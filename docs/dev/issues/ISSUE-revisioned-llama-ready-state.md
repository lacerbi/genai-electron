# Issue: Expose Revisioned llama-server Ready State

Created: 2026-07-29
Status: RESOLVED

## Summary

Consumers need one authoritative notification whenever a newly started llama-server process is
healthy and its effective capacity has been verified. The notification must identify the exact
server incarnation so asynchronous consumers can discard stale lifecycle work safely.

`started` and `restarted` currently expose `ServerInfo`, but they do not provide a persistent
incarnation identifier. Successful starts can also arise through several paths: initial startup,
explicit restart, automatic crash recovery, and resource-orchestrator restoration.

## Required contract

Add a monotonic llama-server generation to the public ready state and expose one canonical event
for successful readiness.

The public payload must contain:

```ts
interface LlamaServerReadyState {
  serverGeneration: number;
  modelId: string;
  port: number;
  configuredContextSize?: number;
  effectiveContextSize: number;
  effectiveParallelRequests: number;
  startedAt: string;
}
```

The exact names may follow the library's existing conventions, but the semantics below are
required.

**Generation:** `serverGeneration` identifies the committed healthy process. It increases
monotonically whenever a different llama-server process reaches verified readiness. Failed,
cancelled, superseded, and stale startup attempts never acquire a generation.

The generation is scoped to the lifetime of the Electron main process. It starts at `0`, the first
verified process receives generation `1`, and it is not persisted across application launches.
After a stop or crash, `getInfo()` retains the last committed generation as a watermark, while
process-specific effective-capacity fields are cleared.

**Ready event:** Emit one canonical `ready` or `capacity-ready` event exactly once for each
successful generation, after `/health` and `/props` validation and after the manager has committed
its running state. Initial starts, explicit restarts, automatic restarts, and
resource-orchestrator restorations use the same event.

Use `ready` as the canonical event. Keep `started` and `restarted` as additional lifecycle
notifications. For each successful start, `ready` emits before `started`; a restart then emits
`restarted` after `started`.

**Effective parallelism:** `/props.total_slots` remains optional. When llama-server reports it,
validate and use that value. Otherwise, use the resolved configured `parallelRequests`, whose
default is `1`:

```ts
effectiveParallelRequests =
  runtimeCapacity.totalSlots ?? resolvedConfig.parallelRequests ?? 1;
```

**Current state:** `getInfo()` exposes the current generation and the same effective capacity
values as the ready event. A consumer that subscribes late can therefore reconcile its cached
state without guessing which lifecycle event occurred. While the server is running, these values
agree with the most recent ready payload.

**No false readiness:** A no-op reuse of the already-running process does not emit another ready
event or increment the generation. Failed starts, cancelled starts, and late callbacks from an
older process do not emit readiness.

Reuse here means that a consumer inspects `getInfo()` and continues using a suitable running
process without calling `start()`. This issue does not make `start()` idempotent and does not add
suitability or reuse selection logic. Calling `start()` while the server is already running
continues to reject and does not increment the generation or emit readiness.

## Event ordering

Lifecycle ordering must make stale-state rejection deterministic:

1. A previous generation emits `stopped` or `crashed` before a replacement becomes ready.
2. The replacement commits its verified model, port, effective per-slot context, and effective
   slot count.
3. The canonical ready event emits with the new generation.
4. The additional `started` event emits, followed by `restarted` when the start was a restart.
5. No subsequent event from the previous process may report itself as current.

The resulting public order is:

- Initial start: `ready` -> `started`
- Explicit restart: `stopped` -> `ready` -> `started` -> `restarted`
- Automatic restart: `crashed` -> `ready` -> `started` -> `restarted`

Resource-orchestrator restoration follows the same sequence even when restoration happens in the
background after another operation has returned.

## Acceptance criteria

- [x] Public types expose the monotonic server generation.
- [x] Public ready-state data includes the effective per-slot context and effective parallel slot
      count reported by the running server when available, otherwise the resolved configured count.
- [x] Initial start emits exactly one canonical ready event.
- [x] Explicit restart emits exactly one canonical ready event with a higher generation.
- [x] Automatic restart emits exactly one canonical ready event with a higher generation.
- [x] Resource-orchestrator restoration emits exactly one canonical ready event with a higher
      generation.
- [x] Reusing an already-running suitable server does not increment or re-emit readiness.
- [x] Failed, cancelled, superseded, and stale startup attempts never emit readiness.
- [x] `getInfo()` agrees with the most recent ready payload.
- [x] Tests cover event order and stale-attempt suppression.
- [x] The public API reference and lifecycle documentation describe the canonical event.

## Non-goals

This issue does not change context-size selection, including `preferredContextSize`. It does not
add token counting, request routing, prompt budgeting, application-specific retry behavior,
generation persistence across Electron launches, idempotent `start()`, or server-suitability
selection.

## Resolution

Implemented as an unreleased feature on 2026-07-29. The manager now exposes a strict `ready`
snapshot, a successful-process generation watermark, and effective parallel capacity through
`getInfo()`. All startup and restoration paths converge on the same verified commit point.
