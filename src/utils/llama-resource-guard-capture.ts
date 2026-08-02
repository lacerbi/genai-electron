/**
 * Bounded, abortable orchestration for the calibration resource-stability guard.
 *
 * Everything async lives here: the fixed settle delay, cooldown spacing, the fixed number of
 * baseline attempts, and the single whole-boundary confirmation. Every decision is delegated to the
 * pure module, and every dependency (snapshot capture, cooldown) is injected, so unit tests need no
 * hardware, no real waiting, and no timer faking.
 *
 * Two hard invariants:
 *
 * - **Bounded.** Collection is limited by fixed counts (`samples`, `confirmationReads`). Nothing
 *   loops waiting for telemetry to become trusted or for a machine to settle.
 * - **Abortable.** The caller's signal is honoured before and after every await, so an abort rejects
 *   promptly with the caller's own abort reason (the manager maps that to `CALIBRATION_ABORTED`).
 *
 * Confirmation reads are telemetry only: this module never launches a server, so confirmation
 * consumes no launch or probe budget by construction.
 *
 * @module utils/llama-resource-guard-capture
 */

import {
  buildResourceBaseline,
  concludeResourceBoundary,
  evaluateResourceSnapshot,
  isTrustworthyByteValue,
  mergeResourceSnapshotEvaluations,
  readingFromBytes,
  requiresConfirmation,
  trustedReading,
  untrustedReading,
  validateResourceStabilityThresholds,
} from './llama-resource-guard.js';
import type {
  ResourceBaseline,
  ResourceBoundaryKind,
  ResourceBoundaryResult,
  ResourceMetricReading,
  ResourceSnapshot,
  ResourceSnapshotEvaluation,
  ResourceStabilityThresholds,
} from './llama-resource-guard.js';
import type { MemoryTelemetryRefreshStatus, TelemetryCommandOptions } from '../types/system.js';

/**
 * Baseline attempts made when the caller passes no count.
 *
 * The shipped policy value lives on the calibration defaults; this constant only keeps the module
 * usable standalone (for the Phase 1 replay harness and tests).
 */
export const DEFAULT_BASELINE_SAMPLE_ATTEMPTS = 3;

/** Whole-boundary confirmation snapshots made when the caller passes no count. */
export const DEFAULT_CONFIRMATION_READS = 1;

/** Captures one whole-machine reading. Must reject promptly if `signal` aborts. */
export type CaptureResourceSnapshot = (options: {
  signal?: AbortSignal;
}) => Promise<ResourceSnapshot>;

/** Waits `ms`, rejecting with the signal's abort reason if the caller aborts while waiting. */
export type AbortableDelay = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ResourceGuardDependencies {
  captureSnapshot: CaptureResourceSnapshot;
  delay: AbortableDelay;
}

export interface CollectBaselineOptions {
  /** Fixed cooldown separating baseline attempts. */
  cooldownMs: number;
  /** Fixed number of attempts. Never extended; at least 2 so a median can be trusted. */
  samples?: number;
  /** Fixed settle delay before the first attempt. May be 0. Never condition-driven. */
  settleMs?: number;
  signal?: AbortSignal;
}

export interface CheckBoundaryOptions {
  baseline: ResourceBaseline;
  /** Passed in (not read from defaults) so candidate values can be replayed through this path. */
  thresholds: ResourceStabilityThresholds;
  /** Cooldown before each confirmation snapshot. */
  cooldownMs: number;
  /** Fixed confirmation snapshots for a suspicious boundary. At least 1; production value is 1. */
  confirmationReads?: number;
  /** Diagnostic label echoed into the result. */
  boundary?: ResourceBoundaryKind;
  signal?: AbortSignal;
}

/**
 * Canonical public telemetry types, re-exported so guard consumers need one import.
 *
 * These are the same declarations `SystemInfo` uses; the guard deliberately does not maintain a
 * parallel structural copy that could drift from the shipped contract.
 */
export type { MemoryTelemetryRefreshStatus };
export type ResourceTelemetryReadOptions = TelemetryCommandOptions;

/**
 * The minimum structural surface the guard needs from a telemetry provider.
 *
 * Declared structurally rather than importing `SystemInfo` so this module stays free of hardware,
 * Electron, and singleton dependencies, and so tests can supply a plain object.
 */
export interface ResourceTelemetrySource {
  refreshMemoryTelemetry(
    options?: ResourceTelemetryReadOptions
  ): Promise<MemoryTelemetryRefreshStatus>;
  getMemoryInfo(): { available: number };
  getGPUInfo(options?: ResourceTelemetryReadOptions): Promise<{ vramAvailable?: number }>;
}

