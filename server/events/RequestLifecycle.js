import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";

const OUTCOME_TEXT = {
  completed: "completed",
  upstream_error: "upstream error",
  client_disconnect: "client disconnected",
  cancelled: "cancelled",
  upstream_unreachable: "upstream unreachable",
  unknown: "unknown",
};
const WRITE_DEBOUNCE_MS = 1500;

function safeLog(method, ...args) {
  try {
    console[method](...args);
  } catch {
    /* logging must not interrupt polling */
  }
}

export class RequestLifecycleTracker {
  constructor({
    record,
    resolveSparkId,
    sparkName = (id) => id,
    now = Date.now,
    file = null,
    maxActive = 500,
    maxEndedIds = 2000,
    staleAfterMs = 15000,
  } = {}) {
    this._record = typeof record === "function" ? record : () => null;
    this._resolveSparkId = typeof resolveSparkId === "function" ? resolveSparkId : () => null;
    this._sparkName = typeof sparkName === "function" ? sparkName : (id) => id;
    this._now = now;
    this.file = file;
    this.maxActive = Math.max(0, Math.floor(maxActive) || 0);
    this.maxEndedIds = Math.max(0, Math.floor(maxEndedIds) || 0);
    this.staleAfterMs = staleAfterMs;
    this._active = new Map();
    this._ended = new Set();
    this._status = "unknown";
    this._fetchedAt = null;
    this._lastOkAt = null;
    this._firstOkAt = null;
    this._bootId = null;
    this._unattributedCount = 0;
    this._overflowCount = 0;
    this._lastEventId = null;
    this._seq = 0;
    this._loadedStale = false;
    this._timer = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed?.active)) {
        for (const item of parsed.active) {
          if (!item || item.rawId == null) continue;
          const rawId = String(item.rawId);
          if (this._active.size >= this.maxActive) break;
          this._active.set(rawId, {
            key: `rq${++this._seq}`,
            rawId,
            startedAt: Number.isFinite(item.startedAt) ? item.startedAt : this._now(),
            label: item.label ?? null,
            model: item.model ?? null,
            lifecycle: item.lifecycle === "pending" ? "pending" : "active",
            promptEstTokens: item.promptEstTokens ?? null,
            completionEstTokens: item.completionEstTokens ?? null,
            maxTokens: item.maxTokens ?? null,
            sparkId: item.sparkId == null ? null : String(item.sparkId),
            lastSeenAt: Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : this._now(),
          });
        }
      }
      if (Array.isArray(parsed?.ended)) {
        for (const id of parsed.ended) this._addEnded(String(id));
      }
      this._bootId = parsed?.bootId ?? null;
      this._firstOkAt = Number.isFinite(parsed?.firstOkAt) ? parsed.firstOkAt : null;
      this._lastEventId = parsed?.lastEventId ?? null;
      this._loadedStale = this._active.size > 0;
      if (this._loadedStale) this._status = "ok";
    } catch (err) {
      if (err?.code !== "ENOENT") safeLog("warn", "[RequestLifecycle] state load failed:", err?.message);
    }
  }

  _addEnded(rawId) {
    if (this.maxEndedIds === 0) return;
    this._ended.delete(rawId);
    this._ended.add(rawId);
    while (this._ended.size > this.maxEndedIds) this._ended.delete(this._ended.values().next().value);
  }

  _schedulePersist() {
    if (!this.file) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  _persist() {
    if (!this.file || !this._dirty) return;
    try {
      const state = {
        active: [...this._active.values()].map(({ key, ...entry }) => entry),
        ended: [...this._ended],
        bootId: this._bootId,
        firstOkAt: this._firstOkAt,
        lastEventId: this._lastEventId,
      };
      atomicWrite(this.file, JSON.stringify(state), 0o600);
      this._dirty = false;
    } catch (err) {
      safeLog("error", "[RequestLifecycle] persist failed:", err?.message);
    }
  }

  flush() {
    try {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this._persist();
    } catch (err) {
      safeLog("error", "[RequestLifecycle] flush failed:", err?.message);
    }
  }

  _makeEntry(request, fetchedAt, rawId, lifecycle = "active") {
    const startedAt = request.startedAt != null
      ? Number(request.startedAt) * 1000
      : request.ageSec != null
        ? fetchedAt - Number(request.ageSec) * 1000
        : fetchedAt;
    let sparkId = null;
    try {
      const resolved = this._resolveSparkId(request);
      sparkId = resolved == null ? null : String(resolved);
    } catch {
      sparkId = null;
    }
    return {
      key: `rq${++this._seq}`,
      rawId,
      startedAt: Number.isFinite(startedAt) ? startedAt : fetchedAt,
      label: request.user ?? request.label ?? null,
      model: request.model ?? null,
      lifecycle,
      promptEstTokens: request.promptEstTokens ?? null,
      completionEstTokens: request.completionEstTokens ?? null,
      maxTokens: request.maxTokens ?? null,
      sparkId,
      lastSeenAt: fetchedAt,
    };
  }

  _end(entry, recent, endReason) {
    const outcome = recent && typeof recent.outcome === "string" && recent.outcome
      ? recent.outcome
      : "unknown";
    const promptEstTokens = recent?.promptEstTokens ?? entry.promptEstTokens;
    const completionEstTokens = recent?.completionEstTokens ?? entry.completionEstTokens;
    const maxTokens = recent?.maxTokens ?? entry.maxTokens;
    const endedAt = recent?.finishedAt != null ? Number(recent.finishedAt) * 1000 : this._fetchedAt;
    const endedAtApprox = recent?.finishedAt == null;
    const durationSec = recent?.durationSec ?? null;
    const sparkLabel = entry.sparkId ? this._sparkName(entry.sparkId) : "Unattributed";
    const event = {
      type: "request.ended",
      severity: outcome === "completed" ? "success" : outcome === "unknown" ? "info" : "warn",
      sparkId: entry.sparkId,
      sparkName: entry.sparkId ? this._sparkName(entry.sparkId) : null,
      message: `${sparkLabel}: LLM request finished · ${entry.label || "unknown key"} · ${entry.model || "unknown model"} · outcome ${OUTCOME_TEXT[outcome] ?? outcome}`,
      data: {
        kind: "llm-request",
        lifecycle: "completed",
        outcome,
        outcomeKnown: outcome !== "unknown",
        label: entry.label,
        model: entry.model,
        promptEstTokens,
        completionEstTokens,
        maxTokens,
        startedAt: entry.startedAt,
        endedAt,
        endedAtApprox,
        durationSec,
        attributed: entry.sparkId != null,
        sourceStatus: this._status,
        endReason,
      },
    };
    let stored = null;
    try {
      stored = this._record(event, { dedupe: false });
    } catch {
      stored = null;
    }
    if (stored && stored.id != null) this._lastEventId = stored.id;
    this._addEnded(entry.rawId);
    this._active.delete(entry.rawId);
  }

  ingest(users) {
    try {
      const source = users?._source;
      if (!source || source.status === "unavailable") {
        this._status = "unavailable";
        this._fetchedAt = source?.fetchedAt ?? this._now();
        this._schedulePersist();
        return;
      }
      if (source.status !== "ok" && source.status !== "legacy") {
        this._status = "unavailable";
        this._fetchedAt = source.fetchedAt ?? this._now();
        this._schedulePersist();
        return;
      }

      this._status = source.status;
      this._fetchedAt = Number.isFinite(source.fetchedAt) ? source.fetchedAt : this._now();
      this._lastOkAt = this._fetchedAt;
      this._firstOkAt ??= this._fetchedAt;
      this._loadedStale = false;

      if (source.bootId != null && this._bootId != null && source.bootId !== this._bootId) {
        for (const entry of [...this._active.values()]) this._end(entry, null, "producer-restart");
      }
      if (source.bootId != null) this._bootId = source.bootId;

      const requestsById = new Map();
      for (const request of Array.isArray(users?._openRequests) ? users._openRequests : []) {
        if (request?.id == null) continue;
        const rawId = String(request.id);
        if (!requestsById.has(rawId)) requestsById.set(rawId, request);
      }

      let overflowCount = 0;
      for (const [rawId, request] of requestsById) {
        if (this._ended.has(rawId)) continue;
        const lifecycle = ["queued", "pending", "waiting"].includes(request.state) ? "pending" : "active";
        const startedAtMs = request.startedAt != null
          ? Number(request.startedAt) * 1000
          : request.ageSec != null
            ? this._fetchedAt - Number(request.ageSec) * 1000
            : this._fetchedAt;
        let entry = this._active.get(rawId);
        if (entry && request.startedAt != null && Math.abs(entry.startedAt - startedAtMs) > 5000) {
          this._end(entry, null, "id-reused");
          this._ended.delete(rawId);
          entry = null;
        }
        if (entry) {
          entry.lifecycle = lifecycle;
          entry.label = request.user ?? request.label ?? entry.label;
          entry.model = request.model ?? entry.model;
          entry.promptEstTokens = request.promptEstTokens ?? entry.promptEstTokens;
          entry.completionEstTokens = request.completionEstTokens ?? entry.completionEstTokens;
          entry.maxTokens = request.maxTokens ?? entry.maxTokens;
          entry.lastSeenAt = this._fetchedAt;
          try {
            const resolved = this._resolveSparkId(request);
            entry.sparkId = resolved == null ? null : String(resolved);
          } catch {
            entry.sparkId = null;
          }
        } else {
          if (this._active.size >= this.maxActive) {
            overflowCount++;
            continue;
          }
          entry = this._makeEntry(request, this._fetchedAt, rawId, lifecycle);
          this._active.set(rawId, entry);
        }
      }
      this._overflowCount = overflowCount;

      const recentRows = Array.isArray(users?._recentRequests) ? users._recentRequests : [];
      const recentById = new Map();
      for (const row of recentRows) {
        if (row?.id != null) recentById.set(String(row.id), row);
      }
      for (const [rawId, entry] of [...this._active]) {
        if (!requestsById.has(rawId)) this._end(entry, recentById.get(rawId) ?? null, "vanished");
      }

      for (const row of recentRows) {
        if (row?.id == null) continue;
        const rawId = String(row.id);
        if (this._active.has(rawId) || this._ended.has(rawId)) continue;
        if (row.finishedAt == null || Number(row.finishedAt) * 1000 < this._firstOkAt - 2000) continue;
        const entry = this._makeEntry(row, this._fetchedAt, rawId, "active");
        this._end(entry, row, "finished-between-polls");
      }

      this._unattributedCount = [...this._active.values()].filter((entry) => entry.sparkId == null).length;
      this._schedulePersist();
    } catch (err) {
      safeLog("error", "[RequestLifecycle] ingest failed:", err?.message);
      try {
        this._schedulePersist();
      } catch {
        /* public method remains non-throwing */
      }
    }
  }

  markUnavailable(err) {
    try {
      this.ingest({ _source: { status: "unavailable", fetchedAt: this._now(), error: err?.message ?? String(err) } });
    } catch {
      /* public method remains non-throwing */
    }
  }

  snapshot() {
    try {
      const now = this._now();
      const staleAfterMs = typeof this.staleAfterMs === "function"
        ? this.staleAfterMs()
        : this.staleAfterMs;
      let status;
      if (this._status === "unknown" && !this._loadedStale) status = "unknown";
      else if (this._loadedStale) status = "stale";
      else if (this._status === "unavailable") status = "unavailable";
      else if (this._lastOkAt != null && now - this._lastOkAt > staleAfterMs) status = "stale";
      else status = this._status;
      const stale = status === "stale" || status === "unavailable" || status === "unknown";
      const requests = [...this._active.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => ({
          key: entry.key,
          sparkId: entry.sparkId,
          sparkName: entry.sparkId ? this._sparkName(entry.sparkId) : null,
          label: entry.label,
          model: entry.model,
          lifecycle: entry.lifecycle,
          promptEstTokens: entry.promptEstTokens,
          completionEstTokens: entry.completionEstTokens,
          maxTokens: entry.maxTokens,
          startedAt: entry.startedAt,
          lastSeenAt: entry.lastSeenAt,
          stale,
          attributed: entry.sparkId != null,
        }));
      return {
        status,
        stale,
        fetchedAt: this._fetchedAt,
        lastOkAt: this._lastOkAt,
        staleAfterMs,
        legacy: status === "legacy",
        unattributedCount: this._unattributedCount,
        overflowCount: this._overflowCount,
        lastRequestEventId: this._lastEventId,
        requests,
      };
    } catch (err) {
      safeLog("error", "[RequestLifecycle] snapshot failed:", err?.message);
      return {
        status: "unavailable", stale: true, fetchedAt: this._fetchedAt,
        lastOkAt: this._lastOkAt, staleAfterMs: this.staleAfterMs,
        legacy: false, unattributedCount: this._unattributedCount,
        overflowCount: this._overflowCount, lastRequestEventId: this._lastEventId,
        requests: [],
      };
    }
  }
}

export default RequestLifecycleTracker;
