/**
 * On-unit programs for the GPU clock cap (the sparkLimiter behaviour):
 * `nvidia-smi -lgc MIN,MAX`, optionally kept across reboots by a oneshot systemd
 * service, and a root-written marker (`/run/sparkdash/gpu-clock-cap`) so the
 * dashboard can show the current cap (NVML cannot read an -lgc lock back).
 *
 * Every program is a POSIX sh script. The only values interpolated into it are
 * integers that this module validates itself plus fixed paths; nothing from a
 * request or from the unit ever reaches a shell as text. Privilege: root runs
 * it directly (the local unit, through the host mount namespace), anyone else
 * uses `sudo -n` and fails with a clear code when sudo wants a password.
 *
 * Programs always exit 0 and report on stdout as `KEY=value` lines
 * (`RESULT=ok|error`, `CODE`, `MSG`, plus the status fields), so an ssh failure
 * and a refused action can be told apart.
 */

export const GPU_CLOCK_SERVICE = "spark-gpu-clock-limit";
/** Same name sparkLimiter uses, so the two tools manage the same unit. */
export const UNIT_NAME = `${GPU_CLOCK_SERVICE}.service`;
export const MARKER_FILE = "gpu-clock-cap";

/** Lowest cap accepted: below this the GPU is barely usable and the box looks hung. */
export const MIN_CAP_MHZ = 300;
export const MAX_CAP_MHZ = 10000;

/** root-owned locations only: never PATH, because the path ends up in a root-run unit. */
const NVSMI_CANDIDATES = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/bin/nvidia-smi"];
const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

const DEFAULT_PATHS = Object.freeze({
  unitDir: "/etc/systemd/system",
  runDir: "/run/sparkdash",
  bootIdFile: "/proc/sys/kernel/random/boot_id",
  systemdRunDir: "/run/systemd/system",
  nvsmi: NVSMI_CANDIDATES,
  systemctl: "systemctl",
  // Test sandbox only: run unprivileged against fake binaries and a temp tree.
  sandbox: false,
});

/** Paths come from code only (tests point them at a sandbox); still refuse anything odd. */
function resolvePaths(overrides = {}) {
  const p = { ...DEFAULT_PATHS, ...overrides };
  const list = [p.unitDir, p.runDir, p.bootIdFile, p.systemdRunDir, ...p.nvsmi];
  if (p.systemctl !== "systemctl") list.push(p.systemctl);
  for (const v of list) {
    if (typeof v !== "string" || !SAFE_PATH.test(v) || v.includes("..")) {
      throw new Error("unsafe path in GPU clock program");
    }
  }
  return p;
}

/**
 * Validate a cap request. Returns normalized integers or throws an Error with `status` 400.
 * @param {unknown} body
 * @returns {{ minMHz: number, maxMHz: number, persist: boolean }}
 */
export function parseCapRequest(body) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const maxMHz = b.maxMHz;
  const minMHz = b.minMHz ?? 0;
  if (!Number.isInteger(maxMHz) || maxMHz < MIN_CAP_MHZ || maxMHz > MAX_CAP_MHZ) {
    throw fail(`maxMHz must be a whole number from ${MIN_CAP_MHZ} to ${MAX_CAP_MHZ}`);
  }
  if (!Number.isInteger(minMHz) || minMHz < 0 || minMHz > maxMHz) {
    throw fail("minMHz must be a whole number from 0 up to maxMHz");
  }
  if (b.persist !== undefined && typeof b.persist !== "boolean") throw fail("persist must be true or false");
  return { minMHz, maxMHz, persist: b.persist === true };
}

