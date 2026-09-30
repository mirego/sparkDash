/**
 * Unit tests for the opencode.json provider block generator
 * (server/collectors/OpenCodeExport.js) — card t_74f9a080.
 *
 * Covers: schema-key compliance, claude-* alias policy + CPA live-alias
 * cross-check (d-002), {env:CPA_API_KEY} placeholder, baseURL shape,
 * zero-plaintext-secret invariant, and live-registry freshness
 * (fresh parse of a mutated registry changes the export — no restart).
 *
 * Run: node --test server/collectors/__tests__/OpenCodeExport.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpencodeConfig,
  validateOpencodeConfig,
  looksLikeSecret,
  CPA_PORT,
  CPA_API_KEY_ENV,
  PROVIDER_ID,
  DEFAULT_CPA_HOST,
} from "../OpenCodeExport.js";

/** Representative slice of the real config/model-registry.json shape. */
const REGISTRY = {
  version: 1,
  nodes: { A: { host: "127.0.0.1", name: "anton", pin: "" } },
  models: [
    {
      id: "deepseek-v4-flash-0731",
      aliases: ["deepseek-v4-flash-dspark", "claude-deepseek-v4-flash-0731"],
      capability: ["general", "fast"],
      engine: "vllm",
      node_ports: [{ node: "A", host: "127.0.0.1", port: 8888, host_port: "127.0.0.1:8888" }],
    },
    {
      id: "qwen3.8-flash-next",
      aliases: ["qwen38-fn", "claude-qwen3.8-flash-next"],
      capability: ["general"],
      engine: "vllm",
      node_ports: [{ node: "A", host: "127.0.0.1", port: 8888, host_port: "127.0.0.1:8888" }],
    },
    {
      // No claude-* alias → falls back to canonical id + warning.
      id: "mystery-model",
      aliases: [],
      capability: ["general"],
      engine: "vllm",
      node_ports: [],
    },
  ],
};

const CPA_STATUS = {
  working_set: ["qwen3.8-flash-next"],
  providers: [
    {
      name: "live-qwen3.8-flash-next-127-0-0-1",
      "base-url": "http://127.0.0.1:8888/v1",
      aliases: ["qwen3.8-flash-next", "claude-qwen3.8-flash-next", "gilfoyle-current-model"],
    },
  ],
};

test("builds a valid opencode provider block from the registry", () => {
  const { config } = buildOpencodeConfig(REGISTRY);
  const check = validateOpencodeConfig(config);
  assert.equal(check.valid, true, check.errors.join("; "));

  assert.equal(config.$schema, "https://opencode.ai/config.json");
  const prov = config.provider[PROVIDER_ID];
  assert.ok(prov, "provider.sparkdash present");
  assert.equal(prov.npm, "@ai-sdk/openai-compatible");
  assert.equal(prov.options.baseURL, `http://${DEFAULT_CPA_HOST}:${CPA_PORT}/v1`);
  assert.equal(prov.options.apiKey, `{env:${CPA_API_KEY_ENV}}`);
  assert.deepEqual(prov.env, [CPA_API_KEY_ENV]);
});

test("stable user-facing aliases each get an entry; canonical id is display name (ruling 2026-09-30)", () => {
  // No CPA status file → registry-alias fallback: canonical + claude-* ship, nicks don't.
  const { config, warnings } = buildOpencodeConfig(REGISTRY);
  const models = config.provider[PROVIDER_ID].models;
  assert.deepEqual(Object.keys(models).sort(), [
    "claude-deepseek-v4-flash-0731",
    "claude-qwen3.8-flash-next",
    "deepseek-v4-flash-0731",
    "mystery-model",
    "qwen3.8-flash-next",
  ]);
  assert.equal(models["claude-deepseek-v4-flash-0731"].name, "deepseek-v4-flash-0731");
  assert.equal(models["qwen3.8-flash-next"].name, "qwen3.8-flash-next");
  // one-off nick ("qwen38-fn", "deepseek-v4-flash-dspark") must NOT be a picker entry
  assert.equal(models["qwen38-fn"], undefined);
  assert.equal(models["deepseek-v4-flash-dspark"], undefined);
  // no-claude-alias model warns and still ships under canonical id
  assert.ok(warnings.some((w) => w.includes("mystery-model")));
  assert.equal(validateOpencodeConfig(config).valid, true);
});

