# GPU Energy Tracking Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Track each Spark's GPU power draw over time, integrate it into daily watt-hours (Wh), and show a pill next to the "online" chip displaying today's fleet-wide Wh consumed.

**Architecture:** A server-side `EnergyTracker` module integrates the already-collected `metrics.gpu.power.draw` (W) into per-calendar-day Wh, persisting to `config/gpu-wh.json` so totals survive restarts and accumulate even when no browser is open. The tracker is fed inside the existing `buildSnapshotPayload()` broadcast loop (runs every `pollIntervalMs` ≈ 2s regardless of WS clients). Today's per-spark Wh is attached to each snapshot and the frontend sums it into a pill in the Overview welcome row.

**Tech Stack:** Node.js ESM (node:test for server tests), React 19 + TS (vite/custom, no component lib), plain CSS.

---

## Current context / assumptions (verified)

- GPU power is already collected per Spark in `server/collectors/SystemCollector.js` (`_getGPUAll` → `power: { draw, limit, systemDraw }`), polled every `POLL_INTERVAL_GPU = 2000ms` by `SparkMonitor._pollDomain("gpu")` and cached in `_metrics.gpu`.
- It's exposed to the UI in the snapshot as `spark.metrics.gpu.power.draw` (W) — shown in `OverviewPage.tsx:368` as `GPU Power: {draw}W / {limit}W`.
- `buildSnapshotPayload()` (`server/index.js:1535`, already `async`) runs every `pollIntervalMs` (default 2000ms) via `startBroadcast()` **even with zero WS clients**, and is the right sampling driver.
- Persistence precedent exists: `config/token-lifetimes.json` (LlmProbe), `config/per-key-usage.json` (PerKeyUsageTracker) — both use tmp-file + atomic rename, debounced saves.
- Pill style precedent: `.online-chip` in `src/index.css:698`; rendered at `OverviewPage.tsx:501`.
- **Assumption:** DGX Spark (GB10) has a single GPU; `power.draw` is that GPU's total draw. `_parseGpuLine` already reads only the first line.
- **Assumption:** "today" = server-local calendar day (host is UTC−4). Server TZ is used for the date key.

---

## Design decisions

- **Accumulate server-side** (not in the client `metricsStore`) so daily totals are accurate, zero-loss, and independent of whether a browser tab is open — matching your accuracy requirements. Client history is capped at 1h and dies with the tab.
- **Track `power.draw` (GPU-only)** as requested ("the current GPU power"). `systemDraw` (GPU+CPU+~20W) is available and could be swapped later — see Open Questions.
- **Trapezoid integration:** increment uses the average of the previous and current power reading × elapsed hours, the standard for energy metering at 2s granularity.
- **Gap guard:** if more than `MAX_GAP_MS` (60s) elapsed since a spark's last sample (spark offline / paused / just booted), don't backfill — reseed from the current reading so a stale sample can't create a false mega-jump.
- **Per-spark daily buckets** so we can later show per-card values; the pill sums across all sparks.

---

## Data file shape — `config/gpu-wh.json`

```json
{
  "version": 1,
  "daily": {
    "2026-08-01": { "anton": 12.84, "son-of-anton": 15.11 },
    "2026-08-02": { "anton": 3.51 }
  }
}
```

Values are Wh (floats). Old days pruned to last 60 to bound the file.

---

## Task list

### Task 1: Create `EnergyTracker` module

**Objective:** Server-side Wh accumulator with disk persistence.

**Files:**
- Create: `server/collectors/EnergyTracker.js`
- Create (test): `server/collectors/__tests__/EnergyTracker.test.js`

**Step 1: Write failing test** (`node --test` style, matching existing tests)

