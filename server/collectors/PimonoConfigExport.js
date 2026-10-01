/**
 * PimonoConfigExport — generates the pi-mono (Pi coding agent) provider/model
 * config for the sparkDash fleet from LIVE sources. Sibling adapter to
 * OpencodeConfigExport; both project the SAME registry data into different
 * on-disk formats (task t_c3d0f7f3, story t_ab1321df).
 *
 * Format truth (citation-backed spec, t_c1888a2d — verified against upstream
 * github.com/earendil-works/pi TypeBox schemas in
 * packages/coding-agent/src/core/model-config.ts):
 *   - Target file: `~/.pi/agent/models.json` (agent dir; override via
 *     PI_CODING_AGENT_DIR). No project-level equivalent.
 *   - Top level is EXACTLY `{ "providers": { "<id>": ProviderConfig } }`.
 *     Extra top-level keys are rejected and an invalid file is refused whole,
 *     so this module whitelists every key it emits — no $schema here (unlike
 *     opencode).
 *   - Non-built-in providers need `baseUrl` + `api`; models need only `id`
 *     (defaults: contextWindow 128000, maxTokens 16384, reasoning false,
 *     input ["text"]).
 *   - Env interpolation is "$VAR" / "${VAR}" — NOT opencode's `{env:VAR}`
 *     (which pi would treat as a *literal key*) and NOT a bare
 *     `CPA_API_KEY` (also a literal). A missing env var leaves the value
 *     unresolved: the model loads but stays unavailable until the user sets
 *     it — the desired failure mode.
 *   - `authHeader: true` sends `Authorization: Bearer <apiKey>`.
 *
 * Binding decisions honored (d-002, t_da7f7026 — same rules as the opencode
 * export):
 *   - baseUrl is the CLIProxyAPI endpoint `http://<cpa-host>:8317/v1`; direct
 *     node:port is REJECTED (bypasses per-user keys / usage tracking).
 *   - apiKey is the env placeholder for `CPA_API_KEY` — the export carries NO
 *     plaintext credentials ever (d-001 secret rule).
 *   - One picker entry per served model, keyed by the id CPA actually accepts
 *     (claude-* alias preferred via live CPA status, registry fallback); the
 *     canonical id is the display `name`, not a duplicate entry.
 *   - The fleet "always-current" alias gets its own entry on the served
 *     model. pi's default model lives in settings.json (`defaultModel`), NOT
 *     in models.json — so it is returned as `defaultModel` metadata for the
 *     UI copy text, never injected into the emitted config.
 *
 * Note: constants are duplicated from OpencodeConfigExport rather than
 * imported, because that module lives on an unmerged sibling branch
 * (t_03552241). Both branches must converge on one shared export core at
 * merge time; the values are pinned by the same decision record.
 *
 * Pure module: takes { registry, cpaStatus } as arguments so the endpoint can
 * pass freshly-read live state on every request (registry changes reflected
 * without restarting sparkDash) and tests need no I/O.
 */

/** Provider key + display name in the generated config. */
export const PROVIDER_KEY = "sparkdash";
export const PROVIDER_NAME = "Spark Fleet";

/** OpenAI-compatible API id for vLLM/CPA chat-completions (pi `api` field). */
export const PI_API = "openai-completions";

/** CPA endpoint constants (d-002) — single source of truth in CpaEndpoint.js. */
import { CPA_PORT, DEFAULT_CPA_HOST } from "./CpaEndpoint.js";
export { CPA_PORT, DEFAULT_CPA_HOST };
export const CPA_API_KEY_ENV = "CPA_API_KEY";

/** The fleet "always-current" alias CPA publishes for the served model. */
export const CURRENT_MODEL_ALIAS = "gilfoyle-current-model";

/** Conservative hostname/IPv4/IPv6-literal shape; rejects URL/scheme injection. */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Resolve the CPA host for the export: trim, default, sanitize. Anything that
 * isn't a bare host (scheme, slash, space, junk) falls back to the loopback
 * default so a crafted `?host=` can never smuggle a URL into baseUrl.
 */
export function resolveCpaHost(raw) {
  const h = typeof raw === "string" ? raw.trim() : "";
  if (!h) return DEFAULT_CPA_HOST;
  if (!HOST_RE.test(h) || h.includes("//")) return DEFAULT_CPA_HOST;
  return h;
}

/** Single server-resolved baseUrl (never appends /chat/completions). */
export function cpaBaseUrl(host) {
  return `http://${resolveCpaHost(host)}:${CPA_PORT}/v1`;
}

/** Env-placeholder form of the API key per pi's resolve-config-value syntax. */
export function piEnvPlaceholder(envName = CPA_API_KEY_ENV) {
  return `$${envName}`;
}

