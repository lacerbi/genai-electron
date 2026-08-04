# Plan: Simplify Adaptive Calibration

- Created: 2026-08-04
- Approved: 2026-08-04
- Status: COMPLETE
- Target: correct the unreleased schema-v4 adaptive-calibration implementation; no package version,
  release PR, tag, GitHub release, or npm publication until explicitly requested

Sources:

- `docs/dev/issues/ISSUE-adaptive-calibration-budget-resume.md` - production evidence that the old
  time/probe reserves could withhold a useful result
- `docs/dev/plans/PLAN-time-first-adaptive-calibration.md` - completed record of the first unreleased
  schema-v4 implementation; this plan supersedes only its clock, admission/finalization,
  evidence-ranking, stall-fuse, public-timing, and resource-failure-selection decisions
- `docs/dev/plans/PLAN-calibration-resource-stability.md` - implemented fixed-baseline measurement
  validity; retain its boundary rejection and cleanup guarantees
- `PROGRESS.md` - current unreleased summary and automated-validation baseline

## Summary

Replace the current estimate-and-finalize adaptive controller with a direct elapsed-time procedure:
keep the best clean incumbent after every accepted probe, continue the ordinary structural search
while the caller's actual time and optional probe cap permit another launch, and return the incumbent
when a hard limit arrives. Reproduction and full search resolution remain useful evidence, but are
not reserved or required before `selected` can be returned.

Make evidence descriptive except for one bounded uncertainty tie-break, make omitted `maxProbes`
genuinely unbounded, preserve a host-usable best-known result when a later resource boundary rejects
the run, and remove speculative scheduling details from the public API. The library remains
lifecycle-neutral: it never applies or persists a result itself, while the host may apply, persist,
present, or ignore any application-ready result it receives.

This is a correction to unreleased schema v4, not a new v5 design. Exact-mode scheduling and ranking
remain unchanged. No live or hardware calibration belongs in this plan.

## Scope

### In scope

- One fixed 60-minute adaptive default with arbitrary positive caller overrides.
- Method-entry elapsed-time accounting, including precondition checks, preparation, baseline
  collection, and probes; already-started owned work may settle past the deadline and must report
  that overrun honestly.
- Manager-owned hard deadline and optional probe-cap admission.
- Removal of configured/observed admission estimates, the 1.2 margin, time/probe reservations,
  explicit finalization state, and the derived attempt-count ceiling.
- Best-clean incumbent derivation where evidence only resolves candidates equivalent under the
  existing fidelity-specific uncertainty rules.
- Application-ready clean pre-failure evidence on typed resource-stability errors.
- A smaller draft-v4 progress, budget-report, defaults, and package-export surface.
- Deterministic tests, packed-consumer checks, harness updates, and current documentation updates.

### Out of scope

- Cross-call resume or evidence seeding.
- Changes to exact combo order, ordinary exact ranking, or one-launch-per-combo behavior.
- A new validation-priority scheduler; single-launch evidence remains a valid normal partial result.
- Weakening cleanup confirmation, orphan protection, context/slot verification, prompt redaction,
  caller-abort precedence, or resource-invalid probe exclusion.
- Host UI implementation, duration presets, consent requirements, persistence, or automatic apply.
- Rewriting v0.20 or older release history, migrations, plans, or committed trace artifacts.
- Live model/GPU validation, package version changes, release work, or publication.

### Explicit follow-up, not part of this implementation

Investigate whether conservative `getOptimalConfig()` anchors and limited cross-cell boundary
transfer burn avoidable probes by creating unnecessarily wide initial intervals. Keep this visible as
a later search-efficiency improvement; do not mix it into the budget/controller simplification.

## Approved behavioral contract

1. **Good result, not optimality proof.** Adaptive calibration continuously retains the best clean
   measured incumbent. A partial search may return `selected`; `selectionEvidence` and
   `searchCompleteness` state exactly what is and is not known.
2. **Time is the normal resource.** `maxWallTimeMs` defaults to 60 minutes. The monotonic clock starts
   synchronously at `calibrate()` method entry and includes orphan/precondition checks, validation,
   preparation, binary readiness/validation, resource-baseline work, and probes. Invalid input,
   busy/orphan state, and other precondition errors retain their typed exceptional behavior rather
   than being disguised as time limits.
3. **The maximum is an admission/cancellation deadline, not a settlement SLA.** At the deadline, no
   new preparation operation or probe starts and active abortable work is signaled. Already-started
   work must still settle safely: stream/child shutdown, staging cleanup, a non-interruptible install
   commit, probe teardown, and resource confirmation may finish afterward. Reports expose actual
   elapsed time plus `overrunMs`; the library neither hides the overrun nor reserves speculative time
   to avoid it. The measurement endpoint is after all library-owned async work and manager
   restoration/unlocking, but before invoking terminal host callbacks/listeners and returning or
   throwing; host callback execution is not calibration work.
