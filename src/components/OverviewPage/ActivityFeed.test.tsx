import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";
import { flush, render } from "../../testing/render";
import type { ActivityEvent, RequestActivity, RequestActivityRow } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn(), fetchRequestActivity: vi.fn() }));
import { fetchEvents, fetchRequestActivity } from "../../api/client";
const fetchMock = vi.mocked(fetchEvents);
const requestMock = vi.mocked(fetchRequestActivity);

function requestData(overrides: Partial<RequestActivity> = {}): RequestActivity {
  return { status: "ok", stale: false, fetchedAt: Date.now(), lastOkAt: Date.now(), staleAfterMs: 15_000, legacy: false, unattributedCount: 0, overflowCount: 0, lastRequestEventId: null, requests: [], ...overrides };
}

function req(overrides: Partial<RequestActivityRow> = {}): RequestActivityRow {
  return {
    key: "private-request-id",
    sparkId: "s3",
    sparkName: "spark-03",
    label: "safe label",
    model: "model-a",
    lifecycle: "active",
    promptEstTokens: 1234,
    completionEstTokens: 20,
    maxTokens: 200,
    startedAt: Date.now() - 60_000,
    lastSeenAt: Date.now() - 30_000,
    stale: false,
    attributed: true,
    ...overrides,
  };
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

function ended(overrides: Record<string, unknown> = {}, eventOverrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return ev({
    id: 9,
    type: "request.ended",
    severity: "info",
    message: "finished",
    data: {
      kind: "llm-request", lifecycle: "completed", outcome: "unknown", outcomeKnown: false,
      label: "safe label", model: "model-a", promptEstTokens: 1, completionEstTokens: null, maxTokens: null,
      startedAt: Date.now() - 90_000, endedAt: Date.now(), endedAtApprox: true, durationSec: null,
      attributed: true, sourceStatus: "legacy", endReason: "vanished", ...overrides,
    },
    ...eventOverrides,
  });
}

async function renderFeed(requests: RequestActivityRow[], events: ActivityEvent[] = [], dataOverrides: Partial<RequestActivity> = {}, props: React.ComponentProps<typeof ActivityFeed> = {}) {
  requestMock.mockResolvedValue(requestData({ requests, ...dataOverrides }));
  fetchMock.mockResolvedValue(events);
  const result = render(<ActivityFeed {...props} />);
  await flush();
  return result;
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
    expect(splitMessage("x went offline", "x")).toEqual({ before: "", name: "x", after: " went offline" });
    expect(splitMessage("hello", "zz").name).toBe("");
  });
});

