/**
 * LLM runtime-calibration types.
 *
 * Omit `combos` and pass one or two `profiles` to use the adaptive boundary
 * search. Pass a singular `profile` with non-empty `combos` to benchmark an
 * exact caller-ordered list.
 *
 * @module types/llm-calibration
 */

import type { LlamaServerConfig } from './servers.js';

/** Exact total context allocation and llama-server slot count. */
export interface LlamaCalibrationProfile {
  /** Exact total llama-server `-c` allocation across all slots. */
  contextSize: number;
  /** Exact llama-server `-np` slot count. */
  parallelRequests: number;
}

/** Launch fields that an exact candidate may vary. */
export type LlamaCalibrationOverrides = Partial<
  Pick<
    LlamaServerConfig,
    | 'gpuLayers'
    | 'swaFull'
    | 'cacheTypeK'
    | 'cacheTypeV'
    | 'flashAttention'
    | 'cpuMoe'
    | 'nCpuMoe'
    | 'overrideTensors'
    | 'threads'
    | 'batchSize'
    | 'cacheRam'
  >
>;

/** Launch fields inherited identically by every probe. */
export type LlamaCalibrationFixedConfig = LlamaCalibrationOverrides &
  Partial<Pick<LlamaServerConfig, 'continuousBatching' | 'useMmap' | 'useMlock'>>;

/** One exact candidate to benchmark. */
export interface LlamaCalibrationCombo {
  /** Stable caller label used in progress and reports. */
  label?: string;
  /** Candidate overrides, separate from the label for direct start-config reuse. */
  overrides: LlamaCalibrationOverrides;
}

/** A cold request scenario, including a fixed prediction length. */
export interface LlamaColdPrefillWorkload {
  id: string;
  kind: 'cold-prefill';
  prompt: string;
  nPredict: number;
  /** Relative scenario frequency; optional only for a sole workload. */
  weight?: number;
}

/** A complete shared-prefix burst measured on one controlled server slot. */
export interface LlamaSharedPrefixWorkload {
  id: string;
  kind: 'shared-prefix';
  sharedPrefix: string;
  /** The first suffix primes the slot; at least one further suffix is timed. */
  suffixes: readonly string[];
  nPredict: number;
  /** Relative complete-burst frequency; optional only for a sole workload. */
  weight?: number;
}

export type LlamaCalibrationWorkload = LlamaColdPrefillWorkload | LlamaSharedPrefixWorkload;

export type LlamaCalibrationOperationalStatus =
  | 'ok'
  | 'oom'
  | 'startup-timeout'
  | 'request-timeout'
  | 'crashed'
  | 'error';

/** Kept as a concise alias for probe/exact-run operational status. */
export type LlamaCalibrationStatus = LlamaCalibrationOperationalStatus;

export type LlamaCalibrationProbePurpose =
  | 'reference'
  | 'reference-guard'
  | 'ceiling'
  | 'boundary'
  | 'ambiguity-repeat'
  | 'finalist'
  | 'winner-validation'
  | 'fallback-validation'
  | 'exact';

export type LlamaAdaptiveCalibrationProbePurpose = Exclude<LlamaCalibrationProbePurpose, 'exact'>;

export type LlamaCalibrationProbeFidelity = 'search' | 'full';

export type LlamaCalibrationProbePhase =
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

export type LlamaAdaptiveCalibrationPhase =
  | 'preparing'
  | 'policy-ready'
  | 'finding-reference'
  | 'establishing-ceiling'
  | 'bisecting'
  | 'validating-finalist'
  | 'validating-winner'
  | 'validating-fallback'
  | 'stopping';

export type LlamaExactCalibrationPhase =
  | 'preparing'
  | 'starting'
  | 'capacity-check'
  | 'warmup'
  | 'sampling'
  | 'stopping';

/** Union of non-terminal progress phases retained for convenient consumers. */
export type LlamaCalibrationPhase =
  | LlamaAdaptiveCalibrationPhase
  | LlamaExactCalibrationPhase
  | 'done';

type LlamaAdaptiveCalibrationTerminalStatus =
  | 'complete'
  | 'time-limited'
  | 'probe-limited'
  | 'inconclusive'
  | 'no-viable-candidate';

export type LlamaCalibrationTerminalStatus =
  | LlamaAdaptiveCalibrationTerminalStatus
  | 'aborted'
  | 'failed';

