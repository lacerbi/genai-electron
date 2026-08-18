# Plan: Node-Safe llama-server Launch Entry

Created: 2026-08-18
Status: COMPLETE (2026-08-18)
Repository: genai-electron (sister repo; the consumer lives in palimpsest-engine)
Source issue: `docs/dev/issues/ISSUE-node-safe-server-launch.md`

## Summary

Add `genai-electron/llama-server-launch`, a narrow Electron-free subpath following the v0.22.0
`./llm-calibration-policy` precedent. Plain-Node tooling will be able to build the canonical
llama-server argument vector, adopt or launch against a caller-supplied binary and model path,
health-poll the process, inspect `/props`, and stop the exact spawned child without loading the
Electron-bound package root.

The implementation keeps the existing public `ServerConfig` contract intact. It introduces a
launch-only config view derived from `LlamaServerConfig`, makes host/port/cwd and slots behavior
explicit, preserves calibration behavior through explicit calibration options, hardens spawn and
teardown behavior for a long-lived public handle, and keeps native ESM loading semantics unchanged.
Electron becomes optional for package consumers but remains an explicit development dependency so
clean repository installs can still build and type-check.

The work lands on a branch, unreleased. No version bump, tag, publication, or pull request.

## Scope

**In scope**: the new facade and `exports` declaration; a `Pick`-based
`LlamaServerRuntimeConfig` that does not alter `ServerConfig`; a path-only model input; named
argument-builder options; `/props.model_path` reporting; caller-controlled cwd, bind host, slots
mode, slot-save policy, and fixed port; fixed-port occupancy safety; a factory-created public
runner handle with guarded lifecycle; family-correct wildcard health normalization; containment of
asynchronous spawn errors; Electron optional-peer metadata plus an Electron development dependency;
golden-vector, behavior, public-type, and packed-package tests; documentation, `PROGRESS.md`, and
issue/plan archival.

Caller-controlled bind hosts and `cwd` deliberately expand the motivating issue, whose immediate
consumer accepted forced loopback. They are retained from the prior design discussion because this
is a general launch facade rather than another calibration-only entry: it must not silently
overwrite a canonical runtime host, must probe the address family on which it launches, and must
allow a caller-provisioned executable to receive its required working directory. Approval of this
plan approves that bounded expansion; neither option changes manager lifecycle or storage behavior.

**Out of scope**: changing `ServerConfig`, `LlamaServerManager.getConfig()`, or the package-root
value/type export surface; a CommonJS build or synchronous `require()` contract; `LlamaServerManager`
lifecycle, singletons, or status model; any deep-path `exports` exception; model discovery,
storage roots, or binary provisioning; palimpsest-side adoption; version bump, tag, publish,
release notes, migration guide, or PR.

## Settled upstream contract: llama.cpp b9860

The pinned source and generated server documentation settle the slots questions without a
GPU-heavy discovery launch:

- `/slots` is enabled by default;
- `--slots` explicitly enables it and `--no-slots` explicitly disables it;
- `GET /props` always reports `total_slots`, `model_path`, and `endpoint_slots`, independently of
  whether the `/slots` endpoint is exposed;
- `model_path` is the path supplied through `-m`.

Authoritative references:

- `https://github.com/ggml-org/llama.cpp/blob/b9860/tools/server/README.md#L198-L201`
- `https://github.com/ggml-org/llama.cpp/blob/b9860/tools/server/server-context.cpp#L4142-L4169`

Record those facts in the issue with links to the pinned b9860 source. If a provisioned b9860
binary is already available during implementation, `--version` and `--help` may be used as a cheap
sanity check, but absence of a local binary or GGUF does not block the source/API work and no model
launch is required for this phase.

Consequences for the API:

- slots selection is tri-state: `'default' | 'enabled' | 'disabled'`;
- `'default'` emits no slots flag and preserves the manager's production vector;
- `'enabled'` emits `--slots`;
- `'disabled'` emits `--no-slots`;
- capacity verification remains hard when `/slots` is disabled because b9860 still reports
  `total_slots` through `/props`.

## Phases

## Implementation tracking

- [x] Phase 0: settle the issue record.
- [x] Phase 1: implement launch-only config and argument contracts.
- [x] Phase 2: implement the safe runner, lifecycle, ports, slots, and capacity behavior.
- [x] Phase 3: add the Electron-free facade and package metadata.
- [x] Phase 4: add and update focused tests.
- [x] Phase 5: extend the packed-package contract.
- [x] Phase 6: update documentation, progress, and archival records.
- [x] Run the complete verification gate and independently double-check the implementation.

### Phase 0: Settle the issue record

**Goal**: make the durable issue describe the approved design and the verified b9860 contract
before implementation diverges from the original proposal.

**Work**:

- Add the pinned b9860 findings above and replace the proposal's boolean slots assumption with the
  tri-state design.
- Record that `fetchLlamaRuntimeCapacity()` currently does not expose model identity and that the
  implementation will read the top-level `model_path` field.
