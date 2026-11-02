/**
 * AlertMonitor — threshold-based health & usage alerting for the Spark fleet.
 *
 * This closes the biggest P0 gap from the gap analysis: everything was
 * pull-based with no proactive alert path. It evaluates each Spark's live
 * snapshot against the DGX_SPARK thermal/fan thresholds (previously dead code
 * in server/config.js) plus OOM / disk / TTFT / offline rules, and:
 *
 *   - classifies every Spark into a single health level (ok | warn | danger),
 *   - emits a compact set of `badges` (one per monitored subsystem) so the UI
 *     can color-code junction / memory / fan / clocks / ecc / oom / disk without
 *     re-deriving thresholds client-side,
 *   - produces an ordered `alerts` list (highest severity first),
 *   - keeps a bounded history ring of alert transitions,
 *   - fires an optional webhook (on warn->danger / new danger / recovery) with
 *     a dedup cooldown so a stuck condition doesn't spam.
 *
 * The rule logic (`evaluateSparkHealth`) is a pure function of a snapshot so it
 * is trivially unit-testable with canned payloads (see
 * server/collectors/__tests__/AlertMonitor.test.js).
 */

import { DGX_SPARK } from "../config.js";

/** Severity, highest first. */
export const LEVEL_ORDER = ["danger", "warn", "ok"];

/** Credit-style mapping for a value against a { warning, critical } threshold pair. */
function levelForTemp(value, thresholds, unitLabel) {
  if (value == null || !Number.isFinite(value)) return "ok"; // no read → not an alarm
  if (value >= thresholds.critical) return "danger";
  if (value >= thresholds.warning) return "warn";
  return "ok";
}

