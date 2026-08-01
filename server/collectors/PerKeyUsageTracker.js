/**
 * PerKeyUsageTracker — tracks per-client per-model token usage by correlating
 * CPA's gin_logger (client IP) with v1-chat-completions request logs (tokens).
 *
 * Architecture:
 *
 *   gin_logger (main.log):
 *     [ts] [TRACE_ID] [info] [gin_logger.go:97] STATUS | DURATION | CLIENT_IP | METHOD "PATH"
 *
 *   v1-chat-completions log files  (per-request, in .cli-proxy-api/logs/):
 *     Filename: v1-chat-completions-TIMESTAMP-TRACE_ID.log
 *     Contains: request body (model), response body (usage.prompt/completion_tokens)
 *
 *   Merge: trace ID bridges both logs → (clientIp, model, tokens)
 *
 * Data stored in config/per-key-usage.json:
 *   { models: { modelId: { users: { clientIp: { requests, promptTokens, completionTokens, lastSeen } } } } }
 */
import fs from "fs";
import path from "path";
import { HOST_PATHS, ROOT } from "../config.js";

// ─── Paths ────────────────────────────────────────────────

/** CPA main log (inside Docker, host filesystem mounted at HOST_PATHS.ROOT). */
const CPA_LOG_PATH = process.env.CPA_LOG_PATH ||
  path.join(HOST_PATHS.ROOT, "home/gilfoyle/cliproxyapi/logs/main.log");

/** CPA per-request log directory (v1-chat-completions-*.log files). */
const CPA_REQUEST_LOG_DIR = process.env.CPA_REQUEST_LOG_DIR ||
  path.join(HOST_PATHS.ROOT, "home/gilfoyle/.cli-proxy-api/logs");

/** Config directory for per-key usage data. */
const PER_KEY_USAGE_PATH = process.env.PER_KEY_USAGE_PATH ||
  path.join(ROOT, "config", "per-key-usage.json");

// ─── Regex patterns ──────────────────────────────────────

/**
 * Gin log entry format:
 * [2026-07-30 10:32:12] [054e62f9] [info ] [gin_logger.go:97] 200 | 258ms | 127.0.0.1 | POST "/v1/chat/completions"
 */
const GIN_LOG_RE = /^\[[^\]]+\] \[([a-f0-9]+)\] \[info \] \[gin_logger\.go:97\] (\d+) \s*\|\s+[\d.]+\w*s?\s+\|\s+([\d.]+)\s+\|\s+(GET|POST|PUT|PATCH|DELETE)\s+"([^"]*)"/m;

/** Filename pattern: v1-chat-completions-TIMESTAMP-TRACE_ID.log */
const REQ_LOG_FILENAME_RE = /^v1-chat-completions-.+-([a-f0-9]+)\.log$/;

// ─── State ────────────────────────────────────────────────

/** traceId → { clientIp, ts } from gin_logger */
let _traceToClient = new Map();

/**
 * modelId → { clientIp → { requests, promptTokens, completionTokens, lastSeen } }
 * Initialized from disk on startup, updated by request log parsing.
 */
let _modelUsage = { models: {} };

/** Byte offset in main.log for incremental reads. */
let _lastGinOffset = 0;

/** Set of already-processed v1-chat-completions log filenames. */
let _processedFiles = new Set();

/** Last save timestamp (debounce). */
let _lastSave = 0;

// ─── Disk I/O ─────────────────────────────────────────────

function ensureDir(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadUsageData() {
  try {
    if (fs.existsSync(PER_KEY_USAGE_PATH)) {
      const raw = fs.readFileSync(PER_KEY_USAGE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.models === "object") {
        _modelUsage = parsed;
      }
    }
  } catch { /* corrupt or missing */ }
}

function saveUsageData() {
  try {
    const now = Date.now();
    if (now - _lastSave < 30_000) return; // debounce
    _lastSave = now;
    ensureDir(PER_KEY_USAGE_PATH);
    fs.writeFileSync(PER_KEY_USAGE_PATH + ".tmp", JSON.stringify(_modelUsage, null, 2), "utf8");
    fs.renameSync(PER_KEY_USAGE_PATH + ".tmp", PER_KEY_USAGE_PATH);
  } catch (err) {
    console.error("[PerKeyUsageTracker] save failed:", err.message);
  }
}

// ─── Load processed-file set from saved state ─────────────

function loadProcessedSet() {
  const statePath = path.join(ROOT, "config", ".per-key-state.json");
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, "utf8");
      const state = JSON.parse(raw);
      if (Array.isArray(state.processedFiles)) {
        _processedFiles = new Set(state.processedFiles);
      }
      if (typeof state.lastGinOffset === "number") {
        _lastGinOffset = state.lastGinOffset;
      }
    }
  } catch { /* ignore */ }
}