4. **No speculative admission.** If the structural policy asks for a probe and the real deadline and
   optional probe cap have not been reached, the manager may launch it. It does not reserve time or
   slots for a hypothetical validation launch and does not use timeout maxima or observed-duration
   estimates to deny work.
5. **Reproduction is ordinary work.** Existing finalist, winner-validation, and reference-guard
   actions may still arise from the structural search. They receive no protected time or probe slots.
   If they do not happen before a limit, the weaker clean incumbent remains usable and accurately
   labeled.
6. **No hidden probe cap.** Omitted `maxProbes` means no count-based limit. Remove the derived
   `max(64, cells * (layers + 1) * 8)` ceiling and `CALIBRATION_POLICY_STALLED`. The wall deadline
   bounds production execution; transition assertions may reject an actual state/action invariant
   violation but may not count otherwise legal probes.
7. **Probe caps count policy-runner invocations.** Immediately before invoking the probe executor,
   the manager reserves the next public `probeIndex` and consumes one cap unit. Runner-internal
   process-start retries do not consume extra units. Startup failure, capacity rejection, and
   deadline interruption consume the one attempted public probe; a failure before executor
   invocation does not. Every non-exceptional attempted probe has one chronological trail record.
   Natural completion after the last accepted probe is evaluated before `probe-limited`. Adaptive
   progress retains top-level `completedProbes` as the number of settled chronological probe records;
   it is useful display/diagnostic data but does not drive scheduling. While a probe is active,
   `remainingProbes` may already reflect its consumed cap unit before `completedProbes` increments.
8. **Evidence only resolves uncertainty-equivalent candidates.** Build the existing clean per-point
   incumbent and score, retain the two-stage reduction (within each cell, then globally), and retain
   `competitiveObservedRatio()` for conservative cell competitiveness. At each reduction, remove the
   old strongest-evidence prefilter and let the existing raw-score context/KV rules choose the
   product class. Inside that class:
   - normally, the final equivalence set remains the candidates within `tieTolerancePct` of the raw
     class-fastest score;
   - if the raw class-fastest incumbent is `single-search-launch`, also admit only stronger-evidence
     candidates whose raw score is within `searchNoiseAllowancePct` of that fastest score, using the
     same `(slower - faster) / faster` percentage definition as `spreadPct()`;
   - order the resulting set by lower GPU layers, `swaFull: false`, stronger evidence, lower raw
     score, then cell order.

   Thus same-strength comparisons retain the ordinary tie band, and a single-search result displaces
   stronger evidence on performance only when the gap is greater than
   `searchNoiseAllowancePct`. Evidence never overrides context/KV product preferences, structural
   safety, or a score gap outside its declared uncertainty allowance. The chosen point still reports
   `independent-reproduction`, `single-full-launch`, or `single-search-launch` literally.
9. **Invalid observations remain excluded.** Deadline-interrupted, caller-aborted,
   cleanup-unconfirmed, capacity-unverified, capped/incomplete, and resource-invalidated launches do
   not displace a prior clean incumbent. This is measurement/process validity, not a completeness
   requirement.
10. **Resource rejection preserves earlier clean value.** A confirmed or unverifiable resource
    boundary still throws `LlamaCalibrationResourceStabilityError` and invalidates the affected
    probe. Its partial report may also carry a start-ready best-known result derived solely from
    earlier accepted evidence. The host decides whether to use it.
11. **Host policy remains outside the library.** `calibrate()` leaves the manager stopped. No API,
    documentation, or example requires confirmation, automatic application, persistence, or a
    notification. Specific host duration presets are not library guidance.
12. **Keep draft schema v4.** Because the current v4 contract has not been released, correct it in
    place under `llama-runtime-v4`. Do not create v5 merely to version an unshipped intermediate
    design.

## Public contract target

The following names and invariants are the implementation target. A discovery that requires a
broader or materially different public shape returns to discussion rather than growing an optional
property bag during implementation.

```typescript
interface LlamaCalibrationReportBase {
  resultKind: 'report';
  // Existing ordinary report fields remain.
}

interface LlamaAdaptiveCalibrationConfig {
  // Existing model, profiles, workloads, and fixed settings remain.
  maxWallTimeMs?: number; // positive safe integer; default 60 minutes
  maxProbes?: number; // optional; omission means no count limit
}

type LlamaAdaptiveProgressBudget = {
  maxWallTimeMs: number;
  remainingMs: number;
} &
  (
    | { maxProbes?: never; remainingProbes?: never }
    | { maxProbes: number; remainingProbes: number }
  );

interface LlamaAdaptiveCalibrationBudgetReport {
  maxWallTimeMs: number;
  /** Method entry through completion/restoration of all library-owned work. */
  elapsedMs: number;
  /** max(0, elapsedMs - maxWallTimeMs), with no double counting. */
  overrunMs: number;
  maxProbes?: number;
}

type NonEmptyProbeIndexes = readonly [number, ...number[]];

interface LlamaAdaptiveCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: LlamaAdaptiveCalibrationSelectionEvidence;
  sourceProbeIndexes: NonEmptyProbeIndexes;
}

interface LlamaExactCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: 'single-launch-measurement';
  sourceProbeIndexes: NonEmptyProbeIndexes;
}
```

