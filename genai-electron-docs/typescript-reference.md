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

---

## System Types

### SystemCapabilities

Complete system hardware information.

```typescript
interface SystemCapabilities {
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpu: GPUInfo;
  platform: NodeJS.Platform;           // 'darwin', 'win32', 'linux'
  recommendations: SystemRecommendations;
  detectedAt: string;                  // ISO 8601 timestamp
}
```

### CPUInfo

```typescript
interface CPUInfo {
  cores: number;           // Number of CPU cores
  model: string;           // CPU model name
  architecture: string;    // 'x64', 'arm64', etc.
}
```

### MemoryInfo

```typescript
interface MemoryInfo {
  total: number;      // Total RAM in bytes
  available: number;  // Available RAM in bytes
  used: number;       // Used RAM in bytes
}
```

### GPUInfo

```typescript
interface GPUInfo {
  available: boolean;                  // Whether GPU is detected
  type?: 'nvidia' | 'amd' | 'apple' | 'intel';
  name?: string;                       // GPU model name
  vram?: number;                       // VRAM in bytes
  cuda?: boolean;                      // NVIDIA CUDA support
  metal?: boolean;                     // Apple Metal support
  rocm?: boolean;                      // AMD ROCm support
  vulkan?: boolean;                    // Vulkan support
}
```

### SystemRecommendations

```typescript
interface SystemRecommendations {
  maxModelSize: string;                      // e.g., '7B', '13B'
  recommendedQuantization: readonly string[];  // e.g., ['Q4_K_M', 'Q5_K_M']
  threads: number;                           // Recommended thread count
  gpuLayers?: number;                        // Recommended GPU layers (if GPU available)
}
```

---

## Model Types

### ModelInfo

```typescript
interface ModelInfo {
  id: string;                  // Unique model identifier
  name: string;                // Display name
  type: ModelType;             // 'llm' or 'diffusion'
  size: number;                // File size in bytes
  path: string;                // Absolute path to model file
  downloadedAt: string;        // ISO 8601 timestamp
  source: ModelSource;         // Download source info
  checksum?: string;           // SHA256 checksum (if provided)
  supportsReasoning?: boolean; // Reasoning model detection (Qwen3, DeepSeek-R1, GPT-OSS)
  ggufMetadata?: GGUFMetadata; // GGUF metadata (extracted during download)
}
```

**Reasoning Support:**
- Automatically detected based on GGUF filename patterns
- When `true`, llama-server started with `--jinja --reasoning-format deepseek`
- Supported families: Qwen3, DeepSeek-R1, GPT-OSS

**GGUF Metadata:**
- Extracted during download (validates before downloading)
- Provides actual layer count, context length, architecture
- Use `updateModelMetadata()` for models downloaded before GGUF integration

### ModelType

```typescript
type ModelType = 'llm' | 'diffusion';
```

### ModelSource

```typescript
interface ModelSource {
  type: 'huggingface' | 'url';
  url: string;              // Direct download URL
  repo?: string;            // HuggingFace repo (if applicable)
  file?: string;            // HuggingFace file (if applicable)
}
```

### GGUFMetadata

Complete metadata extracted from GGUF model files.

```typescript
interface GGUFMetadata {
  version?: number;              // GGUF format version
  tensor_count?: number;         // Number of tensors (from BigInt)
  kv_count?: number;             // Number of metadata key-value pairs (from BigInt)
  architecture?: string;         // Model architecture (e.g., "llama", "gemma3", "qwen3")
  general_name?: string;         // Model name from GGUF
  file_type?: number;            // Quantization type
  block_count?: number;          // Number of layers (ACTUAL, not estimated!)
  context_length?: number;       // Maximum sequence length
  attention_head_count?: number; // Number of attention heads
  embedding_length?: number;     // Embedding dimension
  feed_forward_length?: number;  // Feed-forward layer size
  vocab_size?: number;           // Vocabulary size
  rope_dimension_count?: number; // RoPE dimension count
  rope_freq_base?: number;       // RoPE frequency base
  attention_layer_norm_rms_epsilon?: number; // RMS normalization epsilon
  raw?: Record<string, unknown>; // Complete raw metadata (JSON-serializable)
}
```

