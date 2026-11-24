import { describe, expect, it } from "vitest";
import type { ActivityEvent, RequestActivityRow } from "../../api/types";
import { buildFeedRows } from "./activityFeedModel";

function request(key: string, overrides: Partial<RequestActivityRow> = {}): RequestActivityRow {
  return {
    key,
    sparkId: "s1",
    sparkName: "spark-01",
    label: "key label",
    model: "model",
    lifecycle: "active",
    promptEstTokens: null,
    completionEstTokens: null,
    maxTokens: null,
    startedAt: 10,
    lastSeenAt: 10,
    stale: false,
    attributed: true,
    ...overrides,
  };
}

function event(id: number, ts: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id, ts, type: "system.changed", severity: "info", message: "changed", ...overrides };
}

function ended(id: number, ts: number, sourceStatus = "ok", outcomeKnown = true): ActivityEvent {
  return event(id, ts, {
    type: "request.ended",
    data: {
      kind: "llm-request", lifecycle: "completed", outcome: "upstream_error", outcomeKnown,
      label: "key label", model: "model", promptEstTokens: 1, completionEstTokens: 2, maxTokens: 3,
      startedAt: 1, endedAt: 4, endedAtApprox: false, durationSec: 3, attributed: true,
      sourceStatus, endReason: "vanished", rawId: "raw-secret",
    },
  });
}

describe("buildFeedRows", () => {
  it("interleaves request and event rows newest first", () => {
    const result = buildFeedRows([
      request("older", { lastSeenAt: 200 }),
      request("newer", { lastSeenAt: 400 }),
    ], [event(1, 100), ended(2, 300)], 10);
    expect(result.rows.map((row) => row.ts)).toEqual([400, 300, 200, 100]);
    expect(result.rows.map((row) => row.kind)).toEqual(["request", "request", "request", "event"]);
  });

  it("falls back from a non-finite lastSeenAt to startedAt", () => {
    const result = buildFeedRows([request("fallback", { lastSeenAt: Number.NaN, startedAt: 50 })], [], 10);
    expect(result.rows[0].ts).toBe(50);
  });

  it("applies the limit after sorting and counts dropped open rows", () => {
    const result = buildFeedRows([
      request("old", { lastSeenAt: 100 }),
      request("new", { lastSeenAt: 300 }),
    ], [event(1, 200)], 2);
    expect(result.rows.map((row) => row.ts)).toEqual([300, 200]);
    expect(result.hiddenOpen).toBe(1);
  });

  it("marks unknown legacy outcomes without copying sensitive producer fields", () => {
    const row = buildFeedRows([], [ended(4, 20, "legacy", false)], 1).rows[0];
    expect(row.kind).toBe("request");
    if (row.kind !== "request") throw new Error("expected a request row");
    expect(row.legacyUnknown).toBe(true);
    expect(row.outcomeKnown).toBe(false);
    expect(row).not.toHaveProperty("endReason");
    expect(row).not.toHaveProperty("sourceStatus");
    expect(row).not.toHaveProperty("rawId");
    expect(row).not.toHaveProperty("key");
  });

  it("sorts non-finite timestamps last while preserving input order for ties", () => {
    const result = buildFeedRows([
      request("tie-1", { lastSeenAt: 20 }), request("tie-2", { lastSeenAt: 20 }),
      request("non-finite", { lastSeenAt: Number.POSITIVE_INFINITY }),
    ], [event(1, 20), event(2, Number.NaN)], 10);
    expect(result.rows.map((row) => row.rowKey)).toEqual(["open:tie-1", "open:tie-2", "ev:1", "open:non-finite", "ev:2"]);
  });
});
