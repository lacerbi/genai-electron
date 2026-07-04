# Plan: Diffusion Offload Calibration API (`diffusionServer.calibrate()`)

Created: 2026-07-04
Status: COMPLETE (2026-07-04) — all phases done, live smoke PASSED, doublecheck clean; ships unreleased per the batch workflow
Source: `ISSUE-diffusion-offload-calibration.md` (repo root) + design discussion (agreed decisions below)

## Phase status

- [x] Phase 1: Types, defaults, core plumbing
- [x] Phase 2: `calibrate()` implementation
- [x] Phase 3: Tests (20 new; +3 in doublecheck hardening → 566/566 total, 22 suites)
- [x] Phase 4: Documentation + housekeeping
- [x] Phase 5: Example-app wiring
- [x] Phase 6: Live smoke (PASSED 2026-07-04 — see Phase 6 results)
- [x] Final `/doublecheck` (2026-07-04): 3 read-only Opus reviewers (core impl / API+docs /
  example+tests) + main-thread CI gate. **Verdict: faithful to plan & ISSUE, zero
  critical/important findings.** Minor hardening applied same-day: `calibrating` released
  before the awaited `reloadLLM()` (lock-safety), per-sweep combo copies (no shared refs to
  `DIFFUSION_CALIBRATION_DEFAULTS.combos` in reports), calibration log writes made
  fire-and-forget (match `executeImageGeneration`), IPC double-calibrate guard in the example,
  +3 tests closing reviewer gaps (stdout-driven `stageMs`/fractional progress, happy-path
  median of 2 samples + combo-copy lock-in, calibrate-during-calibrate guard) → 566/566,
  and doc polish (docs index feature bullet, troubleshooting → calibrate cross-ref,
  CLAUDE.md Key Exports line). Not addressed (accepted): internal-only
  `orchestrateImageGeneration`-during-calibrate misuse (unreachable from public surface),
  exit-code-based OOM classification (message/stderr matching suffices), pre-existing docs
  catch-narrowing style, pre-existing preload `WindowAPI` missing image `cancel` (unrelated).

## Summary

Add a per-machine calibration sweep to `DiffusionServerManager`: benchmark CPU-offload flag
combinations (`clipOnCpu` / `vaeOnCpu` / `offloadToCpu` / `diffusionFlashAttention`) for a given
model and image size(s) by actually running generations, and return a report with per-combo
timings, per-stage splits, OOM/error classification, and a recommended (fastest working) combo
per size. First-class progress reporting (callback **and** event) so callers can drive a
progress bar.

## Agreed design decisions (from review of the ISSUE)

1. **No restarts.** The ISSUE assumed stop+start per combo, but flags are resolved *per
   generation* (`computeDiffusionOptimizations()` is called inside `executeImageGeneration()`,
   `src/managers/DiffusionServerManager.ts:842`). `calibrate()` threads per-combo flag overrides
   directly into each spawn. No HTTP server, no port binding, no restart churn.
2. **Server-state contract: require stopped.** `calibrate()` throws if the server is running.
   It does its own minimal setup (model validation + `ensureBinary`, no HTTP server) and leaves
   the server stopped. `start()` throws while a calibration is in flight.
3. **LLM handling: sweep-level offload via orchestrator.** If the manager was constructed with a
   `llamaServer` (→ internal `ResourceOrchestrator`), settle any in-flight background reload
   (`await waitForReload()` — without this, an LLM mid-reload reads as not-running, the offload
   no-ops, and the LLM comes back *during* the sweep), then offload the LLM **once**
   (unconditionally if running — measurement hygiene) and restore it (awaited) at sweep end, in
   a `finally`. Requires making `ResourceOrchestrator.offloadLLM()` / `reloadLLM()` public.
   Note: `offloadLLM()` no-ops when the LLM isn't running but **throws** if it is running with
   no retrievable config (`ResourceOrchestrator.ts:383`) — so the offload call must already be
   inside calibrate's try/finally. `reloadLLM()` no-ops without saved state and never throws.
   Without an orchestrator, document that the caller should stop the LLM first.
