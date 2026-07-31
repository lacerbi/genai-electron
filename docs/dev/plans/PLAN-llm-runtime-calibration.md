# Plan: LLM Runtime Calibration

Created: 2026-07-31
Status: COMPLETE (approved and implemented 2026-07-31)
Source: `docs/dev/issues/ISSUE-llm-runtime-calibration.md` + design discussion on 2026-07-31

## Summary

Add `LlamaServerManager.calibrate()` as a fixed-profile, per-machine benchmark that starts an
isolated real `llama-server` for each candidate, runs caller-supplied serial cold-prefill and
shared-prefix scenarios under a fixed production capacity profile, and recommends the best stable
candidate under the documented latency and tie policy. The default search is a small, model-aware core around
`SystemInfo.getOptimalConfig()`; callers can replace it with a narrower or more specific candidate
list.

Each calibration call holds the exact total `contextSize` and `parallelRequests` constant. A
consumer that wants to explore the capacity/performance frontier calls `calibrate()` independently
at 8K, 10K, 12K, etc. with the same workloads and compares the separate reports; the library does
not rank different context sizes against one another in v1.

## Phase status

- [x] Phase 1: Public contract, metadata, defaults, and pure policy helpers
- [x] Phase 2: Shared launch primitives and lifecycle-neutral server runner
- [x] Phase 3: HTTP workload runner and fixed-profile sweep
- [x] Phase 4: Reporting, recommendation, progress, and cancellation
- [x] Phase 5: Deterministic test coverage
- [x] Phase 6: Documentation and issue bookkeeping
- [x] Phase 7: Full verification and live smoke
- [x] Final `/doublecheck` (all high/medium findings fixed and regression-tested)

## Design decisions for approval

1. **One fixed context profile per call.** `profile.contextSize` is the exact total `-c` allocation
   and `profile.parallelRequests` is the exact `-np` slot count. Both are required. Every candidate
   receives the same values with `-fit off`; `/props` verifies the effective per-slot context and
   slot count. Because the profile is shared by every candidate, missing or mismatched capacity
   evidence fails the calibration with `CALIBRATION_SLOTS_UNAVAILABLE`.
2. **Contexts are not a search dimension.** There is no `contextSizes[]` and no cross-context
   winner. Consumers may make repeated calls and build their own frontier. A future
   `calibrateProfiles()` could be a thin orchestration wrapper without changing report semantics.
3. **Production-representative workloads are required.** As with diffusion calibration's required
   `generation` block, the library will not silently invent the request mix. Callers provide one
   or more cold-prefill and/or shared-prefix workloads, including fixed output length. A lone
   workload implicitly has weight 1; multiple workloads must all declare explicit positive
   production-frequency weights. Every report retains separate per-workload results even when an
   aggregate recommendation is computed.
4. **Curated defaults, not a Cartesian sweep.** The default policy generates at most ten unique
   candidates around the current static recommendation. Its core targets GPU-layer headroom, full
   offload, meaningful SWA comparisons, and at most one measured-MoE counterfactual. KV precision
   stays fixed unless the caller opts into one f16/q8 comparison; advanced fields remain available
   through caller-supplied candidates.
5. **Custom candidates replace defaults.** `combos` follows the diffusion precedent: if supplied,
   the exact non-empty list is validated, copied, and benchmarked in caller order. Duplicate-
   equivalent custom candidates are rejected rather than silently changing the requested set. This
   supports a one-combo diagnostic run or a narrowly controlled experiment.
6. **The real server is authoritative.** Candidate ranking uses the pinned `llama-server` through
   `/completion`, `/slots`, and `/props`. `llama-bench`, `llama-batched-bench`, and
   `llama-fit-params` are not v1 dependencies because they do not reproduce the server's prompt
   cache, slot scheduling, SWA behavior, and full HTTP path.
7. **Startup is measured but not ranked.** Model load/start time is reported separately. The
   default score is the caller-weighted median steady-request latency across workloads.
8. **Slow success is still success.** v1 does not claim to detect “thrashing.” Candidate statuses
   distinguish OOM, startup/request timeout, crash, and other errors; a managed-memory spill that
   completes remains `ok` and loses through its latency.
9. **Report-only persistence boundary.** The caller applies and persists the resolved winner.
   Calibration does not make `SystemInfo.getOptimalConfig()` stateful and does not write implicit
   per-model defaults. `ResourceOrchestrator` already preserves a normally started server's full
   applied config across diffusion offload/reload cycles.
10. **Calibration servers are invisible to normal lifecycle state.** Public status remains
    `stopped`; ephemeral candidates do not update `_config`, PID/port, readiness generation,
    watchdog/restart state, or emit `ready`/`started`/`stopped`/`crashed` events.
11. **Exclusive resources are a caller precondition.** Llama occupancy is checked where possible,
    but the manager cannot prove that another app or a diffusion workload is not consuming the GPU.
    The caller must stop competing generation for the sweep; the report records memory/environment
    diagnostics but does not mistake them for an exclusivity guarantee.
12. **Fixed fields and candidate axes are distinct.** `fixedConfig` values are inherited by every
    run and never varied. Candidate overrides may only use non-fixed axes; overlap is rejected. The
    generated policy varies only its documented axes, while custom combos specify the exact search.

## Scope

