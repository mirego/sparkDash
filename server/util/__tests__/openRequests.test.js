import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenRequestsForSpark } from "../openRequests.js";

const source = {
  status: "ok",
  fetchedAt: 123,
  generatedAt: 122,
  schemaVersion: 2,
};

 test("filters by Spark, deduplicates ids, and sorts oldest first", () => {
  const result = buildOpenRequestsForSpark([
    { id: "a", user: "alice", model: "deepseek", sparkId: "anton", ageSec: 4 },
    { id: "a", user: "alice-duplicate", model: "other", sparkId: "anton", ageSec: 99 },
    { id: "b", user: "bob", model: "other", sparkId: "son-of-anton", ageSec: 20 },
    { id: "c", user: "carol", model: "unknown-model", ageSec: 3 },
  ], source, "anton");

  assert.deepEqual(result.requests.map((request) => request.id), ["a"]);
  assert.equal(result.requests[0].label, "alice");
  assert.equal(result.unattributedCount, 1);
});

test("whitelists row fields and never exposes proxy-only metadata", () => {
  const result = buildOpenRequestsForSpark([{
    id: "safe-id",
    user: "prefix",
    model: "model",
    state: "queued",
    promptEstTokens: 10,
    promptSource: "estimate",
    maxTokens: 20,
    completionEstTokens: 2,
    completionSource: "estimate",
    ageSec: 3,
    idleSec: 1,
    ttftSec: null,
    path: "/private/path",
    backend: "private-backend",
    headers: { "user-agent": "secret" },
    key: "secret-key",
    clientGone: true,
    sparkId: "anton",
  }], source, "anton");

  assert.deepEqual(Object.keys(result.requests[0]).sort(), [
    "ageSec", "completionEstTokens", "completionSource", "id", "idleSec",
    "label", "maxTokens", "model", "promptEstTokens", "promptSource", "state", "ttftSec",
  ]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("unavailable source passes through with unknown request count and no rows", () => {
  const result = buildOpenRequestsForSpark([
    { id: "a", user: "alice", sparkId: "anton" },
  ], { ...source, status: "unavailable" }, "anton");

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.requests, []);
  assert.equal(result.unattributedCount, 0);
});
