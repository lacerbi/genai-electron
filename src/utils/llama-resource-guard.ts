/**
 * Pure resource-stability calculations for LLM runtime calibration.
 *
 * Calibration compares every launch boundary against ONE fixed baseline per enabled metric. There is
 * no re-anchoring and no settled-level state: a decrease is measured cumulatively from the single
 * baseline captured during preparation, so several individually minor steps can together cross the
 * threshold.
 *
 * This module is deliberately free of async work, timers, cooldowns, hardware access, and public
 * schema types. `llama-resource-guard-capture.ts` owns the bounded async orchestration and injects
 * its snapshots here; everything below is a total function over data, so the whole decision surface
 * is unit-testable without a machine.
 *
 * Vocabulary intentionally tracks the schema-v3 plan (`availableBytes`,
 * `decreasePctFromBaseline`) so the Phase 4 public mapping is mechanical, but nothing here is
 * exported from the package root.
 *
 * @module utils/llama-resource-guard
 */

/** The two independently guarded resources. There is no weighting and no combined score. */
export type ResourceMetric = 'hostMemory' | 'vram';

/** Canonical metric order used by every metric list this module produces. */
export const RESOURCE_METRICS: readonly ResourceMetric[] = ['hostMemory', 'vram'];

/**
 * Trusted baseline samples required to guard a metric for the run.
 *
 * Below this, the metric is disabled with a warning rather than guarded from one possibly degraded
 * reading. The collector never loops waiting for more samples.
 */
export const MIN_TRUSTED_BASELINE_SAMPLES = 2;

/** Why a reading cannot be compared against the baseline. */
export type ResourceReadingUntrustedReason =
  /** Platform telemetry refresh reported failure, so any value would be from another regime. */
  | 'telemetry-refresh-failed'
  /** The source threw, or reported no value at all. */
  | 'reading-unavailable'
  /** A value was present but not a finite non-negative byte count. */
  | 'reading-invalid';

export interface TrustedResourceReading {
  trusted: true;
  /** Finite and non-negative. Zero is a valid, maximally severe reading - not missing telemetry. */
  availableBytes: number;
}

export interface UntrustedResourceReading {
  trusted: false;
  untrustedReason: ResourceReadingUntrustedReason;
  /**
   * Untrusted readings deliberately carry no byte value: a stale or degraded number must never be
   * comparable against the baseline by accident.
   */
  availableBytes?: undefined;
}

export type ResourceMetricReading = TrustedResourceReading | UntrustedResourceReading;

/** One whole-machine reading. Metric trust is independent: either may be untrusted alone. */
export type ResourceSnapshot = Record<ResourceMetric, ResourceMetricReading>;

/** Which side of a launch a boundary check belongs to. */
export type ResourceBoundaryKind = 'pre-launch' | 'post-cleanup';

/** How much of the resource guard is actually active for a run. */
export type ResourceMonitoringCoverage = 'complete' | 'partial' | 'unavailable';

/** Independent per-metric decrease thresholds, in percent of the baseline. */
export interface ResourceDecreaseThresholds {
  hostMemoryDecreaseThresholdPct: number;
  vramDecreaseThresholdPct: number;
}

export interface ResourceMetricBaseline {
  metric: ResourceMetric;
  /** Whether this metric is guarded for the run. */
  enabled: boolean;
  /** Median of the trusted samples. Present (finite and positive) only when enabled. */
  baselineBytes?: number;
  /** Snapshot attempts inspected (fixed count; never extended by retries). */
  attempts: number;
  /** Trusted sample values in capture order. */
  trustedSamples: readonly number[];
}

export interface ResourceBaseline {
  metrics: Record<ResourceMetric, ResourceMetricBaseline>;
  enabledMetrics: readonly ResourceMetric[];
  coverage: ResourceMonitoringCoverage;
  /** Snapshot attempts made (fixed count). */
  attempts: number;
  warnings: readonly string[];
}

