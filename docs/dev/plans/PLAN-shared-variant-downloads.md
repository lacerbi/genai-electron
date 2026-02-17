# Plan: Shared-Directory Multi-Variant Downloads

Created: 2026-02-17
Status: COMPLETE

## Context

Downloading a second variant of Flux 2 Klein (e.g., Q4_0 after Q8_0) crashes because shared
component files (Qwen3-4B LLM, VAE) already exist in the same directory. The download throws
`"Component file already exists"`. Additionally, both variants produce the same model ID
(`flux-2-klein`) so they can't coexist as separate entries.

User chose **shared directory** approach: variants share a directory and reuse identical component
files (~2.8 GB saved per extra variant), with safe deletion that checks for shared references.

## Scope

- **In scope**: Library changes for skip-if-exists, shared directory support, safe deletion;
  example app changes for variant-specific naming
- **Out of scope**: Variant switching UI within a single model entry, automatic variant detection

## Execution Tracker

- [x] Phase 1: Library — DownloadConfig API Extension
- [x] Phase 2: Library — Skip Existing Component Files
- [x] Phase 3: Library — Use `modelDirectory` in Download
- [x] Phase 4: Library — Safe Deletion of Shared Components
- [x] Phase 5: Example App — Variant-Specific Download Names
- [x] Phase 6: Tests
- [x] Final: Build + Lint + Format + All tests pass (415/415)
- [x] Doublecheck: Fix C1 (rmdir instead of rm), C2 (sanitize modelDirectory), C3 (idempotency guard)
- [x] Doublecheck: Add tests for modelDirectory, error cleanup with shared files, all-exist scenario, idempotency guard

## Phases

### Phase 1: Library — DownloadConfig API Extension

**Goal**: Allow callers to specify a shared model directory independent of model ID.

**Files**: `src/types/models.ts`

**Work**:
- Add optional `modelDirectory?: string` to `DownloadConfig`
  - When provided, used as the subdirectory name instead of the model ID
  - Allows multiple model IDs to share the same directory on disk

### Phase 2: Library — Skip Existing Component Files

**Goal**: Reuse identical component files instead of throwing.

**Files**: `src/managers/ModelManager.ts` (lines 374–381)

**Work**:
- Replace the `throw new DownloadError("Component file already exists")` with skip logic:
  ```
  if (exists) {
    // Reuse existing file — do NOT add to downloadedPaths (no cleanup on error)
    // Update progress as if downloaded (count existing file size)
    completedBytes += await getFileSize(item.destination);
    continue;
  }
  ```
- Still fire `onComponentStart` before the skip (so UI shows "Component 2/3: Qwen3-4B — already exists")
- Track downloaded-in-this-attempt paths separately from pre-existing paths for error cleanup
- **Fix error cleanup**: change `rm(modelDir, { recursive: true })` to `rm(modelDir, { recursive: false })`
  so a failed variant B download doesn't destroy variant A's files (only removes dir if empty)
- **Skip HEAD requests for existing files**: don't issue HEAD for files that already exist on disk;
  use `getFileSize()` to get their size for progress reporting instead
- **Idempotency guard**: at the start of `downloadMultiComponentModel`, check if the model ID already
  has metadata in storage — if so, throw `"Model already exists"` to prevent silent overwrites

### Phase 3: Library — Use `modelDirectory` in Download

**Goal**: Decouple directory name from model ID.

**Files**: `src/managers/ModelManager.ts` (line 279–280)

**Work**:
- Change directory resolution:
  ```typescript
  const modelId = this.generateModelId(config.name);
  const dirName = config.modelDirectory || modelId;
  const modelDir = getModelDirectory(config.type, dirName);
  ```
- The `modelInfo.id` remains variant-specific (e.g., `flux-2-klein-q80`)
- The `modelInfo.path` and component paths point into the shared directory

### Phase 4: Library — Safe Deletion of Shared Components

**Goal**: Deleting one variant must not break another that shares component files.

**Files**: `src/managers/StorageManager.ts` (`deleteModelFiles`, line 193)

**Current code** (broken for shared dirs): blindly deletes ALL component files listed in
the model's metadata, then tries `rm(modelDir, { recursive: false })`.

**New logic**:
1. Load metadata for the model being deleted
2. Load ALL other model metadata of the same type via `listModelFiles(type)`
3. Build a `Set<string>` of every component path referenced by those OTHER models
4. For each component in the model being deleted:
   - If the path is in the shared set → **skip** (another variant still needs it)
   - If the path is NOT in the shared set → **delete** the file
5. Also delete the primary model file (`metadata.path`) only if not in the shared set
6. Try `rm(modelDir, { recursive: false })` — only removes directory if now empty
7. Delete the metadata JSON file

This means: deleting "Flux 2 Klein Q8_0" removes `flux-2-klein-4b-Q8_0.gguf` (unique to
that variant) but leaves `Qwen3-4B-Q4_0.gguf` and `flux2-vae.safetensors` (shared with Q4_0).
Deleting the last variant removes everything and the directory.

### Phase 5: Example App — Variant-Specific Download Names

