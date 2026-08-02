# Plan: Adaptive LLM Calibration

- Created: 2026-08-01
- Status: COMPLETE (2026-08-02) — implemented, hardware-validated, and archived
- Target: unreleased work after v0.18.0

Sources:

- `docs/dev/issues/ISSUE-adaptive-calibration-search.md` - downstream empirical evidence
- `docs/dev/plans/PLAN-llm-runtime-calibration.md` - implemented v0.18.0 foundation
- `ISSUE-adaptive-llm-calibration-gqbr.md` - deferred global/statistical research proposal

## Summary

Replace the generated fixed candidate ladder used when `calibrate()` is called without `combos`
with a bounded, cell-local adaptive search for the best operational `gpuLayers` boundary. Adaptive
mode accepts one or two comparable context profiles and searches each context/SWA/KV cell at its
own boundary. Preserve isolated fresh server launches, scoring, cleanup, cancellation, and
report-only behavior. Retain caller-supplied `combos` with one exact profile as a diagnostic and
reproduction path.

This version deliberately favors a useful engineering result over formal risk certification. It
will seek the fastest reproducible finalist, but when the observations do not reliably distinguish
two configurations it will prefer the configuration with lower known structural GPU-memory
pressure. It will prefer a larger requested context within an explicit product-value tolerance,
but it will not fit a shared global threshold, publish posterior degradation probabilities, or
claim that a few launches establish a distribution-free safety bound.

## Why this plan exists

The v0.18.0 default ladder measures a bounded set of static anchors around the conservative
auto-configuration baseline. It can leave a large unprobed interval immediately below the VRAM
cliff. On the archived reference machine, a downstream cell-local search used ten fresh server
starts in about 18 minutes, found a configuration approximately 13% faster than the generated
ladder's recommendation, and exposed instability in the apparent full-offload winner.

The stronger GQBR proposal could eventually share boundary information through predicted GPU
footprint. That reduction depends on validated footprint arithmetic, a transferable threshold,
and a statistical classifier. Those are not necessary to obtain the demonstrated improvement.
This plan therefore implements cell-local search now and records memory estimates passively so
future evidence can determine whether GQBR is worthwhile.

## Durable artifact ownership

- This plan owns the pragmatic implementation contract, work sequence, and acceptance criteria.
- `docs/dev/issues/ISSUE-adaptive-calibration-search.md` owns the motivating trace and downstream
  evidence. Preserve it as history; after implementation, add a resolution link to the completed
  plan.
- `ISSUE-adaptive-llm-calibration-gqbr.md` owns the deferred global-footprint/Bayesian research
  program. Once this plan is approved, add a status cross-link that cell-local implementation is
  proceeding first. Keep the issue open at the repository root unless the user separately decides
  to archive it.
- `docs/dev/plans/PLAN-llm-runtime-calibration.md` and the v0.18 migration page remain historical
  records and must not be rewritten to describe the new behavior.
- No additional actionable issue is needed.

## Scope

### In scope

- Replace the omitted-`combos` generated sweep inside `LlamaServerManager.calibrate()` with a
  deterministic cell-local adaptive controller.
- Accept one or two total-context profiles with a common exact `parallelRequests` count in adaptive
  mode; keep exact custom-combo mode to one profile.
- Search `gpuLayers` separately inside relevant context, SWA, and optional KV-precision cells.
- Use one timed sample for search probes and the configured full sample count for finalists.
- Require fresh server processes for independent stability observations.
- Separate operational outcome, memory evidence, and the controller's boundary decision.
- Prefer performance normally and lower known structural GPU-memory pressure only when observations are
  unstable or candidates fall inside the existing robustness tolerance.
- Retain exact custom `combos` in caller order as a diagnostic/reproduction strategy.
- Add explicit probe budgets, terminal outcomes, a chronological probe trail, per-cell state,
  provisional/selected distinction, and a directly observed fallback when budget permits.
- Add slim passive memory diagnostics that do not affect decisions in this version.
- Preserve lifecycle neutrality, prompt privacy, capacity verification, cancellation, cleanup, and
  orphan blocking.

### Out of scope

- A shared footprint-space threshold or cross-cell GQBR inference.
- Logistic/probit/Bayesian degradation probabilities, confidence certificates, EVSI, or regret
  optimization.
- A footprint-validation campaign or validation-scope artifact as a prerequisite for this work.
- More than two context profiles, differing slot counts, or profile-specific workload variants in
  one calibration.
- Searching MoE placement, arbitrary advanced llama.cpp flags, model quantization, or output quality.
- Automatic application or persistence of a recommendation.
- A new runtime dependency, worker-thread statistical engine, or calibration UI.
- Version bumps, migration guides, release PRs, tags, GitHub releases, or npm publication until the
  user explicitly requests a release.

## Required behavior

### 1. Public strategy selection

Use the existing `calibrate()` entry point directly:

- `profiles` supplied and `combos` omitted: run the new adaptive strategy across one or two
  profiles.
- `profile` plus non-empty `combos` supplied: run those exact candidates in caller order with full
  fidelity.
- an empty `combos` array remains invalid.
- do not add a sibling `calibrateAdaptive()` API or retain the generated ladder as a public mode.

Represent this as a schema-v2 discriminated input contract, not overlapping optional fields:

```ts
type LlamaCalibrationConfig =
  | {
      profiles:
        | readonly [LlamaCalibrationProfile]
        | readonly [LlamaCalibrationProfile, LlamaCalibrationProfile];
      profile?: never;
      combos?: never;
      contextPreferencePct?: number;
      // adaptive fields
    }
  | {
      profile: LlamaCalibrationProfile;
      profiles?: never;
      combos: readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]];
      // exact fields
    };
```

Adaptive validation accepts one or two profiles. Exact mode deliberately accepts exactly one
profile: do not implicitly expand `profiles x combos`, because that would obscure caller ordering
and candidate identity. A caller needing exact comparisons across contexts runs separate exact
calibrations. `contextPreferencePct` is adaptive-only, defaults to 10, and must be finite and
non-negative. With one profile it has no selection effect.

Enforce the discrimination at runtime for plain-JavaScript and untyped callers before provisioning:

- reject legacy `profile` without `combos` with a targeted migration message directing adaptive
  callers to `profiles: [profile]`;
- reject `profiles` with `combos` with a targeted message that exact custom-combo mode requires the
  singular `profile` field;
- reject inputs containing both `profile` and `profiles`, even if another field would otherwise make
  the strategy inferable.

This is intentionally a breaking replacement of the v0.18 default policy. There are no known
compatibility-sensitive consumers, but persisted reports still require a new `schemaVersion` and
`policyVersion`.

Keep `fixedConfig` semantics. Any fixed field is inherited by every probe and cannot be varied by
a cell or exact combo. Continue to resolve and deduplicate candidates using normalized production
argv from `buildLlamaServerArgs()`, because quantized V-cache normalization can add flash attention.

If `fixedConfig.gpuLayers` is present, adaptive mode degenerates to direct measurement of that one
layer value in each otherwise relevant cell; it does not pretend to have searched a boundary.

Exact mode remains deliberately simpler and is represented as a distinct report/progress variant:

- each supplied combo receives one fresh full-fidelity launch using `samples` and the caller's full
  request timeout;
- adaptive probe/wall-time budget fields and `includeKvCacheComparison` are invalid with `combos`;
- progress retains the known combo index/count plus workload/sample progress;
- exact probes use `boundaryDecision: 'not-applicable'` and have no cell/boundary state;
- the exact winner uses the existing precision, robustness, simplicity, and stable caller-order
  recommendation rule;
- `complete` means the best exact candidate was measured, with
  `selectionEvidence: 'single-launch-measurement'`; it does not imply adaptive reproducibility;
- `no-viable-candidate` means every exact candidate failed.

Adaptive `complete` instead requires `selectionEvidence: 'independent-reproduction'` and the
fresh-launch checks below. The strategy-discriminated report types must make these meanings
explicit rather than placing incompatible invariants on one undifferentiated result.

### 2. Comparable profiles and workload objective

Adaptive profiles must have unique positive safe-integer `contextSize` values and one shared
positive safe-integer `parallelRequests` value. Preserve caller order in report identity, but
normalize scheduling from smaller to larger context. Reject an empty list, more than two profiles,
duplicates, differing slot counts, or any profile with `parallelRequests > contextSize` before
provisioning. Apply the same integer and `parallelRequests <= contextSize` validation to exact
mode's single profile.

Retain the v0.18 measurement invariants for every profile:

- each `profile.contextSize` is the exact total `-c` allocation;
- the shared `profile.parallelRequests` is the exact `-np` slot count;
- `/props` must verify the effective context and slot count on every fresh launch.
- workloads are caller-supplied production scenarios and raw prompts are omitted from reports.
- each workload score is its median scenario wall time.
- the aggregate score is the normalized weighted sum of workload medians.
- startup time remains diagnostic and is not part of the default performance score.
- workload requests remain serial and controlled; this feature does not benchmark concurrent
  traffic even when multiple slots are allocated.

The normalized workload set must be identical across profiles: prompts, completions, weights,
order, seed, and sampling cannot vary by context. As soon as token counts are available, validate
every workload, including requested output tokens, against the smallest profile's verified
effective per-slot capacity. A failure invalidates the whole calibration with a clear preparation
error; it is not a failed cell. Larger contexts do not receive longer prompts in the same run.
Their product benefit is capacity, not a speed benefit demonstrated by this fixed workload, and the
explicit context preference in Section 9 prices that benefit. Consumers use separate calibrations
for differing slot counts or context-specific workloads.

Start with the lowest-pressure cell in the smallest profile. Every attempted launch counts against
the probe/wall-time budgets and appears in the chronological trail, including a startup failure that
causes reference descent. Attach the capacity preflight to the first smallest-profile launch that
successfully reaches `/props` and tokenization; effective per-slot capacity does not depend on
`gpuLayers`. Before that launch's timed work, validate every workload against the verified capacity.
If validation succeeds, continue the same fresh process as the cell's reference—do not pay for a
separate preparation launch. If it fails, stop and clean up that process and return the typed
preparation failure; no further adaptive probes follow. An operational `/props` or tokenization
failure is not proof that the workload is invalid: classify that launch through the ordinary
reference failure/retry rules and attach preflight to the next qualifying smallest-profile launch.
Only a completed capacity calculation showing that a workload does not fit is fatal validation.

### 3. Adaptive cells

A cell fixes one exact profile and every other launch-affecting value except `gpuLayers`. Its
canonical identity includes the profile/context, SWA mode, KV precision, pinned MoE placement, and
all remaining normalized argv.

The default adaptive axes are:

