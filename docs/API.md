# genai-electron API Reference

> **Version**: 0.2.0 (Phase 2.6 Complete - Async API & genai-lite Integration)
> **Status**: Production Ready

Complete API reference for genai-electron covering:
- **Phase 1**: LLM Support (SystemInfo, ModelManager, LlamaServerManager)
- **Phase 2**: Image Generation (DiffusionServerManager, ResourceOrchestrator)
- **Phase 2.5**: Async Image Generation API (GenerationRegistry, HTTP endpoints)
- **Phase 2.6**: genai-lite Integration & Best Practices

---

## Table of Contents

### Phase 1: LLM Support
1. [SystemInfo](#systeminfo)
2. [ModelManager](#modelmanager)
3. [LlamaServerManager](#llamaservermanager)

### Phase 2: Image Generation
4. [DiffusionServerManager](#diffusionservermanager)
5. [ResourceOrchestrator](#resourceorchestrator)
6. [GenerationRegistry](#generationregistry)
7. [HTTP API Endpoints](#http-api-endpoints)

### Reference
8. [Types and Interfaces](#types-and-interfaces)
9. [Error Classes](#error-classes)
10. [Utilities](#utilities)

---

## SystemInfo

The `SystemInfo` class provides system capability detection and intelligent configuration recommendations.

### Import

```typescript
import { systemInfo } from 'genai-electron';
// Or for advanced usage:
import { SystemInfo } from 'genai-electron';
const customSystemInfo = SystemInfo.getInstance();
```

### Methods

#### `detect(): Promise<SystemCapabilities>`

Detects all system capabilities including CPU, memory, and GPU. Results are cached for 60 seconds.

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

**Automatic Cache Clearing**: The cache is automatically cleared when servers start or stop (via `LlamaServerManager` and `DiffusionServerManager`). This ensures that subsequent memory checks reflect the actual available RAM after models are loaded or unloaded.

**Memory Checks Use Real-Time Data**: The `canRunModel()` and `getOptimalConfig()` methods use real-time `getMemoryInfo()` for memory availability checks, ensuring accurate resource validation even when the capabilities cache is active. Static hardware info (CPU cores, GPU specs) is taken from the cache.

---

#### `getMemoryInfo(): MemoryInfo`

Gets current memory usage information (not cached, real-time).

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

---

#### `canRunModel(modelInfo: ModelInfo, options?: { checkTotalMemory?: boolean }): Promise<{ possible: boolean; reason?: string; suggestion?: string }>`

Checks if a specific model can run on the current system based on available or total memory.

**Parameters**:
- `modelInfo: ModelInfo` - Model information to check
- `options?: { checkTotalMemory?: boolean }` - Optional configuration
  - `checkTotalMemory` - If `true`, checks against total system memory instead of currently available memory. Use this for servers that load models on-demand (e.g., diffusion server). Default: `false` (checks available memory)

**Returns**: `Promise<{ possible: boolean; reason?: string; suggestion?: string }>` - Whether model can run, reason if not, and optional suggestion

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

#### `getOptimalConfig(modelInfo: ModelInfo): Promise<Partial<ServerConfig>>`

Generates optimal server configuration for a specific model based on system capabilities.

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

---

## ModelManager

The `ModelManager` class handles model downloading, storage, and management.

### Import

```typescript
import { modelManager } from 'genai-electron';
// Or for advanced usage:
import { ModelManager } from 'genai-electron';
const customModelManager = ModelManager.getInstance();
```

### Methods

#### `listModels(type?: ModelType): Promise<ModelInfo[]>`

Lists all installed models, optionally filtered by type.

**Parameters**:
- `type?: ModelType` - Optional filter: `'llm'` or `'diffusion'`

**Returns**: `Promise<ModelInfo[]>` - Array of installed models

**Example**:
```typescript
// List all models
const allModels = await modelManager.listModels();
console.log('Total models:', allModels.length);

// List only LLM models
const llmModels = await modelManager.listModels('llm');
console.log('LLM models:', llmModels.length);

llmModels.forEach(model => {
  console.log('Model:', model.name);
  console.log('  ID:', model.id);
  console.log('  Size:', (model.size / 1024 / 1024 / 1024).toFixed(2), 'GB');
  console.log('  Type:', model.type);
  console.log('  Downloaded:', model.downloadedAt);
  console.log('  Source:', model.source.type);
});
```

---

#### `downloadModel(config: DownloadConfig): Promise<ModelInfo>`

Downloads a model from a URL or HuggingFace repository.

**Parameters**:
- `config: DownloadConfig` - Download configuration

**DownloadConfig Options**:
- **Direct URL**:
  - `source: 'url'`
  - `url: string` - Direct download URL
  - `name: string` - Display name for the model
  - `type: ModelType` - `'llm'` or `'diffusion'`
  - `checksum?: string` - Optional SHA256 checksum (format: `'sha256:...'`)
  - `onProgress?: (downloaded: number, total: number) => void` - Progress callback

- **HuggingFace**:
  - `source: 'huggingface'`
  - `repo: string` - Repository path (e.g., `'TheBloke/Llama-2-7B-GGUF'`)
  - `file: string` - File name (e.g., `'llama-2-7b.Q4_K_M.gguf'`)
  - `name: string` - Display name
  - `type: ModelType` - Model type
  - `checksum?: string` - Optional checksum
  - `onProgress?: (downloaded: number, total: number) => void` - Progress callback

**Returns**: `Promise<ModelInfo>` - Information about the downloaded model

**Example (Direct URL)**:
```typescript
const model = await modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/my-model.gguf',
  name: 'My Custom Model',
  type: 'llm',
  checksum: 'sha256:abc123...', // Recommended for integrity verification
  onProgress: (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(1);
    console.log(`Downloading: ${percent}% (${downloaded}/${total} bytes)`);
  }
});

console.log('Download complete!');
console.log('Model ID:', model.id);
console.log('Model path:', model.path);
```

**Example (HuggingFace)**:
```typescript
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'TheBloke/Llama-2-7B-GGUF',
  file: 'llama-2-7b.Q4_K_M.gguf',
  name: 'Llama 2 7B Q4',
  type: 'llm',
  onProgress: (downloaded, total) => {
    const mb = (downloaded / 1024 / 1024).toFixed(1);
    const totalMb = (total / 1024 / 1024).toFixed(1);
    console.log(`Progress: ${mb}MB / ${totalMb}MB`);
  }
});

console.log('Successfully downloaded:', model.name);
```

**Error Handling**:
```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
    // Network error, server error, etc.
  } else if (error instanceof InsufficientResourcesError) {
    console.error('Not enough disk space:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof ChecksumError) {
    console.error('File corrupted:', error.message);
  }
}
```

**GGUF Metadata Extraction**:

GGUF metadata is automatically extracted from the model file **before** downloading:
- ✅ **Pre-download validation** - Confirms file is a valid GGUF
- ✅ **Accurate information** - Layer count, context length, architecture
- ✅ **No guessing** - Real values from model file
- ✅ **Fast failure** - Fails immediately if not a valid GGUF (saves bandwidth)

The metadata is stored with the model and accessible via `model.ggufMetadata`.

---

#### `deleteModel(id: string): Promise<void>`

Deletes a model and its metadata.

**Parameters**:
- `id: string` - Model ID to delete

**Returns**: `Promise<void>`

**Example**:
```typescript
// List models first
const models = await modelManager.listModels();
console.log('Available models:');
models.forEach((m, i) => console.log(`${i + 1}. ${m.name} (${m.id})`));

// Delete a specific model
const modelToDelete = models[0];
await modelManager.deleteModel(modelToDelete.id);
console.log(`Deleted: ${modelToDelete.name}`);

// Verify deletion
const updated = await modelManager.listModels();
console.log('Remaining models:', updated.length);
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

#### `getModelInfo(id: string): Promise<ModelInfo>`

Gets detailed information about a specific model.

**Parameters**:
- `id: string` - Model ID

**Returns**: `Promise<ModelInfo>` - Model information

**Example**:
```typescript
const info = await modelManager.getModelInfo('llama-2-7b');

console.log('Model Information:');
console.log('Name:', info.name);
console.log('Type:', info.type);
console.log('Size:', (info.size / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('Path:', info.path);
console.log('Downloaded:', new Date(info.downloadedAt).toLocaleString());
console.log('Source:', info.source.type);
if (info.source.type === 'huggingface') {
  console.log('Repository:', info.source.repo);
  console.log('File:', info.source.file);
}
if (info.checksum) {
  console.log('Checksum:', info.checksum);
}
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

#### `verifyModel(id: string): Promise<boolean>`

Verifies model file integrity using stored checksum.

**Parameters**:
- `id: string` - Model ID to verify

**Returns**: `Promise<boolean>` - `true` if valid, `false` if checksum doesn't match

**Example**:
```typescript
const isValid = await modelManager.verifyModel('llama-2-7b');

if (isValid) {
  console.log('✅ Model file is valid');
} else {
  console.log('❌ Model file is corrupted or tampered with');
  console.log('Consider re-downloading the model');
}
```

**Note**: Only works if checksum was provided during download. Returns `false` if no checksum stored (cannot verify integrity without checksum).

**Throws**: `ModelNotFoundError` if model doesn't exist

---

#### `cancelDownload(): void`

Cancels any ongoing download operation.

**Example**:
```typescript
// Start download
const downloadPromise = modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/large-model.gguf',
  name: 'Large Model',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`Progress: ${((downloaded / total) * 100).toFixed(1)}%`);
  }
});

// Cancel after 5 seconds
setTimeout(() => {
  console.log('Cancelling download...');
  modelManager.cancelDownload();
}, 5000);

try {
  await downloadPromise;
} catch (error) {
  if (error instanceof DownloadError) {
    console.log('Download was cancelled');
  }
}
```

---

#### `updateModelMetadata(id: string, options?: { source?: MetadataFetchStrategy }): Promise<ModelInfo>`

Updates GGUF metadata for an existing model without re-downloading.

Useful for models downloaded before GGUF integration or to refresh metadata.

**Parameters**:
- `id: string` - Model ID
- `options?: { source?: MetadataFetchStrategy }` - Optional configuration
  - `source?: MetadataFetchStrategy` - Where to fetch metadata from (default: `'local-remote'`)
    - `'local-remote'` - Try local first, fallback to remote if local fails (default)
    - `'local-only'` - Read from local file only (fastest, offline-capable)
    - `'remote-only'` - Fetch from remote URL only (requires network)
    - `'remote-local'` - Try remote first, fallback to local if remote fails

**Returns**: `Promise<ModelInfo>` - Updated model information with GGUF metadata

**Example (Default - Local + Remote Fallback)**:
```typescript
// Update metadata from local file first, fallback to remote if needed (default)
const updated = await modelManager.updateModelMetadata('llama-2-7b');

console.log('Updated model information:');
console.log('Layer count:', updated.ggufMetadata?.block_count);
console.log('Context length:', updated.ggufMetadata?.context_length);
console.log('Architecture:', updated.ggufMetadata?.architecture);
```

**Example (Remote Only - Force Fresh from Source)**:
```typescript
// Force fetch from original URL (useful if local file suspected corrupted)
const fresh = await modelManager.updateModelMetadata('llama-2-7b', {
  source: 'remote-only'
});

console.log('Fresh metadata from source:', fresh.ggufMetadata?.block_count);
```

**Example (Local + Remote Fallback - Resilient)**:
```typescript
// Try local first (fast), fallback to remote if local fails
const resilient = await modelManager.updateModelMetadata('llama-2-7b', {
  source: 'local-remote'
});

console.log('Metadata (resilient fetch):', resilient.ggufMetadata);
```

**Example (Remote + Local Fallback)**:
```typescript
// Try remote first (authoritative), fallback to local if network fails
const authoritative = await modelManager.updateModelMetadata('llama-2-7b', {
  source: 'remote-local'
});

console.log('Metadata (authoritative fetch):', authoritative.ggufMetadata);
```

**Strategy Use Cases**:

| Strategy | Speed | Offline | Use When |
|----------|-------|---------|----------|
| `local-remote` (default) | Fast | ✅ Partial | Want speed + resilience (recommended) |
| `local-only` | Fastest | ✅ Yes | Certain local file is good |
| `remote-only` | Slowest | ❌ No | Verify against source, suspect local corruption |
| `remote-local` | Slow | ✅ Partial | Want authoritative + offline fallback |

**Throws**:
- `ModelNotFoundError` if model doesn't exist
- `DownloadError` if metadata fetch fails (strategy-dependent):
  - `local-only`: Throws if local file unreadable
  - `remote-only`: Throws if no URL or network fails
  - `local-remote`: Throws only if both fail
  - `remote-local`: Throws only if both fail

---

#### `getModelLayerCount(id: string): Promise<number>`

Gets the actual layer count for a model.

Uses GGUF metadata if available, falls back to estimation for older models.

**Parameters**:
- `id: string` - Model ID

**Returns**: `Promise<number>` - Layer count (actual or estimated)

**Example**:
```typescript
const layers = await modelManager.getModelLayerCount('llama-2-7b');
console.log(`Model has ${layers} layers`);

// Use for GPU offloading calculations
const gpuLayers = 24; // Want to offload 24 layers to GPU
const gpuRatio = gpuLayers / layers;
console.log(`Offloading ${(gpuRatio * 100).toFixed(1)}% to GPU`);

// Check if offloading request is valid
if (gpuLayers > layers) {
  console.warn(`Cannot offload ${gpuLayers} layers - model only has ${layers}`);
}
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

#### `getModelContextLength(id: string): Promise<number>`

Gets the actual context length for a model.

Uses GGUF metadata if available, falls back to default for older models.

**Parameters**:
- `id: string` - Model ID

**Returns**: `Promise<number>` - Context length in tokens

**Example**:
```typescript
const contextLen = await modelManager.getModelContextLength('llama-2-7b');
console.log(`Context window: ${contextLen} tokens`);

// Use for appropriate context size configuration
const config = {
  modelId: 'llama-2-7b',
  contextSize: Math.min(contextLen, 8192), // Don't exceed model's capacity
  port: 8080
};

await llamaServer.start(config);
console.log(`Started with context size: ${config.contextSize}`);
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

#### `getModelArchitecture(id: string): Promise<string>`

Gets the architecture type for a model.

Uses GGUF metadata if available, falls back to 'llama' for LLM models.

**Parameters**:
- `id: string` - Model ID

**Returns**: `Promise<string>` - Architecture type (e.g., 'llama', 'mamba', 'gpt2')

**Example**:
```typescript
const arch = await modelManager.getModelArchitecture('llama-2-7b');
console.log(`Architecture: ${arch}`);

// Verify architecture matches expected type
if (arch !== 'llama') {
  console.warn('⚠️  This model may not work with llama-server');
  console.warn(`Expected: llama, Got: ${arch}`);
} else {
  console.log('✅ Model architecture verified');
}

// Different architectures may require different server configurations
const serverConfig = arch === 'mamba'
  ? { /* Mamba-specific config */ }
  : { /* Llama-specific config */ };
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

## LlamaServerManager

The `LlamaServerManager` class manages the llama-server process lifecycle.

### Import

```typescript
import { llamaServer } from 'genai-electron';
// Or for advanced usage:
import { LlamaServerManager } from 'genai-electron';
const customServer = new LlamaServerManager();
```

### Methods

#### `start(config: LlamaServerConfig): Promise<ServerInfo>`

Starts the llama-server process with the specified configuration. Downloads binary automatically on first run.

**Parameters**:
- `config: LlamaServerConfig` - Server configuration

**LlamaServerConfig Options**:
- `modelId: string` - **Required** - Model ID to load
- `port: number` - **Required** - Port to listen on (typically 8080)
- `threads?: number` - Optional - CPU threads (auto-detected if not specified)
- `contextSize?: number` - Optional - Context window size (default: 4096)
- `gpuLayers?: number` - Optional - Layers to offload to GPU (auto-detected if not specified)
- `parallelRequests?: number` - Optional - Concurrent request slots (default: 4)
- `flashAttention?: boolean` - Optional - Enable flash attention (default: false)
- `forceValidation?: boolean` - Optional - Force re-validation of binary even if cached (default: false, see [Binary Validation Caching](#binary-validation-caching))

**Returns**: `Promise<ServerInfo>` - Server information

**Example (Auto-configuration)**:
```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080
  // threads, gpuLayers, contextSize auto-detected
});

console.log('Server started with optimal settings');
```

**Example (Custom configuration)**:
```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  threads: 8,              // Use 8 CPU threads
  gpuLayers: 35,           // Offload 35 layers to GPU
  contextSize: 8192,       // 8K context window
  parallelRequests: 8,     // Handle 8 concurrent requests
  flashAttention: true     // Enable flash attention
});

console.log('Server started with custom settings');
```

**Example (Using SystemInfo for optimal config)**:
```typescript
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const optimalConfig = await systemInfo.getOptimalConfig(modelInfo);

await llamaServer.start({
  modelId: modelInfo.id,
  port: 8080,
  ...optimalConfig
});
```

**Throws**:
- `ModelNotFoundError` - Model doesn't exist
- `ServerError` - Server failed to start
- `PortInUseError` - Port already in use
- `InsufficientResourcesError` - Not enough RAM/VRAM
- `BinaryError` - Binary download or execution failed (all variants failed)

**Binary Download and Variant Testing**:

On first call to `start()`, the library automatically:
1. **Downloads** appropriate binary if not present (~50-100MB)
2. **Tests variants** in priority order: CUDA → Vulkan → CPU
3. **Runs real functionality test**:
   - Generates 1 token with GPU layers enabled (`-ngl 1`)
   - Verifies CUDA actually works (not just that binary loads)
   - Parses output for GPU errors ("CUDA error", "failed to allocate", etc.)
4. **Falls back automatically** if test fails:
   - Example: Broken CUDA → tries Vulkan → CPU
   - Logs warnings but continues with working variant
5. **Caches working variant and validation results** for fast subsequent starts

**Note**: Real functionality testing only runs if model is downloaded. If model doesn't exist yet, falls back to basic `--version` test. This means optimal variant selection happens automatically when you call `start()` with a valid model.

**Binary Validation Caching**:

After the first successful validation, subsequent calls to `start()` skip the expensive validation tests (Phase 1 & Phase 2) and only verify binary integrity via checksum (~0.5s instead of 2-10s):

- ✅ **First start**: Downloads binary → Runs Phase 1 & 2 tests → Saves validation cache
- ✅ **Subsequent starts**: Verifies checksum → Uses cached validation (fast startup)
- ✅ **Modified binary**: Checksum mismatch → Re-runs full validation
- ✅ **Force validation**: Use `forceValidation: true` to re-run tests (e.g., after driver updates)

**Example (Force Validation)**:
```typescript
// After updating GPU drivers
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true  // Re-run Phase 1 & 2 tests
});
```

---

#### `stop(): Promise<void>`

Stops the llama-server process gracefully.

**Returns**: `Promise<void>`

**Example**:
```typescript
console.log('Stopping server...');
await llamaServer.stop();
console.log('Server stopped');

// Verify status
const status = llamaServer.getStatus();
console.log('Status:', status.status); // 'stopped'
```

**Behavior**:
1. Sends SIGTERM to process (graceful shutdown)
2. Waits up to 10 seconds for process to exit
3. Sends SIGKILL if still running (force kill)
4. Cleans up resources

---

#### `restart(): Promise<ServerInfo>`

Restarts the server with the same configuration.

**Returns**: `Promise<ServerInfo>` - Server information after restart

**Example**:
```typescript
console.log('Restarting server...');
const info = await llamaServer.restart();
console.log('Server restarted on port', info.port);
console.log('PID:', info.pid);
```

**Equivalent to**:
```typescript
await llamaServer.stop();
await llamaServer.start(previousConfig);
```

---

#### `getStatus(): ServerStatus`

Gets current server status as a simple string (synchronous).

**Returns**: `ServerStatus` - Current server state: `'stopped'`, `'starting'`, `'running'`, `'stopping'`, or `'crashed'`

**Example**:
```typescript
const status = llamaServer.getStatus();
console.log('Server Status:', status);
// Possible values: 'stopped', 'starting', 'running', 'stopping', 'crashed'

if (status === 'running') {
  console.log('✅ Server is running');
} else if (status === 'crashed') {
  console.error('❌ Server has crashed');
}
```

---

#### `getInfo(): ServerInfo`

Gets detailed server information including status, health, PID, and more (synchronous).

**Returns**: `ServerInfo` - Complete server state

**Example**:
```typescript
const info = llamaServer.getInfo();

console.log('Server Status:', info.status);
// Possible values: 'stopped', 'starting', 'running', 'stopping', 'crashed'

console.log('Health:', info.health);
// Possible values: 'ok', 'loading', 'error', 'unknown'

if (info.pid) {
  console.log('Process ID:', info.pid);
}

console.log('Port:', info.port);
console.log('Model ID:', info.modelId);

if (info.startedAt) {
  const uptime = Date.now() - new Date(info.startedAt).getTime();
  console.log('Uptime:', Math.floor(uptime / 1000), 'seconds');
}
```

---

#### `isHealthy(): Promise<boolean>`

Checks if the server is responding to health checks (asynchronous).

**Returns**: `Promise<boolean>` - `true` if server is healthy, `false` otherwise

**Example**:
```typescript
const healthy = await llamaServer.isHealthy();

if (healthy) {
  console.log('✅ Server is healthy and ready to accept requests');
} else {
  console.log('❌ Server is not responding');
  const info = llamaServer.getInfo();
  console.log('Status:', info.status);
  console.log('Health:', info.health);
}
```

**Use Case**:
```typescript
// Wait for server to be ready
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Poll until healthy
let retries = 0;
while (!(await llamaServer.isHealthy()) && retries < 10) {
  console.log('Waiting for server to be ready...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  retries++;
}

if (await llamaServer.isHealthy()) {
  console.log('Server is ready!');
} else {
  console.error('Server failed to become healthy');
}
```

---

#### `getLogs(lines?: number): Promise<string[]>`

Gets recent server logs.

**Parameters**:
- `lines?: number` - Optional - Number of lines to retrieve (default: 100)

**Returns**: `Promise<string[]>` - Array of recent log entries

**Example**:
```typescript
// Get last 100 lines (default)
const logs = await llamaServer.getLogs();
console.log('Recent logs:');
logs.forEach(line => console.log(line));

// Get last 50 lines
const recentLogs = await llamaServer.getLogs(50);
console.log(`Last ${recentLogs.length} lines`);

// Get all logs
const allLogs = await llamaServer.getLogs(Infinity);
console.log(`Total log entries: ${allLogs.length}`);
```

**Log Format**:
```
[2025-10-16T10:30:00.000Z] [info] llama-server starting...
[2025-10-16T10:30:01.234Z] [info] Model loaded: llama-2-7b
[2025-10-16T10:30:01.500Z] [info] Server listening on port 8080
[2025-10-16T10:30:05.123Z] [info] Request completed in 234ms
```

---

### Events

The `LlamaServerManager` extends `EventEmitter` and emits lifecycle events.

#### `'started'`

Emitted when server starts successfully.

```typescript
llamaServer.on('started', () => {
  console.log('Server started!');
});
```

#### `'stopped'`

Emitted when server stops.

```typescript
llamaServer.on('stopped', () => {
  console.log('Server stopped');
});
```

#### `'crashed'`

Emitted when server crashes unexpectedly.

```typescript
llamaServer.on('crashed', (error: Error) => {
  console.error('Server crashed:', error.message);
  // Auto-restart in Phase 4
});
```

#### `'binary-log'`

Emitted during binary download and variant testing.

```typescript
llamaServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
  console.log(`[${data.level.toUpperCase()}] ${data.message}`);
});
```

**Example (Complete Event Handling)**:
```typescript
llamaServer.on('started', () => {
  console.log('✅ Server started successfully');
});

llamaServer.on('stopped', () => {
  console.log('🛑 Server stopped');
});

llamaServer.on('crashed', (error) => {
  console.error('💥 Server crashed:', error.message);
  console.error('Stack:', error.stack);

  // Could implement custom restart logic
  console.log('Attempting restart in 5 seconds...');
  setTimeout(async () => {
    try {
      await llamaServer.restart();
      console.log('✅ Server restarted successfully');
    } catch (restartError) {
      console.error('❌ Failed to restart:', restartError);
    }
  }, 5000);
});

// Start server
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## DiffusionServerManager

The `DiffusionServerManager` class manages the diffusion HTTP wrapper server for local image generation using stable-diffusion.cpp.

**Architecture Note**: Unlike llama-server (which is a native HTTP server), stable-diffusion.cpp is a one-shot executable. DiffusionServerManager creates an HTTP wrapper server that spawns stable-diffusion.cpp on-demand for each image generation request. Resource orchestration (automatic LLM offload/reload) works for both the Node.js API and HTTP endpoints.

### Import

```typescript
import { diffusionServer } from 'genai-electron';
// Or for advanced usage:
import { DiffusionServerManager } from 'genai-electron';
const customServer = new DiffusionServerManager();
```

### Methods

#### `start(config: DiffusionServerConfig): Promise<DiffusionServerInfo>`

Starts the diffusion HTTP wrapper server. Downloads binary automatically on first run.

**Parameters**:
- `config: DiffusionServerConfig` - Server configuration

**DiffusionServerConfig Options**:
- `modelId: string` - **Required** - Diffusion model ID to load
- `port?: number` - Optional - Port to listen on (default: 8081)
- `threads?: number` - Optional - CPU threads (auto-detected if not specified)
- `gpuLayers?: number` - Optional - Layers to offload to GPU (auto-detected if not specified, 0 = CPU-only)
- `vramBudget?: number` - Optional - VRAM budget in MB ⚠️ **Phase 3**: This option is planned but not yet implemented. Currently ignored.
- `forceValidation?: boolean` - Optional - Force re-validation of binary even if cached (default: false)

**Returns**: `Promise<DiffusionServerInfo>` - Server information

**Example (Auto-configuration)**:
```typescript
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081
  // threads, gpuLayers auto-detected
});

console.log('Diffusion server started with optimal settings');
```

**Example (Custom configuration)**:
```typescript
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081,
  threads: 8,        // Use 8 CPU threads
  gpuLayers: 35,     // Offload 35 layers to GPU
  vramBudget: 6144   // Limit VRAM usage to 6GB
});

console.log('Diffusion server started with custom settings');
```

**Throws**:
- `ModelNotFoundError` - Model doesn't exist or is not a diffusion model
- `ServerError` - Server failed to start
- `PortInUseError` - Port already in use
- `InsufficientResourcesError` - Not enough RAM/VRAM
- `BinaryError` - Binary download or execution failed (all variants failed)

**Binary Download and Variant Testing**:

On first call to `start()`, the library automatically:
1. **Downloads** appropriate binary if not present (~50-100MB)
2. **Tests variants** in priority order: CUDA → Vulkan → CPU
3. **Runs real functionality test**:
   - Generates tiny 64x64 image with 1 diffusion step
   - Verifies CUDA/GPU acceleration actually works
   - Parses output for GPU errors ("CUDA error", "Vulkan error", etc.)
4. **Falls back automatically** if test fails:
   - Example: Broken CUDA → tries Vulkan → CPU
   - Logs warnings but continues with working variant
5. **Caches working variant** for fast subsequent starts

**Note**: Real functionality testing only runs if model is downloaded. If model doesn't exist yet, falls back to basic `--help` test. This means optimal variant selection happens automatically when you call `start()` with a valid model.

---

#### `stop(): Promise<void>`

Stops the diffusion HTTP wrapper server gracefully.

**Returns**: `Promise<void>`

**Example**:
```typescript
console.log('Stopping diffusion server...');
await diffusionServer.stop();
console.log('Diffusion server stopped');

// Verify status
const status = diffusionServer.getStatus();
console.log('Status:', status.status); // 'stopped'
```

**Behavior**:
1. Cancels any ongoing image generation
2. Closes HTTP server
3. Cleans up resources

---

#### `generateImage(config: ImageGenerationConfig): Promise<ImageGenerationResult>`

Generates an image by spawning stable-diffusion.cpp executable.

**Automatic Resource Management**: When using the singleton `diffusionServer`, this method automatically manages system resources. If RAM or VRAM is constrained while both the LLM and diffusion servers are running:
1. Temporarily stops the LLM server (saves configuration)
2. Generates the image
3. Automatically restarts the LLM server with the same configuration

This happens transparently without any additional code. The orchestration uses a 75% resource availability threshold to determine if offloading is needed.

**Parameters**:
- `config: ImageGenerationConfig` - Image generation configuration

**ImageGenerationConfig Options**:
- `prompt: string` - **Required** - Text prompt describing the image
- `negativePrompt?: string` - Optional - What to avoid in the image
- `width?: number` - Optional - Image width in pixels (default: 512)
- `height?: number` - Optional - Image height in pixels (default: 512)
- `steps?: number` - Optional - Number of inference steps (default: 20, more = better quality but slower)
- `cfgScale?: number` - Optional - Guidance scale (default: 7.5, higher = closer to prompt)
- `seed?: number` - Optional - Random seed for reproducibility (undefined or negative = random, actual seed returned in result)
- `sampler?: ImageSampler` - Optional - Sampler algorithm (default: 'euler_a')
- `count?: number` - Optional - Number of images to generate (1-5, default: 1). Seeds are automatically incremented for each image.
- `onProgress?: (currentStep: number, totalSteps: number, stage: ImageGenerationStage, percentage?: number) => void` - Optional - Progress callback with stage information

**Returns**: `Promise<ImageGenerationResult>` - Generated image data (single image). For batch generation (count > 1), use the HTTP API which returns multiple images.

**Example (Basic)**:
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape at sunset, 4k, detailed',
  width: 1024,
  height: 1024,
  steps: 30
});

console.log('Image generated in', result.timeTaken, 'ms');
console.log('Image size:', result.width, 'x', result.height);

// Save image
import { promises as fs } from 'fs';
await fs.writeFile('output.png', result.image);
```

**Example (Advanced with progress tracking)**:
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A futuristic city with flying cars, cyberpunk style',
  negativePrompt: 'blurry, low quality, distorted, ugly',
  width: 1024,
  height: 1024,
  steps: 50,
  cfgScale: 8.0,
  seed: 42,  // For reproducibility
  sampler: 'dpm++2m',
  onProgress: (currentStep, totalSteps, stage, percentage) => {
    if (stage === 'loading') {
      console.log(`Loading model... ${Math.round(percentage || 0)}%`);
    } else if (stage === 'diffusion') {
      console.log(`Generating (step ${currentStep}/${totalSteps}): ${Math.round(percentage || 0)}%`);
    } else {
      console.log(`Decoding: ${Math.round(percentage || 0)}%`);
    }
  }
});

console.log('Generated with seed:', result.seed);
console.log('Format:', result.format); // 'png'
await fs.writeFile('cyberpunk-city.png', result.image);
```

**Example (Batch Generation via HTTP API)**:
```typescript
// Note: Batch generation (count > 1) is only available via HTTP API
// The Node.js API (generateImage) returns a single ImageGenerationResult

// Use HTTP endpoints for batch generation:
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'A serene mountain landscape',
    width: 1024,
    height: 1024,
    steps: 30,
    count: 3  // Generate 3 variations
  })
});

const { id } = await response.json();

// Poll for results (see HTTP API Endpoints section for complete polling example)
// Result will contain an array of 3 images with automatically incremented seeds
```

**Throws**:
- `ServerError` - Server not running, already generating an image, or generation failed

**Important Notes**:
- Only one generation can run at a time. If called while busy, throws `ServerError`.
- Model validation occurs during `start()`.
- **Automatic Resource Orchestration**: The singleton `diffusionServer` is initialized with `llamaServer`, enabling automatic LLM offload/reload when resources are constrained. This happens transparently - you don't need to manually use `ResourceOrchestrator`.
- **Batch Orchestration Limitation**: When generating multiple images (count > 1 via HTTP API), automatic orchestration is bypassed. This is planned for Phase 3.

---

#### `getStatus(): ServerStatus`

Gets current server status as a simple string (synchronous).

**Returns**: `ServerStatus` - Current server state: `'stopped'`, `'starting'`, `'running'`, `'stopping'`, or `'crashed'`

**Example**:
```typescript
const status = diffusionServer.getStatus();
console.log('Server Status:', status);
// Possible values: 'stopped', 'starting', 'running', 'stopping', 'crashed'

if (status === 'running') {
  console.log('✅ Diffusion server is running');
} else if (status === 'crashed') {
  console.error('❌ Diffusion server has crashed');
}
```

---

#### `getInfo(): DiffusionServerInfo`

Gets detailed server information including status, health, busy state, PID, and more (synchronous).

**Returns**: `DiffusionServerInfo` - Complete server state

**Example**:
```typescript
const info = diffusionServer.getInfo();

console.log('Server Status:', info.status);
// Possible values: 'stopped', 'starting', 'running', 'stopping', 'crashed'

console.log('Health:', info.health);
// Possible values: 'ok', 'loading', 'error', 'unknown'

console.log('Busy:', info.busy);
// true if currently generating an image

if (info.pid) {
  console.log('HTTP wrapper PID:', info.pid);
}

console.log('Port:', info.port);
console.log('Model ID:', info.modelId);

if (info.startedAt) {
  const uptime = Date.now() - new Date(info.startedAt).getTime();
  console.log('Uptime:', Math.floor(uptime / 1000), 'seconds');
}
```

---

#### `isHealthy(): Promise<boolean>`

Checks if the HTTP wrapper server is responding (asynchronous).

**Returns**: `Promise<boolean>` - `true` if server is healthy, `false` otherwise

**Example**:
```typescript
const healthy = await diffusionServer.isHealthy();

if (healthy) {
  console.log('✅ Diffusion server is healthy and ready');
} else {
  console.log('❌ Diffusion server is not responding');
}
```

---

#### `getLogs(lines?: number): Promise<string[]>`

Gets recent server logs.

**Parameters**:
- `lines?: number` - Optional - Number of lines to retrieve (default: 100)

**Returns**: `Promise<string[]>` - Array of recent log entries

**Example**:
```typescript
// Get last 100 lines (default)
const logs = await diffusionServer.getLogs();
console.log('Recent logs:');
logs.forEach(line => console.log(line));

// Get last 50 lines
const recentLogs = await diffusionServer.getLogs(50);

// Get all logs
const allLogs = await diffusionServer.getLogs(Infinity);
```

---

#### `clearLogs(): Promise<void>`

Clears all server logs.

**Returns**: `Promise<void>`

**Example**:
```typescript
await diffusionServer.clearLogs();
console.log('Logs cleared');
```

---

### Events

The `DiffusionServerManager` extends `EventEmitter` and emits lifecycle events.

#### `'started'`

Emitted when HTTP wrapper server starts successfully.

```typescript
diffusionServer.on('started', (info: DiffusionServerInfo) => {
  console.log('Diffusion server started on port', info.port);
});
```

#### `'stopped'`

Emitted when server stops.

```typescript
diffusionServer.on('stopped', () => {
  console.log('Diffusion server stopped');
});
```

#### `'crashed'`

Emitted when server crashes unexpectedly.

```typescript
diffusionServer.on('crashed', (error: Error) => {
  console.error('Diffusion server crashed:', error.message);
});
```

#### `'binary-log'`

Emitted during binary download and variant testing.

```typescript
diffusionServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
  console.log(`[${data.level.toUpperCase()}] ${data.message}`);
});
```

**Example (Complete Event Handling)**:
```typescript
diffusionServer.on('started', (info) => {
  console.log('✅ Diffusion server started on port', info.port);
});

diffusionServer.on('stopped', () => {
  console.log('🛑 Diffusion server stopped');
});

diffusionServer.on('crashed', (error) => {
  console.error('💥 Diffusion server crashed:', error.message);

  // Implement custom restart logic
  console.log('Attempting restart in 5 seconds...');
  setTimeout(async () => {
    try {
      await diffusionServer.start({
        modelId: 'sdxl-turbo',
        port: 8081
      });
      console.log('✅ Server restarted successfully');
    } catch (restartError) {
      console.error('❌ Failed to restart:', restartError);
    }
  }, 5000);
});

// Start server
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });
```

---

## ResourceOrchestrator

The `ResourceOrchestrator` class provides automatic resource management between LLM and image generation servers. When system resources are constrained (limited RAM or VRAM), it automatically offloads the LLM server before generating images, then reloads it afterward.

**Note**: When using the singleton `diffusionServer`, resource orchestration happens automatically inside `generateImage()`. The ResourceOrchestrator is used internally and you typically don't need to interact with it directly. This class is primarily for advanced use cases where you need custom orchestrator instances or want to check resource status programmatically.

### Import

```typescript
import { ResourceOrchestrator } from 'genai-electron';
import { systemInfo, llamaServer, diffusionServer, modelManager } from 'genai-electron';

// Create orchestrator instance
const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);
```

### Constructor

```typescript
new ResourceOrchestrator(
  systemInfo?: SystemInfo,
  llamaServer: LlamaServerManager,
  diffusionServer: DiffusionServerManager,
  modelManager?: ModelManager
)
```

**Parameters**:
- `systemInfo?: SystemInfo` - Optional - System information instance (defaults to singleton)
- `llamaServer: LlamaServerManager` - **Required** - LLM server manager instance
- `diffusionServer: DiffusionServerManager` - **Required** - Diffusion server manager instance
- `modelManager?: ModelManager` - Optional - Model manager instance (defaults to singleton)

---

### Methods

#### `orchestrateImageGeneration(config: ImageGenerationConfig): Promise<ImageGenerationResult>`

Generates an image with automatic resource management. If system resources are constrained, automatically offloads the LLM server before generation and reloads it afterward.

**Parameters**:
- `config: ImageGenerationConfig` - Image generation configuration (same as `DiffusionServerManager.generateImage()`)

**Returns**: `Promise<ImageGenerationResult>` - Generated image data

**Example (Basic Usage)**:
```typescript
import { ResourceOrchestrator } from 'genai-electron';
import { systemInfo, llamaServer, diffusionServer, modelManager } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// LLM server is running and using 6GB VRAM
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Start diffusion server
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });

// Generate image - automatically manages resources
// If not enough VRAM:
//   1. Saves LLM state
//   2. Stops LLM server (frees 6GB VRAM)
//   3. Generates image
//   4. Restarts LLM server with saved config
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A beautiful sunset over mountains',
  width: 1024,
  height: 1024,
  steps: 30
});

console.log('Image generated successfully');
// LLM server is running again with original configuration
```

**Example (With Progress Tracking)**:
```typescript
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A futuristic city at night',
  negativePrompt: 'blurry, low quality',
  width: 1024,
  height: 1024,
  steps: 50,
  onProgress: (currentStep, totalSteps, stage, percentage) => {
    if (stage === 'loading') {
      console.log(`Loading: ${Math.round(percentage || 0)}%`);
    } else if (stage === 'diffusion') {
      console.log(`Step ${currentStep}/${totalSteps}: ${Math.round(percentage || 0)}%`);
    } else {
      console.log(`Decoding: ${Math.round(percentage || 0)}%`);
    }
  }
});

await fs.promises.writeFile('city.png', result.image);
```

**Behavior**:
- **Ample resources**: Generates directly without offloading LLM
- **Constrained resources**: Automatically offloads LLM, generates image, reloads LLM
- **Resource detection**: Determines bottleneck (RAM vs VRAM) automatically
- **Threshold**: Uses 75% of available resource as threshold for offload decision

**Throws**: Same exceptions as `DiffusionServerManager.generateImage()`

---

#### `wouldNeedOffload(): Promise<boolean>`

Checks if generating an image would require offloading the LLM server.

**Returns**: `Promise<boolean>` - `true` if offload would be needed, `false` otherwise

**Example**:
```typescript
const needsOffload = await orchestrator.wouldNeedOffload();

if (needsOffload) {
  console.log('⚠️  Image generation will temporarily stop the LLM server');
  console.log('The LLM will be automatically reloaded after generation');
} else {
  console.log('✅ Enough resources - both servers can run simultaneously');
}

// Proceed with generation
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape painting',
  steps: 30
});
```

**Use Cases**:
- Warn users about temporary LLM unavailability
- Decide whether to defer image generation
- Display resource status in UI

---

#### `getSavedState(): SavedLLMState | undefined`

Gets the saved LLM state if the server was offloaded.

**Returns**: `SavedLLMState | undefined` - Saved state or undefined if no state saved

**SavedLLMState Interface**:
```typescript
interface SavedLLMState {
  config: ServerConfig;   // Original LLM configuration
  wasRunning: boolean;    // Whether LLM was running before offload
  savedAt: Date;          // When state was saved
}
```

**Example**:
```typescript
// Check if LLM was offloaded
const savedState = orchestrator.getSavedState();

if (savedState) {
  console.log('LLM was offloaded at:', savedState.savedAt);
  console.log('Original model:', savedState.config.modelId);
  console.log('Original port:', savedState.config.port);
  console.log('GPU layers:', savedState.config.gpuLayers);
  console.log('Was running:', savedState.wasRunning);
} else {
  console.log('No LLM state saved (not offloaded)');
}
```

---

#### `clearSavedState(): void`

Clears any saved LLM state. Use this if you don't want the LLM to be automatically reloaded.

**Returns**: `void`

**Example**:
```typescript
// Generate image with offload
await orchestrator.orchestrateImageGeneration({
  prompt: 'A mountain landscape',
  steps: 30
});

// Prevent automatic LLM reload for next generation
orchestrator.clearSavedState();

// Next generation won't reload LLM
await orchestrator.orchestrateImageGeneration({
  prompt: 'A city skyline',
  steps: 30
});
```

---

### Resource Estimation

The `ResourceOrchestrator` automatically estimates resource usage and determines the bottleneck:

**Bottleneck Detection**:
- **GPU Systems**: Uses VRAM as bottleneck if GPU is available
- **CPU-Only Systems**: Uses RAM as bottleneck

**Estimation Formulas**:
- **LLM Usage**:
  - GPU mode: `VRAM = model_size * (gpu_layers / total_layers) * 1.2`
  - CPU mode: `RAM = model_size * 1.2`
- **Diffusion Usage**: `RAM/VRAM = model_size * 1.2`

**Offload Decision**:
- Combined usage > 75% of available resource → Offload needed
- Combined usage ≤ 75% of available resource → No offload needed

**Example Scenarios**:

1. **GPU System with 8GB VRAM**:
   - LLM using 6GB VRAM (75%)
   - Diffusion needs 5GB VRAM
   - Combined: 11GB > 8GB * 0.75 (6GB) → **Offload needed** ✅

2. **GPU System with 24GB VRAM**:
   - LLM using 6GB VRAM (25%)
   - Diffusion needs 5GB VRAM
   - Combined: 11GB < 24GB * 0.75 (18GB) → **No offload** ✅

3. **CPU-Only System with 16GB RAM**:
   - LLM using 8GB RAM (50%)
   - Diffusion needs 6GB RAM
   - Combined: 14GB > 16GB * 0.75 (12GB) → **Offload needed** ✅

---

## GenerationRegistry

The `GenerationRegistry` class manages in-memory state for async image generation operations. It provides create/read/update/delete operations and automatic cleanup of old results.

**Note**: This class is primarily for internal use by `DiffusionServerManager`. It's exported for advanced use cases where you need custom generation tracking or want to build your own HTTP API.

### Import

```typescript
import { GenerationRegistry } from 'genai-electron';
```

### Constructor

```typescript
new GenerationRegistry(config?: GenerationRegistryConfig)
```

**GenerationRegistryConfig Options**:
- `maxResultAgeMs?: number` - Maximum age (in ms) for completed generations before cleanup (default: 5 minutes / 300000ms)
- `cleanupIntervalMs?: number` - Interval (in ms) between cleanup runs (default: 1 minute / 60000ms)

**Example**:
```typescript
import { GenerationRegistry } from 'genai-electron';

// Create registry with custom TTL
const registry = new GenerationRegistry({
  maxResultAgeMs: 10 * 60 * 1000,  // 10 minutes
  cleanupIntervalMs: 2 * 60 * 1000  // 2 minutes
});
```

---

### Methods

#### `create(config: ImageGenerationConfig): string`

Create a new generation entry with 'pending' status.

**Parameters**:
- `config: ImageGenerationConfig` - Image generation configuration

**Returns**: `string` - Unique generation ID

**Example**:
```typescript
const id = registry.create({
  prompt: 'A serene mountain landscape',
  width: 1024,
  height: 1024,
  steps: 30
});

console.log('Generation ID:', id); // e.g., "abc123def456"
```

---

#### `get(id: string): GenerationState | null`

Get a generation by ID.

**Parameters**:
- `id: string` - Generation ID

**Returns**: `GenerationState | null` - Generation state or null if not found

**Example**:
```typescript
const state = registry.get('abc123def456');

if (state) {
  console.log('Status:', state.status);
  console.log('Created:', new Date(state.createdAt));

  if (state.status === 'in_progress' && state.progress) {
    console.log('Progress:', state.progress.percentage, '%');
  }

  if (state.status === 'complete' && state.result) {
    console.log('Images:', state.result.images.length);
  }
}
```

---

#### `update(id: string, updates: Partial<GenerationState>): void`

Update a generation's state. Automatically updates `updatedAt` timestamp.

**Parameters**:
- `id: string` - Generation ID
- `updates: Partial<GenerationState>` - Partial state updates

**Example**:
```typescript
// Update to in_progress
registry.update('abc123', {
  status: 'in_progress',
  progress: {
    currentStep: 5,
    totalSteps: 30,
    stage: 'diffusion',
    percentage: 25
  }
});

// Update to complete
registry.update('abc123', {
  status: 'complete',
  result: {
    images: [{
      image: base64String,
      seed: 42,
      width: 1024,
      height: 1024
    }],
    format: 'png',
    timeTaken: 15000
  }
});

// Update to error
registry.update('abc123', {
  status: 'error',
  error: {
    message: 'Generation failed',
    code: 'BACKEND_ERROR'
  }
});
```

---

#### `delete(id: string): void`

Delete a generation from the registry.

**Parameters**:
- `id: string` - Generation ID

**Example**:
```typescript
registry.delete('abc123');
```

---

#### `getAllIds(): string[]`

Get all generation IDs currently in the registry.

**Returns**: `string[]` - Array of generation IDs

**Example**:
```typescript
const ids = registry.getAllIds();
console.log('Active generations:', ids.length);
ids.forEach(id => {
  const state = registry.get(id);
  console.log(`${id}: ${state?.status}`);
});
```

---

#### `size(): number`

Get count of stored generations.

**Returns**: `number` - Number of generations in registry

**Example**:
```typescript
console.log('Registry size:', registry.size());
```

---

#### `cleanup(maxAgeMs: number): number`

Clean up old completed or errored generations older than specified age.

**Parameters**:
- `maxAgeMs: number` - Maximum age in milliseconds for terminal states

**Returns**: `number` - Number of generations cleaned up

**Example**:
```typescript
// Manual cleanup - remove results older than 5 minutes
const cleaned = registry.cleanup(5 * 60 * 1000);
console.log('Cleaned up', cleaned, 'old generations');
```

**Note**: Automatic cleanup runs at intervals specified in constructor. Only terminal states (complete/error) are cleaned up; pending and in_progress generations are never auto-removed.

---

#### `clear(): void`

Clear all generations from the registry. Useful for testing or manual reset.

**Example**:
```typescript
registry.clear();
console.log('Registry cleared, size:', registry.size()); // 0
```

---

#### `destroy(): void`

Stop the automatic cleanup interval. Call this when you're done with the registry.

**Example**:
```typescript
// When shutting down
registry.destroy();
```

---

### Complete Example: Custom Generation Tracking

```typescript
import { GenerationRegistry } from 'genai-electron';
import type { ImageGenerationConfig } from 'genai-electron';

// Create registry with 10 minute TTL
const registry = new GenerationRegistry({
  maxResultAgeMs: 10 * 60 * 1000,
  cleanupIntervalMs: 2 * 60 * 1000
});

// Simulate async generation workflow
async function handleGenerationRequest(config: ImageGenerationConfig): Promise<string> {
  // Create entry
  const id = registry.create(config);

  // Start async work (don't await)
  generateImageAsync(id, config).catch(error => {
    registry.update(id, {
      status: 'error',
      error: {
        message: error.message,
        code: 'BACKEND_ERROR'
      }
    });
  });

  // Return ID immediately
  return id;
}

async function generateImageAsync(id: string, config: ImageGenerationConfig) {
  // Update to in_progress
  registry.update(id, { status: 'in_progress' });

  // Simulate generation with progress updates
  for (let step = 1; step <= 30; step++) {
    await new Promise(resolve => setTimeout(resolve, 100));

    registry.update(id, {
      progress: {
        currentStep: step,
        totalSteps: 30,
        stage: 'diffusion',
        percentage: (step / 30) * 100
      }
    });
  }

  // Complete
  registry.update(id, {
    status: 'complete',
    result: {
      images: [{
        image: 'base64_image_data_here',
        seed: config.seed || 42,
        width: config.width || 512,
        height: config.height || 512
      }],
      format: 'png',
      timeTaken: 3000
    }
  });
}

// Usage
const id = await handleGenerationRequest({
  prompt: 'A beautiful sunset',
  width: 1024,
  height: 1024
});

// Poll for result
const checkStatus = async () => {
  const state = registry.get(id);
  if (!state) {
    console.log('Not found');
    return;
  }

  console.log('Status:', state.status);

  if (state.status === 'complete') {
    console.log('✅ Complete!');
    console.log('Images:', state.result?.images.length);
  } else if (state.status === 'in_progress') {
    console.log('⏳ In progress:', state.progress?.percentage, '%');
  }
};

// Cleanup when done
process.on('exit', () => {
  registry.destroy();
});
```

---

## HTTP API Endpoints

The `DiffusionServerManager` creates an HTTP server with RESTful endpoints for async image generation. These endpoints implement a polling pattern where you POST to start generation, then GET to poll for status and results.

**Base URL**: `http://localhost:{port}` (default port: 8081)

**Architecture Note**: The HTTP server is created automatically when you call `diffusionServer.start()`. It runs alongside the internal generation logic and provides the same automatic resource orchestration as the Node.js API.

---

### POST /v1/images/generations

Start an async image generation. Returns immediately with a generation ID.

**Request Body** (JSON):
```typescript
{
  prompt: string;              // Required - text description
  negativePrompt?: string;     // What to avoid
  width?: number;              // Image width (default: 512)
  height?: number;             // Image height (default: 512)
  steps?: number;              // Inference steps (default: 20)
  cfgScale?: number;           // Guidance scale (default: 7.5)
  seed?: number;               // Random seed (undefined/negative = random)
  sampler?: ImageSampler;      // Sampler algorithm (default: 'euler_a')
  count?: number;              // Number of images (1-5, default: 1)
}
```

**Response** (201 Created):
```typescript
{
  id: string;           // Unique generation ID (use for polling)
  status: 'pending';    // Initial status
  createdAt: number;    // Unix timestamp
}
```

**Error Responses**:
- `400 Bad Request` - Invalid request (missing prompt, invalid count)
- `503 Service Unavailable` - Server is busy with another generation

**Example**:
```typescript
// Start generation
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'A serene mountain landscape at sunset',
    negativePrompt: 'blurry, low quality',
    width: 1024,
    height: 1024,
    steps: 30,
    cfgScale: 7.5,
    sampler: 'dpm++2m'
  })
});

const { id, status, createdAt } = await response.json();
console.log('Generation started:', id);
```

---

### GET /v1/images/generations/:id

Poll generation status and retrieve results when complete.

**URL Parameters**:
- `id` - Generation ID from POST response

**Response Formats**:

**Pending** (200 OK):
```typescript
{
  id: string;
  status: 'pending';
  createdAt: number;
  updatedAt: number;
}
```

**In Progress** (200 OK):
```typescript
{
  id: string;
  status: 'in_progress';
  createdAt: number;
  updatedAt: number;
  progress: {
    currentStep: number;      // Current step in stage
    totalSteps: number;       // Total steps in stage
    stage: 'loading' | 'diffusion' | 'decoding';
    percentage?: number;      // Overall progress (0-100)
    currentImage?: number;    // Current image (1-indexed, batch only)
    totalImages?: number;     // Total images (batch only)
  };
}
```

**Complete** (200 OK):
```typescript
{
  id: string;
  status: 'complete';
  createdAt: number;
  updatedAt: number;
  result: {
    images: Array<{
      image: string;    // Base64-encoded PNG
      seed: number;     // Seed used
      width: number;    // Image width
      height: number;   // Image height
    }>;
    format: 'png';
    timeTaken: number;  // Total time in milliseconds
  };
}
```

**Error** (200 OK):
```typescript
{
  id: string;
  status: 'error';
  createdAt: number;
  updatedAt: number;
  error: {
    message: string;
    code: 'SERVER_BUSY' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'BACKEND_ERROR' | 'IO_ERROR';
  };
}
```

**Error Response** (404 Not Found):
```typescript
{
  error: {
    message: 'Generation not found';
    code: 'NOT_FOUND';
  };
}
```

**Example (Polling Loop)**:
```typescript
async function pollUntilComplete(id: string): Promise<any> {
  while (true) {
    const response = await fetch(`http://localhost:8081/v1/images/generations/${id}`);
    const data = await response.json();

    console.log('Status:', data.status);

    if (data.status === 'in_progress' && data.progress) {
      console.log(`Progress: ${data.progress.percentage?.toFixed(1)}%`);
      console.log(`Stage: ${data.progress.stage}`);
    }

    if (data.status === 'complete') {
      console.log('✅ Generation complete!');
      console.log(`Generated ${data.result.images.length} images in ${data.result.timeTaken}ms`);
      return data.result;
    }

    if (data.status === 'error') {
      console.error('❌ Generation failed:', data.error.message);
      throw new Error(data.error.message);
    }

    // Poll every second
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Use it
const result = await pollUntilComplete(generationId);

// Save images
result.images.forEach((img, i) => {
  const buffer = Buffer.from(img.image, 'base64');
  fs.writeFileSync(`output-${i}.png`, buffer);
  console.log(`Saved with seed: ${img.seed}`);
});
```

---

### GET /health

Check if the diffusion server is running and available.

**Response** (200 OK):
```typescript
{
  status: 'ok';
  busy: boolean;  // Whether currently generating an image
}
```

**Example**:
```typescript
const response = await fetch('http://localhost:8081/health');
const { status, busy } = await response.json();

if (status === 'ok' && !busy) {
  console.log('✅ Server is ready for generation');
} else if (busy) {
  console.log('⏳ Server is busy - wait before submitting');
}
```

---

### Complete Workflow Example

```typescript
async function generateImageViaHTTP() {
  const baseURL = 'http://localhost:8081';

  // 1. Check server health
  const healthResponse = await fetch(`${baseURL}/health`);
  const { status, busy } = await healthResponse.json();

  if (status !== 'ok') {
    throw new Error('Diffusion server is not running');
  }

  if (busy) {
    console.log('Server is busy, waiting...');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 2. Start generation
  const startResponse = await fetch(`${baseURL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'A futuristic city at night, cyberpunk style',
      negativePrompt: 'blurry, low quality, oversaturated',
      width: 1024,
      height: 1024,
      steps: 30,
      cfgScale: 7.5,
      sampler: 'dpm++2m',
      count: 2  // Generate 2 variations
    })
  });

  if (!startResponse.ok) {
    const error = await startResponse.json();
    throw new Error(error.error?.message || 'Failed to start generation');
  }

  const { id } = await startResponse.json();
  console.log('Generation started:', id);

  // 3. Poll for completion
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const pollResponse = await fetch(`${baseURL}/v1/images/generations/${id}`);
    const data = await pollResponse.json();

    if (data.status === 'in_progress' && data.progress) {
      const { stage, percentage, currentImage, totalImages } = data.progress;
      if (currentImage && totalImages) {
        console.log(`Image ${currentImage}/${totalImages}: ${stage} - ${percentage?.toFixed(1)}%`);
      } else {
        console.log(`${stage}: ${percentage?.toFixed(1)}%`);
      }
    }

    if (data.status === 'complete') {
      console.log('✅ Generation complete!');
      console.log(`Time taken: ${(data.result.timeTaken / 1000).toFixed(1)}s`);

      // Save images
      data.result.images.forEach((img, i) => {
        const buffer = Buffer.from(img.image, 'base64');
        fs.writeFileSync(`cyberpunk-${i}.png`, buffer);
        console.log(`Saved image ${i} (seed: ${img.seed})`);
      });

      return data.result;
    }

    if (data.status === 'error') {
      throw new Error(`Generation failed: ${data.error.message} (${data.error.code})`);
    }
  }
}

// Run it
try {
  await generateImageViaHTTP();
} catch (error) {
  console.error('Failed:', error.message);
}
```

---

### Error Codes Reference

| Code | Description | Typical Cause |
|------|-------------|---------------|
| `SERVER_BUSY` | Server is already processing another generation | Multiple concurrent requests |
| `NOT_FOUND` | Generation ID not found | Invalid ID or result already expired (TTL) |
| `INVALID_REQUEST` | Invalid request parameters | Missing prompt, invalid count (not 1-5), etc. |
| `BACKEND_ERROR` | Backend processing failed | Model loading error, CUDA error, etc. |
| `IO_ERROR` | File I/O error | Failed to write temporary files, disk full |

---

### Resource Orchestration (HTTP Endpoints)

The HTTP endpoints inherit the same automatic resource orchestration as the Node.js API:
- If resources are constrained, LLM is automatically offloaded before generation
- After generation completes, LLM is automatically reloaded
- This happens transparently for all HTTP requests
- No additional configuration needed

**Note**: Batch generation (count > 1) currently bypasses orchestration and runs without offload. This is planned for Phase 3.

---

### Migration from Phase 2.0 Synchronous API

**Breaking Change**: Phase 2.5 introduced an async polling API. If you were using the previous synchronous HTTP endpoint:

**Old (Phase 2.0 - synchronous)**:
```typescript
// POST /v1/images/generations - blocks until complete
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config)
});
const result = await response.json(); // Waits for entire generation
```

**New (Phase 2.5+ - async)**:
```typescript
// POST /v1/images/generations - returns immediately
const startResponse = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config)
});
const { id } = await startResponse.json(); // Get ID immediately

// Poll GET /v1/images/generations/:id for result
// (see polling examples above)
```

---

## Types and Interfaces

### SystemCapabilities

Complete system hardware information.

```typescript
interface SystemCapabilities {
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpu: GPUInfo;
  platform: NodeJS.Platform;
  recommendations: SystemRecommendations;
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
  available: boolean;              // Whether GPU is detected
  type?: 'nvidia' | 'amd' | 'apple' | 'intel';
  name?: string;                   // GPU model name
  vram?: number;                   // VRAM in bytes
  cuda?: boolean;                  // NVIDIA CUDA support
  metal?: boolean;                 // Apple Metal support
  rocm?: boolean;                  // AMD ROCm support
  vulkan?: boolean;                // Vulkan support
}
```

### SystemRecommendations

```typescript
interface SystemRecommendations {
  maxModelSize: string;              // e.g., '7B', '13B'
  recommendedQuantization: readonly string[];  // e.g., ['Q4_K_M', 'Q5_K_M']
  threads: number;                   // Recommended thread count
  gpuLayers?: number;                // Recommended GPU layers (if GPU available)
}
```

### ModelInfo

```typescript
interface ModelInfo {
  id: string;                 // Unique model identifier
  name: string;               // Display name
  type: ModelType;            // 'llm' or 'diffusion'
  size: number;               // File size in bytes
  path: string;               // Absolute path to model file
  downloadedAt: string;       // ISO 8601 timestamp
  source: ModelSource;        // Download source info
  checksum?: string;          // SHA256 checksum (if provided)
  supportsReasoning?: boolean; // Whether model supports reasoning (auto-detected)
  ggufMetadata?: GGUFMetadata; // GGUF metadata (extracted during download)
}
```

**Reasoning Support Detection:**

The `supportsReasoning` field is automatically detected based on GGUF filename patterns during model download. When `true`, llama-server will be started with `--jinja --reasoning-format deepseek` flags to enable extraction of reasoning content from `<think>...</think>` tags.

Supported model families:
- **Qwen3**: All sizes (0.6B, 1.7B, 4B, 8B, 14B, 30B)
- **DeepSeek-R1**: All variants including distilled models
- **GPT-OSS**: OpenAI's open-source reasoning model

See [Reasoning Model Detection](#reasoning-model-detection) for details.

**GGUF Metadata:**

The `ggufMetadata` field contains accurate model information extracted from the GGUF file during download:
- `block_count` - Actual number of layers (no estimation!)
- `context_length` - Maximum sequence length the model supports
- `architecture` - Model architecture ('llama', 'mamba', 'gpt2', etc.)
- `attention_head_count` - Number of attention heads
- `embedding_length` - Embedding dimension
- Plus 10+ additional fields and complete raw metadata

**Example**:
```typescript
const model = await modelManager.getModelInfo('llama-2-7b');
if (model.ggufMetadata) {
  console.log('✅ Accurate metadata available');
  console.log('Layers:', model.ggufMetadata.block_count);
  console.log('Context:', model.ggufMetadata.context_length);
  console.log('Architecture:', model.ggufMetadata.architecture);
} else {
  console.log('⚠️  Using estimated values (model downloaded before GGUF integration)');
  // Update metadata: await modelManager.updateModelMetadata('llama-2-7b');
}
```

For models downloaded before GGUF integration, this field may be `undefined`.
Use `modelManager.updateModelMetadata(id)` to add metadata without re-downloading.

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
  tensor_count?: number;         // Number of tensors (converted from BigInt for JSON serialization)
  kv_count?: number;             // Number of metadata key-value pairs (converted from BigInt)
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

**Example:**
```typescript
const model = await modelManager.getModelInfo('llama-2-7b');
if (model.ggufMetadata) {
  console.log('✅ Accurate metadata available');
  console.log('Layers:', model.ggufMetadata.block_count);
  console.log('Context:', model.ggufMetadata.context_length);
  console.log('Architecture:', model.ggufMetadata.architecture);

  // Use for precise GPU offloading
  const totalLayers = model.ggufMetadata.block_count || 32;
  const gpuLayers = Math.min(24, totalLayers);
  console.log(`Offloading ${gpuLayers}/${totalLayers} layers to GPU`);
} else {
  console.log('⚠️  Using estimated values (model downloaded before GGUF integration)');
  // Update metadata: await modelManager.updateModelMetadata('llama-2-7b');
}
```

**Architecture Support:**

The library uses generic architecture field extraction with `getArchField()`, supporting ANY model architecture dynamically:
- **Llama family**: llama, llama2, llama3
- **Gemma family**: gemma, gemma2, gemma3
- **Qwen family**: qwen, qwen2, qwen3
- **Other**: mistral, phi, mamba, gpt2, gpt-neox, falcon, and any future architectures

Different architectures have their metadata in architecture-prefixed fields:
- **llama**: `llama.block_count`, `llama.context_length`, `llama.attention.head_count`
- **gemma3**: `gemma3.block_count`, `gemma3.context_length`, `gemma3.attention.head_count`
- **qwen3**: `qwen3.block_count`, `qwen3.context_length`, `qwen3.attention.head_count`

The library automatically extracts the correct fields using the `general.architecture` value.

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
}
```

### Phase 2: Image Generation Types

#### ImageGenerationConfig

Configuration for image generation requests.

```typescript
interface ImageGenerationConfig {
  prompt: string;                    // Text prompt describing the image
  negativePrompt?: string;           // What to avoid in the image
  width?: number;                    // Image width in pixels (default: 512)
  height?: number;                   // Image height in pixels (default: 512)
  steps?: number;                    // Inference steps (default: 20)
  cfgScale?: number;                 // Guidance scale (default: 7.5)
  seed?: number;                     // Random seed (undefined or negative = random, actual seed returned)
  sampler?: ImageSampler;            // Sampler algorithm (default: 'euler_a')
  count?: number;                    // Number of images to generate (1-5, default: 1)
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: 'loading' | 'diffusion' | 'decoding',
    percentage?: number
  ) => void; // Progress callback with stage information
}
```

#### ImageGenerationResult

Result of image generation.

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

#### ImageSampler

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

#### ImageGenerationStage

Stage of image generation process.

```typescript
type ImageGenerationStage =
  | 'loading'     // Model tensors being loaded into memory
  | 'diffusion'   // Denoising steps (main generation process)
  | 'decoding';   // VAE decoding latents to final image
```

#### ImageGenerationProgress

Progress information emitted during image generation.

```typescript
interface ImageGenerationProgress {
  currentStep: number;              // Current step within the stage
  totalSteps: number;               // Total steps in the stage
  stage: ImageGenerationStage;      // Current stage
  percentage?: number;              // Overall progress percentage (0-100)
  currentImage?: number;            // Current image being generated (1-indexed, for batch generation)
  totalImages?: number;             // Total images in batch (for batch generation)
}
```

### Progress Tracking

Image generation progress tracking provides detailed stage information:

**Stages:**

1. **Loading** (~20% of time): Model tensors loading into memory
   - Reports: tensor count (e.g., 1500/2641)
   - UI suggestion: "Loading model..."

2. **Diffusion** (~30-50% of time): Denoising steps
   - Reports: actual step count (e.g., 2/4, 15/30)
   - UI suggestion: "Generating (step X/Y)"

3. **Decoding** (~30-50% of time): VAE decoding
   - Reports: estimated progress
   - UI suggestion: "Decoding..."

**Self-Calibrating Estimates:**

The system automatically calibrates time estimates based on actual hardware performance:
- First generation uses reasonable defaults
- Subsequent generations adapt to image size and step count
- Provides accurate overall percentage across all stages

**Example Progress Display:**

```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape',
  width: 1024,
  height: 1024,
  steps: 30,
  onProgress: (current, total, stage, percentage) => {
    if (stage === 'loading') {
      console.log(`Loading model... ${Math.round(percentage || 0)}%`);
    } else if (stage === 'diffusion') {
      console.log(`Generating (step ${current}/${total}): ${Math.round(percentage || 0)}%`);
    } else {
      console.log(`Decoding: ${Math.round(percentage || 0)}%`);
    }
  }
});

// Output:
// Loading model... 12%
// Generating (step 1/30): 25%
// Generating (step 15/30): 55%
// Generating (step 30/30): 75%
// Decoding: 88%
// Decoding: 100%
```

#### DiffusionServerConfig

Configuration for starting the diffusion server.

```typescript
interface DiffusionServerConfig {
  modelId: string;        // Diffusion model ID to load
  port?: number;          // Port to listen on (default: 8081)
  threads?: number;       // CPU threads (auto-detected if not specified)
  gpuLayers?: number;     // GPU layers to offload (auto-detected if not specified)
  vramBudget?: number;    // VRAM budget in MB (Phase 3 - not yet implemented, currently ignored)
}
```

#### DiffusionServerInfo

Diffusion server status information.

```typescript
interface DiffusionServerInfo {
  status: ServerStatus;      // Current server state
  health: HealthStatus;      // Health check result
  pid?: number;              // HTTP wrapper process ID (if running)
  port: number;              // Server port
  modelId: string;           // Loaded model ID
  startedAt?: string;        // ISO 8601 timestamp (if running)
  error?: string;            // Last error message (if crashed)
  busy?: boolean;            // Whether currently generating an image
}
```

#### GenerationStatus

Status of an async image generation (for HTTP API).

```typescript
type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error';
```

**Status Flow**:
- `pending` → Initial state after POST request
- `in_progress` → Generation is running
- `complete` → Generation finished successfully
- `error` → Generation failed

#### GenerationState

Complete state information for an async image generation (for HTTP API).

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

**Usage**: This type represents the complete state stored in `GenerationRegistry` and returned by the HTTP GET endpoint.

---

## Error Classes

All errors extend `GenaiElectronError` which provides:
- `code: string` - Error code for programmatic handling
- `details?: unknown` - Additional error context

### GenaiElectronError

Base error class.

```typescript
class GenaiElectronError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code: string, details?: unknown);
}
```

### ModelNotFoundError

Thrown when a model doesn't exist.

```typescript
class ModelNotFoundError extends GenaiElectronError {
  constructor(modelId: string);
}
```

**Example**:
```typescript
try {
  await modelManager.getModelInfo('non-existent-model');
} catch (error) {
  if (error instanceof ModelNotFoundError) {
    console.error('Model not found:', error.message);
    // Suggest available models
    const available = await modelManager.listModels();
    console.log('Available models:', available.map(m => m.id));
  }
}
```

### DownloadError

Thrown when a download fails.

```typescript
class DownloadError extends GenaiElectronError {
  constructor(message: string, details?: unknown);
}
```

**Example**:
```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
    console.error('Details:', error.details);
    // Could retry with exponential backoff
  }
}
```

### InsufficientResourcesError

Thrown when system lacks required resources.

```typescript
class InsufficientResourcesError extends GenaiElectronError {
  details: {
    required: string;
    available: string;
    suggestion?: string;
  };

