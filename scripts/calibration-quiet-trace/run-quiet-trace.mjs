/**
 * Versioned quiet-trace harness for PLAN-calibration-resource-stability.
 *
 * Runs ONE `llamaServer.calibrate()` call for one matrix cell inside a headless Electron main
 * process and writes one sanitized artifact JSON. It never creates a BrowserWindow and disables
 * hardware acceleration before the app is ready, so the harness itself adds no GPU interference.
 *
 * The Phase-0.8 observe/shadow path is gone: the resource guard is now the ordinary enforcing
 * behaviour of `calibrate()`, so this harness records whatever the public API returned - a report,
 * or a typed rejection with its partial report and resource-failure diagnostics. That also makes it
 * the Phase 6 enforcement-smoke harness without a second instrumentation path.
 *
 * `--scenario` adds the Phase 6 items 2-5 pressure scenarios on top of that single path: the same
 * call, the same artifact, plus a bounded host-memory disturbance injected from the calibration's
 * own progress events (see `host-pressure-helper.mjs` for the safety rails). Pressure is host
 * memory only; VRAM crossings are an operator procedure documented in README.md, never scripted.
 *
 * This file lives outside the npm package (`files` is ["dist","README.md","LICENSE"]) and
 * deep-imports the BUILT library, so `npm run build` must run first.
 *
 * Usage:
 *   npx electron scripts/calibration-quiet-trace/run-quiet-trace.mjs \
 *     --cell adaptive-1p --out scripts/calibration-quiet-trace/artifacts/<name>.json
 *   npx electron scripts/calibration-quiet-trace/run-quiet-trace.mjs \
 *     --cell adaptive-1p --scenario host-prelaunch --out .../host-prelaunch-001.json
 *
 * See README.md in this directory for the four-cell matrix, the scenario table, and the artifact
 * schema.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { summarizePartialReport, summarizeReport } from './summarize.mjs';

/**
 * Bump together with the artifact shape; replay tooling switches on this.
 *
 * `1` was the shadow era: those artifacts carry `shadowSchedule`/`shadowTrace` and are what
 * `replay-thresholds.mjs` reads. `2` is the enforcing era: the guard's decisions are the run's own
 * decisions, so there is no separate trace to replay and threshold replay does not apply. `3`
 * updates future schema-v4 summaries for the total elapsed clock and resource-error `bestKnown`.
 */
const ARTIFACT_FORMAT_VERSION = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CELL_NAMES = ['adaptive-1p', 'adaptive-2p', 'exact-near-capacity', 'exact-lower-pressure'];

const MIB = 1024 * 1024;
const HELPER_SCRIPT = path.join(HERE, 'host-pressure-helper.mjs');

/**
 * Where in the calibration a scenario's pressure is armed, expressed in progress events.
 *
 * - `policy-ready` fires the instant the run's ONE fixed baseline is finished. Nothing is awaited
 *   between that emission and probe 0's pre-launch snapshot, so arming here races that snapshot's
 *   telemetry read (one PowerShell PerfOS query, ~0.4-0.6 s on the reference machine). Adaptive
 *   only: exact mode has no post-baseline event before its first pre-launch check.
 * - `probe-launch` fires when the first launch is announced, i.e. after probe 0's pre-launch
 *   boundary already admitted. The next guarded boundary is that probe's post-cleanup.
 * - `probe-sampling` / `probe-stopping` fire inside the launch, during the workloads and at
 *   teardown respectively.
 */
const ARM_POINTS = ['policy-ready', 'probe-launch', 'probe-sampling', 'probe-stopping'];

const PRESSURE_LIMITS = {
  chunkMib: 64,
  floorMib: 4096,
  /** Fallback armed-hold TTL; each scenario sets its own, and none may exceed `maxTtlMs`. */
  ttlMs: 120_000,
  maxTtlMs: 1_800_000,
  stagedTtlMs: 1_800_000,
  /** Hard cap on the requested fraction of the baseline, whatever the CLI asks for. */
  maxPctOfBaseline: 40,
  minTargetMib: 64,
  releaseGraceMs: 2_000,
  killGraceMs: 1_500,
  recoverySettleMs: 2_000,
  /** Quiet-band tolerance used only for the between-scenario recovery gate. */
  recoveryBandPct: 10,
};

/**
 * Phase 6 scenario table. `quiet` is the item-1 behaviour; the rest are items 2-5.
 *
 * Percentages are of the run's fixed host baseline, approximated before the call by the same
 * telemetry the guard reads (see `readHostAvailable`). The artifact records the requested percent,
 * the MiB actually committed, and - once the report or the failure's partial report is available -
 * the percent of the REAL baseline, so nothing has to be taken on trust.
 *
 * `ttlMs` is the armed-hold bound and must outlast the pressure the scenario intends to apply: a
 * TTL that expires mid-run silently removes the disturbance and turns the evidence into a
 * different experiment. It is still a hard bound (`PRESSURE_LIMITS.maxTtlMs`), and a helper that
 * does hit it records `exitReason: "ttl"` with its exit instant, so a truncated hold is visible
 * rather than assumed away.
 */
