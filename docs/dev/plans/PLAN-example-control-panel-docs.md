# Plan: Update example-control-panel.md with Multi-Component & Preset Patterns

Created: 2026-02-17
Status: COMPLETE

## Summary

Update `genai-electron-docs/example-control-panel.md` to document the 12 new patterns added to the example app for multi-component diffusion model support, the preset download system, and per-component progress tracking. Also fix stale/incorrect code snippets identified by audit, and fix a latent bug in the app's `crashed` event handler.

## Scope

**In scope**:
- Add new pattern sections to `example-control-panel.md` covering presets, multi-component downloads, and settings hints
- Fix the stale preload `validChannels` code snippet (was 9 channels, now 13)
- Update the existing "Model Download Progress Streaming" pattern with a cross-reference to new per-component pattern
- Update the Features summary at the top to mention multi-component and preset support
- Update the `## Contents` ToC to include the new section
- Update the Architecture "Structure" description to mention `renderer/data/`

**Also in scope** (from audit):
- Fix `off()` API snippet showing incorrect 2-arg call (actual API is single-arg, removes ALL listeners)
- Fix `crashed` event payload type in both app code and doc (library emits `{ code, signal }`, not `Error`)
- Fix stale preset values in "Preset UI with Custom Fallback" pattern (steps and cfgScale options)

**Out of scope**:
- Changes to other doc files (migration guide, typescript-reference, etc.)
- Full rewrite of existing patterns — only additive updates

## Execution Tracker

- [x] Phase 1: Update Features Summary & Structure
- [x] Phase 2: Add New Pattern Sections
- [x] Phase 3: Fix Stale/Incorrect Code Snippets (incl. audit items)
- [x] Phase 3b: Fix App Bug — `crashed` Event Payload
- [x] Phase 4: Verification

---

## Phases

### Phase 1: Update Features Summary

**Goal**: Reflect multi-component and preset support in the doc's Features section.

**File**: `genai-electron-docs/example-control-panel.md` (lines 32-43)

**Work**:

1. Update the **Model Management** feature line to mention preset downloads and multi-component models:
   - Current: `Download (HuggingFace/URL), list/delete models, **GGUF Metadata Viewer** with auto-fetch and smart truncation for 50k+ item arrays`
   - New: add "**Preset Downloads** (Flux 2 Klein, SDXL Lightning) with per-component progress, multi-component badge in model list"

2. Update the **Diffusion Server** feature line to mention settings hints:
   - Add: "preset-matched recommended settings with one-click apply"

3. Add the new section to the `## Contents` ToC (lines 5-13):
   - Add: `- [Multi-Component & Preset Patterns](#multi-component--preset-patterns)` between Key Patterns and Advanced Patterns

4. Update the **Architecture** "Structure" description (line 50) to mention `renderer/data/`:
   - Current: `main/` (Node.js: ...) + `renderer/` (Browser: React components, custom hooks, types)
   - New: add `data` to the renderer list: `(Browser: React components, custom hooks, types, data)`

---

### Phase 2: Add New Pattern Sections

**Goal**: Document the new patterns in the same style as existing ones (Challenge → Solution → code → Key insight).

**File**: `genai-electron-docs/example-control-panel.md`

**Placement**: Add a new `## Multi-Component & Preset Patterns` section after the existing `## Key Patterns` section (before `## Advanced Patterns`). This groups all multi-component patterns together and keeps the existing patterns undisturbed.

**New patterns to add** (6 pattern blocks, consolidating the 12 items into logical groups):

#### Pattern: Preset Data Separation

- **Challenge**: Support one-click downloads for multi-component models without hardcoding UI logic.
- **Solution**: Preset definitions in `renderer/data/model-presets.ts`, separate from components.
- **Code**: Show `ModelPreset` type shape and the Flux 2 Klein preset entry (abbreviated).
- **Key insight**: Adding a new preset requires only a data entry — no UI code changes.

**Source**: `examples/electron-control-panel/renderer/data/model-presets.ts`

#### Pattern: Preset-to-DownloadConfig Translation

- **Challenge**: Convert user-selected preset + variant choices into a library `DownloadConfig`.
- **Solution**: `handlePresetDownload()` in `ModelDownloadForm.tsx` (lines 64-104).
- **Code**: Show the translation function — variant tag extraction, `modelDirectory` for shared storage, component mapping.
- **Key insight**: `modelDirectory: preset.id` enables shared storage; variant tag in name gives distinct model entries.

**Source**: `examples/electron-control-panel/renderer/components/ModelDownloadForm.tsx:64-104`

#### Pattern: Per-Component Download Progress (IPC Flow)

- **Challenge**: Show which component is downloading during multi-file downloads.
- **Solution**: Full IPC flow: library `onComponentStart` → main `sendComponentStart` → preload → renderer `setComponentProgress` → UI.
- **Code**: Show the IPC handler's `onComponentStart` callback (ipc-handlers.ts:92-99), the `sendComponentStart` helper (genai-api.ts:137-154), and the renderer display (ModelDownloadForm.tsx:244-249).
- **Key insight**: `componentProgress` state lives in the parent `ModelManager.tsx` to avoid the preload `removeAllListeners` collision — same reason download progress is centralized there.

**Source**: Multiple files (ipc-handlers.ts, genai-api.ts, ModelManager.tsx, ModelDownloadForm.tsx)

#### Pattern: Centralized Download State Management

