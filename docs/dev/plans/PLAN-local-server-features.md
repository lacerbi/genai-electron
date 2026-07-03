# Plan: Local-Server Features, Launch Contract & Reliability (v0.6.0)

Created: 2026-07-03
Status: COMPLETE 2026-07-03 (branch feat/v0.6.0-local-server) — all phases done incl. GPU live smoke and the genai-lite 0.9.0 pairing verification

> **Execution notes (2026-07-03)**: Open Questions 1-4 resolved as recommended: sd.cpp bump OUT (follow-up plan), ROCm/HIP OUT, serverStart default → 120 s, occupancy rail default `'warn'`. **GPU is in use for ~4-5 h from start of execution** — all GPU-touching steps (binary two-phase validation, Phase 2 live smoke, Phase 6 walkthrough) are deferred to the end and marked `[!] GPU-deferred`; code, mocked tests, builds, and downloads proceed normally.

## Summary

Port the battle-tested llama-server knowledge from gmbench into genai-electron and pair with genai-lite v0.9.0 (`PLAN-local-model-features.md` in the genai-lite repo): (1) correctness fixes — wire five dead config fields, `127.0.0.1` everywhere, unconditional `--jinja`, optional port; (2) llama.cpp binary bump b7956 → b9860 with a modernized launch contract (tri-state flash attention, KV-cache quantization, MoE offload, `--host`, auto-fit control); (3) multi-shard GGUF downloads; (4) process-level reliability — port `'auto'` + occupancy rail, configurable start timeout, load-time metric, opt-in crash auto-restart + hang watchdog, log rotation; (5) diffusion generation cancellation; (6) example-app pairing with genai-lite 0.9.0 (reasoning toggle). Ships as v0.6.0 (additive; behavioral changes flagged below).

## Scope

