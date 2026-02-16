# Plan: Multi-Component Model Presets in Example App

Created: 2026-02-16
Status: PENDING APPROVAL

## Context

The genai-electron library now fully supports multi-component diffusion models (Flux 2 Klein, SDXL split) — download, storage, CLI arg building, and optimization auto-detection all work end-to-end. However, the electron-control-panel example app has no way to download multi-component models because `ModelDownloadForm` only builds flat single-file `DownloadConfig` objects. The `components` field is never populated.

## Goal

Add a preset-based download experience for multi-component models to the example app, so users can download Flux 2 Klein in one click with quant variant selection. Keep the existing freeform form as a "Custom" option.

## Decisions Made

- **Preset with quant dropdown** — Select "Flux 2 Klein", then pick quant level per component
- **Show which component is downloading** — e.g., "Downloading component 2/3: Qwen3-4B-Q4_0.gguf"
- **Keep freeform form** — Existing single-file download form stays as "Custom" option

## Scope

**In scope:**
- Model preset data structure with Flux 2 Klein and SDXL Lightning preset definitions
- Preset selector UI in ModelDownloadForm with quant variant dropdowns
- Per-component download progress display
- Multi-component badge in model list
- Flux 2 recommended generation settings hint in DiffusionServerControl
- Small library extension: `onComponentStart` callback in `DownloadConfig`

**Out of scope:**
- SDXL split (multi-component) preset — can be added later with the same system
- Preset management / user-defined presets
- Downloading presets from a remote registry
- Changes to the async image generation API

---

## Phases

### Phase 0: Type Consolidation

**Goal**: Eliminate duplicate local type definitions that would block multi-component support.

**Context**: `ModelInfo`, `DownloadConfig`, and `DownloadProgress` are each defined locally in multiple files, shadowing the library types and lacking `components`. Consolidate before building on them.

**Files**:
- `examples/electron-control-panel/renderer/components/ModelDownloadForm.tsx` — has local `DownloadConfig` + `DownloadProgress`
- `examples/electron-control-panel/renderer/components/hooks/useModels.ts` — has local `ModelInfo` + `DownloadConfig` + `DownloadProgress`
- `examples/electron-control-panel/renderer/types/api.ts` — add re-exports for new types
- `examples/electron-control-panel/renderer/types/ui.ts` — canonical location for `DownloadProgress`

**Work**:

1. Add `DiffusionComponentRole`, `DiffusionComponentDownload` to the import/re-export in `renderer/types/api.ts`.

2. Remove local `DownloadConfig` from `ModelDownloadForm.tsx` and `useModels.ts`. Import from `../types/api` instead (which re-exports the library type including `components?`).

3. Remove local `ModelInfo` from `useModels.ts`. Import from `../types/api` instead (which re-exports the library type including `components?`).

4. Remove local `DownloadProgress` from `ModelDownloadForm.tsx` and `useModels.ts`. Import from `../types/ui` instead (single canonical definition).

5. Verify that `LlamaServerConfig.tsx` local `ModelInfo` is unaffected (out of scope for this plan but noted for future cleanup).

**Verification**:
- [ ] Example app builds with no TypeScript errors
- [ ] No duplicate type definitions for `DownloadConfig`, `ModelInfo`, `DownloadProgress` remain in component/hook files

---

### Phase 1: Library Extension — `onComponentStart` Callback

**Goal**: Let callers know which component is currently being downloaded.

**Files**:
- `src/types/models.ts` — add callback to `DownloadConfig`
- `src/managers/ModelManager.ts` — fire callback in `downloadMultiComponentModel()`

**Work**:

1. Add to `DownloadConfig` in `src/types/models.ts`:

```typescript
/** Called when each component download begins (multi-component only). */
onComponentStart?: (info: {
  role: string;
  filename: string;
  index: number;
  total: number;
}) => void;
```

2. In `downloadMultiComponentModel()`, before each component's download call (the loop item already has a `filename` property):

```typescript
config.onComponentStart?.({
  role: item.role,
  filename: item.filename,
  index: i + 1,  // 1-based
  total: downloadItems.length,
});
```

3. Export the callback info type if useful, or keep it inline.

**Verification**:
- [ ] `npm run build` passes
- [ ] All existing tests pass unchanged
- [ ] New callback is optional (backwards compatible)

---

### Phase 2: Preset Data

**Goal**: Define the preset data structure, Flux 2 Klein preset (multi-component), and SDXL Lightning preset (monolithic).

**Files**:
- `examples/electron-control-panel/renderer/data/model-presets.ts` — NEW

**Work**:

1. Define preset type and Flux 2 Klein data:

