# Migrating from v0.18.x to v0.19.0

v0.19.0 replaces the LLM calibration search policy introduced in v0.18.0. `calibrate()` now runs a
bounded, cell-local adaptive search for the largest reproducible operational `gpuLayers` point
instead of measuring a generated ladder of static anchors, and it accepts one or two comparable
context profiles in a single call.

This is a **breaking change to `LlamaServerManager.calibrate()` only**. Server lifecycle, sizing,
model management, image generation, and every other API are unchanged. Calibration remains opt-in,
lifecycle-neutral, and report-only: it never applies or persists a recommendation. As a pre-1.0
package, a dependency range such as `^0.18.0` does not admit `0.19.0`; update the declared range
explicitly when adopting this release.

## What changed

### The config is now a discriminated union

Adaptive mode takes `profiles` (one or two) and no `combos`. Exact diagnostic mode takes a singular
`profile` plus a non-empty, caller-ordered `combos` tuple. Mixed or legacy shapes are rejected
before any server is provisioned, with a targeted migration error.

```ts
// v0.18: singular profile, generated candidate ladder
const report = await llamaServer.calibrate({
  modelId,
  profile: { contextSize: 12_288, parallelRequests: 1 },
  workloads,
});

// v0.19: adaptive boundary search
const report = await llamaServer.calibrate({
  modelId,
  profiles: [{ contextSize: 12_288, parallelRequests: 1 }],
  workloads,
});
```

Wrapping the old `profile` in `profiles: [ ... ]` is the whole migration for callers who relied on
the default strategy. Callers who supplied their own `combos` keep the singular `profile` — but see
the report changes below, which affect them too.

### Two comparable contexts in one call

Adaptive mode accepts a second profile with a unique `contextSize` and the same `parallelRequests`.
Each context is searched at its own boundary, and the larger context wins when its finalist lands
inside a globally anchored `contextPreferencePct` band (default 10%).

```ts
profiles: [
  { contextSize: 12_288, parallelRequests: 1 },
  { contextSize: 16_384, parallelRequests: 1 },
],
```

Workloads, weights, output lengths, seed, and sampling must be identical across profiles: the larger
context's value is capacity, not a measured speed benefit. Use separate calibrations for differing
slot counts or context-specific workloads.

### Reports are schema v2

`report.schemaVersion` is `2` and `policyVersion` is `llama-runtime-v2`. Persisted v0.18 reports are
not readable as v0.19 reports and should be discarded rather than migrated — they describe a
different search policy. Notable shape changes:

- **`recommended` is now `selected`.** This one affects *every* caller, including exact-mode callers
  whose config needs no change. A v0.18 consumer reading `report.recommended` silently receives
  `undefined` — there is no runtime error. `comboSource: 'default' | 'custom'` is also gone, since
  the strategy is now explicit.
- `strategy` discriminates `'adaptive'` from `'exact'`, and the two carry different invariants.
- `status` is a terminal outcome. A *returned* report is `complete`, `budget-exhausted`, or
  `no-viable-candidate` (exact mode never returns `budget-exhausted`). `aborted` and `failed` appear
  only on the `LlamaCalibrationPartialReport` attached to a rejection.
- `selected`, `provisional`, and `fallback` are distinct fields. A `budget-exhausted` report never
  exposes a provisional candidate as selected.
- `probes` is a full chronological fresh-launch trail; each probe separates `operationalStatus`,
  `memoryEvidence`, and `boundaryDecision` so an operational failure is never silently read as proof
  of a memory threshold.
- Adaptive selections carry `selectionEvidence: 'independent-reproduction'` and require two
  successful launches at the exact resolved arguments, at least one full fidelity. Exact selections
  carry `'single-launch-measurement'` and make no reproducibility claim.

`LlamaCalibrationProgress` is likewise a strategy-discriminated union. Host UIs should narrow on
`strategy` and `phase`, and treat `overallPercent` as a monotonic estimate rather than a fixed
probe count.

### MoE placement is pinned in adaptive mode

Adaptive search varies `gpuLayers` only; it does not compare `cpuMoe`, `nCpuMoe`, or
`overrideTensors`. Every adaptive report sets `pinnedMoePlacement: true`, so its conclusion is
conditional on the resolved placement. This is intentionally narrower than the v0.18 generated
ladder. Use exact `combos` for MoE-placement experiments.

### Budgets scale with enumerated cells

Probe and wall-time budgets are derived from the actual cell count and echoed in `report.budget`
alongside the formula version and any caller overrides. `targetProbes`, `maxProbes`, and
`maxWallTimeMs` remain caller-overridable. Adding a second profile roughly doubles the cell count,
as does enabling `includeKvCacheComparison`.

## New in this release

- `probe.resourceRegime` records the settled resource level an **adaptive** launch was measured under
  (it is absent on exact-mode probes). A confirmed
  step change in available memory — something taking memory once and keeping it — re-anchors the
  drift reference and increments the regime instead of ending the run, and a selection is never
  reproduced by launches spanning a step. Availability that is still moving on the repeat remains
  persistent drift and ends `budget-exhausted`.
- `SystemInfo.refreshMemoryTelemetry()` refreshes the platform available-memory reading behind
  `getMemoryInfo()`. Calibration calls it before every snapshot so all readings share one
  measurement regime. Long-running callers that sample memory repeatedly without re-running
  `detect()` may want it too: on Windows the standby-aware value has a 60-second TTL and otherwise
  degrades to `os.freemem()`, which excludes reclaimable standby pages.

## Operational guidance

Calibration compares wall-clock timings across launches minutes apart, so the machine should be
otherwise idle for the duration. Host applications should tell the user a calibration is running and
ask them not to start heavy work — other model servers, image generation, games, large builds —
until it finishes. Ordinary light desktop use is tolerated. See
[Machine conditions during a run](llm-server.md#machine-conditions-during-a-run).

## Checklist

1. Replace `profile:` with `profiles: [ ... ]` for callers using the default strategy.
2. Leave the `profile` + `combos` *config* unchanged, but update those callers to read
   `report.selected` instead of `report.recommended`.
3. Rename every other `report.recommended` read to `report.selected`, and drop any use of
   `comboSource`.
4. Discard persisted v0.18 calibration reports and recalibrate.
5. Narrow report and progress handling on `strategy`, and read `status` before `selected`.
6. Treat adaptive recommendations as conditional on the pinned MoE placement.
7. Update the declared dependency range to admit `0.19.0`.