  constructor(message: string, details: { required: string; available: string; suggestion?: string });
}
```

**Example**:
```typescript
try {
  await llamaServer.start({ modelId: 'llama-2-13b', port: 8080 });
} catch (error) {
  if (error instanceof InsufficientResourcesError) {
    console.error('Not enough resources:', error.message);
    console.error('Required:', error.details.required);
    console.error('Available:', error.details.available);
    console.log('Suggestion:', error.details.suggestion);
  }
}
```

### ServerError

Thrown when server operations fail.

```typescript
class ServerError extends GenaiElectronError {
  constructor(message: string, details?: unknown);
}
```

### PortInUseError

Thrown when a port is already in use.

```typescript
class PortInUseError extends GenaiElectronError {
  constructor(port: number);
}
```

**Example**:
```typescript
try {
  await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
} catch (error) {
  if (error instanceof PortInUseError) {
    console.error('Port 8080 is already in use');
    // Try alternative port
    await llamaServer.start({ modelId: 'llama-2-7b', port: 8081 });
  }
}
```

### ChecksumError

Thrown when checksum verification fails.

```typescript
class ChecksumError extends GenaiElectronError {
  constructor(expected: string, actual: string);
}
```

### FileSystemError

Thrown when file operations fail.

```typescript
class FileSystemError extends GenaiElectronError {
  constructor(operation: string, path: string, originalError?: unknown);
}
```

### BinaryError

Thrown when binary download or execution fails.

```typescript
class BinaryError extends GenaiElectronError {
  constructor(message: string, details?: unknown);
}
```

---

## Utilities

### Platform Detection

```typescript
import { getPlatform, getArchitecture, getPlatformKey } from 'genai-electron';