export type LlamaExactCalibrationTerminalStatus =
  | 'complete'
  | 'no-viable-candidate'
  | 'aborted'
  | 'failed';

export type LlamaAdaptiveProgressBudget = {
  maxWallTimeMs: number;
  remainingMs: number;
} & (
  | { maxProbes?: never; remainingProbes?: never }
  | { maxProbes: number; remainingProbes: number }
);

/** Start-ready measured fields returned for every exact or adaptive launch. */
export type ResolvedLlamaCalibrationConfig = LlamaCalibrationProfile &
  LlamaCalibrationFixedConfig &
  LlamaCalibrationOverrides;

export interface LlamaAdaptiveActiveProbe {
  /** Stable caller-order profile identity. */
  profileIndex: number;
  /** Smaller-context-first scheduling position. */
  profileOrdinal: number;
  cellId: string;
  purpose: LlamaAdaptiveCalibrationProbePurpose;
  gpuLayers: number;
  fidelity: LlamaCalibrationProbeFidelity;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  argvKey: string;
  probePhase?: LlamaCalibrationProbePhase;
}

export type LlamaExactProgressCandidates =
  | { resolved: false }
  | { resolved: true; comboCount: number };

export interface LlamaExactActiveCandidate {
  comboIndex: number;
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  gpuLayers: number;
}

interface LlamaCalibrationProgressBase {
  overallPercent: number;
  elapsedMs: number;
  workloadIndex?: number;
  workloadCount?: number;
  sampleIndex?: number;
  sampleCount?: number;
}

/** Strategy-discriminated, monotonic progress suitable for host-app UIs. */
export type LlamaCalibrationProgress =
  | (LlamaCalibrationProgressBase & {
      strategy: 'adaptive';
      phase: LlamaAdaptiveCalibrationPhase;
      terminalStatus?: never;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
      activeProbe?: LlamaAdaptiveActiveProbe;
    })
  | (LlamaCalibrationProgressBase & {
      strategy: 'exact';
      phase: LlamaExactCalibrationPhase;
      terminalStatus?: never;
      candidates: LlamaExactProgressCandidates;
      activeCandidate?: LlamaExactActiveCandidate;
    })
  | {
      strategy: 'adaptive';
      phase: 'done';
      terminalStatus: LlamaCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      completedProbes: number;
      budget: LlamaAdaptiveProgressBudget;
    }
  | {
      strategy: 'exact';
      phase: 'done';
      terminalStatus: LlamaExactCalibrationTerminalStatus;
      overallPercent: number;
      elapsedMs: number;
      candidates: LlamaExactProgressCandidates;
    };

interface LlamaCalibrationConfigCommon {
  modelId: string;
  /** Pinned values inherited by every launch and excluded from variation. */
  fixedConfig?: LlamaCalibrationFixedConfig;
  /** Required production scenario mix. Raw prompts are omitted from reports. */
  workloads: readonly LlamaCalibrationWorkload[];
  /** Timed repetitions per workload for full-fidelity launches. Default: 3. */
  samples?: number;
  /** Deterministic completion seed. Default: 42. */
  seed?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onProgress?: (progress: LlamaCalibrationProgress) => void;
  signal?: AbortSignal;
}

export interface LlamaAdaptiveCalibrationConfig extends LlamaCalibrationConfigCommon {
  profiles:
    | readonly [LlamaCalibrationProfile]
    | readonly [LlamaCalibrationProfile, LlamaCalibrationProfile];
  profile?: never;
  combos?: never;
  /** Add q8 and f16 as independently searched cells. Default: false. */
  includeKvCacheComparison?: boolean;
  /** Prefer f16 inside this global-fastest slowdown band. Default: 10. */
  kvPrecisionPreferencePct?: number;
  /** Prefer the larger requested context inside this global-fastest band. Default: 10. */
  contextPreferencePct?: number;
  /** Optional expert/test launch cap. Omission means no caller-configured probe limit. */
  maxProbes?: number;
  /** Total elapsed limit from `calibrate()` method entry. Default: 60 minutes. */
  maxWallTimeMs?: number;
}

export interface LlamaExactCalibrationConfig extends LlamaCalibrationConfigCommon {
  profile: LlamaCalibrationProfile;
  profiles?: never;
  combos: readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]];
  /** Exact mode retains the existing larger-KV preference. Default: 10. */
  kvPrecisionPreferencePct?: number;
  includeKvCacheComparison?: never;
  contextPreferencePct?: never;
  maxProbes?: never;
  maxWallTimeMs?: never;
}