Model ordinary adaptive selection as an atomic union, not two unrelated optionals:

```typescript
type LlamaAdaptiveSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: LlamaAdaptiveCalibrationSelectionEvidence;
    }
  | { selected?: never; selectionEvidence?: never };

type LlamaExactSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: 'single-launch-measurement';
    }
  | { selected?: never; selectionEvidence?: never };

type LlamaCalibrationResourceFailurePartialReport =
  | (Omit<
      LlamaCalibrationPartialReport,
      'strategy' | 'status' | 'cleanupConfirmed'
    > & {
      strategy: 'adaptive';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness: 'partial';
      budget: LlamaAdaptiveCalibrationBudgetReport;
      bestKnown?: LlamaAdaptiveCalibrationBestKnown;
    })
  | (Omit<
      LlamaCalibrationPartialReport,
      'strategy' | 'status' | 'cleanupConfirmed'
    > & {
      strategy: 'exact';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness?: never;
      bestKnown?: LlamaExactCalibrationBestKnown;
    });
```

Intersect the relevant selection union into each ordinary report. Index uniqueness, ascending order,
range, and accepted-probe membership remain runtime/report-builder invariants in addition to the
non-empty tuple type.

Keep the importable package-root type set intentionally small: export the existing adaptive
progress/report budgets, the preparation-time-limit result, both strategy-specific `BestKnown`
payloads, and the resource-failure partial union. `NonEmptyProbeIndexes` and the two selection-pair
types are declaration-internal helpers, not new package-root exports.

Public removals in the corrected v4 surface (some replace unreleased draft-v4 additions; explicitly
marked items were already public in v0.20 and require release-time migration coverage):

- `LlamaAdaptiveCalibrationMode` and progress `mode`;
- progress `clock`, duplicate `budgetElapsedMs`, `remainingBudgetMs` (replaced by `remainingMs`),
  `probeLimit`, `estimatedNextProbeCycleMs`, and `estimatedFinalizationCycleMs`;
- report budget `policy`, `probeLimit`, `completedProbes` (the probe trail is authoritative on every
  returned ordinary report),
  `preparationElapsedMs`, `budgetElapsedMs`, `cleanupOverrunMs`, `enteredFinalization`,
  `finalizationStartedAtBudgetMs`, `durationEstimation`, and `overrides`;
- `LlamaCalibrationProbeLimit` when optional `maxProbes` is sufficient;
- `adaptiveAdmissionMarginMultiplier` and the released time-admission-only
  `unobservedProbeDurationPolicy` default;
- the newly introduced public `resolveLlamaCalibrationTimeBudget()` and its public helper types;
- `AdaptivePolicyStalledError` / `CALIBRATION_POLICY_STALLED`;
- schema-v4 `diagnosticCandidate` plus the released
  `LlamaCalibrationDiagnosticCandidate` / `LlamaCalibrationDiagnosticEvidenceLevel` exports, in
  favor of strategy-correct host-usable `bestKnown` payloads. Do not retain deprecated aliases for a
  contract that no longer has diagnostic-only semantics; document the removal at release.

Retained public behavior:

- adaptive terminal statuses, `searchCompleteness`, `terminalReason`, `selected`, and
  `selectionEvidence`;
- top-level adaptive progress `completedProbes`; remove only its redundant report-budget copy;
- existing profiles, cells, probes, preference diagnostics, fallback, methodology, identity,
  cacheability, warnings, and resource-monitoring records unless a direct type dependency requires
  a narrow edit;
- exact report/progress behavior and exact `confidence`;
- `LlamaCalibrationResourceStabilityError` and its two details codes.

### Preparation-time expiry

The elapsed clock must not silently reset after preparation. The genuinely long interruptible
preparation paths—binary download and binary-validation child processes—receive the internal
deadline signal. Other preparation work is checked before and after, awaited as an owned
settle-to-completion section if the deadline arrives in flight, and counted as overrun. Shared helper
behavior is unchanged when no signal is provided.

If the deadline arrives before the fixed resource baseline and ordinary report identity are both
complete, return this deliberately small result rather than fabricating report fields or converting
the chosen limit into a generic failure:

