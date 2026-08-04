# Plan: Time-First Adaptive Calibration

- Created: 2026-08-04
- Status: COMPLETE (implemented and automatically verified 2026-08-04)
- Target: unreleased breaking adaptive-calibration work after v0.20.0; no package version, release
  PR, tag, GitHub release, or npm publication until explicitly requested

> Superseded in part by [`PLAN-simplify-adaptive-calibration.md`](PLAN-simplify-adaptive-calibration.md),
> which corrects the unreleased clock, admission/finalization, evidence ranking, timing, and
> resource-failure selection decisions. This file remains the completed record of the first draft.

Sources:

- `docs/dev/issues/ISSUE-adaptive-calibration-budget-resume.md` - two production runs demonstrating that the
  cell-count launch and wall-time reserves can withhold a useful measured configuration
- `docs/dev/plans/PLAN-adaptive-llm-calibration.md` - the implemented v0.19 controller and evidence
  contract; retain as a historical record
- `docs/dev/plans/PLAN-calibration-resource-stability.md` - the implemented v0.20 fixed-baseline
  measurement-validity contract; retain as a historical record
- `PROGRESS.md` - current release and validation baseline

## Execution tracking

- [x] Phase 1: freeze the time-first API and consolidate defaults
- [x] Phase 2: implement incumbent derivation and finalization scheduling
- [x] Phase 3: rewire manager timing, progress, deadlines, and reports
- [x] Phase 4: update consumers, harnesses, and current documentation
- [x] Phase 5: run automated validation
- [x] Run the required double-check and resolve all findings
  - [x] Quarantine executor results that resolve after caller abort or the internal deadline.
  - [x] Let stable reproduced full evidence supersede earlier ambiguous point evidence.
  - [x] Report the limit that actually blocks a finalization launch when time and probe limits interact.
  - [x] Preserve `CALIBRATION_POLICY_STALLED` through manager error mapping.
  - [x] Close the manager/policy integration coverage gaps and stale schema terminology.

## Summary

Redesign adaptive LLM calibration around the outcome a host and its users actually care about: find
a good application-ready configuration within a chosen amount of time. Replace cell-count-derived
probe limits and finalist reserves with a time-first controller that establishes a usable incumbent
early, explores improvements while time remains, and deliberately switches to finalization before
the deadline. When search space remains unresolved, return the best clean configuration found with
truthful evidence-strength and search-completeness metadata instead of a dead-end provisional.

Keep `maxProbes` only as an optional expert/test limit and make omission mean no configured probe
limit. Remove the behaviorally inert `targetProbes` field. Probe count remains report and progress
telemetry, not the normal budget. The library remains lifecycle-neutral: `calibrate()` leaves the
manager stopped and returns an exact `startConfig`; the host alone decides whether to apply it
automatically, persist it, present it, or ignore it.

This is a schema and policy revision because it changes adaptive config, progress, terminal, and
recommendation invariants. Exact caller-ordered combo mode remains behaviorally unchanged.

## Why this direction

The current policy protects enough launches and time to resolve every still-competitive cell and
complete winner/fallback guards. That serves a best-under-the-requested-policy objective. It is too
strict for a product-calibration objective: on a slow host, the controller can find and independently
reproduce a strong incumbent, reserve resources for unresolved alternatives, then return
`budget-exhausted` with no application-ready selection.

Probe count was intended as a proxy for cost, but launch cost varies by model, machine, context,
workload, and fidelity. A four-cell run with five-minute full launches and one with twenty-second
launches should not receive the same operational budget. Elapsed time is the meaningful user-facing
resource, and observed launch duration is the meaningful scheduling input.

The new contract does not claim global optimality. Even a fully resolved call covers only the
requested profiles, cells, workloads, binary, and policy. It distinguishes:

- how much of that requested search was resolved; and
- how strong the direct evidence is for the returned configuration.

Those facts let a host choose its own product behavior without the library prescribing a consent or
UI flow.

## Durable artifact ownership

- This plan owns the time-first adaptive policy, public-contract decisions, implementation sequence,
  and acceptance criteria.
- `docs/dev/issues/ISSUE-adaptive-calibration-budget-resume.md` owns the downstream production
  evidence. It is archived with a resolution linking to this plan and states explicitly that evidence
  resume was deferred rather than implemented.
- The v0.19 and v0.20 plans and existing migration guides are historical snapshots and must not be
  rewritten to describe the new policy.
- Current API guides own user-facing behavior. `PROGRESS.md` owns the concise Unreleased record.
- A future migration guide has a distinct release-time purpose, but must not be created until the
  user explicitly requests a release.