export interface ResourceMetricEvaluation {
  metric: ResourceMetric;
  /** False when the metric has no usable baseline; such a metric can never trigger anything. */
  enabled: boolean;
  trusted: boolean;
  untrustedReason?: ResourceReadingUntrustedReason;
  availableBytes?: number;
  /** Signed: positive means less availability than the baseline, negative means more. */
  decreasePctFromBaseline?: number;
  /** `max(0, decreasePctFromBaseline)` - the value actually compared with the threshold. */
  decisionDecreasePct?: number;
  thresholdPct?: number;
  /** Enabled, trusted, and at or above its threshold (comparison is inclusive). */
  suspicious: boolean;
}

export interface ResourceSnapshotEvaluation {
  metrics: Record<ResourceMetric, ResourceMetricEvaluation>;
  /** Enabled + trusted metrics at or above threshold. */
  suspiciousMetrics: readonly ResourceMetric[];
  /** Enabled but untrusted metrics. Recorded only; they can never trigger a failure alone. */
  untrustedMetrics: readonly ResourceMetric[];
}

export type ResourceBoundaryConclusion = 'admitted' | 'confirmed-drift' | 'stability-unverified';

export interface ResourceBoundaryResult {
  boundary?: ResourceBoundaryKind;
  conclusion: ResourceBoundaryConclusion;
  /** True when the boundary needed - and therefore took - a confirmation snapshot. */
  confirmationPerformed: boolean;
  initial: ResourceSnapshotEvaluation;
  confirmation?: ResourceSnapshotEvaluation;
  initiallySuspiciousMetrics: readonly ResourceMetric[];
  /** Metrics responsible for a non-admitted conclusion; empty when admitted. */
  affectedMetrics: readonly ResourceMetric[];
  warnings: readonly string[];
}

