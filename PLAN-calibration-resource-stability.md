# Plan: Calibration Resource Stability Hard Stop

- Created: 2026-08-02
- Status: IN PROGRESS (plan approved 2026-08-02; implementing on `feat/calibration-resource-stability`)
- Target: unreleased breaking calibration work after published v0.19.1; eventual v0.20.0
- Tracking: work-plan items carry checkboxes — `[ ]` pending, `[~]` in progress, `[x]` done, `[!]` blocked

Sources:

- `ISSUE-calibration-cross-regime-comparison.md` - the residual correctness issue that motivated
  replacing resource regimes instead of expanding them
- `docs/dev/plans/PLAN-adaptive-llm-calibration.md` - the implemented v0.19 adaptive-calibration
  contract and live-validation record
- `PROGRESS.md` - current release history and validation baseline

## Summary

Replace calibration's resource-regime re-anchoring with one fixed baseline per enabled trusted
metric. Resource availability remaining within each fixed-baseline band is tolerated. A material
independently confirmed decrease in either available host RAM or available VRAM stops calibration
with a typed error; a suspicious boundary
that cannot be verified clean fails under the same error class with a distinct details code.
Calibration never restarts, re-anchors, or spends launch budget repeating a probe merely to confirm
resource stability. Resource increases remain diagnostic and do not stop a run.

Apply the same guard to adaptive and exact calibration at both sides of every launch: immediately
before launch and after teardown is confirmed. A suspicious boundary reading gets a cheap telemetry
confirmation, not another server launch. Evidence invalidated by confirmed or unverifiable resource
stability must never reach the adaptive controller or recommendation logic. A candidate supported
entirely by earlier clean evidence may appear only in the partial report as explicitly diagnostic
and non-applicable.

This is an intentionally breaking report/API revision. Remove resource regimes and their policy
branches, publish schema v3 and policy `llama-runtime-v3`, and add an ergonomic typed rejection
contract. Because v0.19.1 is already on npm, implementation is accumulated under Unreleased and the
version bump, migration guide, release PR, tag, GitHub release, and npm publication remain gated on
an explicit release request.

## Why this direction

Re-anchoring preserves forward progress by declaring a new measurement regime. It does not make
scores across regimes comparable: cliff classification, cell pruning, and final ranking can still
compare measurements taken before and after a resource change. Closing every cross-regime path
would add policy state and re-measurement, and restarting the search could enter a never-ending loop
when a user continues doing work on the machine.

The cross-regime defect is confirmed by static review and is reachable, but it has not produced a
demonstrated wrong recommendation in a live calibration. The v0.19 record contains a browser-induced
settled resource step, which exercises the prerequisite for re-anchoring, not the downstream
mis-selection. Hard-stop behavior is therefore a deliberate correctness and product-contract
choice: once the library observes a material loss of comparability, it refuses to publish a usable
recommendation instead of transferring its non-exported evidence-validity decision to the host.

The stronger and simpler boundary invariant is:

> Every observation admitted to one calibration result started and ended with every enabled trusted
> resource metric within its accepted decrease band around one fixed baseline.

This does not claim continuous observation. Pressure that starts and fully clears between the
pre-launch and post-cleanup snapshots can escape the guard. In-flight telemetry would itself perturb
timing and is outside this change; document the temporal blind spot instead of promising that the
guard detects every transient disturbance.

This is a complexity trade, not a predicted net line-count reduction. Removing regime/re-anchor
state gives the pure controller a simpler proof obligation—only fixed-baseline-clean observations
enter policy—but truthful capture, confirmation, exact-mode parity, diagnostics, and failure
reporting add manager/API work. That boundary is still preferable because the controller's
mixed-regime proof obligations disappear from the policy, where two post-release defects and this
residual issue were found.

Two quiet post-fix runs discussed during investigation constrain only the increase side: available
host memory rose roughly 4-6% as the machine settled, while reported GPU drift stayed at 0%. Their
raw snapshots are not a committed artifact, and they do not establish a universal harmful-decrease
boundary. Consequently, this plan freezes the protocol but makes provisional thresholds plus the
fixed baseline-settle/cooldown schedule a user checkpoint after reproducible production-timed quiet
traces.

## Decisions frozen by this plan

1. **No restart and no re-anchor.** One `calibrate()` call has one baseline. Comparison is cumulative
   against that preparation baseline: individually minor decreases that together reach the
   threshold reject the call, and a settled material step is never accepted as a new baseline.
2. **Bounded baseline stabilization.** After provisioning/preparation and before the probe-policy
   wall clock starts, wait the fixed approved baseline-settle delay, then capture three snapshots
   separated by the existing resource cooldown. Compute each metric's median independently from at
   least two trusted values. If fewer than two trusted values exist, disable that metric for this
   run and warn; do not loop waiting for it.
3. **Asymmetric comparison.** For reading `R` and baseline `B`, use
   `decreasePct = max(0, (B - R) / B * 100)` for decisions. Signed raw change remains available for
   diagnostics. An increase never contributes to failure.
   *Amendment (2026-08-02, user checkpoint discussion):* a large increase also degrades strict
   comparability (earlier probes ran under tighter conditions; the result may be conservative), but
   quiet machines measurably settle upward (+10.8% host over one quiet run), so increases stay
   non-fatal. Instead, a trusted increase beyond a warning-only band (value chosen at the threshold
   checkpoint, above the measured settling envelope) adds an explicit report warning that the result
   may be conservative and recalibration may find a better configuration. Implemented with the
   Phase 2/4 report work.
   *Checkpoint resolution (2026-08-02):* user approved host decrease 10%, VRAM decrease 10%,
   settle 5000 ms, cooldown 750 ms, telemetry timeout 10000 ms, samples 3, confirmation reads 1.
   Increase band set at host 20% / VRAM 10%; warn-vs-stop semantics at that band deliberately held
   open pending the long-run (adaptive-2p default-budget) settling datapoint, because a large
   increase also desensitizes the fixed-baseline decrease guard (nominal 10% becomes ~(settle+10)%
   effective against the settled level) — the user's argument for bounding it.
   *Final resolution (2026-08-02):* the 13.3-min default-budget adaptive-2p run settled at a
   +10.50% plateau (stable from ~minute 6), matching the earlier +10.82% peak. Increase bands are
   therefore enforced as confirmed HARD stops, not warnings: host increase 20% (≈1.9× plateau
   margin), VRAM increase 10% (zero measured settling). Same confirmation protocol and the same
   `CALIBRATION_RESOURCE_DRIFT` details code as decreases; direction is recorded in diagnostics.
   Frozen set: host 10 dec / 20 inc, VRAM 10 dec / 10 inc, settle 5000 ms, cooldown 750 ms,
   telemetry timeout 10000 ms, baseline samples 3, confirmation reads 1.
