/**
 * LLM runtime-calibration types.
 *
 * A calibration call benchmarks one exact total context allocation and slot
 * count. Consumers can compare profiles by running independent calibrations.
 *
 * @module types/llm-calibration
 */

import type { LlamaServerConfig } from './servers.js';

/** Capacity profile held constant throughout one calibration sweep. */
export interface LlamaCalibrationProfile {
  /** Exact total llama-server `-c` allocation across all slots. */
  contextSize: number;
  /** Exact llama-server `-np` slot count. */
  parallelRequests: number;
}

/** Launch fields that a caller-provided candidate may vary in v1. */
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

/** Launch fields inherited identically by every candidate in a sweep. */
export type LlamaCalibrationFixedConfig = LlamaCalibrationOverrides &
  Partial<Pick<LlamaServerConfig, 'continuousBatching' | 'useMmap' | 'useMlock'>>;

/** One exact candidate to benchmark. */
export interface LlamaCalibrationCombo {
  /** Stable label used in progress and reports. */
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

export type LlamaCalibrationPhase =
  | 'preparing'
  | 'starting'
  | 'warmup'
  | 'sampling'
  | 'stopping'
  | 'done';

/** Monotonic progress payload delivered by callback and EventEmitter. */
export interface LlamaCalibrationProgress {
  overallPercent: number;
  phase: LlamaCalibrationPhase;
  comboIndex: number;
  comboCount: number;
  combo?: LlamaCalibrationCombo;
  workloadIndex?: number;
  workloadCount: number;
  sampleIndex?: number;
  sampleCount: number;
}

/** Configuration for {@link LlamaServerManager.calibrate}. */
export interface LlamaCalibrationConfig {
  modelId: string;
  profile: LlamaCalibrationProfile;
  /** Pinned values inherited by every combo and excluded from variation. */
  fixedConfig?: LlamaCalibrationFixedConfig;
  /** Required production scenario mix. Raw prompts are omitted from reports. */
  workloads: readonly LlamaCalibrationWorkload[];
  /** Exact custom candidates. When present, generated defaults are not used. */
  combos?: readonly LlamaCalibrationCombo[];
  /** Add one bounded f16/q8 comparison to generated defaults. Default: false. */
  includeKvCacheComparison?: boolean;
  /** Prefer a larger KV element footprint within this slowdown. Default: 10. */
  kvPrecisionPreferencePct?: number;
  /** Timed repetitions per workload. Default: 3. */
  samples?: number;
  /** Deterministic completion seed. Default: 42. */
  seed?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onProgress?: (progress: LlamaCalibrationProgress) => void;
  signal?: AbortSignal;
}

export type LlamaCalibrationStatus =
  | 'ok'
  | 'oom'
  | 'startup-timeout'
  | 'request-timeout'
  | 'crashed'
  | 'error';

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

/** Start-ready measured fields returned for each candidate. */
export type ResolvedLlamaCalibrationConfig = LlamaCalibrationProfile &
  LlamaCalibrationFixedConfig &
  LlamaCalibrationOverrides;

export interface LlamaCalibrationRun {
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  status: LlamaCalibrationStatus;
  loadTimeMs?: number;
  /** Effective per-slot context reported by llama-server. */
  effectiveContextSize?: number;
  effectiveParallelRequests?: number;
  workloadResults: readonly LlamaCalibrationWorkloadResult[];
  scoreMs?: number;
  error?: string;
  stderrTail?: string;
}

export interface LlamaCalibrationRecommendation {
  combo: LlamaCalibrationCombo;
  /** Includes the exact profile and inherited fixed values. */
  startConfig: ResolvedLlamaCalibrationConfig;
  scoreMs: number;
}

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

export interface LlamaCalibrationReport {
  schemaVersion: 1;
  policyVersion: string;
  createdAt: string;
  model: LlamaCalibrationModelIdentity;
  binary: LlamaCalibrationBinaryIdentity;
  machine: LlamaCalibrationMachineIdentity;
  cacheability: { level: 'stable' | 'best-effort'; reasons: readonly string[] };
  profile: LlamaCalibrationProfile;
  fixedConfig: LlamaCalibrationFixedConfig;
  verifiedProfile?: {
    effectiveContextSize: number;
    effectiveParallelRequests: number;
  };
  workloads: readonly LlamaCalibrationWorkloadSignature[];
  methodology: {
    samples: number;
    warmups: 1;
    seed: number;
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    resourceCooldownMs: number;
    tieTolerancePct: number;
    includeKvCacheComparison: boolean;
    kvPrecisionPreferencePct: number;
    scoreUnit: 'scenario-median-wall-ms';
  };
  comboSource: 'default' | 'custom';
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
  runs: readonly LlamaCalibrationRun[];
  recommended?: LlamaCalibrationRecommendation;
}
