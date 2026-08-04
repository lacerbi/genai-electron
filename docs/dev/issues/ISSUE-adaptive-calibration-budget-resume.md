# ISSUE: Adaptive calibration on slow machines — budget formula, no resume, dead-end provisional

**Filed from:** palimpsest-engine (consumer), 2026-08-04, after the first production
adaptive run on the reference machine (8 GB VRAM, Gemma 4 12B IQ4_XS).

**Superseded by:** [`PLAN-simplify-adaptive-calibration.md`](../plans/PLAN-simplify-adaptive-calibration.md),
which removes speculative reservation/finalization and returns the best clean incumbent at a real
method-entry deadline. The observations below remain the original production evidence.

**Run configuration:** `profiles: [12288, 16384] × 1 slot`, KV pinned q8_0 + FA on
(no `includeKvCacheComparison`), 3 workloads (1 cold-prefill + 2 shared-prefix),
`samples: 2`, default budgets → 4 cells, target 14 / max 23 probes, 45 min wall cap.

**Observed:** `status: budget-exhausted`, `terminalReason: 'required probe denied by
time-reserve'` at ~30 elapsed minutes. Provisional
`p0:c12288:swa-window:kv-q8_0` at 4.2 s/scenario; nothing applied. The operator's
summary: half an hour spent, a named result on screen, and no way to use it.

## Problem 1 — the wall-time formula ignores observed launch cost

`resolveAdaptiveBudgets` derives `maxWallTimeMs` from cell count alone
(`900_000 + 450_000 × cellCount`, here 45 min). Admission then prices the remaining
required launches at the slowest observed full-fidelity launch
(`estimateEffectiveFinalistTimeReserve`: `max(finalistTimeReserveMs,
remainingRequiredLaunches × max(fullDurations))`). On this machine a full launch costs
~5 minutes (model load on 8 GB + 3 workloads × 2 samples), so mid-run the effective
reserve exceeded the remaining 15 minutes and a required probe was denied — the run
spent two thirds of its budget and concluded it could never have finished inside it.

The two halves of the policy disagree: the reserve knows the machine's real launch
cost, the cap does not. Possible resolutions, in preference order:

1. Once full-fidelity evidence exists, scale the remaining wall budget by observed
   launch duration (e.g. cap = max(formula, expectedRemainingLaunches ×
   max(fullDurations) × margin)), so the formula default is a floor, not a cliff.
2. Failing that, an **early infeasibility verdict**: the arithmetic that denied the
   probe at minute 30 was largely determined after the first few full launches;
   terminating (or warning through `onProgress`) then would save the operator twenty
   minutes and return the same provisional.
3. At minimum, document that hosts on slow machines should raise `maxWallTimeMs` —
   the field is caller-settable and works.

Downstream mitigation applied: palimpsest now passes `maxWallTimeMs: 4_500_000`
(the formula's own ceiling).

## Problem 2 — budget-exhausted runs cannot resume

The only remedy the report offers is a full re-run from scratch: ~30 minutes of probe
evidence (references, boundaries, a resolved cell, reproduction partials) is
discarded, and the retry re-pays all of it before breaking new ground. A
`resumeFrom(report)` (or an evidence-seeding input on `calibrate()`) would turn
"run calibration again" from a repeat into a completion. This compounds Problem 1:
the failure costs 30 minutes and the remedy starts by repeating them.

## Problem 3 — the provisional is a dead end for the operator

Guidance says `provisional` must not be auto-applied — correct, reproduction did not
complete. But there is no sanctioned path to act on it at all, so a budget-exhausted
run shows the operator a measured start config they cannot use. Asks:

1. Bless a **user-consented apply** in the guidance: a host may apply a provisional on
   explicit user action, labeled unvalidated, without violating the contract.
   (Palimpsest now does this: an "Apply anyway" action stores the candidate marked
   `unvalidated` with a persistent recalibrate hint.)
2. Better, with resume (Problem 2): a **"validate this candidate" continuation** that
   runs only the missing reproduction launches for the provisional (~2 launches,
   ~10 minutes here) instead of a full re-search.

## Addendum — run 2 (2026-08-04): the probe reserve binds even with the clock fixed

Same machine and configuration, `maxWallTimeMs` raised to 4,500,000 (75 min):
`status: budget-exhausted`, `terminalReason: 'required probe denied by launch-reserve'`.
Provisional `p1:c16384:swa-window:kv-q8_0` at 3.6 s/scenario. So with wall time no
longer binding, the **probe budget** (maxProbes 23 with finalistReserve 4 held back)
ran out instead: 4 cells with wide bisection intervals consumed ~19 probes before
every decision-relevant cell resolved. A plausible amplifier is the baseline anchor:
`getOptimalConfig` resolves very conservatively on this card (historically `-ngl 19`
of 48 at 12,288), and a low reference widens every cell's search interval, costing
extra ceiling/bisection probes per cell.

Two runs, two different reserves binding → both budget axes are mis-scaled for real
machines, not just the clock. Additional asks beyond Problems 1–3:

- Scale `targetProbes`/`maxProbes` with observed interval width (or spend
  fewer probes on anchoring — e.g. reuse the first cell's resolved boundary as the
  sibling cells' reference, which `transferAxis` already does for ceilings only).
- Note the operator outcome: the applied config came from the downstream
  "user-consented apply" path both times; the provisional's start config
  (16,384 / ngl 48 / q8_0 / swa-window) is numerically identical to the config the
  0.18 exhaustive ladder validated on 2026-08-01 — the search found the right answer
  and the budget policy withheld it.

## Minor — `details.suggestion` audience

The suggestion strings address the host developer ("Ask the user to close heavy
applications…"). Hosts that relay them verbatim tell the user to ask themselves.
Either phrase them end-user-ready or document that they are developer-facing;
palimpsest now writes its own user-facing copy keyed on `details.code`.

## Resolution (2026-08-04)

Resolved by the unreleased schema-v4 time-first adaptive calibration work tracked in
[`PLAN-time-first-adaptive-calibration.md`](../plans/PLAN-time-first-adaptive-calibration.md):

- `maxWallTimeMs` is the primary user-facing budget, with a fixed 60-minute library default;
- omitted `maxProbes` is unbounded, while an explicit value remains an expert/test cap;
- clean best-known evidence can produce an application-ready `selected` on partial searches, with
  evidence strength and search completeness reported separately;
- applying, presenting, persisting, or ignoring `selected` is entirely host policy; and
- resource-stability suggestions are phrased for end users.

Cross-call evidence resume is deliberately deferred. Returning a usable best-known selection removes
the immediate dead end, while resume still needs a separate baseline/session and budget-accounting
contract.
