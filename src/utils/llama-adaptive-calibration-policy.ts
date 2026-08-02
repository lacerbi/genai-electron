/**
 * Pure adaptive LLM calibration policy.
 *
 * This module intentionally has no Electron, process, manager, or public-schema dependency. The
 * manager integration added in a later phase drives it as an immutable
 * `next action -> observation -> next state` controller.
 */

export type AdaptiveKvPrecision = 'q8_0' | 'f16' | 'baseline';
export type AdaptiveFidelity = 'search' | 'full';
export type AdaptiveTimeoutMode = 'adaptive' | 'adaptive-with-full-continuation' | 'full';
export type AdaptiveOperationalStatus =
  | 'ok'
  | 'oom'
  | 'startup-timeout'
  | 'request-timeout'
  | 'crashed'
  | 'error';
export type AdaptiveMemoryEvidenceKind = 'none' | 'suspected' | 'confirmed' | 'unknown';
export type AdaptiveResourceDriftStatus = 'available' | 'material' | 'unavailable';
export type AdaptiveBoundaryDecision = 'admissible' | 'unsuitable' | 'ambiguous';
export type AdaptiveProbePurpose =
  | 'reference'
  | 'ceiling'
  | 'boundary'
  | 'ambiguity-repeat'
  | 'finalist'
  | 'winner-validation'
  | 'fallback-validation'
  | 'reference-guard';
export type AdaptiveTerminalStatus = 'complete' | 'budget-exhausted' | 'no-viable-candidate';
export type AdaptiveCellPhase =
  | 'pending'
  | 'finding-reference'
  | 'establishing-ceiling'
  | 'bisecting'
  | 'finalist'
  | 'resolved'
  | 'unresolved'
  | 'no-viable-point';

export interface AdaptiveProfileInput {
  /** Stable caller-order identity. */
  profileIndex: number;
  contextSize: number;
  parallelRequests: number;
  autoGpuLayers: number;
  /** Canonical normalized arguments excluding context, SWA, KV precision, and GPU layers. */
  normalizedInvariantKey?: string;
}

export interface AdaptiveCellEnumerationInput {
  profiles: readonly AdaptiveProfileInput[];
  totalLayers: number;
  gpuAvailable: boolean;
  fixedGpuLayers?: number;
  fixedSwaFull?: boolean;
  slidingWindow?: number;
  hasSharedPrefixWorkload: boolean;
  includeKvCacheComparison: boolean;
  baselineKvPrecision: AdaptiveKvPrecision;
  /**
   * True only after argv normalization proves q8 and f16 differ solely by KV precision. Quantized
   * V-cache normalization can otherwise change flash attention and forbids KV ceiling transfer.
   */
  kvTransferCompatible?: boolean;
}

export interface AdaptiveCell {
  id: string;
  order: number;
  profileIndex: number;
  profileOrdinal: number;
  contextSize: number;
  parallelRequests: number;
  effectivePerSlotContext: number;
  swaFull: boolean;
  kvPrecision: AdaptiveKvPrecision;
  initialGpuLayers: number;
  physicalCeiling: number;
  fixedGpuLayers: boolean;
  normalizedInvariantKey: string;
  kvTransferCompatible: boolean;
}

export interface AdaptivePassiveDiagnostics {
  kvBytesEstimate?: number;
  modelBytes?: number;
  expertWeightBytes?: number;
  hostAvailableBytes?: number;
  gpuAvailableBytes?: number;
  measurementAvailability?: Readonly<Record<string, 'available' | 'unavailable' | 'censored'>>;
  warnings?: readonly string[];
}

export interface AdaptiveProbeObservation {
  cellId: string;
  gpuLayers: number;
  purpose: AdaptiveProbePurpose;
  fidelity: AdaptiveFidelity;
  operationalStatus: AdaptiveOperationalStatus;
  memoryEvidence: AdaptiveMemoryEvidenceKind;
  scoreMs?: number;
  /** True only when the completion was actually terminated at the adaptive cap. */
  terminatedAtAdaptiveCap?: boolean;
  aggregateLowerBoundMs?: number;
  /**
   * Whether host/GPU availability remained comparable around this launch. Materially drifting
   * launches remain in the chronological evidence trail, but do not contribute performance timing
   * after a clean repeat resolves the point.
   */
  resourceDriftStatus?: AdaptiveResourceDriftStatus;
  /**
   * Which settled resource level this launch was measured under. Incremented
   * when a confirmed step change re-anchors the reference, so a point is never
   * considered reproduced by launches taken under materially different
   * conditions. Absent is treated as regime 0.
   */
  resourceRegime?: number;
  durationMs: number;
  diagnostics?: AdaptivePassiveDiagnostics;
}

export interface AdaptiveEvidence extends AdaptiveProbeObservation {
  index: number;
  boundaryDecision: AdaptiveBoundaryDecision;
  decisionReason: string;
}

export interface AdaptivePolicyDefaults {
  grossRegressionMultiplier: number;
  tieTolerancePct: number;
  contextPreferencePct: number;
  kvPrecisionPreferencePct: number;
  searchNoiseAllowancePct: number;
  nonMonotoneTriggerPct: number;
  guardDistanceMinLayers: number;
  guardDistanceFraction: number;
  stabilityTolerancePct: number;
  maxRunnerStartAttempts: number;
  capacityCheckTimeoutCapMs: number;
  processExitConfirmationMs: number;
  processExitSettleGraceMs: number;
}

export const ADAPTIVE_POLICY_DEFAULTS: Readonly<AdaptivePolicyDefaults> = Object.freeze({
  grossRegressionMultiplier: 1.5,
  tieTolerancePct: 5,
  contextPreferencePct: 10,
  kvPrecisionPreferencePct: 10,
  searchNoiseAllowancePct: 20,
  nonMonotoneTriggerPct: 20,
  guardDistanceMinLayers: 2,
  guardDistanceFraction: 0.1,
  stabilityTolerancePct: 25,
  maxRunnerStartAttempts: 2,
  capacityCheckTimeoutCapMs: 5_000,
  processExitConfirmationMs: 2_000,
  processExitSettleGraceMs: 250,
});

export interface AdaptiveBudgetOverrides {
  targetProbes?: number;
  maxProbes?: number;
  maxWallTimeMs?: number;
}

export interface AdaptiveBudgets {
  cellCount: number;
  targetProbes: number;
  maxProbes: number;
  finalistReserve: number;
  maxWallTimeMs: number;
  finalistTimeReserveMs: number;
}

export interface ConfiguredProbeDurationInput {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  serverStopTimeoutMs: number;
  plannedPostStartupRequestCount: number;
  maxRunnerStartAttempts?: number;
  capacityCheckTimeoutCapMs?: number;
  processExitConfirmationMs?: number;
  processExitSettleGraceMs?: number;
}

export interface ConfiguredProbeDurationEstimate {
  policy: 'configured-conservative-estimate';
  estimateMs: number;
  resolvedCapacityCheckTimeoutMs: number;
  configuredAttemptTeardownMs: number;
  plannedPostStartupRequestCount: number;
  maxRunnerStartAttempts: number;
  isFormalUpperBound: false;
}

export interface AdaptiveProbeAdmissionInput {
  probesUsed: number;
  elapsedMs: number;
  budgets: AdaptiveBudgets;
  finalistPurpose: boolean;
  estimatedNextProbeDurationMs: number;
  effectiveFinalistTimeReserveMs: number;
}

export interface AdaptiveProbeAdmission {
  allowed: boolean;
  reason: 'allowed' | 'probe-limit' | 'launch-reserve' | 'wall-time' | 'time-reserve';
}

export interface AdaptiveCompetitivenessInput {
  hasDirectBoundary: boolean;
  cellBestDirectScoreMs?: number;
  globalBestDirectScoreMs?: number;
  triggeredNonMonotoneCandidate: boolean;
  contextPreferenceActive: boolean;
  kvPreferenceActive: boolean;
  tieTolerancePct?: number;
  contextPreferencePct?: number;
  kvPrecisionPreferencePct?: number;
  searchNoiseAllowancePct?: number;
}

export interface StableCliffReference {
  status: 'eligible' | 'insufficient' | 'unstable' | 'missing';
  gpuLayers?: number;
  denominatorScoreMs?: number;
  evidenceIndices: readonly number[];
}

export interface AdaptiveClassification {
  boundaryDecision: AdaptiveBoundaryDecision;
  reason: string;
}

export interface MixedFidelityAssessment {
  status: 'stable' | 'insufficient' | 'unstable' | 'conflict';
  recommendationScoreMs?: number;
  spreadPct?: number;
  evidenceIndices: readonly number[];
  reason: string;
}

export interface AdaptiveCeilingHint {
  receivingCellId: string;
  sourceCellId: string;
  gpuLayers: number;
  sourceEvidenceIndex: number;
  kind: 'hard-high-hypothesis' | 'provisional-scheduling-hint';
  axis: 'context' | 'swa' | 'kv';
}

export interface AdaptiveCandidate {
  cellId: string;
  cellOrder: number;
  profileIndex: number;
  contextSize: number;
  kvPrecision: AdaptiveKvPrecision;
  swaFull: boolean;
  gpuLayers: number;
  scoreMs: number;
  evidenceIndices: readonly number[];
  source: 'boundary' | 'step-down' | 'non-monotone';
}

export interface AdaptivePreferenceResolution {
  selected?: AdaptiveCandidate;
  eligible: readonly AdaptiveCandidate[];
  globalFastestScore?: number;
  contextBand?: number;
  kvBand?: number;
  selectedContextSize?: number;
  selectedKvPrecision?: AdaptiveKvPrecision;
  kvPrecisionPreferenceResolution:
    | 'not-active'
    | 'preferred-within-joint-band'
    | 'fallback-no-joint-eligible';
  finalEquivalenceSet: readonly AdaptiveCandidate[];
}

export interface AdaptiveReferenceGuardAssessment {
  status: 'satisfied' | 'probe-required' | 'failed' | 'not-applicable';
  targetGpuLayers: number;
  evidenceIndex?: number;
  promotionGpuLayers?: number;
  reason?: 'fixed-gpu-layers';
}