- **In scope**:
  - `LlamaServerManager.calibrate()` and `isCalibrating()`.
  - A fixed-context public calibration contract, caller-defined workloads, custom candidate lists,
    model-aware bounded defaults, raw samples, deterministic recommendation, progress, and abort.
  - An internal lifecycle-neutral real-server runner shared with production argument/config
    normalization where safe.
  - Normalized sliding-window metadata needed to gate default SWA candidates.
  - Reproducibility fingerprints for machine, model, binary, profile, workloads, and policy.
  - Public exports, unit tests, user docs, README feature summary, PROGRESS Unreleased entry, and
    resolution/archive of the root issue after verification.
- **Out of scope**:
  - Sweeping all llama.cpp flags, arbitrary raw argv, or context size.
  - Automatic library persistence or silent changes to `SystemInfo.getOptimalConfig()`.
  - Cross-context scoring, quality evaluation, or choosing the application's capacity target.
  - Treating startup time as part of the default recommendation score.
  - Upstream helper-executable integration in v1; retain an internal candidate-seeding seam only.
  - Concurrent traffic simulation in v1. `parallelRequests` is fixed for capacity/placement, while
    benchmark requests use controlled slots serially for reproducibility.
  - A calibration UI in the example app or changes in consumer repositories.
  - Version bumps, migration guides, tags, releases, or npm publishing without a later explicit
    release instruction.

## Proposed public contract

Add focused types in `src/types/llm-calibration.ts` and re-export them through
`src/types/index.ts` and `src/index.ts`.

```ts
export interface LlamaCalibrationProfile {
  /** Exact total llama-server -c allocation; fixed across every candidate. */
  contextSize: number;
  /** Exact slot count; fixed across every candidate. */
  parallelRequests: number;
}

/** Fields v1 may vary. Omitted values inherit fixedConfig, then static auto-resolution. */
export type LlamaCalibrationOverrides = Partial<
  Pick<
    LlamaServerConfig,
    | 'gpuLayers'
    | 'swaFull'
    | 'cacheTypeK'
    | 'cacheTypeV'
    | 'flashAttention'
    | 'cpuMoe'
    | 'nCpuMoe'
    | 'overrideTensors'
    | 'threads'
    | 'batchSize'
    | 'cacheRam'
  >
>;

/** Launch fields pinned identically across every candidate. */
export type LlamaCalibrationFixedConfig = LlamaCalibrationOverrides &
  Partial<Pick<LlamaServerConfig, 'continuousBatching' | 'useMmap' | 'useMlock'>>;

export interface LlamaCalibrationCombo {
  label?: string;
  /** Nested so the recommended overrides can be spread into start() without stripping label. */
  overrides: LlamaCalibrationOverrides;
}

export interface LlamaColdPrefillWorkload {
  id: string;
  kind: 'cold-prefill';
  prompt: string;
  nPredict: number;
  /** Relative frequency; optional only when this is the sole workload. */
  weight?: number;
}

export interface LlamaSharedPrefixWorkload {
  id: string;
  kind: 'shared-prefix';
  sharedPrefix: string;
  /** First suffix primes the slot; remaining suffixes form the timed burst. */
  /** Runtime validation requires >= 2; each request is sharedPrefix + suffix exactly. */
  suffixes: readonly string[];
  nPredict: number;
  /** Complete-burst frequency; optional only when this is the sole workload. */
  weight?: number;
}

export type LlamaCalibrationWorkload =
  | LlamaColdPrefillWorkload
  | LlamaSharedPrefixWorkload;

export interface LlamaCalibrationConfig {
  modelId: string;
  profile: LlamaCalibrationProfile;
  /** Pinned launch values inherited by every combo and excluded from candidate variation. */
  fixedConfig?: LlamaCalibrationFixedConfig;
  /** Required production request mix; raw prompts are never copied into the report. */
  workloads: readonly LlamaCalibrationWorkload[];
  /** Replaces generated defaults when present; an explicit empty array is invalid. */
  combos?: readonly LlamaCalibrationCombo[];
  /** Add one f16/q8 counterfactual to generated defaults; default false. */
  includeKvCacheComparison?: boolean;
  /** Prefer higher-precision KV when its score is within this % of fastest; default 10. */
  kvPrecisionPreferencePct?: number;
  samples?: number; // positive integer; default 3
  seed?: number; // default 42
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onProgress?: (progress: LlamaCalibrationProgress) => void;
  signal?: AbortSignal;
}
```

The report types will be LLM-specific rather than reusing image `CalibrationRun`. The final type
file will also define the resolved-config and identity/signature structures named below:

