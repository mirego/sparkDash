/**
 * PimonoConfigExport — generates the pi-mono (Pi coding agent) provider/model
 * config for the gilfoyle fleet. Reworked for t_da2e5d5e (supersedes the
 * t_c3d0f7f3 alias-expansion adapter).
 *
 * Rework spec (user-approved, per OPin sample):
 *   - Provider `gilfoyle`: baseUrl "Replaced by extensions/providers.ts",
 *     api "openai-completions",
 *     compat { supportsDeveloperRole: false, supportsReasoningEffort: false }.
 *   - NO `apiKey` field anywhere — pi resolves auth via env variables /
 *     auth.json; the sentinel baseUrl is rewritten by the user's extensions
 *     layer. (Supersedes d-002's $CPA_API_KEY placeholder for THIS export.)
 *   - `models` array contains EXACTLY two entries: `gilfoyle-current-model`
 *     (minimal always-valid baseline) + the model currently loaded on Anton.
 *     No loaded model detected ⇒ only the baseline.
 *   - Per model: id, name, reasoning, input (from registry modalities),
 *     contextWindow, maxTokens, cost {input,output,cacheRead,cacheWrite},
 *     and a PER-MODEL thinkingLevelMap — effort-capable models get the
 *     effort mapping; chat-template-gated models (exl3) get the pi-native
 *     `qwen-chat-template` compat + chatTemplateKwargs $var bindings
 *     (validated against pi.dev docs / upstream pi source, not blind-copied).
 *
 * Schema truth: packages/coding-agent/src/core/model-config.ts TypeBox
 * schemas (research card t_c1888a2d). models entries ADD/REPLACE same-id
 * models; unknown keys are rejected — every key emitted here is whitelisted.
 *
 * Pure module: takes { registry, servedId } so the endpoint passes freshly
 * read live state on every request.
 */

import {
  classifyModelType,
  MODEL_TYPES,
  CURRENT_MODEL_BASELINE,
  effortThinkingLevelMap,
  chatTemplateThinkingLevelMap,
  chatTemplateCompat,
} from "./ExportModelSpec.js";

/** Provider key in the generated config (per rework spec). */
export const PROVIDER_KEY = "gilfoyle";
/** OpenAI-compatible API id (pi `api` field). */
export const PI_API = "openai-completions";
/** The fleet "always-current" alias. */
export const CURRENT_MODEL_ALIAS = "gilfoyle-current-model";
/** Sentinel baseUrl rewritten by the user's extensions/providers.ts layer. */
export const SENTINEL_BASE_URL = "Replaced by extensions/providers.ts";

/** Registry modalities → pi input list (pi allows "text" | "image"). */
function pimonoInput(model) {
  const raw = model?.modalities?.input || model?.input;
  if (Array.isArray(raw)) {
    const filtered = raw.filter((x) => x === "text" || x === "image");
    if (filtered.length > 0) return [...new Set(filtered)];
  }
  return [...CURRENT_MODEL_BASELINE.pimonoInput];
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * One ModelDefinition per spec field set, typed by model class.
 * @param {object|null} model registry entry
 * @param {string} id wire id
 * @param {string} name display name
 */
function modelDef(model, id, name) {
  const type = classifyModelType(model);
  const def = {
    id,
    name,
    reasoning: true,
    input: pimonoInput(model),
    contextWindow: positiveInt(model?.contextWindow) || CURRENT_MODEL_BASELINE.contextLimit,
    maxTokens: positiveInt(model?.maxTokens) || CURRENT_MODEL_BASELINE.outputLimit,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (type === MODEL_TYPES.CHAT_TEMPLATE) {
    def.thinkingLevelMap = chatTemplateThinkingLevelMap();
    def.compat = chatTemplateCompat();
  } else {
    def.thinkingLevelMap = effortThinkingLevelMap();
  }
  return def;
}

/** The minimal baseline entry valid across all cluster setups. */
function currentModelDef() {
  return {
    id: CURRENT_MODEL_ALIAS,
    name: CURRENT_MODEL_BASELINE.name,
    reasoning: true,
    input: [...CURRENT_MODEL_BASELINE.pimonoInput],
    contextWindow: CURRENT_MODEL_BASELINE.contextLimit,
    maxTokens: CURRENT_MODEL_BASELINE.outputLimit,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: effortThinkingLevelMap(),
  };
}

/**
 * Build the complete pi-mono models.json object.
 *
 * @param {object} opts
 * @param {object|null} opts.registry  parsed model-registry.json (live file state)
 * @param {string|null} [opts.servedId] canonical id currently loaded on Anton (live probe)
 * @returns {{ config: object, defaultModel: string|null, warnings: string[] }}
 *   config       — exactly what to write to ~/.pi/agent/models.json
 *   defaultModel — `gilfoyle/<id>` for the UI copy text (pi keeps its default
 *                  in settings.json — NOT part of models.json)
 */
export function buildPimonoConfig({ registry, servedId } = {}) {
  const warnings = [];
  const models = Array.isArray(registry?.models) ? registry.models : [];
  if (models.length === 0) warnings.push("registry_unavailable");

  const defs = [currentModelDef()];
  const model = servedId
    ? models.find(
        (m) => m && (m.id === servedId || (Array.isArray(m.aliases) && m.aliases.includes(servedId))),
      )
    : null;
  if (servedId && model) {
    defs.push(modelDef(model, model.id, model.id));
  } else if (servedId) {
    // Loaded id is live but unknown to the registry: emit with baseline
    // parameters so the entry still works; flagged in warnings.
    warnings.push(`loaded_model_not_in_registry:${servedId}`);
    defs.push(modelDef(null, servedId, servedId));
  } else {
    warnings.push("no_loaded_model_detected");
  }

  const config = {
    providers: {
      [PROVIDER_KEY]: {
        baseUrl: SENTINEL_BASE_URL,
        api: PI_API,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: defs,
      },
    },
  };
  return {
    config,
    defaultModel: `${PROVIDER_KEY}/${CURRENT_MODEL_ALIAS}`,
    warnings,
  };
}

export default buildPimonoConfig;