- Record the deliberate host/cwd scope expansion and its boundary, fixed-port occupancy checking,
  family-correct connect hosts, factory-owned temporary slot state, exact-child ownership, numeric
  validation, spawn-error containment, and the public handle/lifecycle decision.
- Correct the error-code description: `ServerError.code` is `'SERVER_ERROR'`; historical
  `CALIBRATION_*` identifiers live under `details.code`, and some existing messages also say
  “calibration.”
- Record the install-time decision: Electron is an optional peer for consumers and a development
  dependency for this repository.
- Record the loader boundary: the subpath supports native ESM import, while CommonJS output that
  downlevels `import()` to `require()` is outside this package contract and must be handled during
  downstream adoption rather than inferred from `require.resolve()` success.
- Keep the issue status as a proposal until the user approves this plan; mark it resolved only
  when implementation and verification complete.

**Verification**:

- [x] The issue contains no stale claim that omitting `--slots` disables the endpoint.
- [x] The issue distinguishes runtime Electron-freedom from repository development dependencies.
- [x] Every acceptance criterion matches the source design below.

### Phase 1: Define the narrow argument and config contracts

**Goal**: make the canonical argument builder callable from plain Node without changing existing
root API types.

#### 1a. Launch-only config view

In `src/types/servers.ts`, add:

- `LlamaServerRuntimeConfig`, defined as a `Pick<LlamaServerConfig, ...>` over exactly the fields
  consumed by `buildLlamaServerArgs`: `host`, `threads`, `contextSize`, `gpuLayers`,
  `parallelRequests`, `flashAttention`, `fit`, `cacheTypeK`, `cacheTypeV`, `swaFull`,
  `overrideTensors`, `cacheRam`, `cpuMoe`, `nCpuMoe`, `reasoningFormat`, `modelAlias`, `batchSize`,
  `continuousBatching`, `useMmap`, `useMlock`, and `jinja`.
- `LlamaServerRunnerConfig = Omit<LlamaServerRuntimeConfig, 'contextSize' | 'parallelRequests' |
  'fit'>`. The factory supplies the first two as required top-level fields and always fixes
  `fit: 'off'`, so accepting duplicates inside `config` would create silent precedence conflicts.
- `ResolvedLlamaServerRunnerConfig = LlamaServerRunnerConfig & { port: number; contextSize: number;
  parallelRequests: number; fit: 'off' }`, representing the factory's stronger resolved
  postcondition without making those builder fields globally required.
- Re-export these types from `src/types/index.ts` for internal aggregation and from the new facade
  only. Do not add them to `src/index.ts`; the package-root surface stays unchanged.

Do not move or redeclare fields on `ServerConfig` or `LlamaServerConfig`. This preserves the public
return type of `ServerManager.getConfig()`, `SavedLLMState`, the example control panel, and external
consumers.

In `src/process/llama-server-args.ts`:

- keep the existing `ResolvedLlamaServerConfig = LlamaServerConfig & { port: number }` alias for
  manager internals, which rely on `modelId`, `startupTimeout`, and `healthCheckInterval`;
- add `ResolvedLlamaServerRuntimeConfig = LlamaServerRuntimeConfig & { port: number }` for the
  canonical builder and launch handle;
- narrow the generic constraint of `normalizeLlamaVCacheConfig()` to partial launch/runtime config
  while preserving its input type `T` on return and keeping full `LlamaServerConfig` callers
  assignable;
- define and export `LlamaModelFile` as `{ path: string }`;
- narrow `buildLlamaServerArgs()` from `ModelInfo` to `LlamaModelFile` and its config parameter to
  `ResolvedLlamaServerRuntimeConfig`.

Existing variable-based callers remain structurally assignable. Two manager calibration/baseline
call sites pass inline object literals containing the now-unused `modelId`; remove that literal
property so TypeScript's excess-property check succeeds. Do not change the manager's stored config
or public input types.

#### 1b. Named slots/argument options

Replace the anonymous third-parameter type with:

- `LlamaSlotsEndpointMode = 'default' | 'enabled' | 'disabled'`;
- `LlamaServerArgsOptions`, containing `slotsEndpoint?: LlamaSlotsEndpointMode` and
  `slotSavePath?: string`.

Argument behavior is exact:

- omitted or `'default'` → no slots flag;
- `'enabled'` → `--slots`;
- `'disabled'` → `--no-slots`;
- `slotSavePath` → `--slot-save-path <path>`;
- `'disabled'` plus `slotSavePath` → reject with `ServerError` before returning argv because the
  endpoint required to operate on saved slot state is unavailable.

Calibration always passes `'enabled'` explicitly. The plain launch default stays byte-equal to the
manager's production builder call; a consumer that wants the endpoint hidden opts into
`'disabled'`, producing the single intentional `--no-slots` delta.

**Verification**:

- [x] Existing variable-based `ModelInfo` and `LlamaServerConfig` callers compile unchanged; only
  the two identified internal inline literals drop unused `modelId`.
- [x] `ServerConfig` and `getConfig()` retain all existing declared fields.
- [x] The three slots modes produce distinct, documented argv behavior.

