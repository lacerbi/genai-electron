#!/usr/bin/env node
/**
 * Packed public-API verification.
 *
 * Builds the library, packs it exactly as `npm publish` would, installs that tarball into a
 * throwaway consumer project, and type-checks a small TypeScript consumer against it. The consumer
 * imports ONLY the package name, so it exercises the generated declarations and the package's own
 * entry points - never a source-relative path that would hide a missing export or a type that never
 * made it into `dist/`.
 *
 * Why compile-only: importing the package at runtime outside Electron fails on `electron`'s own
 * stub (`import { app } from 'electron'` has no named exports in a plain Node process). The contract
 * this harness protects - specialized error identity, details narrowing, schema-v4 shapes, and the
 * absence of removed fields - is entirely a declaration-level contract.
 *
 * Usage:
 *   node scripts/packed-api/run.mjs [--keep] [--skip-build]
 *
 *   --keep        leave the temporary consumer project in place and print its path
 *   --skip-build  reuse the existing dist/ instead of recompiling first
 *
 * @module scripts/packed-api/run
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const keepTempProject = args.has('--keep');
const skipBuild = args.has('--skip-build');

/** Dependencies whose types the generated declarations may reference. */
const LINKED_DEPENDENCIES = ['@types', '@huggingface', 'electron', 'adm-zip', 'tar'];

/**
 * The external consumer.
 *
 * Kept inline so the repository's own lint/format/tsc passes never try to own a file that
 * deliberately imports a package that is not installed here.
 */
