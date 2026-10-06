// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with an NVIDIA GPU (still monitored via nvidia-smi,
   *   just not a Spark). Real hardware is auto-detected once online.
   */
  kind?: "spark" | "host";
  lanIp: string;
  cx7Ip?: string | null;
  llmHost?: string | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Ports that have an encrypted LLM API key stored server-side.
   * The key itself is never returned by the API.
   */
  llmApiKeyPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /**
   * Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /**
   * Probe local ComfyUI and show the ComfyUI card (default false; all roles).
   */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188). */
  comfyPort?: number;
  /**
   * Opt-in: Hermes Agent CLI (nousresearch/hermes-agent) is installed on this
   * machine. When enabled, sparkDash checks for Hermes updates and can run
   * `hermes update` for you via SSH.
   */
  hermesMonitoring?: boolean;
  /**
   * Report tailnet presence via `tailscale status --json` (default false; all roles).
   */
  tailscaleMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hermes Agent status ───────────────────────────────
/** Opt-in Hermes Agent update monitoring state, pushed in every snapshot. */
export interface HermesStatus {
  /** Opt-in setting from Edit Spark (hermes installed on this machine). */
  monitoring: boolean;
  /** Whether the `hermes` binary was found on the target. null before first check. */
  installed: boolean | null;
  /** Installed version string when detected (e.g. "0.20.0"). */
  version: string | null;
  /** true when `hermes update --check` reports commits behind origin/main. */
  updateAvailable: boolean | null;
  /** Number of commits behind origin/main when reported. */
  behindCommits: number | null;
  /** Last check time (ms epoch). */
  checkedAt: number | null;
  /** One-shot update job state. */
  status: "idle" | "running" | "success" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Short human-readable message when the last check/update failed. */
  error: string | null;
}

/** Latest public Hermes Agent release (changelog for the update dialog). */
export interface HermesRelease {
  /** GitHub release tag, e.g. "v2026.7.7.2". */
  tagName: string;
  /** Human release name, e.g. "Hermes Agent v0.18.1 (v2026.7.7.2)". */
  name: string;
  version: string;
  /** Semantic version of the release (e.g. "0.20.0") for bump detection. */
  semver: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  /** Markdown release body. */
  body: string;
}

/** One pending commit an update would bring (from git HEAD..origin/main). */
export interface HermesPendingCommit {
  sha: string;
  title: string;
}

/** One Spark's outcome from a batch `update-all` call. */
export interface HermesBatchUpdateResult {
  id: string;
  name: string;
  ok: boolean;
  started: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface HermesBatchUpdateResponse {
  success: boolean;
  results: HermesBatchUpdateResult[];
}

/** Per-Spark update preview used by the confirmation dialog. */
export interface HermesUpdatesResponse {
  success: boolean;
  /** Which content the dialog should lead with. */
  view: "commits" | "release";
  /** Latest tagged release (may be null on GitHub API failure). */
  release: HermesRelease | null;
  releaseError: string | null;
  /** Installed hermes version on this Spark (e.g. "0.20.0"), when known. */
  installedVersion: string | null;
  /** Pending commits from git (may be null if the repo can't be read). */
  pending: { count: number; headSha: string | null; commits: HermesPendingCommit[] } | null;
}

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string | null;
  cpuCores: number | null;
  totalMemoryGB: number | null;
  gpuChip: string | null;
  /** Number of physical GPUs behind `gpuChip` (absent on DGX Spark units). */
  gpuCount?: number;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
/**
 * Multi-zone thermal / cooling / reliability telemetry surfaced per-GPU.
 * Fields are null when the reported value is [N/A] on the hardware — a null is
 * rendered as "—" (unknown), never a misleading 0 (no-silent-failures rule).
 */
export interface HealthBadge {
  id: string;
  level: "ok" | "warn" | "danger";
  /** Short label, e.g. "GPU junction", "Fan", "OOM risk". */
  label: string;
  /** Human-readable current value / detail, e.g. "77°C". */

  detail: string;
}

export interface GpuThrottle {
  /** HW or SW thermal slowdown engaged. */
  thermal: boolean;
  /** HW slowdown (may include thermal or power brake). */
  hwSlowdown: boolean;
  /** SW power-cap scaling limiting clocks. */
  powerCap: boolean;
  /** Any limiting reason above. */
  active: boolean;
  reason: "ok" | "thermal" | "power" | "hw" | "unknown";
  smClockMHz: number | null;
  smClockMaxMHz: number | null;
  /** Current SM clock as % of max (0–100). null when clocks unavailable. */
  smClockPct: number | null;
  /** Human-readable active reasons (tooltip). */

