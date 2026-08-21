# ISSUE — Diffusion path follow-ups deferred from the sd-server migration

- Created: 2026-08-21
- Status: TRACKING — reminder list; each item is a separate proposal to confirm before implementing
- Package: genai-electron
- Source: `docs/dev/2026-08-21_diffusion-architecture-review.md` (§5 code-level findings, §6 risks,
  §8 ranked actions) and `docs/dev/plans/PLAN-sd-server-migration.md` (Scope → Out of scope)
- Implemented by the migration (branch `feat/sd-server-backend`, unreleased): §3 / §8.2 (persistent
  `sd-server` backend, `burst`/`single` residency, symmetric orchestration, calibration re-base),
  §5.1 bind fix / §8.1 (`127.0.0.1` default + `host`), §5.2 busy-gate race, §5.3 batch through the
  orchestrator, §5.5 temp-PNG leak (by construction), `gpuLayers` kept as a documented no-op.

## Implemented in the follow-up small-fix batch (2026-08-21, same branch)

- [x] **`darwin-x64` explicit unsupported error** — `ensureBinary()` now raises a `BinaryError`
  naming the platform and the missing upstream Intel-macOS prebuilt, with a suggestion to use
  Apple silicon / another platform or to build stable-diffusion.cpp from source and drop
  `sd-server` into the binaries directory. Documented in `installation-and-setup.md` and
  `troubleshooting.md`.
