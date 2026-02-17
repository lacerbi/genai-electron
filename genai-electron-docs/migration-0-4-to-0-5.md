# Migrating from v0.4.x to v0.5.0

Guide for upgrading genai-electron from 0.4.x to 0.5.0. The headline feature is **multi-component diffusion model support** — models like Flux 2 Klein that require multiple files (diffusion model, text encoder, VAE) are now first-class citizens.

---

## Compatibility

All changes in 0.5.0 are **additive**. Existing 0.4.x code works without modification:

- Single-file model downloads are unchanged
- `diffusionServer.start({ modelId })` works the same for monolithic models
- All existing types are backwards-compatible (new fields are optional)

**One behavioral change**: `orchestrateImageGeneration()` now returns the image result immediately — the LLM server reloads asynchronously in the background. See [Resource Orchestration Changes](#resource-orchestration-changes) if your app depends on the LLM being ready when the promise resolves.

---

## What's New

| Feature | Summary |
|---------|---------|
| Multi-component downloads | Download models composed of multiple files (diffusion model + encoder + VAE) |
| Per-model subdirectories | Multi-component models stored in their own directory |
| Shared variant storage | Multiple quant variants share common files (encoder, VAE) |
| Optimization auto-detection | `--offload-to-cpu` and `--diffusion-fa` enabled automatically when needed |
| CUDA safety | CPU offload flags auto-disabled for CUDA backend (prevents silent crashes) |
| Component-aware CLI args | Server start emits per-component flags (`--diffusion-model`, `--llm`, `--vae`) |
| Async LLM reload | Image generation returns faster; LLM reloads in the background |

---

## New Types

Four new types support multi-component models.

### DiffusionComponentRole

Each role maps to a stable-diffusion.cpp CLI flag:

```typescript
type DiffusionComponentRole =
  | 'diffusion_model'  // --diffusion-model (main UNet/DiT)
  | 'clip_l'           // --clip_l (CLIP-L text encoder)
  | 'clip_g'           // --clip_g (CLIP-G text encoder, SDXL)
  | 't5xxl'            // --t5xxl (T5-XXL text encoder, SD3/Flux 1)
  | 'llm'              // --llm (LLM text encoder, Flux 2/Qwen Image)
  | 'llm_vision'       // --llm_vision (LLM vision, Qwen Image)
  | 'vae';             // --vae (VAE decoder)
```

### DiffusionComponentInfo

Metadata about a single component file on disk:

```typescript
interface DiffusionComponentInfo {
  /** Absolute path to this component file on disk. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** SHA256 checksum with sha256: prefix. */
  checksum?: string;
}
```

### DiffusionModelComponents

Map of component roles to their file info. Only populated roles are present:

```typescript
type DiffusionModelComponents = Partial<
  Record<DiffusionComponentRole, DiffusionComponentInfo>
>;
```

### DiffusionComponentDownload

Specifies how to download one component. Used inside `DownloadConfig.components`:

```typescript
interface DiffusionComponentDownload {
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

---

## Extended Interfaces

### ModelInfo

New optional field for multi-component models:

```typescript
interface ModelInfo {
  // ... all existing fields unchanged ...

  /**
   * Component files for multi-component diffusion models.
   * Undefined for single-file models (LLM, monolithic diffusion).
   * When present, `path` points to the diffusion_model component
   * and `size` is the aggregate total of all component sizes.
   */
  components?: DiffusionModelComponents;
}
```

Code that reads `modelInfo.path` and `modelInfo.size` continues to work — `path` points to the primary diffusion model file, and `size` is the total across all components.

### DownloadConfig

Three new optional fields:

```typescript
interface DownloadConfig {
  // ... all existing fields unchanged ...

  /**
   * Additional component files for multi-component diffusion models.
   * When present, the top-level url/repo/file describes the primary
   * diffusion model, and each entry here describes an additional component.
   */
  components?: DiffusionComponentDownload[];

  /**
   * Subdirectory name for multi-component model storage.
   * When provided, used instead of the model ID for the directory name.
   * Allows multiple model variants to share the same directory on disk
   * (e.g., different quant levels sharing encoder/VAE files).
   */
  modelDirectory?: string;

  /**
   * Called when each component download begins (multi-component only).
   * Useful for displaying which component is currently being downloaded.
   */
  onComponentStart?: (info: {
    role: string;
    filename: string;
    index: number;   // 1-based
    total: number;
  }) => void;
}
```

### DiffusionServerConfig

Two new optional fields for VRAM optimization. Both use three-state semantics: `undefined` = auto-detect, `true` = force on, `false` = force off.

```typescript
interface DiffusionServerConfig {
  // ... all existing fields unchanged ...

  /**
   * Offload model weights to CPU RAM, load to VRAM on demand (--offload-to-cpu).
   *
   * Auto-detect: enabled when modelInfo.size > availableVRAM * 0.85.
   * Disabled for CUDA backend (crashes sd.cpp CUDA builds silently).
   */
  offloadToCpu?: boolean;

  /**
   * Enable flash attention in the diffusion model (--diffusion-fa).
   *
   * Auto-detect: enabled when model has an 'llm' component (Flux 2 architecture).
   */
  diffusionFlashAttention?: boolean;
}
```

**CUDA safety note**: `clipOnCpu`, `vaeOnCpu`, and `offloadToCpu` are now auto-disabled when a CUDA binary variant is installed. This prevents silent crashes in sd.cpp CUDA builds. You can still force them on with `true`, but this is not recommended for CUDA.

---

## New Exports

All importable from `genai-electron`:

```typescript
import {
  // New types
  DiffusionComponentRole,
  DiffusionComponentInfo,
  DiffusionModelComponents,
  DiffusionComponentDownload,

  // New constants
  DIFFUSION_COMPONENT_FLAGS,   // Record<DiffusionComponentRole, string>
  DIFFUSION_COMPONENT_ORDER,   // readonly DiffusionComponentRole[]

  // New utility
  getModelDirectory,           // (type, modelId) => string
} from 'genai-electron';
```

**`DIFFUSION_COMPONENT_FLAGS`** maps each role to its sd.cpp CLI flag:

```typescript
const DIFFUSION_COMPONENT_FLAGS: Record<DiffusionComponentRole, string> = {
  diffusion_model: '--diffusion-model',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
  vae: '--vae',
};
```

**`DIFFUSION_COMPONENT_ORDER`** defines the canonical iteration order for deterministic CLI arg output:

```typescript
const DIFFUSION_COMPONENT_ORDER: readonly DiffusionComponentRole[] = [
  'diffusion_model', 'clip_l', 'clip_g', 't5xxl', 'llm', 'llm_vision', 'vae',
];
```

**`getModelDirectory(type, modelId)`** returns the path to a per-model subdirectory:

```typescript
import { getModelDirectory } from 'genai-electron';

const dir = getModelDirectory('diffusion', 'flux-2-klein');
// → {userData}/models/diffusion/flux-2-klein/
```

---

## Multi-Component Model Downloads

### Concept

Some modern diffusion architectures ship their components as separate files:

| Architecture | Components | sd.cpp Flags |
|---|---|---|
| **Monolithic** (SDXL Turbo, etc.) | Single file | `-m` |
| **SDXL Split** | UNet + CLIP-L + CLIP-G + VAE | `--diffusion-model --clip_l --clip_g --vae` |
| **Flux 2 Klein** | DiT-4B + Qwen3-4B + VAE | `--diffusion-model --llm --vae` |
| **Flux 2 Dev** | DiT + Mistral-Small-24B + VAE | `--diffusion-model --llm --vae` |

In `DownloadConfig`, the top-level `source`/`repo`/`file` fields describe the **primary diffusion model**. The `components` array describes additional files. Each component has a `role` that determines its CLI flag at server start.

### Download Example

```typescript
import { modelManager } from 'genai-electron';

const modelInfo = await modelManager.downloadModel({
  // Primary: the diffusion model (implicitly role 'diffusion_model')
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein Q8_0',
  type: 'diffusion',

  // Additional components
  components: [
    {
      role: 'llm',
      source: 'huggingface',
      repo: 'unsloth/Qwen3-4B-GGUF',
      file: 'Qwen3-4B-Q4_0.gguf',
    },
    {
      role: 'vae',
      source: 'url',
      url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
    },
  ],

  // Aggregate progress across all components (smooth 0→100%)
  onProgress: (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(1);
    console.log(`Overall: ${percent}%`);
  },

  // Per-component progress
  onComponentStart: (info) => {
    console.log(`Downloading component ${info.index}/${info.total}: ${info.filename}`);
  },
});

// modelInfo.size ≈ 7.1 GB (aggregate of all components)
// modelInfo.path → '.../flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
// modelInfo.components → {
//   diffusion_model: { path: '...', size: 4617..., checksum: '...' },
//   llm:             { path: '...', size: 2684..., checksum: '...' },
//   vae:             { path: '...', size: 335...,  checksum: '...' },
// }
```

**Key behaviors**:

- Components are downloaded sequentially (one at a time)
- `onProgress` reports aggregate bytes across all components — a single smooth 0→100%
- `onComponentStart` fires before each component download (including the primary)
- GGUF metadata is fetched only for `.gguf` files (skipped for `.safetensors`)
- If any component fails, all files downloaded in the current attempt are cleaned up

### Storage Layout

Single-file models keep the existing flat layout. Multi-component models get a per-model subdirectory:

```
{userData}/models/diffusion/
  sdxl-turbo.safetensors                  ← monolithic (flat, unchanged)
  sdxl-turbo.json                         ← metadata

  flux-2-klein/                           ← multi-component subdirectory
    flux-2-klein-4b-Q8_0.gguf            ← diffusion model (~4.3 GB)
    Qwen3-4B-Q4_0.gguf                   ← LLM text encoder (~2.5 GB)
    flux2-vae.safetensors                 ← VAE (~335 MB)
  flux-2-klein-q8-0.json                  ← metadata (at parent level)
```

### Shared Variant Downloads

When downloading a second quantization variant of the same model (e.g., Q4_0 after Q8_0), shared components (encoder, VAE) should not be re-downloaded. The `modelDirectory` field enables this:

```typescript
// First variant: Q8_0
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein Q8_0',
  type: 'diffusion',
  modelDirectory: 'flux-2-klein',       // ← shared directory name
  components: [/* ... same components ... */],
});

