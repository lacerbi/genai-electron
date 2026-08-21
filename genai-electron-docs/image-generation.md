# Image Generation

Generate images locally using stable-diffusion.cpp through DiffusionServerManager. A small HTTP wrapper is the public server; the actual inference runs in a persistent `sd-server` backend process that can stay warm between images. Supports both a synchronous Node.js API and an asynchronous HTTP API with a polling pattern.


---

## Overview

`DiffusionServerManager` manages local image generation using stable-diffusion.cpp. The public server is an HTTP wrapper (node:http) that genai-electron runs inside your process; inference happens in an internal `sd-server` child process — the stable-diffusion.cpp *server* binary shipped in the same pinned archive — which is spawned lazily on the first image request and driven through its native async job API.

Consequences worth knowing up front:

- **`start()` holds no VRAM.** It brings up the wrapper only; no model is read and no GPU memory is claimed until the first image is requested.
- **The backend can stay resident.** After an image it either stays warm (`'burst'` — the next image skips the model load, measured ~33-39% faster on the reference machine) or is torn down together with its VRAM (`'single'`). See [Backend Residency](#backend-residency).
- **Results never touch disk.** Images travel from the backend as base64 inside the job JSON; there are no temporary PNG files.
- **A backend crash is not a server crash.** The wrapper keeps serving, the in-flight generation fails with `BACKEND_ERROR`, and the next request respawns the backend — see [Backend crashes](#backend-crashes).

**Features:** Binary auto-download with variant testing, Node.js API (`generateImage()`), HTTP API (async polling), batch generation (1-5), progress tracking, single/burst backend residency, automatic resource orchestration (works for both APIs).

```typescript
import { diffusionServer, DiffusionServerManager } from 'genai-electron';
```

---

## Server Lifecycle

### start(config)

Starts the HTTP wrapper. Auto-downloads the binary on first run. **No model is loaded and no VRAM is held by `start()`** — the `sd-server` backend is spawned on the first image request.

**Config:**

| Field | Default | Meaning |
|---|---|---|
| `modelId` | **required** | Diffusion model to serve |
| `port` | `8081` | Wrapper port; `'auto'` picks a free OS-assigned port (resolved value on `DiffusionServerInfo.port`) |
| `host` | `'127.0.0.1'` | Interface the wrapper binds to |
| `startupTimeout` | `120000` | Max ms for the **backend** to go spawn → ready (not `start()` itself) |
| `usageMode` | `'auto'` | Default residency policy: `'auto'` \| `'burst'` \| `'single'` — see [Backend Residency](#backend-residency) |
| `idleTimeoutMs` | `300000` | How long a `'burst'`-resident backend may idle before it is released; `0` = never |
| `threads` | auto | CPU threads; passed to the backend as `-t` at launch |
| `gpuLayers` | — | Accepted for config-shape compatibility but **not** passed to sd.cpp — GPU offload is automatic |
| `forceValidation` | `false` | Re-run binary validation even if a cached result exists |
| `clipOnCpu`, `vaeOnCpu`, `offloadToCpu`, `diffusionFlashAttention` | auto | Offload flags (see below) — these are **launch** flags, so changing them respawns the backend |
| `batchSize` | `1` | Maps to `batch_count` in the backend job request |

> **Behavior change:** the wrapper binds **`127.0.0.1` (loopback only)** by default. Earlier versions bound every interface. The wrapper is unauthenticated and allows CORS from any origin, so widen the bind (`host: '0.0.0.0'`) only behind deliberate network controls.

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

**Behavior change (v0.10.0):** CPU offloading flags are now auto-detected identically on all backends, including CUDA. The old CUDA suppression worked around a silent crash in sd.cpp builds up to `master-504-636d3cb`; that crash is fixed upstream (re-verified live on the current `master-782-b290693` pin). Low-VRAM CUDA setups may therefore now auto-enable `--clip-on-cpu`/`--vae-on-cpu`/`--offload-to-cpu` — pass explicit `false` to restore the old behavior. Upstream caveat: SD3.5-Large is broken with `--clip-on-cpu` on any backend (leejet/stable-diffusion.cpp#1578).

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
Batch size for processing. Maps to `batch_count` in the backend's job request (the first image of the batch is returned). If not specified, `batch_count: 1` is sent — sd.cpp's own default. Not to be confused with `ImageGenerationConfig.count`, which asks the library for N separate images.

### stop()

Stops the diffusion server gracefully.

**Example:**
```typescript
await diffusionServer.stop();
```

In order: closes the POST gate (further requests get `503 SERVER_NOT_RUNNING`), cancels any ongoing generation (its status becomes `'cancelled'`), **releases the `sd-server` backend and waits for its confirmed death**, closes the HTTP wrapper, and destroys the generation registry.

Calling `stop()` on an already-stopped server is not a no-op for the backend: it still releases a backend left behind by `calibrate()`, which runs while the wrapper's own status is `'stopped'`.

---

## Backend Residency

The `sd-server` backend is spawned lazily on the first image request and is the only thing that holds VRAM. What happens to it *after* an image is a policy — the **usage mode**:

| Mode | After the image | Cost / benefit |
|---|---|---|
| `'single'` | Backend is killed immediately; VRAM goes back to ~0 | Every image pays the model load again |
| `'burst'` | Backend stays resident until the idle timer fires (or you release it) | Follow-up images skip the model load (~33-39% faster per image), but the VRAM stays claimed |

> Reference numbers (RTX 4060 Laptop 8 GB, Flux 2 Klein, 768², 4 steps, `--offload-to-cpu --diffusion-fa`): a cold image ≈ 11 s, a warm one ≈ 7 s. Your machine, model, size, and offload flags all move these — [offload calibration](#offload-calibration) measures them for you.

### How the mode is chosen

Precedence, highest first:

1. **Per request** — `ImageGenerationConfig.usageMode` (`generateImage({ ..., usageMode: 'burst' })`, or `usageMode` in the POST body).
2. **Per server** — `DiffusionServerConfig.usageMode`, when it is not `'auto'`.
3. **Computed** (the `'auto'` default) — `'single'` when the resource orchestrator had to offload the LLM to make room for *this* image, `'burst'` otherwise.

The computed default is what keeps an LLM + diffusion machine from thrashing: if the image only fit because the LLM was stopped, the backend gives its VRAM straight back so the LLM can return.

```typescript
// A one-off image on a tight machine: release the VRAM as soon as it is done
await diffusionServer.generateImage({ prompt: 'a lighthouse', usageMode: 'single' });

// A burst of variations: keep the model warm across all of them
await diffusionServer.start({ modelId: 'flux-2-klein', usageMode: 'burst', idleTimeoutMs: 120_000 });
```

### Idle timeout

A `'burst'`-resident backend is released automatically after `idleTimeoutMs` (default **300 000 ms = 5 minutes**) of no generations. Set `idleTimeoutMs: 0` to disable the timer entirely — the host then owns the release (via `releaseBackend()` or `stop()`). This is diffusion-only; the LLM server has no idle timer.

### releaseBackend(options?)

```typescript
releaseBackend(options?: {
  reason?: DiffusionBackendReleaseReason;
  waitForInFlight?: boolean;
}): Promise<void>
```

Frees the backend (and its VRAM) without stopping the wrapper. Idempotent and safe at any time: an absent backend returns immediately, an in-progress release is joined rather than duplicated, and an in-progress *spawn* is aborted rather than waited out. Resolves only after confirmed process death.

- `reason` (default `'explicit'`) is echoed on the `'backend-status'` event and decides whether a deferred LLM reload fires (see below).
- `waitForInFlight: true` lets a generation that is already running finish first.

```typescript
// Free the GPU for something else, keep serving requests
await diffusionServer.releaseBackend();
```

### getBackendInfo()

```typescript
getBackendInfo(): DiffusionBackendInfo
```

Returns `{ state, pid?, startedAt?, loadTimeMs?, lastUsedAt?, flags? }`. `state` is one of `'absent' | 'starting' | 'ready' | 'busy' | 'stopping'`; every other field is present only while a process exists. `flags` records the four offload flags the resident process was launched with — because those are launch arguments, a request that resolves to different flags forces a respawn (release reason `'flags-changed'`).

The same snapshot is on `getInfo().backend`, and `getInfo().pid` / `getPid()` report the **backend** PID while it is resident (the wrapper is in-process and has no PID of its own).

```typescript
if (diffusionServer.getBackendInfo().state === 'ready') {
  console.log('the next image skips the model load');
}
```

### 'backend-status' event

Every backend state transition is emitted as `'backend-status'` with a `DiffusionBackendStatusEvent`:

```typescript
diffusionServer.on('backend-status', ({ state, previous, reason, exit }) => {
  console.log(`backend ${previous} -> ${state} (${reason ?? 'n/a'})`);
  if (reason === 'crashed') console.warn('backend exited unexpectedly', exit);
});
```

`reason` is either a forward transition (`'spawned'`, `'ready'`, `'job'`), a spawn that never became ready (`'start-failed'`), or one of the release reasons: `'single'`, `'idle-timeout'`, `'explicit'`, `'flags-changed'`, `'cancel'`, `'crashed'`, `'stop'`, `'shutdown'`, `'llm-start'`, `'calibration'`.

### Deferred LLM reload under `'burst'`

When the orchestrator offloaded the LLM for an image and the mode resolves to `'burst'`, the backend deliberately stays warm and **the LLM reload is deferred** — it fires when the backend is finally released for a reason that means "the VRAM is free again": `'idle-timeout'`, `'explicit'`, `'crashed'`, or `'stop'`. See [Resource Orchestration](resource-orchestration.md#residency-and-the-reload-decision).

### Backend crashes

If the backend dies unexpectedly, the in-flight generation fails with wire code `BACKEND_ERROR`, the backend state goes to `'absent'` with a `'backend-status'` event carrying `reason: 'crashed'` and the process `exit` details, and **the wrapper stays `'running'`** — the next request simply respawns the backend. `isHealthy()` is wrapper-scoped by design and is unaffected by backend residency, so a `'single'`-mode release after every image never flips a health poll to `false`.

`DiffusionServerManager` still never emits the `'crashed'` event: that event means "the server is down", which a backend exit is not.

---

## Node.js API

### generateImage(config)

Generates a single image on the `sd-server` backend, spawning it first when no backend with matching offload flags is resident. When both LLM and diffusion servers are running, singleton `diffusionServer` automatically offloads/reloads LLM when RAM/VRAM exceeds 75% threshold.

**Config:** `prompt` (required), `negativePrompt`, `width` (512), `height` (512), `steps` (20), `cfgScale` (7.5), `seed` (random), `sampler` ('euler_a'), `count` (1), `usageMode` (see [Backend Residency](#backend-residency)), `onProgress`.

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

Cancels an in-flight async-API generation by its registry ID. Marks the generation `'cancelled'`, halts the batch loop (also between images), and stops the backend job. Idempotent for terminal generations (already complete/error/cancelled — no-op); throws `ServerError` for an unknown ID.

**How the backend job is stopped** depends on how far it got:

- **Still queued** — cancelled through the backend's own job API; the backend stays resident and the next image is still warm.
- **Already generating** — stable-diffusion.cpp cannot interrupt sampling, so the backend process is **killed**. The cost is the same as before this was a persistent process: the next image reloads the model.

The kill is *initiated*, not awaited: `cancelImageGeneration()` (and `DELETE`) resolves as soon as the generation has been rejected, typically within ~1 s. The confirmed death is awaited internally before any respawn, so no new backend can slip past a dying one.

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

**Base URL:** `http://127.0.0.1:{port}` (default: http://127.0.0.1:8081). The wrapper binds loopback only unless `host` says otherwise, so this address is also the *only* one that works by default. Use `127.0.0.1` rather than `localhost` — on Windows the `localhost` → IPv6 lookup adds a noticeable per-request penalty.

### POST /v1/images/generations

Start an async image generation. Returns immediately with a generation ID.

**Request:** JSON with `prompt` (required), `negativePrompt`, `width` (512), `height` (512), `steps` (20), `cfgScale` (7.5), `seed` (random), `sampler` ('euler_a'), `count` (1-5), `usageMode` (`'burst'` | `'single'`; omitted = the server's policy decides — see [Backend Residency](#backend-residency)).

**Response (201 Created):**
```typescript
{ id: string; status: 'pending'; createdAt: number; }
```

**Errors:**
- `400 Bad Request` — missing `prompt`, `count` outside 1-5, `usageMode` that is neither `'burst'` nor `'single'`, or a malformed JSON body (all `code: 'INVALID_REQUEST'`)
- `503 Service Unavailable` — another generation is in flight (`code: 'SERVER_BUSY'`), or the wrapper is not running / is stopping (`code: 'SERVER_NOT_RUNNING'`)

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
- `status: 'cancelled'` - Terminal; generation was cancelled (via DELETE, `cancelImageGeneration()`, or a `stop()` that landed mid-image). No `error` object is attached — a cancellation is not a failure
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

Cancel an in-flight generation. Marks it `'cancelled'`, halts the batch loop, and stops the backend job — a queued job is cancelled through the backend's job API, a generating one by killing the backend process. The response is sent as soon as the cancellation has been *initiated* (well inside genai-lite's 5 s DELETE budget); the confirmed process death is awaited internally before the next spawn.

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
{ status: 'ok'; busy: boolean; backend: DiffusionBackendState; }
```

`backend` is the internal `sd-server` state (`'absent' | 'starting' | 'ready' | 'busy' | 'stopping'`) — `'absent'` is normal and healthy, it just means the next image pays the model load.

**Example:**
```typescript
const { status, busy, backend } = await (await fetch('http://127.0.0.1:8081/health')).json();
```

### Error Codes Reference

| Code | Description | Typical Cause |
|------|-------------|---------------|
| `SERVER_BUSY` | Server is processing another generation | Multiple concurrent requests |
| `SERVER_NOT_RUNNING` | The wrapper is stopped or stopping | POST after `stop()` (503) |
| `NOT_FOUND` | Generation ID not found | Invalid ID or expired (TTL) |
| `INVALID_REQUEST` | Invalid parameters | Missing prompt, invalid `count`/`usageMode`, malformed JSON body |
| `ALREADY_TERMINAL` | Generation is already `complete`/`error` | DELETE arriving too late |
| `GENERATION_CANCELLED` | Internal classification for a cancelled generation | DELETE, `cancelImageGeneration()`, or `stop()` mid-image. Pollers normally observe this as the terminal **`status: 'cancelled'`** rather than as an `error.code` — the cancellation is not reported as a failure |
| `BACKEND_ERROR` | The `sd-server` backend failed the job | Failed job (CUDA/OOM), backend exited or crashed mid-job, spawn never became ready, backend job queue full |
| `IO_ERROR` | The returned image could not be decoded | Empty/absent base64 payload in the job result |
| `INTERNAL_ERROR` | Unhandled error inside a route | Bug — check `diffusion-server.log` |
| `UNKNOWN_ERROR` | Unclassified failure | Fallback when nothing else matched |

### Batch Generation

Generate multiple variations (1-5 images) with auto-incremented seeds. Set `count: 3` to generate 3 images with seeds 42, 43, 44 (if seed=42).

Batch generation now goes through the resource orchestrator like a single image: the LLM is offloaded **once** for the whole batch, all `count` images run inside that one window, and residency is settled once after the last one. The images are still produced one at a time (per-image progress, cancellable between images).

### Migration from Phase 2.0

**Breaking Change:** Phase 2.5 changed from synchronous (POST blocks until complete) to async polling (POST returns ID immediately, poll GET endpoint for results). See polling examples above.

---

## Progress Tracking

Progress provides stage information with self-calibrating time estimates.

### Stages

1. **Loading** (~20%): On a **cold** backend, process spawn plus weight placement; on a **warm** (`'burst'`-resident) backend, only the short pre-sampling/conditioning work — so this stage is much shorter for the 2nd..nth image of a burst
2. **Diffusion** (~30-50%): Denoising steps (main process), reports actual step count
3. **Decoding** (~30-50%): VAE decoding latents to image, reports estimated progress

Progress is derived from the backend's stdout (step bar plus a small table of stage marker literals) combined with job polling — the pinned stable-diffusion.cpp build reports no progress in the job JSON itself.

### Self-Calibrating Estimates

System adapts time estimates based on hardware: first generation uses defaults, subsequent generations adjust to image size/steps. Cold and warm generations are estimated separately, so a cold image after a run of warm ones does not distort the bar.

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

**Config:**
- `modelId` (**required**).
- `sizes` (**required**) — the image size(s) your app generates at (`{ width, height }`, positive multiples of 64). Compute scales with area, so the fastest combo can differ by size.
- `generation` (**required**) — the production generation parameters the sweep must mirror, as a unit: `steps`, `cfgScale`, `sampler` (all required) plus optional `threads`/`batchSize`. See the ⚠️ below.
- `usageMode` (default `'single'`) — **what the sweep measures**; see [Calibration modes](#calibration-modes).
- `combos` (default: curated labeled set in `DIFFUSION_CALIBRATION_DEFAULTS`: `auto`, `clip-gpu`, `clip-gpu+offload`, `offload`, `all-resident`, `max-savings`).
- `samples` (default 2 timed samples per combo × size, after 1 discarded warmup per combo).
- `seed` (default 42, fixed so every combo does identical work), `prompt` (neutral benchmark; does not affect timing), `onProgress`, `signal`.

> ⚠️ **`generation` must match what you generate with in production** — these parameters define the *compute profile* the sweep measures, and a mismatch makes the benchmark rank the combos wrong. In particular **`cfgScale`**: a value > 1 enables classifier-free guidance, which runs **two model passes per step (~2× the diffusion cost)** and can flip which offload combo wins. Guidance-distilled models (Flux Klein, SDXL-Lightning/Turbo) run at `cfgScale: 1`; standard models are typically 5–8. (`steps`, `cfgScale`, `sampler`, and `sizes` have no library defaults precisely so calibration can never *silently* diverge from production.)

Default sweep cost: 6 combos × (1 warmup + 2 samples) = 18 generations per size — typically a few minutes.

**Contract:**
- The server must be **stopped** and is left stopped, with no backend resident. `start()` throws while calibrating; `isCalibrating()` exposes the state (`getInfo().busy` may briefly read `true` while `status` stays `'stopped'` — harmless).
- The sweep **manages the backend itself** — offload flags are launch arguments, so each combo gets its own process launch — and never settles residency for you.
- `usageMode` decides whether a timed sample is cold or warm, and the report echoes it along with `policyVersion`; results are only comparable across reports that share both.
- When the manager is wired for orchestration (the `diffusionServer` singleton is), a running LLM is offloaded **once** for the whole sweep and restored afterwards. Without orchestration wiring, stop the LLM yourself before calibrating.
- Failing combos are recorded (`status: 'oom' | 'error'`) and never abort the sweep; the `max-savings` fallback combo means something usually succeeds even on very tight VRAM.
- `recommended` is keyed `"<width>x<height>"` (e.g. `"768x768"`) and holds combos **as requested** — the winner may be the plain auto combo; what auto-detection resolved to is in the winning run's `resolved`. Ties within 5% of the fastest prefer fewer forced flags (robustness).

**Example** (an app that commits to specific illustration sizes):

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }, { width: 512, height: 1024 }], // your app's real sizes
  generation: {
    steps: 4, // your app's quality preset
    cfgScale: 1, // MUST match production — Flux Klein is guidance-distilled (cfg 1)
    sampler: 'euler',
    // threads / batchSize: pass your production values here if you set them
  },
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

### Calibration modes

Because the backend can now stay resident, a sweep has to say *which* latency it is measuring. `config.usageMode` picks it and `report.usageMode` echoes the resolved value:

| Mode | What one timed sample is | `timeTakenMs` means | Backend launches per combo |
|---|---|---|---|
| `'single'` (**default**) | release → **spawn** → generate → release | Cold single-shot latency: process start + weight placement + sampling + decode | `1 + samples × sizes` |
| `'burst'` | one launch, a discarded warmup, then warm generations | Latency of the 2nd..nth image of a burst | `1` |

- **`'single'` is the default** because it mirrors the common one-off production request, and because it keeps the same semantics `timeTakenMs` had before the backend became persistent (every image used to spawn a fresh process).
- **The two modes are not comparable.** Warm medians run far below cold ones. Only compare reports that share `usageMode` — and keep the mode in whatever key you persist recommendations under.
- **`stageMs.loadMs` changes meaning with the mode.** It always spans "sample start → the backend's first `generating` marker", but in `'single'` that start is the process **spawn** (so `loadMs` is a real model load), while in `'burst'` it is the **job submission** on already-resident weights (so `loadMs` is just the small conditioning time). `diffusionMs` and `decodeMs` mean the same thing in both modes.
- Whichever mode is used, calibration is **report-only**: it never settles residency for you and always leaves the server stopped and the backend released.

### Report versioning and VRAM figures

- **`report.policyVersion`** is `'diffusion-offload-v2'` — the identifier for reports measured against the resident `sd-server` backend. A persisted report with **no** `policyVersion` field is a pre-migration v1 report (measured by spawning the one-shot CLI once per image): treat it as `usageMode: 'single'`-comparable at best, and prefer re-measuring.
- **`runs[].vramPeakBytes` / `runs[].vramIdleBytes`** report `vramTotal − min(vramAvailable)` during the representative timed sample and `vramTotal − vramAvailable` once it settled (after the release in `'single'`, right after the job in `'burst'` — so `'burst'` shows what a combo keeps resident *between* images). These figures are **machine-wide**, sampled at roughly 1 s resolution, so anything else using the GPU is included. Both fields are omitted together whenever GPU telemetry is unavailable or untrusted at any point of the window, and always on macOS (unified memory, no VRAM availability telemetry) — i.e. in practice they are NVIDIA-on-Linux/Windows only.

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }],
  generation: { steps: 4, cfgScale: 1, sampler: 'euler' },
  usageMode: 'burst', // measure the warm latency of an image burst instead
});

console.log(report.usageMode, report.policyVersion); // 'burst' 'diffusion-offload-v2'
for (const run of report.runs) {
  console.log(run.combo.label, run.timeTakenMs, run.vramPeakBytes, run.vramIdleBytes);
}
```

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
  await diffusionServer.calibrate({ modelId, sizes, generation, signal: controller.signal });
} catch (error) {
  if (error.details?.code === 'CALIBRATION_ABORTED') {
    console.log('Aborted; partial results:', error.details.runs);
  } else throw error;
}
```

### Caveats

- **Calibrate with your real settings** (`generation` + `sizes`). `offloadToCpu` overhead scales with step count, larger sizes shift the optimum (hence per-size recommendations), and — most impactfully — `cfgScale > 1` doubles the diffusion work (two passes/step) and can invert the ranking. The report echoes `steps`/`cfgScale`/`sampler`/`samples` so a persisted recommendation records the exact methodology it was measured under.
- **Sizes must be positive multiples of 64** (sd.cpp constraint; validated up-front).
- **SD3.5-Large:** combos forcing `clipOnCpu: true` are skipped automatically (garbled output upstream — leejet/stable-diffusion.cpp#1578) and listed in `report.skippedCombos`. Auto-detection may still resolve `clipOnCpu` on for auto combos on low-VRAM machines — prefer explicit `clipOnCpu: false` combos for this model family.
- **Timing noise:** thermal throttling and background load perturb results; the raw per-sample totals are kept in `runs[].samplesMs`. `timeTakenMs` is the median (with `samples: 2`, the mean of both).
- **Mode decides whether the model load is inside the measurement.** In the default `'single'` mode every timed generation includes the backend spawn and the model load — representative of a one-off request; in `'burst'` the weights are already resident. The per-stage split is in `runs[].stageMs` (`loadMs`/`diffusionMs`/`decodeMs`), and `loadMs` follows the mode (see [Calibration modes](#calibration-modes)).
- **Report-only, and it restarts processes.** The sweep launches and releases the backend itself (offload flags are launch arguments, so each combo needs its own process); it requires a stopped server and leaves both the server and the backend down when it finishes.

---

## Status and Health

### getStatus()

Gets current server status (synchronous). Returns `ServerStatus`: `'stopped'` | `'starting'` | `'running'` | `'stopping'` | `'crashed'`. In practice the diffusion server never reports `'crashed'` — the wrapper runs in-process, and a backend failure is reported through [`'backend-status'`](#backend-status-event) instead.

```typescript
const status = diffusionServer.getStatus();
```

### getInfo()

Gets detailed server information (synchronous). Returns `DiffusionServerInfo` with `status`, `health`, `busy`, `pid`, `port`, `modelId`, `startedAt`, `error`, `backend`.

- `backend` is the [`DiffusionBackendInfo`](#getbackendinfo) snapshot of the internal `sd-server` process.
- `pid` is the **backend** process ID while it is resident, and absent otherwise — the public server is an in-process HTTP wrapper and has no PID of its own. `getPid()` reports the same value.

```typescript
const info = diffusionServer.getInfo();
console.log(info.status, info.backend?.state, info.pid);
```

### isHealthy()

Checks if the wrapper is responding (async). Returns `Promise<boolean>`.

**Wrapper-scoped by design:** this reflects the HTTP wrapper only, never backend residency — a `'single'`-mode release after every image must not flip a periodic health poll to `false`. Use `getBackendInfo().state` (or `/health`'s `backend` field) if you want to know whether the model is warm.

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

During ZIP extraction, `'binary-progress'` adds `writtenBytes` / `totalUncompressedBytes` alongside
`completedEntries` / `totalEntries`. Extraction `percent` uses the byte ratio when available,
falls back to entries, and is omitted without a positive denominator. ZIP work runs in a
self-contained worker, so it does not block Electron's main event loop or resolve a loose
`adm-zip` package at runtime. `adm-zip` inflates each complete entry before writing it, so byte
updates measure writes rather than streaming decompression. After all writes, `phase: 'finalizing'`
names worker/isolate resource release until exit; after validation, `phase: 'installing'` names the
candidate-copy and publication tail. Neither phase claims a percentage.

- `'started'` - Server started successfully (receives `DiffusionServerInfo`)
- `'stopped'` - Server stopped
- `'binary-log'` - Binary download/validation progress (receives `{ message, level }`); the same messages are persisted to `diffusion-server.log` from the beginning of `start()`
- `'binary-progress'` - Structured provisioning progress (receives `BinaryProgressEvent`: phase + file + throttled download/ZIP-write percentages, ZIP entry counters, and phase-only finalization/installation tails) — build progress UIs from this instead of parsing log messages
- `'calibration-progress'` - Offload-calibration sweep progress (receives `DiffusionCalibrationProgress`; same payload as the `calibrate()` `onProgress` callback) — see [Offload Calibration](#offload-calibration)
- `'backend-status'` - Internal `sd-server` backend transition (receives `DiffusionBackendStatusEvent`) — see [Backend Residency](#backend-residency)

**Note:** DiffusionServerManager never emits a `'crashed'` event. That event means "the server is down", and the public server here is the in-process HTTP wrapper, which survives a backend failure. A backend that dies unexpectedly surfaces as `'backend-status'` with `reason: 'crashed'`, the in-flight generation fails with `BACKEND_ERROR`, and the next request respawns it. Other generation failures are reported via the returned promise or HTTP error responses.

---

## Binary Management

The validated primary binary is **`sd-server(.exe)`** — the stable-diffusion.cpp server the library actually runs. The one-shot `sd-cli` binary is still extracted from the archive but is no longer executed by genai-electron.

> **One-time re-validation on existing installs:** because the primary binary name changed, an already-installed diffusion binary re-runs its validation once on the next `start()`. Nothing is re-downloaded (the pinned version is unchanged and the working variant is preserved); on macOS/Linux the exec bit is repaired first so the re-validation succeeds rather than triggering a redownload.

Phase-2 validation exercises the **production launch path**: it starts `sd-server` with the same runner and argv shape the manager uses, submits one 64×64 1-step job through the native job API, and passes only if the job completes with no GPU error diagnostics in the output. The backend is always stopped afterwards, and a termination that cannot be confirmed aborts the variant loop rather than extracting the next variant over a live child.

The phase-2 image test receives the same resolved `clipOnCpu`, `vaeOnCpu`,
`offloadToCpu`, and `diffusionFlashAttention` flags that production generation
would use at that moment. Batch size and thread count remain outside the tiny
validation workload.

CUDA dependencies are recorded in `.deps.json` by checksum, so byte-identical
runtime archives are reused across release URL changes. A restart after
interrupted provisioning clears stale staging and reuses complete
checksum-valid archives. If installation had already completed, the
validated-binary fast path removes leftover main archives and extraction
directories while retaining an unmanifested dependency archive for recovery.

On first `start()`: Downloads binary (~50-100MB), tests variants (CUDA → Vulkan → CPU) with real functionality test (64x64 image through `sd-server`), falls back if test fails, caches working variant. Subsequent starts skip tests and verify checksum only (~0.5s). Use `forceValidation: true` after driver updates. Real functionality testing requires model; falls back to `--help` test if model missing.

The library also creates and owns `<userData>/loras` and passes it to the backend as `--lora-model-dir`. It is normally empty — pointing sd.cpp at the models directory instead would make it try to read model files as LoRAs.

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
