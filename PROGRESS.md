# genai-electron Implementation Progress

> **Current Status**: v0.16.0 release candidate — preferred context sizing and revisioned llama
> readiness (2026-07-29)

---

## Current Build Status

- **Build:** ✅ 0 TypeScript errors
- **Tests:** ✅ 716/716 passing (28 suites)
- **Branch:** `release/v0.16.0`
- **Last Updated:** 2026-07-30 (unreleased SWA prompt-cache control)

---

## Unreleased

- Added opt-in `LlamaServerConfig.swaFull`; `true` emits llama.cpp's `--swa-full` to preserve
  prompt-cache reuse on sliding-window-attention models, while false/unset preserve existing argv.
- Specialized `LlamaServerManager.start()` to accept `LlamaServerConfig`, making llama-specific
  fields type-safe in direct object literals as already documented.
- Documented that metadata-backed auto-sizing conservatively prices SWA layers as full-context and
  added regression coverage for heterogeneous Gemma-style cache dimensions. Automatic enablement,
  checkpoint controls, and raw argument passthrough remain out of scope.

---

## v0.16.0: Preferred Context and Revisioned Llama Readiness (2026-07-29)

- Added `preferredContextSize` as an effective per-slot soft sizing target. It caps recommended KV
  allocation with the same granularity and multi-slot accounting as `maximumContextSize`, while
  allowing the running server to expose additional harmless capacity.
- Preserved hard `minimumContextSize` and `maximumContextSize` runtime enforcement. Validation now
  accepts minimum + preferred without a maximum, enforces minimum ≤ preferred ≤ maximum for fields
  present, and reports typed preferred-value/order/overflow diagnostics.
- Retained preferred policy through direct-spread recommendations, restart, auto-restart, and
  ResourceOrchestrator reload; updated public API documentation and regression coverage.
- Added a canonical llama-server `ready` event with a strict verified-capacity snapshot and a
  process-lifetime `serverGeneration`. Only successfully committed processes consume generations;
  `getInfo()` supports late reconciliation without conflating failed or stale startup attempts.
- Exposed effective parallel slots from `/props.total_slots` when available, otherwise the resolved
  configured count (default `1`). Initial start, explicit/automatic restart, and orchestrator
  restoration share the same readiness path with documented event ordering.

**Release validation:** `prepublishOnly` passes with a clean build and 714/714 tests across 28
suites; the open-handle verification run also passes. ESLint passes with 0 errors and the existing
61 warnings, repository formatting and `git diff --check` pass, and 284 focused tests pass across
the 5 affected suites. The v0.16.0 package dry-run contains 171 files, and the production
dependency audit reports 0 vulnerabilities.

**Release status:** Release candidate on `release/v0.16.0`. Version metadata and the v0.15.x-to-v0.16.0
migration guide are included in the release PR; merge, tag, GitHub release, and maintainer-side
`npm publish` remain pending.

---

## v0.15.0: Context Capacity Contract (2026-07-29)

- Added effective per-slot `minimumContextSize` / `maximumContextSize` constraints while retaining
  exact total `contextSize` behavior. Constraint-aware sizing preserves the normal recommendation
  when possible and otherwise searches full, MoE, partial, and CPU placement with raw VRAM/RAM
  feasibility, multi-slot KV accounting, native-model limits, and typed diagnostics.
- Added package-root `ContextConstraintError` and typed reason/stage/details exports. Valid but
  unsatisfiable minima continue to use `InsufficientResourcesError` with context diagnostics.
- `LlamaServerManager.start()` now requires post-health `GET /props` capacity discovery before
  entering `running`. `ServerInfo` separates configured total context from verified effective
  per-slot context; ranged starts reject runtime violations and preserve the contract across
  restart, crash auto-restart, and ResourceOrchestrator reload.
- Updated public sizing, server, TypeScript, integration, and troubleshooting documentation,
  including the v0.14.x-to-v0.15.0 migration guide.

**Release validation:** `prepublishOnly` passes (clean build and 701/701 tests across 28 suites);
the open-handle verification run also passes. Lint passes with 0 errors and the existing 61
warnings, repository formatting and `git diff --check` pass, and the generated declarations/public
exports are present. The 0.15.0 package dry-run contains 171 files, and the production dependency
audit reports 0 vulnerabilities. A live smoke against the healthy GUI-provisioned Gemma 4 12B
server confirmed the 6,144-context/one-slot `/props` result satisfies a 4,096–8,192 range, while a
deliberate two-slot expectation returns typed `runtime-slots-mismatch` diagnostics.

**Release status:** Published as v0.15.0.

---

## v0.14.0: Binary Provisioning Robustness (2026-07-27)

- Moved ZIP parsing/inflation for both binary and dependency archives into an
  inline worker thread. `'binary-progress'` now reports ZIP entry counters and
  extraction percentages while Electron's main event loop remains responsive.
- Added atomic `.deps.json` manifests keyed by dependency checksum. Matching
  installed dependencies are materialized into clean staging without another
  download or inflation, including when only the upstream release URL changed.
- Hardened interrupted provisioning: stale variant staging is removed first,
  and complete main/dependency archives are reused only after SHA-256
  verification. HTTP range resume for `.partial` files remains deferred.
- Phase-2 diffusion validation now uses the same resolved CPU-offload and
  diffusion-flash-attention flags as production generation. GPU diagnostics are
  line-anchored to retain real backend errors without rejecting prose mentions.
- Initialized llama and diffusion log managers before provisioning, preserving
  the complete BinaryManager log on both successful starts and failures.
- Guarded concurrent starts from sharing provisioning paths and reject any
  main-archive path that collides with a dependency-owned file before candidate
  installation or manifest commit.
- Folded in the final lifecycle follow-ups: validated installed binaries clean
  leftover main archives/staging before returning while preserving any
  unmanifested dependency archive as a recovery copy, and a
  real-filesystem cross-instance regression now exercises ZIP extraction,
  atomic manifest persistence, URL-independent checksum reuse, and dependency
  staging beside the candidate on the incident platform.

**Release validation:** `prepublishOnly` passes (clean build plus 634/634 tests
across 26 suites); mandatory implementation double-check found no acceptance
blockers and its two medium-risk findings were fixed with regressions; 215/215
original focused tests, 58/58 follow-up focused tests, and the full suite pass
with open-handle detection; repository formatting passes; lint passes with 0
errors (61 existing warnings); generated runtime/declarations and the 163-file
`genai-electron@0.14.0` npm package dry run were inspected; `git diff --check`
passes.
The final follow-up double-check identified the install-before-manifest recovery
window; the corrected manifest-aware cleanup policy and its regressions passed
re-review with no remaining blocker.

**Release status:** Release candidate on `release/v0.14.0`. Version metadata and migration guide
are included in the release PR; merge, tag, GitHub release, and maintainer-side `npm publish`
remain pending.

---

## v0.13.0: Reproducible Downloads, Artifact License Provenance, and sd.cpp Refresh (2026-07-26)

**Release validation:** `prepublishOnly` passed (clean build plus 604/604 tests across 25 suites);
lint passed with 0 errors (61 existing warnings); repository-wide formatting passed; the production
dependency audit reported 0 vulnerabilities; the electron-control-panel production build passed;
generated declarations/runtime output and package metadata were inspected; `git diff --check`
passed; and the npm package dry run contained the expected 163 files as
`genai-electron@0.13.0`.

### Artifact license provenance passthrough (2026-07-26)

