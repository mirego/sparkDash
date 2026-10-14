import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApplyProgram,
  buildResetProgram,
  buildStatusProgram,
  buildUnit,
  parseCapRequest,
  parseProgramOutput,
  MARKER_FILE,
  UNIT_NAME,
} from "../commands.js";
import { GpuClockManager, assertSupported } from "../GpuClockManager.js";

/** A temp tree with a fake nvidia-smi and systemctl; the programs run unprivileged against it. */
function sandbox({ hwMax = 3003, lgcFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpuclock-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const d of ["units", "run", "systemd"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "boot_id"), "11111111-2222-3333-4444-555555555555\n");
  const lock = path.join(root, "lock");
  const calls = path.join(root, "calls.log");
  fs.writeFileSync(
    path.join(bin, "nvidia-smi"),
    `#!/bin/sh
echo "nvidia-smi $*" >> ${calls}
case "$1" in
  --query-gpu=clocks.max.gr) echo "${hwMax}" ;;
  -lgc) ${lgcFails ? 'echo "Setting GPU clocks is not supported" >&2; exit 4' : `echo "$2" > ${lock}`} ;;
  -rgc) rm -f ${lock} ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> ${calls}
case "$1" in
  restart) [ -f ${root}/restart_fails ] && exit 1 ;;
  is-enabled) [ -f ${root}/units/${UNIT_NAME} ] && echo enabled || echo disabled ;;
  is-active) [ -f ${root}/units/${UNIT_NAME} ] && echo active || echo inactive ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const paths = {
    unitDir: path.join(root, "units"),
    runDir: path.join(root, "run"),
    bootIdFile: path.join(root, "boot_id"),
    systemdRunDir: path.join(root, "systemd"),
    nvsmi: [path.join(bin, "nvidia-smi")],
    systemctl: path.join(bin, "systemctl"),
    sandbox: true,
  };
  const run = (program, { shell = "sh", env } = {}) =>
    parseProgramOutput(execFileSync(shell, ["-c", program], { encoding: "utf8", env: env ?? process.env }));
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const write = (f, text) => fs.writeFileSync(path.join(root, f), text);
  return { root, paths, run, read, write, bin, calls: () => read("calls.log") ?? "", cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("parseCapRequest accepts a normal cap and rejects everything else", () => {
  assert.deepEqual(parseCapRequest({ maxMHz: 2200 }), { minMHz: 0, maxMHz: 2200, persist: false });
  assert.deepEqual(parseCapRequest({ minMHz: 300, maxMHz: 1800, persist: true }), { minMHz: 300, maxMHz: 1800, persist: true });
  for (const bad of [
    null, {}, { maxMHz: "2200" }, { maxMHz: 2200.5 }, { maxMHz: 299 }, { maxMHz: 10001 },
    { maxMHz: -1 }, { maxMHz: "2200; rm -rf /" }, { maxMHz: 2200, minMHz: 2201 }, { maxMHz: 2200, minMHz: -1 },
    { maxMHz: 2200, persist: "yes" }, { maxMHz: 2200, minMHz: "0" }, { maxMHz: Infinity }, { maxMHz: NaN },
  ]) {
    assert.throws(() => parseCapRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("program text only carries integers and fixed paths", () => {
  const hostile = { minMHz: 0, maxMHz: 2200, persist: true };
  const p = buildApplyProgram(hostile);
  assert.throws(() => buildApplyProgram({ minMHz: 0, maxMHz: "2200;id", persist: true }), /maxMHz/);
  assert.throws(() => buildApplyProgram(hostile, { unitDir: "/etc/x; id" }), /unsafe path/);
  assert.throws(() => buildApplyProgram(hostile, { runDir: "/run/../etc" }), /unsafe path/);
  assert.match(p, /MIN=0; MAX=2200; PERSIST=1/);
  assert.doesNotMatch(p, /PATH=/);
});

test("every program is valid POSIX sh", () => {
  for (const prog of [
    buildStatusProgram(),
    buildResetProgram(),
    buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: false }),
    buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }),
  ]) {
    execFileSync("sh", ["-n", "-c", prog]);
  }
});

test("the unit escapes systemd's $ and keeps the marker in sync with the cap", () => {
  const unit = buildUnit({ minMHz: 0, maxMHz: 1800 });
  assert.match(unit, /^ExecStart=\/usr\/bin\/nvidia-smi -lgc 0,1800$/m);
  assert.match(unit, /^ExecStop=\/usr\/bin\/nvidia-smi -rgc$/m);
  assert.match(unit, /echo 1800 \$\$\(cat \/proc\/sys\/kernel\/random\/boot_id\) > \/run\/sparkdash\/gpu-clock-cap/);
  assert.match(unit, /^ExecStopPost=\/bin\/rm -f \/run\/sparkdash\/gpu-clock-cap$/m);
  assert.doesNotMatch(unit, /%s/);
});

test("apply without the service: caps the clock, writes the marker, installs no unit", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.CAP, "2200");
    assert.equal(sb.read("lock").trim(), "0,2200");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "2200 11111111-2222-3333-4444-555555555555");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.CAP, "2200");
    assert.equal(status.HWMAX, "3003");
    assert.equal(status.SVC_INSTALLED, "0");
  } finally {
    sb.cleanup();
  }
});

test("apply with the service: installs and enables the unit, which carries the cap", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST, "1");
    const unit = sb.read(`units/${UNIT_NAME}`);
    assert.match(unit, new RegExp(`ExecStart=${sb.paths.nvsmi[0].replace(/[/.]/g, "\\$&")} -lgc 0,1800`));
    assert.doesNotMatch(unit, /@@NV@@/);
    assert.match(sb.calls(), /systemctl enable spark-gpu-clock-limit.service/);
    assert.match(sb.calls(), /systemctl restart spark-gpu-clock-limit.service/);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CLOCKS, "0,1800");
    assert.equal(status.SVC_ENABLED, "enabled");
    assert.equal(status.CAP, "1800");
  } finally {
    sb.cleanup();
  }
});

test("switching the service off removes the unit so the old cap is not re-applied at boot", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2000, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /systemctl disable --now spark-gpu-clock-limit.service/);
    assert.equal(sb.read("lock").trim(), "0,2000");
  } finally {
    sb.cleanup();
  }
});

test("a cap above the GPU maximum is refused and nothing changes", () => {
  const sb = sandbox({ hwMax: 2418 });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 3000, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "range");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
  } finally {
    sb.cleanup();
  }
});

test("when nvidia-smi refuses the cap no service or marker is written", () => {
  const sb = sandbox({ lgcFails: true });
  try {
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "lgc-failed");
    assert.match(res.MSG, /not supported/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
  } finally {
    sb.cleanup();
  }
});

test("a stale marker from an earlier boot is not reported as the current cap", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.root, "run", MARKER_FILE), "1500 99999999-0000-0000-0000-000000000000\n");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "");
  } finally {
    sb.cleanup();
  }
});

test("reset removes the service, the lock and the marker", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    const res = sb.run(buildResetProgram(sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`run/${MARKER_FILE}`), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /nvidia-smi -rgc/);
  } finally {
    sb.cleanup();
  }
});

test("a unit with no nvidia-smi reports a clean error instead of touching anything", () => {
  const sb = sandbox();
  try {
    const paths = { ...sb.paths, nvsmi: [path.join(sb.root, "bin", "missing")] };
    assert.equal(sb.run(buildStatusProgram(paths)).CODE, "no-nvidia");
    assert.equal(sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 2200, persist: true }, paths)).CODE, "no-nvidia");
  } finally {
    sb.cleanup();
  }
});

test("parseProgramOutput: junk or missing RESULT is an error, never ok", () => {
  assert.equal(parseProgramOutput("").RESULT, "error");
  assert.equal(parseProgramOutput("Welcome to Ubuntu\nCAP=2200").RESULT, "error");
  assert.equal(parseProgramOutput("motd\nRESULT=ok\nCAP=1800\nEVIL=1").EVIL, undefined);
});

test("only Linux Spark units are supported", () => {
  assert.throws(() => assertSupported({ id: "a", kind: "host" }), (e) => e.status === 400);
  assert.throws(() => assertSupported({ id: "a", kind: "spark", platform: "windows" }), (e) => e.status === 400);
  assert.throws(() => assertSupported({ id: "a", kind: "spark", platform: "darwin" }), (e) => e.status === 400);
  assert.throws(() => assertSupported(undefined), (e) => e.status === 404);
  assertSupported({ id: "a", kind: "spark" });
  assertSupported({ id: "a", kind: "spark", platform: "linux" });
});

test("GpuClockManager: maps program errors to statuses, serialises per unit, hides ssh detail", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const outputs = [];
  const m = new GpuClockManager({
    run: async (_spark, program) => {
      if (program.includes("MAX=2200")) await gate;
      return outputs.shift();
    },
  });
  const spark = { id: "s1", name: "S1", kind: "spark" };

  outputs.push("RESULT=error\nCODE=no-sudo\nMSG=passwordless sudo is required for the user that runs the change");
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 409 && e.code === "no-sudo");

  outputs.push("RESULT=ok\nCAP=2200\nPERSIST=0");
  const first = m.apply(spark, { maxMHz: 2200 });
  await assert.rejects(m.apply(spark, { maxMHz: 1900 }), (e) => e.status === 409);
  release();
  assert.deepEqual(await first, { capMHz: 2200, persist: false, minMHz: 0 });

  const down = new GpuClockManager({ run: async () => { throw new Error("SSH to 10.0.0.2:22 failed: refused"); } });
  await assert.rejects(down.reset(spark), (e) => e.status === 502);
  await assert.rejects(m.apply(spark, { maxMHz: "x" }), (e) => e.status === 400);
  await assert.rejects(m.status({ id: "h", kind: "host" }), (e) => e.status === 400);
});

test("GpuClockManager.status: normal answer, and a unit without nvidia-smi is 'unsupported', not an error", async () => {
  const spark = { id: "s1", kind: "spark" };
  const ok = new GpuClockManager({
    run: async () => "RESULT=ok\nHWMAX=3003\nSUDO=yes\nCAP=1800\nSVC_INSTALLED=1\nSVC_CLOCKS=0,1800\nSVC_ENABLED=enabled\nSVC_ACTIVE=active",
  });
  assert.deepEqual(await ok.status(spark), {
    supported: true, hwMaxMHz: 3003, capMHz: 1800, sudo: "yes",
    service: { installed: true, clocks: "0,1800", enabled: "enabled", active: "active" },
  });
  const none = new GpuClockManager({ run: async () => "RESULT=error\nCODE=no-nvidia\nMSG=nvidia-smi was not found on this unit" });
  assert.equal((await none.status(spark)).supported, false);
});

const OLD_UNIT = `[Unit]
Description=Limit NVIDIA GPU graphics clock (0,2200 MHz)

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/nvidia-smi -lgc 0,2200
ExecStop=/usr/bin/nvidia-smi -rgc

[Install]
WantedBy=multi-user.target
`;

test("status understands a unit installed by the standalone sparkLimiter script", () => {
  const sb = sandbox();
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CLOCKS, "0,2200");
    assert.equal(status.CAP, "");
  } finally {
    sb.cleanup();
  }
});

test("a refused cap leaves an existing service and its marker exactly as they were", () => {
  const sb = sandbox({ lgcFails: true });
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    sb.write(`run/${MARKER_FILE}`, "2200 11111111-2222-3333-4444-555555555555\n");
    for (const persist of [true, false]) {
      const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist }, sb.paths));
      assert.equal(res.CODE, "lgc-failed");
      assert.equal(sb.read(`units/${UNIT_NAME}`), OLD_UNIT);
      assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "2200 11111111-2222-3333-4444-555555555555");
    }
    assert.doesNotMatch(sb.calls(), /disable|restart/);
  } finally {
    sb.cleanup();
  }
});

test("a service that fails to start is rolled back: previous unit restored, cap and marker stay truthful", () => {
  const sb = sandbox();
  try {
    sb.write(`units/${UNIT_NAME}`, OLD_UNIT);
    sb.write("restart_fails", "1");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "service-failed");
    assert.match(res.MSG, /until the next reboot/);
    assert.equal(sb.read(`units/${UNIT_NAME}`), OLD_UNIT, "the previous service is back");
    assert.equal(sb.read("lock").trim(), "0,1800", "the live cap is still applied");
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 11111111-2222-3333-4444-555555555555");
  } finally {
    sb.cleanup();
  }
});

test("a first-time service that fails to start is removed again", () => {
  const sb = sandbox();
  try {
    sb.write("restart_fails", "1");
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths));
    assert.equal(res.CODE, "service-failed");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), /systemctl disable spark-gpu-clock-limit.service/);
    assert.equal(sb.read(`run/${MARKER_FILE}`).trim(), "1800 11111111-2222-3333-4444-555555555555");
  } finally {
    sb.cleanup();
  }
});

test("the same programs behave under dash and bash --posix", () => {
  for (const shell of ["dash", "bash"]) {
    try {
      execFileSync(shell, ["-c", "true"]);
    } catch {
      continue; // not installed here
    }
    const sb = sandbox();
    try {
      const opt = { shell, env: process.env };
      const wrap = (prog) => (shell === "bash" ? `set -o posix\n${prog}` : prog);
      assert.equal(sb.run(wrap(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, sb.paths)), opt).RESULT, "ok", shell);
      assert.equal(sb.run(wrap(buildStatusProgram(sb.paths)), opt).CAP, "1800", shell);
      assert.equal(sb.run(wrap(buildResetProgram(sb.paths)), opt).RESULT, "ok", shell);
      assert.equal(sb.read(`units/${UNIT_NAME}`), null, shell);
    } finally {
      sb.cleanup();
    }
  }
});

test("as a normal user every privileged step goes through sudo -n (real privilege path, fake sudo)", () => {
  const sb = sandbox();
  try {
    const log = path.join(sb.root, "sudo.log");
    fs.writeFileSync(path.join(sb.bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> ${log}\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`, { mode: 0o755 });
    // `install -o root -g root` cannot succeed unprivileged: drop the ownership flags only.
    fs.writeFileSync(path.join(sb.bin, "install"), `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args $1"; shift ;; esac; done\nexec /usr/bin/install $args\n`, { mode: 0o755 });
    const paths = { ...sb.paths, sandbox: false, systemctl: "systemctl" };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` };
    const res = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1800, persist: true }, paths), { env });
    assert.equal(res.RESULT, "ok");
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /sudo -n true/);
    assert.match(calls, /sudo -n .*nvidia-smi -lgc 0,1800/);
    assert.match(calls, /sudo -n install -m 644 -o root -g root/);
    assert.match(calls, /sudo -n .*systemctl enable/);
    assert.match(calls, /sudo -n sh -c mkdir -p/);
    assert.equal(sb.read(`units/${UNIT_NAME}`).includes("-lgc 0,1800"), true);
    // Sudo that asks for a password changes nothing.
    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.rmSync(path.join(sb.root, "lock"));
    const denied = sb.run(buildApplyProgram({ minMHz: 0, maxMHz: 1500, persist: true }, paths), { env });
    assert.equal(denied.CODE, "no-sudo");
    assert.equal(sb.read("lock"), null);
    assert.equal(sb.read(`units/${UNIT_NAME}`).includes("-lgc 0,1800"), true);
  } finally {
    sb.cleanup();
  }
});

test("a dropped connection keeps the unit busy for a while, then frees it", async () => {
  let n = 0;
  const m = new GpuClockManager({
    holdMs: 60,
    run: async () => { n += 1; if (n === 1) throw new Error("timeout"); return "RESULT=ok\nCAP=1800\nPERSIST=0"; },
  });
  const spark = { id: "s1", kind: "spark" };
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 502);
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 409);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal((await m.apply(spark, { maxMHz: 1800 })).capMHz, 1800);
});
