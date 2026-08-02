# Calibration quiet-trace harness (development only)

Versioned instrumentation for **PLAN-calibration-resource-stability**.

It runs one real `llamaServer.calibrate()` call per invocation and writes one sanitized artifact
JSON. There is no shadow to arm any more: plan Phase 2.10 converted the observe path into the
ordinary enforcing behaviour of `calibrate()`, so the harness simply drives the public API and
records what it returned — a report, or the typed
`LlamaCalibrationResourceStabilityError` with its partial report, resource-failure diagnostics, and
optional diagnostic-only candidate.

This directory is outside the npm package (`package.json` `files` is `["dist","README.md","LICENSE"]`),
so nothing here ships. Phase 6 reuses this same harness and artifact format for enforcement smokes;
do not create a second instrumentation path. `--scenario` adds the Phase 6 pressure scenarios to
that same path — see [Phase 6 scenarios](#phase-6-scenarios).

Files:

| File                       | Role                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `run-quiet-trace.mjs`      | The harness. One `calibrate()` call, one artifact, optional scenario.     |
| `host-pressure-helper.mjs` | Bounded host-memory pressure process, spawned only by the harness.        |
| `config.default.json`      | Matrix cells, model id, userData, workloads.                             |
| `replay-thresholds.mjs`    | Offline threshold replay for the retained `formatVersion: 1` artifacts.  |

## Prerequisites

```powershell
npm.cmd run build      # the harness deep-imports dist/, not src/
```

Electron is a peer dependency and **is** installed at the repository root on this machine
(`node_modules/.bin/electron`, currently v43). If a checkout has no root Electron, use the example
app's devDependency instead:

```powershell
node_modules\.bin\electron --version                                  # preferred
examples\electron-control-panel\node_modules\.bin\electron --version  # fallback
```

The harness itself needs nothing but a working `electron` binary; pick whichever exists.

## userData resolution

`src/config/paths.ts` evaluates `app.getPath('userData')` at **import time**, so the harness calls
`app.setPath('userData', …)` before importing `dist/index.js`. That makes the library reuse an
already-provisioned binary and model instead of downloading anything.

On this machine the provisioned Gemma 4 12B model and CUDA `llama-server` live under the Palimpsest
GUI's userData, which is what `config.default.json` points at:

| What                | Path                                                     |
| ------------------- | -------------------------------------------------------- |
| userData            | `%APPDATA%\@palimpsest\gui`                              |
| llama binary        | `…\binaries\llama\llama-server.exe`                      |
| model (`gemma-4-12b-iq4xs`) | `…\models\llm\gemma-4-12b-it-IQ4_XS.gguf`        |

The `electron-control-panel` example uses `%APPDATA%\electron-control-panel` and has different
models provisioned (Gemma 3 12B, Qwen 3), so it is not the default. Override with
`--user-data-dir <dir>` or the `userDataDir` key in the config; `%VAR%`/`$VAR` are expanded.

Before any real-model run, invoke the repository's `llama-server` skill for the pinned binary/model
facts and confirm no other llama-server is running (calibration's strict occupancy check will
otherwise refuse to start).

## Running one cell

```powershell
npm.cmd run build
node_modules\.bin\electron scripts\calibration-quiet-trace\run-quiet-trace.mjs `
  --cell adaptive-1p `
  --out scripts\calibration-quiet-trace\artifacts\adaptive-1p-001.json
```

Flags:

| Flag                   | Meaning                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `--cell`               | One of the four matrix cells (required).                                            |
| `--out`                | Artifact path. Defaults to `artifacts/<cell>-<epoch>.json`.                         |
| `--config`             | Alternate JSON config. Defaults to `config.default.json`.                           |
| `--user-data-dir`      | Override the provisioned userData directory.                                        |
| `--dry-run`            | Resolve config/model/paths/scenario and exit without launching a server or helper.  |
| `--scenario`           | Phase 6 scenario name. Default `quiet`.                                             |
| `--arm-at`             | Override the scenario's arm point (`policy-ready`, `probe-launch`, `probe-sampling`, `probe-stopping`). |
| `--pressure-pct`       | Override the target as a percent of the host baseline (hard cap 40).                |
| `--pressure-workers`   | Number of helper processes the target is split across.                              |
| `--pressure-floor-mib` | Hard remaining-memory floor passed to every helper. Default 4096.                   |
| `--pressure-ttl-ms`    | Helper TTL for the armed hold. Default 120000.                                      |
| `--pressure-chunk-mib` | Allocation chunk size. Default 64.                                                  |
| `--transient-hold-ms`  | `host-transient` only: milliseconds from ARM to release. Default 2600.              |
| `--transient-delay-ms` | Delay between the arm-point event and the ARM write. Default 0.                     |

The process creates no `BrowserWindow` and calls `app.disableHardwareAcceleration()` before ready,
so the harness contributes no GPU load of its own.

## The matrix

| Cell                   | Strategy | Shape                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| `adaptive-1p`          | adaptive | one profile at the calibrated production context        |
| `adaptive-2p`          | adaptive | two comparable profiles                                 |
| `exact-near-capacity`  | exact    | near-capacity / full-offload combos                     |
| `exact-lower-pressure` | exact    | deliberately lower pressure                             |

Each call runs with an ample explicit wall budget (`maxWallTimeMs` per cell in the config), because
the guard's settle, cooldown, and confirmation waits are real wall time that the adaptive budget
sees. The baseline schedule is paid before the probe wall clock starts; the per-boundary cooldowns
are not.

## Phase 6 scenarios

`--scenario <name>` injects a bounded **host-memory** disturbance into the same
`calibrate()` call, driven from the calibration's own `'calibration-progress'` events. Nothing else
changes: same harness, same artifact, plus a `scenario` block.

| Scenario                      | What it injects                                                                         | Expected outcome                                                                                                              | Plan item |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
| `quiet` (default)             | nothing                                                                                   | completed report, no false abort, every probe cleanup confirmed                                                                 | 6.1       |
| `host-subthreshold-prelaunch` | ~7 % of the host baseline, armed once probe 0 has launched, held to the end               | run **continues**; boundaries record a nonzero `decreasePctFromBaseline` that was still `admitted`                              | 6.2       |
| `host-prelaunch`              | ~14 % of the host baseline, armed the instant the fixed baseline is complete, held        | probe 0's **pre-launch** boundary goes suspicious → confirmation → confirmed drift → typed rejection with **no launch at all**  | 6.2       |
| `host-transient`              | ~14 %, armed at probe 0 teardown, released `--transient-hold-ms` later                    | post-cleanup boundary suspicious on the initial read, **recovered** on the confirmation read, run **continues** without another launch | 6.3   |
| `host-postcleanup`            | ~14 %, armed while probe 0 is running its workloads, held through confirmation            | probe 0 completes, its **post-cleanup** boundary confirms the drift, the probe is invalidated, typed rejection, no report        | 6.2       |

Targets are computed from a pre-run reading of the same metric the guard uses (Windows
`Available Bytes`, not `os.freemem()`), because the run's real fixed baseline does not exist until
`calibrate()` has collected it. The artifact records the requested percent, the MiB actually
committed, and `pressure.actualPctOfRunBaseline` against the real baseline once it is known —
check that number rather than assuming the intended band was crossed.

### Which boundary actually fires

Boundary reads are ordered `pre-launch → (probe) → post-cleanup → pre-launch → …`, and the gap
between a post-cleanup read and the next pre-launch read is a few milliseconds of synchronous
policy work. **Pressure that appears while a probe is running is therefore always seen first at that
probe's post-cleanup boundary**, never at a later pre-launch one.

That is why `host-prelaunch` arms at `policy-ready` instead: nothing is awaited between that event
and probe 0's pre-launch snapshot, so the helper's commit (~0.2-0.5 s for 1.5 GiB, split over two
workers) races one PowerShell PerfOS query (~0.4-0.6 s on the reference machine). Winning the race
gives the intended pre-launch, no-launch rejection. Losing it is not a wasted run: the same held
pressure is confirmed at probe 0's post-cleanup instead, and `scenario.outcome.failureBoundary`
says which one happened. Re-run if you need the pre-launch case specifically.

`--arm-at policy-ready` requires an adaptive cell; exact mode emits no progress event between its
baseline and its first pre-launch check, and the harness refuses the combination.

### Tuning and retrying `host-transient`

The release must land **after** the post-cleanup initial read and **before** its confirmation read
750 ms later (plus that read's own command latency). The harness cannot observe those instants, so
it releases on a timer measured from the ARM event at probe 0's `stopping` phase, and records every
real instant it does know. Read the resulting artifact and adjust:

| What the artifact shows                                                        | Meaning              | Next step                        |
| ------------------------------------------------------------------------------ | -------------------- | -------------------------------- |
| `postCleanup.initiallySuspiciousMetrics` nonempty, `confirmationPerformed: true`, conclusion admitted | landed               | done                             |
| post-cleanup boundary never suspicious                                          | released too early   | raise `--transient-hold-ms`      |
| typed rejection with `failureBoundary: "post-cleanup"`                          | released too late    | lower `--transient-hold-ms`      |

Expect to need a retry or two; teardown duration varies by ~2 s between runs. `--transient-delay-ms`
adds a delay between the `stopping` event and the ARM write if the whole window needs shifting.

### Safety rails

Every rail is mandatory and lives in `host-pressure-helper.mjs`; the CLI can only tighten them.

- **Hard memory floor**, re-checked before *every* chunk: the helper refuses to take `os.freemem()`
  below `--floor-mib` (default 4096) and prints `FLOOR <allocatedMiB>` instead of continuing. On
  Windows this is conservative, since `os.freemem()` excludes the standby cache.
- **TTL self-expiry**: the armed hold is bounded by the helper's `--ttl-ms` (default 120 s when the
  helper is run by hand), an unarmed staged process by `--staged-ttl-ms`. Both hard-exit. The
  harness passes a per-scenario armed-hold TTL — 5 min for `host-prelaunch`, 10 min for
  `host-postcleanup`, 20 min for the whole-run `host-subthreshold-prelaunch`, 120 s for
  `host-transient` — because a TTL that expired mid-run would silently remove the disturbance and
  change the experiment. `--pressure-ttl-ms` overrides it, capped at 30 min. If a helper does hit
  its TTL, its record shows `exitReason: "ttl"` and the exact instant, so a truncated hold is
  visible in the trace instead of being assumed away.
- **Parent-death watchdog**, polled every second, plus stdin close: if the harness disappears, the
  helper exits and the pages go back to the OS.
- **Controller-finally cleanup**: every spawn is tracked in the harness registry and released in a
  `finally`, so a completed run, a typed rejection, and a harness crash all tear down the same way.
- **Preflight refusal**: the harness refuses to start a scenario whose target would breach the floor,
  or that asks for more than 40 % of the baseline.
- **Recovery gate**: after release the harness re-reads host availability and warns if the machine
  has not returned to within 10 % of the run's baseline. Do not start the next scenario until it has.
- **Teardown gate**: the harness warns with PIDs if any helper is still alive. Kill it before the
  next scenario rather than letting the next trial inherit unknown pressure.

The helper is safe to smoke-test on its own:

```powershell
node scripts\calibration-quiet-trace\host-pressure-helper.mjs --self-test
```

It checks the floor logic against a fake floor, commits and releases one 64 MiB chunk, and drives a
child through the staged `ARM`/`RELEASE` protocol. It exits 0 and leaves nothing behind.

### VRAM crossing: operator procedure, not a script

There is deliberately **no VRAM helper**. Plan item 6.4 is done by hand, only with the
lower-pressure profile, and only with measured reserve — never at the capacity edge, and never
while a calibration model is loaded:

1. Start `--cell exact-lower-pressure --scenario quiet` (or `adaptive-1p`) and watch the log.
2. Between the baseline (`policy-ready`) and the first launch, start a *second, small*
   llama-server on a different port to consume roughly 1-1.5 GiB of VRAM, e.g. the Gemma e4b model
   with a small `-ngl`:
   `llama-server.exe -m <e4b model>.gguf --port 8081 -ngl 8 -c 2048`
   (invoke the repository's `llama-server` skill for the pinned binary/model facts).
3. Expect the typed rejection: the VRAM decrease band is 10 %, and 1-1.5 GiB of ~8 GiB free is a
   clear crossing.
4. **Kill that second server immediately after the rejection**, confirm VRAM has recovered
   (`nvidia-smi`), and only then run anything else.

If no safe crossing exists on the machine at hand, record the scenario as *not run* and rely on the
deterministic manager coverage. Never risk an OOM or a driver reset to satisfy this step.

### Suggested run order

One scenario per invocation, quiet machine, nothing else running. Between runs, confirm the
recovery/teardown lines are clean and no `llama-server.exe` or helper survives.

```powershell
npm.cmd run build

# 1. Item 6.1 - the quiet matrix (already recorded; re-run if the guard changed)
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --out scripts\calibration-quiet-trace\artifacts\adaptive-1p-enforcing-001.json

# 2. Item 6.2 - minor change is tolerated
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --scenario host-subthreshold-prelaunch --out scripts\calibration-quiet-trace\artifacts\host-subthreshold-001.json

# 3. Item 6.2 - pre-launch rejection, no launch consumed (retry if it lands on post-cleanup)
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --scenario host-prelaunch --out scripts\calibration-quiet-trace\artifacts\host-prelaunch-001.json

# 4. Item 6.2 - post-cleanup invalidation of a completed probe
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --scenario host-postcleanup --out scripts\calibration-quiet-trace\artifacts\host-postcleanup-001.json

# 5. Item 6.3 - transient disturbance recovers at the confirmation read (expect retries)
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --scenario host-transient --out scripts\calibration-quiet-trace\artifacts\host-transient-001.json

# 6. Item 6.4 - VRAM crossing by hand, per the procedure above (exact-lower-pressure)

# 7. Item 6.6 - a plain quiet run must still succeed afterwards
node_modules\.bin\electron.cmd scripts\calibration-quiet-trace\run-quiet-trace.mjs --cell adaptive-1p --out scripts\calibration-quiet-trace\artifacts\adaptive-1p-recovery-001.json
```

Add `--dry-run` to any of these to see the resolved scenario plan (target MiB, workers, arm point,
expectation) without launching a server or spawning a helper.

## Threshold replay applies to Phase 1 artifacts only

`replay-thresholds.mjs` re-decides shadow-era boundaries offline through the pure functions in
`dist/utils/llama-resource-guard.js`. It reads `formatVersion: 1` artifacts, which carry a
`shadowTrace` of captured snapshots:

```powershell
node scripts\calibration-quiet-trace\replay-thresholds.mjs `
  scripts\calibration-quiet-trace\artifacts\*.json --thresholds 10,15,20,25
```

Enforcement-era artifacts (`formatVersion: 2`) have nothing to replay: the guard's conclusions are
the run's own conclusions, and thresholds are shipped policy constants rather than a swept
parameter. Both the script and the Phase 1 artifacts are retained unchanged so the threshold
decision stays auditable.

## Artifact schema (`formatVersion: 2`)

One file per calibration call, committed under `artifacts/`.

| Field                 | Contents                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `formatVersion`       | `2` for enforcing runs; `1` marks the retained Phase 1 shadow traces that `replay-thresholds.mjs` reads. |
| `cell`                | Matrix cell name, plus `cellDescription`.                                                                                                    |
| `scenario`            | Additive in `formatVersion: 2`. Scenario name/description/plan items/expectation, arm point, release policy, the pressure plan and what was actually committed, the pre-run baseline proxy and the run's real host baseline, the helper registry, the progress+helper timeline, the outcome summary, and the recovery/teardown gates. See below. |
| `harness`             | Script name, repository git SHA, dirty flag, config file basename.                                                                           |
| `environment`         | Platform/arch, Electron/Chrome/Node versions, hardware-acceleration and window-count facts.                                                   |
| `timestamps`          | ISO start/finish and monotonic `durationMs`.                                                                                                 |
| `identities`          | Binary and model **basenames + byte sizes only**, model id/name/architecture. No directories.                                                 |
| `calibrateConfig`     | The exact config passed to `calibrate()`, with every prompt replaced by `{workloadId, sha256, chars, tokenCounts}`.                            |
| `resourcePolicy`      | The enforced bands and schedule read from `LLAMA_CALIBRATION_DEFAULTS`, plus `policyVersion`.                                                  |
| `report`              | Report summary: status, terminal reason, probe count, warnings, selected/provisional/fallback, and per probe scoreMs, operationalStatus, boundaryDecision, memoryEvidence, `resourceValidity`, cleanup confirmation, resource diagnostics. |
| `failure`             | Present only when `calibrate()` rejected: message, error name, details code, suggestion, and the partial report including `resourceFailure` boundary diagnostics and any `diagnosticCandidate`. |
| `progress`            | `policy-ready` and terminal `done` progress payloads.                                                                                         |
| `cleanup`             | `isCalibrating()`, manager status, and whether every probe reported confirmed cleanup.                                                         |

### The `scenario` block

| Key                        | Contents                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name` … `expectation`     | Scenario identity, `planItems`, prose expectation, `armAt`, `releasePolicy`, `helperScript`.                                  |
| `pressure`                 | `requestedPctOfBaseline`, `targetMib`, `workers`, `chunkMib`, `floorMib`, `ttlMs`, `holdMs`, `committedMib`, and `actualPctOfRunBaseline` measured against the run's real fixed baseline. |
| `baselineProxy`            | The pre-run host reading the target was sized from, with its `refreshStatus`.                                                |
| `runHostBaselineBytes`     | The host baseline `calibrate()` actually fixed, from the report or the failure's partial report.                             |
| `armedAt(Ms)` / `releaseRequestedAt(Ms)` / `releaseReason` | Controller-level instants, ISO plus milliseconds from the call.                              |
| `helpers[]`                | Per helper: pid, target, `allocatedMib`, `floorStopped`, `commitMs`, spawn/staged/armed/ready/release/exit timestamps (ISO **and** ms), `exitReason` (`released`, `ttl`, `staged-ttl`, `hold-elapsed`, `parent-death`, or the OS code/signal), any kill escalation, and the raw protocol lines. |
| `timeline`                 | Chronological progress-phase transitions and harness events (`helpers-staged`, `armed`, `timed-release`), each with `atMs`.  |
| `outcome`                  | `rejected`, `errorName`, `code` (`error.details.code`), `reportStatus`, `probesRecorded`, and from `resourceFailure`: `failureBoundary`, `failureAffectedMetrics`, `failureAffectedDirections`, `failureProbeIndex`, `failureConfirmationPerformed`, plus `diagnosticCandidatePresent`. |
| `recovery`                 | Post-release host reading, its delta from the reference baseline, and `withinQuietBand`.                                     |
| `teardown`                 | Helper count, whether all exited, any live PIDs, total committed MiB.                                                        |
| `notes`                    | Anything the scenario wiring caught that did not belong in the run itself.                                                   |

The full boundary diagnostics stay where they always were — `report.probes[].resourceBoundaries`
and `failure.partialReport.resourceFailure` — retained verbatim. The `scenario` block only says
what was injected and when.

**Sanitization is mandatory and unconditional.** Prompt text is hashed structurally, only basenames
are stored, and a final scrubbing pass rewrites the userData directory, repository root, home
directory, user name, and any remaining absolute-looking path into placeholders. No raw prompt text,
user name, or absolute path may appear in a committed artifact — check a new artifact before
committing it. Scenario helper output is numeric line protocol and carries no paths.

## Known cost and blind spot (recorded, not hidden)

The guard costs real wall time in every run, harness or not: the fixed settle delay plus
cooldown-spaced baseline samples before the adaptive wall clock starts, then per launch a
pre-launch read, a post-cleanup cooldown and read, and one further cooldown plus read whenever a
reading is suspicious. Near an exhausted wall budget that time can change which branch the search
takes; keep `maxWallTimeMs` ample, and read the budget and terminal reason off the artifact rather
than assuming.

Boundary sampling is pre/post only. A disturbance that begins and fully clears inside a single
launch is invisible to it. That is a documented limitation of this design, not something the
harness can measure away — in-flight telemetry would perturb the very timings being measured.

Two scenario-specific consequences worth recording with the results:

- A sub-threshold hold is *cumulative* against the one fixed baseline. On a long run its ~7 % plus
  the machine's own settling can cross the 10 % band late in the run; that is correct guard
  behaviour, not a harness bug. Lower `--pressure-pct` if a clean "tolerated" trace is needed.
- `host-prelaunch` and `host-transient` are races against telemetry-read latency that the harness
  cannot observe. Their artifacts are honest about what happened (`outcome.failureBoundary`, the
  helper `readyAt`/`releaseRequestedAt` instants); read those rather than the scenario name when
  writing up the evidence.
