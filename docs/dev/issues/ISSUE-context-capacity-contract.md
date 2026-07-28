# ISSUE: Support minimum/maximum context constraints and report the effective server context

Created: 2026-07-28

Status: RESOLVED (2026-07-28)

Package: genai-electron

Filed from: palimpsest-engine

## Request

Applications need to tell genai-electron the minimum context window their workloads require
without pinning the server to that exact size. genai-electron should optimize the server
configuration subject to application-provided minimum and maximum context constraints, then
report the context window the running llama-server actually provides.

This is a server-capacity contract. Applications remain responsible for deciding how much of
that capacity each request should use.

## Problem

`SystemInfo.getOptimalConfig()` currently chooses `contextSize` from the model and available
VRAM/RAM. `OptimalConfigHints.contextSize` lets a caller replace that choice with an exact pin,
but there is no way to express either of these common requirements:

- "Choose the best configuration you normally would, but provide at least 12,288 tokens."
- "Do not allocate more than 32,768 tokens even if additional context would fit."

This leaves applications choosing between accepting an undersized automatic recommendation and
duplicating genai-electron's hardware-sizing logic by selecting an exact context themselves.
Neither establishes a reliable contract between application prompt budgets and server capacity.

Palimpsest Engine exposed the failure in real play. Its default narrative-generation policy may
assemble approximately 8,000 budgeted prompt tokens (4,000 history plus 4,000 world text), plus
current input and fixed/system text, while reserving up to 2,000 output tokens. genai-electron
started the development model at `-c 5632 -ngl 38` because that configuration fit its hardware
optimization, but genai-electron had no knowledge of the application's required capacity.

A related run against llama-server at `-c 6144` assembled a 5,875-token prompt and requested up
to 2,000 output tokens. llama-server stopped after 223 output tokens at
`n_tokens = 6143, truncated = 1`, cutting the response off mid-sentence. This specific
truncation guard belongs in Palimpsest/genai-lite, but preventing the capacity mismatch requires
genai-electron to accept application constraints and expose the effective server result.

## Required API semantics

The sizing API should distinguish an exact value from lower and upper constraints. The concrete
shape may vary, but the public contract should support semantics equivalent to:

```typescript
export interface OptimalConfigHints {
  /** Exact context size. Mutually exclusive with minimumContextSize/maximumContextSize. */
  contextSize?: number;

  /** Smallest acceptable context window. The optimizer may return a larger value. */
  minimumContextSize?: number;

  /** Largest useful context window. The optimizer may return a smaller value. */
  maximumContextSize?: number;

  // Existing hints remain unchanged.
}
```

**No constraints:** Preserve the current adaptive behavior.

**Exact `contextSize`:** Preserve the current pinning behavior for backward compatibility.

**Minimum only:** Run the normal optimization. If its result meets the minimum, retain that
result rather than reducing it to the minimum. If it does not, re-optimize the configuration to
make room for the requested context, including reducing GPU layer offload or changing other
existing adaptive choices where appropriate.

**Maximum only:** Run the normal optimization, then constrain context to the maximum. A maximum
is useful when allocating a larger KV cache would waste resources that the application never
uses.

**Minimum and maximum:** Select an optimized value inside the inclusive range. Reject
`minimumContextSize > maximumContextSize`.

**Model and hardware limits:** Reject a minimum above the model's native context limit. If the
available VRAM/RAM cannot satisfy the minimum under any supported configuration, return a
structured resource/constraint error; do not silently return a smaller window while implying
that the minimum was honored.

Rounding to llama.cpp-compatible granularity is acceptable, provided minimums round upward,
maximums round downward, and the returned configuration states the selected value.

## Effective runtime capacity

The selected launch argument is not always sufficient evidence of the running server's actual
capacity, especially when llama.cpp fitting behavior or version changes can adjust runtime
configuration. genai-electron should expose the effective context after startup.

The preferred result is a normalized field on `ServerInfo`, populated from llama-server's
`/props` response after the server becomes healthy:

```typescript
export interface ServerInfo {
  // Existing fields remain unchanged.

  /** Effective context window reported by the running server. */
  contextSize?: number;
}
```

