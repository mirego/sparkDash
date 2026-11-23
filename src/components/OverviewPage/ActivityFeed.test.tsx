import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";
import { flush, render } from "../../testing/render";
import type { ActivityEvent, RequestActivity } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn(), fetchRequestActivity: vi.fn() }));
import { fetchEvents, fetchRequestActivity } from "../../api/client";
const fetchMock = vi.mocked(fetchEvents);
const requestMock = vi.mocked(fetchRequestActivity);

function requestData(overrides: Partial<RequestActivity> = {}): RequestActivity {
  return { status: "ok", stale: false, fetchedAt: Date.now(), lastOkAt: Date.now(), staleAfterMs: 15_000, legacy: false, unattributedCount: 0, overflowCount: 0, lastRequestEventId: null, requests: [], ...overrides };
}

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 1,
    ts: Date.now() - 120_000,
    type: "gpu.throttle.thermal",
    severity: "warn",
    sparkId: "s3",
    sparkName: "spark-03",
    message: "spark-03 started thermal throttling (84°C)",
    ...over,
  };
}

describe("activity formatting", () => {
  const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
  it("formats relative times", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("now");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2m");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe("2d");
    expect(formatRelativeTime(new Date(2026, 9, 5, 8).getTime() - 8 * 86400_000, now)).toBe("Sep 27");
  });
  it("maps severities and splits messages", () => {
    expect(severityDotClass("error")).toBe("bg-danger");
    expect(severityDotClass("success")).toBe("bg-success");
    expect(splitMessage("x went offline", "x")).toEqual({ before: "", name: "x", after: " went offline" });
    expect(splitMessage("hello", "zz").name).toBe("");
  });
});

describe("ActivityFeed", () => {
  beforeEach(() => requestMock.mockResolvedValue(requestData()));

  it("shows the empty state", async () => {
    fetchMock.mockResolvedValue([]);
    const { container } = render(<ActivityFeed />);
    await flush();
    expect(container.textContent).toContain("Nothing yet.");
    expect(container.textContent).toContain("live");
  });

  it("renders events and selects the spark on name click", async () => {
    fetchMock.mockResolvedValue([ev({}), ev({ id: 2, severity: "success", message: "other", sparkName: null, sparkId: null })]);
    const onSelect = vi.fn();
    const { container } = render(<ActivityFeed limit={5} onSelectSpark={onSelect} />);
    await flush();
    expect(container.textContent).toContain("started thermal throttling (84°C)");
    expect(container.textContent).toContain("2m");
    container.querySelector("a")!.click();
    expect(onSelect).toHaveBeenCalledWith("s3");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("pins open requests above events and renders ended requests in event order", async () => {
    const ended = ev({ id: 9, type: "request.ended", severity: "info", sparkName: "spark-03", message: "finished", data: { kind: "llm-request", lifecycle: "completed", outcome: "unknown", outcomeKnown: false, label: "key", model: "model", promptEstTokens: null, completionEstTokens: null, maxTokens: null, startedAt: 1, endedAt: 2, endedAtApprox: true, durationSec: null, attributed: true, sourceStatus: "legacy", endReason: "vanished" } });
    fetchMock.mockResolvedValue([ended, ev({ id: 8 })]);
    requestMock.mockResolvedValue(requestData({ requests: [{ key: "rq1", sparkId: "s3", sparkName: "spark-03", label: "key", model: "model", lifecycle: "active", promptEstTokens: 1, completionEstTokens: 2, maxTokens: 3, startedAt: Date.now(), lastSeenAt: Date.now(), stale: false, attributed: true }] }));
    const { container } = render(<ActivityFeed />);
    await flush();
    const text = container.textContent ?? "";
    expect(container.querySelector(".ac-requests")?.compareDocumentPosition(container.querySelector("ul")!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text).toContain("Outcome: Unknown");
    expect(text).toContain("Completed");
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("refreshes events immediately after a request ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      fetchMock.mockResolvedValue([ev({})]);
      requestMock.mockResolvedValueOnce(requestData({ lastRequestEventId: null, requests: [{ key: "rq1", sparkId: "s3", sparkName: "spark-03", label: "key", model: "model", lifecycle: "active", promptEstTokens: null, completionEstTokens: null, maxTokens: null, startedAt: 1, lastSeenAt: 1, stale: false, attributed: true }] }));
      requestMock.mockResolvedValue(requestData({ lastRequestEventId: 11, requests: [] }));
      const { container } = render(<ActivityFeed />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Next request-activity poll (3 s) sees the row gone: the event list reloads at once,
      // without waiting for its own 15 s poll.
      await act(async () => { vi.advanceTimersByTime(3_000); });
      await flush();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("No open requests");
    } finally {
      vi.useRealTimers();
    }
  });
});