```typescript
interface LlamaAdaptiveCalibrationPreparationTimeLimit {
  resultKind: 'preparation-time-limit';
  schemaVersion: 4;
  policyVersion: 'llama-runtime-v4';
  createdAt: string;
  strategy: 'adaptive';
  phase: 'preparing';
  status: 'time-limited';
  searchCompleteness: 'partial';
  terminalReason: string;
  budget: LlamaAdaptiveCalibrationBudgetReport;
  probes: readonly [];
  warnings: readonly string[];
  cleanupConfirmed: true;
  selected?: never;
  selectionEvidence?: never;
}
```

It has no optional identity/monitoring bag. Once identity and the fixed baseline exist, every later
ordinary terminal uses the normal adaptive report, even if the deadline is noticed before the first
probe. Add this member to `LlamaCalibrationReport`; every ordinary adaptive and exact report carries
`resultKind: 'report'`, making `resultKind` a total exhaustive discriminant before consumers narrow
ordinary reports by `strategy`.

## Execution tracking

- [x] Phase 1: freeze the simplified draft-v4 API and preparation-time branch
  - [x] Apply the approved public type, default, and package-export surface
  - [x] Update compile fixtures and make implementation consumers conform
- [x] Phase 2: separate structural policy from manager-owned resource limits
- [x] Phase 3: enforce one total elapsed deadline through preparation and probing
  - [x] Move deadline/cap ownership, elapsed reporting, and terminal publication into the manager
  - [x] Verify binary cancellation, cleanup, fallback, and installed-binary integrity
  - [x] Stamp the returned redacted resource-error budget after manager restoration
- [x] Phase 4: expose clean pre-resource-failure best-known results
  - [x] Preserve repeated application-ready config references during error redaction
- [x] Phase 5: update consumers and current documentation
  - [x] Version and Node-test the quiet-trace schema-v4 summarizer without changing artifacts
- [x] Phase 6: run automated validation and double-check
  - [x] Resolve final lifecycle review findings
    - [x] Await and clean up an aborted active download pipeline
    - [x] Preserve fatal-probe trail and deadline precedence after cleanup
    - [x] Make binary installation commit complete-or-restore
    - [x] Confirm validation-child termination with bounded escalation
    - [x] Attach settled deadline observations and preserve one fatal-probe record/precedence
    - [x] Recheck cancellation before costly provisioning checksums
  - [x] Correct stale schema/resource-best-known documentation found by review
  - [x] Remove the unapproved adaptive-terminal-status package-root export

## Phases

### Phase 1: Freeze the smallest truthful v4 contract

**Goal:** Remove unneeded scheduling internals before modifying execution and define every terminal
shape, including expiry during preparation.

**Work:**

- Add compile-time fixtures for the minimal progress budget, report budget, ordinary adaptive
  results, preparation-time-limited results, exact results, generic partials, and resource-failure
  partials.
- Remove public finalization, estimation, margin, probe-limit-discriminant, resolver, and stalled
  policy symbols listed above.
- Keep `LLAMA_CALIBRATION_DEFAULTS.adaptiveMaxWallTimeMs` as the single 60-minute default.
- Represent an omitted probe cap through absent `maxProbes`/`remainingProbes`, never `Infinity` or a
  large numeric sentinel; the progress union makes the two bounded fields present or absent
  together. Keep elapsed time only in the existing progress base so it cannot disagree with budget
  data, and retain top-level progress `completedProbes` outside that budget.
- Add total `resultKind: 'report' | 'preparation-time-limit'` discrimination across every
  `LlamaCalibrationReport` member; strategy narrowing happens only inside ordinary reports.
- Add strategy-discriminated resource-failure `bestKnown`; recommendation, strategy-correct evidence,
  and non-empty source indexes are present together or absent together.
- Use atomic selected/evidence unions for adaptive and exact ordinary reports, and require the
  preparation branch to prohibit both fields at compile time.
- Preserve schema 4 / `llama-runtime-v4` and exact-mode narrowing.
- Do not remove unrelated diagnostic fields merely because a smaller report could be imagined.

**Steps:**

1. Write positive and negative TypeScript fixtures before changing exports.
2. Edit `src/types/llm-calibration.ts`, type barrels, and package-root exports.
3. Consolidate the internal default resolution without exporting a replacement public resolver.
4. Inspect generated declarations and the packed consumer for accidental scheduling internals.

**Verification:**

- [x] Progress/report types expose real elapsed time and optional probe counts only.
- [x] Progress retains top-level `completedProbes`; the report budget does not duplicate the probe
      trail count.
- [x] Preparation expiry is a normal typed adaptive result with no fabricated fields, and an
      exhaustive `resultKind` switch separates it from every ordinary adaptive/exact report.
- [x] `selected`/`selectionEvidence` and strategy-correct resource `bestKnown` pair atomically.
- [x] Resource-failure partials reject `status: 'aborted'`, `cleanupConfirmed: false`, wrong-strategy
      evidence, empty indexes, and adaptive partials without a budget at compile time.
