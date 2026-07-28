# Migrating from v0.14.x to v0.15.0

v0.15.0 adds a context-capacity contract for llama-server. Applications can express effective
per-request minimum and maximum context requirements without replacing genai-electron's hardware
optimizer, and can read the capacity that the running server actually exposes.

Existing unconstrained automatic sizing and exact `contextSize` recommendations retain their
previous behavior. The compatibility change to review is that every llama-server start now
requires a compatible `GET /props` response before entering `running`.

Because this package is still below `1.0.0`, a dependency range such as `^0.14.0` does **not**
admit `0.15.0`. Update the range explicitly when you are ready to adopt this release.

## What changed

- `minimumContextSize` and `maximumContextSize` are available on `OptimalConfigHints` and
  `LlamaServerConfig`.
- Minimum and maximum values describe effective **per-slot** capacity. The selected
  `contextSize` remains the concrete **total** context passed to llama-server.
- Constraint-aware sizing preserves an already-suitable recommendation and otherwise searches
  permitted full-GPU, MoE, partial-GPU, KV-quantized, and CPU placements using raw VRAM/RAM
  feasibility.
- `ServerInfo.configuredContextSize` reports the selected total context.
- `ServerInfo.effectiveContextSize` reports the per-slot context returned by llama-server
  `GET /props`.
- `ContextConstraintError` and its reason, stage, and details types are exported from the package
  root.
- Restart, crash auto-restart, and `ResourceOrchestrator` offload/reload flows preserve and
  re-check the requested range.

## Startup compatibility: `/props` is now required

After `/health` succeeds, `LlamaServerManager.start()` requests `GET /props` and requires:

- an HTTP success response with valid JSON;
- a positive safe-integer `default_generation_settings.n_ctx`;
- when `total_slots` is present, a positive safe integer matching `parallelRequests`.

The manager does not enter `running`, start its watchdog, or emit `started` until this check
passes. The llama.cpp b9860 binary pinned by genai-electron supports this schema.

If you supply a custom llama-server binary, reverse proxy, test double, or request interceptor,
ensure it exposes `/props`. Test fixtures that previously mocked only `/health` must now also
return a compatible `/props` response:

```json
{
  "default_generation_settings": {
    "n_ctx": 8192
  },
  "total_slots": 1
}
```

Unavailable or malformed runtime capacity rejects startup with
`ContextConstraintError` reason `runtime-capacity-unavailable`. A slot-count disagreement uses
`runtime-slots-mismatch`.

## Add a context-capacity requirement

Constraints are optional. To require at least 8,192 effective tokens per request while retaining
the optimizer's preferred larger value up to 32,768:

```typescript
import { llamaServer, modelManager, systemInfo } from 'genai-electron';

const model = await modelManager.getModelInfo('writing-model');
const recommendation = await systemInfo.getOptimalConfig(model, {
  minimumContextSize: 8192,
  maximumContextSize: 32768,
  parallelRequests: 1,
});

const info = await llamaServer.start({
  modelId: model.id,
  ...recommendation,
});

console.log({
  configuredTotal: info.configuredContextSize,
  effectivePerSlot: info.effectiveContextSize,
});
```

The returned recommendation retains the minimum and maximum fields, so spreading it directly into
`start()` preserves runtime enforcement through restart and orchestration flows.

With `parallelRequests: 2`, a minimum of 8,192 requires enough total KV capacity for two slots,
while `/props` must report at least 8,192 effective tokens for each slot.

## Exact values and ranges

`contextSize` remains an exact total sizing hint. In `getOptimalConfig()`, do not combine that
exact hint with minimum/maximum hints; use one mode or the other.

A resolved recommendation can legitimately contain a concrete `contextSize` together with its
retained minimum/maximum contract when passed to `start()`. The concrete value controls the CLI
configuration, while the range remains active for post-health runtime verification.

Multiple workloads sharing one server should combine their capacity needs with `max()`, not by
adding them. A larger server capacity also does not expand application prompt or output budgets;
prompt assembly, trimming, and output reserves remain consumer responsibilities.

## Handle structured failures

```typescript
import {
  ContextConstraintError,
  InsufficientResourcesError,
  llamaServer,
} from 'genai-electron';

try {
  await llamaServer.start({
    modelId: 'writing-model',
    minimumContextSize: 8192,
  });
} catch (error) {
  if (error instanceof ContextConstraintError) {
    console.error(error.details.reason, error.details.suggestion);
  } else if (error instanceof InsufficientResourcesError) {
    console.error(error.details.required, error.details.available);
  }
}
```

`ContextConstraintError` covers invalid ranges, unavailable model-native metadata for a requested
higher minimum, native-limit conflicts, `/props` failures, slot mismatches, and runtime values
outside the requested range. A valid minimum that no permitted hardware placement can satisfy
continues to use `InsufficientResourcesError`.

## Upgrade checklist

1. Change the dependency to `genai-electron@^0.15.0` (or an exact version).
2. Rebuild the Electron application.
3. Confirm custom llama-server binaries and proxies expose compatible `/health` and `/props`
   endpoints.
4. Update startup test doubles to return `default_generation_settings.n_ctx` and the expected
   `total_slots`.
5. Optionally replace exact context pins with minimum/maximum constraints.
6. Read `effectiveContextSize` after startup and keep application prompt budgets within it.

## See also

- [System Detection — `getOptimalConfig()`](system-detection.md#getoptimalconfig)
- [LLM Server](llm-server.md)
- [TypeScript Reference](typescript-reference.md)
- [Integration Guide](integration-guide.md)
- [Troubleshooting](troubleshooting.md)
- [Migrating 0.13 → 0.14](migration-0-13-to-0-14.md)
