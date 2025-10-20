# genai-electron API Reference

> **Version**: 0.2.0 (Phase 2 Complete)
> **Status**: Production Ready

Complete API reference for genai-electron Phase 1 (LLM Support) and Phase 2 (Image Generation).

---

## Table of Contents

### Phase 1: LLM Support
1. [SystemInfo](#systeminfo)
2. [ModelManager](#modelmanager)
3. [LlamaServerManager](#llamaservermanager)

### Phase 2: Image Generation
4. [DiffusionServerManager](#diffusionservermanager)
5. [ResourceOrchestrator](#resourceorchestrator)

### Reference
6. [Types and Interfaces](#types-and-interfaces)
7. [Error Classes](#error-classes)
8. [Utilities](#utilities)

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

#### `canRunModel(modelInfo: ModelInfo): Promise<{ possible: boolean; reason?: string; suggestion?: string }>`

Checks if a specific model can run on the current system based on available resources.

**Parameters**:
- `modelInfo: ModelInfo` - Model information to check

**Returns**: `Promise<{ possible: boolean; reason?: string; suggestion?: string }>` - Whether model can run, reason if not, and optional suggestion

**Example**:
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
  // Example reasons:
  // - "Insufficient RAM: Model requires 8GB but only 4GB available"
  // - "Model file not found or corrupt"
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
5. **Caches working variant** for fast subsequent starts

**Note**: Real functionality testing only runs if model is downloaded. If model doesn't exist yet, falls back to basic `--version` test. This means optimal variant selection happens automatically when you call `start()` with a valid model.

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

**Architecture Note**: Unlike llama-server (which is a native HTTP server), stable-diffusion.cpp is a one-shot executable. DiffusionServerManager creates an HTTP wrapper server that spawns stable-diffusion.cpp on-demand for each image generation request.

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

**Parameters**:
- `config: ImageGenerationConfig` - Image generation configuration

**ImageGenerationConfig Options**:
- `prompt: string` - **Required** - Text prompt describing the image
- `negativePrompt?: string` - Optional - What to avoid in the image
- `width?: number` - Optional - Image width in pixels (default: 512)
- `height?: number` - Optional - Image height in pixels (default: 512)
- `steps?: number` - Optional - Number of inference steps (default: 20, more = better quality but slower)
- `cfgScale?: number` - Optional - Guidance scale (default: 7.5, higher = closer to prompt)
- `seed?: number` - Optional - Random seed for reproducibility (-1 = random)
- `sampler?: ImageSampler` - Optional - Sampler algorithm (default: 'euler_a')
- `onProgress?: (currentStep: number, totalSteps: number) => void` - Optional - Progress callback

**Returns**: `Promise<ImageGenerationResult>` - Generated image data

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
  onProgress: (currentStep, totalSteps) => {
    const percent = ((currentStep / totalSteps) * 100).toFixed(1);
    console.log(`Generating: ${currentStep}/${totalSteps} (${percent}%)`);
  }
});

console.log('Generated with seed:', result.seed);
console.log('Format:', result.format); // 'png'
await fs.writeFile('cyberpunk-city.png', result.image);
```

**Throws**:
- `ServerError` - Server not running, already generating an image, or generation failed

**Note**: Only one image can be generated at a time. If called while busy, throws `ServerError`. Model validation occurs during `start()`.

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
  onProgress: (currentStep, totalSteps) => {
    console.log(`Progress: ${currentStep}/${totalSteps}`);
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
}
```

**Reasoning Support Detection:**

The `supportsReasoning` field is automatically detected based on GGUF filename patterns during model download. When `true`, llama-server will be started with `--jinja --reasoning-format deepseek` flags to enable extraction of reasoning content from `<think>...</think>` tags.

Supported model families:
- **Qwen3**: All sizes (0.6B, 1.7B, 4B, 8B, 14B, 30B)
- **DeepSeek-R1**: All variants including distilled models
- **GPT-OSS**: OpenAI's open-source reasoning model

See [Reasoning Model Detection](#reasoning-model-detection) for details.

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
  seed?: number;                     // Random seed (-1 = random)
  sampler?: ImageSampler;            // Sampler algorithm (default: 'euler_a')
  onProgress?: (currentStep: number, totalSteps: number) => void; // Progress callback
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
      onProgress: (currentStep, totalSteps) => {
        const percent = ((currentStep / totalSteps) * 100).toFixed(1);
        process.stdout.write(`\rImage Generation: ${percent}% (${currentStep}/${totalSteps})`);
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
