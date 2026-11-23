#!/usr/bin/env node
/**
 * Fake auth-proxy `/inflight` for the request-activity E2E (t_98955a1d).
 *
 * Serves the LEGACY shape the production proxy returns today
 * (`{ users: { <label>: { requests: [...] } }, recent: [...] }`, no schemaVersion)
 * or, with mode "v2", the schema-v2 shape (`schemaVersion`, `bootId`, flat
 * `requests[]`, `recent[].outcome`). Driven over HTTP so the Playwright spec
 * can start/finish requests and simulate an outage:
 *
 *   POST /_ctl/start   { id, user, model, phase?, promptEstTokens?, maxTokens?, sparkId? }
 *   POST /_ctl/stream  { id, completionEstTokens? }          waiting -> streaming
 *   POST /_ctl/finish  { id, outcome? }                       open -> recent ring (outcome only in v2)
 *   POST /_ctl/mode    { mode: "legacy" | "v2" | "down" }     "down" answers HTTP 503
 *   POST /_ctl/reset
 *
 * Usage: FAKE_INFLIGHT_PORT=18317 node tests/fixtures/fake-inflight.mjs
 */
import http from "node:http";

const PORT = Number(process.env.FAKE_INFLIGHT_PORT || 18317);
const RECENT_MAX = 5;

let mode = "legacy";
let open = new Map();
let recent = [];

const nowSec = () => Date.now() / 1000;

function publicReq(r) {
  const now = nowSec();
  return {
    id: r.id,
    user: r.user,
    phase: r.phase,
    model: r.model,
    maxTokens: r.maxTokens ?? null,
    promptEstTokens: r.promptEstTokens ?? null,
    completionEstTokens: r.completionEstTokens ?? null,
    promptSource: "estimate",
    completionSource: r.completionEstTokens != null ? "stream" : null,
    startedAt: r.startedAt,
    ageSec: Math.round((now - r.startedAt) * 10) / 10,
    backend: null,
    sparkId: r.sparkId ?? null,
    // Must never reach the UI.
    path: "/v1/chat/completions",
  };
}

function payload() {
  const users = {};
  for (const r of open.values()) {
    const u = (users[r.user] ??= { waiting: 0, active: 0, inputBytes: 0, requests: [] });
    if (r.phase === "waiting") u.waiting++;
    else u.active++;
    u.requests.push(publicReq(r));
  }
  const rec = recent.map((r) => {
    const row = { ...publicReq(r), finishedAt: r.finishedAt, durationSec: Math.round((r.finishedAt - r.startedAt) * 100) / 100 };
    if (mode === "v2") row.outcome = r.outcome ?? "completed";
    return row;
  });
  if (mode === "v2") {
    const requests = [...open.values()].map((r) => ({
      ...publicReq(r),
      state: r.phase === "waiting" ? "queued" : "streaming",
    }));
    return { schemaVersion: 2, generatedAt: nowSec(), bootId: "fake-boot-1", requests, users, recent: rec };
  }
  return { users, recent: rec };
}

function body(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && req.url === "/inflight") {
    if (mode === "down") return send(503, { error: "down" });
    return send(200, payload());
  }
  if (req.method === "POST" && req.url?.startsWith("/_ctl/")) {
    const b = await body(req);
    const op = req.url.slice("/_ctl/".length);
    if (op === "start") {
      open.set(String(b.id), {
        id: String(b.id),
        user: b.user,
        model: b.model,
        phase: b.phase ?? "waiting",
        promptEstTokens: b.promptEstTokens ?? null,
        maxTokens: b.maxTokens ?? null,
        completionEstTokens: null,
        sparkId: b.sparkId ?? null,
        startedAt: nowSec() - (b.ageSec ?? 0),
      });
    } else if (op === "stream") {
      const r = open.get(String(b.id));
      if (r) {
        r.phase = "streaming";
        if (b.completionEstTokens != null) r.completionEstTokens = b.completionEstTokens;
      }
    } else if (op === "finish") {
      const r = open.get(String(b.id));
      if (r) {
        open.delete(r.id);
        recent = [{ ...r, finishedAt: nowSec(), outcome: b.outcome }, ...recent].slice(0, RECENT_MAX);
      }
    } else if (op === "mode") {
      mode = b.mode;
    } else if (op === "reset") {
      open = new Map();
      recent = [];
      mode = "legacy";
    } else {
      return send(404, { error: "unknown op" });
    }
    return send(200, { ok: true, mode, open: open.size, recent: recent.length });
  }
  send(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-inflight] listening on 127.0.0.1:${PORT}`);
});