### Phase 2: Make the runner safe for launch use

**Goal**: support a one-shot plain-Node launcher without publishing calibration constructors or
test seams as application API.

#### 2a. Public factory options and handle

In `src/process/llama-server-runner.ts`, define a public factory contract separate from the
internal constructor/test contract:

- `StartLlamaServerRunnerOptions` contains `binaryPath`, `model: LlamaModelFile`,
  `config: LlamaServerRunnerConfig`, `contextSize`, `parallelRequests`, `startupTimeoutMs`, optional
  `port`, `cwd`, `signal`, `stderrMaxBytes`, `slotsEndpoint`, `slotSavePath`, and
  `temporarySlotSavePath`.
- `LlamaServerHandle` exposes the supported post-start result: required `port`, `args`,
  `config: ResolvedLlamaServerRunnerConfig`, `capacity: VerifiedLlamaRuntimeCapacity`, `loadTimeMs`,
  and `pid`, plus stdout/stderr tails, `exitPromise`, `raceWithExit()`, and `stop()`. The concrete
  runner may use private optional backing state while starting and expose required getters that
  assert the post-start invariant, but the factory must validate and return the stronger handle only
  after spawn, health, child liveness, and mandatory `/props` capacity verification succeed.
- `startLlamaServerRunner()` returns `Promise<LlamaServerHandle>`.

Keep `LlamaServerRunner`, its constructor options, `RunnerProcessManager`, and
`slotSaveDirectoryRemover` internal to the source module/tests and omit them from the new facade.
The concrete class implements the public handle. Preserve process-manager and directory-remover
injection for source-level unit tests through an implementation-only options intersection or
non-facade helper; the exported overload and emitted public declaration accept only
`StartLlamaServerRunnerOptions`. Narrow the internal constructor's model/config fields to
`LlamaModelFile` and `LlamaServerRunnerConfig` as well; calibration callers remain structurally
assignable after the overridden fields are passed only through their top-level options, and no
registry identity is fabricated.

Add a runner state guard (`new` → `starting` → `running` → `stopping`/`stopped`). Reject duplicate
or concurrent `start()` calls and starting after stop, so even an internal or untyped JavaScript
caller cannot orphan an earlier child by overwriting `_pid`.

Coalesce all `stop()` calls through one stored promise. Cleanup of factory-owned state occurs once.
After teardown confirms that the exact child is dead, settle `exitPromise` even if a mocked or
platform-specific child never delivered its exit callback; use the existing `{ code: null, signal:
null }` shape for that synthetic confirmed-stop record. Concurrent stops receive the same success or
typed cleanup failure.

Define `signal` as startup-scoped cancellation: a pre-aborted signal or an abort while the factory is
starting cancels startup and triggers confirmed teardown, but aborting it after the handle has been
returned does not stop a successfully launched server. The caller owns the returned handle and must
call `stop()` explicitly. Calibration retains its surrounding `finally` teardown.

Unexpected child exit/error must also start the same once-only owned cleanup automatically; callers
must not need to call `stop()` merely to remove a factory-created slot directory. Make public
`exitPromise` wait for that cleanup. It resolves with the observed exit after successful cleanup and
rejects with the existing typed cleanup failure if removal fails; a later/concurrent `stop()` awaits
the same recorded outcome.

#### 2b. Input validation, child identity, host, cwd, and fixed-port behavior

- Stop injecting `host: '127.0.0.1'` into the emitted config. An omitted host preserves the
  manager's production vector.
- Compute `bindHost = config.host ?? '127.0.0.1'` for port allocation and TCP bind tests. Compute a
  separate `connectHost` for HTTP occupancy, `waitForHealthy()`, and
  `fetchLlamaRuntimeCapacity()`: omitted host and `0.0.0.0` map to `127.0.0.1`, `::` maps to `::1`,
  and specific IPv4, IPv6, and hostname values remain unchanged. Update `normalizeHealthHost()` to
  preserve that address-family rule and pin the intentional correction of its prior `::` →
  `127.0.0.1` behavior in unit tests and documentation.
- Pass `cwd` through to `SpawnOptions.cwd` without changing the default process cwd when omitted.
- Construct the runner's resolved config only from its runtime fields plus top-level context,
  parallelism, port, and fixed `fit: 'off'`; do not add unused manager lifecycle fields merely to
  satisfy the old full config alias.
- Before directory creation, network access, or spawn, validate `contextSize`, `parallelRequests`,
  and `startupTimeoutMs` as positive safe integers; validate `stderrMaxBytes`, when supplied, the
  same way; validate explicit ports as safe integers in `1..65535`; and reject an empty,
  whitespace-only, or surrounding-whitespace `config.host` instead of emitting one bind address and
  probing another.
- Retain `SpawnResult.process` and make child exit/error events plus that exact `ChildProcess`
  instance the ownership identity. Post-health liveness and teardown must not rely only on a
  globally reusable numeric PID. Implement child-aware liveness/termination behind the runner's
  source-private seam rather than adding methods to the root-exported `ProcessManager`; its existing
  PID API and declaration surface remain compatible, and `pid` on the handle is informational.