  detail: string;
}

export interface GpuMetrics {
  temperature: number;
  /** Multi-zone thermal: memory-junction temperature (°C), null when N/A. */
  temperatures?: { memory: number | null };
  /** Fan speed; % or RPM depending on driver. null when N/A. */
  fan?: number | null;
  /** SM + memory clock rates (MHz). null when N/A/unified memory. */
  clocks?: { sm: number | null; mem: number | null };
  /** Power state, e.g. "P0"/"P8". null when N/A. */
  pstate?: string | null;
  /** Volatile ECC error counters. null when ECC disabled/unsupported. */
  ecc?: { corrected: number | null; uncorrected: number | null };
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
  /** NVIDIA clock throttle / thermal slowdown state from nvidia-smi. */
  throttle?: GpuThrottle | null;
  /** Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). */
  nvErrNoMemory?: number;
  /**
   * Per-physical-GPU breakdown for multi-card hosts. The fields above stay the
   * fleet-wide aggregate (hottest / busiest card, summed power and VRAM), so a
   * one-GPU DGX Spark has exactly one entry here mirroring them.
   */
  gpus?: GpuDevice[];
}

/** One physical GPU as reported by nvidia-smi (`index,name,uuid`). */
export interface GpuDevice {
  index: number;
  name: string | null;
  uuid: string | null;
  temperature: number;
  usage: number;
  power: { draw: number; limit: number };
  vram: { used: number; total: number; percentage: number; available: number };
  throttle?: GpuThrottle | null;
  /** Processes holding memory on this card only. */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  /** °C. null when the host exposes no readable temperature source. */
  temperature: number | null;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  readSpeed: number;
  writeSpeed: number;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | "ds4" | "exl3" | "q27" | "tensorfold" | null;
  modelId: string | null;
  modelPath: string | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Live cached-prefill tok/s when the backend splits kinds (ds4, llama.cpp, sglang). */
  cachedPrefillTps?: number | null;
  /** Live uncached/computed prefill tok/s when split is available. */
  uncachedPrefillTps?: number | null;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** Cumulative total input (prompt) tokens as reported by the LLM server */
  totalInputTokens: number;
  /** Cumulative cached (prefix-cache served) prompt tokens. null when the backend does not expose the split. */
  totalCachedTokens: number | null;
  /** Cumulative total prompt (prefill) tokens as reported by the LLM server. null when the backend does not expose it. */
  totalPromptTokens: number | null;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds (recent rolling window). null when unavailable. */
  ttftP95Seconds?: number | null;
  /** vLLM time-to-first-token mean in seconds (recent rolling window). null when unavailable. */
  ttftMeanSeconds?: number | null;
  /** Live recent-window mean TTFT (seconds) from vLLM histogram sum/count deltas. null when unavailable. */
  ttftSeconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  /**
   * Engine phase for decode-bound diagnosis:
   * IDLE | PREFILL | DECODE | SLOW_DECODE | QUEUED | DOWN
   */
  enginePhase?: "IDLE" | "PREFILL" | "DECODE" | "SLOW_DECODE" | "QUEUED" | "DOWN" | string | null;
  /** generationTps / max(running,1) — per-stream feel. */
  genTpsPerRunning?: number | null;
  /** 1 / itlP95Seconds when ITL available. */
  itlImpliedTps?: number | null;
  /**
   * True when the engine looks decode-bound (low gen / high ITL / elevated KV)
   * with prefill quiet. Pair with GPU util for “busy GPU, 0 tok/s”.
   */
  decodeBound?: boolean;
  /**
   * vLLM num_requests_waiting_by_reason breakdown, e.g. { capacity: 1, deferred: 0 }.
   * null when the series is missing.
   */
  waitingByReason?: Record<string, number> | null;
  /** Dominant engine wait reason: capacity | deferred | mixed | … */
  engineWaitReason?: string | null;
  /**
   * Human one-liner: engine queue reason + live KV + who is waiting/streaming
   * at the auth-proxy. null when nothing interesting.
   */
  queueHint?: string | null;
  /** Engine-native running count (vLLM batch). Same as requestsRunning after fix. */
  engineRequestsRunning?: number | null;
  /** Engine-native waiting count (vLLM scheduler queue). */
  engineRequestsWaiting?: number | null;
  /**
   * Auth-proxy: requests that have received ≥1 response byte (streaming).
   * Different clock from engine run — do not treat as GPU batch size.
   */
  proxyRequestsRunning?: number | null;
  /**
   * Auth-proxy: accepted but no first response byte yet (upstream queue or prefill).
   */
  proxyRequestsWaiting?: number | null;
  /**
   * Users with active or waiting (in-flight) requests, reported by the
   * auth-proxy in real-time. Each entry includes whether the user has any
   * requests still waiting for their first response byte.
   */
  /**
   * Last N completed requests from auth-proxy (newest first), with full I/O.
   * Shown in Inference Health when the in-flight list is empty or alongside it.
   */
  recentRequests?: Array<{
    id: string;
    user: string;
    phase?: string;
    model?: string | null;
    maxTokens?: number | null;
    promptEstTokens?: number | null;
    completionEstTokens?: number | null;
    cachedTokens?: number | null;
    cacheHitPct?: number | null;
    promptSource?: string | null;
    completionSource?: string | null;
    ageSec?: number | null;
    ttftSec?: number | null;
    durationSec?: number | null;
    finishedAt?: number | null;
    path?: string | null;
  }>;
  activeUsers?: Array<{
    label: string;
    requests: number;
    waiting: boolean;
    /** Distinct waiting (throttled, pre-first-byte) request count. */
    waitingCount?: number;
    /** Distinct active (streaming) request count — these occupy GPU slots. */
    activeCount?: number;
    /** Cumulative prompt bytes forwarded to the upstream for this user. */
    inputBytes?: number;
    /** Live estimated prompt tokens (open requests). */
    promptEstTokens?: number | null;
    /** Live estimated/official completion tokens (open requests). */
    completionEstTokens?: number | null;
    /** Prefix-cache hit tokens from usage.prompt_tokens_details.cached_tokens. */
    cachedTokens?: number | null;
    cacheHitPct?: number | null;
    /** Sum of max_tokens on open requests. */
    maxTokens?: number | null;
    model?: string | null;
    openRequests?: Array<{
      id: string;
      phase: string;
      model?: string | null;
      maxTokens?: number | null;
      promptEstTokens?: number | null;
      completionEstTokens?: number | null;
      cachedTokens?: number | null;
      cacheHitPct?: number | null;
      promptSource?: string | null;
      completionSource?: string | null;
      ageSec?: number | null;
      ttftSec?: number | null;
    }>;
  }>;
  /**
   * Observational exposure hint from unauthenticated probe reachability +
   * configured target host scope. null when auth status is unknown.
   * Does not claim process bind address.
   */
  posture?: LlmPosture | null;
  error: string | null;
}

/** One UTC day of busy tok/s rollups (null avg = no busy samples). */
export interface LlmDailyDay {
  date: string;
  decodeMax: number;
  decodeAvg: number | null;
  prefillMax: number;
  prefillAvg: number | null;
  cachedPrefillMax: number | null;
  cachedPrefillAvg: number | null;
  uncachedPrefillMax: number | null;
  uncachedPrefillAvg: number | null;
}

export interface LlmDailyResponse {
  sparkId: string;
  port: number;
  days: LlmDailyDay[];
}

/** Security posture badge payload from LlmProbe. */
export interface LlmPosture {
  /** ok = green, warn = amber, danger = red */
  level: "ok" | "warn" | "danger";
  auth: "open" | "protected" | "keyed";
  scope: "local" | "lan" | "public" | "unknown";
  /** Short badge text */
  label: string;
  /** Tooltip / title detail */
  detail: string;
}

// ─── ComfyUI metrics ─────────────────────────────────────
/** Active or queued ComfyUI job (parsed from /queue prompt graph). */
export interface ComfyJob {
  id: string;
  status: "running" | "pending";
  /** Workflow title when present in extra_pnginfo. */
  title: string | null;
  /** Model weight files referenced by loader nodes. */
  models: string[];
  nodeCount: number;
  steps: number | null;
  width: number | null;
  height: number | null;
  batchSize: number | null;
  sampler: string | null;
  /** Queue entry create time (ms epoch when available). */
  createTime: number | null;
}

/** Live or estimated progress for the active Comfy job. */
export interface ComfyProgress {
  promptId: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  value: number;
  max: number;
  percent: number | null;
  updatedAt: number;
  /** ws = Comfy WebSocket frames; estimate = elapsed/avg heuristic */
  source?: "ws" | "estimate";
}

export interface ComfyLastJob {
  id: string;
  status: "completed" | "failed" | "cancelled" | string;
  title: string | null;
  durationMs: number | null;
  endedAt: number | null;
}

export interface ComfyModelsInstalled {
  checkpoints: string[];
  loras: string[];
}

export interface ComfyMetrics {
  available: boolean;
  port: number;
  version: string | null;
  pytorchVersion: string | null;
  /** Primary device type from /system_stats (e.g. cpu, cuda) — not VRAM. */
  deviceType?: string | null;
  queueRunning: number;
  queuePending: number;
  /** Currently executing job, if any. */
  activeJob?: ComfyJob | null;
  /** Next pending jobs (capped server-side). */
  pendingJobs?: ComfyJob[];
  progress?: ComfyProgress | null;
  lastJob?: ComfyLastJob | null;
  modelsInstalled?: ComfyModelsInstalled | null;
  /** Estimated ms until queue idle (running remainder + pending × avg). */
  queueEtaMs?: number | null;
  /** Browser-openable ComfyUI base URL (probe host + port). */
  openUrl?: string | null;
  error: string | null;
}

export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /**
   * The node's OWN view of whether it is talking to the coordination server.
   * null when tailscale did not report it.
   */
  online: boolean | null;
  /** tailscaled's own state: Running | Stopped | NeedsLogin | NoState. */
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailscaleIp: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** ISO timestamp; null when key expiry is disabled for this node. */
  keyExpiry: string | null;
  keyExpired: boolean;
  version: string | null;
  /** Tailscale's own health warnings — these explain a false `online`. */
  health: string[];
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
  /** ComfyUI probe result when monitoring is enabled; null when off or not yet polled. */
  comfy?: ComfyMetrics | null;
  /** Tailnet probe result when monitoring is enabled; null when off or not yet polled. */
  tailscale?: TailscaleMetrics | null;
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  name: string;
  /** Unit type: spark (DGX Spark) or host (dedicated GPU Linux box). */
  kind?: "spark" | "host";
  online: boolean;
  /** Today's GPU energy consumption for this spark, in Wh (server-accumulated). */
  energyTodayWh?: number;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  isLocal?: boolean;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  lanIp: string;
  llmHost: string | null;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /**
   * Derived worker label: live mirror of the head's served model id.
   * Display-only (never written to config). A non-empty manual workerLabel
   * takes priority over this in the UI.
   */
  workerDerivedLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  /** Ports with a stored LLM API key (key itself never exposed) */
  llmApiKeyPorts?: number[];
  /** Whether ComfyUI is probed (opt-in; all roles) */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188) */
  comfyPort?: number;
  /** Whether tailnet presence is probed (opt-in; all roles) */
  tailscaleMonitoring?: boolean;
  /** Hermes Agent update monitoring state (present in every snapshot). */
  hermes?: HermesStatus;
  hardware: HardwareInfo;
  metrics: SparkMetrics;
  /**
   * Compact per-Spark health summary computed server-side from DGX_SPARK
   * thresholds (absent for older servers). `level` is the fleet-level
   * classification; `badges` is one entry per monitored subsystem. Alerts are
   * the badges with level !== "ok", presented highest-severity first.
   */
  health?: {
    level: "ok" | "warn" | "danger";
    badges: HealthBadge[];
  };
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  /** Server generation time; optional while clients and servers roll independently. */
  generatedAt?: number;
  sparks: SparkSnapshot[];
  refreshInterval: number;
}

