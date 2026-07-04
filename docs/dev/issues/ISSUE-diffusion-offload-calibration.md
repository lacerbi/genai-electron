# Diffusion offload calibration (per-machine sweep API)

**Type:** feature request
**Area:** `DiffusionServerManager` / image generation
**Status:** RESOLVED (2026-07-04) — see resolution note below
**Version target:** genai-electron ≥ 0.10.x

> **Status: RESOLVED** (2026-07-04, on `feat/diffusion-calibration` — unreleased batch).
> Implemented as `DiffusionServerManager.calibrate()` per
> `docs/dev/plans/PLAN-diffusion-calibration.md`, with these deviations from the
> proposal below:
>
> - **No restart per combo** — offload flags resolve per generation inside
>   `executeImageGeneration()`, so the sweep threads per-combo overrides into each
>   spawn directly. No HTTP server or port involvement at all; the "sweep restarts
>   per combo" acceptance test became "per-run flag resolution".
> - **Abort throws** (the proposed "existing stop path" would silently no-op while
>   status is `'stopped'`, which it is throughout calibration): a `ServerError` with
>   `details.code = 'CALIBRATION_ABORTED'` and partial runs in `details.runs`
>   (top-level `error.code` stays the generic `'SERVER_ERROR'`).
> - Tie-break made deterministic: any OK combo within **5%** of the fastest that
>   forces fewer flags wins (robustness preference).
> - Progress phases reworked (`'starting'` → `'preparing'`, added `'restoring-llm'`)
>   and the payload enriched (combo/size/sample context + `generationPercent` for
>   smooth bars); also emitted as a `'calibration-progress'` event for IPC forwarding.
> - Report gains `skippedCombos` + a methodology echo (`steps`/`sampler`/`samples`);
>   default combos ship labeled; `isCalibrating()` added; the optional standalone
>   `calibrateDiffusion()` wrapper was not implemented (the manager method suffices).
> - LLM handling: sweep-level offload/restore via the internal orchestrator
>   (`waitForReload()` → `offloadLLM()` once at sweep start; `reloadLLM()` in the
>   finally; both promoted to public `ResourceOrchestrator` API).
>
> Docs: `genai-electron-docs/image-generation.md` → "Offload Calibration".

## Summary

Add a **calibration** API that benchmarks the CPU-offload flag combinations
(`clipOnCpu` / `vaeOnCpu` / `offloadToCpu` / `diffusionFlashAttention`) on the
**actual machine** for a given model and image size(s), and returns the fastest
working configuration. The caller then applies/persists the result.

genai-electron already picks these flags via a static VRAM heuristic
(`DiffusionServerManager.computeDiffusionOptimizations()`). Real-world testing
shows the optimum is **not** a simple function of VRAM — it depends on the whole
system (driver behaviour, PCIe bandwidth, CPU speed, RAM bandwidth, OS), and the
flags **interact** in non-obvious ways. The only reliable way to pick the best
config is to **measure it on the target machine**. That measurement machinery is
completely general and belongs here, not in each consumer app.

## Motivation (empirical)

Measured on an **8 GB laptop GPU, Windows 11**, model **Flux 2 Klein (Q4_0)**
(multi-component: Flux DiT + Qwen3-4B text encoder + VAE), via a consumer app's
"generate one image and show the time" panel:

| Config | Time / image |
|---|---|
| Auto (heuristic picks `clipOnCpu=true`) | ~18 s |
| `clipOnCpu=false` (rest auto) | ~13 s |
| `vaeOnCpu=true` | **~3× slower** |
| `clipOnCpu=false` + `offloadToCpu=true` | **~10–12 s (best)** |
| `offloadToCpu=true` alone | ~no change vs auto |

Why these are not obvious, and why a static heuristic can't capture them:

- **`vaeOnCpu` is almost always a trap.** CPU decode of the (large) Flux latent
  dominates the run — the current auto only enables it below 2 GB headroom, which
  is right, but a naive "save VRAM" default would be badly wrong.
- **`clipOnCpu=false` is a big win *if it fits*** — Flux's "CLIP" is a 4B LLM, so
  moving it to the GPU saves the multi-second CPU encode. But forcing it onto an
  8 GB GPU oversubscribes VRAM.
