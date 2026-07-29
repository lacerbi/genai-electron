# Migrating from v0.15.x to v0.16.0

v0.16.0 adds a soft preferred-context target and one canonical, revisioned llama-server readiness
notification. Applications can optimize KV allocation for their normal workload while retaining
hard capacity bounds, and can identify the exact healthy server process that owns asynchronous
lifecycle work.

The existing `started` and `restarted` events remain available. The compatibility change to review
is lifecycle ordering: every successful llama-server process now emits `ready` before `started`.

Because this package is still below `1.0.0`, a dependency range such as `^0.15.0` does **not**
admit `0.16.0`. Update the range explicitly when you are ready to adopt this release.

## What changed

- `preferredContextSize` is available on `OptimalConfigHints` and `LlamaServerConfig`.
- Preferred context is an effective **per-slot** soft sizing target. The optimizer avoids
  unnecessary KV allocation above it, but runtime capacity above preferred remains valid.
- `minimumContextSize` and `maximumContextSize` remain inclusive hard runtime bounds.
- `LlamaServerReadyState` and the canonical llama-server `'ready'` event are exported publicly.
- `ServerInfo.serverGeneration` identifies the last successfully committed process generation.
- `ServerInfo.effectiveParallelRequests` reports verified or resolved parallel capacity.
- Failed, cancelled, superseded, and stale startup attempts do not consume generations or emit
  readiness.
- Initial start, explicit restart, automatic crash recovery, and `ResourceOrchestrator`
  restoration use the same verified readiness path.

## Add a preferred context target

Use preferred context when additional capacity is harmless but not worth allocating explicitly:

```typescript
import { llamaServer, modelManager, systemInfo } from 'genai-electron';

const model = await modelManager.getModelInfo('writing-model');
const recommendation = await systemInfo.getOptimalConfig(model, {
  minimumContextSize: 4096,
  preferredContextSize: 8192,
  maximumContextSize: 16384,
  parallelRequests: 1,
});

const info = await llamaServer.start({
  modelId: model.id,
  ...recommendation,
});

console.log(info.effectiveContextSize);
```

The optimizer targets 8,192 effective tokens per slot when feasible. A running server may report
more than 8,192 without failing startup; values below the minimum or above the maximum still fail
with the existing typed context-constraint diagnostics.

`contextSize` remains an exact total pin. Do not combine it with context-policy fields in
`getOptimalConfig()`. A resolved recommendation may contain a concrete `contextSize` together with
retained minimum/preferred/maximum policy when spread into `llamaServer.start()`.

## Subscribe to canonical readiness

Use `ready` when a consumer must bind work to one verified process:

```typescript
import type { LlamaServerReadyState } from 'genai-electron';
import { llamaServer } from 'genai-electron';

llamaServer.on('ready', (state: LlamaServerReadyState) => {
  console.log({
    generation: state.serverGeneration,
    modelId: state.modelId,
    port: state.port,
    contextPerSlot: state.effectiveContextSize,
    parallelSlots: state.effectiveParallelRequests,
  });
});
```

`serverGeneration` starts at `0` in `getInfo()`, and the first verified process receives generation
`1`. It increases only after `/health` and `/props` verification and a committed running state. The
last successful generation remains visible as a watermark after stop/crash, while effective
capacity is cleared. It resets when the Electron main process is relaunched.

A late subscriber can reconcile with `llamaServer.getInfo()`: while running, its generation,
configured/effective context, effective parallel count, port, model, and start time agree with the
latest ready payload.

## Event ordering

The public lifecycle order is:

- Initial start: `ready` -> `started`
- Explicit restart: `stopped` -> `ready` -> `started` -> `restarted`
- Automatic restart: `crashed` -> `ready` -> `started` -> `restarted`
- Resource restoration: the orchestrator's background `start()` emits `ready` -> `started`

Reading and continuing to use a suitable running process does not increment or re-emit readiness.
Calling `start()` while already running continues to reject; this release does not add idempotent
startup or suitability-selection behavior.

## Effective parallel capacity

llama-server's `/props.total_slots` remains optional. When present, genai-electron validates and
uses it. Otherwise `effectiveParallelRequests` falls back to the resolved configured
`parallelRequests`, whose default is `1`.

## Upgrade checklist

1. Change the dependency to `genai-electron@^0.16.0` (or an exact version).
2. Rebuild the Electron application.
3. Add a `ready` listener for consumers that need generation-aware lifecycle reconciliation.
4. Update expected auto-restart ordering to include `ready` before `started`.
5. Optionally replace a hard maximum used only for sizing with `preferredContextSize`.
6. Read `effectiveParallelRequests` alongside `effectiveContextSize` when budgeting concurrent
   work.

## See also

- [System Detection — `getOptimalConfig()`](system-detection.md#getoptimalconfig)
- [LLM Server](llm-server.md)
- [TypeScript Reference](typescript-reference.md)
- [Integration Guide](integration-guide.md)
- [Troubleshooting](troubleshooting.md)
- [Migrating 0.14 -> 0.15](migration-0-14-to-0-15.md)