- In `ProcessManager.spawn()`, register the child `error` listener before inspecting a possibly
  absent PID or taking any path that throws. A nonexistent executable must become one typed runner
  failure and must not later emit an uncaught `ENOENT` that terminates the Node host.
- Refine `isPortBindable()` so only `EADDRINUSE` resolves `false`; reject with the original error for
  `EADDRNOTAVAIL`, `EACCES`, name-resolution failures, and other bind errors. The factory translates
  only the `false` result into `PortInUseError`, preserving invalid-interface and permission errors
  rather than misreporting them as occupancy. Keep the function signature unchanged and document
  the corrected rejection behavior for existing root consumers.

When `port` is supplied:

1. probe for an HTTP occupant through the connect host;
2. bind-test the port on the actual bind host to catch non-HTTP or interface-specific occupants;
3. throw `PortInUseError` before spawning if either check shows occupancy;
4. perform one start attempt only; and
5. after health succeeds, require that the same spawned child is still alive before accepting
   `/props`.

When `port` is omitted, call `findFreePort(bindHost)` and retain the existing single bind-collision
retry because the release/rebind race is unavoidable. Do not allocate an IPv4-loopback port and
then launch on a different caller-selected interface.

#### 2c. Slots and slot-save ownership

The public options have deterministic ownership semantics:

- `slotsEndpoint` defaults to `'default'` and creates no directory;
- `'disabled'` emits `--no-slots` and cannot be combined with `slotSavePath` or
  `temporarySlotSavePath`;
- a caller-supplied `slotSavePath` is emitted but never removed by the library;
- `temporarySlotSavePath: true` requires `slotsEndpoint: 'enabled'`, rejects a simultaneous
  caller path, creates one `mkdtemp` directory, and makes the runner responsible for removing it
  after confirmed teardown;
- calibration passes `slotsEndpoint: 'enabled'` and `temporarySlotSavePath: true`, reproducing its
  current `--slots --slot-save-path <temp>` vector and cleanup guarantee.

If construction or startup fails after a temporary directory is created—including a pre-aborted
signal or argument-normalization error—the factory must still remove its owned directory. A
cleanup failure remains fatal and retains the existing typed details.

#### 2d. Capacity and model identity

In `src/process/llama-props.ts`:

- add optional `modelPath?: string` to `LlamaRuntimeCapacity`;
- add `VerifiedLlamaRuntimeCapacity = LlamaRuntimeCapacity & { totalSlots: number }` for the
  runner handle's post-verification result, without changing the more general fetcher's return type;
- read it from the top-level `/props.model_path` field;
- leave it `undefined` when absent or not a string without weakening existing capacity validation.

The runner continues to hard-require `total_slots` and the exact expected per-slot context. The
subpath documents that b9860 returns `model_path` exactly as supplied via `-m`; callers can compare
it with their requested absolute path before using an adopted or freshly launched endpoint.

#### 2e. Calibration call sites

Update `llama-calibration-probe.ts` to pass `slotsEndpoint: 'enabled'` and
`temporarySlotSavePath: true`. Derive `config` by omitting `contextSize`, `parallelRequests`, and
`fit` from `options.resolvedConfig`, add `host: '127.0.0.1'` explicitly, and pass context and
parallelism through their top-level options; do not fabricate `modelId`. This preserves the exact
calibration argv after removing the runner's host override and stays aligned with the calibration
client's fixed loopback URL. Update `llama-calibration-client.ts` and probe-local variables to depend on
`LlamaServerHandle` rather than the concrete class where possible. Update runner test fixtures to
use the path-only model/runtime config shapes while retaining full-model assignability coverage in
the argument tests.

Calibration argv, hard capacity checks, abort behavior, and confirmed teardown remain unchanged.

**Verification**:

- [x] The default factory vector matches the production builder vector for the same runtime config.
- [x] Explicit slots disablement adds only `--no-slots` relative to that vector.
- [x] Explicit hosts use the actual interface for bind tests and a reachable normalized host for
  HTTP occupancy, health, and `/props`.
- [x] Caller directories are preserved; only factory-created directories are removed.
- [x] Repeated/concurrent starts cannot spawn an unmanaged second child.
- [x] Concurrent stops share one result, settle public exit observation, and clean up once.
- [x] A nonexistent executable rejects as a typed error without an uncaught child-process event.

### Phase 3: Add the Electron-free facade and package metadata

**Goal**: expose only the supported launch workflow and make installation genuinely Electron-free
for plain-Node consumers without breaking repository development.

#### 3a. Facade

Add `src/llama-server-launch.ts` with a module doc comment and explicit value/type re-exports.
Because `isolatedModules` is enabled, use `export type` for every type-only export.

Values:

- `buildLlamaServerArgs`, `normalizeLlamaVCacheConfig`;
- `startLlamaServerRunner`;
- `waitForHealthy`, `checkHealth`, `isServerResponding`, `normalizeHealthHost`, `formatHttpHost`;
- `fetchLlamaRuntimeCapacity`;
- `findFreePort`, `isPortBindable`;
- `GenaiElectronError`, `ServerError`, `ContextConstraintError`, `PortInUseError`.

