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
 * This file lives outside the npm package (`files` is ["dist","README.md","LICENSE"]) and
 * deep-imports the BUILT library, so `npm run build` must run first.
 *
 * Usage:
 *   npx electron scripts/calibration-quiet-trace/run-quiet-trace.mjs \
 *     --cell adaptive-1p --out scripts/calibration-quiet-trace/artifacts/<name>.json
 *
 * See README.md in this directory for the four-cell matrix and the artifact schema.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Bump together with the artifact shape; replay tooling switches on this.
 *
 * `1` was the shadow era: those artifacts carry `shadowSchedule`/`shadowTrace` and are what
 * `replay-thresholds.mjs` reads. `2` is the enforcing era: the guard's decisions are the run's own
 * decisions, so there is no separate trace to replay and threshold replay does not apply.
 */
const ARTIFACT_FORMAT_VERSION = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CELL_NAMES = ['adaptive-1p', 'adaptive-2p', 'exact-near-capacity', 'exact-lower-pressure'];

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

function summarizeRecommendation(recommendation) {
  if (!recommendation) return undefined;
  return {
    profileIndex: recommendation.profileIndex,
    cellId: recommendation.cellId,
    scoreMs: recommendation.scoreMs,
    gpuLayers: recommendation.startConfig?.gpuLayers,
    contextSize: recommendation.startConfig?.contextSize,
    evidence: recommendation.evidence,
  };
}

function summarizeReport(report) {
  if (!report) return undefined;
  return {
    schemaVersion: report.schemaVersion,
    policyVersion: report.policyVersion,
    strategy: report.strategy,
    status: report.status,
    terminalReason: report.terminalReason,
    createdAt: report.createdAt,
    probeCount: report.probes.length,
    warnings: report.warnings,
    // Schema v3: the run's ONE fixed baseline per metric, which every probe boundary below is
    // measured against. Retained verbatim - it is what makes a trace replayable.
    resourceMonitoring: report.resourceMonitoring,
    selected: summarizeRecommendation(report.selected),
    provisional: summarizeRecommendation(report.provisional),
    fallback: summarizeRecommendation(report.fallback),
    selectionEvidence: report.selectionEvidence,
    confidence: report.confidence,
    probes: report.probes.map((probe) => ({
      probeIndex: probe.probeIndex,
      purpose: probe.purpose,
      fidelity: probe.fidelity,
      cellId: probe.cellId,
      profileIndex: probe.profileIndex,
      gpuLayers: probe.resolvedConfig?.gpuLayers,
      contextSize: probe.resolvedConfig?.contextSize,
      operationalStatus: probe.operationalStatus,
      boundaryDecision: probe.boundaryDecision,
      memoryEvidence: probe.memoryEvidence,
      scoreMs: probe.scoreMs,
      durationMs: probe.durationMs,
      resourceValidity: probe.resourceValidity,
      cleanupConfirmed: probe.cleanup?.confirmed,
      // Schema v3 replaced the per-probe before/after reduction with both guarded boundaries.
      resourceBoundaries: probe.resourceBoundaries,
      diagnostics: probe.diagnostics
        ? {
            kvBytesEstimate: probe.diagnostics.kvBytesEstimate,
            warnings: probe.diagnostics.warnings,
          }
        : undefined,
    })),
  };
}

function summarizePartialReport(partial) {
  if (!partial || typeof partial !== 'object') return undefined;
  return {
    schemaVersion: partial.schemaVersion,
    strategy: partial.strategy,
    status: partial.status,
    probeCount: Array.isArray(partial.probes) ? partial.probes.length : undefined,
    warnings: partial.warnings,
    cleanupConfirmed: partial.cleanupConfirmed,
    resourceMonitoring: partial.resourceMonitoring,
    // Retained verbatim: the boundary diagnostics are the whole point of an enforcement smoke.
    resourceFailure: partial.resourceFailure,
    diagnosticCandidate: partial.diagnosticCandidate,
    probes: (partial.probes ?? []).map((probe) => ({
      probeIndex: probe.probeIndex,
      purpose: probe.purpose,
      gpuLayers: probe.resolvedConfig?.gpuLayers,
      operationalStatus: probe.operationalStatus,
      boundaryDecision: probe.boundaryDecision,
      resourceValidity: probe.resourceValidity,
      terminationReason: probe.terminationReason,
      cleanupConfirmed: probe.cleanup?.confirmed,
    })),
  };
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
    },
    allowPositionals: true,
    strict: false,
  });

  const cellName = values.cell;
  if (!cellName || !CELL_NAMES.includes(cellName)) {
    throw new Error(`--cell must be one of: ${CELL_NAMES.join(', ')}`);
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
          ...(cell.targetProbes !== undefined ? { targetProbes: cell.targetProbes } : {}),
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

  if (values['dry-run']) {
    log(
      `dry run: cell ${cellName} resolved, model ${model.id}, userData ${path.basename(userDataDir)}`
    );
    log(`dry run: enforcing resource policy ${JSON.stringify(resourcePolicy)}`);
    log('dry run does not launch a server; re-run without --dry-run to record a trace.');
    return { skipped: true };
  }

  log(`cell ${cellName}: enforcing calibration (policy ${resourcePolicy.policyVersion})`);

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
          });
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
  }

  const finishedAt = performance.now();

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
