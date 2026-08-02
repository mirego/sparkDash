/**
 * EnergyTracker — integrates per-Spark GPU power draw (W) into per-calendar-day
 * watt-hours (Wh), persisted to disk so totals survive restarts and accumulate
 * even while no browser is open (the broadcast loop feeds it every poll tick).
 *
 * Data stored in config/gpu-wh.json:
 *   { version: 1, daily: { "YYYY-MM-DD": { sparkId: wh } } }
 */
import fs from "fs";
import path from "path";
import { ROOT } from "../config.js";

const ENERGY_PATH =
  process.env.GPU_WH_PATH || path.join(ROOT, "config", "gpu-wh.json");
/** Ignore gaps larger than this (spark offline / paused / just booted) — no backfill. */
const MAX_GAP_MS = 60_000;
/** Bound the file by pruning days older than this. */
const KEEP_DAYS = 60;
/** Debounce between writes to disk. */
const SAVE_DEBOUNCE_MS = 30_000;

let _state = { version: 1, daily: {} };
/** sparkId → { ts, drawW } — the last power reading used for trapezoid integration. */
let _last = new Map();
let _lastSave = 0;

/** Local calendar date key, e.g. "2026-08-01". */
export function _getDateKey(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  try {
    if (fs.existsSync(ENERGY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(ENERGY_PATH, "utf8"));
      if (parsed && typeof parsed.daily === "object") _state = parsed;
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
    fs.mkdirSync(path.dirname(ENERGY_PATH), { recursive: true });
    fs.writeFileSync(ENERGY_PATH + ".tmp", JSON.stringify(_state, null, 2), "utf8");
    fs.renameSync(ENERGY_PATH + ".tmp", ENERGY_PATH);
  } catch (err) {
    console.error("[EnergyTracker] save failed:", err.message);
  }
}

function prune() {
  const keys = Object.keys(_state.daily).sort();
  if (keys.length > KEEP_DAYS) {
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete _state.daily[k];
  }
}

export function _resetForTest() {
  _state = { version: 1, daily: {} };
  _last = new Map();
  _lastSave = 0;
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
      if (!_state.daily[key]) _state.daily[key] = {};
      _state.daily[key][sparkId] = (_state.daily[key][sparkId] || 0) + avgW * dtHours;
    }
  }
  _last.set(sparkId, { ts: nowMs, drawW });
  prune();
  save();
}

/** Total Wh across all sparks for the local calendar day of nowMs. */
export function getTodayWh(nowMs = Date.now()) {
  const bucket = _state.daily[_getDateKey(nowMs)] || {};
  return Object.values(bucket).reduce((s, v) => s + v, 0);
}

/** Per-spark Wh map for the local calendar day of nowMs. */
export function getTodayWhBySpark(nowMs = Date.now()) {
  return { ...(_state.daily[_getDateKey(nowMs)] || {}) };
}

load();