```ts
export type LlamaCalibrationStatus =
  | 'ok'
  | 'oom'
  | 'startup-timeout'
  | 'request-timeout'
  | 'crashed'
  | 'error';

export interface LlamaCalibrationRequestTiming {
  wallTimeMs: number;
  promptTokens?: number;
  promptMs?: number;
  promptTokensPerSecond?: number;
  predictedTokens?: number;
  predictedMs?: number;
  predictedTokensPerSecond?: number;
  cachedTokens?: number;
}

export interface LlamaCalibrationSample {
  /** End-to-end time for one cold request or one timed shared-prefix burst. */
  wallTimeMs: number;
  /** One entry for cold-prefill; one per timed suffix for shared-prefix. */
  requests: readonly LlamaCalibrationRequestTiming[];
}

export interface LlamaCalibrationWorkloadResult {
  workloadId: string;
  kind: LlamaCalibrationWorkload['kind'];
  workloadHash: string;
  weight: number;
  samples: readonly LlamaCalibrationSample[];
  medianWallTimeMs?: number;
  error?: string;
}

export type ResolvedLlamaCalibrationConfig = LlamaCalibrationProfile &
  LlamaCalibrationFixedConfig &
  LlamaCalibrationOverrides;

export interface LlamaCalibrationRun {
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  status: LlamaCalibrationStatus;
  loadTimeMs?: number;
  effectiveContextSize?: number;
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  error?: string;
  stderrTail?: string;
}

export interface LlamaCalibrationRecommendation {
  combo: LlamaCalibrationCombo;
  /** Start-ready measured fragment, including the profile and inherited fixed values. */
  startConfig: ResolvedLlamaCalibrationConfig;
  scoreMs: number;
}

export interface LlamaCalibrationReport {
  schemaVersion: 1;
  policyVersion: string;
  createdAt: string;
  model: LlamaCalibrationModelIdentity;
  binary: LlamaCalibrationBinaryIdentity;
  machine: LlamaCalibrationMachineIdentity;
  cacheability: { level: 'stable' | 'best-effort'; reasons: readonly string[] };
  profile: LlamaCalibrationProfile;
  fixedConfig: LlamaCalibrationFixedConfig;
  verifiedProfile?: {
    effectiveContextSize: number;
    effectiveParallelRequests: number;
  };
  workloads: readonly LlamaCalibrationWorkloadSignature[];
  methodology: {
    samples: number;
    warmups: 1;
    seed: number;
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    resourceCooldownMs: number;
    tieTolerancePct: number;
    includeKvCacheComparison: boolean;
    kvPrecisionPreferencePct: number;
    scoreUnit: 'scenario-median-wall-ms';
  };
  comboSource: 'default' | 'custom';
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
  runs: readonly LlamaCalibrationRun[];
  recommended?: LlamaCalibrationRecommendation;
}
```

`ResolvedLlamaCalibrationConfig` is the normalized, start-ready intersection of
`LlamaCalibrationProfile`, `fixedConfig`, and the resolved calibration axes. It includes fixed
values and explicit values wherever library auto-resolution selected one; fields still omitted
intentionally defer to the fingerprinted pinned binary's default. Applying a winner is unambiguous:

```ts
await llamaServer.start({
  modelId: report.model.id,
  ...report.recommended!.startConfig,
});
```

`LlamaCalibrationProgress` will carry a monotonic `overallPercent`, phase
(`preparing | starting | warmup | sampling | stopping | done`), combo index/count, current combo,
workload index/count, and timed sample index/count. Progress is sent through both guarded
`onProgress` and raw `'calibration-progress'` EventEmitter channels, matching diffusion. It will
not be added to `ServerEvent`, whose `emitEvent()` payload is normal server lifecycle state.

## Default candidate policy

Implement the policy as a pure, directly tested generator. Start from a fully resolved static
baseline for the exact profile and `fixedConfig`, then form targeted candidates and deduplicate
their normalized resolved overrides:

1. Calculate a GPU-layer step of `max(2, ceil(totalLayers * 0.10))`.
2. Add distinct anchors in canonical order: `baseline`, headroom (`baseline - step`), aggressive
   (`baseline + step`), and full offload (`totalLayers`), clamped to
   `[0, totalLayers]`. On CPU-only or otherwise non-GPU backends, emit only the zero-layer baseline;
   never manufacture positive GPU placements. If `fixedConfig.gpuLayers` is present, keep that one
   placement instead of generating a ladder.
3. Pin the baseline's resolved KV K/V types and compatible flash-attention setting across every
   generated candidate so placement/SWA changes cannot accidentally change cache precision. Only
   when `includeKvCacheComparison: true`, add one alternate KV profile at the baseline placement:
   - resolved q8_0/q8_0 -> f16/f16;
   - otherwise -> q8_0/q8_0 with flash attention on.
4. When exact measured MoE expert bytes exist and the counterfactual is statically feasible, add
   one baseline-placement `cpuMoe` toggle. Do not generate partial `nCpuMoe` or arbitrary tensor
   overrides. Do not vary MoE placement when any MoE axis is fixed.
5. When normalized sliding-window metadata is present, a shared-prefix workload exists, and the
   expected per-slot context exceeds the SWA window, add explicit `swaFull: false` and `swaFull:
   true` counterparts for the distinct GPU-layer anchors. If `fixedConfig.swaFull` is present, keep
   that value instead of generating the SWA comparison.
6. Deduplicate equivalent resolved configs in stable order and cap at ten candidates. Preserve
   every omitted/filtered candidate with a machine-readable reason in `skippedCombos`.

This is intentionally not a Cartesian product: KV, MoE, thread, batch, cache-RAM, and arbitrary
tensor-placement interactions are custom-candidate territory. Caller candidates may use every
field in `LlamaCalibrationOverrides`, but validation rejects unknown fields, non-finite/out-of-range
numbers, duplicate normalized configs, mutually contradictory MoE settings, and quantized V-cache
with flash attention forced off. A custom combo may not override a key present in `fixedConfig`.
Metadata gates generated defaults only: any otherwise valid custom candidate, including an explicit
`swaFull` experiment, runs exactly as requested. Supplying `includeKvCacheComparison: true` together
with custom `combos`, or with fixed KV/FA axes, is rejected as ambiguous.