Types:

- `LlamaModelFile`, `LlamaServerRuntimeConfig`, `LlamaServerRunnerConfig`,
  `ResolvedLlamaServerRuntimeConfig`, `ResolvedLlamaServerRunnerConfig`;
- `LlamaSlotsEndpointMode`, `LlamaServerArgsOptions`;
- `StartLlamaServerRunnerOptions`, `LlamaServerHandle`, `LlamaServerExit`;
- `LlamaRuntimeCapacity`, `VerifiedLlamaRuntimeCapacity`, `HealthCheckResponse`;
- `LlamaServerConfig`, `KVCacheType`, and `FlashAttentionSetting`.

Do not export the concrete runner class, constructor options, process-manager seam, `SpawnOptions`,
or `SpawnResult` from this subpath.

#### 3b. Package metadata

In `package.json`:

- add `./llama-server-launch` with the same `types` / `import` / `default` conditions as
  `./llm-calibration-policy`;
- keep the package ESM-only and do not add a `require` condition;
- mark the existing Electron peer optional with
  `peerDependenciesMeta: { electron: { optional: true } }`;
- add exact `electron: "43.2.0"` to `devDependencies`, matching the version already resolved in the
  current lock, so `npm ci`, TypeScript, tests, and the packed type consumer still have Electron's
  runtime declarations available in this repository. Keep the consumer peer range at `>=25.0.0`;
  future development-runtime upgrades are separate deliberate maintenance.

Update `package-lock.json` with `npm install --package-lock-only`. Confirm the root package record
contains both the optional peer metadata and the development dependency, and that the lock remains
`npm ci` compatible.

Add JSDoc examples for every new public type and option. Examples must use absolute binary/model
paths, normalized loopback behavior, and explicit `slotsEndpoint: 'disabled'` when demonstrating a
fixed-port CLI launcher. Host-option JSDoc must warn that `0.0.0.0` and `::` can expose the
unauthenticated server beyond loopback and should be used only with deliberate network controls.

**Verification**:

- [x] `npm run build` succeeds from the updated dependency/type graph.
- [x] The root import remains Electron-bound.
- [x] The facade graph has no Electron runtime import.
- [x] Package metadata distinguishes optional consumer peer behavior from the repository's dev dependency.

### Phase 4: Tests

**Goal**: pin parity, safety behavior, type compatibility, and ownership rules at their actual call
sites.

#### Argument tests

Add `tests/unit/llama-server-args.test.ts`:

- golden production vector with default slots mode;
- golden calibration vector with explicit slots and a save path;
- runner-default vector asserted equal to the production vector;
- disabled-slots vector asserted equal except for `--no-slots`;
- all three slots modes and invalid disabled-plus-save-path combination;
- bare `{ path }` model input;
- quantized-V/flash-attention normalization and failure.

Pin `LlamaServerManager.start()` to calling the builder without launch-only options, or route the
manager fixture and runner fixture through one golden comparison so later manager call-site drift
cannot leave the builder unit test green.

#### Runner tests

Extend `tests/unit/llama-server-runner.test.ts`:

- calibration's explicit options reproduce today's argv and owned-temp cleanup;
- launch defaults emit no host or slots flag and allocate no directory;
- disabled slots emit `--no-slots` while `/props.total_slots` and per-slot context remain mandatory;
- cwd reaches `SpawnOptions.cwd`;
- `::1`, wildcard, and omitted hosts reach the expected health and `/props` URLs, while bind tests
  receive the actual configured interface;
- occupied fixed ports throw `PortInUseError` before spawn and never retry;
- free fixed ports use exactly one attempt;
- auto ports are selected on the actual bind host and retain the existing bind-collision retry;
- invalid context size, parallelism, startup timeout, stderr limit, and explicit ports reject before
  any directory, network, or spawn side effect;
- post-health liveness belongs to the exact spawned child rather than only its numeric PID;
- caller-supplied slot directories are not removed;
- factory-created slot directories are removed on normal stop, startup failure, pre-abort, and
  constructor/normalization failure;
- incompatible slot option combinations reject before spawn;
- duplicate, concurrent, and post-stop starts reject without an extra spawn;
- concurrent stops share one promise/result, settle `exitPromise` on the no-exit-callback fallback,
  and remove owned state exactly once;
- abort during startup stops and cleans up, while abort after the factory returns leaves the child
  running until explicit `stop()`;
- spontaneous exit/error triggers once-only owned cleanup without a required follow-up `stop()`, and
  cleanup failure rejects `exitPromise` and the shared stop outcome consistently;
- empty or whitespace-padded hosts reject before side effects, and non-occupancy bind failures keep
  their original error identity rather than becoming `PortInUseError`.

Add `tests/unit/process-manager.test.ts` with a real platform-neutral nonexistent-executable case.
Assert that spawn/runner failure remains typed and that the child `ENOENT` is consumed rather than
surfacing as `uncaughtException`. Also cover the listener-registration order for the missing-PID
path.

