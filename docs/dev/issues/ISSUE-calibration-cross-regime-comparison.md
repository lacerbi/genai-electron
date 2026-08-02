# ISSUE — Resource-regime isolation covers reproduction but not comparison

- Created: 2026-08-02
- Status: RESOLVED (2026-08-02) — see Resolution below; original proposal preserved unchanged
- Package: genai-electron
- Affected API: `LlamaServerManager.calibrate()` (adaptive strategy)
- Found by: v0.19.0 post-release double-check (static review, not observed live)

## Resolution (2026-08-02)

Resolved by the fixed-baseline hard-stop contract implemented on
`feat/calibration-resource-stability` per `PLAN-calibration-resource-stability.md`, which is the
durable owner of the delivered behavior.

None of the three options below was adopted as written. Instead, resource regimes were removed
entirely: one `calibrate()` call now establishes **one fixed baseline** per enabled trusted metric
(available host RAM, available VRAM) after preparation, never re-anchors, and compares every launch
boundary cumulatively against it. A confirmed material change in either direction, or a suspicious
boundary that cannot be verified clean, hard-stops adaptive **and** exact calibration with
`LlamaCalibrationResourceStabilityError`. Only clean observations ever reach the pure controller, so
every comparison listed above — cliff denominator, gross-regression classification, capped/gross
closure, non-monotone promotion, cell competitiveness, and final recommendation — is comparable by
construction and no longer needs regime filtering. `AdaptiveResourceDriftStatus`,
`probe.resourceRegime`, settled-level logic, and regime filters are deleted; reports move to schema
3 / policy `llama-runtime-v3`.

This is closest in spirit to option 1 (invalidate on re-anchor) taken to its conclusion: rather than
re-measuring after a regime change, the library refuses to publish a recommendation it can no longer
stand behind, and asks the host to recalibrate on a quiet machine. Option 3's reporting concern is
covered by run-level `resourceMonitoring`, per-probe `resourceBoundaries`/`resourceValidity`, and
the typed failure's partial report. The documentation constraint below is satisfied: the current
docs no longer claim regime isolation and instead state the fixed-baseline guarantee, its bands, the
retry contract, and the pre/post sampling blind spot.

## Problem

v0.19.0 added confirmed-step drift re-anchoring: when available memory drops materially and the
repeat confirms the same new level, calibration re-anchors its reference, increments
`probe.resourceRegime`, and continues. To keep that honest, `assessMixedFidelityStability()`
assesses only the newest regime, so a point is never *reproduced* by launches taken on either side
of a step.

That guarantee is real but narrow. Every other score comparison in the policy remains
regime-agnostic:

- `findStableCliffReference()` — the cliff denominator can be built from two pre-step launches and
  then used to classify a post-step probe.
- `classifyAdaptiveObservation()` — the gross-regression test compares `observation.scoreMs` against
  a lower reference that may belong to a superseded regime. If the step change also slowed the
  machine, a healthy point can exceed `grossRegressionMultiplier`, and its repeat can then close it
  as `unsuitable`, permanently moving the boundary down. **This is the same failure class as the
  original drift bug, relocated.**
- `canCloseCappedPoint()` / `canCloseSuccessfulGrossPoint()` — filter material drift but not regime.
- `nonMonotonePromotionLayer()` — an interior point from an older regime can trigger promotion.
- `isAdaptiveCellCompetitive()` — a regime-1 cell's best score is compared against a global best
  that may be regime-0, so a cell can be pruned against a score measured under different conditions.
- `resolveAdaptiveRecommendation()` — candidates from different cells can carry different regimes
  and are ranked head to head. A cell fully measured before the step keeps its regime-0 score and
  competes against post-step cells.

So the documented sentence "a selected configuration's independent launches always share one
regime" is true, while the comparison that *chose* that configuration may span regimes.

## Why it was scoped out of v0.19.0

The approved scope was same-regime reproduction only. Extending regime isolation to classification
and selection changes which candidates survive and which cells get pruned, so it needs its own
golden traces and ideally a live run — not a patch riding on a correctness fix.

## Suggested direction (not decided)

Options, roughly in increasing cost:

1. **Invalidate on re-anchor.** Treat a regime change as ending the comparability of all prior
   scores: drop pre-step candidates from selection and require competitive cells to re-measure.
   Simple and obviously correct, but can force a lot of re-measurement and may often end
   `budget-exhausted` in practice.
2. **Regime-scope each comparison.** Thread the active regime through the cliff denominator,
   capped-close, non-monotone promotion, competitiveness and recommendation. More surgical,
   considerably more surface, and needs a decision for every mixed-regime case.
3. **Report and do not act.** Keep today's behaviour, but record in the report when a selection was
   chosen against cross-regime evidence so a consumer can decide whether to trust or recalibrate.

Worth noting that re-anchoring is rare — it needs a material drop plus a confirming repeat — so
option 3 may be adequate in practice, and it composes with either of the others later.

## Constraints

- Whatever is chosen, `genai-electron-docs/llm-server.md`, `troubleshooting.md` and the
  `resourceRegime` TSDoc must state exactly how far the guarantee extends. Today they imply more
  isolation than the code provides.
- The controller must stay a pure deterministic function of the observation trace.

## Related

- `docs/dev/plans/PLAN-adaptive-llm-calibration.md` — the drift-re-anchoring erratum records this
  residual scope explicitly
- `src/utils/llama-adaptive-calibration-policy.ts` — `comparableLaunchEvidence` is the single place
  regime filtering currently happens