1. each requested adaptive profile;
2. the resolved baseline KV precision when KV comparison is disabled;
3. `swaFull: false` and `swaFull: true` only when sliding-window metadata exists, that profile's
   effective per-slot context exceeds the window, a shared-prefix workload is present, and
   `swaFull` is not fixed;
4. when `includeKvCacheComparison: true`, exactly `q8_0/q8_0` and `f16/f16` as separate cells,
   replacing the baseline precision and searching each at its own layer boundary rather than
   probing f16 only at q8's boundary.

Cell enumeration must normalize K and V together and keep the quantized-V/flash-attention contract.
When KV comparison is disabled, preserve the resolved baseline K/V values. When SWA is irrelevant
or fixed, enumerate one SWA value only.

Retain the current conflict rule: `includeKvCacheComparison: true` is invalid when `cacheTypeK`,
`cacheTypeV`, or `flashAttention` is fixed. A caller that needs q4, bf16, mixed K/V, or a pinned
flash-attention comparison uses exact `combos`; adaptive mode does not silently add those as a
third precision class.

MoE placement is invariant in this version. Resolve baseline KV, MoE, and other non-profile axes
from `fixedConfig` plus one canonical auto-configuration at the smallest context, then keep those
normalized values in every adaptive cell except axes explicitly expanded by the policy. Compute
only the starting `gpuLayers` baseline per profile. Remove the generated one-off MoE flip from the
adaptive path. Advanced MoE
comparisons remain possible through exact custom `combos`. This is an intentional reduction in
default coverage from the v0.18 generated ladder for MoE models; document it and state in every
adaptive report that the recommendation is conditional on the pinned placement.

Order cells deterministically from lower known structural GPU-memory pressure to higher pressure:
smaller context before larger context, windowed before full SWA, and q8 before f16. For otherwise
matched cells, larger context strictly increases KV allocation; do not claim all temporary compute
or backend workspace allocations are monotone. This qualitative ordering may supply conservative
search ceilings, but never substitutes for directly probing a finalist or for an unvalidated byte
estimate.

### 4. Three separate outcome concepts

Every probe must expose three independent fields:

1. `operationalStatus`: the existing process/request result (`ok`, `oom`, `startup-timeout`,
   `request-timeout`, `crashed`, or `error`).
2. `memoryEvidence`: `none`, `suspected`, `confirmed`, or `unknown`, with a reason and source.
3. `boundaryDecision`: `admissible`, `unsuitable`, or `ambiguous`, with a deterministic reason.

Exact-mode probes additionally allow `boundaryDecision: 'not-applicable'`.

Rules:

- A specific allocation-failure diagnostic may be confirmed memory evidence. The existing broad
  operational OOM classification (including generic `CUDA error`) must be split from memory
  attribution; `operationalStatus: 'oom'` does not automatically mean confirmed memory evidence.
- A generic timeout, crash, CUDA error, protocol error, or slow result is not by itself proof of a
  memory threshold.
- A non-`ok` launch is not eligible as a finalist. Its scheduling effect follows the transition
  table below; a contradictory higher-layer success invalidates the assumed bracket.
- Low cache reuse and slow shared-prefix reads in a windowed-SWA cell are expected cell behavior,
  not memory degradation.
- Healthy envelopes and performance-cliff comparisons are always cell-local.
- The report must use terms such as `observed`, `reproduced`, `ambiguous`, and `operational
  boundary`; it must not call the result statistically safe or attach a formal failure probability.

Use this transition table in adaptive mode:

| Observation | First decision | Repeat/transition rule | Bracket effect |
| --- | --- | --- | --- |
| `ok`, score within the cell-local cliff limit | `admissible` | Re-evaluate stability at finalist fidelity | May move `low` up |
| Specific OOM/allocation failure with confirmed memory evidence | `unsuitable` | Repeat only if later evidence contradicts it | May move `high` down immediately |
| Generic startup/request timeout, crash, error, or broad operational OOM | `ambiguous` | If decision-relevant, repeat once with the full caller timeout; a second non-`ok` result is `unsuitable` | First result is a provisional scheduling ceiling only; it cannot resolve a competitive cell |
| Adaptive early-stop cap fires | `ambiguous` | Repeat independently when decision-relevant. At the second launch's cap, stop it early and establish `unsuitable` only when both aggregate lower bounds exceed the `1.5x` cliff limit against the same reproduced lower reference; otherwise let that same second launch continue to the full caller timeout | The first capped result never moves the final bracket; the symmetric two-launch lower-bound rule may move `high` down |
| First successful score above the `1.5x` cliff limit | `ambiguous` | Repeat once at full timeout when decision-relevant; a second gross regression is `unsuitable` | No final bracket move until repeated |
| `ok` result above an existing unsuitable `high` | `ambiguous` with reason `contradiction` | Clear the inherited/provisional `high`; repeat the conflicting endpoint(s) if decision-relevant | Reopen the local search |

A non-decision-relevant ambiguous point may remain a provisional scheduling ceiling so the
controller can spend its budget elsewhere, but it cannot eliminate a cell that still meets the
competitiveness rule or support an inherited cross-cell ceiling.

### 5. Cell-local performance-cliff heuristic

Do not add a narration-specific public workload role. Generalize the archived heuristic to the
existing arbitrary workload mix:

- Treat healthy performance improving with more GPU layers as a working search hypothesis, not a
  guaranteed property.

- A successful search probe is initially admissible when it completes every workload and does not
  show a gross aggregate-score regression relative to the nearest lower-`gpuLayers`, directly
  observed admissible probe in the same cell.
- The default gross-regression threshold is `1.5x`. It is a performance-cliff heuristic, not a
  memory classifier.
- A first successful result beyond that threshold is `ambiguous`, not immediately degraded.
- Repeat an ambiguous point only when it could change the cell boundary or final selection.
- Two independent gross regressions at the same point make it operationally unsuitable for this
  calibration. A later contradictory healthy result reopens the boundary rather than being
  discarded.
- Before two gross successful results or two capped aggregate lower bounds may move `high`, the
  shared nearest-lower reference must itself have two independent admissible launches within
  `stabilityTolerancePct`. These may both be search fidelity because this evidence supports only a
  conservative cliff denominator, not finalist eligibility. Use the slower reproduced launch-level
  score as that denominator. If the lower reference is unstable or cannot be reproduced within
  budget, leave the higher point and cell unresolved rather than excluding it.
- The 25% cliff-denominator tolerance is intentionally looser than the 20% mixed-fidelity finalist
  allowance: the cliff rule uses the slower reproduced score conservatively and does not establish
  finalist eligibility. Do not merge the constants merely because both rules compare launches.
- Do not retroactively relabel an earlier healthy lower-layer point merely because a later point is
  faster. The comparison is against the nearest lower directly observed admissible point available
  when evaluating the higher layer, and the complete reasoning is retained in the probe trail.
- After measuring a boundary at full fidelity, compare it with every lower-layer score observed in
  that cell. If a lower point's search score is at least `nonMonotoneTriggerPct` faster than the
  boundary score, promote that point to a full-fidelity local finalist. The initial trigger is 20%,
  matching the archived single-sample noise allowance rather than reacting to small fluctuations.
- Once the promoted interior point is full-fidelity, independently reproduced, and operationally
  admissible, include it in the ordinary recommendation set; Section 9 alone decides whether it
  wins. Do not start a secondary neighbor search in this pragmatic version. Record a
  `nonMonotoneWarning` and every unmeasured gap, and compare only the directly reproduced interior
  and boundary candidates. This deliberately accepts that an unmeasured neighbor could be slightly
  faster. If the budget cannot reproduce the promoted point, mark that cell unresolved instead of
  selecting its boundary by assumption.
- Before adaptive `complete`, set
  `guardTarget = max(0, selectedGpuLayers - guardDistanceLayers)` and require the winning cell to
  contain a directly observed admissible point at or below that target. If none exists, probe the
  target once before selection. At `g=0`, the selected observation itself satisfies the guard. This
  catches a completed but already-thrashing reference that otherwise has no lower comparator.
  Evaluate a materially faster guard observation through the same non-monotone promotion and
  reproduction rules; do not add a separate neighbor search.

Per-request prompt/decode/cache diagnostics support the explanation and contradiction checks, but
the first implementation does not fit a classifier model.

### 6. Cell-local early stopping

Search probes may use a shorter request timeout only after the same cell has an admissible
reference. A comparable request means the same workload ID and request position within that
scenario. For completion requests only, compute:

```text
adaptiveCapMs = min(
  callerRequestTimeoutMs,
  max(minimumAdaptiveRequestTimeoutMs,
      earlyStopMultiplier * slowestComparableReferenceRequestMs)
)
```

Initial defaults:

- `earlyStopMultiplier: 2`;
- `minimumAdaptiveRequestTimeoutMs: 15_000`.

If no comparable reference exists, use the caller's full timeout. Tokenization, slot erasure, and
other control requests always retain the full caller timeout; add a completion-specific timeout or
abort seam rather than shortening the whole `LlamaCalibrationClient`.

At `adaptiveCapMs`, terminate the completion early only when elapsed time plus completed workload
contributions already lower-bound the best possible aggregate score outside the widest active
performance/preference window: specifically, a direct best score must already exist and the
candidate's aggregate lower bound must exceed `bestDirectScore * competitiveObservedRatio`.
Otherwise allow the request to continue to the caller's full timeout. Finalist and exact-combo
probes always use the caller's full timeout. Any first cap-triggered termination is `ambiguous`. On
the single allowed independent repeat, terminate at the adaptive cap and close the point as
`unsuitable` only when both launches' aggregate lower bounds already exceed
`grossRegressionMultiplier` times the same conservatively scored, independently reproduced lower
reference. Completion could only increase either lower bound, so this is conservative. Otherwise,
do not cap the second launch: let that same process continue in place to the caller's full timeout
and classify its completed outcome. This prevents a slow, low-weight request from excluding an
otherwise competitive aggregate candidate, preserves the cliff-time savings for clearly
infeasible probes, and does not create an accidental third-launch exception to the repeat limit.

### 7. Normative search state machine

Implement the controller as a pure deterministic transition function over an immutable observation
trace. Each affected cell moves through:

```text
pending
  -> finding-reference
  -> establishing-ceiling
  -> bisecting
  -> finalist
  -> resolved | unresolved | no-viable-point
```

For each cell:

1. **Reference**
   - Start at `min(profileAutoConfiguredGpuLayers, cellCeiling)`. Resolve the non-profile KV, MoE,
     and other fixed axes once for comparability, but compute the starting layer baseline for each
     profile.
   - If it is admissible, it becomes the lower bracket.
   - If it is unsuitable or remains ambiguous after its decision-relevant repeat, descend
     deterministically toward zero using `floor(currentGpuLayers / 2)` until reaching zero.
   - Directly probe `g=0` before declaring the cell to have no viable point.

