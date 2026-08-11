/**
 * PerUserModelUsageTracker — per-model (and per-user × model) token usage.
 *
 * Composes on top of PerKeyUsageTracker (which correlates CPA gin_logger +
 * v1-chat-completions request logs and already applies the delta-on-
 * lastRawPromptTokens logic so we count NEW input per conversation turn, not
 * the full accumulated vLLM context). This module adds the registry-aware
 * layer the multi-model design requires (DESIGN.md §9.3):
 *
 *   1. Coalesce aliases → canonical registry id.
 *      `claude-deepseek-v4-flash-0731`, `deepseek-ai/DeepSeek-V4-Flash-0731`
 *      and the canonical `deepseek-v4-flash-0731` all roll up into ONE row.
 *   2. Per-model summary rows: lifetime in/out tokens, requests, last-seen,
 *      optionally per (modelId, node, port) variant.
 *   3. Drill-down: per-user × per-model rows.
 *
 * This module is pure (no I/O, no network) so it is trivially unit-testable.
 */

/**
 * Normalize an alias/id and look up its canonical counterpart.
 * @param {string} modelName  raw model id from a request
 * @param {object|null} registry  parsed model-registry.json (optional)
 * @returns {string} canonical id (falls back to input when unknown/absent)
 */
export function canonicalModel(modelName, registry) {
  if (!modelName) return modelName;
  if (registry && registry.alias_to_id) {
    const canon = registry.alias_to_id[modelName];
    if (canon) return canon;
  }
  return modelName;
}

/**
 * Build per-model usage summary from PerKeyUsageTracker's per-model user map,
 * coalescing aliases to canonical ids via the registry.
 *
 * @param {object} allModelUsers  output of PerKeyUsageTracker.getAllModelUsers()
 *        shape: { [modelName]: { users, totalRequests, totalTokens } }
 * @param {object|null} registry  parsed model-registry.json (alias_to_id map)
 * @returns {Map<string, object>} canonicalModelId -> {
 *            requests, promptTokens, completionTokens, totalTokens, lastSeen,
 *            users: [ {clientIp,label,requests,promptTokens,completionTokens,totalTokens,lastSeen} ]
 *          }
 */
export function aggregateByCanonicalModel(allModelUsers, registry) {
  const byModel = new Map();

  for (const [modelName, data] of Object.entries(allModelUsers || {})) {
    const canon = canonicalModel(modelName, registry);
    if (!byModel.has(canon)) {
      byModel.set(canon, {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        lastSeen: 0,
        users: new Map(),
      });
    }
    const agg = byModel.get(canon);
    agg.requests += data.totalRequests || 0;
    agg.totalTokens += data.totalTokens || 0;

    for (const user of data.users || []) {
      if (!agg.users.has(user.label)) {
        agg.users.set(user.label, {
          clientIp: user.clientIp || "",
          label: user.label || user.clientIp || "unknown",
          apiKeyPrefix: user.apiKeyPrefix || null,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          lastSeen: 0,
        });
      }
      const u = agg.users.get(user.label);
      u.requests += user.requests || 0;
      u.promptTokens += user.promptTokens || 0;
      u.completionTokens += user.completionTokens || 0;
      u.totalTokens += user.totalTokens || 0;
      u.lastSeen = Math.max(u.lastSeen || 0, user.lastSeen || 0);
      if (user.apiKeyPrefix && !u.apiKeyPrefix) u.apiKeyPrefix = user.apiKeyPrefix;
    }
    agg.lastSeen = Math.max(agg.lastSeen, data.users?.reduce?.((m, u) => Math.max(m, u.lastSeen || 0), 0) || 0);
    // promptTokens are per-user; derive model-level from user aggregates
    for (const u of agg.users.values()) {
      agg.promptTokens += u.promptTokens;
      agg.completionTokens += u.completionTokens;
    }
  }

  // Materialize users as sorted arrays, drop the Map key
  const out = new Map();
  for (const [id, agg] of byModel) {
    const users = [...agg.users.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    out.set(id, {
      requests: agg.requests,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      totalTokens: agg.totalTokens || agg.promptTokens + agg.completionTokens,
      lastSeen: agg.lastSeen,
      users,
    });
  }
  return out;
}

/**
 * Serialize aggregateByCanonicalModel into a plain object keyed by model id
 * (matches the shape the Model Usage History table expects).
 * @returns {Record<string, object>}
 */
export function perModelUsageObject(allModelUsers, registry) {
  const m = aggregateByCanonicalModel(allModelUsers, registry);
  return Object.fromEntries(m);
}
