/**
 * Unit tests for LlmProbe's rolling TTFT window (recent p95/mean).
 *
 * The raw vLLM TTFT histogram is cumulative over the process lifetime, so a
 * single historical overload burst pins the p95 for the whole engine uptime —
 * the exact "TTFT shows 9s but tokens stream fast" confusion. These tests
 * verify that _pushTtftWindow/_recentTtft compute p95/mean from *delta* samples
 * (new requests since the last poll) within a bounded lookback, so the number
 * drains stale overload once the recent window rolls past it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const stubSpark = { lanIp: "127.0.0.1" };
function makeProbe() {
  return new LlmProbe(stubSpark, 8888);
}

/** Build a parsed-histogram object from raw bucket counts (capped at a max finite le). */
function hist(counts, total) {
  const buckets = Object.entries(counts)
    .map(([upper, count]) => ({ upper: parseFloat(upper), count }))
    .sort((a, b) => a.upper - b.upper);
  return { buckets, total };
}

/** Reproduce the fully-cumulative bucket counts vLLM reports for the next poll. */
function nextCumulative(prev, added, prevTotal) {
  const out = { ...prev };
  let total = prevTotal;
  for (const [upper, n] of Object.entries(added)) {
    out[upper] = (out[upper] || 0) + n;
    total += n;
  }
  return { counts: out, total };
}

test("rolling TTFT reflects only recent deltas, not the lifetime pyramid", () => {
  const probe = makeProbe();
  probe._ttftWindowMs = 5 * 60 * 1000;

  // Poll 1: 100 fast samples (all ≤0.1s). Primes prev state (first poll
  // establishes baseline, contributes 0 deltas — nothing to compare yet).
  let c1 = hist({ "0.1": 100, "0.5": 100, "10": 100 }, 100);
  probe._pushTtftWindow(c1, 10); // sum 10 ⇒ mean 0.1s
  let t1 = probe._recentTtft();
  assert.deepEqual(t1, { p95: null, mean: null }, "first poll only sets baseline, no window yet");

  // Poll 2: 100 MORE fast samples (total now 200). Delta = 100 fast.
  const c2 = nextCumulative({ "0.1": 100, "0.5": 100, "10": 100 }, { "0.1": 100 }, 100);
  probe._pushTtftWindow(hist(c2.counts, c2.total), 20); // added sum 10 ⇒ recent mean 0.1s
  const t2 = probe._recentTtft();
  assert.ok(t2.p95 != null && t2.p95 <= 0.1 + 1e-9, `recent p95 should be ~0.1s, got ${t2.p95}`);
  assert.ok(Math.abs(t2.mean - 0.1) < 1e-9, `recent mean should be 0.1s, got ${t2.mean}`);

  // Poll 3: a slow burst — 10 samples land in the 10s bucket.
  const c3 = nextCumulative(c2.counts, { "10": 10 }, c2.total);
  probe._pushTtftWindow(hist(c3.counts, c3.total), 20 + 100); // added sum ~100 (10s*10)
  const t3 = probe._recentTtft();
  // 110 recent samples: 100 fast + 10 slow. p95 target=104.5 → past the 100
  // fast samples, interpolating inside the le=10 bucket (uniform 0.1→10 fills
  // the gap) → several seconds, far above the 0.1s baseline. Mean ≈1.0s.
  assert.ok(t3.p95 >= 4, `p95 should jump to multi-second after the burst, got ${t3.p95}`);
  assert.ok(t3.mean > 0.8 && t3.mean < 1.05, `mean should rise to ~1s, got ${t3.mean}`);

  // Poll 4: reset state and feed only fast samples again — the slow burst is
  // gone, so recent p95/mean must drop back to fast.
  probe._ttftWindow = [];
  probe._prevTtftHist = null;
  probe._pushTtftWindow(hist({ "0.1": 100, "10": 100 }, 100), 10); // baseline
  const d4 = nextCumulative({ "0.1": 100, "10": 100 }, { "0.1": 100 }, 100);
  probe._pushTtftWindow(hist(d4.counts, d4.total), 20); // +100 fast, sum +10
  const t4 = probe._recentTtft();
  assert.ok(t4.p95 <= 0.1 + 1e-9, `p95 should drop back to fast after drain, got ${t4.p95}`);
  assert.ok(Math.abs(t4.mean - 0.1) < 1e-9, `mean should drop back to 0.1s, got ${t4.mean}`);
});

test("rolling TTFT returns nulls until enough recent samples accumulate", () => {
  const probe = makeProbe();
  probe._ttftMinSamples = 5;

  probe._pushTtftWindow(hist({ "0.1": 1, "1": 1 }, 1), 0.1);
  const next = nextCumulative({ "0.1": 1, "1": 1 }, { "0.1": 1 }, 1);
  probe._pushTtftWindow(hist(next.counts, next.total), 0.1 + 0.1);
  assert.deepEqual(probe._recentTtft(), { p95: null, mean: null });

  const next2 = nextCumulative(next.counts, { "0.1": 5 }, next.total);
  probe._pushTtftWindow(hist(next2.counts, next2.total), 0.6);
  const t = probe._recentTtft();
  assert.ok(t.p95 != null, "p95 should appear once recent samples hit the minimum");
  assert.ok(t.mean != null, "mean should appear once recent samples hit the minimum");
});

test("rolling TTFT prunes samples older than the lookback window", () => {
  const probe = makeProbe();
  probe._ttftWindowMs = 1000; // 1s lookback for the test
  probe._ttftMinSamples = 1;

  probe._pushTtftWindow(hist({ "0.1": 1, "1": 1 }, 1), 0.1);
  probe._pushTtftWindow(hist({ "0.1": 2, "1": 2 }, 2), 0.2);
  assert.ok(probe._recentTtft().p95 != null);

  // Age the existing window entry beyond the lookback, then add a fresh one.
  // The aged entry must be pruned so p95 reflects only the new sample.
  for (const e of probe._ttftWindow) e.ts -= 2000;
  const next = nextCumulative({ "0.1": 2, "1": 2 }, { "0.1": 1 }, 2);
  probe._pushTtftWindow(hist(next.counts, next.total), 0.3);
  const t = probe._recentTtft();
  assert.ok(t.p95 != null && t.p95 <= 0.1 + 1e-9, `stale entry should be pruned, got p95 ${t.p95}`);
});