- [x] Exact config rejects adaptive budgets and exact ordinary result semantics are unchanged.
- [x] No unreleased v4 consumer can reference finalization, estimates, the 1.2 margin, or the new
      resolver.

### Phase 2: Make the structural policy budget-agnostic

**Goal:** Let the pure policy choose useful structural work while the manager alone owns wall time
and optional launch count.

**Work:**

- Remove configured/observed cycle-estimate inputs and functions, admission decisions, run mode,
  finalization cause/queue, and the evidence-count attempt ceiling.
- Keep ordinary finalist, winner-validation, and reference-guard actions where the structural state
  machine naturally requests them; remove only protected scheduling. `fallback` remains a derived
  report field and must not regain a scheduled validation action.
- Make `nextAdaptivePolicyAction()` return natural terminals or the next structurally legal probe
  without inspecting elapsed time or probe budgets.
- Add a pure helper that derives a time/probe-limited terminal from current committed evidence when
  the manager denies the next launch.
- Change incumbent reduction exactly as frozen in decision 8: keep per-point score construction,
  two-stage competition, raw-score context/KV preferences, and structural priorities; replace the
  broad evidence-tier prefilter with the bounded single-search uncertainty tie-break. Keep evidence
  labeling truthful.
- Preserve natural completion requirements: `complete` may still require resolved decision-relevant
  work and reproduced evidence, but incomplete evidence may still be `selected` on partial outcomes.

**Steps:**

1. Delete estimation/finalization/stall types and helpers; simplify immutable policy state/actions.
2. Rebuild the action loop around structural planning and natural terminal detection.
3. Remove the strongest-evidence prefilter, preserve `competitiveObservedRatio()` for cell
   competitiveness, and implement the deterministic final-class equivalence/order rule from
   decision 8 without adding a new constant.
4. Update pure traces and property-style tests without adding a replacement probe-count guard.

**Verification:**

- [x] A legal next probe is never denied for a hypothetical later validation.
- [x] A trace can exceed the former derived attempt ceiling when time is external and `maxProbes` is
      omitted.
- [x] Explicit cap and deadline terminals retain reproduced, single-full, and single-search
      incumbents.
- [x] A single-search class-fastest candidate remains selected over structurally equivalent stronger
      evidence when its raw advantage is greater than `searchNoiseAllowancePct`; at or inside that
      allowance, stronger evidence precedes lower raw score after the existing structural priorities.
- [x] Same-strength comparisons retain the ordinary `tieTolerancePct` band, and context/KV product
      preferences remain ahead of evidence.
- [x] Natural complete/no-viable/inconclusive behavior remains deterministic.

### Phase 3: Enforce one total elapsed deadline in the manager

**Goal:** Make the selected duration describe elapsed adaptive-call work from method entry, with an
honest and narrowly defined settlement overrun.

**Work:**

- Capture the monotonic epoch as the first synchronous statement in `calibrate()`. After validation
  establishes adaptive mode, derive its absolute deadline from that epoch; do not reset it after the
  lock, preparation, or baseline. Combine deadline and caller signals while preserving their source.
  On simultaneous cancellation, caller abort remains exceptional and takes precedence over an
  ordinary time-limited result.
- Make preparing progress start with elapsed/remaining time already running; `policy-ready` remains a
  phase event but never resets the clock.
- Inventory every await before `policy-ready` and classify it in code/tests as deadline-aware or an
  owned settle-to-completion section: orphan/precondition check, validation/model lookup, log
  initialization, occupancy check, forced system detection and its GPU/memory commands, binary
  selection/download/checksum/archive verification/extraction/dependency handling/install,
  installed-binary identity, CUDA filtering, per-profile auto-configuration, and fixed-baseline
  telemetry. Check the deadline before and after every category.
- Add optional signal plumbing only where preparation may bind for a material time and interruption
  is clean: binary download and binary-validation child processes, through
  `LlamaServerManager.ensureBinary()`, `ServerManager.ensureBinaryHelper()`, `BinaryManager`, and
  `Downloader`. Abort closes the download stream, kills and awaits validation children, removes
  staging/partial artifacts, and short-circuits binary variant/dependency fallback rather than trying
  more work. Active calibration probes retain their existing deadline cancellation. Ordinary
  unsignaled binary/download behavior remains unchanged.
- Do not thread deadline signals through checksum streaming, archive verification/extraction,
  occupancy checks, system detection, CUDA filtering, auto-configuration, or resource telemetry.
  Check the deadline around these bounded operations; if it arrives in flight, await the owned work
  and report the time in `overrunMs`.
- Preserve install integrity across cancellation. Fully download, verify, and stage a replacement
  before touching the live installation. Recheck the deadline before commit; once the commit begins,
  treat it as an owned non-interruptible section and either complete it or restore the prior
  installation before returning. Never start another variant or dependency after cancellation.
  Archive extraction or another library call that cannot be interrupted is likewise awaited as one
  owned section and its post-deadline time is reported as overrun.