/**
 * Live fleet-alert push (type: "alerts"). Sent by the AlertMonitor whenever
 * any Spark's health level transitions. `changed` lists the sparks that moved;
 * `sparks` is the full current per-spark alert state.
 */
export interface WsAlertMessage {
  type: "alerts";
  changed: Array<{ sparkId: string; prevLevel: string; level: string; alerts: Array<{
    id: string; level: string; label: string; detail: string;
  }> }>;
  sparks: Array<{ sparkId: string; level: "ok" | "warn" | "danger" | "unknown"; alerts: Array<{
    id: string; level: string; label: string; detail: string;
  }> }>;
  nowMs: number;
}

export interface FleetEnergy {
  estimated: boolean;
  membershipChanged: boolean;
  restartRequired: boolean;
  trackedNodeIds: string[];
  currentNodeIds: string[];
  freshNodeCount: number;
  currentWatts30s: number | null;
  energy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  outputTokens24h: number;
  coverage24hMs: number;
  /** Window coverage24hMs is measured over (server-owned; fleet-size independent). */
  coverage24hWindowMs?: number;
  coverage31dMs: number;
  coverage31dWindowMs?: number;
  nodeCoverage24hMs: Record<string, number>;
  nodeCoverage31dMs: Record<string, number>;
  hourlyWatts24h: Array<number | null>;
}