2. **Ceiling**
   - The physical ceiling is the model's resolved total layer count, or the fixed layer value.
   - A higher-memory cell may inherit a lower scheduling ceiling from an otherwise matched
     lower-memory cell only when every other resolved argument matches and the higher-memory cell
     differs solely by a known monotone axis (`smaller context -> larger context`, `window -> full
     SWA`, or `q8 -> f16`). Confirmed allocation-memory evidence may supply a higher-confidence
     scheduling ceiling; a reproduced operationally unsuitable point without confirmed memory
     evidence may supply only a provisional scheduling hint. Neither is final receiving-cell
     evidence. Never transfer an admissible lower bound, performance score, or performance-cliff
     classification across cells.
   - Probe every inherited ceiling/hint directly in the receiving cell. The source observation alone
     never changes that cell's final bracket. The point becomes a local `high` only when the receiving
     cell's own direct observations satisfy the ordinary transition table, including stable lower
     reference requirements for gross regressions. If observations contradict the ordering
     assumption, remove the inherited value, record a warning, and continue toward the physical
     ceiling locally if budget remains.

3. **Bracket**
   - Probe the ceiling if it is not already observed.
   - If it is admissible, the cell is right-censored at the maximum and that point becomes its
     provisional boundary.
   - Otherwise retain the largest directly observed admissible lower point and the smallest
     confirmed-memory or reproduced-unsuitable upper point. A first generic failure may guide the
     next scheduled probe but cannot close the final bracket of a competitive cell.

4. **Bisection**
   - Probe `floor((low + high) / 2)` while `high - low > 1`.
   - Admissible moves `low` upward; confirmed-memory or reproduced-unsuitable moves `high` downward.
   - Ambiguous or contradictory results consume a repeat only when decision-relevant. Otherwise
     keep the conservative lower bracket and mark the uncertainty in the cell report.
   - The provisional boundary is the largest directly observed admissible `low`, never an
     arithmetic-only inference.

5. **CPU-only and `g=0`**
   - A CPU binary or machine without a usable GPU collapses the layer search to `g=0`.
   - Remaining relevant cells are measured directly; no GPU boundary claim is emitted.

The controller may stop low-value cells unresolved once its remaining probe reserve is required to
validate the likely winner. It does not need to determine every theoretical boundary.

### 8. Adaptive finalists, stability, and conservative uncertainty handling

- These requirements apply to adaptive mode; exact mode follows the distinct single-launch contract
  in Section 1.
- Search probes use one timed sample per workload after the existing warmup.
- Each competitive cell boundary receives a fresh full-fidelity probe using the configured
  `samples` value and full request timeout.
- The selected configuration must have at least two independent successful fresh-launch
  observations at the exact resolved argv, at least one of them full fidelity.
- Within-process samples improve the score estimate but do not count as independent launch
  stability observations.
- Recommendation scores come only from full-fidelity launches. When more than one full-fidelity
  launch exists at the exact argv, use the median of all admissible full-fidelity launch-level
  aggregate scores in the calibration; never pool individual request samples across fresh launches.
- One-sample search launches may count as independent operational successes. With exactly one
  full-fidelity launch, compute the mixed-fidelity spread across that launch and **all** admissible
  search-fidelity launches at the exact argv; it satisfies reproduction only when the complete set
  is within `searchNoiseAllowancePct`. If the mixed spread is greater than that allowance, schedule
  another full-fidelity fresh launch when budget remains. Once two or more full-fidelity launches
  exist, determine stability from the spread across all full-fidelity launches at that argv in the
  calibration and retain every search launch only as diagnostic evidence. Do not cherry-pick an
  agreeing pair; any conflicting non-`ok` finalist launch also remains decision-relevant.
- If the selected boundary has a conflicting launch, cross-launch spread above
  `stabilityTolerancePct`, or an
  unresolved performance-cliff result, repeat it when budget allows. If uncertainty persists,
  test one layer lower and prefer that directly observed point unless the higher point becomes
  reproducible.
- A one-layer-lower fallback should be directly measured when `high - selectedGpuLayers <= 1`, the
  selected point showed any instability, or the only upper observation is ambiguous, and budget
  remains. If it was not directly measured, report it only as an unvalidated lower-layer option,
  not as a validated fallback.

This is where the policy errs toward less VRAM: only under unresolved or effectively equivalent
evidence. A clearly faster, independently reproducible boundary remains eligible and is not
automatically penalized by one layer.

Freeze these deterministic predicates in `LLAMA_CALIBRATION_DEFAULTS` and echo them in every
adaptive report:

- `grossRegressionMultiplier: 1.5`;
- `earlyStopMultiplier: 2`;
- `minimumAdaptiveRequestTimeoutMs: 15_000`;
- `tieTolerancePct: 5`;
- `contextPreferencePct: 10`;
- `kvPrecisionPreferencePct: 10`;
- `searchNoiseAllowancePct: 20`;
- `nonMonotoneTriggerPct: 20`;
- `guardDistanceMinLayers: 2`;
- `guardDistanceFraction: 0.10`;
- `stabilityTolerancePct: 25`;
- `resourceDriftThresholdPct: 25`;
- `resourceDriftRetries: 1`;
- `unobservedProbeDurationPolicy: 'configured-conservative-estimate'`;
- `maxRunnerStartAttempts: 2`;
- `capacityCheckTimeoutCapMs: 5_000`;
- `processExitConfirmationMs: 2_000`;
- `processExitSettleGraceMs: 250`.

Definitions:

- Derive and report
  `guardDistanceLayers = max(guardDistanceMinLayers, ceil(totalLayers * guardDistanceFraction))`
  after model metadata resolves; only the minimum and fraction are static defaults.
- `activePreferencePct` is the maximum of `tieTolerancePct`, `contextPreferencePct` when two
  profiles are requested, and `kvPrecisionPreferencePct` when KV comparison is enabled.
- `competitiveObservedRatio = (1 + activePreferencePct / 100) *
  (1 + searchNoiseAllowancePct / 100) / (1 - searchNoiseAllowancePct / 100)`. This protects both
  noisy observations instead of adding a one-sided allowance. With the proposed defaults it is
  1.575 when neither product preference is active, and 1.65 whenever the 10% context or KV
  preference is active.
- A cell is **competitive** until it has a directly observed provisional boundary. After that, it
  remains competitive when its best direct score is no greater than
  `bestDirectScore * competitiveObservedRatio` or it contains a triggered non-monotone interior
  candidate. Do not prune an unresolved cell from a slow low-layer reference, because higher layers
  may improve it materially.
- A probe is **decision-relevant** when it can resolve a competitive cell or active context/KV
  preference, reproduce a promoted non-monotone point, establish winner reproducibility, or
  directly measure a fallback. Unmeasured neighbors of a reproduced non-monotone point do not
  trigger a second local search in this policy version.
- Cross-launch score spread is `(maxScore - minScore) / minScore * 100`. The same exact argv is
  independently reproduced when at least two fresh launches are admissible and either all available
  full-fidelity launches (when there are at least two) are within `stabilityTolerancePct`, or exactly
  one full-fidelity launch and all admissible search-fidelity launches at that argv are jointly within
  `searchNoiseAllowancePct`. A mixed-fidelity spread above the noise allowance remains unresolved
  until a second full-fidelity launch is obtained; if budget cannot obtain it, do not select the
  point. Report the complete evidence set used by this rule.
- **Persistent uncertainty** means the one allowed decision-relevant repeat still conflicts, fails,
  exceeds the stability tolerance, or cannot complete before a hard budget.
- Resource drift compares only host/GPU availability metrics present in both snapshots. A comparable
  metric is material when it falls by more than `resourceDriftThresholdPct` from the
  preparation/reference snapshot. If no metric is comparable, record
  `resourceDriftStatus: 'unavailable'` and a warning; this neither passes nor blocks pragmatic
  calibration and must not support a formal drift claim. Record a metric-specific warning whenever
  GPU or host telemetry is missing even if the other metric remains comparable, so partial
  observability is never reported as complete. Cool down and repeat one reference at most
  `resourceDriftRetries` times for material drift; persistent decision-relevant drift ends
  `budget-exhausted`.
- A cell cannot be called resolved while an ambiguous point inside its final one-layer bracket is
  decision-relevant.

### 9. Recommendation order

For adaptive mode, only full-fidelity, directly observed, independently reproduced, operationally
admissible finalists are eligible. Exact mode retains its Section 1 recommendation rule.

Apply preferences in this order:

1. Remove candidates that failed the independent-launch requirement or remain operationally
   ambiguous.
2. Let `globalFastestScore` be the fastest eligible aggregate score. Define `contextBand` and
   `kvBand` from that same anchor using their respective preference percentages; never chain
   tolerances.
3. Select the largest requested context class having an eligible finalist no slower than
   `contextBand`. With one profile, select that profile.
4. Within the selected context, if KV comparison was explicitly enabled, form `jointBandCandidates`
   from eligible finalists inside `kvBand` and, when two profiles are active, `contextBand`. When
   this set is non-empty, select the largest represented KV precision class and apply both product
   bands. When it is empty (possible under unequal caller tolerances), record
   `kvPrecisionPreferenceResolution: 'fallback-no-joint-eligible'` and keep the precision class of
   the fastest eligible finalist in the selected context that remains inside `contextBand`; the KV
   band is not active for final filtering in this fallback. Otherwise keep the single baseline
   precision. This preserves the explicit f16 preference without creating an empty candidate set or
   compounding tolerances.
5. Within the selected context and precision class, find the class's fastest eligible score and
   retain only candidates inside `tieTolerancePct` of that class-local fastest score **and** inside
   every product band active after Step 4. Thus the structural tie-break cannot move the final result
   beyond a preference band that qualified its context or precision class.
6. Within that equivalence set, apply the known structural pressure order: prefer fewer
   `gpuLayers`; at equal layers prefer windowed over full SWA; then prefer the faster measured score
   and deterministic cell order.

The larger-context and KV rules are explicit product-value preferences, not claims that those
profiles are faster. The structural pressure order is a conservative heuristic for equivalent
evidence, not a byte estimate. Passive memory estimates must not determine health, translate
boundaries, select a context/precision class, or exclude a clearly faster reproducible finalist.

### 10. Probe and wall-time budgets

Let `cellCount` be the actual number of enumerated profile x SWA x KV cells after irrelevant and
fixed axes collapse. It is between one and eight in this version. Resolve adaptive defaults
deterministically from that count:

```text
targetProbes = min(24, 6 + 2 * cellCount)
maxProbes = min(36, 7 + 4 * cellCount)
finalistReserve = min(6, max(2, cellCount))
maxWallTimeMs = min(4_500_000, 900_000 + 450_000 * cellCount)
finalistTimeReserveMs = min(900_000, 150_000 * cellCount)
```

The two-cell case therefore preserves the proposed 10-target/15-maximum/two-reserve/30-minute/
five-minute defaults. Four cells resolve to 14/23/four/45 minutes/10 minutes; eight cells resolve
to 22/36/six/75 minutes/15 minutes. These are global limits for one calibration, not per-profile
allowances. The caps intentionally bound an opt-in worst case; they do not promise to resolve all
eight cells.

In addition:

- `targetProbes` is a soft target after which every additional probe must be decision-relevant;
- `maxProbes` is the hard fresh-launch maximum;
- `finalistReserve` launch slots are held back for winner stability or step-down validation;
- `searchSamples: 1`;
- `samples: 3` remains the default full-fidelity sample count.

Expose `targetProbes?`, `maxProbes?`, and `maxWallTimeMs?` as adaptive caller overrides. Keep
`finalistReserve`, `finalistTimeReserveMs`, `searchSamples`, and the cliff/stability predicates
versioned policy constants in this first implementation. Validate positive safe integers,
`targetProbes <= maxProbes`, `maxProbes > finalistReserve`, and
`maxWallTimeMs > finalistTimeReserveMs` before provisioning.

Caller overrides win over the resolved defaults and every report echoes `cellCount`, the formula
version, effective values, and which values were overridden. Do not silently truncate cells to fit
a smaller caller budget. KV comparison roughly doubles cell count, as does adding a second context;
validation and documentation must make that cost visible. An undersized but internally valid caller
budget is allowed and may honestly terminate `budget-exhausted`.

After `targetProbes`, allow any decision-relevant boundary, non-monotonicity, finalist, ambiguity,
or validation probe under the hard limits; the soft target does not forbid an ordinary probe that
can still change the result. Do not spend the last `finalistReserve` launch slots on non-finalist
exploration. The reserve does not promise full measurement of every surviving cell: if too many
cells remain competitive, prioritize the best direct scores and return `budget-exhausted` rather
than weakening selection requirements.

Protect time as well as launch count. Start a non-finalist exploration probe only when
`remainingWallTimeMs > effectiveFinalistTimeReserveMs + estimatedNextProbeDurationMs`; merely being
above the reserve is insufficient because the new probe could consume it. Estimate the next probe
from comparable observed startup, launch-level workload, and teardown durations. Until such evidence
exists, apply the frozen
`unobservedProbeDurationPolicy: 'configured-conservative-estimate'`:

```text
resolvedCapacityCheckTimeoutMs =
  min(startupTimeoutMs, capacityCheckTimeoutCapMs)

configuredAttemptTeardownMs =
  DEFAULT_TIMEOUTS.serverStop
  + processExitConfirmationMs
  + processExitSettleGraceMs

configuredProbeDurationEstimateMs =
  maxRunnerStartAttempts
  * (startupTimeoutMs
     + resolvedCapacityCheckTimeoutMs
     + configuredAttemptTeardownMs)
  + plannedPostStartupRequestCount * requestTimeoutMs
```

`plannedPostStartupRequestCount` includes every tokenization, slot-control, warmup, and timed
completion HTTP call scheduled at that probe's fidelity; do not use a one-request shortcut. The
attempt factor covers the runner's one bind-collision retry, and teardown includes the configured
kill timeout plus process-confirmation and exit-settle grace for each possible attempt. This is a
deterministic conservative admission estimate, not a formal wall-clock upper bound: filesystem and
OS process scheduling can still add delay. Treat the cell-count formula's
`finalistTimeReserveMs` as a minimum scheduling floor, not a completion guarantee. Once timing
evidence exists, raise the effective reserve to at least the estimated duration of the remaining
required full-fidelity/independent validation launches, using observed comparable launch-level
durations rather than request samples pooled across launches. Report the formula floor, effective
reserve, next-probe estimate, estimate provenance, policy name, request count, attempt/timeout/grace
inputs, and the non-upper-bound caveat. If the estimate already exceeds remaining time, stop
exploration and attempt only the highest-value required validation; if it cannot finish before the
hard deadline, return honest `budget-exhausted`.

`maxWallTimeMs` is a hard elapsed search deadline. Use an internal deadline signal distinct from
the caller's signal. At the deadline, stop the active request/probe and perform mandatory confirmed
cleanup; only cleanup may overrun, and its duration is reported separately. A caller signal rejects
with `aborted`. An internal deadline resolves as `budget-exhausted` after cleanup unless cleanup
itself fails, in which case it rejects as `failed` and preserves the orphan guard. No new probe may
start after either hard budget. Mark the interrupted probe `boundaryDecision: 'ambiguous'` with
termination reason `internal-deadline`; do not turn it into boundary evidence. The controller may
stop before the target when the best candidate is reproducible and every remaining cell has a
direct boundary score greater than `bestDirectScore * competitiveObservedRatio`.

Terminal outcomes:

- `complete`: strategy-specific completion; adaptive reports contain an independently reproduced
  selection with the active context/KV preference decisions resolved, while exact reports contain
  the best single-launch exact measurement;
- `budget-exhausted`: unresolved decision-relevant uncertainty, including an unsearched or
  unresolved cell that could change the larger-context/KV preference, remains; `selected` is absent
  and a `provisional` candidate may be reported diagnostically;
- `no-viable-candidate`: every requested profile and every enumerated cell was resolved and lacks an
  operationally admissible point; `selected` is absent. If a requested profile/cell was never
  searched or remains relevant to a larger-context/KV preference, use `budget-exhausted` instead;
- `aborted`: caller cancellation; reject with a typed partial report;
- `failed`: preparation, invariant, or cleanup failure; reject with a typed partial report.

These adaptive budget fields are rejected in exact custom-combo mode. Exact mode resolves as
`complete` when it has an eligible recommendation and `no-viable-candidate` when all exact
candidates fail. It does not make adaptive boundary or independent-reproduction claims.

### 11. Passive memory diagnostics

Keep instrumentation deliberately slim and diagnostic-only in this version:

- normalized structural axes (`gpuLayers`, SWA mode, K/V types, exact profile) and the layer-count
  source (`metadata` or `fallback`);
- the existing full-attention KV byte estimate, explicitly labelled an upper-bound-style estimate
  that is not SWA-correct for windowed models;
- model size and, if exposed by existing metadata, expert-weight bytes without inventing a new
  per-layer GPU-weight estimator;
- existing available host/GPU-memory snapshots before and after a probe, with used memory derived
  only when total and available values are both known and drift comparability recorded as
  `available`, `material`, or `unavailable` per metric;
- raw operational diagnostics already captured by the runner, plus measurement availability,
  censoring, and warnings.

Do not add a versioned stderr buffer parser, peak-memory sampler, backend adapter campaign, or new
footprint model in this plan. Do not call a value observed during OOM the latent required footprint.
Do not use estimated bytes to infer boundaries or select a winner. The chronological data may
support a later, separately approved GQBR instrumentation/validation effort.

### 12. Report and progress contract

Create a schema-v2 LLM calibration report. Preserve model, binary, machine, workload, privacy, and
methodology identities, while replacing fixed-list assumptions with:

- strategy: `adaptive` or `exact`;
- adaptive requested profiles in caller order, scheduling order, per-profile verification records,
  tested/unstarted state, and smallest-profile workload-comparability validation; exact mode retains
  its single profile and verification record;
- terminal status;
- full chronological probe trail;
- probe purpose (`reference`, `ceiling`, `boundary`, `ambiguity-repeat`, `finalist`,
  `winner-validation`, `fallback-validation`, or `exact`);
- fidelity and independent launch index;
- exact resolved config, normalized argv identity, caller-order `profileIndex`, scheduling-order
  `profileOrdinal`, and canonical profile/cell identity for every adaptive probe. The stable
  `profileIndex` is used consistently by profiles, cells, probes, and progress even though scheduling
  may sort by context;
- operational status, memory evidence, boundary decision, reasons, diagnostics, score, and cleanup;
- per-cell reference, observed bracket, provisional boundary, finalist, stability, inherited-ceiling
  provenance, warnings, and resolution state, plus per-profile best/resolution state;
- adaptive `globalFastestScore`, exact globally anchored context/KV preference bands,
  `contextPreferenceResolution`, and `kvPrecisionPreferenceResolution`;
- `selected`, `provisional`, fallback availability/evidence, and strategy-specific
  `selectionEvidence` as distinct fields;
- budget usage, search elapsed time, time-admission estimates/provenance, cleanup overrun, effective
  defaults, and policy version;
- strategy-specific confidence wording: `empirical-reproducibility` for adaptive selections and
  `single-launch-measurement` for exact recommendations.

`selected.startConfig`, every provisional candidate, and every validated fallback must contain its
exact `contextSize` and `parallelRequests`. A validated fallback is lower-layer evidence in the
selected profile/cell; do not silently switch context. Raw prompt content remains omitted and hashed
exactly as in v0.18.

Freeze `LlamaCalibrationProgress` as a strategy-discriminated schema-v2 union. The names below are
normative; implementation may factor common fields into base interfaces:

```ts
type LlamaCalibrationProbePhase =
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

type LlamaAdaptiveCalibrationPhase =
  | 'preparing'
  | 'policy-ready'
  | 'finding-reference'
  | 'establishing-ceiling'
  | 'bisecting'
  | 'validating-finalist'
  | 'validating-winner'
  | 'validating-fallback'
  | 'stopping';

type LlamaExactCalibrationPhase =
  | 'preparing'
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

type LlamaCalibrationTerminalStatus =
  | 'complete'
  | 'budget-exhausted'
  | 'no-viable-candidate'
  | 'aborted'
  | 'failed';

type LlamaExactCalibrationTerminalStatus = Exclude<
  LlamaCalibrationTerminalStatus,
  'budget-exhausted'
>;

type LlamaAdaptiveProgressBudget =
  | { resolved: false }
  | {
      resolved: true;
      targetProbes: number;
      maxProbes: number;
      finalistReserve: number;
      maxWallTimeMs: number;
      finalistTimeReserveMs: number;
      remainingWallTimeMs: number;
      probeReserveActive: boolean;
      timeReserveActive: boolean;
    };

interface LlamaAdaptiveActiveProbe {
  profileIndex: number; // stable caller-order identity
  profileOrdinal: number; // smaller-context-first scheduling order
  cellId: string;
  purpose: LlamaCalibrationProbePurpose;
  gpuLayers: number;
  fidelity: 'search' | 'full';
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  argvKey: string;
  probePhase?: LlamaCalibrationProbePhase;
}

type LlamaExactProgressCandidates =
  | { resolved: false }
  | { resolved: true; comboCount: number };

interface LlamaExactActiveCandidate {
  comboIndex: number;
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  gpuLayers: number;
}

type LlamaCalibrationProgress =
  | {
      strategy: 'adaptive';
      phase: LlamaAdaptiveCalibrationPhase;
      terminalStatus?: never;
      overallPercent: number;
      elapsedMs: number;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
      activeProbe?: LlamaAdaptiveActiveProbe;
      workloadIndex?: number;
      workloadCount?: number;
      sampleIndex?: number;
      sampleCount?: number;
    }
  | {
      strategy: 'exact';
      phase: LlamaExactCalibrationPhase;
      terminalStatus?: never;
      overallPercent: number;
      elapsedMs: number;
      candidates: LlamaExactProgressCandidates;
      activeCandidate?: LlamaExactActiveCandidate;
      workloadIndex?: number;
      workloadCount?: number;
      sampleIndex?: number;
      sampleCount?: number;
    }
  | {
      strategy: 'adaptive';
      phase: 'done';
      terminalStatus: LlamaCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
    }
  | {
      strategy: 'exact';
      phase: 'done';
      terminalStatus: LlamaExactCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      candidates: LlamaExactProgressCandidates;
    };
```