- **Challenge**: Multiple hooks registering for the same IPC channel causes silent listener destruction (preload calls `removeAllListeners`).
- **Solution**: All download IPC listeners live in `ModelManager.tsx` (parent component), not in individual hooks.
- **Code**: Show the `useEffect` in ModelManager.tsx (lines 25-42) that registers both `download:progress` and `download:component-start` in one place.
- **Key insight**: This is a general Electron IPC pattern — when the preload uses `removeAllListeners`, only one component can register per channel.

**Source**: `examples/electron-control-panel/renderer/components/ModelManager.tsx:16-42`

#### Pattern: Multi-Component Badge in Model List

- **Challenge**: Visually distinguish multi-component models from single-file models in the list.
- **Solution**: Conditional badge next to the type badge when `model.components` is present.
- **Code**: Show the badge rendering from ModelList.tsx (lines 86-93).
- **Key insight**: `Object.keys(model.components).length` gives the component count; tooltip shows role names.

**Source**: `examples/electron-control-panel/renderer/components/ModelList.tsx:86-93`

#### Pattern: Preset-Matched Settings Hint

- **Challenge**: When a model from a preset is selected, suggest optimal generation parameters.
- **Solution**: Match selected model ID against `MODEL_PRESETS`, show hint banner with "Apply" button.
- **Code**: Show preset matching (line 193), `applyPresetSettings` (lines 195-209), and the hint banner JSX (lines 306-324).
- **Key insight**: `applyPresetSettings` updates both actual values AND preset selector states (bidirectional sync), including integer-to-float formatting for CFG scale dropdowns.

**Source**: `examples/electron-control-panel/renderer/components/DiffusionServerControl.tsx:193-324`

---

### Phase 3: Fix Stale Code Snippets and Cross-References

**Goal**: Update stale snippets and add cross-references between related patterns.

**File**: `genai-electron-docs/example-control-panel.md`

**Work**:

1. Update the `validChannels` array in the "Type-Safe IPC Bridge with Security" pattern (lines 285-289) to show all 13 current channels:

```typescript
const validChannels = [
  'download:progress', 'download:complete', 'download:error',
  'download:component-start',
  'server:started', 'server:stopped', 'server:crashed', 'server:binary-log',
  'diffusion:started', 'diffusion:stopped', 'diffusion:crashed',
  'diffusion:binary-log', 'diffusion:progress',
];
```

New channels (4): `download:component-start`, `server:binary-log`, `diffusion:crashed`, `diffusion:binary-log`.

2. Add a cross-reference note to the existing "Pattern: Model Download Progress Streaming" (lines 152-186):
   - After the "Key insight" line, add: `**Multi-component models**: For per-component progress tracking (which component is currently downloading), see [Per-Component Download Progress](#pattern-per-component-download-progress-ipc-flow) below.`
   - This addresses the fact that the snippet shows only `onProgress` but the actual handler also includes `onComponentStart`.

3. **[Audit #42] Fix `off()` API** — doc line 102 shows `window.api.off('server:started', handleServerEvent)` with two args. The actual `off()` only takes a single arg (`channel: string`) and removes ALL listeners on that channel.
   - Fix: change to `window.api.off('server:started');`
   - Add a note: `**Warning**: `off(channel)` removes ALL listeners on that channel, not just specific callbacks.`

4. **[Audit #43] Fix `crashed` event payload** — doc line 134 shows `llamaServer.on('crashed', (error: Error) => {...})`. The library's `ServerManager` emits `{ code, signal }`, not an `Error` object.
   - Fix the doc snippet to show the correct payload type (see Phase 3b for the app code fix)

5. **[Audit #45] Fix stale preset values** — doc line 481 says `steps (20/30/50), cfgScale (5.0/7.5/10.0)`.
   - Actual steps options: `1/2/4/8/20/30`
   - Actual cfgScale options: `1.0/2.0/7.5/10.0/15.0`
   - Fix: update the inline list to match

---

### Phase 3b: Fix App Bug — `crashed` Event Payload

**Goal**: Fix a latent bug in the example app where `crashed` event is typed as `Error` but the library emits `{ code, signal }`.

**Files**:
- `examples/electron-control-panel/main/genai-api.ts` (lines 43-51 and 75-83)

**Work**:

1. Change the `crashed` handler parameter type from `(error: Error)` to `(data: { code: number | null; signal: string | null })`.

2. Update the `webContents.send` payload to forward `code` and `signal` instead of `error.message` and `error.stack`:

```typescript
llamaServer.on('crashed', (data: { code: number | null; signal: string | null }) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('server:crashed', {
      message: `Server crashed with exit code ${data.code}`,
      code: data.code,
      signal: data.signal,
    });
  }
});
```

3. Apply the same fix to the `diffusionServer.on('crashed', ...)` handler (lines 75-83).

**Note**: The renderer already handles `server:crashed` as `{ message: string }` so keeping a `message` field in the payload maintains backwards compatibility.

---

### Phase 4: Verification

- [x] All code snippets match the actual source files (verified line numbers)
- [x] No contradictions with existing patterns in the doc
- [x] No contradictions with `migration-0-4-to-0-5.md`
- [x] Consistent style: Challenge → Solution → Code → Key insight
- [x] All file paths in pattern descriptions are correct

---

## Notes

- The existing "Pattern: Model Download Progress Streaming" (lines 152-186) gets a cross-reference note to the new per-component pattern. The `onProgress` snippet stays as-is since it's still the correct pattern for single-file downloads.
- The existing "Pattern: Preset UI with Custom Fallback" (lines 452-483) documents the parameter presets (dimensions, steps, cfg). The new settings hint pattern is different — it's about model-level preset matching, not parameter presets. Both stay.
- Estimated addition: ~200-250 lines (6 pattern blocks × ~35-40 lines each).

---
**Please review. Edit directly if needed, then confirm to proceed.**