- Never use `Promise.race` in a way that leaves downloads, validation children, subprocesses, or
  staged installation work alive.
- Before each discretionary preparation step and probe launch, recheck the real deadline. After the
  structural policy returns a probe, check explicit `maxProbes`, reserve its public index, decrement
  the cap, then invoke the executor. Runner-internal retries retain that one index and consume no
  additional cap.
- Give an active probe only the remaining total time. If it is interrupted, append an honest
  quarantined trail record, finish mandatory cleanup/resource confirmation, and derive the result
  from the prior committed state.
- Freeze executor-boundary precedence: snapshot deadline/caller interruption when the executor
  settles. A deadline already active then quarantines that probe. A probe that settled before the
  deadline is not invalidated merely because teardown or post-cleanup resource confirmation crosses
  it; after valid cleanup, commit the observation, evaluate typed resource failure, then natural
  structural completion before returning `time-limited`.
- Keep caller abort, cleanup/orphan failure, and typed resource-stability failure exceptional and
  higher priority than an ordinary time limit. The resource-invalid current probe is never committed;
  earlier clean evidence may still populate its error's `bestKnown`.
- Build progress/report elapsed from method entry. Progress `remainingMs` clamps at zero. Restructure
  completion so the manager first awaits all owned work and restores/unlocks itself, then captures
  one final monotonic timestamp, builds/stamps the terminal report or typed error, emits terminal
  progress/callbacks, and returns or throws. Final `elapsedMs` is entry-to-library-settlement and
  `overrunMs` is exactly
  `max(0, elapsedMs - maxWallTimeMs)` for preparation expiry, probe expiry, and resource-confirmation
  overrun—never a second duration added on top. Time spent inside terminal host callbacks/listeners
  and the final synchronous handoff is deliberately excluded.
- Base deadline decisions on an absolute monotonic timestamp, not timer duration. For overrides above
  Node's single-timer range, re-arm a timer in safe chunks while checking the same absolute deadline;
  arbitrary positive safe-integer overrides must not fire early.

**Steps:**

1. Introduce one method-entry deadline owner, chunk-safe timer, and tested caller/deadline signal
   classifier.
2. Complete the preparation-await inventory; thread optional cancellation only through binary
   download/validation and make binary staging/abort/commit behavior safe without altering
   unsignaled behavior.
3. Replace policy-clock calculations and post-preparation reset points with total elapsed time.
4. Move time/probe admission to the manager boundary immediately before each launch.
5. Route preparation expiry, pre-launch expiry, in-flight expiry, and settlement overrun through
   centralized terminal/result builders.

**Verification:**

- [x] Fake precondition, provisioning, baseline, and probe durations consume the same method-entry
      maximum; validation failures still report validation errors.
- [x] No new discretionary work begins after the deadline.
- [x] Expiry during binary download/validation cancels work, attempts no fallback variant, leaves no
      partial file or child, and preserves/restores the prior installed binary.
- [x] Expiry during preparation returns the typed preparation-time-limited result.
- [x] Expiry during a later probe preserves the prior clean incumbent and invalidates the interrupted
      probe for policy use.
- [x] Owned settling work may overrun, is measured once by the elapsed/overrun invariant, and leaves
      the manager stopped/unlocked with no background work.
- [x] Explicit `maxProbes: 1` permits exactly one launch and then returns its clean incumbent; omission
      imposes no count limit.
- [x] A probe settled before the deadline remains eligible when valid cleanup crosses the deadline;
      natural completion and resource-error precedence are deterministic.
- [x] A wall-time override above `2^31 - 1` ms does not expire early.

### Phase 4: Make clean pre-failure evidence host-usable

**Goal:** Preserve measurement-validity rejection without imposing a host application policy on
earlier clean evidence.

**Work:**

- Replace the schema-v4 diagnostic-only resource candidate with the strategy-discriminated atomic
  `bestKnown` variants frozen in Phase 1. The adaptive resource partial always states
  `searchCompleteness: 'partial'`; exact retains its strategy's existing completeness semantics.
- For adaptive mode, derive it through the same uncertainty-bounded incumbent helper used by ordinary
  limit results; allow single-search, single-full, or reproduced evidence.
- For exact mode, derive it from earlier accepted clean `runs` using existing exact ranking and
  `single-launch-measurement` evidence.
- Map internal evidence indexes to chronological public probe indexes and verify every cited probe is
  accepted, operationally complete, capacity-verified, uncapped, cleanup-confirmed, unique,
  ascending, and in range.
- Never include the resource-invalidated boundary probe. A first-probe rejection has no `bestKnown`.
- Keep the typed resource error, failure boundary diagnostics, prompt redaction, and cleanup
  precedence unchanged.
- Centralize repeated partial-report construction where doing so reduces duplication without
  changing unrelated error behavior.

**Verification:**

