import { useEffect, useState } from "react";
import { BotIcon, RotateIcon } from "./ui/icons";

interface ModelStatusData {
  current: string | null;
  cpa: any;
  switchScript: { ok: boolean; stdout: string; stderr: string; code: number } | null;
  available: Array<{ id: string; name: string; type: string; desc: string }>;
}

/** Parse ANSI-colored terminal output to plain text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\\[\\ABbH])/g, "").replace(/\x1B[\[\]()][0-9;]*[a-zA-Z]/g, "");
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

  // Detect current model from CPA data
  const currentModel = data?.current || data?.available?.[0]?.id || null;

  const currentInfo = data?.available?.find((m) => m.id === currentModel);

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BotIcon className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-text-strong">Model Fleet</span>
        </div>
        <button type="button" onClick={fetchStatus} disabled={loading}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover transition-colors disabled:opacity-50">
          <RotateIcon className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {/* Current model badge */}
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

      {/* Available models grid */}
      <div className="mb-3">
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

      {/* Switch script output */}
      {data?.switchScript?.stdout && (
        <details className="group">
          <summary className="cursor-pointer text-[10px] text-muted hover:text-text transition-colors">
            Switch script status
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-surface-hover p-2 text-[9px] leading-tight text-muted font-mono whitespace-pre-wrap">
            {stripAnsi(data.switchScript.stdout)}
          </pre>
        </details>
      )}
    </div>
  );
}
