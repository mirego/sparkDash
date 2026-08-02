import { useState } from "react";
import type { EnergyBucket } from "../api/types";

/** Format Wh → human short string (auto-scales to kWh). */
export function fmtEnergyWh(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
}

/** Compact axis label: 35 → "35", 3500 → "3.5k". */
function compact(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `${Math.round(v)}`;
}

/**
 * Hand-rolled SVG bar chart for energy buckets (Wh), matching the codebase's
 * custom-chart style (see ScrubChart). Renders proportional bars with a y-axis
 * grid, sparse x labels, hover highlighting, and a live caption.
 */
export function EnergyBarChart({ buckets, window = Infinity }: {
  buckets: EnergyBucket[];
  /** Cap the number of most-recent bars shown. */
  window?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = 220;
  const PAD = { top: 16, right: 16, bottom: 28, left: 52 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const data = window !== Infinity && buckets.length > window ? buckets.slice(-window) : buckets;

  if (data.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-xs text-muted">
        No energy data yet.
      </div>
    );
  }

  const maxVal = Math.max(...data.map((b) => b.value), 1);
  const n = data.length;
  const slot = innerW / n;
  const barW = Math.max(2, Math.min(slot * 0.62, 46));
  const toX = (i: number) => PAD.left + slot * i + (slot - barW) / 2;
  const toY = (v: number) => PAD.top + innerH - (v / maxVal) * innerH;

  const yGrid = Array.from({ length: 5 }, (_, i) => {
    const v = (maxVal * (i + 1)) / 5;
    return { y: toY(v), label: compact(v) };
  });

  // Sparse x labels (~every few periods) so they don't collide.
  const labelStep = Math.max(1, Math.ceil(n / 8));
  const xLabels = data.map((b, i) =>
    i % labelStep === 0 || i === n - 1
      ? { x: PAD.left + slot * i + slot / 2, label: b.label }
      : null
  );

  const hovered = hover != null ? data[hover] : null;

  return (
    <div className="relative">
      <div className="mb-1 h-4 text-xs">
        {hovered ? (
          <span className="text-text">
            <span className="font-semibold text-accent">{fmtEnergyWh(hovered.value)}</span>
            <span className="text-muted"> · {hovered.date}{hovered.label !== "" ? ` (${hovered.label})` : ""} · </span>
            {Object.entries(hovered.sparks).map(([id, wh], i) => (
              <span key={id} className="text-muted">
                {i > 0 ? " · " : ""}{id} {fmtEnergyWh(wh)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ height: "auto", maxHeight: 240 }}
        onMouseLeave={() => setHover(null)} role="img" aria-label="GPU energy bar chart">
        {yGrid.map((g, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={g.y} x2={W - PAD.right} y2={g.y} stroke="var(--color-grid)" strokeWidth={1} />
            <text x={PAD.left - 6} y={g.y + 3} textAnchor="end" fill="var(--color-muted)" fontSize={9}>{g.label}</text>
          </g>
        ))}
        <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="var(--color-border)" strokeWidth={1} />
        {data.map((b, i) => {
          const x = toX(i), y = toY(b.value), h = PAD.top + innerH - y;
          const active = hover === i;
          return (
            <g key={b.date}>
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)} rx={2}
                fill={active ? "var(--color-accent)" : "color-mix(in srgb, var(--color-accent) 55%, transparent)"}
                style={{ cursor: "pointer", transition: "fill 120ms" }}
                onMouseEnter={() => setHover(i)} />
              {active && (
                <line x1={PAD.left + slot * i + slot / 2} y1={PAD.top} x2={PAD.left + slot * i + slot / 2} y2={PAD.top + innerH}
                  stroke="var(--color-text-strong)" strokeWidth={1} strokeDasharray="3 2" opacity={0.5} />
              )}
            </g>
          );
        })}
        {xLabels.map((l, i) =>
          l ? (
            <text key={i} x={l.x} y={H - 8} textAnchor="middle" fill="var(--color-muted)" fontSize={9}>{l.label}</text>
          ) : null
        )}
      </svg>
    </div>
  );
}