The opt-in KV alternative crosses an accepted precision/performance boundary. Consumers control the
tradeoff with `kvPrecisionPreferencePct` (default 10): a higher-precision cache may win while it is
no more than that percentage slower than the fastest eligible candidate. Setting it to 0 selects
the precision class only among candidates tied for the fastest measured score; the ordinary 5%
same-precision robustness rule still applies afterwards. Consumers may also express any specific
cache comparison through custom combos.

## Measurement protocol and scoring

For every candidate in active order (the generated static baseline is first; custom order is
preserved):

1. Resolve the profile + fixed config + combo into a concrete launch config. Reject any fixed/combo
   overlap. Always force loopback, an ephemeral port, `fit: 'off'`, no auto-restart/watchdog, and the
   same `-c`/`-np`.
2. Spawn one isolated server, race health readiness against caller abort, child `error`/exit, and
   startup timeout, then call `/props`. Record load time separately.
3. Independently require `/props.total_slots === profile.parallelRequests` and
   `effectiveContextSize === floor(profile.contextSize / profile.parallelRequests)`, matching the
   repository's existing exact-total context contract. Cross-run equality is a secondary invariant,
   not the source of truth; non-divisible totals intentionally use the documented floor. Missing
   slot-count evidence is `capacity-unverifiable`, never assumed correct.
4. Use `/tokenize` once for every complete request prompt: the cold prompt and every
   `sharedPrefix + suffix` priming/timed prompt. Record observed token counts and reject the
   calibration configuration if any prompt + fixed prediction cannot fit the verified per-slot
   context. Do not include raw prompt content in logs, progress, reports, or errors.
5. Enable/use the pinned server's slots endpoint and assign a controlled slot. Before every
   workload sample, erase that slot so earlier samples cannot influence the result.
6. Run one discarded warmup of the complete workload set for the candidate.
7. Run `samples` timed repetitions of each workload with non-streaming `/completion`, fixed seed,
   deterministic sampling, fixed `n_predict`, `ignore_eos`, and `cache_prompt` as appropriate:
   - `cold-prefill`: erase, then time the prompt + fixed prediction.
   - `shared-prefix`: erase, make one untimed priming request with suffix 0, then time the remaining
     suffix requests on the same slot as one burst. Record server cache/prompt/prediction timings for
     each request as well as end-to-end wall time. Require the pinned response to expose normalized
     prompt/cache counts; a missing or malformed cache observation makes the run ineligible, while a
     small legitimate cache hit remains valid data rather than an error.
8. Tear down the process in `finally`, await confirmed exit, clear cached system information, and
   allow a bounded resource-release cooldown before the next candidate. An unconfirmed teardown is
   calibration-fatal: retain partial results and PID/kill diagnostics, do not launch another
   candidate, and block later `start()`/`calibrate()` calls until a liveness recheck confirms the
   orphan is gone.

For each workload, take the median successful wall time across timed repetitions. A workload weight
is the relative production frequency of the complete scenario: one cold request or one entire
shared-prefix burst. Normalize those positive caller weights and compute:

```text
scoreMs = sum(normalizedWeight(workload) * medianWallTimeMs(workload))
```

A candidate is eligible only when startup/capacity verification and every required workload sample
succeeds. Let the fastest eligible score be `F`. Among candidates at or below
`F * (1 + kvPrecisionPreferencePct / 100)`, first choose the highest combined K/V element footprint
using `KV_CACHE_BYTES_PER_ELEMENT`. Within candidates at that selected footprint, the fastest score
establishes the ordinary 5% robustness tie window; then prefer fewer explicitly forced override
fields and stable candidate order. Thus the default 10% precision window can choose f16 over q8
when f16 is at most 10% slower, while a value of 0 makes precision relevant only at equal measured
latency before the ordinary same-precision 5% robustness rule. When all candidates use the same
resolved KV precision, only the ordinary 5% tie rule applies. Startup time and diagnostic
free-memory snapshots never enter the score.

If all candidates fail, return a valid report with `recommended` absent rather than throwing away
the diagnostic runs.

## Upstream llama.cpp executables

- `llama-fit-params` solves whether/how a model can be placed; it does not measure the production
  request path and therefore cannot select the fastest candidate.
- `llama-bench` is useful for prompt/generation kernels and may later prefilter layer/KV candidates,
  but it does not currently reproduce this feature's server slots, HTTP scheduling, shared-prefix
  cache semantics, or SWA flag comparison.
- `llama-batched-bench` is synthetic and should not be the final authority for `llama-server`.
- `BinaryManager` already installs sibling archive files beside `llama-server`, but their presence
  varies by release/variant. v1 will neither assume nor require them. The pure default-candidate
  generator is the future seam where validated helper output could seed candidates.

## Phases

### Phase 1: Contract, metadata, defaults, and pure policy

**Goal**: Establish an explicit fixed-profile API and deterministic candidate/recommendation logic
before adding processes or HTTP.

**Work**:

- [x] Add `src/types/llm-calibration.ts` with the public types above, JSDoc examples, readonly report
  collections, and explicit fixed-total/per-slot terminology.
- [x] Re-export types from `src/types/index.ts` and `src/index.ts`.
- [x] Add `LLAMA_CALIBRATION_DEFAULTS` in `src/config/defaults.ts`: samples 3, seed 42, 5% ordinary
  tie tolerance, `includeKvCacheComparison: false`, `kvPrecisionPreferencePct: 10`, policy version,
  bounded stderr size, startup/request/cooldown defaults, and OOM patterns. Export it from
  `src/index.ts`; dynamic candidate objects are not stored in the constant.
