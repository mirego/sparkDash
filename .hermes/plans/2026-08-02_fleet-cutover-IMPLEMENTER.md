# fleet_sync → CPA Source-of-Truth Cutover — IMPLEMENTER RUNBOOK

> **Handoff doc — self-contained.** Follow top-to-bottom on the target host.
> Created 2026-08-02. Owner: Gilfoyle. Underlying kanban task `t_55fdb4b9` is **done**;
> this runbook executes the deferred `fleet_sync_source_of_truth` item.
>
> **You are a separate implementer with NO prior conversation context.** Everything you need
> is here: architecture, decisions, prerequisites, exact commands, gates, verification, rollback.
> If a gate fails, **STOP and back out** per the phase's rollback — do not push through.

---

## 0. Goal & Architecture

Make `fleet-models.yaml` (via `fleet_sync.py`) the **single generator** of CLIProxyAPI's
provider list, replacing the probe-driven `sync-live-models.py`, WITHOUT breaking current
routing (`deepseek-v4-flash-0731` stays reachable through the entry point), and with a
**version-controlled, scripted backout at every phase.**

**Target topology (after all phases):**
```
client -> :8317 auth-proxy.py (X-User inject) -> :8318 cli-proxy-api (CPA, routes by provider)
        -> :8320 least-queue-proxy (ALWAYS up, ALWAYS in path) -> model backends
        ->    :8888 vLLM deepseek (TP=2 spans anton + son-of-anton)
        ->    :8891 laguna   (Phase 5)  :8892 qwen-q8 (Phase 5)  :8893 qwen-nvfp4 (Phase 5)
```

**Key decision (operator):** the least-queue `:8320` is a **permanent component** — it must be
**up at all times** and **every model request passes through it**, even when a model runs on a
single node or is a single TP=2 instance spanning two nodes. It is NOT an optional "only for
dual-same-model" balancer.

### Terminology (to avoid confusion)
- **Working set** = the set of models actually being served through CPA at a given time.
  Today only **deepseek** is live (laguna/qwen engines are not running yet). The first cutover
  therefore serves deepseek; laguna/qwen are added in **Phase 5** once their engines are brought up.
  This is sequencing, not a permanent restriction.
- **Source of truth** = whichever file CPA's provider list is *generated from*. We switch it from
  live probing (`sync-live-models.py`) to the declarative registry (`fleet-models.yaml`).

---

## 1. Operator Decisions (already made — do NOT revisit)

| # | Decision | Consequence for implementation |
|---|---|---|
| 1 | Deepseek is the starting working set | First `apply` emits deepseek only; laguna/qwen added in Phase 5 |
| 2 | **Least-queue `:8320` always up, always in path** | Bring `:8320` up in Phase 3 (BEFORE cutover); CPA providers point at `:8320`, never directly at a backend for the active set |
| 3 | `cliproxyapi` is **not under git** — create a local repo | Phase 1: `git init` + baseline commit before any edit |
| 4 | **CPA restart is fine** | Do the cutover apply + CPA restart in a maintenance window |

---

## 2. Prerequisites / Assumptions

- Target host: **anton** (DGX Spark), Linux systemd user session. Commands marked `[HOST]` run
  on anton itself; `[REMOTE]` may be run over SSH from your workstation.
- Reachability on anton (check first):
  ```bash
  [REMOTE] ssh gilfoyle@<anton> 'ss -ltnp | grep -E ":(8317|8318|8320|8888)\b"'
  [HOST]   for u in 8317 8318 8320 8888; do echo -n "$u "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$u/; done
  ```
- Current expected state: `:8317` (auth-proxy) & `:8318` (CPA) up; `:8320` **down**;
  `:8888` up (deepseek).
- `python3` with `yaml` available on anton (already used by fleet_sync).
- Docker available on anton (for sparkDash, if frontend pieces need rebuilds).

---

## 3. PHASE 1 — Baseline backup + git init (NO behaviour change)

**Objective:** bulletproof, version-controlled backout snapshot.

```bash
[REMOTE] ssh gilfoyle@<anton> '
TS=$(date +%Y%m%d_%H%M%S); B=~/.cli-proxy-api/backups/cutover-$TS; mkdir -p $B; echo $B > /tmp/fleet_cutover_backup.txt
cp -a ~/.cli-proxy-api/config.yaml $B/
cp -a ~/.cli-proxy-api/live-models-status.json $B/
cp -a ~/.cli-proxy-api/least-queue.json $B/ 2>/dev/null || true
cp -a ~/.cli-proxy-api/model-registry.json $B/ 2>/dev/null || true
cp -a /home/gilfoyle/cliproxyapi/*.py   $B/
cp -a /home/gilfoyle/cliproxyapi/*.sh   $B/
cp -a /home/gilfoyle/cliproxyapi/fleet-models.yaml $B/
echo "BACKUP_DIR=$B"
'
```

