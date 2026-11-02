/**
 * Unit tests for the fleet AlertMonitor (P0 health/alerting).
 *
 * `evaluateSparkHealth` is a pure function of a snapshot, so we can assert every
 * rule (offline, GPU junction/memory temp, fan, ECC, OOM, disk, TTFT) against
 * canned payloads. The stateful AlertMonitor class is tested for change
 * detection, bounded history, and webhook delivery (via an injected notifier so
 * no network is touched).
 *
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateSparkHealth,
  AlertMonitor,
  LEVEL_ORDER,
} from "../AlertMonitor.js";

/** Build a minimal snapshot-shaped spark with overridable fields. */
function mkSpark(over = {}) {
  return {
    id: "anton",
    name: "anton",
    online: true,
    metrics: {
      gpu: { temperature: 50, usage: 10, ecc: { corrected: 0, uncorrected: 0 } },
      unifiedMemory: { oomRisk: "low" },
      storage: [{ label: "/", percentage: 40, disabled: false }],
      llm: [{ available: true, ttftP95Seconds: 0.4 }],
    },
    ...over,
  };
}

function levelsOf(badges) {
  return badges.map((b) => b.level);
}

test("healthy spark -> ok level with no alerts", () => {
  const h = evaluateSparkHealth(mkSpark());
  assert.equal(h.level, "ok");
  assert.equal(h.alerts.length, 0);
});

test("offline spark -> danger", () => {
  const h = evaluateSparkHealth(mkSpark({ online: false }));
  assert.equal(h.level, "danger");
  assert.ok(h.alerts.some((a) => a.id === "offline" && a.level === "danger"));
});

test("GPU junction temperature crosses warning/critical", () => {
  // 80C = below junction warning 85 -> no badge/alert
  assert.equal(evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperature: 80 } } })).level, "ok");
  // 90C = danger (>= critical 95? no, 90 >= warning 85 -> warn)
  const warn = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperature: 90 } } }));
  assert.equal(warn.level, "warn");
  assert.ok(warn.alerts.some((a) => a.id === "gpu_temp" && a.level === "warn"));
  // 100C = danger (>= critical 95)
  const danger = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperature: 100 } } }));
  assert.equal(danger.level, "danger");
  assert.ok(danger.alerts.some((a) => a.id === "gpu_temp" && a.level === "danger"));
});

test("GPU memory-junction temperature uses its own thresholds", () => {
  // memory warning=75, critical=85
  const warn = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperatures: { memory: 80 } } } }));
  assert.equal(warn.level, "warn");
  assert.ok(warn.alerts.some((a) => a.id === "mem_temp" && a.level === "warn"));
});

test("stalled fan under load -> danger fan badge", () => {
  const h = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperature: 50, usage: 90, fan: 0 } } }));
  assert.equal(h.level, "danger");
  assert.ok(h.alerts.some((a) => a.id === "fan" && a.level === "danger"));
});

test("ECC corrected accumulation -> warn; uncorrected -> danger", () => {
  const warn = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, ecc: { corrected: 250, uncorrected: 0 } } } }));
  assert.equal(warn.level, "warn");
  assert.ok(warn.alerts.some((a) => a.id === "ecc"));
  const danger = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, ecc: { corrected: 0, uncorrected: 1 } } } }));
  assert.equal(danger.level, "danger");
  assert.ok(danger.alerts.some((a) => a.id === "ecc" && a.level === "danger"));
});

test("OOM risk high -> danger alert", () => {
  const h = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, unifiedMemory: { oomRisk: "high" } } }));
  assert.equal(h.level, "danger");
  assert.ok(h.alerts.some((a) => a.id === "oom" && a.level === "danger"));
});

test("disk nearly full -> warn; full -> danger", () => {
  const warn = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, storage: [{ label: "/", percentage: 92, disabled: false }] } }));
  assert.ok(warn.alerts.some((a) => a.id === "disk" && a.level === "warn"));
  const danger = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, storage: [{ label: "/", percentage: 97, disabled: false }] } }));
  assert.ok(danger.alerts.some((a) => a.id === "disk" && a.level === "danger"));
});

test("disabled disk mounts are ignored for disk alerts", () => {
  const h = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, storage: [{ label: "/snap", percentage: 99, disabled: true }] } }));
  assert.ok(!h.alerts.some((a) => a.id === "disk"), "disabled mount must not alert");
});