- No additional issue, journal, completion report, or design-summary document is needed.

## Proposed contract decisions

These are the plan's recommended defaults. The open questions at the end identify the choices that
must be confirmed or edited before implementation.

1. **Time is the primary budget.** Retain adaptive `maxWallTimeMs` as the caller/host control and
   replace its cell-count formula with one fixed 60-minute library default. Hosts may pass any
   positive whole-millisecond override and choose their own presets or custom input.
2. **Define the clock honestly.** Preserve the current policy-clock boundary: provisioning,
   capability detection, binary readiness, and fixed-baseline collection are `preparing`; the
   selected `maxWallTimeMs` starts at `policy-ready` and bounds adaptive search/finalization.
   Mandatory teardown and a resource-boundary confirmation already in progress may overrun and are
   reported separately. Progress exposes both total call elapsed time and budget elapsed/remaining
   time so hosts do not mistake preparation for free or invisible work.
3. **No default probe maximum.** Omitted `maxProbes` means unbounded by caller policy. Represent this
   structurally in reports/progress; never serialize `Infinity` or `Number.MAX_SAFE_INTEGER`.
   Supplying `maxProbes` remains an expert/test hard limit, with no reserved subset.
4. **Remove the fake soft target.** Remove `targetProbes` from adaptive config, defaults, validation,
   progress, reports, docs, and public helpers. It currently has no scheduling effect, and a
   preferred probe count would remain a poor proxy for time.
5. **Use a non-user policy-stall fuse.** Bound controller attempts with a policy-aware transition
   ceiling derived from the finite cell graph and validation stages. Treat committed-evidence growth
   and legal stage advancement as progress, even when two consecutive validation launches have the
   same argv. Fail only an impossible overrun with an invariant code such as
   `CALIBRATION_POLICY_STALLED`; this is not a documented probe budget or an ordinary limited result.
6. **Finalization is a state, not a denial.** Replace launch/time reserve admission with explicit
   `exploring` and `finalizing` modes. Keep separate duration estimates for search-fidelity work and
   each missing full-fidelity finalization launch. Admit another exploration launch only when its
   estimate plus the incumbent's remaining finalization sequence, including a frozen conservative
   margin, fits strictly inside both the remaining time and any remaining probe slots. Equality
   enters finalization. An initial search launch may still be attempted under the active hard
   deadline when no incumbent exists, even if its configured estimate exceeds the whole budget;
   otherwise the policy could guarantee a zero-result run from an estimate alone.
7. **Return the best clean incumbent.** Every ordinary adaptive terminal path derives its result
   through one pure helper from manager-committed evidence. The helper relies on the manager invariant
   that cleanup and resource-validity checks pass before any policy evidence is committed. Successful
   score-bearing evidence additionally requires context/slot capacity verification; cleanly handled
   non-OK outcomes may be committed without it to resolve a boundary but can never support
   `selected`. The report builder verifies incumbent evidence indexes against the public probe trail.
   A later interrupted launch is kept in that chronological trail but never displaces or contaminates
   an earlier clean incumbent.
8. **Separate evidence from completeness.** A returned selection records one of:
   `independent-reproduction`, `single-full-launch`, or `single-search-launch`. Search completeness
   records `resolved` or `partial`. A host may use any returned selection according to its own
   policy; documentation explains the evidence without forbidding automatic application. Selection
   first finds the fastest eligible score across all tiers. Inside the existing
   `competitiveObservedRatio()` around that score, evidence strength precedes context/KV preferences
   and deterministic structural ties. Thus a materially faster weak observation may win with an
   honest label, while a noisy weak near-tie does not silently displace reproduced evidence.
9. **Keep the familiar application field.** Retain adaptive `selected` as the application-ready
   recommendation to minimize downstream churn. Permit it on time- or probe-limited reports. Remove
   `provisional`; it encoded search incompleteness and evidence strength in one misleading bucket.
   Remove adaptive `confidence` as redundant with the required evidence discriminant. Retain
   `fallback` only as additional diagnostic information; it gates neither `selected`, evidence tier,
   nor search completeness.
10. **Use non-failure terminal language.** Replace adaptive `budget-exhausted` with `time-limited`
    and optional `probe-limited`. Retain `complete` and `no-viable-candidate`, and add `inconclusive`
    for an ordinary partial stop caused by persistent ambiguity, unstable validation, a failed
    reference guard, incomplete preflight, or exhausted legal work rather than a caller budget.
    Add `searchCompleteness` and an explicit human-readable `terminalReason` to every adaptive report.
