/**
 * Offline threshold replay for quiet-trace artifacts (PLAN-calibration-resource-stability Phase 1.6).
 *
 * Plain Node (no Electron, no server, no model): it reads the retained snapshots out of one or more
 * artifacts and re-decides every boundary through the SAME pure functions the manager uses, at each
 * candidate threshold pair. Nothing here re-implements guard logic — `dist/utils/llama-resource-guard.js`
 * is the only decision source, so a replay result is exactly what enforcement would have concluded.
 *
 * The replay principle: the live capture threshold must be the LOWEST candidate you intend to
 * replay. A confirmation snapshot only exists when the live run found the initial read suspicious,
 * so any candidate at or above the capture threshold has its confirmation available, while a
 * candidate below it can be left unreplayable. Those boundaries are reported as `unreplayable`
 * rather than silently resolved.
 *
 * Usage:
 *   node scripts/calibration-quiet-trace/replay-thresholds.mjs \
 *     scripts/calibration-quiet-trace/artifacts/*.json --thresholds 10,15,20,25
 *   node ... --host 10,15 --vram 10,25 --json
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SUPPORTED_FORMAT_VERSIONS = new Set([1]);

const guard = await import(
  pathToFileURL(path.join(REPO_ROOT, 'dist', 'utils', 'llama-resource-guard.js')).href
);
const {
  concludeResourceBoundary,
  evaluateResourceSnapshot,
  mergeResourceSnapshotEvaluations,
  requiresConfirmation,
} = guard;

function parseList(value) {
  return String(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

function candidatePairs(hostList, vramList) {
  const pairs = [];
  for (const host of hostList) {
    for (const vram of vramList) {
      pairs.push({ hostMemoryDecreaseThresholdPct: host, vramDecreaseThresholdPct: vram });
    }
  }
  return pairs;
}

function decreaseSummary(evaluation) {
  return {
    hostMemory: evaluation.metrics.hostMemory.decreasePctFromBaseline,
    vram: evaluation.metrics.vram.decreasePctFromBaseline,
  };
}

/**
 * Replay one boundary event.
 *
 * `capturedConfirmations` is what the live run actually recorded; when a candidate finds the
 * initial read suspicious and no confirmation exists, the boundary cannot be replayed at that
 * candidate and is reported as such instead of being concluded from missing data.
 */
function replayBoundary(baseline, event, thresholds) {
  const initial = evaluateResourceSnapshot(baseline, event.initialSnapshot, thresholds);
  const initiallySuspicious = requiresConfirmation(initial);
  if (!initiallySuspicious) {
    const result = concludeResourceBoundary({ boundary: event.boundary, initial });
    return {
      probeOrdinal: event.probeOrdinal,
      boundary: event.boundary,
      strategy: event.strategy,
      initiallySuspiciousMetrics: [],
      wouldConfirm: false,
      conclusion: result.conclusion,
      decreasePct: decreaseSummary(initial),
    };
  }
  const confirmations = (event.confirmationSnapshots ?? []).map((snapshot) =>
    evaluateResourceSnapshot(baseline, snapshot, thresholds)
  );
  if (confirmations.length === 0) {
    return {
      probeOrdinal: event.probeOrdinal,
      boundary: event.boundary,
      strategy: event.strategy,
      initiallySuspiciousMetrics: [...initial.suspiciousMetrics],
      wouldConfirm: true,
      conclusion: 'unreplayable',
      note: 'the live capture threshold was above this candidate, so no confirmation snapshot exists',
      decreasePct: decreaseSummary(initial),
    };
  }
  const confirmation = mergeResourceSnapshotEvaluations(confirmations);
  const result = concludeResourceBoundary({
    boundary: event.boundary,
    initial,
    confirmation,
  });
  return {
    probeOrdinal: event.probeOrdinal,
    boundary: event.boundary,
    strategy: event.strategy,
    initiallySuspiciousMetrics: [...initial.suspiciousMetrics],
    wouldConfirm: true,
    conclusion: result.conclusion,
    affectedMetrics: [...result.affectedMetrics],
    decreasePct: decreaseSummary(initial),
    confirmationDecreasePct: decreaseSummary(confirmation),
  };
}

