#!/usr/bin/env bash
# Isolated E2E stack for tests/request-activity.e2e.ts (t_98955a1d): fake /inflight + sparkDash branch server.
# Nothing here touches the production server (:5555), its config, or the live proxy (:8317).
set -euo pipefail
WT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="${E2E_DIR:?set E2E_DIR to a scratch directory outside the repo}"
mkdir -p "$E2E/config"
cat > "$E2E/config/sparks.json" <<'JSON'
{ "sparks": [
  { "id": "anton", "name": "Anton", "kind": "spark", "platform": "linux", "lanIp": "192.0.2.10",
    "isLocal": false, "ssh": { "host": "192.0.2.10", "user": "e2e", "auth": "key", "port": 22 },
    "llmPorts": [8888], "role": "standalone", "llmMonitoring": false },
  { "id": "son-of-anton", "name": "Son of Anton", "kind": "spark", "platform": "linux", "lanIp": "192.0.2.11",
    "isLocal": false, "ssh": { "host": "192.0.2.11", "user": "e2e", "auth": "key", "port": 22 },
    "llmPorts": [8888], "role": "standalone", "llmMonitoring": false }
] }
JSON
# Seed one ordinary (non-request) event so the E2E can prove existing rows stay.
cat > "$E2E/config/events.json" <<JSON
{ "nextId": 2, "events": [ { "id": 1, "ts": $(($(date +%s) * 1000 - 600000)), "type": "spark.online", "severity": "info",
  "sparkId": "anton", "sparkName": "Anton", "message": "Anton came online" } ] }
JSON
rm -f "$E2E/config/request-lifecycle.json"

export SPARKS_JSON_PATH="$E2E/config/sparks.json"
export SETTINGS_JSON_PATH="$E2E/config/settings.json"
export EVENTS_JSON_PATH="$E2E/config/events.json"
export REQUEST_LIFECYCLE_PATH="$E2E/config/request-lifecycle.json"
export SPARKS_SECRETS_PATH="$E2E/config/sparks-secrets.json"
export SECRETS_KEY_PATH="$E2E/config/.secrets-key"
export TOKEN_LIFETIMES_PATH="$E2E/config/token-lifetimes.json"
export GPU_HISTORY_JSON_PATH="$E2E/config/gpu-history.json"
export GPU_HISTORY_LONG_JSON_PATH="$E2E/config/gpu-history-long.json"
export FLEET_ENERGY_JSON_PATH="$E2E/config/fleet-energy.json"
export FLEET_ENERGY_MONTHLY_JSON_PATH="$E2E/config/fleet-energy-monthly.json"
export ALERTS_JSON_PATH="$E2E/config/alerts.json"
export LLM_TOKEN_JSON_PATH="$E2E/config/llm-token-totals.json"
export LLM_DAILY_JSON_PATH="$E2E/config/llm-daily.json"
export PER_KEY_USAGE_PATH="$E2E/config/per-key-usage.json"
export AUTH_PROXY_INFLIGHT_URL="http://127.0.0.1:18317/inflight"
export PORT=5611 BIND_HOST=127.0.0.1

FAKE_INFLIGHT_PORT=18317 node "$WT/tests/fixtures/fake-inflight.mjs" > "$E2E/fake-inflight.log" 2>&1 &
echo $! > "$E2E/fake.pid"
cd "$WT"
exec node server/index.js > "$E2E/server.log" 2>&1