**Create a local git repo for `cliproxyapi` (baseline commit first):**
```bash
[REMOTE] ssh gilfoyle@<anton> '
cd /home/gilfoyle/cliproxyapi
git init 2>/dev/null
git add -A
git -c user.name="gilfoyle" -c user.email="gilfoyle@local" \
  commit -m "baseline before fleet cutover"
git log --oneline -1
'
```
> Note: this repo holds config generators. Exclude obvious secrets if present via `.gitignore`
> (e.g. `*.sock`, `*.key`) — but `config.yaml` is under `~/.cli-proxy-api/`, NOT here, so it
> stays out of VCS, which is correct.

**Gate (all must hold):** record the pre-cutover baseline and confirm live health:
```bash
[HOST] python3 /home/gilfoyle/cliproxyapi/fleet_sync.py --mode check \
        --registry /home/gilfoyle/cliproxyapi/fleet-models.yaml \
        --config ~/.cli-proxy-api/config.yaml
      # Record FULL JSON. Expect ok:false + providers_differ_from_config:true (pre-cutover).
[HOST] curl -s -o /dev/null -w "CPA 8318: %{http_code}\n" http://127.0.0.1:8318/v1/models
[HOST] curl -s -o /dev/null -w "deepseek 8888: %{http_code}\n" http://127.0.0.1:8888/v1/models
```
**Rollback:** nothing mutated → do nothing.

---

## 4. PHASE 2 — Code changes (version-controlled)

**Objective:** give `fleet_sync` fix + a working-set filter, and rewire `switch-model.sh` to it.
Commit each edit.

### 4.1 `fleet_sync.py` — fix least-queue health hardcode + add `--only`

- Locate the `do_apply(...)` call site (approx line ~403). It currently passes
  `least_queue_healthy=True` hardcoded. **Replace** with a real probe of `http://127.0.0.1:8320/healthz`
  (or the health of the active backends) so a down least-queue is never written as healthy.
  - Implication of Decision #2: `:8320` will be up by Phase 3, so `least_queue_healthy` will be
    true at cutover; the fix just prevents silent mis-marking if it ever drops.
- Add a **working-set filter** argument to `build_cpa_providers()` and the `--mode apply`/`dry-run`
  paths, e.g. `--only deepseek,laguna`. When set, only those model ids are emitted as providers.
  When unset (Phase 5+), the full registry is emitted.

**Verify (no live effect):**
```bash
[HOST] cd /home/gilfoyle/cliproxyapi
python3 -m unittest test_fleet                    # 27/27
python3 fleet_sync.py --mode dry-run --only deepseek \
        --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml
      # EXPECT: providers contain ONLY deepseek; base-url is http://127.0.0.1:8320/v1 (the least-queue)
      #   plus 0 or more deepseek pin variants. NO laguna/qwen. NO dead :8891/2/3 endpoints.
```
**Gate:** dry-run is deepseek-only and points at `:8320`. If it still emits laguna/qwen or dead
endpoints, fix the filter before continuing.

**Commit:**
```bash
[HOST] cd /home/gilfoyle/cliproxyapi && git add -A && git commit -m "fleet_sync: leastq-health probe + --only working-set filter"
```

### 4.2 `switch-model.sh` — drive fleet_sync instead of sync-live-models

- Locate `force_sync()` (approx lines 636-650). It currently calls `$SYNC_PY`
  (`sync-live-models.py`) with `--endpoint :8888 / soa:8888 / :8000 / soa:8000`.
  - **Replace** the body: backup `config.yaml`, run `fleet_sync --mode check` (abort on diff),
    then `fleet_sync --mode apply --only <working-set-for-this-mode>` (e.g. `deepseek`,
    `laguna`, `qwen`), then verify `:8318 /v1/models`.
  - Keep `start_least_queue()` / `LEASTQ_URL` (switch-model still ensures `:8320` service is up).
  - Because Decision #2 makes least-queue always-in-path, the generated provider for the active
    model MUST point at `:8320` (fleet_sync already does this when `least_queue_healthy`).
- Update the `SYNC_PY` reference / comments so no path calls `sync-live-models.py` for a live write.