function replayArtifact(artifact, pairs) {
  if (!SUPPORTED_FORMAT_VERSIONS.has(artifact.formatVersion)) {
    throw new Error(`unsupported artifact formatVersion ${artifact.formatVersion}`);
  }
  const events = artifact.shadowTrace?.events ?? [];
  const baselineEvent = events.find((event) => event.type === 'baseline' && event.baseline);
  if (!baselineEvent) {
    return {
      cell: artifact.cell,
      captureThresholds: artifact.shadowSchedule?.thresholds,
      error: 'artifact has no usable baseline; every boundary was skipped in the live run',
      candidates: [],
    };
  }
  const boundaries = events.filter((event) => event.type === 'boundary' && event.initialSnapshot);
  return {
    cell: artifact.cell,
    captureThresholds: artifact.shadowSchedule?.thresholds,
    baseline: {
      coverage: baselineEvent.baseline.coverage,
      enabledMetrics: baselineEvent.baseline.enabledMetrics,
      hostMemoryBytes: baselineEvent.baseline.metrics.hostMemory.baselineBytes,
      vramBytes: baselineEvent.baseline.metrics.vram.baselineBytes,
      warnings: baselineEvent.baseline.warnings,
    },
    boundaryCount: boundaries.length,
    candidates: pairs.map((thresholds) => {
      const replayed = boundaries.map((event) =>
        replayBoundary(baselineEvent.baseline, event, thresholds)
      );
      return {
        thresholds,
        belowCaptureThreshold:
          artifact.shadowSchedule?.thresholds !== undefined &&
          (thresholds.hostMemoryDecreaseThresholdPct <
            artifact.shadowSchedule.thresholds.hostMemoryDecreaseThresholdPct ||
            thresholds.vramDecreaseThresholdPct <
              artifact.shadowSchedule.thresholds.vramDecreaseThresholdPct),
        initialSuspicions: replayed.filter((entry) => entry.wouldConfirm).length,
        wouldConfirmSequences: replayed
          .filter((entry) => entry.wouldConfirm)
          .map((entry) => `${entry.boundary}#${entry.probeOrdinal}`),
        wouldAbort: replayed.filter(
          (entry) =>
            entry.conclusion === 'confirmed-drift' || entry.conclusion === 'stability-unverified'
        ),
        unreplayable: replayed.filter((entry) => entry.conclusion === 'unreplayable'),
        boundaries: replayed,
      };
    }),
  };
}

function formatPct(value) {
  return value === undefined ? '   n/a' : `${value >= 0 ? ' ' : ''}${value.toFixed(2)}%`;
}

function printReport(file, replay) {
  process.stdout.write(`\n=== ${path.basename(file)} (cell ${replay.cell}) ===\n`);
  if (replay.error) {
    process.stdout.write(`  ${replay.error}\n`);
    return;
  }
  process.stdout.write(
    `  capture thresholds host/vram: ${replay.captureThresholds?.hostMemoryDecreaseThresholdPct}/${replay.captureThresholds?.vramDecreaseThresholdPct}` +
      `  baseline coverage: ${replay.baseline.coverage}  boundaries: ${replay.boundaryCount}\n`
  );
  for (const warning of replay.baseline.warnings ?? []) {
    process.stdout.write(`  baseline warning: ${warning}\n`);
  }
  for (const candidate of replay.candidates) {
    const label = `host ${candidate.thresholds.hostMemoryDecreaseThresholdPct}% / vram ${candidate.thresholds.vramDecreaseThresholdPct}%`;
    process.stdout.write(
      `  ${label.padEnd(30)} suspicions=${String(candidate.initialSuspicions).padStart(3)}` +
        `  wouldAbort=${String(candidate.wouldAbort.length).padStart(3)}` +
        `  unreplayable=${String(candidate.unreplayable.length).padStart(3)}` +
        `${candidate.belowCaptureThreshold ? '  [below capture threshold]' : ''}\n`
    );
    for (const entry of candidate.wouldAbort) {
      process.stdout.write(
        `      ${entry.conclusion} at ${entry.boundary} of probe ${entry.probeOrdinal}` +
          ` (host ${formatPct(entry.decreasePct.hostMemory)}, vram ${formatPct(entry.decreasePct.vram)})\n`
      );
    }
    for (const entry of candidate.unreplayable) {
      process.stdout.write(
        `      unreplayable at ${entry.boundary} of probe ${entry.probeOrdinal}: ${entry.note}\n`
      );
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      thresholds: { type: 'string', default: '10,15,20,25' },
      host: { type: 'string' },
      vram: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  if (positionals.length === 0) {
    throw new Error('pass at least one artifact JSON path');
  }
  const base = parseList(values.thresholds);
  const pairs = candidatePairs(
    values.host ? parseList(values.host) : base,
    values.vram ? parseList(values.vram) : base
  );
  if (pairs.length === 0) throw new Error('no valid candidate thresholds');

  const results = [];
  for (const file of positionals) {
    const artifact = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    const replay = replayArtifact(artifact, pairs);
    results.push({ file: path.basename(file), ...replay });
    if (!values.json) printReport(file, replay);
  }
  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();