- [x] Adaptive resource rejection after clean evidence exposes a start-ready recommendation with
      truthful evidence and source indexes.
- [x] Exact rejection after a clean earlier combo exposes that existing exact recommendation.
- [x] Invalidated, interrupted, capped, or cleanup-unconfirmed probes cannot support `bestKnown`.
- [x] Cleanup failure and caller abort do not masquerade as resource-selection results.
- [x] Hosts are free to use or ignore `bestKnown`; library code performs no application or persistence.

### Phase 5: Update consumers and current documentation

**Goal:** Present the simple contract without host-specific presets or product-policy suggestions.

**Work:**

- Update the packed API fixture for the reduced v4 progress/report shapes, removed exports, exact
  non-regression, preparation-time result, and resource `bestKnown`.
- Update the quiet-trace summarizer/config documentation for total elapsed time and no finalization or
  duration-estimation fields. Preserve committed historical JSON artifacts unchanged.
- Rewrite current LLM calibration docs around: one total clock, no speculative reservation, best
  clean incumbent, the bounded single-search uncertainty tie-break plus literal evidence metadata,
  optional real probe cap, and host-owned application.
- State that `single-full-launch` and, on especially slow hardware, `single-search-launch` are usable
  expected limit outcomes rather than calibration failures; the host can present their literal
  evidence without the library withholding the recommendation.
- Document exhaustive result narrowing as `resultKind` first, then `strategy` for ordinary reports.
- Document that explicit `maxProbes` counts attempted executor launches, including startup failure,
  capacity/OOM rejection, and deadline interruption, while runner-internal start retries do not
  consume additional units.
- Remove specific duration preset/default examples and optional UI-notification/confirmation recipes;
  retain only the neutral guidance that a host may expose arbitrary `maxWallTimeMs` choices and owns
  whether to apply, persist, present, or ignore the result.
- Update only current files that actually contain affected claims: expected targets are `README.md`,
  `AGENTS.md`, LLM server docs, integration guide, troubleshooting, TypeScript reference,
  resource-orchestration guide, documentation index/navigation if its summaries changed, and only
  the Unreleased section of `PROGRESS.md`. Do not spread example host durations into unrelated files.
- Add a short supersession link from the archived issue and the original time-first plan to this
  plan. Do not rewrite their production evidence or completed implementation history.
- Do not create a migration guide until release is explicitly requested. At release time, migration
  must describe only shipped v0.20-to-release changes: removal of `targetProbes`, the unbounded default
  for omitted `maxProbes`, removal of the diagnostic candidate/evidence exports and
  `unobservedProbeDurationPolicy`, the unversioned progress-payload changes, status/provisional and
  report-budget changes, the new total `resultKind` discriminator, and removal of the old
  cell-derived budget resolver. Do not mention the unshipped draft-v4 time-budget resolver or other
  intermediate churn in user migration prose.

**Verification:**

- [x] No current documentation describes reserved validation time, finalization mode, duration
      estimates, broad evidence-tier gating, hidden probe ceilings, or diagnostic-only clean
      pre-failure evidence.
- [x] No current documentation contains host-specific duration presets or prescribes confirmation,
      automatic application, persistence, or notification.
- [x] Historical migrations/plans/release records and trace artifacts remain accurate history.
- [x] Packed declarations expose only the intended draft-v4 surface.

### Phase 6: Automated validation and double-check

**Goal:** Prove the simplification and preserved safety properties without a live calibration.

**Focused automated matrix:**

- `tests/unit/defaults.test.ts`
- `tests/unit/llama-adaptive-calibration-policy.test.ts`
- `tests/unit/llama-adaptive-calibration-manager.test.ts`
- `tests/unit/llama-calibration-policy.test.ts`
- `tests/unit/llama-calibration.test.ts`
- `tests/unit/public-types.test.ts`
- `tests/unit/error-helpers.test.ts`
- `tests/unit/Downloader.test.ts`
- `tests/unit/BinaryManager.test.ts`
- `tests/unit/LlamaServerManager.test.ts`
- `tests/integration/BinaryManager-cache.test.ts`

**Required deterministic scenarios:**

- orphan/precondition, preparation, and baseline time consume the method-entry limit;
  `policy-ready` does not reset progress;
- deadline during preparation cancels owned I/O/processes and returns an honest partial adaptive
  result;
- binary cancellation short-circuits variant/dependency fallback, cleans staging, and preserves or
  restores the prior installation; unsignaled binary/download behavior is unchanged;
- no estimate or reserved validation prevents useful work before the hard limit;
- an active deadline quarantines only the interrupted launch and preserves a prior incumbent;
- omitted `maxProbes` exceeds both the old 23-probe behavior and the removed derived attempt ceiling;
- explicit caps count actual launches exactly, with natural-completion-before-limit precedence;
- progress `completedProbes` counts settled public trail records while an active invocation has
  already reduced bounded `remainingProbes`;
