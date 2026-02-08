# Issue: sd.cpp crash + ResourceOrchestrator fails to reload LLM after diffusion

Created: 2026-02-08
Status: ALL FIXES IMPLEMENTED (Fix 1 + 2 + 3 + 5 + 6 + 7)
Package: genai-electron

## Summary

Two related failures during image generation:

1. **sd.cpp crashes with exit code 1** during image generation — no image is produced. The diffusion server starts successfully and loads the model, but the actual generation process crashes. No error details beyond the exit code.

2. **ResourceOrchestrator fails to reload LLM** after the crash. The orchestrator correctly offloads the LLM before diffusion, but when it tries to reload after the (failed) generation, it gets `InsufficientResourcesError` — likely because the crashed sd.cpp process hasn't fully released memory yet. The LLM server remains down until the host application explicitly calls `ensureLocalServer()` as a safety net.

## Environment

- Windows 11, WSL2 (but running native Windows Electron)
- GPU: NVIDIA with ~8 GB VRAM
- LLM: `gemma-3-12b-instruct-iq4nl` (~6.4 GB, 44/48 GPU layers, mixed RAM/VRAM)
- Diffusion: `sdxl-lightning-4-step-q51` (~2.9 GB)
- genai-electron version: current (as of 2026-02-08)

## Reproduction

1. Start LLM server with a model that uses most of the VRAM (~7 GB of 8 GB)
2. Trigger image generation via `ImageService.generateImage()` (genai-lite HTTP path)
3. The orchestrator correctly identifies resource contention and offloads the LLM
4. Diffusion runs (or crashes — see secondary issue below)
5. Orchestrator attempts `reloadLLM()` immediately after generation returns
6. Reload fails with `InsufficientResourcesError`

## Observed behavior

### Issue 1: sd.cpp crash (no image produced)

The diffusion server starts and loads the model, but the generation process crashes:

```
[genai-lite:error] GenaiElectron Image API error: Error: Generation failed:
  Server error: stable-diffusion.cpp exited with code 1
```

**No image was generated.** The `ImageService.generateImage()` call returns an error response. Exit code 1 is generic — no further diagnostic information is available from sd.cpp.

**Note:** The model (`sdxl-lightning-4-step-q51`) works correctly when run standalone with appropriate flags (confirmed by user):
```
sd.exe -m model.gguf -p "prompt" --steps 4 --cfg-scale 1 --width 768 --height 768 --seed -1 -v --clip-on-cpu -b 4
```

The crash only occurs through genai-electron's invocation path.

### Root cause: missing `--clip-on-cpu` flag

Inspecting `DiffusionServerManager.buildDiffusionArgs()` (line 464-499), genai-electron does NOT pass several flags that are critical for SDXL models on constrained VRAM:

| Flag | User's working command | genai-electron | Impact |
|---|---|---|---|
| **`--clip-on-cpu`** | Yes | **Not passed** | SDXL models include a ~1-2 GB CLIP text encoder. Without this flag, sd.cpp loads CLIP on GPU alongside the UNet, pushing total VRAM to 3.5 GB model + 1-2 GB CLIP + working memory. On 8 GB VRAM (after potential fragmentation from LLM offload), this likely exceeds available memory and crashes. |
| **`-b 4`** | Yes | **Not passed** | Batch size for VAE processing. Lower values reduce peak VRAM usage. Default may be too high for constrained memory. |
| `-v` | Yes | Not passed | Verbose output — would help diagnostics but isn't the crash cause. |

**`--clip-on-cpu` is almost certainly the primary crash cause.** The orchestrator's VRAM estimate (3.5 GB) accounts for the model weights but likely not for the CLIP encoder loaded on GPU. With CLIP on CPU, the GPU only needs the UNet (~2-3 GB) plus working memory, which fits in 8 GB.

### Additional issue: cfg-scale mismatch for Lightning models

SDXL Lightning is a distilled model designed for `--cfg-scale 1` (or very low values). The user's working command uses `--cfg-scale 1`. However, genai-electron receives `cfgScale` from the host application, and the Palimpsest GUI's quality presets pass `cfgScale: 5.0-8.0`. Even if the crash is fixed, this would produce degraded image quality. This is a host-side issue (we need to adjust our presets for Lightning models), but genai-electron could help by:
- Exposing model metadata that indicates recommended cfg-scale
- Providing model-specific preset overrides

