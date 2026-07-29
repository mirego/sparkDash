import { useEffect, useState } from "react";
import { RotateIcon } from "./ui/icons";

interface ModelUsageRow {
  id: string;
  name: string;
  type: string;
  desc: string;
  switches: number;
  completed: number;
  failed: number;
  lastSeen: number | null;
  lastStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface UsageData {
  models: ModelUsageRow[];
  current: string | null;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

const TYPE_LABELS: Record<string, string> = {
  shared: "🧠 TP=2",
  dual: "🔁 dual",
  single: "📍 single",
};

export function ModelPanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUsage = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models/usage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchUsage(); }, []);

  const models = data?.models || [];

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="text-sm font-semibold text-text-strong">Model Usage History</span>
          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted">{models.length} model{models.length !== 1 ? "s" : ""}</span>
        </div>
        <button type="button" onClick={fetchUsage} disabled={loading}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover transition-colors disabled:opacity-50">
          <RotateIcon className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {models.length === 0 && !loading && (
        <div className="py-8 text-center text-xs text-muted">No model usage data yet. Switch models to start tracking.</div>
      )}

      <div className="space-y-1.5">
        {models.map((m) => {
          const isLive = m.id === data?.current;
          return (
            <div key={m.id}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px", borderRadius: 8,
                border: `1px solid ${isLive ? "var(--color-accent, #e8a830)" : "var(--color-border, #353535)"}`,
                background: isLive ? "rgba(232, 168, 48, 0.06)" : "transparent",
              }}>
              {/* Name + type */}
              <div className="min-w-0" style={{ width: 180, flexShrink: 0 }}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-text-strong truncate">{m.name}</span>
                  {isLive && <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[8px] font-medium text-success">live</span>}
                </div>
                <div className="text-[9px] text-muted mt-px">
                  {TYPE_LABELS[m.type] || m.type} · {m.desc}
                </div>
              </div>

              {/* Last seen */}
              <div className="min-w-0 shrink-0" style={{ width: 70 }}>
                <div className="text-[9px] text-muted">Last seen</div>
                <div className="text-[10px] font-medium text-text-strong">{isLive ? "now" : fmtTime(m.lastSeen)}</div>
              </div>

              {/* Switches */}
              <div className="min-w-0 shrink-0" style={{ width: 60 }}>
                <div className="text-[9px] text-muted">Switches</div>
                <div className="text-[10px] font-medium text-text-strong">
                  {m.switches}
                  {m.failed > 0 && <span className="text-danger ml-1">({m.failed} failed)</span>}
                </div>
              </div>

              {/* Input tokens */}
              <div className="min-w-0 shrink-0 text-right" style={{ width: 80 }}>
                <div className="text-[9px] text-muted">Total Input</div>
                <div className="text-[10px] font-medium text-text-strong font-tabular">{fmtCompact(m.totalInputTokens)}</div>
              </div>

              {/* Output tokens */}
              <div className="min-w-0 shrink-0 text-right" style={{ width: 80 }}>
                <div className="text-[9px] text-muted">Total Output</div>
                <div className="text-[10px] font-medium text-text-strong font-tabular">{fmtCompact(m.totalOutputTokens)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