```js
// __tests__/EnergyTracker.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _resetForTest, recordPower, getTodayWh, getTodayWhBySpark, _getDateKey,
} from "../EnergyTracker.js";

test("records Wh using trapezoid integration", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z
  // 100W for 2s (dt=0.0005556h) then 200W for 2s
  recordPower("a", 100, t0);
  recordPower("a", 100, t0 + 2000); // ~100W * 2s
  recordPower("a", 200, t0 + 4000); // ~150W * 2s
  const wh = getTodayWh(t0 + 4000);
  // (100*2 + 150*2) W*s / 3600 = 500/3600
  assert.ok(Math.abs(wh - 500 / 3600) < 0.001, `got ${wh}`);
});

test("does not backfill across a large gap", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0);
  // gap of 5 minutes (well over the 60s guard) at a high draw — must NOT count
  recordPower("a", 1000, t0 + 5 * 60_000);
  assert.equal(getTodayWh(t0 + 5 * 60_000), 0);
});

test("rolls daily bucket over midnight", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 23, 59, 58); // local-ish; see date key below
  recordPower("a", 100, t0);
  const day1Total = getTodayWh(t0);
  const day2Total = getTodayWh(t0 + 4000); // crossed into next day
  assert.ok(day1Total > 0);
  assert.ok(day2Total >= 0);
  assert.notEqual(_getDateKey(t0), _getDateKey(t0 + 4000));
});

test("zero/offline power does not accumulate", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 0, t0);
  recordPower("a", 0, t0 + 2000);
  assert.equal(getTodayWh(t0 + 2000), 0);
});

test("sums multiple sparks for the fleet pill", () => {
  _resetForTest();
  const t0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  recordPower("a", 100, t0); recordPower("a", 100, t0 + 2000);
  recordPower("b", 200, t0); recordPower("b", 200, t0 + 2000);
  assert.ok(Math.abs(getTodayWh(t0 + 2000) - (300 * 2) / 3600) < 0.001);
  assert.deepEqual(Object.keys(getTodayWhBySpark(t0 + 2000)), ["a", "b"]);
});
```

**Step 2: Run test, expect FAIL** — module missing.

**Step 3: Implement `EnergyTracker.js`**

```js
import fs from "fs";
import path from "path";
import { ROOT } from "../config.js";

const ENERGY_PATH =
  process.env.GPU_WH_PATH || path.join(ROOT, "config", "gpu-wh.json");
const MAX_GAP_MS = 60_000; // ignore gaps > 60s (offline/boot) — no backfill
const KEEP_DAYS = 60;
const SAVE_DEBOUNCE_MS = 30_000;

let _state = { version: 1, daily: {} };
let _last = new Map(); // sparkId -> { ts, drawW }
let _lastSave = 0;

/** Local calendar date key, e.g. "2026-08-01". */
export function _getDateKey(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  try {
    if (fs.existsSync(ENERGY_PATH)) {
      const p = JSON.parse(fs.readFileSync(ENERGY_PATH, "utf8"));
      if (p && typeof p.daily === "object") _state = p;
    }
  } catch { /* corrupt — start fresh */ }
}

function save() {
  try {
    const now = Date.now();
    if (now - _lastSave < SAVE_DEBOUNCE_MS) return;
    _lastSave = now;
    fs.mkdirSync(path.dirname(ENERGY_PATH), { recursive: true });
    fs.writeFileSync(ENERGY_PATH + ".tmp", JSON.stringify(_state, null, 2), "utf8");
    fs.renameSync(ENERGY_PATH + ".tmp", ENERGY_PATH);
  } catch (err) {
    console.error("[EnergyTracker] save failed:", err.message);
  }
}

function prune() {
  const keys = Object.keys(_state.daily).sort();
  if (keys.length > KEEP_DAYS) {
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete _state.daily[k];
  }
}

export function _resetForTest() {
  _state = { version: 1, daily: {} };
  _last = new Map();
  _lastSave = 0;
}

/**
 * Integrate a power sample (W) for a spark into today's Wh.
 * Uses trapezoid (avg of prev & current) × elapsed hours. Skips gaps > MAX_GAP_MS.
 */
export function recordPower(sparkId, drawW, nowMs = Date.now()) {
  if (!Number.isFinite(drawW) || drawW <= 0) return; // offline / no reading
  const prev = _last.get(sparkId);
  if (prev && nowMs - prev.ts <= MAX_GAP_MS) {
    const dtHours = (nowMs - prev.ts) / 3_600_000;
    const avgW = (prev.drawW + drawW) / 2;
    if (dtHours > 0) {
      const key = _getDateKey(nowMs);
      if (!_state.daily[key]) _state.daily[key] = {};
      _state.daily[key][sparkId] = (_state.daily[key][sparkId] || 0) + avgW * dtHours;
    }
  }
  _last.set(sparkId, { ts: nowMs, drawW });
  prune();
  save();
}

/** Total Wh across all sparks for the local calendar day of nowMs. */
export function getTodayWh(nowMs = Date.now()) {
  const bucket = _state.daily[_getDateKey(nowMs)] || {};
  return Object.values(bucket).reduce((s, v) => s + v, 0);
}

/** Per-spark Wh map for the local calendar day of nowMs. */
export function getTodayWhBySpark(nowMs = Date.now()) {
  return { ...(_state.daily[_getDateKey(nowMs)] || {}) };
}

load();
```

