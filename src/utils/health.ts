/**
 * Inference-health signal helpers shared by the Overview fleet banner (E),
 * the In-Flight leaderboard (C), and the token-dialog overlay (A/B).
 *
 * Thresholds are deliberately config-able-in-one-place; they encode Gilfoyle's
 * "no silent failures" rule — TTFT creep and preemption are the two signals that
 * indicate the box is oversubscribed even when throughput looks fine.
 */

/** TTFT p95 in seconds — below this the experience feels snappy. */
export const TTFT_OK_SECONDS = 1.0;
/** TTFT p95 above this is "slow" and starts degrading the user experience. */
export const TTFT_SLOW_SECONDS = 3.0;

/**
 * Preemption rate per poll interval (≈ the auth-proxy/WS interval, ~2 s).
 * Above this sustained rate, requests are being evicted and the box is
 * meaningfully oversubscribed. Below, it's noise / rare.
 */
export const PREEMPTION_RATE_ALERT = 0.15;

export type HealthLevel = "ok" | "warn" | "danger";

/** Map a TTFT p95 (seconds) to a health level. null/undefined → no signal. */
export function ttftHealth(ttftSeconds: number | null | undefined): HealthLevel | null {
  if (ttftSeconds == null || !Number.isFinite(ttftSeconds)) return null;
  if (ttftSeconds < TTFT_OK_SECONDS) return "ok";
  if (ttftSeconds < TTFT_SLOW_SECONDS) return "warn";
  return "danger";
}

/**
 * Compute a preemption rate (preemptions per sample) from a cumulative
 * preemptions time-series. Deltas between consecutive samples are summed over
 * the window and divided by the number of intervals, so a one-off counter jump
 * is treated as a single event and a sustained climb is caught.
 */
export function computePreemptionRate(cumulative: readonly number[]): number {
  if (cumulative.length < 2) return 0;
  let totalDelta = 0;
  for (let i = 1; i < cumulative.length; i++) {
    const delta = cumulative[i] - cumulative[i - 1];
    if (delta > 0) totalDelta += delta;
  }
  // Deltas over N samples ⇒ N-1 intervals.
  return totalDelta / (cumulative.length - 1);
}

/** Map a preemption rate to a health level. */
export function preemptionHealth(rate: number): HealthLevel {
  if (rate <= 0) return "ok";
  if (rate < PREEMPTION_RATE_ALERT) return "warn";
  return "danger";
}

/** Normalize a possibly-missing per-user stream count to 0. */
export function normCount(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}


/** Engine phase labels for decode-bound diagnosis. */
export type EnginePhase = "IDLE" | "PREFILL" | "DECODE" | "SLOW_DECODE" | "QUEUED" | "DOWN" | string;

export function enginePhaseLabel(phase: EnginePhase | null | undefined): string {
  switch (phase) {
    case "IDLE": return "Idle";
    case "PREFILL": return "Prefill";
    case "DECODE": return "Decode";
    case "SLOW_DECODE": return "Slow decode";
    case "QUEUED": return "Queued";
    case "DOWN": return "Down";
    default: return phase ? String(phase) : "—";
  }
}

/**
 * Combined GPU+engine story for “util high, gen ~0”.
 * Returns null when no interesting signal.
 */
export function decodeSaturationHint(opts: {
  gpuUsage?: number | null;
  generationTps?: number | null;
  prefillTps?: number | null;
  requestsRunning?: number | null;
  decodeBound?: boolean | null;
  enginePhase?: EnginePhase | null;
}): { level: HealthLevel; label: string; detail: string } | null {
  const util = opts.gpuUsage ?? 0;
  const gen = opts.generationTps ?? 0;
  const pref = opts.prefillTps ?? 0;
  const run = opts.requestsRunning ?? 0;
  const bound = !!opts.decodeBound || opts.enginePhase === "SLOW_DECODE";
  if (bound && util >= 70 && gen < 5 && run >= 1) {
    return {
      level: "danger",
      label: "Decode saturated",
      detail: `GPU ${Math.round(util)}% busy while generation is ${gen.toFixed(1)} tok/s with ${Math.round(run)} running — long-context decode, not idle hang.`,
    };
  }
  if (bound) {
    return {
      level: "warn",
      label: "Slow decode",
      detail: `Engine phase slow-decode · gen ${gen.toFixed(1)} tok/s · prefill ${pref.toFixed(1)} · run ${Math.round(run)}.`,
    };
  }
  if (util >= 85 && gen < 2 && pref < 5 && run >= 1) {
    return {
      level: "warn",
      label: "Busy GPU, low gen",
      detail: `GPU ${Math.round(util)}% with gen ${gen.toFixed(1)} tok/s — likely decode-bound even if phase not flagged yet.`,
    };
  }
  return null;
}


/** Map vLLM waiting_by_reason label to short UI text. */
export function formatWaitReason(reason: string | null | undefined): string {
  if (!reason) return "—";
  switch (reason) {
    case "capacity": return "capacity";
    case "deferred": return "deferred";
    case "mixed": return "mixed";
    default: return String(reason);
  }
}

/** Detail sentence for engine wait reason. */
export function waitReasonDetail(reason: string | null | undefined): string {
  switch (reason) {
    case "capacity":
      return "Waiting for scheduling capacity — another request holds the batch/slot.";
    case "deferred":
      return "Deferred by a transient constraint (KV transfer, LoRA budget, blocked status).";
    case "mixed":
      return "Multiple wait reasons at once (capacity + deferred).";
    default:
      return reason
        ? `Engine wait reason: ${reason}.`
        : "No engine wait reason series.";
  }
}
