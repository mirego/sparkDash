import { useEffect, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { shutdownAllSparks, updateAllHermes, wakeAllSparks } from "../../api/client";
import { enginePhaseLabel, decodeSaturationHint, formatWaitReason, waitReasonDetail } from "../../utils/health";
import { MetricBar } from "../ui/MetricBar";
import { Sparkline } from "../ui/Sparkline";
import { useMetricsHistory, useMetricsHistoryTail } from "../../hooks/metricsStore";
import { ActivityIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";
import { EnergyModal } from "../EnergyModal";
import { InferenceHealthPanel } from "./InferenceHealthPanel";
import { ModelFleetPanel } from "../ModelFleet/ModelFleetPanel";
import { fmtEnergyWh, fmtCost } from "../../utils/energy";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function MiniStat({
  label,
  value,
  tone = "default",
  bold = true,
  title,
  wrap = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
  /** Allow value to wrap (no ellipsis trim) — used for long model ids. */
  wrap?: boolean;
}) {
  const toneClass = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "accent" ? "text-accent" : tone === "success" ? "text-success" : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted">{label}</span>
      <span
        className={`font-tabular text-[13px] ${
          wrap
            ? "whitespace-normal break-words leading-snug [overflow-wrap:anywhere]"
            : "truncate"
        } ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function SpecBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] leading-none">
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-accent">{value}</span>
    </span>
  );
}

function formatTok(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** Interactive SVG scrub chart for token history. */
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
function TokenDialog({ spark, dialogTab, setDialogTab, dialogTimeRange, setDialogTimeRange, dialogOverlay, setDialogOverlay, onClose }: {
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

function SparkCard({ spark, headSparkName, temperatureUnit, onSelect, onOpenDialog }: {
  spark: SparkSnapshot;
  headSparkName?: string | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
  onOpenDialog?: (id: string) => void;
}) {
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const llmArr = spark.metrics.llm;
  const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
  const ports = spark.llmPorts ?? [];
  const llmIdx = ports.findIndex((p, i) => llmArr?.[i]?.available);
  const portKey = ports[llmIdx] != null ? `:${ports[llmIdx]}` : ":0";
  const genHistory = useMetricsHistoryTail(spark.id, `llm${portKey}.tps`);
  const prefillHistory = useMetricsHistoryTail(spark.id, `llm${portKey}.prefill`);

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const vramPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const vramUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const vramAvail = gpu?.vram?.available ?? um?.available ?? 0;

  const tempBarColor = tempRaw > 85 ? "bg-danger" : tempRaw > 65 ? "bg-warning" : tempRaw > 40 ? "bg-accent" : "bg-success";
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  return (
    <div className="overview-card flex flex-col" style={{
      padding: "var(--density-card-pad)", gap: "var(--density-card-gap)",
      ...(online ? {} : { opacity: 0.6 }),
    }}>
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong">
          {onSelect ? (
            <button type="button" onClick={() => onSelect(spark.id)} className="text-left font-inherit text-inherit hover:underline">{spark.name}</button>
          ) : spark.name}
        </span>
        {(() => {
          const role = resolveSparkRole(spark);
          const text = role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
          const title = role === "head" ? "Cluster head Spark"
            : role === "worker" ? (spark.workerLabel?.trim() ? `${spark.workerLabel.trim()} · distributed LLM worker` : "Distributed LLM worker")
            : spark.llmMonitoring === false ? "Standalone — LLM monitoring off" : "Standalone Spark";
          return <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent" title={title}>{text}</span>;
        })()}
        {spark.comfyMonitoring ? (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              !spark.metrics?.comfy?.available
                ? "bg-border/60 text-muted"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? "bg-accent/15 text-accent"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? "bg-warning/15 text-warning"
                    : "bg-border/60 text-muted"
            }`}
            title={
              !spark.metrics?.comfy?.available
                ? "ComfyUI monitoring on — not reachable"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? spark.metrics.comfy.activeJob?.title
                    ? `ComfyUI running: ${spark.metrics.comfy.activeJob.title}`
                    : "ComfyUI job running"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? `ComfyUI queue: ${spark.metrics.comfy.queuePending} pending`
                    : "ComfyUI idle"
            }
          >
            {!spark.metrics?.comfy?.available
              ? "Comfy"
              : (spark.metrics.comfy.queueRunning ?? 0) > 0
                ? "Comfy · run"
                : (spark.metrics.comfy.queuePending ?? 0) > 0
                  ? `Comfy · ${spark.metrics.comfy.queuePending}q`
                  : "Comfy · idle"}
          </span>
        ) : null}
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {online ? "online" : "offline"}
        </span>
      </div>

      {!online || !gpu ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">{online ? "Waiting for metrics…" : "Host unreachable"}</span>
        </div>
      ) : (
        <>
          {/* Three headline bars */}
          <div className="flex flex-col gap-3.5">
            <MetricBar
              label="VRAM"
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}` : "—"}
            />
            {spark.kind === "host" && (() => {
              // Non-Spark hosts: system RAM is separate from discrete VRAM.
              const ram = spark.metrics.ram;
              const rUsed = ram?.used ?? 0;
              const rTotal = ram?.total ?? 0;
              const rPct = rTotal > 0 ? Math.round((rUsed / rTotal) * 100) : 0;
              const ramBarColor = rPct > 85 ? "bg-danger" : rPct > 60 ? "bg-warning" : "bg-accent";
              return (
                <MetricBar
                  label="RAM"
                  value={rUsed}
                  max={rTotal}
                  color={ramBarColor}
                  caption={rTotal > 0 ? `${fmtStorage(rUsed, false)} / ${fmtStorage(rTotal, true)}` : "—"}
                />
              );
            })()}
            <MetricBar
              label={spark.kind === "host" ? "GPU" : "Temperature"}
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            {spark.kind === "host" && (spark.metrics.cpu?.temperature ?? 0) > 0 && (() => {
              const cpuRaw = spark.metrics.cpu?.temperature ?? 0;
              const cpuDisplay =
                temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(cpuRaw) : cpuRaw;
              const cpuLabel =
                temperatureUnit === "fahrenheit" ? `${cpuDisplay}°F` : `${cpuDisplay}°C`;
              const cpuBarColor =
                cpuRaw > 95 ? "bg-danger" : cpuRaw > 85 ? "bg-warning" : cpuRaw > 50 ? "bg-accent" : "bg-success";
              return (
                <MetricBar
                  label="CPU"
                  value={cpuDisplay}
                  max={temperatureUnit === "fahrenheit" ? 212 : 100}
                  color={cpuBarColor}
                  caption={cpuLabel}
                />
              );
            })()}
            {gpu?.throttle?.thermal && (
              <div
                className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger"
                title={gpu.throttle.detail || "GPU thermal slowdown engaged"}
              >
                Thermal throttle
              </div>
            )}
            <MetricBar label="Usage" value={usage} max={100} color={usageBarColor} caption={`${usage}%`} />
          </div>

          {/* Secondary stats */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5">
            <MiniStat label="GPU Power" value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`} />
            {vramAvail > 0 && <MiniStat label="Available" value={formatMb(vramAvail)} tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"} />}
            {(() => {
              const rootDisk = spark.metrics.storage.find((d) => d.label === "/") ?? spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) return <MiniStat label="Storage" value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`} tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"} bold={false} />;
              return null;
            })()}
            {(() => {
              const role = resolveSparkRole(spark);
              if (role === "worker") {
                const label = spark.workerLabel?.trim() || "distributed";
                const title = headSparkName
                  ? `${label} · worker of ${headSparkName}`
                  : `${label} · distributed LLM worker`;
                return (
                  <MiniStat
                    label="Worker"
                    value={label}
                    tone="accent"
                    title={title}
                    wrap
                  />
                );
              }
              if (!llm) return null;
              return (
                <MiniStat
                  label={
                    llm.backend === "vllm"
                      ? "vLLM"
                      : llm.backend === "ds4"
                        ? "ds4"
                        : llm.backend === "sglang"
                          ? "sgLang"
                          : llm.backend === "exl3"
                            ? "EXL3"
                            : llm.backend ?? "LLM"
                  }
                  value={llm.modelId ?? "unknown"}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                  wrap
                />
              );
            })()}
          </div>

          {/* Model Specifications */}
          {llm && (
            <div className="mt-3.5 border-t border-border pt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Model Specs</span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {llm.contextLength != null && <SpecBadge label="Context" value={llm.contextLength >= 1_000_000 ? `${(llm.contextLength / 1_000_000).toFixed(0)}M` : fmtCompact(llm.contextLength)} />}
                {llm.kvCacheUsage != null && <SpecBadge label="KV Cache" value={`${(llm.kvCacheUsage * 100).toFixed(0)}%`} />}
                {llm.totalInputTokens != null && llm.totalInputTokens > 0 && <SpecBadge label="Total Input" value={fmtCompact(llm.totalInputTokens)} />}
                {llm.totalOutputTokens != null && llm.totalOutputTokens > 0 && <SpecBadge label="Total Output" value={fmtCompact(llm.totalOutputTokens)} />}
                {llm.enginePhase && <SpecBadge label="Phase" value={enginePhaseLabel(llm.enginePhase)} />}
                {llm.genTpsPerRunning != null && llm.requestsRunning != null && llm.requestsRunning > 0 && (
                  <SpecBadge label="t/s·stream" value={llm.genTpsPerRunning.toFixed(1)} />
                )}
              </div>
            </div>
          )}
          {/* Decode-saturation callout: high GPU util + crawl gen */}
          {llm && (() => {
            const hint = decodeSaturationHint({
              gpuUsage: usage,
              generationTps: llm.generationTps,
              prefillTps: llm.prefillTps,
              requestsRunning: llm.requestsRunning,
              decodeBound: llm.decodeBound,
              enginePhase: llm.enginePhase,
            });
            if (!hint) return null;
            const tone = hint.level === "danger"
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-warning/40 bg-warning/10 text-warning";
            return (
              <div className={`mt-3 rounded-md border px-2.5 py-2 text-[10px] leading-snug ${tone}`} title={hint.detail}>
                <div className="font-semibold uppercase tracking-wide">{hint.label}</div>
                <div className="mt-0.5 opacity-90">{hint.detail}</div>
              </div>
            );
          })()}
          {/* Big-number tok/s | prefill block — redundant with the sparkline
              section below (which already shows live values + graphs). */}
          {/* {(() => {
            const role = resolveSparkRole(spark);
            if (role === "worker") return null;
            const llmArr = spark.metrics.llm;
            const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
            if (!llm) return null;
            return (
              <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.generationTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted"> tok/s</span>
                </div>
                <div className="border-l border-border text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.prefillTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted"> prefill</span>
                </div>
              </div>
            );
          })()} */}
          {/* Token throughput sparklines */}
          {llm && (
            <button type="button" onClick={() => onOpenDialog?.(spark.id)}
              aria-label="Open token throughput history"
              className="mt-3.5 w-full border-t border-border pt-3 text-center transition-colors hover:bg-accent/5 rounded-sm -mx-1 px-1">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col items-center gap-1">
                  <div className="min-w-0" style={{ width: "100%", maxWidth: 100 }}>
                    <Sparkline data={prefillHistory} width={100} height={24} color="var(--color-warning)" area />
                  </div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="font-tabular text-[13px] font-bold leading-none text-warning">{llm.prefillTps.toFixed(0)}</span>
                    <span className="text-[9px] text-muted">tok/s</span>
                  </div>
                  <span className="text-[8px] uppercase tracking-wider text-muted">Prefill</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="min-w-0" style={{ width: "100%", maxWidth: 100 }}>
                    <Sparkline data={genHistory} width={100} height={24} color="var(--color-accent)" area />
                  </div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="font-tabular text-[13px] font-bold leading-none text-accent">{llm.generationTps.toFixed(0)}</span>
                    <span className="text-[9px] text-muted">tok/s</span>
                  </div>
                  <span className="text-[8px] uppercase tracking-wider text-muted">Generation</span>
                </div>
              </div>
              <div className="mt-2 flex flex-col items-center gap-1 text-[10px]">
                {/* Engine batch truth (vLLM) */}
                {(llm.engineRequestsRunning != null || llm.requestsRunning != null) && (
                  <span
                    className="inline-flex flex-wrap items-center justify-center gap-1"
                    title="vLLM scheduler: requests in the model batch (run) vs accepted but not scheduled (wait)"
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${(llm.engineRequestsRunning ?? llm.requestsRunning ?? 0) > 0 ? "bg-success" : "bg-muted"}`} />
                    <span className="font-medium text-text-strong">
                      {Math.round(llm.engineRequestsRunning ?? llm.requestsRunning ?? 0)} run
                    </span>
                    <span className="text-muted">·</span>
                    <span className={`font-medium ${(llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0) > 0 ? "text-warning" : "text-text-strong"}`}>
                      {Math.round(llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0)} wait
                    </span>
                    {llm.engineWaitReason && (llm.engineRequestsWaiting ?? llm.requestsWaiting ?? 0) > 0 && (
                      <span
                        className="rounded bg-warning/15 px-1 py-0.5 text-[9px] font-medium text-warning"
                        title={waitReasonDetail(llm.engineWaitReason)}
                      >
                        {formatWaitReason(llm.engineWaitReason)}
                      </span>
                    )}
                    <span className="text-muted">engine</span>
                  </span>
                )}
                {/* Proxy first-byte phase (who) */}
                {((llm.proxyRequestsRunning ?? 0) > 0 || (llm.proxyRequestsWaiting ?? 0) > 0) && (
                  <span
                    className="inline-flex flex-wrap items-center justify-center gap-1"
                    title="Auth-proxy: streaming = ≥1 response byte; waiting = accepted, no first byte yet (queue or prefill). Not the same clock as engine run/wait."
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${(llm.proxyRequestsRunning ?? 0) > 0 ? "bg-accent" : "bg-muted"}`} />
                    <span className="font-medium text-text-strong">{Math.round(llm.proxyRequestsRunning ?? 0)} stream</span>
                    <span className="text-muted">·</span>
                    <span className={`font-medium ${(llm.proxyRequestsWaiting ?? 0) > 0 ? "text-warning" : "text-text-strong"}`}>
                      {Math.round(llm.proxyRequestsWaiting ?? 0)} pre-byte
                    </span>
                    <span className="text-muted">proxy</span>
                  </span>
                )}
                {(() => {
                  // Engine-only hint; who/status lives in pills below.
                  const raw = llm.queueHint || "";
                  const engineOnly = raw
                    .replace(/\s*Clients:[^.]*\./g, "")
                    .trim();
                  if (!engineOnly) return null;
                  return (
                    <span
                      className="mt-0.5 max-w-[240px] text-center text-[9px] leading-snug text-warning/90"
                      title={engineOnly}
                    >
                      {engineOnly}
                    </span>
                  );
                })()}
                {llm.activeUsers && llm.activeUsers.length > 0 && (
                  <span className="mt-1 flex flex-wrap items-center justify-center gap-1">
                    {llm.activeUsers.slice(0, 4).map((u) => {
                      const streamN = u.activeCount ?? (u.waiting ? 0 : u.requests);
                      const waitN = u.waitingCount ?? (u.waiting ? u.requests : 0);
                      const fmtK = (n: number | null | undefined) => {
                        if (n == null || !Number.isFinite(Number(n))) return null;
                        const v = Number(n);
                        if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
                        return String(Math.round(v));
                      };
                      const inL = fmtK(u.promptEstTokens);
                      const outL = fmtK(u.completionEstTokens) ?? "0";
                      const maxL = fmtK(u.maxTokens);
                      const cacheL = fmtK(u.cachedTokens);
                      const cachePct =
                        u.cacheHitPct != null && Number.isFinite(Number(u.cacheHitPct))
                          ? `${Math.round(Number(u.cacheHitPct))}%`
                          : null;
                      const inBits =
                        inL == null
                          ? null
                          : cacheL != null
                            ? `in ${inL} (${cacheL} cached${cachePct ? ` · ${cachePct}` : ""})`
                            : `in ${inL}`;
                      const outBits =
                        maxL != null
                          ? `out ${outL} / max ${maxL}`
                          : u.completionEstTokens != null || u.promptEstTokens != null
                            ? `out ${outL}`
                            : null;
                      const ioBits = [inBits, outBits].filter(Boolean).join(" · ");
                      const state = u.waiting
                        ? waitN > 0 && streamN > 0
                          ? "pre-byte + streaming"
                          : "pre-byte (no first token yet)"
                        : "streaming";
                      const reqLines = (u.openRequests || [])
                        .map((r) => {
                          const pi = fmtK(r.promptEstTokens);
                          const co = fmtK(r.completionEstTokens);
                          const ca = fmtK(r.cachedTokens);
                          const cp =
                            r.cacheHitPct != null && Number.isFinite(Number(r.cacheHitPct))
                              ? `${Math.round(Number(r.cacheHitPct))}%`
                              : null;
                          const inPart =
                            ca != null
                              ? `in ${pi ?? "?"} (${ca} cached${cp ? ` · ${cp}` : ""})`
                              : `in ${pi ?? "?"}`;
                          return `${r.phase} ${inPart} · out ${co ?? "0"}${r.maxTokens != null ? ` / max ${fmtK(r.maxTokens)}` : ""} · ${r.ageSec ?? "?"}s`;
                        })
                        .join(" | ");
                      return (
                        <span
                          key={u.label}
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                            u.waiting
                              ? "bg-warning/15 text-warning"
                              : "bg-success/15 text-success"
                          }`}
                          title={`${u.label} · ${state}${streamN ? ` · ${streamN} stream` : ""}${waitN ? ` · ${waitN} pre-byte` : ""} · ${u.requests} in-flight${ioBits ? ` · ${ioBits}` : ""}${reqLines ? `\n${reqLines}` : ""}`}
                        >
                          <span>{u.label}</span>
                          {ioBits ? (
                            <span className="font-tabular opacity-80">{ioBits}</span>
                          ) : null}
                        </span>
                      );
                    })}
                    {llm.activeUsers.length > 4 && (
                      <span className="text-[9px] text-muted">+{llm.activeUsers.length - 4} more</span>
                    )}
                  </span>
                )}
                <span className="text-[9px] text-muted">Click to view full history</span>
              </div>
            </button>
          )}
          </>
        )}
    </div>
  );
}

