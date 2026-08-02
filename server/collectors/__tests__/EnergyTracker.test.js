/**
 * Unit tests for the GPU energy tracker (Wh/day accumulation).
 *
 * The tracker integrates per-spark GPU power.draw (W) into per-calendar-day
 * watt-hours. These tests cover the pure integration math: trapezoid
 * accumulation, the >60s gap guard (no backfill), midnight rollover, zero/
 * offline handling, and multi-spark summation for the fleet pill.
 *
 * Uses node:test (shipped with Node 22) — no dependencies required.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  _resetForTest,
  recordPower,
  getTodayWh,
  getTodayWhBySpark,
  _getDateKey,
} from "../EnergyTracker.js";

test("records Wh using trapezoid integration", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z
  recordPower("a", 100, t0);            // seed
  recordPower("a", 100, t0 + 2000);     // 100W * 2s
  recordPower("a", 200, t0 + 4000);     // avg(100,200)=150W * 2s
  const wh = getTodayWh(t0 + 4000);
  // (100*2 + 150*2) W·s / 3600 = 500/3600 Wh
  assert.ok(Math.abs(wh - 500 / 3600) < 0.001, `got ${wh}`);
});

test("does not backfill across a large gap", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0);
  // 5-minute gap (>> 60s guard) at high draw — must NOT count
  recordPower("a", 1000, t0 + 5 * 60_000);
  assert.equal(getTodayWh(t0 + 5 * 60_000), 0);
});

test("rolls daily bucket over midnight", () => {
  _resetForTest();
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
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 0, t0);
  recordPower("a", 0, t0 + 2000);
  assert.equal(getTodayWh(t0 + 2000), 0);
});

test("sums multiple sparks for the fleet pill", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0); recordPower("a", 100, t0 + 2000);
  recordPower("b", 200, t0); recordPower("b", 200, t0 + 2000);
  assert.ok(Math.abs(getTodayWh(t0 + 2000) - (300 * 2) / 3600) < 0.001);
  assert.deepEqual(Object.keys(getTodayWhBySpark(t0 + 2000)), ["a", "b"]);
});