4. **Independent metrics.** Host RAM and VRAM have separate thresholds and trust states. A missing
   or untrusted metric cannot mask a confirmed drop in the other. There is no weighted score.
5. **Two launch boundaries.** With complete trusted readings, checking pre and post separately is
   algebraically detection-equivalent to reducing them with `min(pre, post)`. Keep them explicit for
   attribution and admission: pre-launch confirmation can reject without paying for a launch, while
   post-cleanup confirmation decides whether the completed launch may mutate state. This does not
   close the documented in-flight transient blind spot.
6. **Cheap confirmation.** Capture the initial post-cleanup reading only after the normal cooldown,
   so ordinary teardown release has time to settle. A trusted reading at or above its threshold is
   suspicious. Wait one additional cooldown and capture one whole-boundary confirmation. Proceed
   only if every initially suspicious metric recovered and every trusted enabled metric in the
   confirmation is below threshold. Reject confirmed drift when the same metric remains suspicious.
   If confirmation is untrusted for an initially suspicious metric, or a different metric becomes
   newly suspicious, reject as stability-unverified rather than looping or treating it as clean.
   If any originally suspicious metric is independently confirmed, confirmed drift takes precedence
   even when another metric is untrusted or newly suspicious; stability-unverified applies only when
   no metric is confirmed and the boundary still cannot be admitted.
   Once triggered, finish this bounded confirmation with the caller abort signal even if the
   adaptive wall budget expires. If it recovers after budget expiry, return `budget-exhausted`
   without launching. Confirmation consumes wall time but no server-launch or probe budget.
7. **Untrusted readings do not manufacture drift.** Baseline-time telemetry with fewer than two
   trusted values disables only that metric for the run. An isolated untrusted boundary reading,
   without a trusted suspicious reading in that boundary sequence, is recorded/warned and cannot
   trigger drift. Once a trusted suspicious reading exists, failure to obtain a conclusive bounded
   confirmation rejects separately with `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED`; it never admits
   the launch/result. Trust is metric-specific.
8. **Post-check correctness outranks the internal probe deadline.** Once a launch begins, confirmed
   teardown and the bounded post-check use the caller's abort signal, not an expired internal
   per-probe deadline. Record any wall-budget overrun. This closes the final-probe blind spot without
   creating an unbounded wait.
9. **Contaminated evidence is quarantined.** A launch followed by confirmed post-cleanup drift or an
   unverified post-cleanup resource boundary may remain in the chronological probe trail, clearly
   marked invalidated by resource stability, but it is never applied to the adaptive policy, exact
   ranking, selection, fallback, or diagnostic-candidate calculation.
10. **One typed stability error.** Both confirmed drift and an inconclusive suspicious boundary
    reject with `LlamaCalibrationResourceStabilityError`, extending `ServerError`. Its details are a
    discriminated union keyed by `CALIBRATION_RESOURCE_DRIFT` or
    `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED`. Both emit exactly one `phase: 'done'` /
    `terminalStatus: 'failed'` callback/event payload and retain the boundary diagnostics, cleanup
    state, and schema-v3 partial report.
11. **Diagnostic candidate only.** A candidate derived exclusively from clean pre-drift evidence
    may be exposed as `diagnosticCandidate` with literal `usability: 'diagnostic-only'`. Adaptive
    mode requires normal independent reproduction; exact mode may use its existing single-clean-
    launch evidence. Expose only `sourceProbeIndexes` and the evidence level—no duplicated config,
    score, profile, or cell payload. It is never copied into `selected`, `provisional`, or `fallback`,
    and probe indexes cannot be pasted into `start()`.
12. **Cleanup precedence.** If teardown cannot be confirmed, reject as
    `CALIBRATION_CLEANUP_FAILED`; do not hide possible orphaning behind a drift error. An explicit
    caller abort during baseline or confirmation remains `CALIBRATION_ABORTED`.
13. **No resource state in the pure adaptive controller.** Only clean observations reach the
    controller, so `resourceRegime`, `resourceDriftStatus`, settled-level logic, and regime filtering
    are removed.

## Public contract to implement

### Defaults

Replace the current resource keys on `LLAMA_CALIBRATION_DEFAULTS`:

- remove `resourceDriftThresholdPct`;
- remove `resourceSettledTolerancePct`;
- remove `resourceDriftRetries`;
- add `hostMemoryDecreaseThresholdPct` (value selected at the threshold checkpoint; approved
  2026-08-02: 10);
- add `vramDecreaseThresholdPct` (value selected independently at the checkpoint; approved
  2026-08-02: 10);
- add `hostMemoryIncreaseThresholdPct` (approved 2026-08-02: 20) and `vramIncreaseThresholdPct`
  (approved 2026-08-02: 10) per the Decision 3 amendment — confirmed hard stops sharing the
  decrease protocol and error code, direction recorded in diagnostics;
