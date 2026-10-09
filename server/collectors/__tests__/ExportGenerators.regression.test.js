import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildOpencodeConfig,
  validateOpencodeConfig,
  CURRENT_MODEL_ALIAS,
  PROVIDER_ID,
} from "../OpenCodeExport.js";
import { buildPimonoConfig } from "../PimonoConfigExport.js";

/**
 * Re-wiring check (t_011c031d): the export generators must stay valid against
 * the ACTUAL 2.0 registry file — not a hand-copied fixture. The fixture above
 * mirrors this file, but drift here is exactly what 2.0 churn can cause, so
 * read the real one and drive every generator path through it: every model,
 * every alias, and the no-loaded-model case. If the registry shape ever
 * changes under the generators, this file is what goes red.
 */
const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/model-registry.json",
);

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));

/** Every id/alias the live probe could hand the endpoint, plus null. */
function allServedIds() {
  const ids = [null];
  for (const m of registry.models) {
    ids.push(m.id);
    for (const a of m.aliases || []) ids.push(a);
  }
  return ids;
}

function coalesce(id) {
  return (registry.alias_to_id && registry.alias_to_id[id]) || id;
}

test("2.0 registry file parses and exposes the shape the generators read", () => {
  assert.ok(Array.isArray(registry.models) && registry.models.length > 0, "registry.models must be a non-empty array");
  for (const m of registry.models) {
    assert.equal(typeof m.id, "string", `model ${m.id}: id must be a string`);
    assert.ok(m.id.length > 0, "model id must be non-empty");
    // Fields the generators / classifier read — 2.0 must keep emitting them.
    assert.ok("quantization" in m, `model ${m.id}: quantization field missing (classifyModelType input)`);
    if ("alias_to_id" in registry) {
      for (const [alias, canon] of Object.entries(registry.alias_to_id)) {
        const target = registry.models.find((mm) => mm.id === canon);
        assert.ok(target, `alias_to_id ${alias} → ${canon}: canonical id not in registry.models`);
      }
    }
  }
});

for (const servedId of allServedIds()) {
  const canon = coalesce(servedId);
  const label = servedId === null ? "no loaded model" : servedId;

  test(`opencode export valid against 2.0 registry — ${label}`, () => {
    const { config, warnings } = buildOpencodeConfig(registry, { servedId: canon });
    // The exact payload the UI copies must round-trip as JSON.
    const reparsed = JSON.parse(JSON.stringify(config));
    const check = validateOpencodeConfig(reparsed);
    assert.deepEqual(check.errors, [], `schema validation failed: ${check.errors.join("; ")}`);
    assert.ok(check.valid);
    const models = reparsed.provider[PROVIDER_ID].models;
    assert.ok(Object.keys(models).length <= 2, "at most gilfoyle-current-model + active");
    assert.ok(models[CURRENT_MODEL_ALIAS], "baseline alias always present");
    if (servedId === null) {
      assert.ok(warnings.length > 0, "no-loaded case must warn");
      assert.equal(Object.keys(models).length, 1);
    }
  });

  test(`pi-mono export valid against 2.0 registry — ${label}`, () => {
    const { config, defaultModel, warnings } = buildPimonoConfig({ registry, servedId: canon });
    const reparsed = JSON.parse(JSON.stringify(config));
    const providers = reparsed.providers;
    assert.ok(providers && typeof providers === "object" && Object.keys(providers).length === 1);
    const prov = providers.gilfoyle;
    assert.equal(prov.api, "openai-completions");
    assert.ok(!("apiKey" in prov), "pi resolves auth via env — no apiKey anywhere");
    assert.ok(Array.isArray(prov.models) && prov.models.length <= 2);
    assert.ok(prov.models.some((m) => m.id === CURRENT_MODEL_ALIAS), "baseline alias always present");
    for (const entry of prov.models) {
      assert.equal(typeof entry.id, "string");
      assert.equal(typeof entry.name, "string");
      assert.ok(Array.isArray(entry.input) && entry.input.every((x) => x === "text" || x === "image"));
      assert.ok(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0);
      assert.ok(Number.isFinite(entry.maxTokens) && entry.maxTokens > 0);
      assert.ok(entry.thinkingLevelMap && typeof entry.thinkingLevelMap === "object");
    }
    if (servedId === null) {
      assert.ok(warnings.length > 0, "no-loaded case must warn");
      assert.equal(prov.models.length, 1);
    }
    assert.ok(typeof defaultModel === "string" && defaultModel.startsWith("gilfoyle/"));
  });
}

test("alias_to_id coalescing matches what the endpoint passes (servedId ∈ models ids)", () => {
  // The endpoint resolves via modelRegistry.coalesce() before building. For
  // every alias the coalesced id must be a registry model id so the generator
  // takes the registry path (not the unknown-model fallback).
  for (const [alias, canon] of Object.entries(registry.alias_to_id || {})) {
    const oc = buildOpencodeConfig(registry, { servedId: canon });
    assert.ok(
      oc.config.provider[PROVIDER_ID].models[canon],
      `coalesced ${alias} → ${canon} must emit a dedicated model entry`,
    );
    const pm = buildPimonoConfig({ registry, servedId: canon });
    assert.ok(pm.config.providers.gilfoyle.models.some((m) => m.id === canon));
  }
});