export interface AdaptivePolicyConfig extends AdaptiveCellEnumerationInput {
  contextPreferencePct?: number;
  kvPrecisionPreferencePct?: number;
  tieTolerancePct?: number;
  budgetOverrides?: AdaptiveBudgetOverrides;
  /** Conservative duration used until observations provide a comparable duration estimate. */
  unobservedProbeDurationEstimateMs: number;
  policy?: Partial<AdaptivePolicyDefaults>;
}

export interface AdaptivePolicyState {
  config: AdaptivePolicyConfig;
  policy: Readonly<AdaptivePolicyDefaults>;
  cells: readonly AdaptiveCell[];
  budgets: AdaptiveBudgets;
  evidence: readonly AdaptiveEvidence[];
  elapsedMs: number;
}

export interface AdaptiveCellStateSummary {
  cell: AdaptiveCell;
  phase: AdaptiveCellPhase;
  lowGpuLayers?: number;
  highGpuLayers?: number;
  boundaryGpuLayers?: number;
  candidates: readonly AdaptiveCandidate[];
  unresolvedReason?: string;
}

export interface AdaptiveProbeAction {
  kind: 'probe';
  cellId: string;
  gpuLayers: number;
  purpose: AdaptiveProbePurpose;
  fidelity: AdaptiveFidelity;
  timeoutMode: AdaptiveTimeoutMode;
  decisionRelevant: true;
  inheritedCeiling?: AdaptiveCeilingHint;
}

export interface AdaptiveFallback {
  cellId: string;
  gpuLayers: number;
  validated: boolean;
  evidenceIndex?: number;
}

export interface AdaptiveTerminalAction {
  kind: 'terminal';
  status: AdaptiveTerminalStatus;
  reason: string;
  selected?: AdaptiveCandidate;
  provisional?: AdaptiveCandidate;
  fallback?: AdaptiveFallback;
  preferenceResolution?: AdaptivePreferenceResolution;
  referenceGuard?: AdaptiveReferenceGuardAssessment;
}

export type AdaptivePolicyAction = AdaptiveProbeAction | AdaptiveTerminalAction;