```typescript
export interface PresetVariant {
  label: string;       // "Q8_0 (~4.3 GB)"
  file?: string;       // HuggingFace filename
  url?: string;        // Direct URL (for url source)
  sizeGB: number;      // Approximate size for display
}

export interface PresetComponent {
  role: string;        // DiffusionComponentRole
  label: string;       // "Text Encoder (Qwen3-4B base)"
  source: 'huggingface' | 'url';
  repo?: string;
  variants?: PresetVariant[];    // If multiple quant options
  fixedFile?: string;            // If no variants (e.g., VAE)
  fixedUrl?: string;             // Direct URL for fixed component
  fixedSizeGB?: number;
}

export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  primary: {
    source: 'huggingface' | 'url';
    repo?: string;
    variants: PresetVariant[];
  };
  components: PresetComponent[];
  recommendedSettings?: {
    steps: number;
    cfgScale: number;
    sampler: string;
    width?: number;
    height?: number;
  };
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'flux-2-klein',
    name: 'Flux 2 Klein',
    description: 'Fast Flux 2 image generation with Qwen3-4B text encoder. 3 components.',
    primary: {
      source: 'huggingface',
      repo: 'leejet/FLUX.2-klein-4B-GGUF',
      variants: [
        { label: 'Q8_0 (~4.3 GB)', file: 'flux-2-klein-4b-Q8_0.gguf', sizeGB: 4.3 },
        { label: 'Q4_0 (~2.5 GB)', file: 'flux-2-klein-4b-Q4_0.gguf', sizeGB: 2.5 },
      ],
    },
    components: [
      {
        role: 'llm',
        label: 'Text Encoder (Qwen3-4B base)',
        source: 'huggingface',
        repo: 'unsloth/Qwen3-4B-GGUF',
        variants: [
          { label: 'Q4_0 (~2.5 GB)', file: 'Qwen3-4B-Q4_0.gguf', sizeGB: 2.5 },
          { label: 'Q8_0 (~4.3 GB)', file: 'Qwen3-4B-Q8_0.gguf', sizeGB: 4.3 },
        ],
      },
      {
        role: 'vae',
        label: 'VAE (Flux 2, 32ch)',
        source: 'url',
        fixedUrl: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
        fixedSizeGB: 0.34,
      },
    ],
    recommendedSettings: {
      steps: 4,
      cfgScale: 1,
      sampler: 'euler',
      width: 768,
      height: 768,
    },
  },
  {
    id: 'sdxl-lightning-4step',
    name: 'SDXL Lightning (4-step)',
    description: 'Fast SDXL image generation in 4 steps. Single file, no extra components.',
    primary: {
      source: 'huggingface',
      repo: 'mzwing/SDXL-Lightning-GGUF',
      variants: [
        { label: 'Q4_1 (~2.8 GB)', file: 'sdxl_lightning_4step.q4_1.gguf', sizeGB: 2.8 },
        { label: 'Q5_1 (~3.2 GB)', file: 'sdxl_lightning_4step.q5_1.gguf', sizeGB: 3.2 },
      ],
    },
    components: [],  // Monolithic single-file model — no extra components
    recommendedSettings: {
      steps: 4,
      cfgScale: 1,
      sampler: 'euler',
      width: 1024,
      height: 1024,
    },
  },
];
```

---

### Phase 3: Download Form UI

**Goal**: Add preset selector to `ModelDownloadForm` with quant variant dropdowns.

**Files**:
- `examples/electron-control-panel/renderer/components/ModelDownloadForm.tsx`
- `examples/electron-control-panel/renderer/types/ui.ts`

**Work**:

1. Add new types to `ui.ts`:

```typescript
export interface ComponentProgress {
  role: string;
  filename: string;
  index: number;
  total: number;
}
```

2. Extend `DownloadProgress` in `ui.ts`:

```typescript
export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  modelName: string;
  component?: ComponentProgress;  // NEW: which component is downloading
}
```

3. Redesign `ModelDownloadForm` layout:

```
Download Mode: [Preset] [Custom]  ← toggle/tabs at top

── When "Preset" ──
Model:            [Flux 2 Klein          v]
                  "Fast Flux 2 with Qwen3-4B. 3 components."

Diffusion Model:  [Q8_0 (~4.3 GB)       v]
Text Encoder:     [Q4_0 (~2.5 GB)       v]
VAE:              flux2-vae.safetensors (0.34 GB)  ← fixed, no dropdown

Estimated Total:  ~7.1 GB
[Download Flux 2 Klein]

── When "Custom" ──
(existing form fields unchanged)
```

4. State additions for preset mode:

