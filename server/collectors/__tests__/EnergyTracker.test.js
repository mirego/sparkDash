/**
 * Unit tests for the GPU energy tracker (Wh/day accumulation).
 *
 * The tracker integrates per-spark GPU power.draw (W) into per-calendar-day
 * watt-hours. These tests cover the pure integration math: trapezoid
 * accumulation, the >60s gap guard (no backfill), midnight rollover, zero/
 * offline handling, multi-spark summation, and forcing a disk flush.
 *
 * Each test points the tracker at a unique temp file (via _resetForTest(path))
 * so unit tests never touch or corrupt the real config/gpu-wh.json.
 *
 * Uses node:test (shipped with Node 22) — no dependencies required.
 * Run: npm test
 */
import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetForTest,
  recordPower,
  getTodayWh,
  getTodayWhBySpark,
  flush,
  _getDateKey,
} from "../EnergyTracker.js";

const TEMP = path.join(os.tmpdir(), `gpu-wh-test-${process.pid}.json`);

beforeEach(() => {
  _resetForTest(TEMP); // reset state AND redirect writes to the temp file
  try {
    fs.rmSync(TEMP, { force: true });
  } catch { /* ignore */ }
});

test("records Wh using trapezoid integration", () => {
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z
  recordPower("a", 100, t0);            // seed
  recordPower("a", 100, t0 + 2000);     // 100W * 2s
  recordPower("a", 200, t0 + 4000);     // avg(100,200)=150W * 2s
  const wh = getTodayWh(t0 + 4000);
  // (100*2 + 150*2) W·s / 3600 = 500/3600 Wh
  assert.ok(Math.abs(wh - 500 / 3600) < 0.001, `got ${wh}`);
});

test("does not backfill across a large gap", () => {
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0);
  // 5-minute gap (>> 60s guard) at high draw — must NOT count
  recordPower("a", 1000, t0 + 5 * 60_000);
  assert.equal(getTodayWh(t0 + 5 * 60_000), 0);
});

test("rolls daily bucket over midnight", () => {
  // Local-time timestamps (new Date(y,m,d,...) interprets in local TZ), so steps
  // cross local midnight regardless of host timezone. First call is a seed.
  const seed = new Date(2026, 7, 1, 23, 59, 56).getTime(); // local 23:59:56 (seed)
  const t0 = new Date(2026, 7, 1, 23, 59, 58).getTime(); // local 23:59:58 → day 1
  const t1 = new Date(2026, 7, 2, 0, 0, 3).getTime(); // local 00:00:03 → day 2
  recordPower("a", 100, seed); // seed, no increment
  recordPower("a", 100, t0); // 100W * 2s into day-1 bucket
  const day1Total = getTodayWh(t0);
  recordPower("a", 100, t1); // 100W * 5s into day-2 bucket (crosses midnight)
  const day2Total = getTodayWh(t1);
  assert.ok(day1Total > 0, "day 1 should have accumulated something");
  assert.ok(day2Total > 0, "day 2 should have accumulated the cross-midnight step");
  assert.notEqual(_getDateKey(t0), _getDateKey(t1));
});

test("zero/offline power does not accumulate", () => {
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 0, t0);
  recordPower("a", 0, t0 + 2000);
  assert.equal(getTodayWh(t0 + 2000), 0);
});

test("sums multiple sparks for the fleet pill", () => {
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0); recordPower("a", 100, t0 + 2000);
  recordPower("b", 200, t0); recordPower("b", 200, t0 + 2000);
  assert.ok(Math.abs(getTodayWh(t0 + 2000) - (300 * 2) / 3600) < 0.001);
  assert.deepEqual(Object.keys(getTodayWhBySpark(t0 + 2000)), ["a", "b"]);
});

test("flush forces accumulated data to disk", () => {
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0); // seed
  recordPower("a", 100, t0 + 2000); // accumulate
  flush();
  assert.ok(fs.existsSync(TEMP), "flush() should write the temp file");
  const onDisk = JSON.parse(fs.readFileSync(TEMP, "utf8"));
  const day = onDisk.daily[_getDateKey(t0)] || {};
  assert.ok(day.a > 0, "flushed file should contain today's Wh for spark a");
});