// ─── API responses ────────────────────────────────────────
// ─── Model fleet (multi-model registry) ─────────────────
export interface ModelHealth {
  level: "green" | "yellow" | "red";
  healthy: number;
  required: number;
  total: number;
}

export interface ModelReplica {
  node: string;
  host: string;
  port: number;
  host_port: string;
  pin: string;
  healthy: boolean | null;
}

export interface ModelUsageUser {
  clientIp: string;
  label: string;
  apiKeyPrefix?: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastSeen: number;
}

export interface ModelUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastSeen: number;
  users: ModelUsageUser[];
}

export interface FleetModel {
  id: string;
  aliases: string[];
  capability: string[];
  engine: string;
  recipe: string;
  weights: string;
  quantization: string;
  hbm_gb: number;
  tensor_parallel: number;
  min_healthy: number;
  health: ModelHealth;
  replicas: ModelReplica[];
  usage: ModelUsage;
}

export interface ModelFleetResponse {
  ts: number;
  source: string | null;
  registryLoaded: boolean;
  registryError: string | null;
  routing: { aliases?: Record<string, string[]> };
  currentServedId: string | null;
  models: FleetModel[];
}

/** Variant value in an exported opencode model entry — either an effort
 * selector (`reasoningEffort`) or chat-template kwargs for exl3-style models. */
