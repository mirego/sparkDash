import { useTranslation } from "react-i18next";
import { AppLink } from "../ui/AppLink";
import { Tag } from "../ui/Tag";
import { activeTimeZone } from "../../shared/timeZone";
import { ACTIVITY_ID, idToPath } from "../../constants";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { useRequestActivity } from "../../hooks/useRequestActivity";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";
import { buildFeedRows } from "./activityFeedModel";
import { durationLabel, outcomeLabel, RequestEndedDetail, requestRowState, tokenCount } from "./RequestActivity";
import "../../styles/activity.css";

interface ActivityFeedProps {
  limit?: number;
  sparkId?: string;
  onSelectSpark?: (sparkId: string) => void;
  /** Opens the full Activity page. */
  onViewAll?: () => void;
}

/** Compact fleet timeline. Renders card contents only (no outer chrome). */
export function ActivityFeed({ limit = 8, sparkId, onSelectSpark, onViewAll }: ActivityFeedProps) {
  const { t, i18n } = useTranslation("overview");
  const requestActivity = useRequestActivity();
  const { events, loading, error } = useActivityEvents({ sparkId, refreshKey: requestActivity.endedSignal });
  const now = Date.now();
  const requestState = requestRowState(requestActivity.data, requestActivity.clientError, now);
  const requests = (requestActivity.data?.requests ?? []).filter((row) => !sparkId || row.sparkId === sparkId);
  const { rows, hiddenOpen } = buildFeedRows(requests, events, limit);
  const severityLabels = {
    success: t("activity.severity.success"), warn: t("activity.severity.warn"),
    error: t("activity.severity.error"), info: t("activity.severity.info"),
  };
  const timeLabels = {
    now: t("activity.now"),
    minutes: (count: number) => t("activity.minutes", { count }),
    hours: (count: number) => t("activity.hours", { count }),
    days: (count: number) => t("activity.days", { count }),
    // formatRelativeTime already applies the configured time zone before calling this formatter.
    date: (date: Date) => new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date),
  };
  const requestStatusMessage = requestState === "waiting" ? t("requests.waiting")
    : requestState === "unavailable" ? t("requests.unavailable")
    : requestState === "stale" ? t("requests.lastUpdateStale", {
      ago: requestActivity.data?.lastOkAt == null ? "—" : durationLabel(now - requestActivity.data.lastOkAt),
    }) : null;
  const hasRequestOverflow = (requestState === "ok" || requestState === "legacy")
    && ((requestActivity.data?.overflowCount ?? 0) + hiddenOpen > 0);

  return (
    <section className="activity-feed" aria-label={t("activity.title")}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong">{t("activity.title")}</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          {t("activity.live")}
        </span>
      </header>

      {requestStatusMessage ? <p className="af-req-state" role="status">{requestStatusMessage}</p> : null}
      {requestState === "legacy" ? <p className="af-req-note">{t("requests.legacyNote")}</p> : null}
      {loading && rows.length === 0 ? (
        <p className="py-2 text-xs text-muted">{t("activity.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-xs text-muted">{error ? t("activity.error") : t("activity.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            if (row.kind === "request") {
              const sparkName = row.sparkName || row.sparkId || t("requests.unattributed");
              const canSelect = Boolean(row.sparkId && onSelectSpark);
              const age = row.status === "completed"
                ? (row.durationSec != null ? t("requests.tookDuration", { duration: durationLabel(row.durationSec * 1000) }) : t("requests.tookUnknown"))
                : durationLabel(now - (row.startedAt ?? row.ts));
              const ageText = row.status === "completed" ? `${age} · ${formatRelativeTime(row.ts, now, timeLabels)}` : age;
              const ageTimestamp = row.status === "completed" ? row.ts : row.startedAt;
              const dateTime = ageTimestamp != null && Number.isFinite(ageTimestamp) ? new Date(ageTimestamp).toISOString() : undefined;
              const statusTone = row.status === "pending" ? "warn" : row.status === "active" ? "info" : "neutral";
              const statusText = row.status === "pending" ? t("requests.pending") : row.status === "active" ? t("requests.active") : t("requests.completed");
              return (
                <li key={row.rowKey} className={`af-req-row${row.stale ? " ac-request-row__muted" : ""}`} data-status={row.status}>
                  <div className="af-req-line1">
                    {canSelect ? (
                      <AppLink href={idToPath(row.sparkId!)} className="font-semibold text-text-strong hover:underline" onNavigate={() => onSelectSpark!(row.sparkId!)}>{sparkName}</AppLink>
                    ) : <strong>{sparkName}</strong>}
                    <time className="af-req-age mono" dateTime={dateTime}>{ageText}</time>
                  </div>
                  <div className="af-req-line2">
                    <Tag tone="good" className={`af-key-chip${row.label ? "" : " af-key-chip--unknown"}`} title={!row.label ? t("requests.unknownKeyHint") : undefined}>
                      {row.label || t("requests.unknownKey")}
                    </Tag>
                    <span className="af-req-meta">{row.model ?? t("requests.unknownModel")}</span>
                    <span className="af-req-meta">{t("requests.prompt", { count: tokenCount(row.promptEstTokens) })}</span>
                    <span className="af-req-meta">{t("requests.outputWithMax", { output: tokenCount(row.completionEstTokens), max: tokenCount(row.maxTokens) })}</span>
                    {row.status === "completed" ? (
                      <span className="af-req-meta af-req-outcome">
                        {t("requests.outcomeLine", { outcome: outcomeLabel(row.outcomeKnown ? row.outcome ?? "unknown" : "unknown", t) })}
                        {row.legacyUnknown ? ` ${t("requests.legacyOutcomeTag")}` : ""}
                      </span>
                    ) : null}
                    {row.stale ? <Tag tone="neutral">{t("requests.staleTag")}</Tag> : null}
                    <Tag tone={statusTone} className="af-status-chip">{statusText}</Tag>
                  </div>
                </li>
              );
            }

            const ev = row.event;
            const { before, name, after } = splitMessage(ev.message, ev.sparkName);
            const clickable = Boolean(name && ev.sparkId && onSelectSpark);
            const eventDateTime = Number.isFinite(ev.ts) ? new Date(ev.ts).toISOString() : undefined;
            return (
              <li key={row.rowKey} className="flex items-baseline gap-2 py-1.5 text-xs">
                <time
                  className="w-10 shrink-0 text-right font-mono tabular-nums text-muted"
                  dateTime={eventDateTime}
                  title={Number.isFinite(ev.ts) ? new Date(ev.ts).toLocaleString(i18n.resolvedLanguage, { timeZone: activeTimeZone() }) : undefined}
                >
                  {Number.isFinite(ev.ts) ? formatRelativeTime(ev.ts, now, timeLabels) : "—"}
                </time>
                <span
                  className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${severityDotClass(ev.severity)}`}
                  aria-label={severityLabels[ev.severity] ?? ev.severity}
                />
                <span className="min-w-0 break-words text-muted-strong">
                  {ev.type === "request.ended" ? <RequestEndedDetail event={ev} compact onSelectSpark={onSelectSpark} /> : <>
                    {before}
                    {name && (clickable ? (
                      <AppLink href={idToPath(ev.sparkId as string)} className="font-semibold text-text-strong hover:underline" onNavigate={() => onSelectSpark!(ev.sparkId as string)}>{name}</AppLink>
                    ) : <strong className="font-semibold text-text-strong">{name}</strong>)}
                    {after}
                  </>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hasRequestOverflow ? <p className="af-req-more">{t("requests.more", { count: (requestActivity.data?.overflowCount ?? 0) + hiddenOpen })}</p> : null}
      {onViewAll ? (
        <AppLink href={idToPath(ACTIVITY_ID)} className="btn btn--sm btn--ghost mt-2" onNavigate={onViewAll}>
          {t("activity.viewAll")}
        </AppLink>
      ) : null}
    </section>
  );
}

export default ActivityFeed;
