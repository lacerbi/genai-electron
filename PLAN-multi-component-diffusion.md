# Plan: Multi-Component Diffusion Model Support

Created: 2026-02-12
Status: APPROVED

## Summary

Extend genai-electron to support diffusion models composed of multiple separate files (diffusion model, text encoders, VAE, etc.) rather than only monolithic single-file models. The initial target architectures are **SDXL** (split components) and **Flux 2** (`--diffusion-model` + `--llm` + `--vae`), with the design being extensible to Qwen Image in the future.

## Motivation

Modern diffusion architectures ship their components as separate files:

| Architecture | Components | sd.cpp Flags |
|---|---|---|
| **SDXL (monolithic)** | Single file | `-m` (already supported) |
| **SDXL (split)** | UNet + CLIP-L + CLIP-G + VAE | `--diffusion-model --clip_l --clip_g --vae` |
| **Flux 2 Klein** | DiT-4B + Qwen3-4B + VAE | `--diffusion-model --llm --vae` |
| **Flux 2 Dev** | DiT + Mistral-Small-24B + VAE | `--diffusion-model --llm --vae` |
| **Qwen Image** *(future)* | DiT + LLM + LLM-Vision + VAE | `--diffusion-model --llm --llm_vision --vae` |

Out of scope: **SD3** (bad license), **Flux 1** (generally too large; 4 components with separate T5-XXL).

## Reference: Tested Flux 2 Klein Setup

This was validated against real hardware. BFL's own documentation never clearly states most of this.

**Components (3 files, ~7-9 GB total at Q8_0/Q4_0):**

| Component | Source | Flag | Sizes |
|---|---|---|---|
| Diffusion model (Klein 4B) | `leejet/FLUX.2-klein-4B-GGUF` | `--diffusion-model` | Q8_0 ~4.3 GB, Q4_0 ~2.5 GB |
| Text encoder (Qwen3-4B **base**) | `unsloth/Qwen3-4B-GGUF` | `--llm` | Q4_0 ~2.5 GB, Q8_0 ~4.3 GB |
| VAE (Flux 2, 32 latent channels) | `Comfy-Org/flux2-dev` → `split_files/vae/flux2-vae.safetensors` | `--vae` | ~335 MB |

**Working command:**
```
sd-cli --diffusion-model flux-2-klein-4b-Q8_0.gguf \
       --vae flux2-vae.safetensors \
       --llm Qwen3-4B-Q4_0.gguf \
       --sampling-method euler -p "your prompt" \
       --steps 4 --cfg-scale 1 --width 768 --height 768 \
       --offload-to-cpu --diffusion-fa -v
```

**Gotchas discovered during testing:**
1. Klein uses `--llm` (Qwen3-4B), NOT `--clip_l` / `--t5xxl` (those are Flux 1)
2. Must use the **Flux 2 VAE** (`flux2-vae.safetensors`, 32 latent channels) — the Flux 1 `ae.safetensors` silently fails with tensor shape mismatch
3. The `--llm` model must be the **base** Qwen3, not Instruct
4. `--offload-to-cpu` and `--diffusion-fa` are practically required for consumer GPUs

## Scope

**In scope:**
- New type system for multi-component models (backwards-compatible)
- Per-model subdirectory storage for multi-component models
- Multi-file download flow in ModelManager
- Component-aware CLI arg building in DiffusionServerManager
- Aggregate resource estimation across all components
- New `--offload-to-cpu` and `--diffusion-fa` optimization flags
- Tests for all new functionality
- Updated type exports
- Documentation updates across all affected files

**Out of scope:**
- `registerModel()` API for pre-existing local files (future enhancement)
- Auto-detection of architecture from model files
- LoRA / ControlNet management (separate feature)
- Video generation (Wan models)
- Changes to LlamaServerManager (LLM models remain single-file)

## Design Decisions

### D1: One `ModelInfo` per logical model (not per file)

A user thinks of "Flux 2 Klein" as one model, not three. The `ModelInfo` record represents the complete model, with an optional `components` map for the individual files.

### D2: Backwards-compatible extension

