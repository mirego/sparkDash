/**
 * Host used for LLM HTTP (probe, Showcase, DecodeBench, connectivity test).
 *
 * Resolution order:
 *   1. `spark.llmHost` — explicit per-Spark override (e.g. a custom gateway
 *      host or a reachable LAN address that differs from the LAN IP), used
 *      verbatim when set (including "127.0.0.1" for local loopback bind).
 *   2. Local Sparks probe loopback: engines like ds4-server (Entrpi/ds4-on-spark
 *      via ~/models/ds4f/start.sh) default to `--host 127.0.0.1`, so probing the
 *      LAN IP would miss them.
 *   3. Remote Sparks use `lanIp` (they must bind a reachable interface or sit
 *      behind a tunnel).
 *
 * Requires the dashboard process to share the host network namespace when
 * running in Docker (see docker-compose `network_mode: host`).
 *
 * @param {{ isLocal?: boolean, lanIp?: string, llmHost?: string | null } | null | undefined} spark
 * @returns {string}
 */
export function llmProbeHost(spark) {
  if (spark?.llmHost) return String(spark.llmHost).trim();
  if (spark?.isLocal) return "127.0.0.1";
  const ip = spark?.lanIp != null ? String(spark.lanIp).trim() : "";
  return ip;
}
