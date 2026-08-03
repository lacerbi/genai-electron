# Migrating from v0.19.1 to v0.20.0

v0.20.0 replaces calibration's resource-regime re-anchoring with one fixed resource baseline per
run and a hard stop on confirmed resource instability. The breaking surface is confined to
`LlamaServerManager.calibrate()` reports, errors, and defaults, plus one `SystemInfo` return type.
Server lifecycle, model management, image generation, and every non-calibration API are unchanged.

## What changed

### Calibration can now reject with a typed resource-stability error — in both modes

Every `calibrate()` call establishes one fixed baseline for available host RAM and available VRAM
(median of three settled samples) and checks both metrics at every launch boundary (pre-launch and
post-cleanup). A confirmed crossing of a metric's band — decrease **or** increase — or a suspicious
boundary that cannot be verified clean stops the run:

```typescript
import { llamaServer, LlamaCalibrationResourceStabilityError } from 'genai-electron';

try {
  const report = await llamaServer.calibrate(config);
} catch (error) {
  if (error instanceof LlamaCalibrationResourceStabilityError) {
    // error.details.code is 'CALIBRATION_RESOURCE_DRIFT'
    // or 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED'
    // error.details.partialReport carries resourceFailure + chronological probes
    // error.details.suggestion is host-facing retry text
  }
  throw error;
}
```

**Exact mode gains this rejection path too.** v0.19 exact sweeps never stopped for resource
reasons; v0.20 exact callers must catch the same error. `formatErrorForUI()` has a dedicated
branch that surfaces `details.code` and the suggestion.

The bands are policy constants (not caller-configurable): host 10% decrease / 20% increase,
VRAM 10% / 10%, inclusive, measured cumulatively against the run's fixed baseline. A suspicious
reading gets one cooldown plus one confirmation read (telemetry only — never a server launch)
before any rejection. Increases are guarded because earlier probes then ran under tighter
conditions and a stale-low baseline desensitizes the decrease guard.

### Reports are schema v3; discard persisted v2 reports

`schemaVersion` is `3` and `policyVersion` is `'llama-runtime-v3'` on reports and partial reports.
Persisted v0.19 (schema v2) reports should be discarded and machines recalibrated — do not migrate
them.

Added:

- report/partial-level `resourceMonitoring` — per-metric fixed `baselineBytes`, both thresholds,
  attempts, trusted sample count, and overall `coverage` (`complete | partial | unavailable`);
- per-probe `resourceBoundaries` (`preLaunch`/`postCleanup` snapshots with trusted readings and
  signed `decreasePctFromBaseline`) and required `resourceValidity`
  (`'accepted' | 'invalidated-by-resource-stability'`);
- `methodology.resourceStability` (protocol facts, including the boundary-sampling caveat);
- on stability failures, `partialReport.resourceFailure` and an optional, deliberately
  non-applicable `diagnosticCandidate` (`sourceProbeIndexes` + `evidenceLevel` +
  `usability: 'diagnostic-only'`) — it must never be applied as a start configuration;
- the report's machine available-memory values are the stabilized baselines when available.

Removed:

- `LlamaCalibrationProbe.resourceRegime` — regimes no longer exist;
- `LlamaCalibrationResourceMetricDiagnostic` and the probes'
  `diagnostics.hostAvailableMemory`/`gpuAvailableMemory` passive diagnostics — superseded by
  `resourceBoundaries`.

### Defaults changed

Removed from `LLAMA_CALIBRATION_DEFAULTS`: `resourceDriftThresholdPct`,
`resourceSettledTolerancePct`, `resourceDriftRetries`.

Added: `hostMemoryDecreaseThresholdPct: 10`, `hostMemoryIncreaseThresholdPct: 20`,
`vramDecreaseThresholdPct: 10`, `vramIncreaseThresholdPct: 10`, `resourceBaselineSamples: 3`,
`resourceBaselineSettleMs: 5000`, `resourceDriftConfirmationReads: 1`,
`resourceTelemetryTimeoutMs: 10000`. `resourceCooldownMs: 750` is retained.

The values are heuristic, provisional, and validated on one Windows/NVIDIA machine; VRAM guarding
is active only where `nvidia-smi`-style available-VRAM telemetry exists and self-disables (with a
warning and a `coverage` downgrade) elsewhere.

### `SystemInfo.refreshMemoryTelemetry()` returns a status

Previously `Promise<void>`; now `Promise<MemoryTelemetryRefreshStatus>`
(`'refreshed' | 'not-required' | 'failed'`), with optional `TelemetryCommandOptions`
(`signal`, `timeoutMs`). A `'failed'` refresh no longer passes silently; note that within the 60 s
cache TTL `getMemoryInfo()` still serves the last successful standby-aware value. `getGPUInfo()`
also accepts `TelemetryCommandOptions`. Existing no-argument callers keep compiling (the return
value can be ignored).

### Behavior changes to plan for

- **No re-anchoring.** Comparison is cumulative against the run-start baseline, so several
  individually minor decreases can cross the band, and a settled step change (the user opening a
  browser mid-run) that v0.19.1 re-anchored around now fails the run. Ask users for a quiet
  machine and retry from the beginning on rejection.
- **Temporal blind spot (documented, unchanged in kind):** pressure that begins and fully clears
  between one launch's pre-launch and post-cleanup snapshots cannot be detected.
- Runs gain a fixed setup cost (~6.5 s baseline settle + samples) before the probe budget starts.

## Compatibility

- Adaptive and exact `calibrate()` **config** shapes are unchanged from v0.19 — only report/error
  surfaces changed.
- No other manager, event, or type changed. genai-lite pairing is unaffected.
- Pre-1.0 caret ranges (`^0.19.x`) do not auto-adopt 0.20.0; consumers must bump explicitly.

## Checklist

- [ ] Wrap every `calibrate()` call (both modes) in a try/catch handling
      `LlamaCalibrationResourceStabilityError`; surface `details.suggestion` to users.
- [ ] Delete persisted schema-v2 calibration reports and recalibrate.
- [ ] Remove any reads of `probe.resourceRegime` or the removed passive diagnostics; adopt
      `resourceBoundaries`/`resourceMonitoring` if you displayed resource data.
- [ ] If you referenced the removed default keys, switch to the new band constants.
- [ ] Treat `diagnosticCandidate` as display-only; never feed it to `start()`.
