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

**Config:** `modelId` (required), `port` (8081; also accepts `'auto'` to pick a free OS-assigned port — the resolved value is on `DiffusionServerInfo.port`), `threads`, `gpuLayers` (accepted but not passed to sd.cpp — GPU offload is automatic), `forceValidation`, `clipOnCpu`, `vaeOnCpu`, `batchSize`, `offloadToCpu`, `diffusionFlashAttention`.

```typescript
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081, threads: 8 });

// Start Flux 2 Klein — same API, automatic component handling
await diffusionServer.start({
  modelId: 'flux-2-klein',
  port: 8081,
  // Auto-detected: offloadToCpu, diffusionFlashAttention
  // Override if needed:
  // offloadToCpu: true,
  // diffusionFlashAttention: true,
});
```

**Throws:** `ModelNotFoundError`, `ServerError`, `PortInUseError`, `InsufficientResourcesError`, `BinaryError`

### Multi-Component Models

Multi-component models (Flux 2, SDXL split) work with the same `start({ modelId })` API — component resolution is handled internally. The server automatically detects multi-component models and emits the appropriate CLI flags for each component.

**Automatic Optimization:**
- `--offload-to-cpu` is auto-enabled when the model footprint exceeds 85% of VRAM
- `--diffusion-fa` (flash attention) is auto-enabled when the model has an `llm` component (Flux 2 architecture)
- Both can be explicitly overridden in the config

