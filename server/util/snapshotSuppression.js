/**
 * snapshotSuppression — re-entrant guard for connection-time WS snapshots.
 *
 * While a connection-time snapshot is being built, buildSnapshotPayload()
 * internally runs alertMonitor.update(), whose onChange would broadcast an
 * `alerts` frame to the brand-new client BEFORE its awaited `snapshot` frame —
 * breaking the client contract of snapshot-first. Broadcasts are suppressed
 * during that window.
 *
 * This is a COUNTER, not a boolean: several clients may connect concurrently
 * and each snapshot build can take a while (SSH probes). With a module-level
 * boolean, client A finishing would clear the flag while client B's build is
 * still in flight, re-exposing the exact snapshot-first race the guard exists
 * to prevent. Suppression must hold until the LAST in-flight build completes.
 *
 * Pure (no I/O) so it is trivially unit-testable.
 */
export function createSnapshotSuppression() {
  let builders = 0;
  return {
    /** Mark one in-flight connection snapshot build. */
    begin() {
      builders += 1;
    },
    /** Mark the build finished — always pair in a `finally`. */
    end() {
      builders = Math.max(0, builders - 1);
    },
    /** True while any connection snapshot is still being built. */
    get active() {
      return builders > 0;
    },
  };
}