function saveProcessedSet() {
  try {
    const statePath = path.join(ROOT, "config", ".per-key-state.json");
    const state = {
      processedFiles: Array.from(_processedFiles).slice(-10000), // keep last 10k
      lastGinOffset: _lastGinOffset,
    };
    fs.writeFileSync(statePath + ".tmp", JSON.stringify(state), "utf8");
    fs.renameSync(statePath + ".tmp", statePath);
  } catch { /* ignore */ }
}

// ─── Gin log parser ───────────────────────────────────────

/**
 * Read new gin_logger entries and build traceId → clientIp map.
 * Incremental from _lastGinOffset.
 */
function pollGinLogger() {
  try {
    if (!fs.existsSync(CPA_LOG_PATH)) return;

    const stats = fs.statSync(CPA_LOG_PATH);

    if (stats.size < _lastGinOffset) {
      // Log was rotated — reset
      _lastGinOffset = 0;
      _traceToClient.clear();
    }

    if (stats.size === _lastGinOffset) return;

    const fd = fs.openSync(CPA_LOG_PATH, "r");
    const bufSize = stats.size - _lastGinOffset;
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, _lastGinOffset);
    fs.closeSync(fd);

    const oldOffset = _lastGinOffset;
    _lastGinOffset = stats.size;

    const text = buf.toString("utf8");
    const lines = text.split("\n");

    let parsed = 0;
    for (const line of lines) {
      const m = line.match(GIN_LOG_RE);
      if (!m) continue;
      const traceId = m[1];
      const clientIp = m[3];
      // Only track chat completions
      if (m[5].includes("/v1/chat/completions") || m[5].includes("/v1/completions")) {
        _traceToClient.set(traceId, { clientIp, ts: Date.now() });
        parsed++;
      }
    }

    // Prune old entries (keep last 10k or entries older than 5 min)
    const cutoff = Date.now() - 300_000;
    for (const [id, entry] of _traceToClient) {
      if (entry.ts < cutoff) _traceToClient.delete(id);
    }
    if (_traceToClient.size > 10000) {
      // Keep the newest 10000
      const sorted = Array.from(_traceToClient.entries()).sort((a, b) => b[1].ts - a[1].ts);
      _traceToClient = new Map(sorted.slice(0, 10000));
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[PerKeyUsageTracker] gin_logger poll error:", err.message);
    }
  }
}

// ─── Request log parser ───────────────────────────────────

/**
 * Parse a v1-chat-completions-*.log file for model + token usage
 * and optional user-identifying header.
 *
 * CPA logs all incoming request headers (except masked Authorization).
 * If clients send X-User or X-User-Id, we extract it here.
 */
function parseRequestLog(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Extract model from request body: "model":"deepseek-v4-flash-dspark"
    const modelMatch = content.match(/"model"\s*:\s*"([^"]+)"/);
    if (!modelMatch) return null;
    const model = modelMatch[1];

    // Extract user label from incoming request headers (=== HEADERS === section)
    // Look for X-User or X-User-Id in the header block between === HEADERS === and === REQUEST BODY ===
    let userLabel = null;
    const headersSection = content.match(/=== HEADERS ===\n([\s\S]*?)\n\n=== REQUEST BODY ===/);
    if (headersSection) {
      const headerLines = headersSection[1].split("\n");
      for (const line of headerLines) {
        const m = line.match(/^(X-User(?:-Id)?):\s*(.+)$/);
        if (m) {
          userLabel = m[2].trim();
          break;
        }
      }
    }

    // Find the "usage": block — handle both field orders:
    // vLLM: {"prompt_tokens":N,"total_tokens":N,"completion_tokens":N}
    // llama.cpp: {"completion_tokens":N,"prompt_tokens":N,"total_tokens":N}
    let promptTokens = 0;
    let completionTokens = 0;
    const usageMatch = content.match(/"usage"\s*:\s*\{[^}]*"prompt_tokens"\s*:\s*(\d+)[^}]*"completion_tokens"\s*:\s*(\d+)[^}]*\}/);
    if (usageMatch) {
      promptTokens = parseInt(usageMatch[1], 10);
      completionTokens = parseInt(usageMatch[2], 10);
    } else {
      // Try llama.cpp order: completion_tokens before prompt_tokens
      const usageMatch2 = content.match(/"usage"\s*:\s*\{[^}]*"completion_tokens"\s*:\s*(\d+)[^}]*"prompt_tokens"\s*:\s*(\d+)[^}]*\}/);
      if (!usageMatch2) return null;
      completionTokens = parseInt(usageMatch2[1], 10);
      promptTokens = parseInt(usageMatch2[2], 10);
    }

    return { model, promptTokens, completionTokens, userLabel };
  } catch {
    return null;
  }
}

