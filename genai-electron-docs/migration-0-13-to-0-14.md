# Migrating from v0.13.x to v0.14.0

v0.14.0 is a backward-compatible provisioning and reliability release. Existing server start
configuration, model metadata, binary variant ordering, and genai-lite integration continue to
work without changes.

Because this package is still below `1.0.0`, a dependency range such as `^0.13.0` does **not**
admit `0.14.0`. Update the range explicitly when you are ready to adopt this release.

## What changed

- Windows ZIP parsing and inflation run in a worker thread instead of Electron's main process.
- `'binary-progress'` extraction events add optional `completedEntries` and `totalEntries`.
- Successfully installed dependency archives are recorded by checksum in an atomic `.deps.json`
  manifest and reused across release-URL changes.
- Interrupted provisioning starts from clean staging and reuses complete checksum-valid archives.
- Diffusion Phase-2 validation uses the same resolved CPU-offload and flash-attention flags as
  production generation.
- Provisioning output is persisted to the normal llama or diffusion server log from the beginning
  of `start()`.
- Concurrent `start()` calls on the same manager are rejected while the first start is in progress.

No binary pin, model format, storage root, or public start-method signature changes in this
release.

## No required code migration

Existing listeners that use only `phase`, `file`, `downloaded`, `total`, or `percent` remain valid.
The new extraction fields are optional:

```typescript
llamaServer.on('binary-progress', (event) => {
  if (event.phase === 'extracting' && event.totalEntries !== undefined) {
    console.log(
      `Extracting ${event.file}: ${event.completedEntries}/${event.totalEntries}`
    );
  }
});
```

Download byte counters retain their previous meaning. During ZIP extraction, `percent` is derived
from entry counts rather than bytes.

## Provisioning cache and recovery

The library may create `userData/binaries/<type>/.deps.json`. This is internal cache metadata and
should be kept with the installed dependency files. Deleting it is safe, but the next binary
replacement may download and inflate the dependency archive again.

Complete bare archives left by an interrupted process are reused only when their configured
SHA-256 matches. `.partial` downloads are still restarted rather than range-resumed.

On an already-valid installed binary, leftover main archives and extraction directories are
cleaned best-effort. An unmanifested dependency archive is preserved as a recovery copy for the
small interruption window between dependency installation and manifest commit.

## Concurrent starts

Calling `start()` a second time while the same manager is already `starting` now rejects with
`ServerError`. Applications should await or share their first `start()` promise instead of issuing
duplicate starts:

```typescript
const startPromise = llamaServer.start(config);
await startPromise;
```

Calls made after the server reaches `running` retain the existing "already running" error.

## Upgrade checklist

1. Change your dependency to `genai-electron@^0.14.0` (or an exact version).
2. Rebuild the Electron application.
3. Subscribe to the optional extraction counters if the UI displays provisioning progress.
4. Allow one normal server start and confirm provisioning lines appear in the server log.
5. If a binary version change provisions new files, keep `.deps.json` with the binaries directory.

## See also

- [Installation and Setup](installation-and-setup.md)
- [LLM Server](llm-server.md)
- [Image Generation](image-generation.md)
- [Troubleshooting](troubleshooting.md)
- [Migrating 0.12 → 0.13](migration-0-12-to-0-13.md)