**Goal**: Each variant produces a distinct model entry in the UI.

**Files**: `examples/electron-control-panel/renderer/components/ModelDownloadForm.tsx`
(`handlePresetDownload`, around line 64), `examples/electron-control-panel/renderer/data/model-presets.ts`

**Work**:
- In `handlePresetDownload`, include the primary variant label in `config.name`:
  ```typescript
  // Extract short quant label like "Q8_0" from "Q8_0 (~4.3 GB)"
  const variantTag = primaryVariant.label.split(' ')[0];
  name: `${selectedPreset.name} ${variantTag}`,
  ```
- Pass `modelDirectory` from the preset's base ID:
  ```typescript
  modelDirectory: selectedPreset.id,  // "flux-2-klein"
  ```
- Results: model ID `flux-2-klein-q80`, directory `flux-2-klein/`, metadata `flux-2-klein-q80.json`

### Phase 6: Tests

**Goal**: Verify skip-if-exists and safe deletion work correctly.

**Files**: `tests/integration/multi-component-download.test.ts`, `tests/unit/StorageManager.test.ts`

**Work**:
- Add integration test: download variant A, then variant B with shared components → both succeed
- Add unit test: delete variant A when variant B shares components → shared files preserved
- Ensure existing 405 tests still pass

## Verification

- [x] `npm run build` — 0 errors
- [x] `npm run lint` — 0 errors (90 warnings, all pre-existing)
- [x] `npm run format` — clean
- [x] `npm test` — 415/415 pass (18 suites)
- [ ] Manual test in example app: download Q8_0, then Q4_0 → both appear in model list
- [ ] Manual test: delete Q8_0 → Q4_0 still works, shared files preserved
- [ ] Manual test: delete Q4_0 → directory cleaned up (no orphans)

---

## Post-Implementation Review Findings (2026-02-17)

Doublecheck verification identified these items. Critical items were fixed immediately.

### CRITICAL (fixed)

- [x] **C1: `rm(dir, {recursive: false})` never removes directories** — `rm` throws `ERR_FS_EISDIR`
  on directories even when empty. Replaced with `rmdir()` in both `ModelManager.ts` (error cleanup)
  and `StorageManager.ts` (delete last variant). `rmdir` succeeds on empty dirs, throws `ENOTEMPTY`
  on non-empty — exactly the desired behavior.

- [x] **C2: `modelDirectory` not sanitized — path traversal possible** — A caller passing
  `modelDirectory: '../../..'` would resolve to an arbitrary filesystem path. Fixed by applying
  `generateModelId()` to `modelDirectory`, which strips path separators and special characters.

- [x] **C3: Missing idempotency guard** — Plan Phase 2 specified checking if model ID already has
  metadata before downloading, but this was not implemented. Added guard at start of
  `downloadMultiComponentModel()`: calls `storageManager.loadModelMetadata()`, throws
  `DownloadError("Model already exists")` if found.

### CRITICAL (test gaps, fixed)

- [x] **No test for error cleanup with pre-existing shared files** — Added test: variant A files
  exist, variant B downloads primary then fails on checksum → only primary (downloaded in THIS
  attempt) is cleaned up, shared encoder/vae are preserved.

- [x] **No test for `modelDirectory` producing different directory** — Added test asserting
  `getModelDirectory` is called with `modelDirectory` value, not the generated model ID.

- [x] **No test for `modelDirectory` sanitization** — Added test: `../../etc/evil` is sanitized
  to strip path separators before use as directory name.

- [x] **No test for "all components already exist"** — Added test: all 3 files exist on disk →
  0 downloads made, model returned with correct aggregate size and components map.

- [x] **No test for idempotency guard** — Added test: `loadModelMetadata` succeeds (model exists)
  → `DownloadError` thrown with "already exists" message.

### WARNING (resolved)

- [x] **W4: `getStorageUsed()` double-counts shared components** — Fixed: deduplicate by file
  path using `Map<path, size>` before summing. Test added for two variants sharing LLM + VAE.

- [x] **W5: Skip-if-exists doesn't verify checksums of existing files** — Fixed: verify checksum
  of pre-existing files when `checksum` is provided; delete and re-download on mismatch.
  Tests added for both match (skip) and mismatch (re-download) cases.

### NOTES (no action needed)

- `onComponentStart` callback fires for skipped components — correct, verified by integration test
- Progress reporting handles skipped components correctly — HEAD skipped, local size used instead
- Safe deletion handles corrupted other-model metadata gracefully (try-catch, skip)
- Primary path protected redundantly via `sharedPaths.add(otherMeta.path)` — defense-in-depth
- Race condition between concurrent downloads to same directory — mitigated by singleton +
  Downloader's `isDownloading` guard; file-based locking deferred to future if needed
- Documentation updated: `typescript-reference.md` (`modelDirectory`, `onComponentStart`),
  `CLAUDE.md` (ephemeral content removed), `model-management.md` (shared variant usage example)

---

**Status: ✅ ALL ITEMS RESOLVED (2026-02-17) — 418/418 tests passing, 18 suites.**
