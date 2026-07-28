# Plan: Context Capacity Contract

Created: 2026-07-28

Status: COMPLETE (approved and completed 2026-07-28)

Issue: `../issues/ISSUE-context-capacity-contract.md`

## Summary

Add minimum and maximum effective-context constraints to the adaptive LLM sizing API, preserve
today's unconstrained and exact-pin behavior, and re-optimize offload placement when the normal
recommendation cannot meet a requested minimum. After llama-server becomes healthy, read its
effective per-slot context from `GET /props`, expose configured and effective capacity separately,
and refuse to enter `running` when the runtime result violates the requested range.

This is an unreleased feature on the `context-capacity-contract` branch. It does not include a
version bump, migration guide, tag, release, publish, or downstream Palimpsest prompt-policy work.

## Scope

- **In scope**:
  - Exact, minimum, and maximum context semantics in `SystemInfo.getOptimalConfig()`.
  - Re-optimization across full GPU, partial GPU, CPU-only, KV-quantized, pinned, and MoE-aware
    placement paths.
  - Explicit validation and typed errors for invalid, unsupported, and unsatisfiable constraints.
  - Direct constrained `llamaServer.start()` calls and precomputed constrained configurations.
  - Effective runtime capacity from llama-server `GET /props`.
  - Restart, crash auto-restart, and ResourceOrchestrator offload/reload contract preservation.
  - Unit tests, public/source documentation, an Unreleased PROGRESS entry, and issue/plan archival
    after completion.
- **Out of scope**:
  - Prompt assembly, prompt trimming, output reserves, tokenizer margins, or truncation recovery.
  - Automatically expanding consumer prompt budgets when more server capacity is available.
  - New KV quantization policy beyond the existing f16/q8_0 choices.
  - Changing exact `contextSize` feasibility or native-limit behavior for existing callers.
  - Release preparation or downstream repository changes.

## Contract Decisions for Approval

1. **Constraints are effective per-request/per-slot capacity.** `minimumContextSize: 12288` means
   each llama-server slot must expose at least 12,288 tokens. With `parallelRequests: 2`, sizing
   therefore budgets at least 24,576 total `-c` tokens. This matches the workload-oriented issue
   and llama-server's `/props.default_generation_settings.n_ctx`, which is per slot. A known
   native limit is also per slot, so a constrained multi-slot launch may legitimately select a
   total `-c` as high as `nativeContextSize * parallelRequests`.
2. **Report both dimensions.** `ServerInfo.configuredContextSize` is the total selected `-c` value;
   `ServerInfo.effectiveContextSize` is the per-slot value reported by `/props`. Both remain
   optional because no effective value exists before a successful start; no ambiguous
   `ServerInfo.contextSize` alias will be added.
3. **Range validation differs slightly by API layer.**
   - `getOptimalConfig()` treats exact `contextSize` as mutually exclusive with minimum/maximum.
     When given a range, its returned launch recommendation contains both the selected concrete
     `contextSize` and the original minimum/maximum fields so `{ modelId, ...recommended }`
     automatically preserves the runtime contract.
   - `llamaServer.start()` may accept a concrete `contextSize` together with a range. This represents
     a precomputed launch configuration plus the runtime contract to verify, and is required for
     restart/orchestrator reuse. The configured per-slot value must already lie within the range.
4. **Effective capacity is mandatory after every successful llama startup.** A non-OK, timed-out,
   malformed, or schema-incompatible `/props` response fails startup before `running`/`started`,
   including for unconstrained and exact-only callers. This is an intentional lifecycle
   compatibility change requiring approval: it makes the new `ServerInfo` guarantee reliable
   instead of silently falling back to the CLI argument. The pinned b9860 binary supports the
   required response, and focused tests will cover the compatibility boundary.
5. **Runtime enforces both bounds.** An effective result below the minimum or above the maximum
   fails startup. An exact-only configuration continues to start even if runtime fitting changes
   it; the configured/effective fields expose the difference without changing exact-pin
   compatibility.