**Key Fields:**
- `block_count` - Use for GPU offloading calculations (actual layer count)
- `context_length` - Use for context size configuration (model's max capacity)
- `architecture` - Use for compatibility verification

**Architecture Support:**
The library uses generic field extraction with `getArchField()`, supporting ANY architecture dynamically:
- **Llama family:** llama, llama2, llama3
- **Gemma family:** gemma, gemma2, gemma3
- **Qwen family:** qwen, qwen2, qwen3
- **Other:** mistral, phi, mamba, gpt2, gpt-neox, falcon, and any future architectures

Different architectures have metadata in architecture-prefixed fields:
- **llama:** `llama.block_count`, `llama.context_length`
- **gemma3:** `gemma3.block_count`, `gemma3.context_length`
- **qwen3:** `qwen3.block_count`, `qwen3.context_length`

### MetadataFetchStrategy

Strategy for fetching GGUF metadata when updating existing models.

```typescript
type MetadataFetchStrategy =
  | 'local-remote'  // Try local first, fallback to remote (default)
  | 'local-only'    // Read from local file only (fastest, offline-capable)
  | 'remote-only'   // Fetch from remote URL only (requires network)
  | 'remote-local'; // Try remote first, fallback to local
```

**Use Cases:**

| Strategy | Speed | Offline | Use When |
|----------|-------|---------|----------|
| `local-remote` (default) | Fast | ✅ Partial | Want speed + resilience (recommended) |
| `local-only` | Fastest | ✅ Yes | Certain local file is good |
| `remote-only` | Slowest | ❌ No | Verify against source, suspect corruption |
| `remote-local` | Slow | ✅ Partial | Want authoritative + offline fallback |

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
  status: ServerStatus;    // Current server state
  health: HealthStatus;    // Health check result
  pid?: number;            // Process ID (if running)
  port: number;            // Server port
  modelId: string;         // Loaded model ID
  startedAt?: string;      // ISO 8601 timestamp (if running)
}
```

### ServerConfig

```typescript
interface ServerConfig {
  modelId: string;            // Model to load
  port: number;               // Port to listen on
  threads?: number;           // CPU threads
  contextSize?: number;       // Context window size
  gpuLayers?: number;         // GPU layers to offload
  parallelRequests?: number;  // Concurrent request slots
  flashAttention?: boolean;   // Enable flash attention
  forceValidation?: boolean;  // Force re-validation of binary
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
  error?: string;          // Last error message (if crashed)
  busy?: boolean;          // Whether currently generating an image
}
```

### DiffusionServerConfig

```typescript
interface DiffusionServerConfig {
  modelId: string;        // Diffusion model ID to load
  port?: number;          // Port to listen on (default: 8081)
  threads?: number;       // CPU threads (auto-detected if not specified)
  gpuLayers?: number;     // GPU layers to offload (auto-detected if not specified)
  vramBudget?: number;    // VRAM budget in MB (Phase 3 - not yet implemented)
  forceValidation?: boolean; // Force re-validation of binary
}
```

---

## Image Generation Types

### ImageGenerationConfig

Configuration for image generation requests.

```typescript
interface ImageGenerationConfig {
  prompt: string;                    // Text prompt describing the image
  negativePrompt?: string;           // What to avoid in the image
  width?: number;                    // Image width in pixels (default: 512)
  height?: number;                   // Image height in pixels (default: 512)
  steps?: number;                    // Inference steps (default: 20)
  cfgScale?: number;                 // Guidance scale (default: 7.5)
  seed?: number;                     // Random seed (undefined or negative = random)
  sampler?: ImageSampler;            // Sampler algorithm (default: 'euler_a')
  count?: number;                    // Number of images to generate (1-5, default: 1)
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: ImageGenerationStage,
    percentage?: number
  ) => void;                          // Progress callback with stage information
}
```

### ImageGenerationResult

Result of image generation (Node.js API).

```typescript
interface ImageGenerationResult {
  image: Buffer;         // Generated image data (PNG format)
  format: 'png';         // Image format (always 'png')
  timeTaken: number;     // Generation time in milliseconds
  seed: number;          // Seed used (for reproducibility)
  width: number;         // Image width
  height: number;        // Image height
}
```

### ImageSampler

Available sampler algorithms for image generation.

```typescript
type ImageSampler =
  | 'euler_a'      // Euler Ancestral (default, good quality/speed balance)
  | 'euler'        // Euler
  | 'heun'         // Heun (better quality, slower)
  | 'dpm2'         // DPM 2
  | 'dpm++2s_a'    // DPM++ 2S Ancestral
  | 'dpm++2m'      // DPM++ 2M (good quality)
  | 'dpm++2mv2'    // DPM++ 2M v2
  | 'lcm';         // LCM (very fast, fewer steps)
```

### ImageGenerationStage

Stage of image generation process.

```typescript
type ImageGenerationStage =
  | 'loading'     // Model tensors being loaded into memory (~20% of time)
  | 'diffusion'   // Denoising steps (main generation process, ~30-50% of time)
  | 'decoding';   // VAE decoding latents to final image (~30-50% of time)
