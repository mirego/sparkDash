/**
 * OpenCodeExport — generate a ready-to-paste `opencode.json` provider block
 * from the live fleet model registry (config/model-registry.json).
 *
 * Ruling wiki d-002 (factory/wikis/sparkdash, cards t_aa723514 / t_03552241):
 *   - baseURL is always the CLIProxyAPI (CPA) auth proxy: http://<cpa-host>:8317/v1
 *     (direct node ports rejected — they bypass per-user keys/usage tracking).
 *   - apiKey is ALWAYS an env placeholder `{env:CPA_API_KEY}` — never a literal.
 *   - models map keys are STABLE USER-FACING aliases confirmed by CPA's live
 *     alias set (live-models-status.json as truth, registry aliases as
 *     fallback): canonical id + `claude-*` + `gilfoyle-current-model`. HF
 *     weights ids (contain `/`) and one-off nicks are skipped.
 *     Canonical registry id is the display name of every entry.
 *   - `gilfoyle-current-model` (the always-current fleet alias) gets its own
 *     entry on the currently-served model and is the default `model:` value.
 *   - Copy-paste artifact only (d-001): nothing here writes files anywhere.
 *
 * The generator is pure: it takes the parsed registry (+ optional CPA live
 * status) and returns the config object. Callers (server route) re-read the
 * registry on every request so output can never go stale between restarts.
 */

import { CPA_PORT, DEFAULT_CPA_HOST } from "./CpaEndpoint.js";

// Shared CPA binding (d-002) lives in CpaEndpoint.js — re-exported so the
// module's public surface (and its tests) keep importing it from here.
export { CPA_PORT, DEFAULT_CPA_HOST };

/** Env var the user exports themselves; placeholder only in the artifact. */
export const CPA_API_KEY_ENV = "CPA_API_KEY";
/** Custom-provider id surfaced in opencode's /models picker as `sparkdash/<alias>`. */
export const PROVIDER_ID = "sparkdash";
/** The fleet "always-current" alias CPA publishes for the served model (product-head ruling 2026-09-30). */
export const CURRENT_MODEL_ALIAS = "gilfoyle-current-model";

/** opencode.json schema — documented top-level + ProviderConfig keys (v1 schema, https://opencode.ai/config.json). */
const OPENCODE_TOP_KEYS = new Set(["$schema", "model", "provider"]);
const PROVIDER_KEYS = new Set(["api", "name", "env", "id", "npm", "whitelist", "blacklist", "options", "models"]);
const PROVIDER_OPTION_KEYS = new Set(["apiKey", "baseURL", "enterpriseUrl", "setCacheKey", "timeout", "headerTimeout", "chunkTimeout"]);
const MODEL_ENTRY_KEYS = new Set(["id", "name", "family", "release_date", "attachment", "reasoning", "temperature", "tool_call", "interleaved", "cost", "limit", "modalities", "experimental", "status", "provider", "options", "headers", "variants"]);

