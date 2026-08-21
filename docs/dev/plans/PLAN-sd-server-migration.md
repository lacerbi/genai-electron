# Plan: Persistent `sd-server` backend behind the diffusion HTTP wrapper

Created: 2026-08-21
Status: COMPLETE (2026-08-21) — all seven phases landed on `feat/sd-server-backend` (unreleased);
interim + final `/doublecheck` findings folded in; live smoke S1–S11 passed on the pinned
`master-782-b290693` binary (see Phase 7 results); gates: build 0 errors, lint 0 errors, format clean,
1370/1370 tests across 45 suites, example app builds. Deferred items: `ISSUE-diffusion-followups.md`.
(Approved 2026-08-21; open questions resolved: `idleTimeoutMs` default 300 000 ms; example-app
touch-ups = comment fixes + backend-state status line only.)
Source: `docs/dev/2026-08-21_diffusion-architecture-review.md` (§3, §5, §8) + design discussion
(2026-08-21) + local smoke test (results below) + `/doublecheck` of this plan (3 read-only Opus
reviewers, 2026-08-21; findings folded in)
Branch: `feat/sd-server-backend` (accumulates **unreleased**; no version bump/tag/publish/migration
guide until the user asks for a release — see `AGENTS.md` release workflow)

## Phase status

- [x] Phase 1: Backend modules (`sd-server-client.ts`, `sd-server-runner.ts`, types, defaults, paths) — `13b8dec`
- [x] Phase 2: Binary provisioning (`sd-server` primary, Phase-2 validation via the runner, POSIX chmod) — `1ae88a5`
- [x] Phase 3: `DiffusionServerManager` rewire (resident backend, same wrapper contract, lifecycle) — interim
      doublecheck (3 Opus reviewers) folded in; 1260/1260 — `03688af`
- [x] Phase 4: Residency policy + symmetric `ResourceOrchestrator` + LLM pre-start hook — 1321/1321
      — `def5f72`
- [x] Phase 5: Calibration re-base (`usageMode: 'single' | 'burst'`, `policyVersion`, VRAM fields) —
      1331/1331 — `b5706c1`
- [x] Phase 6: Documentation, PROGRESS "Unreleased", DESIGN/dev-doc updates, example-app touch-ups —
      `482367c`; final doc corrections + the queued small-fix batch folded in afterwards
- [x] Phase 7: Live smoke (main thread, pinned binary) + final `/doublecheck` — final doublecheck
      fixes landed as `816b0c0`
- [x] Flip `Status:` to `COMPLETE (date)` with a short results note — done 2026-08-21

## Tracking (live checklist; details in the phase sections below)

- Phase 1 — backend modules
  - [x] types (`images.ts`, `servers.ts` deferred to P3), exports (`types/index.ts`, `index.ts`)
  - [x] `DIFFUSION_BACKEND_DEFAULTS`, calibration defaults `policyVersion`/`usageMode` (+ type literal)
  - [x] `PATHS.loras` + `ensureDirectories()`
  - [x] `src/process/sd-server-client.ts` + tests
  - [x] `src/process/sd-server-runner.ts` (DI, tap, confirmed stop) + tests
  - [x] ESLint `no-restricted-imports` for `src/process/**` (in `eslint.config.mjs`)
  - [x] build/lint/tests green (build 0 errors, lint 0 errors, 1147/1147 tests); committed `13b8dec`
- Phase 2 — provisioning
  - [x] `ensureBinary` → `'sd-server'`; search names
  - [x] `runSdServerTest` via runner/client; termination-unconfirmed mapping; drop `.test-output.png`
  - [x] POSIX chmod-before-revalidate
  - [x] `BinaryManager.test.ts` adapted; build/lint/tests green; commit
  - [ ] live: pinned 782 provisioning + smoke re-run + re-validation (done in P7 if machine busy)
- Phase 3 — manager rewire
  - [x] config fields + host bind + `VALID_CONFIG_FIELDS`
  - [x] backend state machine (`ensureBackend`/`releaseBackend`/idle timer/`getBackendInfo`)
  - [x] `executeImageGeneration` over backend; progress from backend events; error mapping
  - [x] busy claim single owner; POST guards (not-running, malformed JSON, usageMode)
  - [x] cancel (initiate, not await); crash handler; `stop()` ordering; lifecycle release (before stop)
  - [x] `getInfo().backend`/pid, `/health.backend`, `isHealthy()` wrapper-scoped; `ServerEvent` union
  - [x] `calibrate()` minimum adaptation
  - [x] tests — 3a: lifecycle (`DiffusionServerManager.lifecycle.test.ts`, 43 `it`s; old
    `DiffusionServerManager.test.ts` deleted; `electron-lifecycle.test.ts` adapted).
    3b: `…routes.test.ts` (31 `it`s), `…generation.test.ts` (51 `it`s),
    `diffusion-calibration.test.ts` re-based on the runner/client mocks (27 `it`s).
    Commit still pending.
  - [x] interim `/doublecheck` after 3b (3 read-only Opus reviewers: manager impl / HTTP+lifecycle
        invariants / tests+calibration harness) → fold fixes → commit Phase 3.
        Fixed: spawn-abort on release, release-reason rank upgrade, no-orphan cancel across the
        submit round-trip, sticky unconfirmed-PID respawn guard, split cold/warm load estimates,
        transient poll-failure tolerance, bar-line log filtering, stale-handle tap gating,
        cancellation → `'cancelled'`, plus a shared faithful `raceWithExit` test seam
        (`tests/unit/helpers/sd-server-mocks.ts`) and 51 new tests.
- Phase 4 — residency + orchestrator
  - [x] `resolveUsageMode`/`settleResidency`/callback; settle-once ownership
  - [x] orchestrator branches + `onDiffusionBackendReleased(reason)` + `orchestrateBatchGeneration`
  - [x] `LlamaServerManager.registerPreStartHook` (after `'starting'`); `prepareForLLMStart`; estimator override
  - [x] tests (orchestrator, llama hook, integration-style, lifecycle, idle timeout); commit pending
- Phase 5 — calibration
  - [x] `usageMode` single/burst sweep; `stageMs` semantics; `policyVersion`; VRAM sampling
  - [x] tests (29 → 39 in `diffusion-calibration.test.ts`); commit pending
- Phase 6 — docs/housekeeping
  - [x] user docs (`genai-electron-docs/**`) + `README.md` — parallel agent, plus a final
    corrections pass (residency/cancel wording, built-in vs custom orchestrator,
    `BACKEND_TERMINATION_UNCONFIRMED` and `CALIBRATION_IN_PROGRESS` entries, the wire-code table,
    `jobRequestTimeoutMs`, the calibration cost arithmetic, the `darwin-x64` / Linux-Vulkan
    platform notes)
  - [x] `DESIGN.md` (§7 "Update (2026-08-21)" + history note; process-model statements at the
    architecture bullet, manager list, flow walkthrough, DiffusionServer section, quick-start
    comments, and the stable-diffusion.cpp binary note)
  - [x] `docs/dev/UPDATING-BINARIES.md` (`sd-server` primary + `sd-cli` unused, Phase-2 validation
    through the runner/client + job API, `SD_SERVER_STDOUT_MARKERS` coupling note,
    re-validation-on-name-switch + POSIX chmod-before-revalidate, manual-test recipe, checklist item)
  - [x] `docs/dev/ESM-TESTING-GUIDE.md` (Pattern 4 repointed to `LlamaServerManager`; new Pattern 5
    for the shared `sd-server` seam — static helper import, faithful `raceWithExit`, fake job,
    `advanceTimersByTimeAsync`, launch-arg assertions; status table rows)
  - [x] `AGENTS.md` (architecture bullet, `src/process/` Node-safety note, binary strategy,
    residency + pre-start-hook + calibration Key Exports lines)
  - [x] `PROGRESS.md` `## Unreleased` section (change list, behavior changes, validation, smoke
    reference, migration/minor note, release status) — no version bump anywhere
  - [x] `docs/dev/2026-08-21_diffusion-architecture-review.md` implementation status line
  - [x] example app (`main/genai-api.ts` crash-note rationale, `main/ipc-handlers.ts` +
    `renderer/components/DiffusionServerControl.tsx` sd-cli wording, backend-state + "Backend PID"
    status rows, `ResourceMonitor.tsx` PID relabel)
  - [x] commit (main thread, after `npm run format` + the CI gates and the example-app build)
    — `482367c`
- Phase 7 — live smoke + doublecheck
  - [x] live checklist on pinned binary (S1–S11 passed on the final build; results below);
        `/doublecheck` (final, 3 reviewers → `816b0c0` + `76fc192`); status flipped

## Summary

