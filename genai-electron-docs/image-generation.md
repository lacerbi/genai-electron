# Image Generation

Generate images locally using stable-diffusion.cpp through DiffusionServerManager. Supports both synchronous Node.js API and asynchronous HTTP API with polling pattern.

## Navigation

- [Overview](#overview)
- [Server Lifecycle](#server-lifecycle)
- [Node.js API](#nodejs-api)
- [HTTP API (Async Pattern)](#http-api-async-pattern)
- [Progress Tracking](#progress-tracking)
- [Status and Health](#status-and-health)
- [Logs and Events](#logs-and-events)
- [Binary Management](#binary-management)
- [GenerationRegistry (Advanced)](#generationregistry-advanced)

---

## Overview

`DiffusionServerManager` manages local image generation using stable-diffusion.cpp. Unlike llama-server (which is a native HTTP server), stable-diffusion.cpp is a one-shot executable. DiffusionServerManager creates an HTTP wrapper server that spawns stable-diffusion.cpp on-demand for each generation request.

**Key Features:**
- Automatic binary download and variant testing (CUDA → Vulkan → CPU)
- Node.js API for synchronous generation (`generateImage()`)
- HTTP API for asynchronous generation with polling pattern
- Batch generation (1-5 images with auto-incremented seeds)
- Real-time progress tracking across stages (loading, diffusion, decoding)
- Automatic resource orchestration (LLM offload/reload when needed)

**Import:**
```typescript
import { diffusionServer } from 'genai-electron';
// Or for custom instances:
import { DiffusionServerManager } from 'genai-electron';
const customServer = new DiffusionServerManager();
```

---

## Server Lifecycle

### start(config)

Starts the HTTP wrapper server. Downloads binary automatically on first run.

**Parameters:**
- `modelId: string` - **Required** - Diffusion model ID to load
- `port?: number` - Optional - Port to listen on (default: 8081)
- `threads?: number` - Optional - CPU threads (auto-detected if not specified)
- `gpuLayers?: number` - Optional - GPU layers to offload (auto-detected if not specified, 0 = CPU-only)
- `vramBudget?: number` - Optional - VRAM budget in MB ⚠️ **Phase 3** (not yet implemented)
- `forceValidation?: boolean` - Optional - Force re-validation of binary (default: false)

**Example (Auto-configuration):**
```typescript
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081
  // threads, gpuLayers auto-detected
});

console.log('Diffusion server started with optimal settings');
```

**Example (Custom configuration):**
```typescript
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081,
  threads: 8,
  gpuLayers: 35
});
```

**Throws:**
- `ModelNotFoundError` - Model doesn't exist or is not a diffusion model
- `ServerError` - Server failed to start
- `PortInUseError` - Port already in use
- `InsufficientResourcesError` - Not enough RAM/VRAM
- `BinaryError` - Binary download or execution failed

### stop()

Stops the HTTP wrapper server gracefully.

**Example:**
```typescript
await diffusionServer.stop();
console.log('Diffusion server stopped');
```

**Behavior:**
1. Cancels any ongoing image generation
2. Closes HTTP server
3. Cleans up resources

---

## Node.js API

### generateImage(config)

Generates an image by spawning stable-diffusion.cpp executable. Returns a single image.

**Automatic Resource Management:** When using the singleton `diffusionServer`, this method automatically manages system resources. If RAM or VRAM is constrained:
1. Temporarily stops the LLM server (saves configuration)
2. Generates the image
3. Automatically restarts the LLM server with the same configuration

**Parameters (ImageGenerationConfig):**
- `prompt: string` - **Required** - Text description of the image
- `negativePrompt?: string` - What to avoid in the image
- `width?: number` - Image width in pixels (default: 512)
- `height?: number` - Image height in pixels (default: 512)
- `steps?: number` - Inference steps (default: 20, more = better quality but slower)
- `cfgScale?: number` - Guidance scale (default: 7.5, higher = closer to prompt)
- `seed?: number` - Random seed for reproducibility (undefined or negative = random)
- `sampler?: ImageSampler` - Sampler algorithm (default: 'euler_a')
- `count?: number` - Number of images (1-5, default: 1) ⚠️ For batch use HTTP API
- `onProgress?: (currentStep, totalSteps, stage, percentage?) => void` - Progress callback

**Returns:** `ImageGenerationResult` - Single image with metadata

**Example (Basic):**
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape at sunset, 4k, detailed',
  width: 1024,
  height: 1024,
  steps: 30
});

console.log('Image generated in', result.timeTaken, 'ms');
console.log('Seed:', result.seed);

// Save image
import { promises as fs } from 'fs';
await fs.writeFile('output.png', result.image);
```

**Example (Advanced with progress):**
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A futuristic city at night, cyberpunk style',
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
await fs.writeFile('cyberpunk-city.png', result.image);
```

**Throws:**
- `ServerError` - Server not running, already generating, or generation failed

**Important Notes:**
- Only one generation can run at a time
- For batch generation (count > 1), use the HTTP API
- Model validation occurs during `start()`
- Automatic resource orchestration is built into the singleton `diffusionServer`

---

## HTTP API (Async Pattern)

The HTTP API provides asynchronous image generation with a polling pattern. POST returns an ID immediately, then GET polls for status and results.

**Base URL:** `http://localhost:{port}` (default: http://localhost:8081)

### POST /v1/images/generations

Start an async image generation. Returns immediately with a generation ID.

**Request Body (JSON):**
```typescript
{
  prompt: string;              // Required
  negativePrompt?: string;
  width?: number;              // Default: 512
  height?: number;             // Default: 512
  steps?: number;              // Default: 20
  cfgScale?: number;           // Default: 7.5
  seed?: number;               // undefined/negative = random
  sampler?: ImageSampler;      // Default: 'euler_a'
  count?: number;              // 1-5 images, default: 1
}
```

**Response (201 Created):**
```typescript
{
  id: string;           // Use for polling
  status: 'pending';
  createdAt: number;    // Unix timestamp
}
```

**Error Responses:**
- `400 Bad Request` - Invalid request (missing prompt, invalid count)
- `503 Service Unavailable` - Server is busy

**Example:**
```typescript
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
    sampler: 'dpm++2m',
    count: 3  // Generate 3 variations
  })
});

const { id } = await response.json();
console.log('Generation started:', id);
```

### GET /v1/images/generations/:id

Poll generation status and retrieve results when complete.

**Response Formats:**

**Pending (200 OK):**
```typescript
{
  id: string;
  status: 'pending';
  createdAt: number;
  updatedAt: number;
}
```

**In Progress (200 OK):**
```typescript
{
  id: string;
  status: 'in_progress';
  createdAt: number;
  updatedAt: number;
  progress: {
    currentStep: number;
    totalSteps: number;
    stage: 'loading' | 'diffusion' | 'decoding';
    percentage?: number;        // Overall progress 0-100
    currentImage?: number;      // Current image (1-indexed, batch only)
    totalImages?: number;       // Total images (batch only)
  };
}
```

**Complete (200 OK):**
```typescript
{
  id: string;
  status: 'complete';
  createdAt: number;
  updatedAt: number;
  result: {
    images: Array<{
      image: string;    // Base64-encoded PNG
      seed: number;
      width: number;
      height: number;
    }>;
    format: 'png';
    timeTaken: number;  // Milliseconds
  };
}
```

**Error (200 OK):**
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

**Not Found (404):**
```typescript
{
  error: {
    message: 'Generation not found';
    code: 'NOT_FOUND';
  };
}
```

**Example (Polling Loop):**
```typescript
async function pollUntilComplete(id: string) {
  while (true) {
    const response = await fetch(`http://localhost:8081/v1/images/generations/${id}`);
    const data = await response.json();

    if (data.status === 'in_progress' && data.progress) {
      const { stage, percentage, currentImage, totalImages } = data.progress;
      if (currentImage && totalImages) {
        console.log(`Image ${currentImage}/${totalImages}: ${stage} - ${percentage?.toFixed(1)}%`);
      } else {
        console.log(`${stage}: ${percentage?.toFixed(1)}%`);
      }
    }

    if (data.status === 'complete') {
      console.log('✅ Complete!');
      return data.result;
    }

    if (data.status === 'error') {
      throw new Error(data.error.message);
    }

    // Poll every second
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const result = await pollUntilComplete(id);

// Save images
result.images.forEach((img, i) => {
  const buffer = Buffer.from(img.image, 'base64');
  fs.writeFileSync(`output-${i}.png`, buffer);
  console.log(`Saved image ${i} with seed: ${img.seed}`);
});
```

### GET /health

Check if the diffusion server is running and available.

**Response (200 OK):**
```typescript
{
  status: 'ok';
  busy: boolean;  // Whether currently generating
}
```

**Example:**
```typescript
const response = await fetch('http://localhost:8081/health');
const { status, busy } = await response.json();

if (status === 'ok' && !busy) {
  console.log('✅ Server is ready for generation');
}
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

Generate multiple image variations (1-5 images) with automatically incremented seeds:

```typescript
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'A majestic dragon',
    width: 1024,
    height: 1024,
    steps: 30,
    seed: 42,
    count: 3  // Generate 3 variations
  })
});

// Result will contain 3 images with seeds: 42, 43, 44
```

**Note:** Batch generation (count > 1) currently bypasses automatic resource orchestration. This is planned for Phase 3.

### Migration from Phase 2.0 Synchronous API

**Breaking Change:** Phase 2.5 introduced async polling. If you used the previous synchronous endpoint:

**Old (Phase 2.0):**
```typescript
// POST blocked until complete
const response = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config)
});
const result = await response.json(); // Waited for entire generation
```

**New (Phase 2.5+):**
```typescript
// POST returns immediately
const startResponse = await fetch('http://localhost:8081/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config)
});
const { id } = await startResponse.json();

// Poll GET endpoint for result
// (see polling examples above)
```

---

## Progress Tracking

Image generation progress provides detailed stage information with self-calibrating time estimates.

### Progress Stages

**1. Loading (~20% of time)**
- Model tensors loading into memory
- Reports: tensor count (e.g., 1500/2641)
- UI suggestion: "Loading model..."

**2. Diffusion (~30-50% of time)**
- Denoising steps (main generation process)
- Reports: actual step count (e.g., 15/30)
- UI suggestion: "Generating (step X/Y)"

**3. Decoding (~30-50% of time)**
- VAE decoding latents to final image
- Reports: estimated progress
- UI suggestion: "Decoding..."

### Self-Calibrating Estimates

The system automatically calibrates time estimates based on hardware performance:
- First generation uses reasonable defaults
- Subsequent generations adapt to image size and step count
- Provides accurate overall percentage across all stages

**Example:**
```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A peaceful zen garden',
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

### Available Samplers

```typescript
type ImageSampler =
  | 'euler_a'      // Euler Ancestral (default, good quality/speed)
  | 'euler'        // Euler
  | 'heun'         // Heun (better quality, slower)
  | 'dpm2'         // DPM 2
  | 'dpm++2s_a'    // DPM++ 2S Ancestral
  | 'dpm++2m'      // DPM++ 2M (good quality)
  | 'dpm++2mv2'    // DPM++ 2M v2
  | 'lcm';         // LCM (very fast, fewer steps)
```

---

## Status and Health

### getStatus()

Gets current server status (synchronous).

**Returns:** `ServerStatus` - `'stopped'` | `'starting'` | `'running'` | `'stopping'` | `'crashed'`

```typescript
const status = diffusionServer.getStatus();
console.log('Server status:', status);
```

### getInfo()

Gets detailed server information (synchronous).

**Returns:** `DiffusionServerInfo`
- `status: ServerStatus`
- `health: HealthStatus` - `'ok'` | `'loading'` | `'error'` | `'unknown'`
- `busy?: boolean` - Whether currently generating
- `pid?: number` - HTTP wrapper process ID
- `port: number`
- `modelId: string`
- `startedAt?: string` - ISO 8601 timestamp
- `error?: string` - Last error message

```typescript
const info = diffusionServer.getInfo();
console.log('Status:', info.status);
console.log('Busy:', info.busy);
console.log('Port:', info.port);
```

### isHealthy()

Checks if the HTTP wrapper server is responding (asynchronous).

**Returns:** `Promise<boolean>`

```typescript
const healthy = await diffusionServer.isHealthy();
if (healthy) {
  console.log('✅ Server is ready');
}
```

---

## Logs and Events

### getLogs(lines?)

Gets recent server logs (raw strings).

**Parameters:** `lines?: number` - Number of lines (default: 100)

```typescript
const logs = await diffusionServer.getLogs(50);
logs.forEach(line => console.log(line));
```

### getStructuredLogs(lines?)

Gets recent logs as structured objects with parsed timestamps, levels, and messages.

**Parameters:** `lines?: number` - Number of lines (default: 100)

**Returns:** `Promise<LogEntry[]>`
- `timestamp: string` - ISO 8601 timestamp
- `level: string` - 'info', 'warn', 'error', 'debug'
- `message: string` - Log message content

```typescript
const logs = await diffusionServer.getStructuredLogs(50);

// Filter by level
const errors = logs.filter(e => e.level === 'error');

// Format for display
logs.forEach(entry => {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  console.log(`[${time}] ${entry.level.toUpperCase()}: ${entry.message}`);
});
```

### clearLogs()

Clears all server logs.

```typescript
await diffusionServer.clearLogs();
```

### Events

DiffusionServerManager extends `EventEmitter` and emits lifecycle events:

**'started'** - Server started successfully:
```typescript
diffusionServer.on('started', (info: DiffusionServerInfo) => {
  console.log('Diffusion server started on port', info.port);
});
```

**'stopped'** - Server stopped:
```typescript
diffusionServer.on('stopped', () => {
  console.log('Diffusion server stopped');
});
```

**'crashed'** - Server crashed unexpectedly:
```typescript
diffusionServer.on('crashed', (error: Error) => {
  console.error('Diffusion server crashed:', error.message);
});
```

**'binary-log'** - Binary download and validation progress:
```typescript
diffusionServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
  console.log(`[${data.level.toUpperCase()}] ${data.message}`);
});
```

---

## Binary Management

On first call to `start()`, the library automatically:
1. **Downloads** appropriate binary if not present (~50-100MB)
2. **Tests variants** in priority order: CUDA → Vulkan → CPU
3. **Runs real functionality test:**
   - Generates tiny 64x64 image with 1 diffusion step
   - Verifies CUDA/GPU acceleration actually works
   - Parses output for GPU errors ("CUDA error", "Vulkan error")
4. **Falls back automatically** if test fails (broken CUDA → tries Vulkan → CPU)
5. **Caches working variant** for fast subsequent starts

**Validation Caching:** After first successful validation, subsequent starts skip expensive tests and only verify checksum (~0.5s instead of 2-10s). Use `forceValidation: true` after driver updates.

**Note:** Real functionality testing only runs if model is downloaded. If model doesn't exist yet, falls back to basic `--help` test.

---

## GenerationRegistry (Advanced)

The `GenerationRegistry` class manages in-memory state for async image generation. Primarily for internal use by DiffusionServerManager. Exported for advanced use cases.

### Overview

- Tracks generation state (pending, in_progress, complete, error)
- Automatic TTL cleanup (default: 5 minutes for completed/errored generations)
- Thread-safe create/read/update/delete operations

### Constructor

```typescript
import { GenerationRegistry } from 'genai-electron';

const registry = new GenerationRegistry({
  maxResultAgeMs: 10 * 60 * 1000,  // 10 minutes
  cleanupIntervalMs: 2 * 60 * 1000  // 2 minutes
});
```

**Options:**
- `maxResultAgeMs?: number` - Max age before cleanup (default: 5 minutes)
- `cleanupIntervalMs?: number` - Cleanup interval (default: 1 minute)

### Key Methods

**create(config)** - Create new generation entry:
```typescript
const id = registry.create({
  prompt: 'A serene mountain landscape',
  width: 1024,
  height: 1024
});
```

**get(id)** - Get generation state:
```typescript
const state = registry.get(id);
if (state?.status === 'complete') {
  console.log('Images:', state.result?.images.length);
}
```

**update(id, updates)** - Update generation state:
```typescript
registry.update(id, {
  status: 'in_progress',
  progress: {
    currentStep: 15,
    totalSteps: 30,
    stage: 'diffusion',
    percentage: 50
  }
});
```

**delete(id)** - Delete generation:
```typescript
registry.delete(id);
```

**cleanup(maxAgeMs)** - Manual cleanup:
```typescript
const cleaned = registry.cleanup(5 * 60 * 1000);
console.log('Cleaned up', cleaned, 'old generations');
```

**destroy()** - Stop automatic cleanup interval:
```typescript
registry.destroy();
```

### Environment Variables

Configure TTL via environment variables:

```bash
# Result TTL (default: 5 minutes / 300000ms)
export IMAGE_RESULT_TTL_MS=600000  # 10 minutes

# Cleanup interval (default: 1 minute / 60000ms)
export IMAGE_CLEANUP_INTERVAL_MS=120000  # 2 minutes
```

**Important:** If polling too slowly, results may expire. Configure `IMAGE_RESULT_TTL_MS` appropriately.

---

## See Also

- [Resource Orchestration](resource-orchestration.md) - Automatic LLM offload/reload
- [Model Management](model-management.md) - Downloading diffusion models
- [System Detection](system-detection.md) - Hardware capability detection
- [Integration Guide](integration-guide.md) - Electron patterns and lifecycle
- [Troubleshooting](troubleshooting.md) - Common issues
