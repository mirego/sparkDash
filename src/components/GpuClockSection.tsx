import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGpuClock, resetGpuClock, setGpuClock } from "../api/client";
import type { GpuClockStatus } from "../api/types";

const MIN_CAP_MHZ = 300;

type Ready = Extract<GpuClockStatus, { supported: true }>;

/** Highest clock the boot service applies, e.g. "0,2200" -> 2200. */
function serviceMax(status: Ready): number | null {
  const m = /^\d+,(\d+)$/.exec(status.service.clocks ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * GPU clock cap for one Spark (Edit unit). Acts immediately on the unit with the
 * saved connection settings: it is not part of the Save button.
 */
export function GpuClockSection({ sparkId }: { sparkId: string }) {
  const [status, setStatus] = useState<GpuClockStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxInput, setMaxInput] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Only the newest request may write state: a slow answer for an older unit must not win. */
  const latest = useRef(0);

  const syncInputs = (s: GpuClockStatus) => {
    if (!s.supported) return;
    const cap = s.capMHz ?? serviceMax(s);
    setMaxInput(cap != null ? String(cap) : "");
    setPersist(s.service.installed);
  };

  const load = useCallback(
    async (opts: { sync: boolean }) => {
      const mine = ++latest.current;
      try {
        const s = await fetchGpuClock(sparkId);
        if (mine !== latest.current) return;
        setStatus(s);
        setLoadError(null);
        if (opts.sync) syncInputs(s);
      } catch (err) {
        if (mine !== latest.current) return;
        // Keep what is on screen after a failed refresh; the message says what went wrong.
        setLoadError(err instanceof Error ? err.message : "Could not read the GPU clock cap");
      }
    },
    [sparkId]
  );

  useEffect(() => {
    setStatus(null);
    setLoadError(null);
    setMessage(null);
    setMaxInput("");
    setPersist(false);
    void load({ sync: true });
    return () => {
      latest.current += 1;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU clock cap</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError ?? "Reading the unit…"}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU clock cap</span>
        <p className="field-hint">{status.reason || "Not available on this unit."}</p>
      </div>
    );
  }

  const hwMax = status.hwMaxMHz;
  const maxMHz = Number(maxInput);
  const valid =
    maxInput.trim() !== "" &&
    Number.isInteger(maxMHz) &&
    maxMHz >= MIN_CAP_MHZ &&
    (hwMax == null || maxMHz <= hwMax);
  const sudoMissing = status.sudo === "no";

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: done });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "The unit refused the change" });
    } finally {
      setBusy(false);
      await load({ sync: true });
    }
  };

  const apply = () => {
    if (persist && !confirm("Install a system service on this unit that re-applies the cap at every boot? It runs as root through sudo.")) return;
    void run(
      () => setGpuClock(sparkId, { maxMHz, persist }),
      persist ? `Capped at ${maxMHz} MHz and kept after reboot.` : `Capped at ${maxMHz} MHz until the next reboot.`
    );
  };

  const remove = () => {
    if (!confirm("Remove the GPU clock cap and its boot service from this unit?")) return;
    void run(() => resetGpuClock(sparkId), "Cap removed.");
  };

  return (
    <div className="gpu-clock">
      <label className="field-label" htmlFor="gpu-clock-max">
        GPU clock cap
      </label>
      <p className="gpu-clock__now" data-testid="gpu-clock-now">
        {status.capMHz != null ? (
          <>
            Capped at <b>{status.capMHz} MHz</b>
            {hwMax != null ? ` (GPU maximum ${hwMax} MHz)` : ""}
          </>
        ) : (
          <>No cap in effect{hwMax != null ? ` (GPU maximum ${hwMax} MHz)` : ""}</>
        )}
        {status.service.installed
          ? ` · boot service ${status.service.enabled === "enabled" ? "enabled" : status.service.enabled || "installed"}${
              status.service.clocks ? ` (${status.service.clocks} MHz)` : ""
            }`
          : " · not kept after reboot"}
      </p>
      <div className="gpu-clock__row">
        <input
          id="gpu-clock-max"
          type="number"
          min={MIN_CAP_MHZ}
          max={hwMax ?? undefined}
          inputMode="numeric"
          placeholder={hwMax != null ? `${MIN_CAP_MHZ}–${hwMax}` : "MHz"}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          disabled={busy || sudoMissing}
        />
        <span className="gpu-clock__unit">MHz max</span>
        <button type="button" className="btn btn--sm" onClick={apply} disabled={busy || !valid || sudoMissing}>
          {busy ? "Working…" : "Apply"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} disabled={busy || sudoMissing}>
          Remove limit
        </button>
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy || sudoMissing}
        />
        Keep after reboot (installs a system service)
      </label>
      {sudoMissing ? (
        <p className="field-hint is-warn">
          The user that runs the change needs passwordless sudo on this unit (<code>NOPASSWD: ALL</code>) to change the clock. Nothing was changed.
        </p>
      ) : (
        <p className="field-hint">
          Runs <code>nvidia-smi -lgc 0,MAX</code>{status.sudo === "root" ? " as root on this machine" : " through sudo"}, using the
          saved connection settings. Applies at once; it is not part of Save.
        </p>
      )}
      {maxInput.trim() !== "" && !valid && (
        <p className="field-hint is-warn">
          Enter a whole number from {MIN_CAP_MHZ}{hwMax != null ? ` to ${hwMax}` : ""}.
        </p>
      )}
      {loadError && <p className="field-hint is-warn" role="status">Could not refresh: {loadError}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
