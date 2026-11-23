import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerStorageRoutes } from "../routes.js";
import { assertSupported, StorageManager } from "../StorageManager.js";

const known = {
  spark: { id: "spark", name: "Spark", kind: "spark" },
  linux: { id: "linux", name: "Linux GPU", kind: "host", platform: "linux" },
  windows: { id: "windows", name: "Windows host", kind: "host", platform: "windows" },
  mac: { id: "mac", name: "Mac", kind: "mac", platform: "darwin" },
  darwinHost: { id: "darwinHost", name: "Darwin host", kind: "host", platform: "darwin" },
};

async function withApp(run, fn) {
  const app = express();
  app.use(express.json());
  const manager = new StorageManager({ run, holdMs: 0 });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => known[id] },
    recordEvent: () => {},
    allowRead: () => true,
    allowChange: () => true,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, manager);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("assertSupported accepts Linux hosts and Sparks, and refuses unsupported or missing units", () => {
  assert.doesNotThrow(() => assertSupported(known.linux));
  assert.doesNotThrow(() => assertSupported(known.spark));

  for (const unsupported of [known.windows, known.mac, known.darwinHost]) {
    assert.throws(() => assertSupported(unsupported), (error) => error.status === 400);
  }
  assert.throws(() => assertSupported(undefined), (error) => error.status === 404);
});

test("agent-junk refuses Windows and macOS units before running a program", async () => {
  let ran = 0;
  await withApp(async () => {
    ran += 1;
    return "RESULT=ok\n";
  }, async (base) => {
    for (const id of ["windows", "mac"]) {
      const response = await fetch(`${base}/${id}/storage/agent-junk`);
      assert.equal(response.status, 400, id);
      assert.match((await response.json()).error, /only supports Linux units/, `${id}: refused by the platform check`);
    }
    assert.equal(ran, 0, "unsupported units must not run a program");
  });
});

test("delete and scan-start refuse a Windows host before running a program", async () => {
  let ran = 0;
  await withApp(async () => {
    ran += 1;
    return "RESULT=ok\n";
  }, async (base) => {
    const deleteResponse = await fetch(`${base}/windows/storage/delete`, json("POST", { path: "/home/me/old-file" }));
    assert.equal(deleteResponse.status, 400, "delete route");
    assert.match((await deleteResponse.json()).error, /only supports Linux units/, "delete: refused by the platform check");

    const scanResponse = await fetch(`${base}/windows/storage/scan`, json("POST", { path: "/", depth: 2 }));
    assert.equal(scanResponse.status, 400, "scan start route");
    assert.match((await scanResponse.json()).error, /only supports Linux units/, "scan: refused by the platform check");

    assert.equal(ran, 0, "unsupported units must not run a program");
  });
});

test("agent-junk reaches a Linux GPU host and returns successfully", async () => {
  let ran = 0;
  await withApp(async (_spark, _program, { name }) => {
    ran += 1;
    assert.equal(name, "agentJunk");
    return [
      "RESULT=ok",
      "NOW=1800000000",
      `HOME_HEX=${Buffer.from("/home/me").toString("hex")}`,
      "GIT=ok",
    ].join("\n");
  }, async (base) => {
    const response = await fetch(`${base}/linux/storage/agent-junk`);
    assert.equal(response.status, 200);
    assert.equal(ran, 1, "Linux GPU host should invoke the read-only program");
    const body = await response.json();
    assert.equal(body.home, "/home/me");
    assert.deepEqual(body.items, []);
  });
});