The first adaptive `preparing` event has `budget: { resolved: false }`, because metadata-driven cell
enumeration has not yet resolved dynamic defaults. Emit `policy-ready` with the complete resolved
budget before the first probe. Exact preparation may similarly have
`candidates: { resolved: false }`; emit `candidates: { resolved: true, comboCount }` before the first
`starting` event. Exact terminal progress carries the same discriminated candidate state, so an early
preparation failure may remain unresolved without making `comboCount` spuriously optional after a
successful `resolved: true` check.

Every `overallPercent` is finite, bounded to 0-100, and non-decreasing within one calibration call.

For adaptive progress, compute monotonic `overallPercent` from completed probes plus a bounded
active-probe phase/workload fraction against resolved `maxProbes`. It remains 0 while the adaptive
budget is unresolved. A terminal `complete`, `budget-exhausted`, or `no-viable-candidate` event uses
100 because the calibration operation finished with a report; terminal `aborted` or `failed` retains
the last monotonic percentage and relies on `terminalStatus` rather than pretending success. Exact
mode uses normalized combo/workload/sample progress and the same terminal rule. Emit the terminal
event only after cleanup is confirmed or has definitively failed, immediately before returning or
rejecting with the typed report.

Emit progress immediately when preparation begins, on every preparation/probe phase transition,
before and after each fresh launch, for each workload/sample transition, whenever the controller
changes cell or probe purpose, and once with the terminal outcome. Adaptive `overallPercent` is an
estimate, not a promise of a fixed probe count; document that host UIs should show the phase/purpose
(and may animate indeterminately during a long startup or request) rather than infer a stall from a
temporarily unchanged percentage. Do not emit invented percentage increments merely to simulate
activity.

Keep callback/EventEmitter payload parity and isolate exceptions thrown by either consumer.

## Execution tracking

- [x] Plan approved and re-read before implementation.
- [x] Phase 1 - extract and verify the fresh-launch probe primitive.
- [x] Phase 2 - implement and verify the pure adaptive controller.
- [x] Phase 3 - switch schema v2 and orchestration atomically.
- [x] Phase 4 - harden evidence, progress, drift, and partial reports.
- [x] Phase 5 - complete automated coverage.
- [~] Phase 6 - live validation, documentation, and archival.
- [x] Run the mandatory final double-check.

Implementation errata resolved from the approval review:

- [x] Add `reference-guard` as a distinct probe purpose.
- [x] Make adaptive active-probe purpose exclude `exact` at the type level.
- [x] Emit a pre-provisioning feasibility warning when the configured conservative estimate exceeds
      `maxWallTimeMs`; do not reject an otherwise valid small budget, which remains allowed to end
      `budget-exhausted`.
- [x] Live-validation erratum: take the post-probe resource snapshot only after the configured
      cooldown. Immediate Windows host-memory accounting includes the probe's own recently released
      model mappings and falsely reports persistent external drift.
- [x] Live-validation erratum: a capped aggregate lower bound is valid only when the adaptive timeout
      occurred during a timed search sample. Include already completed workload contributions and
      the timed-out workload's weighted cap; never treat a warmup timeout as score evidence.
- [x] Resolve the pre-provisioning warning against either the caller override or the maximum possible
      cell-count wall-time default, so default-derived budgets are not silently omitted from the check.
- [x] Live-validation erratum: retain a materially drifting launch in the chronological report but
      exclude it from recommendation timing after a clean repeat resolves the same point. Persistent
      measured drift at that point still ends unresolved after the configured retry.
- [x] Live-validation erratum: an adaptive timeout during warmup has no valid aggregate lower bound,
      so repeat the same point directly with the full timeout rather than reproducing a cliff
      denominator. If that independent full-timeout launch is also non-`ok`, treat the pair as
      reproduced operationally unsuitable evidence.
- [x] Live-validation erratum: after its one independent repeat, an ambiguous high point may remain
      only as a provisional scheduling ceiling while the controller searches lower layers. At the
      final one-layer bracket it blocks only while the directly measured lower candidate remains
      competitive; an explicitly uncompetitive unresolved cell does not prevent a reproduced winner
      elsewhere from completing.
- [x] Live-validation erratum (2026-08-02, post-fix run): a cell has a directly observed boundary
      only once its bracket search has converged. While it is finding a reference, establishing a
      ceiling, or bisecting, `boundaryGpuLayers` is the interim largest admissible point, and
      treating that as a converged boundary let Section 8's competitiveness rule prune a cell on its
      low-layer reference — the exact behaviour Section 8 forbids. Observed live: the swa-full cell
      was abandoned after one `ngl=19` probe whose score reflects offload level, not the cell's axis
      (the windowed cell improved 10,102 → 3,205 ms across the same span), and the run reported
      `complete` with 11 probe slots unused. Pruning on a converged boundary is retained.
- [x] Live-validation erratum: the first probe of a calibration is admitted whenever wall time
      remains. The frozen configured-conservative-estimate prices every planned request at the full
      request timeout, so an ordinary two-workload mix at default timeouts (16 requests →
      2,194,500 ms) exceeds the two-cell default `maxWallTimeMs` and returned a zero-probe
      `budget-exhausted`. Reserves protect later validation launches; before any evidence exists
      there is nothing to protect. Probe-limit and an expired deadline still refuse, and admission is
      unchanged from probe one onward.
- [x] Live-validation erratum: every calibration resource snapshot refreshes platform memory
      telemetry first, via the new `SystemInfo.refreshMemoryTelemetry()`. The Windows standby-aware
      reading has a 60 s TTL refreshed only by `detect()`, which calibration calls once at
      preparation; after it expired, snapshots silently fell back to `os.freemem()`, which excludes
      the standby list. A probe's released mmap'd pages then read as a 32–35% availability drop
      against a standby-aware baseline, scaling with host footprint, so the heaviest cells were
      rejected for a purely instrumental reason. `clearCache()` does not refresh this value.
- [x] Live-validation erratum: the adaptive early-stop cap is floored to an integer before it reaches
      a timer API. `adaptiveCapFor()` derives it from `performance.now()` request deltas, and
      `AbortSignal.timeout()` rejects a non-integer delay, so a healthy probe failed with a spurious
      `error` status that consumed the point's ambiguity repeat and shifted its boundary. The client
      also floors any timeout it is handed. Integer-only unit fixtures could not surface this.
- [x] Live-validation erratum: the drift reference is re-anchorable. A confirmed step change — a
      material drop whose independent repeat lands on the same level within the drift threshold —
      re-anchors the reference and continues in an incremented resource regime rather than ending
      the run, because a machine that settled at a new level still yields mutually comparable
      launches. Readings still moving on the repeat remain persistent drift. Probes record
      `resourceRegime`, and reproduction is assessed only within the newest regime present, so a
      selection is never reproduced by launches straddling a step. Residual scope: cross-point score
      comparison is not regime-filtered, and the fixed preparation baseline is retained for the
      whole-run warning.

## Implementation phases

### Phase 1 - Extract the fresh-launch probe without changing public behavior

**Goal:** Isolate the existing correct process/workload protocol while the v0.18 public types,
generated default, and schema-v1 report still compile and pass.

Phase 1 intentionally keeps the current singular public `profile`; multi-profile schema and
orchestration arrive atomically in Phase 3.

**Work:**

- [x] Extract the candidate loop body from `LlamaServerManager.calibrate()` into an internal
  `runCalibrationProbe` abstraction.
- [x] Accept one exact resolved config, purpose, fidelity/sample count, a completion-specific timeout,
  workloads, seed, signal source, and guarded progress hooks.
- [x] Reuse `LlamaServerRunner`, `LlamaCalibrationClient`, prompt-capacity validation, workload
  execution, scoring, and current cleanup behavior.
- [x] Add explicit redaction of raw configured prompt/prefix/suffix substrings before library-generated
  error text or captured stderr is serialized; document that arbitrary upstream-derived variants
  cannot be proven absent.
- [x] Cache model/workload token counts after the first verified server without weakening per-launch
  `/props` capacity checks.
- [x] Separate broad operational OOM status from specific memory evidence, including generic CUDA
  failures.
- [x] Keep both the generated default path and exact custom-combo path working through the new primitive.
      The generated-default route was superseded by the already-started Phase 3 adaptive switch;
      its generator remains covered as the internal rollback path while exact mode stays live.

**Verification:**

- [x] The unchanged schema-v1 manager surface still builds and passes its current tests. Superseded
      immediately after extraction by the already-started approved Phase 3 atomic schema-v2 switch.
- [x] One probe starts exactly one fresh isolated process and confirms it dead before returning.
- [x] Fidelity and completion-specific timeouts do not affect tokenization/control calls or other probes.
- [x] Exact custom mode retains caller order, serial execution, scoring, abort, and lifecycle neutrality.
- [x] Cleanup failure remains fatal, reports cleanup as unconfirmed, and installs the orphan guard.

### Phase 2 - Add pure adaptive policy and internal evidence types

**Goal:** Implement the deterministic controller independently of Electron, process state, and the
still-public schema-v1 contract.

**Work:**

- [x] Add a focused adaptive policy module rather than growing `src/utils/llama-calibration.ts`
  indefinitely.
- [x] Add a compact trace-fixture DSL whose profile/cell setup and chronological observation rows remain
  readable as scenario tables. Treat these golden traces as executable policy examples, not opaque
  serialized controller state.