/** The systemd unit. `$$` and `%%` are systemd's escapes for `$` and `%`. */
export function buildUnit({ minMHz, maxMHz, nvsmi = "/usr/bin/nvidia-smi", runDir = DEFAULT_PATHS.runDir, bootIdFile = DEFAULT_PATHS.bootIdFile }) {
  for (const n of [minMHz, maxMHz]) if (!Number.isInteger(n) || n < 0) throw new Error("bad clock value");
  const marker = `${runDir}/${MARKER_FILE}`;
  return [
    "[Unit]",
    `Description=Limit NVIDIA GPU graphics clock (${minMHz},${maxMHz} MHz), managed by sparkDash`,
    "After=nvidia-persistenced.service",
    "Wants=nvidia-persistenced.service",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=${nvsmi} -lgc ${minMHz},${maxMHz}`,
    `ExecStartPost=/bin/sh -c 'mkdir -p ${runDir} && echo ${maxMHz} $$(cat ${bootIdFile}) > ${marker}'`,
    `ExecStop=${nvsmi} -rgc`,
    `ExecStopPost=/bin/rm -f ${marker}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function header(paths) {
  const nv = paths.nvsmi.map((c) => `"${c}"`).join(" ");
  return [
    "set -u",
    'SUDO=""',
    paths.sandbox ? ":" : '[ "$(id -u)" = 0 ] || SUDO="sudo -n"',
    `SYSTEMCTL=${paths.systemctl}`,
    `OWNER="${paths.sandbox ? "" : "-o root -g root"}"`,
    `UNIT=${paths.unitDir}/${UNIT_NAME}`,
    `RUNDIR=${paths.runDir}`,
    `MARKER=${paths.runDir}/${MARKER_FILE}`,
    `BOOTID_FILE=${paths.bootIdFile}`,
    "NV=''",
    `for c in ${nv}; do if [ -x "$c" ]; then NV="$c"; break; fi; done`,
    "fail() { printf 'RESULT=error\\nCODE=%s\\nMSG=%s\\n' \"$1\" \"$2\"; exit 0; }",
    'digits() { tr -dc 0-9; }',
    'hwmax() { "$NV" --query-gpu=clocks.max.gr --format=csv,noheader,nounits 2>/dev/null | head -n 1 | digits; }',
    'bootid() { tr -dc "0-9a-fA-F-" < "$BOOTID_FILE" 2>/dev/null | head -c 64; }',
    'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; }',
    // Removes a previous service (a stale one would re-apply the old cap at boot).
    "drop_service() {",
    '  if [ -f "$UNIT" ]; then',
    `    $SUDO $SYSTEMCTL disable --now ${UNIT_NAME} >/dev/null 2>&1 || true`,
    '    $SUDO rm -f "$UNIT" || return 1',
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1 || true",
    "  fi",
    "}",
  ];
}

/** Read-only: current cap, hardware maximum, sudo availability and the service state. */
export function buildStatusProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    "HW=$(hwmax)",
    'if [ "$(id -u)" = 0 ]; then S=root; elif need_sudo; then S=yes; else S=no; fi',
    "CAP=''",
    'if [ -r "$MARKER" ]; then',
    '  read -r M B < "$MARKER" || true',
    '  M=$(printf "%s" "${M:-}" | digits); B=$(printf "%s" "${B:-}" | tr -dc "0-9a-fA-F-")',
    '  if [ -n "$M" ] && [ "$B" = "$(bootid)" ]; then CAP=$M; fi',
    "fi",
    "INST=0; CLK=''; EN=''; ACT=''",
    'if [ -f "$UNIT" ]; then',
    "  INST=1",
    '  CLK=$(sed -n \'s/^ExecStart=.* -lgc \\([0-9][0-9]*,[0-9][0-9]*\\).*/\\1/p\' "$UNIT" | head -n 1 | tr -dc "0-9,")',
    `  EN=$($SYSTEMCTL is-enabled ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    `  ACT=$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    "fi",
    "printf 'RESULT=ok\\nHWMAX=%s\\nSUDO=%s\\nCAP=%s\\nSVC_INSTALLED=%s\\nSVC_CLOCKS=%s\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\n' \"$HW\" \"$S\" \"$CAP\" \"$INST\" \"$CLK\" \"$EN\" \"$ACT\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Apply a cap now; with `persist`, also install/enable the boot service. */
export function buildApplyProgram({ minMHz, maxMHz, persist }, overrides = {}) {
  const paths = resolvePaths(overrides);
  // Defense in depth: the caller validated already, but this is what reaches a root shell.
  const req = parseCapRequest({ minMHz, maxMHz, persist });
  const unit = buildUnit({ minMHz: req.minMHz, maxMHz: req.maxMHz, runDir: paths.runDir, bootIdFile: paths.bootIdFile, nvsmi: "@@NV@@" });
  return [
    ...header(paths),
    `MIN=${req.minMHz}; MAX=${req.maxMHz}; PERSIST=${req.persist ? 1 : 0}`,
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    "HW=$(hwmax)",
    '[ -n "$HW" ] || fail no-gpu "could not read the GPU maximum clock"',
    '[ "$MAX" -le "$HW" ] || fail range "the cap is above this GPU\'s maximum clock ($HW MHz)"',
    'need_sudo || fail no-sudo "passwordless sudo (NOPASSWD: ALL) is required for the user that runs the change"',
    `if [ "$PERSIST" = 1 ] && [ ! -d ${paths.systemdRunDir} ]; then fail no-systemd "systemd is not running on this unit"; fi`,
    // Order matters: nothing existing is touched until the new cap has been accepted by nvidia-smi.
    'lgc() { $SUDO "$NV" -lgc "$MIN,$MAX"; }',
    'lgc_error() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    'write_marker() { B=$(bootid); [ -n "$B" ] || return 1; $SUDO sh -c \'mkdir -p "$1" && chmod 755 "$1" && echo "$2 $3" > "$4"\' sh "$RUNDIR" "$MAX" "$B" "$MARKER"; }',
    'OUT=$(lgc 2>&1) || fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    'if [ "$PERSIST" = 0 ]; then',
    '  if [ -f "$UNIT" ]; then',
    // Stopping the old service resets the clocks (ExecStop), so the cap is applied again afterwards.
    '    drop_service || fail service-failed "could not remove the existing service"',
    '    OUT=$(lgc 2>&1) || fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    "  fi",
    '  write_marker || fail marker-failed "could not record the cap"',
    "else",
    '  write_marker || fail marker-failed "could not record the cap"',
    "  D=$(mktemp -d) || fail service-failed \"could not create a temporary directory\"",
    '  trap \'rm -rf "$D"\' EXIT',
    '  if [ -f "$UNIT" ]; then cp "$UNIT" "$D/unit.old" || fail service-failed "could not back up the existing service"; fi',
    "  cat > \"$D/unit\" <<'SPARKDASH_UNIT_EOF'",
    unit.replace(/\n$/, ""),
    "SPARKDASH_UNIT_EOF",
    '  sed "s#@@NV@@#$NV#g" "$D/unit" > "$D/unit.final" || fail service-failed "could not prepare the service file"',
    // Past this point a failure restores the previous service (or removes ours) and re-applies the live cap.
    "  rollback() {",
    '    if [ -f "$D/unit.old" ]; then',
    '      $SUDO install -m 644 $OWNER "$D/unit.old" "$UNIT" >/dev/null 2>&1',
    "    else",
    `      $SUDO $SYSTEMCTL disable ${UNIT_NAME} >/dev/null 2>&1`,
    '      $SUDO rm -f "$UNIT"',
    "    fi",
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1",
    "    lgc >/dev/null 2>&1",
    "    write_marker >/dev/null 2>&1",
    "  }",
    '  $SUDO install -m 644 $OWNER "$D/unit.final" "$UNIT" || fail service-failed "could not install the service file"',
    "  $SUDO $SYSTEMCTL daemon-reload || { rollback; fail service-failed \"systemctl daemon-reload failed; the cap applies until the next reboot\"; }",
    `  $SUDO $SYSTEMCTL enable ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "could not enable the service; the cap applies until the next reboot"; }`,
    `  $SUDO $SYSTEMCTL restart ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "the service did not start; the cap applies until the next reboot"; }`,
    `  [ "$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null)" = active ] || { rollback; fail service-failed "the service is not active; the cap applies until the next reboot"; }`,
    '  write_marker || fail marker-failed "could not record the cap"',
    "fi",
    "printf 'RESULT=ok\\nCAP=%s\\nPERSIST=%s\\n' \"$MAX\" \"$PERSIST\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Remove the cap: stop and delete the service, `nvidia-smi -rgc`, drop the marker. */
export function buildResetProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    'need_sudo || fail no-sudo "passwordless sudo (NOPASSWD: ALL) is required for the user that runs the change"',
    'drop_service || fail service-failed "could not remove the existing service"',
    '$SUDO "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"',
    '$SUDO rm -f "$MARKER" || fail marker-failed "could not clear the recorded cap"',
    "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Parse a program's KEY=value stdout. Unknown keys are dropped, values are
 * length-capped, and a missing RESULT line is an error (never "healthy").
 * @param {string} out
 * @returns {Record<string, string>}
 */
export function parseProgramOutput(out) {
  const KEYS = new Set([
    "RESULT", "CODE", "MSG", "HWMAX", "SUDO", "CAP", "PERSIST",
    "SVC_INSTALLED", "SVC_CLOCKS", "SVC_ENABLED", "SVC_ACTIVE",
  ]);
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.has(m[1])) res[m[1]] = m[2].slice(0, 300);
  }
  if (res.RESULT !== "ok" && res.RESULT !== "error") {
    return { RESULT: "error", CODE: "bad-output", MSG: "the unit returned an unexpected answer" };
  }
  return res;
}
