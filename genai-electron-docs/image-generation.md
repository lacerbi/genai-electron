# Image Generation

Generate images locally using stable-diffusion.cpp through DiffusionServerManager. Supports both synchronous Node.js API and asynchronous HTTP API with polling pattern.


---

## Overview

`DiffusionServerManager` manages local image generation using stable-diffusion.cpp. Unlike llama-server (native HTTP server), stable-diffusion.cpp is a one-shot executable, so DiffusionServerManager creates an HTTP wrapper that spawns it on-demand.

**Features:** Binary auto-download with variant testing, Node.js API (`generateImage()`), HTTP API (async polling), batch generation (1-5), progress tracking, automatic resource orchestration (works for both APIs).

```typescript
import { diffusionServer, DiffusionServerManager } from 'genai-electron';
```

---

## Server Lifecycle

### start(config)

Starts HTTP wrapper. Auto-downloads binary on first run.

**Config:** `modelId` (required), `port` (8081), `threads`, `gpuLayers`, `vramBudget` (Phase 3), `forceValidation`.

```typescript
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081, threads: 8, gpuLayers: 35 });
```

**Throws:** `ModelNotFoundError`, `ServerError`, `PortInUseError`, `InsufficientResourcesError`, `BinaryError`

### stop()

Stops the HTTP wrapper server gracefully.

**Example:**
```typescript
await diffusionServer.stop();
```

Cancels ongoing generation, closes HTTP server, and cleans up resources.

---

## Node.js API

### generateImage(config)

Spawns stable-diffusion.cpp to generate a single image. When both LLM and diffusion servers are running, singleton `diffusionServer` automatically offloads/reloads LLM when RAM/VRAM exceeds 75% threshold.

**Config:** `prompt` (required), `negativePrompt`, `width` (512), `height` (512), `steps` (20), `cfgScale` (7.5), `seed` (random), `sampler` ('euler_a'), `count` (1), `onProgress`.

**Returns:** `ImageGenerationResult` - Single image with metadata

**Example:**
```typescript
import { promises as fs } from 'fs';

const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape at sunset, 4k, detailed',
  negativePrompt: 'blurry, low quality',
  width: 1024,
  height: 1024,
  steps: 30,
  cfgScale: 7.5,
  seed: 42,
  sampler: 'dpm++2m',
  onProgress: (currentStep, totalSteps, stage, percentage) => {
    console.log(`${stage}: ${Math.round(percentage || 0)}%`);
  }
});

console.log(`Generated in ${result.timeTaken}ms, seed: ${result.seed}`);
await fs.writeFile('output.png', result.image);
```

**Throws:**
- `ServerError` - Server not running, already generating, or generation failed

**Note:** Only one generation at a time. Batch generation (count > 1) requires HTTP API. Model validation occurs during `start()`. Automatic resource orchestration built into singleton `diffusionServer`.

---

## HTTP API (Async Pattern)

The HTTP API provides asynchronous image generation with a polling pattern. POST returns an ID immediately, then GET polls for status and results.

**Resource Orchestration**: HTTP endpoints inherit the same automatic LLM offload/reload as the Node.js API when resources are constrained. No additional configuration needed.