const platform = getPlatform();  // 'darwin', 'win32', 'linux'
const arch = getArchitecture();  // 'x64', 'arm64'
const key = getPlatformKey();    // 'darwin-arm64', 'win32-x64', etc.
```

### File Utilities

```typescript
import { calculateChecksum, formatBytes } from 'genai-electron';

// Calculate SHA256 checksum
const checksum = await calculateChecksum('/path/to/model.gguf');
console.log('SHA256:', checksum);

// Format bytes for display
const size = 4368769024;
console.log('Size:', formatBytes(size)); // '4.07 GB'
```

### Reasoning Model Detection

genai-electron automatically detects reasoning-capable GGUF models and configures llama-server appropriately.

```typescript
import { detectReasoningSupport, REASONING_MODEL_PATTERNS } from 'genai-electron';

// Check if a model supports reasoning based on filename
const filename = 'Qwen3-8B-Instruct-Q4_K_M.gguf';
const supportsReasoning = detectReasoningSupport(filename);
console.log('Supports reasoning:', supportsReasoning); // true

// View known patterns
console.log('Known reasoning patterns:', REASONING_MODEL_PATTERNS);
// ['qwen3', 'deepseek-r1', 'gpt-oss']
```

**How it works:**

1. **During download**: ModelManager detects reasoning support from GGUF filename
2. **Metadata storage**: `supportsReasoning` flag is saved with model metadata
3. **Server startup**: LlamaServerManager adds `--jinja --reasoning-format deepseek` when starting models with `supportsReasoning: true`
4. **Automatic extraction**: llama.cpp extracts `<think>...</think>` content into separate field
5. **API integration**: Use with genai-lite to access reasoning content

**Supported models:**
- **Qwen3**: All variants (0.6B-30B) with conditional reasoning support
- **DeepSeek-R1**: All sizes with always-on reasoning
- **GPT-OSS**: OpenAI's open-source reasoning model

**Example workflow:**

```typescript
// 1. Download a reasoning model
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'Qwen/Qwen3-8B-Instruct-GGUF',
  file: 'qwen3-8b-instruct-q4_k_m.gguf',
  name: 'Qwen3 8B',
  type: 'llm'
});