11. **Preserve measurement and lifecycle validity.** Context/slot verification, prompt redaction,
    confirmed cleanup, orphan blocking, caller abort, per-probe timeouts, and exclusion of
    resource-invalidated launches remain. This plan relaxes search-completeness requirements; it
    does not allow known-invalid measurements into a selection.
12. **Keep resource-stability rejection behavior focused.** A confirmed/unverifiable fixed-baseline
    crossing still stops the call under the v0.20 typed error in this change. Correct its
    developer-addressed suggestion to end-user-ready language. Whether clean pre-failure evidence
    should become application-ready inside that error is left as an explicit approval question,
    because it expands this plan into the shared adaptive/exact resource-error contract.
13. **Defer resume.** Do not add `resumeFrom` or cross-call evidence seeding here. Returning a usable
    time-limited selection removes the immediate dead end, while true resume still requires a
    separate decision about fixed resource baselines, machine identity, raw workload resupply,
    policy replay, and cumulative versus incremental budget accounting.
14. **Bump the shared serialization contract, not exact behavior.** Schema 4 and
    `llama-runtime-v4` apply to adaptive reports, exact reports, abort/failure partials, and
    resource-failure partials because the version fields live in their shared public base. Exact
    scheduling, ranking, statuses, and selection evidence remain unchanged and golden-tested.
15. **Freeze terminal precedence.** After any launch, first finish cleanup/resource validation and
    commit an accepted observation; next detect natural `complete` or resolved
    `no-viable-candidate`; only then classify an exhausted wall clock or optional probe cap. Caller
    abort and typed cleanup/orphan/resource errors keep their existing exceptional precedence and
    derive any diagnostic trail from the last committed state.

## Public contract sketch

The final names may be adjusted during the type phase, but the discriminants and invariants must be
equivalent to this shape:

```typescript
interface LlamaAdaptiveCalibrationConfig {
  // Existing model/profile/workload/fixed fields remain.
  maxWallTimeMs?: number; // fixed default, no cell-count scaling
  maxProbes?: number; // expert/test limit; omitted means unbounded
  // targetProbes is removed
}

type LlamaAdaptiveCalibrationSelectionEvidence =
  | 'independent-reproduction'
  | 'single-full-launch'
  | 'single-search-launch';

type LlamaAdaptiveProgressBudget = {
  clock: 'not-started' | 'running';
  maxWallTimeMs: number;
  budgetElapsedMs: number;
  remainingBudgetMs: number;
  estimatedNextProbeCycleMs?: number;
  estimatedFinalizationCycleMs?: number;
  probeLimit:
    | { kind: 'unbounded' }
    | { kind: 'bounded'; maxProbes: number; remainingProbes: number };
};

interface LlamaAdaptiveCalibrationBudgetReport {
  policy: 'time-first-v1';
  maxWallTimeMs: number;
  probeLimit:
    | { kind: 'unbounded' }
    | { kind: 'bounded'; maxProbes: number };
  completedProbes: number;
  preparationElapsedMs: number;
  budgetElapsedMs: number;
  cleanupOverrunMs: number;
  enteredFinalization: boolean;
  finalizationStartedAtBudgetMs?: number;
  durationEstimation: {
    policy: 'same-fidelity-comparable-cycle-median';
    configuredSearchCycleEstimateMs: number;
    configuredFullCycleEstimateMs: number;
    finalObservedSearchCycleEstimateMs?: number;
    finalObservedFullCycleEstimateMs?: number;
    admissionMarginMultiplier: 1.2;
  };
  overrides: readonly ('maxWallTimeMs' | 'maxProbes')[];
}

interface LlamaAdaptiveCalibrationReport {
  schemaVersion: 4;
  policyVersion: 'llama-runtime-v4';
  status:
    | 'complete'
    | 'time-limited'
    | 'probe-limited'
    | 'inconclusive'
    | 'no-viable-candidate';
  searchCompleteness: 'resolved' | 'partial';
  terminalReason: string;
  selected?: LlamaCalibrationRecommendation;
  selectionEvidence?: LlamaAdaptiveCalibrationSelectionEvidence;
  budget: LlamaAdaptiveCalibrationBudgetReport;
  // provisional and adaptive confidence are removed
}
```

The adaptive progress branch also gains `mode: 'preparing' | 'exploring' | 'finalizing'`.
`elapsedMs` remains total call time. The budget is no longer unresolved during preparation: its
configured limits are known, `clock` is `not-started`, `budgetElapsedMs` is zero, and
`remainingBudgetMs` equals the configured maximum until `policy-ready`. In reports,
`budgetElapsedMs` is clamped to `maxWallTimeMs`; mandatory post-deadline cleanup/resource time is
recorded only in `cleanupOverrunMs`, avoiding double counting.