- `ModelInfo.path` stays as-is for single-file models (LLM + monolithic diffusion)
- For multi-component models, `path` points to the primary diffusion model
- New `components` field holds all component paths (including the primary one)
- `size` becomes the aggregate total across all components
- Code that only reads `path` continues to work unchanged

### D3: Per-model subdirectories (multi-component only)

Single-file models keep the current flat layout. Multi-component models get a subdirectory:

```
userData/models/diffusion/
  sdxl-turbo.json                      # metadata (monolithic, unchanged)
  sdxl-turbo.safetensors               # model file (monolithic, unchanged)
  flux-2-klein/                        # per-model dir (multi-component)
    flux-2-klein-4b-Q8_0.gguf         # diffusion model (~4.3 GB)
    Qwen3-4B-Q4_0.gguf                # LLM text encoder (~2.5 GB)
    flux2-vae.safetensors              # Flux 2 VAE (~335 MB)
  flux-2-klein.json                    # metadata (components map inside)
```

### D4: `DiffusionServerConfig` references models by ID, not paths

The config references models by `modelId`. Component paths are resolved at runtime from `ModelInfo.components` — the app developer doesn't need to know about individual file paths. Two new optional fields are added (`offloadToCpu`, `diffusionFlashAttention`) for VRAM optimization control, following the existing pattern of `clipOnCpu`/`vaeOnCpu`.

### D5: Component role → CLI flag mapping is explicit

Each component role maps to exactly one sd.cpp CLI flag. The mapping is defined as a constant, not derived.

---

## Phases

### Phase 1: Type System

**Goal**: Define the type foundation for multi-component models without breaking existing code.

**Files**:
- `src/types/models.ts` — new types + extend `ModelInfo` and `DownloadConfig`
- `src/types/index.ts` — export new types
- `src/index.ts` — re-export new types

**Work**:

1. Add new types to `src/types/models.ts`:

```typescript
/**
 * Component roles in a multi-file diffusion model.
 * Each role maps to a specific sd.cpp CLI flag.
 */
export type DiffusionComponentRole =
  | 'diffusion_model'  // --diffusion-model (main UNet/DiT)
  | 'clip_l'           // --clip_l (CLIP-L text encoder)
  | 'clip_g'           // --clip_g (CLIP-G text encoder, SDXL)
  | 't5xxl'            // --t5xxl (T5-XXL text encoder, SD3/Flux 1)
  | 'llm'              // --llm (LLM text encoder, Flux 2/Qwen Image)
  | 'llm_vision'       // --llm_vision (LLM vision, Qwen Image)
  | 'vae';             // --vae (VAE decoder)

/** Info about a single component file within a multi-component model. */
export interface DiffusionComponentInfo {
  /** Absolute path to this component file on disk. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** SHA256 checksum with sha256: prefix. */
  checksum?: string;
}

/**
 * Map of component roles to their file info.
 * Present on ModelInfo only for multi-component diffusion models.
 */
export type DiffusionModelComponents = Partial<
  Record<DiffusionComponentRole, DiffusionComponentInfo>
>;

/**
 * Download specification for a single component within a multi-file model.
 * Used inside DownloadConfig.components.
 */
export interface DiffusionComponentDownload {
  /** Which component this file represents. */
  role: DiffusionComponentRole;
  /** Download source type. */
  source: 'huggingface' | 'url';
  /** Direct download URL (required if source is 'url'). */
  url?: string;
  /** HuggingFace repository (required if source is 'huggingface'). */
  repo?: string;
  /** File path within the HuggingFace repo (required if source is 'huggingface'). */
  file?: string;
  /** Expected SHA256 checksum for verification. */
  checksum?: string;
}
```

2. Extend `ModelInfo` (backwards-compatible):

```typescript
export interface ModelInfo {
  // ... existing fields unchanged ...
  path: string;   // For multi-component: points to the diffusion_model component
  size: number;   // For multi-component: aggregate total of all component sizes

  /**
   * Component files for multi-component diffusion models.
   * Undefined for single-file models (LLM, monolithic diffusion).
   * When present, `path` points to the diffusion_model component
   * and `size` is the aggregate total.
   */
  components?: DiffusionModelComponents;
}
```