```typescript
const [downloadMode, setDownloadMode] = useState<'preset' | 'custom'>('preset');
const [selectedPreset, setSelectedPreset] = useState<string>(MODEL_PRESETS[0]?.id ?? '');
const [variantSelections, setVariantSelections] = useState<Record<string, number>>({});
// variantSelections maps: 'primary' -> variant index, 'llm' -> variant index, etc.
```

5. When "Download" is clicked in preset mode, build the full `DownloadConfig`:

```typescript
const preset = MODEL_PRESETS.find(p => p.id === selectedPreset);
const primaryVariant = preset.primary.variants[variantSelections['primary'] ?? 0];

const config: DownloadConfig = {
  source: preset.primary.source,
  repo: preset.primary.repo,
  file: primaryVariant.file,
  name: preset.name,
  type: 'diffusion',
  components: preset.components.map(comp => {
    if (comp.variants) {
      const variant = comp.variants[variantSelections[comp.role] ?? 0];
      return {
        role: comp.role as DiffusionComponentRole,
        source: comp.source,
        repo: comp.repo,
        file: variant.file,
      };
    }
    return {
      role: comp.role as DiffusionComponentRole,
      source: comp.source,
      url: comp.fixedUrl,
    };
  }),
};
```

6. Progress display during download — show component info alongside progress bar:

```
Downloading Flux 2 Klein...
Component 2/3: Qwen3-4B-Q4_0.gguf
[████████████░░░░░░░░░] 65% — 4.6 GB / 7.1 GB
```

**Props change**: `ModelDownloadFormProps` needs `componentProgress?: ComponentProgress` alongside existing `progress`.

---

### Phase 4: IPC Progress Plumbing

**Goal**: Forward per-component progress events from library → main → renderer.

**Files**:
- `examples/electron-control-panel/main/ipc-handlers.ts` — pass `onComponentStart` callback
- `examples/electron-control-panel/main/genai-api.ts` — add `sendComponentStart` helper
- `examples/electron-control-panel/main/preload.ts` — add event channel
- `examples/electron-control-panel/renderer/components/hooks/useModels.ts` — listen for event

**Work**:

1. Add to `genai-api.ts`:

```typescript
export function sendComponentStart(role: string, filename: string, index: number, total: number, modelName: string) {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:component-start', { role, filename, index, total, modelName });
  }
}
```

2. Update `models:download` handler in `ipc-handlers.ts`:

```typescript
await modelManager.downloadModel({
  ...config,
  onProgress: (downloaded, total) => sendDownloadProgress(downloaded, total, modelName),
  onComponentStart: (info) => sendComponentStart(info.role, info.filename, info.index, info.total, modelName),
});
```

3. Add `'download:component-start'` to the preload event whitelist.

4. In `useModels.ts`, listen for `download:component-start` and store it in state:

```typescript
const [componentProgress, setComponentProgress] = useState<ComponentProgress | null>(null);
// ...
window.api.on('download:component-start', (data) => setComponentProgress(data));
// Reset on complete/error
```

5. Pass `componentProgress` through to `ModelDownloadForm`.

---

### Phase 5: Model List Enhancement

**Goal**: Show multi-component indicator in model list.

**Files**:
- `examples/electron-control-panel/renderer/components/ModelList.tsx`
- `examples/electron-control-panel/renderer/components/hooks/useModels.ts` — ensure `components` is available

**Work**:

1. The `useModels` hook has a local `ModelInfo` interface that omits `components`. Either:
   - (a) Import `ModelInfo` from `genai-electron` (already imported in `types/api.ts`), or
   - (b) Add `components?: Record<string, { path: string; size: number; checksum?: string }>` to the local interface

   Option (a) is cleaner — use the library type directly.

2. In `ModelList.tsx`, next to the type badge, show component count (use existing `model-type-*` naming convention):

```tsx
<span className="model-type-badge model-type-diffusion">Diffusion</span>
{model.components && (
  <span className="model-type-badge model-type-components" title={Object.keys(model.components).join(', ')}>
    {Object.keys(model.components).length} components
  </span>
)}
```

3. Add CSS for the new badge in `ModelList.css`:

```css
.model-type-components {
  background: rgba(46, 204, 113, 0.15);
  color: #2ecc71;
}
```

---

### Phase 6: Preset Generation Settings Hint

**Goal**: When a model matching a preset is selected in DiffusionServerControl, show recommended settings from that preset.

**Depends on**: Phase 2 (preset data with `recommendedSettings`), Phase 5 (model list must include `components` data from library `ModelInfo` type).

**Files**:
- `examples/electron-control-panel/renderer/components/DiffusionServerControl.tsx`
- `examples/electron-control-panel/renderer/components/DiffusionServerControl.css` — add `settings-hint` style

**Work**:

1. Add model info lookup and preset matching:

