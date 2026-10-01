import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPimonoConfig,
  buildModelDefs,
  cpaBaseUrl,
  liveCpaAliases,
  piEnvPlaceholder,
  resolveCpaHost,
  resolveServedFromCpa,
  PROVIDER_KEY,
  CPA_PORT,
  DEFAULT_CPA_HOST,
  CURRENT_MODEL_ALIAS,
} from "../PimonoConfigExport.js";

/* ---------------------------------------------------------------- fixtures */

// Shape-mirror of the live config/model-registry.json (fleet-sync output).
const REG = {
  version: 1,
  nodes: {
    A: { host: "127.0.0.1", name: "anton", pin: "" },
    B: { host: "192.168.100.11", name: "son-of-anton", pin: "" },
  },
  models: [
    {
      id: "deepseek-v4-flash-0731",
      aliases: [
        "deepseek-v4-flash-dspark",
        "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
        "claude-deepseek-v4-flash-0731",
      ],
      engine: "vllm",
      weights: "hf://deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
      quantization: "",
      hbm_gb: 90.0,
      tensor_parallel: 2,
      min_healthy: 1,
      node_ports: [
        { node: "A", host: "127.0.0.1", port: 8888, pin: "anton", host_port: "127.0.0.1:8888" },
      ],
    },
    {
      id: "qwen3.8-flash-next",
      aliases: ["RadixArk/Qwen3.8-Flash-Next-NVFP4", "qwen38-fn", "claude-qwen3.8-flash-next"],
      engine: "vllm",
      weights: "hf://RadixArk/Qwen3.8-Flash-Next-NVFP4",
      quantization: "nvfp4",
      hbm_gb: 110.0,
      tensor_parallel: 2,
      min_healthy: 1,
      node_ports: [
        { node: "B", host: "192.168.100.11", port: 8888, pin: "son-of-anton", host_port: "192.168.100.11:8888" },
      ],
    },
  ],
  alias_to_id: {
    "deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "claude-deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
    "qwen3.8-flash-next": "qwen3.8-flash-next",
    "claude-qwen3.8-flash-next": "qwen3.8-flash-next",
  },
};

// live-models-status.json shape (alias truth per d-002).
const CPA = {
  working_set: ["deepseek-v4-flash-0731"],
  providers: [
    {
      name: "vllm",
      aliases: [
        "claude-deepseek-v4-flash-0731",
        "claude-qwen3.8-flash-next",
        CURRENT_MODEL_ALIAS,
      ],
    },
  ],
};

const PROVIDER_KEYS = new Set([
  "name", "baseUrl", "api", "apiKey", "headers", "authHeader", "oauth",
  "compat", "models", "modelOverrides",
]);
const MODEL_KEYS = new Set([
  "id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input",
  "contextWindow", "maxTokens", "cost", "samplingParams", "headers", "compat",
  "inputLimits", "promptCache",
]);

/* ------------------------------------------------- AC: generated cfg shape */

test("emits top-level object with EXACTLY { providers } — no extra keys", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  assert.deepEqual(Object.keys(config), ["providers"]);
  assert.equal(typeof config.providers, "object");
  assert.deepEqual(Object.keys(config.providers), [PROVIDER_KEY]);
});

test("provider block carries only schema-whitelisted pi ProviderConfig keys", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  const prov = config.providers[PROVIDER_KEY];
  for (const k of Object.keys(prov)) assert.ok(PROVIDER_KEYS.has(k), `unknown provider key: ${k}`);
  assert.equal(prov.baseUrl, `http://${DEFAULT_CPA_HOST}:${CPA_PORT}/v1`);
  assert.equal(prov.api, "openai-completions");
  assert.equal(prov.authHeader, true);
  assert.equal(prov.name, "Spark Fleet");
  assert.ok(Array.isArray(prov.models));
});

test("every model def carries only schema-whitelisted ModelDefinition keys", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  for (const def of config.providers[PROVIDER_KEY].models) {
    for (const k of Object.keys(def)) assert.ok(MODEL_KEYS.has(k), `unknown model key: ${k}`);
    assert.equal(typeof def.id, "string");
    assert.ok(def.id.length > 0);
    if (def.name !== undefined) assert.equal(typeof def.name, "string");
    // contextWindow/maxTokens only when registry actually carries them
    if (def.contextWindow !== undefined) assert.ok(Number.isInteger(def.contextWindow) && def.contextWindow > 0);
    if (def.maxTokens !== undefined) assert.ok(Number.isInteger(def.maxTokens) && def.maxTokens > 0);
    if (def.reasoning !== undefined) assert.equal(typeof def.reasoning, "boolean");
    if (def.input !== undefined) assert.deepEqual([...def.input].sort(), ["image", "text"].slice(2 - def.input.length));
  }
});

test("models is an ARRAY of defs (pi format) — not the opencode id-map", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  assert.ok(Array.isArray(config.providers[PROVIDER_KEY].models));
  assert.ok(!("npm" in config.providers[PROVIDER_KEY]), "no opencode npm field");
  assert.ok(!("$schema" in config), "pi rejects unknown top-level keys — no $schema");
});

