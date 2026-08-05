#!/usr/bin/env node
/**
 * Packed public-API verification.
 *
 * Builds the library, packs it exactly as `npm publish` would, installs that tarball into a
 * throwaway consumer project, runtime-checks its Electron-free policy entry under plain Node,
 * type-checks a small TypeScript consumer against its declared package entries, and bundles the
 * packed root for an isolated runtime smoke. Those public checks use package-name exports only.
 * A separate packaging-only archive smoke addresses the verified packed archive utility by its
 * absolute filesystem path; it is intentionally not a public subpath contract.
 *
 * The Electron-specific root cannot run directly under plain Node because Electron's npm stub has
 * no named `app` export. Its isolated bundle therefore uses a tiny `app.getPath()` build-time stub
 * so root evaluation can be exercised. The policy subpath is deliberately different and must
 * import directly without Electron installed or linked. CommonJS resolution is checked separately
 * without promising synchronous ESM execution across the whole supported Node/Electron range.
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
import AdmZip from 'adm-zip';
import { build as esbuildBuild } from 'esbuild';
import * as tar from 'tar';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const keepTempProject = args.has('--keep');
const skipBuild = args.has('--skip-build');

/** Runtime packages esbuild may traverse while bundling the packed root. */
const BUNDLE_LINKED_DEPENDENCIES = ['@huggingface', 'tar'];

/** Additional packages needed only while type-checking the packed declarations. */
const TYPE_LINKED_DEPENDENCIES = ['@types', 'electron'];

const ZIP_FIXTURE_FILES = [
  { entry: 'nested/alpha.txt', content: 'packed ZIP alpha\n' },
  { entry: '../../nested/deeper/beta.bin', content: 'packed ZIP beta\n' },
];
const EXPECTED_ZIP_FILES = ['nested/alpha.txt', 'nested/deeper/beta.bin'];

/** Plain-Node runtime consumer for the Electron-free policy entry. */
const POLICY_RUNTIME_SOURCE = `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as importedPolicy from 'genai-electron/llm-calibration-policy';

const require = createRequire(import.meta.url);
const isUnexportedPath = (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';

const { LLAMA_CALIBRATION_DEFAULTS: importedDefaults } = importedPolicy;
assert.equal(importedDefaults.policyVersion, 'llama-runtime-v4');
assert.equal('resolveLlamaCalibrationTimeBudget' in importedPolicy, false);
const rootEntry = require.resolve('genai-electron');
assert.equal(path.basename(rootEntry), 'index.js');
assert.equal(path.basename(path.dirname(rootEntry)), 'dist');
const policyEntry = require.resolve('genai-electron/llm-calibration-policy');
assert.equal(path.basename(policyEntry), 'llm-calibration-policy.js');
assert.equal(path.basename(path.dirname(policyEntry)), 'dist');
await assert.rejects(import('genai-electron/dist/config/defaults.js'), isUnexportedPath);
assert.throws(() => require.resolve('genai-electron/dist/config/defaults.js'), isUnexportedPath);
`;

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
  LlamaCalibrationResourceStabilityError,
  ServerError,
  formatErrorForUI,
} from 'genai-electron';
import { LLAMA_CALIBRATION_DEFAULTS } from 'genai-electron/llm-calibration-policy';
// @ts-expect-error the unreleased public budget resolver was removed from the package root
import { resolveLlamaCalibrationTimeBudget } from 'genai-electron';
// @ts-expect-error the Electron-free policy entry does not promote the internal budget resolver
import { resolveLlamaCalibrationTimeBudget as policyBudgetResolver } from 'genai-electron/llm-calibration-policy';
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