- **`offloadToCpu` looks inert alone but is decisive under pressure.** With CLIP
  on CPU (low GPU pressure) it has nothing to stream → ~no effect. But
  `clip=false` **oversubscribes** VRAM; on Windows the driver then silently spills
  to shared system RAM *ad-hoc* (thrash). `offloadToCpu=true` replaces that with
  sd.cpp's **orderly** weight streaming → faster than driver thrash. Hence the
  best combo (`clip=false` + `offload=true`) beats either alone, and `offload`
  alone appears to do nothing. **This proves `offloadToCpu` works** — it's just
  conditional on the VRAM pressure that `clip=false` creates.

Critically, **this is platform-dependent**: Windows/WDDM silently oversubscribes
VRAM (slow but runs); Linux/CUDA typically **hard-OOMs** instead. So the same
`clip=false` combo that is merely "slower until you add offload" on Windows may
**fail outright** on Linux — a static heuristic cannot know which. Only a live
sweep that actually runs each combo and observes success + wall-clock can decide.

## Why this belongs in genai-electron

The sweep needs exactly the things this library owns: the flag config
(`DiffusionServerConfig`), the server start/stop lifecycle, per-generation
execution (`generateImage`), hardware detection (`SystemInfo.getGPUInfo()`), and
per-stage timing. A consumer app can only script it clumsily from outside
(repeated start/stop/generate) and can't classify OOM vs slow reliably. The
**only** consumer-specific input is *which image dimensions to benchmark* — and
even that is naturally an array parameter.

## Existing building blocks (already in the codebase)

- **Flags + auto thresholds:** `src/types/images.ts` → `DiffusionServerConfig`
  (`clipOnCpu`, `vaeOnCpu`, `offloadToCpu`, `diffusionFlashAttention`, `batchSize`,
  `threads`, `forceValidation`). Auto-detection lives in
  `DiffusionServerManager.computeDiffusionOptimizations()`
  (`src/managers/DiffusionServerManager.ts`), thresholds in
  `src/config/defaults.ts` → `DIFFUSION_VRAM_THRESHOLDS`
  (`clipOnCpuHeadroomBytes = 6 GiB`, `vaeOnCpuHeadroomBytes = 2 GiB`,
  `modelOverheadMultiplier = 1.2`; `offloadToCpu` when footprint > 85% of VRAM).
- **Per-generation execution:** `DiffusionServerManager.generateImage(config)`
  (`ImageGenerationConfig` → `ImageGenerationResult`). `ImageGenerationResult`
  already returns `timeTaken` (ms), `seed`, `width`, `height`.
- **Per-stage timing already tracked internally** for progress estimation:
  `DiffusionServerManager` keeps `loadStartTime/loadEndTime/diffusionStartTime/
  diffusionEndTime` (~lines 1287–1299). Surfacing load/diffusion/decode as part of
  the calibration result would make the sweep *diagnostic* (it directly shows
  where a combo's cost lands: CPU-VAE → decode stage, CPU-CLIP → load/encode,
  offload → diffusion stage).
- **Config is start-time:** flags are read from `this._config` per generation, set
  at `start()`. So each combo requires a **stop + start** with that config — the
  sweep must orchestrate restarts. `start()` is cheap (no model preload; sd.cpp is
  spawned per generation), so restarts are acceptable.
  *(Resolution note: this premise turned out to be avoidable — flags are resolved
  per generation, so the implementation threads per-combo overrides into each
  spawn with no restarts at all.)*
- **Prior art for internal test-gen:** `BinaryManager` Phase 2 already runs real
  sd.cpp inference to validate GPU functionality (`src/managers/BinaryManager.ts`,
  "Phase 2: Testing GPU functionality with real inference"). The calibration sweep
  is a generalization of that idea.
- **Machine fingerprint:** `SystemInfo.getGPUInfo()` → `GPUInfo`
  (`src/types/system.ts`: `type`, `name`, `vram`, `vramAvailable`).

## Proposed API

A method on the diffusion server (mirrors how `start`/`generateImage` live there),
plus exported types. A standalone exported `calibrateDiffusion(config)` wrapper is
also fine.

