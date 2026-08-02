import { useEffect, useState } from "react";
import { fetchEnergyHistory } from "../api/client";
import type { EnergyReport } from "../api/types";
import { EnergyBarChart, fmtEnergyWh } from "./EnergyBarChart";

type Period = "day" | "week" | "month" | "year";

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

/** Max bars shown per period (the most recent N). */
const WINDOW: Record<Period, number> = { day: 30, week: 16, month: 12, year: 8 };

/**
 * Approximate blended retail price of electricity in Montreal, QC
 * (Hydro-Québec, Res. Rate D), CAD/kWh. Rough all-in figure — adjust freely.
 */
const PRICE_CAD_PER_KWH = 0.10;

/** Format a Wh amount as an approximate CAD cost. */
function fmtCost(wh: number): string {
  const cost = (wh / 1000) * PRICE_CAD_PER_KWH;
  const digits = cost < 1 && cost > 0 ? 3 : 2;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cost);
}

/**
 * GPU energy history modal — opens from the ⚡ pill. Fetches /api/energy on
 * mount and lets you view the bar chart bucketed by day / week / month / year.
 * Top-right shows all-time consumption and its approximate price.
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

  // Close on Escape (no explicit close button; backdrop click also closes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // All-time = sum of all daily buckets (GPU draw across all Sparks, retention-bound).
  const allTimeWh = report ? report.day.reduce((s, b) => s + b.value, 0) : 0;
  const buckets = report ? report[period] : [];

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
    background: active ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
    color: active ? "#fff" : "var(--color-muted, #888)",
  });

  // Small metric tile for the top-right boxes.
  const tileStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 2, minWidth: 84, padding: "6px 12px",
    borderRadius: 8, background: "var(--color-surface-hover, #303030)",
    border: "1px solid var(--color-border, #353535)", textAlign: "right" as const,
  };
  const tileLabel: React.CSSProperties = { fontSize: 9, letterSpacing: ".05em", color: "var(--color-muted, #888)", whiteSpace: "nowrap" };
  const tileValue: React.CSSProperties = { fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <div style={{ position: "fixed", zIndex: 99999, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--color-surface-elevated, #262626)", borderRadius: 12, padding: 0, maxWidth: 640, width: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", border: "1px solid var(--color-border, #353535)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 20px 12px", flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--color-text-strong, #fff)" }}>⚡ GPU Energy</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={tileStyle} title="Total GPU energy consumed (all Sparks, retention-bound)">
              <span style={tileLabel}>ALL TIME</span>
              <span style={{ ...tileValue, color: "var(--color-accent, #e8a830)" }}>{fmtEnergyWh(allTimeWh)}</span>
            </div>
            <div style={tileStyle} title={`Approximate price @ ~${(PRICE_CAD_PER_KWH * 100).toFixed(1)}¢/kWh (Hydro-Québec, Montreal)`}>
              <span style={tileLabel}>APPROX. PRICE</span>
              <span style={{ ...tileValue, color: "var(--color-text-strong, #fff)" }}>{fmtCost(allTimeWh)}</span>
            </div>
          </div>
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