describe("ActivityFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestMock.mockResolvedValue(requestData());
  });

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

  it("interleaves all row kinds in one flat list, newest first", async () => {
    const now = Date.now();
    const { container } = await renderFeed([
      req({ key: "older-open", startedAt: now - 500, lastSeenAt: now - 200 }),
      req({ key: "newer-open", startedAt: now - 500, lastSeenAt: now - 400 }),
    ], [ev({ id: 12, ts: now - 100 }), ended({}, { id: 13, ts: now - 300 })]);
    const rows = Array.from(container.querySelectorAll("ul > li"));
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.getAttribute("data-status") ?? (row.textContent?.includes("thermal throttling") ? "event" : "ended"))).toEqual(["event", "active", "completed", "active"]);
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    const list = container.querySelector("ul")!;
    expect(Array.from(container.querySelectorAll("li")).every((row) => row.parentElement === list)).toBe(true);
    expect(container.querySelector(".ac-requests")).toBeNull();
    expect(container.querySelectorAll("li ul, li li")).toHaveLength(0);
  });

  it("puts chips and request metadata in the specified line-two order", async () => {
    const completed = ended({ outcome: "upstream_error", outcomeKnown: true, sourceStatus: "ok", durationSec: 12 }, { id: 10, ts: Date.now() - 5_000 });
    const { container } = await renderFeed([req()], [completed]);
    for (const row of container.querySelectorAll<HTMLLIElement>(".af-req-row")) {
      const line = row.querySelector(".af-req-line2")!;
      expect(line.firstElementChild?.classList.contains("af-key-chip")).toBe(true);
      expect(line.lastElementChild?.classList.contains("af-status-chip")).toBe(true);
    }
    expect(container.textContent).toContain("prompt ~1,234");
    expect(container.textContent).toContain("out 20 / max 200");
    expect(container.textContent).toContain("Outcome: Upstream error");
    expect(container.textContent).toContain("took 12s");
  });

  it("renders missing values without implying zero and marks unknown keys and legacy outcomes", async () => {
    const { container } = await renderFeed([
      req({ label: "", model: null, promptEstTokens: null, completionEstTokens: null, maxTokens: null }),
    ], [ended()]);
    expect(container.textContent).toContain("Unknown key");
    expect(container.querySelector(".af-key-chip--unknown")).not.toBeNull();
    expect(container.textContent).toContain("unknown model");
    expect(container.textContent).toContain("prompt ~—");
    expect(container.textContent).toContain("out — / max —");
    expect(container.textContent).not.toContain("out 0");
    expect(container.textContent).toContain("Outcome: Unknown (legacy proxy)");
  });

  it("shows request-source unavailable, stale and waiting states without a no-requests claim", async () => {
    fetchMock.mockResolvedValue([]);
    requestMock.mockRejectedValueOnce(new Error("offline"));
    const unavailable = render(<ActivityFeed />);
    await flush();
    expect(unavailable.container.textContent).toContain("Proxy unavailable — open requests unknown");
    expect(unavailable.container.textContent).not.toContain("No open requests");

    requestMock.mockResolvedValueOnce(requestData({ status: "stale", stale: true, lastOkAt: Date.now() - 3_000 }));
    const stale = render(<ActivityFeed />);
    await flush();
    expect(stale.container.textContent).toContain("Stale — last update");

    requestMock.mockResolvedValueOnce(requestData({ status: "unknown" }));
    const waiting = render(<ActivityFeed />);
    await flush();
    expect(waiting.container.textContent).toContain("Waiting for request data");
  });

  it("selects sparks from request and system-event rows", async () => {
    const onSelect = vi.fn();
    const { container } = await renderFeed([req()], [ev({ id: 2 })], {}, { onSelectSpark: onSelect });
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    links[0].click();
    links[1].click();
    expect(onSelect).toHaveBeenNthCalledWith(1, "s3");
    expect(onSelect).toHaveBeenNthCalledWith(2, "s3");
  });

  it("labels every request row with a trailing Pending/Active/Completed chip; unattributed rows have no link", async () => {
    const now = Date.now();
    const onSelect = vi.fn();
    const { container } = await renderFeed([
      req({ key: "p", lifecycle: "pending", lastSeenAt: now - 1_000 }),
      req({ key: "a", lifecycle: "active", sparkId: null, sparkName: null, attributed: false, lastSeenAt: now - 2_000 }),
    ], [ended({}, { id: 20, ts: now - 3_000 })], {}, { onSelectSpark: onSelect });
    const rows = Array.from(container.querySelectorAll<HTMLLIElement>(".af-req-row"));
    expect(rows.map((row) => row.querySelector(".af-req-line2")!.lastElementChild!.textContent)).toEqual(["Pending", "Active", "Completed"]);
    expect(rows[1].querySelector(".af-req-line1")!.textContent).toContain("Unattributed");
    expect(rows[1].querySelector("a")).toBeNull();
    expect(rows[0].querySelector("a")).not.toBeNull();
    // Line 1 = Spark + outcome + duration/age; line 2 = exactly key chip, model, prompt, out/max, status.
    for (const row of rows) expect(row.querySelector(".af-req-line2")!.children).toHaveLength(5);
    expect(rows[2].querySelector(".af-req-line1")!.textContent).toContain("Outcome: Unknown (legacy proxy)");
    expect(rows[0].querySelector(".af-req-line1 .tag")).toBeNull();
  });

  it("does not render request keys or end reasons", async () => {
    const { container } = await renderFeed([req({ key: "rq-secret-1" })], [ended({ endReason: "vanished" })]);
    expect(container.innerHTML).not.toContain("rq-secret-1");
    expect(container.innerHTML).not.toContain("vanished");
  });

  it("refreshes events immediately after a request ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      fetchMock.mockResolvedValue([ev({})]);
      requestMock.mockResolvedValueOnce(requestData({ lastRequestEventId: null, requests: [req()] }));
      requestMock.mockResolvedValue(requestData({ lastRequestEventId: 11, requests: [] }));
      const { container } = render(<ActivityFeed />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll(".af-req-row")).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(3_000); });
      await flush();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(container.querySelectorAll(".af-req-row")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
