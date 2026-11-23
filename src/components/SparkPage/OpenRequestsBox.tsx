import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProxyOpenRequests } from "../../api/types";

interface OpenRequestsBoxProps {
  data?: ProxyOpenRequests;
}

function displayTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat().format(value);
}

function displayAge(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function OpenRequestsBox({ data }: OpenRequestsBoxProps) {
  const { t } = useTranslation("spark");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const unavailable = !data || data.status === "unavailable";
  const staleAfterMs = data?.staleAfterMs ?? 15_000;
  const stale = !unavailable && data.fetchedAt != null && now - data.fetchedAt > staleAfterMs;
  const requests = data?.requests ?? [];
  const count = unavailable || stale ? "—" : requests.length;

  return (
    <section className="rounded-md border border-border bg-surface p-3" aria-label={t("llm.openRequests.title", { count })}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">{t("llm.openRequests.title", { count })}</h3>
        {stale && <span className="sp-badge">{t("llm.openRequests.stale")}</span>}
      </div>
      {unavailable ? (
        <p className="text-xs text-muted">{t("llm.openRequests.unavailable")}</p>
      ) : stale ? (
        <p className="text-xs text-muted">{t("llm.openRequests.staleCount")}</p>
      ) : requests.length === 0 ? (
        <p className="text-xs text-muted">{t("llm.openRequests.empty")}</p>
      ) : (
        <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {requests.map((request) => (
            <li key={request.id} className="rounded border border-border/70 px-2 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-text">{request.label || t("llm.openRequests.unknownUser")}</span>
                {request.model && <span className="text-muted">{request.model}</span>}
                <span className={`rounded px-1.5 py-0.5 ${request.state === "queued" ? "bg-warning/10 text-warning" : "bg-accent-soft text-accent"}`}>
                  {request.state === "queued" ? t("llm.openRequests.queued") : t("llm.openRequests.streaming")}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted">
                <span>{t("llm.openRequests.prompt", { value: displayTokens(request.promptEstTokens) })}</span>
                {request.maxTokens != null && <span>{t("llm.openRequests.max", { value: displayTokens(request.maxTokens) })}</span>}
                {request.completionEstTokens != null && <span>{t("llm.openRequests.generated", { value: displayTokens(request.completionEstTokens) })}</span>}
                <span>{t("llm.openRequests.age", { value: displayAge(request.ageSec) })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && !unavailable && data.unattributedCount > 0 && (
        <p className="mt-2 text-xs text-muted">{t("llm.openRequests.unattributed", { count: data.unattributedCount })}</p>
      )}
    </section>
  );
}
