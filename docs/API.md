# genai-electron API Reference

> **Version**: 0.1.0 (Phase 1 MVP)
> **Status**: Complete

Complete API reference for genai-electron Phase 1.

---

## Table of Contents

1. [SystemInfo](#systeminfo)
2. [ModelManager](#modelmanager)
3. [LlamaServerManager](#llamaservermanager)
4. [Types and Interfaces](#types-and-interfaces)
5. [Error Classes](#error-classes)
6. [Utilities](#utilities)

---

## SystemInfo

The `SystemInfo` class provides system capability detection and intelligent configuration recommendations.

### Import

```typescript
import { systemInfo } from 'genai-electron';
// Or for advanced usage:
import { SystemInfo } from 'genai-electron';
const customSystemInfo = new SystemInfo();
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

#### `canRunModel(modelInfo: ModelInfo): Promise<{ canRun: boolean; reason?: string }>`

Checks if a specific model can run on the current system based on available resources.

**Parameters**:
- `modelInfo: ModelInfo` - Model information to check

**Returns**: `Promise<{ canRun: boolean; reason?: string }>` - Whether model can run and reason if not

**Example**:
```typescript
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const check = await systemInfo.canRunModel(modelInfo);

if (check.canRun) {
  console.log('✅ Model can run on this system');
  await llamaServer.start({ modelId: modelInfo.id, port: 8080 });
} else {
  console.log('❌ Cannot run model:', check.reason);
  // Example reasons:
  // - "Insufficient RAM: Model requires 8GB but only 4GB available"
  // - "Model file not found or corrupt"
}
```

---

#### `getOptimalConfig(modelInfo: ModelInfo): Promise<ServerConfig>`

Generates optimal server configuration for a specific model based on system capabilities.

**Parameters**:
- `modelInfo: ModelInfo` - Model to generate config for

**Returns**: `Promise<ServerConfig>` - Optimized server configuration

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
const customModelManager = new ModelManager();
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

**Note**: Only works if checksum was provided during download. Returns `true` if no checksum stored.

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
- `BinaryError` - Binary download or execution failed

**Note**: First run will download llama-server binary (~50-100MB) for your platform.

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

#### `restart(): Promise<void>`

Restarts the server with the same configuration.

**Returns**: `Promise<void>`

**Example**:
```typescript
console.log('Restarting server...');
await llamaServer.restart();
console.log('Server restarted');
```

**Equivalent to**:
```typescript
await llamaServer.stop();
await llamaServer.start(previousConfig);
```

---

#### `getStatus(): ServerInfo`

Gets current server status (synchronous).

**Returns**: `ServerInfo` - Current server state

**Example**:
```typescript
const status = llamaServer.getStatus();

console.log('Server Status:', status.status);
// Possible values: 'stopped', 'starting', 'running', 'stopping', 'crashed'

console.log('Health:', status.health);
// Possible values: 'ok', 'loading', 'error', 'unknown'

if (status.pid) {
  console.log('Process ID:', status.pid);
}

console.log('Port:', status.port);
console.log('Model ID:', status.modelId);

if (status.startedAt) {
  const uptime = Date.now() - new Date(status.startedAt).getTime();
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
  const status = llamaServer.getStatus();
  console.log('Status:', status.status);
  console.log('Health:', status.health);
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

#### `getLogs(lines?: number): Promise<string>`

Gets recent server logs.

**Parameters**:
- `lines?: number` - Optional - Number of lines to retrieve (default: 100)

**Returns**: `Promise<string>` - Recent log entries

**Example**:
```typescript
// Get last 100 lines (default)
const logs = await llamaServer.getLogs();
console.log('Recent logs:\n', logs);

// Get last 50 lines
const recentLogs = await llamaServer.getLogs(50);
console.log('Last 50 lines:\n', recentLogs);

// Get all logs
const allLogs = await llamaServer.getLogs(Infinity);
console.log('All logs:\n', allLogs);
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
  id: string;              // Unique model identifier
  name: string;            // Display name
  type: ModelType;         // 'llm' or 'diffusion'
  size: number;            // File size in bytes
  path: string;            // Absolute path to model file
  downloadedAt: string;    // ISO 8601 timestamp
  source: ModelSource;     // Download source info
  checksum?: string;       // SHA256 checksum (if provided)
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

---

## Complete Example

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { systemInfo, modelManager, llamaServer } from 'genai-electron';

async function main() {
  // 1. Detect system
  console.log('Detecting system capabilities...');
  const capabilities = await systemInfo.detect();
  console.log('CPU:', capabilities.cpu.cores, 'cores');
  console.log('RAM:', formatBytes(capabilities.memory.total));
  console.log('GPU:', capabilities.gpu.available ? capabilities.gpu.name : 'none');
  console.log('Max model size:', capabilities.recommendations.maxModelSize);

  // 2. List or download models
  let models = await modelManager.listModels('llm');

  if (models.length === 0) {
    console.log('No models found. Downloading Llama 2 7B...');
    await modelManager.downloadModel({
      source: 'huggingface',
      repo: 'TheBloke/Llama-2-7B-GGUF',
      file: 'llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B',
      type: 'llm',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        process.stdout.write(`\rProgress: ${percent}%`);
      }
    });
    console.log('\nDownload complete!');
    models = await modelManager.listModels('llm');
  }

  const model = models[0];
  console.log('Using model:', model.name);

  // 3. Check if model can run
  const check = await systemInfo.canRunModel(model);
  if (!check.canRun) {
    console.error('Cannot run model:', check.reason);
    return;
  }

  // 4. Get optimal config
  const config = await systemInfo.getOptimalConfig(model);
  console.log('Optimal config:', config);

  // 5. Start server
  console.log('Starting llama-server...');
  await llamaServer.start({
    modelId: model.id,
    port: 8080,
    ...config
  });
  console.log('Server started!');

  // 6. Use with genai-lite
  const llmService = new LLMService(async () => 'not-needed');
  const response = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: 'llama-2-7b',
    messages: [
      { role: 'user', content: 'Explain AI in one sentence.' }
    ]
  });

  if (response.object === 'chat.completion') {
    console.log('AI:', response.choices[0].message.content);
  }

  // 7. Cleanup
  app.on('before-quit', async () => {
    console.log('Stopping server...');
    await llamaServer.stop();
  });
}

app.whenReady().then(main).catch(console.error);
```

---

For more information, see:
- [README.md](../README.md) - Overview and quick start
- [SETUP.md](SETUP.md) - Development setup
- [DESIGN.md](../DESIGN.md) - Architecture and design