6. **`fit: 'on'` needs a concrete constrained context.** A range without `contextSize` conflicts
   with delegated fitting because genai-electron cannot re-optimize it. A precomputed
   `contextSize` plus range may use `fit: 'on'`, subject to `/props` verification.
7. **Missing native-context metadata is not treated as an authoritative 4K limit.** Unconstrained
   legacy behavior remains exactly 4096. A minimum that requires more than the conservative legacy
   recommendation fails with an actionable `model-context-unknown` constraint reason rather than
   falsely claiming the model's native limit is 4096; maximum-only constraints can still reduce
   the legacy recommendation.

## Phase 1: Public Contract and Typed Errors

**Goal**: Define the API and error surface before changing sizing or lifecycle behavior.

**Work**:

- [x] `src/types/servers.ts`
  - Add documented `minimumContextSize?: number` and `maximumContextSize?: number` to
    `ServerConfig` (alongside its existing LLM `contextSize`) and include them in
    `OptimalConfigHints`; `DiffusionServerConfig` remains a standalone type and does not gain them.
  - Document exact-vs-range sizing semantics and the start-time precomputed-config exception.
  - Add `configuredContextSize?: number` and `effectiveContextSize?: number` to `ServerInfo`, with
    total-vs-per-slot semantics.
- [x] `src/errors/index.ts`
  - Add a public `ContextConstraintError` with stable code `CONTEXT_CONSTRAINT_ERROR`.
  - Export and use named `ContextConstraintReason`, `ContextConstraintStage`, and
    `ContextConstraintDetails` types; narrow `ContextConstraintError.details` to the named details
    interface so consumers do not need casts.
  - Enumerate stable reasons:
    - `invalid-minimum`, `invalid-maximum`, `exact-range-conflict`,
      `minimum-exceeds-maximum`, `unsafe-total-capacity`;
    - `minimum-exceeds-native`, `model-context-unknown`, `fit-range-conflict`,
      `precomputed-context-out-of-range`;
    - `runtime-capacity-unavailable`, `runtime-slots-mismatch`,
      `runtime-below-minimum`, `runtime-above-maximum`.
  - Give details a stage (`validation`, `sizing`, or `runtime`) plus relevant exact/minimum/maximum,
    configured, effective, native-limit, parallel-slot, and suggestion fields.
  - Use it for invalid combinations, unknown/model-native limits, fit conflicts, unavailable
    runtime capacity, and runtime range violations.
  - Keep `InsufficientResourcesError` for a valid minimum that no permitted memory/offload
    placement can satisfy; export a named `InsufficientResourcesDetails` interface that retains
    today's required `required`/`available` strings and adds optional context/resource diagnostics,
    and narrow the subclass `details` property without breaking existing callers.
- [x] `src/managers/ServerManager.ts`
  - Preserve any `GenaiElectronError` in `handleStartupError()` instead of maintaining a fragile
    class whitelist, so new typed startup errors retain their public code/details.
- [x] `src/utils/error-helpers.ts` and `src/index.ts`
  - Export the new error plus its public reason/stage/details types from the package root, and
    format it with an actionable UI title/remediation.

**Steps**:

1. [x] Define positive safe-integer validation contract for the new minimum/maximum fields, checked
   safe
   multiplication by `parallelRequests`, and the reason/stage matrix above; do not add new
   validation to legacy exact `contextSize` pins.
2. [x] Add source JSDoc for capacity, parallel-slot, and precomputed-start semantics.
3. [x] Add type/export/error/UI-format tests before optimizer integration.

**Verification**:

- [x] New types compile from the package root.
- [x] Invalid and resource failures retain distinct typed codes/details through startup handling.
- [x] Existing error constructors and `formatErrorForUI()` results remain unchanged.

## Phase 2: Constraint-Aware Sizing

**Goal**: Preserve the existing recommendation when it satisfies the range, and re-optimize only
when a minimum requires a different placement.

**Work**:

- [x] Refactor `SystemInfo.getOptimalConfig()` into clearly separated operations:
  1. validate hints and determine authoritative native context when available;
  2. compute the existing unconstrained recommendation without behavior changes;
  3. translate per-slot constraints into total KV tokens using resolved `parallelRequests`;
  4. apply a maximum after the normal recommendation;
  5. only when the normal effective result is below the minimum, find the highest-offload
     feasible placement that satisfies the minimum, then use remaining capacity for the largest
     context inside the range.