/** Configuration for {@link LlamaServerManager.calibrate}. */
export type LlamaCalibrationConfig = LlamaAdaptiveCalibrationConfig | LlamaExactCalibrationConfig;

/** Server and wall-clock timing for one HTTP completion request. */
export interface LlamaCalibrationRequestTiming {
  wallTimeMs: number;
  promptTokens?: number;
  promptMs?: number;
  promptTokensPerSecond?: number;
  predictedTokens?: number;
  predictedMs?: number;
  predictedTokensPerSecond?: number;
  cachedTokens?: number;
}

/** One complete timed scenario repetition. */
export interface LlamaCalibrationSample {
  wallTimeMs: number;
  requests: readonly LlamaCalibrationRequestTiming[];
}

export interface LlamaCalibrationWorkloadResult {
  workloadId: string;
  kind: LlamaCalibrationWorkload['kind'];
  workloadHash: string;
  weight: number;
  samples: readonly LlamaCalibrationSample[];
  medianWallTimeMs?: number;
  error?: string;
}

export interface LlamaCalibrationMemoryEvidence {
  classification: 'none' | 'suspected' | 'confirmed' | 'unknown';
  reason: string;
  source:
    | 'specific-allocation-diagnostic'
    | 'broad-operational-diagnostic'
    | 'timeout'
    | 'process-exit'
    | 'performance'
    | 'not-observed';
}

export interface LlamaCalibrationBoundaryDecision {
  classification: 'admissible' | 'unsuitable' | 'ambiguous' | 'not-applicable';
  reason: string;
}

export interface LlamaCalibrationCleanupRecord {
  confirmed: boolean;
  durationMs: number;
  pid?: number;
  error?: string;
}

/** The two independently guarded resources. There is no weighting and no combined score. */
export type LlamaCalibrationResourceMetric = 'hostMemory' | 'vram';

/** Which side of the fixed baseline a suspicious reading fell on. Diagnostic; both are fatal. */
export type LlamaCalibrationResourceChangeDirection = 'decrease' | 'increase';

/** Which side of a launch a resource boundary check belongs to. */
export type LlamaCalibrationResourceBoundaryKind = 'pre-launch' | 'post-cleanup';

/** Why a boundary reading could not be compared against the fixed baseline. */
export type LlamaCalibrationResourceUntrustedReason =
  | 'telemetry-refresh-failed'
  | 'reading-unavailable'
  | 'reading-invalid';

/** One metric's reading inside one boundary snapshot. */
export interface LlamaCalibrationResourceReading {
  metric: LlamaCalibrationResourceMetric;
  /** False when the metric has no usable baseline; such a metric never triggers anything. */
  enabled: boolean;
  trusted: boolean;
  untrustedReason?: LlamaCalibrationResourceUntrustedReason;
  availableBytes?: number;
  /** Signed: positive means less availability than the baseline, negative means more. */
  decreasePctFromBaseline?: number;
  decreaseThresholdPct?: number;
  increaseThresholdPct?: number;
  suspicious: boolean;
  suspiciousDirection?: LlamaCalibrationResourceChangeDirection;
}

/** One whole-machine snapshot evaluated against the fixed baseline. */
export interface LlamaCalibrationResourceSnapshotDiagnostic {
  readings: readonly LlamaCalibrationResourceReading[];
  suspiciousMetrics: readonly LlamaCalibrationResourceMetric[];
  /** Enabled but untrusted metrics. Recorded only; they never indicate drift on their own. */
  untrustedMetrics: readonly LlamaCalibrationResourceMetric[];
}

/**
 * One launch boundary: an initial snapshot plus, only when it was suspicious, one confirmation.
 */
export interface LlamaCalibrationResourceBoundaryDiagnostic {
  boundary: LlamaCalibrationResourceBoundaryKind;
  confirmationPerformed: boolean;
  initial: LlamaCalibrationResourceSnapshotDiagnostic;
  confirmation?: LlamaCalibrationResourceSnapshotDiagnostic;
  initiallySuspiciousMetrics: readonly LlamaCalibrationResourceMetric[];
  warnings: readonly string[];
}

/**
 * Both guarded boundaries of one launch.
 *
 * `postCleanup` is present only when teardown was confirmed, because an unconfirmed teardown
 * rejects with its own cleanup error before any resource classification happens. Either side is
 * absent when resource monitoring was unavailable for the run.
 */