### Feature requests for genai-electron

1. ~~**`--clip-on-cpu` support**: Add a `clipOnCpu?: boolean` option to `DiffusionServerConfig` or auto-detect when VRAM is constrained~~ — DONE (auto-detected + config override)
2. ~~**Batch size (`-b`) support**: Add a `batchSize?: number` option for VAE processing control~~ — DONE (config passthrough)
3. ~~**Auto-detection for SDXL**: When loading an SDXL model on a system with limited VRAM, automatically add `--clip-on-cpu`~~ — DONE (generic headroom-based detection, not SDXL-specific)
4. ~~**sd.cpp stderr capture**: Surface stderr in the error response — exit code 1 alone is not actionable~~ — DONE (Fix 5: stderr accumulated in sliding window, attached to ServerError details)

**Diagnostic request:** Can genai-electron capture and surface sd.cpp's stderr before it exits? Exit code 1 alone is not actionable — the stderr would contain the actual error (e.g., "failed to allocate N bytes", "unsupported quantization type", etc.).

### Issue 2: Orchestrator reload failure

### Orchestrator log (annotated)

```
[Orchestrator] VRAM Analysis:
  - LLM VRAM usage: 7.055588701367378 GB
  - Diffusion VRAM usage: 3.5233455061912538 GB
  - Total VRAM needed: 10.578934207558632 GB
  - Total VRAM available: 7.99609375 GB
  - Threshold (75%): 5.9970703125 GB
  - Offload needed: true
[Orchestrator] llamaServer.isRunning(): true
[Orchestrator] Resources constrained - offloading LLM before generation
[Orchestrator] Stopping LLM server...
[Orchestrator] LLM server stopped successfully
[Orchestrator] Generating image with LLM offloaded...
```

So far correct — the orchestrator identifies that LLM (7.1 GB VRAM) + diffusion (3.5 GB) exceeds 8 GB VRAM, offloads the LLM, and runs diffusion.

```
[Orchestrator] Reloading LLM after generation...
[Orchestrator] Restarting LLM with saved config: { modelId: 'gemma-3-12b-instruct-iq4nl', port: 8080 }
[Orchestrator] Failed to reload LLM: InsufficientResourcesError: System cannot run model:
  Insufficient RAM: model requires 7.7GB, but only 5.6GB available
```

The reload fails. Key observations:

1. **The error says RAM, not VRAM.** The LLM ran fine before offload (it was using mixed RAM+VRAM with 44/48 GPU layers). The reload check appears to be using a different resource calculation than the original `start()` — or the diffusion process hasn't fully released its memory yet.

2. **The diffusion process has exited** (sd.cpp exit code 1 — see below), but the OS may not have reclaimed the ~3.5 GB of memory immediately. The orchestrator's `reloadLLM()` runs synchronously after generation returns, with no delay for memory reclamation.

3. **The host's safety net succeeds later.** When the user submits their next action (seconds to minutes later), our code calls `ensureLocalServer()` and the LLM starts fine — by then, memory has been fully freed.

### Connection between the two issues

The sd.cpp crash (issue 1) likely worsens issue 2. Abnormal process termination delays OS memory reclamation compared to a clean `diffusionServer.stop()`. The orchestrator's `reloadLLM()` fires immediately after the crashed generation returns, before the OS has fully cleaned up the ~3.5 GB held by the diffusion process. However, issue 2 could also occur after a successful generation if memory reclamation is slow.

## Expected behavior

1. `reloadLLM()` should succeed after diffusion completes, since the diffusion model is no longer loaded.
2. If memory hasn't been freed yet, the orchestrator should retry after a brief delay (e.g., 1-2 seconds) rather than failing immediately.
3. The RAM check during reload should use the same resource calculation as the original `start()` (which succeeded with the same model on the same system).

## Suggested fixes

### 1. Retry with backoff in `reloadLLM()`