```ts
/** One offload combination to benchmark. Omitted flag = auto-detect (undefined). */
export interface DiffusionOffloadCombo {
  label?: string;                     // e.g. "clip-off + offload-on"
  clipOnCpu?: boolean;
  vaeOnCpu?: boolean;
  offloadToCpu?: boolean;
  diffusionFlashAttention?: boolean;
}

export interface CalibrationSize { width: number; height: number; }

export interface DiffusionCalibrationConfig {
  modelId: string;
  /** Sizes to benchmark. Default: a small representative set (see below). */
  sizes?: CalibrationSize[];
  /** Combos to benchmark. Default: the curated set below. */
  combos?: DiffusionOffloadCombo[];
  /** Inference steps per generation. Default: 4.
   *  NB: offload cost scales with steps — prefer the caller's real step count. */
  steps?: number;
  cfgScale?: number;                  // default: model-appropriate
  sampler?: ImageSampler;             // default: 'euler'
  /** Fixed seed so every combo does identical work. Default: a constant. */
  seed?: number;
  /** Neutral benchmark prompt. Default provided. */
  prompt?: string;
  /** Timed samples per (size, combo), after 1 discarded warmup. Default: 2. */
  samples?: number;
  onProgress?: (p: DiffusionCalibrationProgress) => void;
  signal?: AbortSignal;               // cancellable
}

export interface DiffusionCalibrationProgress {
  phase: 'starting' | 'warmup' | 'sampling' | 'done';
  sizeIndex: number; sizeCount: number;
  comboIndex: number; comboCount: number;
  sample?: number; sampleCount?: number;
  overallPercent: number;
}

export interface CalibrationRun {
  size: CalibrationSize;
  combo: DiffusionOffloadCombo;       // as requested (undefined = auto)
  /** What auto-detection resolved omitted flags to (for transparency). */
  resolved?: { clipOnCpu: boolean; vaeOnCpu: boolean; offloadToCpu: boolean; diffusionFlashAttention: boolean };
  status: 'ok' | 'oom' | 'error';
  timeTakenMs?: number;               // median of samples (total wall-clock per image)
  stageMs?: { loadMs?: number; diffusionMs?: number; decodeMs?: number };
  samplesMs?: number[];               // raw per-sample totals (for variance)
  error?: string;                     // when status != 'ok'
}

export interface DiffusionCalibrationReport {
  machine: { gpuType?: string; gpuName?: string; vramBytes?: number; vramAvailableBytes?: number };
  modelId: string;
  steps: number;
  runs: CalibrationRun[];
  /** Fastest OK combo per size, keyed "<W>x<H>". Absent for a size where all failed. */
  recommended: Record<string, DiffusionOffloadCombo>;
}

// On DiffusionServerManager (and the `diffusionServer` singleton):
calibrate(config: DiffusionCalibrationConfig): Promise<DiffusionCalibrationReport>;
```

### Default sweep

**Default sizes:** a small representative set, e.g. `[{768,768}]`, or
`[{768,768},{512,1024}]`. Callers that commit to specific dimensions should pass
their own — the optimum shifts with size (bigger latent → more VRAM pressure).

**Default combos** (curated, ~6 — the full 2⁴ is wasteful and mostly dominated):

1. `{}` — **auto** (baseline; current heuristic)
2. `{ clipOnCpu: false }` — encoder on GPU
3. `{ clipOnCpu: false, offloadToCpu: true }` — encoder on GPU + managed streaming *(the empirically-best combo above)*
4. `{ offloadToCpu: true }` — auto clip + managed streaming
5. `{ clipOnCpu: false, vaeOnCpu: false, offloadToCpu: false }` — everything resident (fastest if it fits, else OOM)
6. `{ clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true }` — max VRAM saving (last-resort fallback so *something* runs on very tight VRAM)

`diffusionFlashAttention` is left at auto in the default combos (auto-enables for
Flux). It can be added as an optional extra axis by the caller.

## Design considerations

- **Restart per combo.** Flags are start-config → stop + start the server for each
  combo. Cheap (no model preload). Do it once per combo, then run warmup + samples
  at each size before moving on (minimizes restarts; sizes share a server config).
  *(Resolution note: superseded — no restarts in the implementation.)*
- **Timing methodology.** Fixed `seed`, `steps`, `cfgScale`, `sampler`, `prompt`,
  and `size` so **every combo does identical work** — only device placement varies,
  so wall-clock is the sole variable. One discarded **warmup** generation per combo
  (stabilizes disk cache / first-spawn overhead), then `samples` timed runs; report
  the **median** as `timeTakenMs` and keep raw `samplesMs`. Note: sd.cpp reloads
  the model every generation, so model-load time is part of *every* real image and
  should be **included** (representative) — surface the stage split so callers can
  see load vs diffusion vs decode.