Replace the per-image `sd-cli` spawn inside `DiffusionServerManager` with a persistent `sd-server`
child (already shipped in the pinned stable-diffusion.cpp zip and already extracted on every
user's disk) driven through its native async job API, **without changing the wrapper's HTTP
contract or the manager's public method/event surface**. The node:http wrapper remains the public
server; `sd-server` becomes an internal, lazily-spawned, optionally-resident backend. Residency is
a policy: `'single'` (release VRAM right after the image — default when the orchestrator had to
offload the LLM for it) vs `'burst'` (stay warm — default otherwise), and the orchestrator becomes
symmetric (an LLM start yields a resident diffusion backend when both don't fit). Calibration is
re-based on the same backend with a selectable mode (default `'single'` = cold per sample, the
common production case).

No stable-diffusion.cpp pin bump: `master-782-b290693` already has the full job API
(`POST /sdcpp/v1/img_gen` → 202, `GET /sdcpp/v1/jobs/{id}`, `POST …/cancel`,
`GET /sdcpp/v1/capabilities`, 64-deep queue → 429, 10-min result TTL → 410); the only later
server change upstream is an additive IP-Adapter field.

### Smoke-test reference (2026-08-21, RTX 4060 Laptop 8 GB, local cached build `master-746`,
klein 4B Q4_0 + Qwen3-4B Q4_0 + flux2-vae, 768², 4 steps, cfg 1, euler, seed 42)

| Config | spawn→listening | job 0 (cold) | jobs 1/2 (warm) | VRAM peak | idle after job |
|---|---|---|---|---|---|
| `--clip-on-cpu --diffusion-fa` (today's auto pick) | 2.4 s | 18.4 s | 15.3 / 15.7 s | 6597 MiB | 2851 MiB |
| `--diffusion-fa` (all resident) | 0.6 s | 11.4 s | 7.5 / 7.9 s | 7917 MiB | 5571–5677 MiB |
| `--offload-to-cpu --diffusion-fa` | 0.6 s | 11.2 s | 6.8 / 6.9 s | 4249 MiB | 503 MiB |
| `sd-cli` cold, `--clip-on-cpu --diffusion-fa` | — | 22.2 / 22.5 s | — | 6597 MiB | — |
| `sd-cli` cold, `--diffusion-fa` | — | 11.7 s | — | 7909 MiB | — |

Findings that shape this plan: burst saves ~33–39 % per image; single-shot `sd-server` ≈ `sd-cli`;
`--offload-to-cpu` is as fast warm with half the peak VRAM and ~0.5 GB idle; `sd-server` reads the
model files before `listening on:` but places weights lazily (the first job carries the byte-bar
uploads); stdout still prints the step bar and the `generating image:` / `decoding 1 latents` /
`decode_first_stage completed` literals (the `/4` in the step bar also proves `sample_steps`
round-trips — sd.cpp's default is 20); job JSON has no progress; `POST /sdcpp/v1/jobs/{id}/cancel`
→ 409 while generating; kill 150–580 ms, VRAM → 0. **The smoke ran on the cached `746` build; the
pinned `782` binary is re-verified in Phase 2/7** (`UPDATING-BINARIES.md:573` records 746 as the
last stdout-literal break).

## Scope

- **In scope**
  - New `src/process/sd-server-client.ts` (typed `/sdcpp/v1/*` client + request-body builder) and
    `src/process/sd-server-runner.ts` (spawn/ready/stdout tap/confirmed stop), both Node-safe.
  - Provisioning: `sd-server` as the primary validated binary; Phase-2 validation through the
    runner + client; POSIX exec-bit fix so existing installs re-validate without re-downloading.
  - `DiffusionServerManager`: backend state machine, `executeImageGeneration()` over the backend,
    progress mapping, cancel (kill), crash handling, `stop()` ordering, wrapper bound to
    `127.0.0.1` + `host` field, `startupTimeout`/`usageMode`/`idleTimeoutMs` config, additive
    `getInfo().backend`, `/health.backend`, `'backend-status'` event, `releaseBackend()`,
    synchronous busy claim, POST refused while not running, malformed JSON → 400.
  - `ResourceOrchestrator`: residency settle (release-before-reload, deferred reload for
    `burst`-after-offload), `prepareForLLMStart()` via a new `LlamaServerManager` pre-start hook,
    batch (`count > 1`) through the orchestrator, quit-time safety.
  - `calibrate()`: `usageMode` (default `'single'`), per-combo launches, `policyVersion`, per-run
    machine-wide VRAM peak/idle fields.
  - Tests (rewrite of `DiffusionServerManager.test.ts` split by concern, adapted calibration /
    orchestrator / BinaryManager / lifecycle tests, new client/runner tests, **new HTTP-level
    POST/GET route coverage**, one integration-style orchestrator test with a real
    `ResourceOrchestrator`).
  - Docs (user docs, DESIGN.md, UPDATING-BINARIES.md, ESM-TESTING-GUIDE, AGENTS.md, PROGRESS
    "Unreleased"), example-app comment fixes + a backend-state line.
- **Out of scope** (tracked separately; devlog §5/§8 items are listed so nothing is dropped silently)
  - Pin bump (no server benefit; 45 core-library commits of churn). `--max-vram` / `--stream-layers`
    exposure (both present at the cached 746 build per `--help`; exposure is a separate feature).
  - `--backend te=cpu,vae=cpu` spelling (deprecated-but-working flags kept); `darwin-x64` explicit
    error; `sd35LargePattern` expiry; Linux-NVIDIA-gets-Vulkan; Mage-Flow benchmark; per-model
    generation contracts; Z-Image second model; `calibrate()` as a binary-bump regression gate
    (`policyVersion` + VRAM fields here are its groundwork).
  - Dropping `gpuLayers` (kept as a documented no-op — removing it from `VALID_CONFIG_FIELDS` would
    be breaking). CORS `*` / no auth on the wrapper (bind fix only; auth is a separate design).
  - Queueing concurrent requests (keep 503 `SERVER_BUSY`); `preload`/`--eager-load` at `start()`;
    measured-VRAM orchestrator estimator (the VRAM fields added in Phase 5 are its input);
    a no-activity stuck-job timeout (client DELETE covers it today); VAE tiling/TAESD experiments;
    an Electron-free `sd-server-launch` subpath; a named `DiffusionEngine` abstraction (the
    runner/client pair is the de-facto seam; naming it is deferred).
  - Sweeping pre-existing `userData/temp/sd-output-*.png` leftovers (the leak itself disappears:
    results travel as base64 in JSON, no temp files).
  - Version bump, tag, npm publish, migration guide, release notes (release-time artifacts).

## Invariants (what must not change)

**Wire contract** read by genai-lite — checked against **genai-lite 0.19.0** at
`~/Documents/GitHub/genai-lite` (commit `44938f1`, `src/adapters/image/GenaiElectronImageAdapter.ts`,
`src/image/config.ts`), identical to the 0.11 vendored in the example app: `POST
/v1/images/generations` with `{prompt, negativePrompt, width, height, steps, cfgScale, seed, sampler,
count}` → any 2xx with `{id}`; `GET /v1/images/generations/:id` → `status ∈
{pending,in_progress,complete,error,cancelled}` + `progress.{currentStep,totalSteps,stage,percentage}`
/ `result.images[].{image(base64 png),seed,width,height}` + `result.timeTaken` /
`error.{message,code}`; `DELETE …/:id` answered within 5 s (body ignored). genai-lite never calls
`/health`, never retries (`retryable: false`), polls every 500 ms with no per-GET timeout → the
wrapper must always answer promptly (it does: the child is a separate process). Error codes at the
wire keep their meaning: `SERVER_BUSY`, `SERVER_NOT_RUNNING`, `NOT_FOUND`, `INVALID_REQUEST`,
`ALREADY_TERMINAL`, `BACKEND_ERROR`, `IO_ERROR`, `INTERNAL_ERROR`, `UNKNOWN_ERROR`. The
503-busy-gate semantics stay. `/health` (`{status:'ok', busy}`) is documented for users/curl; the
example app checks health via `diffusionServer.isHealthy()` over IPC, not HTTP.

**Manager surface** used by `examples/electron-control-panel/`: `start/stop/getInfo/isHealthy/
getStructuredLogs/clearLogs/getActiveGenerationId/cancelImageGeneration/calibrate/getConfig`;
events `started/stopped/crashed/binary-log/calibration-progress`; config keys `modelId, port,
clipOnCpu, vaeOnCpu, offloadToCpu, diffusionFlashAttention`; stage tokens
`loading|diffusion|decoding`; calibration table reads `run.stageMs?.{loadMs,diffusionMs,decodeMs}`
(optional chaining). All preserved. `ResourceOrchestrator.orchestrateImageGeneration(config)` →
`diffusionServer.executeImageGeneration(config)` stays the internal entry point (the 26 orchestrator
tests pin it; their plain-object mock gains methods).

**Behavior change to call out** (PROGRESS + docs): the wrapper binds `127.0.0.1` by default
(today all interfaces); hosts that relied on remote access must set `host`.

`LlamaServerManager`'s occupancy rail (`/health` + `/props` fingerprint on 8080–8083) is
unaffected: `sd-server` serves neither and is bound to an ephemeral `127.0.0.1` port.

## Target architecture

```
DiffusionServerManager (public server = node:http wrapper; status/events as today)
 ├─ GenerationRegistry (unchanged)
 ├─ ResourceOrchestrator (symmetric; residency settle; LLM pre-start hook)
 ├─ backend: { state: absent|starting|ready|busy|stopping, handle?, flags?, lastUsedAt, idleTimer }
 │    ensureBackend(flags) / releaseBackend({reason, waitForInFlight}) / settleResidency(mode)
 ├─ SdServerRunner (src/process/sd-server-runner.ts): spawn `sd-server` with model + context
 │    flags, `--listen-ip 127.0.0.1 --listen-port <free>`, `--lora-model-dir <owned dir>`,
 │    cwd = binary dir, never `--color`; ready = GET /sdcpp/v1/capabilities 200 (stdout
 │    `listening on:` is a hint only); line-buffered stdout/stderr tap → {type:'step'} |
 │    {type:'bytes'} | {type:'marker', marker: 'generating'|'decoding'|'decoded'|'completed'};
 │    bounded tails; exitPromise; stop() = kill + confirmed death
 └─ SdServerClient (src/process/sd-server-client.ts): capabilities(), submitImageJob(body),
      getJob(id), cancelJob(id); buildSdServerImageRequest(config) →
      { prompt, negative_prompt?, width?, height?, seed, batch_count,
        sample_params: { sample_steps?, sample_method?, guidance: { txt_cfg? } } }
      (fields omitted when undefined so sd.cpp defaults apply, exactly as argv omission does today)
```

Generation flow (single image): synchronous busy claim → 201 → `runAsyncGeneration` →
(orchestrator | direct) → `executeImageGeneration(config, flagOverrides?)`: seed normalize →
`computeDiffusionOptimizations(flagOverrides)` (still per call, so it sees the post-offload VRAM
landscape) → `ensureBackend(resolvedFlags)` (spawn if absent or flags differ; `'loading'` stage
while starting) → `submitImageJob` → poll job (200 ms) while the stdout tap drives `onProgress` →
`b64_json` → `Buffer` → `{image, format:'png', timeTaken, seed, width, height}`. The **owner of
the offload context** then settles residency exactly once (Phase 4). Offload flags, `-t`, and
model paths are launch args; prompt/size/steps/cfg/seed/sampler/batch are per-request JSON.

Backend release reasons (one enum, used by the event, the orchestrator callback, and tests):
`'single' | 'idle-timeout' | 'explicit' | 'flags-changed' | 'cancel' | 'crashed' | 'stop' |
'shutdown' | 'llm-start' | 'calibration'`.

## Phases

### Phase 1: Backend modules
**Goal**: Node-safe, independently testable client + runner; types/defaults/paths; no manager or
provisioning changes yet.

**Work**:
- `src/types/images.ts`: add `DiffusionUsageMode = 'burst' | 'single'`,
  `DiffusionBackendState = 'absent' | 'starting' | 'ready' | 'busy' | 'stopping'`,
  `DiffusionBackendReleaseReason` (enum above), `DiffusionBackendInfo { state; pid?; startedAt?;
  loadTimeMs?; lastUsedAt?; flags?: {clipOnCpu, vaeOnCpu, offloadToCpu, diffusionFlashAttention} }`,
  `DiffusionBackendStatusEvent { state; previous; reason?: DiffusionBackendReleaseReason | 'spawned'
  | 'ready' | 'job'; exit?: {code, signal} }`. Extend `DiffusionServerConfig` with `host?: string`
  (default `'127.0.0.1'`), `startupTimeout?: number` (backend spawn→ready; default
  `DEFAULT_TIMEOUTS.serverStart`), `usageMode?: DiffusionUsageMode | 'auto'` (default `'auto'`),
  `idleTimeoutMs?: number` (default `DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs`, `0` = never).
  Extend `ImageGenerationConfig` with `usageMode?: DiffusionUsageMode`. Extend
  `DiffusionServerInfo` with `backend?: DiffusionBackendInfo`; re-document `pid` as the backend PID
  when resident. Update the `batchSize` JSDoc (`:161-167`) to "maps to `batch_count`".
- Exports: add every new type to `src/types/index.ts` and the explicit type block in
  `src/index.ts` (`:374-390`); `DIFFUSION_BACKEND_DEFAULTS` to the constants block.
- `src/config/defaults.ts`: `DIFFUSION_BACKEND_DEFAULTS = { idleTimeoutMs: 300_000,
  jobPollIntervalMs: 200, readyTimeoutMs: DEFAULT_TIMEOUTS.serverStart, stopTimeoutMs:
  DEFAULT_TIMEOUTS.serverStop }`; `DIFFUSION_CALIBRATION_DEFAULTS` gains `policyVersion:
  'diffusion-offload-v2'` and `usageMode: 'single'` (**edit the annotated type literal at
  `:392-403` too**; absent `policyVersion` in persisted reports = pre-migration v1).
- `src/config/paths.ts`: `PATHS.loras` = `<userData>/loras`; add to `ensureDirectories()`
  (`:55-67`). The manager also `await ensureDirectory(PATHS.loras)` inside `ensureBackend()` before
  spawning (Electron side — keeps the runner Node-safe; the runner receives `loraDir` as an arg).
- `src/process/sd-server-client.ts`: `SdServerClient(port, host='127.0.0.1')` with
  `capabilities(signal?)`, `submitImageJob(body, signal?)` (202 → `{id}`; 429 → `ServerError`
  `details.code='BACKEND_QUEUE_FULL'`; 400 → `ServerError` with the server message), `getJob(id)`
  (typed `SdServerJob { id, status: 'queued'|'generating'|'completed'|'failed'|'cancelled',
  queue_position, result?: {output_format, images: [{index, b64_json}]}, error?: {code, message} }`;
  404/410 → typed errors), `cancelJob(id)` → `{ cancelled: boolean, httpStatus }` (409 → false);
  `buildSdServerImageRequest(config & {seed: number}, batchSize?)` → body above with
  `batch_count = batchSize ?? 1`. Uses global `fetch` (Node ≥ 22, as `health-check.ts` does). No
  Electron imports.
- `src/process/sd-server-runner.ts`: `startSdServerRunner({ binaryPath, modelArgs, contextArgs,
  threads?, loraDir, host: '127.0.0.1', port?: number | 'auto', readyTimeoutMs, processManager?,
  onStdoutEvent, signal })` → `SdServerHandle { pid, port, args, loadTimeMs (spawn→ready),
  stdoutTail, stderrTail, exitPromise, raceWithExit(op), stop(timeoutMs?) }`. Ready = first
  `capabilities` 200 (poll 150 ms → backoff ≤ 1 s); bind-collision retry once with a new free port
  (pattern from `llama-server-runner.ts:647-687`, `maxRunnerStartAttempts`); `stop()` = `child.kill()`
  → confirmed death, else throw `ServerError` with `details.code = 'SD_SERVER_TERMINATION_UNCONFIRMED'`
  and `details.pid` (Phase 2 maps it to `BinaryError` `BINARY_VALIDATION_TERMINATION_UNCONFIRMED`
  inside `BinaryManager`). Stdout tap: **line-buffered** (split on `\r`/`\n`, carry partial),
  emits `{type:'step', step, steps}` from `/\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/`
  with a `step > steps` guard (upstream #1884), `{type:'bytes', done, total}` from the
  `(?:B|KB|MB|GB)/s` bar, `{type:'marker', marker}` for `generating image:` / `sampling using` →
  `'generating'`, `decoding 1 latents` → `'decoding'`, `decode_first_stage completed` → `'decoded'`,
  `generate_image completed` → `'completed'`. Marker literals live in one exported constant table
  (`SD_SERVER_STDOUT_MARKERS`) — the log-format coupling is documented, not scattered.
- Lint guard: ESLint `no-restricted-imports` override for `src/process/**` forbidding `electron`
  and `../config/paths.js` (makes the Node-safety checkbox enforceable).
- Tests: `tests/unit/sd-server-client.test.ts` (body builder incl. omission of undefined fields
  and `batch_count`; response/typed-error mapping for 202/400/404/409/410/429),
  `tests/unit/sd-server-runner.test.ts` — **pure DI like `llama-server-runner.test.ts`** (injected
  `processManager`, `findFreePort`, `isPortBindable`, `fetchCapabilities`): argv shape incl.
  `--listen-ip 127.0.0.1`, `--lora-model-dir`, no `--color`; ready detection; tap line-buffering
  across chunk splits; `step>steps` guard; exit propagation; confirmed stop + unconfirmed error;
  startup abort.

**Verification**:
- [x] `npm run build` 0 errors; new tests green; lint rule rejects an `electron` import in
  `src/process/` (prove with a throwaway file, then delete it).
  Done 2026-08-21: build 0 errors, `npm run lint` 0 errors, `npm run format:check` clean,
  59 new tests (23 client + 36 runner), full suite 1147/1147 across 41 suites; the throwaway
  `src/process/__lint-probe.ts` produced both expected `no-restricted-imports` errors
  (`electron`, `../config/paths.js`) and was deleted.

### Phase 2: Binary provisioning
**Goal**: `sd-server` is the validated primary binary; Phase-2 validation exercises the production
launch path; existing installs re-validate without re-downloading on every platform.

**Work**:
- `DiffusionServerManager.ensureBinary()` (`:1062-1070`): `ensureBinaryHelper('diffusion',
  'sd-server', …)`; `BinaryManager.ts:912-916` extraction search names → `['sd-server.exe',
  'sd-server']` (exact-match locate; no accidental hits).
- `BinaryManager.runRealFunctionalityTest` (`:1287-1297`) → for `type === 'diffusion'` run
  `runSdServerTest`: `startSdServerRunner` with `testModelArgs + testOptimizationArgs`, ephemeral
  port, owned temp lora dir, ready timeout 120 s when `testModelArgs` is set (multi-component)
  else 15 s (as today); submit one 64×64 1-step job; pass iff job `completed` and no
  `GPU_ERROR_PATTERNS` hit in stdout/stderr tails; always confirmed-stop; a runner
  `SD_SERVER_TERMINATION_UNCONFIRMED` becomes `BinaryError` `BINARY_VALIDATION_TERMINATION_UNCONFIRMED`
  so `isValidationTerminationFailure` (`:72-80`) aborts the variant loop instead of downloading the
  next variant over a live child. Remove `.test-output.png` handling (`:1491`). Phase 1 (`--help`,
  5 s) unchanged — verified to work for `sd-server`.
- **POSIX exec bit**: the zip worker extracts without original permissions (`archive-utils.ts:215`,
  adm-zip writes `0o666`) and install chmods only the primary binary (`BinaryManager.ts:973-978`).
  In the existing-install branch (`:357-428`), `chmod 0o755` the primary binary on non-Windows
  **before** `testBinary` so the name switch yields re-validation, not "Existing binary not working,
  re-downloading". With that, existing installs on all platforms: `.validation.json.checksum`
  (the `sd-cli` digest) mismatches → re-validation only (`:380-397`); version unchanged → no
  re-download branch (`:363-376`); variant preserved (`:409`).
- `sd-cli` is no longer executed by the library (intermediate state: until Phase 3 lands, fresh
  POSIX installs would chmod only `sd-server` while the manager still spawns `sd-cli` — the phases
  land on one branch; Phase 2's live check is Windows).
- Tests: `BinaryManager.test.ts` diffusion Phase-2 test (`~:2050-2119`) → runner/client mocks,
  chmod-before-revalidate, termination-unconfirmed mapping; `defaults.test.ts` unchanged (pin
  unchanged).

**Verification**:
- [x] Build/lint/test green.
  Done 2026-08-21: build 0 errors, `npm run lint` 0 errors, `npm run format:check` clean,
  `BinaryManager.test.ts` 86/86 (7 new diffusion/chmod tests), full suite 1154/1154 across
  41 suites. The job budget reuses the ready budget (120 s multi-component / 15 s otherwise)
  as a second, independent clock; polling uses `DIFFUSION_BACKEND_DEFAULTS.jobPollIntervalMs`.
- [ ] Live (laptop; the cached 746 install is superseded by the 782 pin on first `start()`):
  provisioning downloads/validates `782` via `sd-server`; then re-run the smoke script against the
  **pinned binary** to confirm `/sdcpp/v1/*` shapes, 202/409 semantics, and the marker literals
  (a non-default `steps`, `sampler: 'euler_a'`, and `seed` must visibly change the stdout/outputs —
  guards the "omitted field silently falls back to sd.cpp defaults" hazard). Then delete
  `.validation.json` → `start()` re-validates with `sd-server` without re-downloading.

### Phase 3: `DiffusionServerManager` rewire
**Goal**: Same wrapper contract and public surface, `sd-server` underneath, lifecycle safe.

**Work** (`src/managers/DiffusionServerManager.ts` unless noted):
- Config: add `host`, `startupTimeout`, `usageMode`, `idleTimeoutMs` to `VALID_CONFIG_FIELDS`
  (`:98-109`). `start()`: resolve `host` (default `127.0.0.1`; `findFreePort(host)`,
  `checkPortAvailability(port, undefined, normalizeHealthHost(host))`), `httpServer.listen(port,
  host)` (`:1138`, raw host); keep `canRunModel(..., {checkTotalMemory: true})` (model still loads
  on demand). Registry destroy/recreate unchanged. `start()` never spawns the backend.
- Backend state machine: `ensureBackend(resolvedFlags, {signal})` — reuse if `ready` with equal
  flags; await if `starting`; await an in-progress `stopping` then spawn; `flags-changed` →
  release + respawn; refuse when `_status === 'stopping'`, or `'stopped'` unless `calibrating`;
  spawn via the runner with `buildDiffusionArgs` split into model args + `buildDiffusionOptimizationArgs(flags)`
  + `-t`; sets `loadStartTime` when a spawn begins; emits `'backend-status'`.
  `releaseBackend({ reason, waitForInFlight? })` — idempotent; sets `state = 'stopping'` **before**
  the kill so the exit handler treats the exit as intended; confirmed stop; clears the idle timer;
  emits with `reason`; the Phase-4 orchestrator callback hangs off this (not wired in this phase).
  Idle timer armed by `settleResidency('burst')` (Phase 4), disarmed on job start/`stop()`.
  `getBackendInfo()`.
- `executeImageGeneration(config, flagOverrides?)` (signature unchanged): as in "Target
  architecture". Progress: keep `initializeProgressTracking`, the self-calibrating time model
  (`modelLoadTime`, `diffusionTimePerStepPerMegapixel`, `vaeTimePerMegapixel`,
  `calculateOverallPercentage`, `updateTimeEstimates`, `reportProgress`,
  `startSyntheticVaeProgress`) and feed it from backend events instead of chunk regexes:
  `loadStartTime` = spawn start (cold) or job submit (warm); `'generating'` marker or first step →
  `loadEndTime` set **unconditionally**, stage → internal `'diffusion'`; `'decoding'` marker (or
  last step reached while the job is still running) → internal `'vae'` (wire token `'decoding'`,
  unchanged); `'decoded'`/job `completed` → `vaeEndTime`. Delete the chunk-level
  `processStdoutForProgress` block. `cleanupSyntheticProgress()` must be called on job
  completed/failed/cancelled, backend exit, `releaseBackend()`, and `stop()` (its old call sites
  were the spawn `onExit`/`onError`).
  Errors: job `failed` → reject `ServerError('stable-diffusion.cpp job failed: …', { code:
  'BACKEND_JOB_FAILED', backendError, args, stderr: <stderrTail>, stdout: <stdoutTail> })` (stderr
  kept so `classifyCalibrationFailure`/`oomPatterns` still see it); backend exit mid-job → reject
  `ServerError('stable-diffusion.cpp exited with code …', {exitCode, stderr: tail, args})`; base64
  decode failure → `ServerError('Failed to decode generated image', …)` (keeps `IO_ERROR`
  reachable). `mapErrorCode`: check `error.details?.code` first (`BACKEND_JOB_FAILED`,
  `BACKEND_QUEUE_FULL` → `BACKEND_ERROR`; `GENERATION_CANCELLED` etc.), then the existing substring
  fallbacks; top-level `ServerError.code` stays `'SERVER_ERROR'` (details carry the discriminant).
- Busy claim: **one owner** — `handleStartGeneration`/`generateImage()` create the claim
  synchronously (after validation, before `registry.create`/any `await`) and release it in a
  `finally` in `runAsyncGeneration`/`generateImage()`; `executeImageGeneration` only *refines*
  the claim's `cancel` once a job is submitted and never clears it (so batch loops keep the gate
  closed between images); a cancel arriving before submit latches a flag checked right after
  submit (today's `activeGeneration.cancelled` role). POST while `_status !== 'running'` → 503
  `SERVER_NOT_RUNNING`. Malformed JSON → 400 `INVALID_REQUEST` (today 500). `usageMode` in the
  body must be `'burst'|'single'` if present (else 400); `count` 1–5 unchanged.
- Cancel: `cancelImageGeneration(id)` → queued job → `client.cancelJob`; generating →
  `releaseBackend({reason:'cancel'})` **initiated, not awaited to confirmed death**: the job is
  rejected (`'cancelled'` status) and the promise resolves immediately; the DELETE route answers
  200 at that point; the confirmed-death wait continues under `state: 'stopping'` and
  `ensureBackend` awaits it before any respawn. Cost equals today's (next image reloads).
- Crash: runner `exitPromise` handler → if `state !== 'stopping'`: fail the in-flight job, state
  `absent`, emit `'backend-status'` `{reason:'crashed', exit}`; wrapper stays `running`; no
  `'crashed'` emission (that event keeps meaning "the server is down").
- `stop()`: before the early-return-when-stopped, always `releaseBackend({reason:'stop'})` (covers a
  backend left by `calibrate()`); full order: `setStatus('stopping')` (POST guard closes) → reject
  in-flight job → release backend (confirmed) → close http → destroy registry → `'stopped'`.
- `src/utils/electron-lifecycle.ts`: **before** the status-conditional `stop()`, always
  `await managers.diffusionServer?.releaseBackend({ reason: 'shutdown' })` (Phase 4 makes
  `'shutdown'` suppress any LLM reload; ordering matters because `stop()`'s own release carries
  reason `'stop'`, which *does* reload a deferred LLM — by then the backend is already absent, so
  no reload races `app.exit(0)`). Also covers a backend left alive by `calibrate()` (status
  `'stopped'`, so the conditional `stop()` is skipped).
- `getInfo()`: `busy` unchanged; add `backend`; `pid` = backend PID when resident. `/health` →
  `{status:'ok', busy, backend: state}`. **`isHealthy()` stays wrapper-scoped** (`running &&
  httpServer`) — backend residency is not wrapper liveness (a `'single'` release after every image
  must not flip the example app's 3 s health poll).
- `ServerEvent` union (`src/types/servers.ts:428-437`): add `'backend-status'` and declare the
  already-emitted `'calibration-progress'` (deliberate reversal of `PLAN-diffusion-calibration.md`'s
  "don't touch `servers.ts`" note — `emitEvent` takes `data?: unknown`, so it is purely additive).
- `calibrate()` minimum adaptation so the build stays green: `runCalibrationGeneration` works
  through `executeImageGeneration` → `ensureBackend(combo)`; `finally` also
  `releaseBackend({reason:'calibration'})` (Phase 5 finishes semantics).
- Tests — split `tests/unit/DiffusionServerManager.test.ts` (81 `it`s) into:
  `…lifecycle.test.ts` (start/stop incl. **assert `listen(port, host)` args**, host override,
  config allowlist incl. new fields, backend state transitions, idle timer, crash → job error +
  wrapper still running, intentional kill ≠ crash, `stop()` releases a calibration-era backend,
  `getInfo().backend/pid`, `isHealthy()` unchanged by releases);
  `…routes.test.ts` (OPTIONS/404/health incl. `backend`; **POST 201 shape, 400 missing prompt /
  bad count / bad usageMode / malformed JSON, 503 busy proven by two back-to-back POSTs (sync
  claim), 503 not-running; GET pending/in_progress/complete/error/cancelled payloads; DELETE
  200/404/409 answered without awaiting confirmed death**);
  `…generation.test.ts` (request-body mapping incl. undefined omission and `batch_count`, progress
  mapping and stage transitions, `loadMs` present cold and warm, time model still calibrates, error
  mapping incl. details-code-first, cancel-kill, pre-submit cancel latch, batch loop seeds + gate
  held between images, no temp files). Mock `sd-server-runner`/`sd-server-client` modules via
  `unstable_mockModule`; update shared mocks: `listen` mock must accept `(port, host, cb)`; the
  `config/paths.js` mock gains `getBinaryPath` and `PATHS.loras`. Migration map for the old file:
  **migrated** — DELETE 200/404/409 (`:1527-1572`), `/health`/OPTIONS/404 (`:1410-1462`), config
  allowlist, logs, `getInfo`; **deleted** — the stdout-chunk `progress calibration` block
  (`:847-1237`), `image file cannot be read` (`:784`), the stderr-window trio (`:718-796`);
  **repointed** — `should not pass --n-gpu-layers` (`:797`) to launch args, VRAM-flag and
  multi-component argv assertions to launch args. `tests/unit/diffusion-calibration.test.ts`
  (24 `it`s) must move to runner/client mocks in **this** phase (its `installAutoSpawn` harness
  `:246-283`, `mockReadFile` `:302`, stdout fixtures `:622-629`/`:645-651` are spawn-per-image);
  keep spawn-count/mode semantics for Phase 5. `tests/unit/electron-lifecycle.test.ts`: mock gains
  `releaseBackend`; assert it is called. Keep `GenerationRegistry`, `pickRecommended`, logs tests
  untouched.

**Verification**:
- [x] Build/lint/test green; `ResourceOrchestrator.test.ts` unchanged and green (26/26).
  Phase 3a (2026-08-21, implementation + lifecycle test): build 0 errors, `npm run lint`
  0 errors, `format:check` clean, `ResourceOrchestrator.test.ts` 26/26 untouched, full suite
  1099/1099 across 40 suites — **`diffusion-calibration.test.ts` is deliberately red until
  3b** (suite fails to load: its `health-check.js` mock lacks `formatHttpHost`, and its
  `installAutoSpawn` harness is spawn-per-image).
  Phase 3b (2026-08-21, tests): build 0 errors, `npm run lint` 0 errors (114 pre-existing
  warnings), `format:check` clean, full suite **1208/1208 across 43 suites**
  (routes 31 + generation 51 + calibration 27 new/re-based; `ResourceOrchestrator.test.ts`
  26/26 still untouched). No `src/` change was needed: three deliberate mutations
  (drop the poll-loop VAE fallback, make the POST busy claim asynchronous, ignore
  `details.code` in `mapErrorCode`) each fail the new suites. Calibration launch counts
  now follow distinct flag sets in sequence (6 default combos → 6 launches).
  Phase 3 doublecheck (2026-08-21, 3 read-only Opus reviewers): **25 findings — 14
  implementation, 11 test-coverage; all fixed, none deferred.** Implementation: abort an
  in-flight spawn on release (`stop()` no longer waits out a cold load); rank release reasons so
  a `stop()` behind a `'cancel'` reports `'stop'`; never race `submitImageJob` against the abort
  promise (a cancel mid-round-trip cancels the accepted job instead of orphaning it); a
  `SD_SERVER_TERMINATION_UNCONFIRMED` kill records a sticky PID that blocks the next spawn while
  it is alive (`BACKEND_TERMINATION_UNCONFIRMED` → wire `BACKEND_ERROR`); separate cold
  (`modelLoadTime`) and warm (`warmLoadTime`) load estimates so a cold generation after warm
  ones cannot regress from 100 % to 40 %; tolerate 2 consecutive transient job-poll failures
  (`DIFFUSION_BACKEND_DEFAULTS.maxTransientPollFailures`); keep progress-bar redraws out of the
  log file (`isSdServerProgressBarLine`); gate the stdout tap on the emitting handle; guard the
  `'backend-status'` emit and the exit watcher; hoist `cleanupSyntheticProgress()` in
  `releaseBackend`; identity-check `inFlight`/`progressConfig`; `'start-failed'` (not
  `'crashed'`) for a spawn that never became ready; `getPid()` override; cancellation maps to
  `'GENERATION_CANCELLED'` and registry `'cancelled'`; `electron-lifecycle` wraps
  `releaseBackend` in its own try/catch. Tests: shared faithful backend seam
  (`tests/unit/helpers/sd-server-mocks.ts` — `raceWithExit` really races observed exit),
  imported statically by all four suites; new coverage for poll-loop termination, spawn
  concurrency, unconfirmed termination, spawn failure/abort, a wire error-code table, mid-poll
  errors, synthetic-VAE teardown, `waitForInFlight`, the three dropped lifecycle tests, stale
  stdout, `getActiveGenerationId`, library defaults, post-crash recovery, and the
  cold→warm→cold progress sequence. Full suite **1259/1259 across 43 suites** (was 1208);
  build 0 errors, lint 0 errors (114 pre-existing warnings), `format:check` clean.
- [ ] Live (Phase 7): `netstat -ano | findstr :8081` shows a `127.0.0.1` listener.

### Phase 4: Residency policy + symmetric orchestrator
**Goal**: `'single'`/`'burst'` semantics, release-before-reload, deferred reload, LLM-start yield,
batch through the orchestrator, quit-time safety.

**Work**:
- Manager: `resolveUsageMode(requestMode, llmWasOffloaded)` = request > `config.usageMode` (if not
  `'auto'`) > (`llmWasOffloaded ? 'single' : 'burst'`); `settleResidency(mode)` = `'single'` →
  `releaseBackend({reason:'single'})`; `'burst'` → arm idle timer. **Settle exactly once per
  generation, by the component that owns the offload context**: `runAsyncGeneration`/
  `generateImage()` settle only in the no-orchestrator branch (single and batch); with an
  orchestrator, `orchestrateImageGeneration`/`orchestrateBatchGeneration` settle in both of their
  branches. Manager `releaseBackend()` calls `orchestrator?.onDiffusionBackendReleased(reason)`
  after confirmed death — the Phase-3 seam `onBackendReleased(reason)` already delivers the
  FINAL, rank-upgraded reason (a `stop()` that joined a `'cancel'` release reports `'stop'`), so
  the reason filter can be written against it directly. `settleResidency('burst')` also takes
  ownership of `armIdleTimer()`, which Phase 3 arms from `executeImageGeneration`'s `finally`.
- `ResourceOrchestrator.orchestrateImageGeneration`: offload branch → after result/error:
  `mode = diffusionServer.resolveUsageMode(config.usageMode, true)`; `await
  diffusionServer.settleResidency(mode)`; `mode === 'single'` → `fireAndForgetReload()`
  (release-before-reload — closes the unnumbered finding "No diffusion cleanup before reload",
  `ISSUE-orchestrator-reload.md:321-338`, which never got a numbered fix); `'burst'` → keep
  `savedLLMState`, **no** reload now. Non-offload branch → `settleResidency(resolveUsageMode(
  config.usageMode, false))`. `onDiffusionBackendReleased(reason)`: acts only for reasons
  `'idle-timeout' | 'explicit' | 'crashed' | 'stop'` (ignores `'single'` — the branch above is the
  sole reload trigger there, so no double reload — and `'llm-start' | 'shutdown' | 'calibration' |
  'cancel' | 'flags-changed'`), and only if `savedLLMState && !pendingReload &&
  !diffusionServer.isCalibrating()` → `fireAndForgetReload()`. Document on `waitForReload()` that
  under `'burst'`-after-offload the LLM is intentionally still down until the backend is released.
- New `orchestrateBatchGeneration(config)`: same offload window around
  `diffusionServer.executeBatchGeneration(config)`; `runAsyncGeneration` routes `count > 1`
  through it (closes the Phase-2-era gap; per-image loop kept: `seed+i`, per-image progress, cancel
  between images).
- `LlamaServerManager`: `registerPreStartHook(hook: (ctx: { config: LlamaServerConfig; reason:
  'start' | 'auto-restart' }) => Promise<void>): () => void`. Hooks run **inside `start()`'s
  `try`, after `const startupGeneration = ++this.processGeneration; this.setStatus('starting')`
  (`:681-683`) and after `normalizeContextConstraints` (`:668`), before port resolution** — so the
  concurrency guard already rejects re-entrant starts while a hook awaits, and hook errors flow
  through `handleStartupError` (status reset; `GenaiElectronError` subclasses preserved). On the
  auto-restart path a hook error is logged and ignored (must not consume restart budget).
  `DiffusionServerManager` registers the hook in its constructor when `llamaServer` is given
  (`:178-180`), keeping the unregister handle (replace on re-registration).
- `ResourceOrchestrator.prepareForLLMStart({config})`: no-op unless the diffusion backend is
  resident; reuse the 75 % arithmetic via `needsOffloadForImage(llmConfigOverride?)` refactor
  where `estimateLLMUsage(configOverride?)` **skips both the `isRunning()` early return and
  `getConfig()` when an override is passed** (today `:248-251` returns zeros when the LLM isn't
  running, which would make the hook a permanent no-op); if both don't fit →
  `await diffusionServer.releaseBackend({ reason: 'llm-start', waitForInFlight: true })` (reason
  suppresses the callback → no reload from inside the hook).
- Quit-time: `electron-lifecycle` releases with `reason: 'shutdown'` (Phase 3) — suppressed in
  `onDiffusionBackendReleased`, so no `llamaServer.start()` races `app.exit(0)`.
- `needsOffloadForImage()` arithmetic unchanged for image requests (conservative; a resident
  backend may trigger an offload/reload cycle — accepted; measured-VRAM estimator is a follow-up;
  see Risks "ping-pong").
- Tests: `ResourceOrchestrator.test.ts` — plain-object diffusion mock gains `resolveUsageMode`,
  `settleResidency`, `releaseBackend`, `isCalibrating`, `executeBatchGeneration`,
  `getBackendInfo`; new tests: release-before-reload ordering; `burst` defers reload until a
  qualifying `onDiffusionBackendReleased`; reason filtering (`'single'`/`'llm-start'`/`'shutdown'`
  never reload; `'idle-timeout'`/`'explicit'`/`'crashed'`/`'stop'` do); explicit request/
  server-level overrides; batch orchestration; `prepareForLLMStart` (fits → no release; doesn't
  fit → release; waits for in-flight; estimate uses the override, not `isRunning()`). **One
  integration-style test** with the real `ResourceOrchestrator` + a fake `LlamaServerManager`
  whose `start()` counts calls and honours the status guard, asserting exactly one reload in the
  single path and zero from inside the hook. `LlamaServerManager.test.ts`: hook runs after
  `'starting'`, concurrent start rejected while a hook awaits, error propagates, unregister works,
  auto-restart hook error non-fatal. Mocks: `mockLlamaServer` objects in
  `diffusion-calibration.test.ts:919-933` and the manager tests gain `registerPreStartHook`.
  Manager tests: idle timeout fires → `absent` + event.

**Verification**:
- [x] Build/lint/test green.
  Done 2026-08-21: build 0 errors, `npm run lint` 0 errors (114 pre-existing warnings — no new
  ones), `npm run format` + `format:check` clean, full suite **1321/1321 across 44 suites**
  (was 1260/1260 across 43). Per suite: `ResourceOrchestrator.test.ts` 26 → 58 (the 26 originals
  needed no assertion changes — only the plain-object mock gained
  `resolveUsageMode`/`settleResidency`/`releaseBackend`/`isCalibrating`/`executeBatchGeneration`/
  `getBackendInfo`), new `ResourceOrchestrator.integration.test.ts` 5,
  `LlamaServerManager.test.ts` 110 → 117, `DiffusionServerManager.lifecycle.test.ts` 60 → 65,
  `DiffusionServerManager.generation.test.ts` 63 → 72, `diffusion-calibration.test.ts` 27 → 29,
  `electron-lifecycle.test.ts` 15 → 16. Five deliberate mutations each fail the new suites:
  accepting every release reason in `onDiffusionBackendReleased` (8 failures), reloading before
  the settle (ordering test), keeping the `isRunning()` short-circuit under an estimator override
  (4 `prepareForLLMStart` failures), re-arming the idle timer inside `executeImageGeneration`
  (1 failure), and dropping the no-orchestrator settle (3 failures).
- [x] Scenario tests pass (unit/integration level; the live runs stay in Phase 7):
  (LLM running, 8 GB) image → offload → generate → release → reload — exactly one reload, backend
  killed before `llama-server` restarts; `usageMode:'burst'` → backend stays, reload deferred,
  fires on idle timeout **and** on an explicit release; LLM start with a resident backend → yield
  via the pre-start hook (release reason `'llm-start'`, no reload from inside the hook), and
  coexist untouched when both fit. `electron-lifecycle` quit releases with `'shutdown'` and starts
  nothing (with the same saved state, a follow-up `'stop'` does reload — the control assertion).

### Phase 5: Calibration re-base
**Goal**: `calibrate()` measures the mode the caller selects; default `'single'` (cold per
sample) = the common production case and today's report semantics; `'burst'` opt-in.

**Work**:
- `DiffusionCalibrationConfig.usageMode?: DiffusionUsageMode` (default
  `DIFFUSION_CALIBRATION_DEFAULTS.usageMode = 'single'`).
  - `'single'`: per combo → one discarded warmup (cold spawn → generate → release; primes the OS
    page cache and the variant) → per size, per sample: `releaseBackend({reason:'calibration'})`,
    T0, `ensureBackend(combo)`, generate, T1, release (untimed). `timeTakenMs` = median of (T1−T0)
    = cold single-shot latency.
  - `'burst'`: per combo → `ensureBackend(combo)` once, one discarded warmup at `sizes[0]`
    (absorbs lazy weight placement), then per size `samples` warm generations, release at combo
    end. `timeTakenMs` = warm median.
  - Both: `stageMs` keeps its trio with the Phase-3 timestamps: `loadMs` = `loadStartTime` (spawn
    in single / job submit in burst) → `'generating'` marker; `diffusionMs` = generating →
    decoding; `decodeMs` = decoding → decoded. Document that in burst runs `loadMs` is the small
    pre-sampling time (conditioning), not a model load. This reverses `PLAN-diffusion-calibration.md`
    agreed decision 1 ("No restarts") — unavoidable now that offload flags are launch args; the
    runner's ephemeral port bind + collision retry covers the port churn.
- Report: `usageMode` echo, `policyVersion: 'diffusion-offload-v2'`, and per-run
  `vramPeakBytes?` / `vramIdleBytes?`: sample via `createTelemetrySnapshotCapture()`
  (`src/utils/llama-resource-guard-capture.ts:269-321`, which already encodes "VRAM is trusted only
  when a fresh `getGPUInfo()` supplies a finite `vramAvailable`"), only when
  `gpu.vramAvailable !== undefined` and not on `darwin`, at a 1 s interval during the timed window
  (each sample spawns `nvidia-smi`; the load is GPU-bound so the perturbation is negligible — if
  Phase 7 shows >2 % timing drift with sampling on, fall back to before/after samples only);
  `vramPeakBytes = vramTotal − min(vramAvailable)` (machine-wide, ~1 s resolution),
  `vramIdleBytes = vramTotal − vramAvailable` after release (single) / after the job (burst);
  omitted when untrusted. `machine` block unchanged.
- Sweep orchestration unchanged (stopped server required, one LLM offload for the whole sweep,
  `finally` reload, abort contract `CALIBRATION_ABORTED`); `onDiffusionBackendReleased` ignores
  `'calibration'` and is suppressed while calibrating. `generation.batchSize` still reaches the
  request as `batch_count`.
- Progress: `totalUnits` unchanged; phases unchanged.
- Tests (`tests/unit/diffusion-calibration.test.ts`): launch counts per mode (`single`: launches =
  combos × (1 + samples × sizes); `burst`: launches = combos), warmup discard, median, `stageMs`
  per mode (rewrite fixtures `:622-629`/`:645-651` and the spawn-count assertion `:535`),
  `policyVersion`/`usageMode` echo, VRAM fields present when trusted / omitted otherwise, OOM
  classification from a failed job (via `details.stderr`) and from a process exit, abort
  mid-launch, state restore, LLM offload ordering.

**Verification**:
- [x] Build/lint/test green.
  Done 2026-08-21: build 0 errors, `npm run lint` 0 errors (114 pre-existing warnings — no new
  ones), `npm run format` + `format:check` clean, full suite **1331/1331 across 44 suites**
  (was 1321/1321; `diffusion-calibration.test.ts` 29 → 39). The "worker process has failed to
  exit gracefully" line stays pre-existing (see `PLAN-diffusion-calibration.md:229`); the suite
  reports no open handles under `--detectOpenHandles`.
  Implementation notes: `timeTakenMs` reuses `executeImageGeneration`'s own total (it clocks
  from before `ensureBackend()`, so a cold sample already contains spawn + weight load — no
  second stopwatch around the call); the release that makes a `'single'` sample cold happens
  BEFORE the timed window and again in a `finally` after it (so a failed warmup/sample also
  leaves no backend), each with reason `'calibration'` (ignored by the orchestrator's reload
  filter, and additionally suppressed by `isCalibrating()`); `'burst'` releases once per combo
  after its sizes. The release-before-sample opened a new abort window, so the signal is
  re-checked immediately after it in both the warmup and the sample path. VRAM comes from a
  private `CalibrationVramSampler` fed by `createTelemetrySnapshotCapture()` over a GPU-only
  source adapter (`refreshMemoryTelemetry` stubbed `'not-required'` — the sweep never compares
  host memory), gated once per sweep on `process.platform !== 'darwin'` + a fresh
  `getGPUInfo()` with a finite `vramAvailable`/`vram`; 1 s unref'd interval plus a reading at
  each window edge, `peak = vramTotal − min(vramAvailable)`, `idle = vramTotal − vramAvailable`
  from one extra reading taken after the release (`'single'`) or right after the job
  (`'burst'`); any unusable reading omits BOTH fields, nothing ever throws into the sweep, and
  `dispose()` runs first in `calibrate()`'s `finally`. Both figures are taken from the same
  representative sample as `stageMs` (closest to the median).
  Five deliberate mutations each fail the suite: leaking the sampler interval (fake-timer
  `getTimerCount()` test), dropping the post-release abort re-check, inverting the peak
  arithmetic to a maximum, flipping the default mode to `'burst'`, and (implicitly, via the six
  launch-count assertions) making `'single'` reuse a warm backend.
- [ ] Live (Phase 7): short sweep (2 combos × 1 size × 2 samples) in each mode on the laptop;
  `single` medians ≈ 11 s / `burst` ≈ 7 s for the offload combo; `loadMs` present in both (large
  cold, small warm); report carries `policyVersion` and VRAM fields; timing with sampling on vs
  off within 2 %.

### Phase 6: Documentation and housekeeping
**Work**:
- `genai-electron-docs/image-generation.md`: process-model statements (`:3`, `:10`, `:24`, `:97-99`,
  `:134`, `:228`, `:284-292`, `:409`, `:487`), `start()` config list (`:26`: `host`, `startupTimeout`,
  `usageMode`, `idleTimeoutMs`; `gpuLayers` no-op note kept), POST request fields (`:173`:
  `usageMode`), `/health` shape (`:252`), `getInfo()` fields (`:425`: `backend`, `pid` semantics),
  batch-bypass note (`:272` — now orchestrated), Phase-2 validation mechanism (`:493-496`, `:505`),
  cancel semantics (queued vs generating), crash behavior, `releaseBackend()`, `'backend-status'`,
  calibration modes + `policyVersion` + VRAM fields, the `127.0.0.1` default bind.
- `genai-electron-docs/resource-orchestration.md`: residency policy, release-before-reload,
  deferred reload, symmetric LLM-start yield, batch now orchestrated (`:102`), `:61-73` cycle,
  `waitForReload()` caveat.
- `troubleshooting.md` (`:161-169`, `:235-247`; `:463` still holds), `system-detection.md`
  (`checkTotalMemory` rationale wording `:251/:261/:280`), `typescript-reference.md`
  (`DiffusionServerInfo :522-537`, `DiffusionServerConfig :539`, `ImageGenerationConfig :1438`,
  calibration types `:1590-1633`, new types), `index.md` (`:78` feature bullet, `:346` "spawns
  stable-diffusion.cpp", `:388` version-pairing paragraph: no genai-lite change required),
  `example-control-panel.md:740` ("kills the running sd-cli process"), `integration-guide.md`
  (`:77-93`, `:380-399` `attachAppLifecycle` now also releases the backend), `README.md:15`,
  `AGENTS.md` (`:45` Architecture bullet; Key Exports calibration/offload lines). **Migration
  guides (`migration-*.md`) are frozen history — do not edit** (`migration-0-5-to-0-6.md:487`
  stays).
- `DESIGN.md` §7 (`:1145-1222`) + `:96`, `:254-259`, `:400-403`, `:548-552`, `:810`, `:818`, `:1669`:
  record that the "native server" trigger fired and the wrapper now fronts `sd-server`; keep the
  rationale history.
- `docs/dev/UPDATING-BINARIES.md:570-580`: `sd-server(.exe)` is the primary binary, `sd-cli` unused
  (`:570` DLL note reworded); the log-format coupling note (`:573`) now points at
  `SD_SERVER_STDOUT_MARKERS`; re-validation-on-name-switch note.
- `docs/dev/ESM-TESTING-GUIDE.md:206-260` patterns 3–4 + status table `:390`: repoint to the new
  test seams.
- `PROGRESS.md`: add `## Unreleased` above the v0.24.0 entry (release-workflow convention) with
  the change list (incl. the `127.0.0.1` default-bind behavior change and the one-time
  re-validation), validation line placeholder, and the smoke reference numbers.
- `examples/electron-control-panel`: update the rationale in `main/genai-api.ts:76-77` (the
  "does not emit `'crashed'`" claim stays true; the "not a persistent process" reason does not);
  delete the `sd-cli` mentions at `main/ipc-handlers.ts:317-318` and
  `renderer/components/DiffusionServerControl.tsx:233-234`; add a backend-state line to the status
  panel (reads `getInfo().backend?.state`); no calibration mode selector (out of scope).
- Update this plan's phase checklist as work lands.

**Verification**:
- [ ] `npm run format`, `npm run format:check`, `npm run lint`, `npm run build`, `npm test`,
  `git diff --check` green; `npm --prefix examples/electron-control-panel run build` green.
  Note (2026-08-21): the dev-doc / PROGRESS / DESIGN / AGENTS / example-app half landed in a
  parallel agent alongside the `genai-electron-docs/**` + `README.md` half; neither ran the gates.
  The example app resolves `genai-electron` as `file:../..`, so the root `npm run build` must run
  BEFORE its build for `DiffusionServerInfo.backend` to type-check in the renderer. Prettier
  ignores `*.md`; only the two `.tsx`/`.ts` example files need `npm run format`.
- [x] Documentation content verified against the implementation at `b5706c1` (public method names,
  `DIFFUSION_BACKEND_DEFAULTS`, `SD_SERVER_STDOUT_MARKERS`, `runSdServerTest`, the wire error codes,
  and the calibration report fields were all read from `src/` rather than from this plan).

### Phase 7: Live smoke (main thread, single heavy slot) + `/doublecheck`
- Against the **pinned 782 binary** on the laptop, via the example app (genai-lite path): start
  wrapper (`netstat` shows `127.0.0.1:8081`); cold ≈ 11 s, second image warm ≈ 7 s with the
  offload combo; cancel mid-job → `cancelled` within ~1 s, next request works; `taskkill /F` the
  `sd-server` PID mid-job → job `error` (`BACKEND_ERROR`), wrapper still `running`, next request
  respawns; with the LLM running: image → LLM offloaded → image → LLM back, `nvidia-smi` shows
  release before reload; `usageMode:'burst'` via the Node API keeps the backend and defers reload;
  start LLM while backend resident → yield; `attachAppLifecycle` quit kills the backend and starts
  no LLM; calibration short sweep both modes; Phase-2 re-validation after deleting
  `.validation.json`; **deliberate OOM probe** (e.g., 2048² all-resident) to learn whether
  `sd-server` surfaces OOM as a failed job or a process exit and confirm classification.
- `/doublecheck` with read-only Opus reviewers (core impl / API + docs / tests + example) + the
  CI gate in the main thread; fold findings back in; flip `Status:`.

**Live smoke results (2026-08-21, RTX 4060 Laptop 8 GB, pinned `master-782-b290693`, klein 4B
Q4_0, 768² / 4 steps / cfg 1 / euler unless noted; harness = `scripts/live-smoke/sd-server-live-smoke.mjs`,
an Electron main-process script reusing the example app's `userData`, HTTP path identical to
genai-lite's adapter; see `scripts/live-smoke/README.md`):**

| Step | Result |
|---|---|
| S1 provisioning (746 cache → 782 download) + `sd-server` Phase-1/2 validation | ✓ 8.7 min incl. download; validation ~10 s; second run 3.2 s (cached) |
| S2 cold HTTP generation | ✓ 16.5 s first-ever run (cold page cache), 10.3–12.2 s afterwards; `absent → starting → ready → busy → ready` |
| S3 warm HTTP generation (burst default) | ✓ 6.3–6.9 s, peak 4249 MiB |
| S4 cancel mid-generation | ✓ DELETE answered on initiation, `stopping:cancel → absent:cancel`, next request respawns |
| S5 `taskkill` backend mid-job | ✓ job `error` (`BACKEND_ERROR`), `absent:crashed {code:1}`, wrapper `running`, respawn |
| S6 idle timeout (5 s) | ✓ `stopping:idle-timeout` after the window |
| S7 LLM cycle | ✓ `llm-start` yield 0.5 s after `llamaServer.start()` (after the H6 fix; the pre-fix run never yielded); offload → generate 11 s → `single` release → reload (release precedes reload); `usageMode:'burst'` keeps the backend, reload deferred; `releaseBackend()` → `explicit` → reload |
| S8 `stop()` with resident backend | ✓ `stopping:stop → absent:stop`, VRAM 0 |
| S9 calibration `single` / `burst` (512², 2 combos × 2 samples) | ✓ single: offload 7.1 s, all-resident 6.3 s, VRAM peak 3.2 / 6.3 GB, idle 0.24 GB; burst: 3.46 / 2.86 s, idle 0.6 / 6.2 GB; `policyVersion` + `usageMode` echoed; backend released |
| S10 re-validation (`.validation.json` deleted) | ✓ Phase 1 + Phase 2 via `sd-server` in 8 s, no download |
| S11 "OOM probe" 2048² all-resident | did not OOM (peak 7885 MiB, still sampling at 180 s) → exercised cancel-of-a-long-job (`stopping:cancel` → `stop` upgrade); OOM classification stays unit-tested only |

Follow-up from S9: `sampling using` was dropped from the `generating` marker mapping (sd-server
prints it at job start, before conditioning/weight upload), so `stageMs.loadMs` now spans spawn →
`generating image:`.

**Final doublecheck (2026-08-21)** — three read-only Opus reviewers ran in parallel over the whole
branch:
1. **Core implementation** — `DiffusionServerManager` backend state machine, `ResourceOrchestrator`
   residency/reload logic, the `LlamaServerManager` pre-start hook, `electron-lifecycle`.
2. **API surface + documentation** — public exports and types against `genai-electron-docs/**`,
   `README.md`, `AGENTS.md`, `PROGRESS.md`, and the wire contract genai-lite consumes.
3. **Tests, provisioning and the example app** — the four diffusion suites and the shared seam,
   `BinaryManager` provisioning/validation, `examples/electron-control-panel`.

All implementation findings were folded into `816b0c0` (orchestrator reload correctness incl.
`'cancel'` and single-after-burst, the `prepareForLLMStart` auto-`gpuLayers` estimate and
`CALIBRATION_IN_PROGRESS`, cancel-during-cold-spawn, sticky unconfirmed PID at start time, lost-job
stop, `jobRequestTimeoutMs`, `BACKEND_QUEUE_FULL` → `SERVER_BUSY`, `batch_count` clamp, bar-frame-free
tails, the fresh-POSIX exec bit, the per-line GPU-error scan). The remaining documentation findings
plus the queued small-fix batch (`darwin-x64` explicit error, `sd35LargePattern` expiry note,
Linux-NVIDIA Vulkan warning, root export-surface guard) landed in the follow-up pass on top of it.
The live Phase-7 checklist and the `Status:` flip stay with the main thread.

## Files touched (expected)

| Area | Files |
|---|---|
| New | `src/process/sd-server-client.ts`, `src/process/sd-server-runner.ts`, `tests/unit/sd-server-client.test.ts`, `tests/unit/sd-server-runner.test.ts`, `tests/unit/DiffusionServerManager.{lifecycle,routes,generation}.test.ts`, `tests/unit/helpers/sd-server-mocks.ts`, `tests/unit/ResourceOrchestrator.integration.test.ts`, `tests/unit/public-exports.test.ts`, `ISSUE-diffusion-followups.md` |
| Types/config | `src/types/images.ts`, `src/types/servers.ts`, `src/types/index.ts`, `src/index.ts`, `src/config/defaults.ts`, `src/config/paths.ts`, `eslint.config.mjs` |
| Managers/utils | `src/managers/DiffusionServerManager.ts`, `src/managers/ResourceOrchestrator.ts`, `src/managers/LlamaServerManager.ts` (hook only), `src/managers/BinaryManager.ts`, `src/utils/electron-lifecycle.ts` |
| Tests adapted | `tests/unit/DiffusionServerManager.test.ts` (replaced by the split), `diffusion-calibration.test.ts`, `ResourceOrchestrator.test.ts`, `LlamaServerManager.test.ts`, `BinaryManager.test.ts`, `electron-lifecycle.test.ts` |
| Docs | listed in Phase 6 |
| Example app | `main/genai-api.ts`, `main/ipc-handlers.ts`, `renderer/components/DiffusionServerControl.tsx` (+ status rows), `renderer/components/ResourceMonitor.tsx` (PID relabel) |

## Documentation

Existing artifacts updated (Phase 6 list). New artifacts: this plan only — it uniquely owns the
migration design, invariants, and the smoke baseline; the user docs own the resulting contract,
PROGRESS owns the change log, the devlog owns the rationale. No other new document.

## Decisions

- **The wrapper stays the public server; `sd-server` is an internal lazily-spawned backend** —
  preserves every consumer contract and `start()`'s "no VRAM until an image" behavior (the LLM may
  be resident at `start()`). Rejected: making `start()` spawn `sd-server` eagerly (holds VRAM from
  start; breaks LLM-first usage; would need `--eager-load` to even mean "loaded").
- **Keep a stdout tap for progress** (line-buffered, single marker table, `step>steps` guard) —
  the job JSON carries no progress at the pin; the single worker thread makes attribution exact.
  Rejected: waiting for upstream PR #1884 (unmerged) or dropping step progress (the example app and
  genai-lite's `onProgress` consume it). Pluggable: job-JSON progress replaces the tap when it lands.
- **Residency mechanism in the manager, context in the orchestrator** (`resolveUsageMode` /
  `settleResidency` / `onDiffusionBackendReleased(reason)`, settle exactly once by the owner of the
  offload context) — Rejected: threading hints through `executeImageGeneration` args (breaks the
  pinned internal signature for no gain); deriving the default from `savedLLMState` (set for whole
  calibration sweeps, stale on failed reloads).
- **A server-level `config.usageMode` sits between the request value and the computed default**
  — deliberate divergence from the devlog's "not stored config" (§3): hosts on the genai-lite path
  cannot set per-request fields, and `'auto'` keeps the devlog behavior as the default.
- **Release reasons are a typed enum and the orchestrator reloads only on
  `idle-timeout|explicit|crashed|stop`** — makes the "who triggers the LLM reload" question
  answerable in one place and testable; prevents the double-reload and the reload-from-inside-
  the-hook/at-shutdown paths. Rejected: a boolean "suppress" flag (loses the why).
- **Cancel-while-generating = kill the backend, DELETE answers on initiation** — upstream cannot
  interrupt sampling (409); the cost equals today's (next image reloads); genai-lite's DELETE
  budget is 5 s. Rejected: "cancel applies after the current image" (bad UX on 30-step jobs);
  awaiting confirmed death before answering.
- **Backend crash is surfaced as `'backend-status'`, not `'crashed'`; `isHealthy()` stays
  wrapper-scoped** — the wrapper is still up; the example app flips the whole server on
  `'crashed'` and polls health every 3 s. Rejected: reusing `'crashed'`; tying health to residency.
- **Keep the 503 busy gate; no queueing** — documented contract, genai-lite maps `SERVER_BUSY` to
  rate-limit and never retries. Rejected: exposing `sd-server`'s 64-deep queue as `pending`.
- **Batch stays a per-image loop (now orchestrated)**; **`batchSize` maps to `batch_count`** (first
  image returned, as today) — preserves `seed+i`, per-image progress, cancel between images, and
  the calibration "match production" meaning of `generation.batchSize`. Rejected: one
  `batch_count` job per request; declaring `batchSize` a no-op (behavior change for no benefit).
- **Phase-2 validation through the same runner/client as production** — the provisioning-
  robustness fix established "one flag mapper for production/calibration/validation"; a `sd-cli`
  probe would drift from the `sd-server` production path. Rejected: keeping the `sd-cli` probe.
- **Provisioning lands before the manager rewire** — otherwise the manager would spawn a binary
  provisioning never validated/chmod'ed. Rejected: the original manager-first order.
- **Calibration default `usageMode: 'single'`** (cold per sample) and the reversal of
  PLAN-diffusion-calibration's "No restarts" — matches the common usage and today's report
  semantics; restarts are unavoidable with launch-arg flags. Rejected: warm-only (the devlog's first
  framing).
- **Hooks run after `setStatus('starting')` inside `start()`'s `try`** — the concurrency guard
  must already be armed while a hook awaits. Rejected: before `setStatus` (re-entrant start window).
- **No pin bump** — the pinned server equals current master's minus an unused additive field.
- **Switching the primary binary name triggers a one-time re-validation on existing installs**
  (no download; POSIX chmod-before-revalidate makes that true on all platforms) — accepted;
  documented.
- **New modules live in `src/process/` and stay Node-safe (lint-enforced)** — consistent with
  `llama-server-runner`; leaves the door open for an Electron-free diffusion launch subpath later.
- **`--lora-model-dir` always set to a library-owned `<userData>/loras` dir; `cwd` = binary dir**
  — upstream #1468 insurance. Rejected: the model directory (would enumerate model files as LoRAs).
- **`ServerEvent` union edited** (`'backend-status'`, `'calibration-progress'`) — additive;
  reverses an earlier "don't touch `servers.ts`" note knowingly.

## Risks

| Risk | Mitigation |
|---|---|
| Test rewrite scope (81 + 24 tests in the two diffusion files, plus orchestrator/calibration/BinaryManager/lifecycle adaptations) | Split by concern; new seams (`runner`/`client` module mocks, DI in runner tests) remove the `setTimeout(50)` races; the ~90 untouched tests are the safety net; HTTP-route coverage is new and must land with Phase 3 |
| Upstream stdout format drift at a future pin bump (progress still parsed from literals) | Single exported `SD_SERVER_STDOUT_MARKERS` table + UPDATING-BINARIES note repointed; replaceable by job-JSON progress when #1884 lands |
| All-resident combos peak at 7.9/8.2 GB on 8 GB cards | Calibration records peak VRAM per combo; auto flags unchanged in this PR; follow-up estimator work |
| Offload/yield ping-pong (LLM start releases backend → image offloads LLM → burst keeps backend → …), each cycle paying a full LLM load | Default `'single'` after an offload breaks the loop; measured-VRAM estimator follow-up; documented |
| Backend stuck (no progress, no exit) | Client DELETE (genai-lite does this on its 120 s timeout) → kill; internal no-activity timeout is a follow-up |
| `sd-server` OOM surfacing unverified (failed job vs process exit) | Phase 7 deliberate-OOM probe; both paths classify via `details.stderr`/exit |
| Windows re-provisioning while a backend holds the install dir | `ensureBinary` runs only in `start()`/`calibrate()` when no backend exists by construction; termination-unconfirmed aborts the variant loop |
| Windows-only live smoke (POSIX chmod path, macOS sampling skip unexercised) | Unit tests for the chmod branch; platform gates; accepted residual |
| `sd-server` as a managed child is young upstream (#1849 LoRA crash, #1293 plateau) | We never vary LoRA; plateau is calibrated; exit handler + lazy respawn recover from crashes |
| `loadMs` semantics change in burst reports | `policyVersion` + `usageMode` echo so hosts can key persisted recommendations |

## Rollback

The branch is the rollback unit (unreleased). On-disk effects are benign: `.validation.json`
gains a `sd-server` checksum (a revert simply re-validates `sd-cli` once); `<userData>/loras` is
an empty directory. No data formats change; `ModelInfo` is untouched.

## Open Questions (resolved 2026-08-21)

1. `idleTimeoutMs` default — **5 min (300 000 ms)**. Under `'burst'`-after-offload the idle
   timeout is also what eventually brings the LLM back; `0` = never (host owns the release).
   Diffusion-only — the LLM side gets no idle timer.
2. Example-app touch-ups — **minimal**: comment fixes + a backend-state status line; no
   calibration mode selector.