- add `resourceBaselineSamples: 3`;
- add `resourceBaselineSettleMs` (the fixed bounded value approved at the threshold checkpoint,
  possibly zero if the quiet trace supports it);
- add `resourceDriftConfirmationReads: 1`;
- add a bounded `resourceTelemetryTimeoutMs` for each host/GPU capture operation;
- retain `resourceCooldownMs` as the cooldown key, with its current 750 ms value subject to the
  quiet-trace checkpoint;
- change `policyVersion` to `llama-runtime-v3`.

Threshold comparison is inclusive: a trusted decrease equal to the threshold is suspicious and must
be confirmed. These are exported policy constants, not new caller-configurable calibration fields.
Keep the threshold values finite and in `(0, 100]`, the baseline sample count at least 2, and the
confirmation count at least 1. Keep the settle delay a non-negative safe integer and the telemetry
timeout/cooldown positive safe integers. Do not add an override that disables confirmation in this
change.

### Truthful memory refresh

Change `refreshAvailableMemory()` and public `SystemInfo.refreshMemoryTelemetry()` to return a typed
status rather than silently swallowing an operational distinction:

```ts
type MemoryTelemetryRefreshStatus = 'refreshed' | 'not-required' | 'failed';
```

- Windows returns `refreshed` only when a valid finite non-negative standby-aware value was stored, otherwise
  `failed` without throwing.
- Other platforms return `not-required`; their direct `os.freemem()` reading is trusted.
- `SystemInfo.detect()` remains best-effort and may ignore the status.
- Calibration trusts host RAM only for `refreshed` or `not-required` results.
- GPU trust remains independent: a fresh `getGPUInfo()` result with a finite non-negative
  `vramAvailable` is trusted; absence/failure disables only the VRAM metric for that snapshot.
- Calibration passes its caller abort signal and the bounded telemetry timeout into the platform
  commands. Extend the internal detectors and no-argument public methods compatibly as needed; do
  not implement timeout with a bare promise race that leaves a child process running.

Export the status type and update the method's TSDoc. Do not infer refresh failure from a stale
numeric cache value.

### Schema-v3 resource diagnostics

Replace the current `beforeBytes`/`afterBytes` reduction with one lean auditable model:

- report/partial-report-level `resourceMonitoring` stores each metric's fixed baseline bytes,
  threshold, number of attempts, trusted baseline samples, and overall
  `complete | partial | unavailable` coverage;
- each probe stores explicit `pre-launch` and, when cleanup is confirmed, `post-cleanup` boundary
  diagnostics. A boundary has one initial whole-machine snapshot and an optional confirmation
  snapshot; each metric reading is either trusted with `availableBytes` and one signed
  `decreasePctFromBaseline`, or untrusted;
- `resourceValidity` is only `accepted | invalidated-by-resource-stability`;
- on failure, `partialReport.resourceFailure` supplies the boundary, affected metrics, optional
  probe index, and that same boundary-diagnostics shape.

Do not add a second conclusion enum or unverified-reason taxonomy. The error details code, trusted
readings, confirmation presence, affected metrics, and probe validity already distinguish normal
admission, recovery, confirmed drift, and an unverifiable boundary. Do not duplicate the
`resourceFailure` payload again in error details.

Require a finite positive baseline for the percentage denominator, but accept finite non-negative
boundary/confirmation readings: zero available bytes is the most severe valid decrease, not missing
telemetry. Define positive `decreasePctFromBaseline` as less availability and negative values as
increases; decisions use `max(0, decreasePctFromBaseline)`. Remove
`LlamaCalibrationProbe.resourceRegime`.

Change report `schemaVersion` to `3`. Keep methodology to protocol facts rather than repeating
baseline samples/thresholds already in `resourceMonitoring`. A disabled metric weakens only the
stated resource-stability coverage and is warned explicitly; existing performance-evidence
confidence must not be presented as proof of unobserved resources. When available, the stabilized
host baseline replaces reported host available memory and the VRAM baseline replaces reported GPU
available memory independently.

### Typed rejection and partial report

Add and export one error with discriminated details:

```ts
interface LlamaCalibrationResourceStabilityDetailsCommon {
  partialReport: LlamaCalibrationResourceFailurePartialReport;
  suggestion: string;
}

type LlamaCalibrationResourceStabilityDetails =
  LlamaCalibrationResourceStabilityDetailsCommon &
    (
      | { code: 'CALIBRATION_RESOURCE_DRIFT' }
      | { code: 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED' }
    );

class LlamaCalibrationResourceStabilityError extends ServerError {
  declare readonly details: LlamaCalibrationResourceStabilityDetails;
}
```

Keep only fields guaranteed for both variants in
`LlamaCalibrationResourceStabilityDetailsCommon`. Any future field whose presence or shape differs
between confirmed drift and stability-unverified failures belongs on its corresponding
`details.code` union arm, not as an optional common field.

This matches the library's one-error-plus-details-discriminant pattern better than two subclasses.
It preserves `ServerError` compatibility while giving callers one `instanceof` branch followed by a
typed switch on `details.code`. The message tells the host that resource stability either changed or
could not be verified and suggests asking the user to close heavy work and retry from the beginning.
Prompt text, filesystem internals, and other sensitive values remain redacted.

Add `LlamaCalibrationResourceFailurePartialReport`, extending the general partial report with
`status: 'failed'`, required `resourceFailure`, and optional `diagnosticCandidate`. Boundary,
affected metrics, optional probe index, and readings then have one source of truth even when
pre-launch failure has no probe. The diagnostic candidate contains only `sourceProbeIndexes`, its
evidence level, and literal `usability: 'diagnostic-only'`; referenced clean probes already hold
configs/scores. Omit it when there is no defensible clean candidate. Do not add this field to the
general `LlamaCalibrationPartialReport`; abort and unrelated failure partials retain their existing
surface.

