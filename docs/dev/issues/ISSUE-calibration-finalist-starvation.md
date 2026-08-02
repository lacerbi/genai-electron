# ISSUE — An exploratory cell can starve another cell's reserved finalist launch

- Created: 2026-08-02
- Status: CLOSED — NOT REPRODUCIBLE (2026-08-02)
- Package: genai-electron
- Affected API: `LlamaServerManager.calibrate()` (adaptive strategy)
- Found by: v0.19.0 post-release double-check (static review, not observed live)

## Resolution

Closed without a code change after deterministic reachability analysis and simulated legal policy
traces. The local control-flow observation was accurate — admission failure for the first actionable
plan returns a terminal result — but the proposed cross-cell starvation state is not reachable
through the controller:

- `nextAdaptivePolicyAction()` handles the first competitive actionable plan before it can reach
  adaptive completion;
- a non-finalist exploratory action belongs to an unconverged cell phase, and unconverged cells are
  unconditionally competitive;
- scheduling is serial in deterministic cell order, so that exploratory cell necessarily prevents
  a later cell from accumulating finalist evidence in the first place; and
- `applyAdaptivePolicyObservation()` rejects any observation that does not match the controller's
  expected next action, preventing out-of-order evidence from creating the proposed state.

The claimed impact was also incorrect independently of reachability. While a competitive
unconverged cell remains actionable, adaptive `complete` is unavailable: the controller must either
probe that cell or return honest `budget-exhausted`. Skipping to validation elsewhere could at most
strengthen a provisional candidate; it could not produce an evidence-safe `selected` result.

Validation used only controller-approved transitions and required no LLM or hardware:

- 150,000 simulated calibrations across two-context, SWA-pair, and four-cell configurations produced
  63,849 launch-reserve stops and 60,167 time-reserve stops. Permuting the same pending cells at
  every stop exposed zero alternative finalist actions.
- A follow-up specifically varied `resourceDriftStatus` and `resourceRegime`: 60,000 additional
  traces included 85,412 material-drift launches and 54,802 settled regime changes. Their 50,843
  launch-reserve stops likewise exposed zero alternative finalists.
- The focused adaptive-policy suite remained green at 33/33 tests.

One useful semantic clarification remains: reserve slots can go unused when unresolved competitive
exploration reaches the reserve boundary. This is intentional. Spending those slots elsewhere may
improve diagnostic provisional evidence, but cannot make the unresolved run complete. The original
proposal is retained below as an audit record; its problem and impact claims are superseded by this
resolution.

## Problem

`nextAdaptivePolicyAction()` picks the next probe with `plans.find(...)`, scanning cells in
deterministic order and returning the first plan that has an action and is still competitive. If
that plan's probe fails admission, `admitOrBudgetTerminal()` returns a **terminal** result
immediately rather than falling through to the next plan.

Before v0.19.0's boundary-convergence fix, an uncompetitive exploratory cell was pruned by the
competitiveness check, so the scan moved on and a later cell's `finalist` or `winner-validation`
action could still be found. That fix — correctly — stops pruning a cell on its interim low-layer
reference, which means an exploratory cell now stays actionable much longer.

The interaction: once `remainingProbeSlots <= finalistReserve`, a non-finalist probe is denied with
`launch-reserve` (`evaluateProbeAdmission`). Because the denial terminates the whole run, a cell
still bisecting can consume the run's budget and end it `budget-exhausted` **even though the
reserve was being held for a different cell's finalist launch, which admission would have
allowed.**

The result is a downgrade from `complete` + `selected` to `budget-exhausted` + `provisional`. It is
not a wrong answer — the policy never fabricates a selection — but it wastes a run that could have
completed, and it defeats the purpose of reserving launches for finalists.

## Reachability

With the two-cell defaults (`maxProbes: 15`, `finalistReserve: 2`) this needs 13 exploratory probes
before the cliff. Ambiguity repeats and the extra full-fidelity launches that same-regime
reproduction can demand both push toward it. Not observed in the v0.19.0 live runs, which completed
in 5-9 probes.

## Suggested direction (not decided)

Make probe selection reserve-aware rather than making the first denial fatal. Options worth
weighing:

1. On a `launch-reserve` denial, continue the scan for a plan whose action *is* a finalist purpose,
   and only terminate when no admissible action exists anywhere.
2. Order `plans.find` so finalist and winner-validation actions are considered before exploratory
   ones once the remaining slots approach the reserve.
3. Keep the current behaviour but report it honestly — record which cell consumed the budget and
   which reserved finalist was denied, so `budget-exhausted` is diagnosable.

Option 1 is the smallest change that restores the reserve's intent. Option 2 changes probe ordering
globally and would need its golden traces re-derived.

## Constraints

- Must not weaken the selection evidence requirements: a finalist launch that runs because of this
  change still needs its independent reproduction.
- Must keep the controller a pure deterministic function of the observation trace.
- Any change here needs new golden traces; the existing ones do not reach the reserve boundary.

## Related

- `docs/dev/plans/PLAN-adaptive-llm-calibration.md` — Section 10 (probe and wall-time budgets),
  Section 7 (search state machine)
- `src/utils/llama-adaptive-calibration-policy.ts` — `nextAdaptivePolicyAction`,
  `admitOrBudgetTerminal`, `evaluateProbeAdmission`