```typescript
const selectedModelInfo = models.find(m => m.id === selectedModel);
const matchedPreset = MODEL_PRESETS.find(p => selectedModel?.startsWith(p.id));
```

2. Show a hint banner when a preset with `recommendedSettings` is matched:

```tsx
{matchedPreset?.recommendedSettings && (
  <div className="settings-hint">
    {matchedPreset.name} recommended: Steps {matchedPreset.recommendedSettings.steps},
    CFG Scale {matchedPreset.recommendedSettings.cfgScale},
    {matchedPreset.recommendedSettings.sampler} sampler,
    {matchedPreset.recommendedSettings.width}×{matchedPreset.recommendedSettings.height}
    <button onClick={() => applyPresetSettings(matchedPreset.recommendedSettings)}>Apply</button>
  </div>
)}
```

3. Generic `applyPresetSettings` function (works for any preset, not hardcoded to Flux 2):

```typescript
function applyPresetSettings(settings: ModelPreset['recommendedSettings']) {
  if (!settings) return;
  setSteps(settings.steps);
  setCfgScale(settings.cfgScale);
  setSampler(settings.sampler);
  if (settings.width) setWidth(settings.width);
  if (settings.height) setHeight(settings.height);
}
```

5. Add CSS for the hint banner in `DiffusionServerControl.css`:

```css
.settings-hint {
  background: rgba(33, 150, 243, 0.1);
  border: 1px solid rgba(33, 150, 243, 0.3);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
```

---

## File Change Summary

| File | Change Type | Size |
|------|------------|------|
| **Phase 0: Type Consolidation** | | |
| `renderer/types/api.ts` | Add `DiffusionComponentRole`, `DiffusionComponentDownload` re-exports | Tiny |
| `renderer/components/ModelDownloadForm.tsx` | Remove local `DownloadConfig` + `DownloadProgress`, import from types | Small |
| `renderer/components/hooks/useModels.ts` | Remove local `ModelInfo` + `DownloadConfig` + `DownloadProgress`, import from types | Small |
| **Phase 1: Library Extension** | | |
| `src/types/models.ts` | Add `onComponentStart` to DownloadConfig | Small |
| `src/managers/ModelManager.ts` | Call `onComponentStart` in download loop | Small |
| **Phase 2: Preset Data** | | |
| `renderer/data/model-presets.ts` | NEW: Preset type definitions + Flux 2 Klein data | Medium |
| **Phase 3: Download Form UI** | | |
| `renderer/types/ui.ts` | Add `ComponentProgress`, extend `DownloadProgress` | Small |
| `renderer/components/ModelDownloadForm.tsx` | Preset mode UI + variant selectors | Large |
| **Phase 4: IPC Plumbing** | | |
| `main/ipc-handlers.ts` | Forward `onComponentStart` | Small |
| `main/genai-api.ts` | Add `sendComponentStart` helper | Small |
| `main/preload.ts` | Add `download:component-start` to event whitelist | Tiny |
| `renderer/components/hooks/useModels.ts` | Listen for component-start, pass through | Small |
| **Phase 5: Model List** | | |
| `renderer/components/ModelList.tsx` | Multi-component badge | Small |
| `renderer/components/ModelList.css` | Badge style for `.model-type-components` | Tiny |
| **Phase 6: Settings Hint** | | |
| `renderer/components/DiffusionServerControl.tsx` | Flux 2 settings hint + model lookup | Small |
| `renderer/components/DiffusionServerControl.css` | `.settings-hint` style | Tiny |

## Verification

- [ ] `npm run build` passes (library + example app if buildable)
- [ ] `npm test` — all 403 tests pass (no library test changes expected)
- [ ] Manual test: Select Flux 2 Klein preset, choose quants, verify DownloadConfig shape
- [ ] Manual test: Download progress shows "Component 2/3: filename"
- [ ] Manual test: Model list shows "3 components" badge for multi-component models
- [ ] Manual test: DiffusionServerControl shows Flux 2 settings hint
- [ ] Custom download mode still works as before (backwards compat)

## Notes

- Two presets shipped: Flux 2 Klein (multi-component, 3 files) and SDXL Lightning 4-step (monolithic, single file). More presets (SDXL split, Flux 2 Dev) can be added to the `MODEL_PRESETS` array later.
- The library's `onComponentStart` callback is the only public API change. It's optional and backwards compatible.
- The example app is a reference implementation — keep it simple, no over-engineering.
- `renderer/data/` is a new directory (doesn't exist yet).
- Verify Flux 2 Klein HuggingFace filenames against actual repos at implementation time (repos may rename files).
- The preload event whitelist (`validChannels` in `preload.ts`) is critical — if `'download:component-start'` is missed, component progress silently fails.

---
**Please review. Edit directly if needed, then confirm to proceed.**