- [x] Add normalized optional sliding-window size to `GGUFMetadata`, populate it in
  `ModelManager.createGGUFMetadataFromParsed()` via
  `getArchField(..., 'attention.sliding_window')`, and retain raw-metadata fallback for models
  recorded by older versions.
- [x] Add pure helpers for validation, config normalization, default candidate generation,
  deduplication, medians, weighted scoring, and deterministic tie-breaking in a focused internal
  module such as `src/utils/llama-calibration.ts`.
- [x] Runtime validation requires positive safe-integer context/slots/token counts, unique non-empty
  workload IDs, at least two shared-prefix suffixes, and exact `sharedPrefix + suffix`
  concatenation with no library-inserted delimiter. One workload may omit its weight and resolves to
  1; two or more workloads must all provide finite positive weights. Reject fixed/candidate key
  overlap and ambiguous default-KV opt-in combinations before provisioning.
  `kvPrecisionPreferencePct` must be finite and non-negative; reject negative, `NaN`, and infinite
  values before provisioning.
- [x] Add an internal read-only binary identity helper that returns pinned version, installed backend
  variant, and installed binary checksum from the already maintained validation data.

**Steps**:

1. Lock down type names and runtime validation errors.
2. Add metadata normalization without changing existing sizing behavior.
3. Implement and unit-test the bounded policy and scorer as pure functions.
4. Verify package-root declarations/exports.

**Verification**:

- [x] Build succeeds under strict TypeScript/ESM rules.
- [x] Policy never emits more than ten unique candidates.
- [x] Tests cover missing/old metadata, CPU-only and GPU dense/MoE/SWA models, fixed versus generated
  axes, caller combos, invalid cache/FA and MoE combinations, duplicates, all-failed reports,
  single-workload implicit weight, rejected missing multi-workload weights, scenario-frequency
  weighted scores, KV opt-in, rejected invalid precision percentages, 0%/10%/custom precision
  windows, and KV footprint grouping.
- [x] Existing `SystemInfo` recommendations and public `start()` arguments remain unchanged.

### Phase 2: Shared launch primitives and lifecycle-neutral runner

**Goal**: Start and stop calibration candidates without exposing them as production server state.

**Work**:

- [x] Extract current CLI construction from `LlamaServerManager.buildCommandLineArgs()` into a pure
  internal helper used by both production start and calibration; include an internal calibration
  option for the slots endpoint without exposing a new normal start flag.
- [x] Extract the quantized-V/flash-attention normalization currently inline in `start()` so production
  and calibration cannot drift.
- [x] Keep the public start generation/race/commit wrapper intact. First prove the behavior-only helper
  extraction against existing `LlamaServerManager` tests.
- [x] Add a lifecycle-neutral runner, likely `src/process/llama-server-runner.ts`, which owns only local
  PID, port, capacity, log tails, exit promise, and idempotent `stop()` state.
- [x] Make startup race health against process exit/error, timeout, and linked caller abort. Add
  optional linked-signal support to health and `/props` discovery (without changing existing callers)
  so cancellation does not wait for their independent timeouts. Retry a proven ephemeral-port bind
  collision once; score genuine model/backend failures normally.
- [x] Expose the runner's process exit/error promise to the calibration client. Race every `/tokenize`,
  slot erase, prime, and completion request against it so a mid-request process death is promptly
  classified as `crashed`, with exit code/signal/stderr, rather than misreported as a timeout.
- [x] Treat failed process teardown as an unsafe orphan state, not an ordinary candidate failure. Store
  its PID/diagnostics on the manager; entry guards recheck liveness and clear the state only once the
  PID is gone, otherwise reject normal start/restart/calibration with an actionable error.
- [x] Reuse `ProcessManager`, `findFreePort`, health checks, and `fetchLlamaRuntimeCapacity`, while never
  calling manager `handleExit`/`handleSpawnError`, `setStatus`, watchdog, restart, or event commit
  paths.
- [x] Bind candidates to `127.0.0.1`; never accept host/port/lifecycle fields through calibration.

**Steps**:

1. Extract/verify pure argv and cache/FA normalization.
2. Implement the isolated runner with bounded stdout/stderr capture.
3. Add abortable readiness and guaranteed stop/await-exit behavior.
4. Confirm production start emits byte-for-byte equivalent argv for existing configs.

**Verification**:

- [x] Existing lifecycle, argument, readiness, restart, watchdog, and occupancy tests stay green.
- [x] Runner tests cover ready, early exit, spawn error, startup timeout, abort, `/props` failure,
  slot mismatch, port collision retry, request-vs-exit races, and kill failure/orphan diagnostics.
- [x] Standalone runner state is local and it has no manager lifecycle callbacks.

### Phase 3: HTTP workloads and fixed-profile sweep

**Goal**: Execute the caller's serial request scenarios under the fixed production capacity profile
for every candidate with strict isolation.

**Work**:

- [x] Add a small internal HTTP client (for example `src/process/llama-calibration-client.ts`) for
  `/tokenize`, `/completion`, and slot erase. It must use linked timeouts/AbortSignal, strict response
  validation, and b9860-compatible timing normalization.
- [x] Verify the pinned b9860 slot-erase endpoint/response during implementation and lock it in tests;
  fail with an actionable setup error rather than silently benchmarking contaminated cache state.
