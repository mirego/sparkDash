import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import { allowOpenRemote } from "./auth.js";

export function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host || "");
}

export function evaluateStartupPreflight(input) {
  const loopback = isLoopbackHost(input.bindHost);
  const errors = [];
  const warnings = [];
  if (!loopback && !input.tokenConfigured) {
    if (input.allowOpenRemote) {
      warnings.push(
        `Remote bind ${input.bindHost} is open: anyone who can reach it can change settings and power units off, because SPARKDASH_TOKEN is not set and SPARKDASH_ALLOW_OPEN_REMOTE is unset or 1. Set SPARKDASH_TOKEN for authenticated remote access, or SPARKDASH_ALLOW_OPEN_REMOTE=0 to refuse to start without one.`
      );
    } else {
      errors.push(
        `Remote bind ${input.bindHost} requires SPARKDASH_TOKEN. Keep BIND_HOST=127.0.0.1, or set SPARKDASH_TOKEN and use an SSH tunnel, authenticated TLS reverse proxy, or Tailscale Serve.`
      );
    }
  }
  if (!input.configWritable) errors.push("Config directory is not writable; fix the config volume ownership/permissions.");
  if (!input.secretsKey?.present) warnings.push("No secrets key exists yet; one will be created when the secrets store is first used. Back it up with the config directory.");
  if (!input.sshIdentity?.configured) {
    // Loud + specific: a generic "no identity" line scrolls past unnoticed —
    // the v2.0.1 rebuild lost the key mounts and both key-auth Sparks went
    // "Permission denied" for hours (card t_4495562c). Name the affected units.
    const keyAuthIds = input.keyAuthSparks ?? [];
    if (keyAuthIds.length > 0) {
      warnings.push(
        `No SSH identity is available (SSH_IDENTITY_FILE unset or missing, no default key at the container HOME), but ${keyAuthIds.length} Spark${keyAuthIds.length === 1 ? "" : "s"} use key auth: ${keyAuthIds.join(", ")}. Remote polls for those will fail with "Permission denied (publickey,password)" — mount the key into the container (docker-compose.deploy.yml) and redeploy.`
      );
    } else {
      warnings.push("No SSH identity is configured; remote key-auth units will be unavailable.");
    }
  }
  if (input.sshIdentity?.configured && input.sshIdentity.safePermissions === false) {
    warnings.push("SSH identity permissions are too open; set the private key to mode 600.");
  }
  if (!input.localCollectors?.available) warnings.push("Local host metrics are unavailable; verify /proc and /sys host mounts.");
  return {
    fatal: errors.length > 0,
    authMode: loopback
      ? "loopback-only"
      : input.tokenConfigured
        ? "bearer"
        : input.allowOpenRemote
          ? "open-remote"
          : "required-missing",
    errors,
    warnings,
  };
}

function pathWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Spark ids that need SSH key auth and would break without a container identity. */
export function keyAuthSparkIds(sparksJsonPath = SPARKS_JSON_PATH) {
  try {
    const registry = JSON.parse(fs.readFileSync(sparksJsonPath, "utf8"));
    return (registry.sparks ?? [])
      .filter((s) => !s.isLocal && s.ssh?.host && s.ssh?.auth === "key")
      .map((s) => s.id);
  } catch {
    return [];
  }
}

export function inspectStartupPreflight(bindHost) {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  let identityMode = null;
  try {
    identityMode = fs.statSync(identity).mode & 0o777;
  } catch {
    identityMode = null;
  }
  return evaluateStartupPreflight({
    bindHost,
    tokenConfigured: Boolean(process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN),
    allowOpenRemote: allowOpenRemote(),
    configWritable: pathWritable(configDir),
    secretsKey: {
      present: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(keyFile),
      source: process.env.SPARKDASH_SECRETS_KEY ? "environment" : "file",
    },
    sshIdentity: {
      configured: identityMode != null,
      path: identity,
      safePermissions: identityMode == null ? null : (identityMode & 0o077) === 0,
    },
    keyAuthSparks: keyAuthSparkIds(),
    localCollectors: {
      available: fs.existsSync(path.join(HOST_PATHS.PROC, "meminfo")) && fs.existsSync(HOST_PATHS.SYS),
    },
  });
}

export function logStartupPreflight(preflight, bindHost, port) {
  console.log(`[sparkDash] preflight: bind=${bindHost}:${port} auth=${preflight.authMode}`);
  for (const warning of preflight.warnings) console.warn(`[sparkDash] preflight warning: ${warning}`);
  for (const error of preflight.errors) console.error(`[sparkDash] preflight error: ${error}`);
}
