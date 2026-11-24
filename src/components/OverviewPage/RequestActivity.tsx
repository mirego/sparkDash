import { useTranslation } from "react-i18next";
import type { ActivityEvent, RequestActivity as RequestActivityData, RequestActivityRow, RequestEndedData } from "../../api/types";
import { isRequestEndedData } from "../../api/types";
import { idToPath } from "../../constants";
import { AppLink } from "../ui/AppLink";
import { Tag } from "../ui/Tag";
import { NO_SPARK } from "../ActivityPage/activityStats";
import "../../styles/activity.css";

export type RequestRowState = "waiting" | "unavailable" | "stale" | "ok" | "legacy";

export function requestRowState(activity: RequestActivityData | null, clientError: boolean, now: number): RequestRowState {
  if (clientError) return activity ? "stale" : "unavailable";
  if (!activity || activity.status === "unknown") return "waiting";
  if (activity.status === "unavailable") return "unavailable";
  if (activity.stale || activity.status === "stale" || (activity.lastOkAt != null && now - activity.lastOkAt > activity.staleAfterMs)) return "stale";
  if (activity.status === "legacy" || activity.legacy) return "legacy";
  return "ok";
}

interface OpenRequestsPinnedProps {
  activity: RequestActivityData | null;
  clientError: boolean;
  now: number;
  compact?: boolean;
  sparkFilter?: string;
  query?: string;
  onSelectSpark?: (id: string) => void;
  maxRows?: number;
}