Extend `tests/unit/health-check.test.ts` to pin the family-correct wildcard mapping (`0.0.0.0` →
`127.0.0.1`, `::` → `::1`) and IPv6 URL formatting.

Extend `tests/unit/port-utils.test.ts` to prove `EADDRINUSE` is the sole `false` result and other bind
errors reject without losing their original code.

Update `llama-calibration-probe.test.ts` to assert the explicit calibration options passed to the
factory. Re-run the broader calibration suites that mock the factory.

#### Props and public-type tests

Extend the existing `tests/unit/llama-props.test.ts`—not the runner suite—for `model_path` parsing,
including absent and non-string values.

Extend `tests/unit/public-types.test.ts` to prove:

- full `LlamaServerConfig` is assignable to `LlamaServerRuntimeConfig`;
- runtime config does not require `modelId` or manager lifecycle fields;
- runner config rejects nested `contextSize`, `parallelRequests`, and `fit` so top-level factory
  precedence cannot be ambiguous;
- `ServerConfig` still declares `host`, `threads`, `contextSize`, `gpuLayers`,
  `parallelRequests`, and `flashAttention`;
- `OptimalConfigHints` remains intact;
- the public factory returns `LlamaServerHandle` and does not require concrete runner/test-seam
  types;
- `capacity`, `capacity.totalSlots`, resolved context/parallelism/fit, `loadTimeMs`, and `pid` are
  required on the returned post-start handle;
- manager code continues to use the full `ResolvedLlamaServerConfig`, while builder/handle code uses
  `ResolvedLlamaServerRuntimeConfig`.

**Verification**:

- [x] Two new test suites are added; the existing runner, health, props, calibration-probe, and
  public-type suites expand.
- [x] Deliberately changing one builder flag fails a golden test, then the change is reverted.
- [x] The example control panel still type-checks against the unchanged `getConfig()` contract.

### Phase 5: Packed-package contract

**Goal**: prove the published tarball exposes a genuinely Electron-free ESM subpath while keeping
the package boundary sealed.

Extend `scripts/packed-api/run.mjs`:

- before Electron is linked, dynamically import `genai-electron/llama-server-launch` under plain
  Node and assert a representative canonical vector;
- use `require.resolve()` to verify the subpath selects `dist/llama-server-launch.js` without
  promising synchronous ESM execution;
- do not call `require()` on the ESM entry and do not introduce a no-top-level-await compatibility
  promise;
- retain negative `ERR_PACKAGE_PATH_NOT_EXPORTED` assertions for undeclared `dist/` paths;
- assert the packed manifest marks Electron as an optional peer;
- assert the tarball does not contain or bundle Electron;
- before Electron is linked, link only the repository's `@types/node` and its declaration
  dependencies and run a facade-only TypeScript consumer that imports and exercises the supported
  launch types, required post-start handle fields, and factory signature;
- only after that Node-only type smoke passes, link Electron and retain the existing root-package
  TypeScript consumer for the Electron-bound declarations.

The illustrative call must compile with every required field and must use a platform-neutral model
path in the argv assertion. The runtime smoke does not spawn a real server.

Record the deliberate downstream consequence beside the packed checks: TypeScript and other tools
targeting CommonJS may compile `await import('genai-electron/llama-server-launch')` to a deferred
`require('genai-electron/llama-server-launch')`. That emitted path is not covered by the native ESM
smoke or by `require.resolve()`, is not promised by this package, and can fail on runtimes without
synchronous ESM loading or if this facade's graph ever gains top-level await. Palimpsest's adoption
must therefore inspect its built CommonJS artifact and either preserve native `import()` or call the
subpath through an ESM bridge. If neither is feasible, stop adoption and open a separate compatibility
decision: provide a real CommonJS artifact/`require` condition, or deliberately promise and test a
minimum-runtime, no-top-level-await `require(esm)` contract. Do not discover or silently choose that
contract during implementation of this plan.

**Verification**:

- [x] `npm run test:packed-api` passes.
- [x] The runtime import occurs before Electron is linked.
- [x] The facade-only declaration consumer type-checks before Electron is linked.
- [x] CommonJS resolution is checked without claiming CommonJS execution.
- [x] The packed-test comments state that CommonJS-transpiled `import()` execution is deliberately
  untested and unsupported, rather than implying that `require.resolve()` proves it.
- [x] Optional-peer metadata is asserted from the packed manifest.

### Phase 6: Documentation, progress, archival, and full gate

#### Documentation

- `README.md`: add the plain-Node launch subpath, distinguish root requirements from optional
  subpath installation, amend “all other functionality is Electron-specific,” and state that the
  supported execution contract is native ESM rather than CommonJS-downleveled `import()`.
- `genai-electron-docs/installation-and-setup.md` and `DESIGN.md`: explain that Electron is a
  required host for root runtime APIs, an optional peer for Node-safe subpaths, and a repository
  development dependency.