Invariants:

- `selected` and `selectionEvidence` are present or absent together.
- `complete` implies `searchCompleteness: 'resolved'`.
- `time-limited`, `probe-limited`, and `inconclusive` imply `searchCompleteness: 'partial'`, but may
  have `selected`.
- `no-viable-candidate` has no `selected` only after the search space was actually resolved as
  non-viable; a deadline before any usable observation is `time-limited` without `selected`.
- `resolved` means every decision-relevant requested cell is resolved or conclusively non-viable,
  the active context/KV preference is unambiguous, the winner has independent reproduction, and any
  required reference guard passed. Producing a fallback is optional and does not gate resolution.
- A selection always points to an accepted, operationally complete, uncapped, cleanup-confirmed,
  capacity-verified observation or agreeing set of observations with a finite positive score. Any
  accepted comparable conflict at the exact argv prevents a single-launch selection. The enum
  states exactly how much evidence supports it.
- The library never starts or persists the returned configuration itself. This is lifecycle
  neutrality, not a restriction on what the host may do next.

Terminal mapping is explicit:

| Controller outcome | Public adaptive status |
| --- | --- |
| All decision-relevant work resolved with a reproduced winner | `complete` |
| All requested cells resolved as non-viable | `no-viable-candidate` |
| Hard policy clock prevents more work | `time-limited` |
| Explicit optional probe cap prevents more work | `probe-limited` |
| Legal work ends unresolved, including persistent ambiguity/instability or guard failure | `inconclusive` |
| Caller abort, cleanup/orphan failure, resource rejection, or internal invariant | Existing typed exceptional path with schema-v4 partial report |

## Phases

### Phase 1: Freeze the time-first API and one source of defaults

**Goal:** Establish one coherent schema-v4 contract before changing controller behavior.

**Work:**

- [x] Replace duplicated cell-count budget formulas with one adaptive time-budget resolver in
  `src/config/defaults.ts`; make the pure policy consume the resolved values instead of reimplementing
  arithmetic.
- [x] Remove cell-count-dependent wall defaults, `targetProbes`, `finalistReserve`, and
  `finalistTimeReserveMs` from stable defaults and public resolved-default types.
- [x] Keep optional finite `maxProbes` validation without any `target <= max` or reserve constraints.
- [x] Define a JSON-safe bounded/unbounded probe-limit discriminant for internal state, progress, and
  reports.
- [x] Replace the schema-v3 budget report's formula/cell/reserve fields with the time-first shape above:
  configured clock and optional probe cap, preparation/policy/cleanup timing, finalization entry,
  overrides, and the frozen duration-estimation policy.
- [x] Revise adaptive config, progress, report, terminal-status, and adaptive-only selection-evidence
  types. Remove adaptive `confidence`; retain exact `selectionEvidence` and `confidence` unchanged.
- [x] Bump the shared report schema constant to 4 and shared policy identifier to
  `llama-runtime-v4` across adaptive, exact, abort/failure partial, and resource-failure partial
  reports. This acknowledges a shared serialization change while keeping exact-mode execution and
  result semantics unchanged.
- [x] Update package-root and type-barrel exports. Do not change package version metadata.
- [x] Remove the old public `resolveLlamaCalibrationBudgetDefaults(cellCount)` as approved; do not
  retain a deprecated wrapper that preserves the old cell-count meaning.

**Steps:**

1. Write compile-time fixtures for the proposed config/report/progress discriminants and invalid
   combinations, including every full and partial report strategy under the shared version bump.
2. Consolidate the default resolver and update default/validation tests.
3. Update public types and exports until the compile-time fixtures pass.
4. Inspect generated declarations to confirm exact/adaptive narrowing and serializable unbounded
   limits.

**Verification:**

- [x] `targetProbes` is absent from schema-v4 adaptive inputs and outputs.
- [x] Omitted `maxProbes` resolves to an explicit unbounded state without a non-finite number.
- [x] Exact config still rejects adaptive-only time/probe fields exactly as intended.
- [x] Exact, adaptive, and both partial-report families all serialize schema 4/policy v4, while
      exact scheduling/status/evidence fixtures remain byte-for-byte equivalent apart from versions.
- [x] One implementation owns all adaptive time-default arithmetic.
- [x] Schema-v3 shapes fail the new compile-time fixtures where the contract intentionally changed.