- [x] Return the original minimum/maximum fields beside the selected concrete `contextSize`; this is
  an intentional resolved recommendation (not a conflicting input hint) and lets callers spread it
  directly into `start()` without losing runtime enforcement.
- [x] In the constrained multi-slot path, cap total selected KV capacity at
  `authoritativeNativeContext * parallelRequests`, while still validating each requested per-slot
  minimum against the native limit. Keep today's single-`modelCtx` cap untouched when there is no
  range, preserving existing multi-slot recommendations for unconstrained callers.
- [x] Preserve the existing optimization priorities:
  - caller-pinned GPU/cache/MoE choices remain owner-controlled;
  - full offload remains preferred when feasible;
  - automatic measured-expert `cpuMoe` remains the next tier;
  - partial offload uses the greatest feasible GPU layer count;
  - CPU-only is the final supported placement;
  - existing f16/q8_0 and flash-attention choices remain the only automatic cache policy.
- [x] On a minimum-constrained re-optimization pass, re-evaluate an unpinned f16/q8_0 choice against
  the required **total** multi-slot KV allocation. This may choose the existing q8_0+FA adaptive
  path to satisfy a minimum, but must never override explicit cache types or flash-attention-off.
- [x] Replace clamp-based "feasibility" with raw GPU/RAM budget checks. The current helper floors
  impossible negative capacity up to 4096 and cannot prove a minimum is satisfiable.
- [x] Keep the existing progressive downward rounding for automatic recommendations. Minimum
  enforcement rounds upward and maximum enforcement downward when possible, but rounding must
  never violate an inclusive bound or turn a valid narrow interval into a false conflict.
- [x] Handle paths explicitly:
  - **No range**: byte-for-byte decision behavior remains unchanged.
  - **Exact**: verbatim context and current layer-packing behavior remain unchanged.
  - **Minimum already met**: retain the normal recommendation, not the minimum.
  - **Minimum not met**: re-plan placement using the total required KV allocation.
  - **Maximum**: cap the normal result, including maxima below the historical 4096 floor, without
    opportunistically repacking more layers.
  - **Minimum + maximum**: select inside the inclusive per-slot range.
  - **Pinned placement**: error if that placement cannot satisfy the minimum; do not override pins.
  - **Known native limit**: reject a per-slot minimum above GGUF `context_length`.
  - **Legacy metadata**: preserve no-constraint behavior and use the explicit unknown-limit policy
    above for ranges that require more than the conservative recommendation.
- [x] Return `InsufficientResourcesError` only after checking every placement allowed by the caller's
  pins and existing optimizer policy. For partial offload, evaluate candidate integer layer counts
  against both raw GPU and RAM shares rather than assuming the current reserve heuristic proves
  feasibility.
- [x] Extract/share the resolved-placement capacity evaluator with `canRunModel()` (or an equivalent
  validation path) so constrained startup can validate its actual context/cache/offload/MoE plan.
  Do not use the current CPU-resident, f16, floor-context `canRunModel()` result as the gate for a
  constrained recommendation.

**Steps**:

1. [x] Add internal constraint normalization and raw-capacity helpers with no public behavior change.
2. [x] Lock current no-hint and exact-hint outputs with regression tests.
3. [x] Add maximum post-processing.
4. [x] Add minimum-aware full/MoE/partial/CPU placement selection.
5. [x] Add native-limit, metadata-unknown, pinned-plan, and unsatisfiable diagnostics.
6. [x] Verify `parallelRequests > 1` converts per-slot requirements to total KV sizing correctly.
7. [x] Verify constrained recommendation output retains its range and caller-owned sizing hints for
   direct spread into start/restart.

**Verification**:

- [x] No-hint recommendations match the existing full-GPU, partial, CPU, q8/f16, and MoE tests.
- [x] Exact pins remain verbatim and continue to shape layer packing as before.
- [x] A baseline above the minimum is retained.
- [x] A satisfiable minimum below the baseline does not reduce the recommendation.
- [x] A satisfiable minimum above the baseline reduces offload only as much as needed.
- [x] Maximum-only and inclusive-range cases remain within their effective per-slot bounds.
- [x] Full-offload, partial-offload, CPU-only, KV-quantized, MoE-auto, and MoE-pinned paths pass.
- [x] Conflicts, known native-limit violations, unknown legacy limits, pinned-plan failures, and
      total hardware exhaustion return the intended typed error.

## Phase 3: Runtime Capacity Discovery and Enforcement

**Goal**: Make the actual running capacity available through normal lifecycle APIs and enforce the
requested range before declaring success.

**Work**:

- [x] Add a focused internal llama `/props` client/normalizer (implemented in
  `src/process/llama-props.ts`):
  - target the resolved port and normalized health host;
  - construct URL-safe hosts, including bracketed IPv6 literals;
  - use a bounded timeout and abort cleanup;
  - require an OK JSON response;
  - validate positive safe-integer `default_generation_settings.n_ctx`;
  - normalize optional `total_slots` for diagnostics; when present it must be a positive safe
    integer equal to the resolved `parallelRequests`, otherwise startup fails with
    `runtime-slots-mismatch`.
- [x] `LlamaServerManager.start()`:
  - perform pure numeric/range/exact/fit validation before entering `starting` or doing I/O;
  - after model lookup, perform known-native/unknown-metadata validation before binary provisioning,
    port checks, or occupancy probes;
  - accept/validate the new fields and forward a range to `getOptimalConfig()` only when context is
    not already concrete;
  - for concrete context + range, validate the selected per-slot capacity locally and pass only
    the exact pin into sizing (use `floor(contextSize / parallelRequests)` for this preliminary
    check; `/props` remains authoritative);
  - for any ranged start, resolve auto-configuration before the old resource gate and validate the
    resulting context/cache/offload/MoE placement with the shared raw-capacity evaluator; retain
    today's preflight order and behavior for callers with no range;
  - retain constraints in the resolved stored config so restart, auto-restart, `getConfig()`, and
    ResourceOrchestrator state preserve the contract;
  - query `/props` immediately after `waitForHealthy()` and before setting `running`, starting the
    watchdog, or emitting `started`;
  - preserve `loadTimeMs` as spawn-to-healthy time rather than including the `/props` round trip;
  - populate configured/effective state and reject effective values outside the requested range;
  - log configured total context, effective per-slot context, and slot count.
- [x] `LlamaServerManager.getInfo()`:
  - report configured total context from the resolved config;
  - report effective per-slot context only after verified startup.
- [x] Lifecycle cleanup:
  - clear stale effective state at the beginning of start and on stop/crash/failure;
  - synchronously clear PID/port/effective state after a verification failure kills the child;
  - ensure `started`/`restarted` and watchdog event payloads carry the verified value.
- [x] Keep occupancy fingerprinting behavior unchanged; reuse only common safe request/normalization
  pieces if that does not alter its short best-effort probe semantics.

**Steps**:

1. [x] Implement and unit-test strict `/props` parsing independently from occupancy probing.
2. [x] Insert discovery/verification at the pre-`running` startup boundary.
3. [x] Add constrained auto-config and precomputed-config merge paths.
4. [x] Exercise stop, manual restart, crash auto-restart, and orchestrator offload/reload reuse.
5. [x] Verify custom/wildcard host normalization and resolved auto-port URLs.

**Verification**:

- [x] Existing `LlamaServerManager` suite uses route-aware `/props` fixtures and remains green
      (102 tests).
- [x] `start()`, `getInfo()`, and lifecycle event payloads expose configured/effective context.
- [x] `/props` is queried only after health and before `running`/`started`.
- [x] Missing/malformed/non-OK/timed-out `/props` fails startup with no `started` event.
- [x] Unconstrained and exact-only `/props` failures cover the intentional compatibility change.
- [x] Below-minimum and above-maximum runtime values kill the child and leave clean stopped state.
- [x] Exact-only runtime differences are reported without changing exact-pin compatibility.
- [x] Manual restart, auto-restart, and ResourceOrchestrator reload preserve and re-check ranges.
- [x] `{ modelId, ...await getOptimalConfig(model, range) }` preserves enforcement through start,
      restart, and ResourceOrchestrator reload without manually reattaching the range.
