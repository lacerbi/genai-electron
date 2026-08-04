# Migrating from v0.20.x to v0.21.0

v0.21.0 reframes adaptive LLM calibration as an anytime procedure: it keeps the best clean
start-ready configuration found so far, continues useful structural search until one total elapsed
deadline or an optional explicit probe cap, and returns that result with honest evidence and search
completeness labels. The breaking surface is confined to `LlamaServerManager.calibrate()` adaptive
configuration, progress, reports, and resource-failure partial reports. Other managers and normal
server lifecycle APIs are unchanged.

## Required migration

### Discard persisted schema-v3 reports

Calibration reports and partial reports now use `schemaVersion: 4` and policy
`'llama-runtime-v4'`. Persisted schema-v3 reports from v0.20 must be discarded and the machine
recalibrated; do not translate old evidence into the new result contract.

### Narrow every result on `resultKind`

Every ordinary adaptive and exact report now carries `resultKind: 'report'`. Adaptive calibration
can also return `resultKind: 'preparation-time-limit'` when the total deadline expires before the
ordinary report identity and fixed resource baseline exist. That minimal result intentionally has
no machine identity, workloads, selection, or fabricated probe evidence.

```typescript
const result = await llamaServer.calibrate(config);

if (result.resultKind === 'preparation-time-limit') {
  showCalibrationTimedOutDuringSetup(result.budget.elapsedMs);
  return;
}

if (result.strategy === 'adaptive' && result.selected) {
  // Host policy decides whether to apply, persist, present, or ignore it.
  await maybeUseCalibration(result.selected.startConfig, {
    evidence: result.selectionEvidence,
    completeness: result.searchCompleteness,
  });
}
```

Use an exhaustive `resultKind` switch before narrowing by `strategy`. Code that switched only on
`strategy` must add the preparation-time branch.

### Replace probe-derived budgets with elapsed time

`maxWallTimeMs` is now the primary adaptive resource and covers the whole call from synchronous
method entry through preparation, baseline collection, probing, cleanup, and manager restoration.
It defaults to 60 minutes.

`maxProbes` remains an optional expert/test launch cap. Omit it for the normal policy, which is
unbounded by probe count. Failed or interrupted executor launches count against an explicit cap;
runner-internal retries do not.

Removed configuration and public budget API:

- `targetProbes`;
- `resolveLlamaCalibrationBudgetDefaults()` and `ResolvedLlamaCalibrationBudgetDefaults`;
- `LlamaCalibrationBudgetReport`, replaced by `LlamaAdaptiveCalibrationBudgetReport`;
- `LLAMA_CALIBRATION_DEFAULTS.unobservedProbeDurationPolicy`;
- the cell-count budget formula and its target, reserve, duration-estimate, and finalization fields.

```typescript
await llamaServer.calibrate({
  modelId,
  profiles,
  workloads,
  // maxWallTimeMs is optional and defaults to 60 minutes.
  // Usually omit maxProbes. Supply it only when a hard launch cap is independently useful.
});
```

### Adopt the schema-v4 adaptive result fields

Adaptive reports no longer require optimality proof before exposing `selected`. A clean incumbent
may be returned on `complete`, `time-limited`, `probe-limited`, or `inconclusive` outcomes.

- `selectionEvidence` is atomic with `selected` and is
  `'independent-reproduction' | 'single-full-launch' | 'single-search-launch'`;
- `searchCompleteness` independently reports `'resolved' | 'partial'`;
- adaptive report `confidence` is removed; use `selectionEvidence` and `searchCompleteness`;
- `provisional` is removed;
- `budget` now contains `maxWallTimeMs`, actual `elapsedMs`, `overrunMs`, and optional `maxProbes`;
- adaptive terminal status `budget-exhausted` is replaced by the specific `time-limited` and
  `probe-limited` statuses, with `inconclusive` available when no ordinary structural work remains
  but the search is unresolved.

Evidence labels describe measurement strength; they do not prescribe host UX. The library does not
apply or persist a recommendation and does not require user confirmation. That policy belongs to
the host application.

### Update progress displays

Adaptive progress now exposes actual elapsed time:

- `budget.maxWallTimeMs` and `budget.remainingMs` are always present;
- `completedProbes` remains a top-level counter;
- `budget.maxProbes` and `budget.remainingProbes` appear together only when the caller supplied an
  explicit cap.

Remove UI dependencies on target probes, finalist reserves, time reserves, duration estimates,
finalization mode, or resolved/unresolved budget formulas.

### Replace diagnostic-only resource candidates with `bestKnown`

`LlamaCalibrationResourceStabilityError` remains the typed hard-stop path from v0.20. Its
`partialReport` may now expose a strategy-correct `bestKnown` supported solely by clean earlier
probes:

```typescript
try {
  await llamaServer.calibrate(config);
} catch (error) {
  if (error instanceof LlamaCalibrationResourceStabilityError) {
    const best = error.details.partialReport.bestKnown;
    if (best) {
      // best.recommendation is start-ready; whether to use it is host policy.
      offerOrApplyAccordingToHostPolicy(best.recommendation.startConfig, best.evidence);
    }
  }
  throw error;
}
```

The old `diagnosticCandidate`, `LlamaCalibrationDiagnosticCandidate`, and
`LlamaCalibrationDiagnosticEvidenceLevel` types are removed. Use
`LlamaAdaptiveCalibrationSelectionEvidence` for adaptive selection and `bestKnown` evidence.
`bestKnown` is deliberately application-ready, but the failed boundary remains excluded and the
search is incomplete; hosts may use or ignore it.

## Compatibility

- Exact calibration keeps caller-ordered combo execution and selection semantics, while ordinary
  exact reports gain `resultKind: 'report'` and atomic `selected` / `selectionEvidence` typing.
- Fixed-baseline resource-stability rejection and telemetry guarantees from v0.20 remain in force.
- Cross-call evidence resume remains unsupported; each call starts a new calibration.
- Non-calibration APIs, server start configuration, model management, diffusion calibration, and
  genai-lite pairing are unchanged.
- Pre-1.0 caret ranges such as `^0.20.0` do not adopt v0.21.0 automatically; consumers must update
  their dependency range explicitly.

## Checklist

- [ ] Update the dependency to `genai-electron` v0.21.0.
- [ ] Delete persisted schema-v3 calibration reports and recalibrate.
- [ ] Remove `targetProbes`, budget-reserve assumptions, and calls to the removed public resolver.
- [ ] Narrow calibration results on `resultKind` before `strategy`.
- [ ] Update adaptive progress and report handling to the schema-v4 fields.
- [ ] Replace `diagnosticCandidate` handling with host-policy handling of `bestKnown`.
