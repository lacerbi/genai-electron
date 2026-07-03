# ISSUE: Structured progress event for binary provisioning (downloads currently parseable only from log strings)

Created: 2026-07-03
Status: RESOLVED (2026-07-03, on main — ships with the next release) — 'binary-progress'
event implemented as proposed (+ whole-percent convenience field): throttled at the
source, phase transitions for downloading/verifying/extracting/testing, dependency
downloads labeled by description, forwarded by both server managers. 'binary-log'
unchanged. See genai-electron-docs/llm-server.md#binary-progress.
Package: genai-electron (filed from palimpsest-engine loading-UI work)

## Problem

The first `llamaServer.start()` downloads the llama.cpp binary (~50–300 MB) —
a long, silent wait from the consumer app's perspective. The only signal is
the `'binary-log'` event, whose payload is a human-readable string:
`BinaryManager` logs `` `Downloading ${variant.type} binary: ${percent}%` ``
(src/managers/BinaryManager.ts, main-binary and dependency download
callbacks) through the `log` callback that `ServerManager.emit('binary-log',
{ message, level })` forwards.

Consumers who want a progress bar must regex the percentage out of the
message text. palimpsest does exactly this today
(`/:\s*(\d+(?:\.\d+)?)%\s*$/` on `binary-log` messages) and it works — but
the message wording is now an implicit API contract: any rephrasing of the
log line silently breaks downstream progress UIs. (Same failure class as the
Gemini timeout message-sniffing that v0.9.2 of genai-lite just eliminated.)

Two smaller papercuts from the same gap:

- The log fires on **every download chunk**, so consumers must also throttle.
- There's no machine-readable phase signal (downloading vs. verifying vs.
  variant testing) — only prose.

## Fix

Add a structured event alongside `binary-log` (which stays as-is for
logging), e.g.:

```typescript
// ServerEvent union += 'binary-progress'
export interface BinaryProgressEvent {
  phase: 'downloading' | 'extracting' | 'verifying' | 'testing';
  /** What is being downloaded: 'binary' or a dependency description */
  file: string;
  downloaded?: number;  // bytes, when phase === 'downloading'
  total?: number;       // bytes, when known
}
```

Emit from the same `onProgress` callbacks that currently produce the log
lines (BinaryManager already has `downloaded`/`total` in hand), throttled at
the source (e.g. whole-percent changes), plus one event per phase
transition. This mirrors the precedent of `DownloadProgressCallback` on
`modelManager.downloadModel()` — model downloads already give consumers
structured bytes; binary downloads should too.

## Notes

- Severity: low — a log-parsing workaround exists and ships in palimpsest;
  this is about removing an implicit string contract before more consumers
  grow to depend on it.
- If the event lands, palimpsest drops its regex + throttle and subscribes
  to `binary-progress` directly.
