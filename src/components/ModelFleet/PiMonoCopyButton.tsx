import { useEffect, useRef, useState } from "react";
import type { PiMonoExportResponse } from "../../api/types";
import { fetchPiMonoExport } from "../../api/client";

/**
 * One-click "Copy pi-mono config" affordance for the Model Fleet header.
 *
 * Calls GET /api/models/export/pimono (the pi-mono format adapter, story
 * t_ab1321df) and puts the generated config on the clipboard. The document
 * targets `~/.pi/agent/models.json` (pi-mono reads only the agent dir — spec
 * t_c1888a2d §1) and always carries the "$CPA_API_KEY" env placeholder for
 * the key (binding ruling d-002; pi's $VAR syntax) — the UI never renders or
 * persists a literal secret; the payload shown in the fallback view is exactly
 * what the server returned (`text`).
 *
 * States: idle → copying… → copied ✓ (2 s) | error line under the header.
 * If the async Clipboard API is unavailable (non-HTTPS context) the config is
 * shown in a selected textarea so the user can copy it manually.
 */
export function PiMonoCopyButton() {
  const [phase, setPhase] = useState<"idle" | "copying" | "copied">("idle");
  const [error, setError] = useState<string | null>(null);
  // Fallback payload when clipboard write is blocked; null = panel hidden.
  const [fallback, setFallback] = useState<PiMonoExportResponse | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const flashCopied = () => {
    setPhase("copied");
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setPhase("idle"), 2000);
  };

  const copy = async () => {
    setPhase("copying");
    setError(null);
    setFallback(null);
    try {
      // Regenerated server-side on every call from the live registry — no
      // sparkDash restart needed for the config to reflect registry changes.
      const res = await fetchPiMonoExport();
      try {
        await navigator.clipboard.writeText(res.text);
        flashCopied();
      } catch {
        // Clipboard API unavailable/blocked (e.g. non-secure context): show the
        // text pre-selected so Ctrl+C is all that's left.
        setFallback(res);
        setError("Clipboard blocked — config shown below and selected; press Ctrl+C to copy.");
        // select() after the fallback textarea renders
        requestAnimationFrame(() => fallbackRef.current?.select());
        setPhase("idle");
      }
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="copy-pimono-config"
        onClick={() => void copy()}
        disabled={phase === "copying"}
        className="rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        title="Copy a ready-to-paste pi-mono models.json generated from the live registry (env placeholder key, no secrets)"
      >
        {phase === "copying" ? "copying…" : phase === "copied" ? "copied ✓" : "copy pi-mono config"}
      </button>
      {error && (
        <div className="mt-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] text-danger">
          {error}
        </div>
      )}
      {fallback && (
        <textarea
          ref={fallbackRef}
          data-testid="pimono-export-fallback"
          readOnly
          value={fallback.text}
          rows={Math.min(18, fallback.text.split("\n").length)}
          spellCheck={false}
          className="mt-2 w-full resize-y rounded border border-border bg-surface px-2 py-2 font-mono text-[10px] leading-relaxed text-text-strong"
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  );
}