3. Extend `DownloadConfig` (backwards-compatible):

```typescript
export interface DownloadConfig {
  // ... existing fields unchanged (used for single-file or primary component) ...

  /**
   * Additional component files for multi-component diffusion models.
   * When present, the top-level url/repo/file describes the primary
   * diffusion model, and each entry here describes an additional component.
   */
  components?: DiffusionComponentDownload[];
}
```

4. Export new types from `src/types/index.ts` and `src/index.ts`.

**Verification**:
- [ ] `npm run build` passes with zero errors
- [ ] All existing tests pass unchanged
- [ ] New types are accessible via `import { DiffusionComponentRole } from 'genai-electron'`

---

### Phase 2: Storage & Paths

**Goal**: Support per-model subdirectories for multi-component models while preserving the flat layout for single-file models.

**Files**:
- `src/config/paths.ts` — add `getModelDirectory()` helper
- `src/managers/StorageManager.ts` — multi-file deletion and integrity checks
- `src/index.ts` — export new path helper

**Work**:

1. Add to `src/config/paths.ts`:

```typescript
/**
 * Returns the path to a per-model subdirectory for multi-component models.
 * Creates: {models_dir}/{type}/{modelId}/
 */
export function getModelDirectory(
  type: 'llm' | 'diffusion',
  modelId: string
): string {
  return path.join(PATHS.models[type], modelId);
}
```

2. Update `StorageManager.deleteModelFiles()`:
   - If `metadata.components` exists, iterate all component paths and delete each file
   - Then delete the model subdirectory (if it exists and is empty)
   - Then delete the metadata JSON (existing behavior)
   - Backwards-compatible: single-file models still just delete `metadata.path`

3. Update `StorageManager.verifyModelIntegrity()`:
   - If `metadata.components` exists, verify each component file exists
   - If any component has a checksum, verify it
   - Backwards-compatible: single-file models still just verify `metadata.path`

**Known limitation**: Metadata JSON stores absolute paths for component files (same as existing single-file `path` field). If a user moves their `userData` directory, paths break. Not a regression — existing behavior. Future Phase 4 shared storage could switch to relative paths.

**Verification**:
- [ ] `npm run build` passes
- [ ] Existing StorageManager tests pass unchanged
- [ ] New tests for multi-file delete and verify

---

### Phase 3: Multi-Component Download

**Goal**: Enable `ModelManager.downloadModel()` to download multiple component files for a single logical model.

**Files**:
- `src/managers/ModelManager.ts` — extend `downloadModel()` flow
- `src/download/Downloader.ts` — no changes needed (reuse for each component)

**Work**:

1. Extend `downloadModel()` to handle `config.components`:

```
If config.components is present:
  a. Validate: reject if any component has role 'diffusion_model'
     (top-level url/repo/file is implicitly the diffusion_model — duplicates are a config error)
  b. Create per-model subdirectory: getModelDirectory(type, modelId)
  c. Download primary model (from config.url/repo/file) → subdirectory
  d. Download each component (from config.components[]) → subdirectory
  e. Build DiffusionModelComponents map from downloaded files (including primary as diffusion_model)
  f. Set modelInfo.size = sum of all component sizes
  g. Set modelInfo.path = diffusion_model component path
  h. Set modelInfo.components = the built components map
  i. Save metadata as usual
Else:
  Existing single-file flow (unchanged)
```