```

### ImageGenerationProgress

Progress information emitted during image generation.

```typescript
interface ImageGenerationProgress {
  currentStep: number;              // Current step within the stage
  totalSteps: number;               // Total steps in the stage
  stage: ImageGenerationStage;      // Current stage
  percentage?: number;              // Overall progress percentage (0-100)
  currentImage?: number;            // Current image being generated (1-indexed, for batch)
  totalImages?: number;             // Total images in batch (for batch generation)
}
```

**Progress Calculation:**
- System self-calibrates time estimates based on hardware performance
- First generation uses reasonable defaults
- Subsequent generations adapt to image size and step count
- Provides accurate overall percentage across all stages

---

## Async Generation Types

Types for HTTP API async image generation (polling pattern).

### GenerationStatus

Status of an async image generation.

```typescript
type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error';
```

**Status Flow:**
- `pending` → Initial state after POST request
- `in_progress` → Generation is running
- `complete` → Generation finished successfully
- `error` → Generation failed

### GenerationState

Complete state information for an async image generation.

```typescript
interface GenerationState {
  id: string;                      // Unique generation ID
  status: GenerationStatus;        // Current status
  createdAt: number;               // Unix timestamp (ms)
  updatedAt: number;               // Unix timestamp (ms)
  config: ImageGenerationConfig;   // Original request configuration

  // Present when status is 'in_progress'
  progress?: ImageGenerationProgress;

  // Present when status is 'complete'
  result?: {
    images: Array<{
      image: string;      // Base64-encoded PNG
      seed: number;       // Seed used
      width: number;      // Image width
      height: number;     // Image height
    }>;
    format: 'png';
    timeTaken: number;    // Total time in milliseconds
  };

  // Present when status is 'error'
  error?: {
    message: string;
    code: string;         // Error code (SERVER_BUSY, NOT_FOUND, etc.)
  };
}
```

### GenerationRegistryConfig

Configuration for GenerationRegistry (advanced usage).

```typescript
interface GenerationRegistryConfig {
  maxResultAgeMs?: number;      // Max age (ms) before cleanup (default: 5 minutes)
  cleanupIntervalMs?: number;   // Interval (ms) between cleanup runs (default: 1 minute)
}
```

**Environment Variables:**
- `IMAGE_RESULT_TTL_MS` - Override `maxResultAgeMs`
- `IMAGE_CLEANUP_INTERVAL_MS` - Override `cleanupIntervalMs`

---

## Logging Types

### LogEntry

Structured log entry with parsed components.

```typescript
interface LogEntry {
  timestamp: string;  // ISO 8601 timestamp
  level: LogLevel;    // Log level
  message: string;    // Log message content
}
```

**Usage:** Returned by `getStructuredLogs()` method on server managers.

**Example:**
```typescript
const logs = await llamaServer.getStructuredLogs(50);

// Filter by level
const errors = logs.filter(e => e.level === 'error');

// Format for display
logs.forEach(entry => {
  console.log(`[${entry.timestamp}] ${entry.level}: ${entry.message}`);
});
```

### LogLevel

Supported log levels.

```typescript
type LogLevel = 'info' | 'warn' | 'error' | 'debug';
```

---

## Resource Types

### SavedLLMState

State information saved during LLM server offload operations.

```typescript
interface SavedLLMState {
  config: ServerConfig;   // Server configuration at time of offload
  wasRunning: boolean;    // Whether server was running before offload
  savedAt: Date;          // When the state was saved
}
```

**Usage:** Used by `ResourceOrchestrator` to restore LLM server after resource-intensive operations (like image generation).

**Access:** `orchestrator.getSavedState()` returns `SavedLLMState | undefined`

---

## UI Types

### UIErrorFormat

Formatted error for UI display with consistent structure.

```typescript
interface UIErrorFormat {
  code: string;           // Error code for programmatic handling
  title: string;          // Short, human-readable title
  message: string;        // Detailed error message
  remediation?: string;   // Optional suggested remediation steps
}
```

**Usage:** Returned by `formatErrorForUI(error)` utility function.

**Example:**
```typescript
import { formatErrorForUI } from 'genai-electron';

try {
  await operation();
} catch (error) {
  const formatted = formatErrorForUI(error);

  // Display in UI
  showError({
    title: formatted.title,
    message: formatted.message,
    remediation: formatted.remediation
  });

  // Or programmatic handling
  if (formatted.code === 'INSUFFICIENT_RESOURCES') {
    handleDiskSpaceIssue();
  }
}
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