function assertPackedPackageContract(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const installTimeBuckets = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const bucket of installTimeBuckets) {
    if (manifest[bucket]?.['adm-zip'] !== undefined) {
      throw new Error(`packed manifest must not declare adm-zip in ${bucket}`);
    }
  }
  const bundledDependencies = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  if (bundledDependencies.includes('adm-zip')) {
    throw new Error('packed manifest must not bundle adm-zip as an install-time dependency');
  }
  const embeddedVersion = manifest.devDependencies?.['adm-zip'];
  const esbuildVersion = manifest.devDependencies?.esbuild;
  if (!/^\d+\.\d+\.\d+$/.test(embeddedVersion ?? '')) {
    throw new Error('packed manifest must exact-pin the embedded adm-zip development input');
  }
  if (!/^\d+\.\d+\.\d+$/.test(esbuildVersion ?? '')) {
    throw new Error('packed manifest must exact-pin the esbuild development input');
  }

  const noticePath = path.join(packageDir, 'THIRD_PARTY_NOTICES.md');
  if (!fs.existsSync(noticePath)) {
    throw new Error('packed payload is missing THIRD_PARTY_NOTICES.md');
  }
  const notice = fs.readFileSync(noticePath, 'utf8');
  if (
    !notice.includes(`adm-zip ${embeddedVersion}`) ||
    !notice.includes('Permission is hereby granted')
  ) {
    throw new Error('packed third-party notice is missing adm-zip version or MIT permission text');
  }

  const generatedSource = fs.readFileSync(
    path.join(packageDir, 'dist', 'generated', 'adm-zip-worker-source.js'),
    'utf8'
  );
  if (!generatedSource.includes(`ADM_ZIP_WORKER_VERSION = ${JSON.stringify(embeddedVersion)}`)) {
    throw new Error('packed generated ZIP worker does not match its exact adm-zip input pin');
  }
  if (
    !generatedSource.includes(
      'Copyright (c) 2012 Another-D-Mention Software and other contributors'
    ) ||
    !generatedSource.includes('Permission is hereby granted')
  ) {
    throw new Error('packed generated ZIP worker is missing the embedded adm-zip MIT notice');
  }
}

async function createZipFixture(zipPath) {
  const zip = new AdmZip();
  for (const fixture of ZIP_FIXTURE_FILES) {
    zip.addFile(fixture.entry, Buffer.from(fixture.content));
  }
  await zip.writeZipPromise(zipPath);
}