Both exact and adaptive stability failures use `status: 'failed'`, final progress
`phase: 'done'`/`terminalStatus: 'failed'`, no returned report, and no selected/provisional/fallback.
Exact mode therefore gains a documented rejection path that callers must catch.

## Durable artifact ownership

- This plan owns the selected no-regime behavior, implementation sequence, validation protocol, and
  acceptance criteria.
- `ISSUE-calibration-cross-regime-comparison.md` remains the motivating proposal until the fix is
  implemented. Then update it with the chosen resolution and archive it under `docs/dev/issues/`.
- `docs/dev/plans/PLAN-adaptive-llm-calibration.md`, the v0.18-to-v0.19 migration guide, and the
  v0.19.0-to-v0.19.1 migration guide remain historical and are not rewritten.
- `PROGRESS.md` receives a concise Unreleased entry during implementation. Separately correct its
  stale statement that v0.19.1 is still in release preparation, since v0.19.1 is published.
- A new v0.19.1-to-v0.20 migration guide is release-owned and is created only when the user
  explicitly requests release preparation.

## Scope

### In scope

- Fixed trusted resource baseline shared by adaptive and exact strategies.
- Independent asymmetric host-RAM and VRAM decrease guards.
- Bounded baseline sampling and telemetry confirmation reads.
- Pre-launch and post-cleanup hard-stop enforcement.
- Real host-memory refresh trust and independent GPU telemetry trust.
- Typed error, schema-v3 diagnostics, diagnostic-only partial candidate, and progress behavior.
- Removal of regimes/re-anchoring from public types, manager state, pure policy, tests, and current
  documentation.
- Automated tests and bounded live validation on the Windows CUDA reference machine.
- Production-timed quiet screening of provisional independent thresholds and the bounded
  baseline-settle schedule, followed by a user checkpoint.
- Current documentation, issue archival, AGENTS orientation, and Unreleased bookkeeping.

### Out of scope

- Restarting calibration after drift, automatic retry, or any open-ended settling loop.
- Weighting or combining host and VRAM measurements.
- Treating resource increases as interference. *(Amended 2026-08-02: bounded increase bands are now
  enforced per the Decision 3 amendment; what remains out of scope is treating sub-band increases —
  e.g. ordinary settling — as interference.)*
- Cross-platform claims based on the Windows/NVIDIA validation machine.
- Monitoring CPU load, GPU utilization, temperature, clocks, disk pressure, or unrelated process
  activity in this change.
- Applying or persisting any recommendation automatically.
- A calibration UI or example-control-panel feature; that example currently has no LLM calibration
  workflow.
- Rewriting historical plans, release notes, or migration guides.
- Version bump, new migration guide, release PR, tag, GitHub release, or npm publication before an
  explicit release request.

## Work plan

### Phase 0 - Make telemetry truthful and build the threshold-independent guard

**Goal:** centralize bounded, testable resource decisions used identically by exact and adaptive
calibration before collecting any data used to choose defaults. Do not integrate the guard into
manager decisions or freeze threshold values yet.

1. [x] Change `src/system/memory-detect.ts` to return the refresh status on all branches, including
   invalid command output and command failure. Keep the fallback behavior of `getMemoryInfo()` for
   ordinary callers.
2. [x] Thread the status through `SystemInfo.refreshMemoryTelemetry()`, public type exports, TSDoc, and
   direct SystemInfo tests.
3. [x] Add a small internal resource-guard module under `src/utils/` rather than embedding another
   policy inside `LlamaServerManager`. Keep pure calculations separate from async capture/cooldown
   orchestration. Pass thresholds into the pure guard so the experiment can evaluate candidate
   values without changing public defaults.
4. [x] Model host and VRAM readings independently. Require finite positive baselines and accept finite
   non-negative boundary values; never let a host refresh failure invalidate a fresh VRAM reading or
   vice versa.
5. [x] Implement bounded three-attempt baseline collection, per-metric median construction, signed
   diagnostics, asymmetric inclusive threshold comparison, and confirmation state. The
   production path always performs at least one confirmation for a suspicious trusted reading.
   Parameterize the fixed baseline-settle delay so Phase 1 can evaluate it through the same path.
6. [x] Bound each platform telemetry command, propagate the caller abort signal, and classify
   timeout/abort correctly. Ensure every cooldown is abortable and all collection is bounded by
   fixed sample/read counts.
7. [x] Add focused utility tests for median handling, unavailable metrics, independent trust,
   zero-byte boundary readings, just-below/equal/above thresholds, increases, transient recovery,
   confirmed decreases, cross-metric changes, and stability-unverified outcomes.
8. [x] Create one versioned development-only quiet-trace harness and artifact format. Integrate the
   guard temporarily in an observe/shadow path that executes the real manager baseline, pre-launch,
   post-cleanup, cooldown, and confirmation schedule but does not alter the v0.19 decision. Do not
   expose a caller-facing shadow option or ship mixed shadow/enforcement behavior. Shadow
   confirmation is triggered from the lowest replayed candidate threshold. Use an ample explicit
   validation wall budget, record added guard time and any launch-trail perturbation, and do not
   claim shadow waits are invisible to scheduling.

**Verification:** `SystemInfo` tests prove valid Windows output, invalid output, command failure,
non-Windows no-op status, hung-command timeout, and caller abort; guard tests require no real
cooldown or hardware.

### Phase 1 - Screen false triggers and approve provisional defaults

**Goal:** choose provisional independent host/VRAM thresholds and a bounded baseline-settle schedule
from production-timed quiet traces. Do not claim to identify a universal performance-harm boundary.

1. [x] Reuse the pinned Windows CUDA / Gemma 4 12B reference environment and invoke the repository's
   `llama-server` skill before real-model runs. Use headless Electron with hardware acceleration and
   BrowserWindow creation disabled so the harness does not create its own GPU interference.