const SCENARIOS = {
  quiet: {
    planItems: ['6.1'],
    description: 'No injected pressure: the quiet enforcement smoke.',
    pressure: false,
    expectation:
      'Stabilized baseline, no false abort, clean selection evidence, every probe cleanup confirmed.',
  },
  'host-subthreshold-prelaunch': {
    planItems: ['6.2'],
    description:
      'Sub-threshold host allocation (~7% of baseline) armed once probe 0 has launched and held for the rest of the run.',
    pressure: true,
    pctOfBaseline: 7,
    armAt: 'probe-launch',
    workers: 1,
    release: 'end-of-run',
    // Held for the whole run, which on this matrix is 5-15 minutes.
    ttlMs: 1_200_000,
    expectation:
      'Every later boundary (probe 0 post-cleanup, then the next pre-launch) admits the decrease because it stays under the 10% host band; the run continues and completes. The artifact must show a nonzero decreasePctFromBaseline that was still admitted.',
  },
  'host-prelaunch': {
    planItems: ['6.2'],
    description:
      'Above-threshold host allocation (~14% of baseline) armed the instant the fixed baseline is complete, held through confirmation.',
    pressure: true,
    pctOfBaseline: 14,
    armAt: 'policy-ready',
    // Parallel workers halve the commit time, which is what makes the pre-launch snapshot
    // reachable at all; the floor is still enforced per chunk against live free memory.
    workers: 2,
    release: 'end-of-run',
    // Rejection lands either seconds after arming (pre-launch) or one probe later.
    ttlMs: 300_000,
    expectation:
      "Probe 0's PRE-LAUNCH read is suspicious, the confirmation read (helper still holding) confirms it, and calibrate() rejects with CALIBRATION_RESOURCE_DRIFT having launched nothing. If the commit loses the race against that snapshot, the same held pressure is confirmed at probe 0's post-cleanup instead - read scenario.outcome.failureBoundary rather than assuming.",
  },
  'host-transient': {
    planItems: ['6.3'],
    description:
      'Above-threshold host allocation (~14%) armed at probe 0 teardown and released again a fixed hold later, aiming for the window between a boundary initial read and its confirmation read.',
    pressure: true,
    pctOfBaseline: 14,
    armAt: 'probe-stopping',
    workers: 2,
    release: 'timer',
    holdMs: 2600,
    ttlMs: 120_000,
    expectation:
      "Probe 0's post-cleanup initial read is suspicious, the +750 ms confirmation read finds the machine recovered, the boundary concludes admitted, and the run continues WITHOUT another launch. Timing is best-effort: the artifact records the real arm/ready/release instants so a miss is visible, and the scenario may need retries with a tuned --transient-hold-ms.",
  },
  'host-postcleanup': {
    planItems: ['6.2'],
    description:
      'Above-threshold host allocation (~14%) armed while probe 0 is running its workloads and held through confirmation.',
    pressure: true,
    pctOfBaseline: 14,
    armAt: 'probe-sampling',
    workers: 1,
    release: 'end-of-run',
    // Must outlast the rest of probe 0 (up to ~135 s here) plus its post-cleanup confirmation.
    ttlMs: 600_000,
    expectation:
      'Probe 0 completes and its POST-CLEANUP boundary confirms the decrease: the probe is invalidated, calibrate() rejects with CALIBRATION_RESOURCE_DRIFT, and no completed report is produced. Host pressure only - never run this against VRAM while a model is loaded.',
  },
};

const SCENARIO_NAMES = Object.keys(SCENARIOS);

/** Probe-level phase of a progress payload, for both strategies. */
function progressProbePhase(progress) {
  if (progress.strategy === 'adaptive') return progress.activeProbe?.probePhase;
  // Exact mode's outer phase IS the probe phase once a candidate is active.
  return progress.activeCandidate ? progress.phase : undefined;
}

/** Short label of whatever launch a progress payload is about, or undefined between launches. */
function progressLaunchLabel(progress) {
  if (progress.strategy === 'adaptive') {
    const probe = progress.activeProbe;
    return probe ? `${probe.cellId}@ngl${probe.gpuLayers}` : undefined;
  }
  const candidate = progress.activeCandidate;
  return candidate ? `combo${candidate.comboIndex}@ngl${candidate.gpuLayers}` : undefined;
}

function matchesArmPoint(progress, armAt) {
  switch (armAt) {
    case 'policy-ready':
      return progress.phase === 'policy-ready';
    case 'probe-launch':
      return progressLaunchLabel(progress) !== undefined;
    case 'probe-sampling':
      return progressProbePhase(progress) === 'sampling';
    case 'probe-stopping':
      return progressProbePhase(progress) === 'stopping';
    default:
      return false;
  }
}

/**
 * Read host availability through the library's own telemetry, i.e. the exact metric the guard
 * compares against (`Available Bytes` on Windows, not `os.freemem()`).
 *
 * Used before the call to size the pressure target and after it as the recovery gate. It is never
 * called while a probe is running: each call spawns a PowerShell query, and that is precisely the
 * kind of interference the quiet matrix exists to avoid.
 */
async function readHostAvailable(library) {
  const refreshStatus = await library.systemInfo.refreshMemoryTelemetry({ timeoutMs: 10_000 });
  const memory = library.systemInfo.getMemoryInfo();
  return {
    at: new Date().toISOString(),
    refreshStatus,
    availableBytes: memory.available,
    totalBytes: memory.total,
    freememBytes: os.freemem(),
  };
}

/** Host baseline actually used by the run, from a report or from a failure's partial report. */
function runHostBaselineBytes(monitoring) {
  const metric = (monitoring?.metrics ?? []).find((entry) => entry.metric === 'hostMemory');
  return metric?.enabled ? metric.baselineBytes : undefined;
}

/**
 * Registry and lifecycle owner for every spawned pressure helper.
 *
 * Nothing spawns outside this class, and `release()` is called from a `finally` in `main()`, so a
 * thrown calibration, a fatal harness error, and a normal completion all converge on the same
 * teardown. The helper's own TTL and parent-death rails are the backstops for the case where even
 * that fails (a hard kill of the Electron process).
 */