- [x] **`sd35LargePattern` expiry note** — JSDoc now marks it an upstream-bug workaround
  (leejet/stable-diffusion.cpp#1578) to re-check at every pin bump and delete once fixed, with a
  matching `docs/dev/UPDATING-BINARIES.md` checklist item.
- [x] **Linux NVIDIA silently gets Vulkan** — provisioning now logs a `warn` once per
  `ensureBinary()` when the diffusion binary on `linux-x64` falls back to Vulkan on a CUDA-capable
  machine. Documented in `installation-and-setup.md` and `troubleshooting.md`. (Only a warning: no
  Linux CUDA asset exists upstream, so there is nothing else to select.)
- [x] **Export-surface guard for the package root** — `tests/unit/public-exports.test.ts` imports
  `src/index.ts` behind an `electron` mock and asserts the named value exports
  (`DIFFUSION_BACKEND_DEFAULTS`, `DIFFUSION_CALIBRATION_DEFAULTS`, `diffusionServer`, `llamaServer`,
  `ResourceOrchestrator`) plus a compile-time check of the new diffusion/hook types.
  `public-types.test.ts` deliberately stays Electron-free and was not extended.

## Small fixes (low risk; do in one batch)

- [ ] **Progress percentage can touch 100 % before the image is done** — the self-calibrating
  estimator (`calculateOverallPercentage` / `updateTimeEstimates` in `DiffusionServerManager`)
  learns the cold load time from the previous cold generation; a later cold load that is slower
  than anything seen before (e.g. cold disk cache after a restart) can drive the loading-stage
  percentage to 100 and it then falls back when sampling starts. Cosmetic only (the displayed
  `percentage`), pre-existing in spirit (the `sd-cli` estimator had the same class of wart; the
  v0.25.0 cold/warm split removed the common case). Fix: never report 100 % before the final
  completion callback (cap in-flight values at 99) and keep the percentage monotonic within a
  generation; ships as a patch. Surfaced by a timing-flaky unit test on Windows CI after the
  v0.25.0 merge (test de-flaked in PR #59; the estimator itself is unchanged).
- [ ] **`--clip-on-cpu` / `--vae-on-cpu` → `--backend te=cpu,vae=cpu`** — deprecated-but-working at
  the pinned build; switch the spelling at the next pin bump (re-run the offload matrix live).

## Orchestration / measurement (real work items)

- [ ] **Measured-VRAM orchestrator estimator** (devlog §5.4) — replace `size × 1.2` (charged to RAM
  and VRAM, ignores offload flags and residency) with calibration-measured `vramPeakBytes` /
  `vramIdleBytes` (now in `CalibrationRun`) plus live `vramAvailable`; make `needsOffloadForImage()`
  resident-aware so a small LLM and an offload-to-cpu diffusion backend can coexist on 8 GB without
  the offload/reload cycle. Also reconcile `computeDiffusionOptimizations` thresholds (6 GB / 2 GB /
  85 %) with the orchestrator's 75 % rule.
- [ ] **Expose `--max-vram` / `--stream-layers`** (devlog §5.4, §8.5) — both exist at the pinned
  build (`sd-server --help`); evaluate on real hardware first, then expose as diffusion config.
- [ ] **`calibrate()` as a binary-bump regression gate** (devlog §6, §8.4) — persist reference
  timings per machine keyed by `policyVersion`/`usageMode`; refuse or flag a bump on a large delta.
- [ ] **Stuck-job watchdog** — an internal no-activity timeout for a resident backend (today the
  client's DELETE on its own timeout is the only recovery).
- [ ] **Expose the built-in orchestrator state** — `DiffusionServerManager` constructs its
  `ResourceOrchestrator` internally and exposes no accessor, so a host that wants to observe the
  offload/reload cycle (`getSavedState()`, `waitForReload()`) has to construct its own — a
  split-brain instance that never receives `onDiffusionBackendReleased()` and whose saved state
  reflects only its own calls. Decide on a `getOrchestrator()` (or a narrower saved-state /
  `waitForReload()` accessor on the manager). Documented as a caveat for now
  ("Built-in vs custom orchestrator" in `resource-orchestration.md`).

## Model / API shape (features)

- [ ] **Per-model generation contracts** (devlog §4, §8.3) — native steps / cfgScale / sampler /
  resolution in model metadata; ship Z-Image Turbo as a first-class second option (shares the
  Qwen3-4B encoder).
- [ ] **API leaks to keep in mind for any backend abstraction** (devlog §5.7) — `ImageSampler` =
  sd.cpp CLI strings, `DiffusionOffloadCombo` = four sd.cpp flags, `DiffusionComponentRole` = 1:1
  sd.cpp flags persisted in `ModelInfo`; the runner/client pair is the de-facto seam, a named
  `DiffusionEngine` abstraction is not.
- [ ] **Queueing concurrent requests** — `sd-server` has a 64-deep queue; the wrapper still answers
  503 `SERVER_BUSY` (documented contract, genai-lite maps it to rate-limit and never retries).
- [ ] **`preload` / `--eager-load` at `start()`** — optional eager backend spawn for hosts that want
  the first image warm.
- [ ] **CORS `*` / no auth on the wrapper** (devlog §5.1 second half) — bind-only fix shipped;
  auth/CORS policy is a separate design decision.

## Tooling

- [ ] **CI lint gate excludes `tests/` — decide.** `eslint.config.mjs` lists `tests/` in its global
  `ignores`, so `npm run lint` (and therefore CI) never sees a test file: a stray `it.only` /
  `describe.only`, an unused import, or a `@ts-expect-error` that no longer applies cannot fail the
  build. The `files: ['**/*.test.ts', '**/*.spec.ts']` block further down is dead config as a
  result. Either lint `tests/` (dropping the ignore and keeping the relaxed rule block, plus a
  `no-only-tests`-style guard) or delete the dead block and record the exclusion as deliberate.

## Experiments (devlog §4, §8.5, §8.7)

- [ ] Q5_K_S vs Q4 on the DiT; 1024² vs 768² at 4 steps; VAE tiling / TAESD (decode is ~3 s of a
  ~7 s warm 768² image on the reference machine); Mage-Flow 4B vs klein 4B benchmark before any
  default-model change.

## Watch list (devlog §7)

- FLUX 3 open weights; Mage-Flow adoption; text-encoder inflation; `libnunchaku`; upstream
  stable-diffusion.cpp PR #1884 (progress in the job JSON — would let the stdout marker tap go);
  Ollama image-gen on Windows/Linux.
