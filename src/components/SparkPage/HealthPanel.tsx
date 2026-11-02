import type { SparkSnapshot } from "../../api/types";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { useAlertEvents } from "../../hooks/metricsStore";

interface HealthPanelProps {
  spark: SparkSnapshot;
}

const LEVEL_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  danger: { dot: "bg-danger", text: "text-danger", label: "Critical" },
  warn: { dot: "bg-warning", text: "text-warning", label: "Warning" },
  ok: { dot: "bg-success", text: "text-success", label: "Healthy" },
  unknown: { dot: "bg-muted", text: "text-muted", label: "Unknown" },
};

function BadgeChip({ level, label, detail }: { level: string; label: string; detail: string }) {
  const st =
    level === "danger"
      ? "border-danger/40 bg-danger/10 text-danger"
      : level === "warn"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-border bg-surface-elevated text-text";
  return (
    <div className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${st}`} title={detail}>
      <span className="truncate text-[11px] font-medium">{label}</span>
      <span className="shrink-0 font-tabular text-[11px] opacity-90">{detail}</span>
    </div>
  );
}

/**
 * Health panel — renders the server-computed per-Spark health classification
 * (badges + overall level) plus a live feed of recent alert transitions for
 * this Spark (from the WS `alerts` channel). Colored per the no-silent-failures
 * rule: danger/red, warn/amber, ok/green; unknown/absent renders "—".
 */
export function HealthPanel({ spark }: HealthPanelProps) {
  const events = useAlertEvents().filter((e) => e.sparkId === spark.id).slice(0, 5);
  const health = spark.healthSummary;
  const level = health?.level ?? (spark.online ? "ok" : "danger");
  const st = LEVEL_STYLES[level] ?? LEVEL_STYLES.unknown;
  const badges = health?.badges ?? [];
  const activeAlerts = badges.filter((b) => b.level !== "ok");

  return (
    <Panel
      title="Health"
      accent
      icon={<ActivityIcon />}
      actions={
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${st.text} bg-surface-hover`}>
          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
          {st.label}
        </span>
      }
      className="md:col-span-2"
      bodyClassName="space-y-3"
    >
      {!spark.online ? (
        <div className="text-xs text-danger">Host unreachable — no health telemetry available.</div>
      ) : badges.length === 0 ? (
        <div className="text-xs text-muted">No health signals reported yet.</div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {badges.map((b) => (
            <BadgeChip key={b.id} level={b.level} label={b.label} detail={b.detail} />
          ))}
        </div>
      )}

      {activeAlerts.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-danger/30 bg-danger/5 p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-danger">
            Active alerts
          </div>
          {activeAlerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-xs">
              <span className="text-text">{a.label}</span>
              <span className="font-tabular text-danger">{a.detail}</span>
            </div>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Recent</div>
          {events.map((e, i) => {
            const fromOk = e.prevLevel === "ok";
            const nowOk = e.level === "ok";
            return (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-muted">
                  {fromOk ? "cleared" : "triggered"} ·{" "}
                  <span className="text-text">{e.alerts?.[0]?.label ?? "health"}</span>
                </span>
                <span className={`font-tabular ${nowOk ? "text-success" : "text-warning"}`}>
                  {e.prevLevel} → {e.level}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