export interface LlamaCalibrationProbeResourceBoundaries {
  preLaunch?: LlamaCalibrationResourceBoundaryDiagnostic;
  postCleanup?: LlamaCalibrationResourceBoundaryDiagnostic;
}

/** How much of the resource guard was actually active for a run. */
export type LlamaCalibrationResourceMonitoringCoverage = 'complete' | 'partial' | 'unavailable';

/**
 * One metric's fixed baseline for the whole run.
 *
 * There is exactly one of these per metric per `calibrate()` call: calibration never re-anchors, so
 * every boundary reading in the report is comparable against this single value.
 */
export interface LlamaCalibrationResourceMetricMonitoring {
  metric: LlamaCalibrationResourceMetric;
  /** False when too few trusted baseline samples existed; such a metric guards nothing. */
  enabled: boolean;
  /** Median of `trustedSamples`; finite and positive, and present only when `enabled`. */
  baselineBytes?: number;
  decreaseThresholdPct: number;
  increaseThresholdPct: number;
  /** Bounded baseline snapshot attempts inspected. Never extended by retries. */
  attempts: number;
  /** Trusted baseline sample values in capture order; may be shorter than `attempts`. */
  trustedSamples: readonly number[];
}

/** Run-level resource-guard coverage and the fixed baselines every boundary was compared against. */
export interface LlamaCalibrationResourceMonitoring {
  coverage: LlamaCalibrationResourceMonitoringCoverage;
  /** Metrics guarded for the whole run, in canonical order. */
  enabledMetrics: readonly LlamaCalibrationResourceMetric[];
  /** One entry per metric, in canonical order, including disabled ones. */
  metrics: readonly LlamaCalibrationResourceMetricMonitoring[];
}

/**
 * The single source of truth for a resource-stability rejection.
 *
 * `probeIndex` is absent for a pre-launch failure, which by construction has no probe.
 */
export interface LlamaCalibrationResourceFailure {
  boundary: LlamaCalibrationResourceBoundaryKind;
  affectedMetrics: readonly LlamaCalibrationResourceMetric[];
  /** Band crossed per affected metric; absent for a metric affected only by lost telemetry. */
  affectedDirections: Readonly<
    Partial<Record<LlamaCalibrationResourceMetric, LlamaCalibrationResourceChangeDirection>>
  >;
  probeIndex?: number;
  diagnostics: LlamaCalibrationResourceBoundaryDiagnostic;
}

/** Strength of the directly measured evidence behind an adaptive recommendation. */
export type LlamaAdaptiveCalibrationSelectionEvidence =
  | 'independent-reproduction'
  | 'single-full-launch'
  | 'single-search-launch';

/** Whether an observation may be used for any decision. */
export type LlamaCalibrationProbeResourceValidity =
  | 'accepted'
  | 'invalidated-by-resource-stability';

/**
 * Passive per-probe estimates.
 *
 * Machine-resource readings are NOT here: they live in the probe's `resourceBoundaries`, compared
 * against the run's single fixed baseline in report-level `resourceMonitoring`.
 */
export interface LlamaCalibrationPassiveDiagnostics {
  /** Full-attention upper-bound-style estimate; not SWA-correct for windowed models. */
  kvBytesEstimate?: number;
  modelBytes?: number;
  expertWeightBytes?: number;
  warnings: readonly string[];
}

