import { isRequestEndedData } from "../../api/types";
import type { ActivityEvent, RequestActivityRow } from "../../api/types";

export type FeedRequestRow = {
  kind: "request";
  rowKey: string;
  ts: number;
  status: "pending" | "active" | "completed";
  sparkId: string | null;
  sparkName: string | null;
  label: string | null;
  model: string | null;
  promptEstTokens: number | null;
  completionEstTokens: number | null;
  maxTokens: number | null;
  startedAt: number | null;
  durationSec: number | null;
  stale: boolean;
  outcome: string | null;
  outcomeKnown: boolean;
  legacyUnknown: boolean;
};

export type FeedEventRow = { kind: "event"; rowKey: string; ts: number; event: ActivityEvent };
export type FeedRow = FeedRequestRow | FeedEventRow;

type IndexedFeedRow = { row: FeedRow; index: number };

export function buildFeedRows(requests: RequestActivityRow[], events: ActivityEvent[], limit: number): { rows: FeedRow[]; hiddenOpen: number } {
  const indexed: IndexedFeedRow[] = [];
  let index = 0;

  for (const request of requests) {
    indexed.push({
      index: index++,
      row: {
        kind: "request",
        rowKey: `open:${request.key}`,
        ts: Number.isFinite(request.lastSeenAt) ? request.lastSeenAt : request.startedAt,
        status: request.lifecycle,
        sparkId: request.sparkId,
        sparkName: request.sparkName,
        label: request.label || null,
        model: request.model,
        promptEstTokens: request.promptEstTokens,
        completionEstTokens: request.completionEstTokens,
        maxTokens: request.maxTokens,
        startedAt: request.startedAt,
        durationSec: null,
        stale: request.stale,
        outcome: null,
        outcomeKnown: false,
        legacyUnknown: false,
      },
    });
  }

  for (const event of events) {
    if (event.type === "request.ended" && isRequestEndedData(event.data)) {
      const data = event.data;
      indexed.push({
        index: index++,
        row: {
          kind: "request",
          rowKey: `ev:${event.id}`,
          ts: event.ts,
          status: "completed",
          sparkId: event.sparkId ?? null,
          sparkName: event.sparkName ?? null,
          label: data.label,
          model: data.model,
          promptEstTokens: data.promptEstTokens,
          completionEstTokens: data.completionEstTokens,
          maxTokens: data.maxTokens,
          startedAt: data.startedAt,
          durationSec: data.durationSec,
          stale: false,
          outcome: data.outcome,
          outcomeKnown: data.outcomeKnown,
          legacyUnknown: data.sourceStatus === "legacy" && !data.outcomeKnown,
        },
      });
    } else {
      indexed.push({ index: index++, row: { kind: "event", rowKey: `ev:${event.id}`, ts: event.ts, event } });
    }
  }

  indexed.sort((a, b) => {
    const aFinite = Number.isFinite(a.row.ts);
    const bFinite = Number.isFinite(b.row.ts);
    if (aFinite !== bFinite) return aFinite ? -1 : 1;
    if (aFinite && bFinite && a.row.ts !== b.row.ts) return b.row.ts - a.row.ts;
    return a.index - b.index;
  });

  const safeLimit = Number.isNaN(limit) ? 0 : Math.max(0, Math.floor(limit));
  const visible = indexed.slice(0, safeLimit).map(({ row }) => row);
  const hiddenOpen = indexed.slice(safeLimit).filter(({ row }) => row.kind === "request" && row.status !== "completed").length;
  return { rows: visible, hiddenOpen };
}
