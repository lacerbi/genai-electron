# Migrating from v0.16.x to v0.17.0

v0.17.0 adds an opt-in way to enable llama.cpp's full-size sliding-window-attention
(SWA) cache. This can dramatically improve prompt-cache reuse for repeated short
requests with a large shared prefix, at the cost of additional KV-cache memory.

The release is backward compatible: existing configurations emit the same command
line because `swaFull` defaults to the llama.cpp server default. As a pre-1.0 package,
however, a dependency range such as `^0.16.0` does not admit `0.17.0`; update the
declared range explicitly when adopting this release.

## What changed

### Opt-in full-size SWA cache

`LlamaServerConfig` now exposes `swaFull?: boolean`. Set it to `true` to emit
`--swa-full`:

```ts
import { llamaServer } from 'genai-electron';

await llamaServer.start({
  modelPath,
  contextSize: 12_288,
  gpuLayers: 34,
  swaFull: true,
});
```

When `swaFull` is `false` or unset, genai-electron emits no SWA flag and preserves
the prior behavior.

Full-size SWA is most useful for workloads that repeatedly submit short, similar
prompts and depend on reuse beyond a shared system prefix. Its KV-cache cost grows
with context size, so measure both latency and memory on the target machine before
enabling it broadly.

### Conservative sizing already covers full-size SWA

Metadata-backed automatic placement already prices every transformer layer at the
configured full context. That is conservative for a normal windowed SWA cache and
covers the larger full-size cache used by `swaFull: true`. v0.17.0 adds regression
coverage for Gemma-style models whose full-attention and SWA layers have different
KV dimensions.

For models without usable GGUF metadata, refresh stored metadata before relying on
tightly packed automatic placement:

```ts
await modelManager.updateModelMetadata(modelId);
```

Alternatively, pin `contextSize` and `gpuLayers` to values validated on the target
machine.

### Direct llama-specific configuration is type-safe

`LlamaServerManager.start()` now accepts `LlamaServerConfig` directly. This aligns
the public method signature with the llama-specific options it already consumes and
allows direct object literals containing fields such as `swaFull`, cache types, or
flash-attention settings without TypeScript excess-property errors.

## Rollback

To keep v0.17.0 while restoring the previous llama.cpp behavior, remove `swaFull` or
set it to `false`:

```ts
await llamaServer.start({
  modelPath,
  swaFull: false,
});
```

To roll back the package, pin `genai-electron` to `0.16.0` and reinstall. No stored
model or binary migration is required.

## Upgrade checklist

- Update the dependency range to admit `0.17.0`.
- Enable `swaFull` only for workloads that benefit from deeper prompt-cache reuse.
- Recheck VRAM/RAM headroom at the production context size.
- Refresh GGUF metadata or pin placement for legacy model records without metadata.
- Verify repeated short prompts and monitor llama.cpp prompt-processing timings.

## See also

- [LLM server](llm-server.md)
- [System detection and sizing](system-detection.md)
- [TypeScript reference](typescript-reference.md)
