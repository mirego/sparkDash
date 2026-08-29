# fleet_sync CPA Source-of-Truth Cutover — Runbook

> **Status:** PLAN (no execution) · **Date:** 2026-08-02 · **Owner:** Gilfoyle (op) / Hermes
> **Context record:** kanban task `t_55fdb4b9` closed `done` with `fleet_sync_source_of_truth` explicitly deferred.
> **Grounding:** traced live `switch-model.sh`, `sync-live-models.py`, `fleet_sync.py`, `least-queue-proxy.py`, `auth-proxy.py`, `config.yaml`, `fleet-models.yaml`.

---

## Goal

Make `fleet-models.yaml` (via `fleet_sync.py`) the **single generator** of CPA's
`openai-compatibility` providers — replacing probe-driven `sync-live-models.py` —
**without changing the currently-working routing** (`deepseek-v4-flash-0731` -> `:8888`),
and with a **verified backout at every phase**.

## Current architecture (unchanged since deploy)

```
client -> :8317 auth-proxy.py  (X-User inject) -> :8318 cli-proxy-api (CPA, routes by provider)
        -> :8888 vLLM deepseek (TP=2 spans anton + son-of-anton)
```
- **CPA entry :8317** stays the door. The cutover only changes *which generator writes config.yaml*.
- Live CPA config has **1 provider**: `live-deepseek-v4-flash-0731-127.0.0.1-8888 -> :8888`.
- `cliproxy-live-models.service` (PID 2475) rewrites config.yaml every **15s** — this is the generator we replace.
- `least-queue-proxy.service` (:8320) is **down** (inactive since Jul 31). Co-located engines :8891/:8892/:8893 **down**.
- `fleet_sync --mode check` currently reports `providers_differ_from_config: true` (expected pre-cutover).

## Why this is a coordinated cutover, not `--mode apply`

