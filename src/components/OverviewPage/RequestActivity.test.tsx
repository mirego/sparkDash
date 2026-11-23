import { describe, expect, it } from "vitest";
import type { ActivityEvent, RequestActivity, RequestActivityRow } from "../../api/types";
import { flush, render } from "../../testing/render";
import { OpenRequestsPinned, RequestEndedDetail, requestRowState } from "./RequestActivity";

const row = (overrides: Partial<RequestActivityRow> = {}): RequestActivityRow => ({
  key: "rq1", sparkId: "spark-a", sparkName: "Spark A", label: "client-key", model: "model-x", lifecycle: "pending",
  promptEstTokens: 1234, completionEstTokens: 20, maxTokens: 200, startedAt: Date.now() - 12_000,
  lastSeenAt: Date.now(), stale: false, attributed: true, ...overrides,
});
const activity = (overrides: Partial<RequestActivity> = {}): RequestActivity => ({
  status: "ok", stale: false, fetchedAt: Date.now(), lastOkAt: Date.now(), staleAfterMs: 15_000,
  legacy: false, unattributedCount: 0, overflowCount: 0, lastRequestEventId: null, requests: [row()], ...overrides,
});

it("renders sorted rows and safe token values without request identifiers", () => {
  const older = row({ key: "rq2", sparkName: "Older Spark", startedAt: 1_000 });
  const newer = row({ key: "rq1", lifecycle: "active", startedAt: 2_000 });
  const { container } = render(<OpenRequestsPinned activity={activity({ requests: [older, newer] })} clientError={false} now={3_000} />);
  const rows = [...container.querySelectorAll(".ac-request-row")];
  expect(rows[0].textContent).toContain("Spark A");
  expect(rows[0].textContent).toContain("Active");
  expect(rows[1].textContent).toContain("Pending");
  expect(container.textContent).toContain("client-key");
  expect(container.textContent).toContain("model-x");
  expect(container.textContent).toContain("prompt ~1,234");
  expect(container.textContent).toContain("out 20 / max 200");
  expect(container.textContent).toContain("1s");
  expect(container.textContent).not.toContain("rq1");
  expect(container.textContent).not.toContain("rq2");
});

it("renders null token counts as em dashes", () => {
  const { container } = render(<OpenRequestsPinned activity={activity({ requests: [row({ promptEstTokens: null, completionEstTokens: null, maxTokens: null })] })} clientError={false} now={Date.now()} />);
  expect(container.textContent).toContain("prompt ~—");
  expect(container.textContent).toContain("out —");
  expect(container.textContent).not.toContain("out 0");
});

it("renders unknown, unavailable, stale, empty, legacy, unattributed and overflow states", () => {
  const now = Date.now();
  expect(requestRowState(activity({ status: "unavailable" }), false, now)).toBe("unavailable");
  expect(requestRowState(activity({ stale: true }), false, now)).toBe("stale");
  expect(requestRowState(activity(), true, now)).toBe("stale");
  const unavailable = render(<OpenRequestsPinned activity={activity({ status: "unavailable" })} clientError={false} now={now} />);
  expect(unavailable.container.textContent).toContain("—");
  expect(unavailable.container.textContent).toContain("Proxy unavailable");
  const stale = render(<OpenRequestsPinned activity={activity({ stale: true })} clientError={false} now={now} />);
  expect(stale.container.textContent).toContain("Stale");
  const empty = render(<OpenRequestsPinned activity={activity({ requests: [] })} clientError={false} now={now} />);
  expect(empty.container.textContent).toContain("No open requests");
  const legacy = render(<OpenRequestsPinned activity={activity({ status: "legacy", legacy: true })} clientError={false} now={now} />);
  expect(legacy.container.textContent).toContain("Legacy proxy");
  const unattributed = render(<OpenRequestsPinned activity={activity({ requests: [row({ sparkId: null, sparkName: null, attributed: false })], unattributedCount: 1 })} clientError={false} now={now} />);
  expect(unattributed.container.textContent).toContain("Unattributed");
  const overflow = render(<OpenRequestsPinned activity={activity({ overflowCount: 3 })} clientError={false} now={now} />);
  expect(overflow.container.textContent).toContain("3 more open requests not shown");
});

it("renders known, unknown and verbatim ended outcomes", async () => {
  const event = (outcome: string, outcomeKnown: boolean): ActivityEvent => ({
    id: 1, ts: Date.now(), type: "request.ended", severity: "success", sparkId: "spark-a", sparkName: "Spark A", message: "finished",
    data: { kind: "llm-request", lifecycle: "completed", outcome, outcomeKnown, label: "key", model: "model", promptEstTokens: 1, completionEstTokens: 2, maxTokens: 3, startedAt: 1, endedAt: 2, endedAtApprox: false, durationSec: 2, attributed: true, sourceStatus: "ok", endReason: "vanished" },
  });
  const completed = render(<RequestEndedDetail event={event("completed", true)} />);
  expect(completed.container.textContent).toContain("Completed");
  expect(completed.container.textContent).toContain("Outcome: Completed");
  const unknown = render(<RequestEndedDetail event={event("unknown", false)} />);
  expect(unknown.container.textContent).toContain("Outcome: Unknown");
  const custom = render(<RequestEndedDetail event={event("custom-outcome", true)} />);
  expect(custom.container.textContent).toContain("Outcome: custom-outcome");
  await flush();
});