interface CellPlan {
  phase: AdaptiveCellPhase;
  action?: AdaptiveProbeAction;
  candidates: readonly AdaptiveCandidate[];
  boundaryGpuLayers?: number;
  highGpuLayers?: number;
  unresolvedReason?: string;
}

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be finite and positive`);
  }
}

function safeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function spreadPct(scores: readonly number[]): number {
  if (scores.length < 2) return 0;
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  return ((maximum - minimum) / minimum) * 100;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function withPolicy(
  partial: Partial<AdaptivePolicyDefaults> | undefined
): Readonly<AdaptivePolicyDefaults> {
  return Object.freeze({ ...ADAPTIVE_POLICY_DEFAULTS, ...partial });
}

/** Enumerate deterministic lower-pressure-first context/SWA/KV cells. */
export function enumerateAdaptiveCells(
  input: AdaptiveCellEnumerationInput
): readonly AdaptiveCell[] {
  safeNonNegativeInteger(input.totalLayers, 'totalLayers');
  if (input.profiles.length < 1 || input.profiles.length > 2) {
    throw new TypeError('adaptive profiles must contain one or two entries');
  }
  const profileIndices = new Set<number>();
  const contexts = new Set<number>();
  const expectedParallelRequests = input.profiles[0]!.parallelRequests;
  for (const profile of input.profiles) {
    safeNonNegativeInteger(profile.profileIndex, 'profileIndex');
    safeNonNegativeInteger(profile.autoGpuLayers, 'autoGpuLayers');
    finitePositive(profile.contextSize, 'contextSize');
    finitePositive(profile.parallelRequests, 'parallelRequests');
    if (
      !Number.isSafeInteger(profile.contextSize) ||
      !Number.isSafeInteger(profile.parallelRequests)
    ) {
      throw new TypeError('profile context and parallel request counts must be safe integers');
    }
    if (profile.parallelRequests > profile.contextSize) {
      throw new TypeError('parallelRequests cannot exceed contextSize');
    }
    if (profile.parallelRequests !== expectedParallelRequests) {
      throw new TypeError('adaptive profiles must use one shared parallelRequests value');
    }
    if (profileIndices.has(profile.profileIndex) || contexts.has(profile.contextSize)) {
      throw new TypeError('adaptive profile identities and contexts must be unique');
    }
    profileIndices.add(profile.profileIndex);
    contexts.add(profile.contextSize);
  }
  if (input.fixedGpuLayers !== undefined) {
    safeNonNegativeInteger(input.fixedGpuLayers, 'fixedGpuLayers');
    if (input.fixedGpuLayers > input.totalLayers) {
      throw new TypeError('fixedGpuLayers cannot exceed totalLayers');
    }
  }
  const sortedProfiles = [...input.profiles].sort(
    (left, right) => left.contextSize - right.contextSize || left.profileIndex - right.profileIndex
  );
  const kvValues: readonly AdaptiveKvPrecision[] = input.includeKvCacheComparison
    ? ['q8_0', 'f16']
    : [input.baselineKvPrecision];
  const cells: AdaptiveCell[] = [];
  for (let profileOrdinal = 0; profileOrdinal < sortedProfiles.length; profileOrdinal++) {
    const profile = sortedProfiles[profileOrdinal]!;
    const effectivePerSlotContext = Math.floor(profile.contextSize / profile.parallelRequests);
    const swaRelevant =
      input.fixedSwaFull === undefined &&
      input.slidingWindow !== undefined &&
      input.hasSharedPrefixWorkload &&
      effectivePerSlotContext > input.slidingWindow;
    const swaValues =
      input.fixedSwaFull !== undefined
        ? [input.fixedSwaFull]
        : swaRelevant
          ? [false, true]
          : [false];
    for (const swaFull of swaValues) {
      for (const kvPrecision of kvValues) {
        const physicalCeiling = input.gpuAvailable
          ? (input.fixedGpuLayers ?? input.totalLayers)
          : 0;
        const initialGpuLayers = input.gpuAvailable
          ? (input.fixedGpuLayers ?? Math.min(profile.autoGpuLayers, physicalCeiling))
          : 0;
        const id = [
          `p${profile.profileIndex}`,
          `c${profile.contextSize}`,
          swaFull ? 'swa-full' : 'swa-window',
          `kv-${kvPrecision}`,
        ].join(':');
        cells.push({
          id,
          order: cells.length,
          profileIndex: profile.profileIndex,
          profileOrdinal,
          contextSize: profile.contextSize,
          parallelRequests: profile.parallelRequests,
          effectivePerSlotContext,
          swaFull,
          kvPrecision,
          initialGpuLayers,
          physicalCeiling,
          fixedGpuLayers: input.fixedGpuLayers !== undefined,
          normalizedInvariantKey: profile.normalizedInvariantKey ?? 'default',
          kvTransferCompatible: input.kvTransferCompatible ?? false,
        });
      }
    }
  }
  return cells;
}

/** Resolve cell-count-scaled capped budgets. Caller overrides deliberately win. */
export function resolveAdaptiveBudgets(
  cellCount: number,
  overrides: AdaptiveBudgetOverrides = {}
): AdaptiveBudgets {
  if (!Number.isSafeInteger(cellCount) || cellCount < 1 || cellCount > 8) {
    throw new TypeError('cellCount must be an integer from 1 through 8');
  }
  const finalistReserve = Math.min(6, Math.max(2, cellCount));
  const maxProbes = overrides.maxProbes ?? Math.min(36, 7 + 4 * cellCount);
  const resolved: AdaptiveBudgets = {
    cellCount,
    targetProbes: overrides.targetProbes ?? Math.min(Math.min(24, 6 + 2 * cellCount), maxProbes),
    maxProbes,
    finalistReserve,
    maxWallTimeMs: overrides.maxWallTimeMs ?? Math.min(4_500_000, 900_000 + 450_000 * cellCount),
    finalistTimeReserveMs: Math.min(900_000, 150_000 * cellCount),
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'cellCount') continue;
    finitePositive(value, name);
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }
  if (resolved.targetProbes > resolved.maxProbes) {
    throw new TypeError('targetProbes cannot exceed maxProbes');
  }
  if (resolved.maxProbes <= resolved.finalistReserve) {
    throw new TypeError('maxProbes must exceed finalistReserve');
  }
  if (resolved.maxWallTimeMs <= resolved.finalistTimeReserveMs) {
    throw new TypeError('maxWallTimeMs must exceed finalistTimeReserveMs');
  }
  return resolved;
}

/** Deterministic conservative duration estimate used before comparable timing exists. */
export function estimateConfiguredProbeDuration(
  input: ConfiguredProbeDurationInput
): ConfiguredProbeDurationEstimate {
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    safeNonNegativeInteger(value, name);
  }
  finitePositive(input.startupTimeoutMs, 'startupTimeoutMs');
  finitePositive(input.requestTimeoutMs, 'requestTimeoutMs');
  finitePositive(input.serverStopTimeoutMs, 'serverStopTimeoutMs');
  const maxRunnerStartAttempts =
    input.maxRunnerStartAttempts ?? ADAPTIVE_POLICY_DEFAULTS.maxRunnerStartAttempts;
  const capacityCheckTimeoutCapMs =
    input.capacityCheckTimeoutCapMs ?? ADAPTIVE_POLICY_DEFAULTS.capacityCheckTimeoutCapMs;
  const processExitConfirmationMs =
    input.processExitConfirmationMs ?? ADAPTIVE_POLICY_DEFAULTS.processExitConfirmationMs;
  const processExitSettleGraceMs =
    input.processExitSettleGraceMs ?? ADAPTIVE_POLICY_DEFAULTS.processExitSettleGraceMs;
  finitePositive(maxRunnerStartAttempts, 'maxRunnerStartAttempts');
  finitePositive(capacityCheckTimeoutCapMs, 'capacityCheckTimeoutCapMs');
  const resolvedCapacityCheckTimeoutMs = Math.min(
    input.startupTimeoutMs,
    capacityCheckTimeoutCapMs
  );
  const configuredAttemptTeardownMs =
    input.serverStopTimeoutMs + processExitConfirmationMs + processExitSettleGraceMs;
  return {
    policy: 'configured-conservative-estimate',
    estimateMs:
      maxRunnerStartAttempts *
        (input.startupTimeoutMs + resolvedCapacityCheckTimeoutMs + configuredAttemptTeardownMs) +
      input.plannedPostStartupRequestCount * input.requestTimeoutMs,
    resolvedCapacityCheckTimeoutMs,
    configuredAttemptTeardownMs,
    plannedPostStartupRequestCount: input.plannedPostStartupRequestCount,
    maxRunnerStartAttempts,
    isFormalUpperBound: false,
  };
}

/** Decide whether a probe can start without consuming protected validation reserves. */
export function evaluateProbeAdmission(input: AdaptiveProbeAdmissionInput): AdaptiveProbeAdmission {
  if (input.probesUsed >= input.budgets.maxProbes) {
    return { allowed: false, reason: 'probe-limit' };
  }
  // The first probe of a calibration is always attempted while wall time remains.
  // Launch and time reserves protect later validation launches; before any
  // evidence exists there is nothing to protect, and the frozen
  // configured-conservative-estimate prices every planned request at the full
  // request timeout, so it can exceed an ordinary budget and return a
  // zero-probe report. The internal deadline still stops an overrunning probe
  // and performs confirmed cleanup.
  if (input.probesUsed === 0 && input.budgets.maxWallTimeMs - input.elapsedMs > 0) {
    return { allowed: true, reason: 'allowed' };
  }
  const remainingProbeSlots = input.budgets.maxProbes - input.probesUsed;
  if (!input.finalistPurpose && remainingProbeSlots <= input.budgets.finalistReserve) {
    return { allowed: false, reason: 'launch-reserve' };
  }
  const remainingWallTimeMs = input.budgets.maxWallTimeMs - input.elapsedMs;
  if (remainingWallTimeMs <= 0) return { allowed: false, reason: 'wall-time' };
  if (input.finalistPurpose) {
    if (remainingWallTimeMs <= input.estimatedNextProbeDurationMs) {
      return { allowed: false, reason: 'wall-time' };
    }
  } else {
    if (
      remainingWallTimeMs <=
      input.effectiveFinalistTimeReserveMs + input.estimatedNextProbeDurationMs
    ) {
      return { allowed: false, reason: 'time-reserve' };
    }
  }
  return { allowed: true, reason: 'allowed' };
}

/** Widest active preference window with a symmetric search-noise allowance. */
export function competitiveObservedRatio(input: {
  contextPreferenceActive: boolean;
  kvPreferenceActive: boolean;
  tieTolerancePct?: number;
  contextPreferencePct?: number;
  kvPrecisionPreferencePct?: number;
  searchNoiseAllowancePct?: number;
}): number {
  const activePreferencePct = Math.max(
    input.tieTolerancePct ?? ADAPTIVE_POLICY_DEFAULTS.tieTolerancePct,
    input.contextPreferenceActive
      ? (input.contextPreferencePct ?? ADAPTIVE_POLICY_DEFAULTS.contextPreferencePct)
      : 0,
    input.kvPreferenceActive
      ? (input.kvPrecisionPreferencePct ?? ADAPTIVE_POLICY_DEFAULTS.kvPrecisionPreferencePct)
      : 0
  );
  const noisePct =
    input.searchNoiseAllowancePct ?? ADAPTIVE_POLICY_DEFAULTS.searchNoiseAllowancePct;
  if (noisePct < 0 || noisePct >= 100) {
    throw new TypeError('searchNoiseAllowancePct must be at least zero and below 100');
  }
  return (1 + activePreferencePct / 100) * ((1 + noisePct / 100) / (1 - noisePct / 100));
}

/** Keep unresolved cells competitive until a direct boundary exists; never prune a trigger. */
export function isAdaptiveCellCompetitive(input: AdaptiveCompetitivenessInput): boolean {
  if (!input.hasDirectBoundary || input.triggeredNonMonotoneCandidate) return true;
  if (input.cellBestDirectScoreMs === undefined || input.globalBestDirectScoreMs === undefined) {
    return true;
  }
  return (
    input.cellBestDirectScoreMs <= input.globalBestDirectScoreMs * competitiveObservedRatio(input)
  );
}

/**
 * A cell has a directly observed boundary only once its bracket search has
 * converged. While it is still finding a reference, establishing a ceiling, or
 * bisecting, `boundaryGpuLayers` is merely the interim largest admissible point
 * — typically the low-layer reference. Pruning a cell on that score would
 * discard it without ever measuring the higher layers that may improve it
 * materially, which the policy explicitly forbids.
 */
function hasConvergedBoundary(phase: AdaptiveCellPhase): boolean {
  return (
    phase !== 'pending' &&
    phase !== 'finding-reference' &&
    phase !== 'establishing-ceiling' &&
    phase !== 'bisecting'
  );
}

function cellEvidence(
  evidence: readonly AdaptiveEvidence[],
  cellId: string
): readonly AdaptiveEvidence[] {
  return evidence.filter((item) => item.cellId === cellId);
}

function exactPointEvidence(
  evidence: readonly AdaptiveEvidence[],
  cellId: string,
  gpuLayers: number
): readonly AdaptiveEvidence[] {
  return evidence.filter((item) => item.cellId === cellId && item.gpuLayers === gpuLayers);
}

function latestPointEvidence(
  evidence: readonly AdaptiveEvidence[],
  cellId: string,
  gpuLayers: number
): AdaptiveEvidence | undefined {
  return exactPointEvidence(evidence, cellId, gpuLayers).at(-1);
}

function latestPointDecisions(
  evidence: readonly AdaptiveEvidence[],
  cellId: string
): ReadonlyMap<number, AdaptiveEvidence> {
  const result = new Map<number, AdaptiveEvidence>();
  for (const item of evidence) {
    if (item.cellId === cellId) result.set(item.gpuLayers, item);
  }
  return result;
}

function nearestLowerAdmissibleLayer(
  evidence: readonly AdaptiveEvidence[],
  cellId: string,
  gpuLayers: number
): number | undefined {
  const layers = [...latestPointDecisions(evidence, cellId).entries()]
    .filter(([layer, item]) => layer < gpuLayers && item.boundaryDecision === 'admissible')
    .map(([layer]) => layer);
  return layers.length > 0 ? Math.max(...layers) : undefined;
}

/** Find a reproduced, stable nearest-lower cliff denominator and conservatively use its slower score. */
export function findStableCliffReference(
  evidence: readonly AdaptiveEvidence[],
  cellId: string,
  gpuLayers: number,
  stabilityTolerancePct = ADAPTIVE_POLICY_DEFAULTS.stabilityTolerancePct
): StableCliffReference {
  const layer = nearestLowerAdmissibleLayer(evidence, cellId, gpuLayers);
  if (layer === undefined) return { status: 'missing', evidenceIndices: [] };
  const launches = exactPointEvidence(evidence, cellId, layer).filter(
    (item) =>
      item.operationalStatus === 'ok' &&
      item.boundaryDecision === 'admissible' &&
      item.scoreMs !== undefined
  );
  if (launches.length < 2) {
    return {
      status: 'insufficient',
      gpuLayers: layer,
      evidenceIndices: launches.map((item) => item.index),
    };
  }
  const scores = launches.map((item) => item.scoreMs!);
  if (spreadPct(scores) > stabilityTolerancePct) {
    return {
      status: 'unstable',
      gpuLayers: layer,
      evidenceIndices: launches.map((item) => item.index),
    };
  }
  return {
    status: 'eligible',
    gpuLayers: layer,
    denominatorScoreMs: Math.max(...scores),
    evidenceIndices: launches.map((item) => item.index),
  };
}

/** Determine whether two cap-terminated lower bounds conservatively prove a gross regression. */
export function canCloseCappedPoint(
  priorEvidence: readonly AdaptiveEvidence[],
  current: AdaptiveProbeObservation,
  stableReference: StableCliffReference,
  grossRegressionMultiplier = ADAPTIVE_POLICY_DEFAULTS.grossRegressionMultiplier
): boolean {
  if (
    !current.terminatedAtAdaptiveCap ||
    current.aggregateLowerBoundMs === undefined ||
    stableReference.status !== 'eligible' ||
    stableReference.denominatorScoreMs === undefined
  ) {
    return false;
  }
  const priorCaps = priorEvidence.filter(
    (item) =>
      item.cellId === current.cellId &&
      item.gpuLayers === current.gpuLayers &&
      item.resourceDriftStatus !== 'material' &&
      item.terminatedAtAdaptiveCap &&
      item.aggregateLowerBoundMs !== undefined
  );
  if (priorCaps.length !== 1) return false;
  const threshold = stableReference.denominatorScoreMs * grossRegressionMultiplier;
  return (
    priorCaps[0]!.aggregateLowerBoundMs! > threshold && current.aggregateLowerBoundMs > threshold
  );
}

function canCloseSuccessfulGrossPoint(
  priorEvidence: readonly AdaptiveEvidence[],
  current: AdaptiveProbeObservation,
  stableReference: StableCliffReference,
  grossRegressionMultiplier: number
): boolean {
  if (
    current.operationalStatus !== 'ok' ||
    current.scoreMs === undefined ||
    stableReference.status !== 'eligible' ||
    stableReference.denominatorScoreMs === undefined
  ) {
    return false;
  }
  const threshold = stableReference.denominatorScoreMs * grossRegressionMultiplier;
  const priorGross = priorEvidence.filter(
    (item) =>
      item.cellId === current.cellId &&
      item.gpuLayers === current.gpuLayers &&
      item.resourceDriftStatus !== 'material' &&
      item.operationalStatus === 'ok' &&
      item.scoreMs !== undefined &&
      item.scoreMs > threshold
  );
  return priorGross.length === 1 && current.scoreMs > threshold;
}

/** Classify one chronological probe from only immutable prior evidence. */
export function classifyAdaptiveObservation(
  priorEvidence: readonly AdaptiveEvidence[],
  observation: AdaptiveProbeObservation,
  policy: Readonly<AdaptivePolicyDefaults> = ADAPTIVE_POLICY_DEFAULTS
): AdaptiveClassification {
  if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0) {
    return { boundaryDecision: 'ambiguous', reason: 'invalid-duration' };
  }
  const priorAtPoint = exactPointEvidence(priorEvidence, observation.cellId, observation.gpuLayers);
  const stableReference = findStableCliffReference(
    priorEvidence,
    observation.cellId,
    observation.gpuLayers,
    policy.stabilityTolerancePct
  );

  if (observation.operationalStatus !== 'ok' && observation.memoryEvidence === 'confirmed') {
    return { boundaryDecision: 'unsuitable', reason: 'confirmed-allocation-failure' };
  }

  if (observation.resourceDriftStatus === 'material') {
    return { boundaryDecision: 'ambiguous', reason: 'resource-drift' };
  }

  if (observation.terminatedAtAdaptiveCap) {
    if (
      canCloseCappedPoint(
        priorEvidence,
        observation,
        stableReference,
        policy.grossRegressionMultiplier
      )
    ) {
      return { boundaryDecision: 'unsuitable', reason: 'reproduced-capped-gross-regression' };
    }
    return { boundaryDecision: 'ambiguous', reason: 'adaptive-cap' };
  }

  if (observation.operationalStatus !== 'ok') {
    const priorGenericFailures = priorAtPoint.filter(
      (item) =>
        item.operationalStatus !== 'ok' &&
        item.memoryEvidence !== 'confirmed' &&
        item.resourceDriftStatus !== 'material' &&
        // A timed-sample cap with an aggregate lower bound is a policy-driven censoring event, not
        // an independent generic failure. A warmup/control-path cap has no score lower bound; if the
        // one allowed full-timeout repeat also fails, the pair is reproduced operational evidence.
        (!item.terminatedAtAdaptiveCap || item.aggregateLowerBoundMs === undefined)
    );
    return priorGenericFailures.length === 1
      ? { boundaryDecision: 'unsuitable', reason: 'reproduced-operational-failure' }
      : { boundaryDecision: 'ambiguous', reason: 'generic-operational-failure' };
  }

  if (
    observation.scoreMs === undefined ||
    !Number.isFinite(observation.scoreMs) ||
    observation.scoreMs <= 0
  ) {
    return { boundaryDecision: 'ambiguous', reason: 'missing-or-invalid-score' };
  }

  const nearestLowerLayer = nearestLowerAdmissibleLayer(
    priorEvidence,
    observation.cellId,
    observation.gpuLayers
  );
  if (nearestLowerLayer !== undefined) {
    const lower = latestPointEvidence(priorEvidence, observation.cellId, nearestLowerLayer);
    const cliffDenominatorMs =
      stableReference.status === 'eligible' && stableReference.denominatorScoreMs !== undefined
        ? stableReference.denominatorScoreMs
        : lower?.scoreMs;
    if (
      cliffDenominatorMs !== undefined &&
      observation.scoreMs > cliffDenominatorMs * policy.grossRegressionMultiplier
    ) {
      if (
        canCloseSuccessfulGrossPoint(
          priorEvidence,
          observation,
          stableReference,
          policy.grossRegressionMultiplier
        )
      ) {
        return { boundaryDecision: 'unsuitable', reason: 'reproduced-performance-cliff' };
      }
      return { boundaryDecision: 'ambiguous', reason: 'first-performance-cliff' };
    }
  }

  const priorUnsuitableBelow = [...latestPointDecisions(priorEvidence, observation.cellId).values()]
    .filter(
      (item) => item.gpuLayers < observation.gpuLayers && item.boundaryDecision === 'unsuitable'
    )
    .sort((left, right) => right.gpuLayers - left.gpuLayers)[0];
  if (priorUnsuitableBelow) {
    const priorContradiction = priorAtPoint.some(
      (item) => item.boundaryDecision === 'ambiguous' && item.decisionReason === 'contradiction'
    );
    if (!priorContradiction) {
      return { boundaryDecision: 'ambiguous', reason: 'contradiction' };
    }
  }

  return { boundaryDecision: 'admissible', reason: 'completed-within-cliff-limit' };
}

/**
 * The launches at one point that may be compared with each other.
 *
 * A material-drift launch is intentionally retained in the chronological trail, but it is not a
 * comparable timing observation. The controller permits one clean repeat; persistent drift is
 * terminated by the manager before recommendation. Excluding only explicitly material launches
 * avoids making a single resolved telemetry disturbance permanently poison an otherwise stable
 * point while preserving every ordinary operational conflict.
 *
 * Reproduction may also never span a confirmed resource-regime change, so the set is confined to
 * the newest regime present: it describes the environment the run is now in, and requiring fresh
 * launches there is the conservative reading — older evidence stays in the trail but cannot
 * reproduce a point on its own.
 *
 * Every caller that counts or scores launches at a point must use this one subset. A gate that
 * counted a wider set than the assessment scored would see enough launches while the assessment
 * saw too few, and would stop scheduling the very launch needed to resolve the point.
 */
function comparableLaunchEvidence(
  evidence: readonly AdaptiveEvidence[]
): readonly AdaptiveEvidence[] {
  // The newest regime is taken over ALL evidence, not just the drift-free subset.
  // If the only launch in the current regime was itself materially drifting, the
  // comparable set is empty and the point reports `insufficient`, scheduling a
  // fresh launch under present conditions. Deriving the regime from the drift-free
  // subset instead would silently fall back to the pre-step regime and let stale
  // evidence reproduce the point.
  const activeRegime = evidence.reduce(
    (latest, item) => Math.max(latest, item.resourceRegime ?? 0),
    0
  );
  return evidence.filter(
    (item) => item.resourceDriftStatus !== 'material' && (item.resourceRegime ?? 0) === activeRegime
  );
}

/** Assess launch-level stability without ever mixing search scores into the recommendation score. */
export function assessMixedFidelityStability(
  evidence: readonly AdaptiveEvidence[],
  searchNoiseAllowancePct = ADAPTIVE_POLICY_DEFAULTS.searchNoiseAllowancePct,
  stabilityTolerancePct = ADAPTIVE_POLICY_DEFAULTS.stabilityTolerancePct
): MixedFidelityAssessment {
  const comparableEvidence = comparableLaunchEvidence(evidence);
  const nonOk = comparableEvidence.filter((item) => item.operationalStatus !== 'ok');
  if (nonOk.length > 0) {
    return {
      status: 'conflict',
      evidenceIndices: comparableEvidence.map((item) => item.index),
      reason: 'non-ok launch remains decision-relevant',
    };
  }
  const comparableFull = comparableEvidence.filter(
    (item) =>
      item.fidelity === 'full' &&
      item.operationalStatus === 'ok' &&
      item.scoreMs !== undefined &&
      Number.isFinite(item.scoreMs) &&
      item.scoreMs > 0
  );
  const admissibleFull = comparableFull.filter(
    (item) => item.boundaryDecision === 'admissible' && item.scoreMs !== undefined
  );
  const search = comparableEvidence.filter(
    (item) =>
      item.fidelity === 'search' &&
      item.boundaryDecision === 'admissible' &&
      item.scoreMs !== undefined
  );
  if (admissibleFull.length === 0) {
    return {
      status: 'insufficient',
      evidenceIndices: [...comparableFull, ...search].map((item) => item.index),
      reason: 'admissible full-fidelity launch required',
    };
  }
  const recommendationScoreMs = median(admissibleFull.map((item) => item.scoreMs!));
  if (comparableFull.length >= 2) {
    const spread = spreadPct(comparableFull.map((item) => item.scoreMs!));
    return {
      status: spread <= stabilityTolerancePct ? 'stable' : 'unstable',
      recommendationScoreMs,
      spreadPct: spread,
      evidenceIndices: comparableFull.map((item) => item.index),
      reason:
        spread <= stabilityTolerancePct
          ? 'all full-fidelity launches agree'
          : 'full-fidelity spread exceeds tolerance',
    };
  }
  if (search.length === 0) {
    return {
      status: 'insufficient',
      recommendationScoreMs,
      evidenceIndices: comparableFull.map((item) => item.index),
      reason: 'second independent launch required',
    };
  }
  const mixed = [...comparableFull, ...search];
  const spread = spreadPct(mixed.map((item) => item.scoreMs!));
  return {
    status: spread <= searchNoiseAllowancePct ? 'stable' : 'unstable',
    recommendationScoreMs,
    spreadPct: spread,
    evidenceIndices: mixed.map((item) => item.index),
    reason:
      spread <= searchNoiseAllowancePct
        ? 'full and all search launches agree'
        : 'mixed-fidelity spread exceeds allowance',
  };
}

function transferAxis(
  lower: AdaptiveCell,
  higher: AdaptiveCell
): AdaptiveCeilingHint['axis'] | undefined {
  if (lower.normalizedInvariantKey !== higher.normalizedInvariantKey) return undefined;
  const contextOnly =
    lower.contextSize < higher.contextSize &&
    lower.parallelRequests === higher.parallelRequests &&
    lower.swaFull === higher.swaFull &&
    lower.kvPrecision === higher.kvPrecision;
  if (contextOnly) return 'context';
  const swaOnly =
    lower.profileIndex === higher.profileIndex &&
    lower.contextSize === higher.contextSize &&
    !lower.swaFull &&
    higher.swaFull &&
    lower.kvPrecision === higher.kvPrecision;
  if (swaOnly) return 'swa';
  const kvOnly =
    lower.profileIndex === higher.profileIndex &&
    lower.contextSize === higher.contextSize &&
    lower.swaFull === higher.swaFull &&
    lower.kvPrecision === 'q8_0' &&
    higher.kvPrecision === 'f16' &&
    lower.kvTransferCompatible &&
    higher.kvTransferCompatible;
  return kvOnly ? 'kv' : undefined;
}

/** Derive source-only scheduling hints; callers must directly probe them in the receiving cell. */
export function deriveCeilingHints(
  cells: readonly AdaptiveCell[],
  evidence: readonly AdaptiveEvidence[]
): readonly AdaptiveCeilingHint[] {
  const hints: AdaptiveCeilingHint[] = [];
  for (const receiving of cells) {
    for (const source of cells) {
      if (source.order >= receiving.order) continue;
      const axis = transferAxis(source, receiving);
      if (!axis) continue;
      const sourceDecisions = [...latestPointDecisions(evidence, source.id).values()];
      const highestAdmissible = Math.max(
        -1,
        ...sourceDecisions
          .filter((item) => item.boundaryDecision === 'admissible')
          .map((item) => item.gpuLayers)
      );
      const sourcePoints = sourceDecisions.filter(
        (item) => item.boundaryDecision === 'unsuitable' && item.gpuLayers > highestAdmissible
      );
      for (const item of sourcePoints) {
        hints.push({
          receivingCellId: receiving.id,
          sourceCellId: source.id,
          gpuLayers: item.gpuLayers,
          sourceEvidenceIndex: item.index,
          kind:
            item.memoryEvidence === 'confirmed'
              ? 'hard-high-hypothesis'
              : 'provisional-scheduling-hint',
          axis,
        });
      }
    }
  }
  const orderByCell = new Map(cells.map((cell) => [cell.id, cell.order]));
  return hints.sort(
    (left, right) =>
      (orderByCell.get(left.receivingCellId) ?? Number.MAX_SAFE_INTEGER) -
        (orderByCell.get(right.receivingCellId) ?? Number.MAX_SAFE_INTEGER) ||
      left.gpuLayers - right.gpuLayers ||
      left.sourceEvidenceIndex - right.sourceEvidenceIndex
  );
}

/** Apply global context/KV bands and the lower-pressure structural tie-break without compounding. */
export function resolveAdaptiveRecommendation(
  candidates: readonly AdaptiveCandidate[],
  options: {
    contextPreferencePct: number;
    kvPrecisionPreferencePct: number;
    tieTolerancePct: number;
    contextPreferenceActive: boolean;
    kvPreferenceActive: boolean;
  }
): AdaptivePreferenceResolution {
  for (const [name, value] of [
    ['contextPreferencePct', options.contextPreferencePct],
    ['kvPrecisionPreferencePct', options.kvPrecisionPreferencePct],
    ['tieTolerancePct', options.tieTolerancePct],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be finite and non-negative`);
    }
  }
  if (candidates.length === 0) {
    return {
      eligible: [],
      kvPrecisionPreferenceResolution: 'not-active',
      finalEquivalenceSet: [],
    };
  }
  if (candidates.some((item) => !Number.isFinite(item.scoreMs) || item.scoreMs <= 0)) {
    throw new TypeError('candidate scores must be finite and positive');
  }
  const eligible = [...candidates].sort(
    (left, right) => left.scoreMs - right.scoreMs || left.cellOrder - right.cellOrder
  );
  const globalFastestScore = eligible[0]!.scoreMs;
  const contextBand = globalFastestScore * (1 + options.contextPreferencePct / 100);
  const kvBand = globalFastestScore * (1 + options.kvPrecisionPreferencePct / 100);
  const contextEligible = options.contextPreferenceActive
    ? eligible.filter((candidate) => candidate.scoreMs <= contextBand)
    : eligible;
  const selectedContextSize = Math.max(
    ...contextEligible.map((candidate) => candidate.contextSize)
  );
  const inContext = eligible.filter((candidate) => candidate.contextSize === selectedContextSize);

  let selectedKvPrecision: AdaptiveKvPrecision;
  let kvPrecisionPreferenceResolution: AdaptivePreferenceResolution['kvPrecisionPreferenceResolution'];
  let kvBandActive = false;
  if (options.kvPreferenceActive) {
    const jointBandCandidates = inContext.filter(
      (candidate) =>
        candidate.scoreMs <= kvBand &&
        (!options.contextPreferenceActive || candidate.scoreMs <= contextBand)
    );
    if (jointBandCandidates.length > 0) {
      selectedKvPrecision = jointBandCandidates.some((candidate) => candidate.kvPrecision === 'f16')
        ? 'f16'
        : 'q8_0';
      kvPrecisionPreferenceResolution = 'preferred-within-joint-band';
      kvBandActive = true;
    } else {
      const contextBandCandidates = inContext.filter(
        (candidate) => !options.contextPreferenceActive || candidate.scoreMs <= contextBand
      );
      selectedKvPrecision = [...contextBandCandidates].sort(
        (left, right) => left.scoreMs - right.scoreMs || left.cellOrder - right.cellOrder
      )[0]!.kvPrecision;
      kvPrecisionPreferenceResolution = 'fallback-no-joint-eligible';
    }
  } else {
    selectedKvPrecision = inContext[0]!.kvPrecision;
    kvPrecisionPreferenceResolution = 'not-active';
  }

  const selectedClass = inContext.filter(
    (candidate) => candidate.kvPrecision === selectedKvPrecision
  );
  const classFastest = Math.min(...selectedClass.map((candidate) => candidate.scoreMs));
  const finalEquivalenceSet = selectedClass.filter(
    (candidate) =>
      candidate.scoreMs <= classFastest * (1 + options.tieTolerancePct / 100) &&
      (!options.contextPreferenceActive || candidate.scoreMs <= contextBand) &&
      (!kvBandActive || candidate.scoreMs <= kvBand)
  );
  const structurallySorted = [...finalEquivalenceSet].sort(
    (left, right) =>
      left.gpuLayers - right.gpuLayers ||
      Number(left.swaFull) - Number(right.swaFull) ||
      left.scoreMs - right.scoreMs ||
      left.cellOrder - right.cellOrder
  );
  return {
    selected: structurallySorted[0],
    eligible,
    globalFastestScore,
    contextBand,
    kvBand,
    selectedContextSize,
    selectedKvPrecision,
    kvPrecisionPreferenceResolution,
    finalEquivalenceSet,
  };
}