A blind `--apply` today would: (1) strip the only live deepseek provider and repoint the
default aliases at **down `:8320```` (least-q) and down `:8891/2/3` engines; (2) orphan
`switch-model.sh` (still hard-calls `sync-live-models.py`, zero `fleet_sync` refs); (3) write
a `least-queue.json`/`auth-capabilities.json` that no running process reads. This runbook
closes each of those gaps in order, gated, with backout.

---

## Phase 1 — Preflight + full backup (no behaviour change)

**Objective:** capture a bulletproof backout snapshot before any mutation.

**Commands (run on anton, prod):**
```bash
TS=$(date +%Y%m%d_%H%M%S); B=~/.cli-proxy-api/backups/cutover-$TS; mkdir -p $B
cp -a ~/.cli-proxy-api/config.yaml          $B/
cp -a ~/.cli-proxy-api/live-models-status.json $B/
cp -a /home/gilfoyle/cliproxyapi/sync-live-models.py   $B/
cp -a /home/gilfoyle/cliproxyapi/switch-model.sh      $B/
cp -a /home/gilfoyle/cliproxyapi/least-queue-proxy.py $B/
cp -a /home/gilfoyle/cliproxyapi/fleet-models.yaml    $B/
cp -a /home/gilfoyle/cliproxyapi/fleet_sync.py        $B/
tar czf $B/cpa-artifacts.tgz ~/.cli-proxy-api/least-queue.json ~/.cli-proxy-api/model-registry.json 2>/dev/null || true
echo $B > /tmp/fleet_cutover_backup.txt
echo "backup -> $B"
```

**Gates (all must hold):**
```bash
# live pipeline still healthy before we touch anything
curl -s -o /dev/null -w '8318 %{http_code}' http://127.0.0.1:8318/v1/models; echo
curl -s -o /dev/null -w '8888 %{http_code}' http://127.0.0.1:8888/v1/models; echo
python3 /home/gilfoyle/cliproxyapi/fleet_sync.py --mode check --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml
```
`--mode check` output must be **recorded** (expected `ok:false`, delta documented) — this is the
pre-cutover baseline we diff against.

**Rollback (Phase 1):** nothing mutated; backout = do nothing.

---

## Phase 2 — Code: make `switch-model.sh` registry-driven (the key change)

**Objective:** `switch-model.sh` (the tool behind sparkDash's "Switch Model") stops calling
`sync-live-models.py` and instead drives `fleet_sync` as the single generator.

**Files:**
- Modify: `/home/gilfoyle/cliproxyapi/switch-model.sh`
  - Replace the whole `force_sync()` fn (currently at lines ~636-650, calls `$SYNC_PY` =
    `sync-live-models.py` with `--endpoint :8888 / soa:8888 / :8000 / soa:8000`).
  - New `force_sync()`: backup config, run `fleet_sync --mode check` (gate), then
    `fleet_sync --mode apply --registry fleet-models.yaml`, then verify `:8318 /v1/models`.
  - Add a **working-set** argument so a switch only applies the models for that mode
    (e.g. `deepseek`, `laguna`, `qwen`) rather than the whole registry — reused for the
    engine bring-up phases below.
  - `LEASTQ_URL`/`start_least_queue()` stay (switch-model still starts the queue service).
- Modify: `/home/gilfoyle/cliproxyapi/fleet_sync.py`
  - **Fix the `least_queue_healthy` hardcode** at `do_apply(...)` call site (~line 403,
    currently `True`). Derive it from a real `--mode validate`/health probe of `:8320/healthz`
    so a down least-queue never gets written as healthy.
  - Add a **working-set filter** (e.g. `--only deepseek`) to `build_cpa_providers()` so
    `--apply` emits only the active models (deepseek now; adds laguna/qwen when engines are up).
  - (`auth-capabilities.json`/`least-queue.json` generation is fine to keep; see Phase 5/6.)

**Verify:**
```bash
python3 /home/gilfoyle/cliproxyapi/python3 -m unittest test_fleet   # 27/27 still
git -C /home/gilfoyle/cliproxyapi diff --stat                        # only the intended edits
bash -n /home/gilfoyle/cliproxyapi/switch-model.sh                  # syntax
# DRY-RUN the deepseek-only working set (does NOT touch live config):
python3 fleet_sync.py --mode dry-run --only deepseek --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml
# -> providers must contain ONLY deepseek, and its base-url must be :8888 (NOT :8320 unless queue is up)
```

**Gate before proceeding:** the dry-run deepseek provider set must be **routing-equivalent to today**
(deepseek -> :8888). No leastq :8320 provider unless the queue is actually healthy.

**Rollback (Phase 2):** restore `switch-model.sh` + `fleet_sync.py` from `$B` (backup);
`cliproxy-live-models.service` still running so no rift yet.

---

## Phase 3 — Generator cutover with zero routing change (THE cutover)

**Objective:** registry becomes source of truth; routing stays exactly as today.

**Steps (in order, gates between each):**
```bash
# 1. Stop the probe-driven generator (removes the 15s clobber)
systemctl --user stop cliproxy-live-models.service
systemctl --user disable cliproxy-live-models.service   # so it can't resurrect on boot

# 2. Golden gate — generated must match live (deepseek-only, :8888)
python3 fleet_sync.py --mode check --only deepseek --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml
# EXPECT: providers_differ_from_config: false  (if true, STOP — diff and reconcile before apply)

# 3. Apply
echo "OLD_CONFIG_BACKUP: $(cat /tmp/fleet_cutover_backup.txt)" # confirm backup path
timeout 60 python3 fleet_sync.py --mode apply --only deepseek --registry fleet-models.yaml --config ~/.cli-proxy-api/config.yaml

