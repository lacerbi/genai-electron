# Troubleshooting

Common issues and solutions for genai-electron. Focus on non-obvious problems with actionable solutions.

## Navigation

- [Binary Validation Failures](#binary-validation-failures)
- [HTTP API Errors](#http-api-errors)
- [Memory & Resources](#memory--resources)
- [Model Issues](#model-issues)
- [Initialization & Cache Issues](#initialization--cache-issues)
- [Connection Issues](#connection-issues)
- [FAQ](#faq)
- [Additional Utilities](#additional-utilities)

---

## Binary Validation Failures

### CUDA Errors with Automatic Fallback

**Problem:** `BinaryError: CUDA error detected in validation output`

**Solution:** Binary manager automatically tries variants in priority order: CUDA → Vulkan → CPU. If CUDA fails, Vulkan or CPU will be used automatically.

After updating GPU drivers, use `forceValidation: true` to re-run validation tests:

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true  // Re-run Phase 1 & 2 tests after driver update
});
```

**Why this matters:** Binary validation is cached (checksum-based) for fast subsequent starts. After GPU driver updates, the cached validation may be stale even though the checksum matches.

### CUDA + `--offload-to-cpu` Crash

**Problem:** Diffusion generation crashes silently when using CUDA backend with `--offload-to-cpu` (sd.cpp build `master-504-636d3cb`).

**Solution:** Auto-detection disables `--offload-to-cpu` for CUDA variants automatically. If you set `offloadToCpu: true` manually and generation fails silently, try `offloadToCpu: false`.

### Missing Shared Libraries

**Problem:** `BinaryError: error while loading shared libraries`

**Solution:**

```bash
# Linux: Install common dependencies
sudo apt-get update
sudo apt-get install libgomp1 libstdc++6

# Windows: Install Visual C++ Redistributable
# macOS: Usually not needed
```

### Monitor Binary Validation

```typescript
llamaServer.on('binary-log', (data) => {
  console.log(`[${data.level}] ${data.message}`);
});

// Watch for validation progress and errors
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## HTTP API Errors

### Error Codes Table

| Code | Description | Solution |
|------|-------------|----------|
| `SERVER_BUSY` | Server processing another generation | Wait for current generation to complete |
| `NOT_FOUND` | Generation ID not found | ID invalid or result expired (TTL) |
| `INVALID_REQUEST` | Invalid parameters | Check prompt, count (1-5) |
| `BACKEND_ERROR` | Backend processing failed | Check logs, model may be corrupt |
| `IO_ERROR` | File I/O error | Check disk space and permissions |

### Generation Not Found (TTL Expired)

**Problem:** `NOT_FOUND` error when polling for results

**Solution:** Results expire after TTL (default: 5 minutes). Poll more frequently or increase TTL:

```bash
# Set longer TTL (10 minutes)
export IMAGE_RESULT_TTL_MS=600000

# Restart diffusion server for changes to take effect
```

### Polling Frequency

**Recommendation:** Poll every 1 second. Polling too slowly (>5 seconds) increases risk of results expiring before retrieval.

```typescript
// Good polling frequency
await new Promise(resolve => setTimeout(resolve, 1000));

// Too slow - results may expire
await new Promise(resolve => setTimeout(resolve, 10000));
```

---

## Memory & Resources

### canRunModel Memory Modes

**Problem:** Confusing when to use `checkTotalMemory` option

**Solution:** Use different modes for different server types:

```typescript
// LLM servers: Check available memory (default)
// Models load at startup, need RAM available NOW
const llmCheck = await systemInfo.canRunModel(llmModelInfo);

// Diffusion servers: Check total memory
// Models load on-demand, ResourceOrchestrator will free memory
const diffusionCheck = await systemInfo.canRunModel(
  diffusionModelInfo,
  { checkTotalMemory: true }
);
```

**Why this matters:** Diffusion models are loaded on-demand. If you check available memory, it may fail even though ResourceOrchestrator can free memory by offloading LLM.

### Resource Orchestration Pattern

**Problem:** Both LLM and image generation running out of RAM/VRAM

**Solution:** Use ResourceOrchestrator for automatic LLM offload/reload:

```typescript
import { ResourceOrchestrator } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// Automatically offloads LLM if needed, then reloads after generation
await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape',
  steps: 30
});
```

### Batch Generation Limitation (Phase 3)

**Problem:** Generating multiple images (`count > 1`) doesn't trigger automatic LLM offload

**Workaround:** Use `count: 1` for now, or manually orchestrate. Batch orchestration planned for Phase 3.

```typescript
// Current limitation: orchestration bypassed for batch
const result = await diffusionServer.generateImage({
  prompt: 'A landscape',
  count: 3  // LLM won't be offloaded automatically
});
```

---

## Model Issues

### Multi-Component Model Issues

**Wrong VAE for Flux 2**
- **Symptom:** Tensor shape mismatch or silent failure during generation
- **Cause:** Using Flux 1 `ae.safetensors` (16 latent channels) instead of Flux 2 `flux2-vae.safetensors` (32 latent channels)
- **Fix:** Download the Flux 2 VAE from `Comfy-Org/flux2-dev` → `split_files/vae/flux2-vae.safetensors`

**Component Checksum Mismatch**
- **Symptom:** `ChecksumError: SHA256 checksum mismatch for component: llm`
- **Cause:** Corrupted or incomplete component download
- **Fix:** Delete the model with `modelManager.deleteModel(modelId)` and re-download

**Partial Download Cleanup**
- If a multi-component download fails mid-way, all already-downloaded component files are automatically cleaned up. Re-run `downloadModel()` to start fresh.

**"Model too large" with Multi-Component Models**
- The `canRunModel()` check uses the aggregate size of all components, which may be conservative when `--offload-to-cpu` is available
- Try setting `offloadToCpu: true` in the server config to enable CPU offloading (note: crashes on CUDA backend in sd.cpp `master-504-636d3cb`)

### Reasoning Not Extracted

**Problem:** Reasoning-capable model doesn't extract `<think>...</think>` tags

**Check:** Model has `supportsReasoning: true` (auto-set during download for Qwen3, DeepSeek-R1, GPT-OSS):

```typescript
const modelInfo = await modelManager.getModelInfo('qwen3-8b');
console.log('Supports reasoning:', modelInfo.supportsReasoning);

// If false, reasoning flags won't be added to llama-server
```

**Manual override:** Start llama-server manually with reasoning flags:

```bash
llama-server -m model.gguf --jinja --reasoning-format deepseek --port 8080
```

Then connect with genai-lite using `LLAMACPP_API_BASE_URL`.

### Checksum Mismatch

**Problem:** `ChecksumError: Checksum verification failed`

**Solution:** File corrupted during download. Delete and re-download:

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof ChecksumError) {
    console.log('File corrupted, re-downloading...');
    await modelManager.deleteModel(modelId);
    await modelManager.downloadModel(config);
  }
}
```

---

## Initialization & Cache Issues

### Library Called Before Electron Ready

**Problem:** `Error: Cannot call app.getPath() before app is ready`

**Cause:** genai-electron depends on Electron's `app.getPath('userData')` for model and binary storage. If you import and use the library before Electron's 'ready' event, it will crash.

**Solution:** Always initialize after `app.whenReady()`:

```typescript
// ❌ BAD: Called too early
import { modelManager } from 'genai-electron';
await modelManager.listModels(); // CRASH!

// ✅ GOOD: Wait for ready event
import { app } from 'electron';
import { modelManager } from 'genai-electron';

app.whenReady().then(async () => {
  const models = await modelManager.listModels(); // Works!
}).catch(console.error);
```

**Why this matters:** Common beginner mistake with a cryptic error message. The library needs `userData` path to function, which is only available after app initialization completes.

### SystemInfo Memory Cache Staleness

**Problem:** After loading a server, `systemInfo.detect()` may return stale memory data for up to 60 seconds, causing false "insufficient RAM" errors when loading additional models.

**Real-world scenario:**
1. Load 6GB LLM server → consumes RAM
2. Try to load diffusion model immediately
3. `canRunModel()` checks memory using cached data (shows OLD available memory)
4. Reports "insufficient RAM" even though enough RAM is actually available

**Cause:** `SystemInfo.detect()` caches results for 60 seconds for performance. The library automatically invalidates cache on server start/stop, BUT direct calls to `detect()` use cached data.

**Solution:** Use `detect(forceRefresh: true)` when you need real-time memory after server state changes:

```typescript
// After loading LLM server, memory consumed but cache may be stale
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// ❌ POTENTIALLY STALE: Uses cached memory (up to 60s old)
const caps1 = await systemInfo.detect();
console.log('Available RAM:', (caps1.memory.available / 1024 ** 3).toFixed(1), 'GB');

// ✅ ALWAYS FRESH: Force refresh for accurate real-time memory
const caps2 = await systemInfo.detect(true);
console.log('Available RAM:', (caps2.memory.available / 1024 ** 3).toFixed(1), 'GB');

// ✅ AUTOMATIC: Library methods invalidate cache automatically
const check = await systemInfo.canRunModel(diffusionModelInfo); // Uses fresh memory
```

**Automatic cache invalidation:** The library automatically clears cache on:
- `llamaServer.start()` completion
- `llamaServer.stop()` completion
- `diffusionServer.start()` completion
- `diffusionServer.stop()` completion

**When to force refresh:**
- When checking memory between rapid server operations
- After external processes consume significant memory
- When displaying real-time memory in UI (but consider using `getMemoryInfo()` instead, which never caches)

**Alternative for real-time memory:** Use `systemInfo.getMemoryInfo()` which always returns fresh data:

```typescript
// Always real-time, never cached (but no GPU/CPU/recommendations)
const memory = systemInfo.getMemoryInfo();
console.log('Available:', (memory.available / 1024 ** 3).toFixed(1), 'GB');
console.log('Used:', (memory.used / 1024 ** 3).toFixed(1), 'GB');
console.log('Total:', (memory.total / 1024 ** 3).toFixed(1), 'GB');
```

---

## Connection Issues

### Port Already in Use

**Problem:** `PortInUseError: Port 8080 is already in use`

**Solution:** Stop conflicting application or use different port:

```typescript
// Use alternative port
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8081  // Instead of 8080
});
```

**Find what's using the port:**
```bash
# macOS/Linux
lsof -i :8080

# Windows
netstat -ano | findstr :8080
```

### Health Check Timeout

**Problem:** Server takes long to load model, `isHealthy()` returns false

**Solution:** Poll until ready with retry logic:

```typescript
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Poll until healthy (up to 30 seconds)
let retries = 0;
while (!(await llamaServer.isHealthy()) && retries < 30) {
  console.log('Waiting for model to load...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  retries++;
}

if (await llamaServer.isHealthy()) {
  console.log('✅ Server is ready');
} else {
  console.error('❌ Server failed to become healthy');
  const logs = await llamaServer.getLogs(50);
  console.log('Recent logs:', logs);
}
```

**Why this matters:** Large models can take 10-30 seconds to load, especially on CPU-only systems.

---

## FAQ

### Can I use custom llama.cpp builds?

**Yes!** Set `LLAMACPP_API_BASE_URL` environment variable:

```bash
export LLAMACPP_API_BASE_URL=http://localhost:9000

# Start your custom llama-server
llama-server -m model.gguf --port 9000

# Then use genai-lite - it will connect to your custom server
```

### How to disable GPU?

Set `gpuLayers: 0` to force CPU-only mode:

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  gpuLayers: 0  // Force CPU-only
});
```

### How to enable embeddings with llama.cpp?

Start llama-server manually with `--embeddings` flag:

```bash
llama-server -m model.gguf --port 8080 --embeddings
```

Then connect with genai-lite using `LLAMACPP_API_BASE_URL`.

---

## Additional Utilities

genai-electron exports additional utilities for advanced use cases:

**Platform Detection**:
```typescript
import {
  getPlatform,      // 'darwin' | 'win32' | 'linux'
  getArchitecture,  // 'x64' | 'arm64'
  getPlatformKey,   // 'darwin-arm64', etc.
  isMac, isWindows, isLinux, isAppleSilicon
} from 'genai-electron';
```

**File Utilities**:
```typescript
import {
  calculateChecksum,  // SHA256 checksum
  formatBytes,        // Human-readable sizes
  fileExists,         // Check file existence
  ensureDirectory,    // Create directory if needed
  sanitizeFilename    // Safe filenames
} from 'genai-electron';
```

These are low-level utilities used internally. Most applications won't need them directly.

---

## See Also

- [Installation and Setup](installation-and-setup.md) - Requirements and setup
- [System Detection](system-detection.md) - Hardware capability checking
- [LLM Server](llm-server.md) - Server configuration and logs
- [Image Generation](image-generation.md) - HTTP API and error codes
- [Integration Guide](integration-guide.md) - Error handling patterns