- Added package-root `ArtifactProvenance` and optional `provenance` fields on `DownloadConfig`,
  `DiffusionComponentDownload`, `ModelInfo`, and `DiffusionComponentInfo`.
- Persisted caller-supplied license-declaration context for single-file, sharded, and
  multi-component downloads. Multi-component primary metadata uses independent top-level and
  `diffusion_model` copies; additional components receive only their own declarations.
- Preserved configuration-record semantics for shared physical files: every model variant records
  the declaration supplied for that configuration even when an existing component is reused
  without another GET.
- Kept the package policy-free. It does not validate, normalize, interpret, compare, fetch, or
  branch on declaration contents, and omission remains compatible with legacy metadata.
- Added manager, storage JSON round-trip, and real local HTTP integration coverage for opaque field
  preservation, omission, copy isolation, non-inheritance, sharded storage, metadata refresh, and
  independently declared shared-file variants.

**Validation:** 124/124 focused tests across the three affected unit/integration suites; clean
library build; lint with 0 errors (61 existing warnings); touched-file formatting; 604/604 full
tests across 25 suites; electron-control-panel production build; generated declaration/runtime
inspection; `git diff --check`; and the 163-file package dry run.

**Release status:** Included in the v0.13.0 release preparation.

---

### stable-diffusion.cpp `master-782-b290693` refresh (2026-07-26)

- **Binary pin `master-746-2574f59` → `master-782-b290693`** (36 upstream commits;
  release published 2026-07-16). Updated the Metal, Windows CUDA/Vulkan/CPU, and Linux
  Vulkan/CPU asset URLs and SHA-256 checksums from the official GitHub release API. The Windows
  CUDA runtime dependency is byte-identical; its URL moves to the new tag while its digest remains
  `fe203668…f38d`.
- Preserved the existing variant priority/fallback policy. Upstream now publishes ROCm variants,
  but genai-electron still lacks the AMD/ROCm capability detection needed to select them safely, so
  they are not added by this pin-only refresh.
- Audited the upstream source delta: every component, generation, optimization, and short-form flag
  genai-electron emits remains accepted. The Flux 2 component/VAE command shape is unchanged, as
  are the progress-parser's sampling and decoding literals. At the exact new commit,
  `docs/flux2.md` still lists `black-forest-labs/FLUX.2-small-decoder` /
  `full_encoder_small_decoder.safetensors` as an alternative VAE option.
- Upstream now marks `--clip-on-cpu` and `--vae-on-cpu` deprecated in favor of `--backend`, but both
  remain functional. genai-electron keeps the established flags in this batch to avoid changing
  offload semantics during a binary refresh.
- Deliberately did **not** expose the new `dpm++2m_sde` / `dpm++2m_sde_bt` samplers: the pinned
  source adds the enum/CLI names without adding their entries to `sampling_methods_str`. A live
  Brownian-tree run therefore indexed past that display-name array and logged the adjacent
  `"cuda"` string. The generated image was correct, but the out-of-bounds read is undefined
  behavior; keep these methods out of the typed API/UI until upstream fixes the table.
- Added a binary-default invariant test so every configured sd.cpp asset/dependency must share the
  configured release tag and carry a 64-character lowercase SHA-256 pin.

**Live CUDA smoke (RTX 4060 Laptop 8 GB):** the 362 MB Windows CUDA asset matched the official
`bc7aa2…8a02` digest exactly and passed `sd-cli --help`. Reused the existing byte-identical CUDA
runtime in an isolated `C:\tmp` directory, leaving the control-panel cache untouched. Flux 2 Klein
Q4_0 with Qwen3-4B Q4_0 + `flux2-vae.safetensors` generated a visually inspected, prompt-correct
red cube at 512²/4-step Euler in 6.86 s. A second run with all three offload flags generated a
visually inspected, prompt-correct blue sphere (36.61 s); both outputs were real PNGs, not gray,
blank, or noise. CUDA initialization and the parser's `sampling using` / `generating image:` /
`decoding 1 latents` / `decode_first_stage completed` transitions were present.

**Validation:** clean library build, lint (0 errors; existing warnings), touched-file formatting,
595/595 tests across 25 suites, electron-control-panel production build, generated
runtime/declaration pin smoke, `git diff --check`, and the 163-file package dry run pass.

**Release status:** Included in v0.13.0. The exact old → new sd.cpp pin must remain explicit in the
GitHub release notes so downstream consumers know to re-verify model/VAE compatibility.

---

### Hugging Face revision support and download provenance (2026-07-26)

- Canonicalized structured Hugging Face URLs: repository-relative file paths retain nested `/`
  separators, each path segment is encoded safely, and callers can select a branch, tag, or commit
  through the new optional `revision` field (default `main`).
- `parseHuggingFaceURL()` now returns decoded `{ repo, revision, file }` data and remains compatible
  with legacy generated URLs that encoded nested file separators as `%2F`.
- Persisted the effective Hugging Face revision for single-file, multi-shard, and multi-component
  downloads. Derived bare shard filenames inherit the primary revision.
- Added normalized `source` locators to every newly written diffusion component, including the
  primary `diffusion_model`; reused shared files record the current model configuration's locator.
- The public changes are additive: two-argument URL-helper calls still default to `main`, input
  revision fields are optional, and legacy component metadata without `source` remains valid.
- Closed the issue's `%2F` severity question with downstream range-request evidence and documented
  the maintainer rule that every future sd.cpp pin change must be explicit in release notes.

**Validation:** clean build, lint (0 errors; existing warnings), touched-file formatting, 595/595
tests across 25 suites, generated runtime/declaration smoke, and the 163-file package dry run pass.
Release preparation subsequently brought the repository-wide formatting check to a clean pass.

**Release status:** Included in the v0.13.0 release preparation.

---

## v0.12.1: Archive Dependency Security and Tooling Hardening (2026-07-25)

### Archive dependency security hardening (2026-07-25)

- Raised `adm-zip` to `^0.6.0` to prevent crafted ZIP entries from triggering excessive
  uncompressed-size allocation during extraction.
- Raised `tar` to `^7.5.22` and regenerated the dependency lockfile with patched archive
  resolutions.
- Removed `@types/adm-zip`; `adm-zip` now supplies the TypeScript declarations used by the build.
- Added real temporary-directory integration coverage for ZIP and `.tar.gz` extraction, including
  nested binary discovery and content verification.

### ESLint 10 development tooling migration (2026-07-25)

- Upgraded ESLint and `@eslint/js` to v10, `typescript-eslint` to v8.65, and
  `eslint-config-prettier` to v10. The existing flat configuration required no structural change.
- Accepted ESLint 10's new recommended `no-useless-assignment` behavior and removed four dead
  initial assignments without changing runtime logic.
- Refreshed Jest and `ts-jest` to their latest compatible releases; avoided the unsafe
  `npm audit fix --force` proposal, which would downgrade the test stack to incompatible majors.
- ESLint 10 development commands require Node 22.13 or newer; the published runtime engine remains
  Node 22 or newer.
- The production audit is clean. The remaining full-audit findings are development-only and come
  from Jest's current `glob`/`minimatch` dependency chain.
- Corrected the npm author/repository/homepage metadata and contributor setup links to reference
  the canonical `lacerbi/genai-electron` repository.

**Validation:** prepublish hook passed (clean build + 570/570 tests), lint and formatting passed,
production audit reports zero vulnerabilities, clean-install dry run passed, and
`npm pack --dry-run` validated the 163-file package payload.