**Step 4: Run test, expect PASS.**

**Step 5: Commit**
```bash
git add server/collectors/EnergyTracker.js server/collectors/__tests__/EnergyTracker.test.js
git commit -m "feat: server-side GPU energy tracker (Wh/day, persisted)"
```

---

### Task 2: Feed the tracker and attach `energyTodayWh` to snapshots

**Objective:** Drive accumulation from the broadcast loop and expose today's Wh per spark.

**Files:**
- Modify: `server/index.js`
  - import `recordPower, getTodayWhBySpark` from `./collectors/EnergyTracker.js` (near the PerKeyUsageTracker import, ~line 15-27)
  - in `buildSnapshotPayload()` (line 1535), after `const sparks = orderedSnapshots();`
- Test: none needed (integration only) — covered by Task 3 typecheck + manual verify.

**Step 1: Add the import**

```js
import { recordPower, getTodayWhBySpark } from "./collectors/EnergyTracker.js";
```

**Step 2: In `buildSnapshotPayload`, after `const sparks = orderedSnapshots();` add:**

```js
// Feed GPU power into the energy tracker, then expose today's Wh per spark.
const nowIdx = Date.now();
const todayBySpark = getTodayWhBySpark(nowIdx);
for (const spark of sparks) {
  if (spark.online) {
    const draw = spark.metrics?.gpu?.power?.draw;
    if (typeof draw === "number") recordPower(spark.id, draw, nowIdx);
  }
  spark.energyTodayWh = todayBySpark[spark.id] || 0;
}
```

Placement note: this credit is captured **before** the `_lastBroadcastPayload` equality skip returns, so every broadcast tick accumulates energy even when the payload didn't change. The `nowIdx` is intentionally a single value so all sparks share one timestep.

**Step 3: Verify server starts & snapshot gains the field**

```bash
cd /home/gilfoyle/sparkDash && node --check server/index.js && npm run typecheck
```
Then restart the container and confirm a WS snapshot's `sparks[].energyTodayWh` exists after ~5s (nonzero as long as a machine reports GPU power > 0).

**Step 4: Commit**
```bash
git add server/index.js
git commit -m "feat: wire EnergyTracker into snapshot broadcasts"
```

---

### Task 3: Add `energyTodayWh` to the TS snapshot type

**Objective:** Keep the frontend type-safe.

**Files:**
- Modify: `src/api/types.ts` (add to `SparkSnapshot` interface)

**Step 1: Add field** (find the `SparkSnapshot` interface)

```ts
/** Today's GPU energy consumption for this spark, in Wh (server-accumulated). */
energyTodayWh?: number;
```

**Step 2: Verify**
```bash
npm run typecheck
```

**Step 3: Commit**
```bash
git add src/api/types.ts
git commit -m "feat: type energyTodayWh on SparkSnapshot"
```

---

### Task 4: Add `.energy-chip` pill style

**Objective:** Reuse the pill look from `.online-chip` with an energy accent.

**Files:**
- Modify: `src/index.css` (after the `.online-chip` block, ~line 717)

**Step 1: Add style**

```css
/* ─── Energy chip (overview welcome row) ─────────────── */
.energy-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: var(--color-surface-elevated);
  border-radius: 50px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-accent);
  box-shadow: var(--shadow-card);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.energy-chip .energy-ico {
  font-size: 12px;
  line-height: 1;
}
```

**Step 2: Verify build** — `npm run build` succeeds.

