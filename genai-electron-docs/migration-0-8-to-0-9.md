# Migrating from v0.8.x to v0.9.0

v0.9.0 is a small additive release: a **structured progress event for binary provisioning**, so loading UIs no longer parse `'binary-log'` message strings.

## Compatibility

Fully backwards-compatible. `'binary-log'` is unchanged; if you parse its messages today, nothing breaks — but switch to `'binary-progress'` so the log wording stops being an implicit API contract.

## What's New

### `'binary-progress'` event

Emitted by both `llamaServer` and `diffusionServer` during first-run binary provisioning:

```typescript
llamaServer.on('binary-progress', (event: BinaryProgressEvent) => {
  if (event.phase === 'downloading') {
    progressBar.update(event.percent!, { label: event.file });
  } else {
    statusLine.set(`${event.phase} ${event.file}...`);
  }
});
```

```typescript
interface BinaryProgressEvent {
  phase: 'downloading' | 'extracting' | 'verifying' | 'testing';
  file: string; // 'binary' or a dependency description (e.g. 'CUDA runtime')
  downloaded?: number; // bytes (downloading)
  total?: number; // bytes (downloading)
  percent?: number; // whole number (downloading)
}
```

- Download events are **throttled to whole-percent changes at the source** — no consumer-side throttling needed (`'binary-log'` still fires per chunk).
- Each phase transition emits one event; dependency downloads carry their description in `file`.
- `BinaryProgressEvent` is exported from the package root and listed in the [TypeScript Reference](typescript-reference.md#binaryprogressevent).

## See Also

- [LLM Server — events](llm-server.md) · [Migrating 0.7 → 0.8](migration-0-7-to-0-8.md)
