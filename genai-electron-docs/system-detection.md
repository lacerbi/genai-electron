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
  options?: { checkTotalMemory?: boolean }
): Promise<{ possible: boolean; reason?: string; suggestion?: string }>
```

**Parameters**:
- `modelInfo: ModelInfo` - Model information to check
- `options?: { checkTotalMemory?: boolean }` - Optional configuration
  - `checkTotalMemory` - If `true`, checks against total system memory instead of currently available memory. Use this for servers that load models on-demand (e.g., diffusion server). Default: `false` (checks available memory)

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
getOptimalConfig(modelInfo: ModelInfo): Promise<Partial<ServerConfig>>
```

**Parameters**:
- `modelInfo: ModelInfo` - Model to generate config for

**Returns**: `Promise<Partial<ServerConfig>>` - Partial server configuration (threads, gpuLayers, contextSize, etc.) meant to be spread into full `start()` call. Does not include `modelId` or `port`.

**Example**:
```typescript
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const config = await systemInfo.getOptimalConfig(modelInfo);

console.log('Optimal Configuration:');
console.log('Threads:', config.threads);
console.log('GPU Layers:', config.gpuLayers);
console.log('Context Size:', config.contextSize);
console.log('Parallel Requests:', config.parallelRequests);
console.log('Flash Attention:', config.flashAttention);

// Use the config to start the server
await llamaServer.start({
  modelId: modelInfo.id,
  port: 8080,
  ...config
});
```

**What it determines**:
- **threads**: Based on CPU core count (typically cores - 1 or cores / 2)
- **gpuLayers**: Maximum layers that fit in VRAM (if GPU available), or 0 for CPU-only
- **contextSize**: Appropriate context window based on model and available memory
  - **Calculation**: Subtracts model size + 2GB OS overhead from available RAM, then selects context size based on remaining memory (8GB→8K, 4GB→4K, 2GB→2K, else 1K)
- **parallelRequests**: Concurrent request slots based on available resources
- **flashAttention**: Whether flash attention should be enabled

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
    vram: 17179869184, // 16GB (unified with RAM)
    metal: true
  }
}
```

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
    cuda: true,
    vulkan: true
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
    rocm: true,
    vulkan: true
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
