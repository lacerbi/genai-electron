# Migrating from v0.23.0 to v0.24.0

v0.24.0 adds a supported Electron-free ESM entry for launching a caller-provisioned llama-server
binary and GGUF model. Existing Electron manager APIs remain compatible. Electron is now an
optional package peer so plain-Node consumers can install and use the Node-safe subpaths without
installing Electron.

Because genai-electron is pre-1.0, a dependency range such as `^0.23.0` does not admit v0.24.0.
Update the range or exact pin explicitly to adopt this release.

## What changed

The new entry is:

```typescript
import {
  buildLlamaServerArgs,
  startLlamaServerRunner,
} from 'genai-electron/llama-server-launch';
```

It exposes the canonical llama-server argument builder, direct launch factory, health and capacity
utilities, port helpers, relevant errors, and narrow runtime/handle types without evaluating the
Electron-backed package root.

The launch factory accepts absolute or caller-resolved executable and model paths. It resolves only
after health and strict `/props` capacity verification:

```typescript
const handle = await startLlamaServerRunner({
  binaryPath: '/opt/llama/bin/llama-server',
  model: { path: '/opt/models/model.gguf' },
  config: { host: '127.0.0.1', gpuLayers: 40 },
  contextSize: 8192,
  parallelRequests: 2,
  startupTimeoutMs: 120_000,
  port: 12_345,
  slotsEndpoint: 'disabled',
});

try {
  console.log(handle.pid, handle.capacity.totalSlots);
} finally {
  await handle.stop();
}
```

The handle owns the exact spawned child rather than only its numeric PID. Concurrent stops share
one outcome, public exit observation waits for factory-owned cleanup, and nonterminal child errors
do not falsely report process death. The optional `signal` cancels startup only; after the factory
returns, call `stop()` explicitly.

## Ports, hosts, and slots

- A fixed port is checked for HTTP occupancy and TCP bindability before spawn and is attempted only
  once. Omit `port` to allocate automatically and retain one proven bind-collision retry.
- Bind checks use the configured interface. HTTP probes map `0.0.0.0` to `127.0.0.1` and `::` to
  `::1`. Wildcard binds may expose the unauthenticated server beyond loopback and require deliberate
  firewall/network controls.
- Omitted `slotsEndpoint` preserves llama-server's default; `'enabled'` emits `--slots`, and
  `'disabled'` emits `--no-slots`.
- `slotSavePath` is caller-owned and never removed. `temporarySlotSavePath: true` requires enabled
  slots and creates factory-owned state that is removed after failure, exit, or stop.
- `/props.total_slots` and exact per-slot context remain mandatory in every slots mode.
- `capacity.modelPath`, when present, reports llama-server's exact `model_path`; adopt-first callers
  should compare it with their requested absolute model path.

## Electron installation

Applications importing from `genai-electron` still require a compatible Electron host and must use
manager operations after Electron is ready. Electron remains declared at `>=25.0.0`, but the peer is
optional at installation time so consumers using only these subpaths need not install it:

- `genai-electron/llama-server-launch`
- `genai-electron/llm-calibration-policy`

The repository's exact Electron 43.2.0 development dependency is for reproducible package builds,
tests, and root declaration validation. It does not change the consumer range.

## Native ESM and CommonJS hosts

The launch entry supports native ESM. `require.resolve()` can locate it but does not promise that
`require()` can execute it. TypeScript and bundlers targeting CommonJS may rewrite
`await import('genai-electron/llama-server-launch')` to a deferred `require()` call. That output is
unsupported.

Before adopting from a CommonJS host, inspect the emitted artifact and either preserve native
dynamic `import()` or call the entry through an ESM bridge. If neither is possible, remain on the
existing integration and open a separate compatibility decision rather than relying on incidental
runtime support for requiring ESM.

## Compatibility

- Existing root imports, singleton managers, `ServerConfig`, `LlamaServerConfig`, `getConfig()`,
  storage, binary provisioning, and persisted data remain compatible.
- Existing full `ModelInfo` and `LlamaServerConfig` values remain structurally usable by the
  canonical builder's narrower runtime views.
- The package stays ESM-only and undeclared `dist/*` paths remain sealed.
- Calibration uses explicit slots/temp-directory options to retain its previous argument vector and
  cleanup behavior.
- The `::` wildcard health target changes from IPv4 loopback to family-correct `::1`.

## Consumer action

1. Update the dependency to v0.24.0 or a compatible range beginning at v0.24.0.
2. Existing Electron applications may continue using the package root without source changes.
3. Plain-Node launch consumers must import the dedicated subpath and provide their own executable
   and absolute GGUF paths.
4. Decide explicitly whether `/slots` should remain at the server default, be enabled, or be
   disabled.
5. For fixed ports, handle `PortInUseError`; for launch/capacity failures, branch on the documented
   typed error/detail codes.
6. CommonJS consumers must verify that their built artifact preserves native dynamic import or uses
   an ESM bridge.

## Verification and rollback

Verify the emitted argument vector, returned capacity/model path, selected bind exposure, and
confirmed cleanup in the target host. Do not use a wildcard host unless remote accessibility is
intentional and protected.

If adoption cannot preserve native ESM loading or the host cannot meet the direct launch contract,
pin v0.23.0 and continue using the Electron-backed managers or an existing external launcher. No
persisted data migration is required when rolling back.

## Checklist

- [ ] Update the dependency to v0.24.0.
- [ ] Use only declared package entries; remove any private `dist/*` imports.
- [ ] Provide caller-owned binary and model paths for direct launch.
- [ ] Confirm host exposure, port policy, and slots mode.
- [ ] Preserve native ESM loading from CommonJS builds.
- [ ] Exercise startup, capacity verification, spontaneous exit, and explicit stop in the packaged
      application.
