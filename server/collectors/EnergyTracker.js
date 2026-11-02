/**
 * EnergyTracker — integrates per-Spark GPU power draw (W) into per-calendar-day
 * watt-hours (Wh), persisted to disk so totals survive restarts and accumulate
 * even while no browser is open (the broadcast loop feeds it every poll tick).
 *
 * Data stored in config/gpu-wh.json — dates are the top-level keys, `version`
 * is the only reserved key. Each date maps to per-Spark Wh:
 *   { version: 1, "YYYY-MM-DD": { sparkId: wh } }
 */
import fs from "fs";
import path from "path";
import { ROOT } from "../config.js";

const ENERGY_PATH =
  process.env.GPU_WH_PATH || path.join(ROOT, "config", "gpu-wh.json");
/** Mutable so tests can point saves at a temp file instead of real runtime data. */
let _energyPath = ENERGY_PATH;
/** Ignore gaps larger than this (spark offline / paused / just booted) — no backfill. */
const MAX_GAP_MS = 60_000;
/** Bound the file by pruning days older than this (≈14 months so year facts hold). */
const KEEP_DAYS = 400;
/** Debounce between writes to disk. */
const SAVE_DEBOUNCE_MS = 30_000;

let _state = { version: 1 };
/** sparkId → { ts, drawW } — the last power reading used for trapezoid integration. */
let _last = new Map();
let _lastSave = 0;
let _flushTimer = null;

/** Local calendar date key, e.g. "2026-08-01". */
export function _getDateKey(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  try {
    if (fs.existsSync(_energyPath)) {
      const parsed = JSON.parse(fs.readFileSync(_energyPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        // Migrate the old { daily: {...} } wrapper → dates at the top level.
        if (parsed.daily && typeof parsed.daily === "object") {
          const next = { version: parsed.version || 1 };
          for (const [k, v] of Object.entries(parsed.daily)) next[k] = v;
          _state = next;
        } else {
          _state = parsed;
        }
      }
    }
  } catch {
    /* corrupt or missing — start fresh */
  }
}

function save() {
  try {
    const now = Date.now();
    if (now - _lastSave < SAVE_DEBOUNCE_MS) return;
    _lastSave = now;
    fs.mkdirSync(path.dirname(_energyPath), { recursive: true });
    fs.writeFileSync(_energyPath + ".tmp", JSON.stringify(_state, null, 2), "utf8");
    fs.renameSync(_energyPath + ".tmp", _energyPath);
  } catch (err) {
    console.error("[EnergyTracker] save failed:", err.message);
  }
}

/** Force a write now, bypassing the debounce. Used on graceful shutdown. */
export function flush() {
  _lastSave = 0;
  save();
}

/**
 * Periodically flush to disk so a crash/restart loses at most one interval
 * (instead of being bounded only by the debounce). Cleared via stopEnergyFlush.
 * @param {number} [intervalMs=60_000]
 */
export function startEnergyFlush(intervalMs = 60_000) {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => save(), intervalMs);
}

export function stopEnergyFlush() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

function prune() {
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const keys = Object.keys(_state).filter((k) => DAY_RE.test(k)).sort();
  if (keys.length > KEEP_DAYS) {
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete _state[k];
  }
}

export function _resetForTest(path) {
  _state = { version: 1 };
  _last = new Map();
  _lastSave = 0;
  stopEnergyFlush();
  // Point saves at a temp file so unit tests never touch real runtime data.
  if (typeof path === "string") _energyPath = path;
}

/**
 * Integrate a power sample (W) for a spark into today's Wh.
 * Uses trapezoid (avg of previous & current reading) × elapsed hours.
 * Gaps > MAX_GAP_MS are not backfilled — the spark was likely offline/paused.
 */
export function recordPower(sparkId, drawW, nowMs = Date.now()) {
  if (!Number.isFinite(drawW) || drawW <= 0) return; // offline / no reading
  const prev = _last.get(sparkId);
  if (prev && nowMs - prev.ts <= MAX_GAP_MS) {
    const dtHours = (nowMs - prev.ts) / 3_600_000;
    const avgW = (prev.drawW + drawW) / 2;
    if (dtHours > 0) {
      const key = _getDateKey(nowMs);
      if (!_state[key]) _state[key] = {};
      _state[key][sparkId] = (_state[key][sparkId] || 0) + avgW * dtHours;
    }
  }
  _last.set(sparkId, { ts: nowMs, drawW });
  prune();
  save();
}

/** Total Wh across all sparks for the local calendar day of nowMs. */
export function getTodayWh(nowMs = Date.now()) {
  const bucket = _state[_getDateKey(nowMs)] || {};
  return Object.values(bucket).reduce((s, v) => s + v, 0);
}

/** Per-spark Wh map for the local calendar day of nowMs. */
export function getTodayWhBySpark(nowMs = Date.now()) {
  return { ...(_state[_getDateKey(nowMs)] || {}) };
}

/**
 * Full daily energy history, sorted ascending by date.
 * @returns {{ date: string, total: number, sparks: Record<string, number> }[]}
 */
export function getEnergyHistory() {
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dates = Object.keys(_state).filter((k) => DAY_RE.test(k)).sort();
  return dates.map((date) => {
    const sparks = { ...(_state[date] || {}) };
    const total = Object.values(sparks).reduce((s, v) => s + v, 0);
    return { date, total, sparks };
  });
}

load();

/** Test hook — reload state from disk (used to exercise migration paths). */
export function _reload() {
  load();
}
