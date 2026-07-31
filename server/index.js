import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import dotenv from "dotenv";
import { SparkRegistry } from "./sparks/SparkRegistry.js";
import { SparkMonitor } from "./sparks/SparkMonitor.js";
import { sshExec, sshTest, llmTest } from "./collectors/ssh.js";
import { validateSparkTarget, createRateLimiter } from "./validate.js";
import { getSettings, updateSettings, loadSettings } from "./settings.js";
import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
} from "./collectors/DecodeBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import {
  startPerKeyTracking,
  stopPerKeyTracking,
  getTopUsers,
  getAllModelUsers,
  getKnownApiKeys,
} from "./collectors/PerKeyUsageTracker.js";

dotenv.config();

/**
 * Normalize a model name for fuzzy matching.
 * Handles:
 *   - Stripping prefixes: /home/gilfoyle/, claude-, poolside/
 *   - Stripping suffixes: -NVFP4, -DSpark, .gguf, _DGX-Spark-Recipe
 *   - Replacing spaces with hyphens
 *   - Lowercasing
 *
 * Examples:
 *   "qwen3.6-35b-a3b-q8" → "qwen3.6-35b-a3b-q8"
 *   "/home/gilfoyle/Qwen3.6-35B-A3B-UD-Q8_K_XL_DGX-Spark-Recipe/Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf"
 *     → "qwen3.6-35b-a3b-ud-q8_k_xl"
 *   "mimo-v2.5" → "mimo-v2.5"
 *   "MiMo-V2.5-NVFP4" → "mimo-v2.5"
 *   "deepseek-v4-flash-dspark" → "deepseek-v4-flash"
 *   "DeepSeek V4 Flash DSpark" → "deepseek-v4-flash"
 *   "laguna-s-2.1" → "laguna-s-2.1"
 *   "poolside/Laguna-S-2.1-NVFP4" → "laguna-s-2.1"
 *   "claude-laguna-s-2.1" → "laguna-s-2.1"
 */