/** Check the selected layer's materially lower direct guard observation. */
export function evaluateReferenceGuard(
  candidate: AdaptiveCandidate,
  evidence: readonly AdaptiveEvidence[],
  totalLayers: number,
  policy: Readonly<AdaptivePolicyDefaults> = ADAPTIVE_POLICY_DEFAULTS,
  fixedGpuLayers = false
): AdaptiveReferenceGuardAssessment {
  if (fixedGpuLayers) {
    return {
      status: 'not-applicable',
      targetGpuLayers: candidate.gpuLayers,
      reason: 'fixed-gpu-layers',
    };
  }
  const distance = Math.max(
    policy.guardDistanceMinLayers,
    Math.ceil(totalLayers * policy.guardDistanceFraction)
  );
  const targetGpuLayers = Math.max(0, candidate.gpuLayers - distance);
  if (candidate.gpuLayers === 0) {
    return {
      status: 'satisfied',
      targetGpuLayers,
      evidenceIndex: candidate.evidenceIndices[0],
    };
  }
  const admissible = cellEvidence(evidence, candidate.cellId)
    .filter(
      (item) =>
        item.gpuLayers <= targetGpuLayers &&
        item.boundaryDecision === 'admissible' &&
        item.operationalStatus === 'ok' &&
        item.scoreMs !== undefined
    )
    .sort((left, right) => right.gpuLayers - left.gpuLayers || right.index - left.index)[0];
  if (!admissible) {
    const attempted = cellEvidence(evidence, candidate.cellId).some(
      (item) => item.purpose === 'reference-guard' && item.gpuLayers === targetGpuLayers
    );
    return { status: attempted ? 'failed' : 'probe-required', targetGpuLayers };
  }
  const improvementPct = ((candidate.scoreMs - admissible.scoreMs!) / candidate.scoreMs) * 100;
  return {
    status: 'satisfied',
    targetGpuLayers,
    evidenceIndex: admissible.index,
    ...(improvementPct >= policy.nonMonotoneTriggerPct
      ? { promotionGpuLayers: admissible.gpuLayers }
      : {}),
  };
}

