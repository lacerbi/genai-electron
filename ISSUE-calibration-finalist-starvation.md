# ISSUE — An exploratory cell can starve another cell's reserved finalist launch

- Created: 2026-08-02
- Status: PROPOSAL — read and confirm with the user before implementation
- Package: genai-electron
- Affected API: `LlamaServerManager.calibrate()` (adaptive strategy)
- Found by: v0.19.0 post-release double-check (static review, not observed live)

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