4. **Abort: throw, with partial results attached.** On `signal` abort: cancel the in-flight
   generation and throw a `ServerError`. **Discriminator caveat:** `ServerError` hardcodes its
   top-level `.code` to `'SERVER_ERROR'`, so the abort marker lives in
   `error.details.code === 'CALIBRATION_ABORTED'` with partial runs in `error.details.runs`
   (consistent with how other details-carried codes work in this codebase; must be stated
   verbatim in docs and asserted that way in tests).
   *Deliberate divergence from the ISSUE:* the ISSUE suggested aborting "via existing stop
   path", but `stop()` early-returns when `_status === 'stopped'` (`:278`) — which is the status
   throughout calibration — so it would be a silent no-op. Calibrate aborts the in-flight
   generation via `this.currentGeneration?.cancel()` directly. Do not "simplify" this back.
5. **SD3.5-Large guard.** Detect via name/id pattern; skip `clipOnCpu: true` combos (both
   default and caller-provided), record them in the report (`skippedCombos`), and document
   (upstream leejet/stable-diffusion.cpp#1578 — changes the image, not just the time).
6. **Defaults per the ISSUE:** curated 6-combo set, 1 discarded warmup per combo, 2 timed
   samples, median reported + raw `samplesMs` (with `samples: 2` the median is the mean of the
   two — documented), fixed seed/steps/prompt/sampler so combos do identical work. Default
   sweep = 6 combos × (1 warmup + 2 samples × 1 size) = 18 generations.

## Scope

- **In scope:** `calibrate()` method + types + progress reporting; per-run flag-override
  plumbing; OOM classification; `ResourceOrchestrator` public offload/reload; unit tests;
  docs (image-generation, typescript-reference, resource-orchestration); PROGRESS entry;
  ISSUE file resolution (move to `docs/dev/issues/`).
- **Out of scope (per ISSUE non-goals):** image-quality comparison, auto-applying/persisting
  the winner, tuning steps/sampler/cfg/resolution, multi-GPU, report caching inside the
  library. The ISSUE's optional standalone `calibrateDiffusion()` wrapper is deliberately
  omitted (the method on the manager/singleton suffices).
- **Versioning:** deliberately deferred per the agreed release workflow — this lands as an
  **unreleased** batch (PROGRESS.md "Unreleased" entry only). Version strings (package.json,
  `src/index.ts` `@version`, README header) and any migration notes are bumped later in a
  release PR, when the user explicitly says to release.

---

## API (new types in `src/types/images.ts`)

```ts
/** One offload combination to benchmark. Omitted flag = auto-detect. */
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
  sizes?: CalibrationSize[];          // default: [{ width: 768, height: 768 }]
  combos?: DiffusionOffloadCombo[];   // default: curated set (below)
  steps?: number;                     // default: 4 (docs: prefer the caller's real step count —
                                      // offload cost scales with steps; 4 suits distilled models)
  cfgScale?: number;                  // default: omitted → sd.cpp default
  sampler?: ImageSampler;             // default: 'euler'
  seed?: number;                      // default: 42 (fixed → identical work per combo)
  prompt?: string;                    // default: neutral benchmark prompt
  samples?: number;                   // timed samples per (combo, size); default: 2
  threads?: number;                   // optional passthrough (match production -t)
  batchSize?: number;                 // optional passthrough (match production -b)
  onProgress?: (p: DiffusionCalibrationProgress) => void;
  signal?: AbortSignal;
}

export interface DiffusionCalibrationProgress {
  phase: 'preparing' | 'warmup' | 'sampling' | 'restoring-llm' | 'done';
  comboIndex: number;                 // 0-based index into the active (post-skip) combo list
  comboCount: number;                 // active combos (skipped ones excluded)
  combo?: DiffusionOffloadCombo;      // current combo — UI text via combo.label (defaults are labeled)
  sizeIndex: number;
  sizeCount: number;
  size?: CalibrationSize;
  sample?: number;                    // 1-based, timed samples only
  sampleCount?: number;
  generationPercent?: number;         // 0-100 within the current generation (from sd.cpp progress)
  overallPercent: number;             // 0-100 smooth across the whole sweep
}

export interface CalibrationRun {
  size: CalibrationSize;
  combo: DiffusionOffloadCombo;       // as requested (omitted = auto)
  /** What auto-detection resolved omitted flags to (captured per run). */
  resolved?: {
    clipOnCpu: boolean; vaeOnCpu: boolean;
    offloadToCpu: boolean; diffusionFlashAttention: boolean;
  };
  status: 'ok' | 'oom' | 'error';
  timeTakenMs?: number;               // median of samplesMs; only when status === 'ok'
  stageMs?: { loadMs?: number; diffusionMs?: number; decodeMs?: number };
  samplesMs?: number[];               // raw totals of *successful* samples (kept even on failed runs)
  error?: string;                     // when status != 'ok'
}

export interface DiffusionCalibrationReport {
  machine: { gpuType?: string; gpuName?: string; vramBytes?: number; vramAvailableBytes?: number };
  modelId: string;
  // Methodology echo (for caller-side persistence keying / reproducibility):
  steps: number;
  sampler: ImageSampler;
  samples: number;
  runs: CalibrationRun[];
  /** Fastest OK combo per size, keyed "<W>x<H>" (e.g. "768x768" — document the exact format).
   *  Value is the combo AS REQUESTED (winner may be `{}` = auto); what auto resolved to is in
   *  the winning run's `resolved`. Absent for a size where all combos failed. */
  recommended: Record<string, DiffusionOffloadCombo>;
  /** Combos excluded up-front (e.g. SD3.5-Large + clipOnCpu). */
  skippedCombos?: { combo: DiffusionOffloadCombo; reason: string }[];
}
```

New method + helpers on `DiffusionServerManager`:

```ts
calibrate(config: DiffusionCalibrationConfig): Promise<DiffusionCalibrationReport>;
isCalibrating(): boolean;
```

**Progress delivery (user requirement — progress bar):** both channels, same payload:
- `config.onProgress(p)` callback (primary, same-process).
- `'calibration-progress'` event on the manager (mirrors the `'binary-progress'` pattern →
  natural to forward over IPC in Electron apps). Emit via raw `this.emit(...)` like
  `'binary-progress'` (`ServerManager.ts:521`) — do NOT use the typed `emitEvent()`, which is
  constrained to the `ServerEvent` union and would force a `servers.ts` change.
- **Both guarded:** wrap the callback invocation and the `emit` in try/catch (swallow; debug-log)
  so a throwing consumer cannot abort the sweep with a raw error.

Defaults live in `src/config/defaults.ts` as `DIFFUSION_CALIBRATION_DEFAULTS` (exported):
default combos, sizes, steps, samples, seed, prompt, tie tolerance, SD3.5-Large pattern,
OOM stderr patterns.

**Default combos** (curated, from the ISSUE — each ships with a `label` since progress UIs and
persisted recommendations surface it):

1. `{ label: 'auto' }` — baseline; current heuristic
2. `{ label: 'clip-gpu', clipOnCpu: false }` — encoder on GPU
3. `{ label: 'clip-gpu+offload', clipOnCpu: false, offloadToCpu: true }` — encoder on GPU + managed streaming (empirical best on 8 GB/Win11)
4. `{ label: 'offload', offloadToCpu: true }` — auto clip + managed streaming
5. `{ label: 'all-resident', clipOnCpu: false, vaeOnCpu: false, offloadToCpu: false }` — fastest if it fits, else OOM
6. `{ label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true }` — fallback so something runs

`diffusionFlashAttention` stays at auto in defaults (callers may add it as an extra axis).
`label` is ignored by flag resolution (only the four flag fields are read).

---

## Phases

### Phase 1: Types, defaults, core plumbing

**Goal:** Everything `calibrate()` will need, landed first so each phase compiles on its own.

**Work:**
- [x] Add the six types above to `src/types/images.ts`; re-export via `src/types/index.ts` and
  `src/index.ts` (type-exports block).
- [x] Add `DIFFUSION_CALIBRATION_DEFAULTS` to `src/config/defaults.ts` (combos with labels, sizes,
  steps, samples, seed, prompt, tie tolerance %, SD3.5-Large id/name pattern, OOM stderr
  patterns); export from `src/index.ts` (constants block).
- [x] `computeDiffusionOptimizations(flagOverrides?: DiffusionOffloadCombo)` — precedence per flag:
  `flagOverrides.X ?? serverConfig.X ?? autoX`. No behavior change when called without overrides.
- [x] `executeImageGeneration(config, flagOverrides?)` — optional second param, passed through.
  Existing callers (orchestrator, batch, async path) unchanged.
- [x] Store the resolved flags in a private `lastResolvedOptimizations` field (read by calibrate
  after each run for `CalibrationRun.resolved`).
- [x] `ResourceOrchestrator`: make `offloadLLM()` and `reloadLLM()` public with JSDoc (no logic
  change). JSDoc must be precise: `offloadLLM()` no-ops when the LLM isn't running but throws
  if running without a retrievable config; `reloadLLM()` no-ops without saved state and never
  throws (internally retried + swallowed).

**Verification:**
- [x] `npm run build` — 0 errors; all existing tests still pass (543/543; the "worker process
  failed to exit gracefully" Jest warning was verified pre-existing on the unmodified tree).
  Note: Phase 1 alone did not compile standalone (TS6133 — `lastResolvedOptimizations`
  write-only until calibrate() reads it), so the build gate ran after Phase 2's code, as one
  compile unit.

### Phase 2: `calibrate()` implementation

**Goal:** The sweep itself.

**Work — control flow:**
1. **Guards:** throw `ServerError` if `_status !== 'stopped'`; throw if already calibrating
   (private `calibrating` flag, set here). Add matching guard in `start()` (throw while
   calibrating). Check `signal.aborted` at entry (throw `CALIBRATION_ABORTED` immediately, empty
   `details.runs`). Validate `sizes`: positive integers, multiples of 64 (sd.cpp constraint) —
   clear `ServerError` up-front beats a cryptic per-run failure.
   Note (no extra guard needed, confirm in tests): during calibration `_status` stays
   `'stopped'`, so a stray `stop()` no-ops and `generateImage()` throws "not running";
   `getInfo().busy` may read `true` mid-generation — harmless, mention in docs.
2. **Setup (phase `'preparing'`):** `getModelInfo` + diffusion-type check; `canRunModel`
   (`checkTotalMemory: true`); initialize log manager (`diffusion-server.log`) if absent;
   `ensureBinary` (reuses existing multi-component test-args logic). **First-run caveat:**
   `ensureBinary` may download ~50–660 MB + run validation inference; it already emits
   `'binary-progress'`/`'binary-log'` on this manager — docs tell callers to subscribe for that
   phase; check `signal.aborted` immediately after it returns.
   Save prior `_config` / `currentModelInfo` / `binaryPath`; install synthetic
   `_config = { modelId, threads?, batchSize? }` + fresh `currentModelInfo` / `binaryPath`.
   (Required: `computeDiffusionOptimizations` dereferences `this._config` at `:1036`/`:1078` —
   the *first* crash site with `_config === undefined` — and `buildDiffusionArgs` reads
   `.threads` at `:1182`. This holds even for pure-auto combos, since precedence still evaluates
   `serverConfig.X`.) All state from here on is torn down in `finally`.
3. **LLM offload:** `await this.orchestrator?.waitForReload()` (settle any background reload
   from a prior orchestrated generation — otherwise the LLM can read as not-running now and
   come back mid-sweep), then `await this.orchestrator?.offloadLLM()`.
4. **Combo list:** caller's or default. If model id/name matches the SD3.5-Large pattern,
   filter out combos with `clipOnCpu === true` → `skippedCombos` with reason + log line.
   `comboCount`/progress accounting use the post-filter (active) list.
5. **Sweep loop** (combo-outer, size-inner; sizes processed in caller order):
   - Per combo: 1 warmup generation at the first size (discarded), then per size: `samples`
     timed generations. Every generation uses fixed seed/steps/cfg/sampler/prompt and
     `executeImageGeneration(genConfig, combo)`.
   - **Bookkeeping invariant:** every (active combo × size) pair produces exactly one
     `CalibrationRun`.
   - After each generation (warmup included): read `lastResolvedOptimizations` → `resolved`;
     snapshot the stage timestamps (`loadStartTime`/`loadEndTime`, `diffusionStartTime`/
     `diffusionEndTime`, `vaeStartTime`/`vaeEndTime`) **per sample** — they are instance fields
     reset by the next generation — into `{ loadMs, diffusionMs, decodeMs }` (fields omitted
     when markers were missed).
   - `timeTakenMs` = median of `samplesMs` (mean of middle two for even n), set only when
     `status === 'ok'`; run's `stageMs` = the snapshot of the sample whose total is closest to
     the median.
   - **Failure handling (never aborts the sweep):** classify each failed generation via
     stderr/exit-code patterns (`details.stderr`, `details.exitCode` on the `ServerError` from
     `executeImageGeneration`) → `'oom'` (patterns: `out of memory`, `cudaMalloc`,
     `CUDA error`, `ErrorOutOfDeviceMemory`, `failed to allocate`, `not enough memory`, …)
     else `'error'` (spawn failures and pattern misses — incl. Windows access-violation exits
     with empty stderr — classify `'error'`; still never recommended, so the report stays
     correct; Windows over-subscription typically shows up as a slow `'ok'`, not a crash).
     Rules:
     - Timed sample fails → that (combo, size) run gets the failure status + `error`;
       successful `samplesMs` are kept for diagnostics; remaining samples for that size are
       skipped (an intermittently-failing combo must not be recommended); later sizes for the
       combo are still attempted.
     - Warmup fails → the **first size's** run records the failure (its timed samples are
       skipped); later sizes are still attempted, without an extra warmup (failure at one size
       doesn't imply failure at another).
     - Progress accounting: units skipped due to failure are counted as **completed** so
       `overallPercent` still reaches 100 by folding (no stall-then-jump).
6. **Recommendation:** pure helper `pickRecommended(runs, tolerancePct)` — per size: fastest
   `status === 'ok'` run; any run within 5% of the fastest with **fewer forced flags** (count
   of defined flag fields, `label` excluded) wins the tie (robustness preference, per ISSUE,
   made deterministic). Must be directly unit-testable (exported or `@internal`-exported —
   decide at implementation).
7. **Abort:** check `signal.aborted` before each generation; `signal` listener calls
   `this.currentGeneration?.cancel()`. On abort: throw `ServerError` with
   `details.code = 'CALIBRATION_ABORTED'` and `details.runs` = partial runs (see decision 4 —
   top-level `.code` is `'SERVER_ERROR'`). Listener removed in finally.
8. **Finally:** restore saved `_config`/`currentModelInfo`/`binaryPath`; phase
   `'restoring-llm'` → `await this.orchestrator?.reloadLLM()`; `calibrating = false`; server
   remains stopped.
9. **Report:** `machine` from `systemInfo.getGPUInfo()` (`type`, `name`, `vram`,
   `vramAvailable`); methodology echo (`steps`, `sampler`, `samples`); `runs`, `recommended`,
   `skippedCombos`.

**Work — progress (user requirement):**
- Total work units = Σ over **active** combos of `(1 warmup + samples × sizeCount)`; units
  skipped by failure handling count as completed (see 5).
- Each generation's `onProgress` percentage is mapped to `generationPercent` and folded into
  `overallPercent = (completedUnits + generationPercent/100) / totalUnits × 100` → the bar
  moves smoothly *within* each generation, not just between runs.
- Emit on: sweep start (`'preparing'`, 0%), every wrapped per-generation progress tick, each
  warmup/sample boundary, `'restoring-llm'`, and `'done'` (100%) on success.
- Deliver via both `config.onProgress` and the `'calibration-progress'` event; both guarded
  with try/catch (a throwing consumer must not kill the sweep).

**Tracking (Phase 2):**
- [x] Guards (`stopped` required, `calibrating` flag, `start()` guard, pre-aborted signal, size validation)
- [x] Setup / `'preparing'` (model+canRun+logManager+ensureBinary, save/install state)
- [x] LLM offload (`waitForReload()` → `offloadLLM()`)
- [x] Combo list + SD3.5-Large filter → `skippedCombos`
- [x] Sweep loop (warmup + samples, per-sample stage snapshots, failure classification rules)
- [x] `pickRecommended` pure helper (5% tolerance, fewer-forced-flags tie-break; exported `@internal`)
- [x] Abort wiring (listener → `currentGeneration.cancel()`, `details.code = 'CALIBRATION_ABORTED'` + `details.runs`)
- [x] Finally teardown (state restore, `'restoring-llm'` → `reloadLLM()`, `calibrating = false`)
- [x] Report assembly (machine fingerprint, methodology echo, runs, recommended, skippedCombos)
- [x] Progress plumbing (units math, `generationPercent` folding with monotonic clamp, guarded callback + `'calibration-progress'` event)

**Verification:**
- [x] `npm run build` — 0 TypeScript errors (strict mode).
- [x] Full unit-test suite (Phase 3) green.

### Phase 3: Tests

**Goal:** Coverage for the new surface.

**Work:**
- New test file `tests/unit/diffusion-calibration.test.ts` (reuses the mock scaffold from
  `DiffusionServerManager.test.ts` — mocked spawn with controllable stdout/stderr/exit; the
  scaffold's mock set is sufficient for the real-`ResourceOrchestrator` path, since the
  orchestrator's own imports pull nothing needing extra mocks). Cases:
  - [x] Sweep spawns combos × (warmup + samples × sizes) processes; per-spawn CLI flags match each
    combo (per-run flag resolution — replaces the ISSUE's obsolete "restarts per combo" check).
  - [x] Injected OOM (exit 1 + `CUDA error: out of memory` stderr) on one combo → `status: 'oom'`,
    sweep continues, other combos recorded `'ok'`.
  - [x] Injected generic failure → `status: 'error'`.
  - [x] Warmup failure → first size's run carries the failure, later sizes still attempted,
    progress still reaches 100.
  - [x] `pickRecommended`: fastest wins; 5%-tolerance tie prefers fewer forced flags; size with all
    failures absent from `recommended` (pure-function tests with synthetic runs — deterministic,
    no wall-clock dependence).
  - [x] Progress: phases observed in order, `overallPercent` monotonic 0→100, `'done'` emitted;
    `'calibration-progress'` event fires with the same payloads as the callback; a **throwing**
    `onProgress` does not abort the sweep (also covers a throwing event listener).
  - [x] Abort mid-sweep → rejects with `details.code === 'CALIBRATION_ABORTED'` (top-level code is
    `'SERVER_ERROR'`), partial `details.runs` present, `calibrating` cleared. Pre-aborted
    signal at call time → immediate rejection, no spawns. Plus: in-flight abort via the
    cancel/kill path (hanging spawn + kill→exit wiring).
  - [x] Throws if server running; `start()` throws during calibration; invalid sizes (non-multiple
    of 64) rejected up-front.
  - [x] SD3.5-Large model name → `clipOnCpu: true` combos in `skippedCombos`, not run.
  - [x] Constructed with mock `llamaServer` running → `llamaServer.stop()` once at sweep start,
    `llamaServer.start()` (restore) at sweep end (exercises the real orchestrator with mocks:
    `isRunning`, `getConfig`, `stop`, `start`).
  - [x] State restore: prior `_config`/`currentModelInfo`/`binaryPath` back in place after the
    sweep (e.g. a normal `start()` + `generateImage()` works unchanged afterwards; also
    asserts no leftover combo overrides leak into post-calibration generations).
- `computeDiffusionOptimizations` override-precedence cases can be covered through the sweep
  tests (flags on spawn args); add a direct case in the existing test file only if a gap remains.

**Verification:**
- [x] `npm test` — all suites green (563/563: 543 existing + 20 new, 22 suites).
- [x] `npm run lint` (0 errors, 62 pre-existing warnings), `npm run format` clean.

### Phase 4: Documentation + housekeeping

**Goal:** Docs are a deliverable, not an afterthought.

**Work:**
- [x] `genai-electron-docs/image-generation.md` — new **"Offload Calibration"** section (named to
  avoid colliding with the existing "Self-Calibrating Estimates" progress section; add a
  one-line cross-reference disambiguating the two): motivation (one short paragraph — the
  optimum is machine-dependent), API + example (mirroring the ISSUE's consumer usage),
  defaults, contract (server must be stopped and is left stopped; LLM offloaded/restored
  automatically when orchestration is wired, else stop it yourself; report is returned, caller
  persists/applies; `recommended` values are as-requested combos — see the winning run's
  `resolved` for what auto picked; `"<W>x<H>"` key format), caveats (SD3.5-Large skip; steps
  interaction — calibrate at your real step count; size dependence; sizes must be multiples of
  64; thermal noise / raw `samplesMs`; first-run binary provisioning during `'preparing'` →
  subscribe to `'binary-progress'`; `busy` may read true while status is `'stopped'`),
  abort semantics (`details.code === 'CALIBRATION_ABORTED'`, `details.runs`), progress-bar
  wiring snippet (callback + `'calibration-progress'` IPC forwarding). Add
  `'calibration-progress'` to the **Events** list in the same file.
- [x] `genai-electron-docs/typescript-reference.md` — new types under "Image Generation Types"
  (+ navigation entries); `DIFFUSION_CALIBRATION_DEFAULTS` under Constants.
- [x] `genai-electron-docs/resource-orchestration.md` — document now-public
  `offloadLLM()`/`reloadLLM()`.
- [x] `PROGRESS.md` — "Unreleased" entry (no version bump, per release workflow).
- [x] Move `ISSUE-diffusion-offload-calibration.md` → `docs/dev/issues/`, add a resolution header
  (implemented, date) listing **all** deviations: no-restart design; abort throws with partial
  runs in `details` (code in `details.code`); 5% tie tolerance; progress phase enum reworked
  (`'starting'` → `'preparing'`, added `'restoring-llm'`) and payload enriched
  (`combo`/`size`/`sample`/`generationPercent`); `skippedCombos` + methodology echo on the
  report; `isCalibrating()` added; standalone `calibrateDiffusion()` wrapper omitted;
  labeled default combos.

**Verification:**
- [x] Docs examples spot-checked against the final API (types, error discriminator, key format;
  added a label-stripping note — spreading a labeled combo into start() would hit config
  validation).
- [x] `npm run format` after doc edits.

### Phase 5: Example-app wiring (confirmed in scope)

**Goal:** Demonstrate the progress-bar consumer pattern in `examples/electron-control-panel`.

**Work:** "Calibrate" button on the Diffusion Server tab; IPC handler calling
`diffusionServer.calibrate()` with the form's model + a small size set; forward
`'calibration-progress'` over IPC (pairs with the existing `'binary-progress'` follow-up);
render a progress bar + result table; display `recommended` and let the user apply it to the
form's Auto/On/Off overrides.

**Tracking (Phase 5):**
- [x] IPC handler + preload wiring (`diffusion:calibrate` + `diffusion:calibrateCancel`;
  main holds the AbortController and converts CALIBRATION_ABORTED into `{aborted, runs}`)
- [x] `'calibration-progress'` forwarded over IPC (genai-api.ts, mirrors binary-log pattern)
- [x] Calibrate button + progress bar + result table in DiffusionServerControl (card shown
  while the server is stopped; benchmarks the Generate form's current size/steps; Start
  disabled during sweeps)
- [x] Apply-recommended → flags stored (label stripped) and spread into the next start()
  (with a visible "on next start" hint + Clear; the app had no per-flag Auto/On/Off controls,
  so apply-to-start-config is the equivalent)

**Verification:**
- [x] Example app builds (tsc + vite, 0 errors); manual click-through folded into Phase 6
  live smoke.

### Phase 6: Live smoke (this machine)

**Goal:** Reproduce the ISSUE's empirical table through the new API.

**Work:** Small script (scratchpad) against the built library: Flux 2 Klein (Q4_0),
`sizes: [{768,768}]`, real step count 4, default combos. Expect: combo 3
(`clip-gpu+offload`) fastest or tied; `vaeOnCpu` combo markedly slower; auto baseline
mid-pack; progress callback stream sane (monotonic, phases in order); LLM offload/restore
observed if llama server running. **Single heavy-compute run in the main thread — no parallel
agents running GPU work.**

**Verification:**
- [x] Report matches the empirical shape from the ISSUE (directionally).
- [x] Server left stopped; subsequent normal `start()` + generation works.

**Results (2026-07-04, RTX 4060 Laptop 8 GB, flux-2-klein-q40, 768×768 @ 4 steps, euler,
2 samples, ~12.5 min sweep):**

| Combo | Median | diffusion / decode |
|---|---|---|
| `auto` (→ clip=true) | 33.5 s | 8.7 s / 1.4 s |
| **`clip-gpu`** (recommended) | **17.1 s** | 9.2 s / 4.9 s |
| `clip-gpu+offload` | 17.4 s | 11.3 s / 1.5 s |
| `offload` | 57.5 s | 10.9 s / 1.5 s |
| `all-resident` | 16.9 s | 8.8 s / 5.0 s |
| `max-savings` | 97.3 s | 10.4 s / 66.4 s |

- Auto heuristic beaten ~2×; `vaeOnCpu` decode trap confirmed (66 s); `offload`-alone worse
  than auto — all directionally per the ISSUE. Divergence (the point of calibrating): on this
  box at Q4_0/768², `clip=false` needs no `offloadToCpu` (`all-resident` ran clean at 16.9 s).
- **Tie-break exercised live**: `all-resident` (16.9 s, 3 forced flags), `clip-gpu` (17.1 s,
  1 flag), `clip-gpu+offload` (17.4 s, 2 flags) all within the 5% window → fewest-forced-flags
  rule picked `clip-gpu`. Exactly as designed.
- Progress: monotonic ✓ (asserted in-script), phases `preparing → (warmup → sampling)×6 →
  restoring-llm → done` ✓, 2303 events on the `'calibration-progress'` channel (callback parity) ✓.
- Post-check: normal `start()` with recommended flags + 768² generation OK (17.7 s, valid
  1.29 MB PNG); server stopped cleanly; `isCalibrating()` false; status `stopped` after sweep.
- `stageMs.loadMs` absent in all runs (loading-stage start marker not hit for this
  multi-component model); `diffusionMs`/`decodeMs` present. Field is optional per spec — OK,
  noted as a possible future parser follow-up.
- Smoke ran as a headless Electron script sharing the example app's userData (v0.10.0 smoke
  methodology). Gotcha for next time: **Electron 35's default app hangs silently on `.mjs`
  entry scripts** — use a `.cjs` entry + dynamic `import()` of the ESM library. Scripts were
  temporary (example dir, deleted after the run); full log in the session scratchpad
  (`calibration-smoke2.log`).

---

## Files touched (summary)

| File | Change |
|---|---|
| `src/types/images.ts` | +6 calibration types (Phase 1) |
| `src/types/index.ts` | re-exports (Phase 1) |
| `src/index.ts` | type + constant exports (Phase 1) |
| `src/config/defaults.ts` | `DIFFUSION_CALIBRATION_DEFAULTS` (labeled combos, sizes, steps, samples, seed, prompt, tie tolerance, SD3.5 pattern, OOM patterns) (Phase 1) |
| `src/managers/DiffusionServerManager.ts` | flag-override plumbing + `lastResolvedOptimizations` (Phase 1); `calibrate()`, `isCalibrating()`, `pickRecommended`, start() guard, `'calibration-progress'` event (Phase 2) |
| `src/managers/ResourceOrchestrator.ts` | `offloadLLM()`/`reloadLLM()` private → public (Phase 1) |
| `tests/unit/diffusion-calibration.test.ts` | new suite (Phase 3) |
| `genai-electron-docs/{image-generation,typescript-reference,resource-orchestration}.md` | new sections (Phase 4) |
| `PROGRESS.md` | Unreleased entry (Phase 4) |
| `ISSUE-diffusion-offload-calibration.md` | → `docs/dev/issues/` with resolution note (Phase 4) |
| `examples/electron-control-panel/*` | Calibrate button, IPC forwarding, progress bar + results UI (Phase 5) |

No new dependencies (Node built-ins + existing internals only). No `servers.ts` change needed
(`'calibration-progress'` is raw-emitted, matching the `'binary-progress'` precedent).

## Risks

- **Timing noise in unit tests** — avoided by testing winner-picking as a pure function;
  sweep tests assert structure/flags/statuses, never wall-clock ordering.
- **Shared mutable state** (`_config`, `currentModelInfo`, progress fields) — calibrate is
  strictly sequential and exclusive (`calibrating` flag + `start()` guard); save/restore in
  `finally`; stage-timestamp snapshots taken per sample before the next generation resets them.
- **`updateTimeEstimates` cross-talk** — calibration runs feed the self-calibrating progress
  estimators (`modelLoadTime` etc.). Harmless (they're heuristics that adapt anyway); noted,
  not mitigated.
- **OOM pattern coverage** — Windows access-violation crashes may produce no stderr; they
  classify as `'error'`, which is still "not recommended", so the report stays correct.
- **Steps default (4) under-represents offload cost at high step counts** — disclosed in docs
  ("prefer your real step count", per the ISSUE); default suits distilled models (Turbo/Klein).

## Branch / release

Work on `feat/diffusion-calibration`; **no version bump now** — this accumulates as unreleased
work per the agreed release workflow (PROGRESS.md "Unreleased" entry in Phase 4 is the only
version-adjacent change). When the user later says to release: one release PR bumps
package.json / `src/index.ts` `@version` / README, adds the PROGRESS release entry and any
migration notes, then tag → GitHub release → user runs `npm publish`. Merge/PR timing decided
by the user at the end.

## Open questions

None — Phase 5 confirmed in scope (2026-07-04).

---
**Approved 2026-07-04 — execution in progress on `feat/diffusion-calibration`. This file is the live tracker.**