test("slow TTFT -> warn, very slow -> danger", () => {
  const warn = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, llm: [{ available: true, ttftP95Seconds: 2.0 }] } }));
  assert.ok(warn.alerts.some((a) => a.id === "ttft" && a.level === "warn"));
  const danger = evaluateSparkHealth(mkSpark({ metrics: { ...mkSpark().metrics, llm: [{ available: true, ttftP95Seconds: 4.0 }] } }));
  assert.ok(danger.alerts.some((a) => a.id === "ttft" && a.level === "danger"));
});

test("danger always outranks warn at fleet level", () => {
  const h = evaluateSparkHealth(mkSpark({
    metrics: {
      ...mkSpark().metrics,
      gpu: { ...mkSpark().metrics.gpu, temperature: 90 }, // warn
      unifiedMemory: { oomRisk: "high" }, // danger
    },
  }));
  assert.equal(h.level, "danger");
});

test("alerts sorted highest severity first", () => {
  const h = evaluateSparkHealth(mkSpark({
    metrics: {
      ...mkSpark().metrics,
      gpu: { ...mkSpark().metrics.gpu, temperature: 100 }, // danger
      unifiedMemory: { oomRisk: "high" }, // danger
    },
  }));
  assert.equal(h.alerts[0].level, "danger");
});

test("LEVEL_ORDER is a descending severity ordering", () => {
  assert.deepEqual(LEVEL_ORDER, ["danger", "warn", "ok"]);
});

// ─── Stateful AlertMonitor ───────────────────────────────
test("first ingest records a transition from unknown to current level", () => {
  const mon = new AlertMonitor();
  const changed = mon.update([mkSpark()], 1000);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].prevLevel, "unknown");
  assert.equal(changed[0].level, "ok");
  assert.equal(mon.getHistory().length, 1);
});

test("no history entry when level is unchanged", () => {
  const mon = new AlertMonitor();
  mon.update([mkSpark()], 1000); // unknown -> ok
  mon.update([mkSpark()], 2000); // ok -> ok, no change
  assert.equal(mon.getHistory().length, 1);
});

test("history is bounded to historySize", () => {
  const mon = new AlertMonitor({ historySize: 3 });
  const ok = mkSpark();
  const hot = mkSpark({ metrics: { ...mkSpark().metrics, gpu: { ...mkSpark().metrics.gpu, temperature: 100 } } });
  for (let i = 0; i < 10; i++) {
    // alternate ok/danger to force a transition each step
    mon.update([i % 2 === 0 ? hot : ok], i * 1000);
  }
  assert.ok(mon.getHistory().length <= 3, `history should be capped, got ${mon.getHistory().length}`);
});

test("getAlerts reflects latest per-spark level", () => {
  const mon = new AlertMonitor();
  mon.update([mkSpark({ id: "a" })], 1000);
  mon.update([mkSpark({ id: "a", metrics: { ...mkSpark().metrics, gpu: { temperature: 100, usage: 10 } } })], 2000);
  const alerts = mon.getAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sparkId, "a");
  assert.equal(alerts[0].level, "danger");
});

test("webhook fires on transitions into danger and on recovery", () => {
  const deliveries = [];
  const mon = new AlertMonitor({
    webhookUrl: "https://example.com/hook",
    onWebhook: (_url, body) => deliveries.push(body),
    cooldownMs: 0,
  });
  const ok = mkSpark();
  const hot = mkSpark({ metrics: { ...mkSpark().metrics, gpu: { temperature: 100, usage: 10 } } });

  mon.update([ok], 1000); // unknown->ok: no danger, no fire
  assert.equal(deliveries.length, 0);
  mon.update([hot], 2000); // -> danger: fire
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event, "alert");
  assert.equal(deliveries[0].level, "danger");
  mon.update([hot], 3000); // still danger, unchanged: no fire
  assert.equal(deliveries.length, 1, "unchanged danger must be deduped");
  mon.update([ok], 4000); // -> ok recovery: fire
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].event, "recovered");
});

test("webhook respects cooldown window", () => {
  const deliveries = [];
  const mon = new AlertMonitor({
    webhookUrl: "https://example.com/hook",
    onWebhook: (_url, body) => deliveries.push(body),
    cooldownMs: 10000,
  });
  const hot = mkSpark({ metrics: { ...mkSpark().metrics, gpu: { temperature: 100, usage: 10 } } });
  mon.update([hot], 1000); // fire
  mon.update([hot], 2000); // still danger, within cooldown -> skip
  mon.update([hot], 12000); // past cooldown but level unchanged -> still skip (no transition)
  assert.equal(deliveries.length, 1);
});