**Step 3: Commit**
```bash
git add src/index.css
git commit -m "feat: energy-chip pill style"
```

---

### Task 5: Render today's Wh pill in the Overview header

**Objective:** Show a "⚡ 1.24 kWh today" pill beside the online chip.

**Files:**
- Modify: `src/components/OverviewPage/OverviewPage.tsx`
  - compute `todayWh` from `visibleSparks`
  - render the pill next to `<span className="online-chip">` (line 501)
- Modify: `src/index.css` (helper, if a formatting function is too much) — keep to Task 4 style.

**Step 1: Add a formatter + sum** near `OverviewPage` component body (before the return, near `onlineCount` line 520):

```ts
const todayWh = visibleSparks.reduce((sum, s) => sum + (s.energyTodayWh ?? 0), 0);
const fmtWh = (wh: number): string =>
  wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
```

**Step 2: Render the pill** next to the online chip (line ~501):

```tsx
{todayWh > 0 && (
  <span className="energy-chip" title="GPU energy consumed today (all Sparks, server-accumulated)">
    <span className="energy-ico">⚡</span>
    {fmtWh(todayWh)} today
  </span>
)}
<span className="online-chip"><span className="dot" />{onlineCount}/{visibleSparks.length} online</span>
```

**Step 3: Verify**
```bash
npm run typecheck && npm test && npm run build
```

**Step 4: Commit**
```bash
git add src/components/OverviewPage/OverviewPage.tsx
git commit -m "feat: show today's GPU Wh pill in Overview header"
```

---

### Task 6: Deploy & verify live

**Objective:** Ship to the running container and confirm real values.

**Files:** none (deploy).

**Step 1:** Rebuild + copy frontend into the container (as done previously):
```bash
cd /home/gilfoyle/sparkDash && npm run build
docker exec sparkDash sh -c 'rm -rf /app/dist' && docker cp dist/. sparkDash:/app/dist/
docker restart sparkDash
```

**Step 2:** Verify:
- `docker logs sparkDash` clean startup.
- In browser, Overview header shows `⚡ X.X kWh today` pill (approaches 0 while machines are idle; grows once GPU draws settle).
- `docker exec sparkDash cat config/gpu-wh.json` shows today's daily bucket with per-spark Wh accumulating.

---

## Tests / validation summary
- `npm test` — covers EnergyTracker unit tests (Task 1), plus existing 45.
- `npm run typecheck` — after Tasks 2, 3, 5.
- `npm run build` — after Tasks 2, 4, 5.
- Live: `config/gpu-wh.json` accumulates; pill renders.

## Risks & tradeoffs
- **Double-counting across WS reconnects:** none — accumulation is wall-clock-integrated per callback, and the gap guard prevents re-feeding stale samples; more frequent calls just integrate more finely.
- **Server TZ for "today":** matches the local calendar day on the host (UTC−4). If the container TZ differs from the host, rollover could shift — verify `_getDateKey` against the host clock in Task 6.
- **Idle-vs-offline power:** GPU at idle still draws >0 W (GB10 ~10–25 W), so the pill won't read 0 for an online, idle machine — that's correct. Offline sparks (draw 0/no reading) are skipped, so consumption pauses honestly while a Spark is down.
- **Single GPU assumption:** fine for GB10; if a node ever has >1 GPU, `_parseGpuLine`/`collectGpu` must sum draws — out of scope now.

## Open questions (resolved)

**1. GPU-only vs whole-machine — RESOLVED: GPU `power.draw` only.** The 20W CX7/peripherals constant (in `SystemCollector.js:144`) is only used to build the whole-machine `systemDraw` estimate; it is not measured and is **out of scope**. We track the actual GPU draw that's already shown in the card.

**2. Units — RESOLVED: auto-scale.** Format `Wh` when < 1000, `kWh` (2 decimals) at ≥ 1000 (`fmtWh` in Task 5).

**3. Per-card chip — RESOLVED: pill-only.** We still attach `energyTodayWh` per spark internally (cheap, enables a future per-card chip), but only render a single fleet-wide pill in the Overview header. The card's live wattage (`GPU Power`) already covers per-machine power.