// Second variant: Q4_0 — encoder and VAE already exist, skipped automatically
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q4_0.gguf',
  name: 'Flux 2 Klein Q4_0',
  type: 'diffusion',
  modelDirectory: 'flux-2-klein',       // ← same directory
  components: [/* ... same components ... */],
});
```

Both variants produce distinct model entries (`flux-2-klein-q8-0`, `flux-2-klein-q4-0`) but share the same on-disk directory and identical component files. The second download saves ~2.8 GB by reusing the encoder and VAE.

**Skip-if-exists behavior**:

- Before downloading each component, the library checks if the file already exists on disk
- If the file exists and has a matching checksum (or no checksum was specified), it is skipped
- If the file exists but the checksum does not match, it is deleted and re-downloaded
- `onComponentStart` still fires for skipped files (so your UI can show "already exists")

### Deletion Safety

When a model is deleted via `modelManager.deleteModel()`, shared component files are protected:

- The library scans all other models of the same type for shared file references
- Component files referenced by another variant are **not deleted**
- Component files unique to the deleted variant are removed
- The model subdirectory is removed only if empty (no other variant's files remain)
- The metadata JSON is always deleted

This means deleting "Flux 2 Klein Q8_0" removes `flux-2-klein-4b-Q8_0.gguf` (unique to that variant) but preserves `Qwen3-4B-Q4_0.gguf` and `flux2-vae.safetensors` if another variant still references them.

### Storage Accounting

`StorageManager.getStorageUsed()` deduplicates shared files by absolute path. Two variants sharing an encoder and VAE report the shared files' sizes only once. This gives an accurate disk usage total.

```typescript
import { StorageManager } from 'genai-electron';

