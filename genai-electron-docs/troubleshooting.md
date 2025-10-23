# Troubleshooting

Common issues and solutions for genai-electron. Covers installation problems, server startup failures, download issues, GPU detection, and more.

## Navigation

- [Installation Issues](#installation-issues)
- [Server Won't Start](#server-wont-start)
- [Download Fails](#download-fails)
- [GPU Not Detected](#gpu-not-detected)
- [Binary Validation Failures](#binary-validation-failures)
- [Model Compatibility](#model-compatibility)
- [Memory Errors](#memory-errors)
- [HTTP API Errors](#http-api-errors)
- [llama.cpp Connection Issues](#llamacpp-connection-issues)
- [FAQ](#faq)

---

## Installation Issues

### Electron Version Mismatch

**Problem:** `Error: Electron version not supported`

**Solution:** genai-electron requires Electron >=25.0.0

```bash
# Check your Electron version
npm list electron

# Upgrade if needed
npm install electron@latest
```

### Node.js Version

**Problem:** Build errors or runtime failures

**Solution:** Requires Node.js 22.x LTS

```bash
# Check Node version
node --version

# Install Node 22.x
# Visit https://nodejs.org/ or use nvm:
nvm install 22
nvm use 22
```

### Platform Compatibility

**Supported Platforms:**
- macOS 11+ (Intel and Apple Silicon)
- Windows 10+ (64-bit)
- Linux: Ubuntu 20.04+, Debian 11+, Fedora 35+

**Check:** Verify your OS meets minimum requirements

---

## Server Won't Start

### Model Not Selected

**Problem:** `ModelNotFoundError: Model 'undefined' not found`

**Solution:** Ensure model is downloaded and ID is correct

```typescript
// Check available models
const models = await modelManager.listModels('llm');
console.log('Available models:', models.map(m => m.id));

// Use correct model ID
await llamaServer.start({
  modelId: models[0].id,  // Use actual model ID
  port: 8080
});
```

### Insufficient RAM/VRAM

**Problem:** `InsufficientResourcesError: Not enough RAM to run model`

**Solution:** Check system capabilities and use smaller model or different quantization

```typescript
// Check available resources
const capabilities = await systemInfo.detect();
console.log('Available RAM:', (capabilities.memory.available / 1024 ** 3).toFixed(1), 'GB');

// Check if model can run
const modelInfo = await modelManager.getModelInfo('llama-2-13b');
const check = await systemInfo.canRunModel(modelInfo);

if (!check.possible) {
  console.log('Cannot run:', check.reason);
  console.log('Suggestion:', check.suggestion);
  // Try: Download smaller model (7B instead of 13B) or higher quantization (Q4 instead of Q5)
}
```

### Port Already in Use

**Problem:** `PortInUseError: Port 8080 is already in use`

**Solution:** Stop conflicting application or use different port

```typescript
// Try alternative port
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8081  // Instead of 8080
});

// Or find what's using the port
// macOS/Linux: lsof -i :8080
// Windows: netstat -ano | findstr :8080
```

### Check Logs for Errors

**Solution:** Examine server logs for specific error messages

```typescript
const logs = await llamaServer.getLogs(50);
logs.forEach(line => console.log(line));

// Or use structured logs
const structuredLogs = await llamaServer.getStructuredLogs(50);
const errors = structuredLogs.filter(e => e.level === 'error');
console.log('Errors:', errors);
```

---

## Download Fails

### Network Connectivity

**Problem:** `DownloadError: Failed to fetch`

**Solution:** Check internet connection and firewall settings

```bash
# Test connectivity to HuggingFace
curl -I https://huggingface.co

# Check if proxy is needed
# Set HTTP_PROXY and HTTPS_PROXY environment variables if required
```

### Insufficient Disk Space

**Problem:** `InsufficientResourcesError: Not enough disk space`

**Solution:** Free up disk space or change download location (Phase 4 feature)

```bash
# Check available disk space
# macOS/Linux: df -h
# Windows: dir

# Free up space by deleting unused models
const models = await modelManager.listModels();
await modelManager.deleteModel('unused-model-id');
```

### Invalid URL or HuggingFace Path

**Problem:** `DownloadError: 404 Not Found`

**Solution:** Verify URL or HuggingFace repo/file paths are correct

```typescript
// Correct HuggingFace format
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'TheBloke/Llama-2-7B-GGUF',  // Repository owner/name
  file: 'llama-2-7b.Q4_K_M.gguf',    // Exact filename
  name: 'Llama 2 7B',
  type: 'llm'
});

// For direct URLs, ensure full path including filename
await modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/path/to/model.gguf',  // Complete URL
  name: 'My Model',
  type: 'llm'
});
```

### Checksum Mismatch

**Problem:** `ChecksumError: Checksum verification failed`

**Solution:** File is corrupted, delete and re-download

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof ChecksumError) {
    console.log('File corrupted during download');
    // Delete partial file and retry
    await modelManager.deleteModel(modelId);
    await modelManager.downloadModel(config);
  }
}
```

---

## GPU Not Detected

### macOS (Metal)

**Problem:** `gpu.available: false` on Mac

**Solution:** Metal is automatic on macOS 11+ with 2016+ Macs

```typescript
const capabilities = await systemInfo.detect();
if (!capabilities.gpu.available) {
  console.log('Mac is too old for Metal support');
  console.log('Will use CPU-only mode');
}
```

### Windows/Linux NVIDIA

**Problem:** NVIDIA GPU not detected

**Solution:** Install latest NVIDIA drivers

```bash
# Check if nvidia-smi works
nvidia-smi

# If not found, install NVIDIA drivers:
# Windows: https://www.nvidia.com/Download/index.aspx
# Linux: sudo apt install nvidia-driver-XXX (replace XXX with version)
```

### Linux AMD (Experimental)

**Problem:** AMD GPU not detected

**Solution:** Install ROCm drivers (experimental support)

```bash
# Install ROCm
# Follow instructions at: https://rocmdocs.amd.com/

# Verify with rocm-smi
rocm-smi
```

### Verify Detection

```typescript
const capabilities = await systemInfo.detect();
console.log('GPU available:', capabilities.gpu.available);
if (capabilities.gpu.available) {
  console.log('GPU type:', capabilities.gpu.type);
  console.log('GPU name:', capabilities.gpu.name);
  console.log('VRAM:', (capabilities.gpu.vram / 1024 ** 3).toFixed(1), 'GB');
}
```

---

## Binary Validation Failures

### CUDA Errors

**Problem:** `BinaryError: CUDA error detected in validation output`

**Solution:** Try Vulkan or CPU fallback (automatic), or update drivers

```typescript
// Binary manager automatically tries: CUDA → Vulkan → CPU
// If CUDA fails, Vulkan or CPU will be used automatically

// After updating GPU drivers, force re-validation
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true  // Re-run Phase 1 & 2 tests
});
```

### Missing Shared Libraries

**Problem:** `BinaryError: error while loading shared libraries`

**Solution:** Install required system libraries

```bash
# Linux: Install common dependencies
sudo apt-get update
sudo apt-get install libgomp1 libstdc++6

# macOS: Usually not needed
# Windows: Install Visual C++ Redistributable
```

### Check Binary Log Events

```typescript
llamaServer.on('binary-log', (data) => {
  console.log(`[${data.level}] ${data.message}`);
});

// Watch for validation progress and any errors
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

---

## Model Compatibility

### Wrong Model Type

**Problem:** `ModelNotFoundError: Model is not a diffusion model`

**Solution:** Ensure using correct model type for server

```typescript
// Check model type
const modelInfo = await modelManager.getModelInfo('my-model');
console.log('Model type:', modelInfo.type);

// Use LLM models with llamaServer
if (modelInfo.type === 'llm') {
  await llamaServer.start({ modelId: modelInfo.id, port: 8080 });
}

// Use diffusion models with diffusionServer
if (modelInfo.type === 'diffusion') {
  await diffusionServer.start({ modelId: modelInfo.id, port: 8081 });
}
```

### Unsupported Architecture

**Problem:** Model won't load or crashes

**Solution:** Check GGUF metadata for architecture field

```typescript
const modelInfo = await modelManager.getModelInfo('my-model');

if (modelInfo.ggufMetadata) {
  console.log('Architecture:', modelInfo.ggufMetadata.architecture);

  // Supported architectures: llama, gemma, qwen, mistral, phi, mamba, etc.
  // If architecture is unsupported, try different model
}
```

---

## Memory Errors

### InsufficientResourcesError

**Problem:** Not enough RAM/VRAM to run model

**Solution:** Use resource orchestration or smaller model

```typescript
// For both LLM + image generation, use resource orchestration
import { ResourceOrchestrator } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// Automatically offloads LLM if needed
await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape',
  steps: 30
});
```

### Check Real-Time Memory

```typescript
// Monitor available memory
const memory = systemInfo.getMemoryInfo();
console.log('Available:', (memory.available / 1024 ** 3).toFixed(1), 'GB');
console.log('Usage:', ((memory.used / memory.total) * 100).toFixed(1), '%');
```

---

## HTTP API Errors

### Error Codes Table

| Code | Description | Solution |
|------|-------------|----------|
| `SERVER_BUSY` | Server is processing another generation | Wait or cancel existing generation |
| `NOT_FOUND` | Generation ID not found | ID is invalid or result expired (TTL) |
| `INVALID_REQUEST` | Invalid parameters | Check prompt, count (1-5), etc. |
| `BACKEND_ERROR` | Backend processing failed | Check logs, model may be corrupt |
| `IO_ERROR` | File I/O error | Check disk space and permissions |

### Generation Not Found (TTL Expired)

**Problem:** `NOT_FOUND` error when polling

**Solution:** Results expire after TTL (default: 5 minutes). Poll more frequently or increase TTL.

```bash
# Set longer TTL (10 minutes)
export IMAGE_RESULT_TTL_MS=600000

# Restart server for changes to take effect
```

### Polling Frequency

**Recommendation:** Poll every 1 second

```typescript
// Good polling frequency
await new Promise(resolve => setTimeout(resolve, 1000));

// Too slow (results may expire)
await new Promise(resolve => setTimeout(resolve, 10000));
```

---

## llama.cpp Connection Issues

### Server Not Running

**Problem:** `Error: connect ECONNREFUSED 127.0.0.1:8080`

**Solution:** Ensure llama-server is running

```typescript
// Check if server is running
const status = llamaServer.getStatus();
console.log('Server status:', status);

if (status === 'stopped') {
  await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
}
```

### Wrong Port

**Problem:** Connection refused or timeout

**Solution:** Verify port configuration

```typescript
// Check server port
const info = llamaServer.getInfo();
console.log('Server port:', info.port);

// Ensure genai-lite uses same port
// Default: http://localhost:8080
// Or set: export LLAMACPP_API_BASE_URL=http://localhost:8081
```

### Health Check Timeout

**Problem:** `isHealthy()` returns false

**Solution:** Server may still be loading model

```typescript
// Wait for server to be ready
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Poll until healthy
let retries = 0;
while (!(await llamaServer.isHealthy()) && retries < 30) {
  console.log('Waiting for server to be ready...');
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

---

## FAQ

### How to change binary download location?

**Answer:** Phase 4 feature (not yet available). Currently binaries are stored in `userData/binaries/`.

### How to use shared model storage?

**Answer:** Phase 4 feature (not yet available). Currently each app has isolated model storage in its `userData` directory.

### Can I use custom llama.cpp builds?

**Answer:** Yes! Set `LLAMACPP_API_BASE_URL` environment variable:

```bash
export LLAMACPP_API_BASE_URL=http://localhost:9000

# Then use genai-lite with custom server
```

### How to disable GPU?

**Answer:** Set `gpuLayers: 0`

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  gpuLayers: 0  // Force CPU-only mode
});
```

### How to enable embeddings with llama.cpp?

**Answer:** Use `--embeddings` flag when starting llama-server manually:

```bash
llama-server -m model.gguf --port 8080 --embeddings
```

Then connect with genai-lite using `LLAMACPP_API_BASE_URL`.

---

## See Also

- [Installation and Setup](installation-and-setup.md) - Requirements and setup
- [System Detection](system-detection.md) - Hardware capability checking
- [LLM Server](llm-server.md) - Server configuration and logs
- [Image Generation](image-generation.md) - HTTP API and error codes
- [Integration Guide](integration-guide.md) - Error handling patterns
