import { useState, useEffect, useRef, useCallback } from "react";
import type { LlmMetrics } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts, updateLlmHost } from "../../api/client";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { BotIcon, GearIcon, InfoIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { enginePhaseLabel, formatWaitReason, waitReasonDetail } from "../../utils/health";
import { BenchmarkDialog } from "./BenchmarkDialog";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  llmPort: number;
  llmHost: string | null;
  lanIp: string;
  llmPorts?: number[];
  hasApiKey?: boolean;
  onRemovePort?: (port: number) => void;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Fraction of the engine’s KV cache memory currently in use (0–100%). High values (≥80%) mean little room for new or long contexts and often lead to queuing or preemptions.",
  requests:
    "ENGINE run/wait from vLLM: Run = in a model batch on the GPU. Wait = accepted but not scheduled. Reason chips (capacity/deferred) come from num_requests_waiting_by_reason. Proxy stream/pre-byte is a different clock (first response byte) — see Queue strip.",
  ttftP95:
    "95th percentile time-to-first-token from vLLM’s history of requests: how long “slow” requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths—not average decode speed.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits ÷ queries). Higher means more prompt reuse and less prefill work; — when the series is missing or unused.",
  e2eP95:
    "95th percentile end-to-end request latency from vLLM’s history: arrival until the request finishes. Includes queue wait, prefill, and decode—not just token generation speed.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from vLLM’s history. Spikes mean decode stalls or contention; lower is smoother streaming.",
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

/** Backend badge — neutral surfaces with a single accent dot. No blue/purple. */
function BackendBadge({ backend }: { backend: string | null }) {
  if (!backend) return <span className="text-xs text-muted">No backend</span>;

  const labels: Record<string, string> = {
    vllm: "vLLM",
    "llama.cpp": "llama.cpp",
    sglang: "sgLang",
  };

  return (
    <span className="llm-badge">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      {labels[backend] || backend}
    </span>
  );
}

/** Exposure / auth posture from the unauthenticated probe (issue #17). */
function PostureBadge({
  posture,
}: {
  posture: NonNullable<LlmMetrics["posture"]>;
}) {
  return (
    <span
      className={`llm-posture llm-posture--${posture.level}`}
      title={posture.detail}
    >
      <span className="llm-posture__dot" />
      {posture.label}
    </span>
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
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
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
            className={`absolute top-full z-20 mt-1 w-52 max-w-[min(13rem,calc(100vw-1.5rem))] rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${
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
  llmPort,
  llmHost,
  lanIp,
  llmPorts,
  hasApiKey = false,
  onRemovePort,
  className,
}: LlmPanelProps) {
  // Tail keyed by port so multi-port LLM sparklines stay distinct (8b).
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [hostDraft, setHostDraft] = useState(llmHost || "");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
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
  const available = llm?.available ?? false;

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

  return (
    <Panel
      title="LLM"
      accent={available}
      icon={<BotIcon />}
      className={`panel-llm ${className}`}
      actions={
        <div className="flex items-center gap-1.5">
          {onRemovePort && (
            <button
              type="button"
              title={`Remove port ${llmPort}`}
              onClick={() => onRemovePort(llmPort)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10"
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
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
              showSettings ? "bg-surface-elevated text-text" : ""
            }`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-3">
          <p className="text-[10px] text-muted">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / OpenAI-compatible gateway).
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Port</span>
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
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">LLM host override</span>
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
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">API key (optional)</span>
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
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-accent disabled:opacity-50"
            />
          </label>
          {hasApiKey && (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked);
                  if (e.target.checked) setApiKeyDraft("");
                  setSaveError(null);
                }}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              Clear saved API key
            </label>
          )}
          {portInvalid && (
            <p className="text-[10px] text-danger">Enter an integer between 1 and 65535</p>
          )}
          {saveError && <p className="text-[10px] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
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
              className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSettings()}
              disabled={saving || portInvalid || !settingsDirty}
              className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 py-1">
            {llm?.posture ? (
              <PostureBadge posture={llm.posture} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted" />
            )}
            <p className="text-xs text-muted">
              {llm?.posture?.auth === "protected"
                ? `${llm.posture.label} on :${llmPort}`
                : `No model loaded on :${llmPort}`}
            </p>
          </div>
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
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <BackendBadge backend={llm?.backend ?? null} />
            {llm?.posture && <PostureBadge posture={llm.posture} />}
            {llm?.modelId && (
              <span
                className="min-w-0 flex-1 truncate text-xs text-text"
                title={llm.modelId}
              >
                {llm.modelId}
              </span>
            )}
            <span className="shrink-0 font-tabular text-[10px] text-muted">:{llmPort}</span>
          </div>
          {llm?.modelPath && (
            <div className="-mt-1.5 truncate text-[10px] text-muted" title={llm.modelPath}>
              {llm.modelPath}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Generation tok/s</span>
            <div className="flex items-center gap-2">
              <Sparkline data={genHistory} color="var(--color-accent)" height={24} />
              <span className="font-tabular text-sm font-semibold text-accent">
                {generationTps.toFixed(1)}
              </span>
            </div>
          </div>

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
                {(llm?.slotsTotal ?? 0) > 0
                  ? `${llm?.slotsActive ?? 0} / ${llm?.slotsTotal ?? 0}`
                  : (llm?.slotsActive ?? 0) > 0
                    ? `${llm?.slotsActive} running`
                    : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Context</div>
              <div className="font-tabular text-sm text-text">
                {llm?.contextLength ? llm.contextLength.toLocaleString() : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
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
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  {engineInfoOpen && (
                    <div
                      onMouseEnter={clearEngineInfoTimer}
                      onMouseLeave={startEngineInfoTimer}
                      className="absolute left-0 top-full z-10 mt-1 w-56 rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case text-text shadow-lg"
                    >
                      Active = processing or ready for requests. Sleeping = idle, GPU memory freed until next request.
                    </div>
                  )}
                </button>
              </div>
              <div className="font-tabular text-sm text-text">
                {llm?.gpuMemoryUtilization != null
                  ? llm.gpuMemoryUtilization === 0
                    ? "Sleeping"
                    : "Active"
                  : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Total Generated</div>
              <div className="font-tabular text-sm text-text">
                {llm && llm.totalOutputTokens > 0
                  ? llm.totalOutputTokens.toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>

          {llm?.backend === "vllm" && (
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

          {llm?.backend === "vllm" && (
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
        </div>
      )}

      <BenchmarkDialog
        open={benchOpen}
        onClose={() => setBenchOpen(false)}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={llm?.modelId ?? null}
      />
    </Panel>
  );
}