const storage = StorageManager.getInstance();
const totalBytes = await storage.getStorageUsed('diffusion');
console.log(`Diffusion models: ${(totalBytes / 1024 ** 3).toFixed(1)} GB`);
```

---

## Starting Multi-Component Models

The server start API is **unchanged**. Component resolution happens internally:

```typescript
import { diffusionServer } from 'genai-electron';

await diffusionServer.start({
  modelId: 'flux-2-klein-q8-0',
  port: 8081,
  // Optimization flags auto-detected — or override explicitly:
  // offloadToCpu: true,
  // diffusionFlashAttention: true,
});
```

For multi-component models, the library reads `ModelInfo.components` and emits per-component CLI flags in a deterministic order (following `DIFFUSION_COMPONENT_ORDER`). For monolithic models, it emits the classic `-m` flag — no change.

### Automatic Optimization

The library auto-detects optimization flags at server start:

| Flag | Auto-detection rule | Overridable? |
|------|-------------------|-------------|
| `--offload-to-cpu` | Enabled when `modelInfo.size > availableVRAM * 0.85` | Yes (`offloadToCpu: true/false`) |
| `--diffusion-fa` | Enabled when model has an `llm` component (Flux 2) | Yes (`diffusionFlashAttention: true/false`) |
| `--clip-on-cpu` | Enabled when VRAM headroom < 6 GB | Yes (`clipOnCpu: true/false`) |
| `--vae-on-cpu` | Enabled when VRAM headroom < 2 GB | Yes (`vaeOnCpu: true/false`) |

All CPU offload flags (`clipOnCpu`, `vaeOnCpu`, `offloadToCpu`) are **auto-disabled for CUDA backend** because they crash sd.cpp CUDA builds silently.

---

## Resource Orchestration Changes

`orchestrateImageGeneration()` now returns the image result **immediately** after generation completes. Previously, it waited for the LLM server to reload before resolving. This change typically saves 10–30 seconds of perceived latency.

**Behavioral change**: The LLM server may not be running when the promise resolves. If your app needs the LLM immediately after image generation, use the new `waitForReload()` method:

```typescript
import { ResourceOrchestrator, llamaServer, diffusionServer, systemInfo } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, diffusionServer);