/**
 * Scan the CPA request log directory for new v1-chat-completions-*.log files
 * and parse them, correlating with the gin_logger trace map.
 */
function pollRequestLogs() {
  try {
    if (!fs.existsSync(CPA_REQUEST_LOG_DIR)) return;

    const files = fs.readdirSync(CPA_REQUEST_LOG_DIR);
    let newFiles = 0;

    for (const fname of files) {
      if (!fname.startsWith("v1-chat-completions-") || !fname.endsWith(".log")) continue;
      if (_processedFiles.has(fname)) continue;

      const traceMatch = fname.match(REQ_LOG_FILENAME_RE);
      if (!traceMatch) continue;
      const traceId = traceMatch[1];

      const parsed = parseRequestLog(path.join(CPA_REQUEST_LOG_DIR, fname));
      if (!parsed) {
        // No usage block yet — this file is still in-flight.
        // Don't add to _processedFiles; leave it for getActiveUsers() to detect.
        continue;
      }

      // Look up client IP from gin_logger trace map
      let clientIp = "unknown";
      const traceEntry = _traceToClient.get(traceId);
      if (traceEntry) {
        clientIp = traceEntry.clientIp;
      }

      // Use userLabel as the user key if available (from X-User header),
      // falling back to clientIp. This merges requests from the same user
      // even when they connect from different IPs.
      const userKey = parsed.userLabel || clientIp;

      // Accumulate
      if (!_modelUsage.models[parsed.model]) {
        _modelUsage.models[parsed.model] = { users: {} };
      }
      if (!_modelUsage.models[parsed.model].users[userKey]) {
        _modelUsage.models[parsed.model].users[userKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          lastSeen: 0,
          userLabel: parsed.userLabel || null,
          clientIp,
        };
      }
      const u = _modelUsage.models[parsed.model].users[userKey];
      u.requests++;
      // Track raw/unadjusted prompt_tokens as reported per-request.
      // No delta logic — each request's usage.prompt_tokens is recorded
      // directly. This gives the total input volume through the proxy.
      u.promptTokens += parsed.promptTokens;
      u.completionTokens += parsed.completionTokens;
      u.lastSeen = Date.now();

      _processedFiles.add(fname);
      newFiles++;
    }

    if (newFiles > 0) {
      saveUsageData();
      saveProcessedSet();
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[PerKeyUsageTracker] request log poll error:", err.message);
    }
  }
}

// ─── Public API ──────────────────────────────────────────

let _pollTimer = null;
let _saveTimer = null;

/**
 * Start periodic polling.
 * @param {number} pollIntervalMs (default 10s)
 */
export function startPerKeyTracking(pollIntervalMs = 10_000) {
  if (_pollTimer) return;

  loadUsageData();
  loadProcessedSet();

  // Initial parse
  pollGinLogger();
  pollRequestLogs();

  _pollTimer = setInterval(() => {
    pollGinLogger();
    pollRequestLogs();
  }, pollIntervalMs);

  // Periodic save regardless of activity
  _saveTimer = setInterval(() => {
    saveUsageData();
    saveProcessedSet();
  }, 60_000);

  console.log(`[PerKeyUsageTracker] started (poll=${pollIntervalMs}ms)`);
}

export function stopPerKeyTracking() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_saveTimer) {
    clearInterval(_saveTimer);
    _saveTimer = null;
  }
  saveUsageData();
  saveProcessedSet();
}

/**
 * Normalize model name for comparison.
 * CPA request logs use lowercase model names like "mimo-v2.5" while
 * vLLM health probe returns "MiMo-V2.5-NVFP4". This function strips
 * prefixes like "mi" and suffixes like "-NVFP4" to create a base
 * model identifier for fuzzy matching.
 */