- [x] Multi-slot tests compare the per-slot `/props` value with per-slot constraints.

## Phase 4: Acceptance Matrix and Regression Coverage

**Goal**: Cover every issue acceptance criterion without coupling runtime tests to optimizer
internals.

**Work**:

- [x] Extend `tests/unit/SystemInfo.test.ts` for:
  - no-constraint equivalence and exact compatibility;
  - minimum-below-normal retention;
  - minimum-above-normal re-optimization;
  - maximum-only, min+max, inclusive boundaries, and below-4096 maximum;
  - invalid numbers, exact/range conflict, min>max, native limit, metadata unknown;
  - unsatisfiable whole-system and pinned-plan cases;
  - full, partial, CPU-only, q8/f16, MoE automatic/hinted/nCpuMoe/custom override;
  - multi-slot total-KV multiplication and rounding boundaries.
- [x] Extend `tests/unit/LlamaServerManager.test.ts` with route-aware fetch fixtures for:
  - successful `/props` normalization and state/event exposure;
  - ordering relative to health/running;
  - min/max mismatch cleanup and typed details;
  - manager cleanup on strict `/props` failure, with HTTP, abort, JSON, and schema variants covered
    by the focused parser suite;
  - stop/crash state clearing;
  - direct spread of constrained `getOptimalConfig()` output, manual restart, auto-restart, and
    precomputed config reuse;
  - early invalid/native failures that perform no binary provisioning, port, or occupancy work;
  - a constrained resolved GPU/q8/MoE placement that succeeds even where the old unresolved
    CPU/f16/floor `canRunModel()` preflight would reject;
  - custom host, auto port, and multiple slots;
  - complete valid-config-field coverage.
- [x] Add a focused `llama-props` test file.
- [x] Extend `errors.test.ts` and `error-helpers.test.ts`, including package-root compile coverage for
  the public reason/stage/details types.
- [x] Re-run ResourceOrchestrator tests and add a focused contract
  preservation regression if existing mocks do not exercise it.

**Verification**:

- [x] Every acceptance bullet in `ISSUE-context-capacity-contract.md` maps to at least one named
      automated test.
- [x] Runtime tests mock the selected config rather than duplicating sizing arithmetic.
- [x] Existing diffusion config validation still rejects LLM-only context fields.
- [x] Test suite has no leaked timers, fetch mocks, child-process state, or open handles.

## Phase 5: Documentation and Repository Record

**Goal**: Document the capacity contract where consumers already look, without adding redundant
artifacts or performing release work.

**Work**:

- [x] `genai-electron-docs/system-detection.md`
  - Add an exact/minimum/maximum semantics table, optimizer behavior, rounding, multi-slot math,
    error cases, and direct `getOptimalConfig()` examples.
- [x] `genai-electron-docs/llm-server.md`
  - Document constrained `start()`, precomputed configurations, configured-vs-effective fields,
    mandatory `/props` verification, range failure behavior, and capacity-vs-prompt-budget
    responsibility.
  - Call out that strict `/props` verification now applies to unconstrained/exact starts as an
    intentional startup compatibility change tied to the effective-capacity guarantee.
  - Explain that multiple workload requirements combine by maximum, not sum, and that a larger
    server window does not expand request budgets.
  - Remove the stale paragraph claiming context still defaults to a planned fixed 4096.
- [x] `genai-electron-docs/typescript-reference.md`
  - Update `ServerConfig`/`LlamaServerConfig`, `OptimalConfigHints`, `ServerInfo`, and public error
    definitions.
- [x] `genai-electron-docs/integration-guide.md` and `troubleshooting.md`
  - Add typed-error/UI handling and actionable runtime-capacity failure guidance.
