import { useMemo } from "react";
import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { Sparkline } from "./../ui/Sparkline";
import {
  computePreemptionRate,
  normCount,
  ttftHealth,
  preemptionHealth,
  TTFT_OK_SECONDS,
  TTFT_SLOW_SECONDS,
  PREEMPTION_RATE_ALERT,
  type HealthLevel,
} from "../../utils/health";

const HEALTH_TEXT: Record<HealthLevel, string> = {
  ok: "OK",
  warn: "Warning",
  danger: "Degraded",
};

const LEVEL_CLASS: Record<HealthLevel, string> = {
  ok: "bg-success text-success",
  warn: "bg-warning text-warning",
  danger: "bg-danger text-danger",
};

const LEVEL_SPARK: Record<HealthLevel, string> = {
  ok: "var(--color-success, #4dbf91)",
  warn: "var(--color-warning, #e0a838)",
  danger: "var(--color-danger, #e5594d)",
};

function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GiB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MiB`;
  if (b >= 1 << 10) return `${(b / (1 << 10)).toFixed(0)} KiB`;
  return `${b} B`;
}

function fmtRate(r: number): string {
  if (r <= 0.001) return "0";
  return r < 10 ? r.toFixed(2) : r.toFixed(0);
}

function fmtTok(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function fmtDur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(Number(s))) return "—";
  const v = Number(s);
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)}s`;
  const m = Math.floor(v / 60);
  const r = Math.round(v % 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

/** One spark's preemption + TTFT row. Uses history hooks, so lives at panel level (no portal). */
function SparkPreemptionRow({ spark }: { spark: SparkSnapshot }) {
  const llm = pickLlm(spark);
  const portKey = getPortKey(spark);
  // Cumulative preemptions series → derive a per-interval rate over the visible window.
  const preemptionsSeries = useMetricsHistoryTail(spark.id, `llm${portKey}.preemptions`);
  const rate = computePreemptionRate(preemptionsSeries);
  const ttft = llm?.ttftP95Seconds != null ? llm.ttftP95Seconds : null;
  const ttftMean = llm?.ttftMeanSeconds != null ? llm.ttftMeanSeconds : null;
  const ttftLvl = ttftHealth(ttft);
  const premLvl = preemptionHealth(rate);

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-surface-hover/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-semibold text-text-strong">{spark.name}</span>
        {llm?.modelId && <span className="truncate text-[10px] text-muted">{llm.modelId}</span>}
      </div>
      <div className="ml-auto flex items-center gap-4">
        <div className="flex flex-col items-end">
          <span className="text-[9px] uppercase tracking-wide text-muted" title="Time-to-first-token, recent rolling window (p95 + mean)">TTFT p95 / mean</span>
          <span className="font-tabular text-xs font-semibold" style={{ color: LEVEL_SPARK[rankLevel(ttftLvl, null)] }}>
            {ttft != null ? `${ttft.toFixed(1)}s` : "—"}
            {ttftMean != null && <span className="text-muted"> / {ttftMean.toFixed(1)}s</span>}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[9px] uppercase tracking-wide text-muted">Preemptions/sample</span>
          <span className="font-tabular text-xs font-semibold" style={{ color: premLvl === "danger" ? LEVEL_SPARK.danger : premLvl === "warn" ? LEVEL_SPARK.warn : "var(--color-text-strong)" }}>
            {fmtRate(rate)}
          </span>
        </div>
        <div style={{ width: 84 }}>
          <Sparkline data={preemptionsSeries} width={84} height={22} color={LEVEL_SPARK[premLvl]} />
        </div>
      </div>
    </div>
  );
}

/**
 * Fleet inference-health panel: an oversubscription banner (E), a live
 * in-flight leaderboard separating streaming "hogs" from waiting "victims"
 * (C), and per-spark preemption + TTFT (D).
 */
