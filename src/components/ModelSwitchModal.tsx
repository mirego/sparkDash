import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

interface ModelOption {
  id: string;
  name: string;
  type: "shared" | "dual" | "single";
  desc: string;
}

interface SwitchEvent {
  ts: string;
  model: string;
  status: "started" | "completed" | "failed";
  detail: string | null;
}

const MODELS: ModelOption[] = [
  { id: "dspark", name: "DeepSeek V4 Flash DSpark", type: "shared", desc: "2-node TP=2 · 1M context · 3-token speculative" },
  { id: "qwen", name: "Qwen3.6 35B Q8", type: "dual", desc: "Both Sparks, llama.cpp, least-queue proxy" },
  { id: "qwen-anton", name: "Qwen3.6 35B Q8 (anton only)", type: "single", desc: "Single node only" },
  { id: "laguna", name: "Laguna S 2.1 NVFP4", type: "dual", desc: "Both Sparks, vLLM, least-queue proxy" },
  { id: "laguna-anton", name: "Laguna S 2.1 (anton only)", type: "single", desc: "Single node only" },
];

const TYPE_LABELS: Record<string, { label: string; icon: string }> = {
  shared: { label: "Shared TP=2", icon: "🧠" },
  dual: { label: "Dual (least-queue)", icon: "🔁" },
  single: { label: "Single node", icon: "📍" },
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export function ModelSwitchModal({
  open,
  onClose,
  currentModel,
}: {
  open: boolean;
  onClose: () => void;
  currentModel: string | null;
}) {
  const [step, setStep] = useState<"select" | "confirm" | "progress">("select");
  const [selected, setSelected] = useState<ModelOption | null>(null);
  const [switching, setSwitching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [events, setEvents] = useState<SwitchEvent[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [liveCurrentModel, setLiveCurrentModel] = useState<string | null>(null);

  // Fetch current model status when modal opens
  useEffect(() => {
    if (!open) return;
    fetch("/api/models/status").then(r => r.json()).then(d => {
      setLiveCurrentModel(d.current || null);
    }).catch(() => {});
  }, [open]);

  // Resolve the effective current model (prop first, then live fetch)
  const effectiveCurrent = currentModel || liveCurrentModel;

  const handleSelect = (m: ModelOption) => {
    setSelected(m);
    setStep("confirm");
  };

  const handleConfirm = async () => {
    if (!selected) return;
    setSwitching(true);
    setStep("progress");
    try {
      const res = await fetch("/api/models/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selected.id }),
      });
      const data = await res.json();
      setResult(data);
      // Start polling for completion
      const poll = setInterval(async () => {
        try {
          const r = await fetch("/api/models/switch-status", { method: "POST" });
          const s = await r.json();
          if (!s.inProgress) {
            clearInterval(poll);
            setSwitching(false);
            // Reload events
            const ev = await fetch("/api/models/history");
            const eh = await ev.json();
            setEvents(eh.events || []);
          }
        } catch {}
      }, 3000);
    } catch (err: unknown) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Request failed" });
      setSwitching(false);
    }
  };

  const loadHistory = async () => {
    if (!showHistory) {
      try {
        const res = await fetch("/api/models/history");
        const data = await res.json();
        setEvents(data.events || []);
      } catch {}
    }
    setShowHistory(!showHistory);
  };

  const handleClose = () => {
    setStep("select");
    setSelected(null);
    setSwitching(false);
    setResult(null);
    setShowHistory(false);
    onClose();
  };

  if (!open) return null;

  const currentInfo = MODELS.find((m) => m.id === effectiveCurrent);

  return createPortal(
    <div style={{ position: "fixed", zIndex: 99999, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
      onClick={handleClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-surface-elevated, #262626)", borderRadius: 12, padding: 0, maxWidth: 480, width: "90vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", border: "1px solid var(--color-border, #353535)" }}>
        
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 20px 12px", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--color-text-strong, #fff)" }}>
              {step === "select" && "Switch Model"}
              {step === "confirm" && selected && `Switch to ${selected.name}?`}
              {step === "progress" && (switching ? "Switching..." : result?.ok ? "Switch Complete" : "Switch Failed")}
            </h2>
            {currentInfo && (
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--color-muted, #888)" }}>
                Currently running: {currentInfo.name} ({currentInfo.desc})
              </p>
            )}
          </div>
          <button type="button" onClick={handleClose}
            style={{ background: "none", border: "none", color: "var(--color-muted, #888)", cursor: "pointer", fontSize: 18, padding: "0 2px", lineHeight: 1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: "0 20px 20px", overflow: "auto", flex: 1 }}>

          {/* Step 1: Select model */}
          {step === "select" && (
            <div>
              <div className="flex flex-wrap gap-2">
                {["shared", "dual", "single"].map((type) => {
                  const group = MODELS.filter((m) => m.type === type);
                  const tl = TYPE_LABELS[type];
                  return (
                    <div key={type} className="w-full" style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--color-muted, #888)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                        {tl.icon} {tl.label}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.map((m) => {
                          const isCurrent = m.id === effectiveCurrent;
                          return (
                            <button key={m.id} type="button" onClick={() => !isCurrent && handleSelect(m)} disabled={isCurrent}
                              style={{
                                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                                padding: "10px 12px", borderRadius: 8, border: `1px solid ${isCurrent ? "var(--color-accent, #e8a830)" : "var(--color-border, #353535)"}`,
                                background: isCurrent ? "rgba(232, 168, 48, 0.08)" : "var(--color-surface-hover, #303030)",
                                cursor: isCurrent ? "default" : "pointer", opacity: isCurrent ? 0.7 : 1,
                              }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, color: isCurrent ? "var(--color-accent, #e8a830)" : "var(--color-text-strong, #fff)" }}>
                                  {m.name} {isCurrent && <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-muted, #888)" }}>(active)</span>}
                                </div>
                                <div style={{ fontSize: 10, color: "var(--color-muted, #888)", marginTop: 2 }}>{m.desc}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2: Confirm */}
          {step === "confirm" && selected && (
            <div>
              <div style={{
                padding: "12px 14px", borderRadius: 8, marginBottom: 14,
                background: "rgba(220, 38, 38, 0.08)", border: "1px solid rgba(220, 38, 38, 0.2)",
                fontSize: 12, color: "var(--color-text, #ccc)",
              }}>
                <strong style={{ color: "#ef4444" }}>⚠️ Warning:</strong> This will stop the currently running model and switch to <strong>{selected.name}</strong>. The API will be unavailable during the switch (usually 2-10 minutes).
              </div>
              <div style={{ fontSize: 11, color: "var(--color-muted, #888)", marginBottom: 14 }}>
                <div style={{ marginBottom: 4 }}>
                  <span style={{ color: "var(--color-text-strong, #fff)" }}>From:</span> {currentInfo?.name || currentModel || "Unknown"}
                </div>
                <div>
                  <span style={{ color: "var(--color-text-strong, #fff)" }}>To:</span> {selected.name}
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStep("select")}
                  style={{ flex: 1, borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 500, border: "1px solid var(--color-border, #353535)", cursor: "pointer", background: "transparent", color: "var(--color-text-strong, #fff)" }}>
                  Cancel
                </button>
                <button type="button" onClick={handleConfirm}
                  style={{ flex: 2, borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", background: "var(--color-accent, #e8a830)", color: "#000" }}>
                  Switch to {selected.name}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Progress */}
          {step === "progress" && (
            <div>
              {switching ? (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>
                  <div style={{ fontSize: 13, color: "var(--color-text-strong, #fff)", marginBottom: 6 }}>
                    Switching to {selected?.name}...
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-muted, #888)" }}>
                    This usually takes 2-10 minutes. The page will update when complete.
                  </div>
                  <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
                    <div style={{ width: 24, height: 24, border: "2px solid var(--color-border, #353535)", borderTopColor: "var(--color-accent, #e8a830)", borderRadius: "50%", animation: "spinner 0.8s linear infinite" }} />
                  </div>
                </div>
              ) : result?.ok ? (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
                  <div style={{ fontSize: 13, color: "var(--color-success, #4ade80)", marginBottom: 6, fontWeight: 600 }}>
                    Switch complete!
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-muted, #888)" }}>
                    {selected?.name} is now running.
                  </div>
                  <button type="button" onClick={handleClose}
                    style={{ marginTop: 16, borderRadius: 8, padding: "8px 24px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", background: "var(--color-accent, #e8a830)", color: "#000" }}>
                    Done
                  </button>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>❌</div>
                  <div style={{ fontSize: 13, color: "#ef4444", marginBottom: 6, fontWeight: 600 }}>
                    Switch failed
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-muted, #888)", marginBottom: 16 }}>
                    {result?.message || "Unknown error"}
                  </div>
                  <button type="button" onClick={() => { setStep("select"); setResult(null); }}
                    style={{ borderRadius: 8, padding: "8px 24px", fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", background: "var(--color-accent, #e8a830)", color: "#000" }}>
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}

          {/* History toggle (visible on select + confirm) */}
          {(step === "select" || step === "confirm") && (
            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={loadHistory}
                style={{ fontSize: 10, color: "var(--color-muted, #888)", cursor: "pointer", background: "none", border: "none", padding: 0, textDecoration: "underline" }}>
                {showHistory ? "Hide switch history" : "Show switch history"}
              </button>
              {showHistory && (
                <div style={{ marginTop: 8, maxHeight: 160, overflow: "auto" }}>
                  {events.length === 0 ? (
                    <div style={{ fontSize: 10, color: "var(--color-muted, #888)", padding: "8px 0" }}>No switch history yet.</div>
                  ) : (
                    events.slice(0, 20).map((evt, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 10, borderBottom: "1px solid var(--color-border, #353535)" }}>
                        <span style={{ width: 14, textAlign: "center" }}>
                          {evt.status === "completed" ? "✅" : evt.status === "failed" ? "❌" : "⏳"}
                        </span>
                        <span style={{ flex: 1, color: "var(--color-text-strong, #fff)", fontWeight: 500 }}>
                          {MODELS.find((m) => m.id === evt.model)?.name || evt.model}
                        </span>
                        <span style={{ color: "var(--color-muted, #888)", whiteSpace: "nowrap" }}>{fmtDate(evt.ts)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>,
    document.body
  );
}