- [x] Source JSDoc for all new public fields and behavior.
- [x] `PROGRESS.md`
  - Update the current-status/branch/date header and add a concise top-level **Unreleased** entry
    with implementation and validation status, without rewriting the historical v0.14.0 section.
- Completion housekeeping:
  - mark the issue RESOLVED and move it to `docs/dev/issues/`;
  - mark this plan COMPLETE and move it to `docs/dev/plans/`.

No new guide, migration document, changelog, README feature list, or release artifact is needed.
The existing public guides own the consumer contract, while the archived issue and plan remain the
durable rationale/design record.

**Verification**:

- [x] Public docs use the same per-slot/total terminology as the types and tests.
- [x] Examples show direct constrained start and effective-capacity enforcement.
- [x] Error codes/reasons and lifecycle failure behavior match implementation.
- [x] No version, package metadata, tag, release, or publish change is included.

## Phase 6: Final Validation

**Goal**: Prove the implementation is complete and regression-safe before handoff.

**Steps**:

1. [x] Run focused sizing, props, manager, error, and orchestrator suites while iterating.
2. [x] Run `npm run format`.
3. [x] Run `npm run build`.
4. [x] Run `npm run lint`.
5. [x] Run `npm test`.
6. [x] Run `git diff --check` and inspect generated/public type surfaces.
7. [x] Reuse the healthy GUI-provisioned Gemma 4 12B server on 2026-07-29 without stopping or
   replacing the pre-existing process. The skill's launch preset configures 6,144 total context
   with one slot; the built strict `/props` normalizer reported 6,144 effective tokens and one
   slot, satisfying a 4,096–8,192 range. A deliberate two-slot expectation returned typed
   `runtime-slots-mismatch` diagnostics. Manager-owned `ServerInfo` state remains covered by the
   automated start/lifecycle suite because the live process was intentionally reused rather than
   replaced.
8. [x] Run the project `doublecheck` workflow against the completed implementation and fix all
   confirmed findings before declaring the issue resolved.
   - [x] Correct the conservative unknown-metadata policy for large legacy models and raw-validate
     baseline placements even when their clamped recommendation already meets the minimum.
   - [x] Guard asynchronous startup with a per-attempt identity, make stop/failure cleanup atomic,
     preserve load timing from successful starts only, and share IPv6-safe HTTP host formatting.
   - [x] Add the double-check regression cases and rerun focused review (102 manager and 61 sizing
     tests pass; independent sizing/runtime re-reviews report no remaining blockers).

**Verification**:

- [x] TypeScript build has zero errors.
- [x] Lint has zero new errors.
- [x] Formatting and `git diff --check` pass.
- [x] Full Jest suite passes with no open handles (701/701 across 28 suites).
- [x] Public exports and generated declarations contain the intended fields/error only.
- [x] All issue acceptance criteria and documentation updates are checked off.

## Risks and Mitigations

- **Optimizer drift without constraints**: isolate/lock the baseline path before adding range logic.
- **False feasibility from the current 4096 clamp**: use raw byte budgets for constrained proofs.
- **Per-slot vs total confusion**: use distinct field names and multiply constraints by resolved
  slot count in both sizing tests and docs.
- **Resolved-config restart conflict**: explicitly allow concrete start config + runtime range while
  keeping exact/range mutual exclusion inside `getOptimalConfig()`.
- **Transient resource changes**: keep current fresh RAM behavior and report measured budgets in
  unsatisfiable errors; do not claim a permanent hardware limit.
- **Unknown legacy model limit**: return an actionable unknown-metadata reason instead of treating a
  fallback estimate as native truth.
- **Upstream `/props` schema drift**: normalize unknown JSON strictly at one boundary and fail
  visibly before `running`.
- **Cleanup races after post-health rejection**: synchronously clear manager runtime state after
  killing the child and test late exit callbacks.
- **`fit: 'on'` undermining constraints**: require a concrete selected context and always verify the
  effective result.

## Open Questions

No blocking implementation questions remain if the seven contract decisions above are approved.

---

**Please review the contract decisions and phases. Edit this file directly if needed, then confirm
to proceed. Implementation must not begin before explicit approval.**