- [x] Add `calibrating` state, `isCalibrating()`, and `start()`/second-calibration guards to
  `LlamaServerManager`. `stop()` remains a no-op while status is stopped; AbortSignal is the
  cancellation contract.
- [x] In `calibrate()`, validate the full config, fetch/validate the LLM model, initialize logging,
  resolve the baseline, and run strict occupancy checking before provisioning. This order matters:
  first-time `ensureBinary(modelPath)` validation can itself launch `llama-server` and load the
  model. Provision the binary once only after the occupancy rail passes.
- [x] Capture and report the pre-sweep resource snapshot and warn on large observable drift, but require
  callers to stop diffusion generation and other competing GPU work; custom manager instances have
  no authoritative global resource registry, so v1 cannot enforce full-machine exclusivity.
- [x] Treat initial binary provisioning as the documented cancellation exception in v1: check abort
  immediately before and after it and continue exposing existing binary progress events, but do not
  claim that an in-flight download/extraction/validation can be interrupted until BinaryManager has
  a first-class AbortSignal contract.
- [x] Generate or copy custom combos, then run the protocol above sequentially. Use a fresh port and
  fresh process per candidate, but one process for its warmup and timed samples. Generated candidates
  honor fixed axes and the opt-in KV flag; custom candidates replace generation exactly.
- [x] Treat prompt/workload validation as calibration-level errors; treat candidate startup/inference
  failures as runs so the sweep continues.
- [x] Preserve requested combo and concrete resolved config separately. Never save synthetic candidate
  config into the manager.

**Steps**:

1. Implement and test the HTTP request/response normalizer.
2. Add manager exclusivity and one-time preparation.
3. Add sequential candidate/workload/sample loops and exact bookkeeping.
4. Add per-candidate teardown and bounded resource settling in `finally`.

**Verification**:

- [x] Every candidate receives identical exact context, slots, workloads, seed, and output lengths.
- [x] Shared-prefix sequencing erases, primes, and times the intended slot in order, and reports
  observed cached tokens.
- [x] One failed candidate cannot abort later candidates or leak a server process.
- [x] Custom one-combo and narrowly selected sweeps work without generated extras.
- [x] Manager info/status/generation/config and normal lifecycle events remain unchanged throughout
  ephemeral runs; an unsafe orphan blocks subsequent lifecycle operations until confirmed gone.

### Phase 4: Report, recommendation, progress, and cancellation

**Goal**: Make results reproducible, UI-friendly, safely cancellable, and directly applicable.

**Work**:

- [x] Assemble the report with schema/policy versions; model ID/checksum/size/source revision and
  architecture; binary version/variant/checksum; OS version and discoverable GPU driver/runtime;
  stable hardware identity; diagnostic available RAM/VRAM; exact profile and normalized fixed
  config; verified capacity; workload hashes/token counts/weights; active and skipped candidates; combo
  source; raw samples; failures; and winner.
- [x] Represent model identity as a manifest over every shard/component path name, size, available
  checksum, and source revision rather than relying only on `ModelInfo.checksum` (which may be absent
  or cover only the first shard).
- [x] Echo one normalized methodology block containing samples, one warmup, seed, startup/request
  timeouts, resource cooldown, ordinary tie tolerance, KV-comparison opt-in, KV precision preference
  window, and scoring unit; these values affect eligibility or ranking and therefore belong in
  persistence invalidation.
- [x] Mark fingerprint confidence/cacheability. A stored model checksum plus complete binary/hardware
  identity is cacheable; missing checksum/revision or undiscoverable runtime identity makes the
  report best-effort and documentation must require recalibration after model, driver, OS, or
  backend-runtime changes.
- [x] Hash workload definitions with Node crypto and omit prompt text from reports/logs/errors.
- [x] Emit guarded callback and raw event progress with monotonic overall percentage. Consumer callback
  or listener exceptions are debug-logged and cannot fail calibration. Failed/skipped work is
  folded into completed progress units so the bar cannot stall below completion.
- [x] Classify failures using stage, child exit, bounded stderr, and patterns into `oom`,
  `startup-timeout`, `request-timeout`, `crashed`, or `error`.
- [x] On abort, stop and await the active candidate, then throw `ServerError` with
  `details.code === 'CALIBRATION_ABORTED'` and completed partial runs/report context in details,
  matching the diffusion convention.
- [x] In the outer `finally`, remove listeners, tear down any active runner, and restore saved private
  preparation state with nested cleanup so restoration still happens if kill fails. Clear the
  in-flight calibration lock only after safe teardown; if teardown cannot be confirmed, transition
  to the separate orphan guard described above and leave public status stopped without claiming the
  manager is safe to start.
- [x] Document persistence invalidation when any model checksum/revision, binary version/variant/
  checksum, hardware/OS/driver/runtime identity, exact profile, normalized fixed config, workload
  signature/weight, sample methodology, or policy version changes.
- [x] Standardize thrown `ServerError.details.code` values as `CALIBRATION_INVALID_CONFIG`,
  `CALIBRATION_SERVER_RUNNING`, `CALIBRATION_BUSY`, `CALIBRATION_RESOURCE_BUSY`,
  `CALIBRATION_SLOTS_UNAVAILABLE`, `CALIBRATION_PREPARATION_FAILED`, `CALIBRATION_ABORTED`, and
  `CALIBRATION_CLEANUP_FAILED`. Per-candidate failures remain structured report statuses.

**Steps**:

1. Add fingerprint and workload-signature helpers.
2. Connect run results to the pure scorer and recommendation.
3. Add progress accounting for all phases and skipped work.
4. Add abort/partial-results behavior and exhaustive cleanup.

**Verification**:

- [x] Reports contain enough information to reproduce/invalidate a persisted winner without raw
  prompts.
- [x] Shared-prefix runs are recommendation-ineligible when cache metrics are unobservable, but are
  not rejected merely because the observed hit is small.
- [x] Progress is monotonic, reaches 100 only on success, and callback/event payloads match.
- [x] Abort during startup, props, warmup, request, teardown, or between candidates normally leaves
  no PID and unlocks subsequent calls; simulated kill failure instead preserves PID diagnostics and
  proves subsequent lifecycle calls remain blocked until liveness recheck succeeds.
- [x] A report winner's `startConfig` can be spread directly into a normal start config and
  survives `ResourceOrchestrator` offload/reload unchanged.

### Phase 5: Deterministic test coverage

**Goal**: Cover policy, lifecycle, HTTP sequencing, and failure recovery without asserting noisy
wall-clock performance in CI.

**Work**:

- [x] Create `tests/unit/llama-calibration.test.ts` with scriptable process/fetch mocks, following the
  dedicated diffusion calibration suite rather than expanding the main manager suite indefinitely.
- [x] Cover required exact profile/workloads, explicit empty arrays, custom replacement semantics,
  model-aware defaults and cap, fixed/candidate overlap rejection, KV opt-in/default-off behavior,
  requested/resolved configs, fixed capacity, workload ordering, required slot evidence, cache
  timing observability/parsing, medians/weights/precision windows/ties, all-failed report, and
  complete methodology/fixed-config echo.
- [x] Cover OOM, early crash, startup/request timeout, invalid HTTP payload, warmup/sample failure,
  partial samples, and continuation to later candidates.
- [x] Cover pre-abort and in-flight abort through the shared runner/client signal boundaries and
  representative manager awaits, partial results, child
  cleanup, manager unlock/orphan guard, progress parity/monotonicity, and throwing progress
  consumers. Cover the documented before/after-only abort behavior around first-time provisioning.
- [x] Assert every documented `ServerError.details.code` at its public failure boundary so IPC/UI code
  does not depend on error-message parsing.
- [x] Extend `tests/unit/LlamaServerManager.test.ts` only for public-state/event non-regression and
  start/restart/calibrate mutual exclusion.
- [x] Extend `tests/unit/ModelManager.test.ts`, `tests/unit/defaults.test.ts`, and
  `tests/unit/public-types.test.ts` for normalized SWA metadata, exported policy, and package-root
  consumability.

**Steps**:

1. Test pure helpers before orchestration.
2. Test the runner/client independently.
3. Test the manager sweep through public APIs.
4. Run focused suites, then the complete suite with open-handle detection if needed.

**Verification**:

- [x] Tests never rank candidates by real elapsed CI time; timings are controlled fixtures.
- [x] Exactly one run is recorded per active candidate, with complete per-workload diagnostics.
- [x] Normal llama lifecycle tests remain green after every refactor phase.
- [x] No test leaves timers, fetches, or child-process handles open.

### Phase 6: Documentation and issue bookkeeping

**Goal**: Make the contract, tradeoffs, and caller responsibilities unambiguous without creating
duplicate durable documentation.

**Work**:

- [x] Add “Runtime Calibration” to `genai-electron-docs/llm-server.md`: fixed total vs effective
  per-slot context, single-versus-multiple workload weight rules, fixed config versus candidate axes,
  always-present per-workload results, default/custom candidates, scoring, application/persistence,
  progress/IPC, abort/error codes, statuses, exclusive-resource preconditions, the serial-slot
  methodology, and separate repeated calls at multiple context sizes. State clearly that KV
  cache quantization is supported but is never varied by the default sweep: the caller must opt into
  the bounded f16/q8 comparison or supply explicit custom KV combos, and controls the higher-
  precision preference window.
- [x] Add the exact public types and defaults to `genai-electron-docs/typescript-reference.md`.
- [x] Add feature navigation to `genai-electron-docs/index.md` and operational remedies to
  `genai-electron-docs/troubleshooting.md`.
- [x] Add a short calibration cross-reference to `genai-electron-docs/resource-orchestration.md` that
  owns only the fact that a caller-applied normal start config is already preserved across
  diffusion offload/reload; keep calibration usage itself in `llm-server.md`.
- [x] Update README's feature/API summary after implementation, but do not change its version header.
- [x] Add a concise PROGRESS “Unreleased” entry with tests/live-smoke evidence; do not add a migration
  guide or version/release metadata yet.
- [x] Rename the misleading root proposal to `ISSUE-llm-runtime-calibration.md` during implementation.
  After all verification, mark it resolved and move it to
  `docs/dev/issues/ISSUE-llm-runtime-calibration.md`, linking the durable plan and recording
  intentional deviations (fixed context, bounded core, report-only persistence, no helper
  dependency).
- [x] At implementation completion, move this approved root plan to
  `docs/dev/plans/PLAN-llm-runtime-calibration.md` as the durable implementation/design record; do
  not create a second completion report or devlog.

**Steps**:

1. Document the public API and copy-pasteable single-context example.
2. Add a repeated-call 8K/10K/12K example that compares reports in the consumer, not the library.
   Explain that comparing each context's own bounded default optimum is valid, while an exact
   flag-for-flag experiment must pass the same custom `combos` to every call.