/** A chronological fresh-launch observation shared by both strategies. */
export interface LlamaCalibrationProbe {
  probeIndex: number;
  strategy: 'adaptive' | 'exact';
  purpose: LlamaCalibrationProbePurpose;
  fidelity: LlamaCalibrationProbeFidelity;
  independentLaunchIndex: number;
  profileIndex: number;
  profileOrdinal: number;
  cellId?: string;
  comboIndex?: number;
  combo?: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  argvKey: string;
  operationalStatus: LlamaCalibrationOperationalStatus;
  memoryEvidence: LlamaCalibrationMemoryEvidence;
  boundaryDecision: LlamaCalibrationBoundaryDecision;
  /**
   * Whether this observation is usable for any decision.
   *
   * `invalidated-by-resource-stability` probes stay in the chronological trail for auditing but
   * never reach adaptive classification, exact ranking, selection, fallback, or the diagnostic
   * candidate. `accepted` means only that the resource-stability guard did not invalidate this
   * observation - including records the guard never evaluated at all, because a launch interrupted
   * by the internal probe deadline or by a caller abort produces a synthetic record with no
   * post-cleanup boundary. So `accepted` is not evidence that the machine was checked, and a probe
   * can still be `accepted` and carry its own operational failure; read `resourceBoundaries` to see
   * which sides were actually evaluated.
   */
  resourceValidity: LlamaCalibrationProbeResourceValidity;
  /**
   * The guarded boundaries around this launch, compared against the run's fixed baseline.
   *
   * Absent sides mean that boundary was never evaluated: resource monitoring was unavailable for
   * the run, the launch ended before it (an unconfirmed teardown, a caller abort), or the launch was
   * interrupted by the internal probe deadline.
   */
  resourceBoundaries?: LlamaCalibrationProbeResourceBoundaries;
  loadTimeMs?: number;
  effectiveContextSize?: number;
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  aggregateLowerBoundMs?: number;
  durationMs: number;
  capped?: boolean;
  terminationReason?: string;
  diagnostics?: LlamaCalibrationPassiveDiagnostics;
  error?: string;
  stderrTail?: string;
  cleanup: LlamaCalibrationCleanupRecord;
}

/** Legacy-shaped exact launch record retained as a useful public data type. */
export interface LlamaCalibrationRun {
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  status: LlamaCalibrationStatus;
  loadTimeMs?: number;
  effectiveContextSize?: number;
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  error?: string;
  stderrTail?: string;
}

export interface LlamaCalibrationRecommendation {
  combo?: LlamaCalibrationCombo;
  profileIndex?: number;
  cellId?: string;
  startConfig: ResolvedLlamaCalibrationConfig;
  scoreMs: number;
}

export type LlamaCalibrationFallback =
  | (LlamaCalibrationRecommendation & { evidence: 'direct-measurement' })
  | {
      profileIndex: number;
      cellId: string;
      startConfig: ResolvedLlamaCalibrationConfig;
      evidence: 'unvalidated-option';
      scoreMs?: never;
    };

export interface LlamaCalibrationWorkloadSignature {
  id: string;
  kind: LlamaCalibrationWorkload['kind'];
  weight: number;
  hash: string;
  requestCount: number;
  nPredict: number;
  /** Observed token counts for the cold prompt or each prefix+suffix request. */
  promptTokenCounts?: readonly number[];
}

export interface LlamaCalibrationModelIdentity {
  id: string;
  name: string;
  architecture?: string;
  size: number;
  checksum?: string;
  sourceRevision?: string;
  files: readonly {
    name: string;
    size: number;
    checksum?: string;
    sourceRevision?: string;
  }[];
}

export interface LlamaCalibrationBinaryIdentity {
  version: string;
  variant: string;
  checksum?: string;
}

export interface LlamaCalibrationMachineIdentity {
  platform: NodeJS.Platform;
  architecture: string;
  osRelease: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  /** Diagnostic snapshot; never enters scoring. */
  availableMemoryBytes?: number;
  gpu: readonly {
    name: string;
    vendor: string;
    memoryBytes?: number;
    driverVersion?: string;
    /** Diagnostic snapshot; never enters scoring. */
    availableMemoryBytes?: number;
  }[];
}

export interface LlamaCalibrationVerifiedProfile {
  effectiveContextSize: number;
  effectiveParallelRequests: number;
}

export interface LlamaAdaptiveCalibrationProfileReport {
  profileIndex: number;
  profileOrdinal: number;
  profile: LlamaCalibrationProfile;
  state: 'unstarted' | 'tested' | 'resolved' | 'unresolved' | 'no-viable-point';
  verified?: LlamaCalibrationVerifiedProfile;
  bestCellId?: string;
  warnings: readonly string[];
}

export interface LlamaAdaptiveCalibrationCellReport {
  cellId: string;
  profileIndex: number;
  profileOrdinal: number;
  structuralOrder: number;
  resolvedConfig: Omit<ResolvedLlamaCalibrationConfig, 'gpuLayers'>;
  state:
    | 'pending'
    | 'finding-reference'
    | 'establishing-ceiling'
    | 'bisecting'
    | 'finalist'
    | 'resolved'
    | 'unresolved'
    | 'no-viable-point';
  referenceGpuLayers?: number;
  lowGpuLayers?: number;
  highGpuLayers?: number;
  provisionalBoundaryGpuLayers?: number;
  finalistGpuLayers?: number;
  inheritedCeiling?: { gpuLayers: number; sourceCellId: string; reason: string };
  nonMonotoneWarning?: boolean;
  unmeasuredGaps?: readonly number[];
  warnings: readonly string[];
}

