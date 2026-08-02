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

**Sanitization is mandatory and unconditional.** Prompt text is hashed structurally, only basenames
are stored, and a final scrubbing pass rewrites the userData directory, repository root, home
directory, user name, and any remaining absolute-looking path into placeholders. No raw prompt text,
user name, or absolute path may appear in a committed artifact — check a new artifact before
committing it.

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