2. [x] Store a reproducible sanitized record beside the versioned harness: binary/model identities,
   exact profiles/combos, workload hashes/token counts, harness revision, timestamps, baseline
   samples, initial/confirmation readings and trust, cleanup-confirmation timing, signed changes,
   scores, and outcomes.
3. [x] (5 calls used of 8, ~50 min of 90: 4 cells complete; reserve call 1 — the 2p rerun without the caller probe cap — was externally stopped with clean teardown and no artifact) Run a capped quiet matrix through the shadow guard: adaptive one-profile, adaptive two-profile,
   exact near-capacity/full-offload, and exact lower-pressure. Reserve four additional calls to rerun
   those same cells with the final settle/cooldown schedule; use them as ordinary repetitions only
   when no schedule changes. Stop at eight calibration calls or 90 minutes, whichever comes first.
4. [x] Compare fixed preparation-delay candidates and the three-sample median. If cooldown-spaced
   baseline samples remain on the initial settling slope, choose one fixed bounded delay; never add
   a condition-driven settling loop. Once selected, rerun affected traces with that exact schedule;
   pre-delay traces cannot validate the final default.
5. [x] Measure post-cleanup recovery at the production decision points—currently one cooldown at 750 ms
   and confirmation at 1,500 ms—under both near-capacity and lower-pressure configurations. A
   dedicated diagnostic pass samples farther out (for example 2,250 and 3,000 ms) to distinguish
   self-release lag from environmental decrease. If 750/1,500 ms is too early, approve a longer
   fixed `resourceCooldownMs` and rerun the affected cells; do not hide release lag by widening the
   decrease threshold. If no bounded cooldown settles, stop for plan revision.
6. [x] Replay candidate host/VRAM thresholds (for example 10%, 15%, 20%, and the existing 25%) over the
   retained raw traces. Report the initial suspicions and confirmed would-abort sequences for every
   threshold and settle-delay candidate.
7. [x] Propose defaults above the largest confirmed quiet downward envelope plus an explicit
   false-abort margin. Label them heuristic, provisional, and scoped to the observed platform. A
   larger threshold is false-abort-conservative; a smaller threshold is
   comparability-conservative—do not use “conservative” without naming the risk.
8. [x] (resolved 2026-08-02: host 10 dec / 20 inc, VRAM 10 dec / 10 inc, all hard; settle 5000,
   cooldown 750, timeout 10000 approved; long-run settling plateau +10.50% measured by the redo)
   **User checkpoint:** present raw summaries, candidate replay, proposed independent defaults,
   telemetry timeout, fixed settle delay, cooldown value, and platform limits. Do not enable manager
   hard stops or claim a harmful-pressure boundary without explicit approval.

**Verification:** the shadow path never hard-stops or feeds resource conclusions into policy, every
call cleans up, added timing/launch-trail effects are retained, and every candidate at or above the
lowest capture threshold can be replayed without another live run. Phase 6 reuses the same
harness/artifact format for small enforcement smokes.

### Phase 2 - Integrate the guard into adaptive calibration and simplify the controller

**Goal:** admit only clean observations to the adaptive policy and remove all regime behavior.

1. [ ] Establish the stabilized baseline after provisioning, model/profile/cell preparation, and binary
   readiness, but before `policyReadyAt` starts the adaptive probe wall budget.
2. [ ] Move the pre-launch resource check inside the error/partial-report path. On confirmed drift or a
   stability-unverified pre-launch condition, reject before executor invocation and without
   consuming a launch. A confirmation already triggered completes against the caller signal; if it
   recovers after the adaptive wall deadline, do not launch and return the normal
   `budget-exhausted` report. A deadline reached before any trusted suspicious reading also follows
   the normal budget-exhausted path. Caller abort remains aborted.
3. [ ] After each executor finishes and teardown is confirmed, perform the post-cleanup check before
   `applyAdaptivePolicyObservation()`. Use the caller abort signal for the bounded post-check even if
   the internal probe deadline expired.
4. [ ] Stage every observation-derived mutation until that post-check passes, including verified
   profiles, prompt token-count caches, policy evidence, and recommendation inputs. If post-cleanup
   stability fails, append at most one invalidated chronological probe, commit none of that staged
   state, build diagnostics/candidate from prior clean evidence, emit exactly one terminal
   `phase: 'done'`/`terminalStatus: 'failed'` progress payload, and reject. Avoid duplication through
   generic fatal-observation handling.
5. [ ] Freeze error precedence: cleanup-unconfirmed wins first; with confirmed cleanup, a resource
   stability failure supersedes the probe's operational/OOM/fatal outcome because that outcome is
   no longer interpretable. Preserve the original probe failure only inside the invalidated
   diagnostic trail. If the resource check passes, retain normal fatal-observation behavior.
6. [ ] Remove adaptive manager state for drift attempts/readings, settled allocations, current regime,
   re-anchoring, confirmed-allocation exceptions, and launch repeats caused by telemetry.
7. [ ] Remove `AdaptiveResourceDriftStatus`, `resourceRegime`, material-drift classification, comparable
   regime filters, and superseded-regime branches from
   `src/utils/llama-adaptive-calibration-policy.ts`. Every policy observation now has implicit clean
   resource validity.
8. [ ] Add or expose one internal policy helper that derives a diagnostic candidate only when clean
   state already meets the normal independent-reproduction requirement; do not promote a single
   adaptive launch merely because drift ended the search. Maintain an explicit mapping from
   accepted policy-evidence indexes to public chronological probe indexes; invalidated probes make
   those index spaces diverge.
9. [ ] Preserve abort, timeout, cleanup-unconfirmed, prompt-redaction, lifecycle-neutrality, and manager
   unlock behavior.
