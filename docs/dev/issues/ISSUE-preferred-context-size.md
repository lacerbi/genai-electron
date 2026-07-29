# ISSUE: Add `preferredContextSize` — an advisory sizing target that is not a runtime bound

**Date:** 2026-07-29
**Status:** RESOLVED (2026-07-29)
**Requested by:** Palimpsest Engine's corrected context contract
(`palimpsest-engine/docs/devlogs/2026-07-29-request-classes.md` and
`PLAN-request-class-contract.md`, Phase 1 / Deferred #6).

## Problem

A consumer negotiating context capacity has two intents that the current hint API cannot
express together:

1. **A hard floor** — below this the consumer cannot operate. `minimumContextSize` expresses
   this correctly (sizing raises to it; `runtime-below-minimum` rejects a server that cannot
   deliver it).
2. **A sizing target** — the consumer derives no benefit from context beyond this value, so
   VRAM above it is better spent elsewhere (or simply left free). The only way to express this
   today is `maximumContextSize`, which does double duty: it caps sizing
   (`SystemInfo.getConstrainedOptimalConfig` → `capContext`,
   `src/system/SystemInfo.ts:631-639`) **and** it is a hard runtime bound —
   `LlamaServerManager.start()` throws `runtime-above-maximum` when the server's effective
   capacity exceeds it (`src/managers/LlamaServerManager.ts:428-437`).

The double duty is the defect. In the field, a llama-server that reported an effective context
a few hundred tokens **above** the requested maximum (granularity rounding, model minimums, a
reused server) failed startup even though more capacity is strictly harmless to the consumer.
Palimpsest's corrected contract now forbids deriving any hard *upper* provider bound from its
policy — it wants to say "at least X, ideally around Y, and anything above Y is fine."

## Proposal

Add `preferredContextSize?: number` to `OptimalConfigHints` (per-slot, like the existing
context fields; `src/types/servers.ts`).

**Semantics:**

- **Sizing**: acts exactly like `maximumContextSize` does today inside `capContext` — a soft
  cap on the baseline recommendation, `cap = min(baseline, totalPreferred, totalNativeContext)`
  with the usual granularity flooring, never below the (raised-to) minimum. Context the
  consumer will not use is not allocated, freeing VRAM.
- **Runtime**: **no validation whatsoever.** An effective capacity above preferred is normal
  and silently accepted. `runtime-below-minimum` remains the only floor check;
  `runtime-above-maximum` continues to apply only to an explicit `maximumContextSize`.
- **Validation of the hint itself** (in `normalizeContextConstraints`,
  `src/utils/context-constraints.ts`): positive safe integer; `minimumContextSize ≤
  preferredContextSize` when both are present; `preferredContextSize ≤ maximumContextSize`
  when both are present; mutually exclusive with an exact `contextSize` under the same rule as
  the range fields (`exact-range-conflict`); multiplied by `parallelRequests` for the total,
  with the same overflow check.
- **Retention**: carried on the returned config like the range fields (`attachContract`,
  `src/system/SystemInfo.ts:599-629`) for observability, but excluded from `start()`'s runtime
  range validation.

`maximumContextSize` keeps its current strict semantics for consumers that genuinely need a
hard ceiling; nothing existing changes behavior.

**Expected consumer usage** (Palimpsest GUI, after its Phase 1):

```ts
const config = await systemInfo.getOptimalConfig(modelInfo, {
  minimumContextSize: 6_000, // hard floor — reject below
  preferredContextSize: 10_000, // sizing target — cap allocation, accept anything above
});
```

## Non-goals

- No change to `runtime-below-minimum` / `runtime-above-maximum` semantics.
- No new reuse logic — whether a running server with a given effective capacity is acceptable
  stays the consumer's decision.
- No proportional/percentage targets; a single per-slot token value, consistent with the
  existing fields.

## Acceptance criteria

- [x] `preferredContextSize` accepted by `getOptimalConfig()` and validated as above
- [x] Sizing caps at preferred (granularity-floored, minimum-respected); VRAM sizing reflects
      the smaller KV allocation
- [x] `start()` never errors because effective capacity exceeds preferred
- [x] `min + preferred` with no `maximum` is a fully supported combination (the expected
      common case)
- [x] Type docs in `src/types/servers.ts` and the context-capacity section of the docs updated
- [x] Tests: validation matrix (bad values, orderings, exact-conflict), sizing cap, and a
      runtime-capacity-above-preferred acceptance test

## Resolution

Implemented on `main` as an unreleased addition after v0.15.0:

- Added the effective per-slot `preferredContextSize` public field and typed validation
  diagnostics.
- Applied preferred as a retained soft sizing cap across baseline, minimum re-planning,
  granularity, native-context, and multi-slot calculations.
- Kept runtime validation exclusive to the hard minimum and maximum bounds; effective capacity
  above preferred is accepted.
- Preserved the sizing policy through direct-spread start, restart, auto-restart, and
  ResourceOrchestrator reload flows.
- Updated public API documentation and focused regression coverage.

## Validation

- TypeScript build passes.
- 279 focused tests pass across the five affected suites.
- Repository formatting and `git diff --check` pass.
- ESLint passes with 0 errors and the existing 61 warnings.
- Jest passes 709/709 tests across 28 suites, including the open-handle verification run.
