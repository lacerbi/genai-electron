# System Detection

The `SystemInfo` class provides system capability detection and intelligent configuration recommendations for running local AI models.

---

## Table of Contents

- [Overview](#overview)
- [Import](#import)
- [Methods](#methods)
  - [detect()](#detect)
  - [getMemoryInfo()](#getmemoryinfo)
  - [getGPUInfo()](#getgpuinfo)
  - [canRunModel()](#canrunmodel)
  - [getOptimalConfig()](#getoptimalconfig)
  - [clearCache()](#clearcache)
- [Caching Behavior](#caching-behavior)
- [Platform-Specific Detection](#platform-specific-detection)
- [Examples](#examples)

---

## Overview

`SystemInfo` detects hardware capabilities (CPU, RAM, GPU, VRAM) and provides intelligent recommendations for:
- Maximum model size to run on your system
- Recommended quantization levels
- Optimal thread count for your CPU
- GPU layer offloading (if GPU available)
- Context size configuration

**Key features**:
- Automatic hardware detection (CPU, RAM, GPU, VRAM)
- Platform-specific GPU detection (NVIDIA, AMD, Apple, Intel)
- Smart caching (60-second cache for performance)
- Real-time memory checks (no cache for memory info)
- Automatic cache invalidation on server start/stop

---

## Import

```typescript
import { systemInfo } from 'genai-electron';

// Or for advanced usage:
import { SystemInfo } from 'genai-electron';
const customSystemInfo = SystemInfo.getInstance();
```

The library exports a singleton `systemInfo` instance for convenience. For most use cases, use the singleton.

---

## Methods

### detect()

Detects all system capabilities including CPU, memory, and GPU. Results are cached for 60 seconds.

**Signature**:
```typescript
detect(): Promise<SystemCapabilities>
```

**Returns**: `Promise<SystemCapabilities>` - Complete system information with recommendations

**Example**:
```typescript
const capabilities = await systemInfo.detect();

console.log('System Information:');
console.log('CPU:', capabilities.cpu.cores, 'cores');
console.log('CPU Model:', capabilities.cpu.model);
console.log('Architecture:', capabilities.cpu.architecture);

console.log('Memory:', capabilities.memory.total, 'bytes total');
console.log('Memory Available:', capabilities.memory.available, 'bytes');

console.log('GPU Available:', capabilities.gpu.available);
if (capabilities.gpu.available) {
  console.log('GPU Type:', capabilities.gpu.type); // 'nvidia', 'amd', 'apple', 'intel'
  console.log('GPU Name:', capabilities.gpu.name);
  console.log('VRAM:', capabilities.gpu.vram, 'bytes');
}

console.log('Recommendations:');
console.log('Max Model Size:', capabilities.recommendations.maxModelSize);
console.log('Recommended Quantization:', capabilities.recommendations.recommendedQuantization);
console.log('Recommended Threads:', capabilities.recommendations.threads);
console.log('GPU Layers:', capabilities.recommendations.gpuLayers);
```

**Caching**: Results are cached for 60 seconds. Subsequent calls within this window return cached data without re-detecting hardware.

**Force Refresh**: Pass `forceRefresh: true` to bypass cache and re-detect hardware: `await systemInfo.detect(true)`.

**Automatic Cache Clearing**: The cache is automatically cleared when servers start or stop (via `LlamaServerManager` and `DiffusionServerManager`). This ensures that subsequent memory checks reflect the actual available RAM after models are loaded or unloaded.

---

### getMemoryInfo()

Gets current memory usage information (not cached, real-time).

**Signature**:
```typescript
getMemoryInfo(): MemoryInfo
```

**Returns**: `MemoryInfo` - Current memory state

**Example**:
```typescript
const memory = systemInfo.getMemoryInfo();

console.log('Total RAM:', memory.total, 'bytes');
console.log('Available RAM:', memory.available, 'bytes');
console.log('Used RAM:', memory.used, 'bytes');

const usagePercent = (memory.used / memory.total) * 100;
console.log('Memory usage:', usagePercent.toFixed(1), '%');
```

**Use Case**: Real-time memory monitoring, especially when running multiple servers or during image generation. Unlike `detect()`, this method always returns fresh data.

---

### getGPUInfo()

Gets current GPU information (not cached, real-time).

**Signature**:
```typescript
getGPUInfo(): Promise<GPUInfo>
```

**Returns**: `Promise<GPUInfo>` - Current GPU state

**Example**:
```typescript
const gpu = await systemInfo.getGPUInfo();

if (gpu.available) {
  console.log('GPU Type:', gpu.type);
  console.log('GPU Name:', gpu.name);
  console.log('VRAM:', (gpu.vram / 1024 ** 3).toFixed(1), 'GB');

  if (gpu.vramAvailable !== undefined) {
    console.log('Available VRAM:', (gpu.vramAvailable / 1024 ** 3).toFixed(1), 'GB');
  }
}
```

**Use Case**: Real-time VRAM monitoring during active workloads like image generation. Unlike `detect()`, this method always queries the system for current GPU state, ensuring fresh VRAM availability data.

---

### canRunModel()

Checks if a specific model can run on the current system based on available or total memory.

**Signature**:
```typescript
canRunModel(
  modelInfo: ModelInfo,
  options?: { checkTotalMemory?: boolean; gpuLayers?: number; totalLayers?: number }
): Promise<{ possible: boolean; reason?: string; suggestion?: string }>
```

**Parameters**:
- `modelInfo: ModelInfo` - Model information to check
- `options?: { checkTotalMemory?: boolean }` - Optional configuration
  - `checkTotalMemory` - If `true`, checks against total system memory instead of currently available memory. Use this for servers that load models on-demand (e.g., diffusion server). Default: `false` (checks available memory)
  - `gpuLayers` - Number of GPU layers to use for VRAM calculation. If omitted, uses auto-detected value.
  - `totalLayers` - Total model layers (overrides GGUF metadata). If omitted, uses model metadata.

**Returns**: `Promise<{ possible: boolean; reason?: string; suggestion?: string }>` - Whether model can run, reason if not, and optional suggestion

**Memory Calculation**: Adds 20% overhead to model size for runtime requirements (model size × 1.2).

**When to Use Each Mode**:
- **Default (available memory)**: For servers that load the model at startup (e.g., LLM server). Ensures there's enough RAM right now.
- **Total memory mode**: For servers that load models on-demand (e.g., diffusion server). Validates the model will eventually fit, allowing ResourceOrchestrator to free up memory when needed.

**Example (Default - Check Available Memory)**:
```typescript
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const check = await systemInfo.canRunModel(modelInfo);

if (check.possible) {
  console.log('✅ Model can run on this system');
  await llamaServer.start({ modelId: modelInfo.id, port: 8080 });
} else {
  console.log('❌ Cannot run model:', check.reason);
  if (check.suggestion) {
    console.log('💡 Suggestion:', check.suggestion);
  }
  // Example: "Insufficient RAM: Model requires 8GB but only 4GB available"
}
```

**Example (Total Memory - For On-Demand Loading)**:
```typescript
const modelInfo = await modelManager.getModelInfo('sdxl-turbo');
const check = await systemInfo.canRunModel(modelInfo, { checkTotalMemory: true });

if (check.possible) {
  console.log('✅ Model will fit in system memory');
  // Server can start - ResourceOrchestrator will free memory when needed
  await diffusionServer.start({ modelId: modelInfo.id, port: 8081 });
} else {
  console.log('❌ Model too large for system:', check.reason);
  // Example: "Insufficient RAM: Model requires 8GB but only 4GB total"
}
```

---

### getOptimalConfig()

Generates optimal server configuration for a specific model based on system capabilities.

**Signature**:
```typescript
getOptimalConfig(
  modelInfo: ModelInfo,
  hints?: OptimalConfigHints  // fields you've already pinned (contextSize, gpuLayers,
                              // cacheTypeK/V, flashAttention, parallelRequests)
): Promise<Partial<LlamaServerConfig>>
```

**Parameters**:
- `modelInfo: ModelInfo` - Model to generate config for (GGUF metadata enables the adaptive sizing below)
- `hints?: OptimalConfigHints` - Fields the caller has already decided; they are respected verbatim and inform the sizing of the remaining ones (e.g. a pinned `contextSize` shapes the KV reserve used for GPU-layer packing; explicit cache types or `flashAttention: 'off'` suppress automatic KV quantization)

**Returns**: `Promise<Partial<LlamaServerConfig>>` - Partial server configuration (threads, gpuLayers, contextSize, and — when auto-selected — cacheTypeK/V + flashAttention) meant to be spread into a full `start()` call. Does not include `modelId` or `port`.

**Example**:
```typescript
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const config = await systemInfo.getOptimalConfig(modelInfo);

console.log('Optimal Configuration:');
console.log('Threads:', config.threads);
console.log('GPU Layers:', config.gpuLayers);
console.log('Context Size:', config.contextSize);
console.log('Parallel Requests:', config.parallelRequests);

// Use the config to start the server
// (port is optional now — omit it to default to 8080, or pass 'auto')
await llamaServer.start({
  modelId: modelInfo.id,
  ...config
});
```

**What it determines** (v0.7.0 adaptive sizing — requires GGUF metadata; models without it get the legacy behavior: fixed 4096 context, flat 2 GB KV reserve):
- **threads**: Based on CPU core count: 1-2 cores → all cores, 3-8 → cores - 1, 9-16 → cores - 2, 17+ → floor(cores × 0.85)
- **gpuLayers / cpuMoe**: **Full GPU offload is preferred** — if all weights fit in VRAM alongside at least a 4096-token KV cache (plus a ~1 GB compute buffer), every layer is offloaded. **For MoE models that don't fit whole**, the next tier is `cpuMoe: true`: expert weights (measured exactly from GGUF tensor offsets, stored as `expert_weights_bytes`) move to the RAM budget while the dense trunk + KV stay fully on GPU — recommended automatically when the trunk fits VRAM and the experts fit RAM (gated against 60% of **total** RAM — experts are mmap'd and sparsely activated, so they page through the OS cache rather than needing committed memory). Only after that are layers packed around a KV reserve (min 1.5 GB). Hints: `cpuMoe`/`nCpuMoe` (and `overrideTensors: 'exps=CPU'`, treated as `cpuMoe`) make the weights-split explicit; any other `-ot` pattern is sized conservatively as dense.
- **contextSize**: Computed from real KV-cache arithmetic (`layers × kvHeads × headDim × bytes-per-element`, GQA-aware via `attention.head_count_kv`): all VRAM left after weights becomes context budget, clamped to `[4096, model's context_length]` and floored to a progressive granularity (multiples of 512 up to 8K, 1024 up to 16K, 2048 up to 32K, 4096 beyond — always within ~6% of the budget). **There is no artificial ceiling** — a small model on a large GPU can get a very large context (and a correspondingly large KV allocation at server startup).
- **cacheTypeK / cacheTypeV / flashAttention**: **q8_0 KV quantization is auto-selected by default** (~2× cheaper KV, small quality loss) together with `flashAttention: 'on'`, *unless* f16 KV at the model's full native context fits alongside fully-offloaded weights (abundant headroom → stays f16, no fields emitted). Opt out by setting `cacheTypeK/V: 'f16'` explicitly or `flashAttention: 'off'`.
- **parallelRequests**: Always 1 (single-user Electron apps)

Use `estimateKVBytesPerToken(modelInfo, cacheTypeK?, cacheTypeV?)` (exported) to run the same KV arithmetic yourself.

---

### clearCache()

Clears the capabilities cache, forcing fresh hardware detection on the next `detect()` call.

**Signature**:
```typescript
clearCache(): void
```

**Example**:
```typescript
// After GPU driver update
systemInfo.clearCache();
const capabilities = await systemInfo.detect(); // Fresh detection
```

---

## Caching Behavior

**detect() Method**:
- Results cached for 60 seconds
- Subsequent calls return cached data (fast)
- Cache automatically cleared when:
  - `llamaServer.start()` is called
  - `diffusionServer.start()` is called
  - Server stops (automatic cleanup)

**Why caching?**
- Performance: Hardware detection can take 100-500ms
- Stability: Hardware doesn't change during app runtime
- Accuracy: Cache invalidation ensures memory reflects actual state

**Memory Checks Use Real-Time Data**:
The `canRunModel()` and `getOptimalConfig()` methods use real-time `getMemoryInfo()` for memory availability checks, ensuring accurate resource validation even when the capabilities cache is active. Static hardware info (CPU cores, GPU specs) is taken from the cache.

**Manual Cache Clearing**: For testing or when hardware changes (e.g., GPU driver updates), use `systemInfo.clearCache()` to force fresh detection on the next `detect()` call.

---

## Platform-Specific Detection

### macOS

**GPU Detection**: Uses `system_profiler SPDisplaysDataType` to detect Metal GPUs

**Features**:
- Automatic Metal support on 2016+ Macs
- Unified memory (GPU and CPU share RAM)
- Accurate VRAM detection

**Example output**:
```typescript
{
  gpu: {
    available: true,
    type: 'apple',
    name: 'Apple M1 Pro',
    vram: 12348030566, // ~11.5GB (estimated ~70% of 16GB unified RAM)
    metal: true
  }
}
```

**Note**: On Apple Silicon, VRAM is estimated as ~70% of total unified memory since GPU and CPU share the same RAM. The actual usable VRAM depends on current system memory pressure.

### Windows

**GPU Detection**: Uses `nvidia-smi` for NVIDIA GPUs

**Features**:
- NVIDIA CUDA support
- Dedicated VRAM detection
- Fallback to CPU if no GPU

**Example output**:
```typescript
{
  gpu: {
    available: true,
    type: 'nvidia',
    name: 'NVIDIA GeForce RTX 3060',
    vram: 12884901888, // 12GB
    cuda: true
  }
}
```

### Linux

**GPU Detection**: Multi-GPU support
- NVIDIA: `nvidia-smi`
- AMD: `rocm-smi` (experimental)
- Intel: `/sys/class/drm` device enumeration

**Features**:
- Most diverse platform support
- Multiple GPU vendors
- ROCm support (experimental)

**Example output (NVIDIA)**:
```typescript
{
  gpu: {
    available: true,
    type: 'nvidia',
    name: 'NVIDIA GeForce RTX 4090',
    vram: 25769803776, // 24GB
    cuda: true
  }
}
```

**Example output (AMD)**:
```typescript
{
  gpu: {
    available: true,
    type: 'amd',
    name: 'AMD Radeon RX 7900 XTX',
    vram: 25769803776, // 24GB
    rocm: true
  }
}
```

---

## Examples

### Complete System Check

```typescript
import { systemInfo } from 'genai-electron';

async function checkSystem() {
  const capabilities = await systemInfo.detect();

  console.log('System:', {
    cpu: `${capabilities.cpu.cores} cores (${capabilities.cpu.model})`,
    ram: `${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB total`,
    gpu: capabilities.gpu.available ? `${capabilities.gpu.name} (${(capabilities.gpu.vram / 1024 ** 3).toFixed(1)}GB VRAM)` : 'CPU-only'
  });

  console.log('Recommendations:', {
    maxModelSize: capabilities.recommendations.maxModelSize,
    quantization: capabilities.recommendations.recommendedQuantization.join(', '),
    threads: capabilities.recommendations.threads
  });
}
```

### Real-Time Memory Monitoring

```typescript
import { systemInfo } from 'genai-electron';

setInterval(() => {
  const memory = systemInfo.getMemoryInfo();
  const usedPercent = (memory.used / memory.total) * 100;

  console.log(`Memory: ${usedPercent.toFixed(1)}% used`);
  if (usedPercent > 90) console.warn('⚠️  High memory usage!');
}, 5000);
```

---

## What's Next?

- **[Model Management](model-management.md)** - Download and manage models compatible with your system
- **[LLM Server](llm-server.md)** - Use detected capabilities for auto-configuration
- **[TypeScript Reference](typescript-reference.md)** - Detailed type definitions for SystemCapabilities, CPUInfo, GPUInfo, etc.
