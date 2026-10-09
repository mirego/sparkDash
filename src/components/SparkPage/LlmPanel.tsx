import { benchId } from "../../constants";
import { BenchIcon } from "../bench/BenchIcon";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { LlmMetrics, LlmBenchTarget } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts, updateLlmHost } from "../../api/client";
import { Sparkline } from "../ui/Sparkline";
import { TrendLine } from "../ui/TrendLine";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { BotIcon, ExpandIcon, FlaskIcon, GearIcon, InfoIcon, ServerIcon } from "../ui/icons";
import {
  useMetricsHistory,
  useMetricsHistoryTail,
  avgPositive,
} from "../../hooks/metricsStore";
import { enginePhaseLabel, formatWaitReason, waitReasonDetail } from "../../utils/health";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { PrefillBenchDialog } from "./PrefillBenchDialog";
import { QualityBenchDialog } from "./QualityBenchDialog";
import { LlmDailyChart } from "./LlmDailyChart";
import { LlmTokenTotals } from "./LlmTokenTotals";
import { ENGINE_GENERATED_LABEL, ENGINE_GENERATED_TITLE } from "./tokenTotalsCopy";
import { parseLlmTargetInput } from "../../shared/llmTarget.js";
import { backendLabel } from "../../shared/llmBackends.js";
import { LlmTrendChart } from "./LlmTrendChart";
import type { BenchKind } from "./BenchSwitcher";
import { engineStateLabel } from "./llmEngineState";
import { idleLabel, isLlmIdle } from "../../shared/llmIdle";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  /** Unit display name — lands on the benchmark share card. */
  sparkName?: string;
  llmPort: number;
  llmHost: string | null;
  lanIp: string;
  llmPorts?: number[];
  hasApiKey?: boolean;
  /** Show "Copy image" in the benchmark dialogs (Settings, off by default). */
  shareImage?: boolean;
  onRemovePort?: (port: number) => void;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Free tokens left in the engine’s KV-cache pool, over the allocated pool (tokens and memory). The pool is shared across concurrent requests and can be larger than one request’s max context. High usage (≥80% full) means little room for new or long contexts and often leads to queuing or preemptions.",
  requests:
    "ENGINE run/wait from vLLM: Run = in a model batch on the GPU. Wait = accepted but not scheduled. Reason chips (capacity/deferred) come from num_requests_waiting_by_reason. Proxy stream/pre-byte is a different clock (first response byte) — see Queue strip.",
  ttftP95:
    "95th percentile time-to-first-token from the engine’s request history: how long “slow” requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths—not average decode speed.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits ÷ queries). Higher means more prompt reuse and less prefill work; — when the series is missing or unused.",
  e2eP95:
    "95th percentile end-to-end request latency from the engine’s request history: arrival until the request finishes. Includes queue wait, prefill, and decode—not just token generation speed.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from the engine’s request history. Spikes mean decode stalls or contention; lower is smoother streaming.",
  mtpAccept:
    "Lifetime speculative / MTP acceptance rate (accepted draft tokens ÷ drafted tokens). Higher means speculative decoding is paying off; — when speculation is off or unused.",
  waitReason:
    "vLLM waiting_by_reason: capacity = no free scheduling slot (usually another job on the GPU); deferred = transient KV/LoRA/transfer block. Separate from proxy pre-first-byte waiting.",
  enginePhase:
    "What the engine is doing right now: Idle, Prefill (eating prompt), Decode (generating tokens), Slow decode (generation crawling under fat KV/concurrency), Queued, or Down. Slow decode with high GPU util is busy work — not a frozen card.",
  tpsPerRun:
    "Generation tok/s divided by running requests — approximate per-stream feel. Total gen can look healthy while each client crawls.",
  itlImplied:
    "1 ÷ ITL p95 — tok/s implied by inter-token latency alone. When this and gen tok/s are both low, decode is expensive.",
} as const;