export interface OpencodeExportVariant {
  reasoningEffort?: string;
  chat_template_kwargs?: { enable_thinking: boolean; reasoning_effort?: string };
}

/** One model entry inside an exported opencode provider block (t_da2e5d5e). */
export interface OpencodeExportModelEntry {
  name: string;
  tool_call: boolean;
  temperature: boolean;
  reasoning: boolean;
  limit: { context: number; output: number };
  modalities: { input: string[]; output: string[] };
  cost: { input: number; output: number };
  variants: Record<string, OpencodeExportVariant>;
}

/** GET /api/models/export/opencode response — copy-paste-ready artifact. */
export interface OpencodeExportResponse {
  format: "opencode.json";
  warnings: string[];
  config: {
    $schema: string;
    model: string;
    provider: Record<
      string,
      {
        npm: string;
        name: string;
        options: { baseURL: string; apiKey: string };
        models: Record<string, OpencodeExportModelEntry>;
      }
    >;
  };
  text: string;
}

/** GET /api/models/export/pimono response — copy-paste-ready pi-mono config.
 * `text` is the exact clipboard payload; `config` is the parsed document
 * (pi-mono schema: { providers: { <id>: { baseUrl, api, compat, models:[...]
 * } } } — NO apiKey: pi resolves auth via env variables).
 * `targetPath` is where the user pastes it (~/.pi/agent/models.json) and
 * `defaultModel` is a `gilfoyle/<id>` suggestion for pi's settings.json —
 * never part of models.json itself. */
export interface PiMonoExportResponse {
  format: string;
  targetPath: string;
  defaultModel: string | null;
  warnings: string[];
  config: unknown;

  text: string;
}

export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  /** Hide worker-role Sparks from Overview cards and the tab bar. */
  hideWorkers: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — compact (default) or comfortable. */
  density: "comfortable" | "compact";
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: boolean;
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: boolean;
  /** Overview search field + status filter. Off by default. */
  showOverviewSearch: boolean;
  showLlmTokenTotals: boolean;
  /** Benchmark dialogs offer "Copy image" — a PNG share card of the results. */
  benchShareImage: boolean;
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  capabilities: Array<{
    id: "host" | "llm" | "comfy" | "hermes" | "tailnet";
    label: string;
    status: "pass" | "fail" | "skipped";
    required: boolean;
    message: string;
    recovery: string | null;
  }>;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string; skipped?: boolean };
  comfy?: { ok: boolean; message: string; skipped?: boolean };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
