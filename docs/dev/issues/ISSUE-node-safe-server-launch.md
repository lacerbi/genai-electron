# ISSUE — No Electron-free entry point for launching a local llama-server

- Created: 2026-08-18
- Status: RESOLVED — implemented and verified 2026-08-18; execution record in
  `docs/dev/plans/PLAN-node-safe-server-launch.md`
- Package: genai-electron
- Affected API: package entry points, canonical llama-server arguments, isolated process runner,
  health/capacity probes, and package peer metadata
- Severity: low — the downstream workaround works, but duplicates configuration owned here and can
  silently drift

## Summary

A plain-Node tool can hold an already-provisioned llama-server executable and GGUF path without
having an Electron runtime. genai-electron already owns the canonical arguments, health checks,
capacity checks, and isolated process lifecycle, but none are reachable through a supported
Electron-free package entry. The root transitively imports Electron, while strict package exports
correctly prevent consumers from reaching into `dist/`.

Add one narrow ESM entry:

```ts
import {
  buildLlamaServerArgs,
  startLlamaServerRunner,
  waitForHealthy,
} from 'genai-electron/llama-server-launch';
```

The caller continues to own binary and model discovery. This package builds the canonical argv,
launches exactly one child, verifies health and `/props` capacity, reports model identity when the
server supplies it, and provides confirmed teardown without loading Electron.

## Why the current workaround is insufficient

The motivating Palimpsest command-line path currently has to reproduce the launcher from outside
the package. Changes here to flag spelling/order, cache normalization, slots behavior, health host,
or capacity interpretation can then produce a server that starts successfully with different
runtime behavior. Deep imports are not an acceptable escape hatch: v0.22.0 intentionally sealed
undeclared `dist/` paths.

The package root remains Electron-specific because managers and storage paths depend on
`app.getPath('userData')`. Only the launch graph becomes available to plain Node.

## Approved design

### Narrow config and model contracts

- Keep `ServerConfig`, `LlamaServerConfig`, `LlamaServerManager.getConfig()`, and package-root
  exports unchanged.
- Derive `LlamaServerRuntimeConfig` from the fields consumed by the canonical argument builder.
- Give the public factory a runner-specific config that cannot duplicate its required top-level
  context, parallelism, or fixed `fit: 'off'` values.
- Accept `LlamaModelFile = { path: string }`; callers do not fabricate registry metadata.
- Retain the manager-only full resolved config alias separately from launch/runtime aliases.

### Public factory and post-start handle

Expose `startLlamaServerRunner()` and a narrow `LlamaServerHandle`, not the concrete calibration
runner or its process/cleanup test seams. The factory resolves only after spawn, health, exact-child
liveness, and mandatory `/props` capacity verification, so its public handle has required PID, load
time, resolved config, and verified capacity.

The public `signal` cancels startup only. Once the factory returns, the caller owns the handle and
must call `stop()`; aborting the old startup signal does not later terminate a successful server.

### Host, cwd, and port behavior

Caller-controlled `host` and `cwd` are an approved bounded expansion beyond the first consumer's
loopback-only need. A general launcher must not overwrite canonical host config and must support the
working directory needed by a caller-provisioned executable.

- Validate host and numeric inputs before filesystem, network, or spawn side effects.
- Bind/allocate on the configured interface, but connect to a reachable address:
  `0.0.0.0` maps to `127.0.0.1` and `::` maps to `::1` for HTTP checks.
- Warn that wildcard hosts can expose the unauthenticated server beyond loopback.
- A fixed port receives an HTTP occupancy probe plus an actual-interface bind test and never moves
  silently to another port.
- Automatic ports retain one retry for the unavoidable release/rebind collision race.
- Only `EADDRINUSE` means a port is occupied; invalid interfaces, permissions, and other bind errors
  preserve their original identity.

### Slots behavior verified against llama.cpp b9860

The pinned server behavior is:

- `/slots` is enabled by default;
- `--slots` explicitly enables it;
- `--no-slots` explicitly disables it;
- `/props` reports `total_slots`, `model_path`, and `endpoint_slots` independently of `/slots`
  exposure;
- `model_path` is the value passed through `-m`.

Sources:

- https://github.com/ggml-org/llama.cpp/blob/b9860/tools/server/README.md#L198-L201
- https://github.com/ggml-org/llama.cpp/blob/b9860/tools/server/server-context.cpp#L4142-L4169

The launch API therefore uses `slotsEndpoint: 'default' | 'enabled' | 'disabled'`. Default emits no
flag; enabled emits `--slots`; disabled emits `--no-slots`. A caller-owned slot path is never
deleted. A factory-created temporary slot path requires explicit enabled mode and is removed once
after stop, startup failure, or spontaneous child exit. Calibration passes enabled/temp options
explicitly to preserve its existing argv and cleanup behavior.