- **OOM safety (must not abort the sweep).** Wrap each generation; on failure,
  classify from sd.cpp stderr/exit (`out of memory`, `cudaMalloc`, `alloc`,
  `CUDA error`, etc.) → `status: 'oom'`, else `'error'`. Continue to the next
  combo. This is essential: on Linux, high-pressure combos hard-fail; on Windows
  they run slowly (captured as a slow `'ok'`). The fallback combo (6) exists so at
  least one combo succeeds on very tight VRAM.
- **Determinism / equivalence.** Offload/clip/vae are **device-placement** flags;
  they do not change the algorithm, so output images are equivalent across combos
  (minor fp differences only). Therefore it is safe to pick the winner purely by
  time. (One exception below — SD3.5-Large.)
- **`recommended`** = fastest `status==='ok'` combo per size. Ties → prefer the
  combo closest to auto (fewer forced flags) for robustness.
- **Server state afterward.** Leave the server **stopped** (clean) so the caller
  re-`ensure`s with the chosen config. Document this.
- **Cancellation / progress.** Honour `signal` (abort between combos/samples and on
  the in-flight generation via existing stop path). Emit `onProgress` so callers
  can show a progress bar (sweep can take a few minutes).
- **Optional caching.** genai-electron *may* cache a report keyed by
  (`gpuName`+`vramBytes`, `modelId`, size, steps) to skip repeat sweeps, but the
  primary contract is "return the report; the caller persists/applies it."
  Recommend leaving persistence to the caller (keep this API pure).

## Caveats / edge cases (document these)

- **SD3.5-Large + `clipOnCpu` is broken** (garbled conditioning — leejet/
  stable-diffusion.cpp#1578). The sweep should **skip `clipOnCpu=true` combos** for
  that model family (genai-electron can detect it), or clearly document that the
  caller must exclude them. This is the one case where a combo changes the *image*,
  not just the time.
- **Steps interaction.** `offloadToCpu` overhead scales with step count; calibrating
  at few steps under-represents its cost. Prefer the caller's real `steps`.
- **Size dependence.** Bigger images shift the optimum (more VRAM pressure); hence
  per-size runs and per-size `recommended`.
- **Measurement noise.** Thermal throttling and background GPU/CPU load perturb
  timings; keep `samplesMs` raw so callers can see variance, and consider
  interleaving combos if a single-combo burst risks thermal bias.

## Non-goals

- Image-**quality** comparison across combos (assumed equivalent; SD3.5 caveat aside).
- Auto-**applying** or persisting the winner — the caller decides and stores it.
- Tuning steps / sampler / cfg / resolution (only offload placement).
- Multi-GPU selection and cloud/remote providers.

## Acceptance criteria

- `diffusionServer.calibrate(config)` runs the sweep across the given sizes × combos
  and returns a `DiffusionCalibrationReport` with per-run `status`, `timeTakenMs`
  (and stage split when available), plus a `recommended` combo per size.
- Combos that OOM/error are **caught and recorded**, never abort the sweep; at least
  the fallback combo yields a result on tight VRAM.
- Fixed seed/steps/prompt/size make combos directly comparable.
- Cancellable via `signal`; progress via `onProgress`; server left **stopped**.
- SD3.5-Large excludes `clipOnCpu=true` combos automatically (or documented).
- Docs updated: `genai-electron-docs/image-generation.md` (new "Calibration"
  section) and `typescript-reference.md` (new types); changelog/migration note.
- Unit/integration coverage: a mocked-spawn test that verifies the sweep restarts
  per combo, classifies an injected OOM, and picks the fastest OK combo.

## Intended consumer usage (context, not part of this API)

A host app (e.g. a text-RPG GUI) that commits to specific illustration sizes will:

```ts
const report = await diffusionServer.calibrate({
  modelId,
  sizes: [{ width: 768, height: 768 }, { width: 512, height: 1024 }], // the app's real sizes
  steps: 4,                                                            // the app's quality preset
});
// Persist report.recommended["768x768"] etc. into the app's per-model settings,
// and pass those flags to future start()/ensure() calls.
```

The host already exposes manual `clipOnCpu/vaeOnCpu/offloadToCpu/flashAttention`
overrides (Auto/On/Off); calibration is the "measure and fill them in for me"
button. Everything above the `sizes` array is generic and lives here.