export interface ResourceBoundaryConclusionInput {
  boundary?: ResourceBoundaryKind;
  initial: ResourceSnapshotEvaluation;
  /**
   * The single whole-boundary confirmation. Omit it only when the initial snapshot had no
   * suspicious trusted metric; a suspicious boundary without a confirmation cannot be admitted.
   */
  confirmation?: ResourceSnapshotEvaluation;
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** Whether a candidate telemetry value may be compared at all: finite and non-negative. */
export function isTrustworthyByteValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function trustedReading(availableBytes: number): TrustedResourceReading {
  return { trusted: true, availableBytes };
}

export function untrustedReading(
  untrustedReason: ResourceReadingUntrustedReason
): UntrustedResourceReading {
  return { trusted: false, untrustedReason };
}

/**
 * Build a reading from a raw telemetry value, downgrading anything unusable.
 *
 * @param value - Raw available-bytes value from a platform source
 * @param missingReason - Reason to record when the value is absent
 */
export function readingFromBytes(
  value: number | null | undefined,
  missingReason: ResourceReadingUntrustedReason = 'reading-unavailable'
): ResourceMetricReading {
  if (value === undefined || value === null) return untrustedReading(missingReason);
  return isTrustworthyByteValue(value)
    ? trustedReading(value)
    : untrustedReading('reading-invalid');
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export function thresholdForMetric(
  thresholds: ResourceDecreaseThresholds,
  metric: ResourceMetric
): number {
  return metric === 'hostMemory'
    ? thresholds.hostMemoryDecreaseThresholdPct
    : thresholds.vramDecreaseThresholdPct;
}

/**
 * Reject thresholds that cannot express a decrease band.
 *
 * Thresholds are passed in rather than read from the shipped defaults so the Phase 1 quiet-trace
 * experiment can replay candidate values through exactly this code path.
 *
 * @throws {RangeError} When a threshold is not finite within `(0, 100]`
 */
export function validateResourceDecreaseThresholds(thresholds: ResourceDecreaseThresholds): void {
  for (const metric of RESOURCE_METRICS) {
    const value = thresholdForMetric(thresholds, metric);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw new RangeError(
        `Resource decrease threshold for ${metric} must be finite within (0, 100], received ${String(value)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Percentages
// ---------------------------------------------------------------------------

/**
 * Signed change from the fixed baseline: positive means less availability.
 *
 * @param baselineBytes - Fixed baseline, required finite and positive (percentage denominator)
 * @param availableBytes - Boundary reading, may be zero
 */
export function decreasePctFromBaseline(baselineBytes: number, availableBytes: number): number {
  return ((baselineBytes - availableBytes) / baselineBytes) * 100;
}

/** Increases never contribute to failure, so decisions clamp the signed change at zero. */
export function decisionDecreasePct(signedDecreasePct: number): number {
  return Math.max(0, signedDecreasePct);
}

/** Inclusive: a decrease exactly equal to the threshold is suspicious. */
export function isSuspiciousDecrease(signedDecreasePct: number, thresholdPct: number): boolean {
  return decisionDecreasePct(signedDecreasePct) >= thresholdPct;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/** Median of a numeric sample set; averages the middle pair for even counts. */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (low === undefined || high === undefined) return undefined;
  return (low + high) / 2;
}

/**
 * Reduce bounded baseline attempts into one fixed baseline per metric.
 *
 * Each metric is decided independently: it is guarded only when at least
 * {@link MIN_TRUSTED_BASELINE_SAMPLES} attempts produced a trusted value AND the median of those
 * values is finite and positive (it is the percentage denominator). Anything else disables that
 * metric for the whole run and surfaces a warning - never a drift decision, and never another
 * attempt.
 *
 * @param snapshots - The fixed number of attempts, in capture order
 */
export function buildResourceBaseline(
  snapshots: readonly ResourceSnapshot[],
  options: { minTrustedSamples?: number } = {}
): ResourceBaseline {
  const minTrustedSamples = options.minTrustedSamples ?? MIN_TRUSTED_BASELINE_SAMPLES;
  const warnings: string[] = [];
  const attempts = snapshots.length;

  const buildMetric = (metric: ResourceMetric): ResourceMetricBaseline => {
    const trustedSamples: number[] = [];
    for (const snapshot of snapshots) {
      const reading = snapshot[metric];
      if (reading.trusted && isTrustworthyByteValue(reading.availableBytes)) {
        trustedSamples.push(reading.availableBytes);
      }
    }
    if (trustedSamples.length < minTrustedSamples) {
      warnings.push(
        `Resource metric ${metric} is disabled for this calibration run: ${trustedSamples.length} of ${attempts} baseline attempts produced a trusted reading (${minTrustedSamples} required).`
      );
      return { metric, enabled: false, attempts, trustedSamples };
    }
    const baselineBytes = medianOf(trustedSamples);
    if (baselineBytes === undefined || !Number.isFinite(baselineBytes) || baselineBytes <= 0) {
      warnings.push(
        `Resource metric ${metric} is disabled for this calibration run: its baseline median is not a finite positive byte count.`
      );
      return { metric, enabled: false, attempts, trustedSamples };
    }
    return { metric, enabled: true, baselineBytes, attempts, trustedSamples };
  };

  const metrics: Record<ResourceMetric, ResourceMetricBaseline> = {
    hostMemory: buildMetric('hostMemory'),
    vram: buildMetric('vram'),
  };
  const enabledMetrics = RESOURCE_METRICS.filter((metric) => metrics[metric].enabled);
  const coverage: ResourceMonitoringCoverage =
    enabledMetrics.length === RESOURCE_METRICS.length
      ? 'complete'
      : enabledMetrics.length === 0
        ? 'unavailable'
        : 'partial';

  return { metrics, enabledMetrics, coverage, attempts, warnings };
}

// ---------------------------------------------------------------------------
// Snapshot evaluation
// ---------------------------------------------------------------------------

/**
 * Compare one whole-machine snapshot against the fixed baseline.
 *
 * Disabled metrics are reported but never suspicious. Untrusted readings of enabled metrics are
 * recorded so a boundary can explain itself, but on their own they can never indicate drift.
 */
export function evaluateResourceSnapshot(
  baseline: ResourceBaseline,
  snapshot: ResourceSnapshot,
  thresholds: ResourceDecreaseThresholds
): ResourceSnapshotEvaluation {
  validateResourceDecreaseThresholds(thresholds);

  const evaluateMetric = (metric: ResourceMetric): ResourceMetricEvaluation => {
    const metricBaseline = baseline.metrics[metric];
    const reading = snapshot[metric];
    if (!metricBaseline.enabled || metricBaseline.baselineBytes === undefined) {
      return {
        metric,
        enabled: false,
        trusted: reading.trusted,
        ...(reading.trusted
          ? { availableBytes: reading.availableBytes }
          : { untrustedReason: reading.untrustedReason }),
        suspicious: false,
      };
    }
    const thresholdPct = thresholdForMetric(thresholds, metric);
    if (!reading.trusted) {
      return {
        metric,
        enabled: true,
        trusted: false,
        untrustedReason: reading.untrustedReason,
        thresholdPct,
        suspicious: false,
      };
    }
    const signed = decreasePctFromBaseline(metricBaseline.baselineBytes, reading.availableBytes);
    return {
      metric,
      enabled: true,
      trusted: true,
      availableBytes: reading.availableBytes,
      decreasePctFromBaseline: signed,
      decisionDecreasePct: decisionDecreasePct(signed),
      thresholdPct,
      suspicious: isSuspiciousDecrease(signed, thresholdPct),
    };
  };

  const metrics: Record<ResourceMetric, ResourceMetricEvaluation> = {
    hostMemory: evaluateMetric('hostMemory'),
    vram: evaluateMetric('vram'),
  };
  return {
    metrics,
    suspiciousMetrics: RESOURCE_METRICS.filter((metric) => metrics[metric].suspicious),
    untrustedMetrics: RESOURCE_METRICS.filter(
      (metric) => metrics[metric].enabled && !metrics[metric].trusted
    ),
  };
}

/** Whether the initial boundary snapshot requires the bounded confirmation. */
export function requiresConfirmation(initial: ResourceSnapshotEvaluation): boolean {
  return initial.suspiciousMetrics.length > 0;
}

/**
 * Reduce several confirmation reads into the single confirmation the conclusion consumes.
 *
 * The production confirmation count is one, where this is the identity. For any larger fixed count
 * the merge stays conservative so a later read can never erase an earlier observation: a metric is
 * trusted only if trusted in every read, suspicious if suspicious in any read, and its reported
 * value is the worst (largest decrease) trusted read.
 *
 * @throws {RangeError} When called with no evaluations
 */
export function mergeResourceSnapshotEvaluations(
  evaluations: readonly ResourceSnapshotEvaluation[]
): ResourceSnapshotEvaluation {
  const first = evaluations[0];
  if (!first) {
    throw new RangeError('mergeResourceSnapshotEvaluations requires at least one evaluation');
  }
  if (evaluations.length === 1) return first;

  const mergeMetric = (metric: ResourceMetric): ResourceMetricEvaluation => {
    const perRead = evaluations.map((evaluation) => evaluation.metrics[metric]);
    const base = perRead[0];
    if (!base) {
      throw new RangeError('mergeResourceSnapshotEvaluations requires at least one evaluation');
    }
    const untrusted = perRead.find((evaluation) => !evaluation.trusted);
    if (untrusted) {
      return {
        metric,
        enabled: base.enabled,
        trusted: false,
        untrustedReason: untrusted.untrustedReason,
        thresholdPct: base.thresholdPct,
        suspicious: false,
      };
    }
    let worst = base;
    for (const evaluation of perRead) {
      if ((evaluation.decisionDecreasePct ?? 0) > (worst.decisionDecreasePct ?? 0)) {
        worst = evaluation;
      }
    }
    return { ...worst, suspicious: perRead.some((evaluation) => evaluation.suspicious) };
  };

  const metrics: Record<ResourceMetric, ResourceMetricEvaluation> = {
    hostMemory: mergeMetric('hostMemory'),
    vram: mergeMetric('vram'),
  };
  return {
    metrics,
    suspiciousMetrics: RESOURCE_METRICS.filter((metric) => metrics[metric].suspicious),
    untrustedMetrics: RESOURCE_METRICS.filter(
      (metric) => metrics[metric].enabled && !metrics[metric].trusted
    ),
  };
}

// ---------------------------------------------------------------------------
// Boundary conclusion
// ---------------------------------------------------------------------------

/**
 * Decide a launch boundary from its initial snapshot and optional confirmation.
 *
 * Protocol (plan decision 6, applied literally):
 *
 * - No suspicious trusted metric in the initial snapshot: admitted, no confirmation.
 * - Otherwise exactly one whole-boundary confirmation decides. Admit only when every initially
 *   suspicious metric recovered (trusted and below threshold) AND no trusted enabled metric in the
 *   confirmation is at or above threshold.
 * - A metric trusted-suspicious in both snapshots is independently confirmed: `confirmed-drift`.
 * - An initially suspicious metric that became untrusted, or a different metric that became newly
 *   suspicious, yields `stability-unverified`.
 * - Precedence: any independently confirmed metric wins, so `confirmed-drift` is reported even when
 *   another metric is untrusted or newly suspicious. `stability-unverified` applies only when no
 *   metric is confirmed and the boundary still cannot be admitted.
 */
export function concludeResourceBoundary(
  input: ResourceBoundaryConclusionInput
): ResourceBoundaryResult {
  const { boundary, initial, confirmation } = input;
  const warnings: string[] = [];
  const boundaryLabel = boundary ?? 'launch';
  const initiallySuspiciousMetrics = initial.suspiciousMetrics;

  for (const metric of initial.untrustedMetrics) {
    warnings.push(
      `Resource metric ${metric} was untrusted at the ${boundaryLabel} boundary (${initial.metrics[metric].untrustedReason ?? 'unknown'}); it is recorded but cannot indicate resource drift on its own.`
    );
  }

  if (initiallySuspiciousMetrics.length === 0) {
    return {
      boundary,
      conclusion: 'admitted',
      confirmationPerformed: false,
      initial,
      initiallySuspiciousMetrics,
      affectedMetrics: [],
      warnings,
    };
  }

  if (!confirmation) {
    // Defensive: the orchestrator always confirms a suspicious boundary. A suspicious boundary with
    // no confirmation is unverifiable, never admitted.
    warnings.push(
      `Resource stability at the ${boundaryLabel} boundary could not be verified: no confirmation snapshot was taken for ${initiallySuspiciousMetrics.join(', ')}.`
    );
    return {
      boundary,
      conclusion: 'stability-unverified',
      confirmationPerformed: false,
      initial,
      initiallySuspiciousMetrics,
      affectedMetrics: initiallySuspiciousMetrics,
      warnings,
    };
  }

  const confirmedMetrics = initiallySuspiciousMetrics.filter(
    (metric) => confirmation.metrics[metric].trusted && confirmation.metrics[metric].suspicious
  );
  const unverifiedMetrics = initiallySuspiciousMetrics.filter(
    (metric) => !confirmation.metrics[metric].trusted
  );
  const newlySuspiciousMetrics = confirmation.suspiciousMetrics.filter(
    (metric) => !initiallySuspiciousMetrics.includes(metric)
  );

  for (const metric of unverifiedMetrics) {
    warnings.push(
      `Resource metric ${metric} was suspicious at the ${boundaryLabel} boundary and its confirmation reading was untrusted (${confirmation.metrics[metric].untrustedReason ?? 'unknown'}).`
    );
  }
  for (const metric of newlySuspiciousMetrics) {
    warnings.push(
      `Resource metric ${metric} became newly suspicious in the ${boundaryLabel} confirmation snapshot.`
    );
  }

  if (confirmedMetrics.length > 0) {
    warnings.push(
      `Resource decrease confirmed at the ${boundaryLabel} boundary for ${confirmedMetrics.join(', ')}.`
    );
    return {
      boundary,
      conclusion: 'confirmed-drift',
      confirmationPerformed: true,
      initial,
      confirmation,
      initiallySuspiciousMetrics,
      affectedMetrics: confirmedMetrics,
      warnings,
    };
  }

  if (unverifiedMetrics.length > 0 || newlySuspiciousMetrics.length > 0) {
    const affectedMetrics = RESOURCE_METRICS.filter(
      (metric) => unverifiedMetrics.includes(metric) || newlySuspiciousMetrics.includes(metric)
    );
    return {
      boundary,
      conclusion: 'stability-unverified',
      confirmationPerformed: true,
      initial,
      confirmation,
      initiallySuspiciousMetrics,
      affectedMetrics,
      warnings,
    };
  }

  return {
    boundary,
    conclusion: 'admitted',
    confirmationPerformed: true,
    initial,
    confirmation,
    initiallySuspiciousMetrics,
    affectedMetrics: [],
    warnings,
  };
}