function assertNoNodeModulesAncestor(startDirectory) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, 'node_modules'))) {
      throw new Error(`isolated runtime has a node_modules ancestor at ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertNoAdmZipRuntimeSpecifier(bundlePath) {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const forbidden = [
    /(?:require|import)\s*\(\s*['"]adm-zip(?:\/[^'"]*)?['"]\s*\)/,
    /\.resolve\s*\(\s*['"]adm-zip(?:\/[^'"]*)?['"]\s*\)/,
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]adm-zip(?:\/[^'"]*)?['"]/,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error(`${path.basename(bundlePath)} contains a runtime adm-zip module specifier`);
  }
}

function makeIsolatedLauncherSource() {
  const expectedContents = Object.fromEntries(
    ZIP_FIXTURE_FILES.map((fixture, index) => [EXPECTED_ZIP_FILES[index], fixture.content])
  );

  return `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
assert.throws(
  () => require.resolve('adm-zip'),
  (error) => error?.code === 'MODULE_NOT_FOUND'
);

const rootBundle = await import('./root-bundle.mjs');
assert.equal(rootBundle.rootExportNames.includes('systemInfo'), true);
assert.equal(rootBundle.rootExportNames.includes('llamaServer'), true);

const { extractArchive } = await import('./archive-bundle.mjs');
const extractTo = path.join(runtimeDir, 'extracted');
const progress = [];
const files = await extractArchive(path.join(runtimeDir, 'fixture.zip'), extractTo, (event) => {
  progress.push(event);
});

const expectedFiles = ${JSON.stringify(EXPECTED_ZIP_FILES)};
const expectedContents = ${JSON.stringify(expectedContents)};
assert.deepEqual(files, expectedFiles);
assert.deepEqual(progress.map((event) => event.completedEntries), [0, 1, 2]);
assert.equal(progress.every((event) => event.totalEntries === 2), true);
assert.deepEqual(progress.slice(1).map((event) => event.entry), expectedFiles);
for (const relativePath of expectedFiles) {
  assert.equal(
    fs.readFileSync(path.join(extractTo, ...relativePath.split('/')), 'utf8'),
    expectedContents[relativePath]
  );
}

assert.equal(fs.existsSync(path.join(runtimeDir, 'nested')), false);
assert.equal(fs.existsSync(path.join(path.dirname(runtimeDir), 'nested')), false);
console.warn('[packed-api] isolated root and ZIP worker smoke passed');
`;
}

async function buildPackedRuntimeBundles({ consumerDir, packageDir, isolatedDir }) {
  const rootBundle = path.join(isolatedDir, 'root-bundle.mjs');
  const archiveBundle = path.join(isolatedDir, 'archive-bundle.mjs');
  const userDataDir = path.join(isolatedDir, 'electron-user-data');
  const packedArchiveModule = path.resolve(packageDir, 'dist', 'utils', 'archive-utils.js');
  if (!fs.existsSync(packedArchiveModule) || !path.isAbsolute(packedArchiveModule)) {
    throw new Error(`packed archive utility is missing at ${packedArchiveModule}`);
  }

  await esbuildBuild({
    absWorkingDir: consumerDir,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    outfile: rootBundle,
    platform: 'node',
    stdin: {
      contents: `import assert from 'node:assert/strict';
import * as packedApi from 'genai-electron';
export const rootExportNames = Object.keys(packedApi);
assert.equal(rootExportNames.includes('systemInfo'), true);
`,
      loader: 'js',
      resolveDir: consumerDir,
      sourcefile: 'packed-root-entry.mjs',
    },
    target: 'node22',
    plugins: [
      {
        name: 'packed-electron-stub',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            namespace: 'packed-electron-stub',
            path: 'electron',
          }));
          build.onLoad({ filter: /.*/, namespace: 'packed-electron-stub' }, () => ({
            contents: `export const app = {
  getPath(name) {
    if (name !== 'userData') throw new Error('unexpected Electron path request: ' + name);
    return ${JSON.stringify(userDataDir)};
  },
};
`,
            loader: 'js',
          }));
        },
      },
    ],
  });

  await esbuildBuild({
    absWorkingDir: consumerDir,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    outfile: archiveBundle,
    platform: 'node',
    stdin: {
      contents: "export { extractArchive } from 'packed-archive-utils';\n",
      loader: 'js',
      resolveDir: consumerDir,
      sourcefile: 'packed-archive-entry.mjs',
    },
    target: 'node22',
    plugins: [
      {
        name: 'packed-archive-seam',
        setup(build) {
          build.onResolve({ filter: /^packed-archive-utils$/ }, () => ({
            path: packedArchiveModule,
          }));
        },
      },
    ],
  });

  assertNoAdmZipRuntimeSpecifier(rootBundle);
  assertNoAdmZipRuntimeSpecifier(archiveBundle);
}

async function main() {
  if (!skipBuild) {
    console.warn('[packed-api] building the library');
    run(process.execPath, [path.join(repoRoot, 'scripts', 'generate-zip-worker.mjs'), '--check']);
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
    assertPackedPackageContract(packageDir);

    const electronLink = path.join(consumerModules, 'electron');
    if (fs.existsSync(electronLink)) {
      throw new Error('runtime policy smoke must run before Electron is linked');
    }
    const runtimeConsumer = path.join(consumerDir, 'policy-runtime.mjs');
    fs.writeFileSync(runtimeConsumer, POLICY_RUNTIME_SOURCE);
    console.warn('[packed-api] importing the policy entry and checking CommonJS resolution');
    run(process.execPath, [runtimeConsumer], { cwd: consumerDir });

    for (const dependency of BUNDLE_LINKED_DEPENDENCIES) {
      if (!linkDependency(dependency, consumerModules)) {
        throw new Error(`bundle dependency ${dependency} is not installed in the repository`);
      }
    }

    const isolatedDir = path.join(tempRoot, 'isolated-runtime');
    fs.mkdirSync(isolatedDir, { recursive: true });
    const fixtureZip = path.join(isolatedDir, 'fixture.zip');
    await createZipFixture(fixtureZip);
    console.warn('[packed-api] bundling the packed root and archive seam for isolated execution');
    await buildPackedRuntimeBundles({ consumerDir, packageDir, isolatedDir });
    const isolatedLauncher = path.join(isolatedDir, 'run.mjs');
    fs.writeFileSync(isolatedLauncher, makeIsolatedLauncherSource());
    assertNoNodeModulesAncestor(isolatedDir);
    console.warn('[packed-api] running bundles with adm-zip unavailable');
    run(process.execPath, [isolatedLauncher], { cwd: isolatedDir });

    for (const dependency of TYPE_LINKED_DEPENDENCIES) {
      if (!linkDependency(dependency, consumerModules)) {
        throw new Error(`type-check dependency ${dependency} is not installed in the repository`);
      }
    }

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
