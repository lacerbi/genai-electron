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
  - [Log Rotation](#log-rotation)
- [Events](#events)
- [Process Reliability](#process-reliability)
  - [Crash Auto-Restart](#crash-auto-restart)
  - [Hang Watchdog](#hang-watchdog)
  - [Occupancy Safety Rail](#occupancy-safety-rail)
  - [Load-Time Metric](#load-time-metric)
- [Binary Management](#binary-management)
- [Reasoning Model Support](#reasoning-model-support)
- [Error Handling](#error-handling)
- [Complete Example](#complete-example)

---

## Overview

LlamaServerManager manages llama-server processes with automatic binary download (platform-specific variant testing), auto-configuration, health monitoring, and reasoning model flag injection.

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
  // port omitted → defaults to 8080; pass 'auto' to bind a free OS-assigned port
  threads: 8,
  gpuLayers: 35,
  contextSize: 8192,
  parallelRequests: 1,      // Use 1 for single-user apps (default, see note below)
  flashAttention: 'auto',   // 'on' | 'off' | 'auto' (default: let the server decide)
  cacheTypeK: 'q8_0'        // quantize the K cache to save VRAM on long contexts
});
```

**Throws**:
- `ModelNotFoundError` - Model doesn't exist
- `ServerError` - Server failed to start
- `PortInUseError` - Port already in use
- `InsufficientResourcesError` - Not enough RAM/VRAM
- `BinaryError` - Binary download or execution failed (all variants failed)

**Note**: `start()` accepts a `LlamaServerConfig`. All of its fields (e.g., `modelAlias`, `continuousBatching`, `cacheTypeK`, `overrideTensors`) are applied as llama-server CLI flags at launch. See [Binary Management](#binary-management) for details on automatic download, variant testing, and validation caching.

**Health Check Behavior**: After spawning llama-server, `start()` waits for the health endpoint to respond with 'ok' status. Uses exponential backoff: starts at 100ms intervals, multiplies by 1.5 after each attempt, caps at 2s intervals. Default timeout is 120 seconds (2 minutes), configurable per start via `startupTimeout`. Cold loads of large GGUFs on slow disks may need a higher value.

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

**LlamaServerConfig** (extends `ServerConfig`):

```typescript
interface LlamaServerConfig extends ServerConfig {
  // Inherited from ServerConfig:
  modelId: string;                 // Required - Model ID to load
  port?: number | 'auto';          // Optional - Port to listen on (default: 8080; 'auto' picks a free OS port)
  threads?: number;                // Optional - CPU threads (auto-detected if not specified)
  contextSize?: number;            // Optional - Context window size (default: 4096)
  gpuLayers?: number;              // Optional - Layers to offload to GPU (auto-detected if not specified)
  parallelRequests?: number;       // Optional - Concurrent request slots (default: 1)
  flashAttention?: FlashAttentionSetting; // Optional - 'on' | 'off' | 'auto' (boolean accepted: true→'on', false→'off'). Default: unset → server decides
  host?: string;                   // Optional - Interface to bind (--host). Default: unset → llama-server default (127.0.0.1, loopback only)
  forceValidation?: boolean;       // Optional - Force re-validation of binary (default: false)
  startupTimeout?: number;         // Optional - Max ms to wait for health after spawn (default: 120000)

  // LlamaServerConfig-specific:
  modelAlias?: string;             // Optional - API model alias (--alias). WARNING: masks the GGUF filename that genai-lite uses for family/reasoning detection — leave unset unless needed
  continuousBatching?: boolean;    // Optional - Set false → --no-cont-batching (server default: enabled)
  batchSize?: number;              // Optional - Logical batch size (-b)
  useMmap?: boolean;               // Optional - Set false → --no-mmap (server default: enabled)
  useMlock?: boolean;              // Optional - Set true → --mlock (lock model in memory)
  jinja?: boolean;                 // Optional - Use the model's Jinja chat template (--jinja). Default: true; false → --no-jinja
  cacheTypeK?: KVCacheType;        // Optional - KV-cache quantization for keys (--cache-type-k). Default: unset (f16)
  cacheTypeV?: KVCacheType;        // Optional - KV-cache quantization for values (--cache-type-v). Quantized V auto-upgrades flash attention to 'on'; throws if flashAttention is explicitly 'off'/false
  overrideTensors?: string;        // Optional - Tensor buffer-type overrides (-ot), e.g. 'exps=CPU' to keep MoE experts on CPU
  cacheRam?: number;               // Optional - Max CPU-side prompt/KV cache in MiB (--cache-ram). -1 = no limit, 0 = disable
  cpuMoe?: boolean;                // Optional - Keep ALL MoE expert weights on CPU (--cpu-moe)
  nCpuMoe?: number;                // Optional - Keep the first N layers' MoE experts on CPU (--n-cpu-moe)
  reasoningFormat?: 'auto' | 'deepseek' | 'deepseek-legacy' | 'none'; // Optional - Reasoning extraction format (--reasoning-format). Default: unset → server default ('auto')
  fit?: 'on' | 'off';              // Optional - Delegate sizing to llama-server (-fit). Default: 'off'; 'on' skips genai-electron's gpuLayers/contextSize auto-config
  occupancyCheck?: 'warn' | 'strict' | 'off'; // Optional - Cross-app VRAM double-load guard (default: 'warn')
  autoRestart?: boolean;           // Optional - Auto-restart after an unexpected crash (default: false)
  maxRestarts?: number;            // Optional - Max consecutive auto-restart attempts (default: 3)
  healthCheckInterval?: number;    // Optional - Hang-watchdog poll interval in ms (default: disabled)
}
```

`KVCacheType` is `'f16' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'iq4_nl'`, and `FlashAttentionSetting` is `boolean | 'on' | 'off' | 'auto'`. See [TypeScript Reference](typescript-reference.md) for the full definitions.

When `threads` and `gpuLayers` are not specified, the library auto-configures based on system capabilities and model metadata.

**About `port` and `'auto'`:**
`port` is optional and defaults to 8080. Pass `'auto'` to have the OS assign a free port — useful when 8080 may already be taken. The resolved numeric port is reported on `ServerInfo.port` (from `getInfo()`) and on `getPort()`. Reliability features such as auto-restart reuse the resolved port rather than re-running `'auto'`.

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
console.log('Health:', info.health); // Note: always 'unknown' — use getHealthStatus() for real health
console.log('PID:', info.pid);
console.log('Port:', info.port);           // resolved numeric port (even when started with 'auto')
console.log('Load time (ms):', info.loadTimeMs); // spawn → healthy duration of the last start
```

**Note**: The `health` field in `ServerInfo` always returns `'unknown'` because health checks are asynchronous. For real-time health status, use `getHealthStatus()` instead.

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

**Health Endpoint**: The library checks `http://127.0.0.1:{port}/health` (loopback rather than `localhost` to avoid the Windows IPv6 resolution penalty), which returns a JSON response with a `status` field ('ok', 'loading', 'error', or 'unknown'). When a custom `host` is configured, health checks target that host instead; wildcard binds (`0.0.0.0` / `::`) are probed via `127.0.0.1`.

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

### Additional Methods (inherited from ServerManager)

These methods are inherited from the `ServerManager` base class:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getPort()` | `number` | Returns the configured port |
| `getPid()` | `number \| undefined` | Returns the process PID if running |
| `isRunning()` | `boolean` | `true` if status is `'running'` |
| `isStopped()` | `boolean` | `true` if status is `'stopped'` |
| `isStarting()` | `boolean` | `true` if status is `'starting'` |
| `isStopping()` | `boolean` | `true` if status is `'stopping'` |
| `hasCrashed()` | `boolean` | `true` if status is `'crashed'` |
| `getConfig()` | `ServerConfig \| undefined` | Returns the current server config |
| `clearLogs()` | `Promise<void>` | Clears all server logs |
| `getLogPath()` | `string \| undefined` | Returns the log file path |

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

### Log Rotation

Server logs are rotated by size so a long-running server never fills the disk. By default the active log rotates once it exceeds **5 MB**, keeping **2** archives (`server.log.1`, `server.log.2`); the oldest is dropped as newer ones shift up. Rotation is best-effort — a rotation failure never takes the server down.

Rotation is configured at the `LogManager` level via `LogRotationOptions` (`maxFileSize`, `maxArchives`); the defaults come from `DEFAULT_LOG_ROTATION`. With `maxArchives: 0` the active log is truncated in place instead of archived. See [TypeScript Reference](typescript-reference.md) for `LogRotationOptions`.

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
llamaServer.on('crashed', (data: { code: number | null; signal: NodeJS.Signals | null }) => {
  console.error('Server crashed with code:', data.code, 'signal:', data.signal);
});
```

### 'restarted'

Emitted when the server comes back up after a crash auto-restart. The listener receives the new `ServerInfo`. See [Crash Auto-Restart](#crash-auto-restart) for the full event ordering.

```typescript
llamaServer.on('restarted', (info: ServerInfo) => {
  console.log('Server restarted on port', info.port);
});
```

### 'health-check-ok' / 'health-check-failed'

Emitted by the optional [hang watchdog](#hang-watchdog) on each poll while the server is running (only when `healthCheckInterval` is set). `'health-check-ok'` receives the current `ServerInfo`; `'health-check-failed'` receives `{ consecutiveFailures, serverInfo }`.

```typescript
llamaServer.on('health-check-ok', (info: ServerInfo) => {
  console.log('Health OK on port', info.port);
});
llamaServer.on('health-check-failed', (data: { consecutiveFailures: number; serverInfo: ServerInfo }) => {
  console.warn('Health check failed:', data.consecutiveFailures);
});
```

### 'status'

Emitted when server status changes. Receives the new and old status.

```typescript
llamaServer.on('status', (newStatus: ServerStatus, oldStatus: ServerStatus) => {
  console.log(`Status changed: ${oldStatus} → ${newStatus}`);
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
llamaServer.on('crashed', (data) => {
  console.error('💥 Server crashed with exit code:', data.code, 'signal:', data.signal);
  // Implement custom restart logic if needed
});

await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## Process Reliability

Beyond basic start/stop, `LlamaServerManager` offers opt-in features for keeping a long-lived server healthy: crash auto-restart, a hang watchdog, and a cross-app occupancy safety rail. Each is configured through `LlamaServerConfig` and is off (or non-fatal) by default.

### Crash Auto-Restart

Set `autoRestart: true` to have the manager relaunch the server after an **unexpected** exit (a non-zero exit code, or a hang killed by the watchdog). Restarts are bounded:

- **Backoff**: attempts are scheduled with exponential backoff — 1s, 2s, 4s, ... — never inline from the exit handler.
- **Budget**: up to `maxRestarts` consecutive attempts (default: 3). Once the budget is exhausted the server stays `'crashed'`. The counter resets on the next manual `start()`.
- **Resolved config reuse**: a restart reuses the previously *resolved* configuration, including the concrete port — a server started with `port: 'auto'` keeps the port it was assigned rather than picking a new one.
- **Intentional stop never restarts**: calling `stop()` cancels any pending restart and is never treated as a crash.

**Event order** for a successful auto-restart is `'crashed'` → `'started'` → `'restarted'` (`'started'` fires from the internal `start()`; `'restarted'` fires once it resolves).

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  autoRestart: true,
  maxRestarts: 5
});

llamaServer.on('crashed', (data) => console.warn('Crashed with code:', data.code));
llamaServer.on('restarted', (info) => console.log('Back up on port', info.port));
```

### Hang Watchdog

A crashed process is easy to detect; a *hung* one that stops answering requests is not. Set `healthCheckInterval` (milliseconds) to poll the health endpoint on a timer while the server is running (default: disabled).

- Each tick emits `'health-check-ok'` or `'health-check-failed'`.
- After **3 consecutive failures** the process is killed. When `autoRestart` is enabled, that kill is treated as a crash and feeds the auto-restart flow.

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  healthCheckInterval: 10000,  // poll every 10s
  autoRestart: true            // restart if the watchdog kills a hung process
});
```

### Occupancy Safety Rail

Before starting, the manager can probe common llama-server ports (8080–8083) for *another* llama-server that could double-load VRAM. Candidate ports are fingerprinted with a `GET /props` request — an endpoint the diffusion HTTP wrapper does not serve — so this app's own diffusion server (default port 8081) is never flagged.

Controlled by `occupancyCheck`:

- `'warn'` (default): log a warning and continue.
- `'strict'`: throw a `ServerError` instead of starting.
- `'off'`: skip the probe entirely.

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  occupancyCheck: 'strict'  // refuse to start if another llama-server is already up
});
```

### Load-Time Metric

After a successful start, `ServerInfo.loadTimeMs` reports how long the last start took, measured spawn → healthy (llama-server only; `undefined` before the first successful start). It is available from `getInfo()` and in the `ServerInfo` carried by the `'started'` event.

```typescript
const info = llamaServer.getInfo();
console.log(`Model loaded in ${info.loadTimeMs} ms`);
```

---

## Binary Management

genai-electron automatically downloads and manages llama-server binaries:

**Pinned Version**: genai-electron pins a specific llama.cpp build (currently `b9860`). Binaries are cached and validated per version, so upgrading genai-electron to a release that bumps the pin re-downloads the binary on the next `start()` (~50–300 MB).

> **Linux + NVIDIA**: As of `b9860`, llama.cpp no longer publishes a prebuilt Linux x64 CUDA binary. On Linux, NVIDIA GPUs run through the Vulkan variant instead (the variant chain is Vulkan → CPU). For CUDA on Linux, build llama.cpp from source.

**First Start**:
1. Downloads appropriate binary for your platform (~50-100MB)
2. Tests GPU variants in platform-specific priority order (Windows: CUDA → Vulkan → CPU; Linux: Vulkan → CPU; macOS: Metal). CUDA variants are pre-filtered: only included if an NVIDIA GPU is detected.
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

llama-server launched by genai-electron passes `--jinja` **unconditionally** (unless you set `jinja: false`), which activates the model's embedded Jinja chat template. This is what makes template-driven features work — including `chat_template_kwargs` toggles such as genai-lite's reasoning switch on hybrid models — regardless of whether the model is "detected" as reasoning-capable.

Reasoning-content extraction then relies on llama-server's default `--reasoning-format auto`, which parses thoughts (e.g. `<think>...</think>`) into a separate `reasoning_content` field. genai-electron no longer forces a specific reasoning format.

**`supportsReasoning` is informational metadata only.** genai-electron still detects reasoning-capable model names (Qwen3, DeepSeek-R1, GPT-OSS) and records the result on `ModelInfo.supportsReasoning`, but this flag no longer changes the launch flags — it is provided for UI/labelling purposes.

**Overriding the format**: set `reasoningFormat` to change how thoughts are handled:

- `'auto'` (server default) — parse thoughts into `reasoning_content`.
- `'deepseek'` / `'deepseek-legacy'` — force DeepSeek-style `reasoning_content` parsing.
- `'none'` — leave thoughts inline in `message.content`.

```typescript
await llamaServer.start({
  modelId: 'qwen3-8b',
  reasoningFormat: 'none'  // keep <think> tags inline instead of extracting them
});
```

**Manual Detection** (advanced):
```typescript
import { detectReasoningSupport, REASONING_MODEL_PATTERNS } from 'genai-electron';

const supportsReasoning = detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf');
console.log('Supports reasoning:', supportsReasoning); // true

console.log('Known patterns:', REASONING_MODEL_PATTERNS);
// ['qwen3', 'deepseek-r1', 'gpt-oss']
```

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

// Informational only — does not change how the server is launched
const modelInfo = await modelManager.getModelInfo('qwen3-8b');
console.log('Supports reasoning:', modelInfo.supportsReasoning);

// Start server (--jinja is always passed; reasoning extraction uses the server default)
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
