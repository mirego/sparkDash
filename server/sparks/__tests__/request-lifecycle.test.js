import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLifecycleTracker } from "../../events/RequestLifecycle.js";
import { EventLog } from "../../events/EventLog.js";

function users(source, open = [], recent = []) {
  const u = [];
  u._source = source;
  u._openRequests = open;
  u._recentRequests = recent;
  return u;
}

function makeTracker({ record = () => null, now = () => 100_000, ...opts } = {}) {
  return new RequestLifecycleTracker({
    record,
    resolveSparkId: (request) => request.sparkId ?? null,
    sparkName: (id) => `spark-${id}`,
    now,
    ...opts,
  });
}

const source = (status = "legacy", fetchedAt = 100_000, bootId = null) => ({ status, fetchedAt, bootId });
const request = (id, extra = {}) => ({ id, user: "user-a", model: "model-a", state: "streaming", sparkId: "s1", ...extra });

test("initial hydration maps pending and active requests newest-start-first", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("legacy", 100_000), [
    request("raw-queued", { state: "queued", startedAt: 95 }),
    request("raw-streaming", { state: "streaming", startedAt: 98 }),
  ]));
  const snap = tracker.snapshot();
  assert.equal(snap.status, "legacy");
  assert.deepEqual(snap.requests.map((row) => row.lifecycle), ["active", "pending"]);
  assert.deepEqual(snap.requests.map((row) => row.startedAt), [98_000, 95_000]);
  assert.equal(events.length, 0);
});

test("updates lifecycle and counts without changing its opaque key", () => {
  const tracker = makeTracker();
  tracker.ingest(users(source("ok", 100_000), [request("raw-update", { state: "queued", startedAt: 95, promptEstTokens: 2 })]));
  const first = tracker.snapshot().requests[0];
  tracker.ingest(users(source("ok", 101_000), [request("raw-update", { state: "streaming", startedAt: 95, promptEstTokens: 8, completionEstTokens: 3 })]));
  const next = tracker.snapshot().requests[0];
  assert.equal(next.key, first.key);
  assert.equal(next.lifecycle, "active");
  assert.equal(next.promptEstTokens, 8);
  assert.equal(next.completionEstTokens, 3);
});

test("legacy disappearance emits one unknown terminal event", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("legacy", 100_000), [request("raw-legacy", { startedAt: 95 })]));
  tracker.ingest(users(source("legacy", 101_000), [], [{ id: "raw-legacy", finishedAt: 100.5 }]));
  tracker.ingest(users(source("legacy", 102_000), []));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "request.ended");
  assert.equal(events[0].severity, "info");
  assert.equal(events[0].data.outcome, "unknown");
  assert.equal(events[0].data.outcomeKnown, false);
});

test("v2 terminal outcomes determine event severity", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("ok", 100_000), [request("raw-disconnect", { startedAt: 95 })]));
  tracker.ingest(users(source("ok", 101_000), [], [{ id: "raw-disconnect", outcome: "client_disconnect", finishedAt: 100.5 }]));
  tracker.ingest(users(source("ok", 102_000), [request("raw-completed", { startedAt: 101 })]));
  tracker.ingest(users(source("ok", 103_000), [], [{ id: "raw-completed", outcome: "completed", finishedAt: 102.5 }]));
  assert.deepEqual(events.map((event) => [event.data.outcome, event.severity]), [
    ["client_disconnect", "warn"],
    ["completed", "success"],
  ]);
});

test("unavailable polls preserve requests and recovery reconciles terminal rows", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("ok", 100_000), [request("raw-recovery", { startedAt: 95 })]));
  tracker.markUnavailable(new Error("proxy down"));
  assert.equal(tracker.snapshot().status, "unavailable");
  assert.equal(tracker.snapshot().stale, true);
  assert.equal(tracker.snapshot().requests.length, 1);
  assert.equal(events.length, 0);
  tracker.ingest(users(source("ok", 102_000), [request("raw-recovery", { startedAt: 95 })]));
  assert.equal(tracker.snapshot().status, "ok");
  assert.equal(events.length, 0);
  tracker.ingest(users(source("ok", 103_000), [], [{ id: "raw-recovery", outcome: "unknown" }]));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.outcome, "unknown");
});

