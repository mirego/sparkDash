import { test } from "node:test";
import assert from "node:assert/strict";
import { getActiveUsers } from "../PerKeyUsageTracker.js";

/**
 * getActiveUsers() polls the auth-proxy /inflight endpoint and maps it into a
 * flat per-user list with separate active (streaming) / waiting (throttled)
 * stream counts plus cumulative input bytes — the raw material for the
 * Inference Health leaderboard.
 */
test("getActiveUsers maps /inflight to active/waiting/inputBytes per user", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      jaub: { waiting: 1, active: 2, inputBytes: 4096 },
      mmez: { waiting: 0, active: 3, inputBytes: 1024 },
      // A user with only waiting requests (negative active implies the proxy
      // may report active as 0; ensure we never emit negative counts).
      opin: { waiting: 2, active: 0, inputBytes: 8192 },
      // A prefix with zero total — should be omitted entirely.
      idle: { waiting: 0, active: 0, inputBytes: 0 },
    }),
  });

  try {
    const users = await getActiveUsers();

    const byLabel = Object.fromEntries(users.map((u) => [u.label, u]));

    // idle prefix dropped (no in-flight requests)
    assert.equal(byLabel["idle"], undefined);

    // jaub: 2 waiting + ... wait, input shows waiting:1 active:2 → total 3,
    // active 2, waitingCount 1.
    assert.equal(byLabel["jaub"].requests, 3);
    assert.equal(byLabel["jaub"].activeCount, 2);
    assert.equal(byLabel["jaub"].waitingCount, 1);
    assert.equal(byLabel["jaub"].waiting, true);
    assert.equal(byLabel["jaub"].inputBytes, 4096);

    // mmez: 3 active, 0 waiting → not "waiting"
    assert.equal(byLabel["mmez"].requests, 3);
    assert.equal(byLabel["mmez"].activeCount, 3);
    assert.equal(byLabel["mmez"].waitingCount, 0);
    assert.equal(byLabel["mmez"].waiting, false);

    // opin: 2 waiting, 0 active
    assert.equal(byLabel["opin"].requests, 2);
    assert.equal(byLabel["opin"].activeCount, 0);
    assert.equal(byLabel["opin"].waitingCount, 2);
    assert.equal(byLabel["opin"].waiting, true);

    // Fleet totals attached for the snapshot override.
    assert.equal(users._totalRunning, 5); // 2 + 3 + 0
    assert.equal(users._totalWaiting, 3); // 1 + 0 + 2
  } finally {
    global.fetch = originalFetch;
  }
});

test("getActiveUsers returns [] on proxy failure", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("proxy down");
  };
  try {
    const users = await getActiveUsers();
    assert.deepEqual(users, []);
  } finally {
    global.fetch = originalFetch;
  }
});