// Image result returned immediately — LLM reloads in background
const result = await orchestrator.orchestrateImageGeneration(config);
displayImage(result);

// If you need the LLM right away:
await orchestrator.waitForReload();
// LLM is now fully reloaded (or reload failed)
```

If you don't call `waitForReload()`, the LLM server still reloads — it just happens asynchronously. Next time you check `llamaServer.isRunning()` or make an inference call, the reload will have completed (or you'll get a clear error).

---

## Preset System (Example App Pattern)

The electron-control-panel example app includes a **preset system** for one-click multi-component model downloads. This is an app-level pattern, not a library API — you can adopt or adapt it for your own app.

### How It Works

A preset defines a complete model package: primary diffusion model with quant variants, additional components (some with their own variants, some fixed), and recommended generation settings. When the user selects a preset and clicks download, the app translates it into a `DownloadConfig` with `components`.

### ModelPreset Type

```typescript
interface PresetVariant {
  label: string;       // "Q8_0 (~4.3 GB)"
  file?: string;       // HuggingFace filename
  url?: string;        // Direct URL (for url source)
  sizeGB: number;      // Approximate size for display
}

interface PresetComponent {
  role: DiffusionComponentRole;
  label: string;       // "Text Encoder (Qwen3-4B base)"
  source: 'huggingface' | 'url';
  repo?: string;
  variants?: PresetVariant[];    // If multiple quant options
  fixedFile?: string;            // HuggingFace filename for fixed component
  fixedUrl?: string;             // Direct URL for fixed component
  fixedSizeGB?: number;
}

interface PresetRecommendedSettings {
  steps: number;
  cfgScale: number;
  sampler: string;
  width?: number;
  height?: number;
}

interface ModelPreset {
  id: string;
  name: string;
  description: string;
  type: 'llm' | 'diffusion';
  primary: {
    source: 'huggingface' | 'url';
    repo?: string;
    variants: PresetVariant[];
  };
  components: PresetComponent[];
  recommendedSettings?: PresetRecommendedSettings;
}
```

### Translating a Preset to DownloadConfig

The app builds a `DownloadConfig` from the user's selections:

```typescript
const preset = MODEL_PRESETS.find(p => p.id === selectedPresetId);
const primaryVariant = preset.primary.variants[selectedPrimaryIndex];

// Extract quant label (e.g., "Q8_0" from "Q8_0 (~4.3 GB)")
const variantTag = primaryVariant.label.split(' ')[0];

const config: DownloadConfig = {
  source: preset.primary.source,
  repo: preset.primary.repo,
  file: primaryVariant.file,
  name: `${preset.name} ${variantTag}`,     // "Flux 2 Klein Q8_0"
  type: preset.type,
  modelDirectory: preset.id,                 // shared directory: "flux-2-klein"
  components: preset.components.map(comp => {
    if (comp.variants) {
      const variant = comp.variants[selectedVariantIndex[comp.role]];
      return { role: comp.role, source: comp.source, repo: comp.repo, file: variant.file };
    }
    return { role: comp.role, source: comp.source, url: comp.fixedUrl };
  }),
  onProgress: (downloaded, total) => { /* update UI */ },
  onComponentStart: (info) => { /* show "Component 2/3: filename" */ },
};

