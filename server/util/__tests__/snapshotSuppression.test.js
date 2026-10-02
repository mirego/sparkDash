import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createSnapshotSuppression } from "../snapshotSuppression.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("no snapshot in flight → broadcasts allowed", () => {
  const sup = createSnapshotSuppression();
  assert.equal(sup.active, false);
});

test("single connection snapshot suppresses broadcasts until its finally ends it", async () => {
  const sup = createSnapshotSuppression();
  // Mirrors the wss connection handler shape in server/index.js.
  sup.begin();
  try {
    await sleep(5);
    assert.equal(sup.active, true);
  } finally {
    sup.end();
  }
  assert.equal(sup.active, false);
});

test("overlapping connection snapshots: A ending early must NOT release suppression while B builds", async () => {
  const sup = createSnapshotSuppression();

  // Client A connects — slow snapshot (SSH probes).
  const clientA = (async () => {
    sup.begin();
    try {
      await sleep(30);
    } finally {
      sup.end();
    }
  })();

  // Client B connects a beat later while A is still building.
  await sleep(5);
  const clientB = (async () => {
    sup.begin();
    try {
      await sleep(60);
    } finally {
      sup.end();
    }
  })();

  await clientA; // A finishes; B's build is still in flight.
  assert.equal(sup.active, true, "suppression must persist while client B's snapshot builds");

  // An alertMonitor.onChange firing now would still be suppressed (snapshot-first).
  assert.equal(sup.active, true);

  await clientB;
  assert.equal(sup.active, false, "suppression releases only after the last build ends");
});

test("unbalanced end() is clamped and cannot poison later builds", () => {
  const sup = createSnapshotSuppression();
  sup.end(); // defensive: no begin matched
  sup.begin();
  sup.end();
  sup.end();
  assert.equal(sup.active, false);
  sup.begin();
  assert.equal(sup.active, true);
  sup.end();
  assert.equal(sup.active, false);
});
