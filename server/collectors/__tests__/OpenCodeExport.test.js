import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpencodeConfig,
  validateOpencodeConfig,
  looksLikeSecret,
  PROVIDER_ID,
  PROVIDER_NAME,
  CURRENT_MODEL_ALIAS,
} from "../OpenCodeExport.js";
import { MODEL_TYPES, FLEET_BASE_URL, FLEET_API_KEY_PLACEHOLDER } from "../ExportModelSpec.js";

/* ---------------------------------------------------------------- fixtures */

// Shape-mirror of the live config/model-registry.json (fleet-sync output).
const REGISTRY = {
  version: 1,
  nodes: {
    A: { host: "127.0.0.1", name: "anton", pin: "" },
    B: { host: "192.168.100.11", name: "son-of-anton", pin: "" },
  },
  models: [
    {
      id: "deepseek-v4-flash-0731",
      aliases: ["deepseek-v4-flash-dspark", "claude-deepseek-v4-flash-0731"],
      engine: "vllm",
      recipe: "DeepSeek-v4-Flash-DSpark-2x-DGX-Spark",
      quantization: "",
    },
    {
      id: "glm-5.3",
      aliases: ["glm-5.3-flash", "claude-glm-5.3"],
      engine: "vllm",
      recipe: "GLM-5.3-Flash-NVFP4-Dual-DGX-Spark",
      quantization: "nvfp4",
    },
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

/* --------------------------------------------------- AC: reworked shape */

test("provider block: gilfoyle / Local DGX Sparks / fleet baseURL / literal placeholder key", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: "glm-5.3-exl3" });
  const prov = config.provider[PROVIDER_ID];
  assert.equal(prov.name, PROVIDER_NAME);
  assert.equal(prov.npm, "@ai-sdk/openai-compatible");
  assert.equal(prov.options.baseURL, FLEET_BASE_URL);
  assert.equal(prov.options.baseURL, "http://10.4.0.15:8317/v1");
  assert.equal(prov.options.apiKey, FLEET_API_KEY_PLACEHOLDER);
  assert.equal(prov.options.apiKey, "YOUR_API_KEY");
  assert.equal(config.model, `${PROVIDER_ID}/${CURRENT_MODEL_ALIAS}`);
});

test("models map contains EXACTLY gilfoyle-current-model + the loaded model", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: "qwen3.8-27b" });
  const keys = Object.keys(config.provider[PROVIDER_ID].models);
  assert.equal(keys.length, 2);
  assert.ok(keys.includes(CURRENT_MODEL_ALIAS));
  assert.ok(keys.includes("qwen3.8-27b"));
  // No alias expansion — the rework drops the claude-* entries.
  assert.ok(!keys.some((k) => k.startsWith("claude-")));
});

test("no loaded model detected ⇒ only gilfoyle-current-model", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: null });
  const keys = Object.keys(config.provider[PROVIDER_ID].models);
  assert.deepEqual(keys, [CURRENT_MODEL_ALIAS]);
});

test("gilfoyle-current-model is the minimal always-valid baseline", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: null });
  const entry = config.provider[PROVIDER_ID].models[CURRENT_MODEL_ALIAS];
  assert.equal(entry.name, "Current model loaded on Gilfoyle");
  assert.equal(entry.tool_call, true);
  assert.equal(entry.temperature, true);
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.limit, { context: 1000000, output: 128000 });
  assert.deepEqual(entry.modalities, { input: ["text", "image", "video"], output: ["text"] });
  assert.deepEqual(entry.cost, { input: 0, output: 0 });
  assert.ok(Object.keys(entry.variants).every((k) => entry.variants[k].reasoningEffort));
});

/* ------------------------------- AC: per-model variant differentiation */

test("effort-capable model gets reasoningEffort variants (not the exl3 template)", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: "qwen3.8-27b" });
  const entry = config.provider[PROVIDER_ID].models["qwen3.8-27b"];
  assert.equal(entry.name, "Qwen3.8-27B-SGLang-DGX-Spark");
  const levels = Object.keys(entry.variants).sort();
  assert.deepEqual(levels, ["high", "low", "max", "medium"]);
  for (const v of Object.values(entry.variants)) {
    assert.equal(typeof v.reasoningEffort, "string");
    assert.equal(v.chat_template_kwargs, undefined);
  }
});