- `docs/SETUP.md`: replace the stale claim that root development installs omit Electron and remove
  the `electron@latest` workaround in favor of the exact repository development dependency.
- `genai-electron-docs/index.md`: add the Node-safe launch entry to navigation and qualify the
  Electron-only overview without changing the 0.23 version banner before release.
- `genai-electron-docs/llm-server.md`: document facade imports, parity rules, fixed-port occupancy,
  normalized hosts, slots tri-state, slot-directory ownership, capacity checks, model-path
  comparison, startup-only abort semantics, and the returned handle. Warn that `0.0.0.0` and `::`
  expose the unauthenticated server beyond loopback unless the host application supplies appropriate
  network controls. State that the supported loader is native ESM and that `require.resolve()` is
  not evidence that a CommonJS-transpiled dynamic import can execute.
- `genai-electron-docs/integration-guide.md`: add the CommonJS-host integration boundary next to its
  Electron main/preload guidance. A CommonJS build must preserve native `import()` or use an ESM
  bridge for this subpath; ordinary TypeScript downleveling to `require()` is unsupported.
- `genai-electron-docs/troubleshooting.md`: document launch exposure of historical
  `CALIBRATION_*` detail codes/messages, `PortInUseError`, invalid ports, capacity failures, and
  slot-option conflicts.
- `genai-electron-docs/typescript-reference.md`: add the launch types and import examples without
  changing `ServerConfig`.
- `AGENTS.md`: qualify the Electron-specific project overview and list all declared package entry
  points under Key Exports.
- `PROGRESS.md`: add an `## Unreleased:` entry with Validation, Migration, and Release status
  paragraphs.

No new user-facing document is created: the launch surface belongs in the existing LLM server,
integration, installation, troubleshooting, and TypeScript references. The archived issue owns
rationale and the archived plan owns the execution design.

At completion, move the issue to `docs/dev/issues/` with a Resolution section, change this plan's
status from `PENDING APPROVAL` to `COMPLETE` with its completion date, and move the plan to
`docs/dev/plans/`. Both files are currently untracked, so move them with the filesystem and stage
them by explicit name rather than using `git mv`.

Defer `migration-0-23-to-0-24.md`, documentation index versioning, and release version strings to
explicit release preparation.

#### Full gate

Run in this order:

```text
npm run format          # inspect the resulting diff
npm ci --dry-run --ignore-scripts
npm run build
npm run lint
npm run format:check
npm test
npm run test:packed-api
npm run audit:embedded
npm audit --omit=dev --audit-level=high
npm pack --dry-run
npm --prefix examples/electron-control-panel run build
git diff --check
```

Record actual test counts, the packed file count/tarball size, and every command result in
`PROGRESS.md`. Markdown is ignored by Prettier, so inspect every changed Markdown file directly.

**Verification**:

- [x] Every gate passes and the example build proves `getConfig()` compatibility.
- [x] The archived issue and plan exist and are staged by name.
- [x] `PROGRESS.md` contains Validation, Migration, and Release status.
- [x] One implementation commit is prepared only after `git diff --cached --stat` review.
- [x] No version bump, tag, publication, or PR occurs.

## Documentation ownership

`README.md`, `genai-electron-docs/index.md`, `llm-server.md`, `integration-guide.md`,
`troubleshooting.md`, `typescript-reference.md`, and `installation-and-setup.md` own the user-facing
surface.
`docs/SETUP.md` owns repository development setup. `DESIGN.md` owns the dependency/entry-point
architecture. `AGENTS.md` owns the orientation pointer.
`PROGRESS.md` owns the unreleased change record. The archived issue owns the durable rationale and
pinned b9860 facts; the archived plan owns the implementation design and verification record.

## Decisions

- **Keep `ServerConfig` unchanged.** `LlamaServerRuntimeConfig` is a `Pick` view of
  `LlamaServerConfig`, preserving public `getConfig()` types and the example app. Rejected: slimming
  `ServerConfig`; it is architecturally tidy but creates an unrelated public type break.
- **Use a factory and public handle, not a public concrete runner.** This supplies launch/stop/crash
  observation without publishing constructor and process-manager test seams. Rejected: exporting
  `LlamaServerRunner`; it enlarges the stable API and exposes unsafe lifecycle methods that require
  more compatibility support.
- **Make the returned handle a post-start contract.** Required capacity, load time, and PID reflect
  what the factory has already verified. Rejected: optional public fields inherited from the
  runner's pre-start implementation state; callers should not re-check impossible factory outcomes.
- **Keep ESM-only execution semantics.** The packed contract uses dynamic import and
  `require.resolve()`. A CommonJS build that downlevels `import()` to `require()` is explicitly
  outside the contract; Palimpsest must preserve native import or use an ESM bridge, and its built
  loader must be checked during downstream adoption. Rejected: testing synchronous `require(esm)`;
  it contradicts the v0.22 compatibility decision and would create minimum-runtime and
  no-top-level-await promises without a CommonJS build. Also rejected: adding a CommonJS artifact in
  this change; that is a separate package-format decision if downstream adaptation proves infeasible.
