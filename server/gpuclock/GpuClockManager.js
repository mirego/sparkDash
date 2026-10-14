/**
 * Runs the GPU clock cap programs on a unit: locally through the host mount
 * namespace (as root, like the shutdown helper), or over SSH with `sudo -n`.
 * One action per unit at a time. Supported on Linux Spark units only.
 */
import { execFile } from "node:child_process";
import { sshExec } from "../collectors/ssh.js";
import { hostMountNs } from "../shutdown.js";
import { scrubbedChildEnv } from "../llmlaunch/childEnv.js";
import {
  buildApplyProgram,
  buildResetProgram,
  buildStatusProgram,
  parseCapRequest,
  parseProgramOutput,
} from "./commands.js";

const ACTION_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 15_000;

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "no-sudo": 409,
  "no-nvidia": 409,
  "no-gpu": 409,
  "no-systemd": 409,
  range: 400,
  "bad-output": 502,
  // The action reached the unit and failed there (nvidia-smi, systemd, the marker write).
  "lgc-failed": 422,
  "service-failed": 422,
  "rgc-failed": 422,
  "marker-failed": 422,
};
/** After a transport failure the outcome on the unit is unknown: refuse a second action for a while. */
const HOLD_AFTER_TRANSPORT_ERROR_MS = 30_000;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** @param {object} spark registry entry */
export function assertSupported(spark) {
  if (!spark) throw httpError(404, "Spark not found");
  if (spark.kind === "host") throw httpError(400, "GPU clock caps are only supported on Spark units");
  if (spark.platform === "windows" || spark.platform === "darwin") {
    throw httpError(400, "GPU clock caps are only supported on Linux Spark units");
  }
}

/** Default runner: the program text goes in as one argument, never through a shell string. */
export function runProgram(spark, program, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  if (!spark.isLocal) {
    const b64 = Buffer.from(program, "utf8").toString("base64");
    return sshExec(spark, `echo ${b64} | base64 -d | sh`, { timeoutMs });
  }
  const mntNs = hostMountNs();
  const [file, args] = mntNs
    ? ["nsenter", [`--mount=${mntNs}`, "--", "sh", "-c", program]]
    : ["sh", ["-c", program]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env: scrubbedChildEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

export class GpuClockManager {
  /** @param {{ run?: typeof runProgram, paths?: object }} [opts] `paths` is a test hook for the program's file locations. */
  constructor({ run = runProgram, paths = {}, holdMs = HOLD_AFTER_TRANSPORT_ERROR_MS } = {}) {
    this._run = run;
    this._holdMs = holdMs;
    this._paths = paths;
    /** @type {Set<string>} */
    this._busy = new Set();
  }

  async _exec(spark, program, timeoutMs) {
    let out;
    try {
      out = await this._run(spark, program, { timeoutMs });
    } catch (err) {
      const e = httpError(502, `Could not reach ${spark.name || spark.id}: ${String(err.message || err).slice(0, 200)}`);
      e.holdBusy = true;
      throw e;
    }
    return parseProgramOutput(out);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  async _exclusive(spark, fn) {
    if (this._busy.has(spark.id)) throw httpError(409, "Another GPU clock action is still running on this unit");
    this._busy.add(spark.id);
    let hold = false;
    try {
      return await fn();
    } catch (err) {
      hold = err?.holdBusy === true;
      throw err;
    } finally {
      // A timed-out or dropped connection can leave the program still running on the unit.
      if (hold && this._holdMs > 0) {
        setTimeout(() => this._busy.delete(spark.id), this._holdMs).unref?.();
      } else {
        this._busy.delete(spark.id);
      }
    }
  }

  /** Read-only: hardware maximum, current cap, sudo availability, service state. */
  async status(spark) {
    assertSupported(spark);
    const res = await this._exec(spark, buildStatusProgram(this._paths), STATUS_TIMEOUT_MS);
    if (res.RESULT !== "ok") {
      // A unit without nvidia-smi is a normal answer for the dialog, not a server error.
      if (res.CODE === "no-nvidia") return { supported: false, reason: res.MSG };
      throw this._fail(res);
    }
    const num = (v) => (/^\d+$/.test(v ?? "") ? Number(v) : null);
    return {
      supported: true,
      hwMaxMHz: num(res.HWMAX),
      capMHz: num(res.CAP),
      sudo: ["root", "yes", "no"].includes(res.SUDO) ? res.SUDO : "no",
      service: {
        installed: res.SVC_INSTALLED === "1",
        clocks: /^\d+,\d+$/.test(res.SVC_CLOCKS ?? "") ? res.SVC_CLOCKS : null,
        enabled: res.SVC_ENABLED || null,
        active: res.SVC_ACTIVE || null,
      },
    };
  }

  /** Apply a cap; `persist` installs the boot service. */
  async apply(spark, body) {
    assertSupported(spark);
    const req = parseCapRequest(body);
    return this._exclusive(spark, async () => {
      const res = await this._exec(spark, buildApplyProgram(req, this._paths), ACTION_TIMEOUT_MS);
      if (res.RESULT !== "ok") throw this._fail(res);
      return { capMHz: Number(res.CAP) || req.maxMHz, persist: res.PERSIST === "1", minMHz: req.minMHz };
    });
  }

  /** Remove the cap and the service. */
  async reset(spark) {
    assertSupported(spark);
    return this._exclusive(spark, async () => {
      const res = await this._exec(spark, buildResetProgram(this._paths), ACTION_TIMEOUT_MS);
      if (res.RESULT !== "ok") throw this._fail(res);
      return {};
    });
  }
}