test("CPA live alias set is the truth: unaccepted ids are dropped", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { cpaStatus: CPA_STATUS });
  const keys = Object.keys(config.provider[PROVIDER_ID].models);
  // CPA_STATUS here publishes only qwen aliases → deepseek/mystery have no live-accepted id.
  assert.ok(keys.includes("qwen3.8-flash-next"));
  assert.ok(keys.includes("claude-qwen3.8-flash-next"));
  assert.ok(!keys.includes("claude-deepseek-v4-flash-0731"));
  assert.ok(!keys.includes("mystery-model"));
});

test("HF weights ids and nicks are skipped even when CPA publishes them", () => {
  const cpa = {
    providers: [
      {
        aliases: [
          "qwen3.8-flash-next",
          "claude-qwen3.8-flash-next",
          "RadixArk/Qwen3.8-Flash-Next-NVFP4", // HF weights name
          "qwen38-fn", // one-off nick
          "gilfoyle-current-model",
        ],
      },
    ],
    working_set: ["qwen3.8-flash-next"],
  };
  const reg = {
    models: [
      {
        id: "qwen3.8-flash-next",
        aliases: ["RadixArk/Qwen3.8-Flash-Next-NVFP4", "qwen38-fn", "claude-qwen3.8-flash-next"],
        node_ports: [],
      },
    ],
  };
  const { config } = buildOpencodeConfig(reg, { cpaStatus: cpa });
  const prov = config.provider[PROVIDER_ID];
  assert.deepEqual(Object.keys(prov.models).sort(), [
    "claude-qwen3.8-flash-next",
    "gilfoyle-current-model",
    "qwen3.8-flash-next",
  ]);
  assert.equal(config.model, "sparkdash/gilfoyle-current-model");
  assert.equal(prov.models["gilfoyle-current-model"].name, "qwen3.8-flash-next (current)");
});

test("default model: gilfoyle-current-model via CPA working_set fallback, no probe needed", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { cpaStatus: CPA_STATUS });
  assert.equal(config.model, "sparkdash/gilfoyle-current-model");
});

test("explicit servedId wins over working_set fallback", () => {
  const cpa = { providers: [{ aliases: ["deepseek-v4-flash-0731", "claude-deepseek-v4-flash-0731", "gilfoyle-current-model"] }], working_set: ["qwen3.8-flash-next"] };
  const { config } = buildOpencodeConfig(REGISTRY, { cpaStatus: cpa, servedId: "deepseek-v4-flash-0731" });
  assert.equal(config.model, "sparkdash/gilfoyle-current-model");
  assert.equal(config.provider[PROVIDER_ID].models["gilfoyle-current-model"].name, "deepseek-v4-flash-0731 (current)");
  assert.equal(config.provider[PROVIDER_ID].models["claude-qwen3.8-flash-next"], undefined);
});

test("no live aliases anywhere: default model falls back to first stable key", () => {
  const { config } = buildOpencodeConfig(REGISTRY);
  assert.ok(config.model.startsWith("sparkdash/"));
  const key = config.model.split("/")[1];
  assert.ok(config.provider[PROVIDER_ID].models[key]);
});

test("CPA live alias set wins over registry when they disagree", () => {
  const cpa = {
    providers: [{ aliases: ["claude-live-winner"] }],
  };
  const reg = {
    models: [{ id: "x", aliases: ["claude-live-winner", "claude-registry-loser"], node_ports: [] }],
  };
  const { config } = buildOpencodeConfig(reg, { cpaStatus: cpa });
  assert.deepEqual(Object.keys(config.provider[PROVIDER_ID].models), ["claude-live-winner"]);
});