console.log('Supports reasoning:', model.supportsReasoning); // true

// 2. Start server (reasoning flags added automatically)
await llamaServer.start({
  modelId: model.id,
  port: 8080
});
// llama-server started with: --jinja --reasoning-format deepseek

// 3. Use with genai-lite to access reasoning
import { LLMService } from 'genai-lite';
const service = new LLMService(async () => 'not-needed');

const response = await service.sendMessage({
  providerId: 'llamacpp',
  modelId: model.id,
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  settings: { reasoning: { enabled: true } }
});

if (response.object === 'chat.completion') {
  console.log('Answer:', response.choices[0].message.content);
  console.log('Reasoning:', response.choices[0].reasoning); // Model's thinking process
}
```

### ID Generation

Generate unique IDs for async operations (used internally by `GenerationRegistry` for the HTTP API).

```typescript
import { generateId } from 'genai-electron';

// Generate a unique ID
const id = generateId();
console.log('Generated ID:', id); // e.g., "a3f9d2b8e1c4"

// Use for custom tracking
const taskId = generateId();
console.log('Task ID:', taskId);
```

**Returns**: `string` - Random alphanumeric ID (12 characters)

**Use cases:**
- Custom async operation tracking
- Request/response correlation
- Unique file naming
- Session identifiers

**Note**: This utility is primarily for advanced use cases. The `DiffusionServerManager` HTTP API uses this internally via `GenerationRegistry`.

---

### GGUF Metadata Extraction

**Generic Architecture Support**

The GGUF parser uses a generic helper function that works with ANY model architecture dynamically.

```typescript
import { getArchField } from 'genai-electron';