test("baseUrl ends at /v1 — never /chat/completions, never a direct node port", () => {
  const { config } = buildPimonoConfig({
    registry: REG, cpaStatus: CPA, host: "192.168.100.55",
  });
  const u = config.providers[PROVIDER_KEY].baseUrl;
  assert.equal(u, "http://192.168.100.55:8317/v1");
  assert.ok(!u.includes("chat/completions"));
  assert.ok(!u.includes(":8888"), "direct vLLM node port rejected (d-002)");
});

test("output serializes as valid strict JSON (no JSON5/undefined leakage)", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  const round = JSON.parse(JSON.stringify(config));
  assert.deepEqual(round, config);
});

/* ----------------------------------------------------- AC: secret redaction */

test("apiKey is the $-prefixed env placeholder, never a literal name", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  const key = config.providers[PROVIDER_KEY].apiKey;
  assert.equal(key, "$CPA_API_KEY");
  // pi gotcha: "CPA_API_KEY" without $ is treated as a LITERAL key.
  assert.notEqual(key, "CPA_API_KEY");
  // and it is NOT opencode's {env:VAR} syntax (pi would take it literally).
  assert.ok(!key.startsWith("{env:"));
});

test("config JSON string contains no key-looking values and no registry pins", () => {
  const dirty = JSON.parse(JSON.stringify(REG));
  dirty.models[0].api_key = "sk-supersecretplaintext123";
  dirty.models[0].token = "tok_live_abc";
  const { config } = buildPimonoConfig({ registry: dirty, cpaStatus: CPA });
  const s = JSON.stringify(config);
  assert.ok(!s.includes("sk-supersecretplaintext123"), "registry secrets must never be projected");
  assert.ok(!s.includes("tok_live_abc"));
  assert.ok(!s.includes("sk-"), "no provider-style key literals anywhere in output");
});

test("node registry pin fields are not emitted", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  const s = JSON.stringify(config);
  assert.ok(!s.includes("anton"), "node names/pins from registry must not leak");
  assert.ok(!s.includes("192.168.100.11"), "direct node hosts must not leak");
});

test("resolveCpaHost sanitizes injection attempts back to loopback default", () => {
  assert.equal(resolveCpaHost("http://evil.example/x"), DEFAULT_CPA_HOST);
  assert.equal(resolveCpaHost("1.2.3.4:8888/../"), DEFAULT_CPA_HOST);
  assert.equal(resolveCpaHost("evil.com /v1"), DEFAULT_CPA_HOST);
  assert.equal(resolveCpaHost(""), DEFAULT_CPA_HOST);
  assert.equal(resolveCpaHost(null), DEFAULT_CPA_HOST);
  assert.equal(resolveCpaHost(" 192.168.100.55 "), "192.168.100.55");
  assert.equal(cpaBaseUrl("evil#host"), `http://${DEFAULT_CPA_HOST}:8317/v1`);
});

test("piEnvPlaceholder always carries the leading $", () => {
  assert.equal(piEnvPlaceholder(), "$CPA_API_KEY");
  assert.equal(piEnvPlaceholder("MY_KEY"), "$MY_KEY");
});

/* --------------------------------------------------- AC: registry population */

test("one def per registry model, keyed by CPA-accepted claude-* alias", () => {
  const { config } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.equal(defs.length, 3); // 2 models + current-model alias entry
  const ids = defs.map((d) => d.id);
  // current-model entry rides directly after the served model it aliases
  assert.deepEqual(ids, ["claude-deepseek-v4-flash-0731", CURRENT_MODEL_ALIAS, "claude-qwen3.8-flash-next"]);
  // canonical id is display name, not a duplicate entry (d-002)
  assert.equal(defs[0].name, "deepseek-v4-flash-0731");
  assert.ok(!ids.includes("deepseek-v4-flash-0731"), "canonical id must not duplicate the alias entry");
});

test("registry models without claude alias fall back to canonical id", () => {
  const reg = { models: [{ id: "bare-model", aliases: ["some-nick"] }] };
  const { config } = buildPimonoConfig({ registry: reg, cpaStatus: null });
  const defs = config.providers[PROVIDER_KEY].models;
  assert.deepEqual(defs.map((d) => d.id), ["bare-model"]);
  assert.equal(defs[0].name, "bare-model");
});

test("live CPA aliases win over registry claude-* aliases", () => {
  const reg = {
    models: [{ id: "m1", aliases: ["claude-m1-old", "claude-m1"] }],
  };
  const cpa = { providers: [{ aliases: ["claude-m1"] }] };
  const { config } = buildPimonoConfig({ registry: reg, cpaStatus: cpa });
  assert.equal(config.providers[PROVIDER_KEY].models[0].id, "claude-m1");
});