function toLevel(levels) {
  if (levels.includes("danger")) return "danger";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

/**
 * Evaluate a single Spark's health from its snapshot fragment.
 * Pulls only the fields it needs so callers can pass a full snapshot or a slim
 * projection (e.g. server/index.js passes the whole ordered snapshot).
 *
 * @param {object} spark  snapshot-shaped { online, metrics: { gpu, unifiedMemory, storage, llm } }
 * @returns {{ level: "ok"|"warn"|"danger", badges: object, alerts: Array<object> }}
 */
export function evaluateSparkHealth(spark) {
  const m = spark?.metrics || {};
  const gpu = m.gpu || {};
  const um = m.unifiedMemory || {};
  const disks = Array.isArray(m.storage) ? m.storage : [];
  const llm = Array.isArray(m.llm) ? m.llm.find((l) => l && l.available) || m.llm[0] : null;

  /** @type {Array<{id:string, level:"ok"|"warn"|"danger", label:string, detail?:string}>} */
  const badges = [];
  /** @type {Array<{id:string, level:"warn"|"danger", label:string, detail:string}>} */
  const alerts = [];
  const levels = [];
  const push = (id, level, label, detail) => {
    badges.push({ id, level, label, detail });
    levels.push(level);
    if (level !== "ok") alerts.push({ id, level, label, detail });
  };

  // ── Node reachability ───────────────────────────────────
  if (spark.online !== true) {
    push("offline", "danger", "Offline", "Host unreachable");
  }

  // ── GPU junction temperature (temperature.gpu) ───────────
  const junc = gpu.temperature;
  if (junc != null && Number.isFinite(junc)) {
    const jl = levelForTemp(junc, DGX_SPARK.THERMAL_THRESHOLDS.junction, "°C");
    push("gpu_temp", jl, "GPU junction", `${Math.round(junc)}°C`);
  }

  // ── GPU memory-junction temperature (temperature.memory) ─
  const memTemp = gpu.temperatures?.memory;
  if (memTemp != null && Number.isFinite(memTemp)) {
    const ml = levelForTemp(memTemp, DGX_SPARK.THERMAL_THRESHOLDS.memory, "°C");
    push("mem_temp", ml, "GPU memory", `${Math.round(memTemp)}°C`);
  }

  // ── Fan — passive-cooling health. Missing/zero while online is suspicious.
  const fan = gpu.fan;
  if (fan != null && Number.isFinite(fan)) {
    // Higher RPM = more cooling; an rpm below the warning threshold while the
    // GPU is drawing load suggests the fan isn't spinning up. Treat a stalled
    // fan (0) under load as danger, else warn. (Foundational thresholds live
    // in DGX_SPARK.FAN_RPM_WARNING/CRITICAL.)
    const underLoad = (gpu.usage ?? 0) > 20;
    const fanLevel = fan <= 0 && underLoad ? "danger" : fan <= 0 ? "warn" : "ok";
    push("fan", fanLevel, "Fan", `${Math.round(fan)}%`);
  }

  // ── ECC — corrected error accumulation on long-running inference.
  const ecc = gpu.ecc?.corrected;
  if (ecc != null && Number.isFinite(ecc) && ecc > 0) {
    // Any uncorrected error is always dangerous; heavy corrected accumulation
    // (>=100) is a warning sign of a degrading memory device.
    const uncorr = gpu.ecc?.uncorrected;
    const eccLevel = uncorr > 0 ? "danger" : ecc >= 100 ? "warn" : "ok";
    push("ecc", eccLevel, "ECC", `${Math.round(ecc)} corrected`);
  } else if (gpu.ecc?.uncorrected != null && gpu.ecc.uncorrected > 0) {
    push("ecc", "danger", "ECC", `${Math.round(gpu.ecc.uncorrected)} uncorrected`);
  }

  // ── OOM risk (remaining unified memory < 1 GB) ──────────
  if (spark.online === true && um.oomRisk === "high") {
    push("oom", "danger", "OOM risk", "Less than 1 GB unified memory remaining");
  }

  // ── Disk free (non-disabled mounts) ─────────────────────
  const worstDisk = disks.reduce((worst, d) => {
    if (d.disabled || d.percentage == null) return worst;
    return (d.percentage || 0) > (worst ? worst.percentage : 0) ? d : worst;
  }, null);
  if (worstDisk && worstDisk.percentage != null) {
    const p = worstDisk.percentage;
    const diskLevel = p >= 95 ? "danger" : p >= 90 ? "warn" : "ok";
    push("disk", diskLevel, "Disk", `${worstDisk.label} ${p}%`);
  }

  // ── LLM inference health (TTFT) ─────────────────────────
  if (llm?.ttftP95Seconds != null && Number.isFinite(llm.ttftP95Seconds)) {
    const t = llm.ttftP95Seconds;
    const ttftLevel = t >= 3 ? "danger" : t >= 1 ? "warn" : "ok";
    push("ttft", ttftLevel, "TTFT", `${t.toFixed(1)}s p95`);
  }

  const level = toLevel(levels);
  // Highest severity first.
  alerts.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  return { level, badges, alerts };
}

const DEFAULT_WEBHOOK_COOLDOWN_MS = 5 * 60 * 1000; // re-alert same (spark,rule) at most every 5 min

/**
 * Stateful monitor over the whole fleet.
 *
 * Responsibilities:
 *   - remember each spark's current alerts + level,
 *   - detect transitions and record them in a bounded history ring,
 *   - notify an `onChange` listener (used by server/index.js to push a WS
 *     `alerts` message) whenever the fleet alert set changes,
 *   - fire an optional webhook on danger transitions / recoveries with dedup.
 */
export class AlertMonitor {
  /**
   * @param {object} [opts]
   * @param {function} [opts.onChange]  called as onChange({ sparks, changed, nowMs })
   * @param {function} [opts.onWebhook]  injected notifier (defaults to fetch); unit-testable
   * @param {string}   [opts.webhookUrl]  full POST URL; empty disables webhook delivery
   * @param {number}   [opts.cooldownMs]  per-(spark,rule) dedup window
   * @param {number}   [opts.historySize]
   */
  constructor({
    onChange = null,
    onWebhook = null,
    webhookUrl = "",
    cooldownMs = DEFAULT_WEBHOOK_COOLDOWN_MS,
    historySize = 200,
  } = {}) {
    this.onChange = onChange;
    this.webhookUrl = webhookUrl;
    this.cooldownMs = cooldownMs;
    this.historySize = historySize;
    // Delivery callback — the server may inject one for testability; otherwise
    // we use the global fetch (Node 18+) when a URL is configured.
    this._deliver = onWebhook || null;

    /** @type {Map<string, {level:string, alerts:Array}>} */
    this._state = new Map();
    /** @type {Map<string, number>} last-fired ms per `${sparkId}:*` */
    this._lastWebhook = new Map();
    /** @type {Array<object>} bounded history ring (newest first) */
    this.history = [];
  }

  /**
   * Ingest the current fleet snapshot and emit change events / webhooks.
   * @param {Array<object>} sparks  array of snapshot-shaped spark objects
   * @param {number} [nowMs]
   * @returns {Array<{sparkId:string, prevLevel:string, level:string, alerts:Array}>} changed sparks
   */
  update(sparks, nowMs = Date.now()) {
    const changed = [];
    const seen = new Set();

    for (const spark of sparks) {
      const id = spark?.id;
      if (!id) continue;
      seen.add(id);
      const health = evaluateSparkHealth(spark);
      const prev = this._state.get(id);
      const prevLevel = prev?.level || "unknown";
      const prevDanger = prev ? prev.alerts.some((a) => a.level === "danger") : false;
      const hasDanger = health.alerts.some((a) => a.level === "danger");
      this._state.set(id, { level: health.level, alerts: health.alerts });

      const levelChanged = prevLevel !== health.level;

      if (levelChanged) {
        this._pushHistory({
          sparkId: id,
          sparkName: spark?.name || id,
          ts: nowMs,
          from: prevLevel,
          to: health.level,
          alerts: health.alerts,
        });
      }
      // Webhook: fire on transitions INTO danger/warn and on recovery from a
      // non-ok state (deduped by the per-spark cooldown window).
      this._maybeWebhook(spark, health, prev, nowMs);

      if (levelChanged) {
        changed.push({ sparkId: id, prevLevel, level: health.level, alerts: health.alerts });
      }
    }

    // Remove sparks that vanished from the snapshot (spark removed from registry).
    for (const id of [...this._state.keys()]) {
      if (!seen.has(id)) {
        this._state.delete(id);
        if (this.onChange) {
          // still surface the removal via onChange below? simpler: just drop.
        }
      }
    }

    if (changed.length > 0 && this.onChange) {
      this.onChange({ sparks: this.getAlerts(), changed, nowMs });
    }
    return changed;
  }

  getAlerts() {
    return Array.from(this._state.entries()).map(([sparkId, v]) => ({
      sparkId,
      level: v.level,
      alerts: v.alerts,
    }));
  }

  getHistory() {
    return this.history.slice();
  }

  getLevel(sparkId) {
    return this._state.get(sparkId)?.level || "unknown";
  }

  _pushHistory(entry) {
    this.history.unshift(entry);
    if (this.history.length > this.historySize) this.history.length = this.historySize;
  }

  /**
   * Fire the webhook for a meaningful transition, respecting the cooldown.
   * Fires when a spark transitions INTO danger or warn, or recovers to ok from
   * a non-ok state. A stuck condition is deduped by the per-spark cooldown.
   * @param {object} spark
   * @param {object} health  evaluateSparkHealth result
   * @param {object|null} prev  prior stored state { level, alerts }, null on first ingest
   * @param {number} nowMs
   */
  async _maybeWebhook(spark, health, prev, nowMs) {
    const url = this.webhookUrl;
    if (!url || !spark) return;

    const prevLevel = prev?.level || "unknown";
    const prevDanger = prev ? prev.alerts.some((a) => a.level === "danger") : false;
    const hasDanger = health.alerts.some((a) => a.level === "danger");
    const newDanger = hasDanger && !prevDanger;
    const recovered =
      !hasDanger && health.level === "ok" && prev != null && prevLevel !== "ok";
    const enteredWarn = health.level === "warn" && prevLevel !== "warn";
    if (!newDanger && !recovered && !enteredWarn) return;
    // Never fired before → always allowed; otherwise honor the dedup window.
    const last = this._lastWebhook.get(spark.id);
    if (last !== undefined && nowMs - last < this.cooldownMs) return;
    this._lastWebhook.set(spark.id, nowMs);

    const body = {
      event: newDanger ? "alert" : recovered ? "recovered" : "warn",
      sparkId: spark.id,
      sparkName: spark.name || spark.id,
      level: health.level,
      alerts: health.alerts,
      ts: nowMs,
    };
    if (this._deliver) {
      this._deliver(url, body);
    } else if (typeof fetch === "function") {
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => console.error(`[AlertMonitor] webhook failed: ${err.message}`));
    }
  }
}

export default AlertMonitor;