// Get metadata-specific field for any architecture
const metadata = {
  'general.architecture': 'gemma3',
  'gemma3.block_count': 48,
  'gemma3.context_length': 131072
};

const blockCount = getArchField(metadata, 'block_count');
console.log('Block count:', blockCount); // 48

const contextLen = getArchField(metadata, 'context_length');
console.log('Context length:', contextLen); // 131072
```

**How it works:**
- Reads `general.architecture` from metadata (e.g., "gemma3", "qwen3", "llama")
- Dynamically constructs field path: `${architecture}.${fieldPath}`
- Returns the value or `undefined` if not found

**Supported architectures:**
- **Llama family**: llama, llama2, llama3
- **Gemma family**: gemma, gemma2, gemma3
- **Qwen family**: qwen, qwen2, qwen3
- **Other**: mistral, phi, mamba, gpt2, gpt-neox, falcon, and more
- **Future-proof**: Any new architecture works automatically!

**Extracted fields:**
```typescript
getArchField(metadata, 'block_count')                        // Layer count
getArchField(metadata, 'context_length')                     // Context window
getArchField(metadata, 'attention.head_count')               // Attention heads
getArchField(metadata, 'embedding_length')                   // Embedding dim
getArchField(metadata, 'feed_forward_length')                // FF layer size
getArchField(metadata, 'vocab_size')                         // Vocabulary size
getArchField(metadata, 'rope.dimension_count')               // RoPE dimensions
getArchField(metadata, 'rope.freq_base')                     // RoPE frequency base
getArchField(metadata, 'attention.layer_norm_rms_epsilon')   // RMS epsilon
```

**Example with different architectures:**

```typescript
// Gemma3 model
const gemma = {
  'general.architecture': 'gemma3',
  'gemma3.block_count': 48,
  'gemma3.context_length': 131072
};
console.log(getArchField(gemma, 'block_count')); // 48