class PressureController {
  /** A staged helper only starts a timer and prints one line; anything slower is broken. */
  static STAGE_TIMEOUT_MS = 10_000;

  constructor({ chunkMib, floorMib, ttlMs, stagedTtlMs, holdMs, clock, log }) {
    this.chunkMib = chunkMib;
    this.floorMib = floorMib;
    this.ttlMs = ttlMs;
    this.stagedTtlMs = stagedTtlMs;
    this.holdMs = holdMs;
    this.clock = clock;
    this.log = log;
    this.helpers = [];
    this.armedAt = undefined;
    this.releaseStartedAt = undefined;
    this.releasePromise = undefined;
  }

  /**
   * Spawn one staged (allocated-nothing) helper per worker, splitting the target evenly.
   *
   * A helper that does not reach `STAGED` aborts the scenario instead of letting a run proceed
   * with less pressure than it claims: a partially armed scenario would produce evidence that
   * looks like a guard result but is not one.
   */
  async stage(totalTargetMib, workers) {
    const share = Math.floor(totalTargetMib / workers);
    const targets = Array.from({ length: workers }, (_, index) =>
      index === workers - 1 ? totalTargetMib - share * (workers - 1) : share
    );
    const staged = targets.map((target, index) => this.#spawnOne(index, target));
    await Promise.race([
      Promise.all(staged),
      new Promise((resolve) => setTimeout(resolve, PressureController.STAGE_TIMEOUT_MS)),
    ]);
    const unstaged = this.helpers.filter((helper) => helper.stagedAtMs === undefined);
    if (unstaged.length > 0) {
      await this.release('stage-failed');
      throw new Error(
        `pressure helper(s) ${unstaged.map((helper) => helper.id).join(', ')} never reported STAGED: ` +
          (unstaged.flatMap((helper) => helper.stderr).join(' | ') || 'no diagnostics')
      );
    }
    this.log(
      `pressure: staged ${workers} helper(s) totalling ${totalTargetMib} MiB ` +
        `(chunk ${this.chunkMib} MiB, floor ${this.floorMib} MiB, ttl ${this.ttlMs} ms)`
    );
  }

  #spawnOne(index, targetMib) {
    const args = [
      HELPER_SCRIPT,
      '--target-mib',
      String(targetMib),
      '--chunk-mib',
      String(this.chunkMib),
      '--floor-mib',
      String(this.floorMib),
      '--ttl-ms',
      String(this.ttlMs),
      '--staged-ttl-ms',
      String(this.stagedTtlMs),
      '--wait-for-arm',
      '--label',
      `w${index}`,
    ];
    // Helper-side backstop for the timed release: the controller still releases first.
    if (this.holdMs !== undefined) args.push('--hold-ms', String(this.holdMs + 3000));

    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The harness runs inside Electron, whose execPath is electron.exe; this makes it Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    const record = {
      id: `w${index}`,
      pid: child.pid,
      targetMib,
      spawnedAt: new Date().toISOString(),
      spawnedAtMs: this.clock(),
      lines: [],
      stderr: [],
    };
    this.helpers.push(record);

    let stagedResolve;
    let readyResolve;
    const staged = new Promise((resolve) => {
      stagedResolve = resolve;
    });
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    // 'close' rather than 'exit': it fires once stdio has drained, so a helper's own EXIT line is
    // always captured before the record is considered final.
    const exited = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        record.exitCode = code;
        record.exitSignal = signal;
        record.exitedAt = new Date().toISOString();
        record.exitedAtMs = this.clock();
        stagedResolve();
        readyResolve();
        resolve();
      });
    });
    child.on('error', (error) => {
      record.spawnError = error?.message ?? String(error);
      stagedResolve();
      readyResolve();
    });
    // A write to an already-dead helper must not surface as an unhandled stream error.
    child.stdin.on('error', (error) => {
      record.stdinError = error?.message ?? String(error);
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffered += data;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (line.length === 0) continue;
        record.lines.push({ atMs: this.clock(), line });
        const [kind, ...rest] = line.split(/\s+/);
        if (kind === 'STAGED') {
          record.stagedAt = new Date().toISOString();
          record.stagedAtMs = this.clock();
          stagedResolve();
        } else if (kind === 'READY') {
          record.allocatedMib = Number(rest[0]);
          record.commitMs = Number(rest[1]);
          record.readyAt = new Date().toISOString();
          record.readyAtMs = this.clock();
          record.floorStopped = false;
          readyResolve();
        } else if (kind === 'FLOOR') {
          record.allocatedMib = Number(rest[0]);
          record.freeMibAtFloor = Number(rest[1]);
          record.commitMs = Number(rest[2]);
          record.readyAt = new Date().toISOString();
          record.readyAtMs = this.clock();
          record.floorStopped = true;
          this.log(
            `pressure: helper ${record.id} stopped at the memory floor with ${record.allocatedMib} MiB ` +
              `(free ${record.freeMibAtFloor} MiB)`
          );
          readyResolve();
        } else if (kind === 'EXIT') {
          record.reportedExitReason = rest[0];
          record.heldMibAtExit = Number(rest[1]);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      for (const line of String(data).split('\n')) {
        if (line.trim().length > 0) record.stderr.push(line.trim());
      }
    });

    record.child = child;
    record.staged = staged;
    record.ready = ready;
    record.exited = exited;
    return staged;
  }

  /**
   * Write `ARM` to every staged helper. Deliberately synchronous and non-blocking: it is called
   * from the calibration's own progress callback, which must not be stalled.
   */
  arm(reason) {
    if (this.armedAt !== undefined) return;
    this.armedAt = this.clock();
    this.armedAtWallClock = new Date().toISOString();
    this.armReason = reason;
    for (const helper of this.helpers) {
      helper.armedAt = this.armedAtWallClock;
      helper.armedAtMs = this.armedAt;
      try {
        helper.child.stdin.write('ARM\n');
      } catch (error) {
        helper.armError = error?.message ?? String(error);
      }
    }
    this.log(`pressure: armed (${reason}) at t+${Math.round(this.armedAt)} ms`);
  }

  /** Resolves once every helper has reported READY or FLOOR (or exited). */
  allReady() {
    return Promise.all(this.helpers.map((helper) => helper.ready));
  }

  /**
   * Release everything: a `RELEASE` line first (so the helper prints its own EXIT reason and frees
   * the pages by exiting), then SIGTERM, then SIGKILL. Idempotent.
   */
  release(reason) {
    this.releasePromise ??= this.#release(reason);
    return this.releasePromise;
  }

  async #release(reason) {
    if (this.helpers.length === 0) return;
    this.releaseStartedAt = this.clock();
    this.releaseReason = reason;
    this.releaseStartedAtWallClock = new Date().toISOString();
    for (const helper of this.helpers) {
      if (helper.exitedAtMs !== undefined) continue;
      helper.releaseRequestedAt = this.releaseStartedAtWallClock;
      helper.releaseRequestedAtMs = this.releaseStartedAt;
      try {
        helper.child.stdin.write('RELEASE\n');
      } catch {
        /* the helper is already gone; the kill escalation below covers it */
      }
    }
    this.log(
      `pressure: release requested (${reason}) at t+${Math.round(this.releaseStartedAt)} ms`
    );
    await this.#awaitExits(PRESSURE_LIMITS.releaseGraceMs);
    for (const helper of this.helpers) {
      if (helper.exitedAtMs === undefined) {
        helper.escalation = 'SIGTERM';
        try {
          helper.child.kill();
        } catch {
          /* ignore */
        }
      }
    }
    await this.#awaitExits(PRESSURE_LIMITS.killGraceMs);
    for (const helper of this.helpers) {
      if (helper.exitedAtMs === undefined) {
        helper.escalation = 'SIGKILL';
        try {
          helper.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    await this.#awaitExits(PRESSURE_LIMITS.killGraceMs);
  }

  async #awaitExits(timeoutMs) {
    const pending = this.helpers.filter((helper) => helper.exitedAtMs === undefined);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending.map((helper) => helper.exited)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Sanitized registry for the artifact: no child handles, no promises. */
  records() {
    return this.helpers.map((helper) => ({
      id: helper.id,
      pid: helper.pid,
      targetMib: helper.targetMib,
      allocatedMib: helper.allocatedMib,
      floorStopped: helper.floorStopped,
      freeMibAtFloor: helper.freeMibAtFloor,
      commitMs: helper.commitMs,
      spawnedAt: helper.spawnedAt,
      spawnedAtMs: helper.spawnedAtMs,
      stagedAt: helper.stagedAt,
      stagedAtMs: helper.stagedAtMs,
      armedAt: helper.armedAt,
      armedAtMs: helper.armedAtMs,
      readyAt: helper.readyAt,
      readyAtMs: helper.readyAtMs,
      releaseRequestedAt: helper.releaseRequestedAt,
      releaseRequestedAtMs: helper.releaseRequestedAtMs,
      exitedAt: helper.exitedAt,
      exitedAtMs: helper.exitedAtMs,
      // The helper's own reason when it managed to print one (released / ttl / staged-ttl /
      // hold-elapsed / parent-death), otherwise whatever the OS reported.
      exitReason:
        helper.reportedExitReason ??
        (helper.exitSignal
          ? `signal:${helper.exitSignal}`
          : helper.exitCode === undefined
            ? 'still-running'
            : `code:${helper.exitCode}`),
      exitCode: helper.exitCode,
      exitSignal: helper.exitSignal,
      heldMibAtExit: helper.heldMibAtExit,
      escalation: helper.escalation,
      spawnError: helper.spawnError,
      stdinError: helper.stdinError,
      armError: helper.armError,
      lines: helper.lines,
      stderr: helper.stderr,
    }));
  }

  /** Teardown gate: every helper must be gone before the next scenario may run. */
  teardownState() {
    const live = this.helpers.filter((helper) => helper.exitedAtMs === undefined);
    return {
      helperCount: this.helpers.length,
      helpersExited: live.length === 0,
      livePids: live.map((helper) => helper.pid),
      totalAllocatedMib: this.helpers.reduce((sum, helper) => sum + (helper.allocatedMib ?? 0), 0),
    };
  }
}

// A GPU process of our own would perturb exactly the telemetry we are trying to measure.
app.disableHardwareAcceleration();

function log(message) {
  process.stdout.write(`[quiet-trace] ${message}\n`);
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Expand %VAR% (Windows) and $VAR (POSIX) so configs can stay machine-independent. */
function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (whole, name) => process.env[name] ?? whole);
}

