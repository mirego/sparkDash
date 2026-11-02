/**
 * OpenCodeExport — generate a ready-to-paste `opencode.json` provider block
 * for the gilfoyle fleet (story t_da2e5d5e, rework of t_03552241).
 *
 * Rework spec (user-approved, supersedes d-002's {env:} rule for THIS export):
 *   - Provider id `gilfoyle`, name "Local DGX Sparks",
 *     npm "@ai-sdk/openai-compatible".
 *   - options.baseURL is the fleet CPA proxy http://10.4.0.15:8317/v1
 *     (server-resolved constant); options.apiKey is the LITERAL placeholder
 *     "YOUR_API_KEY" (user replaces with their real key).
 *   - `models` map contains EXACTLY two entries: `gilfoyle-current-model`
 *     (minimal always-valid baseline) + the model currently loaded on Anton.
 *     No loaded model detected ⇒ only the baseline.
 *   - Variant mechanics are validated PER MODEL via ExportModelSpec:
 *     effort-capable models get reasoningEffort variants; chat-template-gated
 *     models (exl3) get chat_template_kwargs variants. Never cloned blindly.
 *   - Copy-paste artifact only: nothing here writes files anywhere.
 *
 * The generator is pure: it takes the parsed registry (+ optional live
 * signals) and returns the config object. Callers (server route) re-read the
 * registry on every request so output can never go stale between restarts.
 */

import {
  classifyModelType,
  MODEL_TYPES,
  CURRENT_MODEL_BASELINE,
  EFFORT_VARIANTS,
  chatTemplateVariants,
  FLEET_BASE_URL,
  FLEET_API_KEY_PLACEHOLDER,
} from "./ExportModelSpec.js";

/** Provider key in the generated config (per rework spec). */
export const PROVIDER_ID = "gilfoyle";
/** Provider display name (per rework spec). */
export const PROVIDER_NAME = "Local DGX Sparks";
/** The fleet "always-current" alias. */
export const CURRENT_MODEL_ALIAS = "gilfoyle-current-model";

/** opencode.json schema — documented top-level + ProviderConfig keys (v1 schema, https://opencode.ai/config.json). */
const OPENCODE_TOP_KEYS = new Set(["$schema", "model", "provider"]);
const PROVIDER_KEYS = new Set(["api", "name", "env", "id", "npm", "whitelist", "blacklist", "options", "models"]);
const PROVIDER_OPTION_KEYS = new Set(["apiKey", "baseURL", "enterpriseUrl", "setCacheKey", "timeout", "headerTimeout", "chunkTimeout"]);
const MODEL_ENTRY_KEYS = new Set(["id", "name", "family", "release_date", "attachment", "reasoning", "temperature", "tool_call", "interleaved", "cost", "limit", "modalities", "experimental", "status", "provider", "options", "headers", "variants"]);