// Qwen3 model
const qwen = {
  'general.architecture': 'qwen3',
  'qwen3.block_count': 64,
  'qwen3.context_length': 32768
};
console.log(getArchField(qwen, 'block_count')); // 64

// Llama model
const llama = {
  'general.architecture': 'llama',
  'llama.block_count': 32,
  'llama.context_length': 4096
};
console.log(getArchField(llama, 'block_count')); // 32
```

---

## Complete Example: LLM + Image Generation

This example demonstrates both LLM inference and local image generation with automatic resource management.

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import {
  systemInfo,
  modelManager,
  llamaServer,
  diffusionServer,
  ResourceOrchestrator
} from 'genai-electron';
import { promises as fs } from 'fs';

async function main() {
  // 1. Detect system capabilities
  console.log('Detecting system capabilities...');
  const capabilities = await systemInfo.detect();
  console.log('System Information:');
  console.log('  CPU:', capabilities.cpu.cores, 'cores');
  console.log('  RAM:', (capabilities.memory.total / 1024 ** 3).toFixed(1), 'GB');
  console.log('  GPU:', capabilities.gpu.available ? capabilities.gpu.name : 'none');
  if (capabilities.gpu.available) {
    console.log('  VRAM:', (capabilities.gpu.vram / 1024 ** 3).toFixed(1), 'GB');
  }
  console.log('  Recommended max model:', capabilities.recommendations.maxModelSize);

  // 2. Download models if needed
  let llmModels = await modelManager.listModels('llm');
  let diffusionModels = await modelManager.listModels('diffusion');

  // Download LLM model if none exist
  if (llmModels.length === 0) {
    console.log('\nDownloading LLM model (Llama 2 7B)...');
    await modelManager.downloadModel({
      source: 'huggingface',
      repo: 'TheBloke/Llama-2-7B-GGUF',
      file: 'llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B',
      type: 'llm',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`\rLLM Progress: ${percent}%`);
      }
    });
    console.log('\n✅ LLM model downloaded');
    llmModels = await modelManager.listModels('llm');
  }

  // Download diffusion model if none exist
  if (diffusionModels.length === 0) {
    console.log('\nDownloading diffusion model (SDXL Turbo)...');
    await modelManager.downloadModel({
      source: 'url',
      url: 'https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sdxl-turbo-q4.gguf',
      name: 'SDXL Turbo',
      type: 'diffusion',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`\rDiffusion Progress: ${percent}%`);
      }
    });
    console.log('\n✅ Diffusion model downloaded');
    diffusionModels = await modelManager.listModels('diffusion');
  }

  const llmModel = llmModels[0];
  const diffusionModel = diffusionModels[0];

  // 3. Start LLM server
  console.log('\nStarting LLM server...');
  const llmConfig = await systemInfo.getOptimalConfig(llmModel);
  await llamaServer.start({
    modelId: llmModel.id,
    port: 8080,
    ...llmConfig
  });
  console.log('✅ LLM server running on port 8080');

  // 4. Start diffusion server
  console.log('Starting diffusion server...');
  await diffusionServer.start({
    modelId: diffusionModel.id,
    port: 8081
  });
  console.log('✅ Diffusion server running on port 8081');

  // 5. Use LLM via genai-lite
  console.log('\nTesting LLM...');
  const llmService = new LLMService(async () => 'not-needed');
  const llmResponse = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: llmModel.id,
    messages: [
      { role: 'user', content: 'Describe a beautiful landscape in 2 sentences.' }
    ]
  });

  if (llmResponse.object === 'chat.completion') {
    const description = llmResponse.choices[0].message.content;
    console.log('LLM Response:', description);

    // 6. Generate image based on LLM description
    console.log('\nGenerating image based on description...');

    // Create resource orchestrator for automatic management
    const orchestrator = new ResourceOrchestrator(
      systemInfo,
      llamaServer,
      diffusionServer,
      modelManager
    );

    // Check if offload will be needed
    const needsOffload = await orchestrator.wouldNeedOffload();
    if (needsOffload) {
      console.log('⚠️  Limited resources - LLM will be temporarily offloaded');
    }

    // Generate image with automatic resource management
    const imageResult = await orchestrator.orchestrateImageGeneration({
      prompt: description,
      negativePrompt: 'blurry, low quality, distorted',
      width: 1024,
      height: 1024,
      steps: 30,
      onProgress: (currentStep, totalSteps, stage, percentage) => {
        const pct = Math.round(percentage || 0);
        if (stage === 'loading') {
          process.stdout.write(`\rLoading model: ${pct}%`);
        } else if (stage === 'diffusion') {
          process.stdout.write(`\rGenerating (step ${currentStep}/${totalSteps}): ${pct}%`);
        } else {
          process.stdout.write(`\rDecoding: ${pct}%`);
        }
      }
    });

    console.log(`\n✅ Image generated in ${(imageResult.timeTaken / 1000).toFixed(1)}s`);

    // Save image
    await fs.writeFile('generated-landscape.png', imageResult.image);
    console.log('💾 Image saved to generated-landscape.png');

    // Check if LLM is running again
    const llamaStatus = llamaServer.getStatus();
    if (llamaStatus.status === 'running') {
      console.log('✅ LLM server automatically reloaded and ready');
    }
  }

  // 7. Cleanup on app quit
  app.on('before-quit', async () => {
    console.log('\nShutting down servers...');
    await llamaServer.stop();
    await diffusionServer.stop();
    console.log('✅ All servers stopped');
  });
}

app.whenReady().then(main).catch(console.error);
```

**This example demonstrates:**
- System capability detection
- Downloading both LLM and diffusion models
- Starting both servers
- Using LLM via genai-lite to generate a description
- Using ResourceOrchestrator for automatic resource management
- Generating an image based on the LLM description
- Automatic LLM offload/reload when resources are constrained
- Proper cleanup on application quit

---

For more information, see:
- [README.md](../README.md) - Overview and quick start
- [SETUP.md](SETUP.md) - Development setup
- [DESIGN.md](../DESIGN.md) - Architecture and design