- **Make slots tri-state and default-preserving.** Default emits nothing for production parity,
  while callers explicitly choose `--slots` or `--no-slots`. Rejected: a boolean that emits
  `--slots` or nothing; omission cannot disable b9860's default-enabled endpoint.
- **Separate caller-owned and factory-owned slot paths.** Caller paths are never deleted;
  factory-created temporary paths are always deleted after confirmed teardown. Rejected: one
  cleanup boolean across both ownership classes; it risks deleting caller data or leaking factory
  state.
- **Retain caller-controlled host and cwd as a deliberate bounded expansion.** A general launch
  facade must not silently overwrite canonical runtime host config and should pass through the
  working directory needed by a caller-provisioned executable. Rejected: preserving the
  calibration-only loopback/cwd behavior just because the first consumer can tolerate it.
- **Keep abort ownership explicit.** `signal` cancels factory startup; after return, the handle owns
  lifecycle and only `stop()` terminates it. Rejected: a long-retained caller signal stopping a
  successfully returned server at an unrelated later time.
- **Separate bind and connect hosts.** TCP availability tests use the actual bind interface; HTTP
  occupancy, readiness, and `/props` use a reachable, address-family-correct host. Rejected: using
  127.0.0.1 for every operation; explicit IPv6/local binds would fail health checks and wildcard
  bind conflicts could be missed.
- **Own the exact child, not only its PID.** The public handle may outlive calibration's narrow
  probe window, so exit observation, liveness, and teardown retain the spawned `ChildProcess` and
  coalesce cleanup. Rejected: PID-only ownership, which can inspect or signal an unrelated process
  after PID reuse.
- **Check fixed-port occupancy inside the factory.** This prevents adoption of a foreign endpoint
  after the caller has chosen to launch. Rejected: requiring every consumer to reproduce the
  manager's HTTP-plus-bind check.
- **Make Electron optional only for consumers.** Keep it as an optional peer and add it as a dev
  dependency. Rejected: optional peer alone; clean npm installs would no longer provide Electron's
  declarations to this repository's build and packed type test.
- **Report, but do not automatically enforce, `/props.model_path`.** The capacity reader exposes the
  exact b9860 field so adopt-first consumers can compare their requested absolute path. Rejected:
  silently claiming the existing capacity reader already verifies model identity.
- **Keep the package root unchanged and deep paths sealed.** Rejected: a Node-safe root or `dist/*`
  wildcard; both broaden the task beyond one supported launch entry.

## Open Questions

None outstanding. The pinned b9860 source resolves slots/default/capacity behavior; host/cwd are
retained as the bounded expansion from the prior design discussion; and the public surface,
ownership rules, compatibility boundaries, and verification gates are specified above.

## Rollback

The work remains unreleased on one branch. The additive export can be removed, optional-peer and
dev-dependency metadata reverted together, argument/runner options restored with their calibration
call site, and documentation/tests removed without changing persisted artifacts. The calibration
override move must be reverted atomically with runner defaults; partial reversion could silently
change the calibration argv. No stored calibration schema, model metadata, or on-disk format changes.

## Risks

- **Calibration behavior could drift when its defaults become explicit.** Mitigated by the exact
  calibration golden vector and probe call-site assertion.
- **Fixed-port checks still have an unavoidable release/bind race.** Mitigated by pre-spawn
  HTTP/bind checks, one fixed-port attempt, exit racing, post-health child-liveness verification,
  and exposed `modelPath` for caller verification.
- **Caller-selected wildcard and IPv6 hosts broaden network behavior.** Mitigated by separating
  actual bind checks from family-correct connect hosts, pinning URL formatting, and documenting the
  intentional `normalizeHealthHost('::')` correction for existing root consumers. Documentation
  warns that wildcard binding may expose the unauthenticated endpoint beyond loopback.
- **Child-process failures are asynchronous and PIDs are reusable.** Mitigated by registering error
  listeners before PID validation, retaining the exact child identity, coalescing stop/cleanup, and
  testing both real `ENOENT` and missing-exit-event paths.
- **Optional peer metadata changes install behavior.** Mitigated by the explicit dev dependency,
  lockfile update, packed-manifest assertion, frozen-install dry run, clean CI install, and
  documentation.
- **The public handle pins a small lifecycle contract.** Mitigated by omitting the constructor,
  process manager, and cleanup test seams and by guarding the concrete runner state.
- **The packed check does not exercise the real downstream dual-build loader.** TypeScript targeting
  CommonJS can rewrite dynamic `import()` to `require()`, which this ESM-only package neither tests
  nor promises and which may fail by runtime version or future top-level await. Mitigated by an
  explicit documentation warning and by requiring Palimpsest adoption to inspect its emitted
  artifact and preserve native import or use an ESM bridge before release; this remains a downstream
  release validation, not an implementation blocker.

---

**Completed 2026-08-18.** All implementation phases and verification gates passed. Independent
runtime and package-contract reviews found no remaining issue after their confirmed findings were
fixed and retested. Release preparation and Palimpsest adoption remain deliberately out of scope.
