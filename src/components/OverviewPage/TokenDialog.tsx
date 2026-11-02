import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { useMetricsHistory } from "../../hooks/metricsStore";

function formatTok(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function ScrubChart({ data, color, label, pollIntervalMs, secondaryData, secondaryColor, secondaryLabel }: {
  data: readonly number[];
  color: string;
  label: string;
  pollIntervalMs: number;
  secondaryData?: readonly number[];
  secondaryColor?: string;
  secondaryLabel?: string;
}) {
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);
  const W = 600, H = 200;
  const PAD = { top: 12, right: 90, bottom: 28, left: 52 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  if (data.length < 2) {
    return <div className="flex h-[200px] items-center justify-center text-xs text-muted">Not enough data yet — keep the dashboard open.</div>;
  }

  const maxVal = Math.max(...data, 1);
  const minVal = Math.min(...data, 0);
  const span = maxVal - minVal || 1;

  const showSecondary = secondaryData && secondaryData.length > 0;
  const secMax = showSecondary ? Math.max(...secondaryData, 1) : 1;
  const secMin = showSecondary ? Math.min(...secondaryData, 0) : 0;
  const secSpan = (secMax - secMin) || 1;

  const toX = (i: number) => PAD.left + (i / (data.length - 1)) * innerW;
  const toY = (v: number) => PAD.top + innerH - ((v - minVal) / span) * innerH;
  const toSecY = (v: number) => PAD.top + innerH - ((v - secMin) / secSpan) * innerH;
  const points = data.map((v, i) => `${toX(i)},${toY(v)}`);
  const secPoints = showSecondary ? secondaryData.map((v, i) => `${toX(i)},${toSecY(v)}`) : [];

  const gridLabel = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  const gridYs = Array.from({ length: 6 }, (_, i) => {
    const v = minVal + (span * i) / 5;
    return { y: toY(v), label: gridLabel(v) };
  });
  const timeLabels = [0, 1, 2, 3, 4].map((i) => {
    const idx = Math.round((i / 4) * (data.length - 1));
    const secsAgo = (data.length - 1 - idx) * (pollIntervalMs / 1000);
    return { x: toX(idx), label: secsAgo < 60 ? `${Math.round(secsAgo)}s ago` : `${Math.round(secsAgo / 60)}m ago` };
  });

  const scrubValue = scrubIdx != null ? data[scrubIdx] : null;
  const scratchX = scrubIdx != null ? toX(scrubIdx) : null;
  const secsAgo = scrubIdx != null ? (data.length - 1 - scrubIdx) * (pollIntervalMs / 1000) : 0;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vb = e.currentTarget.viewBox.baseVal;
    const svgX = (e.clientX - rect.left) * (vb.width / rect.width);
    const idx = Math.round(((svgX - PAD.left) / innerW) * (data.length - 1));
    setScrubIdx(Math.max(0, Math.min(data.length - 1, idx)));
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ height: "auto", maxHeight: 220 }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setScrubIdx(null)}>
        {gridYs.map((gy, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={gy.y} x2={W - PAD.right} y2={gy.y} stroke="var(--color-grid)" strokeWidth={1} />
            <text x={PAD.left - 6} y={gy.y + 3} textAnchor="end" fill="var(--color-muted)" fontSize={10}>{gy.label}</text>
          </g>
        ))}
        {showSecondary && secSpan > 0 && (
          <>
            {(() => {
              // Integer-optimized tick labels: for small spans (≤4) use step=1,
              // otherwise use 5 evenly-spaced labels rounded to int.
              const raw = Array.from({ length: 5 }, (_, i) => secMin + (secSpan * i) / 4);
              const labels = secMax - secMin <= 4
                ? Array.from({ length: Math.min(secMax - secMin + 1, 5) }, (_, i) => secMin + i)
                : raw.map(v => Math.round(v));
              // Deduplicate but keep positions
              const seen = new Set<number>();
              return labels.filter(v => { const k = Math.round(v * 10); if (seen.has(k)) return false; seen.add(k); return true; }).map((v, i) => {
                const y = toSecY(v);
                return (
                  <text key={i} x={W - PAD.right + 8} y={y + 3} textAnchor="start" fill={secondaryColor || "#888"} fontSize={9}>
                    {v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(1)}K` : v.toFixed(0)}
                  </text>
                );
              });
            })()}
            <text x={W - PAD.right + 8} y={H - PAD.bottom + 14} textAnchor="start" fill={secondaryColor || "#888"} fontSize={8}>
              {secondaryLabel || ""}
            </text>
          </>
        )}
        {timeLabels.map((tl, i) => (
          <text key={i} x={tl.x} y={H - 6} textAnchor="middle" fill="var(--color-muted)" fontSize={10}>{tl.label}</text>
        ))}
        <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={`M${PAD.left},${H - PAD.bottom} L${points.join(" L")} L${W - PAD.right},${H - PAD.bottom} Z`}
          fill={`color-mix(in srgb, ${color} 12%, transparent)`} />
        {showSecondary && secPoints.length > 0 && (
          <g>
            <polyline points={secPoints.join(" ")} fill="none" stroke={secondaryColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2" />
            <path d={`M${PAD.left},${H - PAD.bottom} L${secPoints.join(" L")} L${W - PAD.right},${H - PAD.bottom} Z`}
              fill={`color-mix(in srgb, ${secondaryColor || "#888"} 8%, transparent)`} />
          </g>
        )}
        {scratchX != null && (
          <>
            <line x1={scratchX} y1={PAD.top} x2={scratchX} y2={H - PAD.bottom} stroke="var(--color-text-strong)" strokeWidth={1} strokeDasharray="3 2" opacity={0.5} />
            <circle cx={scratchX} cy={toY(scrubValue ?? 0)} r={4} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {scrubIdx != null && scrubValue != null && (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded border border-border bg-surface-elevated px-2.5 py-1.5 text-xs shadow-lg" style={{ left: "50%", top: "100%", marginTop: 2 }}>
          <div className="flex items-center gap-3">
            <span>
              <span className="font-semibold text-text-strong">{gridLabel(scrubValue)}</span>
              <span className="text-muted"> {label}</span>
            </span>
            {showSecondary && scrubIdx < secondaryData!.length && (
              <span className="border-l border-border pl-3">
                <span className="font-semibold text-text-strong" style={{ color: secondaryColor }}>{Math.round(secondaryData[scrubIdx])}</span>
                <span className="text-muted"> {secondaryLabel}</span>
              </span>
            )}
          </div>
          <div className="text-muted mt-0.5" style={{ fontSize: 10 }}>{secsAgo < 60 ? `${Math.round(secsAgo)}s ago` : `${Math.round(secsAgo / 60)}m ago`}</div>
        </div>
      )}
    </div>
  );
}

/** Token throughput dialog — proper component so hooks work. */
/** Interactive token-throughput dialog: gen vs prefill tabs over live metric history. */
export function TokenDialog({ spark, dialogTab, setDialogTab, dialogTimeRange, setDialogTimeRange, dialogOverlay, setDialogOverlay, onClose }: {
  spark: SparkSnapshot;
  dialogTab: "gen" | "prefill";
  setDialogTab: (t: "gen" | "prefill") => void;
  dialogTimeRange: number;
  setDialogTimeRange: (m: number) => void;
  dialogOverlay: "running" | "waiting" | "ttft";
  setDialogOverlay: (o: "running" | "waiting" | "ttft") => void;
  onClose: () => void;
}) {
  const llmArr = spark.metrics.llm;
  const llm = Array.isArray(llmArr) ? llmArr.length > 0 ? llmArr[0] : null : llmArr;
  const ports = spark.llmPorts ?? [];
  const llmIdx = ports.findIndex((p, i) => llmArr?.[i]?.available);
  const portKey = ports[llmIdx] != null ? `:${ports[llmIdx]}` : ":0";
  const currentTps = dialogTab === "gen" ? llm?.generationTps ?? 0 : llm?.prefillTps ?? 0;
  return (
    <div style={{ position: "fixed", zIndex: 99999, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-surface-elevated, #262626)", borderRadius: 12, padding: 0, maxWidth: 500, width: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", border: "1px solid var(--color-border, #353535)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 20px 12px", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--color-text-strong, #fff)" }}>Token Throughput</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--color-muted, #888)" }}>Live values from the LLM server{llm?.requestsRunning != null ? ` · ${Math.round(llm.requestsRunning)} active request${llm.requestsRunning !== 1 ? "s" : ""}` : ""}</p>
          </div>
          <button type="button" onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--color-muted, #888)", cursor: "pointer", fontSize: 18, padding: "0 2px", lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: "0 20px 20px", overflow: "auto", flex: 1 }}>
          {!llm ? (
            <p style={{ fontSize: 12, color: "var(--color-muted, #888)" }}>No LLM data available.</p>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => setDialogTab("gen")}
                  style={{ borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
                    background: dialogTab === "gen" ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
                    color: dialogTab === "gen" ? "#fff" : "var(--color-muted, #888)" }}>Generation</button>
                <button type="button" onClick={() => setDialogTab("prefill")}
                  style={{ borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
                    background: dialogTab === "prefill" ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
                    color: dialogTab === "prefill" ? "#fff" : "var(--color-muted, #888)" }}>Prefill</button>
                <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,monospace", fontSize: 14, fontWeight: 700, color: "var(--color-text-strong, #fff)" }}>
                  {formatTok(currentTps)}
                  <span style={{ fontSize: 11, fontWeight: 400, color: "var(--color-muted, #888)", marginLeft: 4 }}>
                    {dialogTab === "gen" ? "gen" : "prefill"} tok/s now
                  </span>
                </span>
              </div>
              <div style={{ marginBottom: 12, fontSize: 11, lineHeight: 1.5, color: "var(--color-muted, #888)", padding: "8px 10px", borderRadius: 6, background: "var(--color-surface-hover, #303030)" }}>
                <strong style={{ color: "var(--color-accent, #e8a830)" }}>Generation</strong> — output tokens streamed to the client after the first token (decode).<br />
                <strong style={{ color: "var(--color-warning, #e0a838)" }}>Prefill</strong> — input prompt tokens processed in parallel before generation begins.
              </div>
              <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                {[1, 5, 15, 30, 60].map((m) => (
                  <button key={m} type="button" onClick={() => setDialogTimeRange(m)}
                    style={{ borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 500, border: "none", cursor: "pointer",
                      background: dialogTimeRange === m ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
                      color: dialogTimeRange === m ? "#fff" : "var(--color-muted, #888)" }}>
                    {m < 60 ? `${m}m` : "1h"}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>Overlay</span>
                {(["running", "waiting", "ttft"] as const).map((o) => (
                  <button key={o} type="button" onClick={() => setDialogOverlay(o)}
                    title={o === "ttft" ? "Time-to-first-token p95 (s)" : o === "waiting" ? "Requests waiting for their first byte" : "Requests actively streaming"}
                    style={{ borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 500, border: "none", cursor: "pointer",
                      background: dialogOverlay === o ? "var(--color-accent, #e8a830)" : "var(--color-surface-hover, #303030)",
                      color: dialogOverlay === o ? "#fff" : "var(--color-muted, #888)" }}>
                    {o === "ttft" ? "TTFT (s)" : o}
                  </button>
                ))}
              </div>
              <DialogChart sparkId={spark.id} portKey={portKey} tab={dialogTab} maxSamples={dialogTimeRange * 30} overlay={dialogOverlay} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mounted at OverviewPage level (no portal) — useMetricsHistory is safe. */
function DialogChart({ sparkId, portKey, tab, maxSamples, overlay }: {
  sparkId: string;
  portKey: string;
  tab: "gen" | "prefill";
  maxSamples: number;
  overlay: "running" | "waiting" | "ttft";
}) {
  const color = tab === "gen" ? "var(--color-accent)" : "var(--color-warning)";
  const label = tab === "gen" ? "gen tok/s" : "prefill tok/s";
  const data = useMetricsHistory(sparkId, `llm${portKey}.${tab === "gen" ? "tps" : "prefill"}`);
  const sliced = data.length > maxSamples ? data.slice(-maxSamples) : data;

  // Secondary overlay: requests-running, requests-waiting, or TTFT p95 (s).
  const secKey =
    overlay === "running" ? "running" : overlay === "waiting" ? "waiting" : "ttft";
  const secRaw = useMetricsHistory(sparkId, `llm${portKey}.${secKey}`);
  const secSliced = secRaw.length > maxSamples ? secRaw.slice(-maxSamples) : secRaw;
  const secLabel =
    overlay === "running" ? "req running" : overlay === "waiting" ? "req waiting" : "TTFT s";
  const secColor =
    overlay === "running" ? "var(--color-info, #60a5fa)"
    : overlay === "waiting" ? "var(--color-warning, #e0a838)"
    : "var(--color-danger, #e5594d)";

  return (
    <div>
      <ScrubChart data={sliced} color={color} label={label} pollIntervalMs={2000}
        secondaryData={secSliced.length ? secSliced : undefined}
        secondaryColor={secColor}
        secondaryLabel={secLabel} />
      <p className="mt-2 text-[10px] text-muted">{sliced.length} samples · Hover to inspect</p>
    </div>
  );
}
