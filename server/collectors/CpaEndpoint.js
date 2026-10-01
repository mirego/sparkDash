/**
 * Shared CPA endpoint constants (d-002).
 *
 * Single source of truth for the CPA proxy binding used by both agent-config
 * export endpoints (opencode: t_d1202a53, pi-mono: t_ab1321df) — the hotspot
 * flagged during review of the integration (t_deb15127). The collector
 * modules re-export these so their existing import surfaces stay stable.
 */

/** CPA proxy port — server-resolved constant per d-002. */
export const CPA_PORT = 8317;

/** Default CPA host: same-machine CLI use (d-002 trade-off note). */
export const DEFAULT_CPA_HOST = "127.0.0.1";