/** Union of every alias CPA accepts, from live-models-status.json providers. */
export function liveCpaAliases(cpaStatus) {
  const set = new Set();
  for (const p of cpaStatus?.providers || []) {
    for (const a of p?.aliases || []) if (typeof a === "string") set.add(a);
  }
  return set;
}

/**
 * Fallback served-model resolution from CPA status itself: the first id in
 * `working_set` coalesced through the registry (mirrors the opencode adapter).
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

function claudeAliasOf(model) {
  return (model?.aliases || []).find(
    (a) => typeof a === "string" && a.startsWith("claude-"),
  );
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return null;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Optional per-model enrichment. The registry carries no token limits today
 * (spec §4), but fleet-sync may add them later — pass through ONLY these
 * whitelisted keys, ONLY when the value is of a valid type. Everything else
 * (including any stray api_key/token/pin field in a registry entry) is
 * structurally excluded: the builder never spreads registry objects.
 */
function modelExtras(model) {
  const out = {};
  const cw = positiveInt(model?.contextWindow ?? model?.context_window);
  if (cw) out.contextWindow = cw;
  const mt = positiveInt(model?.maxTokens ?? model?.max_tokens);
  if (mt) out.maxTokens = mt;
  if (typeof model?.reasoning === "boolean") out.reasoning = model.reasoning;
  const input = model?.input ?? model?.modalities;
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((x) => x === "text" || x === "image") &&
    input.includes("text")
  ) {
    out.input = [...new Set(input)];
  }
  return out;
}

/**
 * One ModelDefinition per served model, in registry order.
 * id priority: claude-* alias (live CPA set preferred, registry fallback),
 * else canonical id. name: canonical id (d-002 display-name rule).
 *
 * @param {object[]} models registry `models` array
 * @param {Set<string>} liveAliases accepted ids from CPA status (may be empty)
 * @param {string|null} servedId canonical id of the live/served model
 * @returns {{ defs: object[], defaultId: string|null }}
 */
export function buildModelDefs(models, liveAliases, servedId) {
  const defs = [];
  const seen = new Set();
  let defaultId = null;
  const push = (id, name, model) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    defs.push({ id, name, ...modelExtras(model) });
  };
  for (const m of models || []) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    // Prefer a claude-* alias CPA confirms live; fall back to the registry's
    // claude-* alias; else the canonical id itself.
    const claude =
      firstString(...(m.aliases || []).filter((a) => liveAliases?.has(a))) || claudeAliasOf(m);
    const key = claude || m.id;
    push(key, m.id, m);
    if (m.id === servedId) {
      if (liveAliases?.has(CURRENT_MODEL_ALIAS)) {
        push(CURRENT_MODEL_ALIAS, `${m.id} (current)`, m);
        defaultId = CURRENT_MODEL_ALIAS;
      } else {
        defaultId = key;
      }
    }
  }
  if (!defaultId) defaultId = defs[0]?.id || null;
  return { defs, defaultId };
}

/**
 * Build the complete pi-mono models.json object.
 *
 * @param {object} opts
 * @param {object|null} opts.registry  parsed model-registry.json (live file state)
 * @param {object|null} opts.cpaStatus parsed live-models-status.json (alias truth)
 * @param {string} [opts.host]        CPA host override (default 127.0.0.1)
 * @param {string} [opts.servedId]    canonical id currently served (live probe)
 * @returns {{ config: object, defaultModel: string|null, warnings: string[] }}
 *   config       — exactly what to write to ~/.pi/agent/models.json
 *   defaultModel — `sparkdash/<id>` for the UI to suggest in settings.json
 *                  (NOT part of models.json; pi rejects unknown keys there)
 */
export function buildPimonoConfig({ registry, cpaStatus, host, servedId } = {}) {
  const warnings = [];
  const models = Array.isArray(registry?.models) ? registry.models : [];
  if (models.length === 0) warnings.push("registry_unavailable");
  const liveAliases = liveCpaAliases(cpaStatus);
  if (liveAliases.size === 0) warnings.push("cpa_aliases_unavailable");

  const { defs, defaultId } = buildModelDefs(
    models,
    liveAliases,
    servedId || resolveServedFromCpa(models, cpaStatus),
  );

  const config = {
    providers: {
      [PROVIDER_KEY]: {
        name: PROVIDER_NAME,
        baseUrl: cpaBaseUrl(host),
        api: PI_API,
        apiKey: piEnvPlaceholder(),
        authHeader: true,
        models: defs,
      },
    },
  };
  return {
    config,
    defaultModel: defaultId ? `${PROVIDER_KEY}/${defaultId}` : null,
    warnings,
  };
}

export default buildPimonoConfig;