function normalizeModelName(name) {
  if (!name) return "";
  let n = name.toLowerCase();
  // Strip path prefixes (e.g. /home/gilfoyle/.../model.gguf → model.gguf)
  n = n.replace(/^.*\//, "");
  // Strip "claude-" prefix
  n = n.replace(/^claude-/, "");
  // Strip "poolside/" prefix (already handled by path strip above, but be safe)
  n = n.replace(/^poolside\//, "");
  // Strip common suffixes
  n = n.replace(/-(?:NVFP4|DSpark|FP16|INT4|INT8|GPTQ|AWQ)$/i, "");
  n = n.replace(/_dgx-spark-recipe$/i, "");
  n = n.replace(/\.gguf$/i, "");
  // Strip quantization variant suffixes (e.g. _q8_k_xl, _ud_q8, etc.)
  n = n.replace(/_q\d+.*$/i, "");
  n = n.replace(/-q\d+.*$/i, "");
  // Strip "ud-" prefix (e.g. ud-q8 → q8)
  n = n.replace(/^ud-/, "");
  // Replace spaces with hyphens
  n = n.replace(/\s+/g, "-");
  return n;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "5555", 10);
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);

/** Per-spark LLM HTTP port (1–65535), else env default. */
function resolveLlmPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    // Prefer llmPorts array, fall back to legacy llmPort
    const ports = sparkOrPort.llmPorts;
    if (Array.isArray(ports) && ports.length > 0) {
      const n = ports[0];
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
    const raw = sparkOrPort.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return LLM_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return LLM_PORT;
}

/** Optional Bearer token for a Spark LLM port (from encrypted secrets). */
function resolveLlmApiKey(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

// Rate-limit ephemeral + registered connectivity tests (per client IP)
const allowTest = createRateLimiter(20, 60_000);

// ─── Spark registry ──────────────────────────────────────
const registry = new SparkRegistry();

// ─── Monitor map ─────────────────────────────────────────
const monitors = new Map();

// ─── Start monitor for a Spark ───────────────────────────
function startMonitor(spark) {
  if (monitors.has(spark.id)) return;
  const monitor = new SparkMonitor(spark, {
    onWolMac: (id, mac) => {
      const updated = registry.noteDetectedMac(id, mac);
      if (updated) {
        const mon = monitors.get(id);
        if (mon) mon.updateConfig(registry.getSpark(id));
      }
    },
  });
  monitors.set(spark.id, monitor);
  monitor.start();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (monitor) {
    monitor.stop();
    monitors.delete(id);
  }
}

// ─── Start all monitors from registry ───────────────────
function startAllMonitors() {
  for (const spark of registry.sparks) {
    startMonitor(spark);
  }
}

/** Snapshots in registry tab order (not Map insertion order). */
function orderedSnapshots() {
  return registry.sparkIds
    .map((id) => monitors.get(id))
    .filter(Boolean)
    .map((m) => m.snapshot());
}

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

app.use(express.json());

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── REST API ────────────────────────────────────────────
// Never return SSH passwords in any response
app.get("/api/sparks", (_req, res) => {
  res.json({ sparks: registry.publicSparks });
});

// Ephemeral connectivity test — does not persist or start a monitor
app.post("/api/sparks/test", async (req, res) => {
  try {
    if (!allowTest(clientKey(req))) {
      return res.status(429).json({ error: "Too many test requests; try again shortly" });
    }
    const body = req.body || {};
    const validationError = validateSparkTarget(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = {
      id: body.id || "ephemeral-test",
      name: body.name || "test",
      lanIp: body.lanIp || "",
      cx7Ip: body.cx7Ip || null,
      llmHost: body.llmHost || null,
      isLocal: Boolean(body.isLocal),
      llmPort: resolveLlmPort(body),
      ssh: {
        host: body.ssh?.host || body.lanIp || "",
        user: body.ssh?.user || "root",
        auth: body.ssh?.auth === "pass" ? "pass" : "key",
        password: body.ssh?.password,
      },
    };
    if (!spark.lanIp && !spark.ssh.host) {
      return res.status(400).json({ error: "lanIp or ssh.host required" });
    }
    const llmPort = resolveLlmPort(spark);
    const [sshResult, llmResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, llmPort),
    ]);
    res.json({
      id: spark.id,
      ssh: sshResult,
      llm: llmResult,
      ok: sshResult.ok || llmResult.ok,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks", (req, res) => {
  try {
    const validationError = validateSparkTarget(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = registry.addSpark(req.body);
    startMonitor(spark);
    res.json({ success: true, spark: registry.toPublic(spark) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/sparks/:id", (req, res) => {
  try {
    const body = req.body || {};
    // Only validate host fields if they are being updated
    if (body.lanIp != null || body.llmHost != null || body.ssh?.host != null || body.ssh?.user != null) {
      const existing = registry.getSpark(req.params.id);
      if (!existing) return res.status(404).json({ error: "Spark not found" });
      const merged = {
        lanIp: body.lanIp ?? existing.lanIp,
        ssh: { ...existing.ssh, ...(body.ssh || {}) },
      };
      const validationError = validateSparkTarget(merged);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    // Password-only update: hot-apply without full monitor restart
    const keys = Object.keys(body).filter((k) => k !== "ssh");
    const sshKeys = body.ssh ? Object.keys(body.ssh) : [];
    const passwordOnly =
      keys.length === 0 &&
      sshKeys.length > 0 &&
      sshKeys.every((k) => k === "password");

    if (passwordOnly && body.ssh?.password) {
      const spark = registry.setPassword(req.params.id, body.ssh.password);
      const mon = monitors.get(req.params.id);
      if (mon) mon.updateConfig(registry.getSpark(req.params.id));
      return res.json({ success: true, spark, hasPassword: true });
    }

    const spark = registry.updateSpark(req.params.id, body);
    // Restart monitor so collectors pick up host/auth/isLocal changes
    stopMonitor(req.params.id);
    startMonitor(spark);
    res.json({
      success: true,
      spark: registry.toPublic(spark),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/sparks/:id", (req, res) => {
  try {
    const removed = registry.removeSpark(req.params.id);
    if (!removed) return res.status(404).json({ error: "Spark not found" });
    stopMonitor(req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder Sparks in the tab bar (persisted to sparks.json)
app.put("/api/sparks/order", (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: "body.order must be an array of spark ids" });
    }
    const sparks = registry.reorderSparks(order);
    res.json({ success: true, sparks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Global settings ──────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    const newSettings = updateSettings(patch);
    // If poll interval changed, restart the broadcast timer
    if (patch.pollIntervalMs != null) {
      restartBroadcast();
    }
    res.json(newSettings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  res.json(monitor.snapshot());
});

// Test SSH + LLM connectivity for a registered Spark.
// Optional body.ssh.password is ALWAYS saved (even if the host is down).
app.post("/api/sparks/:id/test", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many test requests; try again shortly" });
  }
  try {
    const body = req.body || {};
    const incomingPassword = body.ssh?.password ?? body.password;
    // Persist password first — does not require host reachability
    if (incomingPassword != null && incomingPassword !== "") {
      registry.setPassword(req.params.id, incomingPassword);
    }

    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const [sshResult, llmResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, resolveLlmPort(spark)),
    ]);
    res.json({
      id: req.params.id,
      ssh: sshResult,
      llm: llmResult,
      ok: sshResult.ok || llmResult.ok,
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual metric refresh ──────────────────────────────
app.post("/api/sparks/:id/refresh/:domain", async (req, res) => {
  try {
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const { domain } = req.params;
    if (domain !== "storage") {
      return res.status(400).json({ error: "Only 'storage' domain is supported" });
    }
    await monitor.refreshDomain(domain);
    // Broadcast updated snapshot immediately (force, ignoring the diff cache)
    const payload = buildSnapshotPayload();
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
    res.json({ success: true, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update SSH password only (works while host is offline)
app.put("/api/sparks/:id/password", (req, res) => {
  try {
    const password = req.body?.password ?? req.body?.ssh?.password;
    if (password == null || password === "") {
      return res.status(400).json({ error: "password is required" });
    }
    const spark = registry.setPassword(req.params.id, password);
    // Refresh monitor with password in memory (no need if already running — updateConfig)
    const mon = monitors.get(req.params.id);
    if (mon) mon.updateConfig(registry.getSpark(req.params.id));
    res.json({ success: true, spark, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled storage devices for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-devices", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledDevices } = req.body;
    if (!Array.isArray(disabledDevices)) {
      return res.status(400).json({ error: "disabledDevices must be an array" });
    }

    const updated = registry.updateSpark(req.params.id, { disabledDevices });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledDevices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled network interfaces for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-interfaces", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledInterfaces } = req.body;
    if (!Array.isArray(disabledInterfaces)) {
      return res.status(400).json({ error: "disabledInterfaces must be an array" });
    }

    const cleaned = disabledInterfaces.filter((n) => typeof n === "string" && n.length > 0);
    const updated = registry.updateSpark(req.params.id, { disabledInterfaces: cleaned });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledInterfaces: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update LLM probe ports for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPorts;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "llmPorts must be an array" });
    }
    const ports = raw
      .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    // Deduplicate
    const unique = [...new Set(ports)];
    if (unique.length === 0) {
      return res.status(400).json({ error: "llmPorts must contain at least one valid port 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    const updated = registry.updateSpark(req.params.id, { llmPorts: unique });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, unique);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backward-compat: update single LLM port (delegates to llm-ports)
app.put("/api/sparks/:id/llm-port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "llmPort must be an integer 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    // Replace the ports list with just this single port
    const updated = registry.updateSpark(req.params.id, { llmPorts: [n] });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, [n]);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPort: n,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add a single LLM port to a Spark (hot — no monitor restart)
app.post("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.port;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    if (currentPorts.includes(n)) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: [...currentPorts, n] });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, llmPorts: updated.llmPorts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an LLM port from a Spark (hot — no monitor restart)
app.delete("/api/sparks/:id/llm-ports/:port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    // Primary (first) port cannot be removed — only additional ports
    if (currentPorts[0] === port) {
      return res.status(400).json({ error: "Cannot remove the primary LLM port" });
    }
    const newPorts = currentPorts.filter((p) => p !== port);
    if (newPorts.length === 0) {
      return res.status(400).json({ error: "Cannot remove the last LLM port" });
    }
    if (newPorts.length === currentPorts.length) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: newPorts });
    registry.clearLlmApiKey(req.params.id, port);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set / clear optional LLM API key for one port (encrypted secrets store)
app.put("/api/sparks/:id/llm-ports/:port/api-key", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      return res.status(400).json({ error: "apiKey is required (use \"\" to clear)" });
    }

    const apiKey = req.body.apiKey == null ? "" : String(req.body.apiKey);
    const publicSpark = registry.setLlmApiKey(req.params.id, port, apiKey);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      spark: publicSpark,
      hasApiKey: registry.hasLlmApiKey(req.params.id, port),
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Decode throughput benchmark (streaming, post-first-token tok/s).
 *
 * POST body: { port?, concurrencies: number[], maxTokens? }
 * Returns immediately with a bench job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let port = req.body?.port != null ? Number(req.body.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }

  // Resolve model id for this port from live snapshot when possible
  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const benchDebug = Boolean(getSettings().benchDebugTraces);
    const job = decodeBenchManager.start({
      sparkId: spark.id,
      lanIp: spark.lanIp,
      llmHost: spark.llmHost || null,
      port,
      modelId,
      concurrencies: req.body?.concurrencies,
      maxTokens: req.body?.maxTokens,
      debug: benchDebug,
      apiKey: resolveLlmApiKey(spark, port),
      sampleHardware:
        benchDebug && monitor
          ? async () => {
              const fromGpu = (gpu, um) =>
                gpu
                  ? {
                      gpuUsage: gpu.usage ?? null,
                      temperature: gpu.temperature ?? null,
                      powerDraw: gpu.power?.draw ?? null,
                      powerLimit: gpu.power?.limit ?? null,
                      vramUsed: gpu.vram?.used ?? null,
                      vramTotal: gpu.vram?.total ?? null,
                      vramAvailable: gpu.vram?.available ?? null,
                      memAvailable: um?.available ?? null,
                    }
                  : null;

              // Local: fresh collect so the timeline isn't stuck on the 2s poll cache.
              // Remote: use snapshot only — SSH collectGpu every 1s is too heavy mid-bench.
              if (spark.isLocal) {
                try {
                  const [gpu, um] = await Promise.all([
                    monitor.collector.collectGpu(),
                    monitor.collector.collectUnifiedMemory(),
                  ]);
                  return fromGpu(gpu, um);
                } catch {
                  /* fall through */
                }
              }
              const snap = monitor.snapshot();
              return fromGpu(snap?.metrics?.gpu, snap?.metrics?.unifiedMemory);
            }
          : null,
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = decodeBenchManager.getActive(spark.id);
  const history = decodeBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = decodeBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: DECODE_BENCH_DEFAULTS,
  });
});

/** Clear finished bench history for a Spark (optional ?port=). Does not cancel a running job. */
app.delete("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  decodeBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job); // already public shape from manager
});

app.delete("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM Prompt Showcase — concurrent streaming demos.
 *
 * POST body: { port, modelId?, maxTokens?, temperature?, thinking?, promptType?, prompts: string[] }
 * Returns 202 { sessionId }; poll GET for deltas; DELETE :sessionId to cancel.
 * Finished runs are archived; GET collection lists history; DELETE collection clears it.
 */
app.post("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  if (req.body?.port == null) {
    return res.status(400).json({ error: "port is required" });
  }
  const port = Number(req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const result = showcaseManager.start({
      sparkId: spark.id,
      lanIp: spark.lanIp,
      llmHost: spark.llmHost || null,
      port,
      modelId,
      maxTokens: req.body?.maxTokens,
      temperature: req.body?.temperature,
      thinking: req.body?.thinking,
      promptType: req.body?.promptType,
      prompts: req.body?.prompts,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Active session + finished history summaries (no stream bodies). */
app.get("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  res.json({
    active: showcaseManager.getActive(spark.id),
    history: showcaseManager.getHistory(spark.id),
  });
});

/** Clear finished showcase history for a Spark. Does not cancel a running session. */
app.delete("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a showcase is running" });
  }
  showcaseManager.clearHistory(spark.id);
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const sinceRaw = req.query.since;
  const since =
    sinceRaw != null && sinceRaw !== ""
      ? parseInt(String(sinceRaw), 10)
      : null;
  const session = showcaseManager.getSession(
    spark.id,
    req.params.sessionId,
    Number.isInteger(since) ? since : null
  );
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

app.delete("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const session = showcaseManager.cancel(spark.id, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

// ─── Power management ────────────────────────────────────
// Shutdown uses host script: sudo -n /usr/local/bin/spark-shutdown (passwordless).
// These routes are unauthenticated like the rest of the LAN dashboard — do not
// expose port 5555 beyond a trusted network.

const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";
/**
 * Remote: verify script + passwordless sudo, then background shutdown so SSH
 * returns before the host dies. Failures before backgrounding surface to the UI.
 */
const SHUTDOWN_REMOTE_CMD = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  `sudo -n true || { echo "sudo -n required for ${SHUTDOWN_BIN}" >&2; exit 126; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("; ");

function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
function initiateSparkShutdown(spark) {
  if (spark.isLocal) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn("sudo", ["-n", SHUTDOWN_BIN], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          const msg = err.message || String(err);
          if (/ENOENT|not found/i.test(msg)) {
            reject(new Error(`${SHUTDOWN_BIN} not found on this host`));
          } else {
            reject(new Error(msg));
          }
        });
        child.unref();
        resolve("Shutdown initiated");
      } catch (err) {
        reject(err);
      }
    });
  }

  return sshExec(spark, SHUTDOWN_REMOTE_CMD, { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** Batch routes first so they never collide with /:id/* if routing changes. */

// ─── Model fleet status ──────────────────────────────────
const SWITCH_SCRIPT = process.env.SWITCH_SCRIPT || "/host/root/home/gilfoyle/switch-model.sh";
const CPA_STATUS_PATH = process.env.CPA_STATUS_PATH || "/host/root/home/gilfoyle/.cli-proxy-api/live-models-status.json";
const MODEL_HISTORY_PATH = path.join(ROOT, "config", "model-history.json");
const TOKEN_LIFETIMES_PATH = path.join(ROOT, "config", "token-lifetimes.json");

// ─── Model switch history ────────────────────────────────
const SWITCH_STATUS_PATH = path.join(ROOT, "config", ".switch-in-progress");

function readModelHistory() {
  try {
    if (fs.existsSync(MODEL_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(MODEL_HISTORY_PATH, "utf8"));
    }
  } catch { /* corrupt */ }
  return [];
}

function writeModelHistory(events) {
  try {
    atomicWrite(MODEL_HISTORY_PATH, JSON.stringify(events, null, 2), 0o600);
  } catch {}
}

function recordSwitchEvent(modelId, status, detail) {
  const events = readModelHistory();
  events.unshift({
    ts: new Date().toISOString(),
    model: modelId,
    status, // "started" | "completed" | "failed"
    detail: detail || null,
  });
  // Keep last 100 events
  if (events.length > 100) events.length = 100;
  writeModelHistory(events);
  return events[0];
}

/** Read CPA live-models-status.json (if it exists). */
function readCpaStatus() {
  try {
    if (fs.existsSync(CPA_STATUS_PATH)) {
      return JSON.parse(fs.readFileSync(CPA_STATUS_PATH, "utf8"));
    }
  } catch { /* not available yet */ }
  return null;
}

/** Run switch-model.sh status and return parsed output. */
function readSwitchStatus() {
  return new Promise((resolve) => {
    try {
      const child = spawn(SWITCH_SCRIPT, ["status"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        env: { ...process.env, TERM: "dumb" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        resolve({ ok: code === 0, stdout, stderr, code });
      });
      child.on("error", (err) => {
        resolve({ ok: false, stdout: "", stderr: err.message, code: -1 });
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: err.message, code: -1 });
    }
  });
}

/** Fuzzy-match a full model ID against the recipe list (e.g. 'deepseek-v4-flash-dspark' → 'dspark'). */
function findModelInfo(modelId, availableModels) {
  return availableModels.find(
    (m) => modelId.includes(m.id) || m.id.includes(modelId)
  ) || null;
}

/** List available model names from the switch script's help / known models. */
function getAvailableModels() {
  return [
    { id: "dspark", name: "DeepSeek V4 Flash DSpark", type: "shared", desc: "2-node TP=2 · 1M context", maxConcurrency: 6 },
    { id: "laguna", name: "Laguna S 2.1 NVFP4", type: "dual", desc: "Both Sparks, least-queue", maxConcurrency: 4 },
    { id: "laguna-anton", name: "Laguna S 2.1 (anton only)", type: "single", desc: "Single node", maxConcurrency: 2 },
    { id: "qwen", name: "Qwen3.6 Q8", type: "dual", desc: "Both Sparks, least-queue", maxConcurrency: 4 },
    { id: "qwen-anton", name: "Qwen3.6 Q8 (anton only)", type: "single", desc: "Single node", maxConcurrency: 2 },
  ];
}

app.get("/api/models/status", async (_req, res) => {
  const [switchStatus, cpaData] = await Promise.all([
    readSwitchStatus(),
    Promise.resolve(readCpaStatus()),
  ]);
  res.json({
    current: cpaData?.probe?.[0]?.ids?.[0] || null,
    cpa: cpaData,
    switchScript: switchStatus,
    available: getAvailableModels(),
  });
});

app.post("/api/models/switch", async (req, res) => {
  const model = req.body?.model;
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "model name required" });
  }
  const allowed = getAvailableModels().map((m) => m.id);
  if (!allowed.includes(model)) {
    return res.status(400).json({ error: `Unknown model: ${model}. Allowed: ${allowed.join(", ")}` });
  }
  const evt = recordSwitchEvent(model, "started", "Switching...");
  res.json({ ok: true, eventId: evt.ts, message: `Switching to ${model}...` });
  // Fire and forget — run the script in background
  const child = spawn(SWITCH_SCRIPT, [model], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, TERM: "dumb" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  child.on("close", (code) => {
    const succeeded = code === 0;
    recordSwitchEvent(model, succeeded ? "completed" : "failed",
      succeeded ? stdout.split("\n").filter(l => l.trim()).slice(-3).join(" | ") : stderr.slice(0, 200));
  });
  child.on("error", (err) => {
    recordSwitchEvent(model, "failed", err.message);
  });
  child.unref();
});

app.get("/api/models/history", async (_req, res) => {
  const events = readModelHistory();
  res.json({ events });
});

app.post("/api/models/switch-status", async (req, res) => {
  // Check if a switch is in progress by looking at the most recent "started" event
  const events = readModelHistory();
  const last = events[0];
  const inProgress = last && last.status === "started";
  res.json({ inProgress: !!inProgress, lastEvent: last || null });
});

app.post("/api/models/refresh", async (_req, res) => {
  const [switchStatus, cpaData] = await Promise.all([
    readSwitchStatus(),
    Promise.resolve(readCpaStatus()),
  ]);
  res.json({
    current: cpaData?.probe?.[0]?.ids?.[0] || null,
    cpa: cpaData,
    switchScript: switchStatus,
    available: getAvailableModels(),
  });
});

// ─── Per-model usage history ─────────────────────────────
function readTokenLifetimes() {
  try {
    if (fs.existsSync(TOKEN_LIFETIMES_PATH)) {
      return JSON.parse(fs.readFileSync(TOKEN_LIFETIMES_PATH, "utf8"));
    }
  } catch {}
  return {};
}

app.get("/api/models/usage", async (_req, res) => {
  const events = readModelHistory();
  const tokenLifetimes = readTokenLifetimes();

  // Collect live token counts from active LLM probes (current session + disk)
  const liveTokens = new Map();
  for (const [sparkId, mon] of monitors) {
    if (!mon.llmProbes) continue;
    for (const [port, probe] of mon.llmProbes) {
      const modelId = probe.modelId;
      if (!modelId) continue;
      const key = `${sparkId}:${port}:${modelId}`;
      if (!liveTokens.has(key)) {
        liveTokens.set(key, { input: 0, output: 0, isLive: false, maxRequests: 0, contextLength: null, totalRequests: 0 });
      }
      const t = liveTokens.get(key);
      // probe.totalInput/Output already includes disk accumulated + current raw
      t.input = Math.max(t.input, probe.totalInputTokens || 0);
      t.output = Math.max(t.output, probe.totalOutputTokens || 0);
      t.maxRequests = Math.max(t.maxRequests, probe.maxRequestsRunning || 0);
      if (probe.contextLength != null) t.contextLength = probe.contextLength;
      t.totalRequests = Math.max(t.totalRequests, probe.totalRequests || 0);
      t.isLive = true;
    }
  }

  // Merge live token data into the disk snapshot
  for (const [key, live] of liveTokens) {
    if (!tokenLifetimes[key]) {
      tokenLifetimes[key] = { input: 0, output: 0 };
    }
    // Use the live value (which includes disk accumulated + current session)
    tokenLifetimes[key].input = Math.max(tokenLifetimes[key].input, live.input);
    tokenLifetimes[key].output = Math.max(tokenLifetimes[key].output, live.output);
  }

  // Build per-model aggregate from events
  const modelMap = new Map();

  for (const evt of events) {
    if (!modelMap.has(evt.model)) {
      modelMap.set(evt.model, { switches: 0, lastSeen: null, lastStatus: null, completed: 0, failed: 0 });
    }
    const m = modelMap.get(evt.model);
    m.switches++;
    const ts = new Date(evt.ts).getTime();
    if (!m.lastSeen || ts > m.lastSeen) {
      m.lastSeen = ts;
      m.lastStatus = evt.status;
    }
    if (evt.status === "completed") m.completed++;
    if (evt.status === "failed") m.failed++;
  }

  // Attach lifetime token counts from token-lifetimes.json
  // Keys are sparkId:port:modelId
  const modelTokenTotals = new Map();
  for (const [key, counts] of Object.entries(tokenLifetimes)) {
    // key format: "anton:8888:deepseek-v4-flash-dspark"
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const modelId = parts.slice(2).join(":");
    if (!modelTokenTotals.has(modelId)) {
      modelTokenTotals.set(modelId, { totalInputTokens: 0, totalOutputTokens: 0 });
    }
    const t = modelTokenTotals.get(modelId);
    t.totalInputTokens += counts.input || 0;
    t.totalOutputTokens += counts.output || 0;
  }

  // Aggregate live probe metadata per model (max requests, context, total requests)
  const modelLiveMeta = new Map();
  for (const [key, live] of liveTokens) {
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const modelId = parts.slice(2).join(":");
    if (!modelLiveMeta.has(modelId)) {
      modelLiveMeta.set(modelId, { maxRequests: 0, contextLength: null, totalRequests: 0 });
    }
    const m = modelLiveMeta.get(modelId);
    m.maxRequests = Math.max(m.maxRequests, live.maxRequests || 0);
    if (live.contextLength != null) m.contextLength = live.contextLength;
    m.totalRequests = Math.max(m.totalRequests, live.totalRequests || 0);
  }

  // Available models list with rich info
  const availableModels = getAvailableModels();
  const modelInfo = new Map(availableModels.map((m) => [m.id, m]));

  const models = [];
  for (const [id, stats] of modelMap) {
    const info = modelInfo.get(id) || findModelInfo(id, availableModels);
    const tokens = modelTokenTotals.get(id);
    models.push({
      id,
      name: info?.name || id,
      type: info?.type || "unknown",
      desc: info?.desc || "",
      switches: stats.switches,
      completed: stats.completed,
      failed: stats.failed,
      lastSeen: stats.lastSeen,
      lastStatus: stats.lastStatus,
      totalInputTokens: tokens?.totalInputTokens || 0,
      totalOutputTokens: tokens?.totalOutputTokens || 0,
      maxRequests: modelLiveMeta.get(id)?.maxRequests || 0,
      contextLength: modelLiveMeta.get(id)?.contextLength || null,
      totalRequests: modelLiveMeta.get(id)?.totalRequests || 0,
      maxConcurrency: info?.maxConcurrency ?? null,
    });
  }

  // Add models that have token data but no switch events (first-time detection)
  for (const [id, tokens] of modelTokenTotals) {
    if (!modelMap.has(id)) {
      const info = modelInfo.get(id) || findModelInfo(id, availableModels);
      models.push({
        id,
        name: info?.name || id,
        type: info?.type || "unknown",
        desc: info?.desc || "",
        switches: 0,
        completed: 0,
        failed: 0,
        lastSeen: null,
        lastStatus: null,
        totalInputTokens: tokens.totalInputTokens,
        totalOutputTokens: tokens.totalOutputTokens,
        maxRequests: modelLiveMeta.get(id)?.maxRequests || 0,
        contextLength: modelLiveMeta.get(id)?.contextLength || null,
        totalRequests: modelLiveMeta.get(id)?.totalRequests || 0,
        maxConcurrency: info?.maxConcurrency ?? null,
      });
    }
  }

  // Sort by lastSeen descending, then by name
  models.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name));

  // Attach per-key usage data (top users) to each model
  const currentModelId = (await Promise.resolve(readCpaStatus()))?.probe?.[0]?.ids?.[0] || null;
  const allModelUsers = getAllModelUsers();

  for (const m of models) {
    // Find all tracked model data by matching both exact and normalized names
    const matchedKeys = [];
    for (const key of Object.keys(allModelUsers)) {
      if (key === m.id) {
        matchedKeys.push(key);
        continue;
      }
      // fuzzy match: "mimo-v2.5" matches "MiMo-V2.5-NVFP4"
      // Also handle "DeepSeek V4 Flash DSpark" vs "deepseek-v4-flash-dspark"
      const a = normalizeModelName(key);
      const b = normalizeModelName(m.id);
      if (a === b) {
        matchedKeys.push(key);
        continue;
      }
      // Also check if key is a substring of b or vice versa
      if (a.includes(b) || b.includes(a)) {
        matchedKeys.push(key);
      }
    }

    // Merge users from all matched keys, combining usage for same user
    const mergedUsers = [];
    const userMap = new Map();
    let totalTokens = 0;
    for (const mk of matchedKeys) {
      const data = allModelUsers[mk];
      if (!data || !data.users) continue;
      totalTokens += data.totalTokens || 0;
      for (const user of data.users) {
        const userKey = user.apiKeyPrefix || user.label || user.clientIp;
        if (userMap.has(userKey)) {
          const existing = userMap.get(userKey);
          existing.requests += user.requests;
          existing.promptTokens += user.promptTokens;
          existing.completionTokens += user.completionTokens;
          existing.totalTokens += user.totalTokens;
          existing.lastSeen = Math.max(existing.lastSeen || 0, user.lastSeen || 0);
        } else {
          userMap.set(userKey, { ...user });
        }
      }
    }
    mergedUsers.push(...userMap.values());
    mergedUsers.sort((a, b) => b.totalTokens - a.totalTokens);

    if (mergedUsers.length > 0) {
      m.topUsers = mergedUsers;
      m.totalClientRequests = totalTokens;
    } else {
      m.topUsers = [];
      m.totalClientRequests = 0;
    }
  }

  res.json({ models, current: currentModelId });
});

app.post("/api/sparks/shutdown-all", async (_req, res) => {
  const results = [];
  // Remotes first, local last — shutting down the dashboard host mid-loop would
  // skip remaining Sparks.
  const ordered = [
    ...registry.sparks.filter((s) => !s.isLocal),
    ...registry.sparks.filter((s) => s.isLocal),
  ];
  for (const spark of ordered) {
    const monitor = monitors.get(spark.id);
    if (!monitor?.online) {
      results.push({ id: spark.id, ok: false, skipped: true, error: "Offline — skipped" });
      continue;
    }
    try {
      // Local dashboard host: acknowledge before power-off kills this process.
      if (spark.isLocal) {
        results.push({ id: spark.id, ok: true, message: "Shutdown initiated" });
        setImmediate(() => {
          void initiateSparkShutdown(spark).catch((err) => {
            console.error(`[shutdown-all] local ${spark.id}:`, err.message);
          });
        });
        continue;
      }
      await initiateSparkShutdown(spark);
      results.push({ id: spark.id, ok: true });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/wake-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      results.push({
        id: spark.id,
        ok: false,
        error: "No MAC address (enP7s7 not seen yet; set override in Edit Spark)",
      });
      continue;
    }
    try {
      const broadcast = broadcastForLanIp(spark.lanIp);
      const sent = await sendWol(cleanMac, broadcast);
      results.push({ id: spark.id, ok: true, mac: sent.mac, broadcast: sent.broadcast });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/:id/shutdown", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Local: send JSON first, then power off — otherwise the process dies mid-response
    // and the UI shows "Failed to fetch".
    if (spark.isLocal) {
      res.json({ success: true, message: "Shutdown initiated" });
      setImmediate(() => {
        void initiateSparkShutdown(spark).catch((err) => {
          console.error(`[shutdown] local ${spark.id}:`, err.message);
        });
      });
      return;
    }

    try {
      const message = await initiateSparkShutdown(spark);
      res.json({ success: true, message, output: message });
    } catch (err) {
      const msg = err.message || String(err);
      res.status(shutdownErrorStatus(msg)).json({
        error: shutdownErrorStatus(msg) === 503 ? `Spark unreachable: ${msg}` : msg,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks/:id/wake", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Body mac > user override > auto-detected enP7s7
    const cleanMac = normalizeMac(req.body?.mac) || effectiveMac(spark);
    if (!cleanMac) {
      if (req.body?.mac || spark.macAddress) {
        return res.status(400).json({
          error: `Invalid MAC address: ${req.body?.mac || spark.macAddress}`,
        });
      }
      return res.status(400).json({
        error:
          "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.",
      });
    }

    const broadcast = broadcastForLanIp(spark.lanIp);
    try {
      const sent = await sendWol(cleanMac, broadcast);
      res.json({
        success: true,
        message: `Magic packet sent to ${sent.mac} via ${sent.broadcast}`,
        mac: sent.mac,
        broadcast: sent.broadcast,
      });
    } catch (err) {
      res.status(500).json({ error: `WoL send failed: ${err.message || String(err)}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files (built frontend) ───────────────────────
const distDir = path.join(ROOT, "dist");
const indexHtml = path.join(distDir, "index.html");
app.use(express.static(distDir));

// ─── SPA fallback (Express v5 wildcard) ───────────────────
app.get("*splat", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .type("text")
      .send("Frontend not built. Run `npm run build` or use `npm run dev`.");
  }
  res.sendFile(indexHtml);
});

// ─── WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  // Send the initial snapshot through the same path the broadcast uses so the
  // new client benefits from the same payload format (and bufferedAmount
  // guard, although a freshly-open socket trivially passes it).
  broadcastPayload(buildSnapshotPayload());
  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ─── Broadcast snapshot (dynamic interval) ────────────────
let broadcastTimer = null;
let _lastBroadcastPayload = null;

/** Build the snapshot payload string. Centralized so broadcast + refresh share it. */
function buildSnapshotPayload() {
  return JSON.stringify({
    type: "snapshot",
    sparks: orderedSnapshots(),
    refreshInterval: getSettings().pollIntervalMs,
  });
}

/**
 * Send a payload to every open WS client.
 * - Drops clients whose send queue is backlogged (>1 MB) to avoid unbounded
 *   buffering on slow/flaky connections (e.g. phone over spotty WiFi).
 * - Returns the payload so callers can compare against the previous broadcast.
 */
function broadcastPayload(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // OPEN only
    if (client.bufferedAmount > 1_000_000) {
      try {
        client.close(1008, "client too slow");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.send(payload);
    } catch {
      /* per-client send failure — ignore, close handler will clean up */
    }
  });
}

function startBroadcast() {
  const interval = getSettings().pollIntervalMs;
  broadcastTimer = setInterval(() => {
    const payload = buildSnapshotPayload();
    // Skip the broadcast entirely when nothing changed since the last tick.
    // A 1s poll that produces identical snapshots becomes free for idle tabs.
    if (_lastBroadcastPayload !== null && payload === _lastBroadcastPayload) return;
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
  }, interval);
}

function restartBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  _lastBroadcastPayload = null; // force a fresh broadcast on the new cadence
  startBroadcast();
}

// ─── Start ───────────────────────────────────────────────
loadSettings();
startBroadcast();
startPerKeyTracking();

server.listen(PORT, BIND_HOST, () => {
  console.log(`[sparkDash] server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[sparkDash] WebSocket endpoint ws://${BIND_HOST}:${PORT}/ws`);
  startAllMonitors();
});

// ─── Graceful shutdown ─────────────────────────────────
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[sparkDash] ${signal} received, shutting down…`);
  try {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
    for (const m of monitors.values()) m.stop();
    monitors.clear();
    stopPerKeyTracking();
  } catch (err) {
    console.error("[sparkDash] error during shutdown:", err.message);
  }
  // Tell WS clients the server is going away, then close the server.
  try {
    wss.clients.forEach((c) => {
      try {
        c.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  wss.close();
  server.close(() => process.exit(0));
  // Safety net: if server.close hangs (lingering keep-alive), force-exit.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, wss };