test("last successful poll ages to stale", () => {
  let now = 100_000;
  const tracker = makeTracker({ now: () => now, staleAfterMs: 5000 });
  tracker.ingest(users(source("ok", 90_000)));
  now = 96_000;
  assert.equal(tracker.snapshot().status, "stale");
});

test("recent ring backfills in-window completions once and ignores pre-tracking rows", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("ok", 100_000), [], [
    { id: "raw-old", outcome: "completed", finishedAt: 97 },
    { id: "raw-ring", outcome: "completed", finishedAt: 99 },
  ]));
  tracker.ingest(users(source("ok", 101_000), [], [{ id: "raw-ring", outcome: "completed", finishedAt: 99 }]));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.endReason, "finished-between-polls");
});

test("producer boot id change ends active entries as unknown", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  tracker.ingest(users(source("ok", 100_000, "boot-a"), [request("raw-boot", { startedAt: 95 })]));
  tracker.ingest(users(source("ok", 101_000, "boot-b"), []));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.outcome, "unknown");
  assert.equal(events[0].data.endReason, "producer-restart");
});

test("restart persistence restores stale rows and ended ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-life-"));
  const file = path.join(dir, "lifecycle.json");
  const events = [];
  try {
    const a = makeTracker({ file, record: (event) => (events.push(event), { id: events.length }) });
    a.ingest(users(source("ok", 100_000), [
      request("raw-persist", { startedAt: 95 }),
      request("raw-ended", { startedAt: 96 }),
    ]));
    a.ingest(users(source("ok", 102_000), [request("raw-persist", { startedAt: 95 })], [
      { id: "raw-ended", outcome: "completed", finishedAt: 101.5 },
    ]));
    a.flush();

    const b = makeTracker({ file, record: (event) => (events.push(event), { id: events.length }) });
    assert.equal(b.snapshot().status, "stale");
    assert.equal(b.snapshot().requests.length, 1);
    b.ingest(users(source("ok", 103_000), [request("raw-persist", { startedAt: 95 })]));
    assert.equal(events.length, 1);
    b.ingest(users(source("ok", 104_000), [], [{ id: "raw-persist", outcome: "completed", finishedAt: 103.5 }]));
    b.ingest(users(source("ok", 105_000), [], [{ id: "raw-ended", outcome: "completed", finishedAt: 101.5 }]));
    assert.equal(events.length, 2);
    assert.equal(events[1].data.endReason, "vanished");
    b.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshots and events do not expose raw ids or proxy details", () => {
  const events = [];
  const tracker = makeTracker({ record: (event) => (events.push(event), { id: events.length }) });
  const rawId = "raw-private-identifier";
  tracker.ingest(users(source("ok", 100_000), [request(rawId, {
    startedAt: 95,
    path: "/private/v1/route",
    backend: "backend-private-value",
    headers: { Authorization: "secret-token" },
  })]));
  tracker.ingest(users(source("ok", 101_000), [], [{
    id: rawId,
    outcome: "upstream_error",
    finishedAt: 100.5,
    path: "/private/v1/route",
    backend: "backend-private-value",
    headers: { Authorization: "secret-token" },
  }]));
  const output = JSON.stringify({ snapshot: tracker.snapshot(), events });
  for (const secret of [rawId, "/private/v1/route", "backend-private-value", "secret-token", "Authorization"]) {
    assert.equal(output.includes(secret), false, `unexpected disclosure: ${secret}`);
  }
});

test("clearing EventLog does not clear active lifecycle entries", () => {
  const eventLog = new EventLog({ file: null });
  const tracker = makeTracker({ record: (event, opts) => eventLog.record(event, opts) });
  tracker.ingest(users(source("ok", 100_000), [request("raw-clear", { startedAt: 95 })]));
  eventLog.record({ type: "system.test", message: "test" });
  eventLog.clear();
  assert.equal(eventLog.list().length, 0);
  assert.equal(tracker.snapshot().requests.length, 1);
});

test("maxActive is bounded and reports open-request overflow", () => {
  const tracker = makeTracker({ maxActive: 1 });
  tracker.ingest(users(source("ok", 100_000), [
    request("raw-one", { startedAt: 95 }),
    request("raw-two", { startedAt: 96 }),
  ]));
  assert.equal(tracker.snapshot().requests.length, 1);
  assert.equal(tracker.snapshot().overflowCount, 1);
});