# 4. Verify routing end-to-end, exactly as today
curl -s -o /dev/null -w 'CPA 8318 : %{http_code}
' http://127.0.0.1:8318/v1/models
curl -s -o /dev/null -w 'deepseek :8888 : %{http_code}
' http://127.0.0.1:8888/v1/models
# smoke a real chat completion through the entry point with a valid key:
#   curl :8317/v1/chat/completions  (X-User via auth-proxy) -> must return deepseek completion
python3 -c "import yaml; c=yaml.safe_load(open('/home/gilfoyle/.cli-proxy-api/config.yaml')); print([p['name'] for p in c['openai-compatibility'] if isinstance(p,dict)])"
```

**Gate:** live smoke via `:8317` returns a completion for `deepseek-v4-flash-0731`; provider
list == deepseek only.

**Rollback (Phase 3) — the dangerous step, so it MUST be scripted first:**
```bash
cp ~/.cli-proxy-api/backups/cutover-*/config.yaml ~/.cli-proxy-api/config.yaml
systemctl --user start cliproxy-live-models.service
curl -s -o /dev/null -w '8318 %{http_code}
' http://127.0.0.1:8318/v1/models   # restore live smoke
```

---

## Phase 4 — Least-queue bring-up (optional, only if dual same-model desired)

**Objective:** make `:8320` least-queue real and fed by the registry, not CLI-args drift.

- Bring up `least-queue-proxy.service`; confirm `:8320/healthz` responds.
- **Wire `least-queue-proxy.py` to read the registry's generated `least-queue.json`** (currently
  it takes backends via argparse in `switch-model.sh`) so queue config is registry-derived.
- Only then register leastq providers for models that actually have >1 live backend.

**Gate:** `:8320/healthz` 200 AND a test request routes to the least-loaded backend.
**Note:** deepseek is **TP=2 (single instance spanning both nodes)** — a least-queue across the two
`:8888`s is load-balancing the *same* TP=2 model, not two independent replicas. Confirm that's
actually wanted before adding deepseek to a leastq pool; otherwise keep deepseek pinned to :8888.

---

## Phase 5 — Co-located engines bring-up (laguna / qwen)

**Objective:** add the other models as live backends, then widen the working set.

- Bring up laguna on :8891 (both nodes if replicas=2), qwen-q8 :8892, qwen-nvfp4 :8893.
- `fleet_sync --mode validate --registry fleet-models.yaml` — all live model backends healthy.
- Re-run `--mode apply` **without** `--only` (full working set) once engines are up.

**Gate:** regenerated providers list laguna/qwen **and** their health probes pass (no dead endpoints registered).

**Rollback:** same as Phase 3 rollback + stop any half-started engine processes.

---

## Phase 6 — Capability aliases + feature flag (out of scope for cutover — flagged)

- **Capability aliases** (`default`, `long-context`): `model_resolver` and
  `auth-capabilities.json` are generated but **auth-proxy does not read them**. Exposing
  capability routing to users is a **separate feature** (wire auth-proxy or CPA to consume the
  resolver + health) — NOT part of making CPA registry-driven. Deferred.
- **ModelFleetPanel `enabled={true}`** (`src/components/OverviewPage/OverviewPage.tsx:603`):
  currently hardcoded on and already deployed live in Phase-0 Step-1. If you want it rank-gated,
  move to `config/settings.json` — small, separate change.

---

## Decisions needed from operator before/during execution

1. **Working set for first cutover:** deepseek-only is the zero-risk default. Accept?
2. **Least-queue:** bring up `:8320` now, and do you actually want deepseek load-balanced (it's TP=2)
   or keep it pinned? Laguna/qwen co-located engines are the natural leastq targets later.
3. **`switch-model.sh` rewrite / fleet_sync edits** require committing to `~/cliproxyapi`
   (a non-git dir? verify) — confirm we can edit + back it up there.
4. **Feature flag:** leave panel on (already live) or gate via settings?

## Open risks

- **`sync-live-models.py` still referenced** by anything else (cron, dashboard endpoint)?
  Grep confirm before disabling the service.
- **CPA hot-reload vs restart:** does CPA pick up config.yaml edits live or need a restart?
  Confirm before Phase 3 (a restart is fine at a maintenance window; must be noted in rollback).
- **`--only` working-set filter** is a new fleet_sync capability — must be added + tested (Phase 2)
  before it's relied on in Phase 3.

## Rollback summary (keep visible during execution)

| Phase | Backout |
|---|---|
| 1 | nothing mutated |
| 2 | restore switch-model.sh + fleet_sync.py from backup |
| 3 | restore config.yaml + re-enable cliproxy-live-models.service |
| 4 | stop least-queue-proxy.service |
| 5 | stop new engines + restore config.yaml |
| 6 | revert settings/code change |

## Files that change (full inventory)
- `/home/gilfoyle/cliproxyapi/switch-model.sh` (force_sync + working-set arg)
- `/home/gilfoyle/cliproxyapi/fleet_sync.py` (leastq-health fix + `--only` filter)
- `/home/gilfoyle/cliproxyapi/least-queue-proxy.py` (Phase 4: read least-queue.json)
- `/home/gilfoyle/cliproxyapi/fleet-models.yaml` (working-set curation as needed)
- `~/.cli-proxy-api/config.yaml` (Phase 3 apply — backed up first)