### Phase 2: Add incumbent derivation and an explicit finalization state

**Goal:** Make the pure controller optimize useful evidence within time rather than exhaustive cell
resolution.

**Work:**

- [x] Separate structural cell planning from run-mode scheduling so the same deterministic cell plans can
  be consumed in `exploring` or `finalizing` mode.
- [x] Add one `deriveAdaptiveIncumbent()` helper that examines only committed accepted evidence and ranks
  candidates. It trusts the manager's committed-evidence invariant; it does not duplicate public
  resource-boundary, cleanup, or capacity state inside the pure controller.
- [x] Preserve the current reproduced-candidate definition. Add explicitly weaker candidates from clean
  single full/search launches instead of silently weakening the existing stability helper.
- [x] Freeze incumbent eligibility and score construction:
  - eligible evidence is manager-committed, operationally `ok`, workload-complete rather than
    deadline-capped, and has a finite positive score for one exact argv;
  - an independently reproduced score is the median of its agreeing full-fidelity launch scores;
    a single-full or single-search score is that one launch's score;
  - any accepted comparable conflicting evidence at that exact argv, earlier or later, removes its
    single-launch eligibility until the normal stability rules resolve the conflict; and
  - report construction verifies the chosen evidence indexes against capacity, cleanup, and
    resource-validity facts in the chronological public probes.
- [x] Freeze cross-tier ranking: find the fastest eligible score, retain points no slower than that score
  times the existing `competitiveObservedRatio()` for the active preference/noise settings, choose
  the strongest evidence tier represented in that band (`independent-reproduction`, then
  `single-full-launch`, then `single-search-launch`), and pass only that tier to the existing
  larger-context, KV-precision, and deterministic structural tie resolver. Apply the same reduction
  first within a cell and then globally. Thus a materially faster clean weak observation can win with
  an honest label, while a noisy near-tie cannot displace strong reproduced evidence.
- [x] Replace `evaluateProbeAdmission()` and `effectiveFinalistTimeReserve()` with a duration-aware
  scheduling decision: continue exploration, enter finalization, execute a finalization probe, or
  stop with the incumbent.
- [x] Maintain separate search- and full-fidelity complete-cycle estimates. A cycle delta runs from the
  pre-probe resource boundary through start/capacity/workload execution, confirmed teardown,
  cooldown, and the post-cleanup resource boundary. Use the median of completed comparable
  same-fidelity cycle deltas when present; otherwise use deterministic configured estimates that add
  planned request/start work and configured capacity, teardown, cooldown, and telemetry overhead.
  Multiply each admission estimate by the frozen `1.2` margin. The hard deadline, not the estimate,
  remains the absolute bound.
- [x] Freeze finalization launch counts:
  - an `independent-reproduction` incumbent needs zero launches;
  - a `single-search-launch` incumbent needs one full launch, whose agreement with the search launch
    establishes independent reproduction; and
  - a `single-full-launch` incumbent without agreeing search evidence needs one additional agreeing
    full launch (if agreeing search evidence existed it would already be reproduced).
  Finalization cost is the corresponding ordered full-cycle estimate, never an automatic two-launch
  reserve for a single-search incumbent.
  Admit exploration only when `remainingTime > nextSearchEstimate + finalizationEstimate`; equality
  finalizes. With no incumbent, permit the first search probe under the hard deadline even when its
  estimate does not fit, then derive the best result actually observed.
- [x] Build a deterministic finalization queue from the current winner and materially competitive weaker
  candidates in incumbent-ranking order. Finalization is monotonic and never returns to exploration
  within a call. If a target fails or conflicts, invalidate/re-rank it, strengthen the next queued
  candidate only when it fits, and otherwise return the strongest remaining evidence. If all queued
  evidence is invalidated, return the terminal status matching the actual stop cause without a
  selection.
- [x] A required reference guard remains a completeness condition: its failure makes the search
  `inconclusive` but cannot erase still-valid selected evidence. Fallback work is optional diagnostic
  improvement only; failure adds a warning and changes neither `selected` nor search completeness.
- [x] Apply an explicit caller `maxProbes` through the same dynamic accounting: compare remaining slots
  with the next exploration launch plus the incumbent's missing finalization launches. Reserve no
  fixed subset. `maxProbes: 1` permits one search launch and then returns its clean incumbent as
  `probe-limited` unless that launch naturally resolves the request. Natural completion is evaluated
  before either limit at an exact boundary.