**Release status:** v0.12.1 published to npm with a GitHub Release (2026-07-25).

---

## v0.12.0: Calibration Mirrors Production Generation Params (breaking `calibrate()` change) (2026-07-04)

**Problem:** `calibrate()` let the compute-shaping generation params default individually, so a
partial call silently diverged from production. In particular `cfgScale` defaulted to *omitted →
sd.cpp default (> 1)*, which enables classifier-free guidance = **two model passes per step**. A
downstream app (palimpsest) benchmarked Flux Klein without passing `cfgScale`, so every calibration
generation did ~2× the diffusion work of its real generations (`cfgScale: 1`, guidance-distilled) —
inflating all times and **inverting the offload ranking** (offload-on measured ~16 s in the sweep
vs ~8 s in real use; the sweep then recommended the offload-off combo). Root-caused from the app's
own logs: identical model/size/steps/threads/sampler/flags, only sampling time doubled (10.2 s vs
5.1 s), load/decode identical → the classifier-free-guidance signature.

**Fix (breaking):** the compute-shaping params are no longer individually defaultable —
`DiffusionCalibrationConfig` now takes them as a required unit:
- New required `sizes: CalibrationSize[]` (was optional, defaulted to 768²) and required
  `generation: DiffusionCalibrationGeneration` (`{ steps, cfgScale, sampler }` required, optional
  `threads`/`batchSize`). Removed the flat `steps`/`cfgScale`/`sampler`/`threads`/`batchSize` fields.
- New exported type `DiffusionCalibrationGeneration`.
- `DiffusionCalibrationReport` gains `cfgScale` (methodology echo alongside `steps`/`sampler`).
- `DIFFUSION_CALIBRATION_DEFAULTS` drops `sizes`/`steps`/`sampler` (caller-supplied now).

**Migration:** wrap the old flat fields in `generation` / `sizes`, and **pass your production
`cfgScale`** (e.g. `1` for Flux Klein / SDXL-Lightning/Turbo; 5–8 for standard models):
`calibrate({ modelId, sizes: [...], generation: { steps, cfgScale, sampler } })`.

**Files:** `src/types/images.ts`, `src/types/index.ts`, `src/index.ts`, `src/config/defaults.ts`,
`src/managers/DiffusionServerManager.ts`, `tests/unit/diffusion-calibration.test.ts` (helper +
`cfgScale` echo assertion), example app (`ipc-handlers`, `DiffusionServerControl`, `renderer/types/api`),
docs (`image-generation`, `typescript-reference`, `migration-0-11-to-0-12.md`, docs index). Downstream
palimpsest call site tracked in that repo's `ISSUE-diffusion-calibration-cfgscale.md`.

**Build:** ✅ 0 TypeScript errors / 566/566 tests passing (22 suites); example app typechecks clean.

**Released 2026-07-04 as v0.12.0.** Breaking change scoped to `calibrate()` (added in v0.11.0);
see `genai-electron-docs/migration-0-11-to-0-12.md`.

---

## Completed Phases

### Phase 1: MVP - LLM Support ✅ (2025-10-16)

**Core Features:**
- SystemInfo: Hardware detection (CPU, RAM, GPU, VRAM), intelligent recommendations
- ModelManager: Download GGUF models from HuggingFace/URLs, storage management, checksums
- LlamaServerManager: Start/stop llama-server processes, auto-configuration, health monitoring
- Binary Management: Automatic download and variant testing for llama.cpp binaries
- Reasoning Support: Automatic detection for reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS)

**Deliverables:**
- Core library with comprehensive test coverage
- electron-control-panel example app (System Info, Models, LLM Server tabs)
- Complete documentation (README.md, genai-electron-docs/, docs/SETUP.md)

**Detailed Progress:** See `docs/dev/phase1/` for complete Phase 1 planning and logs

### Phase 2: Image Generation ✅ (2025-10-19)

**Core Features:**
- DiffusionServerManager: HTTP wrapper for stable-diffusion.cpp with on-demand spawning
- Multi-stage progress tracking: Loading → Diffusion → Decoding with self-calibrating estimates
- ResourceOrchestrator: Automatic LLM offload/reload when RAM/VRAM constrained
- Binary Management: CUDA dependency handling, variant testing with real functionality tests
- GGUF Integration: Pre-download metadata extraction, accurate layer counts, generic architecture support

**Deliverables:**
- DiffusionServerManager + ResourceOrchestrator (fully tested)
- electron-control-panel enhancements (Diffusion Server, Resource Monitor tabs, GGUF Info modal)
- Automatic resource orchestration (prevents system crashes)
- Cross-platform CI/CD with GitHub Actions
- ServerManager refactoring (eliminated ~100+ lines of duplication)

**Detailed Progress:** See `docs/dev/phase2/` for complete Phase 2 planning, logs, and app development details

### Phase 2.5: Async Image Generation API ✅ (2025-10-23)

**Core Features:**
- Async polling pattern for image generation (POST returns ID, GET polls status/progress)
- Batch generation support with `count` parameter (1-5 images per request)
- GenerationRegistry for in-memory state management with TTL cleanup
- Progress tracking for batched operations (currentImage/totalImages fields)
- Sequential batch generation with automatic seed incrementation

**Deliverables:**
- GenerationRegistry class with automatic cleanup (configurable TTL)
- Refactored HTTP endpoints (breaking change from synchronous to async)
- HTTP endpoints preserve ResourceOrchestrator integration (automatic LLM offload)
- 27 comprehensive unit tests for GenerationRegistry
- Updated type definitions (GenerationStatus, GenerationState, batch progress fields)
- Exported utilities (generateId) and new types

**Technical Details:**
- Breaking API change: `/v1/images/generations` POST now returns `{id, status, createdAt}` immediately
- New endpoint: `GET /v1/images/generations/:id` for polling status/progress/result
- Registry TTL: 5 minutes default (configurable via `IMAGE_RESULT_TTL_MS` env var)
- Cleanup interval: 1 minute default (configurable via `IMAGE_CLEANUP_INTERVAL_MS` env var)
- Batch generation: Sequential execution with overall progress calculation
- Error codes: SERVER_BUSY, NOT_FOUND, INVALID_REQUEST, BACKEND_ERROR, IO_ERROR

**Migration Impact:**
- HTTP clients must migrate from blocking pattern to polling pattern
- Example app will need updates to use async API
- Backward compatibility: None (intentional breaking change for better UX)

### Phase 2.6: genai-lite Integration ✅ (2025-10-23)

**Core Changes:**
- Migrated electron-control-panel to use genai-lite 0.5.1 ImageService API
- Image generation now uses genai-electron-images provider (replaces direct genai-electron calls)
- LLM operations continue using LLMService with llamacpp provider
- Removed unused `resources:orchestrateGeneration` handler (legacy code cleanup)

**Deliverables:**
- Example app demonstrates best practice architecture pattern
- Clean separation: genai-lite for unified API layer, genai-electron for runtime infrastructure
- All AI operations (LLM + image generation) now go through genai-lite
- Reduced API surface by removing redundant code paths

### Phase 3 Prep: Library Extraction Phase 1 ✅ COMPLETE (2025-10-23)

**Goal:** Extract reusable patterns from electron-control-panel into genai-electron library (following LIBRARY-EXTRACTION-PLAN.md)

#### Part 1: Type Consolidation & Structured Logs

**Completed Tasks:**