test("reflects a registry change without restart (pure live-input projection)", () => {
  const a = buildPimonoConfig({ registry: REG, cpaStatus: CPA }).config;
  const grown = JSON.parse(JSON.stringify(REG));
  grown.models.push({ id: "new-model", aliases: ["claude-new-model"] });
  const b = buildPimonoConfig({ registry: grown, cpaStatus: CPA }).config;
  assert.ok(!JSON.stringify(a).includes("claude-new-model"));
  assert.ok(b.providers[PROVIDER_KEY].models.some((d) => d.id === "claude-new-model"));
});

test("optional registry enrichment (contextWindow/reasoning/input) passes through", () => {
  const reg = {
    models: [{
      id: "rich", aliases: ["claude-rich"],
      contextWindow: 262144, maxTokens: 32768, reasoning: true, input: ["text", "image"],
    }],
  };
  const { config } = buildPimonoConfig({ registry: reg, cpaStatus: null });
  assert.deepEqual(config.providers[PROVIDER_KEY].models[0], {
    id: "claude-rich", name: "rich",
    contextWindow: 262144, maxTokens: 32768, reasoning: true, input: ["text", "image"],
  });
});

test("garbage enrichment values are dropped, not emitted (schema validity)", () => {
  const reg = {
    models: [{
      id: "junk", aliases: ["claude-junk"],
      contextWindow: -5, maxTokens: "lots", reasoning: "yes", input: ["text", "audio"],
    }],
  };
  const { config } = buildPimonoConfig({ registry: reg, cpaStatus: null });
  const def = config.providers[PROVIDER_KEY].models[0];
  assert.deepEqual(def, { id: "claude-junk", name: "junk" });
});

test("empty/missing registry degrades to valid skeleton + warning", () => {
  for (const reg of [null, {}, { models: [] }]) {
    const { config, warnings } = buildPimonoConfig({ registry: reg, cpaStatus: CPA });
    assert.ok(warnings.includes("registry_unavailable"));
    assert.deepEqual(Object.keys(config), ["providers"]);
    assert.deepEqual(config.providers[PROVIDER_KEY].models, []);
  }
});

test("missing CPA status falls back to registry aliases + warning", () => {
  const { config, warnings } = buildPimonoConfig({ registry: REG, cpaStatus: null });
  assert.ok(warnings.includes("cpa_aliases_unavailable"));
  const ids = config.providers[PROVIDER_KEY].models.map((d) => d.id);
  assert.deepEqual(ids, ["claude-deepseek-v4-flash-0731", "claude-qwen3.8-flash-next"]);
});

test("defaultModel points at served model's current alias for the UI", () => {
  const { config, defaultModel } = buildPimonoConfig({ registry: REG, cpaStatus: CPA });
  assert.equal(defaultModel, `${PROVIDER_KEY}/${CURRENT_MODEL_ALIAS}`);
  // pi puts the default in settings.json — models.json must NOT carry it
  assert.ok(!("defaultModel" in config) && !("model" in config));
  assert.ok(JSON.stringify(config).includes(CURRENT_MODEL_ALIAS));
});

test("served id resolution falls back to CPA working_set", () => {
  assert.equal(resolveServedFromCpa(REG.models, CPA), "deepseek-v4-flash-0731");
  assert.equal(resolveServedFromCpa(REG.models, null), null);
});

test("buildModelDefs dedupes colliding alias ids across models", () => {
  const reg = {
    models: [
      { id: "a", aliases: ["claude-shared"] },
      { id: "b", aliases: ["claude-shared"] },
    ],
  };
  const { defs } = buildModelDefs(reg.models, new Set(), null);
  assert.equal(defs.filter((d) => d.id === "claude-shared").length, 1);
});

test("liveCpaAliases unions across providers", () => {
  const s = liveCpaAliases({ providers: [{ aliases: ["x"] }, { aliases: ["y", "x"] }, {}] });
  assert.deepEqual([...s].sort(), ["x", "y"]);
  assert.equal(liveCpaAliases(null).size, 0);
});

/* ------------------------------------------------- integration: live repo file */

test("generated config for the LIVE repo registry is schema-clean", async () => {
  const fs = await import("node:fs");
  const url = new URL("../../../../../config/model-registry.json", import.meta.url);
  let live;
  try {
    live = JSON.parse(fs.readFileSync(url, "utf8"));
  } catch {
    return; // dev worktree without config file — skip, unit fixtures cover shape
  }
  const { config, defaultModel } = buildPimonoConfig({ registry: live, cpaStatus: null });
  const prov = config.providers[PROVIDER_KEY];
  assert.deepEqual(Object.keys(config), ["providers"]);
  assert.equal(prov.models.length, live.models.length);
  for (const m of live.models) {
    const claude = (m.aliases || []).find((a) => a.startsWith("claude-"));
    assert.ok(prov.models.some((d) => d.id === (claude || m.id)), `missing ${m.id}`);
  }
  assert.ok(defaultModel.startsWith(`${PROVIDER_KEY}/`));
});
