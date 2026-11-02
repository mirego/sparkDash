import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPimonoConfig,
  PROVIDER_KEY,
  PI_API,
  CURRENT_MODEL_ALIAS,
  SENTINEL_BASE_URL,
} from "../PimonoConfigExport.js";

/* ---------------------------------------------------------------- fixtures */

// Shape-mirror of the live config/model-registry.json (fleet-sync output).
const REGISTRY = {
  version: 1,
  models: [
    {
      id: "glm-5.3-exl3",
      aliases: ["GLM-5.3-Flash-EXL3", "glm53-exl3", "claude-glm-5.3-exl3"],
      engine: "vllm",
      recipe: "GLM-5.3-Flash-EXL3-2x-DGX-Sparks",
      quantization: "exl3",
    },
    {
      id: "qwen3.8-27b",
      aliases: ["Qwen3.8-27B-NVFP4", "claude-qwen3.8-27b-sglang"],
      engine: "sglang",
      recipe: "Qwen3.8-27B-SGLang-DGX-Spark",
      quantization: "nvfp4",
    },
  ],
  alias_to_id: {},
};

/* ------------------------------------------------- AC: generated cfg shape */

test("emits top-level object with EXACTLY { providers } — no extra keys", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" });
  assert.deepEqual(Object.keys(config), ["providers"]);
  assert.deepEqual(Object.keys(config.providers), [PROVIDER_KEY]);
});

test("provider block: sentinel baseUrl, openai-completions api, compat flags, NO apiKey", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" });
  const prov = config.providers[PROVIDER_KEY];
  assert.equal(prov.baseUrl, "Replaced by extensions/providers.ts");
  assert.equal(prov.api, "openai-completions");
  assert.deepEqual(prov.compat, {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  });
  // NO apiKey anywhere — pi resolves auth via env variables (AC #2).
  assert.equal(prov.apiKey, undefined);
  assert.equal(prov.authHeader, undefined);
  assert.equal(JSON.stringify(config).includes("apiKey"), false);
});

test("models array contains EXACTLY gilfoyle-current-model + the loaded model", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.equal(defs.length, 2);
  assert.equal(defs[0].id, CURRENT_MODEL_ALIAS);
  assert.equal(defs[1].id, "qwen3.8-27b");
  assert.ok(!defs.some((d) => d.id.startsWith("claude-")));
});

test("no loaded model detected ⇒ only gilfoyle-current-model", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: null });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.equal(defs.length, 1);
  assert.equal(defs[0].id, CURRENT_MODEL_ALIAS);
});

test("baseline entry carries the canonical sample values", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: null });
  const def = config.providers[PROVIDER_KEY].models[0];
  assert.equal(def.name, "Current model loaded on Gilfoyle");
  assert.equal(def.reasoning, true);
  assert.deepEqual(def.input, ["text", "image"]);
  assert.equal(def.contextWindow, 1000000);
  assert.equal(def.maxTokens, 128000);
  assert.deepEqual(def.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Object.values(def.thinkingLevelMap).length >= 7);
});

/* ------------------------------- AC: per-model thinking differentiation */

test("effort-capable model gets the effort thinkingLevelMap, no chat-template compat", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" });
  const def = config.providers[PROVIDER_KEY].models[1];
  assert.deepEqual(def.thinkingLevelMap, {
    off: null, minimal: null, low: "low", medium: "medium",
    high: "high", xhigh: "xhigh", max: "max",
  });
  assert.equal(def.compat, undefined);
});

test("chat-template-gated model (exl3) gets the pi-native qwen-chat-template mechanics", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "glm-5.3-exl3" });
  const def = config.providers[PROVIDER_KEY].models[1];
  assert.equal(def.compat.thinkingFormat, "qwen-chat-template");
  assert.deepEqual(def.compat.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
  assert.deepEqual(def.compat.chatTemplateKwargs.reasoning_effort, { $var: "thinking.effort", omitWhenOff: true });
  // high → xhigh (template validates xhigh|medium|low); unsupported hidden.
  assert.equal(def.thinkingLevelMap.high, "xhigh");
  assert.equal(def.thinkingLevelMap.max, null);
  assert.equal(def.thinkingLevelMap.off, "off");
  // The two model types genuinely differ (AC #4).
  const qwen = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" }).config.providers[PROVIDER_KEY].models[1];
  assert.notDeepEqual(qwen.thinkingLevelMap, def.thinkingLevelMap);
  assert.equal(qwen.compat, undefined);
});

test("loaded id resolves through registry aliases (HF weights name from /v1/models)", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "GLM-5.3-Flash-EXL3" });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.equal(defs.length, 2);
  assert.equal(defs[1].id, "glm-5.3-exl3");
  assert.equal(defs[1].compat.thinkingFormat, "qwen-chat-template");
});

test("loaded id unknown to registry ⇒ emitted with baseline shape + warning", () => {
  const { config, warnings } = buildPimonoConfig({ registry: REGISTRY, servedId: "mystery-model" });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.equal(defs.length, 2);
  assert.equal(defs[1].id, "mystery-model");
  assert.ok(warnings.some((w) => w.includes("mystery-model")));
});

test("defaultModel is the gilfoyle-current-model suggestion (settings.json, not models.json)", () => {
  const { defaultModel, config } = buildPimonoConfig({ registry: REGISTRY, servedId: "qwen3.8-27b" });
  assert.equal(defaultModel, `${PROVIDER_KEY}/${CURRENT_MODEL_ALIAS}`);
  assert.equal(JSON.stringify(config).includes("defaultModel"), false);
});

test("schema whitelist: every emitted key is a pi ModelDefinition/ProviderConfig key", () => {
  const { config } = buildPimonoConfig({ registry: REGISTRY, servedId: "glm-5.3-exl3" });
  const PROVIDER_KEYS = new Set(["name", "baseUrl", "api", "apiKey", "headers", "authHeader", "oauth", "compat", "models", "modelOverrides"]);
  const MODEL_KEYS = new Set(["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "contextWindow", "maxTokens", "cost", "samplingParams", "headers", "compat", "inputLimits", "promptCache"]);
  const prov = config.providers[PROVIDER_KEY];
  for (const k of Object.keys(prov)) assert.ok(PROVIDER_KEYS.has(k), `provider key ${k}`);
  for (const def of prov.models) {
    for (const k of Object.keys(def)) assert.ok(MODEL_KEYS.has(k), `model key ${k}`);
    for (const k of Object.keys(def.compat || {})) {
      assert.ok(["supportsDeveloperRole", "supportsReasoningEffort", "thinkingFormat", "chatTemplateKwargs"].includes(k), `compat key ${k}`);
    }
  }
});
