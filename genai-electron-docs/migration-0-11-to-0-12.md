# Migrating from v0.11.x to v0.12.0

v0.12.0 has **one breaking change**, scoped entirely to `diffusionServer.calibrate()` (added in v0.11.0). Everything else — LLM server, image generation, resource orchestration, binaries — is unchanged. No binary re-download.

If you do not call `calibrate()`, there is nothing to migrate.

## Breaking change: `calibrate()` now takes a required `generation` block

The compute-shaping parameters (`steps`, `cfgScale`, `sampler`, and image `sizes`) can no longer be defaulted individually. They must be supplied, as a unit, so calibration always measures the **same work your app does in production**.

### Why

In v0.11.0 these were optional, and `cfgScale` in particular defaulted to *omitted → sd.cpp's built-in default_ (> 1)*. A `cfgScale > 1` enables classifier-free guidance, which runs **two model passes per sampling step (~2× the diffusion cost)**. If your real generations run at a different CFG (guidance-distilled models like Flux Klein, SDXL-Lightning/Turbo run at `cfgScale: 1`), the sweep benchmarked twice the work of production — inflating all times and, because the extra pass loads the offload path, **flipping which offload combo it recommends**. Making the generation parameters required (no silent defaults) closes that gap.

### Before (v0.11.x)

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }], // was optional (defaulted to 768²)
  steps: 4,                              // was optional (defaulted to 4)
  // cfgScale omitted → sd.cpp default (> 1) → 2× the real work!
  // sampler omitted → 'euler'
});
```

### After (v0.12.0)

```typescript
const report = await diffusionServer.calibrate({
  modelId: 'flux-2-klein',
  sizes: [{ width: 768, height: 768 }], // required
  generation: {                          // required — mirror production
    steps: 4,
    cfgScale: 1,     // REQUIRED — pass the same CFG you generate with
    sampler: 'euler',
    // threads / batchSize: optional; pass your production values if you set them
  },
  onProgress: (p) => updateBar(p.overallPercent),
});
```

### Mechanical mapping

| v0.11.x (flat) | v0.12.0 |
|---|---|
| `steps` | `generation.steps` (required) |
| `cfgScale` | `generation.cfgScale` (**required** — no default) |
| `sampler` | `generation.sampler` (required) |
| `threads` | `generation.threads` (optional) |
| `batchSize` | `generation.batchSize` (optional) |
| `sizes` (optional) | `sizes` (**required**) |
| `combos`, `samples`, `seed`, `prompt`, `onProgress`, `signal` | unchanged |

> **Pass your real `cfgScale`.** `1` for guidance-distilled models (Flux Klein, SDXL-Lightning, SDXL-Turbo); typically `5`–`8` for standard models. This is the single parameter most likely to change the recommendation if it's wrong.

## Also new

- **Type `DiffusionCalibrationGeneration`** is exported (the `generation` block).
- **`DiffusionCalibrationReport` gains `cfgScale`** — the methodology echo now records `steps`, `cfgScale`, `sampler`, and `samples`, so a persisted recommendation captures the exact CFG it was measured under.
- **`DIFFUSION_CALIBRATION_DEFAULTS`** no longer carries `sizes` / `steps` / `sampler` (those are caller-supplied now); `combos`, `samples`, `seed`, `prompt`, tie-tolerance, and the pattern sets still have defaults.

## See Also

- [Image Generation — Offload Calibration](image-generation.md#offload-calibration) (see the ⚠️ `cfgScale` callout)
- [TypeScript Reference — `DiffusionCalibrationGeneration`](typescript-reference.md#diffusioncalibrationgeneration)
- [Migrating 0.10 → 0.11](migration-0-10-to-0-11.md)
