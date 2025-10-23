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
  port: number;
  modelId: string;
  startedAt?: string;
  error?: string;
}
```

### ServerConfig

```typescript
interface ServerConfig {
  modelId: string;
  port: number;
  threads?: number;
  contextSize?: number;
  gpuLayers?: number;
  parallelRequests?: number;
  flashAttention?: boolean;
  forceValidation?: boolean;
}
```

### DiffusionServerInfo

Extends `ServerInfo` with additional diffusion-specific fields.

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
  port?: number;
  threads?: number;
  gpuLayers?: number;
  vramBudget?: number;
  forceValidation?: boolean;
}
```

### LlamaServerConfig

Extends `ServerConfig` with llama.cpp-specific options.

```typescript
interface LlamaServerConfig extends ServerConfig {
  modelAlias?: string;
  continuousBatching?: boolean;
  batchSize?: number;
  useMmap?: boolean;
  useMlock?: boolean;
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

```typescript
type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error';
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
  getArchField
} from 'genai-electron';
```

---

## See Also

- [System Detection](system-detection.md) - SystemCapabilities usage
- [Model Management](model-management.md) - ModelInfo and GGUFMetadata usage
- [LLM Server](llm-server.md) - ServerConfig and ServerInfo usage
- [Image Generation](image-generation.md) - ImageGenerationConfig and progress types
- [Integration Guide](integration-guide.md) - UIErrorFormat usage
