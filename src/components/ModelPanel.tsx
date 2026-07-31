import { useState, Fragment, useEffect } from "react";
import { RotateIcon, ChevronDownIcon, ChevronRightIcon } from "./ui/icons";

interface TopUser {
  clientIp: string;
  label: string;
  apiKeyPrefix: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastSeen: number;
}

interface ModelUsageRow {
  id: string;
  name: string;
  type: string;
  desc: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxRequests: number;
  contextLength: number | null;
  totalRequests: number;
  maxConcurrency: number | null;
  /** Added by server — top users from CPA log tracking */
  topUsers?: TopUser[];
  totalClientRequests?: number;
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

function fmtContext(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const TYPE_LABELS: Record<string, string> = {
  shared: "🧠 TP=2",
  dual: "🔁 dual",
  single: "📍 single",
};

type SortKey = "name" | "type" | "totalInputTokens" | "totalOutputTokens" | "maxConcurrency" | "contextLength" | "totalRequests";

const COLUMNS: { key: SortKey; label: string; align?: string }[] = [
  { key: "name", label: "Model" },
  { key: "type", label: "Type" },
  { key: "totalInputTokens", label: "Total Input", align: "right" },
  { key: "totalOutputTokens", label: "Total Output", align: "right" },
  { key: "maxConcurrency", label: "Max Conc", align: "right" },
  { key: "contextLength", label: "Context", align: "right" },
  { key: "totalRequests", label: "Total Reqs", align: "right" },
];

export function ModelPanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("totalInputTokens");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchUsage = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models/usage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: UsageData = await res.json();
      setData(json);
      // Auto-expand the current/live model if data has users
      if (json.current && !expandedId) {
        const liveModel = json.models.find((m) => m.id === json.current);
        if (liveModel && liveModel.topUsers && liveModel.topUsers.length > 0) {
          setExpandedId(json.current);
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchUsage(); }, []);

  const models = data?.models || [];

  const sorted = [...models].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    let cmp = 0;
    if (aVal == null && bVal == null) cmp = 0;
    else if (aVal == null) cmp = -1;
    else if (bVal == null) cmp = 1;
    else if (typeof aVal === "string" && typeof bVal === "string") cmp = aVal.localeCompare(bVal);
    else cmp = (aVal as number) - (bVal as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

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

      {models.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border, #353535)" }}>
                {/* Collapse/expand column */}
                <th style={{ width: 24, padding: "6px 4px" }} />
                {COLUMNS.map((col) => (
                  <th key={col.key} onClick={() => toggleSort(col.key)}
                    style={{
                      textAlign: (col.align as any) || "left",
                      padding: "6px 8px", fontWeight: 600, color: "var(--color-muted, #888)",
                      cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
                    }}>
                    {col.label}
                    {sortKey === col.key && <span style={{ marginLeft: 4 }}>{sortDir === "desc" ? "▼" : "▲"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => {
                const isLive = m.id === data?.current;
                const hasUsers = m.topUsers && m.topUsers.length > 0;
                const isExpanded = expandedId === m.id;
                return (
                  <Fragment key={m.id}>
                    <tr
                      onClick={() => hasUsers && toggleExpand(m.id)}
                      style={{
                        borderBottom: "1px solid var(--color-border, #353535)",
                        background: isLive ? "rgba(232, 168, 48, 0.06)" : "transparent",
                        cursor: hasUsers ? "pointer" : "default",
                        transition: "background 0.15s",
                      }}
                      className={hasUsers ? "hover:bg-surface-hover/50" : ""}
                    >
                      <td style={{ padding: "8px 4px", textAlign: "center", color: "var(--color-muted, #666)" }}>
                        {hasUsers ? (
                          <span style={{ display: "inline-flex", transition: "transform 0.15s", transform: isExpanded ? "rotate(90deg)" : "none" }}>
                            <ChevronRightIcon className="h-3 w-3" />
                          </span>
                        ) : (
                          <span style={{ width: 12, display: "inline-block" }} />
                        )}
                      </td>
                      <td style={{ padding: "8px 8px", fontWeight: 600, color: "var(--color-text-strong, #fff)" }}>
                        <div className="flex items-center gap-1.5">
                          <span className="truncate" style={{ maxWidth: 160 }}>{m.name}</span>
                          {isLive && <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[8px] font-medium text-success">live</span>}
                        </div>
                      </td>
                      <td style={{ padding: "8px 8px", color: "var(--color-text, #ccc)" }}>
                        <span className="text-muted">{TYPE_LABELS[m.type] || m.type}</span>
                      </td>
                      <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "ui-monospace,monospace", color: "var(--color-text, #ccc)" }}>
                        {fmtCompact(m.totalInputTokens)}
                      </td>
                      <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "ui-monospace,monospace", color: "var(--color-text, #ccc)" }}>
                        {fmtCompact(m.totalOutputTokens)}
                      </td>
                      <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "ui-monospace,monospace", color: "var(--color-text, #ccc)" }}>
                        {m.maxConcurrency != null ? m.maxConcurrency : "—"}
                      </td>
                      <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "ui-monospace,monospace", color: "var(--color-text, #ccc)" }}>
                        {fmtContext(m.contextLength)}
                      </td>
                      <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "ui-monospace,monospace", color: "var(--color-text, #ccc)" }}>
                        {fmtCompact(m.totalRequests)}
                      </td>
                    </tr>
                    {isExpanded && hasUsers && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <div style={{
                            background: "rgba(255,255,255,0.02)",
                            borderBottom: "1px solid var(--color-border, #353535)",
                            padding: "10px 16px 12px",
                          }}>
                            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--color-muted, #888)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                              Top Users
                            </div>
                            {m.topUsers!.map((u) => {
                              return (
                                <div key={u.clientIp} style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  padding: "5px 8px", borderRadius: 6,
                                  marginBottom: 3,
                                }}>
                                  <div style={{
                                    width: 6, height: 6, borderRadius: "50%",
                                    background: "var(--color-accent, #e8a830)",
                                    flexShrink: 0,
                                  }} />
                                  <span style={{
                                    flex: 1, fontSize: 11, fontWeight: 500, color: "var(--color-text-strong, #fff)",
                                    fontFamily: "ui-monospace,monospace",
                                  }}>
                                    {u.apiKeyPrefix ? (
                                      <span title={`API key: ${u.apiKeyPrefix}-***`} style={{ cursor: "help" }}>
                                        {u.apiKeyPrefix}
                                      </span>
                                    ) : (
                                      u.label
                                    )}
                                  </span>
                                  <div style={{
                                    display: "flex", alignItems: "center", gap: 10,
                                  }}>
                                    <span title="Input tokens" style={{
                                      fontSize: 10, color: "var(--color-muted, #999)",
                                      fontFamily: "ui-monospace,monospace", whiteSpace: "nowrap",
                                    }}>
                                      {fmtCompact(u.promptTokens)} in
                                    </span>
                                    <span title="Output tokens" style={{
                                      fontSize: 10, color: "var(--color-accent, #e8a830)",
                                      fontFamily: "ui-monospace,monospace", whiteSpace: "nowrap",
                                    }}>
                                      {fmtCompact(u.completionTokens)} out
                                    </span>
                                    <span style={{
                                      fontSize: 10, color: "var(--color-muted, #888)",
                                      fontFamily: "ui-monospace,monospace",
                                    }}>
                                      {u.requests} req
                                    </span>
                                    <span style={{
                                      fontSize: 9, color: "var(--color-muted, #666)",
                                    }}>
                                      {fmtTime(u.lastSeen)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
