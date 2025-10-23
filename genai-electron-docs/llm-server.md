# LLM Server

The `LlamaServerManager` class manages the llama-server process lifecycle for running local LLMs via llama.cpp.

---

## Table of Contents

- [Overview](#overview)
- [Import](#import)
- [Server Lifecycle](#server-lifecycle)
  - [start()](#start)
  - [stop()](#stop)
  - [restart()](#restart)
- [Configuration Options](#configuration-options)
- [Status and Health](#status-and-health)
  - [getStatus()](#getstatus)
  - [getInfo()](#getinfo)
  - [isHealthy()](#ishealthy)
  - [getHealthStatus()](#gethealthstatus)
- [Logs](#logs)
  - [getLogs()](#getlogs)
  - [getStructuredLogs()](#getstructuredlogs)
- [Events](#events)
- [Binary Management](#binary-management)
- [Reasoning Model Support](#reasoning-model-support)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Overview

`LlamaServerManager` provides complete lifecycle management for llama-server processes:
- Automatic binary download and variant testing (CUDA → Vulkan → CPU)
- Auto-configuration based on system capabilities
- Health monitoring with exponential backoff
- Structured log parsing
- Event-driven lifecycle notifications
- Automatic reasoning model flag injection

**Architecture**: Uses native llama-server (HTTP server from llama.cpp), spawned as a child process and managed by genai-electron.

---

## Import

```typescript
import { llamaServer } from 'genai-electron';

// Or for advanced usage:
import { LlamaServerManager } from 'genai-electron';
const customServer = new LlamaServerManager();
```

The library exports a singleton `llamaServer` instance. For most use cases, use the singleton.

---

## Server Lifecycle

### start()

Starts the llama-server process with the specified configuration. Downloads binary automatically on first run.

**Signature**:
```typescript
start(config: LlamaServerConfig): Promise<ServerInfo>
```

**Parameters**:
- `config: LlamaServerConfig` - Server configuration (see [Configuration Options](#configuration-options))

**Returns**: `Promise<ServerInfo>` - Server information after successful start

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

### stop()

Stops the llama-server process gracefully.

**Signature**:
```typescript
stop(): Promise<void>
```

**Returns**: `Promise<void>`

**Example**:
```typescript
console.log('Stopping server...');
await llamaServer.stop();
console.log('Server stopped');

// Verify status
const status = llamaServer.getStatus();
console.log('Status:', status); // 'stopped'
```

**Behavior**:
1. Sends SIGTERM to process (graceful shutdown)
2. Waits up to 10 seconds for process to exit
3. Sends SIGKILL if still running (force kill)
4. Cleans up resources

---

### restart()

Convenience method to restart the server. Stops the server and starts it again with the same configuration.

**Signature**:
```typescript
restart(): Promise<ServerInfo>
```

**Returns**: `Promise<ServerInfo>` - Server information after restart

**Example**:
```typescript
// Restart server (useful after config changes or crashes)
await llamaServer.restart();
console.log('Server restarted with same configuration');
```

---

## Configuration Options

**LlamaServerConfig**:

```typescript
interface LlamaServerConfig {
  modelId: string;            // Required - Model ID to load
  port: number;               // Required - Port to listen on (typically 8080)
  threads?: number;           // Optional - CPU threads (auto-detected if not specified)
  contextSize?: number;       // Optional - Context window size (default: 4096)
  gpuLayers?: number;         // Optional - Layers to offload to GPU (auto-detected if not specified)
  parallelRequests?: number;  // Optional - Concurrent request slots (default: 4)
  flashAttention?: boolean;   // Optional - Enable flash attention (default: false)
  forceValidation?: boolean;  // Optional - Force re-validation of binary even if cached (default: false)
}
```

**Auto-Configuration**:
When `threads` and `gpuLayers` are not specified, the library:
1. Detects system capabilities via `systemInfo.detect()`
2. Gets model information (layer count) from GGUF metadata
3. Calculates optimal settings based on available resources
4. Applies configuration automatically

**Manual Configuration**:
Specify exact values to override auto-configuration. Useful for:
- Testing different configurations
- Resource-constrained systems
- Custom performance tuning

---

## Status and Health

### getStatus()

Gets current server status as a simple string (synchronous).

**Signature**:
```typescript
getStatus(): ServerStatus
```

**Returns**: `ServerStatus` - Current server state

**Possible Values**:
- `'stopped'` - Server is not running
- `'starting'` - Server is starting up
- `'running'` - Server is running
- `'stopping'` - Server is shutting down
- `'crashed'` - Server has crashed unexpectedly

**Example**:
```typescript
const status = llamaServer.getStatus();
console.log('Server Status:', status);

if (status === 'running') {
  console.log('✅ Server is running');
} else if (status === 'crashed') {
  console.error('❌ Server has crashed');
}
```

---

### getInfo()

Gets detailed server information including status, health, PID, and more (synchronous).

**Signature**:
```typescript
getInfo(): ServerInfo
```

**Returns**: `ServerInfo` - Complete server state

**Example**:
```typescript
const info = llamaServer.getInfo();

console.log('Server Status:', info.status);
console.log('Health:', info.health);

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

### isHealthy()

Checks if the server is responding to health checks (asynchronous).

**Signature**:
```typescript
isHealthy(): Promise<boolean>
```

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

### getHealthStatus()

Gets detailed health status of the server.

**Signature**:
```typescript
getHealthStatus(): Promise<HealthStatus>
```

**Returns**: `Promise<HealthStatus>` - Health status

**Possible Values**:
- `'ok'` - Server is fully operational
- `'loading'` - Server is still loading the model
- `'error'` - Server has encountered an error
- `'unknown'` - Server health status is unknown

**Example**:
```typescript
const healthStatus = await llamaServer.getHealthStatus();
console.log('Health status:', healthStatus);

if (healthStatus === 'ok') {
  console.log('✅ Server is fully operational');
} else if (healthStatus === 'loading') {
  console.log('⏳ Server is still loading the model');
} else if (healthStatus === 'error') {
  console.error('❌ Server has encountered an error');
} else {
  console.log('❓ Server health status is unknown');
}
```

---

## Logs

### getLogs()

Gets recent server logs as raw strings.

**Signature**:
```typescript
getLogs(lines?: number): Promise<string[]>
```

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

---

### getStructuredLogs()

Gets recent server logs as structured objects with parsed timestamps, levels, and messages.

This method parses raw log strings into structured `LogEntry` objects, making it easier to filter, format, and display logs in your application. Use this instead of `getLogs()` when you need programmatic access to log components.

**Signature**:
```typescript
getStructuredLogs(lines?: number): Promise<LogEntry[]>
```

**Parameters**:
- `lines?: number` - Optional - Number of lines to retrieve (default: 100)

**Returns**: `Promise<LogEntry[]>` - Array of structured log entries

**LogEntry Interface**:
```typescript
interface LogEntry {
  timestamp: string;  // ISO 8601 timestamp
  level: string;      // 'info', 'warn', 'error', 'debug', etc.
  message: string;    // Log message content
}
```

**Example**:
```typescript
// Get last 50 logs as structured objects
const logs = await llamaServer.getStructuredLogs(50);

// Filter by log level
const errors = logs.filter(entry => entry.level === 'error');
console.log(`Found ${errors.length} errors`);

// Format for display
logs.forEach(entry => {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  console.log(`[${time}] ${entry.level.toUpperCase()}: ${entry.message}`);
});

// Search for specific messages
const modelLogs = logs.filter(entry => entry.message.includes('model'));
console.log('Model-related logs:', modelLogs);
```

**Fallback Handling**:
If a log line cannot be parsed (malformed format), a fallback entry is created with:
- `timestamp`: Current time
- `level`: 'info'
- `message`: The original unparsed line

This ensures all logs are accessible even if formatting is inconsistent.

---

## Events

The `LlamaServerManager` extends `EventEmitter` and emits lifecycle events.

### 'started'

Emitted when server starts successfully.

```typescript
llamaServer.on('started', () => {
  console.log('Server started successfully');
});
```

### 'stopped'

Emitted when server stops.

```typescript
llamaServer.on('stopped', () => {
  console.log('Server stopped');
});
```

### 'crashed'

Emitted when server crashes unexpectedly.

```typescript
llamaServer.on('crashed', (error: Error) => {
  console.error('Server crashed:', error.message);
  // Auto-restart in Phase 4
});
```

### 'binary-log'

Emitted during binary download and variant testing.

```typescript
llamaServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
  console.log(`[${data.level.toUpperCase()}] ${data.message}`);
});
```

### Complete Event Handling Example

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
      // Restart by stopping and starting again
      const previousConfig = llamaServer.getConfig();
      if (previousConfig) {
        await llamaServer.stop();
        await llamaServer.start(previousConfig);
        console.log('✅ Server restarted successfully');
      }
    } catch (restartError) {
      console.error('❌ Failed to restart:', restartError);
    }
  }, 5000);
});

// Start server
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## Binary Management

genai-electron automatically downloads and manages llama-server binaries:

**First Start**:
1. Downloads appropriate binary for your platform (~50-100MB)
2. Tests GPU variants in priority order:
   - CUDA (NVIDIA)
   - Vulkan (cross-platform)
   - CPU (fallback)
3. Runs real functionality test (generates 1 token with GPU)
4. Falls back to next variant if test fails
5. Caches working variant

**Subsequent Starts**:
1. Verifies binary checksum (fast, ~0.5s)
2. Uses cached validation results
3. Skips expensive Phase 1 & 2 tests

**Force Validation**:
After GPU driver updates, force re-validation:
```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true  // Re-run all tests
});
```

**Binary Location**: `app.getPath('userData')/binaries/llama/`

---

## Reasoning Model Support

genai-electron automatically detects reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS) and injects the required flags:

**Automatic Flag Injection**:
When starting a server with a reasoning model, llama-server is launched with:
```bash
--jinja --reasoning-format deepseek
```

This enables extraction of reasoning content from `<think>...</think>` tags.

**Example**:
```typescript
// Download a reasoning model
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'bartowski/Qwen3-8B-Instruct-GGUF',
  file: 'Qwen3-8B-Instruct-Q4_K_M.gguf',
  name: 'Qwen3 8B',
  type: 'llm'
});

// Check if model supports reasoning
const modelInfo = await modelManager.getModelInfo('qwen3-8b');
console.log('Supports reasoning:', modelInfo.supportsReasoning); // true

// Start server - flags automatically added
await llamaServer.start({
  modelId: 'qwen3-8b',
  port: 8080
});

// Use with genai-lite to access reasoning traces
import { LLMService } from 'genai-lite';
const llmService = new LLMService(async () => 'not-needed');

const response = await llmService.sendMessage({
  providerId: 'llamacpp',
  modelId: 'qwen3-8b',
  messages: [{ role: 'user', content: 'Solve this problem step by step...' }],
  settings: { reasoning: true }
});

if (response.object === 'chat.completion' && response.choices[0].message.reasoning) {
  console.log('Reasoning trace:', response.choices[0].message.reasoning);
  console.log('Final answer:', response.choices[0].message.content);
}
```

---

## Error Handling

```typescript
try {
  await llamaServer.start(config);
} catch (error) {
  if (error instanceof ModelNotFoundError) {
    console.error('Model not found:', error.message);
  } else if (error instanceof ServerError) {
    console.error('Server failed to start:', error.message);
  } else if (error instanceof PortInUseError) {
    console.error('Port already in use:', error.message);
    console.log('Try using a different port or stop the conflicting service');
  } else if (error instanceof InsufficientResourcesError) {
    console.error('Not enough RAM/VRAM:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof BinaryError) {
    console.error('Binary execution failed:', error.message);
    console.log('All GPU variants failed, check binary-log events for details');
  }
}
```

---

## Examples

### Complete LLM Server Workflow

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { systemInfo, modelManager, llamaServer, attachAppLifecycle } from 'genai-electron';

async function setupLLMServer() {
  // 1. Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System:', {
    cpu: `${capabilities.cpu.cores} cores`,
    ram: `${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? capabilities.gpu.name : 'none'
  });

  // 2. List available models
  const models = await modelManager.listModels('llm');
  if (models.length === 0) {
    console.log('No models installed. Download one first.');
    return;
  }

  const firstModel = models[0];
  console.log(`Using model: ${firstModel.name}`);

  // 3. Start server with auto-configuration
  await llamaServer.start({
    modelId: firstModel.id,
    port: 8080
  });

  console.log('Server started on port 8080');

  // 4. Wait for server to be ready
  let retries = 0;
  while (!(await llamaServer.isHealthy()) && retries < 10) {
    console.log('Waiting for server to load model...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    retries++;
  }

  if (await llamaServer.isHealthy()) {
    console.log('✅ Server is ready!');

    // 5. Use with genai-lite
    const llmService = new LLMService(async () => 'not-needed');
    const response = await llmService.sendMessage({
      providerId: 'llamacpp',
      modelId: firstModel.id,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' }
      ]
    });

    if (response.object === 'chat.completion') {
      console.log('Response:', response.choices[0].message.content);
    }
  } else {
    console.error('❌ Server failed to become healthy');
  }
}

app.whenReady().then(setupLLMServer).catch(console.error);

// Automatic cleanup on app quit
attachAppLifecycle(app, { llamaServer });
```

---

## What's Next?

- **[Model Management](model-management.md)** - Download models to use with the server
- **[System Detection](system-detection.md)** - Understand auto-configuration
- **[Integration Guide](integration-guide.md)** - Electron-specific patterns
- **[TypeScript Reference](typescript-reference.md)** - LlamaServerConfig, ServerInfo, and related types
