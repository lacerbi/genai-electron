# TypeScript Reference

Complete type definitions for genai-electron. The library is TypeScript-first with comprehensive type safety.

## Navigation

- [System Types](#system-types)
- [Model Types](#model-types)
- [Server Types](#server-types)
- [LLM Calibration Types](#llm-calibration-types)
- [Image Generation Types](#image-generation-types)
- [Async Generation Types](#async-generation-types)
- [Logging Types](#logging-types)
- [Resource Types](#resource-types)
- [Error Types](#error-types)
- [UI Types](#ui-types)
- [Low-Level Types](#low-level-types)
- [Utility Types](#utility-types)
- [Constants](#constants)
- [Import Examples](#import-examples)

---

## System Types

### SystemCapabilities

Complete system hardware information.

```typescript
interface SystemCapabilities {
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpu: GPUInfo;
  platform: NodeJS.Platform;
  recommendations: SystemRecommendations;
  detectedAt: string;
}
```

### CPUInfo

```typescript
interface CPUInfo {
  cores: number;
  model: string;
  architecture: string;    // 'x64', 'arm64', etc.
}
```

### MemoryInfo

```typescript
interface MemoryInfo {
  total: number;
  available: number;
  used: number;
}
```

### MemoryTelemetryRefreshStatus

Outcome of one `systemInfo.refreshMemoryTelemetry()` call. It describes *that* invocation, never a
cached value.

```typescript
type MemoryTelemetryRefreshStatus = 'refreshed' | 'not-required' | 'failed';
```

- `'refreshed'` — the platform command produced a valid finite non-negative reading, now behind
  `getMemoryInfo()` (Windows standby-aware path).
- `'not-required'` — the platform needs no command (non-Windows); the direct `os.freemem()` reading
  is trusted as-is.
- `'failed'` — the command failed, timed out, or returned unusable output. Nothing is thrown and
  nothing is invalidated: the last successful standby-aware reading stays in effect for the rest of
  its 60 s TTL, and only after it expires does `getMemoryInfo()` fall back to `os.freemem()`.

LLM calibration trusts host RAM only for `'refreshed'` and `'not-required'`.

### TelemetryCommandOptions

Bounding options accepted by `systemInfo.refreshMemoryTelemetry()` and `systemInfo.getGPUInfo()`.

```typescript
interface TelemetryCommandOptions {
  signal?: AbortSignal;   // aborting rejects with the signal's reason
  timeoutMs?: number;     // per-command wall-clock bound (default: 10_000)
}
```

Both bounds kill the underlying child process, so a hung platform command cannot stall a long run or
leak a process. An aborted signal rejects rather than returning `'failed'`, keeping caller
cancellation distinguishable from telemetry degradation.

### GPUInfo

```typescript
interface GPUInfo {
  available: boolean;
  type?: 'nvidia' | 'amd' | 'apple' | 'intel';
  name?: string;
  vram?: number;                       // Total VRAM in bytes
  vramAvailable?: number;              // Available VRAM in bytes
  cuda?: boolean;
  metal?: boolean;
  rocm?: boolean;
  vulkan?: boolean;
}
```

### SystemRecommendations

```typescript
interface SystemRecommendations {
  maxModelSize: string;
  recommendedQuantization: readonly string[];
  threads: number;
  gpuLayers?: number;
  gpuAcceleration: boolean;
}
```

---

## Model Types

### ModelInfo

```typescript
interface ModelInfo {
  id: string;
  name: string;
  type: ModelType;
  size: number;
  path: string;
  downloadedAt: string;
  source: ModelSource;
  provenance?: ArtifactProvenance;  // Caller-supplied license declaration for the primary artifact
  checksum?: string;
  supportsReasoning?: boolean;
  ggufMetadata?: GGUFMetadata;
  components?: DiffusionModelComponents;  // Component files for multi-component diffusion models. When present, `path` points to the primary diffusion_model component and `size` is the aggregate total.
  shards?: ShardInfo[];                   // Ordered shards of a multi-shard GGUF. When present, `path` is the first shard (llama-server auto-discovers siblings) and `size` is the aggregate total.
}
```

### ShardInfo

A single shard of a multi-shard GGUF model (files split as `model-00001-of-0000N.gguf`). Distinct from multi-component diffusion models: shards are ordered pieces of **one** model, not role-keyed components.

```typescript
interface ShardInfo {
  path: string;       // Absolute path to this shard file
  size: number;       // Shard file size in bytes
  checksum?: string;  // SHA256 checksum (sha256: prefix), if known
}
```

### ModelType

```typescript
type ModelType = 'llm' | 'diffusion';
```

### ModelSource

```typescript
interface ModelSource {
  type: 'huggingface' | 'url';
  url: string;
  repo?: string;
  file?: string;
  revision?: string; // Effective Hugging Face revision on newly written HF metadata; omitted for direct URLs and may be absent from legacy metadata
}
```

### ArtifactProvenance

Optional caller-supplied license-declaration context. `genai-electron` stores and returns these
JSON-serializable field values without validating, normalizing, interpreting, comparing, fetching,
or acting on them. The caller owns the declaration and any resulting compliance policy.

```typescript
interface ArtifactProvenance {
  license: string;        // SPDX identifier when applicable, or any caller-defined label
  licenseUrl?: string;    // Caller-provided supporting location
  lastCheckedOn?: string; // Unvalidated caller review-date text; YYYY-MM-DD recommended
  note?: string;          // Caller-provided evidence or context
}
```

The optional field is accepted by `DownloadConfig` and `DiffusionComponentDownload`, then persisted
on `ModelInfo` and `DiffusionComponentInfo`. Top-level provenance always describes the primary
artifact. Additional components receive only their own declarations; a sharded model stores the
declaration once on `ModelInfo`. Reused shared files record each model configuration's supplied
declaration rather than forensic acquisition history.

`ArtifactProvenance` is exported from the package root. Its name does not broaden its current
contract beyond license-declaration context; `ModelSource`, Hugging Face `revision`, and checksums
remain separate records.

### GGUFMetadata

Complete metadata extracted from GGUF model files.

```typescript
interface GGUFMetadata {
  version?: number;
  tensor_count?: number;
  kv_count?: number;
  architecture?: string;
  general_name?: string;
  file_type?: number;
  block_count?: number;
  context_length?: number;
  attention_head_count?: number;
  attention_head_count_kv?: number; // KV heads (GQA); fewer than head_count on modern models
  attention_key_length?: number; // per-head key dim, when != embedding_length / head_count
  expert_count?: number; // MoE experts (0/undefined = dense)
  expert_used_count?: number; // experts active per token
  expert_feed_forward_length?: number; // per-expert FF dimension
  expert_weights_bytes?: number; // measured _exps tensor bytes (what --cpu-moe moves to RAM)
  embedding_length?: number;
  feed_forward_length?: number;
  vocab_size?: number;
  rope_dimension_count?: number;
  rope_freq_base?: number;
  attention_layer_norm_rms_epsilon?: number;
  raw?: Record<string, unknown>;
}
```

### MetadataFetchStrategy

```typescript
type MetadataFetchStrategy =
  | 'local-remote'
  | 'local-only'
  | 'remote-only'
  | 'remote-local';
```

### DownloadProgress

```typescript
interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  speed: number;
  estimatedTimeRemaining?: number;
}
```

### DownloadProgressCallback

```typescript
type DownloadProgressCallback = (downloaded: number, total: number) => void;
```

### DownloadConfig

```typescript
interface DownloadConfig {
  source: 'huggingface' | 'url';
  url?: string;
  repo?: string;
  file?: string;
  revision?: string;  // Hugging Face branch, tag, or full commit SHA; defaults to 'main'
  name: string;
  type: ModelType;
  checksum?: string;
  provenance?: ArtifactProvenance;  // Caller-supplied license declaration for the primary artifact
  onProgress?: DownloadProgressCallback;
  shardFiles?: string[];  // Explicit sibling shards for non-standard multi-shard naming (filenames resolved next to the primary file, or full URLs). Standard `*-00001-of-0000N.gguf` names are auto-discovered.
  components?: DiffusionComponentDownload[];  // Additional component files for multi-component diffusion models
  modelDirectory?: string;  // Subdirectory name override — allows multiple variants to share a directory
  onComponentStart?: (info: {  // Called when each component download begins (multi-component only)
    role: string;
    filename: string;
    index: number;   // 1-based
    total: number;
  }) => void;
}
```

### DiffusionComponentRole

Component roles in a multi-file diffusion model. Each role maps to a specific sd.cpp CLI flag.

```typescript
type DiffusionComponentRole =
  | 'diffusion_model'  // --diffusion-model (main UNet/DiT)
  | 'clip_l'           // --clip_l (CLIP-L text encoder)
  | 'clip_g'           // --clip_g (CLIP-G text encoder, SDXL)
  | 't5xxl'            // --t5xxl (T5-XXL text encoder, SD3/Flux 1)
  | 'llm'              // --llm (LLM text encoder, Flux 2)
  | 'llm_vision'       // --llm_vision (LLM vision, Qwen Image)
  | 'vae';             // --vae (VAE decoder)
```

### DiffusionComponentInfo

Info about a single component file within a multi-component model.

```typescript
interface DiffusionComponentInfo {
  path: string;       // Absolute path to component file
  size: number;       // File size in bytes
  checksum?: string;  // SHA256 checksum (sha256: prefix)
  source?: ModelSource; // Configured locator; optional for legacy metadata
  provenance?: ArtifactProvenance; // Caller-supplied license declaration; optional for legacy metadata
}
```

### DiffusionModelComponents

Map of component roles to their file info. Present on `ModelInfo` only for multi-component diffusion models.

```typescript
type DiffusionModelComponents = Partial<Record<DiffusionComponentRole, DiffusionComponentInfo>>;
```

### DiffusionComponentDownload

Download specification for a single component within a multi-file model.

```typescript
interface DiffusionComponentDownload {
  role: DiffusionComponentRole;
  source: 'huggingface' | 'url';
  url?: string;       // Required if source is 'url'
  repo?: string;      // Required if source is 'huggingface'
  file?: string;      // Required if source is 'huggingface'
  revision?: string;  // Hugging Face branch, tag, or full commit SHA; defaults to 'main'
  checksum?: string;  // Expected SHA256 checksum
  provenance?: ArtifactProvenance; // Independent caller-supplied license declaration
}
```

### Hugging Face URL Utilities

```typescript
function getHuggingFaceURL(repo: string, file: string, revision?: string): string;

function parseHuggingFaceURL(
  url: string
): { repo: string; revision: string; file: string } | null;
```

`getHuggingFaceURL()` accepts a raw revision (default `main`), encodes it as one route segment, and
preserves nested `file` path separators while encoding each segment. A full commit SHA is an
immutable pin; branches and tags can move. `parseHuggingFaceURL()` returns decoded values and accepts
both canonical nested paths and legacy `%2F`-encoded file paths. If a route is ambiguous between a
single-segment repository whose revision is `resolve` and a namespaced repository named `resolve`,
the namespaced repository shape takes precedence.

---

## Server Types

### ServerStatus

```typescript
type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
```

### HealthStatus

```typescript
type HealthStatus = 'ok' | 'loading' | 'error' | 'unknown';
```

### ServerInfo

```typescript
interface ServerInfo {
  status: ServerStatus;
  health: HealthStatus;
  pid?: number;
  port: number;                // Resolved numeric port (even when started with 'auto')
  modelId: string;
  startedAt?: string;
  error?: string;
  loadTimeMs?: number;         // Last successful start duration, spawn → healthy (llama-server only)
  configuredContextSize?: number; // Configured total llama-server -c allocation
  effectiveContextSize?: number;  // Verified /props context per request slot
  serverGeneration?: number;      // Last committed llama process generation (0 before first)
  effectiveParallelRequests?: number; // Running /props slots or resolved configured count
}
```

The llama-specific generation is scoped to one Electron main-process lifetime and remains as the
last-successful watermark after stop/crash. Effective capacity is present only while running.

### LlamaServerReadyState

Payload of the canonical llama-server `'ready'` event:

```typescript
interface LlamaServerReadyState {
  serverGeneration: number;
  modelId: string;
  port: number;
  configuredContextSize?: number;
  effectiveContextSize: number;
  effectiveParallelRequests: number;
  startedAt: string;
}
```

`effectiveParallelRequests` uses `/props.total_slots` when available and otherwise the resolved
configured count (default `1`). Failed, cancelled, superseded, and stale startup attempts never
receive a generation or emit this payload.

### KVCacheType

KV-cache quantization type for llama-server `--cache-type-k` / `--cache-type-v` (server default: `f16`).

```typescript
type KVCacheType = 'f16' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'iq4_nl';
```

### FlashAttentionSetting

Flash attention tri-state, plus `boolean` for backwards compatibility (`true` → `'on'`, `false` → `'off'`). When unset, nothing is emitted and the server decides (`'auto'`).

```typescript
type FlashAttentionSetting = boolean | 'on' | 'off' | 'auto';
```

### Node-safe llama-server launch types

Import these from `genai-electron/llama-server-launch`, not the Electron-backed package root:

```typescript
interface LlamaModelFile { path: string }
type LlamaSlotsEndpointMode = 'default' | 'enabled' | 'disabled';

type LlamaServerRuntimeConfig = Pick<LlamaServerConfig,
  'host' | 'threads' | 'contextSize' | 'gpuLayers' | 'parallelRequests' |
  'flashAttention' | 'fit' | 'cacheTypeK' | 'cacheTypeV' | 'swaFull' |
  'overrideTensors' | 'cacheRam' | 'cpuMoe' | 'nCpuMoe' | 'reasoningFormat' |
  'modelAlias' | 'batchSize' | 'continuousBatching' | 'useMmap' | 'useMlock' | 'jinja'
>;
type LlamaServerRunnerConfig = Omit<
  LlamaServerRuntimeConfig,
  'contextSize' | 'parallelRequests' | 'fit'
>;
type ResolvedLlamaServerRunnerConfig = LlamaServerRunnerConfig & {
  port: number;
  contextSize: number;
  parallelRequests: number;
  fit: 'off';
};

interface StartLlamaServerRunnerOptions {
  binaryPath: string;
  model: LlamaModelFile;
  config: LlamaServerRunnerConfig;
  contextSize: number;
  parallelRequests: number;
  startupTimeoutMs: number;
  port?: number;
  cwd?: string;
  signal?: AbortSignal; // startup only
  stderrMaxBytes?: number;
  slotsEndpoint?: LlamaSlotsEndpointMode;
  slotSavePath?: string; // caller-owned
  temporarySlotSavePath?: boolean; // factory-owned; requires enabled slots
}

interface LlamaRuntimeCapacity {
  effectiveContextSize: number;
  totalSlots?: number;
  modelPath?: string;
}
type VerifiedLlamaRuntimeCapacity = LlamaRuntimeCapacity & { totalSlots: number };

interface LlamaServerHandle {
  readonly port: number;
  readonly args: readonly string[];
  readonly config: ResolvedLlamaServerRunnerConfig;
  readonly capacity: VerifiedLlamaRuntimeCapacity;
  readonly loadTimeMs: number;
  readonly pid: number;
  readonly stderrTail: string;
  readonly stdoutTail: string;
  readonly exitPromise: Promise<LlamaServerExit>;
  raceWithExit<T>(operation: Promise<T>): Promise<T>;
  stop(): Promise<void>;
}
```

The factory returns only after health and strict `/props` verification, so the handle's PID,
load time, and verified capacity are required rather than optional.

### ServerConfig

```typescript
interface ServerConfig {
  modelId: string;
  port?: number | 'auto';           // Default: 8080 (llama) / 8081 (diffusion); 'auto' picks a free OS port
  threads?: number;
  contextSize?: number;             // Exact total llama-server -c allocation
  minimumContextSize?: number;      // Minimum effective context per request slot
  preferredContextSize?: number;    // Soft sizing target per request slot
  maximumContextSize?: number;      // Maximum effective context per request slot
  gpuLayers?: number;
  parallelRequests?: number;
  flashAttention?: FlashAttentionSetting;
  host?: string;                    // Interface to bind (--host); default 127.0.0.1 (loopback only)
  forceValidation?: boolean;
  startupTimeout?: number;          // Max ms to wait for health after spawn (default: 120000)
}
```

The context, parallel-request, flash-attention, and host fields are consumed by
`LlamaServerManager`; `DiffusionServerManager` keeps its narrower runtime allowlist and rejects
LLM-only fields.

### DiffusionServerInfo

Standalone interface mirroring `ServerInfo` fields (adds `busy` and `backend`; has no `loadTimeMs`).

```typescript
interface DiffusionServerInfo {
  status: ServerStatus;
  health: HealthStatus;
  pid?: number;                      // Internal sd-server backend PID while resident (the
                                     //   public server is an in-process HTTP wrapper with no
                                     //   PID of its own); absent when backend is 'absent'
  port: number;
  modelId: string;
  startedAt?: string;
  error?: string;
  busy?: boolean;
  backend?: DiffusionBackendInfo;    // Internal stable-diffusion.cpp backend snapshot (additive)
}
```

### DiffusionServerConfig

```typescript
interface DiffusionServerConfig {
  modelId: string;
  port?: number | 'auto';            // Default: 8081; 'auto' picks a free OS port
  host?: string;                     // Interface the HTTP wrapper binds to. Default: '127.0.0.1'
                                     //   (loopback only — the wrapper is unauthenticated, and
                                     //   there is no API-key option)
  allowedOrigins?: string[];         // Browser origins allowed to read from AND write to the
                                     //   wrapper. Unset/empty (default) = NO Access-Control-*
                                     //   headers; ['*'] = wildcard; otherwise the request Origin
                                     //   is echoed on exact match. An uncovered Origin on a
                                     //   state-changing method (POST/DELETE) gets 403
                                     //   INVALID_ORIGIN
  startupTimeout?: number;           // Max ms for the BACKEND to go spawn → ready (not start()
                                     //   itself). Default: DEFAULT_TIMEOUTS.serverStart (120000)
  usageMode?: DiffusionUsageMode | 'auto'; // Default residency policy. Default: 'auto' → 'single'
                                     //   when the LLM was offloaded for the image, else 'burst'
  idleTimeoutMs?: number;            // Idle time before a 'burst'-resident backend is released.
                                     //   Default: DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs
                                     //   (300000); 0 disables the timer
  jobActivityTimeoutMs?: number;     // No-activity timeout for an in-flight backend job.
                                     //   Default: DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs
                                     //   (600000); 0 — or any non-positive / non-finite value —
                                     //   disables the watchdog
  threads?: number;                  // CPU threads; passed to the backend as -t at launch
  gpuLayers?: number;                // Accepted for config-shape compatibility, NOT passed to
                                     //   sd.cpp (GPU offload is automatic)
  forceValidation?: boolean;
  clipOnCpu?: boolean;               // Offload CLIP text encoder to CPU (--clip-on-cpu). undefined=auto-detect, true=force on, false=force off.
  vaeOnCpu?: boolean;                // Offload VAE decoder to CPU (--vae-on-cpu). undefined=auto-detect, true=force on, false=force off.
  batchSize?: number;                // Maps to `batch_count` in the backend job request (the
                                     //   first image of the batch is returned); omitted → 1.
                                     //   Not auto-detected.
  offloadToCpu?: boolean;            // Offload model weights to CPU RAM (--offload-to-cpu). undefined=auto-detect, true=force on, false=force off.
  diffusionFlashAttention?: boolean; // Enable flash attention (--diffusion-fa). undefined=auto-detect (enabled for Flux 2), true=force on, false=force off.
}
```

The four offload flags are **launch** arguments of the backend process: a generation that resolves
to a different set forces a respawn (release reason `'flags-changed'`).

`allowedOrigins`, the cross-origin write rejection (`403 INVALID_ORIGIN`) and the loopback `Host`
guard are described in
[Network exposure and security](image-generation.md#network-exposure-and-security); the wrapper is
loopback-only and unauthenticated by design, and `host` is the only knob for anything wider.

A generation killed by the `jobActivityTimeoutMs` watchdog rejects with a `ServerError` whose
`details` carry (see [Stuck jobs](image-generation.md#stuck-jobs-the-activity-watchdog)):

```typescript
{
  code: 'BACKEND_JOB_STUCK';
  jobId: string;                     // backend job id, or '(not yet submitted)'
  idleMs: number;                    // observed silence when the watchdog fired
  timeoutMs: number;                 // the budget that was exceeded
  stage: 'loading' | 'diffusion' | 'decoding';
  args: string;                      // the backend's launch argv, space-joined
  backendStderrTail?: string;        // last stderr lines of the killed backend, when any
  suggestion: string;
}
```

The tail is deliberately **not** under `details.stderr`/`details.stderrTail`: those keys drive the
calibration OOM classifier, and a wedged backend is an error, never an out-of-memory result. The
wire code stays `BACKEND_ERROR`.

### Diffusion backend types

The public diffusion server is an in-process HTTP wrapper; these describe the internal
stable-diffusion.cpp `sd-server` child it drives. See
[Backend Residency](image-generation.md#backend-residency).

```typescript
type DiffusionUsageMode = 'burst' | 'single';

type DiffusionBackendState = 'absent' | 'starting' | 'ready' | 'busy' | 'stopping';

type DiffusionBackendReleaseReason =
  | 'single'         // residency policy released it right after the image
  | 'idle-timeout'   // a 'burst' backend sat idle past idleTimeoutMs
  | 'explicit'       // releaseBackend() default
  | 'flags-changed'  // the next generation needs different launch flags
  | 'cancel'         // a generating job was cancelled (sampling cannot be interrupted)
  | 'crashed'        // the process exited unexpectedly
  | 'stuck'          // the job produced no activity for jobActivityTimeoutMs (watchdog)
  | 'stop'           // diffusionServer.stop()
  | 'shutdown'       // attachAppLifecycle() quit path
  | 'llm-start'      // yielded to an LLM start via the pre-start hook
  | 'calibration';   // an offload-calibration sweep manages its own backend

interface DiffusionBackendInfo {
  state: DiffusionBackendState;
  pid?: number;                      // present once spawned
  startedAt?: string;                // ISO timestamp of the spawn
  loadTimeMs?: number;               // spawn → ready duration
  lastUsedAt?: string;               // ISO timestamp of the last finished job
  flags?: {                          // the launch flags this process is pinned to
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
  };
}

// Payload of the 'backend-status' event
interface DiffusionBackendStatusEvent {
  state: DiffusionBackendState;
  previous: DiffusionBackendState;
  reason?: DiffusionBackendReleaseReason
    | 'spawned' | 'ready' | 'job'    // forward transitions
    | 'start-failed';                // a spawn that never became ready (not a crash)
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}
```

`releaseBackend()` takes `{ reason?: DiffusionBackendReleaseReason; waitForInFlight?: boolean }`
and resolves after the stop completes. Normally that means confirmed process death; a termination
that cannot be confirmed is logged, the state still becomes `'absent'`, and the orphan PID blocks
new spawns until it is gone (`BACKEND_TERMINATION_UNCONFIRMED`, wire code `BACKEND_ERROR`).
`getBackendInfo(): DiffusionBackendInfo` is the synchronous snapshot.

`getOrchestrator(): ResourceOrchestrator | undefined` returns the manager's **live built-in**
orchestrator (`undefined` only when the manager was constructed without a `LlamaServerManager`) —
see [Built-in vs custom orchestrator](resource-orchestration.md#built-in-vs-custom-orchestrator).

### LlamaServerConfig

Extends `ServerConfig` with llama.cpp-specific options.

```typescript
interface LlamaServerConfig extends ServerConfig {
  modelAlias?: string;               // --alias. WARNING: masks the GGUF filename genai-lite uses for family/reasoning detection
  continuousBatching?: boolean;      // false → --no-cont-batching (server default: enabled)
  batchSize?: number;                // -b (logical batch size)
  useMmap?: boolean;                 // false → --no-mmap (server default: enabled)
  useMlock?: boolean;                // true → --mlock
  jinja?: boolean;                   // Use embedded Jinja chat template (--jinja). Default: true; false → --no-jinja
  cacheTypeK?: KVCacheType;          // --cache-type-k (default: unset → f16)
  cacheTypeV?: KVCacheType;          // --cache-type-v; quantized V auto-upgrades flash attention to 'on' (throws if explicitly 'off')
  swaFull?: boolean;                 // --swa-full; full-context SWA cache (default: unset/false)
  overrideTensors?: string;          // -ot / --override-tensor, e.g. 'exps=CPU'
  cacheRam?: number;                 // --cache-ram (MiB); -1 = no limit, 0 = disable
  cpuMoe?: boolean;                  // --cpu-moe (keep ALL MoE experts on CPU)
  nCpuMoe?: number;                  // --n-cpu-moe N (keep first N layers' MoE experts on CPU)
  reasoningFormat?: 'auto' | 'deepseek' | 'deepseek-legacy' | 'none'; // --reasoning-format (default: unset → server 'auto')
  fit?: 'on' | 'off';                // -fit; default 'off'. 'on' delegates sizing to llama-server and skips genai-electron's gpuLayers/contextSize auto-config
  occupancyCheck?: 'warn' | 'strict' | 'off'; // Cross-app VRAM double-load guard (default: 'warn')
  autoRestart?: boolean;             // Auto-restart after an unexpected crash (default: false)
  maxRestarts?: number;              // Max consecutive auto-restart attempts (default: 3)
  healthCheckInterval?: number;      // Hang-watchdog poll interval in ms (default: disabled)
}
```

### ServerEvent

```typescript
type ServerEvent =
  | 'ready'
  | 'started'
  | 'stopped'
  | 'crashed'
  | 'restarted'
  | 'health-check-ok'
  | 'health-check-failed'
  | 'binary-log'
  | 'binary-progress'
  | 'backend-status'        // Diffusion only: DiffusionBackendStatusEvent
  | 'calibration-progress'; // Diffusion only: DiffusionCalibrationProgress
```

`'crashed'` is never emitted by `DiffusionServerManager`: its public server is the in-process HTTP
wrapper, which survives a backend failure. An unexpected backend exit surfaces as
`'backend-status'` with `reason: 'crashed'`.

**Payload shapes differ.** Most events deliver a [`ServerEventData`](#servereventdata) envelope.
The two diffusion-only events do **not**: `'backend-status'` delivers a bare
`DiffusionBackendStatusEvent` and `'calibration-progress'` a bare `DiffusionCalibrationProgress`.
Destructure them directly (`on('backend-status', ({ state, reason }) => …)`) rather than reaching
through `.serverInfo`.

### LlamaPreStartHook

Callback registered through `llamaServer.registerPreStartHook()`; runs inside `start()` right
after the status flips to `'starting'` and before any port/binary/model work. See
[registerPreStartHook()](llm-server.md#registerprestarthook).

```typescript
type LlamaPreStartHook = (ctx: {
  config: LlamaServerConfig;         // configuration passed to start() (port may still be 'auto')
  reason: 'start' | 'auto-restart';
}) => Promise<void> | void;

registerPreStartHook(hook: LlamaPreStartHook): () => void; // returns an unregister function
```

A hook that throws fails a manual `start()` (status resets to `'stopped'`, typed errors preserved);
on the auto-restart path the error is logged and ignored.

Hooks are held in a `Set` keyed by **function identity**: registering the same function reference
twice still runs it once, and any of the unregister handles returned for it removes it. Register a
distinct closure per registration if you really want it to run more than once.

### ServerEventData

```typescript
interface ServerEventData {
  event: ServerEvent;
  serverInfo: ServerInfo;
  error?: Error;
  timestamp: string;
}
```

### BinaryLogEvent

```typescript
interface BinaryLogEvent {
  message: string;
  level: 'info' | 'warn' | 'error';
}
```

### HealthCheckResponse

```typescript
interface HealthCheckResponse {
  status: HealthStatus;
  [key: string]: unknown;
}
```

### BinaryProgressEvent

Structured provisioning progress (`'binary-progress'` event). Download events
are throttled to whole-percent changes. ZIP extraction adds throttled
uncompressed write-byte progress alongside its initial and per-file entry
counters. `finalizing` identifies completed ZIP worker resource release until
exit. After validation, `installing` identifies candidate assembly and
publication. Neither tail claims percentage progress.

```typescript
interface BinaryProgressEvent {
  phase: 'downloading' | 'extracting' | 'finalizing' | 'verifying' | 'testing' | 'installing';
  file: string; // 'binary' or a dependency description (e.g. 'CUDA runtime')
  downloaded?: number; // bytes (downloading)
  total?: number; // bytes (downloading)
  percent?: number; // whole number (download bytes or best extraction denominator)
  completedEntries?: number; // extracted file entries (ZIP extraction)
  totalEntries?: number; // total file entries (ZIP extraction)
  writtenBytes?: number; // cumulative uncompressed payload bytes written (ZIP extraction)
  totalUncompressedBytes?: number; // expected uncompressed payload bytes (ZIP extraction)
}
```

`downloaded`/`total` are byte counts and only apply to downloads.
`completedEntries`/`totalEntries` count ZIP file entries. Extraction callbacks
start at `0 / totalEntries` and finish at `totalEntries / totalEntries`.
`writtenBytes` counts successful payload writes and `totalUncompressedBytes`
comes from valid entry headers as progress metadata only. Extraction `percent`
uses that byte ratio when available, falls back to entries, and is omitted when
neither denominator is positive. Because `adm-zip` inflates each complete entry
before writing it, byte progress does not measure streaming decompression. A
phase-only `finalizing` event follows the last ZIP write immediately and remains
the truthful UI state while the worker exits.

### Port & Health Utilities

Low-level helpers used by the server managers (also exported for advanced use).

```typescript
// Resolve a free OS-assigned TCP port on the given host (used when port is 'auto').
function findFreePort(host?: string): Promise<number>;   // host defaults to '127.0.0.1'

// Test whether a specific port can be bound on the given host (catches non-HTTP occupants).
function isPortBindable(port: number, host?: string): Promise<boolean>;  // host defaults to '127.0.0.1'

// Map a bind host to the host health checks should target
// ('0.0.0.0' → '127.0.0.1'; '::' → '::1'; unset → '127.0.0.1').
function normalizeHealthHost(host?: string): string;
```

---

## LLM Calibration Types

### LlamaCalibrationConfig

```typescript
interface LlamaCalibrationProfile {
  contextSize: number;       // exact total llama-server -c allocation
  parallelRequests: number;  // exact llama-server -np slot count
}

type LlamaCalibrationOverrides = Partial<Pick<LlamaServerConfig,
  | 'gpuLayers' | 'swaFull' | 'cacheTypeK' | 'cacheTypeV' | 'flashAttention'
  | 'cpuMoe' | 'nCpuMoe' | 'overrideTensors' | 'threads' | 'batchSize' | 'cacheRam'
>>;

type LlamaCalibrationFixedConfig = LlamaCalibrationOverrides & Partial<Pick<
  LlamaServerConfig,
  'continuousBatching' | 'useMmap' | 'useMlock'
>>;

interface LlamaCalibrationCombo {
  label?: string;
  overrides: LlamaCalibrationOverrides;
}

interface LlamaColdPrefillWorkload {
  id: string;
  kind: 'cold-prefill';
  prompt: string;
  nPredict: number;
  weight?: number;
}

interface LlamaSharedPrefixWorkload {
  id: string;
  kind: 'shared-prefix';
  sharedPrefix: string;
  suffixes: readonly string[]; // at least 2; first primes the slot
  nPredict: number;
  weight?: number;
}

type LlamaCalibrationWorkload =
  | LlamaColdPrefillWorkload
  | LlamaSharedPrefixWorkload;

interface LlamaCalibrationConfigCommon {
  modelId: string;
  fixedConfig?: LlamaCalibrationFixedConfig;
  workloads: readonly LlamaCalibrationWorkload[];
  samples?: number; // full-fidelity samples; default 3
  seed?: number;    // default 42
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onProgress?: (progress: LlamaCalibrationProgress) => void;
  signal?: AbortSignal;
}

interface LlamaAdaptiveCalibrationConfig extends LlamaCalibrationConfigCommon {
  profiles:
    | readonly [LlamaCalibrationProfile]
    | readonly [LlamaCalibrationProfile, LlamaCalibrationProfile];
  profile?: never;
  combos?: never;
  includeKvCacheComparison?: boolean; // default false
  kvPrecisionPreferencePct?: number;  // default 10
  contextPreferencePct?: number;      // default 10
  maxProbes?: number;                 // optional expert/test cap; omitted = unbounded
  maxWallTimeMs?: number;             // default 60 minutes
}

interface LlamaExactCalibrationConfig extends LlamaCalibrationConfigCommon {
  profile: LlamaCalibrationProfile;
  profiles?: never;
  combos: readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]];
  kvPrecisionPreferencePct?: number; // default 10
  includeKvCacheComparison?: never;
  contextPreferencePct?: never;
  maxProbes?: never;
  maxWallTimeMs?: never;
}

type LlamaCalibrationConfig =
  | LlamaAdaptiveCalibrationConfig
  | LlamaExactCalibrationConfig;
```

`profiles` without `combos` selects adaptive mode. `profile` with a non-empty `combos` tuple selects
exact mode. The legacy `profile`-without-`combos` shape, `profiles` with `combos`, and simultaneous
`profile`/`profiles` fields are rejected before provisioning. Adaptive profiles are limited to one
or two unique context sizes with a common slot count.

### Progress

```typescript
type LlamaCalibrationProbePhase =
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

type LlamaAdaptiveCalibrationPhase =
  | 'preparing'
  | 'policy-ready'
  | 'finding-reference'
  | 'establishing-ceiling'
  | 'bisecting'
  | 'validating-finalist'
  | 'validating-winner'
  | 'validating-fallback'
  | 'stopping';

type LlamaExactCalibrationPhase =
  | 'preparing'
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

type LlamaCalibrationPhase =
  | LlamaAdaptiveCalibrationPhase
  | LlamaExactCalibrationPhase
  | 'done';

type LlamaAdaptiveCalibrationTerminalStatus =
  | 'complete'
  | 'time-limited'
  | 'probe-limited'
  | 'inconclusive'
  | 'no-viable-candidate';

type LlamaCalibrationTerminalStatus =
  | LlamaAdaptiveCalibrationTerminalStatus
  | 'aborted'
  | 'failed';

type LlamaExactCalibrationTerminalStatus =
  | 'complete' | 'no-viable-candidate' | 'aborted' | 'failed';

type LlamaAdaptiveCalibrationSelectionEvidence =
  | 'independent-reproduction'
  | 'single-full-launch'
  | 'single-search-launch';

type LlamaAdaptiveProgressBudget = {
  maxWallTimeMs: number;
  remainingMs: number;
} & (
  | { maxProbes?: never; remainingProbes?: never }
  | { maxProbes: number; remainingProbes: number }
);

interface LlamaAdaptiveActiveProbe {
  profileIndex: number;   // stable caller-order identity
  profileOrdinal: number; // smaller-context-first scheduling order
  cellId: string;
  purpose: LlamaAdaptiveCalibrationProbePurpose;
  gpuLayers: number;
  fidelity: 'search' | 'full';
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  argvKey: string;
  probePhase?: LlamaCalibrationProbePhase;
}

type LlamaExactProgressCandidates =
  | { resolved: false }
  | { resolved: true; comboCount: number };

interface LlamaExactActiveCandidate {
  comboIndex: number;
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  gpuLayers: number;
}

type LlamaCalibrationProgress =
  | {
      strategy: 'adaptive';
      phase: LlamaAdaptiveCalibrationPhase;
      terminalStatus?: never;
      overallPercent: number;
      elapsedMs: number;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
      activeProbe?: LlamaAdaptiveActiveProbe;
      workloadIndex?: number;
      workloadCount?: number;
      sampleIndex?: number;
      sampleCount?: number;
    }
  | {
      strategy: 'exact';
      phase: LlamaExactCalibrationPhase;
      terminalStatus?: never;
      overallPercent: number;
      elapsedMs: number;
      candidates: LlamaExactProgressCandidates;
      activeCandidate?: LlamaExactActiveCandidate;
      workloadIndex?: number;
      workloadCount?: number;
      sampleIndex?: number;
      sampleCount?: number;
    }
  | {
      strategy: 'adaptive';
      phase: 'done';
      terminalStatus: LlamaCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
    }
  | {
      strategy: 'exact';
      phase: 'done';
      terminalStatus: LlamaExactCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      candidates: LlamaExactProgressCandidates;
    };
```

Adaptive elapsed/remaining time starts at method entry, including `preparing`; `policy-ready` marks
that the fixed baseline exists but does not reset the clock. The callback and
`'calibration-progress'` event carry equivalent payloads. `overallPercent` is monotonic time
consumption. `completedProbes` counts settled trail records; bounded `remainingProbes` is consumed
when an executor invocation starts.

### Probe and report

```typescript
type LlamaCalibrationOperationalStatus =
  | 'ok' | 'oom' | 'startup-timeout' | 'request-timeout' | 'crashed' | 'error';

type LlamaCalibrationStatus = LlamaCalibrationOperationalStatus;

type LlamaCalibrationProbePurpose =
  | 'reference'
  | 'reference-guard'
  | 'ceiling'
  | 'boundary'
  | 'ambiguity-repeat'
  | 'finalist'
  | 'winner-validation'
  | 'fallback-validation'
  | 'exact';

type LlamaAdaptiveCalibrationProbePurpose = Exclude<
  LlamaCalibrationProbePurpose,
  'exact'
>;

type LlamaCalibrationProbeFidelity = 'search' | 'full';

type ResolvedLlamaCalibrationConfig = LlamaCalibrationProfile &
  LlamaCalibrationFixedConfig & LlamaCalibrationOverrides;

interface LlamaCalibrationRequestTiming {
  wallTimeMs: number;
  promptTokens?: number;
  promptMs?: number;
  promptTokensPerSecond?: number;
  predictedTokens?: number;
  predictedMs?: number;
  predictedTokensPerSecond?: number;
  cachedTokens?: number;
}

interface LlamaCalibrationSample {
  wallTimeMs: number;
  requests: readonly LlamaCalibrationRequestTiming[];
}

interface LlamaCalibrationWorkloadResult {
  workloadId: string;
  kind: LlamaCalibrationWorkload['kind'];
  workloadHash: string;
  weight: number;
  samples: readonly LlamaCalibrationSample[];
  medianWallTimeMs?: number;
  error?: string;
}

interface LlamaCalibrationWorkloadSignature {
  id: string;
  kind: LlamaCalibrationWorkload['kind'];
  weight: number;
  hash: string;
  requestCount: number;
  nPredict: number;
  promptTokenCounts?: readonly number[];
}

interface LlamaCalibrationMemoryEvidence {
  classification: 'none' | 'suspected' | 'confirmed' | 'unknown';
  reason: string;
  source:
    | 'specific-allocation-diagnostic'
    | 'broad-operational-diagnostic'
    | 'timeout'
    | 'process-exit'
    | 'performance'
    | 'not-observed';
}

interface LlamaCalibrationBoundaryDecision {
  classification: 'admissible' | 'unsuitable' | 'ambiguous' | 'not-applicable';
  reason: string;
}

interface LlamaCalibrationCleanupRecord {
  confirmed: boolean;
  durationMs: number;
  pid?: number;
  error?: string;
}

// --- Fixed-baseline resource stability (schema v4) ---

// The two independently guarded resources. No weighting, no combined score.
type LlamaCalibrationResourceMetric = 'hostMemory' | 'vram';

// Which side of the fixed baseline a suspicious reading fell on.
// Diagnostic only: both directions are fatal once confirmed.
type LlamaCalibrationResourceChangeDirection = 'decrease' | 'increase';

type LlamaCalibrationResourceBoundaryKind = 'pre-launch' | 'post-cleanup';

type LlamaCalibrationResourceUntrustedReason =
  | 'telemetry-refresh-failed'
  | 'reading-unavailable'
  | 'reading-invalid';

interface LlamaCalibrationResourceReading {
  metric: LlamaCalibrationResourceMetric;
  enabled: boolean;   // false → no usable baseline; the metric triggers nothing
  trusted: boolean;
  untrustedReason?: LlamaCalibrationResourceUntrustedReason;
  availableBytes?: number;
  // Signed: positive = less availability than baseline, negative = more.
  decreasePctFromBaseline?: number;
  decreaseThresholdPct?: number;
  increaseThresholdPct?: number;
  suspicious: boolean;
  suspiciousDirection?: LlamaCalibrationResourceChangeDirection;
}

interface LlamaCalibrationResourceSnapshotDiagnostic {
  readings: readonly LlamaCalibrationResourceReading[];
  suspiciousMetrics: readonly LlamaCalibrationResourceMetric[];
  // Enabled but untrusted. Recorded only; never drift on their own.
  untrustedMetrics: readonly LlamaCalibrationResourceMetric[];
}

// One launch boundary: an initial snapshot plus, only when it was
// suspicious, exactly one confirmation.
interface LlamaCalibrationResourceBoundaryDiagnostic {
  boundary: LlamaCalibrationResourceBoundaryKind;
  confirmationPerformed: boolean;
  initial: LlamaCalibrationResourceSnapshotDiagnostic;
  confirmation?: LlamaCalibrationResourceSnapshotDiagnostic;
  initiallySuspiciousMetrics: readonly LlamaCalibrationResourceMetric[];
  warnings: readonly string[];
}

// `postCleanup` exists only when teardown was confirmed; either side is
// absent when resource monitoring was unavailable for the run.
interface LlamaCalibrationProbeResourceBoundaries {
  preLaunch?: LlamaCalibrationResourceBoundaryDiagnostic;
  postCleanup?: LlamaCalibrationResourceBoundaryDiagnostic;
}

type LlamaCalibrationResourceMonitoringCoverage =
  | 'complete' | 'partial' | 'unavailable';

// Exactly one of these per metric per calibrate() call: no re-anchoring.
interface LlamaCalibrationResourceMetricMonitoring {
  metric: LlamaCalibrationResourceMetric;
  enabled: boolean;         // false → too few trusted baseline samples
  baselineBytes?: number;   // median of trustedSamples; only when enabled
  decreaseThresholdPct: number;
  increaseThresholdPct: number;
  attempts: number;                        // bounded; never extended
  trustedSamples: readonly number[];       // capture order
}

interface LlamaCalibrationResourceMonitoring {
  coverage: LlamaCalibrationResourceMonitoringCoverage;
  enabledMetrics: readonly LlamaCalibrationResourceMetric[];
  metrics: readonly LlamaCalibrationResourceMetricMonitoring[]; // incl. disabled
}

// Single source of truth for a resource-stability rejection.
// `probeIndex` is absent for a pre-launch failure, which has no probe.
interface LlamaCalibrationResourceFailure {
  boundary: LlamaCalibrationResourceBoundaryKind;
  affectedMetrics: readonly LlamaCalibrationResourceMetric[];
  affectedDirections: Readonly<
    Partial<Record<
      LlamaCalibrationResourceMetric,
      LlamaCalibrationResourceChangeDirection
    >>
  >;
  probeIndex?: number;
  diagnostics: LlamaCalibrationResourceBoundaryDiagnostic;
}

type NonEmptyProbeIndexes = readonly [number, ...number[]];

interface LlamaAdaptiveCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: LlamaAdaptiveCalibrationSelectionEvidence;
  sourceProbeIndexes: NonEmptyProbeIndexes;
}

interface LlamaExactCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: 'single-launch-measurement';
  sourceProbeIndexes: NonEmptyProbeIndexes;
}

type LlamaCalibrationProbeResourceValidity =
  | 'accepted'
  | 'invalidated-by-resource-stability';

// Machine-resource readings are NOT here: they live on the probe's
// `resourceBoundaries`, compared against the run's one fixed baseline in
// report-level `resourceMonitoring`.
interface LlamaCalibrationPassiveDiagnostics {
  kvBytesEstimate?: number;
  modelBytes?: number;
  expertWeightBytes?: number;
  warnings: readonly string[];
}

interface LlamaCalibrationProbe {
  probeIndex: number;
  strategy: 'adaptive' | 'exact';
  purpose: LlamaCalibrationProbePurpose;
  fidelity: LlamaCalibrationProbeFidelity;
  independentLaunchIndex: number;
  profileIndex: number;
  profileOrdinal: number;
  cellId?: string;
  comboIndex?: number;
  combo?: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  argvKey: string;
  operationalStatus: LlamaCalibrationOperationalStatus;
  memoryEvidence: LlamaCalibrationMemoryEvidence;
  boundaryDecision: LlamaCalibrationBoundaryDecision;
  // Whether this observation may be used for any decision. An
  // `invalidated-by-resource-stability` probe stays in the chronological
  // trail for auditing but never reaches classification, ranking, selection,
  // fallback, or resource-failure bestKnown. `accepted` only means the resource
  // guard did not invalidate it — including a record the guard never evaluated
  // at all, and it may still carry an operational failure.
  resourceValidity: LlamaCalibrationProbeResourceValidity;
  // Absent when the boundary was never evaluated: monitoring unavailable for
  // the run, the launch ended earlier (unconfirmed teardown, caller abort), or
  // the launch was interrupted by the internal probe deadline.
  resourceBoundaries?: LlamaCalibrationProbeResourceBoundaries;
  loadTimeMs?: number;
  effectiveContextSize?: number;
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  aggregateLowerBoundMs?: number;
  durationMs: number;
  capped?: boolean;
  terminationReason?: string;
  diagnostics?: LlamaCalibrationPassiveDiagnostics;
  error?: string;
  stderrTail?: string;
  cleanup: LlamaCalibrationCleanupRecord;
}

// Legacy-shaped exact launch record, retained as a public data type.
interface LlamaCalibrationRun {
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  status: LlamaCalibrationStatus;
  loadTimeMs?: number;
  effectiveContextSize?: number;       // verified per slot
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  error?: string;
  stderrTail?: string;
}

interface LlamaCalibrationRecommendation {
  combo?: LlamaCalibrationCombo;
  profileIndex?: number;
  cellId?: string;
  startConfig: ResolvedLlamaCalibrationConfig;
  scoreMs: number;
}

type LlamaCalibrationFallback =
  | (LlamaCalibrationRecommendation & { evidence: 'direct-measurement' })
  | {
      profileIndex: number;
      cellId: string;
      startConfig: ResolvedLlamaCalibrationConfig;
      evidence: 'unvalidated-option';
      scoreMs?: never;
    };

interface LlamaCalibrationVerifiedProfile {
  effectiveContextSize: number;
  effectiveParallelRequests: number;
}

interface LlamaAdaptiveCalibrationProfileReport {
  profileIndex: number;
  profileOrdinal: number;
  profile: LlamaCalibrationProfile;
  state: 'unstarted' | 'tested' | 'resolved' | 'unresolved' | 'no-viable-point';
  verified?: LlamaCalibrationVerifiedProfile;
  bestCellId?: string;
  warnings: readonly string[];
}

interface LlamaAdaptiveCalibrationCellReport {
  cellId: string;
  profileIndex: number;
  profileOrdinal: number;
  structuralOrder: number;
  resolvedConfig: Omit<ResolvedLlamaCalibrationConfig, 'gpuLayers'>;
  state:
    | 'pending'
    | 'finding-reference'
    | 'establishing-ceiling'
    | 'bisecting'
    | 'finalist'
    | 'resolved'
    | 'unresolved'
    | 'no-viable-point';
  referenceGpuLayers?: number;
  lowGpuLayers?: number;
  highGpuLayers?: number;
  provisionalBoundaryGpuLayers?: number;
  finalistGpuLayers?: number;
  inheritedCeiling?: { gpuLayers: number; sourceCellId: string; reason: string };
  nonMonotoneWarning?: boolean;
  unmeasuredGaps?: readonly number[];
  warnings: readonly string[];
}

interface LlamaAdaptiveCalibrationBudgetReport {
  maxWallTimeMs: number;
  elapsedMs: number; // method entry through library-owned settlement/restoration
  overrunMs: number; // max(0, elapsedMs - maxWallTimeMs)
  maxProbes?: number;
}

// Protocol facts only. Baselines and band values live in
// `resourceMonitoring`, which is their single source of truth.
interface LlamaCalibrationResourceStabilityMethodology {
  baselineSettleMs: number;          // fixed delay; never condition-driven
  baselineSamples: number;           // bounded attempts; never extended
  minTrustedBaselineSamples: number; // below this, the metric is disabled
  confirmationReads: number;         // whole-boundary confirmations
  telemetryTimeoutMs: number;        // per platform telemetry command
  guardedDirections: readonly LlamaCalibrationResourceChangeDirection[];
  guardedBoundaries: readonly LlamaCalibrationResourceBoundaryKind[];
  thresholdComparison: 'inclusive';
  caveat: string;                    // states the sampling blind spot
}

interface LlamaCalibrationMethodology {
  layerCount: number;
  layerCountSource: 'metadata' | 'fallback';
  samples: number;
  searchSamples: number;
  warmups: 1;
  seed: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  resourceCooldownMs: number;
  tieTolerancePct: number;
  grossRegressionMultiplier: number;
  stabilityTolerancePct: number;
  searchNoiseAllowancePct: number;
  nonMonotoneTriggerPct: number;
  includeKvCacheComparison: boolean;
  kvPrecisionPreferencePct: number;
  contextPreferencePct?: number;
  scoreUnit: 'scenario-median-wall-ms';
  resourceStability: LlamaCalibrationResourceStabilityMethodology;
}

interface LlamaCalibrationReportBase {
  resultKind: 'report';
  schemaVersion: 4;
  policyVersion: string;
  createdAt: string;
  status: LlamaCalibrationTerminalStatus;
  model: LlamaCalibrationModelIdentity;
  binary: LlamaCalibrationBinaryIdentity;
  machine: LlamaCalibrationMachineIdentity;
  cacheability: { level: 'stable' | 'best-effort'; reasons: readonly string[] };
  fixedConfig: LlamaCalibrationFixedConfig;
  workloads: readonly LlamaCalibrationWorkloadSignature[];
  methodology: LlamaCalibrationMethodology;
  // The run's one fixed baseline per metric, plus how much of the guard was
  // active. Reported machine available-memory values are the stabilized
  // baselines when they exist.
  resourceMonitoring: LlamaCalibrationResourceMonitoring;
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
}

interface LlamaAdaptiveCalibrationReportFields extends LlamaCalibrationReportBase {
  strategy: 'adaptive';
  status: LlamaAdaptiveCalibrationTerminalStatus;
  searchCompleteness: 'resolved' | 'partial';
  terminalReason: string;
  profiles: readonly LlamaAdaptiveCalibrationProfileReport[];
  schedulingProfileIndexes: readonly number[];
  workloadComparability: 'verified' | 'unverified';
  cells: readonly LlamaAdaptiveCalibrationCellReport[];
  budget: LlamaAdaptiveCalibrationBudgetReport;
  globalFastestScoreMs?: number;
  contextBandMaxScoreMs?: number;
  kvBandMaxScoreMs?: number;
  contextPreferenceResolution:
    | 'single-profile' | 'largest-in-band' | 'fastest-only' | 'unresolved';
  kvPrecisionPreferenceResolution:
    | 'disabled'
    | 'largest-in-joint-band'
    | 'fallback-no-joint-eligible'
    | 'unresolved';
  fallback?: LlamaCalibrationFallback;
  pinnedMoePlacement: true;
}

type LlamaAdaptiveSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: LlamaAdaptiveCalibrationSelectionEvidence;
    }
  | { selected?: never; selectionEvidence?: never };

type LlamaAdaptiveCalibrationReport = LlamaAdaptiveCalibrationReportFields &
  LlamaAdaptiveSelection;

interface LlamaExactCalibrationReportFields extends LlamaCalibrationReportBase {
  strategy: 'exact';
  status: 'complete' | 'no-viable-candidate';
  profile: LlamaCalibrationProfile;
  verifiedProfile?: LlamaCalibrationVerifiedProfile;
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
  runs: readonly LlamaCalibrationRun[];
  confidence: 'single-launch-measurement';
}

type LlamaExactSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: 'single-launch-measurement';
    }
  | { selected?: never; selectionEvidence?: never };

type LlamaExactCalibrationReport = LlamaExactCalibrationReportFields & LlamaExactSelection;

interface LlamaAdaptiveCalibrationPreparationTimeLimit {
  resultKind: 'preparation-time-limit';
  schemaVersion: 4;
  policyVersion: 'llama-runtime-v4';
  createdAt: string;
  strategy: 'adaptive';
  phase: 'preparing';
  status: 'time-limited';
  searchCompleteness: 'partial';
  terminalReason: string;
  budget: LlamaAdaptiveCalibrationBudgetReport;
  probes: readonly [];
  warnings: readonly string[];
  cleanupConfirmed: true;
  selected?: never;
  selectionEvidence?: never;
}

type LlamaCalibrationReport =
  | LlamaAdaptiveCalibrationReport
  | LlamaExactCalibrationReport
  | LlamaAdaptiveCalibrationPreparationTimeLimit;

interface LlamaCalibrationPartialReport {
  schemaVersion: 4;
  policyVersion: string;
  strategy: 'adaptive' | 'exact';
  status: 'aborted' | 'failed';
  createdAt: string;
  // Absent only when the run failed before its fixed baseline existed.
  resourceMonitoring?: LlamaCalibrationResourceMonitoring;
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
  cleanupConfirmed: boolean;
}

type LlamaCalibrationResourceFailurePartialReport =
  | (Omit<LlamaCalibrationPartialReport, 'strategy' | 'status' | 'cleanupConfirmed'> & {
      strategy: 'adaptive';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness: 'partial';
      budget: LlamaAdaptiveCalibrationBudgetReport;
      bestKnown?: LlamaAdaptiveCalibrationBestKnown;
    })
  | (Omit<LlamaCalibrationPartialReport, 'strategy' | 'status' | 'cleanupConfirmed'> & {
      strategy: 'exact';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness?: never;
      bestKnown?: LlamaExactCalibrationBestKnown;
    });
```

`LlamaAdaptiveCalibrationProfileReport`, `LlamaAdaptiveCalibrationCellReport`,
`LlamaAdaptiveCalibrationBudgetReport`, `LlamaAdaptiveCalibrationPreparationTimeLimit`, both
strategy-specific `BestKnown` types, `LlamaCalibrationMethodology`,
`LlamaCalibrationResourceStabilityMethodology`, `LlamaCalibrationRequestTiming`,
`LlamaCalibrationSample`, `LlamaCalibrationWorkloadResult`, every resource-diagnostic type above,
the workload signature, and model/binary/machine identity types are also exported from the package
root. Aborted and failed calls reject with the typed partial report at
`ServerError.details.partialReport`; a resource-stability rejection uses the dedicated
[`LlamaCalibrationResourceStabilityError`](#llamacalibrationresourcestabilityerror). See
[LLM Runtime Calibration](llm-server.md#runtime-calibration) for search semantics, budgets,
application, and invalidation.

Narrow `LlamaCalibrationReport` on `resultKind` first. Only `resultKind: 'report'` carries ordinary
model/machine identity and can then be narrowed by `strategy`; `preparation-time-limit` is the
minimal adaptive branch produced before that identity and the fixed baseline exist.

**Removed in schema v3** (present in schema-v2 reports, which should be discarded rather than
migrated): `LlamaCalibrationProbe.resourceRegime`, `LlamaCalibrationResourceMetricDiagnostic`, and
the `hostAvailableMemory` / `gpuAvailableMemory` fields of
`LlamaCalibrationPassiveDiagnostics`.

**Removed in schema v4:** adaptive `provisional` and `confidence`, `targetProbes`, cell-count budget
formulas/reserves, duration estimates, admission/finalization fields, diagnostic-only candidates,
and the public budget resolvers. Adaptive `selected` and `selectionEvidence` are one atomic union;
`searchCompleteness` remains an independent fact.

---

## Image Generation Types

### ImageGenerationConfig

```typescript
interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;                    // NO library default — omitted fields are omitted from the
  height?: number;                   //   backend request, so stable-diffusion.cpp's own defaults
  steps?: number;                    //   apply. Send steps/cfgScale/sampler explicitly.
  cfgScale?: number;
  seed?: number;                     // omitted = random (the resolved seed is reported back)
  sampler?: ImageSampler;
  count?: number;                    // 1-5 on the async HTTP API; default 1
  usageMode?: DiffusionUsageMode;    // Residency policy for THIS request; omitted = the server's
                                     //   DiffusionServerConfig.usageMode decides
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: ImageGenerationStage,
    percentage?: number
  ) => void;
}
```

The library applies **no** defaults to `width`/`height`/`steps`/`cfgScale`/`sampler` — see the
note under [`generateImage()`](image-generation.md#generateimageconfig). Callers going through
genai-lite get genai-lite's defaults for omitted fields, not stable-diffusion.cpp's.

### ImageGenerationResult

```typescript
interface ImageGenerationResult {
  image: Buffer;
  format: 'png';
  timeTaken: number;
  seed: number;
  width: number;                     // actual dimensions of the returned PNG (read from its
  height: number;                    //   header), not an echo of the requested config; only an
                                     //   unparseable payload falls back — to the requested size,
                                     //   then 512 when the request omitted one
}
```

### ImageSampler

```typescript
type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm'
  | 'er_sde'
  | 'euler_cfg_pp'
  | 'euler_a_cfg_pp';
```

### ImageGenerationStage

```typescript
type ImageGenerationStage =
  | 'loading'
  | 'diffusion'
  | 'decoding';
```

### ImageGenerationProgress

```typescript
interface ImageGenerationProgress {
  currentStep: number;
  totalSteps: number;
  stage: ImageGenerationStage;
  percentage?: number;               // monotonic within one generation and capped at 99 while in
                                     //   flight; 100 is reported exactly once, by the completion
                                     //   callback, when the image exists
  currentImage?: number;             // clamped to <= totalImages
  totalImages?: number;
}
```

### DiffusionOffloadCombo

One offload combination to benchmark during [offload calibration](image-generation.md#offload-calibration). Omitted flags = auto-detect. `label` is for UIs/reports only — strip it before spreading a combo into `start()` config.

```typescript
interface DiffusionOffloadCombo {
  label?: string;
  clipOnCpu?: boolean;
  vaeOnCpu?: boolean;
  offloadToCpu?: boolean;
  diffusionFlashAttention?: boolean;
}
```

### CalibrationSize

Dimensions to benchmark (positive multiples of 64).

```typescript
interface CalibrationSize {
  width: number;
  height: number;
}
```

### DiffusionCalibrationGeneration

The production generation parameters an offload-calibration sweep runs under. Required as a unit (no defaults) so calibration measures the same compute profile as your real generations — a mismatch, `cfgScale` above all, can rank the combos wrong.

```typescript
interface DiffusionCalibrationGeneration {
  steps: number;      // match production (diffusion/offload cost scales with steps)
  cfgScale: number;   // match production — cfgScale > 1 = 2 model passes/step (~2x cost),
                      //   can flip the winner. Distilled models (Flux Klein, Turbo) run at 1.
  sampler: ImageSampler; // match production (per-step cost varies by sampler)
  threads?: number;   // match production -t (offload is CPU-sensitive); omitted = sd.cpp default
  batchSize?: number; // match production; maps to `batch_count` in the backend job request
                      //   (the historical sd.cpp -b flag). Omitted = 1, sd.cpp's own default
}
```

### DiffusionCalibrationConfig

Configuration for `diffusionServer.calibrate()`. `sizes` and `generation` are required and must reflect production.

```typescript
interface DiffusionCalibrationConfig {
  modelId: string;
  sizes: CalibrationSize[];           // your app's real size(s); multiples of 64
  generation: DiffusionCalibrationGeneration; // production params the sweep mirrors
  usageMode?: DiffusionUsageMode;     // WHAT is measured. default: 'single' (cold spawn per timed
                                      //   sample); 'burst' = one launch per combo, warm samples.
                                      //   Timings are only comparable within the same mode.
  combos?: DiffusionOffloadCombo[];   // default: DIFFUSION_CALIBRATION_DEFAULTS.combos
  seed?: number;                      // default: 42 (fixed → identical work per combo)
  prompt?: string;                    // default: neutral built-in prompt (does not affect timing)
  samples?: number;                   // default: 2 (timed samples per combo × size)
  onProgress?: (progress: DiffusionCalibrationProgress) => void;
  signal?: AbortSignal;               // abort → details.code === 'CALIBRATION_ABORTED'
}
```

### DiffusionCalibrationProgress

Delivered via the `onProgress` callback and the `'calibration-progress'` event (same payload).

```typescript
interface DiffusionCalibrationProgress {
  phase: 'preparing' | 'warmup' | 'sampling' | 'restoring-llm' | 'done';
  comboIndex: number;                 // 0-based, into the active (post-skip) combo list
  comboCount: number;
  combo?: DiffusionOffloadCombo;
  sizeIndex: number;
  sizeCount: number;
  size?: CalibrationSize;
  sample?: number;                    // 1-based, timed samples only
  sampleCount?: number;
  generationPercent?: number;         // 0-100 within the current generation
  overallPercent: number;             // 0-100, smooth and monotonic across the sweep
}
```

### CalibrationRun

One benchmarked (combo, size) pair.

```typescript
interface CalibrationRun {
  size: CalibrationSize;
  combo: DiffusionOffloadCombo;       // as requested (omitted flags = auto)
  resolved?: {                        // what auto-detection picked for this run
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
  };
  status: 'ok' | 'oom' | 'error';
  timeTakenMs?: number;               // median of samplesMs; only when status === 'ok'
  stageMs?: { loadMs?: number; diffusionMs?: number; decodeMs?: number };
                                      // split of the sample closest to the median. `loadMs` spans
                                      //   sample start → first 'generating' marker, and "start"
                                      //   follows the report's usageMode: the backend SPAWN in
                                      //   'single' (a real model load), the JOB SUBMISSION in
                                      //   'burst' (conditioning only). diffusionMs/decodeMs are
                                      //   mode-independent.
  vramPeakBytes?: number;             // machine-wide vramTotal − min(vramAvailable) over that
                                      //   sample (~1 s resolution)
  vramIdleBytes?: number;             // machine-wide vramTotal − vramAvailable once it settled:
                                      //   after the release in 'single', right after the job in
                                      //   'burst'. Both VRAM fields are omitted together when GPU
                                      //   telemetry is unavailable/untrusted, and always on macOS.
  samplesMs?: number[];               // raw totals of successful samples
  error?: string;                     // when status !== 'ok'
}
```

### DiffusionCalibrationReport

```typescript
interface DiffusionCalibrationReport {
  machine: {
    gpuType?: string;
    gpuName?: string;
    vramBytes?: number;
    vramAvailableBytes?: number;
  };
  modelId: string;
  steps: number;                      // methodology echo (persistence keying)
  cfgScale: number;                   // methodology echo
  sampler: ImageSampler;
  samples: number;
  usageMode: DiffusionUsageMode;      // resolved mode the sweep measured. timeTakenMs,
                                      //   stageMs.loadMs and the VRAM figures are only comparable
                                      //   between reports sharing this value
  policyVersion: 'diffusion-offload-v2'; // compatibility identifier. A stored report with NO
                                      //   policyVersion is a pre-migration v1 report (one CLI
                                      //   process per image) — 'single'-comparable at best
  runs: CalibrationRun[];
  recommended: Record<string, DiffusionOffloadCombo>; // keyed "<width>x<height>", e.g. "768x768"
  skippedCombos?: { combo: DiffusionOffloadCombo; reason: string }[];
}
```

---

## Async Generation Types

Types for HTTP API async image generation (polling pattern).

### GenerationStatus

`'cancelled'` is a terminal status (added in v0.6.0). Note: genai-lite pollers below 0.9.2 treat only `'complete'`/`'error'` as terminal, so an out-of-band cancellation leaves those clients polling until their own client-side timeout; genai-lite ≥ 0.9.2 stops immediately, and ≥ 0.10.0 can issue the cancellation itself (AbortSignal → `DELETE /v1/images/generations/:id`).

```typescript
type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error' | 'cancelled';
```

### GenerationState

```typescript
interface GenerationState {
  id: string;
  status: GenerationStatus;
  createdAt: number;
  updatedAt: number;
  config: ImageGenerationConfig;
  progress?: ImageGenerationProgress;
  result?: {
    images: Array<{
      image: string;
      seed: number;
      width: number;
      height: number;
    }>;
    format: 'png';
    timeTaken: number;
  };
  error?: {
    message: string;
    code: string;
  };
}
```

### GenerationRegistryConfig

**Note:** Internal type, not exported from main package. For advanced usage with custom `GenerationRegistry` instances.

```typescript
interface GenerationRegistryConfig {
  maxResultAgeMs?: number;
  cleanupIntervalMs?: number;
}
```

**Environment Variables:**
- `IMAGE_RESULT_TTL_MS` - Override `maxResultAgeMs`
- `IMAGE_CLEANUP_INTERVAL_MS` - Override `cleanupIntervalMs`

---

## Logging Types

### LogEntry

```typescript
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}
```

### LogLevel

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
```

### LogRotationOptions

Size-based log rotation settings passed to `LogManager`. Defaults come from `DEFAULT_LOG_ROTATION` (5 MB, 2 archives).

```typescript
interface LogRotationOptions {
  maxFileSize?: number;  // Rotate when the log exceeds this many bytes (default: 5 * 1024 * 1024)
  maxArchives?: number;  // Rotated archives to keep, e.g. server.log.1/.2 (default: 2; 0 = truncate in place)
}
```

---

## Resource Types

### OptimalConfigHints

Fields the caller has already pinned when asking `systemInfo.getOptimalConfig(modelInfo, hints?)` for recommendations. Pinned values are respected verbatim and inform the sizing of the remaining dimensions; explicit cache types or `flashAttention: 'off'` suppress automatic KV quantization.

```typescript
type OptimalConfigHints = Partial<
  Pick<
    LlamaServerConfig,
    | 'contextSize'
    | 'minimumContextSize'
    | 'preferredContextSize'
    | 'maximumContextSize'
    | 'gpuLayers'
    | 'parallelRequests'
    | 'flashAttention'
    | 'cacheTypeK'
    | 'cacheTypeV'
    | 'cpuMoe'
    | 'nCpuMoe'
    | 'overrideTensors'
  >
>;
```

`contextSize` is an exact total pin and is mutually exclusive with the context-policy fields in
`getOptimalConfig()`. Minimum/preferred/maximum values are effective capacities per parallel
request slot; returned `contextSize` is the total allocation across all slots. Minimum and
maximum are hard runtime bounds, while preferred is only a soft sizing cap. A policy-aware result
retains all three values and caller-owned placement/cache hints for direct spread into
`llamaServer.start()`. Runtime capacity above preferred is accepted.

`getOptimalConfig` returns `Promise<Partial<LlamaServerConfig>>` (may include auto-selected
`cacheTypeK`/`cacheTypeV`/`flashAttention`). The KV arithmetic is exported as
`estimateKVBytesPerToken(modelInfo, cacheTypeK?, cacheTypeV?)`; context rounding as
`floorContextToGranularity(tokens)` (progressive: 512-steps up to 8K, 1024 to 16K, 2048 to 32K,
4096 beyond).


### SavedLLMState

```typescript
interface SavedLLMState {
  config: ServerConfig;
  wasRunning: boolean;
  savedAt: Date;
}
```

---

## Error Types

### ContextConstraintError

`ContextConstraintError` extends `GenaiElectronError`, uses code
`CONTEXT_CONSTRAINT_ERROR`, and exposes typed details:

```typescript
type ContextConstraintStage = 'validation' | 'sizing' | 'runtime';

type ContextConstraintReason =
  | 'invalid-minimum'
  | 'invalid-preferred'
  | 'invalid-maximum'
  | 'exact-range-conflict'
  | 'minimum-exceeds-preferred'
  | 'preferred-exceeds-maximum'
  | 'minimum-exceeds-maximum'
  | 'unsafe-total-capacity'
  | 'minimum-exceeds-native'
  | 'model-context-unknown'
  | 'fit-range-conflict'
  | 'precomputed-context-out-of-range'
  | 'runtime-capacity-unavailable'
  | 'runtime-slots-mismatch'
  | 'runtime-below-minimum'
  | 'runtime-above-maximum';

interface ContextConstraintDetails {
  reason: ContextConstraintReason;
  stage: ContextConstraintStage;
  contextSize?: number;
  minimumContextSize?: number;
  preferredContextSize?: number;
  maximumContextSize?: number;
  configuredContextSize?: number;
  effectiveContextSize?: number;
  nativeContextSize?: number;
  parallelRequests?: number;
  effectiveParallelRequests?: number;
  suggestion?: string;
  cause?: string;
}
```

Invalid combinations and unverifiable runtime capacity use this error. A valid minimum that no
permitted hardware placement can satisfy uses `InsufficientResourcesError` instead.

### LlamaCalibrationResourceStabilityError

Thrown by `llamaServer.calibrate()` — in **both** adaptive and exact mode — when machine conditions
either changed materially around a launch boundary or could not be verified stable. It extends
`ServerError`, so `error.code` is still `'SERVER_ERROR'` and existing
`instanceof ServerError` handling keeps working; the calibration-specific discriminant is
`error.details.code`.

```typescript
type LlamaCalibrationResourceStabilityCode =
  | 'CALIBRATION_RESOURCE_DRIFT'
  | 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED';

// Only fields guaranteed for BOTH variants belong here.
interface LlamaCalibrationResourceStabilityDetailsCommon {
  partialReport: LlamaCalibrationResourceFailurePartialReport;
  suggestion: string;
}

type LlamaCalibrationResourceStabilityDetails =
  LlamaCalibrationResourceStabilityDetailsCommon &
    (
      | { code: 'CALIBRATION_RESOURCE_DRIFT' }
      | { code: 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED' }
    );

class LlamaCalibrationResourceStabilityError extends ServerError {
  declare readonly details: LlamaCalibrationResourceStabilityDetails;
}
```

`CALIBRATION_RESOURCE_DRIFT` means the same trusted metric stayed outside its band in the
confirmation snapshot, in either direction. `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED` means a
trusted suspicious boundary could not be resolved — its confirmation reading became untrusted, or a
different metric became newly suspicious. The two are never conflated. One `instanceof` branch plus
a typed `switch (error.details.code)` covers both; the boundary, affected metrics and directions,
optional probe index, and full readings live once, on `details.partialReport.resourceFailure`.

### InsufficientResourcesDetails

```typescript
interface InsufficientResourcesDetails {
  required: string;
  available: string;
  suggestion?: string;
  minimumContextSize?: number;
  preferredContextSize?: number;
  maximumContextSize?: number;
  configuredContextSize?: number;
  maxFeasibleContextSize?: number;
  parallelRequests?: number;
}
```

All error classes and the details/reason/stage types are exported from the package root.

---

## UI Types

### UIErrorFormat

```typescript
interface UIErrorFormat {
  code: string;
  title: string;
  message: string;
  remediation?: string;
}
```

---

## Low-Level Types

Types for advanced usage with low-level process management.

### SpawnOptions

```typescript
interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
}
```

### SpawnResult

```typescript
interface SpawnResult {
  process: ChildProcess;
  pid: number;
}
```

---

## Utility Types

TypeScript utility types for advanced usage.

```typescript
type Optional<T> = {
  [K in keyof T]?: T[K];
};

type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

type AsyncFunction<T = void> = () => Promise<T>;

type CleanupFunction = () => void | Promise<void>;
```

---

## Constants

### LLAMA_CALIBRATION_DEFAULTS

Protocol and policy defaults for [LLM runtime calibration](llm-server.md#runtime-calibration).
Adaptive's fixed 60-minute default is independent of cell count; callers may provide any positive
safe-integer `maxWallTimeMs`.

Import the constant from the package root inside Electron, or from the dedicated Electron-free
entry in plain-Node tests and build scripts:

```typescript
import { LLAMA_CALIBRATION_DEFAULTS } from 'genai-electron/llm-calibration-policy';
```

```typescript
const LLAMA_CALIBRATION_DEFAULTS = {
  samples: 3,
  searchSamples: 1,
  seed: 42,
  grossRegressionMultiplier: 1.5,
  earlyStopMultiplier: 2,
  minimumAdaptiveRequestTimeoutMs: 15_000,
  tieTolerancePct: 5,
  contextPreferencePct: 10,
  includeKvCacheComparison: false,
  kvPrecisionPreferencePct: 10,
  searchNoiseAllowancePct: 20,
  nonMonotoneTriggerPct: 20,
  guardDistanceMinLayers: 2,
  guardDistanceFraction: 0.1,
  stabilityTolerancePct: 25,
  // Fixed-baseline resource-stability bands, in percent of the run's one
  // baseline. Inclusive comparison; a confirmed crossing in either direction
  // stops calibration under one error class.
  hostMemoryDecreaseThresholdPct: 10,
  vramDecreaseThresholdPct: 10,
  hostMemoryIncreaseThresholdPct: 20,
  vramIncreaseThresholdPct: 10,
  resourceBaselineSamples: 3,        // bounded; ≥2 must be trusted per metric
  resourceBaselineSettleMs: 5_000,   // fixed settle before the first attempt
  resourceDriftConfirmationReads: 1, // whole-boundary confirmations
  resourceTelemetryTimeoutMs: 10_000,// per host/GPU telemetry capture
  policyVersion: 'llama-runtime-v4',
  adaptiveMaxWallTimeMs: 60 * 60 * 1_000,
  startupTimeoutMs: 120_000,
  requestTimeoutMs: 120_000,
  resourceCooldownMs: 750,           // also the confirmation spacing
  stderrMaxBytes: 16 * 1024,
  maxRunnerStartAttempts: 2,
  capacityCheckTimeoutCapMs: 5_000,
  processExitConfirmationMs: 2_000,
  processExitSettleGraceMs: 250,
  // Internal v0.18 rollback-path setting; not a public adaptive mode.
  maxCandidates: 10,
  oomPatterns: [/* versioned diagnostic patterns */] as readonly RegExp[]
} as const;
```

Omitted `maxProbes` is represented by absent fields, never a non-finite or large numeric sentinel.

`policyVersion` is the persisted-calibration compatibility identifier. It must change whenever
altered admission, ranking, scheduling, evidence, or resource-validity semantics can invalidate
reports or recommendations produced under otherwise identical inputs. A correction may retain the
identifier only when existing persisted artifacts remain semantically valid.

The resource-stability values are exported policy constants, not caller-configurable calibration
fields, and there is no override that disables confirmation. They are heuristic, provisional, and
screened on a Windows/NVIDIA reference machine. **Removed in this policy version:**
`resourceDriftThresholdPct`, `resourceSettledTolerancePct`, and `resourceDriftRetries`.
Schema 4 also removed `adaptiveBudgetFormula`, duration-estimation/admission defaults, and the public
budget resolvers; `policyVersion` is now `llama-runtime-v4`.

### DIFFUSION_COMPONENT_FLAGS

Maps component roles to sd.cpp CLI flags.

```typescript
const DIFFUSION_COMPONENT_FLAGS: Record<DiffusionComponentRole, string>;
// { diffusion_model: '--diffusion-model', clip_l: '--clip_l', ... }
```

### DIFFUSION_COMPONENT_ORDER

Canonical iteration order for component roles.

```typescript
const DIFFUSION_COMPONENT_ORDER: readonly DiffusionComponentRole[];
// ['diffusion_model', 'clip_l', 'clip_g', 't5xxl', 'llm', 'llm_vision', 'vae']
```

### DIFFUSION_BACKEND_DEFAULTS

Policy defaults for the internal stable-diffusion.cpp backend process (see
[Backend Residency](image-generation.md#backend-residency)).

```typescript
const DIFFUSION_BACKEND_DEFAULTS = {
  idleTimeoutMs: 300_000,             // idle time before a 'burst'-resident backend is released
                                      //   (DiffusionServerConfig.idleTimeoutMs: 0 = never)
  jobActivityTimeoutMs: 600_000,      // no-activity timeout for an in-flight backend job
                                      //   (DiffusionServerConfig.jobActivityTimeoutMs: 0, or any
                                      //   non-positive / non-finite value, = off)
  jobPollIntervalMs: 200,             // poll interval for GET /sdcpp/v1/jobs/{id}
  jobRequestTimeoutMs: 10_000,        // per-request timeout for the backend job API; longer than
                                      //   the client's own 5 s default because the backend answers
                                      //   from the thread that runs sampling
  readyTimeoutMs: 120_000,            // DEFAULT_TIMEOUTS.serverStart — max spawn → ready wait
  stopTimeoutMs: 10_000,              // DEFAULT_TIMEOUTS.serverStop — SIGTERM → SIGKILL grace
  maxTransientPollFailures: 3,        // consecutive transient job-poll failures that fail the
                                      //   generation; below this the poll loop retries
} as const;
```

### DIFFUSION_CALIBRATION_DEFAULTS

Defaults for [offload calibration](image-generation.md#offload-calibration): the curated labeled combo set (`auto`, `clip-gpu`, `clip-gpu+offload`, `offload`, `all-resident`, `max-savings`), default samples/seed/prompt, the 5% tie tolerance, the SD3.5-Large id/name pattern, the OOM stderr patterns, the default residency mode, and the persisted-report policy identifier. (`sizes`/`steps`/`cfgScale`/`sampler` are intentionally **not** defaulted — the caller supplies them via `sizes` / `generation` so calibration mirrors production.)

```typescript
const DIFFUSION_CALIBRATION_DEFAULTS: {
  readonly combos: readonly DiffusionOffloadCombo[];
  readonly samples: number;                         // 2
  readonly seed: number;                            // 42
  readonly prompt: string;
  readonly tieTolerancePct: number;                 // 5
  readonly sd35LargePattern: RegExp;
  readonly oomPatterns: readonly RegExp[];
  readonly policyVersion: 'diffusion-offload-v2';   // echoed on every report
  readonly usageMode: DiffusionUsageMode;           // 'single' (cold spawn per timed sample)
};
```

`policyVersion` is the persisted-report compatibility identifier: `'diffusion-offload-v2'` marks
reports measured against the resident `sd-server` backend. Absent in a stored report = a
pre-migration v1 report, measured with one CLI process per image.

---

## Import Examples

### Type-Only Imports

```typescript
import type {
  SystemCapabilities,
  ArtifactProvenance,
  ModelInfo,
  ServerStatus,
  LlamaPreStartHook,
  ImageGenerationConfig,
  ImageGenerationResult,
  DiffusionUsageMode,
  DiffusionBackendState,
  DiffusionBackendReleaseReason,
  DiffusionBackendInfo,
  DiffusionBackendStatusEvent
} from 'genai-electron';
```

### Class and Instance Imports

```typescript
import {
  systemInfo,
  modelManager,
  llamaServer,
  diffusionServer
} from 'genai-electron';

// Or for custom instances
import {
  SystemInfo,
  ModelManager,
  LlamaServerManager,
  DiffusionServerManager,
  ResourceOrchestrator
} from 'genai-electron';
```

### Utility Imports

```typescript
import {
  attachAppLifecycle,
  formatErrorForUI,
  detectReasoningSupport,
  REASONING_MODEL_PATTERNS,
  getArchField,
  getHuggingFaceURL,
  parseHuggingFaceURL,
  findFreePort,
  isPortBindable,
  normalizeHealthHost
} from 'genai-electron';
```

---

## See Also

- [System Detection](system-detection.md) - SystemCapabilities usage
- [Model Management](model-management.md) - ModelInfo and GGUFMetadata usage
- [LLM Server](llm-server.md) - ServerConfig and ServerInfo usage
- [Image Generation](image-generation.md) - ImageGenerationConfig and progress types
- [Integration Guide](integration-guide.md) - UIErrorFormat usage