10. [ ] Convert adaptive manager observe/shadow wiring in place to the approved enforcing path. Delete
    its shadow branch, replay-threshold control, and runtime selector after freezing the defaults.
    Keep only the development harness and retained artifact, which thereafter observe the ordinary
    enforcing API/report path.

**Verification:** existing non-resource golden traces remain unchanged; no policy type or branch
mentions regime/drift; a confirmed drop can never lead to `complete` or policy evidence; and no
adaptive manager branch can select observe/shadow behavior.

### Phase 3 - Apply identical hard-stop semantics to exact mode

**Goal:** exact diagnostic sweeps receive the same comparability guarantee and documented reject
path.

1. [ ] Establish the same stabilized baseline after exact candidate/binary preparation and before the
   first combo launch.
2. [ ] Guard every pre-launch boundary before invoking the executor.
3. [ ] Replace the current debug-only 25% post-run log with the shared post-cleanup confirmation guard.
4. [ ] Maintain a clean-runs collection distinct from the chronological probe trail. A post-drift run
   can be displayed as invalidated but cannot influence `recommendLlamaCalibrationRun()`.
5. [ ] Build `diagnosticCandidate` only from earlier clean exact runs. Confirmed post-cleanup drift on
   the first run yields no candidate because that run is contaminated; pre-launch drift before the
   second run may report the already-clean first run under exact mode's single-launch evidence rule.
   Make exact ranking retain the winning clean public probe index.
6. [ ] Preserve cleanup-failure precedence and structured details through exact and outer catch paths.
   Stage verified-profile/token-count and ranking mutations until post-cleanup acceptance, matching
   adaptive behavior.
7. [ ] Update exact progress to emit exactly one `phase: 'done'`/`terminalStatus: 'failed'` payload and
   never report a completed sweep after stability failure.
8. [ ] Convert exact manager observe/shadow wiring to the identical enforcing path and delete its
   shadow branch, replay-threshold control, and runtime selector.

**Verification:** exact mode launches no later combos after confirmed drift and exposes no usable
recommendation in either returned or error-attached data. No observe/shadow branch, internal mode
flag, or candidate-capture threshold remains in packaged source; Phase 6 drives the ordinary public
enforcing path, with only the development harness and retained trace artifact outside the package.

### Phase 4 - Publish the schema-v3 types, defaults, errors, and reports

**Goal:** make every new semantic explicit and difficult for a host to misuse.

1. [ ] Update `src/types/llm-calibration.ts` with the structured diagnostics, probe validity, typed
   diagnostic candidate, expanded partial report, and schema-v3 report literals.
2. [ ] Add/export `LlamaCalibrationResourceStabilityError` and its discriminated details union from the
   public error surface and root index.
3. [ ] Replace defaults atomically, assert their fixed invariants in tests, and publish
   `llama-runtime-v3`; do not add caller override fields.
4. [ ] Refactor duplicated exact/adaptive partial-report construction enough to guarantee the same
   redaction, resource diagnostics, cleanup state, and candidate usability markers.
5. [ ] Preserve specialized error identity through `redactCalibrationError()` and every adaptive/exact
   outer catch instead of reconstructing a base `ServerError`. Test `instanceof`, typed details, and
   prompt redaction at the final caller boundary for both strategies.
6. [ ] Add one specialized branch before generic `ServerError` handling in `formatErrorForUI()`. Surface
   either calibration-specific details code and its actionable suggestion; cover both in
   `error-helpers.test.ts` and the integration guide.
7. [ ] Update report methodology and warnings for disabled metrics. Do not manufacture a drift decision
   when telemetry is unavailable or repeat baseline/threshold payloads in methodology.
8. [ ] Add a durable `test:packed-api` harness/script that packs the built library and compiles a small
   external TypeScript consumer against the tarball. Exercise `instanceof`, details narrowing,
   schema-v3 types, and the removed fields without relying on source-relative imports.
9. [ ] Ensure generated declarations make the specialized error and typed details usable from that
   packed consumer.

**Verification:** public compile tests consume the new error/details/diagnostics, prove removed keys
and `resourceRegime` are absent, and reject schema-v2 assumptions.

### Phase 5 - Replace resource-regime tests with the new behavioral matrix

**Goal:** prove the hard-stop contract at unit, manager, lifecycle, and public-package levels.

1. [ ] In `tests/unit/llama-adaptive-calibration-manager.test.ts`, use an atomic scripted snapshot queue
   so baseline/pre/post/confirmation host and GPU values cannot become misaligned.
2. [ ] Cover adaptive and exact cases for:
   - bounded baseline collection and refresh-before-read ordering;
   - normal pre/post flow with no confirmation;
   - increases, zero-byte severe drops, and just-under-threshold decreases;
   - individually sub-threshold sequential decreases whose cumulative change from the one fixed
     baseline reaches the threshold and hard-fails without stepwise re-anchoring;
   - suspicious pre-launch reading recovering on confirmation;
   - confirmed pre-launch host-only and VRAM-only drops rejecting without a launch;
   - suspicious post-cleanup reading recovering and admitting the probe;
   - confirmed final-probe post-cleanup drift rejecting before selection;
   - host recovering while VRAM becomes newly suspicious (and the reverse) failing stability
     verification without another read loop;
   - initially suspicious telemetry becoming untrusted failing stability verification, while an
     isolated untrusted reading never manufactures a drift conclusion;
   - one unavailable/untrusted metric not masking confirmed drift in the other;
   - confirmation reads consuming no launch/probe budget;
   - OOM/error evidence coincident with confirmed environmental drift being quarantined;
   - all verified-profile/token-cache/policy/ranking state remaining uncommitted for an invalidated
     observation;
   - partial-report chronology, invalidated-probe marking, diagnostic source indexes that are
     nonempty/unique/chronological/in-range and reference accepted clean probes only,
     exactly-one terminal `done`/`failed` progress callback/event, specialized-error identity after
     redaction, UI formatting, manager unlock, and cleanup/fatal-error precedence;
   - caller abort, telemetry command timeout, and internal deadline behavior during
     baseline/confirmation.