The simplest fix. If `llamaServer.start()` fails with `InsufficientResourcesError` inside `reloadLLM()`, wait 1-2 seconds and retry once. This handles the common case where the diffusion process just exited and memory is being reclaimed.

```typescript
async reloadLLM(): Promise<void> {
  try {
    await this.llamaServer.start(this.savedLLMConfig);
  } catch (error) {
    if (error.code === 'INSUFFICIENT_RESOURCES') {
      await sleep(2000);
      await this.llamaServer.start(this.savedLLMConfig); // retry once
    } else {
      throw error;
    }
  }
}
```

### 2. Consistent resource check

The reload fails saying "model requires 7.7GB RAM, but only 5.6GB available". But the model was running before with mixed RAM/VRAM (0.64 GB RAM + 7.05 GB VRAM per the orchestrator's own analysis). The `start()` resource check during reload may not be accounting for the GPU layers that will be offloaded to VRAM. If `reloadLLM()` restores the saved config (including `gpuLayers: 44`), the resource check should factor that in.

### 3. Ensure diffusion cleanup before reload

After `orchestrateImageGeneration()` completes (success or failure), explicitly wait for the diffusion server process to fully terminate and release resources before attempting LLM reload:

```typescript
async orchestrateImageGeneration(fn): Promise<T> {
  try {
    return await fn();
  } finally {
    // Ensure diffusion resources are freed before reload
    await this.diffusionServer.stop();
    await sleep(500); // Brief delay for OS memory reclamation
    await this.reloadLLM();
  }
}
```

## Workaround (implemented in Palimpsest GUI)

The GUI host calls `ensureLocalServer(modelId)` as a safety net after `awaitImageGeneration()` returns, before the next `runTurn()`. This is normally a no-op (orchestrator already reloaded), but catches the failure case. The user experiences a delay on their next action while the LLM restarts, with status "Restoring language model...".

## Impact

- **Issue 1 (sd.cpp crash) — Severity: High.** Image generation is completely non-functional when running through the orchestrated LLM-offload path. The model works standalone, so this is specific to the offload/handoff sequence. No images are produced.
- **Issue 2 (reload failure) — Severity: Medium.** The LLM is temporarily unavailable after image generation until the host's safety net kicks in. Gameplay is not broken but the user experiences a noticeable delay (~10-30s to restart the LLM server).
- **Frequency:** Issue 1 appears reproducible on systems where the orchestrator offloads the LLM before diffusion (i.e., LLM + diffusion VRAM exceeds available VRAM). Issue 2 follows from issue 1's abnormal process termination but could also occur after successful generation if memory reclamation is slow.

---

## Code Investigation Findings

Detailed codebase analysis performed 2026-02-08. All file references are relative to the repository root.

### Issue 1 Deep Dive: DiffusionServerManager invocation path

#### `buildDiffusionArgs()` — current flags (src/managers/DiffusionServerManager.ts:813-869)

The method builds CLI arguments from `ImageGenerationConfig` (per-request) and `DiffusionServerConfig` (server-level). Currently passed flags:

| Flag | Source | Condition |
|---|---|---|
| `-m <path>` | `modelInfo.path` | Always |
| `-p <prompt>` | `config.prompt` | Always |
| `-n <negative>` | `config.negativePrompt` | If provided |
| `-W <width>` | `config.width` | If provided |
| `-H <height>` | `config.height` | If provided |
| `--steps <N>` | `config.steps` | If provided |
| `--cfg-scale <N>` | `config.cfgScale` | If provided |
| `-s <seed>` | `config.seed` | If provided |
| `--sampling-method` | `config.sampler` | If provided |
| `--n-gpu-layers <N>` | `serverConfig.gpuLayers` | If > 0 |
| `-t <threads>` | `serverConfig.threads` | If provided |
| `-o <output>` | Added after buildDiffusionArgs returns | Always (line 668) |

**Missing flags — not passed, no config option exists:**

| Flag | Impact |
|---|---|
| `--clip-on-cpu` | SDXL models load CLIP text encoder (~1-2 GB) on GPU by default. On VRAM-constrained systems, this pushes total usage past limits and crashes sd.cpp. |
| `-b <batch_size>` | Controls VAE batch size. Lower values reduce peak VRAM during VAE decode. Note: `LlamaServerConfig` has a `batchSize` field, but `DiffusionServerConfig` does not. |
| `--vae-on-cpu` | Another VRAM reduction mechanism — offloads VAE decoder to CPU. Not exposed. |
| `-v` (verbose) | Would provide diagnostic stderr output. Not the crash cause, but useful. |

#### `DiffusionServerConfig` type (src/types/images.ts:113-135)

```typescript
export interface DiffusionServerConfig {
  modelId: string;
  port?: number;           // Default: 8081
  threads?: number;
  gpuLayers?: number;
  vramBudget?: number;     // ← DEAD CODE: declared but never read anywhere
  forceValidation?: boolean;
}
```

The `vramBudget` field is never read by `buildDiffusionArgs()`, never consulted by the orchestrator, and never passed to sd.cpp. It is entirely decorative.

#### stderr capture — present but not surfaced (src/managers/DiffusionServerManager.ts:643-755)

The `executeImageGeneration()` method spawns sd.cpp via `ProcessManager.spawn()` with `stdio: ['ignore', 'pipe', 'pipe']`. Both stdout and stderr are piped:

- **stdout** → parsed for progress updates via `processStdoutForProgress()` AND written to log file
- **stderr** → written to log file via `this.logManager?.write(data, 'warn')`

However, when sd.cpp exits with a non-zero code, the error thrown is:
```typescript
reject(new ServerError(`stable-diffusion.cpp exited with code ${code}`));
```

**No stderr content is included in the error message or `details` field.** The stderr data is captured to the log file but lost from the error propagation path. To surface it, the `onStderr` handler would need to accumulate recent stderr lines and attach them to the ServerError on exit.

#### VRAM estimation ignores CLIP encoder (src/managers/ResourceOrchestrator.ts:287-316)

`estimateDiffusionUsage()` computes:
```typescript
const usage = modelInfo.size * 1.2;  // file size + 20% overhead
return { ram: usage, vram: usage };
```

This treats the model as monolithic. For SDXL, the actual GPU memory is: UNet weights (~2.9 GB on disk → ~3.5 GB loaded) + CLIP text encoder (~1-2 GB) + VAE decoder + working memory for intermediate tensors. The estimate underreports VRAM by ~1-2 GB on SDXL, which means the orchestrator underestimates the severity of the resource contention.

### Issue 2 Deep Dive: Orchestrator reload failure

#### Bug A: `canRunModel()` ignores GPU layers entirely (src/system/SystemInfo.ts:170-212)

This is the **primary root cause** of the reload failure. The method:

```typescript
public async canRunModel(
  modelInfo: ModelInfo,
  options?: { checkTotalMemory?: boolean }
): Promise<{ possible: boolean; reason?: string; suggestion?: string }> {
  const requiredMemory = modelInfo.size * 1.2; // ← full model size, always
  const currentMemory = this.getMemoryInfo();
  const memoryToCheck = options?.checkTotalMemory
    ? currentMemory.total
    : currentMemory.available;  // ← os.freemem()
  const fitsInRAM = memoryToCheck >= requiredMemory;
  // ...
}
```

**The method does not accept or use GPU layer information.** There is no `gpuLayers` parameter. For a 6.4 GB model with 44/48 GPU layers:

- `canRunModel()` computes: `required = 6.4 * 1.2 = 7.7 GB RAM` (wrong — treats entire model as RAM)
- ResourceOrchestrator computes: `RAM = 6.4 * (4/48) * 1.2 = 0.64 GB` (correct — accounts for GPU offload)

The validation gate (`canRunModel`) and the resource planning logic (`estimateLLMUsage`) are **fundamentally inconsistent**. Similarly, `getOptimalConfig()` (same file, line 226) correctly calculates GPU layers, but `canRunModel()` doesn't know they exist.

**`LlamaServerManager.start()` calls `canRunModel()` with no options** (src/managers/LlamaServerManager.ts:109-122):
```typescript
const canRun = await this.systemInfo.canRunModel(modelInfo);
// No gpuLayers passed — check uses full model size against os.freemem()
```

Note: `DiffusionServerManager.start()` calls `canRunModel(modelInfo, { checkTotalMemory: true })`, which checks against total RAM — more lenient. But `LlamaServerManager.start()` checks against available (free) RAM, which is the stricter and buggier path.

**Why fresh start succeeds but reload fails:**

| Scenario | `os.freemem()` | Required (buggy calc) | Result |
|---|---|---|---|
| Fresh start (no diffusion in memory) | ~12+ GB | 7.7 GB | Pass (by luck) |
| Reload after diffusion crash | ~5.6 GB | 7.7 GB | **Fail** |
| Correct calculation (44/48 GPU layers) | ~5.6 GB | 0.64 GB | Would pass |

The saved config **does** round-trip correctly with `gpuLayers: 44` — `offloadLLM()` saves `this.llamaServer.getConfig()` which is set to `finalConfig` (after auto-configuration) in `LlamaServerManager.start()`. The orchestrator passes this config back to `start()` during reload. The problem is purely that `canRunModel()` ignores the gpuLayers that are present in the config being started.

#### Bug B: No delay or retry in reloadLLM() (src/managers/ResourceOrchestrator.ts:366-388)

```typescript
private async reloadLLM(): Promise<void> {
  if (!this.savedLLMState || !this.savedLLMState.wasRunning) {
    return;
  }
  try {
    await this.llamaServer.start(this.savedLLMState.config);
    this.savedLLMState = undefined;
  } catch (error) {
    console.error('[Orchestrator] Failed to reload LLM:', error);
    // Error swallowed — LLM stays offline
    // savedLLMState preserved for manual restart
  }
}
```

- **Single attempt, no retry.** If `start()` throws, the error is logged and swallowed.
- **No delay between diffusion exit and reload.** The `finally` block in `orchestrateImageGeneration()` calls `reloadLLM()` immediately.
- **Errors intentionally not rethrown** — the JSDoc says "Errors are logged but not thrown to avoid disrupting image generation." The image generation result (or error) propagates to the caller; the LLM reload failure is a silent side effect.
- **Saved state preserved on failure** — allows the host to manually restart via `getSavedState()`.

#### No diffusion cleanup before reload (src/managers/ResourceOrchestrator.ts:113-147)

The orchestration flow:
```typescript
async orchestrateImageGeneration(config) {
  if (needsOffload && llamaIsRunning) {
    await this.offloadLLM();
    try {
      const result = await this.diffusionServer.executeImageGeneration(config);
      return result;
    } finally {
      await this.reloadLLM();  // ← no cleanup step before this
    }
  }
  // ...
}
```

There is no call to `diffusionServer.stop()` between generation completing and `reloadLLM()`. The `executeImageGeneration()` method spawns sd.cpp as an ephemeral child process that exits on completion. The HTTP wrapper server remains running (it's lightweight — just a Node.js HTTP server). The sd.cpp process has exited by the time the promise settles, but the OS memory deallocation is asynchronous.

#### DiffusionServerManager.stop() doesn't wait for child process (src/managers/DiffusionServerManager.ts:222-269)

Even if `stop()` were called, it has its own gap:
1. Calls `this.currentGeneration.cancel()` which calls `processManager.kill(pid, 5000)` — but this kill is **fire-and-forget** (`.catch(() => void 0)`, not awaited).
2. Closes the HTTP wrapper server (awaited).
3. Destroys the GenerationRegistry.
4. Does **not** wait for the sd.cpp child process to fully terminate or for memory reclamation.

#### ProcessManager.kill() vs memory reclamation (src/process/ProcessManager.ts:144-204)

`kill()` sends SIGTERM, polls every 100ms via `process.kill(pid, 0)`, escalates to SIGKILL after timeout. It resolves when the PID disappears from the process table. However, **PID removal ≠ memory reclamation**. The OS can release the PID while still asynchronously tearing down page tables, GPU driver allocations, and file descriptors. This is especially slow on Windows after abnormal termination.

**No mechanism exists anywhere in the codebase** to wait for actual memory reclamation — no `os.freemem()` polling, no `nvidia-smi` VRAM check, no configurable delay.

### Additional findings

#### DiffusionServerManager crash handling gap

Unlike `LlamaServerManager`, the `DiffusionServerManager` has **no `handleExit` method** that sets status to `'crashed'`. When sd.cpp crashes during generation, the DiffusionServerManager's overall status remains `running` (the HTTP wrapper is still up). No `'crashed'` event is emitted for the ephemeral sd.cpp process — the failure is only visible as a rejected promise from `executeImageGeneration()`.

#### offloadLLM() saves config by reference (src/managers/ResourceOrchestrator.ts:326-356)

`offloadLLM()` saves `this.llamaServer.getConfig()` which returns `this._config` — a reference, not a deep clone. In practice this is safe because `_config` is only set during `start()` and the LLM is being stopped, but it is a theoretical mutation risk if any code modifies the config object after offload.

## Fix plan

### Priority 0 — Fixes both reported issues

**Fix 1: Add `clipOnCpu`, `vaeOnCpu`, and `batchSize` to DiffusionServerConfig + pass in buildDiffusionArgs()** — DONE

Implemented in commit. Changes:
- `src/types/images.ts` — added `clipOnCpu?: boolean`, `vaeOnCpu?: boolean`, `batchSize?: number` to `DiffusionServerConfig` with JSDoc documenting auto-detection and override semantics
- `src/config/defaults.ts` — added `DIFFUSION_VRAM_THRESHOLDS` constant (clip headroom: 6 GB, vae headroom: 2 GB, model overhead: 1.2x)
- `src/managers/DiffusionServerManager.ts` — new `computeDiffusionOptimizations()` method that fetches fresh GPU info at generation time, computes headroom = totalVRAM - modelFootprint, and applies thresholds; `buildDiffusionArgs()` now accepts and appends `--clip-on-cpu`, `--vae-on-cpu`, `-b` flags; `executeImageGeneration()` calls `computeDiffusionOptimizations()` before building args
- `src/index.ts` — exported `DIFFUSION_VRAM_THRESHOLDS`
- Tests — 8 new test cases (336 total): 8 GB + 2.9 GB model (clip ON), 12 GB + 2.9 GB (neither), 8 GB + 6.5 GB (both), no GPU (clip ON), user overrides in both directions, batchSize passthrough, vramAvailable escalation

**Fix 6: Auto-detect constrained VRAM → auto-enable `--clip-on-cpu` and `--vae-on-cpu`** — DONE (merged into Fix 1)

Auto-detection logic in `computeDiffusionOptimizations()`:
- `clipOnCpu`: enabled when headroom < 6 GB, or no GPU, or vramAvailable critically low
- `vaeOnCpu`: enabled when headroom < 2 GB (conservative — CPU VAE is slow)
- User-provided `clipOnCpu`/`vaeOnCpu`/`batchSize` overrides always win via nullish coalescing (`??`)
- Computed at generation time (not start time) so headroom reflects current VRAM state after orchestrator offloads

**Fix 2: Make `canRunModel()` GPU-layer-aware** — DONE

Implemented: `canRunModel()` now accepts `gpuLayers` and `totalLayers` options. When GPU layers are specified, RAM requirement = `modelSize * (1 - gpuLayers/totalLayers) * 1.2`. `LlamaServerManager.start()` passes `config.gpuLayers` to the check. 4 new tests added.

### Priority 1 — Resilience

**Fix 3: Add retry with backoff in `reloadLLM()`** — DONE

Implemented: `reloadLLM()` now retries once after a 2-second delay with `systemInfo.clearCache()` between attempts. First failure logged as `console.warn`, final failure as `console.error`. 2 new tests added (retry succeeds, both fail).

### Priority 2 — Diagnostics and UX

**Fix 5: Surface stderr in ServerError on sd.cpp crash** — DONE

Implemented: `executeImageGeneration()` accumulates stderr in a sliding window (last 20 lines). On non-zero exit, ServerError includes `{ exitCode, stderr }` in details. 3 new tests added (stderr present, capped at 20 lines, undefined when empty).

### Priority 3 — Cleanup

**Fix 7: Remove dead `vramBudget` field** — DONE

Removed `vramBudget` from `DiffusionServerConfig` in `src/types/images.ts`, `genai-electron-docs/typescript-reference.md`, and `genai-electron-docs/image-generation.md`.