**Verify:**
```bash
[HOST] bash -n /home/gilfoyle/cliproxyapi/switch-model.sh   # syntax ok
[HOST] grep -nE 'fleet_sync|sync-live-models' /home/gilfoyle/cliproxyapi/switch-model.sh
      # EXPECT: fleet_sync present; sync-live-models only in a comment/history note, not invoked
```
**Commit:**
```bash
[HOST] cd /home/gilfoyle/cliproxyapi && git add -A && git commit -m "switch-model: generate from fleet_sync registry"
```

**Rollback (Phase 2):** `git checkout <baseline-commit> -- .` (both files) — no live config touched yet.

---

## 5. PHASE 3 — Least-queue bring-up (`:8320` permanent)

**Objective:** make `:8320` a permanent, always-running, always-in-path component.

1. **Wire `least-queue-proxy.py` to read the registry's `least-queue.json`** so its backend list is
   registry-derived (it currently reads backends from CLI args set by `switch-model.sh`).
   Fall back to CLI args if the file is absent, so nothing else breaks.
```bash
[HOST] cd /home/gilfoyle/cliproxyapi && git add -A && git commit -m "least-queue: read registry least-queue.json"
```
2. **Start + enable. Verify it is up and stays up:**
```bash
[HOST] systemctl --user enable --now least-queue-proxy.service
[HOST] sleep 3
[HOST] curl -s -o /dev/null -w "leastq /healthz: %{http_code}\n" http://127.0.0.1:8320/healthz
[HOST] systemctl --user is-enabled least-queue-proxy.service   # enabled (survives boot)
```
3. **Confirm it routes to the live deepseek backend(s):**
```bash
[HOST] grep -o '"backends":[^]]*]' ~/.cli-proxy-api/least-queue.json   # expect :8888 (anton) [+ son-of-anton :8888]
[HOST] curl -s -o /dev/null -w "leastq->8888: %{http_code}\n" http://127.0.0.1:8320/v1/models
```

**Gate:** `:8320/healthz` 200 AND `:8320/v1/models` proxies to deepseek successfully AND service is enabled.

**Rollback:** `systemctl --user disable --now least-queue-proxy.service` + `git checkout baseline -- least-queue-proxy.py`.

---

## 6. PHASE 4 — Generator cutover + CPA restart (THE cutover) — MAINTENANCE WINDOW

**Objective:** registry becomes the generator; routing stays reachable THROUGH `:8320`.

```bash
[HOST] echo "backup: $(cat /tmp/fleet_cutover_backup.txt)"   # confirm Phase-1 backup path

# 1. Stop the probe-driven generator (kills the 15s rewrite loop)
systemctl --user disable --now cliproxy-live-models.service

# 2. Golden gate — generated (deepseek -> :8320) must equal what's live once queue is up
python3 /home/gilfoyle/cliproxyapi/fleet_sync.py --mode check \
        --only deepseek --registry /home/gilfoyle/cliproxyapi/fleet-models.yaml \
        --config ~/.cli-proxy-api/config.yaml
# EXPECT providers_differ_from_config: false  (after --only deepseek + :8320 up).
# If TRUE: STOP. Reconcile the delta, do NOT force apply.

# 3. Apply (writes config.yaml providers = deepseek via :8320)
timeout 60 python3 /home/gilfoyle/cliproxyapi/fleet_sync.py --mode apply \
        --only deepseek --registry /home/gilfoyle/cliproxyapi/fleet-models.yaml \
        --config ~/.cli-proxy-api/config.yaml

# 4. Restart CPA to load the new provider list (Decision #4)
systemctl --user restart cli-proxy-api.service
sleep 4

# 5. Live smoke THROUGH THE ENTRY POINT
echo -n "8318 /v1/models: "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8318/v1/models
echo -n "8317 (auth-proxy) models: "; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8317/v1/models
# One real chat completion via :8317 with a valid key — MUST return a deepseek completion:
#   curl http://127.0.0.1:8317/v1/chat/completions -H "Authorization: Bearer <VALID_KEY>" \
#        -H 'Content-Type: application/json' \
#        -d '{"model":"deepseek-v4-flash-0731","messages":[{"role":"user","content":"hi"}]}'
```

**Gate:** real completion via `:8317`; provider list = deepseek only; all of `:8317/:8318/:8320/:8888` 200.

**Rollback (Phase 4 — SCRIPT FIRST, then run):**
```bash
[HOST] cat > /tmp/cutover-rollback.sh <<'EOF'
#!/bin/bash
set -e
B=$(cat /tmp/fleet_cutover_backup.txt)
cp -a "$B/config.yaml" ~/.cli-proxy-api/config.yaml
systemctl --user enable --now cliproxy-live-models.service
systemctl --user restart cli-proxy-api.service
sleep 3
curl -s -o /dev/null -w '8318 restored: %{http_code}\n' http://127.0.0.1:8318/v1/models
EOF
chmod +x /tmp/cutover-rollback.sh
# Run ONLY if a gate above fails. Keeps config restore + re-enables the old generator + restarts CPA.
```

