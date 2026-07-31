# Migrating from v0.17.x to v0.18.0

v0.18.0 adds automated, per-machine calibration for a bounded set of llama-server runtime flags.
The new `LlamaServerManager.calibrate()` API runs representative workloads against isolated real
server processes and returns a start-ready recommendation plus the measurements needed to audit it.

The release is backward compatible: calibration is opt-in, does not alter normal server lifecycle
state, and never persists or applies its recommendation automatically. As a pre-1.0 package,
however, a dependency range such as `^0.17.0` does not admit `0.18.0`; update the declared range
explicitly when adopting this release.

## What changed

### Fixed-profile runtime calibration

Call `calibrate()` with the model, exact total context, parallel-slot count, and workloads that
represent production:

```ts
import { llamaServer } from 'genai-electron';

const report = await llamaServer.calibrate({
  modelId,
  profile: {
    contextSize: 12_288,
    parallelRequests: 1,
  },
  workloads: [
    {
      id: 'chat-prefill',
      kind: 'cold-prefill',
      prompt: representativePrompt,
      nPredict: 32,
    },
  ],
  samples: 3,
});

if (report.recommended) {
  await llamaServer.start({
    modelId,
    ...report.recommended.startConfig,
  });
}
```

Each calibration call holds `contextSize` and `parallelRequests` fixed. To compare capacity against
performance, run separate calibrations at the context sizes of interest with equivalent workloads,
then make that cross-report decision in the consumer application.

### Bounded defaults and caller-shaped candidates

The generated candidate set is deliberately small and model-aware. It explores a practical core of
GPU placement, MoE offload, flash attention, and SWA behavior rather than taking a Cartesian product
of every llama-server option. Callers can replace that set with an exact, narrower candidate list
when they already know which tradeoff matters on their hardware or workload.

KV-cache quantization remains supported through normal server configuration and through explicit
calibration candidates. It is not part of the default sweep. Callers may opt into the provided
f16/q8 comparison; when enabled, the default precision-preference window keeps f16 when its latency
is within 10% of q8, and the window is configurable.

### Serial, report-only operation

Candidates and repetitions run serially. Calibration uses isolated processes, verifies the exact
runtime capacity through `/props`, controls slot state for prompt-cache workloads, and tears each
process down before continuing. It emits `calibration-progress`, supports cancellation, and exposes
`isCalibrating()` for UI coordination.

The report includes per-workload samples, failures, binary/model identities, the tested profile, and
the recommendation rationale. A consumer should persist or apply a chosen result only after checking
that the report matches the intended production binary, model, context, slot count, and workload.

## Adoption checklist

- Update the dependency range to admit `0.18.0`.
- Choose representative production prompts and output lengths.
- Keep one calibration call at one exact context and slot profile.
- Use the generated core candidates or supply an exact narrower candidate list.
- Opt into KV-cache comparison only when that tradeoff is relevant.
- Review the report and apply or persist the recommendation in the consumer application.
- Recalibrate after material binary, model, driver, hardware, or workload changes.

## Rollback

Applications that do not call `calibrate()` require no code changes. To roll back the package, pin
`genai-electron` to `0.17.0` and reinstall. Calibration does not migrate stored models, binaries, or
server configuration, so no data rollback is required.

## See also

- [LLM server](llm-server.md)
- [TypeScript reference](typescript-reference.md)
- [Resource orchestration](resource-orchestration.md)
- [Troubleshooting](troubleshooting.md)