/** Conservative host allowlist: IPv4 / hostname (optionally :port is NOT accepted — port is our constant). */
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** True for strings that look like a real API key (sk-…, or long high-entropy blobs). */
export function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  // sk-… anywhere on a token boundary (start, whitespace, or quote-ish char).
  if (/(^|[\s"'=(:])sk-[A-Za-z0-9_-]{8,}/.test(value)) return true;
  if (/(^|[\s"'=(:])Bearer\s+[A-Za-z0-9._-]{20,}/i.test(value)) return true;
  return false;
}

/** Stable user-facing alias names (product-head ruling 2026-09-30):
 * canonical id, `claude-*` family, and the `gilfoyle-current-model` alias.
 * HF weights ids (contain `/`) and one-off nicks are skipped. */
function isStableUserFacingAlias(alias, canonicalId) {
  if (typeof alias !== "string" || !alias) return false;
  if (alias.includes("/")) return false; // HF weights name — not a picker entry
  if (alias === canonicalId) return true;
  if (alias.startsWith("claude-")) return true;
  if (alias === CURRENT_MODEL_ALIAS) return true;
  return false;
}

/** CPA live status providers[].aliases as a Set (empty Set when file absent). */
function cpaAliasSet(cpaStatus) {
  const out = new Set();
  if (cpaStatus && Array.isArray(cpaStatus.providers)) {
    for (const p of cpaStatus.providers) {
      if (Array.isArray(p?.aliases)) {
        for (const a of p.aliases) if (typeof a === "string") out.add(a);
      }
    }
  }
  return out;
}

/**
 * Fallback served-model resolution from CPA status itself: the first id in
 * `working_set` (fleet_sync's live serving list) that the registry knows.
 * Used when the caller's live probe has no served id (e.g. node offline).
 */
export function resolveServedFromCpa(models, cpaStatus) {
  const ws = Array.isArray(cpaStatus?.working_set) ? cpaStatus.working_set : [];
  for (const id of ws) {
    const m = (models || []).find(
      (mm) => mm && (mm.id === id || (Array.isArray(mm.aliases) && mm.aliases.includes(id))),
    );
    if (m) return m.id;
  }
  return null;
}

/**
 * Build the opencode.json document for the fleet.
 * @param {object} registry parsed model-registry.json (live contents — caller must not cache)
 * @param {object} [opts]
 * @param {string} [opts.host] CPA host override (default 127.0.0.1)
 * @param {object|null} [opts.cpaStatus] parsed live-models-status.json for alias cross-check
 * @param {string|null} [opts.servedId] canonical id currently served (live probe)
 * @returns {{config: object, warnings: string[]}}
 */
export function buildOpencodeConfig(registry, opts = {}) {
  const host = opts.host && opts.host !== "" ? String(opts.host) : DEFAULT_CPA_HOST;
  if (!HOST_RE.test(host)) {
    const err = new Error(`invalid CPA host: ${JSON.stringify(host)}`);
    err.code = "BAD_HOST";
    throw err;
  }
  const warnings = [];
  const models = Array.isArray(registry?.models) ? registry.models : [];
  if (models.length === 0) warnings.push("registry has no models — provider block will be empty");

  // Alias truth: CPA's live accepted-id set (live-models-status.json). When
  // the file is unavailable we fall back to registry aliases and say so.
  const liveAliases = cpaAliasSet(opts.cpaStatus);
  const useLive = liveAliases.size > 0;
  if (!useLive) warnings.push("CPA live alias set unavailable — falling back to registry aliases");

  const servedId = opts.servedId || resolveServedFromCpa(models, opts.cpaStatus);

  const out = {};
  let defaultKey = null;
  for (const model of models) {
    if (!model?.id) continue;
    const candidates = [
      model.id,
      ...(Array.isArray(model.aliases) ? model.aliases : []),
      ...(model.id === servedId ? [CURRENT_MODEL_ALIAS] : []),
    ];
    let hasClaude = false;
    let added = 0;
    for (const alias of candidates) {
      if (!isStableUserFacingAlias(alias, model.id)) continue;
      if (alias.startsWith("claude-")) hasClaude = true;
      // d-002 "live set as truth": an id only ships if CPA accepts it.
      if (useLive && !liveAliases.has(alias)) {
        if (alias === model.id) warnings.push(`model ${model.id}: canonical id not CPA-accepted; skipped`);
        continue;
      }
      if (out[alias]) {
        warnings.push(`duplicate alias ${alias} from ${model.id}; keeping first`);
        continue;
      }
      out[alias] = { name: alias === CURRENT_MODEL_ALIAS ? `${model.id} (current)` : model.id };
      added += 1;
      if (alias === CURRENT_MODEL_ALIAS) defaultKey = alias;
    }
    if (!hasClaude && out[model.id]) {
      warnings.push(`model ${model.id} has no claude-* alias; keyed by canonical id`);
    }
    if (added === 0) warnings.push(`model ${model.id} has no CPA-accepted stable alias; skipped`);
  }

  if (!defaultKey) {
    // No live current-model alias: prefer the served model's own key, else first entry.
    const servedKeys = Object.keys(out);
    defaultKey = servedKeys[0] || null;
    if (servedId) {
      const own = servedKeys.find((k) => out[k].name === `${servedId} (current)` || out[k].name === servedId);
      if (own) defaultKey = own;
    }
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "sparkDash Fleet (CPA)",
        env: [CPA_API_KEY_ENV],
        options: {
          baseURL: `http://${host}:${CPA_PORT}/v1`,
          // Built by concatenation so the placeholder can never drift from the constant.
          apiKey: "{env:" + CPA_API_KEY_ENV + "}",
        },
        models: out,
      },
    },
  };
  if (defaultKey) config.model = `${PROVIDER_ID}/${defaultKey}`;
  return { warnings, config };
}

/**
 * Validate an opencode.json document against the documented schema subset we
 * emit (key whitelists mirror https://opencode.ai/config.json $defs:
 * Config / ProviderConfig / options / model entries — all additionalProperties:
 * false) plus the zero-plaintext-secret rule from d-001.
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
          if (key !== undefined && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(key))) {
            errors.push(`provider "${pid}": apiKey must be an {env:VAR} placeholder, not ${typeof key}`);
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
        if (/key|token|secret|password/i.test(k) && typeof x === "string" && !/^\{env:|^\{file:/.test(x)) {
          errors.push(`credential-like value at ${pathStr}.${k} is not an env/file placeholder`);
        }
        walk(x, `${pathStr}.${k}`);
      }
    }
  };
  walk(doc, "$");

  return { valid: errors.length === 0, errors };
}

export default { buildOpencodeConfig, validateOpencodeConfig, resolveServedFromCpa, CPA_PORT, DEFAULT_CPA_HOST, CPA_API_KEY_ENV, PROVIDER_ID, CURRENT_MODEL_ALIAS };