/** True for strings that look like a real API key (sk-…, or long high-entropy blobs). */
export function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  // sk-… anywhere on a token boundary (start, whitespace, or quote-ish char).
  if (/(^|[\s"'=(:])sk-[A-Za-z0-9_-]{8,}/.test(value)) return true;
  if (/(^|[\s"'=(:])Bearer\s+[A-Za-z0-9._-]{20,}/i.test(value)) return true;
  return false;
}

/** The registry model entry matching a served id (id or alias match). */
function findRegistryModel(models, servedId) {
  if (!servedId) return null;
  return (
    (models || []).find(
      (m) => m && (m.id === servedId || (Array.isArray(m.aliases) && m.aliases.includes(servedId))),
    ) || null
  );
}

/** Human display name for a registry entry. */
function displayName(model) {
  if (!model) return CURRENT_MODEL_ALIAS;
  return model.recipe || model.weights || model.id;
}

/**
 * Build the opencode model entry for an effort-capable model.
 */
function effortModelEntry(model) {
  return {
    name: displayName(model),
    tool_call: true,
    temperature: true,
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0, output: 0 },
    variants: { ...EFFORT_VARIANTS },
  };
}

/**
 * Build the opencode model entry for a chat-template-gated model
 * (exl3): thinking is selected through chat_template_kwargs.
 */
function chatTemplateModelEntry(model) {
  return {
    name: displayName(model),
    tool_call: true,
    temperature: true,
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0, output: 0 },
    variants: chatTemplateVariants(),
  };
}

/** Minimal baseline entry valid across all cluster setups (user-approved). */
function currentModelEntry() {
  return {
    name: CURRENT_MODEL_BASELINE.name,
    tool_call: true,
    temperature: true,
    reasoning: true,
    limit: { context: CURRENT_MODEL_BASELINE.contextLimit, output: CURRENT_MODEL_BASELINE.outputLimit },
    modalities: { input: [...CURRENT_MODEL_BASELINE.opencodeModalities.input], output: [...CURRENT_MODEL_BASELINE.opencodeModalities.output] },
    cost: { input: 0, output: 0 },
    variants: { ...EFFORT_VARIANTS },
  };
}

/**
 * Build the opencode.json document for the fleet.
 * @param {object} registry parsed model-registry.json (live contents — caller must not cache)
 * @param {object} [opts]
 * @param {string|null} [opts.servedId] canonical id currently loaded on Anton (live probe)
 * @returns {{config: object, warnings: string[]}}
 */
export function buildOpencodeConfig(registry, opts = {}) {
  const warnings = [];
  const models = Array.isArray(registry?.models) ? registry.models : [];
  if (models.length === 0) warnings.push("registry has no models");

  const out = {};
  out[CURRENT_MODEL_ALIAS] = currentModelEntry();

  const servedId = opts.servedId || null;
  const servedModel = findRegistryModel(models, servedId);
  if (servedId && servedModel) {
    out[servedModel.id] =
      classifyModelType(servedModel) === MODEL_TYPES.CHAT_TEMPLATE
        ? chatTemplateModelEntry(servedModel)
        : effortModelEntry(servedModel);
  } else if (servedId) {
    // Loaded id is live but unknown to the registry: still emit it with the
    // baseline shape (effort variants are the safe default) so the user gets
    // a working entry; the baseline alias covers the conservative path.
    warnings.push(`loaded model ${servedId} not in registry — emitted with baseline parameters`);
    out[servedId] = effortModelEntry({ id: servedId });
  } else {
    warnings.push("no loaded model detected — emitting gilfoyle-current-model only");
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: PROVIDER_NAME,
        options: {
          baseURL: FLEET_BASE_URL,
          // Literal placeholder per user ruling (t_da2e5d5e) — the user
          // replaces it with their real CPA key. Not an env indirection.
          apiKey: FLEET_API_KEY_PLACEHOLDER,
        },
        models: out,
      },
    },
  };
  config.model = `${PROVIDER_ID}/${CURRENT_MODEL_ALIAS}`;
  return { warnings, config };
}

/**
 * Validate an opencode.json document against the documented schema subset we
 * emit (key whitelists mirror https://opencode.ai/config.json $defs:
 * Config / ProviderConfig / options / model entries — all additionalProperties:
 * false) plus the rework-shape rules: literal placeholder key, the fleet
 * baseURL, and at most the two allowed model entries with per-model-typed
 * variant mechanics.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateOpencodeConfig(doc) {
  const errors = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  if (!isObj(doc)) return { valid: false, errors: ["config is not an object"] };
  for (const k of Object.keys(doc)) {
    if (!OPENCODE_TOP_KEYS.has(k)) errors.push(`unknown top-level key "${k}"`);
  }
  if (doc.$schema !== "https://opencode.ai/config.json") {
    errors.push('$schema must be "https://opencode.ai/config.json"');
  }
  const prov = doc.provider;
  if (!isObj(prov) || Object.keys(prov).length === 0) {
    errors.push("provider map missing or empty");
  } else {
    for (const [pid, pc] of Object.entries(prov)) {
      if (!isObj(pc)) { errors.push(`provider "${pid}" is not an object`); continue; }
      for (const k of Object.keys(pc)) {
        if (!PROVIDER_KEYS.has(k)) errors.push(`provider "${pid}": unknown key "${k}"`);
      }
      if (pc.options !== undefined) {
        if (!isObj(pc.options)) errors.push(`provider "${pid}": options must be an object`);
        else {
          for (const k of Object.keys(pc.options)) {
            if (!PROVIDER_OPTION_KEYS.has(k)) errors.push(`provider "${pid}": unknown option "${k}"`);
          }
          const key = pc.options.apiKey;
          if (key !== undefined && key !== FLEET_API_KEY_PLACEHOLDER && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(key))) {
            errors.push(`provider "${pid}": apiKey must be the "${FLEET_API_KEY_PLACEHOLDER}" placeholder or an {env:VAR} indirection, not ${typeof key}`);
          }
          if (pc.options.baseURL !== undefined && !/^https?:\/\/[^\s]+\/v1$/.test(String(pc.options.baseURL))) {
            errors.push(`provider "${pid}": baseURL must be an http(s) URL ending in /v1`);
          }
        }
      }
      if (pc.env !== undefined && !Array.isArray(pc.env)) errors.push(`provider "${pid}": env must be an array`);
      if (pc.models !== undefined) {
        if (!isObj(pc.models)) errors.push(`provider "${pid}": models must be an object`);
        else {
          for (const [mid, entry] of Object.entries(pc.models)) {
            if (!isObj(entry)) { errors.push(`model "${mid}": entry must be an object`); continue; }
            for (const k of Object.keys(entry)) {
              if (!MODEL_ENTRY_KEYS.has(k)) errors.push(`model "${mid}": unknown key "${k}"`);
            }
            // Per-model variant validation: the variant shape must match the
            // model type, never a blind template clone.
            if (entry.variants !== undefined) {
              if (!isObj(entry.variants)) {
                errors.push(`model "${mid}": variants must be an object`);
              } else {
                const vkeys = Object.keys(entry.variants);
                const hasEffort = vkeys.some((v) => entry.variants[v]?.reasoningEffort !== undefined);
                const hasChatTemplate = vkeys.some((v) => entry.variants[v]?.chat_template_kwargs !== undefined);
                if (hasEffort && hasChatTemplate) {
                  errors.push(`model "${mid}": variants mix reasoningEffort and chat_template_kwargs`);
                } else if (mid === CURRENT_MODEL_ALIAS && !hasEffort) {
                  errors.push(`model "${mid}": baseline must use reasoningEffort variants`);
                }
              }
            }
          }
          if (Object.keys(pc.models).length > 2) {
            errors.push(`provider "${pid}": models must contain at most two entries (gilfoyle-current-model + active)`);
          }
        }
      }
    }
  }

  // Zero-plaintext-secret sweep over every string leaf (d-001 binding rule).
  const walk = (v, pathStr) => {
    if (typeof v === "string") {
      if (looksLikeSecret(v)) errors.push(`possible plaintext secret at ${pathStr}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${pathStr}[${i}]`));
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (/key|token|secret|password/i.test(k) && typeof x === "string" && !/^\{env:|^\{file:/.test(x) && x !== FLEET_API_KEY_PLACEHOLDER) {
          errors.push(`credential-like value at ${pathStr}.${k} is not the approved placeholder`);
        }
        walk(x, `${pathStr}.${k}`);
      }
    }
  };
  walk(doc, "$");

  return { valid: errors.length === 0, errors };
}

export default { buildOpencodeConfig, validateOpencodeConfig, PROVIDER_ID, PROVIDER_NAME, CURRENT_MODEL_ALIAS, FLEET_BASE_URL, FLEET_API_KEY_PLACEHOLDER };