await modelManager.downloadModel(config);
```

### Bundled Presets

The example app ships two presets:

**Flux 2 Klein** (multi-component, 3 files):
- Primary: `leejet/FLUX.2-klein-4B-GGUF` — Q8_0 (~4.3 GB) or Q4_0 (~2.5 GB)
- LLM encoder: `unsloth/Qwen3-4B-GGUF` — Q4_0 (~2.5 GB) or Q8_0 (~4.3 GB)
- VAE: `Comfy-Org/flux2-dev` — `flux2-vae.safetensors` (~0.34 GB, fixed)
- Recommended: 4 steps, CFG 1, euler sampler, 768×768

**SDXL Lightning 4-step** (monolithic, single file):
- Primary: `mzwing/SDXL-Lightning-GGUF` — Q4_1 (~2.8 GB) or Q5_1 (~3.2 GB)
- No additional components
- Recommended: 4 steps, CFG 1, euler sampler, 1024×1024

---

## Flux 2 Klein: Complete Walkthrough

End-to-end example for downloading and running Flux 2 Klein, the first multi-component model supported by genai-electron.

### Architecture

Flux 2 Klein uses three separate files that work together:

| Component | Role | Repository | Available Quants | Notes |
|---|---|---|---|---|
| Diffusion model (Klein 4B) | `diffusion_model` | `leejet/FLUX.2-klein-4B-GGUF` | Q8_0 (~4.3 GB), Q4_0 (~2.5 GB) | Main DiT model |
| Text encoder (Qwen3-4B) | `llm` | `unsloth/Qwen3-4B-GGUF` | Q4_0 (~2.5 GB), Q8_0 (~4.3 GB) | Must be **base** model, NOT Instruct |
| VAE (Flux 2, 32 channels) | `vae` | `Comfy-Org/flux2-dev` | Single file (~0.34 GB) | Must be Flux **2** VAE, NOT Flux 1 |

Total storage: ~5.3–8.9 GB depending on quantization choices.

### Step 1: Download

```typescript
import { modelManager } from 'genai-electron';

const modelInfo = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein Q8_0',
  type: 'diffusion',
  modelDirectory: 'flux-2-klein',

  components: [
    {
      role: 'llm',
      source: 'huggingface',
      repo: 'unsloth/Qwen3-4B-GGUF',
      file: 'Qwen3-4B-Q4_0.gguf',
    },
    {
      role: 'vae',
      source: 'url',
      url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
    },
  ],

  onProgress: (downloaded, total) => {
    const pct = Math.round((downloaded / total) * 100);
    process.stdout.write(`\r  ${pct}%`);
  },

  onComponentStart: ({ index, total, filename }) => {
    console.log(`\nComponent ${index}/${total}: ${filename}`);
  },
});

console.log(`\nDownloaded: ${modelInfo.id} (${(modelInfo.size / 1024 ** 3).toFixed(1)} GB)`);
```

### Step 2: Start Server

```typescript
import { diffusionServer } from 'genai-electron';

await diffusionServer.start({
  modelId: modelInfo.id,   // 'flux-2-klein-q8-0'
  port: 8081,
  // Auto-detected for Flux 2 Klein:
  //   offloadToCpu: true (model > 85% of most consumer GPUs)
  //   diffusionFlashAttention: true (has 'llm' component)
});

console.log('Server running on port 8081');
```

### Step 3: Generate Image

```typescript
const result = await diffusionServer.generateImage({
  prompt: 'A cat wearing a tiny astronaut helmet, photorealistic',
  width: 768,
  height: 768,
  steps: 4,
  cfgScale: 1,
  sampler: 'euler',
  onProgress: (step, total, stage, pct) => {
    console.log(`${stage}: ${Math.round(pct || 0)}%`);
  },
});

import { promises as fs } from 'fs';
await fs.writeFile('output.png', result.image);
console.log(`Generated in ${result.timeTaken}ms, seed: ${result.seed}`);
```

### Gotchas

- **Qwen3 base, not Instruct**: The `--llm` text encoder must be the Qwen3-4B **base** model. The Instruct variant will not work correctly.
- **Flux 2 VAE, not Flux 1**: Use `flux2-vae.safetensors` (32 latent channels). The Flux 1 `ae.safetensors` (16 latent channels) causes a silent tensor shape mismatch that produces garbled output.
- **`--offload-to-cpu` required on most GPUs**: At ~7 GB minimum, Flux 2 Klein exceeds the VRAM of most consumer GPUs. The library auto-enables `--offload-to-cpu` when the model is larger than 85% of available VRAM (unless you're on a CUDA backend, where it's disabled for stability).
- **`--diffusion-fa` recommended**: Flash attention for the diffusion model improves performance on Flux 2. Auto-enabled when the model has an `llm` component.
- **Generation settings**: Flux 2 Klein is designed for fast generation — 4 steps with CFG scale 1 and the euler sampler produces good results at 768×768. Higher step counts offer diminishing returns.

---

## See Also

- [Image Generation](image-generation.md) — DiffusionServerManager API and server lifecycle
- [Model Management](model-management.md) — ModelManager API, downloads, and storage
- [Resource Orchestration](resource-orchestration.md) — ResourceOrchestrator and `waitForReload()`
- [TypeScript Reference](typescript-reference.md) — Complete type definitions
- [Example: Control Panel](example-control-panel.md) — Reference implementation with preset UI