- [x] Add a policy-aware attempt/transition ceiling rather than rejecting identical consecutive actions.
  Evidence growth or a legal validation-stage transition resets progress; two necessary identical
  full validation argv actions remain legal.
- [x] Layer terminal derivation: the pure policy emits an internal terminal cause plus incumbent snapshot;
  the manager maps it to the public report after probe/resource checks. This keeps natural completion,
  time admission, probe limit, in-flight deadline, and inconclusive exhaustion on identical incumbent
  rules without making the pure controller construct public reports.

**Steps:**

1. Add trace fixtures for reproduced, single-full, single-search, conflicting, and absent incumbents.
2. Implement and test pure eligibility, score construction, competitive-band/evidence ordering, and
   incumbent ranking independently of scheduling.
3. Introduce controller run mode, deterministic finalization queue, and distinct search/full duration
   estimates.
4. Replace reserve-based time/slot admission and re-derive affected golden traces, including
   finalization failure/reselection.
5. Add legal-trace/property-style coverage showing the unbounded default terminates structurally or
   trips the derived policy-stall invariant without rejecting duplicate legal validation actions.

**Verification:**

- [x] No default controller path terminates because of probe count.
- [x] The old four-cell 19-of-23 launch-reserve stop cannot occur when `maxProbes` is omitted.
- [x] Slow observed launches trigger finalization early enough to preserve a usable incumbent.
- [x] A reproduced incumbent is never discarded merely because another competitive cell is open.
- [x] A materially faster weak candidate can win with its weaker label, while evidence strength wins
      inside the existing competitive band.
- [x] Single-launch selections are labeled accurately and never reported as reproduced.
- [x] Incomplete/capped, conflicting, or resource-invalid evidence cannot become an incumbent.
- [x] Full resolution before the time limit still returns `complete`.
- [x] Persistent ambiguity and validation/guard exhaustion map to `inconclusive`, not a false budget
      or completion status.
- [x] `maxProbes: 1`, exact-cap natural completion, exact-deadline completion, and duplicate legal
      winner validation obey the frozen precedence.
- [x] Impossible no-progress behavior fails boundedly with an invariant error.

### Phase 3: Rewire manager timing, progress, deadlines, and report construction

**Goal:** Drive the new controller with a truthful host-visible time budget while preserving process
safety.

**Work:**

- [x] Retain `policyReadyAt` as the adaptive budget start and continue measuring preparation separately.
- [x] Replace probe-count progress percentage with time-budget consumption. Preserve monotonicity;
  successful early completion may jump to 100 at `done`.
- [x] Keep base `elapsedMs` as total call time. Expose the always-resolved budget clock state,
  `budgetElapsedMs`, `remainingBudgetMs`, `completedProbes` diagnostics, current
  preparing/exploring/finalizing mode, same-fidelity next-cycle estimate, incumbent finalization
  estimate, and JSON-safe optional probe-limit state.
- [x] Remove pre-provision reserve-conflict validation and cell-count wall-budget warnings. Validate only
  positive time and optional probe-limit values before provisioning.
- [x] Keep the active-probe deadline signal and confirmed cleanup behavior. A request interrupted by the
  deadline is appended only to the public trail, leaves committed policy evidence unchanged, and
  derives `selected` from the prior clean state. If measured work completed before the signal and
  only mandatory cleanup/resource confirmation crosses the deadline, validate and commit that
  observation first, then apply natural-completion-before-time-limit precedence.
- [x] Ensure pre-launch expiry, in-flight deadline, post-cleanup expiry, and optional probe limit all use
  the centralized terminal-result builder rather than ad hoc candidate-free terminals.
- [x] Populate the frozen schema-v4 budget shape: preparation elapsed, policy-budget elapsed, cleanup
  overrun, configured limits and overrides, search/full duration-estimation policy, whether/when the
  run entered finalization, and completed probe diagnostics.
- [x] Preserve prompt-token reuse, per-launch capacity verification, redaction, resource-boundary checks,
  abort precedence, cleanup failure precedence, orphan blocking, and stopped manager state.
- [x] Rephrase the resource-stability `details.suggestion` and UI remediation as end-user-ready text;
  document that host code may replace or localize it.

**Steps:**

1. Update manager progress plumbing and fake-timer fixtures for a time denominator.
2. Remove manager assumptions that `maxProbes` and reserves are always finite.
3. Route every adaptive terminal path through one result builder.
4. Add deadline and cleanup regressions with an existing incumbent and with no incumbent.
5. Verify a host can immediately spread any returned `selected.startConfig` into `start()` while the
   library itself remains side-effect neutral.

**Verification:**