export interface TelemetrySnapshotCaptureOptions {
  /** Bounded per-operation telemetry timeout forwarded to the source. */
  telemetryTimeoutMs?: number;
  /** Optional debug sink; the guard itself never logs. */
  onDiagnostic?: (message: string, error?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Default {@link AbortableDelay}: a plain timer that clears itself when the caller aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertSampleCount(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${label} must be a safe integer >= ${minimum}, received ${String(value)}`
    );
  }
}

function assertDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer of milliseconds, received ${String(value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Baseline collection
// ---------------------------------------------------------------------------

/**
 * Capture the run's one fixed baseline.
 *
 * Optional fixed settle delay, then `samples` cooldown-spaced attempts, then the pure per-metric
 * median/enablement reduction. The count is fixed up front: a metric with too few trusted values is
 * disabled for the run with a warning, never retried.
 *
 * @throws {RangeError} On an invalid sample count or duration
 * @throws The caller's abort reason when `options.signal` aborts
 */
export async function collectBaseline(
  deps: ResourceGuardDependencies,
  options: CollectBaselineOptions
): Promise<ResourceBaseline> {
  const samples = options.samples ?? DEFAULT_BASELINE_SAMPLE_ATTEMPTS;
  const settleMs = options.settleMs ?? 0;
  const { cooldownMs, signal } = options;
  assertSampleCount(samples, 'resource baseline samples', 2);
  assertDuration(settleMs, 'resource baseline settle delay');
  assertDuration(cooldownMs, 'resource cooldown');

  signal?.throwIfAborted();
  if (settleMs > 0) {
    await deps.delay(settleMs, signal);
    signal?.throwIfAborted();
  }

  const snapshots: ResourceSnapshot[] = [];
  for (let attempt = 0; attempt < samples; attempt += 1) {
    if (attempt > 0) {
      await deps.delay(cooldownMs, signal);
      signal?.throwIfAborted();
    }
    snapshots.push(await deps.captureSnapshot({ signal }));
    signal?.throwIfAborted();
  }
  return buildResourceBaseline(snapshots);
}

// ---------------------------------------------------------------------------
// Boundary check
// ---------------------------------------------------------------------------

/**
 * Evaluate one launch boundary against the fixed baseline.
 *
 * The caller decides when the initial snapshot happens - a post-cleanup boundary calls this only
 * after its own cooldown, so ordinary teardown release has already settled. If no enabled trusted
 * metric is suspicious, the boundary is admitted after that single read. Otherwise exactly
 * `confirmationReads` (production: one) cooldown-spaced confirmation snapshots are taken and the
 * pure conclusion decides. No server is launched here at any point.
 *
 * @throws {RangeError} On invalid thresholds, read counts, or durations
 * @throws The caller's abort reason when `options.signal` aborts
 */
export async function checkBoundary(
  deps: ResourceGuardDependencies,
  options: CheckBoundaryOptions
): Promise<ResourceBoundaryResult> {
  const { baseline, thresholds, cooldownMs, boundary, signal } = options;
  const confirmationReads = options.confirmationReads ?? DEFAULT_CONFIRMATION_READS;
  validateResourceStabilityThresholds(thresholds);
  assertSampleCount(confirmationReads, 'resource confirmation reads', 1);
  assertDuration(cooldownMs, 'resource cooldown');

  signal?.throwIfAborted();
  const initialSnapshot = await deps.captureSnapshot({ signal });
  signal?.throwIfAborted();
  const initial = evaluateResourceSnapshot(baseline, initialSnapshot, thresholds);
  if (!requiresConfirmation(initial)) {
    return concludeResourceBoundary({ boundary, initial });
  }

  const confirmations: ResourceSnapshotEvaluation[] = [];
  for (let read = 0; read < confirmationReads; read += 1) {
    await deps.delay(cooldownMs, signal);
    signal?.throwIfAborted();
    const snapshot = await deps.captureSnapshot({ signal });
    signal?.throwIfAborted();
    confirmations.push(evaluateResourceSnapshot(baseline, snapshot, thresholds));
  }
  return concludeResourceBoundary({
    boundary,
    initial,
    confirmation: mergeResourceSnapshotEvaluations(confirmations),
  });
}

// ---------------------------------------------------------------------------
// Telemetry adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a telemetry source into a {@link CaptureResourceSnapshot}.
 *
 * Trust rules, applied independently per metric:
 *
 * - Host memory is trusted only when the refresh reports `refreshed` or `not-required` AND the
 *   available value is finite and non-negative. A `failed` refresh yields an untrusted host reading
 *   and the stale cached number is never read, let alone compared.
 * - VRAM is trusted only when a fresh `getGPUInfo()` supplies a finite non-negative `vramAvailable`.
 * - A host failure never invalidates the VRAM reading, and vice versa: both sources are read on
 *   every capture and their errors are contained.
 *
 * Aborts are not converted into untrusted readings - they reject, so the caller's abort contract
 * stays intact.
 */
export function createTelemetrySnapshotCapture(
  source: ResourceTelemetrySource,
  options: TelemetrySnapshotCaptureOptions = {}
): CaptureResourceSnapshot {
  const { telemetryTimeoutMs, onDiagnostic } = options;
  const report = (message: string, error?: unknown): void => {
    onDiagnostic?.(message, error);
  };

  return async ({ signal }) => {
    signal?.throwIfAborted();
    const readOptions: ResourceTelemetryReadOptions = { signal, timeoutMs: telemetryTimeoutMs };

    let hostMemory: ResourceMetricReading;
    let refreshStatus: MemoryTelemetryRefreshStatus;
    try {
      refreshStatus = await source.refreshMemoryTelemetry(readOptions);
    } catch (error) {
      signal?.throwIfAborted();
      report('host-memory telemetry refresh threw', error);
      refreshStatus = 'failed';
    }
    signal?.throwIfAborted();
    if (refreshStatus === 'failed') {
      report('host-memory reading untrusted: telemetry refresh failed');
      hostMemory = untrustedReading('telemetry-refresh-failed');
    } else {
      try {
        const available = source.getMemoryInfo().available;
        hostMemory = isTrustworthyByteValue(available)
          ? trustedReading(available)
          : untrustedReading('reading-invalid');
      } catch (error) {
        signal?.throwIfAborted();
        report('host-memory reading unavailable', error);
        hostMemory = untrustedReading('reading-unavailable');
      }
    }

    let vram: ResourceMetricReading;
    try {
      const gpu = await source.getGPUInfo(readOptions);
      vram = readingFromBytes(gpu?.vramAvailable);
    } catch (error) {
      signal?.throwIfAborted();
      report('VRAM reading unavailable', error);
      vram = untrustedReading('reading-unavailable');
    }

    signal?.throwIfAborted();
    return { hostMemory, vram };
  };
}