test("custom CPA host is honoured; port stays 8317 and path /v1", () => {
  const { config } = buildOpencodeConfig(REGISTRY, { host: "192.168.100.11" });
  assert.equal(config.provider[PROVIDER_ID].options.baseURL, "http://192.168.100.11:8317/v1");
});

test("rejects hosts that try to smuggle in a port/path", () => {
  assert.throws(() => buildOpencodeConfig(REGISTRY, { host: "evil.example:9" }), /invalid CPA host/);
  assert.throws(() => buildOpencodeConfig(REGISTRY, { host: "http://evil.example" }), /invalid CPA host/);
});

test("empty/absent registry yields empty models, still valid JSON shape", () => {
  const { config, warnings } = buildOpencodeConfig({ models: [] });
  assert.deepEqual(config.provider[PROVIDER_ID].models, {});
  assert.ok(warnings.length > 0);
  assert.equal(validateOpencodeConfig(config).valid, true);
});

test("output contains no plaintext secrets — validator catches injected ones", () => {
  const { config } = buildOpencodeConfig(REGISTRY);
  // Round-trip: the honest artifact passes.
  assert.equal(validateOpencodeConfig(config).valid, true);
  assert.ok(!JSON.stringify(config).includes("sk-"));

  // A tampered artifact with a literal key must FAIL validation (tests would
  // catch a future generator regression that leaks secrets).
  const tampered = structuredClone(config);
  tampered.provider[PROVIDER_ID].options.apiKey = "sk-supersecretvalue123";
  const bad = validateOpencodeConfig(tampered);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("apiKey")));

  // Secret hidden in an unexpected string leaf must also fail.
  const sneaky = structuredClone(config);
  sneaky.provider[PROVIDER_ID].name = "Fleet sk-abcdefghij1234567890";
  assert.equal(validateOpencodeConfig(sneaky).valid, false);
});

test("looksLikeSecret heuristic", () => {
  assert.equal(looksLikeSecret("sk-abcdefghijklmnop"), true);
  assert.equal(looksLikeSecret("Bearer abcdef.ghijklmnop.1234567890"), true);
  assert.equal(looksLikeSecret("{env:CPA_API_KEY}"), false);
  assert.equal(looksLikeSecret("claude-qwen3.8-flash-next"), false);
});

test("schema validator rejects unknown keys per documented additionalProperties:false", () => {
  const bad = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      sparkdash: {
        npm: "@ai-sdk/openai-compatible",
        bogusKey: 1,
        options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "{env:CPA_API_KEY}" },
        models: { m: { name: "m", nope: true } },
      },
    },
  };
  const res = validateOpencodeConfig(bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("bogusKey")));
  assert.ok(res.errors.some((e) => e.includes("nope")));
});

test("live-registry check: mutating the registry source changes export without restart", () => {
  // Simulate what the server route does per request: re-read + re-parse the
  // source, then generate. No module-level caching is allowed to interfere.
  const live = structuredClone(REGISTRY);
  const first = buildOpencodeConfig(live);
  assert.deepEqual(Object.keys(first.config.provider[PROVIDER_ID].models).length, 5);

  // fleet-sync rewrites the registry: new model appears, one alias changes.
  live.models.push({
    id: "new-model",
    aliases: ["claude-new-model"],
    engine: "vllm",
    node_ports: [],
  });
  live.models[0].aliases = ["claude-renamed-alias"];

  const second = buildOpencodeConfig(live);
  const keys = Object.keys(second.config.provider[PROVIDER_ID].models);
  assert.ok(keys.includes("claude-new-model"), "new model shows up in export immediately");
  assert.ok(keys.includes("claude-renamed-alias"), "alias rename reflected immediately");
  assert.ok(!keys.includes("claude-deepseek-v4-flash-0731"), "stale alias gone");
  assert.equal(validateOpencodeConfig(second.config).valid, true);
});
