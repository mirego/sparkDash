import { useEffect, useState } from "react";
import { fetchEnergyHistory } from "../api/client";
import type { EnergyReport } from "../api/types";
import { EnergyBarChart, fmtEnergyWh } from "./EnergyBarChart";

type Period = "day" | "week" | "month";

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

/** Max bars shown per period (the most recent N). */
const WINDOW: Record<Period, number> = { day: 30, week: 16, month: 12 };
const PERIOD_LABEL: Record<Period, string> = { day: "days", week: "weeks", month: "months" };

/**
 * GPU energy history modal — opens from the ⚡ pill. Fetches /api/energy once
 * on mount (so it re-fetches fresh data each time it's opened) and lets you
 * view the bar chart bucketed by day / week / month.
 */
export function EnergyModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<EnergyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("day");

  useEffect(() => {
    let cancelled = false;
    fetchEnergyHistory()
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const buckets = report ? report[period] : [];
  const totalWh = buckets.reduce((s, b) => s + b.value, 0);

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
    background: active ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
    color: active ? "#fff" : "var(--color-muted, #888)",
  });

  return (
    <div style={{ position: "fixed", zIndex: 99999, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--color-surface-elevated, #262626)", borderRadius: 12, padding: 0, maxWidth: 640, width: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", border: "1px solid var(--color-border, #353535)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 20px 12px", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--color-text-strong, #fff)" }}>⚡ GPU Energy</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--color-muted, #888)" }}>
              {loading ? "Loading…" : report ? `${totalWh === 0 ? "No" : fmtEnergyWh(totalWh)} across ${buckets.length} ${buckets.length === 1 ? PERIOD_LABEL[period].replace(/s$/, "") : PERIOD_LABEL[period]} (GPU draw)` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--color-muted, #888)", cursor: "pointer", fontSize: 18, padding: "0 2px", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: "0 20px 20px", overflow: "auto", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            {PERIODS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPeriod(p.id)} style={buttonStyle(period === p.id)}>{p.label}</button>
            ))}
          </div>
          {loading ? (
            <p style={{ fontSize: 12, color: "var(--color-muted, #888)" }}>Loading energy history…</p>
          ) : error ? (
            <p style={{ fontSize: 12, color: "var(--color-danger, #ef4444)" }}>{error}</p>
          ) : (
            <EnergyBarChart buckets={buckets} window={WINDOW[period]} />
          )}
        </div>
      </div>
    </div>
  );
}
