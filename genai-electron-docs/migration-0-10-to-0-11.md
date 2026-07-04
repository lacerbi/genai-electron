# Migrating from v0.10.x to v0.11.0

v0.11.0 adds **offload calibration** — a purely additive release. No breaking changes, no behavioral changes to existing APIs, no binary re-download (the sd.cpp pin is unchanged).

## Compatibility

Fully API-compatible: nothing to migrate. Upgrade and go.

Two additions worth knowing about:

- `ResourceOrchestrator.offloadLLM()` / `reloadLLM()` are now **public** (previously private). Existing orchestration behavior is unchanged — they were promoted so `calibrate()` (and your code, if useful) can drive sweep-level LLM offload explicitly.
- `DiffusionServerManager` emits a new `'calibration-progress'` event. Existing event listeners are unaffected.

## What's New

### `diffusionServer.calibrate()` — pick offload flags by measuring, not guessing

The static VRAM heuristic can't know which CPU-offload flag combination (`clipOnCpu` / `vaeOnCpu` / `offloadToCpu` / `diffusionFlashAttention`) is fastest on a given machine — the optimum is hardware-dependent and the flags interact. `calibrate()` benchmarks curated combinations with real generations (server stopped, no restarts — flags resolve per generation) and returns per-combo timings, per-stage splits, OOM/error classification, and a recommended combo per image size:

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }],
  steps: 4, // use your app's real step count
  onProgress: (p) => updateBar(p.overallPercent),
});

const best = report.recommended['768x768'];
if (best) {
  const { label, ...flags } = best;
  await diffusionServer.start({ modelId: 'flux-2-klein', ...flags });
}
```

Highlights:

- Progress via `onProgress` callback **and** the `'calibration-progress'` event (IPC-forwardable; monotonic `overallPercent` for progress bars)
- Cancellable via `AbortSignal` — aborts throw a `ServerError` with `details.code === 'CALIBRATION_ABORTED'` and partial results in `details.runs`
- Running LLM is offloaded once for the sweep and restored afterwards
- SD3.5-Large: forced `clipOnCpu: true` combos are auto-skipped (upstream leejet/stable-diffusion.cpp#1578)
- New exports: `DIFFUSION_CALIBRATION_DEFAULTS` plus the `DiffusionOffloadCombo`, `CalibrationSize`, `CalibrationRun`, `DiffusionCalibrationConfig` / `Progress` / `Report` types

Measured on the reference machine (RTX 4060 Laptop 8 GB, Flux 2 Klein Q4_0 at 768²): the recommended combo ran **~2× faster** than the auto heuristic (17.1 s vs 33.5 s median).

## See Also

- [Image Generation — Offload Calibration](image-generation.md#offload-calibration) · [Resource Orchestration](resource-orchestration.md) · [Migrating 0.9 → 0.10](migration-0-9-to-0-10.md)
