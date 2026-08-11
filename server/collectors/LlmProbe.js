/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { TOKEN_LIFETIMES_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import { classifyHostScope } from "../validate.js";
import fs from "fs";
import path from "path";

// ─── Disk-persisted lifetime token counters ──────────────
// Survives sparkDash restarts. Keyed by `${sparkId}:${port}`.
let _diskCounts = {};
try {
  if (fs.existsSync(TOKEN_LIFETIMES_PATH)) {
    _diskCounts = JSON.parse(fs.readFileSync(TOKEN_LIFETIMES_PATH, "utf8"));
  }
} catch { /* corrupt or missing — start fresh */ }

function _saveDiskCounts() {
  try {
    atomicWrite(TOKEN_LIFETIMES_PATH, JSON.stringify(_diskCounts, null, 2), 0o600);
  } catch (err) {
    console.error("[LlmProbe] failed to save token-lifetimes.json:", err.message);
  }
}

function _loadOffsets(sparkId, port, modelId) {
  const key = modelId ? `${sparkId}:${port}:${modelId}` : `${sparkId}:${port}`;
  const entry = _diskCounts[key];
  if (entry && typeof entry.input === "number" && typeof entry.output === "number") {
    return { input: entry.input, output: entry.output };
  }
  // Fallback: when loading without modelId and no zero-key entry exists,
  // scan for any model-keyed entry for this spark:port so probe host/port
  // changes don't orphan accumulated token history.
  if (!modelId) {
    const prefix = `${sparkId}:${port}:`;
    for (const k of Object.keys(_diskCounts)) {
      if (k.startsWith(prefix)) {
        const e = _diskCounts[k];
        if (e && typeof e.input === "number" && typeof e.output === "number" && (e.input > 0 || e.output > 0)) {
          return { input: e.input, output: e.output };
        }
      }
    }
  }
  return { input: 0, output: 0 };
}

function _saveOffsets(sparkId, port, modelId, input, output) {
  const key = modelId ? `${sparkId}:${port}:${modelId}` : `${sparkId}:${port}`;
  _diskCounts[key] = { input, output };
  // Also write to the null-modelId slot so probes recreated without modelId
  // (e.g. after a host/port change) find the accumulated data.
  if (modelId) {
    _diskCounts[`${sparkId}:${port}`] = { input, output };
  }
  _saveDiskCounts();
}

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${spark.llmHost || spark.lanIp}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastProbeTime = 0;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;
    /** Cumulative total input tokens (prompt) as reported by the LLM server */
    this.totalInputTokens = 0;
    // Lifetime accumulation across vLLM restarts (survives counter resets)
    this._sparkId = spark.id;
    const offsets = _loadOffsets(spark.id, port, null);
    this._inputAccumulated = offsets.input;
    this._outputAccumulated = offsets.output;
    this._lastRawInput = 0;
    this._lastRawOutput = 0;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.maxRequestsRunning = 0;
    this.totalRequests = null;
    this.ttftP95Seconds = null;
    /** Recent (rolling-window) mean TTFT in seconds — lifetime mean can mask overload. */
    this.ttftMeanSeconds = null;
    this.preemptionsTotal = null; // cumulative counter
    /** Prefix cache hit rate 0–1 (hits/queries). */
    this.prefixCacheHitRate = null;
    /** End-to-end request latency p95 (seconds). */
    this.e2eP95Seconds = null;
    /** Inter-token latency p95 (seconds). */
    this.itlP95Seconds = null;
    /** Speculative/MTP acceptance rate 0–1 (accepted/drafted). */
    this.mtpAcceptanceRate = null;

    /**
     * Engine phase for decode-bound diagnosis (not GPU clocks).
     * IDLE | PREFILL | DECODE | SLOW_DECODE | QUEUED | DOWN
     */
    this.enginePhase = "DOWN";
    /** generationTps / max(running,1) — what each stream feels like. */
    this.genTpsPerRunning = null;
    /** Implied tok/s from ITL p95: 1/itlSeconds when ITL available. */
    this.itlImpliedTps = null;
    /**
     * True when running work looks decode-bound: low gen, elevated KV or multi-run,
     * high ITL, prefill quiet. Pair with host GPU util in the UI for the
     * full "96% util / 0 tok/s" story.
     */
    this.decodeBound = false;
    this.waitingByReason = null;
    this.engineWaitReason = null;
    this.queueHint = null;
    /**
     * vLLM waiting breakdown from num_requests_waiting_by_reason.
     * { capacity: N, deferred: N, other?: N } — null when series missing.
     */
    this.waitingByReason = null;
    /** Short engine wait reason label: capacity | deferred | mixed | null */
    this.engineWaitReason = null;
    /**
     * Human one-liner combining engine wait reason + live KV + proxy who.
     * Filled in snapshot after classify; may be refined by index.js with proxy.
     */
    this.queueHint = null;

    // Rolling TTFT window: cumulative histogram deltas pushed per poll into a
    // bounded ring buffer. p95/mean are computed only from *recent* samples so
    // a stale overload burst doesn't pin the banner for the process lifetime.
    this._ttftWindow = []; // {ts, buckets:[{upper,count}], total, sum}
    this._ttftWindowMs = 5 * 60 * 1000; // 5 min lookback
    this._ttftMinSamples = 5;
    this._prevTtftHist = null; // {buckets, total, sum} from previous poll

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${this.spark.llmHost || this.spark.lanIp}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      // Reload disk offsets for the new port key
      const offsets = _loadOffsets(this._sparkId, this.port, this.modelId);
      this._inputAccumulated = offsets.input;
      this._outputAccumulated = offsets.output;
      this._modelKeyed = false;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    try {
      const shouldDetect =
        this.serverIsOpenAI === null ||
        Date.now() - this._lastDetectAt > REDETECT_INTERVAL_MS;

      if (shouldDetect) {
        await this._detectServerType();
        this._lastDetectAt = Date.now();
      }

      if (this.serverIsOpenAI === false) {
        const snap = await this._probeLlamaCpp();
        this._noteSuccess();
        return snap;
      } else if (this.serverIsOpenAI === true) {
        const snap = await this._probeOpenAICompatible();
        this._noteSuccess();
        return snap;
      } else {
        this._noteFailure("LLM server not reachable");
        return this._defaultLlm();
      }
    } catch (err) {
      this._noteFailure(err.message);
      return this._defaultLlm();
    }
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    this.error = null;
  }

  /**
   * Update lifetime token counters, detecting vLLM counter resets (process restart).
   * When the raw counter drops below the previous observation, the old value is
   * added to the accumulated offset so the reported total never decreases.
   */
  _accumulateTokens(rawInput, rawOutput) {
    const now = Date.now();
    // Only accumulate for vLLM/SGLang where counters are cumulative from boot.
    // llama.cpp uses slot-level decoded/prompted counters which work differently.
    if (this.backendType !== "vllm" && this.backendType !== "sglang") {
      this.totalInputTokens = rawInput;
      this.totalOutputTokens = rawOutput;
      return;
    }
    // First observation: just record it.
    if (this._lastRawInput === 0 && this._lastRawOutput === 0) {
      this._lastRawInput = rawInput;
      this._lastRawOutput = rawOutput;
      this.totalInputTokens = rawInput;
      this.totalOutputTokens = rawOutput;
      return;
    }
    // Detect counter reset (value dropped below last seen → vLLM restarted)
    if (rawInput < this._lastRawInput) {
      this._inputAccumulated += this._lastRawInput;
    }
    if (rawOutput < this._lastRawOutput) {
      this._outputAccumulated += this._lastRawOutput;
    }
    this._lastRawInput = rawInput;
    this._lastRawOutput = rawOutput;
    this.totalInputTokens = this._inputAccumulated + rawInput;
    this.totalOutputTokens = this._outputAccumulated + rawOutput;
    // First time we have a modelId: reload offsets keyed by model
    if (this.modelId && !this._modelKeyed) {
      this._modelKeyed = true;
      const offsets = _loadOffsets(this._sparkId, this.port, this.modelId);
      this._inputAccumulated = offsets.input;
      this._outputAccumulated = offsets.output;
      this.totalInputTokens = this._inputAccumulated + rawInput;
      this.totalOutputTokens = this._outputAccumulated + rawOutput;
    }
    // Persist to disk (debounced: save at most once per 10s)
    this._scheduleDiskSave();
  }

  _scheduleDiskSave() {
    if (this._saveTimer) return;
    const modelId = this._modelKeyed ? this.modelId : null;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      _saveOffsets(this._sparkId, this.port, modelId, this._inputAccumulated, this._outputAccumulated);
    }, 10_000);
  }

  _noteFailure(message) {
    this.error = message;
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
  }

  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = null;
    this.authOpen = null;
    this.modelId = null;
    this.modelPath = null;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    // Don't reset totalInputTokens / totalOutputTokens — _accumulateTokens
    // preserves lifetime counts across detection resets and vLLM restarts.
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.maxRequestsRunning = 0;
    this.totalRequests = null;
    this.ttftP95Seconds = null;
    this.ttftMeanSeconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this._ttftWindow = [];
    this._prevTtftHist = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
  }

  /** Note auth from an HTTP status on an unauthenticated probe request. */
  _noteAuthStatus(status) {
    if (status >= 200 && status < 300) {
      this.authOpen = true;
      return "ok";
    }
    if (status === 401 || status === 403) {
      this.authOpen = false;
      return "auth";
    }
    return "other";
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    // Skip the llama.cpp /slots probe once we've positively identified an
    // OpenAI-compatible backend. vLLM and sglang have no /slots endpoint, so
    // re-probing it on every re-detect cycle just spams 404s in the backend's
    // access log (#15). Still probe /slots on first contact, when the type is
    // unknown, or when the backend was previously llama.cpp.
    if (this.backendType !== "vllm" && this.backendType !== "sglang") {
      const slotUrl = `${this.baseUrl}/slots`;
      try {
        const slotRes = await this._fetch(slotUrl);
        const auth = this._noteAuthStatus(slotRes.status);
        if (auth === "ok") {
          const slots = await slotRes.json();
          if (Array.isArray(slots)) {
            this.serverIsOpenAI = false;
            this.backendType = "llama.cpp";
            return;
          }
        } else if (auth === "auth") {
          // Authenticated llama.cpp — treat as protected OpenAI-style for posture
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
      } catch {}
    }

    // Try OpenAI-compatible
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelRes.status);
      if (auth === "ok" || auth === "auth") {
        this.serverIsOpenAI = true;
        this.backendType = "vllm";
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  // ─── OpenAI-compatible path (vLLM/sglang) ────────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = model?.id || null;
        this.contextLength = model?.max_model_len || null;
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // Skip SGLang probe when we already know the backend is vLLM
    let isSglang = false;
    if (this.backendType !== "vllm") {
      try {
        const sgRes = await this._fetch(`${this.baseUrl}/get_server_info`);
        if (sgRes.ok) {
          isSglang = true;
          const sgData = await sgRes.json();
          this.contextLength = sgData.max_total_tokens || sgData.context_length || this.contextLength;
          if (sgData.total_input_tokens != null && sgData.total_output_tokens != null) {
            const deltaIn = sgData.total_input_tokens - this.lastTokenCounts.input;
            const deltaOut = sgData.total_output_tokens - this.lastTokenCounts.output;
            this.lastTokenCounts.input = sgData.total_input_tokens;
            this.lastTokenCounts.output = sgData.total_output_tokens;
            this.totalOutputTokens = sgData.total_output_tokens;
            this.totalInputTokens = sgData.total_input_tokens;
            this._accumulateTokens(sgData.total_input_tokens, sgData.total_output_tokens);
            if (dtSec > 0 && dtSec < 10) {
              this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
              this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
            }
          }
        }
      } catch {}
    }

    // /metrics fetch: vLLM always; SGLang when launched with --enable-metrics
    // (get_server_info rarely exposes cumulative token counters).
    {

      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();

          const promptTokensRaw = this._getVllmMetric(txt, "prompt_tokens_total");
          // Use local_compute only — prompt_tokens_total includes MTP draft
          // re-prefill cache hits that inflate the count ~240x for DSpark.
          const computeRe = new RegExp(`^vllm:prompt_tokens_by_source_total\\{[^}]*source="local_compute"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`, "m");
          const computeMatch = txt.match(computeRe);
          const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
          // SGLang (--enable-metrics): sglang:prompt_tokens_total / generation_tokens_total
          // (and a few historical aliases). Prefer these when vLLM series absent.
          let promptTokensSgl = null;
          let genTokensSgl = null;
          if (isSglang || (promptTokensRaw == null && genTokens == null) || txt.includes("sglang:")) {
            promptTokensSgl =
              this._getSglangMetric(txt, "prompt_tokens_total") ??
              this._getSglangMetric(txt, "num_prompt_tokens_total") ??
              this._getSglangMetric(txt, "prompt_tokens");
            genTokensSgl =
              this._getSglangMetric(txt, "generation_tokens_total") ??
              this._getSglangMetric(txt, "num_generation_tokens_total") ??
              this._getSglangMetric(txt, "generation_tokens") ??
              this._getSglangMetric(txt, "completion_tokens_total");
          }
          const promptTokensVllm = computeMatch ? parseFloat(computeMatch[1]) : null;
          // Prefer vLLM local_compute when present; else SGLang counters; else raw vLLM prompt total.
          const promptTokens =
            promptTokensVllm != null
              ? promptTokensVllm
              : promptTokensSgl != null
                ? promptTokensSgl
                : promptTokensRaw;
          const genTokensFinal = genTokens != null ? genTokens : genTokensSgl;
          if (promptTokens != null && genTokensFinal != null) {
            const deltaIn = promptTokens - this.lastTokenCounts.input;
            const deltaOut = genTokensFinal - this.lastTokenCounts.output;
            this.lastTokenCounts.input = promptTokens;
            this.lastTokenCounts.output = genTokensFinal;
            this.totalOutputTokens = genTokensFinal;
            this.totalInputTokens = promptTokens;
            this._accumulateTokens(promptTokens, genTokensFinal);
            // Cumulative counters often only advance at request end on SGLang.
            if (dtSec > 0 && dtSec < 10) {
              this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
              this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
            }
          }

          // SGLang realtime series update on each log interval during prefill/decode.
          // Prefer these for live prefill/gen tok/s while a request is in flight.
          if (isSglang || txt.includes("sglang:realtime_tokens_total")) {
            const rtPrefill =
              this._getSglangLabeledSum(txt, "realtime_tokens_total", "mode", "prefill_compute") +
              this._getSglangLabeledSum(txt, "realtime_tokens_total", "mode", "prefill_cache");
            const rtDecode = this._getSglangLabeledSum(txt, "realtime_tokens_total", "mode", "decode");
            if (!this._sglangRealtime) this._sglangRealtime = { prefill: 0, decode: 0 };
            const dPref = rtPrefill - this._sglangRealtime.prefill;
            const dDec = rtDecode - this._sglangRealtime.decode;
            this._sglangRealtime.prefill = rtPrefill;
            this._sglangRealtime.decode = rtDecode;
            if (dtSec > 0 && dtSec < 10) {
              if (dDec > 0) {
                this.generationTps = Math.max(0, Math.round((dDec / dtSec) * 100) / 100);
              }
              if (dPref > 0) {
                this.prefillTps = Math.max(0, Math.round((dPref / dtSec) * 100) / 100);
              }
            }
          }

          let running = this._getVllmMetric(txt, "num_requests_running");
          if (running == null) {
            running =
              this._getSglangMetric(txt, "num_running_reqs") ??
              this._getSglangMetric(txt, "num_requests_running") ??
              this._getSglangMetric(txt, "running_requests");
          }
          // Keep requestsRunning in sync with other vLLM tiles (null when missing)
          this.requestsRunning = running;
          if (running != null) {
            this.slotsActive = Math.round(running);
            if (running > this.maxRequestsRunning) this.maxRequestsRunning = Math.round(running);
          }

          // Engine sleep state (0 = active, 1 = sleeping)
          if (this.gpuMemoryUtilization == null) {
            const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
            if (sleepState != null) this.gpuMemoryUtilization = sleepState;
          }

          // vLLM inference performance (same /metrics body — no extra HTTP)
          this.requestsWaiting =
            this._getVllmMetric(txt, "num_requests_waiting") ??
            this._getSglangMetric(txt, "num_queue_reqs") ??
            this._getSglangMetric(txt, "num_requests_waiting") ??
            this._getSglangMetric(txt, "waiting_requests");
          // Waiting reason breakdown (vLLM): capacity | deferred | …
          this.waitingByReason = this._parseWaitingByReason(txt);
          this.engineWaitReason = this._summarizeWaitReason(this.waitingByReason);
          // Total completed requests — sum across all finished_reason labels
          const reqRe = /^vllm:request_success_total\{[^}]*\}\s+([\d.eE+-]+)\s*$/m;
          const reqMatch = txt.match(new RegExp(reqRe.source, "gm"));
          this.totalRequests = reqMatch ? reqMatch.reduce((sum, line) => {
            const v = parseFloat(line.match(/([\d.eE+-]+)\s*$/)?.[1] || "0");
            return sum + (isNaN(v) ? 0 : v);
          }, 0) : null;
          this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
          this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

          const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
          const ttftSum = this._getVllmMetric(txt, "time_to_first_token_seconds_sum");
          this._pushTtftWindow(ttftHist, ttftSum);
          const t = this._recentTtft();
          // Round to 3 decimals so WS snapshots stay stable (avoids float jitter)
          this.ttftP95Seconds = t.p95 == null ? null : Math.round(t.p95 * 1000) / 1000;
          this.ttftMeanSeconds = t.mean == null ? null : Math.round(t.mean * 1000) / 1000;

          const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
          const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
          this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

          const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
          const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
          this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

          // Lifetime rates from absolute counters (stable tiles; null when unused)
          const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
          const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
          this.prefixCacheHitRate =
            prefixHits != null && prefixQueries != null && prefixQueries > 0
              ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
              : null;

          const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
          const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
          this.mtpAcceptanceRate =
            mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
              ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
              : null;
        }
      } catch {}
    }

    this.backendType = isSglang ? "sglang" : "vllm";

    return this._getSnapshot();
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Slots
    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      const auth = this._noteAuthStatus(slotsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
          // Some llama.cpp builds use is_processing instead of state
          this.slotsActive = slots.filter((s) => s.is_processing || (s.state && s.state !== "idle")).length;

          let totalGen = 0;
          let totalPrefill = 0;
          let totalDecoded = 0;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            totalDecoded += decoded;
            const lastState = this.slotState.get(slotId) || { decoded: 0, prompted: 0 };
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            this.slotState.set(slotId, { decoded, prompted });
            if (dtSec > 0 && dtSec < 10) {
              totalGen += dDecoded / dtSec;
              totalPrefill += dPrompted / dtSec;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this.prefillTps = Math.max(0, Math.round(totalPrefill * 100) / 100);
        }
      }
    } catch {}

    if (!slotsOk) {
      throw new Error("llama.cpp /slots unreachable");
    }

    // Props (model info)
    try {
      const propsRes = await this._fetch(`${this.baseUrl}/props`);
      if (propsRes.ok) {
        const props = await propsRes.json();
        this.modelId = props.model_alias || props.model_path || this.modelId;
        this.modelPath = props.model_path || null;
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  _getVllmMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow optional Prometheus labels; sum all series (multi-engine / multi-model)
    const re = new RegExp(`^vllm:${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per `le`,
   * summed across label sets. `total` is the summed `_count` series (or null).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Bucket lines: <metricPrefix>_bucket{...le="X"...} VALUE
    const bucketRe = new RegExp(
      `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const le = m[1];
      const count = parseFloat(m[2]);
      if (!Number.isFinite(count)) continue;
      const upper = le === "+Inf" ? Infinity : parseFloat(le);
      if (upper !== Infinity && !Number.isFinite(upper)) continue;
      if (upper === Infinity) infCount += count;
      byUpper.set(upper, (byUpper.get(upper) || 0) + count);
    }
    const total = this._getVllmMetric(body, `${metricPrefix.replace(/^vllm:/, "")}_count`);
    // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  /**
   * Prometheus-style linear interpolation for a histogram quantile.
   * Returns null when empty / invalid or target is in the +Inf tail.
   */
  _histogramQuantile(buckets, total, quantile) {
    if (!buckets || !buckets.length || total == null || total <= 0) return null;
    const target = total * quantile;
    let prevUpper = 0.0;
    let prevCount = 0.0;
    for (const { upper, count } of buckets) {
      if (count >= target) {
        if (!Number.isFinite(upper)) return null;
        if (count === prevCount) return upper;
        return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
      }
      prevUpper = upper;
      prevCount = count;
    }
    return null;
  }

  /**
   * Feed a new cumulative TTFT histogram snapshot into the rolling window.
   * Computes the delta since the previous poll (only *new* finished requests)
   * and appends it to a bounded ring buffer. Call before _recentTtft() so the
   * window reflects this poll's samples.
   */
  _pushTtftWindow(hist, sum) {
    const now = Date.now();
    const cur = {
      buckets: hist && Array.isArray(hist.buckets) ? hist.buckets : [],
      total: (hist && hist.total != null) ? hist.total : 0,
      sum: typeof sum === "number" && Number.isFinite(sum) ? sum : 0,
    };

    if (this._prevTtftHist) {
      const prev = this._prevTtftHist;
      const deltaCount = cur.total - prev.total;
      // Delta per bucket: current minus previous cumulative count for the same `le`.
      const prevByUpper = new Map(prev.buckets.map((b) => [b.upper, b.count]));
      const deltaBuckets = cur.buckets
        .map((b) => ({
          upper: b.upper,
          count: Math.max(0, b.count - (prevByUpper.get(b.upper) || 0)),
        }))
        .filter((b) => b.count > 0);
      const deltaSum = Math.max(0, cur.sum - prev.sum);
      if (deltaCount > 0) {
        this._ttftWindow.push({
          ts: now,
          buckets: deltaBuckets,
          total: deltaCount,
          sum: deltaSum,
        });
      }
    }
    this._prevTtftHist = cur;

    // Prune samples older than the lookback window.
    const cutoff = now - this._ttftWindowMs;
    while (this._ttftWindow.length && this._ttftWindow[0].ts < cutoff) {
      this._ttftWindow.shift();
    }
  }

  /**
   * Aggregate the rolling window into a single histogram and compute p95 + mean.
   * Returns { p95, mean } (seconds) or nulls when there aren't enough recent
   * samples or the quantile falls in the +Inf bucket.
   */
  _recentTtft() {
    if (this._ttftWindow.length === 0) return { p95: null, mean: null };
    const total = this._ttftWindow.reduce((s, e) => s + e.total, 0);
    const sum = this._ttftWindow.reduce((s, e) => s + e.sum, 0);
    if (total < this._ttftMinSamples) return { p95: null, mean: null };

    // Sum bucket counts across all window entries (same `le` edges), then
    // convert to CUMULATIVE counts (Prometheus style) — _histogramQuantile
    // expects each bucket's count to include all samples up to that `le`.
    const agg = new Map();
    for (const e of this._ttftWindow) {
      for (const b of e.buckets) {
        agg.set(b.upper, (agg.get(b.upper) || 0) + b.count);
      }
    }
    const sorted = Array.from(agg, ([upper, count]) => ({ upper, count })).sort((a, b) => a.upper - b.upper);
    let running = 0;
    const buckets = sorted.map((b) => {
      running += b.count;
      return { upper: b.upper, count: running };
    });
    const p95 = this._histogramQuantile(buckets, total, 0.95);
    const mean = sum > 0 && total > 0 ? sum / total : null;
    return { p95, mean };
  }

  _getSlotDecoded(slot) {
    // Some llama.cpp builds nest n_decoded inside next_token[0]
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    // Fallback: next_token[0].n_decoded (newer llama.cpp)
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    return slot.n_prompt_tokens_processed || slot.n_prompt_tokens || 0;
  }

  /**
   * Observational exposure hint from probe target + unauthenticated reachability.
   * Does not claim process bind address (0.0.0.0 vs interface).
   */
  _buildPosture() {
    if (this.authOpen == null) return null;

    const host = this.spark?.llmHost || this.spark?.lanIp || "";
    const scope = classifyHostScope(host);
    const keyed = Boolean(this._apiKey());
    /** @type {"open" | "protected" | "keyed"} */
    let auth;
    if (keyed) {
      // Key configured: success → keyed; 401/403 → protected (rejected)
      auth = this.authOpen === false ? "protected" : "keyed";
    } else {
      auth = this.authOpen ? "open" : "protected";
    }

    let level = "ok";
    if (auth === "open") {
      if (scope === "public") level = "danger";
      else if (scope === "local") level = "ok";
      else level = "warn"; // lan or unknown hostname
    } else if (keyed && auth === "protected") {
      level = "danger";
    }

    const scopeWords = {
      local: "loopback",
      lan: "LAN",
      public: "public",
      unknown: "unknown-host",
    };
    const shortScope = {
      local: "Local",
      lan: "LAN",
      public: "Public",
      unknown: "Host",
    };
    const label =
      auth === "protected"
        ? keyed
          ? "Bad API key"
          : "Auth required"
        : auth === "keyed"
          ? `API key · ${shortScope[scope]}`
          : `Open · ${shortScope[scope]}`;
    const detail =
      auth === "protected"
        ? keyed
          ? `Configured API key was rejected (401/403) · ${scopeWords[scope]} target (${host || "—"}).`
          : `API key required · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
        : auth === "keyed"
          ? `Using configured API key · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
          : `Unauthenticated · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`;

    return { level, auth, scope, label, detail };
  }


  /**
   * Classify engine phase + decode-bound flag from live probe fields.
   * Call at the end of successful probes and before snapshot.
   *
   * Heuristic (fleet-tuned):
   *   DOWN     — probe unreachable / auth closed
   *   IDLE     — run=0 wait=0
   *   QUEUED   — run=0 wait>0
   *   PREFILL  — run>=1 and prefillTps dominates generation
   *   SLOW_DECODE — run>=1, prefill quiet, gen low or ITL high, KV/run elevated
   *   DECODE   — run>=1, prefill quiet, gen flowing
   */

  /**
   * Parse vllm:num_requests_waiting_by_reason{reason="…"} gauges.
   * Returns { capacity, deferred, … } or null if no series found.
   */
  _parseWaitingByReason(body) {
    if (!body) return null;
    const re = /^vllm:num_requests_waiting_by_reason\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/gm;
    const out = {};
    let m;
    let found = false;
    while ((m = re.exec(body)) !== null) {
      const labels = m[1];
      const val = parseFloat(m[2]);
      if (Number.isNaN(val)) continue;
      const rm = /reason="([^"]+)"/.exec(labels);
      const reason = rm ? rm[1] : "unknown";
      out[reason] = (out[reason] || 0) + val;
      found = true;
    }
    if (!found) {
      const bare = this._getVllmMetric(body, "num_requests_waiting_by_reason");
      if (bare == null) return null;
      return { unknown: bare };
    }
    return out;
  }

  /** Pick a single label from waitingByReason map. */
  _summarizeWaitReason(byReason) {
    if (!byReason || typeof byReason !== "object") return null;
    const entries = Object.entries(byReason)
      .map(([k, v]) => [k, Number(v) || 0])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return null;
    if (entries.length === 1) return entries[0][0];
    const rest = entries.slice(1).reduce((s, [, v]) => s + v, 0);
    if (rest > 0) return "mixed";
    return entries[0][0];
  }

  /**
   * Build engine-side queue hint (proxy who is added later in index.js).
   */
  _buildQueueHint() {
    const run = this.requestsRunning == null ? 0 : Number(this.requestsRunning);
    const wait = this.requestsWaiting == null ? 0 : Number(this.requestsWaiting);
    const kv = this.kvCacheUsage;
    const reason = this.engineWaitReason;
    if (wait <= 0) {
      if (run >= 1 && kv != null && kv >= 0.15 && this.decodeBound) {
        return `Engine busy: ${Math.round(run)} running with live KV ${(kv * 100).toFixed(0)}% (decode-bound).`;
      }
      return null;
    }
    const reasonTxt =
      reason === "capacity"
        ? "capacity (no free scheduling slot)"
        : reason === "deferred"
          ? "deferred (KV/LoRA/transfer constraint)"
          : reason === "mixed"
            ? "mixed engine constraints"
            : reason
              ? String(reason)
              : "unspecified";
    const kvTxt =
      kv != null && kv > 0
        ? ` · live KV ${(kv * 100).toFixed(0)}%`
        : "";
    const runTxt = run >= 1 ? `${Math.round(run)} running ahead` : "nothing running (engine ramp)";
    return `Engine queue: ${Math.round(wait)} waiting — ${reasonTxt} · ${runTxt}${kvTxt}.`;
  }

  _classifyEnginePhase() {
    const metricsLive = this.serverIsOpenAI !== null && this.authOpen !== false;
    const run = this.requestsRunning;
    const wait = this.requestsWaiting;
    const gen = Number(this.generationTps) || 0;
    const pref = Number(this.prefillTps) || 0;
    const kv = this.kvCacheUsage;
    const itl = this.itlP95Seconds;
    const mtp = this.mtpAcceptanceRate;

    this.genTpsPerRunning = null;
    this.itlImpliedTps = null;
    this.decodeBound = false;

    if (!metricsLive) {
      this.enginePhase = "DOWN";
      return;
    }

    const runN = run == null ? 0 : Number(run);
    const waitN = wait == null ? 0 : Number(wait);
    if (run != null && runN >= 1) {
      this.genTpsPerRunning = Math.round((gen / Math.max(runN, 1)) * 100) / 100;
    }
    if (itl != null && itl > 0 && Number.isFinite(itl)) {
      this.itlImpliedTps = Math.round((1 / itl) * 100) / 100;
    }

    if (runN <= 0 && waitN <= 0) {
      this.enginePhase = "IDLE";
      return;
    }
    if (runN <= 0 && waitN > 0) {
      this.enginePhase = "QUEUED";
      return;
    }

    const prefillDominant = pref >= 20 && pref > gen * 3;
    if (prefillDominant) {
      this.enginePhase = "PREFILL";
      return;
    }

    const itlHigh = itl != null && itl >= 0.2;
    const genLow = gen < 8;
    const genCrawl = gen < 2.5;
    const kvElevated = kv != null && kv >= 0.12;
    const multi = runN >= 2;
    const mtpSoft = mtp != null && mtp < 0.45;
    const perStreamLow =
      this.genTpsPerRunning != null && this.genTpsPerRunning < 4;

    const slow =
      runN >= 1 &&
      pref < 30 &&
      (genLow || itlHigh || perStreamLow) &&
      (kvElevated || multi || mtpSoft || genCrawl || itlHigh);

    if (slow) {
      this.enginePhase = "SLOW_DECODE";
      this.decodeBound = true;
      return;
    }

    if (runN >= 1 && pref < 30) {
      this.enginePhase = "DECODE";
      if (genCrawl && (kvElevated || multi)) {
        this.decodeBound = true;
        this.enginePhase = "SLOW_DECODE";
      }
      return;
    }

    this.enginePhase = pref >= gen ? "PREFILL" : "DECODE";
  }

  _getSnapshot() {
    this._classifyEnginePhase();
    this.queueHint = this._buildQueueHint();
    const metricsLive = this.serverIsOpenAI !== null && this.authOpen !== false;
    return {
      available: metricsLive,
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      contextLength: this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      totalOutputTokens: this.totalOutputTokens,
      totalInputTokens: this.totalInputTokens,
      contextLength: this.contextLength,
      kvCacheUsage: this.kvCacheUsage,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      maxRequestsRunning: this.maxRequestsRunning,
      totalRequests: this.totalRequests,
      ttftP95Seconds: this.ttftP95Seconds,
      ttftMeanSeconds: this.ttftMeanSeconds,
      preemptionsTotal: this.preemptionsTotal,
      prefixCacheHitRate: this.prefixCacheHitRate,
      e2eP95Seconds: this.e2eP95Seconds,
      itlP95Seconds: this.itlP95Seconds,
      mtpAcceptanceRate: this.mtpAcceptanceRate,
      enginePhase: this.enginePhase,
      genTpsPerRunning: this.genTpsPerRunning,
      itlImpliedTps: this.itlImpliedTps,
      decodeBound: this.decodeBound,
      waitingByReason: this.waitingByReason,
      engineWaitReason: this.engineWaitReason,
      queueHint: this.queueHint,
      /** Engine-native run/wait (never overwritten by proxy). */
      engineRequestsRunning: this.requestsRunning,
      engineRequestsWaiting: this.requestsWaiting,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  _defaultLlm() {
    return {
      available: false,
      backend: this.backendType,
      modelId: null,
      modelPath: null,
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      kvCacheUsage: null,
      requestsRunning: null,
      requestsWaiting: null,
      maxRequestsRunning: 0,
      totalRequests: null,
      ttftP95Seconds: null,
      ttftMeanSeconds: null,
      preemptionsTotal: null,
      prefixCacheHitRate: null,
      e2eP95Seconds: null,
      itlP95Seconds: null,
      mtpAcceptanceRate: null,
      enginePhase: "DOWN",
      genTpsPerRunning: null,
      itlImpliedTps: null,
      decodeBound: false,
      waitingByReason: null,
      engineWaitReason: null,
      queueHint: null,
      engineRequestsRunning: null,
      engineRequestsWaiting: null,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  /**
   * SGLang Prometheus counter/gauge (enable with --enable-metrics).
   * Series are usually `sglang:<name>` or bare `<name>`; try both.
   */
  _getSglangMetric(body, name) {
    const bare = name.replace(/^sglang:/, "");
    const candidates = [`sglang:${bare}`, bare];
    for (const n of candidates) {
      const v = this._getVllmMetric(body, n);
      if (v != null && !Number.isNaN(v)) return v;
    }
    // labeled series: sglang:prompt_tokens_total{...} 123 — sum labels
    const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reAll = new RegExp(
      `^(?:sglang:)?${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`,
      "gm",
    );
    const matches = body.match(reAll);
    if (!matches || matches.length === 0) return null;
    let sum = 0;
    let any = false;
    for (const line of matches) {
      const mm = line.match(/([\d.eE+-]+)\s*$/);
      if (!mm) continue;
      const v = parseFloat(mm[1]);
      if (!Number.isNaN(v)) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  }

  /**
   * Sum SGLang prometheus series matching name + one label=value filter.
   * Returns 0 when no lines match (so deltas from 0 work on first sighting).
   */
  _getSglangLabeledSum(body, name, label, value) {
    const bare = name.replace(/^sglang:/, "");
    const escName = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escLab = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escVal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^(?:sglang:)?${escName}\\{[^}]*${escLab}="${escVal}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm",
    );
    let sum = 0;
    let any = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (!Number.isNaN(v)) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : 0;
  }



  // ─── HTTP helpers ────────────────────────────────────────
  _apiKey() {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(this.port)] ?? keys[this.port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  async _fetch(url) {
    const headers = {};
    const apiKey = this._apiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS), headers });
  }
}