export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function tokenCount(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

/** "out 20 / max 200", "out — / max 200" or "out 20": output is never confused with the max-token budget. */
export function outputText(output: number | null, max: number | null, t: ReturnType<typeof useTranslation>["t"]): string {
  return max == null
    ? t("requests.output", { count: tokenCount(output) })
    : t("requests.outputWithMax", { output: tokenCount(output), max: tokenCount(max) });
}

function RequestRow({ row, now, onSelectSpark, compact }: { row: RequestActivityRow; now: number; onSelectSpark?: (id: string) => void; compact: boolean }) {
  const { t } = useTranslation("overview");
  const stale = row.stale;
  const sparkName = row.sparkId ? row.sparkName || row.sparkId : t("requests.unattributed");
  const canSelect = Boolean(row.sparkId && onSelectSpark);
  const completion = outputText(row.completionEstTokens, row.maxTokens, t);
  return (
    <li className={`ac-request-row${compact ? " ac-request-row--compact" : ""}`}>
      <div className="ac-request-row__line">
        <Tag tone={stale ? "neutral" : row.lifecycle === "pending" ? "warn" : "info"} className={stale ? "ac-request-row__muted" : ""}>
          {row.lifecycle === "pending" ? t("requests.pending") : t("requests.active")}
        </Tag>
        {stale ? <Tag tone="neutral">{t("requests.staleTag")}</Tag> : null}
        <span className="ac-request-row__spark">
          {canSelect ? (
            <AppLink href={idToPath(row.sparkId)} className="font-semibold text-text-strong hover:underline" onNavigate={() => onSelectSpark!(row.sparkId!)}>
              {sparkName}
            </AppLink>
          ) : <strong>{sparkName}</strong>}
        </span>
        <span className="ac-request-row__meta">{row.label || t("requests.unknownKey")}</span>
        {row.model ? <span className="ac-request-row__meta">{row.model}</span> : null}
        <span className="ac-request-row__meta">{t("requests.prompt", { count: tokenCount(row.promptEstTokens) })}</span>
        <span className="ac-request-row__meta">{completion}</span>
        <time className="ac-request-row__age mono" dateTime={new Date(row.startedAt).toISOString()} title={new Date(row.startedAt).toLocaleString()}>
          {durationLabel(now - row.startedAt)}
        </time>
      </div>
    </li>
  );
}

export function OpenRequestsPinned({ activity, clientError, now, compact = false, sparkFilter = "all", query = "", onSelectSpark, maxRows = Number.POSITIVE_INFINITY }: OpenRequestsPinnedProps) {
  const { t } = useTranslation("overview");
  const state = requestRowState(activity, clientError, now);
  const allRows = activity?.requests ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows = [...allRows].sort((a, b) => b.startedAt - a.startedAt).filter((row) => {
    if (sparkFilter !== "all" && (sparkFilter === NO_SPARK ? row.sparkId != null : row.sparkId !== sparkFilter)) return false;
    if (normalizedQuery && !`${row.sparkName ?? ""}\n${row.label ?? ""}\n${row.model ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)) return false;
    return true;
  });
  const visibleRows = rows.slice(0, Math.max(0, maxRows));
  const hiddenByLimit = Math.max(0, rows.length - visibleRows.length);
  const statusMessage = state === "waiting" ? t("requests.waiting")
    : state === "unavailable" ? t("requests.unavailable")
    : state === "stale" ? t("requests.lastUpdateStale", { ago: activity?.lastOkAt == null ? "—" : durationLabel(now - activity.lastOkAt) })
    : null;
  const count = state === "ok" || state === "legacy"
    ? `${activity?.requests.length ?? 0}${activity?.overflowCount ? ` (+${activity.overflowCount})` : ""}`
    : "—";

  return (
    <section className={`ac-requests${compact ? " ac-requests--compact" : ""}`} aria-label={t("requests.title")}>
      <header className="ac-requests__head">
        <h3>{t("requests.title")}</h3>
        <span className="ac-requests__count mono">{count}</span>
      </header>
      {statusMessage ? <p className="ac-requests__state" role="status">{statusMessage}</p> : null}
      {state === "legacy" ? <p className="ac-requests__note">{t("requests.legacyNote")}</p> : null}
      {(state === "ok" || state === "legacy") && rows.length === 0 ? <p className="ac-requests__state">{t("requests.empty")}</p> : null}
      {visibleRows.length > 0 ? (
        <ul className="ac-requests__list">
          {visibleRows.map((row) => <RequestRow key={row.key} row={row} now={now} onSelectSpark={onSelectSpark} compact={compact} />)}
        </ul>
      ) : null}
      {(state === "ok" || state === "legacy") && (activity?.overflowCount || hiddenByLimit) ? <p className="ac-requests__more">{t("requests.more", { count: (activity?.overflowCount ?? 0) + hiddenByLimit })}</p> : null}
    </section>
  );
}

export function outcomeLabel(outcome: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const known: Record<string, string> = {
    completed: t("requests.outcome.completed"),
    upstream_error: t("requests.outcome.upstreamError"),
    client_disconnect: t("requests.outcome.clientDisconnect"),
    cancelled: t("requests.outcome.cancelled"),
    upstream_unreachable: t("requests.outcome.upstreamUnreachable"),
    unknown: t("requests.outcome.unknown"),
  };
  return known[outcome] ?? outcome;
}

export function RequestEndedDetail({ event, compact = false, onSelectSpark }: { event: ActivityEvent; compact?: boolean; onSelectSpark?: (id: string) => void }) {
  const { t } = useTranslation("overview");
  const data: RequestEndedData | null = isRequestEndedData(event.data) ? event.data : null;
  if (!data) return <span>{event.message}</span>;
  const outcome = outcomeLabel(data.outcome, t);
  const good = data.outcomeKnown && data.outcome === "completed";
  const pieces = [data.label, data.model].filter((value): value is string => Boolean(value));
  const prompt = data.promptEstTokens == null ? "—" : tokenCount(data.promptEstTokens);
  const output = outputText(data.completionEstTokens, data.maxTokens, t);
  if (data.durationSec != null) pieces.push(t("requests.duration", { duration: durationLabel(data.durationSec * 1000) }));
  const sparkName = event.sparkId ? event.sparkName || event.sparkId : t("requests.unattributed");
  return (
    <span className={`ac-request-ended${compact ? " ac-request-ended--compact" : ""}`}>
      {event.sparkId && onSelectSpark ? <AppLink href={idToPath(event.sparkId)} className="font-semibold text-text-strong hover:underline" onNavigate={() => onSelectSpark(event.sparkId!)}>{sparkName}</AppLink> : <strong>{sparkName}</strong>}
      <Tag tone={good ? "good" : "neutral"}>{t("requests.completed")}</Tag>
      <span>{t("requests.outcomeLine", { outcome })}</span>
      {pieces.length ? <span>{pieces.join(" · ")}</span> : null}
      <span>{t("requests.prompt", { count: prompt })}</span>
      <span>{output}</span>
    </span>
  );
}
