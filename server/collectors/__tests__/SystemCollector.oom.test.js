/**
 * Unit tests for the OOM-risk mapping (SystemCollector.oomRiskFor).
 *
 * OOM risk is driven by REMAINING unified memory, not utilization. A healthy
 * model-loaded box sits at ~90-94% used (vLLM targets high GPU-memory
 * utilization), so a percentage alarm is a constant false positive. Risk only
 * fires when there is genuinely under 1 GB (1024 MB) of free memory left.
 *
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { oomRiskFor, OOM_RISK_THRESHOLDS } from "../SystemCollector.js";

test("no OOM risk above 1 GB remaining, even at high utilization", () => {
  assert.equal(oomRiskFor(4096), "low"); // 4 GB free
  assert.equal(oomRiskFor(2048), "low"); // 2 GB free
  assert.equal(oomRiskFor(1024), "low"); // exactly 1 GB: boundary, still not under it
});

test("OOM risk is reserved for under 1 GB remaining", () => {
  assert.equal(oomRiskFor(1023), "high"); // just under 1 GB
  assert.equal(oomRiskFor(512), "high"); // 512 MB free
  assert.equal(oomRiskFor(0), "high"); // nothing free
});

test("threshold is exported and equals 1 GB in MB", () => {
  assert.equal(OOM_RISK_THRESHOLDS.highAvailableMB, 1024);
});
