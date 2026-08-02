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

export type LlamaCalibrationTerminalStatus =
  | 'complete'
  | 'budget-exhausted'
  | 'no-viable-candidate'
  | 'aborted'
  | 'failed';

export type LlamaExactCalibrationTerminalStatus = Exclude<
  LlamaCalibrationTerminalStatus,
  'budget-exhausted'
>;

export type LlamaAdaptiveProgressBudget =
  | { resolved: false }
  | {
      resolved: true;
      targetProbes: number;
      maxProbes: number;
      finalistReserve: number;
      maxWallTimeMs: number;
      finalistTimeReserveMs: number;
      remainingWallTimeMs: number;
      probeReserveActive: boolean;
      timeReserveActive: boolean;
    };

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
  targetProbes?: number;
  maxProbes?: number;
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
  targetProbes?: never;
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

export interface LlamaCalibrationResourceMetricDiagnostic {
  beforeBytes?: number;
  afterBytes?: number;
  comparability: 'available' | 'material' | 'unavailable';
  decreasePct?: number;
}

export interface LlamaCalibrationPassiveDiagnostics {
  /** Full-attention upper-bound-style estimate; not SWA-correct for windowed models. */
  kvBytesEstimate?: number;
  modelBytes?: number;
  expertWeightBytes?: number;
  hostAvailableMemory: LlamaCalibrationResourceMetricDiagnostic;
  gpuAvailableMemory: LlamaCalibrationResourceMetricDiagnostic;
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
   * Settled resource level this adaptive launch was measured under. Starts at 0
   * and increments when a confirmed step change in available memory re-anchors
   * the reference. A selected configuration's independent launches always share
   * one regime, so probes from different regimes never reproduce each other.
   * Absent in exact mode, which does not search or re-anchor.
   */
  resourceRegime?: number;
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

export interface LlamaCalibrationBudgetReport {
  formulaVersion: string;
  cellCount: number;
  targetProbes: number;
  maxProbes: number;
  finalistReserve: number;
  maxWallTimeMs: number;
  finalistTimeReserveMs: number;
  effectiveFinalistTimeReserveMs: number;
  completedProbes: number;
  elapsedMs: number;
  cleanupOverrunMs: number;
  overrides: readonly ('targetProbes' | 'maxProbes' | 'maxWallTimeMs')[];
  timeAdmission: {
    policy: 'configured-conservative-estimate' | 'observed-comparable-launches';
    estimatedNextProbeDurationMs?: number;
    plannedPostStartupRequestCount?: number;
    maxRunnerStartAttempts: number;
    startupTimeoutMs: number;
    resolvedCapacityCheckTimeoutMs: number;
    configuredAttemptTeardownMs: number;
    caveat: string;
  };
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
}

interface LlamaCalibrationReportBase {
  schemaVersion: 2;
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
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
}

export interface LlamaAdaptiveCalibrationReport extends LlamaCalibrationReportBase {
  strategy: 'adaptive';
  status: Extract<
    LlamaCalibrationTerminalStatus,
    'complete' | 'budget-exhausted' | 'no-viable-candidate'
  >;
  /** Human-readable explanation for the terminal controller decision. */
  terminalReason: string;
  profiles: readonly LlamaAdaptiveCalibrationProfileReport[];
  schedulingProfileIndexes: readonly number[];
  workloadComparability: 'verified' | 'unverified';
  cells: readonly LlamaAdaptiveCalibrationCellReport[];
  budget: LlamaCalibrationBudgetReport;
  globalFastestScoreMs?: number;
  contextBandMaxScoreMs?: number;
  kvBandMaxScoreMs?: number;
  contextPreferenceResolution: 'single-profile' | 'largest-in-band' | 'fastest-only' | 'unresolved';
  kvPrecisionPreferenceResolution:
    | 'disabled'
    | 'largest-in-joint-band'
    | 'fallback-no-joint-eligible'
    | 'unresolved';
  selected?: LlamaCalibrationRecommendation;
  provisional?: LlamaCalibrationRecommendation;
  fallback?: LlamaCalibrationFallback;
  selectionEvidence?: 'independent-reproduction';
  confidence: 'empirical-reproducibility';
  pinnedMoePlacement: true;
}

export interface LlamaExactCalibrationReport extends LlamaCalibrationReportBase {
  strategy: 'exact';
  status: Extract<LlamaExactCalibrationTerminalStatus, 'complete' | 'no-viable-candidate'>;
  profile: LlamaCalibrationProfile;
  verifiedProfile?: LlamaCalibrationVerifiedProfile;
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
  runs: readonly LlamaCalibrationRun[];
  selected?: LlamaCalibrationRecommendation;
  selectionEvidence?: 'single-launch-measurement';
  confidence: 'single-launch-measurement';
}

export type LlamaCalibrationReport = LlamaAdaptiveCalibrationReport | LlamaExactCalibrationReport;

/** Partial report attached to aborted/failed calibration errors. */
export interface LlamaCalibrationPartialReport {
  schemaVersion: 2;
  policyVersion: string;
  strategy: 'adaptive' | 'exact';
  status: Extract<LlamaCalibrationTerminalStatus, 'aborted' | 'failed'>;
  createdAt: string;
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
  cleanupConfirmed: boolean;
}