test("chat-template-gated model (exl3) gets chat_template_kwargs variants — never the qwen clone", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: "glm-5.3-exl3" });
  const entry = config.provider[PROVIDER_ID].models["glm-5.3-exl3"];
  const levels = Object.keys(entry.variants).sort();
  assert.deepEqual(levels, ["high", "low", "max", "none"]);
  assert.deepEqual(entry.variants.none, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(entry.variants.max, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" } });
  assert.ok(Object.values(entry.variants).every((v) => v.reasoningEffort === undefined));
  // The two model types genuinely differ (AC #4).
  const qwen = buildOpencodeConfig(REGISTRY, { servedId: "qwen3.8-27b" }).config.provider[PROVIDER_ID].models["qwen3.8-27b"];
  assert.notDeepEqual(qwen.variants, entry.variants);
});

test("loaded id resolves through registry aliases", () => {
  // /v1/models reports the HF weights name; the registry maps it back.
  const { config } = buildOpencodeConfig(REGISTRY, { servedId: "GLM-5.3-Flash-EXL3" });
  const keys = Object.keys(config.provider[PROVIDER_ID].models);
  assert.ok(keys.includes("glm-5.3-exl3"));
  assert.equal(keys.length, 2);
  // EXL3 ⇒ chat-template mechanics applied via alias resolution.
  assert.ok(config.provider[PROVIDER_ID].models["glm-5.3-exl3"].variants.none.chat_template_kwargs);
});

test("loaded id unknown to registry ⇒ emitted with baseline shape + warning", () => {
  const { config, warnings } = buildOpencodeConfig(REGISTRY, { servedId: "totally-new-model" });
  const keys = Object.keys(config.provider[PROVIDER_ID].models);
  assert.equal(keys.length, 2);
  assert.ok(keys.includes("totally-new-model"));
  assert.ok(warnings.some((w) => w.includes("totally-new-model")));
});

test("generated config passes validateOpencodeConfig for every fleet model type", () => {
  for (const servedId of [null, "qwen3.8-27b", "glm-5.3-exl3", "GLM-5.3-Flash-EXL3"]) {
    const { config } = buildOpencodeConfig(REGISTRY, { servedId });
    const check = validateOpencodeConfig(config);
    assert.deepEqual(check.errors, []);
  }
});

/* ------------------------------------------------------------- validator */

test("validator: rejects unknown keys, >2 models, mixed variant mechanics", () => {
  const base = buildOpencodeConfig(REGISTRY, { servedId: null }).config;
  const bad = structuredClone(base);
  bad.bogus = 1;
  const prov = bad.provider[PROVIDER_ID];
  prov.bogusKey = 1;
  prov.models.extra = { name: "x" };
  const mixed = structuredClone(base);
  mixed.provider[PROVIDER_ID].models[CURRENT_MODEL_ALIAS].variants.none = { chat_template_kwargs: { enable_thinking: false } };

  for (const doc of [bad, mixed]) {
    const res = validateOpencodeConfig(doc);
    assert.equal(res.valid, false);
  }
  const res1 = validateOpencodeConfig(bad);
  assert.ok(res1.errors.some((e) => e.includes("bogus")));
  const res2 = validateOpencodeConfig(mixed);
  assert.ok(res2.errors.some((e) => e.includes("mix reasoningEffort and chat_template_kwargs")));
});

test("validator: accepts the literal YOUR_API_KEY placeholder, rejects plaintext secrets", () => {
  const base = buildOpencodeConfig(REGISTRY, { servedId: null }).config;
  assert.equal(validateOpencodeConfig(base).valid, true);

  const leaked = structuredClone(base);
  leaked.provider[PROVIDER_ID].options.apiKey = "sk-really-a-secret-key-1234567890";
  const res = validateOpencodeConfig(leaked);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("plaintext secret") || e.includes("placeholder")));
});

test("looksLikeSecret still detects sk- tokens", () => {
  assert.equal(looksLikeSecret("sk-abcdef1234567890"), true);
  assert.equal(looksLikeSecret("YOUR_API_KEY"), false);
});