3. [ ] Remove regime/re-anchor/material-drift policy tests and keep existing inline golden adaptive
   traces as regression tests.
4. [ ] Expand `SystemInfo`, defaults, error, public-types, report-shape, and process-level calibration
   tests. Ensure older fixtures provide explicit trusted host and available-VRAM values rather than
   silently disabling the guard.
5. [ ] Run the probe and runner lifecycle suites unchanged as regressions.

**Focused verification:**

```powershell
npm.cmd test -- --runInBand tests/unit/defaults.test.ts tests/unit/SystemInfo.test.ts tests/unit/public-types.test.ts tests/unit/llama-calibration.test.ts tests/unit/llama-adaptive-calibration-manager.test.ts tests/unit/llama-adaptive-calibration-policy.test.ts tests/unit/llama-calibration-probe.test.ts tests/unit/llama-server-runner.test.ts
```

### Phase 6 - Live-validate the completed guard

**Goal:** demonstrate that the implemented protocol avoids false aborts in the bounded quiet matrix
and exercise deliberate rejection at safely reachable boundaries, including post-launch when safe.

1. [ ] Reuse the versioned Phase 0/1 quiet-trace harness and artifact format; do not create a second
   instrumentation path. Run enforcing adaptive one-profile/two-profile and representative exact
   calibrations. Verify the stabilized baseline, absence of false aborts, clean selection evidence,
   and no failed launch.
2. [ ] Use one safely bounded sub-threshold host allocation to show minor change is tolerated, then one
   safely bounded above-threshold host allocation after baseline to show the configured
   confirmation and typed rejection. Exercise both pre-launch no-launch behavior and, where the
   harness can time it safely, post-cleanup invalidation of a completed probe. Preflight a hard
   remaining-memory floor, allocate touched fixed-size chunks, give the helper a TTL/parent-death
   rail plus controller-finally cleanup, and require recovery to the quiet baseline band before the
   next scenario.
3. [ ] Release a temporary disturbance between initial and confirmation readings to verify recovery
   without another server launch.
4. [ ] Attempt a VRAM crossing only with a deliberately lower-pressure profile and measured driver/model
   reserve. If no safe crossing exists, rely on deterministic manager coverage and record the live
   scenario as not run; never risk OOM/driver reset to satisfy this step.
5. [ ] Verify unavailable-metric behavior on a controlled telemetry failure where practical; never
   claim a synthetic failure validates the platform command path.
6. [ ] After each scenario, confirm there is no healthy calibration server or pressure helper, manager
   lifecycle remains unlocked, and a subsequent quiet calibration/normal start can succeed.
7. [ ] Record the results and the Windows/NVIDIA scope in this plan. Do not describe the VRAM default as
   active or validated on Apple, AMD, Intel, or Windows non-NVIDIA paths that currently lack trusted
   available-VRAM telemetry. Record pre/post monitoring's inability to detect a disturbance that
   begins and clears entirely within one launch.

### Phase 7 - Update current documentation and close the proposal

**Goal:** make the host behavior and breaking surface unambiguous without rewriting history or
prematurely releasing.

1. [ ] Update `genai-electron-docs/llm-server.md` for fixed-baseline machine conditions, minor-change
   tolerance, exact/adaptive rejection, pre/post confirmation, try/catch usage, and prohibition on
   applying diagnostic candidates. State plainly that cumulative small decreases can cross the
   original baseline threshold and that a settled material step v0.19.1 would re-anchor now fails.
2. [ ] Update `genai-electron-docs/typescript-reference.md` for defaults, schema-v3 diagnostics,
   partial report, refresh status, and typed error.
3. [ ] Update `genai-electron-docs/troubleshooting.md` with `CALIBRATION_RESOURCE_DRIFT` and
   `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED`, host-facing explanation/retry guidance, and
   cleanup/error precedence.
4. [ ] Update `genai-electron-docs/system-detection.md` for truthful refresh status.
5. [ ] Update `genai-electron-docs/integration-guide.md` with `formatErrorForUI()` behavior and a host
   catch/display/retry example for both stability error codes.
6. [ ] Update the calibration orientation in `AGENTS.md` from regimes/schema v2 to the fixed-baseline
   schema-v3 contract.
7. [ ] Add an Unreleased section to `PROGRESS.md`; separately correct the current v0.19.1 release-status
   line to say it is tagged, released, and published on npm.
8. [ ] Mark `ISSUE-calibration-cross-regime-comparison.md` resolved by this plan and move it to
   `docs/dev/issues/`, preserving the original proposal and a resolution note.
9. [ ] Leave README/package/docs-index version strings and historical migration pages unchanged.

### Phase 8 - Full validation and release-gated work

**Goal:** finish implementation quality gates while keeping publication under explicit user
control.

1. [ ] Run formatting, build, lint, full tests, packed API verification, package dry-run, diff checks,
   and production audit in the repository's normal order.
2. [ ] Inspect generated declarations and package contents for the new public types/error and removal of
   regime/default fields.
3. [ ] Run the `doublecheck` skill against the completed implementation and resolve all substantiated
   findings.
4. [ ] Stop with the work recorded as Unreleased unless the user explicitly requests release.
5. [ ] Only on that request: bump package/package-lock/README/docs-index and the root `src/index.ts`
   `@version` to v0.20.0. Create the v0.19.1-to-v0.20 migration guide covering schema-v2 report
   invalidation/recalibration, removed regime/default fields, the refresh return value, and the new
   adaptive/exact `try/catch` paths. Then open one release PR, merge, tag, create the GitHub release,
   and leave `npm publish` to the maintainer per repository policy.

**Full verification:**