1. ✅ **Type Consolidation**
   - Exported `SavedLLMState` type from `ResourceOrchestrator.ts` (was internal interface)
   - Added `SavedLLMState` to `src/index.ts` exports
   - Updated `examples/electron-control-panel/renderer/types/api.ts` to import types from genai-electron library
   - App now uses library types instead of duplicates (eliminates type drift)
   - Clear separation: Library types vs app-specific adaptations documented

2. ✅ **Structured Logs API**
   - Added `getStructuredLogs(limit?: number): Promise<LogEntry[]>` method to `ServerManager` base class
   - Automatically inherited by `LlamaServerManager` and `DiffusionServerManager`
   - Parses raw log strings into structured `LogEntry` objects (timestamp, level, message)
   - Fallback handling for malformed log entries
   - Updated example app IPC handlers (`server:logs`, `diffusion:logs`) to use new API
   - Removed manual `LogManager.parseEntry()` calls from app code (now handled by library)
   - Removed unused `LogManager` import from `ipc-handlers.ts`

3. ✅ **Unit Tests (Part 1)**
   - Created comprehensive test suite: `tests/unit/structured-logs.test.ts`
   - Tests for both `LlamaServerManager` and `DiffusionServerManager`
   - Tests for `LogManager.parseEntry()` static method
   - Coverage: Well-formed logs, malformed logs with fallback, limit parameter, error handling
   - Total: 14 test cases covering all scenarios

**Part 1 Files Modified:**
- `src/managers/ResourceOrchestrator.ts` - Exported SavedLLMState interface
- `src/managers/ServerManager.ts` - Added getStructuredLogs() method
- `src/index.ts` - Added SavedLLMState type export
- `examples/electron-control-panel/renderer/types/api.ts` - Import library types
- `examples/electron-control-panel/main/ipc-handlers.ts` - Use getStructuredLogs() API
- `tests/unit/structured-logs.test.ts` - New comprehensive test suite (14 tests)

#### Part 2: Lifecycle & Error Helpers

**Completed Tasks:**

1. ✅ **Lifecycle Helper**
   - Added `attachAppLifecycle(app, managers)` utility in `src/utils/electron-lifecycle.ts`
   - Automatic graceful shutdown with server cleanup on app quit
   - Registers `before-quit` listener and stops all running servers
   - Supports both LLM and diffusion servers (optional parameters)
   - Updated example app `main/index.ts` to use helper (removed manual cleanup)
   - Removed `cleanupServers()` function from `main/genai-api.ts` (now in library)

2. ✅ **Error Normalization Helper**
   - Added `formatErrorForUI(error)` utility in `src/utils/error-helpers.ts`
   - Converts all 8 library error classes to structured `UIErrorFormat` objects
   - Returns: `{ code, title, message, remediation }` for every error
   - Maps unknown errors to safe fallback format
   - Updated example app `main/ipc-handlers.ts` to use helper
   - Removed brittle substring matching on error messages
   - Exported `UIErrorFormat` type from `src/index.ts`

3. ✅ **Unit Tests (Part 2)**
   - Created `tests/unit/electron-lifecycle.test.ts` - 11 test cases
     - Tests app quit handling, server cleanup, error handling
     - Tests with/without servers provided, mixed server states
   - Created `tests/unit/error-helpers.test.ts` - 22 test cases
     - Tests all 8 error class mappings with proper codes/titles/messages
     - Tests unknown errors, null/undefined, Error objects
     - Tests remediation suggestions from error details

**Part 2 Files Modified:**
- `src/utils/electron-lifecycle.ts` - New lifecycle helper (90 lines)
- `src/utils/error-helpers.ts` - New error formatter (225 lines)
- `src/index.ts` - Export new utilities and UIErrorFormat type
- `examples/electron-control-panel/main/index.ts` - Use attachAppLifecycle
- `examples/electron-control-panel/main/genai-api.ts` - Remove cleanupServers function
- `examples/electron-control-panel/main/ipc-handlers.ts` - Use formatErrorForUI
- `tests/unit/electron-lifecycle.test.ts` - New test suite (11 tests)
- `tests/unit/error-helpers.test.ts` - New test suite (22 tests)

**Build Status:**
- ✅ Library builds successfully (0 TypeScript errors)
- ✅ All 320 tests pass (287 existing + 33 new)
- ✅ 16 test suites, all passing
- ✅ Example app builds successfully

**Overall Impact:**

**All 4 "Move now" items from LIBRARY-EXTRACTION-PLAN.md complete:**
1. ✅ Type Consolidation (use existing exports)
2. ✅ Structured Logs API (additive method)
3. ✅ Lifecycle/Cleanup Helper (optional utility)
4. ✅ Error Normalization Helper (UI-friendly formatting)

**Benefits Delivered:**
- Reduces app code by ~27 lines
- Eliminates brittle error substring matching
- Consistent error handling across all apps
- One-line lifecycle setup with `attachAppLifecycle()`
- Type safety improved (library is source of truth)
- Reduced code duplication between library and apps
- No breaking changes to existing APIs

---

## Key Features Delivered

- ✅ **System Capability Detection** - Automatic hardware detection with intelligent recommendations
- ✅ **Model Management** - Download GGUF models with pre-download validation and metadata extraction
- ✅ **LLM Server Lifecycle** - Start/stop llama-server with auto-configuration and health monitoring
- ✅ **Image Generation** - Local image generation via stable-diffusion.cpp with progress tracking
- ✅ **Resource Orchestration** - Automatic LLM offload/reload when resources constrained (prevents crashes)
- ✅ **Binary Management** - Automatic variant testing (CUDA → Vulkan → CPU) with dependency handling
- ✅ **GGUF Metadata** - Extract accurate model info (layer count, context length) from any architecture
- ✅ **Reasoning Models** - Automatic detection and configuration for reasoning-capable models
- ✅ **Production Example** - Full-featured electron-control-panel demonstrating all capabilities

---

## Architectural Decisions

Key design decisions that inform future development:

**1. Transparent Resource Orchestration**
- `DiffusionServerManager.generateImage()` automatically uses ResourceOrchestrator when initialized with `llamaServer`
- Users don't choose between "safe" and "unsafe" APIs - orchestration happens automatically
- Prevents system crashes from OOM without requiring orchestration knowledge

**2. Configurable Metadata Fetch Strategies**
- Default: `'local-remote'` (tries local file first, auto-fallback to remote if corruption detected)
- Rationale: Some GGUF files trigger parsing errors locally; resilient fallback maintains speed + reliability
- Options: `'local-only'` (fastest), `'remote-only'` (authoritative), `'remote-local'` (prioritize authoritative)

**3. Binary Validation Caching**
- First start: Full validation (2-10s), results cached with SHA256 checksum
- Subsequent starts: Checksum verification only (0.5s) - 4-20x faster
- Auto re-validation on binary modification, manual `forceValidation` flag for driver updates

**4. Generic GGUF Architecture Support**
- `getArchField()` helper dynamically constructs field paths: `${architecture}.${fieldPath}`
- Supports ANY architecture (llama, gemma3, qwen3, mistral, phi, mamba, gpt2, falcon, future models)
- Replaces hardcoded extraction functions - future-proof design

**5. Real-Time Memory Checks with Strategic Caching**
- Dynamic data (available RAM): Always use real-time `getMemoryInfo()`
- Static data (CPU cores, GPU specs): Use 60-second cache from `detect()`
- Cache invalidation: Automatic after server start/stop to reflect memory state changes
- Prevents false "Insufficient RAM" errors when loading models sequentially

