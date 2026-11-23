import { requestBelongsToSpark, resolveInflightSparkId } from "./inflightSpark.js";

const REQUEST_FIELDS = [
  "id",
  "model",
  "state",
  "promptEstTokens",
  "promptSource",
  "maxTokens",
  "completionEstTokens",
  "completionSource",
  "ageSec",
  "idleSec",
  "ttftSec",
];

/**
 * Reduce proxy requests to the safe, per-Spark open-request snapshot contract.
 * Request fields are explicitly copied so proxy metadata can never leak through.
 */
export function buildOpenRequestsForSpark(flat, source, sparkId) {
  const status = source?.status === "unavailable"
    ? "unavailable"
    : source?.status === "legacy"
      ? "legacy"
      : "ok";
  const result = {
    status,
    fetchedAt: source?.fetchedAt ?? null,
    generatedAt: source?.generatedAt ?? null,
    schemaVersion: source?.schemaVersion ?? null,
    requests: [],
    unattributedCount: 0,
  };
  if (status === "unavailable") return result;

  const requests = Array.isArray(flat) ? flat : [];
  const seen = new Set();
  const unique = [];
  for (const request of requests) {
    if (!request || typeof request !== "object" || request.id == null) continue;
    const id = String(request.id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push({ ...request, id });
  }

  result.unattributedCount = unique.filter((request) =>
    !resolveInflightSparkId(request),
  ).length;
  result.requests = unique
    .filter((request) => requestBelongsToSpark(request, sparkId))
    .map((request) => {
      const row = {};
      for (const field of REQUEST_FIELDS) {
        if (field === "id") row.id = request.id;
        else if (Object.hasOwn(request, field)) row[field] = request[field];
      }
      row.label = request.user == null ? "" : String(request.user);
      return row;
    })
    .sort((a, b) => (Number(b.ageSec) || 0) - (Number(a.ageSec) || 0));
  return result;
}