2. Make GGUF metadata fetch conditional:
   - Currently `fetchGGUFMetadata()` is called unconditionally and failures abort the download
   - For multi-component models: only attempt GGUF fetch for `.gguf` files, skip for `.safetensors`/`.sft`
   - Store GGUF metadata only for the primary diffusion model (if it's GGUF)

3. Progress tracking for multi-component downloads:
   - The existing `onProgress` callback reports `{ downloaded, total, percentage }`
   - For multi-component: aggregate progress across all files into a single smooth 0→100%
   - **Pre-fetch total size** via parallel HEAD requests for all component URLs before downloading
     - Adds <1s latency to multi-GB downloads — negligible
     - Fallback: if a HEAD request fails, use 0 and adjust total when GET response arrives
   - Wrap the user's `onProgress` callback to track cumulative bytes:
     ```
     completedBytes = sum of already-downloaded component sizes
     wrappedCallback(downloaded, _total) → onProgress(completedBytes + downloaded, totalBytes)
     ```
   - Download components sequentially (simpler, avoids bandwidth contention)

4. Error handling:
   - If any component download fails, clean up all already-downloaded files
   - Throw a `DownloadError` that identifies which component failed
   - Checksum verification per-component (if checksums provided)

**Verification**:
- [ ] Single-file downloads work exactly as before
- [ ] Multi-component download creates subdirectory with all files
- [ ] Progress callback reports aggregate progress
- [ ] Partial failure cleans up correctly
- [ ] GGUF metadata fetched only for .gguf files

---

### Phase 4: Component-Aware CLI Args

**Goal**: `buildDiffusionArgs()` emits the correct per-component CLI flags when `ModelInfo.components` is present.

**Files**:
- `src/managers/DiffusionServerManager.ts` — update `buildDiffusionArgs()`, optimization logic
- `src/config/defaults.ts` — add component→flag mapping constant

**Work**:

1. Add CLI flag mapping and deterministic iteration order to `src/config/defaults.ts`:

```typescript
/**
 * Maps DiffusionComponentRole to the sd.cpp CLI flag.
 */
export const DIFFUSION_COMPONENT_FLAGS: Record<DiffusionComponentRole, string> = {
  diffusion_model: '--diffusion-model',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
  vae: '--vae',
};

/**
 * Canonical iteration order for component roles in CLI arg building.
 * Ensures deterministic, testable arg output regardless of object key order.
 */
export const DIFFUSION_COMPONENT_ORDER: readonly DiffusionComponentRole[] = [
  'diffusion_model', 'clip_l', 'clip_g', 't5xxl', 'llm', 'llm_vision', 'vae',
] as const;
```

2. Update `buildDiffusionArgs()` — iterate `DIFFUSION_COMPONENT_ORDER`, skip absent roles:

```
If modelInfo.components exists (multi-component):
  For each role in DIFFUSION_COMPONENT_ORDER:
    If modelInfo.components[role] exists:
      args.push(DIFFUSION_COMPONENT_FLAGS[role], info.path)
Else (single-file, backwards compat):
  args.push('-m', modelInfo.path)
```

3. Update `computeDiffusionOptimizations()`:
   - `modelSize` should use `modelInfo.size` (already the aggregate for multi-component)
   - Add `--offload-to-cpu` auto-detection: enable when `modelFootprint > availableVRAM * 0.85`
   - Add `--diffusion-fa` auto-detection: enable when model has `llm` component (Flux 2 indicator)

4. Add new optimization flags to `DiffusionServerConfig` in `src/types/images.ts`:

```typescript
export interface DiffusionServerConfig {
  // ... existing fields ...
  /** Offload model weights to CPU RAM, load to VRAM on demand (--offload-to-cpu).
   *  undefined = auto-detect, true = force on, false = force off. */
  offloadToCpu?: boolean;
  /** Enable flash attention in the diffusion model (--diffusion-fa).
   *  undefined = auto-detect, true = force on, false = force off. */
  diffusionFlashAttention?: boolean;
}
```

5. Update `VALID_CONFIG_FIELDS` in `DiffusionServerManager.ts` to include `'offloadToCpu'` and `'diffusionFlashAttention'`. **Critical**: if missed, config validation silently strips these fields.

6. Update `buildDiffusionArgs()` to emit `--offload-to-cpu` and `--diffusion-fa` from the optimizations object (same pattern as existing `--clip-on-cpu` / `--vae-on-cpu`).

**Verification**:
- [ ] Monolithic models still get `-m path` (backwards compat)
- [ ] SDXL split model gets `--diffusion-model ... --clip_l ... --clip_g ... --vae ...`
- [ ] Flux 2 Klein gets `--diffusion-model ... --llm ... --vae ...`
- [ ] `--offload-to-cpu` emitted when appropriate
- [ ] `--diffusion-fa` emitted when configured

---

### Phase 5: Resource Estimation Verification

**Goal**: Verify that existing resource estimation works correctly with multi-component models. No new logic — Phase 4 handles the auto-detection implementation.

**Note**: This phase is verification-only. The auto-detection logic for `offloadToCpu` and `diffusionFlashAttention` is implemented in Phase 4's `computeDiffusionOptimizations()`. Phase 5 confirms the rest of the resource pipeline handles aggregate sizes correctly.

**Files**:
- `src/managers/ResourceOrchestrator.ts` — `estimateDiffusionUsage()` (verify, no changes expected)
- `src/system/SystemInfo.ts` — `canRunModel()` (verify, no changes expected)

**Work**:

1. Verify `computeDiffusionOptimizations()` auto-detection (implemented in Phase 4) with realistic scenarios:
   - Flux 2 Klein Q8_0+Q4_0 (~7GB total) on 8GB VRAM GPU → should auto-enable `--offload-to-cpu`
   - Flux 2 Klein Q8_0+Q8_0 (~9GB total) on 12GB VRAM GPU → should auto-enable `--offload-to-cpu`
   - Flux 2 Dev (~34GB total) on any consumer GPU → should auto-enable `--offload-to-cpu`
   - SDXL split (~7GB total) on 12GB VRAM GPU → should NOT auto-enable `--offload-to-cpu`

2. Verify `estimateDiffusionUsage()` in ResourceOrchestrator:
   - Uses `modelInfo.size * 1.2` — since `size` is the aggregate, this works unchanged
   - Keep the simple heuristic (conservative, safe)
   - No code changes needed

3. Verify `canRunModel()` in SystemInfo — **defer multi-component refinement**:
   - Currently checks `modelInfo.size` (aggregate) against total/available memory
   - This is conservative for multi-component + `--offload-to-cpu` (overestimates VRAM need)
   - **Known limitation**: may reject models that could run with offloading enabled
   - **Safe**: will never greenlight models that can't actually run
   - Future refinement: check "largest single component fits in VRAM" + "total fits in RAM"
   - No code changes needed now

**Verification**:
- [ ] Flux 2 Klein resource estimation is reasonable (~7-9GB depending on quants)
- [ ] Flux 2 Dev auto-enables offload-to-cpu
- [ ] SDXL split model resource estimation matches monolithic
- [ ] ResourceOrchestrator offload decisions still work correctly

---

### Phase 6: Tests

**Goal**: Comprehensive test coverage for all multi-component functionality.

**Files**:
- `tests/unit/DiffusionServerManager.test.ts` — new test cases
- `tests/unit/ModelManager.test.ts` — new test cases
- `tests/unit/StorageManager.test.ts` — new test cases
- `tests/unit/ResourceOrchestrator.test.ts` — new test cases

**Work**:

1. **DiffusionServerManager tests**:
   - `buildDiffusionArgs()` with multi-component ModelInfo (Flux 2 Klein topology)
   - `buildDiffusionArgs()` with multi-component ModelInfo (SDXL split topology)
   - `buildDiffusionArgs()` with single-file ModelInfo (backwards compat)
   - `computeDiffusionOptimizations()` with large multi-component model
   - New `--offload-to-cpu` and `--diffusion-fa` flag tests
   - Config validation with new fields

2. **ModelManager tests**:
   - `downloadModel()` with `components` in config
   - Aggregate size calculation
   - GGUF metadata conditional fetch (skip for safetensors)
   - Partial download failure cleanup
   - Progress aggregation across components

3. **StorageManager tests**:
   - `deleteModelFiles()` with multi-component metadata
   - `verifyModelIntegrity()` with multi-component metadata
   - Subdirectory creation and cleanup

4. **ResourceOrchestrator tests**:
   - `estimateDiffusionUsage()` with multi-component model
   - Offload decision with large Flux 2 Dev model

**Verification**:
- [ ] All existing tests pass unchanged
- [ ] New tests cover SDXL split and Flux 2 topologies
- [ ] `npm test` passes with zero failures

---

### Phase 7: Exports, Documentation & Project Files

**Goal**: Clean public API surface, accurate documentation across all affected files, updated project metadata.

#### 7A: Export Verification

**Files**:
- `src/types/index.ts` — verify all new types exported
- `src/index.ts` — verify all new types and constants re-exported

**Work**:

1. Verify these types are exported from `src/types/index.ts` and re-exported from `src/index.ts`:
   - `DiffusionComponentRole`
   - `DiffusionComponentInfo`
   - `DiffusionModelComponents`
   - `DiffusionComponentDownload`

2. Verify these constants are exported from `src/index.ts`:
   - `DIFFUSION_COMPONENT_FLAGS`
   - `DIFFUSION_COMPONENT_ORDER`

#### 7B: User-Facing Documentation (High Priority)

These docs would be materially incomplete or wrong without updates.

**Files**:
- `genai-electron-docs/typescript-reference.md`
- `genai-electron-docs/model-management.md`
- `genai-electron-docs/image-generation.md`
- `DESIGN.md`

**Work**:

1. **`typescript-reference.md`** — Type reference must be complete:
   - Add new types section: `DiffusionComponentRole`, `DiffusionComponentInfo`, `DiffusionModelComponents`, `DiffusionComponentDownload`
   - Update `ModelInfo` interface: document new `components?` field, explain `path` and `size` semantics for multi-component
   - Update `DownloadConfig` interface: document new `components?` field with usage
   - Update `DiffusionServerConfig` interface: document `offloadToCpu?` and `diffusionFlashAttention?` with three-state semantics
   - Add new constants: `DIFFUSION_COMPONENT_FLAGS`, `DIFFUSION_COMPONENT_ORDER`

2. **`model-management.md`** — Core download API doc:
   - Update `downloadModel()` documentation: new `components` parameter, multi-file flow
   - Add new subsection: "Multi-Component Model Downloads" with Flux 2 Klein example
   - Document aggregate progress callback behavior (smooth 0→100% across components)
   - Document per-model subdirectory storage layout for multi-component models
   - Document GGUF metadata conditional fetch (skipped for `.safetensors`)
   - Document cleanup-on-failure behavior for partial multi-component downloads

3. **`image-generation.md`** — Diffusion server API doc:
   - Document that `start({ modelId })` works unchanged — component resolution is internal
   - Add note about auto-detection of `--offload-to-cpu` and `--diffusion-fa`
   - Document new `DiffusionServerConfig` fields (`offloadToCpu`, `diffusionFlashAttention`)
   - Add example: starting a Flux 2 Klein model (showing that the API is the same)

4. **`DESIGN.md`** — Architecture reference:
   - Update storage strategy section: add per-model subdirectory layout alongside flat layout
   - Update directory structure example to show multi-component model subdirectory
   - Update download data flow to mention multi-file sequential download with progress aggregation
   - Update phase status to reflect multi-component support completion

#### 7C: Supporting Documentation (Medium Priority)

These docs benefit from updates but aren't broken without them.

**Files**:
- `genai-electron-docs/troubleshooting.md`
- `genai-electron-docs/example-control-panel.md`
- `README.md`

**Work**:

5. **`troubleshooting.md`** — New failure modes to document:
   - Component checksum mismatch (which component failed, how to re-download)
   - Wrong VAE file for Flux 2 (Flux 1 `ae.safetensors` vs Flux 2 `flux2-vae.safetensors`)
   - Partial download cleanup (what happens if download is interrupted mid-component)
   - "Model too large" with `--offload-to-cpu` suggestion

6. **`example-control-panel.md`** — Reference implementation:
   - Note that multi-component models are supported (same `modelId` API)
   - Optional: add Flux 2 Klein as an example download in the walkthrough

7. **`README.md`** — Project overview:
   - Add "Multi-component diffusion models (Flux 2, SDXL split)" to feature list
   - Keep quick start simple (single-file example is fine for introduction)

#### 7D: Low-Priority Documentation (Review & Update Where Needed)

These docs may need minor clarifications. Review each and update only where content would be misleading.

**Files**:
- `genai-electron-docs/resource-orchestration.md` — clarify aggregate size estimation for multi-component
- `genai-electron-docs/integration-guide.md` — note that `modelId` still references the complete model
- `genai-electron-docs/installation-and-setup.md` — note storage growth for multi-component models
- `genai-electron-docs/system-detection.md` — `canRunModel()` uses aggregate size (conservative)
- `genai-electron-docs/index.md` — feature list is generic enough, may not need changes
- `docs/SETUP.md` — note new test categories for multi-component scenarios

#### 7E: Project Metadata

**Files**:
- `PROGRESS.md` — update with multi-component support status
- `CLAUDE.md` — update test count, phase description, key exports list

**Verification**:
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run format` passes
- [ ] All tests pass
- [ ] All 4 new types appear in `typescript-reference.md`
- [ ] `model-management.md` has multi-component download example
- [ ] `image-generation.md` documents new `DiffusionServerConfig` fields
- [ ] `DESIGN.md` storage strategy includes subdirectory layout

---

## Example Usage (Post-Implementation)

### Downloading Flux 2 Klein (Q8_0 diffusion + Q4_0 LLM)

```typescript
import { modelManager } from 'genai-electron';

const modelInfo = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein',
  type: 'diffusion',
  components: [
    {
      role: 'llm',
      source: 'huggingface',
      repo: 'unsloth/Qwen3-4B-GGUF',       // Must be base, not Instruct
      file: 'Qwen3-4B-Q4_0.gguf',
    },
    {
      role: 'vae',
      source: 'url',                        // Direct URL (nested path in repo)
      url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
    },
  ],
  onProgress: (progress) => {
    console.log(`${progress.percentage}% complete`);
  },
});

