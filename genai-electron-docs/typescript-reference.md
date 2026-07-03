# TypeScript Reference

Complete type definitions for genai-electron. The library is TypeScript-first with comprehensive type safety.

## Navigation

- [System Types](#system-types)
- [Model Types](#model-types)
- [Server Types](#server-types)
- [Image Generation Types](#image-generation-types)
- [Async Generation Types](#async-generation-types)
- [Logging Types](#logging-types)
- [Resource Types](#resource-types)
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
}
```

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
  name: string;
  type: ModelType;
  checksum?: string;
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
  checksum?: string;  // Expected SHA256 checksum
}
```

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
}
```

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

### ServerConfig

```typescript
interface ServerConfig {
  modelId: string;
  port?: number | 'auto';           // Default: 8080 (llama) / 8081 (diffusion); 'auto' picks a free OS port
  threads?: number;
  contextSize?: number;
  gpuLayers?: number;
  parallelRequests?: number;
  flashAttention?: FlashAttentionSetting;
  host?: string;                    // Interface to bind (--host); default 127.0.0.1 (loopback only)
  forceValidation?: boolean;
  startupTimeout?: number;          // Max ms to wait for health after spawn (default: 120000)
}
```

### DiffusionServerInfo

Standalone interface mirroring `ServerInfo` fields (adds `busy`; has no `loadTimeMs`).

```typescript
interface DiffusionServerInfo {
  status: ServerStatus;
  health: HealthStatus;
  pid?: number;
  port: number;
  modelId: string;
  startedAt?: string;
  error?: string;
  busy?: boolean;
}
```

### DiffusionServerConfig

```typescript
interface DiffusionServerConfig {
  modelId: string;
  port?: number | 'auto';            // Default: 8081; 'auto' picks a free OS port
  threads?: number;
  gpuLayers?: number;
  forceValidation?: boolean;
  clipOnCpu?: boolean;               // Offload CLIP text encoder to CPU (--clip-on-cpu). undefined=auto-detect (disabled for CUDA backend), true=force on, false=force off.
  vaeOnCpu?: boolean;                // Offload VAE decoder to CPU (--vae-on-cpu). undefined=auto-detect (disabled for CUDA backend), true=force on, false=force off.
  batchSize?: number;                // Batch size for generation (-b flag). Not auto-detected.
  offloadToCpu?: boolean;            // Offload model weights to CPU RAM (--offload-to-cpu). undefined=auto-detect (disabled for CUDA backend), true=force on, false=force off.
  diffusionFlashAttention?: boolean; // Enable flash attention (--diffusion-fa). undefined=auto-detect (enabled for Flux 2), true=force on, false=force off.
}
```

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
  | 'started'
  | 'stopped'
  | 'crashed'
  | 'restarted'
  | 'health-check-ok'
  | 'health-check-failed'
  | 'binary-log';
```

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

### Port & Health Utilities

Low-level helpers used by the server managers (also exported for advanced use).

```typescript
// Resolve a free OS-assigned TCP port on the given host (used when port is 'auto').
function findFreePort(host?: string): Promise<number>;   // host defaults to '127.0.0.1'

// Test whether a specific port can be bound on the given host (catches non-HTTP occupants).
function isPortBindable(port: number, host?: string): Promise<boolean>;  // host defaults to '127.0.0.1'

// Map a bind host to the host health checks should target
// (wildcards '0.0.0.0' / '::' → '127.0.0.1'; unset → '127.0.0.1').
function normalizeHealthHost(host?: string): string;
```

---

## Image Generation Types

### ImageGenerationConfig

```typescript
interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  sampler?: ImageSampler;
  count?: number;
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: ImageGenerationStage,
    percentage?: number
  ) => void;
}
```

### ImageGenerationResult

```typescript
interface ImageGenerationResult {
  image: Buffer;
  format: 'png';
  timeTaken: number;
  seed: number;
  width: number;
  height: number;
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
  | 'lcm';
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
  percentage?: number;
  currentImage?: number;
  totalImages?: number;
}
```

---

## Async Generation Types

Types for HTTP API async image generation (polling pattern).

### GenerationStatus

`'cancelled'` is a terminal status (added in v0.6.0). Note: genai-lite pollers older than the version that recognizes it treat only `'complete'`/`'error'` as terminal, so an out-of-band cancellation leaves those clients polling until their own client-side timeout.

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

### SavedLLMState

```typescript
interface SavedLLMState {
  config: ServerConfig;
  wasRunning: boolean;
  savedAt: Date;
}
```

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

---

## Import Examples

### Type-Only Imports

```typescript
import type {
  SystemCapabilities,
  ModelInfo,
  ServerStatus,
  ImageGenerationConfig,
  ImageGenerationResult
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