- same-strength comparisons use `tieTolerancePct`; a raw class-fastest single-search result admits
  stronger evidence through the inclusive `searchNoiseAllowancePct` boundary but wins on performance
  beyond it;
- final tie ordering remains lower GPU layers, `swaFull: false`, stronger evidence, lower raw score,
  then cell order, with accurate evidence labels;
- adaptive and exact resource failures expose only clean prior `bestKnown` evidence;
- resource-invalid evidence, caller abort, cleanup failure, orphan protection, capacity verification,
  redaction, callback/event parity, stopped manager state, and exact ordinary behavior;
- startup failure, capacity rejection, deadline interruption, and runner-internal retry obey the
  single-public-probe cap rule;
- caller abort simultaneous with preparation deadline preserves caller-abort precedence;
- deadline during resource confirmation preserves typed resource-error precedence and excludes the
  current probe;
- a valid probe settled before deadline remains committed when mandatory cleanup finishes afterward,
  and natural completion wins before a time terminal;
- incomplete baseline collection never appears as established `resourceMonitoring`;
- actual elapsed/overrun accounting is exact and non-duplicative across preparation, active-probe,
  and resource-confirmation expiry, and a wall-time above Node's timer range does not fire early;
- final timing is captured only after owned cleanup and manager restoration; terminal host callback
  time is excluded and the manager is already stopped/unlocked when that callback runs;
- exhaustive `resultKind` narrowing separates ordinary adaptive/exact reports from preparation-time
  limits; schema-v4 positive/negative compile fixtures and packed-package consumption.

Run the quiet-trace summarizer against synthetic normal and resource-error v4 fixtures and perform a
JavaScript syntax check. Do not invoke Electron, llama-server, a model, or hardware; committed JSON
trace artifacts remain unchanged.

**Repository checks:**

```text
npm run format
npm run build
npm run lint
npm test
npm run test:packed-api
npm run format:check
git diff --check
```

**Verification:**

- [x] All focused and full automated tests pass.
- [x] Build, lint, formatting, packed-consumer, and diff-integrity checks pass.
- [x] The required double-check finds no unresolved correctness, contract, documentation, or
      over-engineering issue.
- [x] No live or hardware calibration is run.

## Documentation ownership

This new plan has a distinct durable purpose: it records why and how the first unreleased v4
implementation is being simplified. The original time-first plan remains the completed record of
that first implementation and is not silently rewritten.

Current authoritative docs are updated during Phase 5. The archived issue keeps the original
production evidence and gains only a link to this correction. No audit report, journal, completion
report, extra issue, or migration guide is created.

## Risks and mitigations

- **A total deadline leaves preparation work behind.** Propagate real abort signals where interruption
  is safe, await every owned operation, and report settlement overrun; never use an unowned race that
  merely stops awaiting an operation.
- **Deadline cancellation corrupts a binary install.** Keep the live install untouched through
  download/verification/staging, short-circuit fallback on cancellation, and make the final commit
  complete-or-restore even when it crosses the deadline.
- **Removing estimates starts work that cannot finish.** This is intentional best effort. The hard
  deadline interrupts the launch, cleanup completes, and the earlier incumbent survives.
- **A lucky single-search measurement displaces stable evidence.** Keep literal evidence labels and
  completeness, and use `searchNoiseAllowancePct` only for the approved uncertainty-equivalence rule;
  do not turn evidence back into an application gate or broad ranking preference.
- **Unlimited probes conceal a loop.** The real time deadline is the resource bound. Test structural
  traces and action/state invariants directly instead of imposing another count budget.
- **Resource failure encourages use of invalid evidence.** Derive `bestKnown` before the invalidated
  launch is committed and verify every source probe against the public trail.
- **Shared partial changes regress exact mode.** Golden-test exact ordinary behavior and limit the
  exact change to additive host-usable evidence on resource rejection.
- **Draft-v4 churn becomes needless v5 churn.** Keep v4 because it is unreleased; verify package
  declarations and defer migration prose to the actual release workflow.

## Rollback

- The work is unreleased and creates no persistent manager state. Rollback is a code/document
  reversion to the current completed time-first implementation while retaining the archived issue
  and both plans.
- Do not restore host-specific presets, consent restrictions, or the old cell-count/probe-reserve
  controller during rollback.
- If a shared preparation operation cannot be interrupted safely, classify it explicitly as an owned
  settle-to-completion section and report its overrun; do not leave background work or silently move
  the clock back to `policy-ready`.

## Open questions

None. The user approved this concrete contract and execution sequence on 2026-08-04. Any
implementation discovery that would reintroduce estimates, reserves, broad evidence-tier gating, a
probe-count fuse, host application restrictions, a validation-priority scheduler, or a
post-preparation clock requires renewed discussion before proceeding.

---

**Approved for execution.**
