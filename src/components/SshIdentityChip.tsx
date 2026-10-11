import { useRef, useState } from "react";
import type { HealthResponse } from "../api/types";
import { AlertTriangleIcon } from "./ui/icons";

/**
 * True when /api/health reports the server has no SSH identity while key-auth
 * Sparks are configured — the v2.0.1 regression (card t_4495562c): the
 * container lost its key mounts and every remote poll failed with
 * "Permission denied (publickey,password)" while the dashboard looked normal.
 * The server-side warning names the affected Sparks; shown verbatim in the popover.
 */
export function sshIdentityWarning(health: Pick<HealthResponse, "warnings"> | null | undefined): string | null {
  return (health?.warnings ?? []).find((w) => /SSH identity is not mounted/i.test(w)) ?? null;
}

/**
 * Sidebar warning chip shown only while the container is missing its SSH key.
 * Non-dismissible (unlike OpenAccessChip): it is a deploy defect, and it
 * disappears on its own once the key mount is restored and health re-fetched.
 */
export function SshIdentityChip({ health }: { health: HealthResponse | null }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const warning = sshIdentityWarning(health);
  if (!warning) return null;
  return (
    <div
      ref={wrapperRef}
      className="open-access"
      onBlur={(e) => {
        if (!wrapperRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="open-access-chip open-access-chip--warn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ssh-identity-popover"
        title={warning}
      >
        <AlertTriangleIcon className="open-access-dot" />
        SSH key missing
      </button>
      {open && (
        <div id="ssh-identity-popover" className="open-access-popover" role="dialog" aria-label="SSH key missing">
          <p>{warning}</p>
        </div>
      )}
    </div>
  );
}