- [x] Add internal profile-aware cell, probe, evidence, transition, budget, preference-resolution, and
  terminal-state types.
- [x] Implement and unit-test the major predicates as separate pure functions before composing the
  controller: transition classification, cliff-reference eligibility, capped-close eligibility,
  mixed-fidelity stability, reference guard, product-band resolution, structural tie-break, and
  time admission.
- [x] Implement cell enumeration/order, the transition table, reference descent, ceiling hints,
  bracketing, bisection, competitiveness, non-monotone promotion, finalist scheduling, stability,
  reference guarding, step-down/fallback, globally anchored context/KV recommendation, scaled
  budgets, and terminal outcomes.
- [x] Add the slim passive diagnostics in Section 11 without using numeric estimates in policy.
- [x] Preserve deterministic behavior for a fixed observation trace; no random sampling is required.
- [x] If implementation exposes a genuine policy ambiguity, add a plan-errata note and resolve it in
  review rather than making an undocumented inline judgment call.

  Plan errata resolved during Phase 2: when adaptive mode has fixed `gpuLayers`, the lower-layer
  reference guard is `not-applicable` with reason `fixed-gpu-layers`. The degenerate mode never
  varies the fixed axis, but still requires full-fidelity timing and independent reproduction.

**Verification:**

- [x] Synthetic golden traces produce a stable next-probe sequence and terminal result.
- [x] The trace DSL makes inputs, observations, expected next actions, and terminal outcomes legible
      without reproducing internal controller objects.
- [x] A synthetic fixture based on (and explicitly supplemented beyond) the archived q8 probe order
      finds window `g=48`, full-SWA `g=45`, detects window instability, and selects the reproduced
      full-SWA finalist. Do not claim the incomplete archived narration-only trace is directly
      replayable under the new aggregate/repeat rules.
- [x] A non-monotone fixture promotes and reproduces a materially faster interior point, races only
      directly observed finalists, and schedules no secondary neighbor expansion.
- [x] Generic failures and adaptive-cap timeouts follow the exact transition table and never become
      confirmed memory evidence without a specific allocation diagnostic.
- [x] Two independent capped aggregate lower bounds can close only a proven gross-regression point;
      an inconclusive second launch continues in place to the full caller timeout.
- [x] Context and KV preference tolerances remain anchored to one global fastest score and never
      compound.
- [x] Structural pressure breaks only equivalent evidence, never a clear performance result.

### Phase 3 - Switch the public contract and orchestration atomically

**Goal:** Introduce schema v2 and the adaptive default in one buildable change after the probe and
pure controller are already tested.

**Work:**

- [x] Update `src/types/llm-calibration.ts` for the one-or-two-`profiles` adaptive / one-`profile` exact
  discriminated config, profile-aware progress/probe/cell/report types, terminal outcomes, evidence
  separation, and schema v2.
- [x] Update `src/config/defaults.ts` with every frozen policy value and a new policy version.
- [x] Replace the runner's existing bind-attempt, capacity-timeout-cap, exit-confirmation, and
  exit-settle literals with those shared defaults without changing behavior, so time admission and
  the executed probe path cannot silently drift apart.
- [x] Update `src/types/index.ts` and `src/index.ts` exports and public compile tests.
- [x] Update validation for the runtime `profile`/`profiles`/`combos` discrimination and targeted legacy
  migration errors, profile cardinality/uniqueness/common slots and
  `parallelRequests <= contextSize`, smallest-profile workload fit, adaptive budgets, exact-mode
  conflicts, fixed axes, and optional KV cells.
- [x] Reuse one-time model, binary, capability, identity, workload-token, and occupancy preparation.
  Resolve comparison axes once, but compute and record a profile-local auto-configured layer
  baseline and verify `/props` on every fresh profile launch.
- [x] Replace only the omitted-`combos` branch with `next action -> probe -> observation`; keep supplied
  combos on the exact strategy.
- [x] Build strategy-specific profile-aware reports/progress and map caller abort, internal deadline,
  and cleanup failure to their distinct outcomes.
- [x] Retain `generateDefaultLlamaCalibrationCombos()` as an internal rollback path through live
  validation; do not expose a legacy public strategy.

**Verification:**

- [x] Types, manager report builders, exports, and compile tests switch to schema v2 together.
- [x] Runner retry/capacity/teardown timing values and the configured conservative estimate read the
      same shared constants.
- [x] Empty/duplicate/oversized profiles, differing slots, exact/adaptive conflicts, invalid budgets,
      fixed-field conflicts, and KV/FA conflicts fail before provisioning.
- [x] Plain-JavaScript `profile`-without-`combos`, `profiles`-with-`combos`, and simultaneous
      `profile`/`profiles` inputs receive their specific pre-provisioning migration/conflict errors.
- [x] A workload that does not fit the smallest verified profile fails the whole calibration before
      search after its first budgeted/traced preflight launch is cleaned up; exact mode rejects
      multiple profiles.
- [x] Adaptive and exact reports satisfy their different selection-evidence invariants.
- [x] No new probe begins after either hard budget, and internal deadline is not reported as caller abort.
- [x] Adaptive and exact modes both leave the public manager stopped and preserve normal config.

### Phase 4 - Harden evidence, progress, resource drift, and partial reports

**Goal:** Complete the operational/reporting behavior before broad regression testing.

**Work:**

- [x] Apply objective-aware early completion caps only after a direct cell reference; permit the
  symmetric two-capped-launch gross-regression rule and let an inconclusive second launch continue
  in place to the full caller timeout.
- [x] Enforce launch/time reserves for full-fidelity finalist and independent winner/step-down validation.
- [x] Apply mixed-fidelity escalation, the lower-reference guard, and the frozen resource-drift
  predicate. Missing comparable telemetry warns without blocking; persistent measured
  decision-relevant drift ends unresolved rather than comparing incomparable launches.
- [x] Complete chronological probes, per-profile/cell state, passive diagnostics,
  selected/provisional/fallback, preference resolution, cleanup overrun, and strategy-specific
  confidence fields.
- [x] Preserve typed partial reports for caller abort, deadline exhaustion, preparation failure, and
  confirmed/unconfirmed cleanup outcomes.

**Verification:**

- [x] Every probe process is confirmed dead before the next begins.
- [x] Cleanup failure rejects as `failed`, retains an unconfirmed cleanup record, and blocks later use.
- [x] A later normal `start()` accepts and applies the exact adaptive selected profile/start config.
- [x] Exact progress retains combo counts; adaptive progress uses probe budget and stays monotonic.
- [x] Callback/event progress remains payload-identical and exception-isolated.

### Phase 5 - Complete report and automated coverage

**Goal:** Make the adaptive behavior inspectable and regression-safe without real hardware.

**Work:**

- [x] Replace generated-ladder policy tests with pure state-machine/golden-trace coverage.
- [x] Extend manager tests with a scripted probe executor so adaptive sequences do not require deep HTTP
  mocks.
- [x] Retain exact-mode, capacity, prompt privacy, shared-prefix, abort, teardown, orphan, lock, and
  lifecycle regression tests.
- [x] Extend defaults/public-type tests and add report serialization/narrowing tests.
- [x] Add client tests for completion-specific timeout/abort behavior, full-timeout retries, control-call
  isolation, and prompt redaction.
- [x] Do not add a fake-server integration framework unless unit seams expose an untested process/HTTP
  interaction that existing runner/client tests cannot cover.

**Required automated cases:**

- [x] adaptive profile validation for empty, duplicate, invalid, differing-slot,
      `parallelRequests > contextSize`, and more-than-two profile inputs, plus the same per-profile
      numeric constraints and multiple-profile rejection in exact mode;
- [x] runtime-only legacy `profile` without `combos`, `profiles` with `combos`, and simultaneous
      `profile`/`profiles` shapes receive the targeted errors before provisioning;
- [x] finite/non-negative `contextPreferencePct` validation and one-profile no-op behavior;
- [x] caller profile order remains the stable `profileIndex` identity while smaller-context-first
      scheduling uses a separate ordinal;
- [x] normalized argv and deduplication include exact context/slot identity, so otherwise matched
      candidates in two profiles remain distinct;
- [x] a failed first smallest-profile startup is trailed/budgeted and descends without preflight; the
      first later launch reaching `/props`/tokenization performs capacity preflight, continues as the
      reference on success, and cleans up/fails all calibration on an invalid workload; workload
      identity remains the same across profiles;
- [x] an operational `/props`/tokenization failure retries through the ordinary reference policy and
      is not misreported as deterministic workload-capacity invalidity;
- [x] context-aware cell enumeration for no-SWA, profile-local relevant SWA, fixed-SWA, and optional
      q8/f16 cases, with a hard maximum of eight cells;
- [x] baseline reference success and descent to `g=0`;
- [x] healthy maximum, ordinary bisection, and context/SWA/KV inherited-ceiling contradiction;
- [x] a non-memory reproduced-unsuitable point transfers only a provisional scheduling hint, never
      source-only final bracket evidence;
- [x] CPU-only and fixed-`gpuLayers` degenerate searches;
- [x] one-sample search versus full-sample finalist fidelity, recommendation scoring only from
      full-fidelity launches, mixed 20%-spread acceptance, and mixed-spread escalation to a second
      full-fidelity launch;
- [x] with two search launches and one full-fidelity launch at one argv, mixed stability uses all
      three and cannot cherry-pick the agreeing search result;
- [x] three or more full-fidelity launches use the complete evidence spread and cannot cherry-pick an
      agreeing pair;
- [x] near-cliff conflicting restarts and one-layer step-down;
- [x] a winning reference with no sufficiently lower observation triggers the 10%-of-layers guard;
      a fast guard point enters non-monotone promotion;
- [x] materially non-monotone interior promotion, reproduction, ordinary finalist comparison, and
      no secondary neighbor expansion;
- [x] lower-VRAM equivalence tie-break versus clear performance winner;
- [x] larger-context preference inside/outside the globally anchored 10% window, optional q8/f16
      own-boundary preference, their non-compounding interaction, and structural tie-break exclusion
      of candidates outside any active global band;
- [x] unequal context/KV tolerances that produce no joint-band candidate use
      `fallback-no-joint-eligible`, select the fastest in-context precision, and keep a non-empty
      final set inside the context band;
- [x] MoE placement invariant and explicitly conditional in adaptive mode, and variable through exact
      combos;
- [x] cell-count-scaled effective defaults for 1, 2, 4, and 8 cells; caller overrides; target/max
      probe and wall-time exhaustion with protected launch/time reserves and duration-aware reserve
      escalation/admission estimates;
- [x] before timing evidence exists, `configured-conservative-estimate` deterministically counts
      every planned request, both possible runner attempts, resolved capacity timeout, and teardown
      kill/confirmation/settle values; reports echo the policy, inputs, count, estimate, provenance,
      and non-upper-bound caveat;
