import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStartupPreflight, keyAuthSparkIds } from "../../startupPreflight.js";
import { evaluateHealth } from "../../health.js";

async function withSparksJson(registry, run) {
  const dir = await mkdtemp(join(tmpdir(), "sparkdash-ssh-guard-"));
  const file = join(dir, "sparks.json");
  await writeFile(file, JSON.stringify(registry));
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("no identity + key-auth sparks: the warning names the affected units", () => {
  const result = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    keyAuthSparks: ["anton", "son-of-anton"],
    localCollectors: { available: true },
  });
  assert.equal(result.fatal, false);
  const warning = result.warnings.find((w) => w.includes("SSH identity"));
  assert.ok(warning, "expected an ssh-identity warning");
  assert.match(warning, /anton, son-of-anton/);
  assert.match(warning, /Permission denied/);
  assert.match(warning, /docker-compose\.deploy\.yml/);
});

test("no identity + NO key-auth sparks: generic warning, no unit names", () => {
  const result = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    keyAuthSparks: [],
    localCollectors: { available: true },
  });
  const warning = result.warnings.find((w) => w.includes("SSH identity"));
  assert.ok(warning);
  assert.doesNotMatch(warning, /Permission denied/);
});

test("identity configured: no ssh warning even with key-auth sparks", () => {
  const result = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: true, safePermissions: true },
    keyAuthSparks: ["anton"],
    localCollectors: { available: true },
  });
  assert.equal(result.warnings.find((w) => w.includes("SSH identity")), undefined);
});

test("keyAuthSparkIds lists non-local key-auth sparks from sparks.json", async () => {
  await withSparksJson(
    {
      sparks: [
        { id: "anton", isLocal: false, ssh: { host: "10.4.0.15", auth: "key" } },
        { id: "local", isLocal: true, ssh: { host: "127.0.0.1", auth: "key" } },
        { id: "pw", isLocal: false, ssh: { host: "10.4.0.16", auth: "password" } },
        { id: "nossh", isLocal: false },
      ],
    },
    (file) => {
      assert.deepEqual(keyAuthSparkIds(file), ["anton"]);
    }
  );
});

test("keyAuthSparkIds returns [] on missing/corrupt registry instead of throwing", async () => {
  assert.deepEqual(await withSparksJson({ sparks: [] }, (f) => keyAuthSparkIds(join(f, ".missing"))), []);
});

test("/api/health: missing identity with key-auth sparks lists them in warnings", () => {
  const result = evaluateHealth({
    bindHost: "0.0.0.0",
    configWritable: true,
    secretsKeyPresent: true,
    sshIdentityPresent: false,
    keyAuthSparks: ["anton", "son-of-anton"],
  });
  const warning = result.warnings.find((w) => /SSH identity is not mounted/i.test(w));
  assert.ok(warning);
  assert.match(warning, /anton, son-of-anton/);
});

test("/api/health: missing identity with no key-auth sparks keeps the generic warning", () => {
  const result = evaluateHealth({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKeyPresent: true,
    sshIdentityPresent: false,
    keyAuthSparks: [],
  });
  assert.deepEqual(result.warnings.filter((w) => w.includes("SSH identity")), ["SSH identity is not mounted"]);
});