---

## 7. PHASE 5 — Add co-located engines (laguna / qwen), widen working set

**Objective:** bring up the other models, then drop `--only` so the full registry is served.

1. Bring up engine processes:
   - laguna (NVFP4 vLLM) on `:8891` (replicas=2 per `fleet-models.yaml`)
   - qwen3.6-35b-a3b-q8 (llama.cpp) on `:8892`
   - qwen3.6-35b-a3b-nvfp4 (vLLM) on `:8893`
2. Validate all live backends before registering them as CPA providers:
   ```bash
   [HOST] python3 /home/gilfoyle/cliproxyapi/fleet_sync.py --mode validate \
           --registry /home/gilfoyle/cliproxyapi/fleet-models.yaml
   ```
3. Re-apply with the **full** working set (no `--only`):
   ```bash
   [HOST] python3 fleet_sync.py --mode apply --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml
   [HOST] systemctl --user restart cli-proxy-api.service; sleep 4
   ```
4. Verify each model id/alias resolves `:8317/v1/models` and returns a completion (smoke each).

**Gate:** no provider points at a dead endpoint; every advertised model passes a real completion.
**Rollback:** stop newly-started engines + Phase-4 rollback script (restores deepseek-only config).

---

## 8. PHASE 6 — Cleanup & out-of-scope notes

- Remove/disable leftover `sync-live-models.py` references across the stack (grep first):
  ```bash
  [HOST] grep -rln 'sync-live-models' /home/gilfoyle/cliproxyapi /home/gilfoyle/.config/systemd/user 2>/dev/null
  ```
  Keep the historical file for reference but ensure nothing invokes it for live writes.
- **Out of scope (separate work, flagged, NOT part of this cutover):**
  - **Capability aliases** (`default`, `long-context`): `model_resolver` + `auth-capabilities.json`
    are generated, but `auth-proxy.py` does not read them yet. Wiring capability routing is a
    separate feature.
  - **ModelFleetPanel feature flag**: hardcoded `enabled={true}` at
    `sparkDash/src/components/OverviewPage/OverviewPage.tsx:603`, already deployed. Moving it to
    config is a small separate change if you want it rank-gated.

---

## 9. Full file inventory

| File | Change | Phase |
|---|---|---|
| `~/cliproxyapi/fleet_sync.py` | leastq-health probe + `--only` filter | 2 |
| `~/cliproxyapi/switch-model.sh` | `force_sync()` → fleet_sync; working-set arg | 2 |
| `~/cliproxyapi/least-queue-proxy.py` | read registry `least-queue.json` | 3 |
| `~/cliproxyapi/fleet-models.yaml` | working-set curation (as needed) | 5 |
| `~/.cli-proxy-api/config.yaml` | providers rewritten by apply | 4 (backed up Phase 1) |
| `~/.cli-proxy-api/least-queue.json` | regenerated | 3 |
| `~/cliproxyapi/` | **new local git repo** (baseline commit Phase 1) | 1 |

## 10. Rollback cheatsheet

| Phase | Backout |
|---|---|
| 1 | nothing mutated |
| 2 | `git checkout <baseline> -- fleet_sync.py switch-model.sh` |
| 3 | `systemctl --user disable --now least-queue-proxy.service` + git revert least-queue-proxy.py |
| 4 | `/tmp/cutover-rollback.sh` (restore config + re-enable old generator + restart CPA) |
| 5 | stop new engines + run Phase-4 rollback |
| 6 | revert cleanup / no-op |

## 11. Open items the implementer must confirm before Phase 4

1. **CPA hot-reload** — the plan restarts CPA (Decision #4); confirm the restart is the only
   mechanism CPA uses to pick up config.yaml (i.e. no live-read path that could half-load).
2. **deepseek TP=2 via least-queue** — deepseek is ONE instance spanning both nodes on `:8888`.
   Per Decision #2 it still passes through `:8320`. Confirm least-queue-proxy's single-backend
   passthrough behaves transparently (no queue reordering that breaks TP consistency).
3. **Working set naming** — confirm `switch-model.sh`'s per-mode working-set ids match the
   registry ids (`deepseek`, `laguna-s-2.1`, `qwen3.6-35b-a3b-q8`, `qwen3.6-35b-a3b-nvfp4`).
