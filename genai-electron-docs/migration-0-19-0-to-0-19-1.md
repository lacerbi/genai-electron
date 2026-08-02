# Migrating from v0.19.0 to v0.19.1

v0.19.1 is a correctness patch for the adaptive LLM calibration policy introduced in v0.19.0. There
are no API changes: no new or removed exports, no changed signatures, and no report shape changes.

**If you are upgrading from v0.18.x, go to
[Migrating from v0.18.x to v0.19.0](migration-0-18-to-0-19.md) instead** — that is the guide with the
breaking `calibrate()` changes, and it applies in full. v0.19.0 was tagged but never published to
npm, so v0.19.1 is the first release of this policy that consumers can install.

> **Correction to the v0.18-to-v0.19 guide.** Its first revision said callers who supply their own
> `combos` need no change. That was wrong about the *report*: v0.18's `recommended` field is now
> `selected`, and `comboSource` is gone. A v0.18 consumer reading `report.recommended` receives
> `undefined` with no runtime error. The guide has been corrected; re-read its "Reports are schema
> v2" section if you read it before this release.

## What changed

### Reproduction could strand a point after a resource-regime change

v0.19.0 re-anchors its drift reference when available memory settles at a new level, and refuses to
let launches from either side of that step reproduce each other. The check that decided *whether to
schedule another launch* still counted launches across all regimes, so after a re-anchor it could
believe a point had enough evidence while the assessment still reported `insufficient`. The point
then became unresolvable and its boundary silently dropped a layer, or its cell went unresolved.

Both now read the same comparable-evidence subset. A point that needs another launch under present
conditions gets one.

Relatedly, the active regime is now determined from all evidence rather than only the drift-free
subset. If the sole launch in the current regime was itself materially drifting, the point asks for
a fresh launch instead of falling back to pre-step evidence.

### A steady decline was mistaken for a settled environment

Deciding that a material drop had "settled at a new level" used the same 25% tolerance as the
material-drop test itself. A machine losing memory steadily — each step just under the drift band —
re-anchored on every probe and never registered as persistent drift, so a run could complete on
timings that were not comparable.

Settling now uses `resourceSettledTolerancePct` (5%), a new frozen policy value echoed in
`LLAMA_CALIBRATION_DEFAULTS`. A genuine one-off step change still re-anchors; a moving environment
now correctly ends `budget-exhausted`.

### Degraded telemetry could re-anchor the reference onto an instrument artifact

If the platform memory-telemetry refresh failed, the reading silently degraded to a different
measurement regime. Two consecutive failures produce two mutually consistent degraded readings,
which the settle test would accept — moving the drift baseline onto the artifact and reporting a
resource-regime change that never happened.

A failed refresh is now recorded as a probe warning and can never re-anchor the reference.

### Smaller fixes

- `resourceRegime` is now present on the cleanup-unconfirmed and deadline-interrupted probe records.
  Consumers using `probe.resourceRegime ?? 0` no longer misattribute those probes to regime 0.
- `getMemoryInfo()` is documented accurately for Windows: it prefers a standby-aware reading with a
  60-second TTL and silently reverts to `os.freemem()` once that expires. See
  [`refreshMemoryTelemetry()`](system-detection.md#refreshmemorytelemetry), which is now documented
  in the SystemInfo reference rather than only in a migration guide.
- The TypeScript reference now includes `LlamaCalibrationProbe.resourceRegime`.

## Do I need to recalibrate?

Yes, if a v0.19.0 report shows any of the following, because the selection may have been made on
evidence the policy now rejects:

- a `resourceRegime` greater than 0 on any probe,
- a resource-drift or "settled at a new level" warning,
- a cell that resolved to a boundary one layer below its highest admissible probe.

Reports from runs with no drift warnings and all probes at regime 0 are unaffected — the changed
code paths never executed.

## Checklist

1. Update the declared dependency range to admit `0.19.1`.
2. If you are coming from v0.18.x, follow
   [Migrating from v0.18.x to v0.19.0](migration-0-18-to-0-19.md) in full, including the corrected
   `recommended` → `selected` rename.
3. Recalibrate if a stored v0.19.0 report shows drift warnings or a non-zero `resourceRegime`.
