import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerGpuClockRoutes } from "../routes.js";
import { GpuClockManager } from "../GpuClockManager.js";

async function withApp({ run, allow = () => true, sparks }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  const known = sparks ?? { s1: { id: "s1", name: "S1", kind: "spark" }, h1: { id: "h1", name: "H1", kind: "host" } };
  registerGpuClockRoutes(app, {
    manager: new GpuClockManager({ run }),
    registry: { getSpark: (id) => known[id] },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("PUT validates, applies, records an Activity event and answers with the new cap", async () => {
  const seen = [];
  await withApp({ run: async (_s, program) => { seen.push(program); return "RESULT=ok\nCAP=1800\nPERSIST=1"; } }, async (base, events) => {
    const bad = await fetch(`${base}/s1/gpu-clock`, json("PUT", { maxMHz: "1800; id" }));
    assert.equal(bad.status, 400);
    assert.equal(seen.length, 0, "an invalid request never reaches the unit");

    const ok = await fetch(`${base}/s1/gpu-clock`, json("PUT", { maxMHz: 1800, persist: true }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, capMHz: 1800, persist: true, minMHz: 0 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "gpu.clock.set");
    assert.match(events[0].message, /1800 MHz.*after reboot/);
  });
});

test("host units, unknown units and rate-limited callers are refused before anything runs", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return "RESULT=ok"; };
  await withApp({ run }, async (base) => {
    assert.equal((await fetch(`${base}/h1/gpu-clock`, json("PUT", { maxMHz: 1800 }))).status, 400);
    assert.equal((await fetch(`${base}/nope/gpu-clock`)).status, 404);
    assert.equal(ran, 0);
  });
  await withApp({ run, allow: () => false }, async (base) => {
    assert.equal((await fetch(`${base}/s1/gpu-clock`, json("PUT", { maxMHz: 1800 }))).status, 429);
    assert.equal((await fetch(`${base}/s1/gpu-clock`, json("DELETE"))).status, 429);
    assert.equal((await fetch(`${base}/s1/gpu-clock`)).status, 429);
    assert.equal(ran, 0);
  });
});

test("a refused action comes back with its code and no event is recorded", async () => {
  await withApp({ run: async () => "RESULT=error\nCODE=no-sudo\nMSG=passwordless sudo is required for the user that runs the change" }, async (base, events) => {
    const res = await fetch(`${base}/s1/gpu-clock`, json("DELETE"));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "no-sudo");
    assert.match(body.error, /passwordless sudo/);
    assert.equal(events.length, 0);
  });
});

test("an unreachable unit is a 502 that does not echo ssh internals beyond a short message", async () => {
  await withApp({ run: async () => { throw new Error("SSH to 10.0.0.9:22 failed: " + "x".repeat(500)); } }, async (base) => {
    const res = await fetch(`${base}/s1/gpu-clock`);
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error.length < 260);
  });
});

test("a failure on the unit reaches the browser with its own message, not a generic 500", async () => {
  const cases = [
    ["lgc-failed", "nvidia-smi refused the clock cap: not supported", 422],
    ["service-failed", "the service did not start; the cap applies until the next reboot", 422],
    ["rgc-failed", "nvidia-smi could not reset the clocks", 422],
    ["marker-failed", "could not record the cap", 422],
    ["bad-output", "the unit returned an unexpected answer", 502],
  ];
  for (const [code, msg, status] of cases) {
    await withApp({ run: async () => `RESULT=error\nCODE=${code}\nMSG=${msg}` }, async (base) => {
      const res = await fetch(`${base}/s1/gpu-clock`, json("PUT", { maxMHz: 1800, persist: true }));
      assert.equal(res.status, status, code);
      const body = await res.json();
      assert.equal(body.code, code);
      if (code !== "bad-output") assert.equal(body.error, msg);
    });
  }
});