3. Document cache invalidation and upstream-helper non-goals.
4. Update project bookkeeping only after implementation and verification are true.

**Verification**:

- [x] Documentation never describes `contextSize` as per-slot; it distinguishes configured total
  from `/props` effective per-slot capacity.
- [x] Examples pass exact production workloads/weights, show fixed axes and custom combos replacing
  defaults, and demonstrate both KV opt-in paths plus the default/custom precision window.
- [x] Docs clearly say calibration leaves the server stopped and does not persist/apply results.
- [x] No version bump, migration guide, release, or consumer-repository edit is included.

### Phase 7: Full verification and live smoke

**Goal**: Prove static correctness and exercise the real pinned server without turning one machine's
winner into a universal assertion.

**Work**:

- Run formatting, build, lint, full tests, `git diff --check`, and generated-declaration checks.
- Run a real Windows CUDA smoke with the GUI-provisioned b9860 binary and a known SWA model:
  - stopped-manager and strict occupancy preconditions;
  - a small custom candidate comparison proving SWA/prefix metrics and cleanup;
  - one bounded default-core sweep at a production context if runtime cost is acceptable;
  - two minimal independent calls at different contexts using identical workloads to confirm report
    separation, without asking the library for a cross-context winner.
- Verify every normal lifecycle field/event/generation remains unchanged during calibration, then
  start the normal server with the resolved winner, run a completion, offload/reload through the
  orchestrator if available, and stop cleanly.
- Record measured results as machine-specific evidence only. Cross-platform CPU/Metal/Vulkan smoke
  is best-effort unless those machines are available; CI coverage remains platform-neutral.

**Steps**:

1. Run focused and complete automated gates.
2. Run one serial real-hardware smoke with no parallel GPU work.
3. Inspect report privacy/fingerprint/applicability and process cleanup.
4. Run final `/doublecheck` against the approved plan and actual diff before declaring complete.

**Verification**:

- [x] `npm run format:check`
- [x] `npm run build`
- [x] `npm run lint` (0 errors; existing intentional warnings may remain)
- [x] `npm test`
- [x] `git diff --check`
- [x] Live server reports correct fixed context/slots, cache/prompt/prediction timings, and no
  leaked process.
- [x] Subsequent normal start and orchestration restore use the applied resolved winner.

## Documentation ownership

- `genai-electron-docs/llm-server.md` owns how consumers invoke and operationally use calibration.
- `genai-electron-docs/typescript-reference.md` owns the public type signatures.
- `genai-electron-docs/troubleshooting.md` owns failure remedies and stale-result guidance.
- `genai-electron-docs/resource-orchestration.md` owns only the applied-config preservation
  cross-reference.
- `PROGRESS.md` owns the concise unreleased change record.
- The archived issue owns proposal provenance/resolution; this plan owns implementation decisions,
  sequencing, verification, and intentional deviations. No additional design document is needed.

## Risks and mitigations

- **Lifecycle regression from refactoring `start()`:** extract pure argv/normalization first, keep
  public commit/race logic intact, and gate each phase on existing lifecycle tests.
- **Leaked model processes or GPU memory:** local runner state, nested `try/finally`, abort linked to
  every request/startup await, idempotent stop, confirmed exit before next candidate, and a fatal
  orphan guard if confirmed teardown is impossible.
- **Prompt-cache contamination:** controlled slot IDs, explicit erase before every sample, fresh
  process per candidate, pinned endpoint contract test.
- **Timing noise:** warmup, raw samples, medians, deterministic work, pure fixture-driven scorer,
  and explicit ordinary/precision windows. Never make CI assert a real machine's winner.
- **Server API drift:** strict response parsing and report binary fingerprint; implementation targets
  pinned b9860 behavior and fails actionably on incompatible endpoints.
- **Search explosion:** pure policy cap of ten, stable deduplication, and no independent product of
  all fields.
- **Wrong production proxy:** require caller workload content/shape and, for multi-workload sweeps,
  explicit production-frequency weights; document that a changed request mix invalidates persisted
  results.
- **Prompt/privacy leakage:** hash signatures and token counts only; never echo prompts into report,
  logs, progress, or error details.
- **Port/occupancy races:** strict common-port safety rail, loopback-only candidates, fresh ephemeral
  port, one retry only for a proven bind collision.
- **Report bloat:** bounded stderr, fixed sample count by default, no output text or prompt text.
- **Misleading “thrash” diagnosis:** report slow successful timings and explicit hard failures, but
  do not infer an unobservable memory-management state.

## Rollback

The feature is additive and v1 writes no calibration database. If implementation must be rolled
back, remove the new manager methods/types/defaults/runner/client/tests/docs and restore the small
production helper call sites to their pre-extraction bodies. Existing model metadata remains
forward/backward compatible because the normalized sliding-window field is optional and raw GGUF
metadata is preserved. No user data migration or persisted library state requires cleanup.

## Open questions

None blocking. Approval of this plan confirms the fixed-context-per-call contract, required
workloads with explicit multi-workload production-frequency weights, bounded default policy with KV
precision fixed unless the caller opts in, a default 10% higher-precision preference window,
fixed-config/candidate-axis separation, serial controlled-slot methodology, report-only persistence,
and deferral of auxiliary llama.cpp executables.

---
**Please review. Edit directly if needed, then confirm to proceed.**
