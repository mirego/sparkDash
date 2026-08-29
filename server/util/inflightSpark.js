/**
 * inflightSpark — pure helper to attribute an auth-proxy /inflight request
 * to a SparkRegistry node.
 *
 * The auth-proxy reports one flat in-flight list for the whole fleet. Requests
 * may carry a `sparkId` (from a least-queue hop / pin), a `backend`, and/or the
 * `model` name. When no explicit spark pin exists we fall back to sniffing the
 * backend/model string so we never hide an active request from the per-Spark
 * pills purely because the proxy didn't stamp a node on it.
 *
 * Pure (no I/O, no network) so it is trivially unit-testable.
 */

const SON_OF_ANTON_MARKERS = ["son-of-anton", "@b:", "192.168.100.11"];
const ANTON_MARKERS = ["@a:", "127.0.0.1"];
// Head-only working sets: no least-queue hop. `gilfoyle-current-model` is the
// special alias every live request is sent under via the served-model key, so
// it must resolve to the head spark (`anton`) or active pills vanish.
const HEAD_ONLY_MARKERS = ["deepseek", "dspark", "inkling", "gilfoyle-current-model"];

/**
 * Map /inflight sparkId (or backend / model pin) onto a SparkRegistry id.
 * @param {object|null} item  a /inflight user or per-request record
 * @returns {string|null} spark id (e.g. "anton") or null when un-attributable
 */
export function resolveInflightSparkId(item) {
  if (!item || typeof item !== "object") return null;
  if (item.sparkId) return String(item.sparkId);
  const blob = `${item.backend || ""} ${item.model || ""}`.toLowerCase();
  if (SON_OF_ANTON_MARKERS.some((m) => blob.includes(m))) return "son-of-anton";
  if (ANTON_MARKERS.some((m) => blob.includes(m))) return "anton";
  if (/anton(?:$|[^a-z0-9])/.test(blob)) return "anton";
  // Head-only working sets (DSpark / Inkling / served-model alias): no least-queue hop.
  if (HEAD_ONLY_MARKERS.some((m) => blob.includes(m))) return "anton";
  return null;
}

/**
 * True when a /inflight request/record belongs to the given spark.
 * @param {object} req
 * @param {string} sparkId
 * @returns {boolean}
 */
export function requestBelongsToSpark(req, sparkId) {
  const sid = resolveInflightSparkId(req);
  if (!sid) return false;
  return sid === sparkId;
}
