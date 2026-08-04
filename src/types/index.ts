/**
 * Type definitions for genai-electron
 * @module types
 */

// System types
export type {
  GPUInfo,
  CPUInfo,
  MemoryInfo,
  MemoryTelemetryRefreshStatus,
  TelemetryCommandOptions,
  SystemCapabilities,
  SystemRecommendations,
} from './system.js';

// Model types
export type {
  ModelType,
  ModelInfo,
  ModelSource,
  ArtifactProvenance,
  DownloadConfig,
  DownloadProgress,
  DownloadProgressCallback,
  GGUFMetadata,
  MetadataFetchStrategy,
  DiffusionComponentRole,
  DiffusionComponentInfo,
  DiffusionModelComponents,
  DiffusionComponentDownload,
  ShardInfo,
} from './models.js';

// Server types
export type {
  ServerStatus,
  HealthStatus,
  KVCacheType,
  FlashAttentionSetting,
  ServerConfig,
  ServerInfo,
  LlamaServerReadyState,
  LlamaServerConfig,
  ServerEvent,
  ServerEventData,
  BinaryLogEvent,
  BinaryProgressEvent,
  OptimalConfigHints,
} from './servers.js';

// LLM runtime-calibration types
export type {
  LlamaCalibrationProfile,
  LlamaCalibrationOverrides,
  LlamaCalibrationFixedConfig,
  LlamaCalibrationCombo,
  LlamaColdPrefillWorkload,
  LlamaSharedPrefixWorkload,
  LlamaCalibrationWorkload,
  LlamaCalibrationOperationalStatus,
  LlamaCalibrationProbePurpose,
  LlamaAdaptiveCalibrationProbePurpose,
  LlamaCalibrationProbeFidelity,
  LlamaCalibrationProbePhase,
  LlamaAdaptiveCalibrationPhase,
  LlamaExactCalibrationPhase,
  LlamaCalibrationPhase,
  LlamaCalibrationTerminalStatus,
  LlamaExactCalibrationTerminalStatus,
  LlamaAdaptiveProgressBudget,
  LlamaAdaptiveActiveProbe,
  LlamaExactProgressCandidates,
  LlamaExactActiveCandidate,
  LlamaCalibrationProgress,
  LlamaAdaptiveCalibrationConfig,
  LlamaExactCalibrationConfig,
  LlamaCalibrationConfig,
  LlamaCalibrationStatus,
  LlamaCalibrationRequestTiming,
  LlamaCalibrationSample,
  LlamaCalibrationWorkloadResult,
  LlamaCalibrationMemoryEvidence,
  LlamaCalibrationBoundaryDecision,
  LlamaCalibrationCleanupRecord,
  LlamaCalibrationResourceMetric,
  LlamaCalibrationResourceChangeDirection,
  LlamaCalibrationResourceBoundaryKind,
  LlamaCalibrationResourceUntrustedReason,
  LlamaCalibrationResourceReading,
  LlamaCalibrationResourceSnapshotDiagnostic,
  LlamaCalibrationResourceBoundaryDiagnostic,
  LlamaCalibrationProbeResourceBoundaries,
  LlamaCalibrationResourceMonitoringCoverage,
  LlamaCalibrationResourceMetricMonitoring,
  LlamaCalibrationResourceMonitoring,
  LlamaCalibrationResourceFailure,
  LlamaAdaptiveCalibrationSelectionEvidence,
  LlamaCalibrationProbeResourceValidity,
  LlamaCalibrationPassiveDiagnostics,
  LlamaCalibrationProbe,
  ResolvedLlamaCalibrationConfig,
  LlamaCalibrationRun,
  LlamaCalibrationRecommendation,
  LlamaCalibrationFallback,
  LlamaCalibrationWorkloadSignature,
  LlamaCalibrationModelIdentity,
  LlamaCalibrationBinaryIdentity,
  LlamaCalibrationMachineIdentity,
  LlamaCalibrationVerifiedProfile,
  LlamaAdaptiveCalibrationProfileReport,
  LlamaAdaptiveCalibrationCellReport,
  LlamaAdaptiveCalibrationBudgetReport,
  LlamaCalibrationResourceStabilityMethodology,
  LlamaCalibrationMethodology,
  LlamaAdaptiveCalibrationReport,
  LlamaExactCalibrationReport,
  LlamaAdaptiveCalibrationPreparationTimeLimit,
  LlamaCalibrationReport,
  LlamaCalibrationPartialReport,
  LlamaAdaptiveCalibrationBestKnown,
  LlamaExactCalibrationBestKnown,
  LlamaCalibrationResourceFailurePartialReport,
} from './llm-calibration.js';

// Image generation types
export type {
  ImageSampler,
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageGenerationProgress,
  ImageGenerationStage,
  DiffusionServerConfig,
  DiffusionServerInfo,
  GenerationStatus,
  GenerationState,
  DiffusionOffloadCombo,
  CalibrationSize,
  DiffusionCalibrationGeneration,
  DiffusionCalibrationConfig,
  DiffusionCalibrationProgress,
  CalibrationRun,
  DiffusionCalibrationReport,
} from './images.js';

/**
 * Utility type to make all properties of T optional
 */
export type Optional<T> = {
  [K in keyof T]?: T[K];
};

/**
 * Utility type to extract required keys from T
 */
export type RequiredKeys<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Utility type to extract optional keys from T
 */
export type OptionalKeys<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * Utility type for JSON-serializable values
 */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/**
 * Utility type for async functions
 */
export type AsyncFunction<T = void> = () => Promise<T>;

/**
 * Utility type for cleanup functions
 */
export type CleanupFunction = () => void | Promise<void>;
