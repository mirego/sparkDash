import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalModel,
  aggregateByCanonicalModel,
  perModelUsageObject,
} from "../PerUserModelUsageTracker.js";

const REG = {
  alias_to_id: {
    "deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "claude-deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "poolside/Laguna-S-2.1-NVFP4": "laguna-s-2.1",
    "laguna-s-2.1": "laguna-s-2.1",
  },
};

test("canonicalModel maps alias to canonical", () => {
  assert.equal(canonicalModel("claude-deepseek-v4-flash-0731", REG), "deepseek-v4-flash-0731");
  assert.equal(canonicalModel("poolside/Laguna-S-2.1-NVFP4", REG), "laguna-s-2.1");
  assert.equal(canonicalModel("deepseek-v4-flash-0731", REG), "deepseek-v4-flash-0731");
});

test("canonicalModel falls back to input on unknown / no registry", () => {
  assert.equal(canonicalModel("mystery-model", REG), "mystery-model");
  assert.equal(canonicalModel("deepseek-v4-flash-0731", null), "deepseek-v4-flash-0731");
});

test("aggregateByCanonicalModel coalesces aliases into one model row", () => {
  const allModelUsers = {
    // physical alias + claude alias should roll up under canonical deepseek
    "deepseek-v4-flash-0731": {
      totalRequests: 10,
      totalTokens: 1000,
      users: [
        { clientIp: "1.1.1.1", label: "jaub", requests: 10, promptTokens: 600, completionTokens: 400, totalTokens: 1000, lastSeen: 200 },
      ],
    },
    "claude-deepseek-v4-flash-0731": {
      totalRequests: 5,
      totalTokens: 500,
      users: [
        { clientIp: "1.1.1.1", label: "jaub", requests: 5, promptTokens: 300, completionTokens: 200, totalTokens: 500, lastSeen: 300 },
        { clientIp: "2.2.2.2", label: "mmez", requests: 0, promptTokens: 200, completionTokens: 0, totalTokens: 0, lastSeen: 100 },
      ],
    },
    "poolside/Laguna-S-2.1-NVFP4": {
      totalRequests: 2,
      totalTokens: 80,
      users: [{ clientIp: "3.3.3.3", label: "opin", requests: 2, promptTokens: 50, completionTokens: 30, totalTokens: 80, lastSeen: 50 }],
    },
  };

  const agg = aggregateByCanonicalModel(allModelUsers, REG);
  assert.equal(agg.size, 2); // deepseek + laguna (both aliases coalesced)

  const ds = agg.get("deepseek-v4-flash-0731");
  // 15 total requests across both aliases
  assert.equal(ds.requests, 15);
  // jaub appears once across aliases, tokens summed
  const jaub = ds.users.find((u) => u.label === "jaub");
  assert.equal(jaub.requests, 15);
  assert.equal(jaub.promptTokens, 900);
  assert.equal(jaub.completionTokens, 600);
  assert.equal(jaub.lastSeen, 300); // max
  assert.equal(ds.lastSeen, 300);

  const lag = agg.get("laguna-s-2.1");
  assert.equal(lag.requests, 2);
});

test("perModelUsageObject returns plain object keyed by model", () => {
  const obj = perModelUsageObject(
    { "deepseek-v4-flash-0731": { totalRequests: 1, totalTokens: 50, users: [] } },
    REG
  );
  assert.equal(typeof obj, "object");
  assert.equal(obj["deepseek-v4-flash-0731"].requests, 1);
});

test("aggregateByCanonicalModel handles empty input", () => {
  const agg = aggregateByCanonicalModel({}, REG);
  assert.equal(agg.size, 0);
  assert.equal(aggregateByCanonicalModel(null, REG).size, 0);
});