/**
 * Fleet-wide health banner. Aggregates per-Spark `health` (computed server-side
 * from DGX_SPARK thresholds) into a single warning ribbon shown above the
 * Spark cards: danger ≥ critical, else warn ≥ caution. Hidden when every online
 * Spark is healthy (no silent noise).
 *
 * REMOVED from render (2026-08-29): the "Critical — action needed" / "Warning"
 * ribbon was too alarmist for the overview. Per-Spark health badges on each
 * card + InferenceHealthPanel below the grid still surface alert state.
 * Kept here (unused) so it can be re-added trivially.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function FleetHealthBanner({ sparks }: { sparks: SparkSnapshot[] }) {
  const online = sparks.filter((s) => s.online && s.health);
  const danger = online.filter((s) => s.health!.level === "danger");
  const warn = online.filter((s) => s.health!.level === "warn");
  if (danger.length === 0 && warn.length === 0) return null;

  const critical = danger.length > 0;
  const header = critical
    ? "Critical — action needed"
    : "Warning";
  const tone = critical
    ? "border-danger/40 bg-danger/10 text-danger"
    : "border-warning/40 bg-warning/10 text-warning";
  const lines = [...danger, ...warn].map((s) => {
    const alerts = (s.health?.badges ?? []).filter((b) => b.level !== "ok");
    return { name: s.name, alerts };
  });

  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${critical ? "bg-danger" : "bg-warning"}`} />
        <span className="text-xs font-semibold uppercase tracking-wide">{header}</span>
        <span className="text-[11px] opacity-80">{danger.length + warn.length} of {online.length} online</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {lines.map((l) => (
          <span key={l.name} className="inline-flex items-center gap-1.5 rounded bg-surface-elevated px-2 py-1 text-[11px]">
            <span className="font-semibold text-text">{l.name}</span>
            <span className="text-muted">·</span>
            <span>{l.alerts.map((a) => a.label).join(", ")}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function OverviewPage({ sparks, hideOffline = false, temperatureUnit = "celsius", onSelectSpark }: OverviewPageProps) {
  const visibleSparks = hideOffline ? sparks.filter((s) => s.online) : sparks;
  const [energyOpen, setEnergyOpen] = useState(false);
  const [dialogSparkId, setDialogSparkId] = useState<string | null>(null);
  const [dialogTab, setDialogTab] = useState<"gen" | "prefill">("gen");
  const [dialogTimeRange, setDialogTimeRange] = useState(30);
  const [dialogOverlay, setDialogOverlay] = useState<"running" | "waiting" | "ttft">("running");

  const dialogSpark = dialogSparkId ? visibleSparks.find((s) => s.id === dialogSparkId) ?? null : null;

  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  /** Spark ids we started a batch Hermes update on; drives the live progress bar. */
  const [batchRun, setBatchRun] = useState<string[] | null>(null);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;
  const hermesMonitoredCount = sparks.filter((s) => s.hermes?.monitoring).length;
  const hermesPendingUpdateCount = sparks.filter((s) => s.hermes?.updateAvailable === true).length;

  // Live batch progress — counted from WS snapshots, not from the one-shot HTTP response.
  const batchProg = (() => {
    if (!batchRun || batchRun.length === 0) return null;
    let done = 0;
    let failed = 0;
    for (const id of batchRun) {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) continue;
      if (h.status === "error") {
        done += 1;
        failed += 1;
      } else if (h.status === "success" || h.finishedAt != null) {
        done += 1;
      }
    }
    return { total: batchRun.length, done, failed };
  })();

  // Once every started update has settled (success/error), dismiss the progress bar.
  useEffect(() => {
    if (!batchRun || batchRun.length === 0) return;
    const settled = batchRun.reduce((n, id) => {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) return n;
      return n + (h.status === "success" || h.status === "error" || h.finishedAt != null ? 1 : 0);
    }, 0);
    if (settled === batchRun.length) {
      const t = setTimeout(() => setBatchRun(null), 6000);
      return () => clearTimeout(t);
    }
  }, [batchRun, sparks]);

  async function handleUpdateAllHermes() {
    if (hermesMonitoredCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await updateAllHermes();
      const started = res.results.filter((r) => r.started);
      const skipped = res.results.filter((r) => r.skipped).length;
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      const parts = [`${started.length} update${started.length === 1 ? "" : "s"} started`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      setBatchMsg({
        text: parts.join(", "),
        tone: failed === 0 ? "ok" : "err",
      });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch hermes update failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleShutdownAll() {
    if (onlineShutdownCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [`${ok} shut down`];
      if (fail) parts.push(`${fail} failed`);
      if (skipped) parts.push(`${skipped} skipped`);
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch shutdown failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? `${ok} wake packet(s) sent` : `${ok} sent, ${fail} failed`,
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch wake failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (visibleSparks.length === 0) {
    const allOffline = hideOffline && sparks.length > 0;
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent"><ActivityIcon className="h-5 w-5" /></div>
        <h2 className="text-sm font-semibold text-text-strong">{allOffline ? "All Sparks are offline" : "No Sparks registered"}</h2>
        <p className="mt-1 text-xs text-muted">{allOffline ? "Auto-hide is enabled and no Sparks are currently online." : "Click the + tab to add a DGX Spark unit."}</p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;
  // Today's GPU energy across all visible sparks (Wh), server-accumulated.
  const todayWh = visibleSparks.reduce((sum, s) => sum + (s.energyTodayWh ?? 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-center gap-3">
          <h1 className="font-normal leading-tight tracking-tight text-text-strong" style={{ fontSize: "var(--density-overview-title)" }}>Overview</h1>
          {todayWh > 0 && (
            <button type="button" onClick={() => setEnergyOpen(true)} className="energy-chip"
              title="GPU energy consumed today (all Sparks) — click for daily/weekly/monthly history"
              style={{ border: "none", cursor: "pointer" }}>
              <span className="energy-ico">⚡</span>
              {fmtEnergyWh(todayWh)} / {fmtCost(todayWh)}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-end justify-end gap-3">
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="flex flex-col items-end gap-1">
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <RotateIcon className="h-3 w-3" />
                Updating Hermes — {batchProg.done}/{batchProg.total}
                {batchProg.failed > 0 && (
                  <span className="text-danger">({batchProg.failed} failed)</span>
                )}
                <button
                  type="button"
                  onClick={() => setBatchRun(null)}
                  aria-label="Dismiss update progress"
                  title="Dismiss"
                  className="rounded p-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <span className="text-xs leading-none">✕</span>
                </button>
              </span>
              <div className="h-1 w-36 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    batchProg.failed > 0 ? "bg-danger" : "bg-accent"
                  }`}
                  style={{
                    width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title="Run `hermes update` on every Spark with Hermes Agent enabled"
                  className={`flex items-center gap-1 rounded-md border bg-surface-elevated px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                    hermesPendingUpdateCount > 0
                      ? "border-warning/40 text-warning hover:bg-warning/15"
                      : "border-border text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <RotateIcon className="h-3 w-3" />
                  Update Hermes
                  {hermesPendingUpdateCount > 0 && (
                    <span
                      className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                      title={`${hermesPendingUpdateCount} Spark${hermesPendingUpdateCount === 1 ? "" : "s"} with a Hermes update available`}
                    >
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title="Wake all Sparks that have a MAC configured (WoL)"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
              >
                <PowerOnIcon className="h-3 w-3" />
                Wake All
              </button>
              <button
                type="button"
                onClick={() => setShutdownOpen(true)}
                disabled={batchLoading || onlineShutdownCount === 0}
                title="Shut down all online Sparks"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
              >
                <PowerOffIcon className="h-3 w-3" />
                Shutdown All
              </button>
            </div>
          )}
          <span className="online-chip"><span className="dot" />{onlineCount}/{visibleSparks.length} online</span>
        </div>
      </div>
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdownAll}
        title="Shutdown All"
        description={`Gracefully shut down all ${onlineShutdownCount} online Spark${onlineShutdownCount === 1 ? "" : "s"}? Offline nodes will be skipped.`}
        confirmLabel="Shut down all"
      />
      {/* FleetHealthBanner removed — alert states still visible via per-Spark
          health badges and the InferenceHealthPanel below the cards. */}
      <div className="overview-page grid sm:grid-cols-2 lg:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
        {visibleSparks.map((spark) => (
          <SparkCard key={spark.id} spark={spark}
            headSparkName={spark.workerHeadId ? sparks.find((s) => s.id === spark.workerHeadId)?.name ?? null : null}
            temperatureUnit={temperatureUnit} onSelect={onSelectSpark}
            onOpenDialog={(id) => { setDialogSparkId(id); setDialogTab("gen"); setDialogTimeRange(30); setDialogOverlay("running"); }} />
        ))}
      </div>
      <InferenceHealthPanel sparks={visibleSparks} />
      <ModelFleetPanel enabled={true} />
      {energyOpen && <EnergyModal onClose={() => setEnergyOpen(false)} />}
      {/* Token throughput dialog overlay */}
      {dialogSpark != null && <TokenDialog spark={dialogSpark}
        dialogTab={dialogTab} setDialogTab={setDialogTab}
        dialogTimeRange={dialogTimeRange} setDialogTimeRange={setDialogTimeRange}
        dialogOverlay={dialogOverlay} setDialogOverlay={setDialogOverlay}
        onClose={() => { setDialogSparkId(null); setDialogTab("gen"); setDialogTimeRange(30); setDialogOverlay("running"); }} />
      }
    </div>
  );
}