---

## Key Achievements

### Test Infrastructure
- **246/246 tests passing** (100% pass rate) across 12 test suites
- **Jest 30 + ESM**: Clean exit, no warnings, no memory leaks
- **Fast execution**: ~3.5 seconds for full test suite
- **Comprehensive coverage**: Unit tests for all managers, integration tests for workflows

### Cross-Platform Compatibility
- **Windows, macOS, Linux**: All npm scripts work across platforms (cross-env, rimraf)
- **Binary variant testing**: Automatic fallback (CUDA → Vulkan → CPU) with real functionality tests
- **GitHub Actions CI/CD**: Automated testing on all platforms, code quality checks, security audit

### Production Readiness
- **Zero TypeScript errors**: Strict mode compilation, full type safety
- **Minimal runtime dependencies**: Three small packages (adm-zip, @huggingface/gguf, tar); everything else uses Node.js built-ins
- **Comprehensive documentation**: API reference, setup guide, architecture docs, examples
- **Example application**: Full-featured electron-control-panel demonstrating all features

---

## Documentation References

- **Phase 1 Details:** `docs/dev/phase1/` - Complete planning, logs, and implementation notes
- **Phase 2 Details:** `docs/dev/phase2/` - Complete planning, logs, app development, and issue resolution
- **Testing Guide:** `docs/dev/ESM-TESTING-GUIDE.md` - ESM mocking patterns and best practices
- **Refactoring Analysis:** `docs/dev/REFACTORING-ANALYSIS.md` - ServerManager refactoring journey
- **User Documentation:** `genai-electron-docs/` - Complete API documentation (11 modular files)
- **Setup Guide:** `docs/SETUP.md` - Development environment setup for all platforms
- **Architecture:** `DESIGN.md` - Complete architecture and design document with all 5 phases

---

## Next Steps: Phase 3 - Production Core

### Immediate Priorities

**Testing & Validation:** ✅ **COMPLETE**
- ✅ Real workload testing complete (LLM, image generation, various combinations)
- ✅ Tested with genai-electron example app and genai-lite based apps
- ✅ Resource orchestration validated (LLM offload/reload during image generation)
- ✅ Example code verified working
- ✅ Cross-platform: Windows/WSL tested locally, GitHub CI validates Ubuntu/macOS
- 🔄 Ready for pull request (pending further review)

**Documentation:**
- Review and update SETUP.md for clarity
- Ensure all examples in README.md are current
- Maintain genai-electron-docs/ with Phase 2 features

**Maintenance (noticed 2026-07-03, during the genai-lite 0.11 pairing update):**
- `examples/electron-control-panel` has pre-existing `npm audit` findings in its
  dev tooling (electron ≤ 39.8.4, tar ≤ 7.5.15, brace-expansion < 1.1.13) —
  unrelated to genai-lite; run `npm audit fix` there and bump electron/forge
  when convenient

### Phase 3 Planned Features

**Enhanced Download Management:**
- Resume interrupted downloads (partial file support)
- Enhanced SHA256 checksum verification (progress reporting)
- Advanced cancellation API (pause/resume)
- Multi-model queue management (sequential downloads with prioritization)

**HuggingFace Hub Integration:**
- Direct HuggingFace API integration (browse models, search, filter)
- Model recommendations based on system capabilities
- Automatic checksum fetching from HuggingFace

**Improved Model Management:**
- Model update detection (notify when newer versions available)
- Model categories and tagging system
- Import/export model configurations

### Phase 4 Outlook - Production Polish

**Advanced Server Management:**
- Auto-restart on crash with configurable retry logic
- Log rotation with size limits and archival
- Port conflict detection and auto-resolution
- Advanced health monitoring with metrics collection

**Storage Configuration:**
- Shared storage configuration (multiple apps sharing models)
- Custom storage locations (user-specified directories)
- Storage quotas and cleanup strategies
- Model deduplication across apps

**Developer Experience:**
- Improved error messages with actionable suggestions
- Debug mode with verbose logging
- Performance profiling and optimization tools
- Migration utilities for model metadata updates

---

## Current Focus

**Phase 3 Prep: Library Extraction Phase 1 ✅ COMPLETE (2025-10-23)**

**Summary:**
- **All 4 "Move now" items complete** - Type consolidation, structured logs, lifecycle helper, error normalization
- **No breaking changes** - All changes are additive and backward compatible
- **Library builds clean** - 0 TypeScript errors
- **All tests pass** - 320/320 (100% pass rate) across 16 suites
- **Example app updated** - Uses all new library utilities
- **Type safety improved** - Library is source of truth for types

**Completed in 2 Parts:**

**Part 1 (Commit 7d59f9c):**
1. ✅ Type Consolidation (SavedLLMState exported, app using library types)
2. ✅ Structured Logs API (getStructuredLogs() added to ServerManager)
3. ✅ Unit tests (14 test cases)

**Part 2 (Commit a16f264):**
1. ✅ Lifecycle Helper (attachAppLifecycle() for automatic cleanup)
2. ✅ Error Normalization Helper (formatErrorForUI() for consistent error handling)
3. ✅ Unit tests (33 test cases: 11 lifecycle + 22 error formatting)

**Files Modified (14 total):**
- Library: 6 files (2 new utilities, 3 updated managers, index.ts)
- Example app: 5 files (main/index.ts, genai-api.ts, ipc-handlers.ts, types/api.ts, updated usage)
- Tests: 3 files (3 new comprehensive test suites)

**Benefits Delivered:**
- Reduced app code by ~27 lines
- Eliminates brittle error substring matching
- One-line lifecycle setup
- Consistent error format across all apps
- Better developer experience
- Foundation for future extractions

**Next Steps:**
- Consider Phase 3 proper (download resume/cancel, HuggingFace Hub, etc.)

---

## Documentation Restructuring ✅ COMPLETE (2025-10-24)

**Goal:** Transform documentation from large scattered files into a portable, modular `genai-electron-docs/` folder.

**Completed Phases:**

**Phase 1:** Created 11 modular documentation files in `genai-electron-docs/`
- index.md, installation-and-setup.md, system-detection.md, model-management.md
- llm-server.md, image-generation.md, resource-orchestration.md
- integration-guide.md, typescript-reference.md, troubleshooting.md, example-control-panel.md

**Phase 2:** Content trimming and verification
- Removed bloat and verbose prose from all files
- Verified all technical details against codebase

**Phase 3:** Cross-file consistency and verification
- Verified all examples work, all links valid, all APIs documented
- Added missing utility types to typescript-reference.md
- Total: 14,998 words (12.3% reduction from baseline)

**Phase 4:** Finalization
- Added missing utilities documentation (GGUF parsers, generateId, platform/file utils)
- Deleted docs/API.md (3,690 lines) - all essential content preserved
- Updated table of contents in modified files
- Net project reduction: ~10,755 words

**Result:**
- ✅ 11 modular, self-contained documentation files
- ✅ All APIs, types, examples, and utilities documented
- ✅ No broken links, consistent terminology
- ✅ Production-ready documentation structure

For detailed planning: `docs/dev/2025-10-23-documentation-restructure-plan.md`

---

## Multi-Component Diffusion Model Support (2026-02-16)

**Goal:** Support diffusion models composed of multiple separate files (Flux 2 Klein, SDXL split) instead of only monolithic single-file models.