export interface LlamaAdaptiveCalibrationBudgetReport {
  maxWallTimeMs: number;
  /** Method entry through completion/restoration of all library-owned work. */
  elapsedMs: number;
  /** `max(0, elapsedMs - maxWallTimeMs)`. */
  overrunMs: number;
  /** Optional expert/test cap. Omission means no count-based limit. */
  maxProbes?: number;
}

/**
 * How the fixed-baseline resource guard was operated, as protocol facts only.
 *
 * Numeric baselines and bands are deliberately absent: they belong to `resourceMonitoring`, which
 * is the single source of truth for what each metric was compared against.
 */
export interface LlamaCalibrationResourceStabilityMethodology {
  /** Fixed delay after preparation, before the bounded baseline snapshots. Never condition-driven. */
  baselineSettleMs: number;
  /** Bounded baseline snapshot attempts. Never extended by retries. */
  baselineSamples: number;
  /** Trusted values a metric needs before it is guarded at all. */
  minTrustedBaselineSamples: number;
  /** Whole-boundary confirmation snapshots taken for a suspicious trusted reading. */
  confirmationReads: number;
  /** Per-command wall-clock bound for each platform telemetry read. */
  telemetryTimeoutMs: number;
  /** Both directions are guarded, each by its own independent per-metric band. */
  guardedDirections: readonly LlamaCalibrationResourceChangeDirection[];
  /** Both launch sides are guarded; `post-cleanup` only once teardown is confirmed. */
  guardedBoundaries: readonly LlamaCalibrationResourceBoundaryKind[];
  /** A change exactly equal to a band is suspicious and must be confirmed. */
  thresholdComparison: 'inclusive';
  /** States the sampling blind spot instead of promising continuous observation. */
  caveat: string;
}

export interface LlamaCalibrationMethodology {
  layerCount: number;
  layerCountSource: 'metadata' | 'fallback';
  samples: number;
  searchSamples: number;
  warmups: 1;
  seed: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  resourceCooldownMs: number;
  tieTolerancePct: number;
  grossRegressionMultiplier: number;
  stabilityTolerancePct: number;
  searchNoiseAllowancePct: number;
  nonMonotoneTriggerPct: number;
  includeKvCacheComparison: boolean;
  kvPrecisionPreferencePct: number;
  contextPreferencePct?: number;
  scoreUnit: 'scenario-median-wall-ms';
  resourceStability: LlamaCalibrationResourceStabilityMethodology;
}

interface LlamaCalibrationReportBase {
  resultKind: 'report';
  schemaVersion: 4;
  policyVersion: string;
  createdAt: string;
  status: LlamaCalibrationTerminalStatus;
  model: LlamaCalibrationModelIdentity;
  binary: LlamaCalibrationBinaryIdentity;
  machine: LlamaCalibrationMachineIdentity;
  cacheability: { level: 'stable' | 'best-effort'; reasons: readonly string[] };
  fixedConfig: LlamaCalibrationFixedConfig;
  workloads: readonly LlamaCalibrationWorkloadSignature[];
  methodology: LlamaCalibrationMethodology;
  /** The run's single fixed baseline per metric, and how much of the guard was active. */
  resourceMonitoring: LlamaCalibrationResourceMonitoring;
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
}

interface LlamaAdaptiveCalibrationReportFields extends LlamaCalibrationReportBase {
  strategy: 'adaptive';
  status: LlamaAdaptiveCalibrationTerminalStatus;
  searchCompleteness: 'resolved' | 'partial';
  /** Human-readable explanation for the terminal controller decision. */
  terminalReason: string;
  profiles: readonly LlamaAdaptiveCalibrationProfileReport[];
  schedulingProfileIndexes: readonly number[];
  workloadComparability: 'verified' | 'unverified';
  cells: readonly LlamaAdaptiveCalibrationCellReport[];
  budget: LlamaAdaptiveCalibrationBudgetReport;
  globalFastestScoreMs?: number;
  contextBandMaxScoreMs?: number;
  kvBandMaxScoreMs?: number;
  contextPreferenceResolution: 'single-profile' | 'largest-in-band' | 'fastest-only' | 'unresolved';
  kvPrecisionPreferenceResolution:
    | 'disabled'
    | 'largest-in-joint-band'
    | 'fallback-no-joint-eligible'
    | 'unresolved';
  fallback?: LlamaCalibrationFallback;
  pinnedMoePlacement: true;
}

type LlamaAdaptiveSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: LlamaAdaptiveCalibrationSelectionEvidence;
    }
  | { selected?: never; selectionEvidence?: never };

export type LlamaAdaptiveCalibrationReport = LlamaAdaptiveCalibrationReportFields &
  LlamaAdaptiveSelection;

interface LlamaExactCalibrationReportFields extends LlamaCalibrationReportBase {
  strategy: 'exact';
  status: Extract<LlamaExactCalibrationTerminalStatus, 'complete' | 'no-viable-candidate'>;
  profile: LlamaCalibrationProfile;
  verifiedProfile?: LlamaCalibrationVerifiedProfile;
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
  runs: readonly LlamaCalibrationRun[];
  confidence: 'single-launch-measurement';
}

type LlamaExactSelection =
  | {
      selected: LlamaCalibrationRecommendation;
      selectionEvidence: 'single-launch-measurement';
    }
  | { selected?: never; selectionEvidence?: never };

export type LlamaExactCalibrationReport = LlamaExactCalibrationReportFields & LlamaExactSelection;

/** Adaptive time limit reached before ordinary report identity and the fixed baseline existed. */
export interface LlamaAdaptiveCalibrationPreparationTimeLimit {
  resultKind: 'preparation-time-limit';
  schemaVersion: 4;
  policyVersion: 'llama-runtime-v4';
  createdAt: string;
  strategy: 'adaptive';
  phase: 'preparing';
  status: 'time-limited';
  searchCompleteness: 'partial';
  terminalReason: string;
  budget: LlamaAdaptiveCalibrationBudgetReport;
  probes: readonly [];
  warnings: readonly string[];
  cleanupConfirmed: true;
  selected?: never;
  selectionEvidence?: never;
}

export type LlamaCalibrationReport =
  | LlamaAdaptiveCalibrationReport
  | LlamaExactCalibrationReport
  | LlamaAdaptiveCalibrationPreparationTimeLimit;

/** Partial report attached to aborted/failed calibration errors. */
export interface LlamaCalibrationPartialReport {
  schemaVersion: 4;
  policyVersion: string;
  strategy: 'adaptive' | 'exact';
  status: Extract<LlamaCalibrationTerminalStatus, 'aborted' | 'failed'>;
  createdAt: string;
  /** Absent only when the run failed before its fixed baseline was established. */
  resourceMonitoring?: LlamaCalibrationResourceMonitoring;
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
  cleanupConfirmed: boolean;
}

type NonEmptyProbeIndexes = readonly [number, ...number[]];

/** Start-ready adaptive recommendation supported only by clean pre-failure evidence. */
export interface LlamaAdaptiveCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: LlamaAdaptiveCalibrationSelectionEvidence;
  sourceProbeIndexes: NonEmptyProbeIndexes;
}

/** Start-ready exact recommendation supported only by clean pre-failure evidence. */
export interface LlamaExactCalibrationBestKnown {
  recommendation: LlamaCalibrationRecommendation;
  evidence: 'single-launch-measurement';
  sourceProbeIndexes: NonEmptyProbeIndexes;
}

/** Partial report attached specifically to a typed resource-stability rejection. */
export type LlamaCalibrationResourceFailurePartialReport =
  | (Omit<LlamaCalibrationPartialReport, 'strategy' | 'status' | 'cleanupConfirmed'> & {
      strategy: 'adaptive';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness: 'partial';
      budget: LlamaAdaptiveCalibrationBudgetReport;
      bestKnown?: LlamaAdaptiveCalibrationBestKnown;
    })
  | (Omit<LlamaCalibrationPartialReport, 'strategy' | 'status' | 'cleanupConfirmed'> & {
      strategy: 'exact';
      status: 'failed';
      cleanupConfirmed: true;
      resourceMonitoring: LlamaCalibrationResourceMonitoring;
      resourceFailure: LlamaCalibrationResourceFailure;
      searchCompleteness?: never;
      bestKnown?: LlamaExactCalibrationBestKnown;
    });