- [x] Progress is monotonic and meaningful with an unbounded probe limit.
- [x] A later interrupted probe cannot erase a prior clean selection.
- [x] No new launch begins after the search wall deadline.
- [x] A valid observation whose measured work completed before the deadline is committed after its
      mandatory cleanup checks; natural completion wins over a simultaneous time/probe boundary.
- [x] Mandatory cleanup/confirmation overrun is isolated and reported.
- [x] Caller abort and cleanup/orphan failures keep their existing precedence and typed partials.
- [x] The manager is stopped and unlocked after every returned report.
- [x] Host code can auto-apply, present, persist, or ignore `selected` without violating library
      guidance.

### Phase 4: Update consumers, harnesses, and current documentation

**Goal:** Make the public contract consumable without preserving stale optimality or consent claims.

**Work:**

- [x] Update `scripts/packed-api/run.mjs` to consume schema-v4 adaptive config, progress, result,
  evidence, search-completeness, exact report, and exceptional partial-report types through the
  packed package boundary.
- [x] Update the quiet-trace harness and its default config so at least one ordinary adaptive scenario
  omits `maxProbes`; summarize time budget, termination, selected evidence, and completeness. Preserve
  historical artifacts unchanged.
- [x] Update `README.md` and `AGENTS.md` orientation from strict boundary completion to time-bounded
  best-known calibration.
- [x] Rewrite the current LLM-server budget/status/progress/application sections around host-selected
  time, explicit finalization, selected evidence, and host-owned application policy.
- [x] Update `genai-electron-docs/index.md` so its feature summary promises time-bounded best-known
  calibration rather than reproducible-boundary completion.
- [x] Mirror every public type in the TypeScript reference and replace `budget-exhausted` retry guidance
  in troubleshooting with usable time-limited outcomes.
- [x] Add an integration-guide example showing two equally valid host policies: automatic application
  and presentation/confirmation. State explicitly that these are host choices, not library rules.
- [x] Update resource-orchestration cross-references from `selected only on complete` to the new
  evidence/completeness contract.
- [x] Add a concise Unreleased section to `PROGRESS.md`. Do not edit historical release entries.
- [x] Add the resolution/deferred-resume note and archive the issue under `docs/dev/issues/`.

**Verification:**

- [x] No current documentation says a host must ask for consent or must not automatically apply.
- [x] No current documentation describes probe count as the default adaptive budget.
- [x] Docs distinguish evidence strength, search completeness, and host application policy.
- [x] Packed API and quiet-trace harnesses contain no schema-v3-only adaptive assumptions.
- [x] Public docs do not present adaptive `confidence` or `provisional` as schema-v4 fields, and
      describe retained `fallback` as diagnostic rather than a selection gate.
- [x] Historical plans, migrations, release records, and trace artifacts remain historical.

### Phase 5: Automated validation

**Goal:** Prove the new contract with deterministic tests, consumer checks, and repository-wide
quality gates.

**Focused automated matrix:**

- `tests/unit/defaults.test.ts`
- `tests/unit/llama-calibration-policy.test.ts`
- `tests/unit/llama-adaptive-calibration-policy.test.ts`
- `tests/unit/llama-adaptive-calibration-manager.test.ts`
- `tests/unit/llama-calibration.test.ts`
- `tests/unit/public-types.test.ts`
- `tests/unit/error-helpers.test.ts`

Required deterministic scenarios:

- unbounded default crosses the old 19/23 four-cell threshold without a probe-limit terminal;
- explicit finite `maxProbes` finalizes or returns the best clean incumbent without a reserve;
- `maxProbes: 1`, exact-cap natural completion, and exact-deadline natural completion obey terminal
  precedence;
- five-minute observed launches under synthetic time budgets transition from exploration to
  finalization;
- a single-search incumbent reserves exactly one full probe cycle for strengthening, while an
  already reproduced incumbent reserves zero;
- time limit with reproduced, single-full, single-search, conflicting, and absent incumbents;
- a 2.0-second single-search candidate versus a 4.2-second reproduced candidate selects the former
  when outside the competitive band and labels it weak; a near-tie selects stronger evidence;
- finalization-target failure falls through a deterministic queue or retains the strongest earlier
  incumbent without returning to exploration;
- persistent ambiguity, unstable winner validation, failed required reference guard, and incomplete
  preflight map to `inconclusive` rather than a false time/probe result, while fallback failure is
  warning-only;
- active deadline during a later probe preserves the prior incumbent and cleanup trail;
- full early resolution, all-g=0 failure, caller abort, cleanup failure, orphan protection, prompt
  redaction, callback/event parity, and exact-mode behavior;
