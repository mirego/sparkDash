import { createPortal } from "react-dom";

interface TokenHistoryDialogProps {
  open: boolean;
  onClose: () => void;
  sparkId: string;
  portKey: string;
  currentGenTps: number;
  currentPrefillTps: number;
}

export function TokenHistoryDialog({ open, onClose, sparkId, portKey, currentGenTps, currentPrefillTps }: TokenHistoryDialogProps) {
  if (!open) return null;

  return createPortal(
    <div style={{
      position: "fixed", zIndex: 99999, inset: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.6)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bench-sheet" role="dialog" aria-modal="true"
        style={{ maxWidth: 700, width: "90vw" }}>
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 className="bench-sheet__title">Token Throughput History</h2>
            <p className="bench-sheet__subtitle">Spark {sparkId} · {portKey.replace(":", "")}</p>
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose}>✕</button>
        </header>
        <div className="bench-sheet__body">
          <div className="mb-4" style={{ display: "flex", gap: 24 }}>
            <div><span className="font-tabular text-2xl font-bold text-accent">{currentGenTps.toFixed(0)}</span> <span className="text-xs text-muted">gen tok/s</span></div>
            <div><span className="font-tabular text-2xl font-bold text-warning">{currentPrefillTps.toFixed(0)}</span> <span className="text-xs text-muted">prefill tok/s</span></div>
          </div>
          <p className="text-xs text-muted">
            Chart coming soon with history from the metrics store.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