function probeAction(
  cell: AdaptiveCell,
  gpuLayers: number,
  purpose: AdaptiveProbePurpose,
  fidelity: AdaptiveFidelity,
  timeoutMode: AdaptiveTimeoutMode,
  inheritedCeiling?: AdaptiveCeilingHint
): AdaptiveProbeAction {
  return {
    kind: 'probe',
    cellId: cell.id,
    gpuLayers,
    purpose,
    fidelity,
    timeoutMode,
    decisionRelevant: true,
    ...(inheritedCeiling ? { inheritedCeiling } : {}),
  };
}

function unresolvedAmbiguity(
  evidence: readonly AdaptiveEvidence[],
  cellId: string
): AdaptiveEvidence | undefined {
  const latest = latestPointDecisions(evidence, cellId);
  return [...latest.values()]
    .filter((item) => item.boundaryDecision === 'ambiguous')
    .sort((left, right) => left.index - right.index)[0];
}

function ambiguityAction(
  state: AdaptivePolicyState,
  cell: AdaptiveCell,
  ambiguous: AdaptiveEvidence
): { action?: AdaptiveProbeAction; unresolvedReason?: string } {
  if (
    ambiguous.decisionReason === 'adaptive-cap' ||
    ambiguous.decisionReason === 'first-performance-cliff'
  ) {
    if (
      ambiguous.decisionReason === 'adaptive-cap' &&
      ambiguous.aggregateLowerBoundMs === undefined
    ) {
      return {
        action: probeAction(cell, ambiguous.gpuLayers, 'ambiguity-repeat', 'full', 'full'),
      };
    }
    const reference = findStableCliffReference(
      state.evidence,
      cell.id,
      ambiguous.gpuLayers,
      state.policy.stabilityTolerancePct
    );
    if (reference.status === 'unstable') {
      return { unresolvedReason: 'cliff lower reference is unstable' };
    }
    if (reference.status === 'missing') {
      return { unresolvedReason: 'cliff point has no lower reference' };
    }
    if (reference.status === 'insufficient') {
      return {
        action: probeAction(cell, reference.gpuLayers!, 'ambiguity-repeat', 'search', 'full'),
      };
    }
    return {
      action: probeAction(
        cell,
        ambiguous.gpuLayers,
        'ambiguity-repeat',
        ambiguous.decisionReason === 'adaptive-cap' ? 'search' : 'full',
        ambiguous.decisionReason === 'adaptive-cap' ? 'adaptive-with-full-continuation' : 'full'
      ),
    };
  }
  const attempts = exactPointEvidence(state.evidence, cell.id, ambiguous.gpuLayers).filter(
    (item) => item.purpose === 'ambiguity-repeat'
  );
  if (attempts.length >= 1) {
    return { unresolvedReason: `persistent ambiguity: ${ambiguous.decisionReason}` };
  }
  return {
    action: probeAction(cell, ambiguous.gpuLayers, 'ambiguity-repeat', 'full', 'full'),
  };
}