function normalizeModelName(name) {
  if (!name) return "";
  // strip trailing quantization suffixes (e.g., -NVFP4, -DSpark)
  let base = name.replace(/-(?:NVFP4|DSpark|FP16|INT4|INT8|GPTQ|AWQ)$/i, "");
  // strip trailing -anton (regional variant)
  base = base.replace(/-anton$/i, "");
  return base.toLowerCase();
}

/**
 * Given a tracked model name (e.g., "mimo-v2.5"), check if
 * the target model (e.g., "MiMo-V2.5-NVFP4") is the same model.
 */
function modelsMatch(tracked, target) {
  if (!tracked || !target) return false;
  const a = normalizeModelName(tracked);
  const b = normalizeModelName(target);
  if (a === b) return true;
  // substring match (e.g., "mimo-v2.5" in "MiMo-V2.5-NVFP4")
  return a.includes(b) || b.includes(a);
}

/**
 * Get per-model top users for a specific model (exact match).
 * @param {string|null} currentModelId
 * @returns {{ users: Array, totalRequests: number }}
 */
export function getTopUsers(currentModelId) {
  if (!currentModelId) return { users: [], totalRequests: 0 };

  const modelData = _modelUsage.models[currentModelId];
  if (!modelData) return { users: [], totalRequests: 0 };

  const users = Object.entries(modelData.users)
    .map(([userKey, stats]) => ({
      clientIp: stats.clientIp || userKey,
      label: stats.userLabel || (userKey === "127.0.0.1" ? "localhost" : userKey),
      apiKeyPrefix: stats.userLabel || null,
      requests: stats.requests,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.promptTokens + stats.completionTokens,
      lastSeen: stats.lastSeen,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalRequests = users.reduce((s, u) => s + u.requests, 0);
  const totalTokens = users.reduce((s, u) => s + u.totalTokens, 0);

  return { users: users.slice(0, 10), totalRequests, totalTokens };
}

/**
 * Get all tracked models and their per-user usage data.
 * Returns a map from model-name (tracked) → { users, totalRequests, totalTokens }.
 * Used by the API to attach per-key users to all models in the table.
 */
export function getAllModelUsers() {
  const result = {};
  for (const [modelName, modelData] of Object.entries(_modelUsage.models)) {
    const users = Object.entries(modelData.users)
      .map(([userKey, stats]) => ({
        clientIp: stats.clientIp || userKey,
        label: stats.userLabel || (userKey === "127.0.0.1" ? "localhost" : userKey),
        apiKeyPrefix: stats.userLabel || null,
        requests: stats.requests,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        totalTokens: stats.promptTokens + stats.completionTokens,
        lastSeen: stats.lastSeen,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const totalRequests = users.reduce((s, u) => s + u.requests, 0);
    const totalTokens = users.reduce((s, u) => s + u.totalTokens, 0);

    result[modelName] = { users: users.slice(0, 10), totalRequests, totalTokens };
  }
  return result;
}

/**
 * Get users with active (in-flight) requests by polling the auth-proxy's
 * /inflight endpoint.
 *
 * The auth-proxy (port 8317) intercepts every request to CPA, injects the
 * X-User header, and maintains a real-time counter of in-flight requests
 * per user. This is the ground-truth source: a request is "in-flight" from
 * the moment the proxy accepts it until the last byte of the response is sent.
 *
 * No cache needed — this is a lightweight HTTP GET to localhost.
 *
 * @returns {{ label: string, requests: number }[]}
 */
export async function getActiveUsers() {
  try {
    const resp = await fetch("http://127.0.0.1:8317/inflight", {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];
    const result = await resp.json();
    // Result format: { prefix: { waiting: N, active: M } }
    // Return flat list with status + overall running/waiting counts
    const users = [];
    let totalRunning = 0;
    let totalWaiting = 0;
    for (const [label, counts] of Object.entries(result)) {
      const waiting = counts.waiting || 0;
      const active = counts.active || 0;
      const inputBytes = counts.inputBytes || 0;
      totalWaiting += waiting;
      totalRunning += active;
      const total = waiting + active;
      if (total > 0) {
        users.push({ label, requests: total, waiting: waiting > 0, inputBytes });
      }
    }
    // Attach aggregated counts so the snapshot can use them
    users._totalRunning = totalRunning;
    users._totalWaiting = totalWaiting;
    return users.sort((a, b) => b.requests - a.requests);
  } catch (err) {
    return [];
  }
}

export function getKnownApiKeys() {
  return [];
}

// Exported for testing
export function _resetForTest() {
  _modelUsage = { models: {} };
  _traceToClient = new Map();
  _processedFiles = new Set();
  _lastGinOffset = 0;
}