```powershell
npm.cmd run format
npm.cmd run build
npm.cmd run lint
npm.cmd test
npm.cmd run test:packed-api
npm.cmd pack --dry-run
npm.cmd audit --omit=dev
git diff --check
```

## Rollback and incomplete-evidence policy

- Keep the implementation as one unreleased batch. Do not publish a mixture of schema-v3 types and
  schema-v2 manager behavior, or exact-mode hard stops without adaptive-mode hard stops.
- If the quiet screen cannot support false-abort-safe provisional defaults, stop at the threshold
  checkpoint. Leave v0.19.1 as the supported npm version and do not silently substitute values.
- If implementation or live validation exposes an unsolved correctness problem, retain the issue
  and plan as open artifacts and revert the unreleased batch through normal source-control review;
  do not restore re-anchoring piecemeal as a fallback.
- Reports are report-only and the manager does not persist calibration output, so rollback requires
  no data migration. Schema-v3 reports created by development builds are disposable and must not be
  read as schema v2.
- Every live pressure helper is TTL-bounded and tracked before launch. Teardown verification is a
  gate between scenarios; an unconfirmed helper/server stops the experiment rather than allowing
  subsequent trials to inherit unknown pressure.

## Acceptance criteria

- One calibration call establishes one bounded, fixed baseline for each enabled trusted metric and
  never re-anchors or restarts; partial/unavailable monitoring coverage is explicit.
- Minor decreases below independently approved host/VRAM thresholds are tolerated; increases do not
  stop calibration. *(Amended 2026-08-02: increases beyond the approved bands — host 20%, VRAM 10% —
  also stop calibration under the same error code; sub-band increases remain tolerated and
  diagnostic.)*
- A confirmed material decrease in either trusted metric rejects both adaptive and exact modes with
  `LlamaCalibrationResourceStabilityError` and
  `details.code === 'CALIBRATION_RESOURCE_DRIFT'`.
- A trusted suspicious boundary that cannot reach a clean or confirmed conclusion within the fixed
  reads rejects with the same error class and
  `details.code === 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED'`; it never launches or admits
  evidence and is never mislabeled confirmed drift.
- Confirmation uses telemetry reads only and never consumes a server launch or launch budget.
- Every launched probe whose cleanup is confirmed receives a post-cleanup guard even when it is the
  final probe or the internal deadline has expired; cleanup-unconfirmed terminates before resource
  classification.
- No invalidated observation mutates verified-profile/token caches or reaches adaptive
  classification, exact ranking, selected/provisional/fallback construction, or
  diagnostic-candidate calculation.
- A partial diagnostic candidate contains only accepted clean source-probe indexes and evidence
  level; it carries no duplicated application-ready config or score payload.
- Host and VRAM trust/failure are independent, and production Windows refresh failure is observable.
- `resourceRegime`, settled-level/re-anchor behavior, and the old default keys are absent from code,
  declarations, current docs, and active tests.
- Reports and partial reports use schema 3 and policy `llama-runtime-v3` with explicit boundary
  diagnostics.
- Cleanup failure and caller abort preserve their existing higher-priority contracts.
- Every safely feasible quiet and deliberate-interference live scenario passes, all
  helpers/processes clean up, and skipped unsafe scenarios are explicitly recorded and remain
  covered deterministically. Claims remain scoped to measured hardware. Current docs explicitly
  state that boundary sampling cannot detect pressure that begins and fully clears inside a launch.
- Build, lint, formatting, full tests, packed API tests, package dry-run, audit, and diff checks pass.
- Work remains Unreleased with no version/release action until explicitly requested.

## Risks and mitigations

- **False abort from stale Windows RAM data:** return and consume a truthful refresh status; never
  trip on fallback data.
- **False confidence from one noisy baseline:** require at least two trusted values from three
  bounded attempts and use the median independently per metric.
- **Final contaminated probe reported complete:** post-check with the caller signal before policy or
  ranking, even after internal budget expiry.
- **GPU telemetry unavailable outside current NVIDIA paths:** disable only that metric, warn, and
  scope live claims; host monitoring remains active.
- **Suspicion followed by telemetry loss or cross-metric motion:** terminate with the
  stability-unverified details-code variant after the fixed confirmation; never loop or accept
  ambiguous evidence.
- **Thresholds mistaken for universal harm boundaries:** use production-timed quiet traces only to
  screen false triggers, preserve raw results, seek user approval, and label the defaults heuristic,
  provisional, and platform-scoped.
- **Partial candidate accidentally auto-applied:** distinct type/name, literal diagnostic-only
  usability, source indexes only, no selected/provisional/fallback fields, and explicit host
  documentation.
- **Contaminated probe enters state through a catch path:** maintain distinct chronological and clean
  evidence collections and assert policy/ranking call counts.
- **Cleanup error hidden by drift:** evaluate cleanup confirmation first and retain
  `CALIBRATION_CLEANUP_FAILED` precedence.
- **Baseline/confirmation adds startup latency:** keep fixed small counts, mock waits in unit tests,
  start policy budgets afterward, and report real setup duration separately.
- **Settled median removes an accidental false-negative margin:** compare candidate settle schedules
  in the shadow trace and approve thresholds only against the final production baseline placement.
- **Long-run cumulative decline now fails:** document that several minor steps can cross the original
  baseline threshold and that v0.19.1's settled-step re-anchor no longer exists; make host retry
  guidance explicit.
- **Breaking removal surprises npm consumers:** target v0.20, provide a release-time migration guide,
  and explicitly document exact mode's new reject path.

## Approval checkpoints

1. **Plan approval:** approve this behavior and work sequence before implementation starts.
2. **Threshold approval:** after Phase 1, approve the independent host-RAM and VRAM default values,
   settle delay, cooldown, and evidence limits before enforcement is enabled.
3. **Release approval:** after implementation and validation, explicitly request release before any
   v0.20 versioning, migration, PR, tag, GitHub release, or npm action.