export function InferenceHealthPanel({ sparks }: { sparks: SparkSnapshot[] }) {
  const onlineWithLlm = sparks.filter((s) => s.online && pickLlm(s));
  const llmArr = onlineWithLlm.map((s) => pickLlm(s) as LlmMetrics);

  // ── Fleet TTFT health (E) ────────────────────────────────
  const ttftLevels = llmArr.map((l) => ttftHealth(l.ttftP95Seconds)).filter((x): x is HealthLevel => x != null);
  const fleetTtft: HealthLevel | null =
    ttftLevels.length === 0 ? null : ttftLevels.some((l) => l === "danger") ? "danger" : ttftLevels.some((l) => l === "warn") ? "warn" : "ok";

  // ── Fleet queue state from auth-proxy (C) ────────────────
  // activeUsers is identical fleet-wide on every online spark's LLM entry.
  const fleetUsers = useMemo(() => {
    const source = onlineWithLlm.find((s) => pickLlm(s)?.activeUsers?.length);
    return source ? (pickLlm(source)?.activeUsers ?? []) : [];
  }, [onlineWithLlm]);

  const recentRequests = useMemo(() => {
    const source =
      onlineWithLlm.find((s) => (pickLlm(s)?.recentRequests?.length ?? 0) > 0) ??
      onlineWithLlm[0];
    const list = source ? (pickLlm(source)?.recentRequests ?? []) : [];
    return list.slice(0, 5);
  }, [onlineWithLlm]);

  const fleetRunning = fleetUsers.reduce((s, u) => s + normCount(u.activeCount), 0);
  const fleetWaiting = fleetUsers.reduce((s, u) => s + normCount(u.waitingCount), 0);
  const anyWaiting = fleetWaiting > 0;

  // ── Fleet preemption health (D) ──────────────────────────
  const fleetWaitHealth: HealthLevel = anyWaiting ? "warn" : "ok";
  const fleetLevel: HealthLevel =
    fleetTtft === "danger" ? "danger" : fleetTtft === "warn" ? "warn" : fleetWaitHealth;

  const bannerTone = LEVEL_CLASS[fleetLevel];
  const bannerColor = LEVEL_SPARK[fleetLevel];

  // Sort hogs (most active/streaming) first — they occupy GPU slots.
  const sortedUsers = [...fleetUsers].sort((a, b) =>
    (normCount(b.activeCount) + normCount(b.waitingCount)) - (normCount(a.activeCount) + normCount(a.waitingCount))
  );

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-strong">Inference Health</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${bannerTone}`}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: bannerColor }} />
            {HEALTH_TEXT[fleetLevel]}
          </span>
        </div>
        <span className="text-[10px] text-muted">TTFT &amp; preemption from vLLM · queue from auth-proxy</span>
      </div>

      {/* E: oversubscription banner — no-silent-failure signal */}
      <div
        className="mb-4 flex items-center gap-3 rounded-md px-3 py-2.5"
        style={{ background: "color-mix(in srgb, " + bannerColor + " 10%, transparent)", borderLeft: `3px solid ${bannerColor}` }}
      >
        <div className="flex-1 text-xs leading-snug">
          {onlineWithLlm.length === 0 ? (
            <span className="text-muted">No online Spark with LLM metrics — health assessment unavailable.</span>
          ) : fleetLevel === "ok" && (
            <span className="text-text-strong">Fleet is healthy — no queue, TTFT within range.</span>
          )}
          {onlineWithLlm.length > 0 && fleetLevel === "warn" && (
            <span className="text-warning">
              {anyWaiting
                ? `${fleetWaiting} request${fleetWaiting !== 1 ? "s" : ""} waiting · ` : ""}
              TTFT p95 above {TTFT_OK_SECONDS.toFixed(0)}s· Oversubscription building.
            </span>
          )}
          {fleetLevel === "danger" && (
            <span className="text-danger">
              {fleetTtft === "danger"? `TTFT p95 above ${TTFT_SLOW_SECONDS.toFixed(0)}s · ` : ""}
              Requests are experiencing degraded latency{anyWaiting ? ` — ${fleetWaiting} waiting` : ""}.
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 font-tabular text-xs">
          <span className="text-success">{fleetRunning} active</span>
          <span className="text-warning">{fleetWaiting} waiting</span>
        </div>
      </div>

      {/* C: in-flight leaderboard + last 5 completed */}
      <div className="mb-4">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {fleetUsers.length > 0
            ? "In-Flight Users · active streams occupy GPU slots"
            : "Recent Requests · last 5 completed (auth-proxy)"}
        </div>

        {fleetUsers.length > 0 ? (
          <div className="mb-3 flex flex-col gap-1.5">
            {sortedUsers.map((u) => {
              const act = normCount(u.activeCount);
              const wait = normCount(u.waitingCount);
              const isHog = act > 0;
              const isVictim = wait > 0;
              const inL = fmtTok(u.promptEstTokens);
              const outL = fmtTok(u.completionEstTokens);
              const maxL = u.maxTokens != null ? fmtTok(u.maxTokens) : null;
              const cacheL = u.cachedTokens != null ? fmtTok(u.cachedTokens) : null;
              const cachePct =
                u.cacheHitPct != null && Number.isFinite(Number(u.cacheHitPct))
                  ? `${Math.round(Number(u.cacheHitPct))}%`
                  : null;
              const inPart =
                inL !== "—"
                  ? cacheL && cacheL !== "—"
                    ? `in ${inL} (${cacheL} cached${cachePct ? ` · ${cachePct}` : ""})`
                    : `in ${inL}`
                  : null;
              const io =
                inPart || outL !== "—"
                  ? `${inPart ?? "in —"} · out ${outL}${maxL && maxL !== "—" ? ` / max ${maxL}` : ""}`
                  : null;
              return (
                <div key={u.label} className="flex items-center gap-3 rounded border border-border bg-surface-hover/30 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-text-strong">{u.label}</span>
                  {io && (
                    <span className="hidden font-tabular text-[10px] text-muted sm:inline" title="Live prompt / completion estimates">
                      {io}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${isHog ? "bg-success/15 text-success" : "bg-surface-hover text-muted"}`}
                    title="Actively streaming requests (occupying GPU slots)"
                  >
                    {act} streaming
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${isVictim ? "bg-warning/20 text-warning" : "bg-surface-hover text-muted"}`}
                    title="Requests waiting for their first response byte"
                  >
                    {wait} waiting
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted" title="Cumulative prompt bytes forwarded">
                    {fmtBytes(normCount(u.inputBytes))}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Always show last 5 completed when available */}
        {recentRequests.length > 0 ? (
          <div className={fleetUsers.length > 0 ? "mt-1" : ""}>
            {fleetUsers.length > 0 && (
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                Last 5 completed
              </div>
            )}
            <div className="flex flex-col gap-1">
              {recentRequests.map((r) => {
                const inL = fmtTok(r.promptEstTokens);
                const outL = fmtTok(r.completionEstTokens);
                const maxL = r.maxTokens != null ? fmtTok(r.maxTokens) : null;
                const cacheL = r.cachedTokens != null ? fmtTok(r.cachedTokens) : null;
                const cachePct =
                  r.cacheHitPct != null && Number.isFinite(Number(r.cacheHitPct))
                    ? `${Math.round(Number(r.cacheHitPct))}%`
                    : null;
                const src =
                  r.completionSource === "usage" || r.promptSource === "usage"
                    ? "usage"
                    : "est";
                return (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/80 bg-surface px-3 py-1.5"
                    title={[
                      r.model || "",
                      r.path || "",
                      `ttft ${r.ttftSec != null ? `${r.ttftSec}s` : "—"}`,
                      r.cachedTokens != null
                        ? `cache ${cacheL} (${cachePct ?? "?"} of prompt)`
                        : "cache n/a",
                      `id ${r.id}`,
                      src,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <span className="w-14 shrink-0 font-mono text-xs font-medium text-text-strong">
                      {r.user}
                    </span>
                    <span className="min-w-0 flex-1 font-tabular text-[11px] text-text">
                      in {inL}
                      {cacheL && cacheL !== "—" ? (
                        <span className="text-muted">
                          {" "}
                          ({cacheL} cached{cachePct ? ` · ${cachePct}` : ""})
                        </span>
                      ) : null}
                      <span className="text-muted"> · </span>
                      out {outL}
                      {maxL && maxL !== "—" ? (
                        <span className="text-muted"> / max {maxL}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-tabular text-[10px] text-muted" title="Total duration">
                      {fmtDur(r.durationSec)}
                    </span>
                    <span
                      className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted"
                      title={src === "usage" ? "Official usage from stream" : "chars÷4 estimate"}
                    >
                      {src}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : fleetUsers.length === 0 ? (
          <div className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            No in-flight or recent requests. After traffic flows, the last 5 completed calls appear here with in / out / max.
          </div>
        ) : null}
      </div>

      {/* D: per-spark preemption + TTFT */}
      {onlineWithLlm.length > 0 ? (
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Preemption &amp; first-token latency · threshold &gt;{PREEMPTION_RATE_ALERT}/sample
          </div>
          <div className="flex flex-col gap-1.5">
            {onlineWithLlm.map((s) => <SparkPreemptionRow key={s.id} spark={s} />)}
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted">No online Spark with LLM metrics.</div>
      )}
    </div>
  );
}

/** Pick the first available LLM probe for a spark, or null. */
function pickLlm(spark: SparkSnapshot): LlmMetrics | null {
  const arr = spark.metrics.llm;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((l) => l.available) ?? arr[0] ?? null;
}

/** Build the history port key for a spark's first LLM port. */
function getPortKey(spark: SparkSnapshot): string {
  const ports = spark.llmPorts ?? [];
  const llmArr = spark.metrics.llm;
  const idx = ports.findIndex((_p, i) => (llmArr as LlmMetrics[])?.[i]?.available);
  const port = ports[idx];
  return port != null ? `:${port}` : ":0";
}

/** Worst of two levels (null = no signal). */
function rankLevel(...levels: (HealthLevel | null)[]): HealthLevel {
  const present = levels.filter((l): l is HealthLevel => l != null);
  if (present.length === 0) return "ok";
  if (present.some((l) => l === "danger")) return "danger";
  if (present.some((l) => l === "warn")) return "warn";
  return "ok";
}