**Base URL:** `http://localhost:{port}` (default: http://localhost:8081)

### POST /v1/images/generations

Start an async image generation. Returns immediately with a generation ID.

**Request:** JSON with `prompt` (required), `negativePrompt`, `width` (512), `height` (512), `steps` (20), `cfgScale` (7.5), `seed` (random), `sampler` ('euler_a'), `count` (1-5).

**Response (201 Created):**
```typescript
{ id: string; status: 'pending'; createdAt: number; }
```

**Errors:** `400 Bad Request` (invalid params), `503 Service Unavailable` (server busy)

**Example:**
```typescript
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'A serene mountain landscape at sunset',
    width: 1024, height: 1024, steps: 30, cfgScale: 7.5, sampler: 'dpm++2m', count: 3
  })
});
const { id } = await response.json();
```

### GET /v1/images/generations/:id

Poll generation status and retrieve results.

**Response:** State object with `id`, `status`, `createdAt`, `updatedAt`, plus:
- `status: 'pending'` - No additional fields
- `status: 'in_progress'` - `progress: { currentStep, totalSteps, stage, percentage?, currentImage?, totalImages? }`
- `status: 'complete'` - `result: { images: [{ image, seed, width, height }], format, timeTaken }`
- `status: 'error'` - `error: { message, code }`
- `404` - Generation not found or expired

**Example (Polling Loop):**
```typescript
while (true) {
  const response = await fetch(`http://localhost:8081/v1/images/generations/${id}`);
  const data = await response.json();

  if (data.status === 'complete') {
    data.result.images.forEach((img, i) => {
      const buffer = Buffer.from(img.image, 'base64');
      fs.writeFileSync(`output-${i}.png`, buffer);
    });
    break;
  }
  if (data.status === 'error') throw new Error(data.error.message);

  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

### GET /health

Check if the diffusion server is running and available.

**Response (200 OK):**
```typescript
{ status: 'ok'; busy: boolean; }
```

**Example:**
```typescript
const { status, busy } = await (await fetch('http://localhost:8081/health')).json();
```

### Error Codes Reference

| Code | Description | Typical Cause |
|------|-------------|---------------|
| `SERVER_BUSY` | Server is processing another generation | Multiple concurrent requests |
| `NOT_FOUND` | Generation ID not found | Invalid ID or expired (TTL) |
| `INVALID_REQUEST` | Invalid parameters | Missing prompt, invalid count |
| `BACKEND_ERROR` | Backend processing failed | Model loading error, CUDA error |
| `IO_ERROR` | File I/O error | Disk full, permission issues |

### Batch Generation

Generate multiple variations (1-5 images) with auto-incremented seeds. Set `count: 3` to generate 3 images with seeds 42, 43, 44 (if seed=42). Batch generation bypasses automatic resource orchestration (planned for Phase 3).

### Migration from Phase 2.0

**Breaking Change:** Phase 2.5 changed from synchronous (POST blocks until complete) to async polling (POST returns ID immediately, poll GET endpoint for results). See polling examples above.

---

## Progress Tracking

Progress provides stage information with self-calibrating time estimates.

### Stages

1. **Loading** (~20%): Model tensors loading, reports tensor count
2. **Diffusion** (~30-50%): Denoising steps (main process), reports actual step count
3. **Decoding** (~30-50%): VAE decoding latents to image, reports estimated progress

### Self-Calibrating Estimates

System adapts time estimates based on hardware: first generation uses defaults, subsequent generations adjust to image size/steps.

**Example:**
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A peaceful zen garden',
  width: 1024,
  height: 1024,
  steps: 30,
  onProgress: (current, total, stage, percentage) => {
    console.log(`${stage} (${current}/${total}): ${Math.round(percentage || 0)}%`);
  }
});
```

### Available Samplers

`euler_a` (default), `euler`, `heun` (slower, better quality), `dpm2`, `dpm++2s_a`, `dpm++2m` (good quality), `dpm++2mv2`, `lcm` (very fast).

---

## Status and Health

### getStatus()

Gets current server status (synchronous). Returns `ServerStatus`: `'stopped'` | `'starting'` | `'running'` | `'stopping'` | `'crashed'`

```typescript
const status = diffusionServer.getStatus();
```

### getInfo()

Gets detailed server information (synchronous). Returns `DiffusionServerInfo` with `status`, `health`, `busy`, `pid`, `port`, `modelId`, `startedAt`, `error`.

```typescript
const info = diffusionServer.getInfo();
```

### isHealthy()

Checks if server is responding (async). Returns `Promise<boolean>`.

```typescript
const healthy = await diffusionServer.isHealthy();
```

---

## Logs and Events

### getLogs(lines?)

Gets recent server logs (raw strings). Default: 100 lines.

```typescript
const logs = await diffusionServer.getLogs(50);
```

### getStructuredLogs(lines?)

Gets recent logs as parsed `LogEntry[]` objects with `timestamp`, `level`, `message`. Default: 100 lines.

```typescript
const logs = await diffusionServer.getStructuredLogs(50);
const errors = logs.filter(e => e.level === 'error');
```

### clearLogs()

Clears all server logs.

```typescript
await diffusionServer.clearLogs();
```

### Events

DiffusionServerManager extends `EventEmitter`:

- `'started'` - Server started successfully (receives `DiffusionServerInfo`)
- `'stopped'` - Server stopped
- `'crashed'` - Server crashed (receives `Error`)
- `'binary-log'` - Binary download/validation progress (receives `{ message, level }`)

---

## Binary Management

On first `start()`: Downloads binary (~50-100MB), tests variants (CUDA → Vulkan → CPU) with real functionality test (64x64 image), falls back if test fails, caches working variant. Subsequent starts skip tests and verify checksum only (~0.5s). Use `forceValidation: true` after driver updates. Real functionality testing requires model; falls back to `--help` test if model missing.

---

## GenerationRegistry (Advanced)

Manages in-memory state for async image generation. Primarily for internal use. Exported for custom tracking.

```typescript
import { GenerationRegistry } from 'genai-electron';

const registry = new GenerationRegistry({
  maxResultAgeMs: 10 * 60 * 1000,    // Default: 5 min
  cleanupIntervalMs: 2 * 60 * 1000   // Default: 1 min
});
```

**ID Generation**: The registry uses `generateId()` internally to create unique IDs. You can import it for custom tracking:

```typescript
import { generateId } from 'genai-electron';

const customId = generateId(); // e.g., "gen_1729612345678_x7k2p9q4m"
```

Use cases: custom async operation tracking, request correlation, unique file naming.

**Methods:** `create(config)`, `get(id)`, `update(id, updates)`, `delete(id)`, `getAllIds()`, `size()`, `cleanup(maxAgeMs)`, `clear()`, `destroy()`

**Environment Variables:** Configure TTL with `IMAGE_RESULT_TTL_MS` (default: 300000) and `IMAGE_CLEANUP_INTERVAL_MS` (default: 60000). If polling too slowly, results may expire.

---

## See Also

- [Resource Orchestration](resource-orchestration.md) - Automatic LLM offload/reload
- [Model Management](model-management.md) - Downloading diffusion models
- [System Detection](system-detection.md) - Hardware capability detection
- [Integration Guide](integration-guide.md) - Electron patterns and lifecycle
- [Troubleshooting](troubleshooting.md) - Common issues