const CONSUMER_SOURCE = `/**
 * External consumer of the packed genai-electron tarball.
 *
 * Every import below is from the package NAME. Nothing here may reach into src/ or dist/.
 */
import {
  LLAMA_CALIBRATION_DEFAULTS,
  LlamaCalibrationResourceStabilityError,
  ServerError,
  formatErrorForUI,
} from 'genai-electron';
// @ts-expect-error the unreleased public budget resolver was removed from the package root
import { resolveLlamaCalibrationTimeBudget } from 'genai-electron';
// @ts-expect-error the internal adaptive terminal-status helper is not a package-root export
import type { LlamaAdaptiveCalibrationTerminalStatus } from 'genai-electron';
import type {
  LlamaAdaptiveCalibrationBestKnown,
  LlamaAdaptiveCalibrationBudgetReport,
  LlamaAdaptiveCalibrationConfig,
  LlamaAdaptiveCalibrationPreparationTimeLimit,
  LlamaAdaptiveCalibrationReport,
  LlamaAdaptiveCalibrationSelectionEvidence,
  LlamaAdaptiveProgressBudget,
  LlamaCalibrationPartialReport,
  LlamaCalibrationProbe,
  LlamaCalibrationProbeResourceBoundaries,
  LlamaCalibrationProbeResourceValidity,
  LlamaCalibrationRecommendation,
  LlamaCalibrationReport,
  LlamaCalibrationResourceBoundaryDiagnostic,
  LlamaCalibrationResourceFailure,
  LlamaCalibrationResourceFailurePartialReport,
  LlamaCalibrationResourceMetric,
  LlamaCalibrationResourceMetricMonitoring,
  LlamaCalibrationResourceMonitoring,
  LlamaCalibrationResourceMonitoringCoverage,
  LlamaCalibrationResourceReading,
  LlamaCalibrationResourceSnapshotDiagnostic,
  LlamaCalibrationResourceStabilityCode,
  LlamaCalibrationResourceStabilityDetails,
  LlamaCalibrationResourceStabilityDetailsCommon,
  LlamaCalibrationResourceStabilityMethodology,
  LlamaExactCalibrationBestKnown,
  LlamaExactCalibrationConfig,
  MemoryTelemetryRefreshStatus,
  TelemetryCommandOptions,
  UIErrorFormat,
} from 'genai-electron';

// --- schema-v4 report, progress, and partial shapes -------------------------------------------

const hostAdaptiveConfig: LlamaAdaptiveCalibrationConfig = {
  modelId: 'model',
  profiles: [{ contextSize: 12_288, parallelRequests: 1 }],
  workloads: [{ id: 'cold', kind: 'cold-prefill', prompt: 'prompt', nPredict: 8 }],
  maxWallTimeMs: 60 * 60_000,
};
const unboundedProgressBudget: LlamaAdaptiveProgressBudget = {
  maxWallTimeMs: LLAMA_CALIBRATION_DEFAULTS.adaptiveMaxWallTimeMs,
  remainingMs: LLAMA_CALIBRATION_DEFAULTS.adaptiveMaxWallTimeMs - 1_000,
};
const boundedProgressBudget: LlamaAdaptiveProgressBudget = {
  ...unboundedProgressBudget,
  maxProbes: 7,
  remainingProbes: 6,
};
const reportBudget: LlamaAdaptiveCalibrationBudgetReport = {
  maxWallTimeMs: LLAMA_CALIBRATION_DEFAULTS.adaptiveMaxWallTimeMs,
  elapsedMs: LLAMA_CALIBRATION_DEFAULTS.adaptiveMaxWallTimeMs + 250,
  overrunMs: 250,
};

const hostMonitoring: LlamaCalibrationResourceMetricMonitoring = {
  metric: 'hostMemory',
  enabled: true,
  baselineBytes: 16_000_000_000,
  decreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct,
  increaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct,
  attempts: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
  trustedSamples: [16_000_000_000, 16_050_000_000, 16_100_000_000],
};
const coverage: LlamaCalibrationResourceMonitoringCoverage = 'partial';
const monitoring: LlamaCalibrationResourceMonitoring = {
  coverage,
  enabledMetrics: ['hostMemory'],
  metrics: [
    hostMonitoring,
    {
      metric: 'vram',
      enabled: false,
      decreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
      increaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
      attempts: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
      trustedSamples: [],
    },
  ],
};

const trusted: LlamaCalibrationResourceReading = {
  metric: 'hostMemory',
  enabled: true,
  trusted: true,
  availableBytes: 14_000_000_000,
  decreasePctFromBaseline: 12.5,
  decreaseThresholdPct: 10,
  increaseThresholdPct: 20,
  suspicious: true,
  suspiciousDirection: 'decrease',
};
const untrusted: LlamaCalibrationResourceReading = {
  metric: 'vram',
  enabled: false,
  trusted: false,
  untrustedReason: 'telemetry-refresh-failed',
  suspicious: false,
};
const snapshot: LlamaCalibrationResourceSnapshotDiagnostic = {
  readings: [trusted, untrusted],
  suspiciousMetrics: ['hostMemory'],
  untrustedMetrics: [],
};
const boundary: LlamaCalibrationResourceBoundaryDiagnostic = {
  boundary: 'post-cleanup',
  confirmationPerformed: true,
  initial: snapshot,
  confirmation: snapshot,
  initiallySuspiciousMetrics: ['hostMemory'],
  warnings: [],
};
const boundaries: LlamaCalibrationProbeResourceBoundaries = {
  preLaunch: { ...boundary, boundary: 'pre-launch' },
  postCleanup: boundary,
};
const failure: LlamaCalibrationResourceFailure = {
  boundary: 'post-cleanup',
  affectedMetrics: ['hostMemory'],
  affectedDirections: { hostMemory: 'decrease' },
  probeIndex: 1,
  diagnostics: boundary,
};
const recommendation: LlamaCalibrationRecommendation = {
  profileIndex: 0,
  cellId: 'p0:c12288:swa-window:kv-q8_0',
  startConfig: { contextSize: 12_288, parallelRequests: 1, gpuLayers: 20 },
  scoreMs: 1_234,
};
const bestKnown: LlamaAdaptiveCalibrationBestKnown = {
  recommendation,
  evidence: 'independent-reproduction',
  sourceProbeIndexes: [0],
};
const exactBestKnown: LlamaExactCalibrationBestKnown = {
  recommendation,
  evidence: 'single-launch-measurement',
  sourceProbeIndexes: [0],
};
const partialReport: LlamaCalibrationResourceFailurePartialReport = {
  schemaVersion: 4,
  policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
  strategy: 'adaptive',
  status: 'failed',
  createdAt: new Date().toISOString(),
  resourceMonitoring: monitoring,
  probes: [],
  warnings: [],
  cleanupConfirmed: true,
  resourceFailure: failure,
  searchCompleteness: 'partial',
  budget: reportBudget,
  bestKnown,
};
// The resource-failure partial is usable wherever the general partial is expected.
const generalPartial: LlamaCalibrationPartialReport = partialReport;
const preparationLimit: LlamaAdaptiveCalibrationPreparationTimeLimit = {
  resultKind: 'preparation-time-limit',
  schemaVersion: 4,
  policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
  createdAt: new Date().toISOString(),
  strategy: 'adaptive',
  phase: 'preparing',
  status: 'time-limited',
  searchCompleteness: 'partial',
  terminalReason: 'deadline reached while provisioning',
  budget: reportBudget,
  probes: [],
  warnings: [],
  cleanupConfirmed: true,
};
const exactConfig: LlamaExactCalibrationConfig = {
  modelId: 'model',
  profile: { contextSize: 12_288, parallelRequests: 1 },
  workloads: [{ id: 'cold', kind: 'cold-prefill', prompt: 'prompt', nPredict: 8 }],
  combos: [{ overrides: { gpuLayers: 20 } }],
};

export function readReport(report: LlamaCalibrationReport): {
  kind: 'report';
  schemaVersion: 4;
  coverage: LlamaCalibrationResourceMonitoringCoverage;
  methodology: LlamaCalibrationResourceStabilityMethodology;
  metrics: readonly LlamaCalibrationResourceMetric[];
} | { kind: 'preparation-time-limit'; reason: string } {
  if (report.resultKind === 'preparation-time-limit') {
    return { kind: report.resultKind, reason: report.terminalReason };
  }
  const schemaVersion: 4 = report.schemaVersion;
  return {
    kind: report.resultKind,
    schemaVersion,
    coverage: report.resourceMonitoring.coverage,
    methodology: report.methodology.resourceStability,
    metrics: report.resourceMonitoring.enabledMetrics,
  };
}

export function readProbe(probe: LlamaCalibrationProbe): {
  validity: LlamaCalibrationProbeResourceValidity;
  boundaries?: LlamaCalibrationProbeResourceBoundaries;
} {
  return { validity: probe.resourceValidity, boundaries: probe.resourceBoundaries };
}

export function readAdaptiveSelection(report: LlamaAdaptiveCalibrationReport) {
  const evidence: LlamaAdaptiveCalibrationSelectionEvidence | undefined =
    report.selectionEvidence;
  return {
    selected: report.selected?.startConfig,
    evidence,
    completeness: report.searchCompleteness,
    timeBudgetMs: report.budget.maxWallTimeMs,
  };
}

// --- typed rejection --------------------------------------------------------------------------

export function describeCalibrationFailure(error: unknown): string {
  if (!(error instanceof LlamaCalibrationResourceStabilityError)) {
    return error instanceof ServerError ? 'other-server-error' : 'unknown';
  }
  // Still a ServerError, so existing handling keeps working.
  const asServerError: ServerError = error;
  void asServerError;
  const common: LlamaCalibrationResourceStabilityDetailsCommon = error.details;
  void common.suggestion;
  const details: LlamaCalibrationResourceStabilityDetails = error.details;
  switch (details.code) {
    case 'CALIBRATION_RESOURCE_DRIFT': {
      const code: LlamaCalibrationResourceStabilityCode = details.code;
      return \`\${code}:\${details.partialReport.resourceFailure.affectedMetrics.join(',')}\`;
    }
    case 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED': {
      const formatted: UIErrorFormat = formatErrorForUI(error);
      return \`\${formatted.code}:\${details.partialReport.resourceFailure.boundary}\`;
    }
  }
}

export const sampleRejection = new LlamaCalibrationResourceStabilityError('resources changed', {
  code: 'CALIBRATION_RESOURCE_DRIFT',
  suggestion: 'Close heavy applications and calibrate again from the beginning.',
  partialReport,
});

// --- truthful telemetry surface ---------------------------------------------------------------

export const refreshStatuses: readonly MemoryTelemetryRefreshStatus[] = [
  'refreshed',
  'not-required',
  'failed',
];
export const telemetryOptions: TelemetryCommandOptions = {
  timeoutMs: LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs,
  signal: new AbortController().signal,
};

// --- removed surface (must NOT compile) --------------------------------------------------------

export function removedSurface(report: LlamaCalibrationReport) {
  return report.probes.map((probe) => ({
    // @ts-expect-error resourceRegime was removed with re-anchoring
    regime: probe.resourceRegime,
    // @ts-expect-error the per-probe before/after reduction was replaced by boundary diagnostics
    legacyHost: probe.diagnostics?.hostAvailableMemory,
  }));
}

export function removedAdaptiveSurface(report: LlamaAdaptiveCalibrationReport) {
  return {
    // @ts-expect-error schema v4 removed provisional; selected carries explicit evidence instead
    provisional: report.provisional,
    // @ts-expect-error adaptive confidence was replaced by selectionEvidence
    confidence: report.confidence,
  };
}

export const removedAdaptiveConfig: LlamaAdaptiveCalibrationConfig = {
  ...hostAdaptiveConfig,
  // @ts-expect-error targetProbes was removed; time is the primary adaptive budget
  targetProbes: 10,
};

export const exactWithAdaptiveTime: LlamaExactCalibrationConfig = {
  ...exactConfig,
  // @ts-expect-error exact mode does not accept adaptive time budgets
  maxWallTimeMs: 60_000,
};

// @ts-expect-error bounded progress must expose maxProbes and remainingProbes together
export const invalidBoundedProgressBudget: LlamaAdaptiveProgressBudget = {
  maxWallTimeMs: 60_000,
  remainingMs: 30_000,
  maxProbes: 7,
};

export const emptyBestKnown: LlamaAdaptiveCalibrationBestKnown = {
  recommendation,
  evidence: 'single-full-launch',
  // @ts-expect-error bestKnown must cite at least one accepted source probe
  sourceProbeIndexes: [],
};

export const removedBudgetSurface = {
  // @ts-expect-error report budgets no longer expose speculative finalization state
  finalization: reportBudget.enteredFinalization,
  // @ts-expect-error progress budgets expose remainingMs, not duplicate elapsed fields
  elapsed: unboundedProgressBudget.budgetElapsedMs,
  // @ts-expect-error progress budgets no longer expose an estimate
  estimate: unboundedProgressBudget.estimatedNextProbeCycleMs,
};

export const removedDefaults = {
  // @ts-expect-error resourceDriftThresholdPct was replaced by independent per-metric bands
  drift: LLAMA_CALIBRATION_DEFAULTS.resourceDriftThresholdPct,
  // @ts-expect-error resourceSettledTolerancePct belonged to the removed settled-level logic
  settled: LLAMA_CALIBRATION_DEFAULTS.resourceSettledTolerancePct,
  // @ts-expect-error resourceDriftRetries belonged to the removed re-measurement loop
  retries: LLAMA_CALIBRATION_DEFAULTS.resourceDriftRetries,
  // @ts-expect-error the speculative admission margin was removed
  margin: LLAMA_CALIBRATION_DEFAULTS.adaptiveAdmissionMarginMultiplier,
  // @ts-expect-error the released estimator fallback is no longer part of calibration defaults
  unobserved: LLAMA_CALIBRATION_DEFAULTS.unobservedProbeDurationPolicy,
};

export const consumed = {
  boundaries,
  boundedProgressBudget,
  exactBestKnown,
  exactConfig,
  generalPartial,
  hostAdaptiveConfig,
  monitoring,
  preparationLimit,
  reportBudget,
  sampleRejection,
  telemetryOptions,
  refreshStatuses,
  unboundedProgressBudget,
};
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'node16',
    moduleResolution: 'node16',
    strict: true,
    noEmit: true,
    // The package's own declarations are verified by the repository build; here we check what a
    // consumer can express with them.
    skipLibCheck: true,
    types: ['node'],
    forceConsistentCasingInFileNames: true,
  },
  include: ['src/**/*.ts'],
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(
      `${command} ${commandArgs.join(' ')} exited with code ${String(result.status)}`
    );
  }
  return result;
}

/**
 * Run npm through its JS entry point rather than the `npm.cmd` shim.
 *
 * Node refuses to `spawnSync` a `.cmd` file without a shell (EINVAL), and a shell would make the
 * temp-directory argument depend on quoting rules. `npm_execpath` is set whenever this runs under
 * `npm run`; the sibling-of-node path covers a direct `node scripts/packed-api/run.mjs`.
 */
function runNpm(commandArgs, options = {}) {
  const fromEnv = process.env.npm_execpath;
  const candidates = [
    fromEnv && fromEnv.endsWith('.js') ? fromEnv : undefined,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && fs.existsSync(candidate));
  const cli = candidates[0];
  if (!cli) throw new Error('could not locate npm-cli.js to run `npm pack`');
  return run(process.execPath, [cli, ...commandArgs], options);
}

function linkDependency(name, consumerModules) {
  const source = path.join(repoRoot, 'node_modules', name);
  if (!fs.existsSync(source)) return false;
  const target = path.join(consumerModules, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, 'junction');
  return true;
}

async function main() {
  if (!skipBuild) {
    console.warn('[packed-api] building the library');
    run(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')]);
  }
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.d.ts'))) {
    throw new Error('dist/index.d.ts is missing; run without --skip-build');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genai-electron-packed-'));
  try {
    console.warn('[packed-api] packing the library');
    const packed = runNpm(['pack', '--json', '--pack-destination', tempRoot], { capture: true });
    const tarballName = JSON.parse(packed.stdout)[0]?.filename;
    if (typeof tarballName !== 'string') {
      throw new Error('npm pack did not report a tarball filename');
    }
    // npm scopes package filenames with a directory separator only for scoped names.
    const tarball = path.join(tempRoot, path.basename(tarballName));
    if (!fs.existsSync(tarball)) throw new Error(`packed tarball not found at ${tarball}`);

    const consumerDir = path.join(tempRoot, 'consumer');
    const consumerModules = path.join(consumerDir, 'node_modules');
    const packageDir = path.join(consumerModules, 'genai-electron');
    fs.mkdirSync(path.join(consumerDir, 'src'), { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });

    console.warn('[packed-api] installing the tarball into a throwaway consumer project');
    await tar.x({ file: tarball, cwd: packageDir, strip: 1 });
    for (const dependency of LINKED_DEPENDENCIES) linkDependency(dependency, consumerModules);

    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'genai-electron-packed-consumer',
          private: true,
          version: '0.0.0',
          type: 'module',
          dependencies: { 'genai-electron': `file:${tarball.replace(/\\/g, '/')}` },
        },
        null,
        2
      )}\n`
    );
    fs.writeFileSync(
      path.join(consumerDir, 'tsconfig.json'),
      `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`
    );
    fs.writeFileSync(path.join(consumerDir, 'src', 'consumer.ts'), CONSUMER_SOURCE);

    console.warn('[packed-api] type-checking the consumer against the packed declarations');
    run(
      process.execPath,
      [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
      { cwd: consumerDir }
    );
    console.warn(`[packed-api] OK - ${path.basename(tarball)} satisfies the public API contract`);
  } finally {
    if (keepTempProject) {
      console.warn(`[packed-api] keeping ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