function pointEvidenceForStability(
  evidence: readonly AdaptiveEvidence[],
  cellId: string,
  gpuLayers: number
): readonly AdaptiveEvidence[] {
  return exactPointEvidence(evidence, cellId, gpuLayers);
}

function candidateAtPoint(
  cell: AdaptiveCell,
  gpuLayers: number,
  evidence: readonly AdaptiveEvidence[],
  source: AdaptiveCandidate['source'],
  policy: Readonly<AdaptivePolicyDefaults>
): { candidate?: AdaptiveCandidate; action?: AdaptiveProbeAction; unstable?: boolean } {
  const point = pointEvidenceForStability(evidence, cell.id, gpuLayers);
  // Must be the same subset `assessMixedFidelityStability` scores below: counting
  // full launches from a superseded resource regime here would satisfy the
  // "enough attempts" gate while the assessment still reported `insufficient`,
  // leaving the point permanently unresolvable.
  const fullAttempts = comparableLaunchEvidence(point).filter((item) => item.fidelity === 'full');
  if (fullAttempts.length === 0) {
    return {
      action: probeAction(
        cell,
        gpuLayers,
        source === 'boundary' ? 'finalist' : 'winner-validation',
        'full',
        'full'
      ),
    };
  }
  const assessment = assessMixedFidelityStability(
    point,
    policy.searchNoiseAllowancePct,
    policy.stabilityTolerancePct
  );
  if (assessment.status === 'stable' && assessment.recommendationScoreMs !== undefined) {
    return {
      candidate: {
        cellId: cell.id,
        cellOrder: cell.order,
        profileIndex: cell.profileIndex,
        contextSize: cell.contextSize,
        kvPrecision: cell.kvPrecision,
        swaFull: cell.swaFull,
        gpuLayers,
        scoreMs: assessment.recommendationScoreMs,
        evidenceIndices: assessment.evidenceIndices,
        source,
      },
    };
  }
  if (fullAttempts.length < 2) {
    return {
      action: probeAction(cell, gpuLayers, 'winner-validation', 'full', 'full'),
    };
  }
  return { unstable: true };
}

function nonMonotonePromotionLayer(
  cell: AdaptiveCell,
  baseCandidate: AdaptiveCandidate,
  evidence: readonly AdaptiveEvidence[],
  policy: Readonly<AdaptivePolicyDefaults>
): number | undefined {
  return cellEvidence(evidence, cell.id)
    .filter(
      (item) =>
        item.gpuLayers < baseCandidate.gpuLayers &&
        item.fidelity === 'search' &&
        item.boundaryDecision === 'admissible' &&
        item.scoreMs !== undefined &&
        ((baseCandidate.scoreMs - item.scoreMs) / baseCandidate.scoreMs) * 100 >=
          policy.nonMonotoneTriggerPct
    )
    .sort((left, right) => left.scoreMs! - right.scoreMs! || left.gpuLayers - right.gpuLayers)[0]
    ?.gpuLayers;
}

function nextReferenceLayer(
  cell: AdaptiveCell,
  evidence: readonly AdaptiveEvidence[],
  startingCeiling: number
): number | undefined {
  const observations = cellEvidence(evidence, cell.id);
  if (observations.length === 0) return Math.min(cell.initialGpuLayers, startingCeiling);
  const attemptedLayers = new Set(observations.map((item) => item.gpuLayers));
  let current = Math.min(...attemptedLayers);
  while (current > 0) {
    const next = Math.floor(current / 2);
    if (!attemptedLayers.has(next)) return next;
    current = next;
  }
  return attemptedLayers.has(0) ? undefined : 0;
}

function planCell(state: AdaptivePolicyState, cell: AdaptiveCell): CellPlan {
  const pointDecisions = latestPointDecisions(state.evidence, cell.id);
  const cellHints = deriveCeilingHints(state.cells, state.evidence).filter(
    (hint) => hint.receivingCellId === cell.id && hint.gpuLayers <= cell.physicalCeiling
  );
  const schedulingHint = cellHints[0];
  const admissibleLayers = [...pointDecisions.entries()]
    .filter(([, item]) => item.boundaryDecision === 'admissible')
    .map(([layer]) => layer);
  if (admissibleLayers.length === 0) {
    const ambiguous = unresolvedAmbiguity(state.evidence, cell.id);
    if (ambiguous) {
      const resolution = ambiguityAction(state, cell, ambiguous);
      if (resolution.action) {
        return { phase: 'finding-reference', candidates: [], action: resolution.action };
      }
      if (cell.fixedGpuLayers) {
        return {
          phase: 'unresolved',
          candidates: [],
          unresolvedReason: resolution.unresolvedReason,
        };
      }
      // A repeatedly ambiguous reference is not boundary evidence. Descend and look for a directly
      // observed admissible lower point; the ambiguous layer can then act only as a scheduling high.
    }
    if (cell.fixedGpuLayers) {
      const fixed = pointDecisions.get(cell.physicalCeiling);
      if (!fixed) {
        return {
          phase: 'finding-reference',
          candidates: [],
          action: probeAction(cell, cell.physicalCeiling, 'reference', 'search', 'full'),
        };
      }
      return { phase: 'no-viable-point', candidates: [] };
    }
    const referenceLayer = nextReferenceLayer(
      cell,
      state.evidence,
      schedulingHint?.gpuLayers ?? cell.physicalCeiling
    );
    if (referenceLayer === undefined) return { phase: 'no-viable-point', candidates: [] };
    return {
      phase: 'finding-reference',
      candidates: [],
      action: probeAction(
        cell,
        referenceLayer,
        'reference',
        'search',
        'full',
        schedulingHint?.gpuLayers === referenceLayer ? schedulingHint : undefined
      ),
    };
  }

  const low = Math.max(...admissibleLayers);
  const ambiguousAbove = [...pointDecisions.entries()]
    .filter(([layer, item]) => layer > low && item.boundaryDecision === 'ambiguous')
    .sort(([left], [right]) => left - right)[0];
  let provisionalAmbiguousHigh: number | undefined;
  if (ambiguousAbove) {
    const resolution = ambiguityAction(state, cell, ambiguousAbove[1]);
    if (resolution.action) {
      return {
        phase: 'bisecting',
        candidates: [],
        boundaryGpuLayers: low,
        highGpuLayers: ambiguousAbove[0],
        action: resolution.action,
      };
    }
    provisionalAmbiguousHigh = ambiguousAbove[0];
  }
  const unsuitableLayers = [...pointDecisions.entries()]
    .filter(([layer, item]) => layer > low && item.boundaryDecision === 'unsuitable')
    .map(([layer]) => layer);
  let high = unsuitableLayers.length > 0 ? Math.min(...unsuitableLayers) : undefined;
  if (provisionalAmbiguousHigh !== undefined) {
    high = high === undefined ? provisionalAmbiguousHigh : Math.min(high, provisionalAmbiguousHigh);
  }

  if (high === undefined && low < cell.physicalCeiling) {
    const hints = cellHints.filter((hint) => hint.gpuLayers > low);
    const hint = hints[0];
    if (hint) {
      const received = pointDecisions.get(hint.gpuLayers);
      if (!received) {
        return {
          phase: 'establishing-ceiling',
          candidates: [],
          boundaryGpuLayers: low,
          action: probeAction(cell, hint.gpuLayers, 'ceiling', 'search', 'adaptive', hint),
        };
      }
      if (received.boundaryDecision === 'unsuitable') high = hint.gpuLayers;
    }
  }

  if (high === undefined && low < cell.physicalCeiling) {
    const ceiling = pointDecisions.get(cell.physicalCeiling);
    if (!ceiling) {
      return {
        phase: 'establishing-ceiling',
        candidates: [],
        boundaryGpuLayers: low,
        action: probeAction(cell, cell.physicalCeiling, 'ceiling', 'search', 'adaptive'),
      };
    }
    if (ceiling.boundaryDecision === 'unsuitable') high = cell.physicalCeiling;
  }

  if (high !== undefined && high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (!pointDecisions.has(middle)) {
      return {
        phase: 'bisecting',
        candidates: [],
        boundaryGpuLayers: low,
        highGpuLayers: high,
        action: probeAction(cell, middle, 'boundary', 'search', 'adaptive'),
      };
    }
  }

  const boundaryGpuLayers = low;
  const boundary = candidateAtPoint(
    cell,
    boundaryGpuLayers,
    state.evidence,
    'boundary',
    state.policy
  );
  if (boundary.action) {
    return {
      phase: 'finalist',
      candidates: [],
      boundaryGpuLayers,
      highGpuLayers: high,
      action: boundary.action,
    };
  }
  let baseCandidate = boundary.candidate;
  if (boundary.unstable) {
    if (boundaryGpuLayers === 0 || cell.fixedGpuLayers) {
      return {
        phase: 'unresolved',
        candidates: [],
        boundaryGpuLayers,
        highGpuLayers: high,
        unresolvedReason: cell.fixedGpuLayers
          ? 'fixed-gpu-layers finalist is unstable'
          : 'g=0 finalist is unstable',
      };
    }
    const stepDown = candidateAtPoint(
      cell,
      boundaryGpuLayers - 1,
      state.evidence,
      'step-down',
      state.policy
    );
    if (stepDown.action) {
      return {
        phase: 'finalist',
        candidates: [],
        boundaryGpuLayers,
        highGpuLayers: high,
        action: stepDown.action,
      };
    }
    if (stepDown.unstable || !stepDown.candidate) {
      return {
        phase: 'unresolved',
        candidates: [],
        boundaryGpuLayers,
        highGpuLayers: high,
        unresolvedReason: 'boundary and one-layer step-down are unstable',
      };
    }
    baseCandidate = stepDown.candidate;
  }
  if (!baseCandidate) {
    return {
      phase: 'unresolved',
      candidates: [],
      boundaryGpuLayers,
      highGpuLayers: high,
      unresolvedReason: 'finalist evidence is incomplete',
    };
  }

  const promotionLayer = nonMonotonePromotionLayer(
    cell,
    baseCandidate,
    state.evidence,
    state.policy
  );
  if (promotionLayer !== undefined && promotionLayer !== baseCandidate.gpuLayers) {
    const promoted = candidateAtPoint(
      cell,
      promotionLayer,
      state.evidence,
      'non-monotone',
      state.policy
    );
    if (promoted.action) {
      return {
        phase: 'finalist',
        candidates: [],
        boundaryGpuLayers,
        highGpuLayers: high,
        action: promoted.action,
      };
    }
    if (promoted.unstable || !promoted.candidate) {
      return {
        phase: 'unresolved',
        candidates: [],
        boundaryGpuLayers,
        highGpuLayers: high,
        unresolvedReason: 'promoted non-monotone point is unstable',
      };
    }
    const candidates = [baseCandidate, promoted.candidate];
    return provisionalAmbiguousHigh !== undefined &&
      provisionalAmbiguousHigh - boundaryGpuLayers <= 1
      ? {
          phase: 'unresolved',
          candidates,
          boundaryGpuLayers,
          highGpuLayers: high,
          unresolvedReason: 'adjacent higher layer remains ambiguous after its independent repeat',
        }
      : {
          phase: 'resolved',
          candidates,
          boundaryGpuLayers,
          highGpuLayers: high,
        };
  }

  return provisionalAmbiguousHigh !== undefined && provisionalAmbiguousHigh - boundaryGpuLayers <= 1
    ? {
        phase: 'unresolved',
        candidates: [baseCandidate],
        boundaryGpuLayers,
        highGpuLayers: high,
        unresolvedReason: 'adjacent higher layer remains ambiguous after its independent repeat',
      }
    : {
        phase: 'resolved',
        candidates: [baseCandidate],
        boundaryGpuLayers,
        highGpuLayers: high,
      };
}

