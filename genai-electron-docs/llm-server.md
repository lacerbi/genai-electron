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
- [Complete Example](#complete-example)

---

## Overview

LlamaServerManager manages llama-server processes with automatic binary download (CUDA→Vulkan→CPU variant testing), auto-configuration, health monitoring, and reasoning model flag injection.

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

**Example**:
```typescript
// Auto-configuration (recommended)
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080
});

// Custom configuration
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  threads: 8,
  gpuLayers: 35,
  contextSize: 8192,
  parallelRequests: 1,  // Use 1 for single-user apps (default, see note below)
  flashAttention: true
});
```

**Throws**:
- `ModelNotFoundError` - Model doesn't exist
- `ServerError` - Server failed to start
- `PortInUseError` - Port already in use
- `InsufficientResourcesError` - Not enough RAM/VRAM
- `BinaryError` - Binary download or execution failed (all variants failed)

**Note**: See [Binary Management](#binary-management) for details on automatic download, variant testing, and validation caching.

**Health Check Behavior**: After spawning llama-server, `start()` waits for the health endpoint to respond with 'ok' status. Uses exponential backoff: starts at 100ms intervals, multiplies by 1.5 after each attempt, caps at 2s intervals. Default timeout is 60 seconds.

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
await llamaServer.stop();
const status = llamaServer.getStatus();
console.log('Status:', status);
```

**Behavior**:
1. Sends SIGTERM to process (graceful shutdown)
2. Waits up to 10 seconds for process to exit
3. Sends SIGKILL if still running (force kill)
4. Cleans up resources

---

### restart()

Convenience method to restart the server with the same configuration.

**Signature**:
```typescript
restart(): Promise<ServerInfo>
```

**Returns**: `Promise<ServerInfo>` - Server information after restart

**Example**:
```typescript
await llamaServer.restart();
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
  parallelRequests?: number;  // Optional - Concurrent request slots (default: 1)
  flashAttention?: boolean;   // Optional - Enable flash attention (default: false)
  forceValidation?: boolean;  // Optional - Force re-validation of binary (default: false)
}
```

When `threads` and `gpuLayers` are not specified, the library auto-configures based on system capabilities and model metadata.

**About `parallelRequests`:**
The KV cache is shared across all parallel request slots. With N slots and contextSize C, each slot gets approximately C/N tokens. For single-user Electron apps (interactive chat, writing assistance), use `parallelRequests: 1` (default) to avoid wasting context capacity. Only increase this for multi-user server deployments with concurrent requests.

**About Default Context Size:**
Currently defaults to 4096. We plan to introduce VRAM-aware dynamic context calculation as default.

---

## Status and Health

### getStatus()

Gets current server status as a simple string (synchronous).

**Signature**:
```typescript
getStatus(): ServerStatus
```

**Returns**: `ServerStatus` - Current server state

**Possible Values**: `'stopped'`, `'starting'`, `'running'`, `'stopping'`, `'crashed'`

**Example**:
```typescript
const status = llamaServer.getStatus();
if (status === 'running') {
  console.log('✅ Server is running');
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
console.log('Status:', info.status);
console.log('Health:', info.health);
console.log('PID:', info.pid);
console.log('Port:', info.port);
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
  console.log('✅ Server is healthy');
}
```

**Health Endpoint**: The library checks `http://localhost:{port}/health` which returns a JSON response with `status` field ('ok', 'loading', 'error', or 'unknown').

---

### getHealthStatus()

Gets detailed health status of the server.

**Signature**:
```typescript
getHealthStatus(): Promise<HealthStatus>
```

**Returns**: `Promise<HealthStatus>` - Health status

**Possible Values**: `'ok'`, `'loading'`, `'error'`, `'unknown'`

**Example**:
```typescript
const healthStatus = await llamaServer.getHealthStatus();
if (healthStatus === 'ok') {
  console.log('✅ Server is fully operational');
} else if (healthStatus === 'loading') {
  console.log('⏳ Server is still loading the model');
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
const logs = await llamaServer.getLogs();
logs.forEach(line => console.log(line));

const recent = await llamaServer.getLogs(50);
```

---

### getStructuredLogs()

Gets recent server logs as structured objects with parsed timestamps, levels, and messages.

Use this instead of `getLogs()` when you need programmatic access to log components for filtering or formatting.

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
const logs = await llamaServer.getStructuredLogs(50);

// Filter by log level
const errors = logs.filter(entry => entry.level === 'error');

// Format for display
logs.forEach(entry => {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  console.log(`[${time}] ${entry.level.toUpperCase()}: ${entry.message}`);
});
```

**Comparison**:
- **`getLogs()`**: Returns raw strings - Use when you want unprocessed log lines
- **`getStructuredLogs()`**: Returns parsed objects - Use when you need to filter, search, or format logs

**Fallback Handling**: If a log line cannot be parsed (malformed format), a fallback entry is created with current time, 'info' level, and the original unparsed line. This ensures all logs are accessible even if formatting is inconsistent.

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
});
```

### 'binary-log'

Emitted during binary download and variant testing.

```typescript
llamaServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
  console.log(`[${data.level.toUpperCase()}] ${data.message}`);
});
```

**Example**:
```typescript
llamaServer.on('started', () => console.log('✅ Server started'));
llamaServer.on('stopped', () => console.log('🛑 Server stopped'));
llamaServer.on('crashed', (error) => {
  console.error('💥 Server crashed:', error.message);
  // Implement custom restart logic if needed
});

await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## Binary Management

genai-electron automatically downloads and manages llama-server binaries:

**First Start**:
1. Downloads appropriate binary for your platform (~50-100MB)
2. Tests GPU variants in priority order: CUDA (NVIDIA) → Vulkan (cross-platform) → CPU (fallback)
3. Runs real functionality test: generates 1 token with GPU layers enabled (`-ngl 1`)
4. Verifies CUDA actually works (parses output for GPU errors: "CUDA error", "failed to allocate", etc.)
5. Falls back to next variant if test fails
6. Caches working variant and validation results

**Note**: Real functionality testing only runs if model is downloaded. If model doesn't exist yet, falls back to basic `--version` test. This means optimal variant selection happens automatically when you call `start()` with a valid model.

**Subsequent Starts**:
1. Verifies binary checksum (fast, ~0.5s)
2. Uses cached validation results
3. Skips expensive Phase 1 & 2 tests

**Binary Validation Caching**:

After the first successful validation, subsequent starts skip validation tests and only verify binary integrity via checksum (~0.5s instead of 2-10s):
- **First start**: Downloads binary → Runs Phase 1 & 2 tests → Saves validation cache
- **Subsequent starts**: Verifies checksum → Uses cached validation (fast startup)
- **Modified binary**: Checksum mismatch → Re-runs full validation
- **Force validation**: Use `forceValidation: true` to re-run tests

**Force Validation Example** (after GPU driver updates):
```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true
});
```

**Binary Location**: `app.getPath('userData')/binaries/llama/`

---

## Reasoning Model Support

genai-electron automatically detects reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS) and injects the required flags.

**Manual Detection** (advanced):
```typescript
import { detectReasoningSupport, REASONING_MODEL_PATTERNS } from 'genai-electron';

