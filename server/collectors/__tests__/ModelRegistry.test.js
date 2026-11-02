import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coalesce,
  evaluateModelHealth,
  buildModelFleet,
  probeRegistry,
  mergeState,
  HEALTH,
} from "../ModelRegistry.js";

const REG = {
  version: 1,
  alias_to_id: {
    "deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "claude-deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "deepseek-ai/DeepSeek-V4-Flash-0731": "deepseek-v4-flash-0731",
    "poolside/Laguna-S-2.1-NVFP4": "laguna-s-2.1",
  },
  models: [
    {
      id: "deepseek-v4-flash-0731",
      engine: "vllm",
      min_healthy: 1,
      node_ports: [
        { node: "A", host: "127.0.0.1", port: 8888, host_port: "127.0.0.1:8888" },
        { node: "B", host: "192.168.100.11", port: 8888, host_port: "192.168.100.11:8888" },
      ],
    },
    {
      id: "laguna-s-2.1",
      engine: "vllm",
      min_healthy: 1,
      node_ports: [{ node: "A", host: "127.0.0.1", port: 8891, host_port: "127.0.0.1:8891" }],
    },
  ],
};

test("coalesce maps aliases to canonical id", () => {
  assert.equal(coalesce("claude-deepseek-v4-flash-0731", REG), "deepseek-v4-flash-0731");
  assert.equal(coalesce("deepseek-v4-flash-0731", REG), "deepseek-v4-flash-0731");
  assert.equal(coalesce("poolside/Laguna-S-2.1-NVFP4", REG), "laguna-s-2.1");
});

test("coalesce falls back to input on unknown id / absent registry", () => {
  assert.equal(coalesce("some-live-model", REG), "some-live-model");
  assert.equal(coalesce("deepseek-v4-flash-0731", null), "deepseek-v4-flash-0731");
});

test("evaluateModelHealth green when all replicas healthy", () => {
  const model = REG.models[0]; // min_healthy 1, 2 replicas
  const h = evaluateModelHealth(model, [
    { healthy: true }, { healthy: true },
  ]);
  assert.equal(h.level, HEALTH.GREEN);
  assert.equal(h.healthy, 2);
  assert.equal(h.required, 1);
});

test("evaluateModelHealth yellow when one of several down but min_healthy met", () => {
  const model = { ...REG.models[0], min_healthy: 1 }; // 2 replicas, min 1
  const h = evaluateModelHealth(model, [
    { healthy: true }, { healthy: false },
  ]);
  assert.equal(h.level, HEALTH.YELLOW);
  assert.equal(h.healthy, 1);
});

test("evaluateModelHealth red when fewer than min_healthy", () => {
  const model = { ...REG.models[0], min_healthy: 2 }; // needs both
  const h = evaluateModelHealth(model, [
    { healthy: true }, { healthy: false },
  ]);
  assert.equal(h.level, HEALTH.RED);
});

test("buildModelFleet joins registry + probes per model", () => {
  const fleet = buildModelFleet(REG, [
    { model_id: "deepseek-v4-flash-0731", node: "A", port: 8888, healthy: true },
    { model_id: "deepseek-v4-flash-0731", node: "B", port: 8888, healthy: false },
    { model_id: "laguna-s-2.1", node: "A", port: 8891, healthy: true },
  ]);
  assert.equal(fleet.length, 2);
  const ds = fleet.find((m) => m.id === "deepseek-v4-flash-0731");
  assert.equal(ds.health.level, HEALTH.YELLOW);
  assert.equal(ds.health.healthy, 1);
  // replica-level healthy flags merged
  const repA = ds.replicas.find((r) => r.node === "A");
  const repB = ds.replicas.find((r) => r.node === "B");
  assert.equal(repA.healthy, true);
  assert.equal(repB.healthy, false);
  const lag = fleet.find((m) => m.id === "laguna-s-2.1");
  assert.equal(lag.health.level, HEALTH.GREEN);
});

test("probeRegistry calls healthFetch per node:port", async () => {
  const urls = [];
  const healthFetch = async (url) => {
    urls.push(url);
    return url.includes("127.0.0.1:8888") ? true : url.includes("192.168.100.11:8888") ? false : true;
  };
  const rows = await probeRegistry(REG, healthFetch);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    urls,
    ["http://127.0.0.1:8888/health", "http://192.168.100.11:8888/health", "http://127.0.0.1:8891/health"]
  );
  const dsB = rows.find((r) => r.host_port === "192.168.100.11:8888");
  assert.equal(dsB.healthy, false);
});

test("probeRegistry returns [] on absent registry", async () => {
  assert.deepEqual(await probeRegistry(null), []);
});

test("mergeState deep-merges last probe row per model", () => {
  let s = null;
  s = mergeState(s, { model_id: "deepseek-v4-flash-0731", healthy: true });
  s = mergeState(s, { model_id: "deepseek-v4-flash-0731", healthy: false });
  assert.equal(s.probes["deepseek-v4-flash-0731"].healthy, false);
});
