import { useEffect, useState } from "react";
import { BotIcon, RotateIcon } from "./ui/icons";

interface ProbeEndpoint {
  endpoint: string;
  ids: string[];
}

interface CpaData {
  ts: string;
  changed: boolean;
  least_queue_healthy: boolean;
  least_queue_url: string;
  probe: ProbeEndpoint[];
  providers: Array<{
    name: string;
    "base-url": string;
    aliases: string[];
  }>;
  dispatch: Record<string, { mode: string; backends: string[] }>;
  pools: Record<string, any>;
}

interface ModelStatusData {
  current: string | null;
  cpa: CpaData | null;
  switchScript: { ok: boolean; stdout: string; stderr: string; code: number } | null;
  available: Array<{ id: string; name: string; type: string; desc: string }>;
}

/** Extract host label from an endpoint URL. */
function endpointLabel(url: string): string {
  if (url.includes("127.0.0.1") || url.includes("localhost")) return "anton";
  if (url.includes("192.168.100.11")) return "son-of-anton";
  if (url.includes("8000")) return "qwen";
  return url;
}

function endpointPort(url: string): string {
  const m = url.match(/:(\d+)\/v1/);
  return m ? m[1] : "";
}

export function ModelPanel() {
  const [data, setData] = useState<ModelStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/models/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const currentModel = data?.current || null;
  const currentInfo = data?.available?.find((m) => m.id === currentModel);
  const cpa = data?.cpa;
  const probes = cpa?.probe || [];
  const headProbe = probes.find((p) => p.endpoint.includes("127.0.0.1:8888") || p.endpoint.includes("localhost:8888"));
  const workerProbe = probes.find((p) => p.endpoint.includes("192.168.100.11:8888"));

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BotIcon className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-text-strong">Model Fleet</span>
        </div>
        <button type="button" onClick={fetchStatus} disabled={loading}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover transition-colors disabled:opacity-50">
          <RotateIcon className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {/* Current model */}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15">
          <BotIcon className="h-5 w-5 text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-strong truncate">
            {currentInfo?.name || currentModel || "Unknown"}
          </div>
          <div className="text-[10px] text-muted">
            {currentInfo?.type === "shared" ? "🧠 Shared (TP=2)" : currentInfo?.type === "dual" ? "🔁 Dual (least-queue)" : "📍 Single node"}
            {currentInfo?.desc ? ` · ${currentInfo.desc}` : ""}
          </div>
        </div>
        <span className="shrink-0 rounded bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">live</span>
      </div>

      {/* Node status row */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded bg-surface-hover p-2">
          <div className="text-[9px] uppercase tracking-wide text-muted mb-0.5">Head · anton :8888</div>
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${headProbe?.ids?.length ? "bg-success" : "bg-danger"}`} />
            <span className="text-[11px] font-medium text-text-strong truncate">
              {headProbe?.ids?.[0] || "offline"}
            </span>
          </div>
        </div>
        <div className="rounded bg-surface-hover p-2">
          <div className="text-[9px] uppercase tracking-wide text-muted mb-0.5">Worker · son-of-anton :8888</div>
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${workerProbe?.ids?.length ? "bg-success" : workerProbe ? "bg-warning" : "bg-muted"}`} />
            <span className="text-[11px] font-medium text-text-strong truncate">
              {workerProbe?.ids?.[0] || (workerProbe ? "no model" : "unreachable")}
            </span>
          </div>
        </div>
      </div>

      {/* Proxy health */}
      {cpa && (
        <div className="mb-3 flex items-center gap-3 text-[10px] text-muted">
          <span className={`inline-flex items-center gap-1 ${cpa.least_queue_healthy ? "text-success" : "text-warning"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${cpa.least_queue_healthy ? "bg-success" : "bg-warning"}`} />
            {cpa.least_queue_healthy ? "Least-queue proxy: healthy" : "Least-queue proxy: inactive"}
          </span>
          {cpa.ts && (
            <span>· Updated {new Date(cpa.ts).toLocaleTimeString()}</span>
          )}
        </div>
      )}

      {/* Available models */}
      <div className="mb-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">Available Models</div>
        <div className="flex flex-wrap gap-1.5">
          {data?.available?.map((m) => {
            const isActive = m.id === currentModel;
            return (
              <span key={m.id}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] leading-none ${
                  isActive
                    ? "bg-accent text-white font-semibold"
                    : "bg-surface-elevated text-muted"
                }`}
                title={m.desc}>
                {m.name}
                {isActive && <span className="text-[8px] opacity-70">●</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
