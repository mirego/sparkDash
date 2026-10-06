import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../hooks/useModalPresence";
import { fetchOpencodeExport, fetchPiMonoExport } from "../../api/client";
import type { OpencodeExportResponse, PiMonoExportResponse } from "../../api/types";
import { BotIcon, RotateIcon } from "../ui/icons";

/**
 * "Export Configs" modal for the Overview header (story t_da2e5d5e, rework of
 * t_af27512e).
 *
 * Two side-by-side TABS — `opencode` | `pi-mono` — each showing the
 * generated config in a scrollable <pre> with a clipboard copy button and a
 * copy-failure fallback (selectable text + hint). Switching tabs swaps the
 * config; Copy applies to the active tab. Configs load lazily on modal open,
 * never on page load; the server regenerates them per call, so every open is
 * fresh.
 *
 * The server payload may carry `warnings[]`; the UI deliberately ignores
 * them — no warning text is rendered anywhere in this modal (AC #6).
 *
 * Zero plaintext secrets: the payloads come straight from the export
 * endpoints (`text`), which carry only the approved placeholders
 * ("YOUR_API_KEY" literal / env-var indirection). Nothing here transforms
 * the text.
 */

const OPENCODE_TARGET_HINT = "~/.config/opencode/opencode.json";

type TabId = "opencode" | "pimono";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "opencode", label: "opencode" },
  { id: "pimono", label: "pi-mono" },
];

interface SectionState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function initialSection<T>(): SectionState<T> {
  return { data: null, loading: true, error: null };
}

/** Select the full contents of an element (copy-failure fallback). */
function selectContents(el: HTMLElement | null) {
  if (!el) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

interface ConfigTabProps {
  tab: TabId;
  targetHint: string;
  state: SectionState<OpencodeExportResponse | PiMonoExportResponse>;
}

function ConfigTab({ tab, targetHint, state }: ConfigTabProps) {
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    const text = state.data?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyHint(null);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable/blocked (e.g. non-HTTPS context): select the
      // config text in the pre so Ctrl+C is all that's left.
      selectContents(preRef.current);
      setCopyHint("Clipboard blocked — the config below is selected; press Ctrl+C to copy.");
      setCopied(false);
    }
  };

  const text = state.data?.text ?? "";

  return (
    <section
      className="rounded border border-border bg-surface-hover/30 px-3 py-3"
      data-testid={`agent-config-section-${tab}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted opacity-80">→ {targetHint}</span>
        <button
          type="button"
          data-testid={`copy-${tab}-config`}
          onClick={() => void copy()}
          disabled={!state.data || state.loading}
          className="ml-auto rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          title="Copy the config text to the clipboard (placeholder key — no secrets)"
        >
          {copied ? "copied ✓" : "Copy"}
        </button>
      </div>

      {state.loading && (
        <div className="flex items-center gap-2 py-4 text-[11px] text-muted">
          <RotateIcon className="h-3 w-3 animate-spin" />
          generating from live registry…
        </div>
      )}

      {state.error && (
        <div
          data-testid={`agent-config-error-${tab}`}
          className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] text-danger"
        >
          {state.error}
        </div>
      )}

      {copyHint && (
        <div className="mb-2 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
          {copyHint}
        </div>
      )}

      {state.data && (
        <pre
          ref={preRef}
          tabIndex={0}
          spellCheck={false}
          className="max-h-72 cursor-text overflow-auto rounded border border-border bg-surface px-2 py-2 font-mono text-[10px] leading-relaxed text-text-strong select-text"
        >
          <code>{text}</code>
        </pre>
      )}
    </section>
  );
}

interface AgentConfigExportModalProps {
  open: boolean;
  onClose: () => void;
}

export function AgentConfigExportModal({ open, onClose }: AgentConfigExportModalProps) {
  const { mounted, visible } = useModalPresence(open);
  const titleId = "agent-config-export-title";
  const [activeTab, setActiveTab] = useState<TabId>("opencode");
  const [opencode, setOpencode] = useState<SectionState<OpencodeExportResponse>>(initialSection);
  const [pimono, setPimono] = useState<SectionState<PiMonoExportResponse>>(initialSection);
  // Guard so the lazy fetch fires once per open, not on every render.
  const loadedForOpen = useRef(false);

  const load = useCallback(async () => {
    setOpencode(initialSection());
    setPimono(initialSection());
    const [ocRes, piRes] = await Promise.allSettled([
      fetchOpencodeExport(),
      fetchPiMonoExport(),
    ]);
    setOpencode(
      ocRes.status === "fulfilled"
        ? { data: ocRes.value, loading: false, error: null }
        : { data: null, loading: false, error: ocRes.reason instanceof Error ? ocRes.reason.message : String(ocRes.reason) },
    );
    setPimono(
      piRes.status === "fulfilled"
        ? { data: piRes.value, loading: false, error: null }
        : { data: null, loading: false, error: piRes.reason instanceof Error ? piRes.reason.message : String(piRes.reason) },
    );
  }, []);

  useEffect(() => {
    if (!open) {
      loadedForOpen.current = false;
      return;
    }
    if (loadedForOpen.current) return;
    loadedForOpen.current = true;
    void load();
  }, [open, load]);

  useEscapeOnOpen(open, onClose);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  if (!mounted) return null;

  const sectionState: SectionState<OpencodeExportResponse | PiMonoExportResponse> =
    activeTab === "opencode" ? opencode : pimono;
  const targetHint =
    activeTab === "opencode"
      ? OPENCODE_TARGET_HINT
      : (pimono.data?.targetPath ?? "~/.pi/agent/models.json");

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet max-w-3xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header flex items-center gap-2 text-accent" id={titleId}>
          <BotIcon className="h-4 w-4 shrink-0" />
          <span>Agent CLI configs</span>
        </div>

        <div className="modal-sheet__body space-y-3">
          <p className="text-[11px] leading-relaxed text-muted">
            Copy-paste configs pointing your CLIs at the CPA fleet endpoint — regenerated from the
            live registry on every open. Placeholder key only; no secrets are included.
          </p>

          {/* Side-by-side tabs: switching swaps the config below; Copy
              applies to the active tab. */}
          <div
            className="flex gap-1"
            role="tablist"
            aria-label="Agent CLI config format"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                data-testid={`agent-config-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
                className={`rounded-t border-b-2 px-3 py-1 text-[11px] font-semibold transition-colors ${
                  activeTab === t.id
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:text-text"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <ConfigTab tab={activeTab} targetHint={targetHint} state={sectionState} />
        </div>

        <div className="modal-sheet__footer flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Escape closes the modal while it is open (same UX as ConfirmShutdownDialog). */
function useEscapeOnOpen(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}