function isFinalistPurpose(purpose: AdaptiveProbePurpose): boolean {
  return ['finalist', 'winner-validation', 'fallback-validation', 'reference-guard'].includes(
    purpose
  );
}

function comparableDurationEstimate(state: AdaptivePolicyState): number {
  const comparable = state.evidence
    .filter(
      (item) =>
        item.operationalStatus === 'ok' &&
        item.resourceDriftStatus !== 'material' &&
        !item.terminatedAtAdaptiveCap &&
        item.durationMs > 0
    )
    .map((item) => item.durationMs);
  return comparable.length > 0
    ? median(comparable)
    : state.config.unobservedProbeDurationEstimateMs;
}

function effectiveFinalistTimeReserve(
  state: AdaptivePolicyState,
  plans: readonly { cell: AdaptiveCell; plan: CellPlan }[]
): number {
  const fullDurations = state.evidence
    .filter(
      (item) =>
        item.fidelity === 'full' &&
        item.operationalStatus === 'ok' &&
        item.resourceDriftStatus !== 'material' &&
        !item.terminatedAtAdaptiveCap &&
        item.durationMs > 0
    )
    .map((item) => item.durationMs);
  if (fullDurations.length === 0) return state.budgets.finalistTimeReserveMs;
  let remainingRequiredLaunches = 0;
  let resolvedWinnerValidationTail = 0;
  for (const { cell, plan } of plans) {
    if (plan.phase === 'resolved') {
      for (const candidate of plan.candidates) {
        let candidateValidationTail = 0;
        const guard = evaluateReferenceGuard(
          candidate,
          state.evidence,
          state.config.totalLayers,
          state.policy,
          cell.fixedGpuLayers
        );
        if (guard.status === 'probe-required') candidateValidationTail++;
        const needsFallback =
          !cell.fixedGpuLayers &&
          candidate.gpuLayers > 0 &&
          (candidate.source === 'step-down' ||
            (plan.highGpuLayers !== undefined && plan.highGpuLayers - candidate.gpuLayers <= 1));
        if (needsFallback && !validatedFallback(state, candidate)) {
          const attempted = state.evidence.some(
            (item) => item.cellId === candidate.cellId && item.purpose === 'fallback-validation'
          );
          if (!attempted) candidateValidationTail++;
        }
        resolvedWinnerValidationTail = Math.max(
          resolvedWinnerValidationTail,
          candidateValidationTail
        );
      }
      continue;
    }
    if (['resolved', 'unresolved', 'no-viable-point'].includes(plan.phase)) continue;
    remainingRequiredLaunches++;
    if (plan.action?.fidelity === 'full') {
      const hasIndependentSearch = exactPointEvidence(
        state.evidence,
        plan.action.cellId,
        plan.action.gpuLayers
      ).some(
        (item) =>
          item.fidelity === 'search' &&
          item.operationalStatus === 'ok' &&
          item.boundaryDecision === 'admissible'
      );
      if (!hasIndependentSearch) remainingRequiredLaunches++;
    }
  }
  remainingRequiredLaunches += resolvedWinnerValidationTail;
  return Math.max(
    state.budgets.finalistTimeReserveMs,
    Math.max(1, remainingRequiredLaunches) * Math.max(...fullDurations)
  );
}

/** Snapshot the timing-admission evidence used by the controller for reporting. */
export function summarizeAdaptiveTimingAdmission(state: AdaptivePolicyState): {
  policy: 'configured-conservative-estimate' | 'observed-comparable-launches';
  estimatedNextProbeDurationMs: number;
  effectiveFinalistTimeReserveMs: number;
} {
  const plans = state.cells.map((cell) => ({ cell, plan: planCell(state, cell) }));
  const comparableDurations = state.evidence
    .filter(
      (item) =>
        item.operationalStatus === 'ok' &&
        item.resourceDriftStatus !== 'material' &&
        !item.terminatedAtAdaptiveCap &&
        item.durationMs > 0
    )
    .map((item) => item.durationMs);
  return {
    policy:
      comparableDurations.length > 0
        ? 'observed-comparable-launches'
        : 'configured-conservative-estimate',
    estimatedNextProbeDurationMs:
      comparableDurations.length > 0
        ? median(comparableDurations)
        : state.config.unobservedProbeDurationEstimateMs,
    effectiveFinalistTimeReserveMs: effectiveFinalistTimeReserve(state, plans),
  };
}

function admitOrBudgetTerminal(
  state: AdaptivePolicyState,
  action: AdaptiveProbeAction,
  plans: readonly { cell: AdaptiveCell; plan: CellPlan }[],
  preference?: AdaptivePreferenceResolution
): AdaptivePolicyAction {
  const admission = evaluateProbeAdmission({
    probesUsed: state.evidence.length,
    elapsedMs: state.elapsedMs,
    budgets: state.budgets,
    finalistPurpose: isFinalistPurpose(action.purpose),
    estimatedNextProbeDurationMs: comparableDurationEstimate(state),
    effectiveFinalistTimeReserveMs: effectiveFinalistTimeReserve(state, plans),
  });
  return admission.allowed
    ? action
    : {
        kind: 'terminal',
        status: 'budget-exhausted',
        reason: `required probe denied by ${admission.reason}`,
        ...(preference?.selected ? { provisional: preference.selected } : {}),
        ...(preference ? { preferenceResolution: preference } : {}),
      };
}

/** Create the immutable controller state without provisioning or performing I/O. */
export function createAdaptivePolicyState(config: AdaptivePolicyConfig): AdaptivePolicyState {
  finitePositive(config.unobservedProbeDurationEstimateMs, 'unobservedProbeDurationEstimateMs');
  for (const [name, value] of [
    ['contextPreferencePct', config.contextPreferencePct],
    ['kvPrecisionPreferencePct', config.kvPrecisionPreferencePct],
    ['tieTolerancePct', config.tieTolerancePct],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`${name} must be finite and non-negative`);
    }
  }
  const policy = withPolicy(config.policy);
  for (const name of [
    'grossRegressionMultiplier',
    'guardDistanceMinLayers',
    'guardDistanceFraction',
    'stabilityTolerancePct',
    'maxRunnerStartAttempts',
    'capacityCheckTimeoutCapMs',
  ] as const) {
    finitePositive(policy[name], name);
  }
  for (const name of [
    'tieTolerancePct',
    'contextPreferencePct',
    'kvPrecisionPreferencePct',
    'nonMonotoneTriggerPct',
  ] as const) {
    if (!Number.isFinite(policy[name]) || policy[name] < 0) {
      throw new TypeError(`${name} must be finite and non-negative`);
    }
  }
  if (
    !Number.isFinite(policy.searchNoiseAllowancePct) ||
    policy.searchNoiseAllowancePct < 0 ||
    policy.searchNoiseAllowancePct >= 100
  ) {
    throw new TypeError('searchNoiseAllowancePct must be at least zero and below 100');
  }
  const cells = enumerateAdaptiveCells(config);
  return {
    config,
    policy,
    cells,
    budgets: resolveAdaptiveBudgets(cells.length, config.budgetOverrides),
    evidence: [],
    elapsedMs: 0,
  };
}