const supportsReasoning = detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf');
console.log('Supports reasoning:', supportsReasoning); // true

console.log('Known patterns:', REASONING_MODEL_PATTERNS);
// ['qwen3', 'deepseek-r1', 'gpt-oss']
```

**Automatic Flag Injection**: When starting a server with a reasoning model, llama-server is launched with:
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
console.log('Supports reasoning:', modelInfo.supportsReasoning);

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
  } else if (error instanceof InsufficientResourcesError) {
    console.error('Not enough RAM/VRAM:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof ServerError) {
    console.error('Server failed to start:', error.message);
  }
}
```

---

## Complete Example

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { systemInfo, modelManager, llamaServer, attachAppLifecycle } from 'genai-electron';

async function setupLLMServer() {
  const capabilities = await systemInfo.detect();
  console.log('System:', {
    cpu: `${capabilities.cpu.cores} cores`,
    ram: `${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? capabilities.gpu.name : 'none'
  });

  const models = await modelManager.listModels('llm');
  if (models.length === 0) {
    console.log('No models installed. Download one first.');
    return;
  }

  await llamaServer.start({
    modelId: models[0].id,
    port: 8080
  });

  let retries = 0;
  while (!(await llamaServer.isHealthy()) && retries < 10) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    retries++;
  }

  if (await llamaServer.isHealthy()) {
    const llmService = new LLMService(async () => 'not-needed');
    const response = await llmService.sendMessage({
      providerId: 'llamacpp',
      modelId: models[0].id,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' }
      ]
    });

    if (response.object === 'chat.completion') {
      console.log('Response:', response.choices[0].message.content);
    }
  }
}

app.whenReady().then(setupLLMServer).catch(console.error);
attachAppLifecycle(app, { llamaServer });
```

---

## What's Next?

- **[Model Management](model-management.md)** - Download models to use with the server
- **[System Detection](system-detection.md)** - Understand auto-configuration
- **[Integration Guide](integration-guide.md)** - Electron-specific patterns
- **[TypeScript Reference](typescript-reference.md)** - LlamaServerConfig, ServerInfo, and related types