**Core Features:**
- New type system: `DiffusionComponentRole`, `DiffusionComponentInfo`, `DiffusionModelComponents`, `DiffusionComponentDownload`
- Multi-file download flow with aggregate progress tracking (smooth 0→100% across all components)
- Per-model subdirectory storage for multi-component models (flat layout preserved for single-file)
- Component-aware CLI arg building (`--diffusion-model`, `--llm`, `--vae`, etc.)
- Auto-detection of `--offload-to-cpu` (model footprint > 85% VRAM) and `--diffusion-fa` (Flux 2 architecture)
- Multi-component delete and integrity verification in StorageManager
- New config fields: `offloadToCpu`, `diffusionFlashAttention` (three-state: undefined/true/false)
- Backwards-compatible: single-file models work exactly as before

**Target Architectures:**
- Flux 2 Klein: `--diffusion-model` + `--llm` (Qwen3-4B) + `--vae` (3 files, ~7-9 GB)
- SDXL Split: `--diffusion-model` + `--clip_l` + `--clip_g` + `--vae` (4 files, ~7 GB)

**Files Modified:**
- `src/types/models.ts` — 4 new types, extended `ModelInfo` and `DownloadConfig`
- `src/types/images.ts` — 2 new fields on `DiffusionServerConfig`
- `src/config/defaults.ts` — `DIFFUSION_COMPONENT_FLAGS`, `DIFFUSION_COMPONENT_ORDER`
- `src/config/paths.ts` — `getModelDirectory()` helper
- `src/managers/ModelManager.ts` — `downloadMultiComponentModel()` with aggregate progress
- `src/managers/StorageManager.ts` — Multi-component delete and verify
- `src/managers/DiffusionServerManager.ts` — Per-component CLI args, new optimization flags
- `src/index.ts` — New exports (types, constants, utilities)
- Tests: 22 new test cases across 4 test suites
- Documentation: typescript-reference, model-management, image-generation, DESIGN.md updated

**Build Status:**
- ✅ 0 TypeScript errors
- ✅ 403/403 tests passing (357 existing + 46 new)

---

## Async LLM Reload in ResourceOrchestrator (2026-02-12)

**Problem:** After image generation completed, the image result was blocked for 10-30s while the LLM server reloaded. This caused a visible "silent gap" in the UI between progress reaching 100% and the image appearing.

**Fix:** `orchestrateImageGeneration()` now returns the image result immediately after generation completes. The LLM reload runs asynchronously in the background (fire-and-forget). A new `waitForReload()` public method allows callers to explicitly wait for the reload if needed.

**Behavioral change:** The promise returned by `orchestrateImageGeneration()` now resolves ~10-30s earlier. The LLM may not yet be running when the promise resolves. Callers that need the LLM should use `waitForReload()` or check `llamaServer.isRunning()` before making inference calls.

**Files modified:**
- `src/managers/ResourceOrchestrator.ts` — async reload with `pendingReload` field, `waitForReload()` method
- `tests/unit/ResourceOrchestrator.test.ts` — updated 9 tests, added 1 new concurrency guard test (19 total)
- `genai-electron-docs/resource-orchestration.md` — documented async behavior and new API

---

For detailed historical information:
- Phase 2 app development: `docs/dev/phase2/PHASE2-APP-PROGRESS.md`
- Library extraction plan: `docs/dev/2025-10-23-library-extraction-plan.md`
- Documentation restructure: `docs/dev/2025-10-23-documentation-restructure-plan.md`

---

## v0.6.0: Local-Server Launch Contract, Multi-Shard Models & Reliability (2026-07-03)

**Goal:** Port gmbench's battle-tested llama-server knowledge into the library and pair with genai-lite v0.9.0 (reasoning toggle needs an always-`--jinja` server). Plan: `docs/dev/plans/PLAN-local-server-features.md`.

**Core Features:**
- llama.cpp pinned b7956 → b9860 (checksums from the releases-API digests; Linux x64 CUDA prebuilts discontinued upstream → Vulkan → CPU chain); fixed a latent macOS/Linux install bug (nested `llama-<tag>/` tar layouts now flattened)
- Modernized launch contract: unconditional `--jinja` (opt-out), tri-state `flashAttention` (`-fa on|off|auto`), KV-cache quantization (`cacheTypeK/V` + FA constraint enforcement), MoE offload (`overrideTensors`, `cacheRam`, `cpuMoe`, `nCpuMoe`), `reasoningFormat`, `fit` (default `off`), `host`, explicit `-ngl 0` for CPU-only; previously-dead fields wired (`modelAlias`, `batchSize`, `continuousBatching`, `useMmap`, `useMlock`)
- All health/validation probes use 127.0.0.1 (Windows IPv6 penalty); host-aware health checks
- Port optional with defaults + `port: 'auto'` (new `findFreePort`/`isPortBindable`); real bind test in availability check; cross-app occupancy safety rail (`occupancyCheck`, `/props` fingerprint)
- Reliability: per-start `startupTimeout` (default 60 s → 120 s), `ServerInfo.loadTimeMs`, opt-in crash `autoRestart` with backoff + `maxRestarts`, opt-in hang watchdog (`healthCheckInterval`, emits `health-check-ok/failed`), LogManager size-based rotation
- Multi-shard GGUF downloads (`-00001-of-0000N` auto-detection, `shardFiles` override, aggregate progress, `ModelInfo.shards`)
- Diffusion cancellation: `cancelImageGeneration(id)`, `getActiveGenerationId()`, `DELETE /v1/images/generations/:id`, terminal `'cancelled'` status (genai-lite ≤ 0.9.0 caveat documented; follow-up filed in genai-lite)
- Debug traces gated behind `GENAI_ELECTRON_DEBUG`
- Example app v0.4.0: reasoning request toggle, flash-attention/KV-cache form controls, image-generation Cancel button (genai-lite ^0.9.0; pairing live-verified: reasoning toggle end-to-end against Qwen3.5-4B on the b9860 server)

**Files Modified:** `src/config/defaults.ts`, `src/types/{servers,models,images,index}.ts`, `src/managers/{LlamaServerManager,DiffusionServerManager,ModelManager,StorageManager,BinaryManager,ServerManager,ResourceOrchestrator,GenerationRegistry}.ts`, `src/process/{health-check,log-manager,port-utils}.ts`, `src/utils/debug-log.ts`, `src/index.ts`, example app (TestChat, LlamaServerConfig/Control, DiffusionServerControl, preload, ipc-handlers), docs (`genai-electron-docs/*`, `migration-0-5-to-0-6.md`, `docs/dev/UPDATING-BINARIES.md`)

**Build Status:** ✅ 0 TypeScript errors / 486/486 tests passing (20 suites)

**Released:** v0.6.1 published to npm (2026-07-03; 0.6.0 was tagged but never published — the audit patch superseded it). GitHub Release on tag `v0.6.1`.

**Follow-ups (agreed, not yet started; updated 2026-07-03 post-v0.9.0):**
- **palimpsest-engine integration** (downstream, next natural step) — consume v0.8/0.9: drop the MoE filename regex (`/-a\d+b/i`) + manual `cpuMoe`/`gpuLayers: 999`/pinned-context path (v0.8 auto-config covers it), and the `binary-log` percent regex + throttle (subscribe to `'binary-progress'`, v0.9).
- ~~stable-diffusion.cpp bump~~ — DONE in v0.10.0 (pin `master-746-2574f59`, full surface re-validation, live smoke on all three win32 variants; see the v0.10.0 section and `docs/dev/plans/PLAN-sd-cpp-bump.md`).
- ~~**Skip byte-identical dependency re-downloads**~~ — RESOLVED in Unreleased
  binary-provisioning robustness: installed dependencies are reused by checksum
  across release-URL changes.