- time-based progress monotonicity and JSON-safe bounded/unbounded report shapes;
- legal unbounded traces terminate or hit the internal stall invariant.
- two legal identical full winner-validation actions advance normally and do not trip that invariant.

Full repository checks:

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

- [x] All focused, full, packed-consumer, formatting, and diff-integrity checks pass.
- [x] Automated deadline, cleanup, manager-lock, prompt-redaction, and schema-contract regressions pass.

## Documentation

Existing authoritative documents to update during Phase 4:

- `README.md`
- `AGENTS.md`
- `PROGRESS.md` (new Unreleased section only)
- `genai-electron-docs/index.md`
- `genai-electron-docs/llm-server.md`
- `genai-electron-docs/typescript-reference.md`
- `genai-electron-docs/troubleshooting.md`
- `genai-electron-docs/integration-guide.md`
- `genai-electron-docs/resource-orchestration.md`
- `scripts/calibration-quiet-trace/README.md`

The only new durable document is this plan. A migration guide belongs to the later explicitly
requested release workflow, not this implementation batch.

## Risks and mitigations

- **A weak incumbent looks stronger than it is.** Keep evidence strength required and literal; never
  collapse single-search, single-full, and reproduced evidence into one confidence string.
- **Time percentage is mistaken for work completion.** Document it as budget consumption; expose
  search mode and allow early success to jump to done.
- **Unlimited probes hide a controller loop.** Keep the hard wall deadline and add a policy-aware
  attempt/transition ceiling independent of user budgeting; identical legal validation actions must
  still advance through evidence or stage state.
- **Observed durations underestimate the next cycle.** Estimate complete probe cycles including
  resource snapshots, capacity work, teardown, and cooldown; use distinct configured estimates before
  same-fidelity observations, a frozen 1.2 admission margin, and the active hard deadline as the final
  bound.
- **Finalization starts too late.** Test slow full launches and reserve only incumbent work; when in
  doubt, prefer returning existing evidence over starting an exploration launch.
- **Single-launch selection is auto-applied unexpectedly.** This is a host decision by design. The
  mitigation is accurate evidence metadata and neutral documentation, not a library prohibition.
- **Schema-v3 consumers silently misread new invariants.** Use schema v4, compile-time negative
  fixtures, packed-package consumer checks, and an eventual migration guide.
- **Exact mode regresses through shared unions/helpers.** Keep exact behavior golden-tested and avoid
  routing it through adaptive time/finalization policy. The shared schema/policy bump is explicit and
  covered for exact and exceptional partial reports.
- **Resume is assumed to exist.** Mark it explicitly deferred in the plan, root-issue resolution,
  troubleshooting, and future migration notes.

## Rollback

- The change is calibration-policy/API work but creates no persisted mutable manager state. Rollback
  before release is a code/document reversion to policy v3 and schema v3.
- Do not attempt to interpret schema-v4 reports under v3. Persisted reports are already versioned and
  callers must invalidate them across policy/schema changes.
- Exact mode remains the stable caller-ordered diagnostic fallback throughout implementation.
- If deterministic time-first validation fails, keep the work unreleased, retain the archived issue, and
  either adjust the finalization policy under schema/policy v4 or revert the branch; do not weaken
  lifecycle cleanup or mark the plan complete.

## Approved decisions

The user approved these decisions on 2026-08-04:

1. Keep a fixed 60-minute library default whose policy clock starts at `policy-ready`; report
   preparation and mandatory cleanup separately. Hosts may choose any positive whole-millisecond
   override appropriate to their product.
2. Permit `selected` from one clean search-fidelity launch and label it
   `single-search-launch`; application remains host policy.
3. Rank across evidence tiers by first finding the fastest score, then preferring stronger evidence
   within `competitiveObservedRatio()` before applying existing context/KV/structural preferences.
4. Remove `targetProbes` and the old cell-count default resolver outright in schema 4. Keep only the
   optional, unbounded-by-default expert `maxProbes` cap.
5. Use complete probe-cycle estimates and the frozen 1.2 admission margin; a single-search or
   single-full incumbent reserves exactly one full cycle for strengthening, while a reproduced
   incumbent reserves none.
6. Keep v0.20 resource-stability errors diagnostic-only in this focused change; defer any shared
   adaptive/exact pre-failure-selection revision.
7. Defer cross-call evidence resume. It may later become an "improve for another N minutes" feature
   with its own baseline/session contract.

---

**Implementation completed and automatically verified on 2026-08-04; unreleased.**