/** Compact token counts for the KV pool tile (883552 → 884k). */
function formatKvTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = Math.round((n / 1_000_000) * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (abs >= 1000) {
    const v = abs >= 10_000 ? Math.round(n / 1000) : Math.round((n / 1000) * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return Math.round(n).toLocaleString();
}

function formatKvBytes(n: number): string {
  const gib = n / 1024 ** 3;
  if (gib >= 10) return `${Math.round(gib)} GB`;
  if (gib >= 1) {
    const v = Math.round(gib * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} GB`;
  }
  return `${Math.round(n / 1024 ** 2)} MB`;
}

const REMOTE_STORAGE_KEY = "sparkdash.remote-bench-target";

function readStoredRemote(): { host: string; port: string; tls: boolean } {
  try {
    const raw = localStorage.getItem(REMOTE_STORAGE_KEY);
    if (!raw) return { host: "", port: "443", tls: true };
    const v = JSON.parse(raw) as { host?: string; port?: number; tls?: boolean };
    return {
      host: typeof v.host === "string" ? v.host : "",
      port: v.port != null ? String(v.port) : "443",
      tls: v.tls !== false,
    };
  } catch {
    return { host: "", port: "443", tls: true };
  }
}

/** Decode / Prefill / Quality / Showcase launchers — shown even when the live probe is empty
 *  (remote loopback-bound servers can still be benched via SSH tunnel). */
function LlmLaunchers({
  sparkId,
  llmPort,
  modelId,
  onLaunch,
  onRemoteLaunch,
}: {
  sparkId: string;
  llmPort: number;
  modelId?: string | null;
  onLaunch: (kind: BenchKind) => void;
  onRemoteLaunch: (kind: BenchKind, target: LlmBenchTarget) => void;
}) {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState(() => readStoredRemote().host);
  const [portDraft, setPortDraft] = useState(() => readStoredRemote().port);
  const [tls, setTls] = useState(() => readStoredRemote().tls);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const persist = (t: LlmBenchTarget) => {
    try {
      localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
  };

  const applyHostBlur = () => {
    if (!hostDraft.trim()) return;
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
    } catch {
      /* leave as typed until Run */
    }
  };

  const launchRemote = (kind: BenchKind) => {
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      persist(p);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
      onRemoteLaunch(kind, p);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    }
  };

  const localHint =
    "Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1.";

  return (
    <div className="sp-launchers">
      <div className="sp-btns">
        {(
          [
            ["decode", "Decode", `Decode benchmark: generation speed at rising concurrency, on this Spark. ${localHint}`],
            ["prefill", "Prefill", `Prefill benchmark: prompt processing speed and time to first token, on this Spark. ${localHint}`],
            ["quality", "Quality", "Quality suite (QA, reasoning, arithmetic, state tracking, GSM8K, MMLU) against this port's model. Compare runs across models, quantizations and KV-cache formats."],
            ["tool-eval", "Tool Eval Bench", "Benchmark this model's tool calling."],
          ] as const
        ).map(([type, label, title]) => (
          <button
            key={type}
            type="button"
            // Opens the benchmark's own page, already set to this Spark.
            onClick={() => window.dispatchEvent(new CustomEvent("sparkdash:navigate", { detail: { id: benchId(type), spark: sparkId } }))}
            className="btn btn--sm"
            title={title}
          >
            <BenchIcon id={type} className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const params = new URLSearchParams();
            if (llmPort) params.set("port", String(llmPort));
            if (modelId) params.set("model", modelId);
            const q = params.toString() ? `?${params.toString()}` : "";
            window.open(`/showcase/${encodeURIComponent(sparkId)}${q}`, "_blank", "noopener,noreferrer");
          }}
          className="btn btn--sm"
        >
          <ExpandIcon className="h-3.5 w-3.5" />
          Showcase
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`btn btn--sm btn--ghost sp-btns__end ${remoteOpen ? "is-on" : ""}`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          <ServerIcon className="h-3.5 w-3.5" />
          Remote
        </button>
      </div>
      {remoteOpen && (
        <div className="sp-remote">
          <p className="sp-hint">
            On-demand endpoint. Paste a URL or type host + port — nothing is probed until you run.
          </p>
          <label className="sp-field">
            <span className="eyebrow">Host</span>
            <input
              type="text"
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onBlur={applyHostBlur}
              placeholder="https://name.tailxxxxx.ts.net/v1/models"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="sp-input"
            />
          </label>
          <div className="sp-field-row">
            <label className="sp-field sp-field--grow">
              <span className="eyebrow">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                className="sp-input"
              />
            </label>
            <label className="sp-check">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
              />
              HTTPS
            </label>
          </div>
          {remoteError && <p className="sp-error">{remoteError}</p>}
          <div className="sp-btns">
            <button type="button" onClick={() => launchRemote("decode")} className="btn btn--sm">
              Decode
            </button>
            <button type="button" onClick={() => launchRemote("prefill")} className="btn btn--sm">
              Prefill
            </button>
            <button type="button" onClick={() => launchRemote("quality")} className="btn btn--sm">
              Quality
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const POSTURE_TONE: Record<NonNullable<LlmMetrics["posture"]>["level"], TagTone> = {
  ok: "good",
  warn: "warn",
  danger: "bad",
};

/** Exposure / auth posture from the unauthenticated probe (issue #17). */
function PostureBadge({ posture }: { posture: NonNullable<LlmMetrics["posture"]> }) {
  return (
    <Tag tone={POSTURE_TONE[posture.level]} title={posture.detail}>
      {posture.label}
    </Tag>
  );
}

/** Small (i) next to a metric label; one open tooltip at a time. */
function MetricInfoTip({
  id,
  label,
  text,
  openId,
  setOpenId,
  /** Anchor tooltip to the right so edge columns don’t clip off-screen */
  align = "left",
}: {
  id: string;
  label: string;
  text: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  align?: "left" | "right";
}) {
  const open = openId === id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setOpenId(null), 2000);
  }, [clearTimer, setOpenId]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <div className="sp-tile__label">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => {
          if (open) {
            clearTimer();
            setOpenId(null);
          } else {
            setOpenId(id);
            scheduleClose();
          }
        }}
        onMouseEnter={() => {
          clearTimer();
          setOpenId(id);
        }}
        onMouseLeave={scheduleClose}
        className="relative cursor-pointer opacity-60 hover:opacity-100"
        aria-label={`${label} info`}
      >
        <InfoIcon className="h-2.5 w-2.5" />
        {open && (
          <div
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            className={`absolute top-full z-20 mt-1 w-52 max-w-[min(13rem,calc(100vw-1.5rem))] rounded-xl border border-border-strong bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${
              align === "right" ? "right-0 left-auto" : "left-0 right-auto"
            }`}
          >
            {text}
          </div>
        )}
      </button>
    </div>
  );
}

export function LlmPanel({
  llm,
  sparkId,
  sparkName,
  llmPort,
  llmHost,
  lanIp,
  llmPorts,
  hasApiKey = false,
  shareImage = false,
  onRemovePort,
  className,
}: LlmPanelProps) {
  // Tail keyed by port so multi-port LLM sparklines stay distinct (8b).
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const prefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefill`);
  const cachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillUncached`);

  // Full series (~1 h) for running averages over busy (>0) samples only.
  const genFull = useMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefillFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefill`);
  const cachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillUncached`);
  const genAvg = useMemo(() => avgPositive(genFull), [genFull]);
  const prefillAvg = useMemo(() => avgPositive(prefillFull), [prefillFull]);
  const cachedPrefillAvg = useMemo(() => avgPositive(cachedFull), [cachedFull]);
  const uncachedPrefillAvg = useMemo(() => avgPositive(uncachedFull), [uncachedFull]);
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [hostDraft, setHostDraft] = useState(llmHost || "");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const [openBench, setOpenBench] = useState<BenchKind | null>(null);
  const [remoteTarget, setRemoteTarget] = useState<LlmBenchTarget | null>(null);
  const launchLocal = useCallback((kind: BenchKind) => {
    setRemoteTarget(null);
    setOpenBench(kind);
  }, []);
  const launchRemote = useCallback((kind: BenchKind, target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setOpenBench(kind);
  }, []);
  /** Which vLLM metric info tip is open (kvCache | requests | ttftP95 | preempts). */
  const [metricInfoId, setMetricInfoId] = useState<string | null>(null);
  const engineInfoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEngineInfoTimer = useCallback(() => {
    if (engineInfoTimer.current != null) {
      clearTimeout(engineInfoTimer.current);
      engineInfoTimer.current = null;
    }
  }, []);

  const startEngineInfoTimer = useCallback(() => {
    clearEngineInfoTimer();
    engineInfoTimer.current = setTimeout(() => setEngineInfoOpen(false), 2000);
  }, [clearEngineInfoTimer]);

  const generationTps = llm?.generationTps ?? 0;
  const prefillTps = llm?.prefillTps ?? 0;
  const showPrefillSplit = llm?.cachedPrefillTps != null || llm?.uncachedPrefillTps != null;
  const cachedPrefillTps = llm?.cachedPrefillTps ?? 0;
  const uncachedPrefillTps = llm?.uncachedPrefillTps ?? 0;
  const available = llm?.available ?? false;
  // While nothing is flowing, say when the endpoint last served.
  const idleNote = available && isLlmIdle({ generationTps, prefillTps })
    ? idleLabel(llm?.lastActiveAt)
    : null;

  // Keep draft in sync when server pushes a different port (other tab / reload)
  useEffect(() => {
    if (!showSettings) {
      setPortDraft(String(llmPort));
      setHostDraft(llmHost || "");
      setApiKeyDraft("");
      setClearApiKey(false);
    }
  }, [llmPort, llmHost, showSettings]);

  const parsedPort = (() => {
    const n = parseInt(portDraft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  })();

  const portDirty = parsedPort !== null && parsedPort !== llmPort;
  const portInvalid = portDraft.trim() !== "" && parsedPort === null;
  const apiKeyDirty = apiKeyDraft.trim() !== "" || clearApiKey;
  const hostDirty = hostDraft !== (llmHost || "");
  const settingsDirty = portDirty || apiKeyDirty || hostDirty;

  const handleSaveSettings = async () => {
    if (parsedPort === null) {
      setSaveError("Port must be an integer 1–65535");
      return;
    }
    if (!settingsDirty) {
      setShowSettings(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (portDirty) {
        const currentPorts =
          Array.isArray(llmPorts) && llmPorts.length > 0 ? llmPorts : [llmPort];
        if (currentPorts.includes(parsedPort) && parsedPort !== llmPort) {
          setSaveError(`Port ${parsedPort} is already configured`);
          setSaving(false);
          return;
        }
        // Rename this panel's port in-place so sibling ports (and their keys) survive
        if (currentPorts.length > 1) {
          const next = currentPorts.map((p) => (p === llmPort ? parsedPort : p));
          await updateLlmPorts(sparkId, next);
        } else {
          await updateLlmPort(sparkId, parsedPort);
        }
      }
      if (hostDirty) {
        await updateLlmHost(sparkId, hostDraft || null);
      }
      const keyPort = parsedPort;
      if (clearApiKey) {
        await setLlmApiKey(sparkId, keyPort, "");
      } else if (apiKeyDraft.trim() !== "") {
        await setLlmApiKey(sparkId, keyPort, apiKeyDraft.trim());
      }
      setApiKeyDraft("");
      setClearApiKey(false);
      setShowSettings(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save LLM settings");
    } finally {
      setSaving(false);
    }
  };

  const fmtTps = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(1));
  const fmtAvg = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
  const isVllm = llm != null && (llm.backend === "vllm" || llm.backend === "q27");
  const kvTone =
    llm?.kvCacheUsage == null
      ? ""
      : llm.kvCacheUsage >= 0.8
        ? "text-danger"
        : llm.kvCacheUsage >= 0.5
          ? "text-warning"
          : "text-success";
  const contextLabel = llm?.contextLength
    ? llm.contextLength >= 1000
      ? `${Math.round(llm.contextLength / 1024)}k ctx`
      : `${llm.contextLength} ctx`
    : null;
  const backend = backendLabel(llm?.backend ?? null);

  const tile = (id: string, label: string, value: string, opts?: { tone?: string; sub?: string; align?: "left" | "right" }) => (
    <div className="sp-tile" key={id}>
      <b className={opts?.tone ?? ""}>{value}</b>
      <MetricInfoTip
        id={id}
        label={label}
        text={VLLM_METRIC_INFO[id as keyof typeof VLLM_METRIC_INFO]}
        openId={metricInfoId}
        setOpenId={setMetricInfoId}
        align={opts?.align}
      />
      {opts?.sub && <small>{opts.sub}</small>}
    </div>
  );

  const kvValue =
    llm?.kvCacheUsage != null
      ? `${(llm.kvCacheUsage * 100).toFixed(0)}%`
      : llm?.kvCacheTokensAvailable != null
        ? `${formatKvTokens(llm.kvCacheTokensAvailable)} free`
        : llm?.kvCacheTokens != null
          ? formatKvTokens(llm.kvCacheTokens)
          : null;
  const kvSub = [
    llm?.kvCacheUsage != null && llm?.kvCacheTokensAvailable != null
      ? `${formatKvTokens(llm.kvCacheTokensAvailable)} free`
      : null,
    llm?.kvCacheTokens != null ? `${formatKvTokens(llm.kvCacheTokens)} pool` : null,
    llm?.kvCacheMemoryBytes != null ? formatKvBytes(llm.kvCacheMemoryBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Panel
      title="LLM server"
      accent={available}
      icon={<BotIcon />}
      className={`panel-llm ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        <div className="sp-actions">
          {available && backend && (
            <Tag tone="info" title={`Backend: ${backend}`}>
              {backend} · :{llmPort}
            </Tag>
          )}
          {onRemovePort && (
            <button
              type="button"
              title={`Remove port ${llmPort}`}
              onClick={() => onRemovePort(llmPort)}
              className="btn btn--sm btn--danger"
            >
              <span aria-hidden>×</span>
              <span>Remove</span>
            </button>
          )}
          <button
            type="button"
            title={showSettings ? "Done" : "LLM settings"}
            onClick={() => {
              if (showSettings) {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
              }
              setShowSettings(!showSettings);
            }}
            disabled={saving}
            className={`btn btn--sm btn--ghost ${showSettings ? "is-on" : ""}`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="sp-stack">
          <p className="sp-hint">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / ds4 / EXL3 / TensorFold / OpenAI-compatible gateway).
          </p>
          <label className="sp-field">
            <span className="eyebrow">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="sp-input"
            />
          </label>
          <label className="sp-field">
            <span className="eyebrow">LLM host override</span>
            <input
              type="text"
              placeholder={lanIp}
              value={hostDraft}
              onChange={(e) => {
                setHostDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="sp-input"
            />
          </label>
          <label className="sp-field">
            <span className="eyebrow">API key (optional)</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKeyDraft}
              disabled={clearApiKey}
              placeholder={hasApiKey && !clearApiKey ? "•••••••• (saved — leave blank to keep)" : "Bearer token if required"}
              onChange={(e) => {
                setApiKeyDraft(e.target.value);
                setClearApiKey(false);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="sp-input"
            />
          </label>
          {hasApiKey && (
            <label className="sp-check">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked);
                  if (e.target.checked) setApiKeyDraft("");
                  setSaveError(null);
                }}
              />
              Clear saved API key
            </label>
          )}
          {portInvalid && <p className="sp-error">Enter an integer between 1 and 65535</p>}
          {saveError && <p className="sp-error">{saveError}</p>}
          <div className="sp-btns sp-btns--end">
            <button
              type="button"
              onClick={() => {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
                setShowSettings(false);
              }}
              disabled={saving}
              className="btn btn--sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSettings()}
              disabled={saving || portInvalid || !settingsDirty}
              className="btn btn--sm btn--primary"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="sp-stack">
          <div className="sp-chips">
            {llm?.posture ? <PostureBadge posture={llm.posture} /> : <span className="sdot sdot--off" />}
            <p className="sp-muted">
              {llm?.posture?.auth === "protected"
                ? `${llm.posture.label} on :${llmPort}`
                : `No model loaded on :${llmPort}`}
            </p>
          </div>
          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onLaunch={launchLocal}
            onRemoteLaunch={launchRemote}
          />

          <div className="border-t border-border pt-3 space-y-2">
            <button
              type="button"
              onClick={() => {
                const params = new URLSearchParams();
                if (llmPort) params.set("port", String(llmPort));
                const q = params.toString() ? `?${params.toString()}` : "";
                window.open(
                  `/showcase/${encodeURIComponent(sparkId)}${q}`,
                  "_blank",
                  "noopener,noreferrer"
                );
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft"
              title="Open prompt showcase (works offline to view history or prepare a run)"
            >
              Showcase
            </button>
          </div>
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTokenTotals sparkId={sparkId} llmPort={llmPort} />
        </div>
      ) : (
        <div className="sp-stack">
          <div className="sp-model">
            <div className="eyebrow">
              <span>Model</span>
              {contextLabel && <span>{contextLabel}</span>}
            </div>
            <code title={llm?.modelId ?? undefined}>{llm?.modelId ?? "—"}</code>
            {llm?.modelPath && llm.modelPath !== llm.modelId && !llm.modelPath.includes("models--") && (
              <small title={llm.modelPath}>{llm.modelPath}</small>
            )}
          </div>

          <div className="sp-decode">
            <div className="sp-metric">
              <span className="eyebrow">Decode</span>
              <div className="big-num sp-big-lg">
                {fmtTps(generationTps)}
                <small>tok/s</small>
              </div>
              <TrendLine data={genHistory} height={44} color="var(--color-accent)" />
              {genAvg != null && <span className="sp-avg mono">avg {fmtAvg(genAvg)}</span>}
              {idleNote && (
                <span className="sp-avg" data-llm-idle>
                  {idleNote}
                </span>
              )}
            </div>
            <div
              className="sp-metric"
              title="Prompt tokens/sec taken in during the last poll window — cache-served + computed. Opening a saved chat in the UI does not hit the GPU; send (or regenerate) so the history is sent as the prompt. Cached prefill does little GPU work; uncached prefill is what builds KV cache."
            >
              <span className="eyebrow">Prefill</span>
              <div className="big-num sp-big-lg">
                {llm?.prefillActive && prefillTps <= 0 ? (
                  <>
                    <span className="ov-tps__dots" aria-hidden />
                    <small title="A prompt is being processed. The engine reports its speed only when the request finishes.">prefilling</small>
                  </>
                ) : (
                  <>
                    {fmtTps(prefillTps)}
                    <small>tok/s</small>
                  </>
                )}
              </div>
              <TrendLine data={prefillHistory} height={44} color="var(--color-info)" />
              {prefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(prefillAvg)}</span>}
            </div>
          </div>
          {showPrefillSplit && (
            <div className="sp-decode sp-decode--split">
              <div
                className="sp-metric"
                title="Prefill tokens served from prefix cache (little GPU work). High values mean prompt reuse, not a faster cold prefill."
              >
                <span className="eyebrow">Cached prefill</span>
                <div className="big-num sp-big-md">
                  {fmtTps(cachedPrefillTps)}
                  <small>tok/s</small>
                </div>
                <TrendLine data={cachedPrefillHistory} height={30} color="var(--color-muted)" />
                {cachedPrefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(cachedPrefillAvg)}</span>}
              </div>
              <div
                className="sp-metric"
                title="Uncached (computed) prefill — tokens that actually build KV cache on the GPU."
              >
                <span className="eyebrow">Uncached prefill</span>
                <div className="big-num sp-big-md">
                  {fmtTps(uncachedPrefillTps)}
                  <small>tok/s</small>
                </div>
                <TrendLine data={uncachedPrefillHistory} height={30} color="var(--color-violet)" />
                {uncachedPrefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(uncachedPrefillAvg)}</span>}
              </div>
            </div>
          )}

          <LlmTrendChart sparkId={sparkId} llmPort={llmPort} />
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />

          {llm && (llm.enginePhase || llm.decodeBound) && (
            <div
              className={`rounded-md border px-2.5 py-2 text-[11px] ${
                llm.enginePhase === "SLOW_DECODE" || llm.decodeBound
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : llm.enginePhase === "DOWN"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : llm.enginePhase === "PREFILL"
                      ? "border-accent/30 bg-accent/10 text-accent"
                      : "border-border bg-surface-elevated text-text"
              }`}
              title="Engine phase from run/wait, prefill vs gen tok/s, KV, ITL, MTP — not GPU clocks alone"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold uppercase tracking-wide">
                  {enginePhaseLabel(llm.enginePhase)}
                  {llm.decodeBound ? " · decode-bound" : ""}
                </span>
                {llm.genTpsPerRunning != null && (
                  <span className="font-tabular text-text">
                    {llm.genTpsPerRunning.toFixed(1)} t/s·stream
                  </span>
                )}
              </div>
              {(llm.enginePhase === "SLOW_DECODE" || llm.decodeBound) && (
                <p className="mt-1 text-[10px] leading-snug opacity-90">
                  GPU can sit near 100% while gen tok/s looks ~0: each new token still attends a large live KV.
                  This is slow generation, not an idle hang.
                </p>
              )}
            </div>
          )}

          {/* Dual queue: engine reason + proxy who */}
          {llm && (llm.queueHint || llm.engineWaitReason || (llm.proxyRequestsWaiting ?? 0) > 0 || (llm.proxyRequestsRunning ?? 0) > 0) && (
            <div
              className={`rounded-md border px-2.5 py-2 text-[11px] ${
                (llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0) > 0 || (llm.proxyRequestsWaiting ?? 0) > 0
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-border bg-surface-elevated text-text"
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold uppercase tracking-wide text-[10px]">Queue</span>
                <span className="font-tabular text-text">
                  Engine {Math.round(llm.engineRequestsRunning ?? llm.requestsRunning ?? 0)} run / {Math.round(llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0)} wait
                </span>
                {llm.engineWaitReason && (llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0) > 0 && (
                  <span
                    className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium"
                    title={waitReasonDetail(llm.engineWaitReason)}
                  >
                    {formatWaitReason(llm.engineWaitReason)}
                  </span>
                )}
                {((llm.proxyRequestsRunning ?? 0) > 0 || (llm.proxyRequestsWaiting ?? 0) > 0) && (
                  <span
                    className="font-tabular text-text"
                    title="Auth-proxy first-byte clock — not vLLM batch size"
                  >
                    · Proxy {Math.round(llm.proxyRequestsRunning ?? 0)} stream / {Math.round(llm.proxyRequestsWaiting ?? 0)} pre-byte
                  </span>
                )}
              </div>
              {(() => {
                const raw = llm.queueHint || "";
                const engineOnly = raw.replace(/\s*Clients:[^.]*\./g, "").trim();
                if (!engineOnly) return null;
                return (
                  <p className="mt-1 text-[10px] leading-snug text-text opacity-90">{engineOnly}</p>
                );
              })()}
              {llm.activeUsers && llm.activeUsers.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {llm.activeUsers.slice(0, 8).map((u) => {
                      const streamN = u.activeCount ?? (u.waiting ? 0 : u.requests);
                      const waitN = u.waitingCount ?? (u.waiting ? u.requests : 0);
                      const fmtK = (n: number | null | undefined) => {
                        if (n == null || !Number.isFinite(Number(n))) return null;
                        const v = Number(n);
                        if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
                        return String(Math.round(v));
                      };
                      const inL = fmtK(u.promptEstTokens);
                      const outL = fmtK(u.completionEstTokens) ?? "0";
                      const maxL = fmtK(u.maxTokens);
                      const cacheL = fmtK(u.cachedTokens);
                      const cachePct =
                        u.cacheHitPct != null && Number.isFinite(Number(u.cacheHitPct))
                          ? `${Math.round(Number(u.cacheHitPct))}%`
                          : null;
                      const inBits =
                        inL == null
                          ? null
                          : cacheL != null
                            ? `in ${inL} (${cacheL} cached${cachePct ? ` · ${cachePct}` : ""})`
                            : `in ${inL}`;
                      const outBits =
                        maxL != null
                          ? `out ${outL} / max ${maxL}`
                          : u.completionEstTokens != null || u.promptEstTokens != null
                            ? `out ${outL}`
                            : null;
                      const ioBits = [inBits, outBits].filter(Boolean).join(" · ");
                      const state = u.waiting
                        ? waitN > 0 && streamN > 0
                          ? "pre-byte + streaming"
                          : "pre-byte (no first token yet)"
                        : "streaming";
                      const reqLines = (u.openRequests || [])
                        .map((r) => {
                          const pi = fmtK(r.promptEstTokens);
                          const co = fmtK(r.completionEstTokens);
                          const ca = fmtK(r.cachedTokens);
                          const cp =
                            r.cacheHitPct != null && Number.isFinite(Number(r.cacheHitPct))
                              ? `${Math.round(Number(r.cacheHitPct))}%`
                              : null;
                          const inPart =
                            ca != null
                              ? `in ${pi ?? "?"} (${ca} cached${cp ? ` · ${cp}` : ""})`
                              : `in ${pi ?? "?"}`;
                          return `${r.phase} ${inPart} · out ${co ?? "0"}${r.maxTokens != null ? ` / max ${fmtK(r.maxTokens)}` : ""} · ${r.ageSec ?? "?"}s`;
                        })
                        .join(" | ");
                      return (
                        <span
                          key={u.label}
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                            u.waiting
                              ? "bg-warning/15 text-warning"
                              : "bg-success/15 text-success"
                          }`}
                          title={`${u.label} · ${state}${streamN ? ` · ${streamN} stream` : ""}${waitN ? ` · ${waitN} pre-byte` : ""} · ${u.requests} in-flight${ioBits ? ` · ${ioBits}` : ""}${reqLines ? `\n${reqLines}` : ""}`}
                        >
                          <span>{u.label}</span>
                          {ioBits ? (
                            <span className="font-tabular opacity-80">{ioBits}</span>
                          ) : null}
                        </span>
                      );
                    })}
                </div>
              )}
              {llm.waitingByReason && Object.keys(llm.waitingByReason).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(llm.waitingByReason).map(([reason, n]) => (
                    <span
                      key={reason}
                      className="rounded border border-border px-1 py-0.5 font-tabular text-[9px] text-muted"
                      title={waitReasonDetail(reason)}
                    >
                      {reason}: {Math.round(Number(n) || 0)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-4 gap-2 border-t border-border pt-3">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Slots</div>
              <div className="font-tabular text-sm text-text">
          <LlmTrendChart sparkId={sparkId} llmPort={llmPort} />
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />

          <div className="grid grid-cols-4 gap-2 border-t border-border pt-3">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Slots</div>
              <div className="font-tabular text-sm text-text">
                {(llm?.slotsTotal ?? 0) > 0
                  ? `${llm?.slotsActive ?? 0} / ${llm?.slotsTotal ?? 0}`
                  : (llm?.slotsActive ?? 0) > 0
                    ? `${llm?.slotsActive} running`
                    : "—"}
              </b>
              <span>Slots</span>
            </div>
            <div className="sp-tile">
              <b>{llm?.contextLength ? llm.contextLength.toLocaleString() : "—"}</b>
              <span>Context</span>
            </div>
            <div className="sp-tile">
              {(() => {
                const engine = engineStateLabel(llm);
                return (
                  <b className={engine.muted ? "text-muted" : undefined} title={engine.title}>
                    {engine.text}
                  </b>
                );
              })()}
              <div className="sp-tile__label">
                <span>Engine</span>
                <button
                  type="button"
                  onClick={() => {
                    setEngineInfoOpen((v) => {
                      if (!v) startEngineInfoTimer();
                      return !v;
                    });
                  }}
                  onMouseEnter={clearEngineInfoTimer}
                  onMouseLeave={startEngineInfoTimer}
                  className="relative cursor-pointer opacity-60 hover:opacity-100"
                  aria-label="Engine state info"
                >
                  <InfoIcon className="h-2.5 w-2.5" />
                  {engineInfoOpen && (
                    <div
                      onMouseEnter={clearEngineInfoTimer}
                      onMouseLeave={startEngineInfoTimer}
                      className="absolute left-0 top-full z-10 mt-1 w-56 rounded-xl border border-border-strong bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case text-text shadow-lg"
                    >
                      Active = processing or ready for requests. Sleeping = idle, GPU memory freed until next request.
                    </div>
                  )}
                </button>
              </div>
            </div>
            <div className="sp-tile" title={ENGINE_GENERATED_TITLE}>
              <b>{llm && llm.totalOutputTokens > 0 ? llm.totalOutputTokens.toLocaleString() : "—"}</b>
              <span>{ENGINE_GENERATED_LABEL}</span>
            </div>
          </div>

          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="kvCache"
                  label="KV Cache"
                  text={VLLM_METRIC_INFO.kvCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div
                  className={`font-tabular text-sm ${
                    llm.kvCacheUsage == null
                      ? "text-text"
                      : llm.kvCacheUsage >= 0.8
                        ? "text-danger"
                        : llm.kvCacheUsage >= 0.5
                          ? "text-warning"
                          : "text-success"
                  }`}
                >
                  {llm.kvCacheUsage != null
                    ? `${(llm.kvCacheUsage * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="requests"
                  label="Engine"
                  text={VLLM_METRIC_INFO.requests}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {(llm.engineRequestsRunning ?? llm.requestsRunning) != null &&
                  (llm.engineRequestsWaiting ?? llm.requestsWaiting) != null
                    ? `${Math.round(llm.engineRequestsRunning ?? llm.requestsRunning ?? 0)} run / ${Math.round(llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0)} wait`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="ttftP95"
                  label="TTFT p95"
                  text={VLLM_METRIC_INFO.ttftP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.ttftP95Seconds != null ? `${llm.ttftP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="preempts"
                  label="Preempts"
                  text={VLLM_METRIC_INFO.preempts}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.preemptionsTotal != null
                    ? Math.round(llm.preemptionsTotal).toLocaleString()
                    : "—"}
                </div>
              </div>
            </div>
          )}

          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="prefixCache"
                  label="Prefix Cache"
                  text={VLLM_METRIC_INFO.prefixCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.prefixCacheHitRate != null
                    ? `${(llm.prefixCacheHitRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="e2eP95"
                  label="E2E p95"
                  text={VLLM_METRIC_INFO.e2eP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.e2eP95Seconds != null ? `${llm.e2eP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="itlP95"
                  label="ITL p95"
                  text={VLLM_METRIC_INFO.itlP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.itlP95Seconds != null ? `${llm.itlP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="mtpAccept"
                  label="MTP Accept"
                  text={VLLM_METRIC_INFO.mtpAccept}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.mtpAcceptanceRate != null
                    ? `${(llm.mtpAcceptanceRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
            </div>
          )}

          {llm?.backend === "vllm" && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-3">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="tpsPerRun"
                  label="t/s per stream"
                  text={VLLM_METRIC_INFO.tpsPerRun}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className={`font-tabular text-sm ${
                  llm.genTpsPerRunning != null && llm.genTpsPerRunning < 4
                    ? "text-warning"
                    : "text-text"
                }`}>
                  {llm.genTpsPerRunning != null ? llm.genTpsPerRunning.toFixed(2) : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="itlImplied"
                  label="ITL ⇒ t/s"
                  text={VLLM_METRIC_INFO.itlImplied}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.itlImpliedTps != null ? llm.itlImpliedTps.toFixed(2) : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="enginePhase"
                  label="Phase"
                  text={VLLM_METRIC_INFO.enginePhase}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className={`font-tabular text-sm ${
                  llm.enginePhase === "SLOW_DECODE" || llm.decodeBound
                    ? "text-warning"
                    : llm.enginePhase === "DOWN"
                      ? "text-danger"
                      : "text-text"
                }`}>
                  {enginePhaseLabel(llm.enginePhase)}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-border pt-3 space-y-2">
            <button
              type="button"
              onClick={() => setBenchOpen(true)}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft"
            >
              Run decode benchmark
            </button>
            <button
              type="button"
              onClick={() => {
                const params = new URLSearchParams();
                if (llmPort) params.set("port", String(llmPort));
                if (llm?.modelId) params.set("model", llm.modelId);
                const q = params.toString() ? `?${params.toString()}` : "";
                window.open(
                  `/showcase/${encodeURIComponent(sparkId)}${q}`,
                  "_blank",
                  "noopener,noreferrer"
                );
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft"
            >
              Showcase
            </button>
          </div>
          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="kvCache"
                  label="KV Cache"
                  text={VLLM_METRIC_INFO.kvCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div
                  className={`font-tabular text-sm ${
                    llm.kvCacheUsage == null
                      ? "text-text"
                      : llm.kvCacheUsage >= 0.8
                        ? "text-danger"
                        : llm.kvCacheUsage >= 0.5
                          ? "text-warning"
                          : "text-success"
                  }`}
                >
                  {llm.kvCacheUsage != null
                    ? `${(llm.kvCacheUsage * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="requests"
                  label="Requests"
                  text={VLLM_METRIC_INFO.requests}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.requestsRunning != null
                    ? `${Math.round(llm.requestsRunning)} run${
                        llm.requestsWaiting != null
                          ? ` / ${Math.round(llm.requestsWaiting)} wait`
                          : ""
                      }`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="ttftP95"
                  label="TTFT p95"
                  text={VLLM_METRIC_INFO.ttftP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.ttftP95Seconds != null ? `${llm.ttftP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="preempts"
                  label="Preempts"
                  text={VLLM_METRIC_INFO.preempts}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.preemptionsTotal != null
                    ? Math.round(llm.preemptionsTotal).toLocaleString()
                    : "—"}
                </div>
              </div>
            </div>
          )}

          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="prefixCache"
                  label="Prefix Cache"
                  text={VLLM_METRIC_INFO.prefixCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.prefixCacheHitRate != null
                    ? `${(llm.prefixCacheHitRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="e2eP95"
                  label="E2E p95"
                  text={VLLM_METRIC_INFO.e2eP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.e2eP95Seconds != null ? `${llm.e2eP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="itlP95"
                  label="ITL p95"
                  text={VLLM_METRIC_INFO.itlP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.itlP95Seconds != null ? `${llm.itlP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="mtpAccept"
                  label="MTP Accept"
                  text={VLLM_METRIC_INFO.mtpAccept}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.mtpAcceptanceRate != null
                    ? `${(llm.mtpAcceptanceRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
            </div>
          )}
          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onLaunch={launchLocal}
            onRemoteLaunch={launchRemote}
          />
          {llm?.posture && (
            <div className="sp-chips">
              <PostureBadge posture={llm.posture} />
            </div>
          )}
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTrendChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTokenTotals sparkId={sparkId} llmPort={llmPort} />
        </div>
      )}

      <BenchmarkDialog
        open={openBench === "decode"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        remoteTarget={remoteTarget}
        shareImage={shareImage}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
        liveTps={remoteTarget ? null : llm?.generationTps ?? null}
      />
      <PrefillBenchDialog
        open={openBench === "prefill"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
        shareImage={shareImage}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
      />
      <QualityBenchDialog
        open={openBench === "quality"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
      />
    </Panel>
  );
}
