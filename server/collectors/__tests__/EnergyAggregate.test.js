/**
 * Unit tests for the energy aggregation -> day / week / month buckets.
 *
 * Input is the daily series [{ date, total, sparks }]. These tests cover
 * per-day passthrough, ISO-week (Monday-start) grouping, calendar-month
 * grouping, per-spark summation, and ascending ordering.
 *
 * Uses node:test (shipped with Node 22) — no dependencies.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { aggregate, buildBuckets } from "../EnergyAggregate.js";

const sparkPair = (a, b) => ({ anton: a, "son-of-anton": b });

// A week of days: 2026-07-27 (Mon) .. 2026-08-02 (Sun)
const WEEK = [
  { date: "2026-07-27", total: 10, sparks: sparkPair(6, 4) },
  { date: "2026-07-28", total: 11, sparks: sparkPair(6.5, 4.5) },
  { date: "2026-07-29", total: 12, sparks: sparkPair(7, 5) },
  { date: "2026-07-30", total: 13, sparks: sparkPair(7.5, 5.5) },
  { date: "2026-07-31", total: 14, sparks: sparkPair(8, 6) },
  { date: "2026-08-01", total: 15, sparks: sparkPair(8.5, 6.5) },
  { date: "2026-08-02", total: 16, sparks: sparkPair(9, 7) },
];

test("day aggregation passes through one bucket per day", () => {
  const out = aggregate(WEEK, "day");
  assert.equal(out.length, 7);
  assert.equal(out[0].date, "2026-07-27");
  assert.equal(out[0].label, "07/27");
  assert.equal(out[0].value, 10);
  assert.deepEqual(out[0].sparks, sparkPair(6, 4));
  // ascending
  assert.equal(out[6].date, "2026-08-02");
});

test("week aggregation groups a Mon-Sun span into one bucket", () => {
  const out = aggregate(WEEK, "week");
  assert.equal(out.length, 1);
  assert.equal(out[0].date, "2026-07-27"); // Monday start
  assert.equal(out[0].label, "07/27");
  // Sum = 10+11+12+13+14+15+16 = 91
  assert.ok(Math.abs(out[0].value - 91) < 0.01, `got ${out[0].value}`);
  // Per-spark sums: anton = 6+6.5+7+7.5+8+8.5+9 = 52.5; son = 38.5
  assert.ok(Math.abs(out[0].sparks.anton - 52.5) < 0.01);
  assert.ok(Math.abs(out[0].sparks["son-of-anton"] - 38.5) < 0.01);
});

// Two weeks + one day in a second calendar month
const SPAN = [
  ...WEEK, // Mon 07/27 .. Sun 08/02
  { date: "2026-08-03", total: 5, sparks: sparkPair(3, 2) }, // Mon 08/03 -> week 08/03
  { date: "2026-08-04", total: 7, sparks: sparkPair(4, 3) }, // same week
];

test("week aggregation splits across Monday boundaries", () => {
  const out = aggregate(SPAN, "week");
  assert.equal(out.length, 2);
  assert.equal(out[0].date, "2026-07-27");
  assert.equal(out[1].date, "2026-08-03");
  assert.ok(Math.abs(out[1].value - 12) < 0.01, `got ${out[1].value}`);
});

test("month aggregation groups by calendar month", () => {
  const out = aggregate(SPAN, "month");
  assert.equal(out.length, 2);
  assert.equal(out[0].date, "2026-07-01");
  assert.equal(out[0].label, "Jul");
  assert.equal(out[1].date, "2026-08-01");
  assert.equal(out[1].label, "Aug");
  // July = the 5 days in July (07-27..07-31) = 10+11+12+13+14 = 60
  assert.ok(Math.abs(out[0].value - 60) < 0.01, `got ${out[0].value}`);
  // August = 08-01+08-02+08-03+08-04 = 15+16+5+7 = 43
  assert.ok(Math.abs(out[1].value - 43) < 0.01, `got ${out[1].value}`);
});

test("year aggregation groups by calendar year", () => {
  const out = aggregate(SPAN, "year");
  assert.equal(out.length, 1);
  assert.equal(out[0].date, "2026-01-01");
  assert.equal(out[0].label, "2026");
  // Total of SPAN = 91 (the week) + 5 + 7 = 103
  assert.ok(Math.abs(out[0].value - 103) < 0.01, `got ${out[0].value}`);
  // Per-spark sums across the whole span: anton + son-of-anton = 103
  assert.ok(Math.abs(out[0].sparks.anton + out[0].sparks["son-of-anton"] - 103) < 0.01);
});

test("empty series yields empty buckets", () => {
  const out = aggregate([], "month");
  assert.deepEqual(out, []);
});

test("buildBuckets returns all four periods", () => {
  const b = buildBuckets(SPAN);
  assert.equal(b.day.length, 9);
  assert.equal(b.week.length, 2);
  assert.equal(b.month.length, 2);
  assert.equal(b.year.length, 1);
});
