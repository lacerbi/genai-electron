# Resource Orchestration

Automatically manage system resources when running both LLM and image generation servers simultaneously. ResourceOrchestrator handles temporary LLM offload/reload when memory is constrained.

## Navigation

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Residency and the Reload Decision](#residency-and-the-reload-decision)
- [LLM Start Yields the Diffusion Backend](#llm-start-yields-the-diffusion-backend)
- [Automatic vs Manual Usage](#automatic-vs-manual-usage)
- [API Reference](#api-reference)
- [Example Scenarios](#example-scenarios)

---

## Overview

`ResourceOrchestrator` provides automatic resource management between LLM and image generation servers. When system resources (RAM or VRAM) are constrained, it automatically:
1. Detects if offload is needed
2. Saves LLM server state and stops it (frees memory)
3. Generates the image
4. Releases the stable-diffusion.cpp backend (or keeps it warm, per the residency policy)
5. Restarts LLM server with saved configuration

Orchestration is **symmetric**: an image request may offload the LLM, and — through a pre-start hook — an LLM start may release a resident stable-diffusion.cpp backend. Whichever side is about to load asks the other one to make room.

**Note**: When using the singleton `diffusionServer`, orchestration happens automatically - you typically don't need to use `ResourceOrchestrator` directly. This class is primarily for advanced use cases like custom orchestrator instances or programmatic resource status checking. To *observe* the built-in one, use [`diffusionServer.getOrchestrator()`](#diffusionservergetorchestrator); an orchestrator you construct yourself is a *separate* instance and does not participate in the built-in deferred reloads — see [Built-in vs custom orchestrator](#built-in-vs-custom-orchestrator).

**When to use:**
- Running both llama-server and diffusion server on limited RAM/VRAM
- Want automatic LLM offload/reload during image generation
- Need to ensure enough memory for image generation without manual management

**When NOT needed:**
- System has ample resources (>= 24GB VRAM or >= 32GB RAM)
- Only running one server at a time
- Using separate machines for LLM and diffusion

---

## How It Works

### Bottleneck Detection

**GPU Systems:** Uses VRAM as bottleneck if GPU is available
**CPU-Only Systems:** Uses RAM as bottleneck

### Resource Estimation

**LLM Usage:**
- **GPU mode:** `VRAM = model_size * (gpu_layers / total_layers) * 1.2`
- **CPU mode:** `RAM = model_size * 1.2`

**Diffusion Usage:**
- `RAM/VRAM = model_size * 1.2`

> **Multi-component models:** Resource estimation uses `modelInfo.size` (pre-computed aggregate of all component file sizes) × 1.2 overhead. This is conservative — with `--offload-to-cpu`, only the largest single component needs to fit in VRAM at any time. Future versions may refine this to check per-component VRAM requirements.

> **The estimator is still size-based, not measured.** `size × 1.2` deliberately did not change when the diffusion backend became a persistent process, so a *resident* backend can still trigger an offload/reload cycle that measured VRAM would have shown to be unnecessary. The per-run `vramPeakBytes` / `vramIdleBytes` figures that [offload calibration](image-generation.md#report-versioning-and-vram-figures) now records are the intended input for a measured estimator; until that lands, the conservative arithmetic is what decides.

### Offload Decision

- **GPU systems:** Combined VRAM usage > `totalVRAM × 0.75` → Offload LLM
- **CPU-only systems:** Combined RAM usage > `availableRAM × 0.75` → Offload LLM
- If combined usage is within the threshold → Generate directly without offload

### Offload/Reload Cycle

1. Check if LLM server is running
2. If running, save configuration (modelId, port, threads, gpuLayers, etc.)
3. Stop LLM server gracefully (frees memory)
4. Generate the image(s) — this spawns the stable-diffusion.cpp backend, which is what actually claims the VRAM
5. **Settle diffusion residency** for the request (`'single'` = release the backend now and wait for its confirmed death; `'burst'` = keep it warm and arm its idle timer)
6. **Return the image result immediately**
7. Under `'single'`: restart the LLM server asynchronously in the background. Under `'burst'`: **defer** the restart until the backend is released
8. Clear saved state after reload completes

**Release before reload:** step 5 finishes before step 7 starts, so the backend and `llama-server` never hold VRAM at the same time. (Before this ordering existed, the reload could race a still-running diffusion process.)

**Note:** The LLM reload (step 7) runs asynchronously after the image result is returned. This eliminates a 10-30s delay between image generation completing and the result appearing. Use `waitForReload()` if you need to ensure the LLM is fully restored before proceeding — but read the [`'burst'` caveat](#waitforreload) first.

**Cancellation:** If an orchestrated generation is cancelled (or otherwise fails) after the LLM was offloaded, residency is still settled and the LLM comes back on the same schedule a successful image would have used — immediately under `'single'`; under `'burst'` a cancelled generation kills the backend, which is itself a qualifying release, so the deferred reload fires then. Either way the LLM is restored even when no image is produced.

---

## Residency and the Reload Decision

After an orchestrated image the diffusion backend either goes away or stays warm; that choice is the [usage mode](image-generation.md#backend-residency), and it decides *when* the LLM comes back.

- **`'single'`** (the computed default whenever the LLM had to be offloaded) — the backend is released immediately and the LLM reload starts right after. This is the loop-breaker: it prevents an LLM start → backend release → image → offload → burst → … ping-pong where every cycle pays a full model load.
- **`'burst'`** — reached here only by an explicit per-request or per-server `usageMode`, since `'auto'` never picks it after an offload. The backend stays resident, the saved LLM state is kept, and **no reload is started yet**. The LLM comes back when the backend is finally released.

A release only brings the LLM back when it really means "the VRAM is free and nobody else is about to take it":

| Release reason | Reloads a deferred LLM? | Why |
|---|---|---|
| `'idle-timeout'` | ✅ | The burst is over |
| `'explicit'` | ✅ | The host called `releaseBackend()` |
| `'crashed'` | ✅ | The backend is gone either way |
| `'stuck'` | ✅ | The [activity watchdog](image-generation.md#stuck-jobs-the-activity-watchdog) cut a hung job loose and released the backend — same situation as a crash |
| `'stop'` | ✅ | `diffusionServer.stop()` |
| `'cancel'` | ✅ | The cancelled generation killed the backend and then ended — under `'burst'` nothing else would ever release it |
| `'single'` | ❌ | The orchestration branch above already reloads — reloading here too would double it |
| `'llm-start'` | ❌ | Fired from inside the LLM's own pre-start hook; that start is already under way |
| `'shutdown'` | ❌ | The app is quitting; nothing may start after `app.exit(0)` |
| `'calibration'` | ❌ | A sweep releases between combos and restores the LLM itself |
| `'flags-changed'` | ❌ | The same image immediately respawns the backend with different flags |

Reloads are additionally suppressed while `diffusionServer.isCalibrating()` and while another reload is already in flight — and a release whose LLM is *already running again* (the host started it itself) drops the saved state instead of starting a second server. Exactly one reload happens per offload cycle regardless of which path triggers it.

**A later non-offload request can also bring the LLM back.** If an earlier `'burst'` cycle left a saved LLM state and a *subsequent* request needs no offload but settles to `'single'`, that release frees the VRAM for good — so the no-offload branch reloads the LLM itself. Without that, a burst-then-single sequence would leave the LLM down forever.

**Practical consequence:** if you ask for `usageMode: 'burst'` on a machine that needed the offload, plan for the LLM to be down for up to `idleTimeoutMs` (default 5 minutes). Call `diffusionServer.releaseBackend()` when your burst is over — or set a shorter `idleTimeoutMs` — to bring it back sooner. With `idleTimeoutMs: 0` there is **no** timer at all: after a `'burst'`-after-offload the LLM stays down until you release the backend yourself or issue a request that settles `'single'`.

---

## LLM Start Yields the Diffusion Backend

The reverse direction is handled by a `LlamaServerManager` **pre-start hook** that the diffusion manager registers for you whenever it is wired for orchestration (the `diffusionServer` singleton is):

1. `llamaServer.start()` flips its status to `'starting'`, then runs the hooks.
2. If an offload calibration sweep is running, the hook throws `ServerError` with `details.code: 'CALIBRATION_IN_PROGRESS'` — the sweep owns the backend and restores the LLM itself, so a manual `start()` fails loudly rather than racing it. (On the auto-restart path hook errors are logged and ignored, so a watchdog restart is not consumed by a sweep.)
3. `ResourceOrchestrator.prepareForLLMStart({ config })` then no-ops unless a stable-diffusion.cpp backend is actually resident (`'starting' | 'ready' | 'busy'`).
4. It runs the same 75% arithmetic as the image path, but estimating the LLM from the configuration it is *about to* start with rather than from a running server.
5. If both would not fit, it awaits `releaseBackend({ reason: 'llm-start', waitForInFlight: true })` — an image already in flight is allowed to finish, and reason `'llm-start'` suppresses any reload from inside the hook.
6. Only then does the LLM proceed to port/binary/model work.

If both fit, the backend is left alone and the two coexist. See [`registerPreStartHook()`](llm-server.md#registerprestarthook) for the hook contract itself.

**The hook sees the raw configuration.** `start()` auto-configures `gpuLayers` *after* the hooks run, so a config that omits it would price the LLM at 0 VRAM and the two would always "fit". The estimate therefore resolves an omitted `gpuLayers` the way auto-configuration will (the same `SystemInfo.getOptimalConfig()` call with the same hints; a full GPU offload if that is unavailable). An **explicit** `gpuLayers: 0` is honoured as "CPU-only LLM" and yields nothing — the backend stays resident.

**Quit-time:** `attachAppLifecycle()` releases the diffusion backend with reason `'shutdown'` **before stopping the diffusion server** (the LLM server is stopped first) — including a backend left behind by `calibrate()`, which runs while the wrapper's own status is `'stopped'`. Because `'shutdown'` never reloads, nothing races `app.exit(0)`.

---

## Automatic vs Manual Usage

### Automatic (Built into Singleton)

The singleton `diffusionServer` has built-in orchestration - no additional code needed:

```typescript
import { llamaServer, diffusionServer } from 'genai-electron';

// Start both servers
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });

// Generate image - automatic resource management included
const result = await diffusionServer.generateImage({
  prompt: 'A beautiful sunset over mountains',
  width: 1024,
  height: 1024,
  steps: 30
});

// Image returned immediately — LLM reloads asynchronously in background
console.log('Image generated, LLM reloading in background');
```

**Batch generation is orchestrated too.** A request with `count > 1` opens **one** offload window around the whole batch (`orchestrateBatchGeneration()`): the LLM is offloaded at most once, all images run inside that window, and residency is settled once after the last one.

### Built-in vs custom orchestrator

Everything described above — deferred reloads, the LLM pre-start hook, `onDiffusionBackendReleased()` — belongs to the **built-in** orchestration: the one a `DiffusionServerManager` constructs internally when it is given a `LlamaServerManager`. The exported `diffusionServer` singleton is wired that way to the exported `llamaServer`.

**Reach the built-in one with [`diffusionServer.getOrchestrator()`](#diffusionservergetorchestrator)** — it hands back that live instance, so `getSavedState()` and `waitForReload()` on it describe the offloads you are actually seeing.

An orchestrator you construct yourself is still a **separate instance**:

- Your instance never receives `onDiffusionBackendReleased()` — the manager only calls its own — so it never performs a deferred reload.
- `getSavedState()` / `waitForReload()` / `clearSavedState()` on your instance reflect **only the offloads your instance performed** (through `orchestrateImageGeneration()` / `orchestrateBatchGeneration()` / `offloadLLM()`).
- The LLM pre-start hook is registered by the manager for its own orchestrator, not for yours.

Practical rule: use the singleton path and observe it through `getOrchestrator()` (or `llamaServer.getStatus()` / the `'started'` event), **or** drive image generation exclusively through your own `ResourceOrchestrator` — but do not mix a host-constructed orchestrator with singleton-driven generations and expect its saved state to be meaningful.

---

## API Reference

### diffusionServer.getOrchestrator()

Not a method *on* `ResourceOrchestrator`, but the way to get one: it returns the **live built-in** orchestrator of a `DiffusionServerManager`.

```typescript
getOrchestrator(): ResourceOrchestrator | undefined
```

**Returns:** the instance the manager constructed for itself — the one that performs the offloads, deferred reloads, and the LLM pre-start hook. `undefined` only when the manager was constructed without a `LlamaServerManager` (there is no orchestration to do); on the exported `diffusionServer` singleton it is always defined and wired to the exported `llamaServer`.

```typescript
import { diffusionServer } from 'genai-electron';

const orchestrator = diffusionServer.getOrchestrator();
console.log(await orchestrator?.wouldNeedOffload());  // will this image stop the LLM?
console.log(orchestrator?.getSavedState());           // is an LLM currently offloaded?
await orchestrator?.waitForReload();                  // await an in-flight reload
```

Treat it as read-mostly: it is fine to inspect state and await a reload, but driving `offloadLLM()` / `reloadLLM()` on it by hand while the manager is also using it invites two owners for one saved state.

### Constructor

```typescript
new ResourceOrchestrator(
  systemInfo?: SystemInfo,
  llamaServer: LlamaServerManager,
  diffusionServer: DiffusionServerManager,
  modelManager?: ModelManager
)
```

**Parameters:**
- `systemInfo?: SystemInfo` - Optional, defaults to singleton
- `llamaServer: LlamaServerManager` - **Required**
- `diffusionServer: DiffusionServerManager` - **Required**
- `modelManager?: ModelManager` - Optional, defaults to singleton

### orchestrateImageGeneration(config)

Generates an image with automatic resource management.

**Parameters:** `ImageGenerationConfig` - Same as `DiffusionServerManager.generateImage()`

**Returns:** `Promise<ImageGenerationResult>`

**Behavior:**
- If resources ample: Generates directly without offload, then settles residency (default `'burst'` — the backend stays warm)
- If resources constrained: Offloads LLM → generates → settles residency → returns result → reloads LLM asynchronously (`'single'`) or defers the reload (`'burst'`)
- Uses 75% availability threshold
- LLM reload runs in the background — the promise resolves as soon as the image is ready
- Use `waitForReload()` if you need the LLM ready before making inference calls

### orchestrateBatchGeneration(config)

Same offload window as `orchestrateImageGeneration()`, opened once around a whole `count > 1` batch.

**Parameters:** `ImageGenerationConfig` with `count > 1`

**Returns:** `Promise<ImageGenerationResult[]>` — one result per generated image

The LLM is offloaded at most once and residency is settled once, after the last image. Images are still produced sequentially, so per-image progress and cancellation between images are preserved. `diffusionServer` routes `count > 1` requests here automatically; you rarely call it directly.

### wouldNeedOffload()

Checks if generating an image would require offloading the LLM server.

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const needsOffload = await orchestrator.wouldNeedOffload();

if (needsOffload) {
  console.log('⚠️  Image generation will temporarily stop LLM');
  console.log('LLM will be automatically reloaded after generation');
} else {
  console.log('✅ Enough resources - both servers can run simultaneously');
}

// Proceed with generation
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape painting',
  steps: 30
});
```

**Use cases:**
- Warn users about temporary LLM unavailability
- Decide whether to defer image generation
- Display resource status in UI

### getSavedState()

Gets the saved LLM state if the server was offloaded.

**Returns:** `SavedLLMState | undefined`

**SavedLLMState Interface:**
```typescript
interface SavedLLMState {
  config: ServerConfig;   // Original LLM configuration
  wasRunning: boolean;    // Whether LLM was running before offload
  savedAt: Date;          // When state was saved
}
```

**Example:**
```typescript
const savedState = orchestrator.getSavedState();

if (savedState) {
  console.log('LLM was offloaded at:', savedState.savedAt);
  console.log('Original model:', savedState.config.modelId);
  console.log('Original port:', savedState.config.port);
  console.log('GPU layers:', savedState.config.gpuLayers);
  console.log('Was running:', savedState.wasRunning);
} else {
  console.log('No LLM state saved (not offloaded)');
}
```

### clearSavedState()

Clears any saved LLM state. Use if you don't want LLM to be automatically reloaded.

**Returns:** `void`

**Note:** Since `orchestrateImageGeneration()` returns the image result immediately and reloads the LLM asynchronously in the background, calling `clearSavedState()` right after may not prevent a reload that is already in-flight. Use `waitForReload()` first if you need to ensure the reload has completed before clearing state.

**Example:**
```typescript
// Generate image with offload
await orchestrator.orchestrateImageGeneration({
  prompt: 'A mountain landscape',
  steps: 30
});

// Wait for any in-flight reload, then clear state
await orchestrator.waitForReload();
orchestrator.clearSavedState();

// Next generation won't reload LLM
await orchestrator.orchestrateImageGeneration({
  prompt: 'A city skyline',
  steps: 30
});
```

### waitForReload()

Waits for any pending background LLM reload to complete. Resolves immediately if no reload is in progress.

**Returns:** `Promise<void>`

> ⚠️ **Residency caveat:** under `usageMode: 'burst'` after an offload the LLM is *intentionally* still down when this resolves — no reload has been started yet, so there is nothing to wait for. The deferred reload fires when the diffusion backend is released (idle timeout, an explicit `releaseBackend()`, a backend crash, a stuck job, a cancelled generation, or `diffusionServer.stop()`). A caller that needs the LLM back right away should release the backend first:
>
> ```typescript
> await diffusionServer.releaseBackend();   // frees the VRAM, triggers the deferred reload
> await orchestrator.waitForReload();       // the release already started it — this awaits it
> ```
>
> Make sure `orchestrator` is the one that performed the offload: on the singleton path that is `diffusionServer.getOrchestrator()`, not an instance you constructed (see [Built-in vs custom orchestrator](#built-in-vs-custom-orchestrator)).
>
> **Ordering matters.** `waitForReload()` resolves immediately only when it is called *before* any qualifying release. `releaseBackend()` resolves after the release has been processed, and the deferred reload is registered synchronously inside that processing — so a `waitForReload()` issued *after* it really does wait for `llama-server` to come back up.

**On the singleton path, ask the manager for its orchestrator** — no polling loop needed:

```typescript
await diffusionServer.releaseBackend();                    // frees the VRAM, starts the reload
await diffusionServer.getOrchestrator()?.waitForReload();  // …and awaits it
console.log(diffusionServer.getOrchestrator()?.getSavedState()); // undefined once reloaded
```

**Example:**
```typescript
// Generate image — returns immediately, LLM reloads in background
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A mountain landscape',
  steps: 30
});

// Image is ready here, but LLM may still be reloading
console.log('Image ready!', result.image.length, 'bytes');

// Wait for LLM to finish reloading before making inference calls
await orchestrator.waitForReload();
console.log('LLM is back online');
```

**Use cases:**
- Ensuring the LLM is fully restored before sending inference requests
- Testing: asserting on reload behavior after async orchestration
- Sequential workflows that need both image result and LLM availability

### offloadLLM()

Saves the current LLM configuration and stops the server to free resources. Used internally by `orchestrateImageGeneration()` and by `diffusionServer.calibrate()` (sweep-level offload: once for the whole calibration sweep instead of per generation).

**Returns:** `Promise<void>`

**Behavior:**
- No-ops when the LLM server is not running
- Throws `ServerError` if the LLM is running but its configuration cannot be retrieved
- Pair with `reloadLLM()` to restore; call `waitForReload()` first if a background reload may be in flight (an LLM mid-reload reads as not-running and would be missed)

```typescript
await orchestrator.waitForReload();  // settle any background reload
await orchestrator.offloadLLM();
// ... run VRAM-heavy work ...
await orchestrator.reloadLLM();
```

### reloadLLM()

Restarts the LLM server from the saved state, retrying once after a short delay.

**Returns:** `Promise<void>`

**Behavior:**
- No-ops when there is no saved state
- **Never throws** — failures are logged and the saved state is kept so the caller (or user) can retry manually
- Clears the saved state on success

### Internal coordination methods

These two are part of the managers' wiring rather than an app-facing API, but knowing they exist explains the behavior above:

| Method | Called by | Effect |
|---|---|---|
| `prepareForLLMStart({ config })` | The `LlamaServerManager` pre-start hook the diffusion manager registers | Releases a resident diffusion backend (reason `'llm-start'`) when the LLM about to start would not fit alongside it; throws `CALIBRATION_IN_PROGRESS` while an offload sweep is running |
| `onDiffusionBackendReleased(reason)` | `DiffusionServerManager` after every confirmed backend release | Brings a deferred LLM back for the six qualifying reasons — see [Residency and the Reload Decision](#residency-and-the-reload-decision) |

---

## Example Scenarios

**1. GPU System with 8GB VRAM (Offload Needed)**:
   - LLM: 4.2GB VRAM, Diffusion: 8.3GB VRAM
   - Combined: 12.5GB > 8GB × 0.75 (6GB) → **Offload** ✅
   - Stops LLM, generates image, restarts LLM

**2. GPU System with 24GB VRAM (No Offload)**:
   - LLM: 4.2GB VRAM, Diffusion: 8.3GB VRAM
   - Combined: 12.5GB < 24GB × 0.75 (18GB) → **No offload** ✅
   - Generates directly without stopping LLM

**3. CPU-Only System with 16GB RAM, 12GB Available (Offload Needed)**:
   - LLM: 4.2GB RAM, Diffusion: 8.3GB RAM
   - Combined: 12.5GB > 12GB available × 0.75 (9GB) → **Offload** ✅
   - Stops LLM, generates image, restarts LLM

**4. A Burst of Images on the 8GB System**:
   - Request carries `usageMode: 'burst'` → LLM offloaded once, backend spawned once
   - Every follow-up image reuses the warm backend (no model load), and the LLM stays down on purpose
   - The LLM returns when the backend is released — idle timeout (default 5 min), an explicit `releaseBackend()`, a crash or stuck job, or `diffusionServer.stop()`

**5. Starting the LLM While a Backend Is Warm**:
   - `llamaServer.start()` runs the pre-start hook → both don't fit → backend released with reason `'llm-start'` (an in-flight image is allowed to finish)
   - The LLM then starts normally; no reload is triggered from inside the hook
   - On a machine where both fit, the hook is a no-op and the backend stays resident

---

### Applied LLM calibration configs

The library leaves calibration report-only and the manager stopped. A host may apply,
persist, present, or ignore `report.selected.startConfig`; `selectionEvidence` describes evidence
strength while `searchCompleteness` says whether requested adaptive work was fully resolved. Once
the caller starts the normal server with that config, `ResourceOrchestrator` saves and restores it
through its existing offload/reload path just like any other normal start configuration. Run
calibration only while both managed servers and other GPU work are idle; usage details belong in
[LLM Runtime Calibration](llm-server.md#runtime-calibration).

## See Also

- [Image Generation](image-generation.md) - DiffusionServerManager API
- [LLM Server](llm-server.md) - LlamaServerManager API
- [System Detection](system-detection.md) - Hardware capability detection
- [Model Management](model-management.md) - Model size information