function gitRevision() {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return { revision: 'unknown', dirty: undefined };
  }
}

/**
 * Last-line-of-defence scrubber.
 *
 * Sanitization is mandatory and is done structurally when the artifact is built; this pass then
 * walks every string in the finished artifact and removes anything that still looks like a user
 * path or user name. It never touches numbers, so measurements survive intact.
 */
function scrubStrings(value, replacements) {
  if (typeof value === 'string') {
    let text = value;
    for (const [needle, token] of replacements) {
      if (!needle) continue;
      text = text.split(needle).join(token);
    }
    text = text.replace(/[A-Za-z]:[\\/][^\s"'|;,)]*/g, '<path>');
    text = text.replace(/(?:\/home|\/Users)\/[^\s"'|;,)]*/g, '<path>');
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubStrings(entry, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubStrings(entry, replacements)])
    );
  }
  return value;
}

/** Replace every prompt string with {workloadId, sha256, chars} plus observed token counts. */
function sanitizeWorkloads(workloads, tokenCountsById) {
  return workloads.map((workload) => {
    const common = {
      workloadId: workload.id,
      kind: workload.kind,
      weight: workload.weight,
      nPredict: workload.nPredict,
      tokenCounts: tokenCountsById.get(workload.id),
    };
    if (workload.kind === 'shared-prefix') {
      return {
        ...common,
        sharedPrefix: {
          sha256: sha256(workload.sharedPrefix),
          chars: workload.sharedPrefix.length,
        },
        suffixes: workload.suffixes.map((suffix) => ({
          sha256: sha256(suffix),
          chars: suffix.length,
        })),
      };
    }
    return {
      ...common,
      prompt: { sha256: sha256(workload.prompt), chars: workload.prompt.length },
    };
  });
}

async function fileIdentity(filePath) {
  try {
    const stats = await stat(filePath);
    return { name: path.basename(filePath), sizeBytes: stats.size };
  } catch {
    return { name: path.basename(filePath), sizeBytes: undefined };
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      cell: { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
      'user-data-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      scenario: { type: 'string' },
      'arm-at': { type: 'string' },
      'pressure-pct': { type: 'string' },
      'pressure-workers': { type: 'string' },
      'pressure-floor-mib': { type: 'string' },
      'pressure-ttl-ms': { type: 'string' },
      'pressure-chunk-mib': { type: 'string' },
      'transient-hold-ms': { type: 'string' },
      'transient-delay-ms': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const numeric = (key, fallback) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a number > 0`);
    return parsed;
  };
  const numericOrZero = (key, fallback) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a number >= 0`);
    return parsed;
  };

  const cellName = values.cell;
  if (!cellName || !CELL_NAMES.includes(cellName)) {
    throw new Error(`--cell must be one of: ${CELL_NAMES.join(', ')}`);
  }

  const scenarioName = values.scenario ?? 'quiet';
  const scenarioSpec = SCENARIOS[scenarioName];
  if (!scenarioSpec) {
    throw new Error(`--scenario must be one of: ${SCENARIO_NAMES.join(', ')}`);
  }
  const armAt = values['arm-at'] ?? scenarioSpec.armAt;
  if (scenarioSpec.pressure && !ARM_POINTS.includes(armAt)) {
    throw new Error(`--arm-at must be one of: ${ARM_POINTS.join(', ')}`);
  }
  if (!scenarioSpec.pressure && values['arm-at']) {
    throw new Error(`--arm-at is meaningless for --scenario ${scenarioName}`);
  }
  const configPath = path.resolve(
    REPO_ROOT,
    values.config ?? path.join(HERE, 'config.default.json')
  );
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const cell = config.cells?.[cellName];
  if (!cell) throw new Error(`config ${path.basename(configPath)} has no cell "${cellName}"`);

  const userDataDir = path.resolve(expandEnv(values['user-data-dir'] ?? config.userDataDir));
  await stat(userDataDir).catch(() => {
    throw new Error(
      'userDataDir does not exist; point --user-data-dir at the provisioned Electron userData directory'
    );
  });
  // paths.ts reads app.getPath('userData') at import time, so this must happen before the
  // library is imported. Pointing at the GUI's userData reuses its provisioned binary and models.
  app.setPath('userData', userDataDir);

  await app.whenReady();

  const distIndex = pathToFileURL(path.join(REPO_ROOT, 'dist', 'index.js')).href;
  const library = await import(distIndex);
  const { llamaServer, modelManager } = library;

  const model = await modelManager.getModelInfo(config.modelId);
  const binaryPath = library.getBinaryPath('llama', 'llama-server');

  // Cell-specific keys win over the shared `common` block.
  const calibrateConfig =
    cell.strategy === 'adaptive'
      ? {
          ...config.common,
          modelId: config.modelId,
          profiles: cell.profiles,
          ...(cell.includeKvCacheComparison !== undefined
            ? { includeKvCacheComparison: cell.includeKvCacheComparison }
            : {}),
          ...(cell.maxProbes !== undefined ? { maxProbes: cell.maxProbes } : {}),
          ...(cell.maxWallTimeMs !== undefined ? { maxWallTimeMs: cell.maxWallTimeMs } : {}),
        }
      : {
          ...config.common,
          modelId: config.modelId,
          profile: cell.profile,
          combos: cell.combos,
        };

  // The bands and schedule are now shipped policy constants, echoed into the artifact so a trace
  // stays self-describing without a separate armed-schedule block.
  const { LLAMA_CALIBRATION_DEFAULTS } = library;
  const resourcePolicy = {
    hostMemoryDecreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct,
    vramDecreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
    hostMemoryIncreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct,
    vramIncreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
    resourceBaselineSamples: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
    resourceBaselineSettleMs: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs,
    resourceDriftConfirmationReads: LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads,
    resourceCooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
    resourceTelemetryTimeoutMs: LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs,
    policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
  };
  const progressLog = [];
  const startedAtWallClock = new Date().toISOString();
  const startedAt = performance.now();
  /** Every scenario timestamp in the artifact is milliseconds from this instant. */
  const clock = () => performance.now() - startedAt;

  // ------------------------------------------------------------------
  // Scenario preflight (plan Phase 6 items 2-5)
  // ------------------------------------------------------------------
  const scenarioNotes = [];
  const scenarioTimeline = [];
  let pressurePlan;
  let baselineProxy;

  if (scenarioSpec.pressure) {
    if (armAt === 'policy-ready' && cell.strategy !== 'adaptive') {
      throw new Error(
        `--arm-at policy-ready needs an adaptive cell: exact mode emits no progress event between ` +
          `its baseline and its first pre-launch boundary. Use --cell adaptive-1p, or --arm-at probe-sampling.`
      );
    }
    const pct = numeric('pressure-pct', scenarioSpec.pctOfBaseline);
    if (pct > PRESSURE_LIMITS.maxPctOfBaseline) {
      throw new Error(
        `--pressure-pct ${pct} exceeds the hard cap of ${PRESSURE_LIMITS.maxPctOfBaseline}%`
      );
    }
    const workers = Math.max(1, Math.floor(numeric('pressure-workers', scenarioSpec.workers ?? 1)));
    const floorMib = Math.floor(numeric('pressure-floor-mib', PRESSURE_LIMITS.floorMib));
    const ttlMs = Math.floor(
      numeric('pressure-ttl-ms', scenarioSpec.ttlMs ?? PRESSURE_LIMITS.ttlMs)
    );
    if (ttlMs > PRESSURE_LIMITS.maxTtlMs) {
      throw new Error(
        `--pressure-ttl-ms ${ttlMs} exceeds the hard cap of ${PRESSURE_LIMITS.maxTtlMs} ms`
      );
    }
    const chunkMib = Math.floor(numeric('pressure-chunk-mib', PRESSURE_LIMITS.chunkMib));
    const holdMs =
      scenarioSpec.release === 'timer'
        ? Math.floor(numeric('transient-hold-ms', scenarioSpec.holdMs))
        : undefined;
    const armDelayMs = Math.floor(numericOrZero('transient-delay-ms', 0));

    // Sized from the same metric the guard reads, taken while the machine is still quiet: this is
    // a proxy for the run's fixed baseline, which only exists once calibrate() has collected it.
    baselineProxy = await readHostAvailable(library);
    const targetMib = Math.round((pct / 100) * (baselineProxy.availableBytes / MIB));
    const freeMibNow = Math.floor(baselineProxy.freememBytes / MIB);
    if (targetMib < PRESSURE_LIMITS.minTargetMib) {
      throw new Error(
        `computed pressure target ${targetMib} MiB is below the ${PRESSURE_LIMITS.minTargetMib} MiB minimum`
      );
    }
    if (freeMibNow - targetMib < floorMib) {
      throw new Error(
        `scenario ${scenarioName} needs ${targetMib} MiB but only ${freeMibNow} MiB is free and the ` +
          `hard floor is ${floorMib} MiB. Close applications, or lower the floor deliberately with ` +
          `--pressure-floor-mib. Note os.freemem() under-reports on Windows (free list only), so ` +
          `this check is conservative relative to the guard's Available Bytes metric.`
      );
    }
    pressurePlan = {
      requestedPctOfBaseline: pct,
      targetMib,
      workers,
      chunkMib,
      floorMib,
      ttlMs,
      stagedTtlMs: PRESSURE_LIMITS.stagedTtlMs,
      holdMs,
      armDelayMs,
      freeMibAtPreflight: freeMibNow,
    };
  }

  if (values['dry-run']) {
    log(
      `dry run: cell ${cellName} resolved, model ${model.id}, userData ${path.basename(userDataDir)}`
    );
    log(`dry run: enforcing resource policy ${JSON.stringify(resourcePolicy)}`);
    log(`dry run: scenario ${scenarioName} (${scenarioSpec.planItems.join(', ')})`);
    if (pressurePlan) {
      log(
        `dry run: would stage ${pressurePlan.workers} helper(s) totalling ${pressurePlan.targetMib} MiB ` +
          `(~${pressurePlan.requestedPctOfBaseline}% of ${(baselineProxy.availableBytes / MIB).toFixed(0)} MiB ` +
          `available, refresh ${baselineProxy.refreshStatus}), arm at ${armAt}, release ` +
          `${scenarioSpec.release}${pressurePlan.holdMs ? ` after ${pressurePlan.holdMs} ms` : ''}`
      );
      log(
        `dry run: rails - floor ${pressurePlan.floorMib} MiB (free now ${pressurePlan.freeMibAtPreflight} MiB), ` +
          `armed-hold ttl ${pressurePlan.ttlMs} ms, staged ttl ${pressurePlan.stagedTtlMs} ms, ` +
          `chunk ${pressurePlan.chunkMib} MiB`
      );
      log(`dry run: expectation - ${scenarioSpec.expectation}`);
    }
    log('dry run does not launch a server or spawn a helper; re-run without --dry-run.');
    return { skipped: true };
  }

  log(
    `cell ${cellName}: enforcing calibration (policy ${resourcePolicy.policyVersion}), scenario ${scenarioName}`
  );

  // ------------------------------------------------------------------
  // Scenario wiring: one controller, armed from the calibration's own progress events
  // ------------------------------------------------------------------
  let controller;
  let releaseTimer;
  let armTimer;
  if (pressurePlan) {
    controller = new PressureController({
      chunkMib: pressurePlan.chunkMib,
      floorMib: pressurePlan.floorMib,
      ttlMs: pressurePlan.ttlMs,
      stagedTtlMs: pressurePlan.stagedTtlMs,
      holdMs: pressurePlan.holdMs,
      clock,
      log,
    });
    // Staged before the call so arming costs only a stdin write plus the page-touch loop; an
    // idle helper holds nothing and is therefore inside the run's fixed baseline, not a drift.
    await controller.stage(pressurePlan.targetMib, pressurePlan.workers);
    scenarioTimeline.push({ kind: 'harness', atMs: clock(), event: 'helpers-staged' });
  }

  let armed = false;
  let lastProgressKey;
  const handleScenarioProgress = (progress) => {
    const probePhase = progressProbePhase(progress);
    const launch = progressLaunchLabel(progress);
    const key = `${progress.phase}|${probePhase ?? ''}|${launch ?? ''}`;
    if (key !== lastProgressKey && scenarioTimeline.length < 500) {
      lastProgressKey = key;
      scenarioTimeline.push({
        kind: 'progress',
        atMs: clock(),
        elapsedMs: Math.round(progress.elapsedMs),
        phase: progress.phase,
        probePhase,
        launch,
        terminalStatus: progress.terminalStatus,
      });
    }
    if (!controller || armed || !matchesArmPoint(progress, armAt)) return;
    armed = true;
    const fire = () => {
      controller.arm(`arm-point:${armAt}`);
      scenarioTimeline.push({ kind: 'harness', atMs: clock(), event: 'armed', armAt });
      if (scenarioSpec.release === 'timer') {
        // Hold is measured from the ARM instant, which is the observable anchor; the artifact also
        // records the READY instants so the effective pressure window is reconstructible.
        releaseTimer = setTimeout(() => {
          scenarioTimeline.push({ kind: 'harness', atMs: clock(), event: 'timed-release' });
          void controller.release('transient-hold-elapsed');
        }, pressurePlan.holdMs);
      }
    };
    if (pressurePlan.armDelayMs > 0) armTimer = setTimeout(fire, pressurePlan.armDelayMs);
    else fire();
  };

  let report;
  let failure;
  try {
    report = await llamaServer.calibrate({
      ...calibrateConfig,
      onProgress: (progress) => {
        if (progress.phase === 'done' || progress.phase === 'policy-ready') {
          progressLog.push({
            phase: progress.phase,
            terminalStatus: progress.terminalStatus,
            elapsedMs: progress.elapsedMs,
            budget: progress.budget,
          });
        }
        // A scenario must never be able to break the run it is instrumenting.
        try {
          handleScenarioProgress(progress);
        } catch (error) {
          scenarioNotes.push(`progress handler failed: ${error?.message ?? error}`);
        }
      },
    });
  } catch (error) {
    failure = {
      message: error?.message ?? String(error),
      name: error?.name,
      code: error?.details?.code,
      suggestion: error?.details?.suggestion,
      partialReport: summarizePartialReport(error?.details?.partialReport),
    };
    log(`calibration rejected: ${failure.code ?? 'unknown'} ${failure.message}`);
  } finally {
    // Controller-finally cleanup (plan rollback policy): normal completion, typed rejection, and
    // any harness error all converge here. The helper's TTL and parent-death rails only exist for
    // the case where this process is killed outright.
    if (armTimer) clearTimeout(armTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    if (controller) await controller.release('end-of-run');
  }

  const finishedAt = performance.now();

  // ------------------------------------------------------------------
  // Scenario outcome, recovery gate, teardown gate (plan Phase 6 item 6)
  // ------------------------------------------------------------------
  const resourceMonitoring =
    report?.resourceMonitoring ?? failure?.partialReport?.resourceMonitoring;
  const runHostBaseline = runHostBaselineBytes(resourceMonitoring);
  const resourceFailure = failure?.partialReport?.resourceFailure;
  const scenarioOutcome = {
    rejected: Boolean(failure),
    errorName: failure?.name,
    code: failure?.code,
    reportStatus: report?.status,
    terminalReason: report?.terminalReason,
    probesRecorded: report?.probes?.length ?? failure?.partialReport?.probeCount ?? 0,
    failureBoundary: resourceFailure?.boundary,
    failureAffectedMetrics: resourceFailure?.affectedMetrics,
    failureAffectedDirections: resourceFailure?.affectedDirections,
    failureProbeIndex: resourceFailure?.probeIndex,
    failureConfirmationPerformed: resourceFailure?.diagnostics?.confirmationPerformed,
    bestKnownPresent: Boolean(failure?.partialReport?.bestKnown),
  };

  let scenarioRecovery;
  if (scenarioSpec.pressure) {
    // Gate between scenarios: the machine must be back inside the quiet band before another run.
    await new Promise((resolve) => setTimeout(resolve, PRESSURE_LIMITS.recoverySettleMs));
    const after = await readHostAvailable(library);
    const reference = runHostBaseline ?? baselineProxy?.availableBytes;
    const deltaPct =
      reference && reference > 0
        ? ((reference - after.availableBytes) / reference) * 100
        : undefined;
    scenarioRecovery = {
      settleMs: PRESSURE_LIMITS.recoverySettleMs,
      referenceSource: runHostBaseline ? 'run-baseline' : 'preflight-proxy',
      referenceBytes: reference,
      availableBytes: after.availableBytes,
      refreshStatus: after.refreshStatus,
      decreasePctFromReference: deltaPct,
      withinQuietBand:
        deltaPct === undefined ? undefined : Math.abs(deltaPct) < PRESSURE_LIMITS.recoveryBandPct,
    };
    if (scenarioRecovery.withinQuietBand === false) {
      log(
        `WARNING: host availability is still ${deltaPct.toFixed(1)}% from the reference after release — ` +
          'let the machine settle and re-check before the next scenario.'
      );
    }
  }

  const teardown = controller?.teardownState();
  if (teardown && !teardown.helpersExited) {
    log(
      `WARNING: pressure helper(s) still alive: ${teardown.livePids.join(', ')} — kill them before the next scenario.`
    );
  }

  const scenarioBlock = {
    name: scenarioName,
    description: scenarioSpec.description,
    planItems: scenarioSpec.planItems,
    expectation: scenarioSpec.expectation,
    armAt: scenarioSpec.pressure ? armAt : undefined,
    releasePolicy: scenarioSpec.release,
    helperScript: scenarioSpec.pressure ? path.basename(HELPER_SCRIPT) : undefined,
    pressure: pressurePlan
      ? {
          ...pressurePlan,
          committedMib: teardown?.totalAllocatedMib,
          // The number that actually matters: what the guard saw, as a fraction of the REAL
          // fixed baseline rather than of the pre-run proxy.
          actualPctOfRunBaseline:
            runHostBaseline && teardown?.totalAllocatedMib !== undefined
              ? ((teardown.totalAllocatedMib * MIB) / runHostBaseline) * 100
              : undefined,
        }
      : undefined,
    baselineProxy,
    runHostBaselineBytes: runHostBaseline,
    armedAtMs: controller?.armedAt,
    armedAt: controller?.armedAtWallClock,
    releaseRequestedAtMs: controller?.releaseStartedAt,
    releaseRequestedAt: controller?.releaseStartedAtWallClock,
    releaseReason: controller?.releaseReason,
    helpers: controller?.records(),
    teardown,
    recovery: scenarioRecovery,
    timeline: scenarioSpec.pressure ? scenarioTimeline : undefined,
    outcome: scenarioOutcome,
    notes: scenarioNotes,
  };

  const tokenCountsById = new Map(
    (report?.workloads ?? []).map((signature) => [signature.id, signature.promptTokenCounts])
  );
  const { revision, dirty } = gitRevision();
  const modelFiles = model.shards?.length
    ? await Promise.all(model.shards.map((shard) => fileIdentity(shard.path)))
    : [await fileIdentity(model.path)];

  const artifact = {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    kind: 'calibration-quiet-trace',
    cell: cellName,
    cellDescription: cell.description,
    // Present since formatVersion 2: `quiet` reproduces the pre-scenario artifacts exactly.
    scenario: scenarioBlock,
    harness: {
      script: 'run-quiet-trace.mjs',
      repositoryRevision: revision,
      repositoryDirty: dirty,
      configFile: path.basename(configPath),
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      hardwareAccelerationDisabled: true,
      browserWindowsCreated: 0,
    },
    timestamps: {
      startedAt: startedAtWallClock,
      finishedAt: new Date().toISOString(),
      durationMs: finishedAt - startedAt,
    },
    identities: {
      binary: await fileIdentity(binaryPath),
      model: {
        id: model.id,
        name: model.name,
        architecture: model.ggufMetadata?.architecture,
        sizeBytes: model.size,
        files: modelFiles,
      },
    },
    calibrateConfig: {
      ...calibrateConfig,
      workloads: sanitizeWorkloads(calibrateConfig.workloads, tokenCountsById),
    },
    resourcePolicy,
    report: summarizeReport(report),
    failure,
    progress: progressLog,
    cleanup: {
      calibrating: llamaServer.isCalibrating(),
      serverStatus: llamaServer.getStatus(),
      everyProbeCleanupConfirmed: (report?.probes ?? []).every(
        (probe) => probe.cleanup?.confirmed === true
      ),
    },
  };

  const replacements = [
    [userDataDir, '<userData>'],
    [REPO_ROOT, '<repo>'],
    [os.homedir(), '<home>'],
    [os.userInfo().username, '<user>'],
  ];
  const sanitized = scrubStrings(artifact, replacements);

  const outPath = path.resolve(
    REPO_ROOT,
    values.out ?? path.join(HERE, 'artifacts', `${cellName}-${Date.now()}.json`)
  );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  log(`wrote ${path.relative(REPO_ROOT, outPath)}`);
  log(
    `status=${sanitized.report?.status ?? sanitized.failure?.code ?? 'unknown'} ` +
      `probes=${sanitized.report?.probeCount ?? sanitized.failure?.partialReport?.probeCount ?? 0} ` +
      `durationMs=${Math.round(finishedAt - startedAt)}`
  );
  if (scenarioSpec.pressure) {
    log(
      `scenario=${scenarioName} armedAtMs=${Math.round(scenarioBlock.armedAtMs ?? -1)} ` +
        `committedMib=${scenarioBlock.pressure?.committedMib ?? 0} ` +
        `pctOfRunBaseline=${scenarioBlock.pressure?.actualPctOfRunBaseline?.toFixed(2) ?? 'n/a'} ` +
        `boundary=${scenarioOutcome.failureBoundary ?? 'none'} ` +
        `code=${scenarioOutcome.code ?? 'none'} ` +
        `recoveredWithinBand=${scenarioRecovery?.withinQuietBand ?? 'n/a'}`
    );
    log(`scenario expectation: ${scenarioSpec.expectation}`);
  }
  if (sanitized.cleanup.calibrating || sanitized.cleanup.serverStatus !== 'stopped') {
    log(
      'WARNING: manager did not return to a stopped, unlocked state — investigate before the next cell.'
    );
  }
  return { skipped: false };
}

main().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`[quiet-trace] fatal: ${error?.stack ?? error}\n`);
    app.exit(1);
  }
);
