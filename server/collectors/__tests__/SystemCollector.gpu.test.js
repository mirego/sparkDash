/**
 * Unit tests for the extended GPU telemetry parsing in SystemCollector.
 *
 * Covers the null-safe parse of the new health fields (fan, memory-junction
 * temp, clocks, pstate, ECC), the [N/A] degradation path, and the compute-apps
 * parser. Pure methods — no SSH/exec involved.
 *
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

function makeCollector() {
  return new SystemCollector({ id: "anton", isLocal: true });
}

test("parses extended GPU line with all health fields", () => {
  const c = makeCollector();
  const out = [
    "45, 74, 58, 97, 44, 100, 1545, 0, 0, 0, 0",
  ].join("\n");
  const g = c._parseGpuLine(out);
  assert.equal(g.fan, 45);
  assert.equal(g.temperature, 74);
  assert.equal(g.temperatureMemory, 58);
  assert.equal(g.usage, 97);
  assert.equal(g.powerDraw, 44);
  assert.equal(g.powerLimit, 100);
  assert.equal(g.clockSm, 1545);
  assert.equal(g.clockMem, 0);
  assert.equal(g.pstate, "P0");
  assert.equal(g.eccCorrected, 0);
  assert.equal(g.eccUncorrected, 0);
});

test("[N/A] health fields degrade to null, not false zeros", () => {
  const c = makeCollector();
  // GB10 commonly reports fan.speed / clocks / ECC as [N/A].
  const out = ["[N/A], 75, [N/A], 90, [N/A], 100, [N/A], [N/A], 8, [N/A], [N/A]"].join("\n");
  const g = c._parseGpuLine(out);
  assert.equal(g.fan, null);
  assert.equal(g.temperature, 75);
  assert.equal(g.temperatureMemory, null);
  assert.equal(g.usage, 90);
  assert.equal(g.powerDraw, null); // power.draw [N/A] -> null (not 0)
  assert.equal(g.clockSm, null);
  assert.equal(g.pstate, "P8");
  assert.equal(g.eccCorrected, null);
});

test("empty GPU output produces safe defaults", () => {
  const c = makeCollector();
  const g = c._parseGpuLine("");
  assert.equal(g.temperature, 0);
  assert.equal(g.usage, 0);
  assert.equal(g.powerLimit, 120);
  assert.equal(g.fan, null);
  assert.equal(g.pstate, null);
  assert.equal(g.eccCorrected, null);
});

test("pstate is normalized to P-prefixed form", () => {
  const c = makeCollector();
  assert.equal(c._parseGpuLine(["45, 60, 50, 10, 20, 100, 800, 0, 0, 0, 0"].join("\n")).pstate, "P0");
  assert.equal(c._parseGpuLine(["45, 60, 50, 10, 20, 100, 800, 0, P8, 0, 0"].join("\n")).pstate, "P8");
  assert.equal(c._parseGpuLine(["45, 60, 50, 10, 20, 100, 800, 0, [N/A], 0, 0"].join("\n")).pstate, null);
});

test("_parseSmiNumber handles N/A and junk", () => {
  const c = makeCollector();
  assert.equal(c._parseSmiNumber("[N/A]"), null);
  assert.equal(c._parseSmiNumber("n/a"), null);
  assert.equal(c._parseSmiNumber(""), null);
  assert.equal(c._parseSmiNumber("12"), 12);
  assert.equal(c._parseSmiNumber("12.5"), 12.5);
  assert.equal(c._parseSmiNumber(null), null);
});

test("_parseComputeApps parses pid/name/vram and drops invalid rows", () => {
  const c = makeCollector();
  const raw = [
    "1234, /usr/bin/python3, 4096 MiB",
    "5678, /usr/bin/llama-server, 2048 MiB",
    "0, broken, 0 MiB",
  ].join("\n");
  const apps = c._parseComputeApps(raw);
  assert.equal(apps.length, 2);
  assert.equal(apps[0].pid, 1234);
  assert.equal(apps[0].name, "/usr/bin/python3");
  assert.equal(apps[0].vramMB, 4096);
});

test("default GPU profile exposes the new health fields", () => {
  const c = makeCollector();
  const g = c._defaultGpu();
  assert.deepEqual(g.temperatures, { memory: null });
  assert.equal(g.fan, null);
  assert.deepEqual(g.clocks, { sm: null, mem: null });
  assert.equal(g.pstate, null);
  assert.deepEqual(g.ecc, { corrected: null, uncorrected: null });
});