- **Example-app toolchain chore** — Electron Forge devDependency chain carries npm-audit highs fixable only via major bumps (electron 35→43 + Forge majors). Dev-only, outside the published package and CI's root-only audit gate.
- **Example app: forward `'binary-progress'` over IPC** — the control panel still forwards only `'binary-log'`; wire the structured event through preload/renderer for a real progress bar (small; pairs with the toolchain chore).
- **ROCm/HIP binary variants** — upstream now ships `win-hip-radeon` + `ubuntu-rocm` prebuilts; blocked on Windows AMD GPU detection (DESIGN Phase 4).
- ~~genai-lite `'cancelled'` terminal status~~ — RESOLVED in genai-lite v0.9.2.

---

## v0.7.0: Adaptive Context Sizing & KV-Aware Auto-Configuration (2026-07-03)

**Goal/Problem:** `recommendContextSize` was a stub returning a constant 4096, so every auto-configured server ran a ≤4K context regardless of hardware — silently truncating long prompts (hit by palimpsest-engine; `docs/dev/issues/ISSUE-context-size-recommendation.md`). The flat 2 GB KV reserve in layer packing could also push almost-fitting models into partial offload.

**Core Features:**
- Real KV-cache arithmetic (`estimateKVBytesPerToken`, GQA-aware via `attention.head_count_kv`; new GGUF fields extracted, raw-metadata fallback for older downloads)
- `getOptimalConfig(modelInfo, hints?)`: full-GPU-offload-preferring layer packing (KV reserve flexes down to the 4096-token floor), context sized from leftover VRAM/RAM with **no artificial ceiling** (capped by the model's own context_length), rounded to 1024
- **Automatic q8_0 KV quantization by default** (+ flash attention on) unless f16 at the model's full native context fits — opt out via explicit `cacheTypeK/V: 'f16'` or `flashAttention: 'off'`; pinned hints (contextSize/gpuLayers/cache types) shape the remaining recommendations
- KV-aware `canRunModel` and ResourceOrchestrator usage estimates; legacy behavior preserved exactly for models without GGUF metadata
- New exports: `estimateKVBytesPerToken`, `KV_CACHE_BYTES_PER_ELEMENT`, `KV_SIZING`, `OptimalConfigHints`

**Files Modified:** `src/utils/kv-cache-math.ts` (new), `src/utils/model-metadata-helpers.ts`, `src/system/SystemInfo.ts`, `src/managers/{LlamaServerManager,ModelManager,ResourceOrchestrator}.ts`, `src/config/defaults.ts`, `src/types/{models,servers,index}.ts`, `src/index.ts`, docs (`system-detection`, `llm-server`, `typescript-reference`, `image-generation`, `migration-0-6-to-0-7.md`)

**Build Status:** ✅ 0 TypeScript errors / 514/514 tests passing (21 suites); v0.7.1 adds the progressive context-granularity ladder (128→4096 steps by magnitude, `floorContextToGranularity` exported; amends unpublished v0.7.0 — publish 0.7.1). Live GPU smoke: pure auto-config on Qwen3.5-4B → full offload, auto q8_0 KV + FA, context 58368 (→ 57344 with the ladder), 8130-token prompt round-trips without truncation

---

## v0.11.0: Diffusion Offload Calibration — `diffusionServer.calibrate()` (2026-07-04)

**Goal/Problem:** The static VRAM heuristic cannot pick the fastest CPU-offload flag combo — the optimum is machine-dependent and the flags interact (measured on an 8 GB Win11 laptop with Flux 2 Klein: auto ~18 s vs `clipOnCpu:false`+`offloadToCpu:true` ~10–12 s; `vaeOnCpu` ~3× slower; Windows thrashes where Linux hard-OOMs). Only a live sweep on the target machine can decide. Proposal: `docs/dev/issues/ISSUE-diffusion-offload-calibration.md`; plan: `docs/dev/plans/PLAN-diffusion-calibration.md`.

**Core Features:**
- `calibrate(config)` on DiffusionServerManager: benchmarks offload combos × sizes with real generations (fixed seed/steps/prompt/sampler → identical work per combo), 1 discarded warmup per combo + median-of-samples timing, per-stage split (`stageMs`: load/diffusion/decode), OOM-vs-error classification from stderr/exit code, per-size `recommended` (5% tie tolerance prefers fewer forced flags)
- **No server restarts:** per-generation flag overrides threaded through `computeDiffusionOptimizations` (flags resolve per spawn); server must be stopped, is left stopped; `start()` guarded during sweeps; `isCalibrating()`
- Sweep-level LLM offload/restore via the internal orchestrator (`waitForReload()` → `offloadLLM()` once, `reloadLLM()` in finally; both promoted to public API)
- Progress for UIs: guarded `onProgress` callback + `'calibration-progress'` event (same payload; smooth monotonic `overallPercent` with within-generation folding) — IPC-forwardable like `'binary-progress'`
- Abort via `AbortSignal` → `ServerError` with `details.code = 'CALIBRATION_ABORTED'` + partial runs in `details.runs`
- SD3.5-Large guard: forced `clipOnCpu: true` combos auto-skipped → `report.skippedCombos` (upstream leejet/stable-diffusion.cpp#1578)
- New exports: `DiffusionOffloadCombo`, `CalibrationSize`, `DiffusionCalibrationConfig/Progress/Report`, `CalibrationRun`, `DIFFUSION_CALIBRATION_DEFAULTS`

**Files Modified:** `src/types/{images,index}.ts`, `src/index.ts`, `src/config/defaults.ts`, `src/managers/{DiffusionServerManager,ResourceOrchestrator}.ts`, `tests/unit/diffusion-calibration.test.ts` (new, 23 cases), docs (`image-generation` "Offload Calibration" section, `typescript-reference`, `resource-orchestration`, index/troubleshooting cross-refs, `migration-0-10-to-0-11.md`), example app (calibration UI)

**Build Status:** ✅ 0 TypeScript errors / 566/566 tests passing (22 suites)

**Live smoke (2026-07-04, RTX 4060 Laptop 8 GB, flux-2-klein-q40 768²/4-step):** full default sweep passed — recommended `clip-gpu` at 17.1 s median vs auto's 33.5 s (~2×); `vaeOnCpu` decode trap confirmed (97.3 s, decode 66 s); 5% tie-break exercised live (`all-resident` 16.9 s / `clip-gpu` 17.1 s / `clip-gpu+offload` 17.4 s → fewest forced flags won); progress monotonic, phases in order, callback/event parity (2303 events); post-sweep normal `start()` + generation with recommended flags OK, server left stopped. Details: `docs/dev/plans/PLAN-diffusion-calibration.md` Phase 6.

---

## v0.10.0: stable-diffusion.cpp master-746-2574f59 + CUDA Offload Guard Retirement (2026-07-04)

**Goal/Problem:** The diffusion binary pin (`master-504-636d3cb`, 2026-02-10) was 242 releases behind upstream. Bump to the latest release, re-validate the whole sd-cli surface (flags, log formats, asset scheme), and retire workarounds that no longer apply. Plan: `docs/dev/plans/PLAN-sd-cpp-bump.md`.

**Core changes:**
- **Binary pin `master-504-636d3cb` → `master-746-2574f59`** (2026-07-02; checksums from the releases-API `digest` field). CLI surface verified backward-compatible via upstream source diff: every flag we pass is unchanged; the only removal in the whole range is `--cache-preset` (unused).
- **Windows CPU variant**: upstream consolidated the four per-ISA zips into a single `win-cpu-x64.zip` with runtime CPU dispatch (`ggml-cpu-<arch>.dll` backends, best picked at runtime) — strictly better than the old AVX2-only pin.
- **Linux gains a Vulkan variant** ahead of CPU (new upstream asset), mirroring the llama.cpp Linux chain — Linux GPU users get acceleration instead of CPU-only.
- **CUDA offload guard retired** (behavior change): `--clip-on-cpu`/`--vae-on-cpu`/`--offload-to-cpu` crashed sd.cpp CUDA builds silently (0xC0000005) at the old pin, so auto-detection suppressed them on CUDA installs; fixed upstream. Auto-detection is now identical on all backends — low-VRAM CUDA setups may auto-enable offload flags (explicit `false` restores the old behavior). Added the previously missing variant-aware test coverage. Upstream caveat documented: SD3.5-Large + `--clip-on-cpu` is broken on any backend (leejet/stable-diffusion.cpp#1578).
- **Progress parsing fixed for the new build** (would have silently broken otherwise): upstream renamed the loading literal (`loading tensors from` → `loading model from`) and switched loading to `#`-style byte bars (`|####| N/M - GB/s`) that the old regex would have misread as sampling steps. The step regex now requires an it-rate unit (`it/s`/`s/it`), and a byte-bar branch feeds loading progress only. 3 new parser tests (+1 guard-retirement test, above).
- **Sampler enum** += `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp` (upstream additions); example-app sampler select + docs updated.
- Docs: troubleshooting + image-generation offload sections rewritten for the retirement; `docs/dev/UPDATING-BINARIES.md` retitled and generalized with a stable-diffusion.cpp section (tag scheme, asset naming, digest workflow, log-format coupling) and its stale 30 s test-timeout claim fixed (actual: 120 s multi-component / 15 s single-file).
- Folded into this batch (concurrent docs work already on main): genai-lite 0.11 pairing notes + example pin `genai-lite ^0.11.0` (`36952da`); example dev-tooling audit-findings maintenance note (`fcddb22`).

**Live smoke (RTX 4060 Laptop 8 GB, driver 576.80, Windows 11):** all three win32 variants provisioned from scratch (Phase 1 `--help` + Phase 2 real 64×64 inference) and generated valid PNGs — CUDA: SDXL-Lightning 512²/20-step in 11.1 s and Flux-2-Klein multi-component (`--diffusion-model/--llm/--vae --diffusion-fa` verified in the spawn command) in 8.0 s; forced Vulkan: 34.1 s (slower per upstream perf issue #1647; correctness fine); forced CPU: 256²/4-step in 57 s with all 9 dispatch DLLs surviving install. **CUDA offload matrix all clean: clipOnCpu ✓ (14.8 s) / vaeOnCpu ✓ (22.1 s) / offloadToCpu ✓ (7.9 s, output byte-identical to baseline at the same seed) / all three ✓ (30.9 s)** — the old crash did not reproduce. New `er_sde` sampler ✓. Post-retirement auto-config live-verified: Flux on the CUDA install now auto-enables clip-on-cpu (`auto: clip=true`) and generates correctly.

**Files Modified:** `src/config/defaults.ts`, `src/managers/DiffusionServerManager.ts`, `src/types/images.ts`, `tests/unit/DiffusionServerManager.test.ts`, example app (`DiffusionServerControl.tsx`), docs (`image-generation`, `troubleshooting`, `typescript-reference`, `docs/dev/UPDATING-BINARIES.md`, `docs/dev/plans/PLAN-sd-cpp-bump.md` new)

**Build Status:** ✅ 0 TypeScript errors / 543/543 tests passing (21 suites)

---

## v0.9.0: Structured Binary-Provisioning Progress (2026-07-03)

- **`'binary-progress'` event**: structured companion to `'binary-log'` for binary-provisioning UIs — `BinaryProgressEvent { phase: downloading|extracting|verifying|testing, file, downloaded?, total?, percent? }`, throttled to whole-percent changes at the source, one event per phase transition, emitted by both server managers. Resolves `docs/dev/issues/ISSUE-binary-progress-event.md` (palimpsest drops its log-regex + chunk throttle). `'binary-log'` unchanged.
- Orchestrator MoE-estimate test coverage (v0.8.0 review finding 5b, PR #32).

**Build Status:** ✅ 0 TypeScript errors / 539/539 tests passing (21 suites)

---

## v0.8.0: MoE-Aware Auto-Configuration (2026-07-03)

**Goal/Problem:** Adaptive sizing (v0.7) treated the whole model file as GPU-resident, so MoE models with `--cpu-moe` got floor-level context and hint-less MoE got slow dense partial offload (`docs/dev/issues/ISSUE-moe-aware-auto-config.md`, filed by palimpsest-engine). Apps resorted to filename heuristics to detect MoE.

**Core Features:**
- Exact expert-weights measurement from GGUF tensor offsets at download (`expert_weights_bytes`; quant-agnostic — correct for Unsloth Dynamic quants; `_exps` match mirrors llama.cpp's `--cpu-moe` selection, shared experts count as trunk); MoE metadata extracted (`expert_count`, `expert_used_count`, `expert_feed_forward_length`)
- Auto `cpuMoe` tier in the offload ladder: full dense → **trunk-on-GPU + experts-in-RAM** → dense partial → CPU; context sized against the trunk; KV stays GPU-side
- `OptimalConfigHints` += `cpuMoe`/`nCpuMoe`/`overrideTensors` (`'exps=CPU'` ≡ cpuMoe; custom `-ot` sized conservatively as dense); parameter-count heuristic fallback for pre-0.8 downloads
- MoE-aware ResourceOrchestrator estimates (CPU-resident experts count against RAM)
- Hardening from live-smoke failures: per-layer `attention.head_count_kv` arrays (Gemma 4 alternating attention) normalized via mean in KV math (was NaN); Windows standby-aware available-RAM detection (PerfOS `AvailableBytes` refreshed in `detect()`; `os.freemem()` reported 1.5 GB on a box with ~11 GB reclaimable); mmap-aware expert RAM gate (60% of total RAM, trunk-only committed requirement in `canRunModel`)

**Files Modified:** `src/managers/{ModelManager,LlamaServerManager,ResourceOrchestrator}.ts`, `src/system/{SystemInfo,memory-detect}.ts`, `src/utils/model-metadata-helpers.ts`, `src/types/{models,servers}.ts`, `src/config/defaults.ts`, `src/index.ts`, docs (`system-detection`, `llm-server`, `typescript-reference`, `migration-0-7-to-0-8.md`)

**Build Status:** ✅ 0 TypeScript errors / 532/532 tests passing (21 suites); Opus review pass applied (sharded-MoE measurement skip → heuristic fallback; auto tier restricted to MEASURED expert bytes; orchestrator nCpuMoe split). Live GPU smoke: gemma-4-26B-A4B pure auto-config → `--cpu-moe -ngl 30 -c 16384` + q8_0 KV, healthy + /props-confirmed on an 8 GiB GPU / 23 GiB RAM machine; e2e token check: 131 tokens @ ~12.2 tok/s, exact answer with reasoning_content separated