/** Snapshot profile-aware cell states for reports and deterministic trace assertions. */
export function summarizeAdaptiveCellStates(
  state: AdaptivePolicyState
): readonly AdaptiveCellStateSummary[] {
  return state.cells.map((cell) => {
    const plan = planCell(state, cell);
    const decisions = [...latestPointDecisions(state.evidence, cell.id).entries()];
    const lowGpuLayers = decisions
      .filter(([, item]) => item.boundaryDecision === 'admissible')
      .map(([layer]) => layer)
      .sort((left, right) => right - left)[0];
    return {
      cell,
      phase: plan.phase,
      ...(lowGpuLayers !== undefined ? { lowGpuLayers } : {}),
      ...(plan.highGpuLayers !== undefined ? { highGpuLayers: plan.highGpuLayers } : {}),
      ...(plan.boundaryGpuLayers !== undefined
        ? { boundaryGpuLayers: plan.boundaryGpuLayers }
        : {}),
      candidates: plan.candidates,
      ...(plan.unresolvedReason ? { unresolvedReason: plan.unresolvedReason } : {}),
    };
  });
}

function validatedFallback(
  state: AdaptivePolicyState,
  selected: AdaptiveCandidate
): AdaptiveFallback | undefined {
  if (selected.gpuLayers === 0) return undefined;
  const layer = selected.gpuLayers - 1;
  const evidence = latestPointEvidence(state.evidence, selected.cellId, layer);
  return evidence
    ? {
        cellId: selected.cellId,
        gpuLayers: layer,
        validated: evidence.boundaryDecision === 'admissible',
        evidenceIndex: evidence.index,
      }
    : undefined;
}

/** Return the next deterministic probe or terminal action for the immutable trace. */
export function nextAdaptivePolicyAction(state: AdaptivePolicyState): AdaptivePolicyAction {
  const plans = state.cells.map((cell) => ({ cell, plan: planCell(state, cell) }));
  const candidates = plans.flatMap(({ plan }) => plan.candidates);
  const preference = resolveAdaptiveRecommendation(candidates, {
    contextPreferencePct: state.config.contextPreferencePct ?? state.policy.contextPreferencePct,
    kvPrecisionPreferencePct:
      state.config.kvPrecisionPreferencePct ?? state.policy.kvPrecisionPreferencePct,
    tieTolerancePct: state.config.tieTolerancePct ?? state.policy.tieTolerancePct,
    contextPreferenceActive: state.config.profiles.length > 1,
    kvPreferenceActive: state.config.includeKvCacheComparison,
  });
  const actionable = plans.find(({ cell, plan }) => {
    if (!plan.action) return false;
    if (!preference.selected || plan.boundaryGpuLayers === undefined) return true;
    const directScores = exactPointEvidence(state.evidence, cell.id, plan.boundaryGpuLayers)
      .filter(
        (item) =>
          item.boundaryDecision === 'admissible' &&
          item.resourceDriftStatus !== 'material' &&
          item.scoreMs !== undefined &&
          Number.isFinite(item.scoreMs) &&
          item.scoreMs > 0
      )
      .map((item) => item.scoreMs!);
    const cellBestDirectScoreMs = directScores.length > 0 ? Math.min(...directScores) : undefined;
    const triggeredNonMonotoneCandidate =
      plan.candidates.some((candidate) => candidate.source === 'non-monotone') ||
      (cellBestDirectScoreMs !== undefined &&
        cellEvidence(state.evidence, cell.id).some(
          (item) =>
            item.gpuLayers < plan.boundaryGpuLayers! &&
            item.boundaryDecision === 'admissible' &&
            item.resourceDriftStatus !== 'material' &&
            item.scoreMs !== undefined &&
            ((cellBestDirectScoreMs - item.scoreMs) / cellBestDirectScoreMs) * 100 >=
              state.policy.nonMonotoneTriggerPct
        ));
    return isAdaptiveCellCompetitive({
      hasDirectBoundary: hasConvergedBoundary(plan.phase),
      cellBestDirectScoreMs,
      globalBestDirectScoreMs: preference.globalFastestScore,
      triggeredNonMonotoneCandidate,
      contextPreferenceActive: state.config.profiles.length > 1,
      kvPreferenceActive: state.config.includeKvCacheComparison,
      contextPreferencePct: state.config.contextPreferencePct ?? state.policy.contextPreferencePct,
      kvPrecisionPreferencePct:
        state.config.kvPrecisionPreferencePct ?? state.policy.kvPrecisionPreferencePct,
      tieTolerancePct: state.config.tieTolerancePct ?? state.policy.tieTolerancePct,
      searchNoiseAllowancePct: state.policy.searchNoiseAllowancePct,
    });
  });
  if (actionable?.plan.action) {
    return admitOrBudgetTerminal(state, actionable.plan.action, plans, preference);
  }
  const unresolved = plans.find(({ plan }) => {
    if (plan.phase !== 'unresolved') return false;
    if (plan.candidates.length === 0) return true;
    const bestCellCandidate = [...plan.candidates].sort(
      (left, right) => left.scoreMs - right.scoreMs
    )[0]!;
    return isAdaptiveCellCompetitive({
      hasDirectBoundary: plan.boundaryGpuLayers !== undefined,
      cellBestDirectScoreMs: bestCellCandidate.scoreMs,
      globalBestDirectScoreMs: preference.globalFastestScore,
      triggeredNonMonotoneCandidate: plan.candidates.some(
        (candidate) => candidate.source === 'non-monotone'
      ),
      contextPreferenceActive: state.config.profiles.length > 1,
      kvPreferenceActive: state.config.includeKvCacheComparison,
      contextPreferencePct: state.config.contextPreferencePct ?? state.policy.contextPreferencePct,
      kvPrecisionPreferencePct:
        state.config.kvPrecisionPreferencePct ?? state.policy.kvPrecisionPreferencePct,
      tieTolerancePct: state.config.tieTolerancePct ?? state.policy.tieTolerancePct,
      searchNoiseAllowancePct: state.policy.searchNoiseAllowancePct,
    });
  });
  if (unresolved) {
    return {
      kind: 'terminal',
      status: 'budget-exhausted',
      reason: unresolved.plan.unresolvedReason ?? 'decision-relevant cell is unresolved',
      ...(preference.selected ? { provisional: preference.selected } : {}),
      preferenceResolution: preference,
    };
  }
  if (!preference.selected) {
    const allNoViable = plans.every(({ plan }) => plan.phase === 'no-viable-point');
    return {
      kind: 'terminal',
      status: allNoViable ? 'no-viable-candidate' : 'budget-exhausted',
      reason: allNoViable
        ? 'every cell was directly resolved without an admissible point'
        : 'no eligible reproduced finalist exists',
      preferenceResolution: preference,
    };
  }

  const selected = preference.selected;
  const selectedCell = state.cells.find((item) => item.id === selected.cellId);
  if (!selectedCell)
    throw new TypeError(`selected candidate references unknown cell ${selected.cellId}`);
  const guard = evaluateReferenceGuard(
    selected,
    state.evidence,
    state.config.totalLayers,
    state.policy,
    selectedCell.fixedGpuLayers
  );
  if (guard.status === 'probe-required') {
    return admitOrBudgetTerminal(
      state,
      probeAction(selectedCell, guard.targetGpuLayers, 'reference-guard', 'search', 'full'),
      plans,
      preference
    );
  }
  if (guard.status === 'failed') {
    return {
      kind: 'terminal',
      status: 'budget-exhausted',
      reason: 'winning reference guard could not establish an admissible lower point',
      provisional: selected,
      preferenceResolution: preference,
      referenceGuard: guard,
    };
  }

  const selectedPlan = plans.find(({ cell }) => cell.id === selected.cellId)!.plan;
  const needsFallback =
    !selectedCell.fixedGpuLayers &&
    selected.gpuLayers > 0 &&
    (selected.source === 'step-down' ||
      (selectedPlan.highGpuLayers !== undefined &&
        selectedPlan.highGpuLayers - selected.gpuLayers <= 1));
  const fallback = validatedFallback(state, selected);
  const fallbackAttempted = state.evidence.some(
    (item) => item.cellId === selected.cellId && item.purpose === 'fallback-validation'
  );
  if (needsFallback && !fallback && !fallbackAttempted) {
    const action = probeAction(
      selectedCell,
      selected.gpuLayers - 1,
      'fallback-validation',
      'search',
      'full'
    );
    const admitted = admitOrBudgetTerminal(state, action, plans, preference);
    if (admitted.kind === 'probe') return admitted;
  }
  const reportedFallback =
    fallback ??
    (needsFallback
      ? {
          cellId: selected.cellId,
          gpuLayers: selected.gpuLayers - 1,
          validated: false,
        }
      : undefined);

  return {
    kind: 'terminal',
    status: 'complete',
    reason: 'all active preferences and empirical reproduction requirements are resolved',
    selected,
    ...(reportedFallback ? { fallback: reportedFallback } : {}),
    preferenceResolution: preference,
    referenceGuard: guard,
  };
}

/** Append one matching raw observation, classifying it from the prior immutable trace. */
export function applyAdaptivePolicyObservation(
  state: AdaptivePolicyState,
  observation: AdaptiveProbeObservation
): AdaptivePolicyState {
  const expected = nextAdaptivePolicyAction(state);
  if (expected.kind !== 'probe') {
    throw new TypeError(`cannot append an observation after terminal status ${expected.status}`);
  }
  if (
    observation.cellId !== expected.cellId ||
    observation.gpuLayers !== expected.gpuLayers ||
    observation.purpose !== expected.purpose ||
    observation.fidelity !== expected.fidelity
  ) {
    throw new TypeError(
      `observation does not match expected probe ${expected.cellId}@${expected.gpuLayers}:${expected.purpose}:${expected.fidelity}`
    );
  }
  const classification = classifyAdaptiveObservation(state.evidence, observation, state.policy);
  const evidence: AdaptiveEvidence = {
    ...observation,
    index: state.evidence.length,
    boundaryDecision: classification.boundaryDecision,
    decisionReason: classification.reason,
  };
  return {
    ...state,
    evidence: [...state.evidence, evidence],
    elapsedMs: state.elapsedMs + observation.durationMs,
  };
}