// modelInfo.size ≈ 7.1 GB (aggregate)
// modelInfo.path = '.../flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
// modelInfo.components = {
//   diffusion_model: { path: '.../flux-2-klein/flux-2-klein-4b-Q8_0.gguf', size: 4.3GB },
//   llm:             { path: '.../flux-2-klein/Qwen3-4B-Q4_0.gguf', size: 2.5GB },
//   vae:             { path: '.../flux-2-klein/flux2-vae.safetensors', size: 335MB },
// }
```

### Starting the server (unchanged API)

```typescript
import { diffusionServer } from 'genai-electron';

// Same API — component resolution happens internally
await diffusionServer.start({ modelId: 'flux-2-klein' });
```

---

## Resolved Decisions

1. **Primary component role**: **Implicit primary in input, explicit in output.** `DownloadConfig` top-level `source`/`repo`/`file` is the diffusion model (avoids discriminated union type refactor). `ModelInfo.components` includes ALL roles including `diffusion_model` (complete, iterable). Invariant: `path === components.diffusion_model.path`.

2. **Shared components across models**: **Defer to Phase 4 shared storage.** Accept duplication for now — the largest shared component (VAE) is ~335MB, negligible next to multi-GB models. Symlinks are fragile cross-platform. The per-model subdirectory design is forward-compatible with future content-addressable dedup.

3. **`--offload-to-cpu` scope**: **Three-state with auto-detect.** `offloadToCpu?: boolean` — `undefined` = auto-detect, `true` = force on, `false` = force off. Auto-detect enables when `modelInfo.size > availableVRAM * 0.85`. Same pattern for `diffusionFlashAttention?: boolean` — auto-enables when model has an `llm` component (Flux 2 architecture indicator).

4. **Component download order**: **Sequential, parallel-ready architecture.** Network bandwidth is the bottleneck for multi-GB downloads. Sequential gives clean progress reporting ("Downloading component 2/3") and simple error handling. The per-component download design supports switching to `Promise.all()` later with minimal change. Consider downloading smallest component first for quick validation.

---

**Status: APPROVED — Ready to implement.**