/** Output-shape label for decode bench prompts (not guided decoding). */
export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

/** On-demand remote LLM endpoint for decode/prefill benches. */
export interface LlmBenchTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
  /** Output-shape label only — not guided decoding / JSON schema. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote host (Tailscale HTTPS, etc.). */
  host?: string;
  tls?: boolean;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  /** First answer token (post-reasoning) in ms from request start; null when the reply never leaves the reasoning phase. */
  ttftContentMs: number | null;
  /** Number of streamed chunks that carried reasoning (not answer) text. */
  reasoningChunks: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  prefillTps: number;
  prefillTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window */
  aggregateDecodeTps: number;
  meanPrefillTps: number;
  medianPrefillTps: number;
  /** Sum prompt tokens / concurrent TTFT window (min start → max first token) */
  aggregatePrefillTps: number;
  totalPrefillTokens: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  error: string | null;
  durationMs: number;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  promptTypes: DecodeBenchPromptType[];
  defaultPromptType: DecodeBenchPromptType;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
  /** Output type: structured (default), prose, code, json. Prompt only. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote LLM host (hostname or URL). Skips this Spark's LAN/SSH path. */
  host?: string;
  tls?: boolean;
}

// ─── LLM prefill benchmark ───────────────────────────────
export interface PrefillBenchConfig {
  port: number;
  modelId: string | null;
  contextSizes: number[];
  host?: string;
  tls?: boolean;
}

export interface PrefillBenchSizeResult {
  targetTokens: number;
  promptTokens: number;
  promptChars: number;
  prefillTps: number;
  ttftMs: number;
  ttftContentMs: number | null;
  completionTokens: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

export interface PrefillBenchProgress {
  currentContext: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface PrefillBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: PrefillBenchConfig;
  progress: PrefillBenchProgress;
  results: PrefillBenchSizeResult[];
  error: string | null;
  durationMs: number;
}

export interface PrefillBenchDefaults {
  allowedContextSizes: number[];
  defaultContextSizes: number[];
  minContextSize?: number;
  maxContextSize?: number;
}

export interface PrefillBenchListResponse {
  active: PrefillBenchJob | null;
  last: PrefillBenchJob | null;
  history: PrefillBenchJob[];
  defaults: PrefillBenchDefaults;
}

export interface StartPrefillBenchRequest {
  port?: number;
  contextSizes: number[];
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export type ShowcasePromptType = "structural" | "text" | "mixed";

export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** Sampling temperature (0–2). Defaults to 0.7 on the server. */
  temperature?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  /** Catalog mode used to seed prompts (structural / text / mixed). */
  promptType?: ShowcasePromptType | null;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  peakTokPerSec?: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number;
  completedAt?: number | null;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  totalTokens?: number;
  meanDecodeTps?: number;
  peakStreamTps?: number;
  streamCount?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
  /** True when loaded from disk history (not a live poll session). */
  fromHistory?: boolean;
}

/** List-row for finished showcase runs (no stream bodies). */
export interface ShowcaseHistorySummary {
  sessionId: string;
  sparkId: string;
  status: "completed" | "cancelled" | "error" | string;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number | null;
  completedAt?: number | null;
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  totalTokens: number;
  meanDecodeTps: number;
  peakStreamTps: number;
  streamCount: number;
  error?: string | null;
}

export interface ShowcaseListResponse {
  active: { sessionId: string; status: string } | null;
  history: ShowcaseHistorySummary[];
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}

/** One aggregated energy bucket (Wh), e.g. a day, an ISO week, or a month. */
export interface EnergyBucket {
  /** Period start date as "YYYY-MM-DD" (day itself / week's Monday / month's 1st). */
  date: string;
  /** Short display label, e.g. "08/02" (day/week) or "Aug" (month). */
  label: string;
  /** Total Wh across all Sparks for this period. */
  value: number;
  /** Per-Spark Wh for this period. */
  sparks: Record<string, number>;
}

/** GPU energy history pre-aggregated into the four granularities. */
export interface EnergyReport {
  day: EnergyBucket[];
  week: EnergyBucket[];
  month: EnergyBucket[];
  year: EnergyBucket[];
}