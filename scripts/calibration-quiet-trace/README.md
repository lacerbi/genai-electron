# Calibration quiet-trace harness (development only)

Versioned instrumentation for **PLAN-calibration-resource-stability**, Phase 0 item 8 and Phase 1.

It runs one real `llamaServer.calibrate()` call per invocation with the temporary Phase-0.8
resource-guard shadow armed, and writes one sanitized artifact JSON. The shadow executes the real
baseline / pre-launch / post-cleanup / cooldown / confirmation schedule but **never** changes the
v0.19 decision: the manager records the shadow's conclusion and drops it.

This directory is outside the npm package (`package.json` `files` is `["dist","README.md","LICENSE"]`),
so nothing here ships. Phase 6 reuses the same harness and artifact format for enforcement smokes;
do not create a second instrumentation path.

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

| Flag              | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `--cell`          | One of the four matrix cells (required).                              |
| `--out`           | Artifact path. Defaults to `artifacts/<cell>-<epoch>.json`.           |
| `--config`        | Alternate JSON config. Defaults to `config.default.json`.             |
| `--user-data-dir` | Override the provisioned userData directory.                          |
| `--dry-run`       | Resolve config/model/paths and exit without launching a server.       |

The process creates no `BrowserWindow` and calls `app.disableHardwareAcceleration()` before ready,
so the harness contributes no GPU load of its own.

## The Phase 1 matrix and its cap

| Cell                   | Strategy | Shape                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| `adaptive-1p`          | adaptive | one profile at the calibrated production context        |
| `adaptive-2p`          | adaptive | two comparable profiles                                 |
| `exact-near-capacity`  | exact    | near-capacity / full-offload combos                     |
| `exact-lower-pressure` | exact    | deliberately lower pressure                             |

Four further calls are reserved to rerun those same cells with the **final** settle/cooldown
schedule; if the schedule does not change they count as ordinary repetitions. **Stop at eight
calibration calls or 90 minutes, whichever comes first** (plan Phase 1.3). Pre-delay traces cannot
validate a final default: once the settle schedule changes, the affected cells must be rerun.

Each call runs with an ample explicit wall budget (`maxWallTimeMs` per cell in the config) because
shadow waits are real. The harness records `guardAddedTotalMs`; do not treat it as free.

## Replay principle

Arm the shadow at the **lowest** candidate threshold you intend to replay (the config ships
10 % / 10 %). A confirmation snapshot is only captured when the live initial read was suspicious, so:

- every candidate **at or above** the capture threshold can be replayed offline from the retained
  snapshots, with no further live runs;
- a candidate **below** it may find suspicion where no confirmation exists. Those boundaries are
  reported as `unreplayable` rather than concluded from missing data.

```powershell
node scripts\calibration-quiet-trace\replay-thresholds.mjs `
  scripts\calibration-quiet-trace\artifacts\*.json --thresholds 10,15,20,25
node scripts\calibration-quiet-trace\replay-thresholds.mjs artifacts\a.json --host 10,15 --vram 10,25 --json
```

`replay-thresholds.mjs` is plain Node and re-decides every boundary through the pure functions in
`dist/utils/llama-resource-guard.js`. It re-implements nothing; a replay result is exactly what
enforcement would have concluded at that threshold.

## Artifact schema (`formatVersion: 1`)

One file per calibration call, committed under `artifacts/`.

| Field                 | Contents                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `formatVersion`       | `1`. Replay tooling switches on it.                                                                                                         |
| `cell`                | Matrix cell name, plus `cellDescription`.                                                                                                    |
| `harness`             | Script name, repository git SHA, dirty flag, config file basename.                                                                           |
| `environment`         | Platform/arch, Electron/Chrome/Node versions, hardware-acceleration and window-count facts.                                                   |
| `timestamps`          | ISO start/finish and monotonic `durationMs`.                                                                                                 |
| `identities`          | Binary and model **basenames + byte sizes only**, model id/name/architecture. No directories.                                                 |
| `calibrateConfig`     | The exact config passed to `calibrate()`, with every prompt replaced by `{workloadId, sha256, chars, tokenCounts}`.                            |
| `shadowSchedule`      | Thresholds, settle, cooldown, baseline samples, confirmation reads, telemetry timeout, extra offsets.                                         |
| `shadowTrace`         | The full trace: `baseline`, `boundary`, `extra-sample`, `legacy-outcome`, `note` events, each with `sequence`, `atMs`, `sinceArmMs`, `wallMs`. |
| `guardAddedTotalMs`   | Total wall time the shadow itself consumed.                                                                                                   |
| `report`              | v0.19 report summary: status, terminal reason, probe count, warnings, selected/provisional/fallback, and per probe scoreMs, operationalStatus, boundaryDecision, memoryEvidence, cleanup confirmation, v0.19 resource diagnostics. |
| `failure`             | Present only when `calibrate()` rejected: message, details code, partial-report summary.                                                      |
| `progress`            | `policy-ready` and terminal `done` progress payloads.                                                                                         |
| `cleanup`             | `isCalibrating()`, manager status, and whether every probe reported confirmed cleanup.                                                         |

**Sanitization is mandatory and unconditional.** Prompt text is hashed structurally, only basenames
are stored, and a final scrubbing pass rewrites the userData directory, repository root, home
directory, user name, and any remaining absolute-looking path into placeholders. No raw prompt text,
user name, or absolute path may appear in a committed artifact — check a new artifact before
committing it.

## Known perturbation (recorded, not hidden)

Arming the shadow adds real wall time: the baseline settle plus sampling before the adaptive wall
clock starts, and per probe one cooldown, an optional confirmation cooldown, and any extra
diagnostic offsets. Consequences that are accepted and must be read off the artifact rather than
assumed away:

- the v0.19 post-probe reading is taken later relative to teardown than in a disarmed run, because
  the shadow sequence runs first (that is deliberate: Phase 1.5 needs the 750/1500 ms decision
  points measured from the real teardown instant);
- near an exhausted adaptive wall budget the added time can change which branch v0.19 takes. Keep
  `maxWallTimeMs` ample; the artifact records the budget, the guard-added total, and the terminal
  reason so this is visible.

Everything else about the v0.19 path — decisions, report contents, probe records, warnings, and
event payloads — is unchanged when the shadow is armed.