**Behavior change (v0.10.0):** CPU offloading flags are now auto-detected identically on all backends, including CUDA. The old CUDA suppression worked around a silent crash in sd.cpp builds up to `master-504-636d3cb`; that crash is fixed upstream (re-verified live on `master-746-2574f59`). Low-VRAM CUDA setups may therefore now auto-enable `--clip-on-cpu`/`--vae-on-cpu`/`--offload-to-cpu` — pass explicit `false` to restore the old behavior. Upstream caveat: SD3.5-Large is broken with `--clip-on-cpu` on any backend (leejet/stable-diffusion.cpp#1578).

**Config Fields for Multi-Component Models:**

```typescript
offloadToCpu?: boolean
```
Offload model weights to CPU RAM, load to VRAM on demand. `undefined` = auto-detect (enabled when model footprint > 85% of VRAM), `true` = force on, `false` = force off. Maps to `--offload-to-cpu`.

```typescript
diffusionFlashAttention?: boolean
```
Enable flash attention in the diffusion model. `undefined` = auto-detect (enabled when model has an `llm` component, indicating Flux 2), `true` = force on, `false` = force off. Maps to `--diffusion-fa`.

```typescript
clipOnCpu?: boolean
```
Force CLIP model to run on CPU instead of GPU. Maps to `--clip-on-cpu`. Auto-detected: enabled when VRAM headroom after model load is less than 6GB.

```typescript
vaeOnCpu?: boolean
```
Force VAE model to run on CPU instead of GPU. Maps to `--vae-on-cpu`. Auto-detected: enabled when VRAM headroom after model load is less than 2GB.

```typescript
batchSize?: number
```
Batch size for processing. Maps to `-b` flag. If not specified, the flag is omitted and sd.cpp uses its own internal default.

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

**Note:** `generateImage()` always returns a single image. The `count` parameter is only used by the HTTP async API for batch generation (1-5 images). Only one generation at a time. Model validation occurs during `start()`. Automatic resource orchestration built into singleton `diffusionServer`.

### cancelImageGeneration(id)

Cancels an in-flight async-API generation by its registry ID. Marks the generation `'cancelled'`, halts the batch loop (also between images), and kills the running sd-cli process. Idempotent for terminal generations (already complete/error/cancelled — no-op); throws `ServerError` for an unknown ID.

```typescript
cancelImageGeneration(id: string): Promise<void>
```

Only generations started through the async HTTP API (or `runAsyncGeneration`) have IDs. Direct `generateImage()` calls are not individually cancellable — use `stop()` to abort them.

```typescript
const activeId = diffusionServer.getActiveGenerationId();
if (activeId) {
  await diffusionServer.cancelImageGeneration(activeId);
}
```

### getActiveGenerationId()

Returns the registry ID of the async generation currently being processed, or `undefined` when idle. Useful for cancelling the in-flight generation when the ID is otherwise only known to the HTTP client that started it (e.g. genai-lite).

```typescript
getActiveGenerationId(): string | undefined
```

> **genai-lite polling caveat:** genai-lite clients **below v0.9.2** only treat `complete` and `error` as terminal statuses — if a generation is cancelled out-of-band, they keep polling until their own client-side timeout (~120 s). genai-lite ≥ 0.9.2 recognizes `'cancelled'` as terminal and stops immediately (surfacing an abort error). genai-lite ≥ 0.10.0 additionally supports request-side cancellation — `generateImage(request, { signal })` sends this DELETE itself on caller abort (and on its own poll timeout — 120 s by default, per-call configurable via `generateImage(request, { timeoutMs })` since genai-lite 0.11 — freeing the GPU), so out-of-band cancellation is only needed for older clients or non-genai-lite pollers.

---

## HTTP API (Async Pattern)

The HTTP API provides asynchronous image generation with a polling pattern. POST returns an ID immediately, then GET polls for status and results.

**Resource Orchestration**: HTTP endpoints inherit the same automatic LLM offload/reload as the Node.js API when resources are constrained. No additional configuration needed.

**Base URL:** `http://127.0.0.1:{port}` (default: http://127.0.0.1:8081). Use `127.0.0.1` rather than `localhost` — on Windows the `localhost` → IPv6 lookup adds a noticeable per-request penalty.

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
const response = await fetch('http://127.0.0.1:8081/v1/images/generations', {
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
- `status: 'cancelled'` - Terminal; generation was cancelled (via DELETE or `cancelImageGeneration()`)
- `404` - Generation not found or expired

**Example (Polling Loop):**
```typescript
while (true) {
  const response = await fetch(`http://127.0.0.1:8081/v1/images/generations/${id}`);
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

### DELETE /v1/images/generations/:id

Cancel an in-flight generation. Marks it `'cancelled'`, halts the batch loop, and kills the running sd-cli process.

**Response (200 OK):**
```typescript
{ id: string; status: 'cancelled'; }
```

**Errors:**
- `404 Not Found` - Generation ID not found or expired (`{ error: { message, code: 'NOT_FOUND' } }`)
- `409 Conflict` - Generation is already `complete` or `error` and cannot be cancelled (`{ error: { message, code: 'ALREADY_TERMINAL' } }`)

Cancelling an already-`cancelled` generation is idempotent and returns 200.

**Example:**
```typescript
await fetch(`http://127.0.0.1:8081/v1/images/generations/${id}`, { method: 'DELETE' });
```

### GET /health

Check if the diffusion server is running and available.

**Response (200 OK):**
```typescript
{ status: 'ok'; busy: boolean; }
```

**Example:**
```typescript
const { status, busy } = await (await fetch('http://127.0.0.1:8081/health')).json();
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

> Not to be confused with [Offload Calibration](#offload-calibration) below — that section is about benchmarking **offload flags**, this one is about progress-bar time estimates.

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

`euler_a` (default), `euler`, `heun` (slower, better quality), `dpm2`, `dpm++2s_a`, `dpm++2m` (good quality), `dpm++2mv2`, `lcm` (very fast), `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp` (CFG++ variants).

---

## Offload Calibration

The fastest combination of the CPU-offload flags (`clipOnCpu`, `vaeOnCpu`, `offloadToCpu`, `diffusionFlashAttention`) is machine-dependent: driver behaviour, PCIe/RAM bandwidth, CPU speed, and OS all shift the optimum, and the flags interact (e.g. `offloadToCpu` looks inert alone but wins under the VRAM pressure that `clipOnCpu: false` creates; on Windows an oversubscribed GPU silently thrashes while on Linux it hard-OOMs). `calibrate()` measures instead of guessing: it runs real generations for each combo × size on the actual machine and reports the fastest working configuration.

### calibrate(config)

```typescript
calibrate(config: DiffusionCalibrationConfig): Promise<DiffusionCalibrationReport>
```

Runs the sweep and returns a report. The caller persists/applies the recommendation — the library does not store it.

**Config:** `modelId` (required), `sizes` (default `[{ width: 768, height: 768 }]` — pass your app's real sizes), `combos` (default: curated labeled set in `DIFFUSION_CALIBRATION_DEFAULTS`: `auto`, `clip-gpu`, `clip-gpu+offload`, `offload`, `all-resident`, `max-savings`), `steps` (default 4 — **use your real step count**, offload cost scales with steps), `cfgScale`, `sampler` (`'euler'`), `seed` (42, fixed so every combo does identical work), `prompt`, `samples` (2 timed samples per combo × size, after 1 discarded warmup per combo), `threads`/`batchSize` (match your production config), `onProgress`, `signal`.

Default sweep cost: 6 combos × (1 warmup + 2 samples) = 18 generations — typically a few minutes.

**Contract:**
- The server must be **stopped** and is left stopped. `start()` throws while calibrating; `isCalibrating()` exposes the state (`getInfo().busy` may briefly read `true` while `status` stays `'stopped'` — harmless).
- When the manager is wired for orchestration (the `diffusionServer` singleton is), a running LLM is offloaded **once** for the whole sweep and restored afterwards. Without orchestration wiring, stop the LLM yourself before calibrating.
- Failing combos are recorded (`status: 'oom' | 'error'`) and never abort the sweep; the `max-savings` fallback combo means something usually succeeds even on very tight VRAM.
- `recommended` is keyed `"<width>x<height>"` (e.g. `"768x768"`) and holds combos **as requested** — the winner may be the plain auto combo; what auto-detection resolved to is in the winning run's `resolved`. Ties within 5% of the fastest prefer fewer forced flags (robustness).

**Example** (an app that commits to specific illustration sizes):

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }, { width: 512, height: 1024 }], // the app's real sizes
  steps: 4,                                                            // the app's quality preset
  onProgress: (p) => updateBar(p.overallPercent, p.phase, p.combo?.label),
});

// Persist the per-size winner in your app's settings…
const best = report.recommended['768x768'];
if (best) {
  const { label, ...flags } = best; // strip the label — it is not a server-config field
  await settings.save('diffusion-flags-768', flags);
  // …and pass the flags to future start() calls:
  await diffusionServer.start({ modelId: 'flux-2-klein', port: 8081, ...flags });
}
```

> **Note:** spread only the flag fields into `start()` — `label` is a UI/report field and `start()` rejects unknown config fields.

### Calibration progress (progress-bar wiring)

The same `DiffusionCalibrationProgress` payload is delivered on two channels: the `onProgress` callback and the `'calibration-progress'` event (mirrors `'binary-progress'` — use the event to forward over IPC):

```typescript
// Electron main process
diffusionServer.on('calibration-progress', (p) => {
  mainWindow.webContents.send('diffusion:calibration-progress', p);
});
```

Payload: `phase` (`'preparing' | 'warmup' | 'sampling' | 'restoring-llm' | 'done'`), `comboIndex`/`comboCount` + `combo` (labeled), `sizeIndex`/`sizeCount` + `size`, `sample`/`sampleCount`, `generationPercent` (within the current generation), and a smooth, monotonic `overallPercent` (0–100). Throwing progress consumers are swallowed — they cannot abort the sweep.

**First-run note:** binary provisioning (download + validation, potentially hundreds of MB) happens during the `'preparing'` phase and reports through the existing `'binary-progress'` event — subscribe to both for accurate first-run UX.

### Cancelling a sweep

Pass an `AbortSignal`. On abort the in-flight generation is killed and `calibrate()` rejects with a `ServerError` whose **`details.code === 'CALIBRATION_ABORTED'`** (the top-level `error.code` is the generic `'SERVER_ERROR'`) and `details.runs` = the completed partial runs.

```typescript
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();
try {
  await diffusionServer.calibrate({ modelId, signal: controller.signal });
} catch (error) {
  if (error.details?.code === 'CALIBRATION_ABORTED') {
    console.log('Aborted; partial results:', error.details.runs);
  } else throw error;
}
```

### Caveats

- **Calibrate with your real settings.** `offloadToCpu` overhead scales with step count and larger sizes shift the optimum (hence per-size recommendations). The default `steps: 4` suits distilled models (SDXL-Turbo, Flux Klein).
- **Sizes must be positive multiples of 64** (sd.cpp constraint; validated up-front).
- **SD3.5-Large:** combos forcing `clipOnCpu: true` are skipped automatically (garbled output upstream — leejet/stable-diffusion.cpp#1578) and listed in `report.skippedCombos`. Auto-detection may still resolve `clipOnCpu` on for auto combos on low-VRAM machines — prefer explicit `clipOnCpu: false` combos for this model family.
- **Timing noise:** thermal throttling and background load perturb results; the raw per-sample totals are kept in `runs[].samplesMs`. `timeTakenMs` is the median (with `samples: 2`, the mean of both).
- Each timed generation **includes model load** (sd.cpp reloads the model every generation — representative of real usage); the per-stage split is in `runs[].stageMs` (`loadMs`/`diffusionMs`/`decodeMs`).

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
- `'binary-log'` - Binary download/validation progress (receives `{ message, level }`)
- `'binary-progress'` - Structured provisioning progress (receives `BinaryProgressEvent`: phase + file + throttled whole-percent download progress) — build progress UIs from this instead of parsing log messages
- `'calibration-progress'` - Offload-calibration sweep progress (receives `DiffusionCalibrationProgress`; same payload as the `calibrate()` `onProgress` callback) — see [Offload Calibration](#offload-calibration)

**Note:** DiffusionServerManager does not emit a `'crashed'` event because it does not maintain a persistent process — stable-diffusion.cpp is spawned on-demand for each generation. Generation failures are reported via the returned promise or HTTP error responses.

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

**Environment Variables:** Configure TTL with `IMAGE_RESULT_TTL_MS` (default: 300000) and `IMAGE_CLEANUP_INTERVAL_MS` (default: 60000). If polling too slowly, results may expire. **Note:** These environment variables only take effect when using the singleton `diffusionServer` (which creates the registry internally). Direct `GenerationRegistry` construction ignores env vars — use constructor options instead.

---

## See Also

- [Resource Orchestration](resource-orchestration.md) - Automatic LLM offload/reload
- [Model Management](model-management.md) - Downloading diffusion models
- [System Detection](system-detection.md) - Hardware capability detection
- [Integration Guide](integration-guide.md) - Electron patterns and lifecycle
- [Troubleshooting](troubleshooting.md) - Common issues
