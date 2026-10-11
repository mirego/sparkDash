#!/usr/bin/env bash
# Post-deploy SSH smoke check for sparkDash (anton) — card t_4495562c.
#
# Why: the v2.0.1 rebuild recreated the container from a compose file set
# that omitted the SSH key mounts, and both Sparks went
# "Permission denied (publickey,password)" while the dashboard looked fine.
# This check makes that failure LOUD and immediately after deploy.
#
# What it asserts (against the RUNNING sparkDash container):
#   1. The SSH identity files exist inside the container
#      ($SSH_IDENTITY_FILE if set, else /root/.ssh/id_ed25519).
#   2. `ssh -o BatchMode=yes` reaches every spark in sparks.json that uses
#      SSH and is not local — a key-auth unit unreachable by BatchMode SSH
#      means the container has no (usable) identity, which is exactly the
#      regression this guards.
#
# Usage: scripts/post-deploy-verify.sh
# Env:   SPARKDASH_CONTAINER (default sparkDash)
#        SPARKS_JSON         (default /home/gilfoyle/sparkDash/config/sparks.json)
#        SSH_USER_OVERRIDE   (rarely needed; per-spark ssh.user is used by default)
# Exit:  0 = all sparks ssh-ok; 1 = any check failed (deploy must fail loudly).
set -euo pipefail

CONTAINER="${SPARKDASH_CONTAINER:-sparkDash}"
SPARKS_JSON="${SPARKS_JSON:-/home/gilfoyle/sparkDash/config/sparks.json}"

fail() { echo "post-deploy-verify: FAIL: $*" >&2; exit 1; }

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container '$CONTAINER' not running (is it up on :5588/:5555?)"

# --- 1. Identity present inside the container -------------------------------
if ! docker exec "$CONTAINER" sh -lc 'test -n "$SSH_IDENTITY_FILE" && f="$SSH_IDENTITY_FILE" || f="$HOME/.ssh/id_ed25519"; test -f "$f"' 2>/dev/null; then
  fail "no SSH identity file inside $CONTAINER — compose deploy dropped the key mounts (t_4495562c regression)"
fi
echo "post-deploy-verify: identity file present in container"

# --- 2. BatchMode SSH to every key-auth, non-local spark ---------------------
if [[ ! -f "$SPARKS_JSON" ]]; then
  fail "sparks registry not found at $SPARKS_JSON"
fi

FAILED=0
COUNT=0
# shellcheck disable=SC2002  # jq-free: parse with python3 (always present on anton)
while IFS=$'\t' read -r HOST PORT USER AUTH ISLOCAL ID; do
  [[ -z "${ID:-}" ]] && continue
  if [[ "$ISLOCAL" == "true" ]]; then
    echo "post-deploy-verify: skip $ID (isLocal)"
    continue
  fi
  if [[ "$AUTH" != "key" ]]; then
    echo "post-deploy-verify: skip $ID (ssh auth=$AUTH, not key)"
    continue
  fi
  COUNT=$((COUNT + 1))
  if docker exec "$CONTAINER" ssh -o BatchMode=yes -o ConnectTimeout=10 \
       -p "$PORT" "${USER}@${HOST}" 'echo ok' 2>/dev/null | grep -qx ok; then
    echo "post-deploy-verify: ssh OK  $ID (${USER}@${HOST}:${PORT})"
  else
    echo "post-deploy-verify: ssh FAIL $ID (${USER}@${HOST}:${PORT}) — BatchMode denied; container lost its key?" >&2
    FAILED=$((FAILED + 1))
  fi
done < <(python3 - "$SPARKS_JSON" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for s in data.get("sparks", []):
    ssh = s.get("ssh") or {}
    if not ssh.get("host"):
        continue
    print("\t".join([
        ssh.get("host", ""),
        str(ssh.get("port", 22)),
        ssh.get("user", ""),
        ssh.get("auth", ""),
        "true" if s.get("isLocal") else "false",
        s.get("id", ""),
    ]))
PY
)

if (( COUNT == 0 )); then
  echo "post-deploy-verify: no non-local key-auth sparks configured — mount check only (nothing to SSH to)"
elif (( FAILED > 0 )); then
  fail "$FAILED/$COUNT key-auth sparks unreachable via BatchMode SSH from $CONTAINER"
fi
echo "post-deploy-verify: ALL OK ($COUNT key-auth sparks reachable, identity mounted)"