- [x] complete, budget-exhausted, no-viable, aborted, and failed reports;
- [x] dynamic early timeout and non-memory timeout attribution;
- [x] a low-weight slow request crosses the adaptive cap while the aggregate candidate remains
      competitive and therefore continues/repeats at the full timeout;
- [x] two capped gross-regression lower bounds close a point only against a stable, conservatively
      scored reproduced lower reference, while an inconclusive second launch continues in place to
      its full timeout without a third launch;
- [x] material resource-drift repeat/unresolved behavior, wholly unavailable telemetry warning
      without false pass/block, and metric-specific warnings under partial observability;
- [x] exact custom order, normalized argv deduplication, and all-failed result;
- [x] exact single-launch selection evidence versus adaptive independent-reproduction evidence;
- [x] progress callback/event parity, required preparation/probe/workload/terminal emissions,
      elapsed/reserve fields, monotonic estimated percentage, early-completion jump, and exception
      isolation;
- [x] public progress union narrows by `strategy`/`phase`, adaptive preparation transitions from
      unresolved budget to `policy-ready`, active probes expose exact `gpuLayers`/resolved config,
      exact candidate counts resolve before the first launch, and every terminal status follows its
      defined 100%-versus-retained-percent rule;
- [x] cancellation at preparation, active request, and between probes;
- [x] internal hard deadline maps to budget exhaustion, distinct from caller cancellation;
- [x] unconfirmed teardown installs the orphan guard and stops the search;
- [x] generic CUDA operational OOM remains unconfirmed memory evidence;
- [x] unstarted or unresolved preferred-context cells yield `budget-exhausted`, while
      `no-viable-candidate` requires every requested profile/cell to resolve nonviable;
- [x] profile-aware progress and report serialization include requested/tested contexts, exact
      preference bands/resolutions, caller index plus scheduling ordinal, inherited-ceiling
      provenance, and selected profile/start config;
- [x] no normal manager lifecycle events and no raw configured prompt substrings in serialized
      reports/errors.

### Phase 6 - Live validation and documentation

**Goal:** Verify the policy on the motivating machine and make the changed contract authoritative.

**Work:**

- [x] Re-run the archived Windows CUDA/Gemma 4 12B profile/workloads with the adaptive default and
  compare the newly complete probe trail with the historical narration-only trace; do not require
  identical stochastic outcomes.
- [x] Run a one-call two-context validation with the same workloads and slot count, verifying inherited
  scheduling ceilings, own-context finalists, global-fastest-anchored preference resolution, and
  bounded total cost.
- [x] Verify fresh-launch instability handling, full-fidelity selection, fallback evidence, total starts,
  calibration wall time, cleanup, and a subsequent normal start.
- [x] Compare the selected score and calibration cost with the archived v0.18 generated sweep. Timing is
  diagnostic; do not create a brittle universal performance assertion.
- [x] Record whether the two-cell `maxProbes = 7 + 4 * cellCount` intercept repeatedly causes honest
  exhaustion specifically because of the new guard, denominator reproduction, or mixed-fidelity
  escalation. Treat this as evidence for a later `8 + 4 * cellCount` policy revision, not as an
  implementation defect or an automatic change during this plan.
- [x] Update current public documentation and unreleased progress records listed below.
- [x] Once this plan is approved, add a short status cross-link from the GQBR issue stating that
  pragmatic cell-local work proceeds first while GQBR remains deferred research.
- [x] After implementation passes acceptance, add resolution links to the archived downstream issue,
  mark this plan complete, and archive it under `docs/dev/plans/`.
- [x] Run all repository quality gates.

**2026-08-02 post-fix live-validation record (supersedes the pre-fix record below):**

Reference machine: Windows 11, RTX 4060 Laptop 8 GB, Gemma 4 12B IQ4_XS, GUI-provisioned llama.cpp
b9860 CUDA binary. The harness was recreated through the public `calibrate()` / `start()` APIs in a
headless Electron main process (`app.disableHardwareAcceleration()` plus `--disable-gpu`, no
`BrowserWindow`), which avoids the Chromium GPU-helper crash that blocked the pre-fix attempt.
Workloads are structurally representative, not the archived downstream prompts: an 861-token
cold-prefill at weight 8 and a 1,524-token shared-prefix burst of three requests at weight 2. Both
are short relative to the context, so these runs validate the mechanism rather than any particular
application's profile; workload choice belongs to the consuming app.

- **One profile, 12,288 x 1 slot, default budgets:** `complete` in 294.2 s over 5 probes with no
  failed launch. Selected `gpuLayers 48 / swaFull false / q8_0 KV / flash attention on` at 2,868 ms,
  reproduced across two independent launches (2,804 search and 2,868 full fidelity, a 2.3% spread).
  The swa-full cell was searched to its own boundary (reference 11,474 ms, ceiling 13,772 ms) and
  then correctly pruned once that converged boundary failed the competitiveness ratio against
  2,868 x 1.575 — demonstrating both halves of the boundary-convergence fix in one run. A subsequent
  normal `start()` applied every selected flag, `/props` verified 12,288 tokens and one slot, and the
  server stopped cleanly. Cleanup confirmed on all five probes.
- **Two comparable contexts in one call, 12,288 + 16,384 x 1 slot, SWA pinned:** `complete` in
  263.0 s over 6 probes with no failed launch. Per-profile auto-configured baselines differed (19 and
  9 layers) and both cells resolved at their own boundary of 48. `globalFastestScoreMs` was 2,830 —
  the larger context — so with a 3,113 ms band `contextPreferenceResolution` resolved to
  `largest-in-band` and the 16,384 profile was selected at 2,830 ms with two independent launches.
  Caller order remained the stable `profileIndex` while scheduling ran smaller-context-first. The
  selected configuration then started normally with every flag and the exact profile, `/props`
  verified 16,384 tokens and one slot, and it stopped cleanly.
- **Two comparable contexts, 16,384 + 32,768 x 1 slot (pre-timer-fix, superseded):** returned an
  honest `budget-exhausted` after 9 probes with `selected` absent and a diagnostic `provisional`. The
  conflict/step-down/unresolved chain behaved exactly as specified, but its trigger was the spurious
  fractional-timeout `error` described below rather than real near-cliff instability, so this run is
  retained only as evidence that the conservative path works — not as a measurement of 32,768
  behaviour on this card.
- **Cost comparison with the archived v0.18 generated sweep:** the archived ladder used 9 candidates
  and 51.6 minutes on this machine. These post-fix adaptive runs used 5-6 fresh launches and 4.4-4.9
  minutes, well inside the 15-launch/30-minute two-cell defaults, and both reached `complete` with an
  independently reproduced selection. Probe count is lower and wall time is roughly an order of
  magnitude lower, but the workloads here are far lighter than the archived narration set, so the
  wall-time ratio reflects workload weight as much as policy efficiency and the selected-score
  comparison is deliberately not carried over as a performance claim.
- **Not validated on hardware:** midpoint bisection. On this card the boundary sits adjacent to the
  physical ceiling (47-48), so the controller reaches it by ceiling probe and one-layer step-down
  rather than by halving an interval. Interval bisection remains covered by golden traces only.
- **Fractional adaptive-cap defect (found and fixed during this validation):** in three consecutive
  runs the first `gpuLayers 48` probe of a freshly scheduled cell returned `error` after roughly 13 s
  and then succeeded on its repeat. This was not a hardware transient. `adaptiveCapFor()` derives the
  early-stop cap from `performance.now()` request deltas, so it is fractional, and
  `AbortSignal.timeout()` rejects a non-integer delay ("Received 30709.872999999963" =
  `earlyStopMultiplier * 15354.9365`). It only surfaced when the fractional middle term won the
  min/max clamp; pinned to 120,000 or 15,000 the value is an integer and passes, which made it look
  intermittent. Every unit test supplied integer timeouts, so 881 passing tests could not see it.
  The cap is now floored at the source and the client defensively floors any timeout it receives.
  Impact on earlier runs: the spurious `error` made an otherwise healthy point conflicted, consumed
  its ambiguity repeat, and forced a one-layer step-down — which inverted the two-context result
  (12,288 selected via `fastest-only` before the fix, 16,384 via `largest-in-band` after it). Any
  measurement taken before the fix must be read with that in mind.

**2026-08-02 pre-fix live-validation record:**

- Ran the adaptive default on the Windows CUDA / Gemma 4 12B IQ4_XS reference machine with one
  12,288-token, one-slot profile and representative cold-prefill plus shared-prefix workloads. The
  archived downstream prompts are unavailable, so this is a structurally representative run rather
  than a claim of exact historical replay.
- The pre-fix run returned an honest `budget-exhausted` report after 11 fresh starts and 676,783 ms,
  with a complete chronological trail and monotonic terminal progress. Windowed q8 `g=47`
  completed three full-fidelity launches at approximately 5.69, 5.91, and 5.86 seconds; full-SWA
  `g=19` completed twice at approximately 14.17 and 13.62 seconds, while full-SWA `g=48` timed out
  twice. Cleanup was confirmed after every probe; no Electron/llama process or health endpoint
  remained.
- The run exposed and drove regression-tested fixes for post-clean resource-drift resolution,
  warmup-cap classification, cross-cell/fidelity timing admission, provisional ambiguous ceilings,
  and provisional reporting. Because those fixes change the subsequent policy path, the recorded
  terminal result is evidence for the defects and cleanup behavior, not final post-fix performance.
- A shorter follow-up normal-start harness was blocked before any probe by this host Electron
  executable's Chromium GPU-helper crash and displayed an application-error dialog. Its temporary
  processes were terminated and no llama process was started. Do not count live normal start/stop or
  two-context hardware validation as passed; the scripted manager suite covers both contracts.
- This one noisy two-cell run confirms the 15-launch ceiling was not itself reached, but it does not
  justify changing the budget intercept. Reassess `7 + 4 * cellCount` only after additional ordinary
  production traces, as planned.

**Verification:**

- [x] The reference trace completes within `maxProbes` and the configured search deadline or returns
      an honest unresolved result.
- [x] The adaptive selected configuration completes two independent fresh launches, including one
      full-fidelity launch.
- [x] No calibration process, healthy endpoint, temporary slot state, or orphan remains.
- [x] A normal manager start uses every selected flag and the selected exact context/slot profile,
      then stops cleanly.
- [x] `npm run build`, `npm run lint`, `npm run format`, and `npm test` pass; run the open-handle
      diagnostic unconditionally because the implementation changes repeated process/deadline cleanup.

## Documentation

Update during Phase 6:

- [x] `README.md` - concise adaptive comparable-profile feature summary only; do not change release
  version.