If distinguishing the request from the result is useful, expose both
`configuredContextSize` and `effectiveContextSize`. The effective value must be available through
the ordinary server lifecycle API so every consumer does not have to implement its own
llama-server `/props` client and version normalization.

A startup that requested a minimum but reports an effective context below it should fail with a
structured error rather than enter the `running` state as though the constraint were satisfied.

## Consumer contract

Applications use the feature in three steps:

1. Derive the minimum server capacity from their workload-specific prompt budgets, output
   reserves, and safety allowance.
2. Pass that minimum to genai-electron and start the server using the returned optimized
   configuration.
3. Read the effective capacity after startup and enforce it during request assembly.

The minimum is a capacity requirement, not a request-length target. A server may run with a
larger context while the application deliberately sends shorter prompts.

For example, Palimpsest may route both narrative generation and soft evaluation to the same
model. The server minimum is the maximum requirement among those workloads, not their sum.
Narrative generation may use several thousand tokens of history and world context, while soft
evaluation intentionally retains its much smaller history budget to protect attention. A larger
server window must not cause either budget to expand automatically.

## Acceptance criteria

The change is complete when all of the following behavior is covered:

- `OptimalConfigHints` can express minimum and maximum context constraints without using an
  exact pin.
- Existing callers that omit the new constraints receive unchanged automatic behavior.
- Existing callers that set `contextSize` retain exact-pin behavior.
- An automatic recommendation above a minimum remains above it rather than being reduced to the
  minimum.
- An automatic recommendation below a satisfiable minimum is re-optimized to meet it.
- A maximum constrains an otherwise larger recommendation.
- Conflicting constraints, a minimum above the model's native limit, and an unsatisfiable
  hardware minimum produce explicit typed errors.
- Full-offload, partial-offload, CPU-only, KV-quantized, and MoE-aware sizing paths honor the
  constraints.
- `ServerInfo` exposes the effective running context obtained from llama-server.
- Startup detects and rejects an effective context below a requested minimum.
- Public documentation explains exact, minimum, and maximum semantics and the distinction
  between server capacity and application prompt budgets.

## Out of scope

genai-electron should not decide how an application divides context among history, world data,
current input, or different request types. It should not expand application prompts merely
because more server capacity is available. Prompt trimming, output-reserve policy, tokenizer
safety margins, and detection/recovery of truncated generations remain consumer or genai-lite
responsibilities.

## Resolution

Implemented the context-capacity contract on the unreleased `context-capacity-contract` branch:

- `OptimalConfigHints` and llama start configuration now accept effective per-slot minimum and
  maximum context constraints while preserving unconstrained and exact-pin behavior.
- Constraint-aware sizing enforces native limits, multi-slot KV totals, caller-owned placement
  pins, and raw VRAM/RAM feasibility across full, MoE, partial, quantized-KV, and CPU paths.
- Typed context validation/runtime failures are exported from the package root.
- Every llama startup now verifies effective per-slot capacity through mandatory `GET /props`
  before entering `running`; configured total and effective per-slot context are reported
  separately.
- Lifecycle state and constraints survive restart/orchestration, while stop, crash, failed
  verification, stale callbacks, and auto-restart cancellation cannot publish stale capacity.
- Existing public sizing, server, TypeScript, integration, and troubleshooting guides document
  the contract and retain prompt-budget policy as a consumer responsibility.

## Validation

- Repository formatting, TypeScript build, and `git diff --check` pass.
- ESLint passes with 0 errors and 61 existing warnings.
- Jest passes 701/701 tests across 28 suites with `--detectOpenHandles`.
- Focused independent double-checks of sizing, public API/documentation, and runtime lifecycle
  found no remaining blockers after their confirmed findings were fixed with regressions.
- A 2026-07-29 live smoke reused the healthy GUI-provisioned Gemma 4 12B server without stopping
  it. The 6,144-context/one-slot preset matched `/props`: the built normalizer returned 6,144
  effective tokens and one slot, satisfying a 4,096–8,192 range. Requiring two slots produced
  `CONTEXT_CONSTRAINT_ERROR` with `runtime-slots-mismatch`, effective slot count 1, as designed.