- **In scope**: the six areas above; docs (`genai-electron-docs/`, README, CLAUDE.md, DESIGN.md phase language, PROGRESS.md, `docs/dev/UPDATING-BINARIES.md`), `migration-0-5-to-0-6.md`, tests, version bump.
- **Out of scope**: request-side features (sampling params, `chat_template_kwargs`, grammar, logprobs, retry/timeout per request — all genai-lite v0.9.0's job); stable-diffusion.cpp version bump (Open Question 1); ROCm/HIP binary variants (needs Windows AMD detection, DESIGN Phase 4); HuggingFace Hub API browsing (Phase 3 backlog); download resume; shared storage; multi-server pooling; GPT-OSS harmony tricks (out of scope for both libraries).

## Division of labor with genai-lite v0.9.0 (context)

- genai-electron owns the **launch profile** (all llama-server CLI flags) and process lifecycle; genai-lite owns the **request payload** and response parsing. genai-lite's reasoning toggle sends `chat_template_kwargs.enable_thinking` per request — llama-server honors it only when started with `--jinja`, which is why unconditional `--jinja` here is a hard dependency, not a cleanup.
- genai-lite detects model families from the GGUF **filename reported by the server** — so `modelAlias` must default to unset, with a JSDoc warning.
- Pairing note ships in both changelogs/docs: "genai-lite ≥ 0.9 pairs with genai-electron ≥ 0.6" (docs-only coupling, no runtime check — user-approved).

## Confirmed design decisions (user-approved)

1. Launch profiles (KV quant, `-ot`, `--cache-ram`, gpu layers) live in genai-electron's `ServerConfig`; everything request-shaped stays in genai-lite.
2. llama.cpp pin bumps to **b9860** (≥ b9028 required by genai-lite's verified server behaviors).
3. electron-control-panel becomes the combined smoke test: genai-lite 0.9.0 + reasoning toggle.
4. DiffusionServerManager cancellation API is in scope this round.
5. genai-electron adds **no request-side resilience** (genai-lite Phase 4 owns retry/timeout/abort; avoids double-retry).

## Verified facts the plan relies on

Verified against llama.cpp tag **b9860** (released 2026-07-02) via `tools/server/README.md` and the GitHub releases API; gmbench facts verified against its source (`src/gmbench/backends.py`).

- **Release assets** (exact names): `llama-b9860-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`, `llama-b9860-bin-win-vulkan-x64.zip`, `llama-b9860-bin-win-cpu-x64.zip`, `llama-b9860-bin-macos-arm64.tar.gz`, `llama-b9860-bin-macos-x64.tar.gz`, `llama-b9860-bin-ubuntu-x64.tar.gz`, `llama-b9860-bin-ubuntu-vulkan-x64.tar.gz`. **No Linux x64 CUDA prebuilt exists anymore** — Linux NVIDIA users get Vulkan.
- **Checksums**: the GitHub releases API exposes per-asset `digest` (`sha256:<hex>`) — fetch programmatically at implementation time instead of hand-computing (e.g. cudart 12.4 digest matches our existing pinned checksum, confirming the format).
- **Flag syntax at b9860**: `-fa on|off|auto` (default `auto`); `-fit on|off` (default **on** — auto-adjusts unset args to fit device memory; gmbench disables it after A100 hangs); `--cache-type-k/-v` (values `f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1`, default `f16`); `-ot <pattern>=<buffer>` (e.g. `exps=CPU`); `--cache-ram N` (MiB, default 8192); `--cpu-moe` / `--n-cpu-moe N` (ergonomic MoE offload); `--jinja` **now default-on** (`--no-jinja` to disable); `--reasoning-format` default `auto`; `--host` (default `127.0.0.1`), `--alias`, `--api-key` present; `--no-mmap`, `--mlock`; continuous batching default-on (`--no-cont-batching` to disable); `-b`/`-ub` batch sizes; **`-ngl` now defaults to auto** (so CPU-only intent must be passed explicitly as `-ngl 0`); `-np` default `-1` (auto).
- **Quantized V-cache requires flash attention on** — runtime constraint (not in README; confirmed via maintainer issue reports). Pair `cacheTypeV: q*` with `-fa on`.
- **Multi-shard GGUF**: point `-m` at the **first** shard (`...-00001-of-0000N.gguf`) with siblings adjacent; loader auto-discovers the rest, no flag needed (llama.cpp PR #6187).
- **`/health`**: 200 `{"status":"ok"}` when ready, 503 while loading — remains the correct readiness probe.
- **`localhost` vs `127.0.0.1`**: server binds IPv4 loopback only; on Windows `localhost` resolves to `::1` first → ~2 s IPv6 fallback per request (gmbench measured ~9× per-request penalty; `docs/dev/2026-04-26-windows-localhost-ipv6-perf.md` in gmbench).
- **gmbench launch contract** (`backends.py:275-307`): always `--jinja` + `-fit off`; conditionally `--cache-type-k/v`, `-ot`, `--cache-ram` from per-model config; log-to-file (never an undrained pipe — 64 KiB pipe-buffer deadlock, documented in gmbench's issue archive); terminate→wait(10s)→kill escalation; 600 s health budget for cold model loads.
- **genai-electron dead fields** (confirmed): `modelAlias`, `continuousBatching`, `batchSize`, `useMmap`, `useMlock` pass validation (`LlamaServerManager.ts:61-75`) but are never emitted by `buildCommandLineArgs` (`:389-435`).
- **genai-lite image adapter** (`GenaiElectronImageAdapter.ts:211-263`): polls generation status treating only `complete`/`error` as terminal — a new `'cancelled'` status hangs clients ≤ 0.9.0 until their own 120 s timeout. genai-lite 0.9.0's plan excludes image-side changes; follow-up filed there (see Phase 5).
- **stable-diffusion.cpp**: our pin `master-504-636d3cb` was ~242 releases behind latest (`master-746-2574f59`) — Open Question 1. RESOLVED in the v0.10.0 batch: bumped to `master-746-2574f59` (see `PLAN-sd-cpp-bump.md`).

---

## Phases

Each phase is a PR-sized, independently green unit (`npm run build` 0 errors + `npm test` pass at each boundary; `npm run lint` + `npm run format` before each commit per CLAUDE.md). Order: 1 → 2 (2 needs 1's arg-builder cleanups); 3, 4, 5 are independent of each other but build on 2; 6 gated on genai-lite 0.9.0 availability; 7 last.

### Phase 0: Prep

**Goal**: trustworthy baseline + final binary facts.

**Steps**:
- [x] `npm run build` + `npm test` — baseline green: 0 TS errors, **418/418 tests, 18 suites** (pre-existing worker-teardown warning noted).
- [x] b9860 is still `releases/latest` (2026-07-03) — pin confirmed. All 8 digests recorded in scratch note `b9860-digests.md` (session scratchpad).
- [x] Archive layouts checked (win-cpu zip + ubuntu tar.gz downloaded, checksums match digests). **Two discoveries** → new Phase 2 work item 8: (a) Unix tar.gz nests everything under a top-level `llama-<tag>/` dir at BOTH b7956 and b9860, but `downloadAndTestVariant` copies the extract root verbatim (`BinaryManager.ts:460` → `cp` recursive), stranding the binary at `binaries/llama/llama-<tag>/llama-server` while `finalBinaryPath`/chmod/spawn expect it at the root — pre-existing latent macOS/Linux bug, must fix with the bump; (b) b9860 Windows zips split `llama-server.exe` into a 9 KB launcher + `llama-server-impl.dll` — fine because ALL files are copied, but the launcher alone is not runnable (worth a doc note).

**Verification**:
- [x] Baseline green; tag + digests recorded in the PR description or a scratch note.

### Phase 1: Correctness & compatibility fixes (no binary bump; all valid at b7956)

**Goal**: the known-wrong things fixed; works against the currently pinned binary.

**Work**:
1. [x] **`127.0.0.1` everywhere** — `src/process/health-check.ts:45,191` (+ doc comment `:26`), `src/managers/BinaryManager.ts:696,726`. Update string assertions in `tests/unit/health-check.test.ts:42,348`.
2. [x] **Wire the five dead fields** in `buildCommandLineArgs` (`LlamaServerManager.ts:389-435`): `modelAlias` → `--alias <v>` (JSDoc warning: masks the filename genai-lite uses for family detection; leave unset unless needed); `batchSize` → `-b <n>`; `continuousBatching === false` → `--no-cont-batching` (true/undefined → omit; server default on); `useMmap === false` → `--no-mmap`; `useMlock === true` → `--mlock`.
3. [x] **Port optional**: `ServerConfig.port?: number` (`types/servers.ts:23`); resolve `config.port ?? DEFAULT_PORTS.llama` **once at the top of `start()`**, before `checkPortAvailability` (`:154`) — all of `:154,165,199,207` read the port — and write the resolved number into `finalConfig` so `this._config.port` is concrete (later reused by `restart()`/auto-restart). `ServerInfo.port` stays a required resolved `number`. (`'auto'` comes in Phase 4.)
4. [x] **Unconditional `--jinja`**; drop `--reasoning-format deepseek` conditional (`LlamaServerManager.ts:397`). Add `jinja?: boolean` (default true; `false` → pass `--no-jinja` after the Phase 2 bump; at b7956 false simply omits `--jinja`). Keep `detectReasoningSupport`/`supportsReasoning` (still useful metadata for apps) but it no longer gates flags.
5. [x] **`startupTimeout?: number` (ms)** on `ServerConfig`; thread into `waitForHealthy` at `LlamaServerManager.ts:207` as `finalConfig.startupTimeout ?? DEFAULT_TIMEOUTS.serverStart`; raise `DEFAULT_TIMEOUTS.serverStart` 60000 → **120000** (`defaults.ts:21-30`) — cold loads of 10-20 GB models exceed 60 s (gmbench uses 600 s on HPC).
6. [x] **Debug-log cleanup**: new internal `src/utils/debug-log.ts` gated by `GENAI_ELECTRON_DEBUG` env var; replace the `console.log` spew in `autoConfigureIfNeeded` (`LlamaServerManager.ts:350-373`) and throughout `ResourceOrchestrator.ts` (optionally also `electron-lifecycle.ts:68-84`); keep sparse `console.warn`/`console.error` only for actionable problems.
7. [x] Add all new field names (`startupTimeout`, `jinja`) to `VALID_CONFIG_FIELDS` (`LlamaServerManager.ts:61-75`).

**Tests**: `LlamaServerManager.test.ts` — arg assertions for each newly wired flag (present when set, absent when not), port-default test, startupTimeout threading (assert `waitForHealthy` called with override), `--jinja` always present, `--reasoning-format` absent. `health-check.test.ts` URL updates.

**Verification**:
- [x] `npm test` green (429/429, +11 new); spawn-args assertions prove exact flag emission. (electron-lifecycle.ts logs left as-is — sparse, informative, plan marked optional.)

### Phase 2: Binary bump (→ b9860) + modernized launch contract

**Goal**: current llama.cpp with the full gmbench flag set exposed; deterministic defaults.

**Work**:
1. [x] **`BINARY_VERSIONS.llamaServer`** (`defaults.ts:75-131`): version → chosen tag; per-variant URLs + checksums from the API digests. `win32-x64`: cuda-12.4 (+cudart dependency) → vulkan → cpu (as today); `darwin-arm64`: metal; `darwin-x64`: cpu; `linux-x64`: **vulkan → cpu** (CUDA prebuilt discontinued upstream — release note + migration-guide callout for Linux NVIDIA users). Validation-cache invalidation is automatic via the version field (`BinaryManager.ts:229-240`).
2. [x] **New `LlamaServerConfig` fields** (`types/servers.ts:79-94`) + `VALID_CONFIG_FIELDS` + `buildCommandLineArgs` emission:
   - `cacheTypeK?` / `cacheTypeV?`: `'f16' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'iq4_nl'` → `--cache-type-k/-v`.
   - `overrideTensors?: string` → `-ot <v>`; `cacheRam?: number` (MiB) → `--cache-ram <n>`; `cpuMoe?: boolean` → `--cpu-moe`; `nCpuMoe?: number` → `--n-cpu-moe <n>`.
   - `reasoningFormat?: 'auto' | 'deepseek' | 'deepseek-legacy' | 'none'` → `--reasoning-format <v>` only when set (server default `auto`).
   - `fit?: 'on' | 'off'` → `-fit <v>`, **default `'off'`** (we pass explicit values from our own auto-config; auto-fit hung on gmbench's A100s). Setting `fit: 'on'` skips `autoConfigureIfNeeded`'s filling of `gpuLayers`/`contextSize` (delegating to llama-server) — document this interplay.
   - `host?: string` on `ServerConfig` → `--host <v>` when set. Health checks target `config.host ?? '127.0.0.1'`, mapping `0.0.0.0`/`::` → `127.0.0.1`.
3. [x] **Flash attention tri-state**: `flashAttention?: boolean | 'on' | 'off' | 'auto'` — `true`→`-fa on`, `false`→`-fa off`, string passes through, undefined → omit (server default auto). Note `getOptimalConfig` never actually sets `flashAttention` (`SystemInfo.ts:240-269`), so the common unset case resolves to omit → server `auto` — this is the deliberate behavior change flagged in Risks, not a mapped boolean.
4. [x] **Constraint validation** in `start()`: quantized `cacheTypeV` + flashAttention resolved off/undefined → auto-upgrade to `'on'` with a log line when undefined; throw `ServerError` with an actionable message when explicitly `'off'`/`false`.
5. [x] **`-ngl` emission fix**: condition changes from `gpuLayers > 0` to `gpuLayers !== undefined` — at b9860 the server default is auto-offload, so omitting `-ngl` for a CPU-only config would silently GPU-offload.
6. [x] **Config-surface bookkeeping**: add exactly `cacheTypeK, cacheTypeV, overrideTensors, cacheRam, cpuMoe, nCpuMoe, reasoningFormat, fit, host` to `VALID_CONFIG_FIELDS` — a missing entry makes `start()` throw (`ServerManager.validateConfigFields:361-381`). Add a completeness test asserting every key of `LlamaServerConfig` appears in the set, so later phases (and future fields) can't silently break `start()`.
7. [x] **`docs/dev/UPDATING-BINARIES.md`**: document the new procedure incl. the releases-API `digest` shortcut and the Linux-CUDA discontinuation.
8. [x] **(discovered in Phase 0) Flatten nested tar layouts in `downloadAndTestVariant`** (`BinaryManager.ts:457-465`): Unix tar.gz archives nest under `llama-<tag>/`; copy the contents of `path.dirname(extractedBinaryPath)` (the directory actually containing the binary) instead of the extract root, plus root-level dependency files when the binary dir is nested (Windows CUDA deps land at the root; on Windows zip the two dirs coincide). Fixes a pre-existing latent macOS/Linux install bug; add a unit test with a nested mock layout.

**Tests**: arg assertions for every new flag + the tri-state mapping + `-ngl 0` case; constraint-validation positive/negative; BinaryManager version-bump cache-invalidation tests already exist (`BinaryManager.test.ts:1331+`) — confirm they pass with the new version string.

**Verification**:
- [x] `npm test` green (440/440). New: flag emission for all Phase 2 fields, FA tri-state mapping, -ngl 0, V-cache constraint, fit interplay, config-surface completeness test, nested-tar flatten tests.
- [x] **Live smoke PASSED (2026-07-03, Windows + NVIDIA)**: clean userData → b9860 CUDA + cudart downloaded, two-phase validation (real GPU inference) passed, Qwen3.5-4B-Q4_K_M started healthy in 3.3 s (`loadTimeMs` captured). Spawn line confirmed the full contract: `--jinja --port 8080 --threads 18 -c 8192 -n -1 -ngl 99 -np 1 -fa on -fit off --cache-type-k q8_0 --cache-type-v q8_0` (FA auto-upgraded for quantized V-cache).

### Phase 3: Multi-shard GGUF downloads

**Goal**: big models (`...-00001-of-0000N.gguf`) download and launch.

**Work**:
1. [x] **Auto-detection**: in `ModelManager.downloadModel`, when the resolved filename matches `/-(\d{5})-of-(\d{5})\.gguf$/i`, derive all sibling shard names automatically (HF source: same repo; URL source: same base URL with substituted filename). Explicit `DownloadConfig.shardFiles?: string[]` overrides/supplements for non-standard naming (gmbench's `model_extra_files` equivalent).
2. [x] **Storage**: sharded models live in a per-model subdirectory (reuse `getModelDirectory`, `paths.ts:83`); `ModelInfo.path` = first shard; new `ModelInfo.shards?: Array<{ path: string; size: number; checksum?: string }>`; `ModelInfo.size` = aggregate. The metadata sidecar stays at `models/{type}/{modelId}.json` (`getModelMetadataPath`, `paths.ts:100`), **outside** the subdirectory — same as multi-component; only shard files live inside. Do **not** overload the role-keyed diffusion `components` machinery — shards are ordered pieces of one model, not roles.
3. [x] **Download flow**: sequential shard downloads with aggregate progress (HEAD pre-fetch for totals) and partial-failure cleanup — mirror the multi-component patterns (`ModelManager.ts:262-520`). GGUF metadata from the first shard only (header lives there). `detectReasoningSupport` on the primary filename.
4. [x] **StorageManager**: `deleteModelFiles`, `verifyModelIntegrity`, `getStorageUsed` gain a `shards` branch mirroring the existing `components` branches (`StorageManager.ts:193-267, 351-406, 420-450`).
5. [x] `buildCommandLineArgs` needs no change (`-m` gets `modelInfo.path` = first shard; siblings adjacent).
6. [x] New `ShardInfo`-style type exported from `src/index.ts` types block.

**Tests**: `ModelManager.test.ts` — auto-derivation from the shard pattern, explicit `shardFiles`, aggregate progress, partial-failure cleanup; `StorageManager.test.ts` — delete/verify/storage-used with shards; a case asserting `ModelInfo.path` points at shard 1.

**Verification**:
- [x] `npm test` green (451/451); pattern edge cases covered (single-shard 00001-of-00001, uppercase names preserved, non-first-shard rejection, explicit shardFiles with URLs, aggregate progress, failure cleanup).

### Phase 4: Lifecycle niceties

**Goal**: the operational features gmbench proved out (or explicitly lacked and wanted).

**Work**:
1. [x] **Port `'auto'`**: `port?: number | 'auto'`; new `findFreePort()` util (node:net bind-0) in `src/process/` — exported next to the health utils (`index.ts:200`). Resolution: number → as-is; `'auto'` → bind-0; undefined → `DEFAULT_PORTS.llama`. **Diffusion caveat**: `DiffusionServerConfig`/`DiffusionServerInfo` are standalone interfaces (`types/images.ts:113,185`), NOT extensions of the base — widen `DiffusionServerConfig.port` independently, and fix the existing **double resolution** (`start()` `:209` and `createHTTPServer()` `:394` each do `config.port || DEFAULT_PORTS.diffusion`; with `'auto'` they'd yield two different ports): resolve once at the top of `start()`, store, and thread the number into `createHTTPServer`. Update `DiffusionServerManager`'s own `VALID_CONFIG_FIELDS` (`:75-86`) in lockstep.
2. [x] **Real availability check**: extend `checkPortAvailability` (`ServerManager.ts:383-388`) with a bind test (catches any occupant, not just HTTP responders); keep the `/health` probe to enrich `PortInUseError` ("occupied by another llama-server").
3. [x] **Occupancy safety rail**: on `start()`, probe 8080-8083 (excluding own target) for other llama-servers; new `occupancyCheck?: 'warn' | 'strict' | 'off'` (default `'warn'`: structured warning log; `'strict'`: throw `ServerError` with override guidance) — prevents cross-app VRAM double-loading (gmbench's rail, adapted for a library). **Fingerprint precisely**: our own diffusion wrapper sits at 8081 with an identical `/health` shape (`DiffusionServerManager.ts:412`) — confirm candidates via a llama-only endpoint (`GET /props`; the wrapper 404s it) so the rail never flags the app's own diffusion server.
4. [x] **Load-time metric**: measure spawn→healthy ms; `ServerInfo.loadTimeMs?: number` via `getInfo()`, included in the `'started'` event payload. Llama only — `DiffusionServerManager.getInfo()` spreads the base info (`:347`), so don't populate it there (HTTP-listen time is meaningless; sd-cli loads per generation).
5. [x] **Crash auto-restart (opt-in)**: `autoRestart?: boolean` (default false), `maxRestarts?: number` (default 3), exponential delay (1s/2s/4s). In `handleExit`'s crash branch (`LlamaServerManager.ts:510-531`): emit `'crashed'`, then if enabled and budget remains, **schedule** the re-`start(this._config)` on the backoff timer — never inline from the synchronous `handleExit`, which clears `_pid`/`_port` only after the crash branch — wrapped in `.catch` (a failed restart attempt counts against the budget and leaves status `'crashed'`). Reuse the previously **resolved** concrete port (don't re-run `'auto'`). Event order on success: `'crashed'` → `'started'` → `'restarted'` (matching the existing manual emission at `ServerManager.ts:118` — reuse, don't duplicate). Counter resets on manual `start()`/`restart()`. Intentional `stop()` never triggers it (status is `'stopping'` before kill). Document interplay with `attachAppLifecycle` (quit → plain stop, no restart).
6. [x] **Hang watchdog (opt-in)**: `healthCheckInterval?: number` (ms; default off). While running, poll `checkHealth`; emit the already-declared-but-never-fired `'health-check-ok'` / `'health-check-failed'` events (`types/servers.ts:104-105`); after 3 consecutive failures, kill the process — the exit path then feeds auto-restart if enabled. Timer `unref()`d; torn down on **every** exit path (`handleExit` included, not just `stop()`), re-established by a successful (re)start.
7. [x] **Log rotation**: `LogManager` rotates at 5 MB keeping 2 archives (`llama-server.log.1/.2`); constants in `defaults.ts`, constructor-configurable. Fixes the unbounded-append gap (`log-manager.ts:93-103`).
8. [x] New fields → `VALID_CONFIG_FIELDS`: exactly `occupancyCheck, autoRestart, maxRestarts, healthCheckInterval` (the Phase 2 completeness test catches misses); new types → `index.ts` exports.

**Tests**: new `findFreePort` + occupancy-rail tests (incl. not flagging a diffusion wrapper); diffusion `port: 'auto'` single-resolution test; auto-restart with fake timers (crash → restarted event → budget exhaustion stays `crashed`; manual stop does not restart); watchdog consecutive-failure kill; new `log-manager.test.ts` for rotation; `LlamaServerManager.test.ts` crash-handling block (`:484-555`) updated for the opt-in branch.

**Verification**:
- [x] `npm test` green (475/475, 20 suites); fake-timer tests cover auto-restart success/budget/opt-in/manual-stop, watchdog ok/kill/disabled; occupancy rail incl. diffusion fingerprint; port auto (both managers); rotation suite; real-socket port-utils suite.

### Phase 5: Diffusion generation cancellation

**Goal**: `cancelImageGeneration(id)` — the deferred "Phase 3" API.

**Work**:
1. [x] `GenerationStatus` += `'cancelled'` (`types/images.ts:214`); `GenerationRegistry.cleanup` treats it as terminal (`GenerationRegistry.ts:123`); `handleGetGeneration` gains a `cancelled` branch.
2. [x] Store the generation `id` on `currentGeneration` (`DiffusionServerManager.ts:95-98`; the `id` is created in `handleStartGeneration` `:507` and currently never threaded into the execution path — add it); new public `cancelImageGeneration(id)`: unknown id → throw `ServerError('GENERATION_NOT_FOUND')`; terminal → no-op (idempotent); active → invoke the existing `cancel()` closure (kills sd-cli via `ProcessManager.kill`) and set registry status `'cancelled'` **before** the rejection lands. Guard **both** status writers so `'cancelled'` is never overwritten: the `.catch` in `handleStartGeneration` (`:510-518`) that writes `'error'`, and the success write `'complete'` in `runAsyncGeneration` (`:625-632`) — each skips when the current status is `'cancelled'`.
3. [x] HTTP: `DELETE /v1/images/generations/:id` → 200 `{id, status:'cancelled'}` / 404 / 409-style response for terminal states (CORS already permits DELETE, `:399`).
4. [x] **Batch**: a batch-scoped cancellation token owned by `runAsyncGeneration`, checked before each iteration and honored even **between** images — `currentGeneration` is `undefined` in the gap between batch items (`:800,813,816`), so cancel must work when no child is live; the killed child's rejection aborts the loop; registry ends `'cancelled'`, partial images discarded. Reconcile with `stop()` teardown (`:265-268`, registry `destroy()` `:279`) so cancel-status writes don't race it.
5. [x] Orchestrator: cancellation rejects `executeImageGeneration` → existing catch already triggers the background LLM reload — verify with a test, no code change expected.
5b. [x] (discovered) New `getActiveGenerationId()` accessor — the async-API id is otherwise known only to the HTTP client that created it; needed by the example app's Cancel button.
6. [x] **Compat**: genai-lite ≤ 0.9.0 pollers treat only `complete`/`error` as terminal — cancelled generations would hang them until their 120 s client timeout. Acceptable (cancel is initiated by the same app that polls); document in `image-generation.md` + migration guide, and file a follow-up in genai-lite to add `'cancelled'` as a terminal status in `GenaiElectronImageAdapter`.

**Tests**: `DiffusionServerManager.test.ts` — cancel active/unknown/terminal, registry status transitions, DELETE route, batch abort; `GenerationRegistry.test.ts` — cancelled-is-terminal cleanup; `ResourceOrchestrator.test.ts` — reload fires after cancelled generation.

**Verification**:
- [x] `npm test` green (486/486). Follow-up filed in genai-lite: docs/ISSUE-cancelled-generation-status.md (adapter should treat 'cancelled' as terminal).

### Phase 6: Example-app pairing (electron-control-panel)

**Goal**: the combined genai-electron 0.6 + genai-lite 0.9 story, verified end-to-end.

**Gate** (checked: NOT met on 2026-07-03, latest npm = 0.8.3): genai-lite 0.9.0 published to npm (use local `npm link`/`file:` only for pre-publish testing; do not commit a local path). Prerequisite per CLAUDE.md: refresh the local genai-lite reference docs (`.ath_materials/genai-lite-docs/` — currently absent in this checkout) with the v0.9.0 docs and read `llm-service.md`/`llamacpp-integration.md` before wiring the toggle.

**Work**:
1. [x] genai-lite 0.9.0 published → example bumped to `^0.9.0`, installed, app rebuilds clean (app version 0.4.0).
2. [x] **Reasoning toggle** in `TestChat.tsx`: checkbox in the settings panel (`:135-193`); send `reasoning: { enabled }` in the settings object (`:46-49`) — passes through the opaque `server:testMessage` IPC unchanged. The existing reasoning display (`:210-223`) then lights up.
3. [x] **New server options in the config form**: `flashAttention` becomes a tri-state select (on/off/auto); add `cacheTypeK`/`cacheTypeV` selects (f16/q8_0/q4_0). Update the **duplicated** `LlamaServerConfigForm` interface in both `LlamaServerControl.tsx:14-22` and `LlamaServerConfig.tsx:9-17`, plus the defaults object (`LlamaServerControl.tsx:30-38`). No IPC changes (config forwarded opaquely).
4. [x] **Cancel button** for image generation in `DiffusionServerControl`, wired through a new `diffusion:cancel` IPC handler → `diffusionServer.cancelImageGeneration(id)` (+ preload allowlist entry).

**Verification**:
- [x] Core pairing verified end-to-end (2026-07-03) via headless Electron smoke against a live Qwen3.5-4B: genai-lite 0.9.0 reasoning toggle OFF → clean content, no reasoning field; ON → `choice.reasoning` populated, no `<think>` leakage; KV-quant flags in the server log. Image-cancel is unit-tested and the app's Cancel wiring builds; app launched for an optional visual pass (in-app first start also exercises the b7956→b9860 migration re-download).

### Phase 7: Documentation, migration guide, release

**Goal**: docs tell the new story; v0.6.0 ready.

**Work** (targets from the docs-impact audit; quotes verified against current files):
1. [x] `genai-electron-docs/llm-server.md` — highest impact: config-options block (`:149-170`) rewritten (port optional/'auto', host, tri-state flashAttention, new cache/MoE/fit/reasoningFormat/startupTimeout/autoRestart/watchdog/occupancy fields, dead fields now real); Reasoning section (`:487-545`) reframed (`--jinja` unconditional, `--reasoning-format` default auto); new subsections: auto-restart, load-time metric, occupancy rail; timeout note `:99`.
2. [x] `genai-electron-docs/typescript-reference.md` — `ServerConfig`/`LlamaServerConfig` interface diffs (`:282-295, 331-343`); `ServerInfo.loadTimeMs`; new shard + cancellation types.
3. [x] `genai-electron-docs/model-management.md` — new "Multi-Shard GGUF Downloads" subsection, explicitly distinguished from multi-*component* (roles) at `:113-314`; reasoning-flags sentence `:667` rewritten.
4. [x] `genai-electron-docs/image-generation.md` — `cancelImageGeneration` (Node API + DELETE endpoint); base-URL examples → `127.0.0.1` (`:140,157,182,209`); genai-lite ≤ 0.9.0 cancelled-status caveat.
5. [x] `genai-electron-docs/index.md` — version line `:3`, reasoning bullet `:320`, genai-lite version `:358`, migration nav link.
6. [x] `genai-electron-docs/troubleshooting.md` — reasoning prose `~:204-210`, port-conflict section gains `port: 'auto'` (`:316-337`); `installation-and-setup.md` — timing note + any new env vars; `integration-guide.md` — auto-restart × `attachAppLifecycle` note near `:277-283`; `system-detection.md` — `getOptimalConfig` example port pattern (`:233-250`); `resource-orchestration.md` — re-check batch/orchestration notes (`:100`); `example-control-panel.md` — reasoning *request* toggle pattern (distinct from the existing display toggle), cancel-button pattern.
7. [x] **`genai-electron-docs/migration-0-5-to-0-6.md`** — follow the `migration-0-4-to-0-5.md` skeleton. Compatibility section headlines the behavioral changes: binary re-download on first start (~50-300 MB); Linux NVIDIA CUDA→Vulkan; `--jinja` always on; `--reasoning-format` no longer forced; `-fa`/`-fit`/`-ngl 0` semantics; serverStart default 60→120 s; the genai-lite ≥ 0.9 pairing note.
8. [x] Root docs: `README.md:3` version; `CLAUDE.md` — health-endpoint line `:111` (127.0.0.1), timeout wording `:113`, genai-lite 0.9.0 (`:263,272` — note `.ath_materials/genai-lite-docs/` is absent in this checkout; refresh or flag), Key Exports list; `DESIGN.md` — cancellation no longer "deferred to Phase 3" (`:1286-1316, 1334, 392`), Linux binaries "Built with CUDA" note (`:1813-1818`), Phase 4 metrics partially delivered (`:1870-1875`).
9. [x] `PROGRESS.md` — new dated section per convention (Goal / Core Features / Files Modified / Build Status), top status line + test count refreshed.
10. [x] Release: `package.json` + `src/index.ts:9` → 0.6.0; full local CI trio (`build`, `lint`, `test`) + `npm run format`; commit `package-lock.json`. Archived to `docs/dev/plans/` on completion (repo convention).

**Verification**:
- [x] Grep sweep clean (remaining hits are intentional: migration-guide description of removed behavior; troubleshooting manual-CLI example; genai-lite v0.5.1 references kept deliberately until 0.9.0 publishes).
- [x] CI-equivalent trio green locally (build 0 errors, lint 0 errors, 486/486 tests).

## Testing strategy

- Unit tests per phase as listed; the spawn-args assertion pattern in `LlamaServerManager.test.ts` is the enumeration checklist for every new flag (flag present when set / absent when unset).
- Live verification on this machine (Windows + NVIDIA CUDA, gmbench's GGUFs via `GMBENCH_MODELS_DIR`): Phase 2 binary smoke, Phase 6 walkthrough. One heavy process at a time.
- macOS/Linux binary validation: cannot run locally — rely on checksum-verified downloads + the existing two-phase validation running on users' machines; flag in the release notes that non-Windows platforms had checksum-only verification this cycle (same as previous bumps).

## Risks

- **Behavioral shift from the binary bump**: b9860 defaults are "auto everything" (`-ngl`, `-fa`, `-fit`, `-np`). Mitigated by passing explicit values (our auto-config) + `fit: 'off'` default + the `-ngl 0` fix; still headline in the migration guide.
- **Linux NVIDIA regression**: Vulkan instead of CUDA prebuilts (upstream discontinued). Perf delta varies by model; documented, with build-from-source pointer in troubleshooting.
- **First-start re-download** after upgrade (validation cache invalidates by version) — migration note.
- **`'cancelled'` status vs old genai-lite pollers** — documented caveat + genai-lite follow-up (Phase 5.6).
- **Phase 6 gated on genai-lite 0.9.0 publish** — if delayed, ship 0.6.0 without the example bump and do it as a fast-follow.
- **flashAttention type widening** is source-compatible (boolean still accepted) but docs claiming "default: false" become "default: auto (server-decided)" — a real behavior change on GPUs where auto enables FA.

## Open Questions

> **All resolved 2026-07-03** (user approved the stated recommendations): 1 = OUT, 2 = OUT, 3 = 120 s, 4 = `'warn'`.

1. **stable-diffusion.cpp bump** (pin is ~242 releases behind): recommend a **separate follow-up plan** — sd-cli flag surface may have changed and re-validating diffusion across platforms is its own effort. Plan assumes OUT; say the word to fold it in.
2. **ROCm/HIP variants** (upstream now ships `win-hip-radeon` + `ubuntu-rocm` prebuilts): deferred — Windows AMD GPU detection doesn't exist yet (DESIGN Phase 4). Plan assumes OUT.
3. **`DEFAULT_TIMEOUTS.serverStart` 60 s → 120 s** — comfortable? (Configurable per-start regardless; gmbench uses 600 s but that's HPC cold-Lustre territory.)
4. **Occupancy rail default `'warn'`** (log + keep going) with opt-in `'strict'` — agreed? gmbench throws by default, but it's a batch tool; a library blocking an app's start because *some other app* runs llama-server feels too aggressive.

---
**Please review. Edit directly if needed, then confirm to proceed.**