- [x] `genai-electron-docs/llm-server.md` - authoritative usage, search behavior, exact combos, budgets,
  context/KV preferences, identical-workload limitation, MoE pinning, empirical confidence,
  a host-app progress-bar example that narrows exact/adaptive/terminal events, application of the
  selected config, and report invalidation. Replace the current statement that context sweeps
  require separate adaptive calls; preserve historical documents unchanged.
- [x] `genai-electron-docs/typescript-reference.md` - exact public config/report/progress unions, stable
  phases/defaults, and schema v2.
- [x] `genai-electron-docs/troubleshooting.md` - budget exhaustion, unstable boundaries, failed references,
  early stops, partial reports, step-down behavior, resource drift, and stale reports.
- [x] `genai-electron-docs/resource-orchestration.md` - update the recommendation field cross-reference if
  its name/shape changes.
- [x] `genai-electron-docs/index.md` - concise feature/navigation wording only.
- [x] `PROGRESS.md` - add an Unreleased entry after implementation; preserve the v0.18 historical record.
- [x] `AGENTS.md` - add a concise LLM calibration API/defaults orientation entry if the implementation
  changes the facts future agents need.

Do not update `DESIGN.md`, historical plans/issues, or `migration-0-17-to-0-18.md`. Create the next
migration guide only as part of a later explicitly requested release.

## Rollback

- Keep the current generated-candidate helper and schema-v1 report builder reachable internally
  until automated and live adaptive acceptance passes.
- If pure/controller tests fail, leave the omitted-`combos` branch on the v0.18 generator and keep
  the extracted probe primitive only if its unchanged exact/generated regression suite passes.
- If live validation exposes materially worse selection, excessive unresolved outcomes, cleanup
  regressions, or impractical calibration time, restore the omitted-`combos` branch and schema-v1
  public behavior before merging the feature. Preserve the adaptive trace data for policy revision.
- Delete the legacy generator/report builder only after Phase 6 sign-off and the user's approval to
  proceed with the new default. There is no persisted-data migration or automatic recommendation
  state to roll back.

## Risks and mitigations

1. **One launch is noisy.** Search probes guide the bracket; they do not establish reliability.
   Require an independent exact-config launch for selection.
2. **Operational failure is not memory failure.** Keep status, memory evidence, and boundary decision
   separate and serialize the reasons.
3. **The 1.5x rule can be order-sensitive.** Compare only within a cell against the nearest lower
   direct admissible observation; treat the first cliff as ambiguous, retain the trace, and promote
   materially faster interior points after the full-fidelity boundary check.
4. **Context/SWA/KV ordering can be violated by unmodelled workspace behavior.** Only KV allocation
   is arithmetically monotone across otherwise matched contexts. Use every cross-cell relationship
   only as a scheduling ceiling, probe directly, and reopen on contradiction.
5. **Up to eight opt-in cells may exceed the capped budget.** Scale limits deterministically with
   actual cell count, keep KV comparison opt-in, reserve finalist launches, expose the increased
   cost, and return `budget-exhausted` rather than fabricate certainty.
6. **Adaptive progress has no known final count.** Base monotonic progress on the hard budget and
   expose the active phase/reason.
7. **Cooldown may not restore memory state, and telemetry may be absent.** Snapshot available
   resources, repeat a reference on measured material drift, stop unresolved if measured launches
   remain incomparable, and warn rather than treating wholly unavailable metrics as a pass.
8. **A monolithic manager refactor could weaken cleanup.** Land and test the exact-combo path on the
   extracted probe primitive before enabling the adaptive controller.
9. **Memory estimates may look authoritative.** Label source/availability/censoring and keep numeric
   estimates out of policy; use only the explicit structural pressure order for equivalent evidence.
10. **Breaking report semantics can confuse persisted consumers.** Use schema v2, a new policy
    version, explicit strategy/status, and document invalidation.
11. **A completed reference can already be beyond the performance cliff.** Require a materially
    lower admissible guard observation in the winning cell before completion and promote it when it
    exposes non-monotonicity.
12. **Pinning MoE placement can miss a better counterfactual.** Call this an intentional default
    coverage reduction from v0.18, make adaptive conclusions conditional on the pinned placement,
    and retain exact combos as the escape hatch.
13. **A larger context cannot show a workload benefit under fixed comparable prompts.** State that
    its value is capacity, keep both preference windows anchored to the global fastest score, and
    require separate calibrations for profile-specific workloads.

## Acceptance criteria

### Search and selection

- [x] Omitted `combos` uses cell-local adaptive search; supplied `combos` remains exact mode.
- [x] Adaptive mode accepts one or two unique context profiles with common slots and identical
      workloads; exact mode accepts one profile, and invalid combinations fail before provisioning.
- [x] Every adaptive cell varies only `gpuLayers`; all other resolved arguments are stable in-cell.
- [x] Relevant profile-local SWA and opted-in KV alternatives are measured at their own direct
      boundaries; inherited context/SWA/KV ceilings are directly checked and reopened on
      contradiction.
- [x] An adaptive selected configuration has full-fidelity timing and at least two independent
      successful launches at exactly the reported argv; an exact selected configuration is labelled
      as a single-launch measurement.
- [x] A clearly faster reproducible candidate is not displaced merely for using more VRAM.
- [x] Larger context is preferred before f16 only inside its explicit global-fastest-anchored 10%
      band; the two product preferences never compound, and the final structural tie-break remains
      inside every active global band.
- [x] Unequal caller preference tolerances cannot empty recommendation candidates; the documented KV
      fallback remains inside the context band and is reported explicitly.
- [x] The known structural pressure order wins when candidates are within the robustness tolerance
      or the higher-pressure result remains unstable; passive byte estimates do not select it.
- [x] A materially faster observed interior point is promoted to full fidelity; an unresolved
      detected non-monotone cell cannot emit an adaptive selection.
- [x] The winning cell has a directly observed admissible point at or below
      `max(0, selectedGpuLayers - max(2, ceil(totalLayers * 10%)))`, or the guard's resulting
      non-monotone evidence is fully resolved before selection.
- [x] Reproduced gross/capped regressions use a stable independent lower reference and a conservative
      denominator; the second capped launch either proves the lower-bound rule or continues in place
      to full timeout.
- [x] Budget exhaustion or unresolved decision-relevant ambiguity never exposes a provisional
      candidate as selected.
- [x] Reports make no formal fresh-launch risk or distribution-free confidence claim.

### Lifecycle and operations

- [x] Calibration requires the normal manager to be stopped and blocks normal start/restart and a
      second calibration.
- [x] Every probe is loopback-only, serial, capacity-verified, and fully stopped before the next.
- [x] No normal lifecycle state, config, watchdog, restart behavior, or events are mutated by probes.
- [x] Caller abort returns a typed partial report after confirmed cleanup; cleanup failure rejects as
      `failed`, records cleanup as unconfirmed, and installs the orphan guard.
- [x] An unconfirmed cleanup blocks later lifecycle operations through the existing orphan guard.
- [x] No new work starts after hard budgets; mandatory cleanup overrun is separately reported.
- [x] Non-finalist exploration cannot consume the protected launch or effective time reserve; an
      insufficient reserve produces honest budget exhaustion rather than weaker validation.

### Reporting and privacy

- [x] Schema v2 contains requested/verified/tested profiles, workload-comparability validation,
      identities, methodology, chronological probes, per-profile/cell state, preference resolution,
      evidence separation, terminal status, selected/provisional/fallback, effective scaled budgets,
      and cleanup outcome.
- [x] Every selected or validated fallback config corresponds to an exact direct probe.
- [x] Memory estimates are marked passive and distinguish estimated, observed, unavailable, and
      censored values.
- [x] Profile caller identity and scheduling order are distinct, MoE-conditional scope is explicit,
      and partial or wholly missing resource telemetry produces the required warnings.
- [x] Host applications receive callback/event-parity progress at every required transition, with
      phase/purpose, probe and workload/sample counts, elapsed/reserve state, and a monotonic clearly
      documented estimated percentage suitable for a progress bar.
- [x] Progress is a public strategy/phase-discriminated union: unresolved preparation budgets become
      explicitly resolved, active adaptive probes contain their exact layer/start config, and
      terminal status/percentage semantics are unambiguous for every outcome.
- [x] Raw configured prompt/prefix/suffix substrings are redacted from serialized reports, progress,
      and library-captured errors; docs do not overclaim redaction of arbitrary transformed upstream
      stderr content.

### Quality

- [x] TypeScript strict build passes with zero errors.
- [x] ESLint passes with zero errors.
- [x] Prettier formatting and `git diff --check` pass.
- [x] Full Jest suite and an unconditional open-handle diagnostic pass without leaked processes.
- [x] Live reference validation and subsequent normal start/stop pass.
- [x] Documentation matches the actual exported contract and effective defaults.

## Approved design decisions

The user approved these decisions for the updated plan:

1. Keep `combos` as the implicit, caller-ordered exact diagnostic mode with one `profile`; use one
   or two `profiles` only in adaptive mode.
2. Fold context into the adaptive cells with identical workloads/common slots and prefer the larger
   requested context inside a globally anchored 10% window before applying the f16 preference.
3. Search q8 and f16 as full own-boundary cells only when `includeKvCacheComparison` is explicitly
   enabled; keep the option disabled by default.
4. Pin the auto-resolved MoE placement in adaptive mode, document the intentional v0.18 coverage
   reduction, and leave MoE experiments to exact combos.
5. Scale probe/time defaults deterministically by actual cell count with 24/36-probe and 75-minute
   caps; caller overrides win and honest budget exhaustion is acceptable.
6. Add the lower reference guard, conservative two-capped-launch cliff rule, mixed-fidelity
   escalation, and telemetry-unavailable warning behavior.
7. Prefer performance normally; use known lower structural GPU-memory pressure only inside the 5%
   equivalence window or under unresolved instability.
8. Replace the public report with schema v2 now rather than carry compatibility aliases for a
   release with no known consumers.
9. Define unequal-tolerance KV fallback, defer capacity preflight to the first launch reaching
   `/props`, enforce targeted runtime discrimination errors, and freeze the unobserved-duration
   policy before implementation.
10. Preserve interim host-app progress through callback/EventEmitter parity with adaptive
    phase/purpose, budget, elapsed, workload/sample, and monotonic estimated-percent fields.

---

**Completed 2026-08-02.** Implementation, automated coverage, and hardware validation are done; the
resolution record lives in `docs/dev/issues/ISSUE-adaptive-calibration-search.md` and the unreleased
summary in `PROGRESS.md`. Release steps (version bump, migration guide, tag, publish) are deliberately
out of scope until separately requested.