### Child ownership and failures

The runner retains the exact spawned `ChildProcess`; its PID is informational rather than the sole
ownership identity. Duplicate starts are rejected, concurrent stops share one outcome, owned cleanup
runs once, and exit observation settles after cleanup. A missing executable becomes one typed
failure rather than a later uncaught child `ENOENT`.

Historical runner detail codes remain under `ServerError.details.code`:
`CALIBRATION_SLOTS_UNAVAILABLE`, `CALIBRATION_CANDIDATE_CRASHED`,
`CALIBRATION_CLEANUP_FAILED`, and `CALIBRATION_ABORTED`. The top-level error code remains
`SERVER_ERROR`; launch documentation will explain the historical naming.

### Capacity and model identity

`fetchLlamaRuntimeCapacity()` remains general and may omit `totalSlots`. The successful runner
handle exposes a verified capacity type with required `totalSlots`. It also reports optional
`modelPath` from `/props.model_path`; callers can compare the returned exact string with their
requested absolute path before adopting or using an endpoint.

### Installation and package boundary

- Add only `genai-electron/llama-server-launch`; keep undeclared deep paths sealed.
- Keep the package ESM-only with `types`, `import`, and `default` export conditions and no `require`
  condition.
- Mark Electron as an optional peer for consumers, while adding exact Electron 43.2.0 as a
  repository development dependency so clean development installs still build and test the root.
- Prove the packed facade's runtime and declaration graphs before Electron is linked.

### Deliberate CommonJS consequence

The supported execution contract is native ESM import. TypeScript and similar CommonJS builds may
downlevel `await import('genai-electron/llama-server-launch')` to a deferred `require()` call.
`require.resolve()` proves only that the export resolves; it does not prove that emitted CommonJS
can execute this native ESM graph.

That downleveled path is outside the package contract and can fail on runtimes without synchronous
ESM loading or if the facade graph later gains top-level await. Palimpsest adoption must inspect its
built artifact and preserve native `import()` or use an ESM bridge. If neither works, adoption stops
for a separate decision about a real CommonJS artifact or an explicit minimum-runtime,
no-top-level-await `require(esm)` contract.

## Out of scope

- Making the package root Node-safe.
- Exporting a `dist/*` wildcard or private deep path.
- Changing manager lifecycle, singleton, storage, discovery, or provisioning behavior.
- Adding a CommonJS artifact, `require` condition, or synchronous ESM execution promise.
- Implementing the Palimpsest-side loader/adoption.
- Version bump, migration guide, tag, publication, release, or pull request.

## Acceptance criteria

- `genai-electron/llama-server-launch` is the only supported plain-Node entry needed to build
  canonical arguments, launch against caller-supplied paths, await health, inspect capacity, and
  stop the exact child.
- Importing the packed subpath succeeds under plain Node before Electron is installed or linked;
  its declarations also type-check in that state.
- CommonJS resolution selects the entry without claiming `require()` execution, and documentation
  states the downstream transpilation consequence explicitly.
- Existing `ModelInfo` and full `LlamaServerConfig` callers remain assignable; `ServerConfig` and
  `getConfig()` retain their existing fields.
- Default, enabled, and disabled slots modes produce the verified b9860 behavior; calibration's
  existing vector remains byte-identical through explicit options.
- Fixed ports fail before spawn when occupied and never retry on another port; auto ports retain the
  collision retry.
- Caller-owned directories are preserved, factory-owned directories are removed once, and lifecycle
  operations act on the exact spawned child.
- `/props` capacity remains mandatory for a successful handle, and optional `model_path` is exposed.
- Electron is an optional peer for plain-Node consumers and an explicit development dependency here.
- The root remains Electron-bound, undeclared paths remain sealed, and all repository verification
  gates pass.

## Release status

This work remains unreleased. Implementation does not authorize a version bump, migration guide,
tag, publication, release, or pull request. Palimpsest's emitted-loader validation is required before
a future release but is not an implementation blocker in this repository.

## Resolution

Implemented the approved Electron-free `genai-electron/llama-server-launch` facade, canonical
runtime config/argv types, exact-child launch handle, host/port/slots/capacity safety, optional
Electron peer metadata with an exact development pin, packed Node-only contract checks, tests, and
documentation. Independent runtime and package reviews found no remaining issue after two exit
observation bugs and two packed-smoke precision gaps were corrected. The complete repository gate
passed on 2026-08-18. The work remains unreleased under the repository release policy.
