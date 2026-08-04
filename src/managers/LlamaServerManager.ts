/**
 * LlamaServerManager - Manages llama-server lifecycle
 *
 * Handles downloading binaries, starting/stopping llama-server processes,
 * health checking, and log management.
 *
 * @module managers/LlamaServerManager
 */

import { ServerManager } from './ServerManager.js';
import os from 'node:os';
import path from 'node:path';
import { ModelManager } from './ModelManager.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { ProcessManager } from '../process/ProcessManager.js';
import { checkHealth, waitForHealthy, normalizeHealthHost } from '../process/health-check.js';
import { findFreePort } from '../process/port-utils.js';
import { fetchLlamaRuntimeCapacity } from '../process/llama-props.js';
import {
  createCalibrationPromptRedactor,
  redactCalibrationError,
  runCalibrationProbe,
  type RunCalibrationProbeObservation,
  type RunCalibrationProbeOptions,
} from '../process/llama-calibration-probe.js';
import {
  buildLlamaServerArgs,
  normalizeLlamaVCacheConfig,
  type ResolvedLlamaServerConfig,
} from '../process/llama-server-args.js';
import { parseLlamaCppLogLevel, stripLlamaCppFormatting } from '../process/llama-log-parser.js';
import type {
  ServerConfig,
  ServerInfo,
  LlamaServerReadyState,
  LlamaServerConfig,
  HealthStatus,
  LlamaCalibrationCombo,
  LlamaCalibrationConfig,
  LlamaAdaptiveActiveProbe,
  LlamaAdaptiveCalibrationBestKnown,
  LlamaAdaptiveCalibrationBudgetReport,
  LlamaAdaptiveCalibrationReport,
  LlamaAdaptiveProgressBudget,
  LlamaCalibrationProgress,
  LlamaCalibrationProbe,
  LlamaCalibrationRecommendation,
  LlamaCalibrationReport,
  LlamaCalibrationProbeResourceBoundaries,
  LlamaCalibrationResourceBoundaryDiagnostic,
  LlamaCalibrationResourceFailure,
  LlamaCalibrationResourceFailurePartialReport,
  LlamaCalibrationResourceMetric,
  LlamaCalibrationResourceMonitoring,
  LlamaCalibrationResourceSnapshotDiagnostic,
  LlamaCalibrationResourceStabilityMethodology,
  LlamaCalibrationRun,
  LlamaCalibrationTerminalStatus,
  LlamaExactCalibrationBestKnown,
  LlamaExactCalibrationReport,
  ResolvedLlamaCalibrationConfig,
} from '../types/index.js';
import {
  ContextConstraintError,
  LlamaCalibrationResourceStabilityError,
  ServerError,
  InsufficientResourcesError,
} from '../errors/index.js';
import type { LlamaCalibrationResourceStabilityCode } from '../errors/index.js';
import {
  BINARY_VERSIONS,
  DEFAULT_PORTS,
  DEFAULT_TIMEOUTS,
  LLAMA_CALIBRATION_DEFAULTS,
  resolveLlamaCalibrationTimeBudget,
} from '../config/defaults.js';
import { fileExists } from '../utils/file-utils.js';
import { debugLog } from '../utils/debug-log.js';
import { getInstalledBinaryIdentity } from '../utils/binary-identity.js';
import {
  extractLlamaCalibrationOverrides,
  recommendLlamaCalibrationRun,
  resolveLlamaCalibrationConfig,
  validateLlamaCalibrationConfig,
  workloadSignature,
  type ValidatedLlamaAdaptiveCalibrationConfig,
} from '../utils/llama-calibration.js';
import {
  applyAdaptivePolicyObservation,
  classifyAdaptiveObservation,
  createAdaptivePolicyState,
  deriveAdaptiveLimitTerminal,
  deriveAdaptiveIncumbent,
  deriveCeilingHints,
  nextAdaptivePolicyAction,
  summarizeAdaptiveCellStates,
  type AdaptiveCandidate,
  type AdaptiveCell,
  type AdaptivePolicyState,
  type AdaptiveProbeAction,
  type AdaptiveTerminalAction,
} from '../utils/llama-adaptive-calibration-policy.js';
import {
  abortableDelay,
  checkBoundary,
  collectBaseline,
  createTelemetrySnapshotCapture,
  type ResourceGuardDependencies,
} from '../utils/llama-resource-guard-capture.js';
import { MIN_TRUSTED_BASELINE_SAMPLES, RESOURCE_METRICS } from '../utils/llama-resource-guard.js';
import type {
  ResourceBaseline,
  ResourceBoundaryKind,
  ResourceBoundaryResult,
  ResourceSnapshotEvaluation,
  ResourceStabilityThresholds,
} from '../utils/llama-resource-guard.js';
import { getLayerCountWithFallback, getSlidingWindow } from '../utils/model-metadata-helpers.js';
import { estimateKVBytesPerToken } from '../utils/kv-cache-math.js';
import {
  normalizeContextConstraints,
  validateModelContextRange,
} from '../utils/context-constraints.js';

function calibrationErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ServerError) || typeof error.details !== 'object' || !error.details) {
    return undefined;
  }
  const code = (error.details as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function calibrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function calibrationErrorDetail(error: unknown, key: string): unknown {
  if (!(error instanceof ServerError) || typeof error.details !== 'object' || !error.details) {
    return undefined;
  }
  return (error.details as Record<string, unknown>)[key];
}

function calibrationDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Schedule a deadline without overflowing Node's signed 32-bit timer delay. */
function scheduleCalibrationDeadline(controller: AbortController, deadlineAt: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      controller.abort(new DOMException('Calibration deadline', 'TimeoutError'));
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, 2_147_483_647));
  };
  arm();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function adaptiveProgressBudget(
  maxWallTimeMs: number,
  remainingMs: number,
  maxProbes: number | undefined,
  launchedProbes: number
): LlamaAdaptiveProgressBudget {
  if (maxProbes === undefined) return { maxWallTimeMs, remainingMs };
  return {
    maxWallTimeMs,
    remainingMs,
    maxProbes,
    remainingProbes: Math.max(0, maxProbes - launchedProbes),
  };
}

/**
 * The shipped resource bands, in one place so adaptive and exact calibration cannot diverge.
 *
 * These are policy constants, not caller-configurable calibration fields.
 */
const CALIBRATION_RESOURCE_THRESHOLDS: ResourceStabilityThresholds = {
  hostMemoryDecreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct,
  vramDecreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
  hostMemoryIncreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct,
  vramIncreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
};

const CALIBRATION_RESOURCE_SUGGESTION =
  'Close other memory- or GPU-intensive applications, then run calibration again from the beginning. Calibration uses one fixed baseline, so a disturbed run cannot be resumed safely.';

/**
 * Protocol facts about how the guard was operated.
 *
 * Deliberately free of baselines and band values: those are observations and policy constants that
 * `resourceMonitoring` already reports per metric, and duplicating them here would create a second
 * source of truth that could disagree with the readings a probe was actually judged against.
 */
const CALIBRATION_RESOURCE_STABILITY_METHODOLOGY: LlamaCalibrationResourceStabilityMethodology = {
  baselineSettleMs: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs,
  baselineSamples: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
  minTrustedBaselineSamples: MIN_TRUSTED_BASELINE_SAMPLES,
  confirmationReads: LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads,
  telemetryTimeoutMs: LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs,
  guardedDirections: ['decrease', 'increase'],
  guardedBoundaries: ['pre-launch', 'post-cleanup'],
  thresholdComparison: 'inclusive',
  caveat:
    'Every admitted observation started and ended within its bands around one fixed baseline; this is boundary sampling, not continuous observation, so pressure that begins and fully clears between the pre-launch and post-cleanup snapshots is not detectable.',
};

/**
 * Project the run's fixed baseline onto the public monitoring record.
 *
 * One per calibration call, shared by the report and by every partial report, so a host always
 * reads boundary percentages against exactly the baseline the guard compared them with.
 */
function resourceMonitoringRecord(baseline: ResourceBaseline): LlamaCalibrationResourceMonitoring {
  return {
    coverage: baseline.coverage,
    enabledMetrics: [...baseline.enabledMetrics],
    metrics: RESOURCE_METRICS.map((metric) => {
      const item = baseline.metrics[metric];
      return {
        metric,
        enabled: item.enabled,
        ...(item.baselineBytes !== undefined ? { baselineBytes: item.baselineBytes } : {}),
        decreaseThresholdPct:
          metric === 'hostMemory'
            ? LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct
            : LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
        increaseThresholdPct:
          metric === 'hostMemory'
            ? LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct
            : LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
        attempts: item.attempts,
        trustedSamples: [...item.trustedSamples],
      };
    }),
  };
}

/** Both guarded sides of one launch, omitting a side that was never evaluated. */
function probeResourceBoundaries(
  preLaunch?: ResourceBoundaryResult,
  postCleanup?: ResourceBoundaryResult
): LlamaCalibrationProbeResourceBoundaries | undefined {
  if (!preLaunch && !postCleanup) return undefined;
  return {
    ...(preLaunch ? { preLaunch: resourceBoundaryDiagnostic('pre-launch', preLaunch) } : {}),
    ...(postCleanup
      ? { postCleanup: resourceBoundaryDiagnostic('post-cleanup', postCleanup) }
      : {}),
  };
}

/** Map one evaluated snapshot onto the public diagnostics shape. */
function resourceSnapshotDiagnostic(
  evaluation: ResourceSnapshotEvaluation
): LlamaCalibrationResourceSnapshotDiagnostic {
  return {
    readings: RESOURCE_METRICS.map((metric) => {
      const item = evaluation.metrics[metric];
      return {
        metric: metric as LlamaCalibrationResourceMetric,
        enabled: item.enabled,
        trusted: item.trusted,
        ...(item.untrustedReason ? { untrustedReason: item.untrustedReason } : {}),
        ...(item.availableBytes !== undefined ? { availableBytes: item.availableBytes } : {}),
        ...(item.decreasePctFromBaseline !== undefined
          ? { decreasePctFromBaseline: item.decreasePctFromBaseline }
          : {}),
        ...(item.thresholdPct !== undefined ? { decreaseThresholdPct: item.thresholdPct } : {}),
        ...(item.increaseThresholdPct !== undefined
          ? { increaseThresholdPct: item.increaseThresholdPct }
          : {}),
        suspicious: item.suspicious,
        ...(item.suspiciousDirection ? { suspiciousDirection: item.suspiciousDirection } : {}),
      };
    }),
    suspiciousMetrics: [...evaluation.suspiciousMetrics],
    untrustedMetrics: [...evaluation.untrustedMetrics],
  };
}

function resourceBoundaryDiagnostic(
  boundary: ResourceBoundaryKind,
  result: ResourceBoundaryResult
): LlamaCalibrationResourceBoundaryDiagnostic {
  return {
    boundary,
    confirmationPerformed: result.confirmationPerformed,
    initial: resourceSnapshotDiagnostic(result.initial),
    ...(result.confirmation
      ? { confirmation: resourceSnapshotDiagnostic(result.confirmation) }
      : {}),
    initiallySuspiciousMetrics: [...result.initiallySuspiciousMetrics],
    warnings: [...result.warnings],
  };
}

/**
 * Build the one authoritative failure record for a rejected boundary.
 *
 * `probeIndex` is omitted for a pre-launch rejection, which by construction never launched.
 */
function resourceFailureRecord(
  boundary: ResourceBoundaryKind,
  result: ResourceBoundaryResult,
  probeIndex?: number
): LlamaCalibrationResourceFailure {
  return {
    boundary,
    affectedMetrics: [...result.affectedMetrics],
    affectedDirections: { ...result.affectedMetricDirections },
    ...(probeIndex !== undefined ? { probeIndex } : {}),
    diagnostics: resourceBoundaryDiagnostic(boundary, result),
  };
}

function resourceStabilityCode(
  result: ResourceBoundaryResult
): LlamaCalibrationResourceStabilityCode {
  return result.conclusion === 'confirmed-drift'
    ? 'CALIBRATION_RESOURCE_DRIFT'
    : 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED';
}

function resourceStabilityMessage(boundary: ResourceBoundaryKind, result: ResourceBoundaryResult) {
  const metrics = result.affectedMetrics
    .map((metric) => `${metric} (${result.affectedMetricDirections[metric] ?? 'unverifiable'})`)
    .join(', ');
  const where =
    boundary === 'pre-launch' ? 'before a calibration launch' : 'after a probe finished';
  return result.conclusion === 'confirmed-drift'
    ? `Machine resources changed materially ${where}: ${metrics}`
    : `Machine resource stability could not be verified ${where}: ${metrics}`;
}

/** Append guard/baseline warnings to a run's warning list without duplicating them. */
function mergeCalibrationWarnings(target: string[], incoming: readonly string[] = []): void {
  for (const warning of incoming) {
    if (!target.includes(warning)) target.push(warning);
  }
}

/**
 * Build the partial report attached to a resource-stability rejection.
 *
 * Shared by both strategies so the chronological trail, cleanup state, resource diagnostics, and
 * application-ready best-known evidence cannot diverge between them. Adaptive evidence may be a
 * clean single search/full launch or an independent reproduction; exact uses its single-clean-launch
 * rule. The caller supplies the already-derived strategy-specific value or nothing.
 */
type ResourceStabilityPartialReportOptions = {
  probes: readonly LlamaCalibrationProbe[];
  warnings: readonly string[];
  resourceMonitoring: LlamaCalibrationResourceMonitoring;
  resourceFailure: LlamaCalibrationResourceFailure;
} & (
  | {
      strategy: 'adaptive';
      budget: LlamaAdaptiveCalibrationBudgetReport;
      bestKnown?: LlamaAdaptiveCalibrationBestKnown;
    }
  | { strategy: 'exact'; bestKnown?: LlamaExactCalibrationBestKnown }
);

function resourceStabilityPartialReport(
  options: ResourceStabilityPartialReportOptions
): LlamaCalibrationResourceFailurePartialReport {
  const common = {
    schemaVersion: 4 as const,
    policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
    status: 'failed' as const,
    createdAt: new Date().toISOString(),
    resourceMonitoring: options.resourceMonitoring,
    probes: options.probes,
    warnings: options.warnings,
    // Cleanup precedence: an unconfirmed teardown rejects with its own code before any resource
    // classification happens, so a resource rejection always describes a confirmed-clean teardown.
    cleanupConfirmed: true as const,
    resourceFailure: options.resourceFailure,
  };
  if (options.strategy === 'adaptive') {
    return {
      ...common,
      strategy: 'adaptive',
      searchCompleteness: 'partial',
      budget: options.budget,
      ...(options.bestKnown ? { bestKnown: options.bestKnown } : {}),
    };
  }
  return {
    ...common,
    strategy: 'exact',
    ...(options.bestKnown ? { bestKnown: options.bestKnown } : {}),
  };
}

/**
 * Build the typed rejection for a boundary the guard refused to admit.
 *
 * `warnings` is the run's live warning list and is merged in place before the report is built, so
 * the attached partial report explains the boundary it rejects.
 */
type BuildResourceStabilityErrorOptions = {
  boundary: ResourceBoundaryKind;
  result: ResourceBoundaryResult;
  probeIndex?: number;
  probes: readonly LlamaCalibrationProbe[];
  warnings: string[];
  resourceMonitoring: LlamaCalibrationResourceMonitoring;
} & (
  | {
      strategy: 'adaptive';
      budget: LlamaAdaptiveCalibrationBudgetReport;
      bestKnown?: LlamaAdaptiveCalibrationBestKnown;
    }
  | { strategy: 'exact'; bestKnown?: LlamaExactCalibrationBestKnown }
);

function buildResourceStabilityError(
  options: BuildResourceStabilityErrorOptions
): LlamaCalibrationResourceStabilityError {
  const { boundary, result } = options;
  const resourceFailure = resourceFailureRecord(boundary, result, options.probeIndex);
  mergeCalibrationWarnings(options.warnings, result.warnings);
  return new LlamaCalibrationResourceStabilityError(resourceStabilityMessage(boundary, result), {
    code: resourceStabilityCode(result),
    suggestion: CALIBRATION_RESOURCE_SUGGESTION,
    partialReport: resourceStabilityPartialReport({
      probes: options.probes,
      warnings: options.warnings,
      resourceMonitoring: options.resourceMonitoring,
      resourceFailure,
      ...(options.strategy === 'adaptive'
        ? {
            strategy: 'adaptive' as const,
            budget: options.budget,
            ...(options.bestKnown ? { bestKnown: options.bestKnown } : {}),
          }
        : {
            strategy: 'exact' as const,
            ...(options.bestKnown ? { bestKnown: options.bestKnown } : {}),
          }),
    }),
  });
}

function minimumAggregateLowerBoundAtCap(
  workloads: ValidatedLlamaAdaptiveCalibrationConfig['workloads'],
  capMs: number
): number {
  if (workloads.length === 0) return 0;
  const totalWeight = workloads.reduce((total, workload) => total + workload.weight, 0);
  const minimumWeight = Math.min(...workloads.map((workload) => workload.weight));
  return (minimumWeight / totalWeight) * capMs;
}

function adaptiveProgressPhase(
  purpose: AdaptiveProbeAction['purpose']
): Exclude<LlamaCalibrationProgress, { strategy: 'exact' }>['phase'] {
  if (purpose === 'reference' || purpose === 'reference-guard') return 'finding-reference';
  if (purpose === 'ceiling') return 'establishing-ceiling';
  if (purpose === 'boundary' || purpose === 'ambiguity-repeat') return 'bisecting';
  if (purpose === 'finalist') return 'validating-finalist';
  if (purpose === 'winner-validation') return 'validating-winner';
  return 'validating-fallback';
}

/**
 * LlamaServerManager class
 *
 * Manages the lifecycle of llama-server processes.
 *
 * Features:
 * - Automatic binary download on first start
 * - Auto-configuration based on system capabilities
 * - Process monitoring and health checking
 * - Log capture and retrieval
 * - Graceful shutdown with timeout
 *
 * @example
 * ```typescript
 * import { llamaServer } from 'genai-electron';
 *
 * // Start server
 * await llamaServer.start({
 *   modelId: 'my-model',
 *   port: 8080
 * });
 *
 * // Check health
 * const healthy = await llamaServer.isHealthy();
 *
 * // Get logs
 * const logs = await llamaServer.getLogs();
 *
 * // Stop server
 * await llamaServer.stop();
 * ```
 */
export class LlamaServerManager extends ServerManager {
  /** Fields accepted by LlamaServerManager.start() (ServerConfig + LlamaServerConfig) */
  private static readonly VALID_CONFIG_FIELDS: ReadonlySet<string> = new Set([
    'modelId',
    'port',
    'threads',
    'contextSize',
    'minimumContextSize',
    'preferredContextSize',
    'maximumContextSize',
    'gpuLayers',
    'parallelRequests',
    'flashAttention',
    'forceValidation',
    'modelAlias',
    'continuousBatching',
    'batchSize',
    'useMmap',
    'useMlock',
    'startupTimeout',
    'jinja',
    'host',
    'cacheTypeK',
    'cacheTypeV',
    'swaFull',
    'overrideTensors',
    'cacheRam',
    'cpuMoe',
    'nCpuMoe',
    'reasoningFormat',
    'fit',
    'occupancyCheck',
    'autoRestart',
    'maxRestarts',
    'healthCheckInterval',
  ]);

  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private readonly calibrationProbeExecutor: (
    options: RunCalibrationProbeOptions
  ) => Promise<RunCalibrationProbeObservation>;
  private binaryPath?: string;
  /** Host used for health checks (config.host normalized; 0.0.0.0/:: → 127.0.0.1) */
  private healthHost = '127.0.0.1';
  /** Duration of the last successful start, spawn → healthy (ms) */
  private _loadTimeMs?: number;
  /** Effective per-slot context reported by llama-server /props */
  private _effectiveContextSize?: number;
  /** Effective request slots reported by /props or resolved from configuration */
  private _effectiveParallelRequests?: number;
  /** Monotonic count of successfully committed llama-server processes */
  private serverGeneration = 0;
  /** Monotonic identity for the active startup/process attempt. */
  private processGeneration = 0;
  /** Startup generations explicitly cancelled by stop(), awaiting rejection. */
  private readonly cancelledStartupGenerations = new Set<number>();
  /** Changes on every explicit stop(), including a no-op stop during auto-restart startup. */
  private autoRestartCancellationEpoch = 0;
  /** Total auto-restart attempts since the last MANUAL start (lifetime budget, not consecutive) */
  private restartAttempts = 0;
  /** Pending auto-restart timer (crash backoff) */
  private restartTimer?: NodeJS.Timeout;
  /** True while an auto-restart start() call is in flight (skips counter reset) */
  private isAutoRestarting = false;
  /** Hang-watchdog interval timer */
  private watchdogTimer?: NodeJS.Timeout;
  /** Consecutive failed watchdog health checks */
  private consecutiveHealthFailures = 0;
  /** Set when the watchdog kills a hung process, so handleExit treats it as a crash */
  private watchdogKill = false;
  /** Reentrancy guard: true while a watchdog health check is in flight */
  private watchdogCheckInFlight = false;
  /** True while an isolated LLM runtime-calibration sweep is in flight. */
  private calibrating = false;
  /** Unsafe process left behind by a failed candidate teardown. */
  private calibrationOrphan?: { pid: number; stderrTail?: string };

  /**
   * Create a new LlamaServerManager
   *
   * @param modelManager - Model manager instance (default: singleton)
   * @param systemInfo - System info instance (default: singleton)
   */
  constructor(
    modelManager: ModelManager = ModelManager.getInstance(),
    systemInfo: SystemInfo = SystemInfo.getInstance(),
    calibrationProbeExecutor: (
      options: RunCalibrationProbeOptions
    ) => Promise<RunCalibrationProbeObservation> = runCalibrationProbe
  ) {
    super();
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;
    this.calibrationProbeExecutor = calibrationProbeExecutor;
  }

  /**
   * Start llama-server
   *
   * Downloads binary if not present, validates model exists, auto-configures
   * settings if not specified, spawns the process, and waits for health check.
   *
   * @param config - Server configuration
   * @returns Server information
   * @throws {ModelNotFoundError} If model doesn't exist
   * @throws {PortInUseError} If port is already in use
   * @throws {BinaryError} If binary download/verification fails
   * @throws {InsufficientResourcesError} If system can't run the model
   * @throws {ContextConstraintError} If a context contract is invalid,
   * unsupported by model metadata, or cannot be verified at runtime
   * @throws {ServerError} If server fails to start
   */
  async start(config: LlamaServerConfig): Promise<ServerInfo> {
    await this.assertNoCalibrationOrphan();
    if (this.calibrating) {
      throw new ServerError('Cannot start server while LLM calibration is in progress', {
        code: 'CALIBRATION_BUSY',
        suggestion: 'Wait for calibrate() to finish, or abort it via its AbortSignal',
      });
    }
    // Prevent concurrent starts from sharing binary provisioning artifacts.
    if (this._status === 'running' || this._status === 'starting' || this._status === 'stopping') {
      throw new ServerError(
        this._status === 'running'
          ? 'Server is already running'
          : this._status === 'starting'
            ? 'Server is already starting'
            : 'Server is already stopping',
        {
          suggestion:
            this._status === 'running'
              ? 'Stop the server first with stop()'
              : this._status === 'starting'
                ? 'Wait for the current start() call to finish'
                : 'Wait for stop() to finish before starting again',
        }
      );
    }

    // Validate config fields before proceeding
    this.validateConfigFields(
      config as unknown as Record<string, unknown>,
      LlamaServerManager.VALID_CONFIG_FIELDS,
      'LlamaServerManager'
    );
    const llamaConfig = config as LlamaServerConfig;
    const contextConstraints = normalizeContextConstraints(llamaConfig, {
      allowExactWithPolicy: true,
    });

    // A manual start resets the auto-restart budget and cancels any pending
    // auto-restart; the auto-restart path itself skips this.
    if (!this.isAutoRestarting) {
      this.restartAttempts = 0;
      this.cancelPendingRestart();
    }

    this._effectiveContextSize = undefined;
    this._effectiveParallelRequests = undefined;
    const startupGeneration = ++this.processGeneration;
    let startupPid: number | undefined;
    this.setStatus('starting');

    try {
      // Resolve the port once, up front — every later step (availability check,
      // health polling, CLI args, saved config for restart) uses this value.
      // 'auto' binds port 0 to get an OS-assigned free port.
      const resolvedPort =
        config.port === 'auto' ? await findFreePort() : (config.port ?? DEFAULT_PORTS.llama);
      const startupHealthHost = normalizeHealthHost(config.host);
      this.assertStartupAttemptActive(startupGeneration);
      this.healthHost = startupHealthHost;

      await this.initializeLogManager(
        'llama-server.log',
        `Preparing llama-server for model ${config.modelId} on port ${resolvedPort}`
      );
      this.assertStartupAttemptActive(startupGeneration);

      // 1. Validate model exists
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      this.assertStartupAttemptActive(startupGeneration);

      let finalConfig: ResolvedLlamaServerConfig | undefined;
      let canRun: Awaited<ReturnType<SystemInfo['canRunModel']>>;

      if (contextConstraints.hasContextPolicy) {
        // Validate model limits and resolve the constrained placement before
        // provisioning. The legacy unresolved preflight can otherwise reject a
        // configuration that fits through GPU/MoE offload or quantized KV.
        validateModelContextRange(modelInfo, contextConstraints);
        finalConfig = await this.autoConfigureIfNeeded(
          { ...config, port: resolvedPort },
          modelInfo
        );
        canRun =
          finalConfig.contextSize !== undefined && finalConfig.gpuLayers !== undefined
            ? await this.systemInfo.canRunModel(modelInfo, {
                gpuLayers: finalConfig.gpuLayers,
                contextSize: finalConfig.contextSize,
                cacheTypeK: finalConfig.cacheTypeK,
                cacheTypeV: finalConfig.cacheTypeV,
                cpuMoe: finalConfig.cpuMoe,
                nCpuMoe: finalConfig.nCpuMoe,
                overrideTensors: finalConfig.overrideTensors,
              })
            : { possible: true };
      } else {
        // Preserve the existing preflight order and behavior for legacy callers.
        canRun = await this.systemInfo.canRunModel(modelInfo, {
          gpuLayers: config.gpuLayers,
        });
      }

      if (!canRun.possible) {
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Available RAM: ${Math.round(
              (await this.systemInfo.getMemoryInfo()).available / 1024 / 1024 / 1024
            )}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
            minimumContextSize: contextConstraints.minimumContextSize,
            preferredContextSize: contextConstraints.preferredContextSize,
            maximumContextSize: contextConstraints.maximumContextSize,
            configuredContextSize: finalConfig?.contextSize,
            parallelRequests: contextConstraints.parallelRequests,
          }
        );
      }

      // 3. Ensure binary is downloaded (pass model path for real functionality testing)
      this.binaryPath = await this.ensureBinary(modelInfo.path, config.forceValidation);
      this.assertStartupAttemptActive(startupGeneration);

      // 4. Check if port is in use (on the host the server will bind)
      await this.checkPortAvailability(resolvedPort, undefined, startupHealthHost);
      this.assertStartupAttemptActive(startupGeneration);

      // 4b. Occupancy safety rail: detect other llama-servers that could
      // double-load VRAM (default 'warn'; 'strict' throws; 'off' skips)
      await this.runOccupancyCheck(
        (config as LlamaServerConfig).occupancyCheck ?? 'warn',
        resolvedPort
      );
      this.assertStartupAttemptActive(startupGeneration);

      // 5. Auto-configure if needed (policy-aware starts were resolved before provisioning)
      finalConfig ??= await this.autoConfigureIfNeeded(
        { ...config, port: resolvedPort },
        modelInfo
      );
      this.assertStartupAttemptActive(startupGeneration);

      // 5b. Normalize the shared llama.cpp quantized-V/flash-attention constraint.
      const requestedFlashAttention = finalConfig.flashAttention;
      finalConfig = normalizeLlamaVCacheConfig(finalConfig);
      if (requestedFlashAttention !== finalConfig.flashAttention) {
        debugLog('[LlamaServer] cacheTypeV is quantized - forcing flashAttention on');
      }

      // 6. Save final configuration (AFTER auto-configuration)
      this._config = finalConfig;

      // 7. Record the final auto-configured start parameters
      await this.logManager?.write(`Starting llama-server on port ${finalConfig.port}`, 'info');
      this.assertStartupAttemptActive(startupGeneration);

      // 8. Build command-line arguments
      const args = buildLlamaServerArgs(finalConfig, modelInfo);

      // 9. Verify binary exists before spawning
      if (!this.binaryPath) {
        throw new ServerError('Binary path is not set', {
          suggestion: 'This is an internal error - binary should have been downloaded',
        });
      }

      const binaryExists = await fileExists(this.binaryPath);
      this.assertStartupAttemptActive(startupGeneration);
      if (!binaryExists) {
        throw new ServerError(`Binary file not found: ${this.binaryPath}`, {
          path: this.binaryPath,
          suggestion: 'Try deleting the binaries directory and restarting the app',
        });
      }

      await this.logManager!.write(
        `Spawning llama-server: ${this.binaryPath} with args: ${args.join(' ')}`,
        'info'
      );
      this.assertStartupAttemptActive(startupGeneration);

      // 10. Spawn the process
      const spawnStartedAt = Date.now();
      const { pid } = this.processManager.spawn(this.binaryPath, args, {
        onStdout: (data) => {
          if (startupGeneration === this.processGeneration) {
            this.handleStdout(data);
          }
        },
        onStderr: (data) => {
          if (startupGeneration === this.processGeneration) {
            this.handleStderr(data);
          }
        },
        onExit: (code, signal) => this.handleExit(code, signal, startupGeneration),
        onError: (error) => this.handleSpawnError(error, startupGeneration),
      });

      this.assertStartupAttemptActive(startupGeneration);
      startupPid = pid;
      this._pid = pid;
      this._port = finalConfig.port;

      await this.logManager!.write(
        `Process spawned with PID ${pid}, waiting for health check...`,
        'info'
      );

      // 10. Wait for server to be healthy
      await waitForHealthy(
        finalConfig.port,
        finalConfig.startupTimeout ?? DEFAULT_TIMEOUTS.serverStart,
        undefined,
        undefined,
        startupHealthHost
      );

      this.assertStartupAttemptActive(startupGeneration, pid);
      const loadTimeMs = Date.now() - spawnStartedAt;
      const configuredParallelRequests = finalConfig.parallelRequests ?? 1;
      const runtimeCapacity = await fetchLlamaRuntimeCapacity(
        finalConfig.port,
        startupHealthHost,
        configuredParallelRequests,
        DEFAULT_TIMEOUTS.healthCheck
      );
      this.assertStartupAttemptActive(startupGeneration, pid);

      if (
        contextConstraints.minimumContextSize !== undefined &&
        runtimeCapacity.effectiveContextSize < contextConstraints.minimumContextSize
      ) {
        throw new ContextConstraintError(
          `Effective context ${runtimeCapacity.effectiveContextSize} is below the required minimum ${contextConstraints.minimumContextSize}`,
          {
            reason: 'runtime-below-minimum',
            stage: 'runtime',
            minimumContextSize: contextConstraints.minimumContextSize,
            preferredContextSize: contextConstraints.preferredContextSize,
            maximumContextSize: contextConstraints.maximumContextSize,
            configuredContextSize: finalConfig.contextSize,
            effectiveContextSize: runtimeCapacity.effectiveContextSize,
            parallelRequests: configuredParallelRequests,
            effectiveParallelRequests: runtimeCapacity.totalSlots ?? configuredParallelRequests,
            suggestion:
              'Reduce the minimum or parallel request count, or choose a configuration with more context capacity',
          }
        );
      }

      if (
        contextConstraints.maximumContextSize !== undefined &&
        runtimeCapacity.effectiveContextSize > contextConstraints.maximumContextSize
      ) {
        throw new ContextConstraintError(
          `Effective context ${runtimeCapacity.effectiveContextSize} is above the requested maximum ${contextConstraints.maximumContextSize}`,
          {
            reason: 'runtime-above-maximum',
            stage: 'runtime',
            minimumContextSize: contextConstraints.minimumContextSize,
            preferredContextSize: contextConstraints.preferredContextSize,
            maximumContextSize: contextConstraints.maximumContextSize,
            configuredContextSize: finalConfig.contextSize,
            effectiveContextSize: runtimeCapacity.effectiveContextSize,
            parallelRequests: configuredParallelRequests,
            effectiveParallelRequests: runtimeCapacity.totalSlots ?? configuredParallelRequests,
            suggestion: 'Use a smaller configured context or disable llama-server fitting',
          }
        );
      }

      const effectiveContextSize = runtimeCapacity.effectiveContextSize;
      const effectiveParallelRequests = runtimeCapacity.totalSlots ?? configuredParallelRequests;

      await this.logManager?.write(
        `Server is running and healthy (load time: ${loadTimeMs}ms, configured context: ${
          finalConfig.contextSize ?? 'llama-fit'
        } total, effective context: ${effectiveContextSize} per slot, slots: ${effectiveParallelRequests})`,
        'info'
      );
      this.assertStartupAttemptActive(startupGeneration, pid);

      // Commit verified state only after every asynchronous startup operation.
      // The synchronous tail cannot be interleaved with stop() or a newer start.
      this._effectiveContextSize = effectiveContextSize;
      this._effectiveParallelRequests = effectiveParallelRequests;
      this._loadTimeMs = loadTimeMs;
      this._startedAt = new Date();
      this.setStatus('running');
      this.assertStartupAttemptActive(startupGeneration, pid, 'running');

      // Start the hang watchdog if configured
      this.startWatchdog(finalConfig);

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      // Assign a public generation only after the process is verified and all
      // synchronous commit work has succeeded. Capture both event payloads
      // before listeners can synchronously alter lifecycle state.
      this.serverGeneration++;
      const readyState: LlamaServerReadyState = {
        serverGeneration: this.serverGeneration,
        modelId: finalConfig.modelId,
        port: finalConfig.port,
        configuredContextSize: finalConfig.contextSize,
        effectiveContextSize,
        effectiveParallelRequests,
        startedAt: this._startedAt.toISOString(),
      };
      const serverInfo = this.getInfo();

      this.emitEvent('ready', readyState);
      // A ready listener may synchronously stop or restart the manager. Do not
      // follow that transition with a stale started notification.
      this.assertStartupAttemptActive(startupGeneration, pid, 'running');
      this.emitEvent('started', serverInfo);

      return serverInfo;
    } catch (error) {
      // A stop, exit, or newer start owns lifecycle state now. Reject this
      // stale start without clearing or stopping the newer attempt.
      if (startupGeneration !== this.processGeneration) {
        const startupCancelled = this.cancelledStartupGenerations.delete(startupGeneration);
        throw new ServerError('llama-server stopped or was replaced during startup', {
          cause: error instanceof Error ? error.message : String(error),
          startupCancelled,
          suggestion: 'Retry start() after the active lifecycle operation has completed',
        });
      }

      throw await this.handleStartupError('llama-server', error, async () => {
        this.invalidateProcessGeneration(startupGeneration);
        const pidToKill = startupPid;
        this._pid = undefined;
        this._port = 0;
        this._effectiveContextSize = undefined;
        this._effectiveParallelRequests = undefined;

        if (pidToKill && this.processManager.isRunning(pidToKill)) {
          try {
            await this.processManager.kill(pidToKill, 5000);
          } catch (cleanupError) {
            await this.logManager
              ?.write(
                `Failed to terminate PID ${pidToKill} after startup failure: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
                'error'
              )
              .catch(() => void 0);
          }
        }
      });
    }
  }

  /**
   * Stop llama-server
   *
   * Performs graceful shutdown with SIGTERM, waits for timeout, then force kills if needed.
   *
   * @throws {ServerError} If stop fails
   */
  async stop(): Promise<void> {
    // Intentional stop always cancels any pending auto-restart and the watchdog
    this.autoRestartCancellationEpoch++;
    this.cancelPendingRestart();
    this.teardownWatchdog();

    if (this._status === 'stopped') {
      return; // Already stopped
    }

    const stoppingGeneration = this.processGeneration;
    if (this._status === 'starting') {
      this.cancelledStartupGenerations.add(stoppingGeneration);
    }
    const pidToKill = this._pid;
    this.invalidateProcessGeneration(stoppingGeneration);
    this._pid = undefined;
    this._port = 0;
    this._effectiveContextSize = undefined;
    this._effectiveParallelRequests = undefined;
    this.setStatus('stopping');

    try {
      if (this.logManager) {
        await this.logManager.write('Stopping server...', 'info').catch(() => void 0);
      }

      if (pidToKill) {
        await this.processManager.kill(pidToKill, DEFAULT_TIMEOUTS.serverStop);
      }

      this.setStatus('stopped');

      if (this.logManager) {
        await this.logManager.write('Server stopped', 'info').catch(() => void 0);
      }

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      // Emit stopped event
      this.emitEvent('stopped');
    } catch (error) {
      this.setStatus('stopped'); // Force to stopped state
      throw new ServerError(
        `Failed to stop server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        {
          error: error instanceof Error ? error.message : String(error),
          pid: pidToKill,
        }
      );
    }
  }

  override async restart(): Promise<ServerInfo> {
    await this.assertNoCalibrationOrphan();
    if (this.calibrating) {
      throw new ServerError('Cannot restart server while LLM calibration is in progress', {
        code: 'CALIBRATION_BUSY',
        suggestion: 'Wait for calibrate() to finish, or abort it via its AbortSignal',
      });
    }
    return super.restart();
  }

  /** True while an isolated LLM runtime-calibration sweep is running. */
  isCalibrating(): boolean {
    return this.calibrating;
  }

  /**
   * Calibrate llama-server with either the default adaptive boundary search or
   * an explicit exact combo list. Fresh launches run serially; the manager
   * remains publicly stopped and returns a start-ready result. The host decides
   * whether to apply, persist, present, or ignore it.
   */
  async calibrate(config: LlamaCalibrationConfig): Promise<LlamaCalibrationReport> {
    const calibrationStartedAt = performance.now();
    await this.assertNoCalibrationOrphan();
    if (this._status !== 'stopped') {
      throw new ServerError('Cannot calibrate while the server is not stopped', {
        code: 'CALIBRATION_SERVER_RUNNING',
        suggestion: 'Stop the server with stop() before calibrating',
      });
    }
    if (this.calibrating) {
      throw new ServerError('An LLM calibration is already in progress', {
        code: 'CALIBRATION_BUSY',
        suggestion: 'Wait for the current calibrate() call to finish',
      });
    }

    const validated = validateLlamaCalibrationConfig(config);
    const redactCalibrationText = createCalibrationPromptRedactor(validated.workloads);
    const savedBinaryPath = this.binaryPath;
    const savedLogManager = this.logManager;
    const runs: LlamaCalibrationRun[] = [];
    const probes: LlamaCalibrationProbe[] = [];
    let lastProgress = 0;
    let exactCandidateCount = 0;
    /**
     * The exact run's fixed baseline, hoisted so the outer catch can attach it too.
     *
     * Undefined until the baseline exists, which is exactly the case where a partial report must
     * not claim any resource coverage.
     */
    let exactResourceMonitoring: LlamaCalibrationResourceMonitoring | undefined;
    /**
     * The exact run's live warning list, hoisted so the outer catch can attach it too.
     *
     * Baseline and boundary warnings (a disabled metric, an untrusted boundary reading) are the only
     * record of degraded telemetry, so a partial report that reports `coverage: 'partial'` must not
     * drop them.
     */
    const exactWarnings: string[] = [];
    /**
     * Live adaptive run state the outer catch reads when the strategy throws without already having
     * described itself.
     *
     * `runAdaptiveCalibration` owns both, but escapes after its baseline exists (a caller abort
     * after a committed probe, an invariant failure inside the loop or during report construction)
     * must still surface the coverage and the warnings that were accumulated by then.
     */
    const adaptiveRunState: {
      warnings: string[];
      resourceMonitoring?: LlamaCalibrationResourceMonitoring;
      terminalStatus?: LlamaCalibrationTerminalStatus;
      publishTerminalProgress?: (
        terminalStatus: LlamaCalibrationTerminalStatus,
        elapsedMs: number,
        budget: LlamaAdaptiveProgressBudget
      ) => void;
      resourceError?: LlamaCalibrationResourceStabilityError;
    } = { warnings: [] };
    const initialAdaptiveBudget =
      validated.strategy === 'adaptive'
        ? resolveLlamaCalibrationTimeBudget({
            maxWallTimeMs: validated.maxWallTimeMs,
            maxProbes: validated.maxProbes,
          })
        : resolveLlamaCalibrationTimeBudget();
    const adaptiveDeadlineController =
      validated.strategy === 'adaptive' ? new AbortController() : undefined;
    const cancelAdaptiveDeadline = adaptiveDeadlineController
      ? scheduleCalibrationDeadline(
          adaptiveDeadlineController,
          calibrationStartedAt + initialAdaptiveBudget.maxWallTimeMs
        )
      : undefined;
    const adaptiveWorkSignal = adaptiveDeadlineController
      ? validated.signal
        ? AbortSignal.any([validated.signal, adaptiveDeadlineController.signal])
        : adaptiveDeadlineController.signal
      : undefined;
    let adaptiveOutcome: LlamaCalibrationReport | undefined;
    let adaptiveProgressSnapshot: {
      overallPercent: number;
      budget: LlamaAdaptiveProgressBudget;
    } = {
      overallPercent: 0,
      budget: adaptiveProgressBudget(
        initialAdaptiveBudget.maxWallTimeMs,
        Math.max(
          0,
          initialAdaptiveBudget.maxWallTimeMs - (performance.now() - calibrationStartedAt)
        ),
        initialAdaptiveBudget.maxProbes,
        0
      ),
    };
    this.calibrating = true;

    const exactProgress = (
      phase:
        | 'preparing'
        | 'starting'
        | 'capacity-check'
        | 'warmup'
        | 'sampling'
        | 'stopping'
        | 'done',
      comboIndex: number,
      comboCount: number,
      combo?: LlamaCalibrationCombo,
      resolvedConfig?: ResolvedLlamaCalibrationConfig,
      workloadIndex?: number,
      sampleIndex?: number,
      terminalStatus?: 'complete' | 'no-viable-candidate' | 'aborted' | 'failed'
    ) => {
      if (validated.strategy !== 'exact') return;
      const fractionByPhase = {
        preparing: 0,
        starting: 0.05,
        'capacity-check': 0.1,
        warmup: 0.15,
        sampling:
          0.2 +
          (0.7 * ((workloadIndex ?? 0) * validated.samples + (sampleIndex ?? 0))) /
            Math.max(1, validated.workloads.length * validated.samples),
        stopping: 0.95,
        done: 1,
      };
      const calculated =
        phase === 'done'
          ? terminalStatus === 'aborted' || terminalStatus === 'failed'
            ? lastProgress
            : 100
          : comboCount === 0
            ? 0
            : ((comboIndex + fractionByPhase[phase]) / comboCount) * 100;
      lastProgress = Math.max(lastProgress, Math.min(100, calculated));
      const candidates =
        comboCount === 0
          ? ({ resolved: false } as const)
          : ({ resolved: true, comboCount } as const);
      const payload: LlamaCalibrationProgress =
        phase === 'done'
          ? {
              strategy: 'exact',
              phase,
              terminalStatus: terminalStatus ?? 'failed',
              overallPercent: lastProgress,
              elapsedMs: performance.now() - calibrationStartedAt,
              candidates,
            }
          : {
              strategy: 'exact',
              phase,
              overallPercent: lastProgress,
              elapsedMs: performance.now() - calibrationStartedAt,
              candidates,
              ...(combo && resolvedConfig
                ? {
                    activeCandidate: {
                      comboIndex,
                      combo,
                      resolvedConfig,
                      gpuLayers: resolvedConfig.gpuLayers ?? 0,
                    },
                  }
                : {}),
              workloadIndex,
              workloadCount: validated.workloads.length,
              sampleIndex,
              sampleCount: validated.samples,
            };
      try {
        validated.onProgress?.(structuredClone(payload));
      } catch (error) {
        debugLog('[LlamaCalibration] progress callback threw:', error);
      }
      try {
        this.emit('calibration-progress', structuredClone(payload));
      } catch (error) {
        debugLog('[LlamaCalibration] calibration-progress listener threw:', error);
      }
    };

    try {
      if (validated.strategy === 'adaptive') {
        adaptiveOutcome = await this.runAdaptiveCalibration(
          validated,
          calibrationStartedAt,
          probes,
          (snapshot) => {
            adaptiveProgressSnapshot = snapshot;
          },
          adaptiveRunState,
          adaptiveDeadlineController!,
          adaptiveWorkSignal!
        );
        return adaptiveOutcome;
      }

      exactProgress('preparing', 0, 0);
      validated.signal?.throwIfAborted();
      const model = await this.modelManager.getModelInfo(validated.modelId);
      validated.signal?.throwIfAborted();
      if (model.type !== 'llm') {
        throw new ServerError('LLM calibration requires an LLM model', {
          code: 'CALIBRATION_INVALID_CONFIG',
          modelId: model.id,
        });
      }

      await this.initializeLogManager(
        'llama-server.log',
        `LLM runtime calibration starting for model ${model.id}`
      );
      validated.signal?.throwIfAborted();

      try {
        await this.runOccupancyCheck('strict', 0);
        validated.signal?.throwIfAborted();
      } catch (error) {
        if (validated.signal?.aborted) throw error;
        throw new ServerError('Another llama-server may already be using machine resources', {
          code: 'CALIBRATION_RESOURCE_BUSY',
          cause: calibrationErrorMessage(error),
          suggestion: 'Stop other llama-server and GPU workloads before calibrating',
        });
      }

      let capabilities: Awaited<ReturnType<SystemInfo['detect']>>;
      try {
        capabilities = await this.systemInfo.detect(true);
        validated.signal?.throwIfAborted();
      } catch (error) {
        if (validated.signal?.aborted) throw error;
        throw new ServerError('Could not inspect machine capabilities for calibration', {
          code: 'CALIBRATION_PREPARATION_FAILED',
          cause: calibrationErrorMessage(error),
        });
      }
      const baselineStartConfig: LlamaServerConfig & { port: number } = {
        modelId: model.id,
        port: 0,
        contextSize: validated.profile.contextSize,
        parallelRequests: validated.profile.parallelRequests,
        ...validated.fixedConfig,
        fit: 'off',
      };
      const baselineServer = normalizeLlamaVCacheConfig(
        await this.autoConfigureIfNeeded(baselineStartConfig, model)
      );
      validated.signal?.throwIfAborted();
      const baseline = resolveLlamaCalibrationConfig(
        validated.profile,
        validated.fixedConfig,
        extractLlamaCalibrationOverrides(
          baselineServer as unknown as ResolvedLlamaCalibrationConfig,
          validated.fixedConfig
        )
      );

      const baselineOverrides = extractLlamaCalibrationOverrides(baseline, validated.fixedConfig);
      const resolveCandidate = (combo: LlamaCalibrationCombo) => {
        const resolvedConfig = normalizeLlamaVCacheConfig(
          resolveLlamaCalibrationConfig(validated.profile, validated.fixedConfig, {
            ...baselineOverrides,
            ...combo.overrides,
          })
        );
        const argvKey = JSON.stringify(
          buildLlamaServerArgs(
            {
              modelId: model.id,
              port: 0,
              host: '127.0.0.1',
              fit: 'off',
              ...resolvedConfig,
            },
            model
          )
        );
        return { combo, resolvedConfig, argvKey };
      };
      const customCandidates = validated.combos.map(resolveCandidate);
      const seenCandidates = new Set<string>();
      for (const candidate of customCandidates) {
        if (seenCandidates.has(candidate.argvKey)) {
          throw new ServerError('Custom calibration combos resolve to duplicate server arguments', {
            code: 'CALIBRATION_INVALID_CONFIG',
            combo: candidate.combo,
          });
        }
        seenCandidates.add(candidate.argvKey);
      }

      validated.signal?.throwIfAborted();
      this.binaryPath = await this.ensureBinary(model.path);
      validated.signal?.throwIfAborted();
      const calibrationBinaryPath = this.binaryPath;
      const binaryIdentity = await getInstalledBinaryIdentity(
        'llama',
        calibrationBinaryPath,
        BINARY_VERSIONS.llamaServer.version
      );
      const skippedCombos: { combo: LlamaCalibrationCombo; reason: string }[] = [];
      const candidates = [...customCandidates];
      const combos = candidates.map((candidate) => candidate.combo);
      exactCandidateCount = combos.length;
      let verifiedProfile:
        | { effectiveContextSize: number; effectiveParallelRequests: number }
        | undefined;
      const observedPromptTokenCounts = new Map<string, readonly number[]>();
      const warnings = exactWarnings;
      // Candidate resolution and binary readiness are complete and no combo has launched yet: the
      // same baseline placement plan decision 2 gives adaptive mode. A metric with too few trusted
      // samples is disabled for the whole run and says so in the report warnings.
      const resourceGuard = this.createCalibrationResourceGuard();
      const resourceBaseline = await this.collectCalibrationResourceBaseline(
        resourceGuard,
        validated.signal
      );
      mergeCalibrationWarnings(warnings, resourceBaseline.warnings);
      exactResourceMonitoring = resourceMonitoringRecord(resourceBaseline);
      const resourceMonitoring = exactResourceMonitoring;
      /**
       * Public probe index of each clean run, positionally aligned with `runs`.
       *
       * `runs` is the clean-evidence collection - the only input to ranking - while `probes` is the
       * chronological trail that may additionally end with one invalidated observation. The two
       * index spaces therefore diverge and can only be crossed through this map.
       */
      const cleanRunProbeIndexes: number[] = [];
      /** The best start-ready exact recommendation supported by clean pre-failure evidence. */
      const exactBestKnown = (): LlamaExactCalibrationBestKnown | undefined => {
        const winner = recommendLlamaCalibrationRun(runs, validated.kvPrecisionPreferencePct);
        if (!winner) return undefined;
        const runIndex = runs.findIndex(
          (run) => run.combo === winner.combo && run.resolvedConfig === winner.startConfig
        );
        const probeIndex = runIndex === -1 ? undefined : cleanRunProbeIndexes[runIndex];
        if (probeIndex === undefined) return undefined;
        return {
          recommendation: winner,
          evidence: 'single-launch-measurement',
          sourceProbeIndexes: [probeIndex],
        };
      };
      /**
       * Terminal resource rejection: build the typed error, then emit the single
       * `done`/`terminalStatus: 'failed'` payload. The outer catch recognises the error class, so it
       * never emits a second terminal payload nor rebuilds the rejection as a generic exact failure.
       *
       * Order matters: candidate derivation and report construction run BEFORE the terminal payload,
       * so a throw in either escapes as an untyped error with no terminal payload emitted yet, and
       * the outer catch emits exactly one - rather than a second one after this function's.
       */
      const resourceStabilityRejection = (
        boundary: ResourceBoundaryKind,
        result: ResourceBoundaryResult,
        probeIndex?: number
      ): LlamaCalibrationResourceStabilityError => {
        const bestKnown = exactBestKnown();
        const rejection = buildResourceStabilityError({
          boundary,
          result,
          ...(probeIndex !== undefined ? { probeIndex } : {}),
          strategy: 'exact',
          probes,
          warnings,
          resourceMonitoring,
          ...(bestKnown ? { bestKnown } : {}),
        });
        exactProgress(
          'done',
          exactCandidateCount,
          exactCandidateCount,
          undefined,
          undefined,
          undefined,
          undefined,
          'failed'
        );
        return rejection;
      };

      for (let comboIndex = 0; comboIndex < candidates.length; comboIndex++) {
        const { combo, resolvedConfig, argvKey } = candidates[comboIndex]!;
        // Pre-launch guard: a confirmed or unverifiable boundary rejects here, before the executor
        // is invoked and before any progress payload announces this candidate, so a disturbed
        // machine never costs a launch. The confirmation runs on the caller's signal.
        const preLaunchBoundary = await this.checkCalibrationResourceBoundary(
          resourceGuard,
          resourceBaseline,
          'pre-launch',
          validated.signal
        );
        if (preLaunchBoundary && preLaunchBoundary.conclusion !== 'admitted') {
          throw resourceStabilityRejection('pre-launch', preLaunchBoundary);
        }
        mergeCalibrationWarnings(warnings, preLaunchBoundary?.warnings);
        const probeStartedAt = performance.now();
        try {
          const observation = await this.calibrationProbeExecutor({
            binaryPath: calibrationBinaryPath,
            model,
            combo,
            resolvedConfig,
            workloads: validated.workloads,
            purpose: 'exact',
            fidelity: 'full',
            sampleCount: validated.samples,
            seed: validated.seed,
            startupTimeoutMs: validated.startupTimeoutMs,
            requestTimeoutMs: validated.requestTimeoutMs,
            completionTimeoutMs: validated.requestTimeoutMs,
            cachedPromptTokenCounts: observedPromptTokenCounts,
            signal: validated.signal,
            onProgress: ({ phase, workloadIndex, sampleIndex }) => {
              exactProgress(
                phase,
                comboIndex,
                combos.length,
                combo,
                resolvedConfig,
                workloadIndex,
                sampleIndex
              );
            },
          });
          const { run } = observation;
          const durationMs = performance.now() - probeStartedAt;
          // Teardown is confirmed (the executor resolved) and `durationMs` is already fixed, so the
          // post-cleanup guard is measured from the real teardown instant without inflating the
          // recorded probe duration.
          const postCleanupBoundary = await this.settleAndCheckPostCleanupResourceBoundary(
            resourceGuard,
            resourceBaseline,
            validated.signal
          );
          mergeCalibrationWarnings(warnings, postCleanupBoundary?.warnings);
          const resourceBoundaries = probeResourceBoundaries(
            preLaunchBoundary,
            postCleanupBoundary
          );
          /** Everything about the probe record that does not depend on its resource validity. */
          const probeRecord = {
            probeIndex: probes.length,
            strategy: 'exact' as const,
            purpose: 'exact' as const,
            fidelity: 'full' as const,
            independentLaunchIndex: 1,
            profileIndex: 0,
            profileOrdinal: 0,
            comboIndex,
            combo,
            resolvedConfig,
            argvKey,
            operationalStatus: run.status,
            memoryEvidence: observation.memoryEvidence,
            boundaryDecision: {
              classification: 'not-applicable' as const,
              reason: 'Exact candidates do not participate in adaptive boundary search.',
            },
            loadTimeMs: run.loadTimeMs,
            effectiveContextSize: run.effectiveContextSize,
            effectiveParallelRequests: run.effectiveParallelRequests,
            workloadResults: run.workloadResults,
            scoreMs: run.scoreMs,
            durationMs,
            error: run.error,
            stderrTail: run.stderrTail,
            cleanup: observation.cleanup,
            ...(resourceBoundaries ? { resourceBoundaries } : {}),
          };
          // Nothing above has mutated the verified profile, the prompt token-count cache, or the
          // clean-run ranking input: an observation whose post-cleanup boundary cannot be admitted
          // is quarantined, so it must not leave a trace in any of them. Only the chronological
          // trail keeps it, and only as explicitly invalidated evidence.
          if (postCleanupBoundary && postCleanupBoundary.conclusion !== 'admitted') {
            probes.push({
              ...probeRecord,
              resourceValidity: 'invalidated-by-resource-stability',
              terminationReason: 'invalidated-by-resource-stability',
            });
            throw resourceStabilityRejection(
              'post-cleanup',
              postCleanupBoundary,
              probes.length - 1
            );
          }
          if (
            verifiedProfile === undefined &&
            run.effectiveContextSize !== undefined &&
            run.effectiveParallelRequests !== undefined
          ) {
            verifiedProfile = {
              effectiveContextSize: run.effectiveContextSize,
              effectiveParallelRequests: run.effectiveParallelRequests,
            };
          }
          for (const [workloadId, tokenCounts] of observation.promptTokenCounts) {
            if (!observedPromptTokenCounts.has(workloadId)) {
              observedPromptTokenCounts.set(workloadId, tokenCounts);
            }
          }
          cleanRunProbeIndexes.push(probeRecord.probeIndex);
          runs.push(run);
          probes.push({ ...probeRecord, resourceValidity: 'accepted' });
        } catch (error) {
          // A resource-stability rejection raised above is already the terminal decision, complete
          // with its partial report and its single terminal progress payload.
          if (error instanceof LlamaCalibrationResourceStabilityError) throw error;
          const sanitized = redactCalibrationError(error, redactCalibrationText);
          const fatalObservation = calibrationErrorDetail(sanitized, 'probeObservation') as
            | RunCalibrationProbeObservation
            | undefined;
          if (fatalObservation?.run && fatalObservation.cleanup?.confirmed) {
            const { run } = fatalObservation;
            const fatalProbe = {
              probeIndex: probes.length,
              strategy: 'exact' as const,
              purpose: 'exact' as const,
              fidelity: 'full' as const,
              independentLaunchIndex: 1,
              profileIndex: 0,
              profileOrdinal: 0,
              comboIndex,
              combo,
              resolvedConfig,
              argvKey,
              operationalStatus: run.status,
              memoryEvidence: fatalObservation.memoryEvidence,
              boundaryDecision: {
                classification: 'not-applicable' as const,
                reason: 'Exact candidates do not participate in adaptive boundary search.',
              },
              loadTimeMs: run.loadTimeMs,
              effectiveContextSize: run.effectiveContextSize,
              effectiveParallelRequests: run.effectiveParallelRequests,
              workloadResults: run.workloadResults,
              scoreMs: run.scoreMs,
              durationMs: performance.now() - probeStartedAt,
              terminationReason: calibrationErrorCode(sanitized) ?? 'fatal-probe-validation',
              error: run.error,
              stderrTail: run.stderrTail,
              cleanup: fatalObservation.cleanup,
            };
            // Teardown was confirmed even though the probe failed fatally, so plan decision 8 still
            // owes this launch a post-cleanup boundary, on the caller's signal. Skipped only for a
            // caller abort, which keeps its own higher-priority contract, and for an unconfirmed
            // cleanup, which is decided first below.
            const fatalBoundary =
              calibrationErrorCode(sanitized) === 'CALIBRATION_CLEANUP_FAILED' ||
              validated.signal?.aborted === true
                ? undefined
                : await this.settleAndCheckPostCleanupResourceBoundary(
                    resourceGuard,
                    resourceBaseline,
                    validated.signal
                  );
            mergeCalibrationWarnings(warnings, fatalBoundary?.warnings);
            const fatalBoundaries = probeResourceBoundaries(preLaunchBoundary, fatalBoundary);
            if (fatalBoundary && fatalBoundary.conclusion !== 'admitted') {
              // Precedence: with cleanup confirmed, a resource failure supersedes the probe's own
              // operational/OOM outcome, because that outcome is no longer interpretable. The
              // original failure survives inside the invalidated probe record.
              probes.push({
                ...fatalProbe,
                ...(fatalBoundaries ? { resourceBoundaries: fatalBoundaries } : {}),
                resourceValidity: 'invalidated-by-resource-stability',
              });
              throw resourceStabilityRejection('post-cleanup', fatalBoundary, probes.length - 1);
            }
            cleanRunProbeIndexes.push(fatalProbe.probeIndex);
            runs.push(run);
            probes.push({
              ...fatalProbe,
              ...(fatalBoundaries ? { resourceBoundaries: fatalBoundaries } : {}),
              resourceValidity: 'accepted',
            });
          }
          if (calibrationErrorCode(sanitized) === 'CALIBRATION_CLEANUP_FAILED') {
            const orphanPid = calibrationErrorDetail(sanitized, 'pid');
            const errorStderr = calibrationErrorDetail(sanitized, 'stderrTail');
            const cleanup = calibrationErrorDetail(sanitized, 'cleanup');
            if (typeof orphanPid === 'number' && Number.isSafeInteger(orphanPid)) {
              this.calibrationOrphan = {
                pid: orphanPid,
                stderrTail: typeof errorStderr === 'string' ? errorStderr : undefined,
              };
            }
            probes.push({
              probeIndex: probes.length,
              strategy: 'exact',
              purpose: 'exact',
              fidelity: 'full',
              independentLaunchIndex: 1,
              profileIndex: 0,
              profileOrdinal: 0,
              comboIndex,
              combo,
              resolvedConfig,
              argvKey,
              operationalStatus: 'error',
              memoryEvidence: {
                classification: 'unknown',
                reason: 'Probe cleanup could not be confirmed.',
                source: 'process-exit',
              },
              boundaryDecision: {
                classification: 'not-applicable',
                reason: 'Exact candidates do not participate in adaptive boundary search.',
              },
              // The guard never judged this launch: an unconfirmed teardown rejects before any
              // resource classification, so only the pre-launch side exists and the observation is
              // not invalidated by resource stability - it failed on its own terms.
              resourceValidity: 'accepted',
              resourceBoundaries: probeResourceBoundaries(preLaunchBoundary),
              workloadResults: validated.workloads.map((workload) => ({
                workloadId: workload.id,
                kind: workload.kind,
                workloadHash: workloadSignature(workload).hash,
                weight: workload.weight,
                samples: [],
                error: 'cleanup-unconfirmed',
              })),
              durationMs: performance.now() - probeStartedAt,
              error: calibrationErrorMessage(sanitized),
              stderrTail: typeof errorStderr === 'string' ? errorStderr : undefined,
              cleanup:
                cleanup && typeof cleanup === 'object'
                  ? (cleanup as LlamaCalibrationProbe['cleanup'])
                  : {
                      confirmed: false,
                      durationMs: 0,
                      pid: typeof orphanPid === 'number' ? orphanPid : undefined,
                      error: calibrationErrorMessage(sanitized),
                    },
            });
          }
          throw sanitized;
        }
        // No separate inter-combo cooldown: every completed launch already paid one before its
        // post-cleanup boundary, which is exactly the spacing the next candidate needs.
      }

      const modelFiles = model.shards?.length
        ? model.shards.map((file) => ({
            name: path.basename(file.path),
            size: file.size,
            checksum: file.checksum,
            sourceRevision: model.source.revision,
          }))
        : [
            {
              name: path.basename(model.path),
              size: model.size,
              checksum: model.checksum,
              sourceRevision: model.source.revision,
            },
          ];
      const cacheabilityReasons: string[] = [];
      if (modelFiles.some((file) => !file.checksum)) {
        cacheabilityReasons.push('One or more model files have no stored checksum');
      }
      if (binaryIdentity.variant === 'unknown') {
        cacheabilityReasons.push('Installed binary backend variant is unknown');
      }
      if (model.source.type === 'huggingface' && !model.source.revision) {
        cacheabilityReasons.push('Hugging Face source revision is unknown');
      }
      if (capabilities.gpu.available) {
        cacheabilityReasons.push('GPU driver/runtime version is not discoverable');
      }
      const selected = recommendLlamaCalibrationRun(runs, validated.kvPrecisionPreferencePct);
      const reportBase = {
        resultKind: 'report',
        schemaVersion: 4,
        policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
        createdAt: new Date().toISOString(),
        strategy: 'exact',
        status: selected ? 'complete' : 'no-viable-candidate',
        model: {
          id: model.id,
          name: model.name,
          architecture: model.ggufMetadata?.architecture,
          size: model.size,
          checksum: model.checksum,
          sourceRevision: model.source.revision,
          files: modelFiles,
        },
        binary: binaryIdentity,
        machine: {
          platform: capabilities.platform,
          architecture: capabilities.cpu.architecture,
          osRelease: os.release(),
          cpuModel: capabilities.cpu.model,
          cpuCores: capabilities.cpu.cores,
          totalMemoryBytes: capabilities.memory.total,
          // The stabilized baseline replaces the one-shot detection reading whenever it exists:
          // the machine numbers a reader compares probes against must be the ones the guard used.
          // Each metric is substituted independently, so a disabled VRAM metric cannot suppress
          // the stabilized host value or vice versa.
          availableMemoryBytes:
            resourceBaseline.metrics.hostMemory.baselineBytes ?? capabilities.memory.available,
          gpu: capabilities.gpu.available
            ? [
                {
                  name: capabilities.gpu.name ?? 'unknown',
                  vendor: capabilities.gpu.type ?? 'unknown',
                  memoryBytes: capabilities.gpu.vram,
                  availableMemoryBytes:
                    resourceBaseline.metrics.vram.baselineBytes ?? capabilities.gpu.vramAvailable,
                },
              ]
            : [],
        },
        cacheability: {
          level: cacheabilityReasons.length === 0 ? 'stable' : 'best-effort',
          reasons: cacheabilityReasons,
        },
        profile: validated.profile,
        fixedConfig: validated.fixedConfig,
        verifiedProfile,
        workloads: validated.workloads.map((workload) => ({
          ...workloadSignature(workload),
          promptTokenCounts: observedPromptTokenCounts.get(workload.id),
        })),
        methodology: {
          layerCount: getLayerCountWithFallback(model),
          layerCountSource: model.ggufMetadata?.block_count ? 'metadata' : 'fallback',
          samples: validated.samples,
          searchSamples: LLAMA_CALIBRATION_DEFAULTS.searchSamples,
          warmups: 1,
          seed: validated.seed,
          startupTimeoutMs: validated.startupTimeoutMs,
          requestTimeoutMs: validated.requestTimeoutMs,
          resourceCooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
          tieTolerancePct: LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
          grossRegressionMultiplier: LLAMA_CALIBRATION_DEFAULTS.grossRegressionMultiplier,
          stabilityTolerancePct: LLAMA_CALIBRATION_DEFAULTS.stabilityTolerancePct,
          searchNoiseAllowancePct: LLAMA_CALIBRATION_DEFAULTS.searchNoiseAllowancePct,
          nonMonotoneTriggerPct: LLAMA_CALIBRATION_DEFAULTS.nonMonotoneTriggerPct,
          includeKvCacheComparison: false,
          kvPrecisionPreferencePct: validated.kvPrecisionPreferencePct,
          scoreUnit: 'scenario-median-wall-ms',
          resourceStability: CALIBRATION_RESOURCE_STABILITY_METHODOLOGY,
        },
        resourceMonitoring,
        combos,
        skippedCombos,
        runs,
        probes,
        warnings,
        confidence: 'single-launch-measurement',
      } as const;
      const report: LlamaExactCalibrationReport = selected
        ? {
            ...reportBase,
            selected,
            selectionEvidence: 'single-launch-measurement',
          }
        : reportBase;
      exactProgress(
        'done',
        combos.length,
        combos.length,
        undefined,
        undefined,
        undefined,
        undefined,
        report.status
      );
      return report;
    } catch (error) {
      const originalErrorCode = calibrationErrorCode(error);
      const sanitized = redactCalibrationError(error, redactCalibrationText);
      // A resource-stability rejection from either strategy is already the terminal decision, with
      // its typed details, its partial report, and its single terminal progress payload. Redaction
      // preserved the class; rebuilding it as a generic `ServerError` would destroy the contract
      // hosts branch on, and emitting another terminal payload would break the one-payload rule.
      if (sanitized instanceof LlamaCalibrationResourceStabilityError) {
        if (validated.strategy === 'adaptive') adaptiveRunState.resourceError = sanitized;
        throw sanitized;
      }
      if (validated.strategy === 'adaptive') {
        if (calibrationErrorDetail(sanitized, 'partialReport') !== undefined) {
          throw sanitized;
        }
        const terminalStatus = validated.signal?.aborted ? 'aborted' : 'failed';
        adaptiveRunState.terminalStatus = terminalStatus;
        throw new ServerError(
          terminalStatus === 'aborted'
            ? 'LLM calibration aborted'
            : 'Adaptive LLM calibration failed',
          {
            ...(sanitized instanceof ServerError &&
            typeof sanitized.details === 'object' &&
            sanitized.details
              ? (sanitized.details as Record<string, unknown>)
              : {}),
            code:
              terminalStatus === 'aborted'
                ? 'CALIBRATION_ABORTED'
                : (calibrationErrorCode(sanitized) ?? originalErrorCode ?? 'CALIBRATION_FAILED'),
            cause: redactCalibrationText(calibrationErrorMessage(sanitized)),
            partialReport: {
              schemaVersion: 4,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: terminalStatus,
              createdAt: new Date().toISOString(),
              // Reached for any failure the strategy did not already describe, which includes
              // post-baseline escapes (a caller abort observed after a committed probe, an invariant
              // failure inside the loop or during report construction). Coverage is therefore
              // attached whenever the baseline exists and omitted only before it, and the warnings
              // accumulated so far - the sole record of a disabled metric or an untrusted boundary
              // reading - travel with it.
              ...(adaptiveRunState.resourceMonitoring
                ? { resourceMonitoring: adaptiveRunState.resourceMonitoring }
                : {}),
              probes,
              warnings: [...adaptiveRunState.warnings],
              cleanupConfirmed: calibrationErrorCode(sanitized) !== 'CALIBRATION_CLEANUP_FAILED',
            },
          }
        );
      }
      const cleanupConfirmed = calibrationErrorCode(sanitized) !== 'CALIBRATION_CLEANUP_FAILED';
      if (validated.signal?.aborted || calibrationErrorCode(sanitized) === 'CALIBRATION_ABORTED') {
        exactProgress(
          'done',
          exactCandidateCount,
          exactCandidateCount,
          undefined,
          undefined,
          undefined,
          undefined,
          'aborted'
        );
        throw new ServerError('LLM calibration aborted', {
          code: 'CALIBRATION_ABORTED',
          runs,
          cause: redactCalibrationText(
            validated.signal?.reason === undefined
              ? calibrationErrorMessage(sanitized)
              : String(validated.signal.reason)
          ),
          partialReport: {
            schemaVersion: 4,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'exact',
            status: 'aborted',
            createdAt: new Date().toISOString(),
            resourceMonitoring: exactResourceMonitoring,
            probes,
            // The baseline's disabled-metric warning and every boundary warning accumulated so far
            // are the only record of degraded telemetry, so they must survive alongside the
            // (possibly `partial`) coverage this report already claims.
            warnings: [...exactWarnings],
            cleanupConfirmed,
          },
        });
      }
      exactProgress(
        'done',
        exactCandidateCount,
        exactCandidateCount,
        undefined,
        undefined,
        undefined,
        undefined,
        'failed'
      );
      if (sanitized instanceof ServerError) {
        throw new ServerError(sanitized.message.replace(/^Server error: /, ''), {
          ...(typeof sanitized.details === 'object' && sanitized.details
            ? (sanitized.details as Record<string, unknown>)
            : {}),
          partialReport: {
            schemaVersion: 4,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'exact',
            status: 'failed',
            createdAt: new Date().toISOString(),
            resourceMonitoring: exactResourceMonitoring,
            probes,
            // The baseline's disabled-metric warning and every boundary warning accumulated so far
            // are the only record of degraded telemetry, so they must survive alongside the
            // (possibly `partial`) coverage this report already claims.
            warnings: [...exactWarnings],
            cleanupConfirmed,
          },
        });
      }
      throw new ServerError('LLM calibration failed', {
        code: 'CALIBRATION_FAILED',
        cause: calibrationErrorMessage(sanitized),
        partialReport: {
          schemaVersion: 4,
          policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
          strategy: 'exact',
          status: 'failed',
          createdAt: new Date().toISOString(),
          resourceMonitoring: exactResourceMonitoring,
          probes,
          // The baseline's disabled-metric warning and every boundary warning accumulated so far
          // are the only record of degraded telemetry, so they must survive alongside the
          // (possibly `partial`) coverage this report already claims.
          warnings: [...exactWarnings],
          cleanupConfirmed,
        },
      });
    } finally {
      cancelAdaptiveDeadline?.();
      this.binaryPath = savedBinaryPath;
      this.logManager = savedLogManager;
      this.systemInfo.clearCache();
      this.calibrating = false;
      if (validated.strategy === 'adaptive') {
        const elapsedMs = Math.max(0, performance.now() - calibrationStartedAt);
        const budget = {
          maxWallTimeMs: initialAdaptiveBudget.maxWallTimeMs,
          elapsedMs,
          overrunMs: Math.max(0, elapsedMs - initialAdaptiveBudget.maxWallTimeMs),
          ...(initialAdaptiveBudget.maxProbes !== undefined
            ? { maxProbes: initialAdaptiveBudget.maxProbes }
            : {}),
        };
        if (adaptiveOutcome?.strategy === 'adaptive') adaptiveOutcome.budget = budget;
        const resourcePartial = adaptiveRunState.resourceError?.details.partialReport;
        if (resourcePartial?.strategy === 'adaptive') resourcePartial.budget = budget;
        const terminalStatus = adaptiveRunState.terminalStatus;
        if (terminalStatus && adaptiveRunState.publishTerminalProgress) {
          adaptiveRunState.publishTerminalProgress(
            terminalStatus,
            elapsedMs,
            adaptiveProgressBudget(
              initialAdaptiveBudget.maxWallTimeMs,
              Math.max(0, initialAdaptiveBudget.maxWallTimeMs - elapsedMs),
              initialAdaptiveBudget.maxProbes,
              initialAdaptiveBudget.maxProbes === undefined
                ? 0
                : initialAdaptiveBudget.maxProbes -
                    (adaptiveProgressSnapshot.budget.remainingProbes ?? 0)
            )
          );
        }
      }
    }
  }

  private async runAdaptiveCalibration(
    validated: ValidatedLlamaAdaptiveCalibrationConfig,
    calibrationStartedAt: number,
    publicProbes: LlamaCalibrationProbe[],
    onProgressSnapshot: (snapshot: {
      overallPercent: number;
      budget: LlamaAdaptiveProgressBudget;
    }) => void,
    /**
     * Shared with the caller's outer catch, exactly like `publicProbes`: the warning list is
     * accumulated in place and the monitoring record is published the moment the baseline exists, so
     * an escape this strategy did not describe itself still reports what was actually observed.
     */
    runState: {
      warnings: string[];
      resourceMonitoring?: LlamaCalibrationResourceMonitoring;
      terminalStatus?: LlamaCalibrationTerminalStatus;
      publishTerminalProgress?: (
        terminalStatus: LlamaCalibrationTerminalStatus,
        elapsedMs: number,
        budget: LlamaAdaptiveProgressBudget
      ) => void;
      resourceError?: LlamaCalibrationResourceStabilityError;
    },
    deadlineController: AbortController,
    workSignal: AbortSignal
  ): Promise<LlamaCalibrationReport> {
    const redact = createCalibrationPromptRedactor(validated.workloads);
    const warnings = runState.warnings;
    const tokenCounts = new Map<string, readonly number[]>();
    const verifiedProfiles = new Map<
      number,
      { effectiveContextSize: number; effectiveParallelRequests: number }
    >();
    let lastProgress = 0;
    const configuredBudget = resolveLlamaCalibrationTimeBudget({
      maxWallTimeMs: validated.maxWallTimeMs,
      maxProbes: validated.maxProbes,
    });
    const deadlineAt = calibrationStartedAt + configuredBudget.maxWallTimeMs;
    let launchedProbeCount = 0;
    let progressBudget = adaptiveProgressBudget(
      configuredBudget.maxWallTimeMs,
      Math.max(0, deadlineAt - performance.now()),
      configuredBudget.maxProbes,
      launchedProbeCount
    );
    let state: AdaptivePolicyState | undefined;

    const resolvedProgressBudget = (): LlamaAdaptiveProgressBudget => {
      return adaptiveProgressBudget(
        configuredBudget.maxWallTimeMs,
        Math.max(0, deadlineAt - performance.now()),
        configuredBudget.maxProbes,
        launchedProbeCount
      );
    };
    const adaptiveBudgetReport = (): LlamaAdaptiveCalibrationBudgetReport => {
      const elapsedMs = Math.max(0, performance.now() - calibrationStartedAt);
      return {
        maxWallTimeMs: configuredBudget.maxWallTimeMs,
        elapsedMs,
        overrunMs: Math.max(0, elapsedMs - configuredBudget.maxWallTimeMs),
        ...(configuredBudget.maxProbes !== undefined
          ? { maxProbes: configuredBudget.maxProbes }
          : {}),
      };
    };
    const publishProgress = (payload: LlamaCalibrationProgress): void => {
      try {
        validated.onProgress?.(structuredClone(payload));
      } catch (error) {
        debugLog('[LlamaCalibration] adaptive progress callback threw:', error);
      }
      try {
        this.emit('calibration-progress', structuredClone(payload));
      } catch (error) {
        debugLog('[LlamaCalibration] adaptive calibration-progress listener threw:', error);
      }
    };
    runState.publishTerminalProgress = (terminalStatus, elapsedMs, budget) => {
      const overallPercent =
        terminalStatus === 'aborted' || terminalStatus === 'failed' ? lastProgress : 100;
      lastProgress = Math.max(lastProgress, overallPercent);
      onProgressSnapshot({ overallPercent: lastProgress, budget });
      publishProgress({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus,
        overallPercent: lastProgress,
        elapsedMs,
        completedProbes: publicProbes.length,
        budget,
      });
    };

    const emitProgress = (
      phase:
        | 'preparing'
        | 'policy-ready'
        | 'finding-reference'
        | 'establishing-ceiling'
        | 'bisecting'
        | 'validating-finalist'
        | 'validating-winner'
        | 'validating-fallback'
        | 'stopping'
        | 'done',
      options: {
        terminalStatus?:
          | 'complete'
          | 'time-limited'
          | 'probe-limited'
          | 'inconclusive'
          | 'no-viable-candidate'
          | 'aborted'
          | 'failed';
        activeProbe?: LlamaAdaptiveActiveProbe;
        workloadIndex?: number;
        sampleIndex?: number;
        sampleCount?: number;
      } = {}
    ): void => {
      progressBudget = resolvedProgressBudget();
      if (phase === 'done') {
        runState.terminalStatus = options.terminalStatus ?? 'failed';
        onProgressSnapshot({ overallPercent: lastProgress, budget: progressBudget });
        return;
      }
      const calculated =
        ((progressBudget.maxWallTimeMs - progressBudget.remainingMs) /
          progressBudget.maxWallTimeMs) *
        100;
      lastProgress = Math.max(lastProgress, Math.min(100, calculated));
      const payload: LlamaCalibrationProgress = {
        strategy: 'adaptive',
        phase,
        overallPercent: lastProgress,
        elapsedMs: performance.now() - calibrationStartedAt,
        completedProbes: publicProbes.length,
        budget: progressBudget,
        activeProbe: options.activeProbe,
        workloadIndex: options.workloadIndex,
        workloadCount: validated.workloads.length,
        sampleIndex: options.sampleIndex,
        sampleCount: options.sampleCount ?? validated.samples,
      };
      onProgressSnapshot({ overallPercent: lastProgress, budget: progressBudget });
      publishProgress(payload);
    };

    emitProgress('preparing');
    validated.signal?.throwIfAborted();

    const preparationTimeLimit = (terminalReason: string): LlamaCalibrationReport | undefined => {
      if (performance.now() < deadlineAt) return undefined;
      emitProgress('done', { terminalStatus: 'time-limited' });
      return {
        resultKind: 'preparation-time-limit',
        schemaVersion: 4,
        policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
        createdAt: new Date().toISOString(),
        strategy: 'adaptive',
        phase: 'preparing',
        status: 'time-limited',
        searchCompleteness: 'partial',
        terminalReason,
        budget: adaptiveBudgetReport(),
        probes: [],
        warnings: [...warnings],
        cleanupConfirmed: true,
      };
    };
    const entryPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached before adaptive preparation could start.'
    );
    if (entryPreparationLimit) return entryPreparationLimit;

    const model = await this.modelManager.getModelInfo(validated.modelId);
    validated.signal?.throwIfAborted();
    if (model.type !== 'llm') {
      throw new ServerError('LLM calibration requires an LLM model', {
        code: 'CALIBRATION_INVALID_CONFIG',
        modelId: model.id,
      });
    }
    const modelPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while loading model metadata.'
    );
    if (modelPreparationLimit) return modelPreparationLimit;
    await this.initializeLogManager(
      'llama-server.log',
      `Adaptive LLM runtime calibration starting for model ${model.id}`
    );
    validated.signal?.throwIfAborted();
    const logPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while preparing calibration logging.'
    );
    if (logPreparationLimit) return logPreparationLimit;
    try {
      await this.runOccupancyCheck('strict', 0);
      validated.signal?.throwIfAborted();
    } catch (error) {
      if (validated.signal?.aborted) throw error;
      throw new ServerError('Another llama-server may already be using machine resources', {
        code: 'CALIBRATION_RESOURCE_BUSY',
        cause: redact(calibrationErrorMessage(error)),
        suggestion: 'Stop other llama-server and GPU workloads before calibrating',
      });
    }
    const occupancyPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while checking machine occupancy.'
    );
    if (occupancyPreparationLimit) return occupancyPreparationLimit;

    let capabilities: Awaited<ReturnType<SystemInfo['detect']>>;
    try {
      capabilities = await this.systemInfo.detect(true);
      validated.signal?.throwIfAborted();
    } catch (error) {
      if (validated.signal?.aborted) throw error;
      throw new ServerError('Could not inspect machine capabilities for calibration', {
        code: 'CALIBRATION_PREPARATION_FAILED',
        cause: redact(calibrationErrorMessage(error)),
      });
    }
    const capabilityPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while inspecting machine capabilities.'
    );
    if (capabilityPreparationLimit) return capabilityPreparationLimit;

    try {
      this.binaryPath = await this.ensureBinary(model.path, false, workSignal);
    } catch (error) {
      if (validated.signal?.aborted) throw error;
      const limit = preparationTimeLimit(
        'The calibration time limit was reached while provisioning the calibration binary.'
      );
      if (limit) return limit;
      throw error;
    }
    validated.signal?.throwIfAborted();
    const binaryPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while provisioning the calibration binary.'
    );
    if (binaryPreparationLimit) return binaryPreparationLimit;
    const calibrationBinaryPath = this.binaryPath;
    const binaryIdentity = await getInstalledBinaryIdentity(
      'llama',
      calibrationBinaryPath,
      BINARY_VERSIONS.llamaServer.version
    );
    validated.signal?.throwIfAborted();
    const identityPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while reading the calibration binary identity.'
    );
    if (identityPreparationLimit) return identityPreparationLimit;
    const gpuAvailable = capabilities.gpu.available && binaryIdentity.variant !== 'cpu';
    const totalLayers = getLayerCountWithFallback(model);
    const schedulingProfiles = validated.profiles
      .map((profile, profileIndex) => ({ profile, profileIndex }))
      .sort(
        (left, right) =>
          left.profile.contextSize - right.profile.contextSize ||
          left.profileIndex - right.profileIndex
      );
    const smallest = schedulingProfiles[0]!;
    const canonicalStartConfig: LlamaServerConfig & { port: number } = {
      modelId: model.id,
      port: 0,
      contextSize: smallest.profile.contextSize,
      parallelRequests: smallest.profile.parallelRequests,
      ...validated.fixedConfig,
      fit: 'off',
    };
    const canonicalServer = normalizeLlamaVCacheConfig(
      await this.autoConfigureIfNeeded(canonicalStartConfig, model)
    );
    validated.signal?.throwIfAborted();
    const canonicalPreparationLimit = preparationTimeLimit(
      'The calibration time limit was reached while preparing the calibration search space.'
    );
    if (canonicalPreparationLimit) return canonicalPreparationLimit;
    const canonicalResolved = resolveLlamaCalibrationConfig(
      smallest.profile,
      validated.fixedConfig,
      extractLlamaCalibrationOverrides(
        canonicalServer as unknown as ResolvedLlamaCalibrationConfig,
        validated.fixedConfig
      )
    );
    const canonicalOverrides = extractLlamaCalibrationOverrides(
      canonicalResolved,
      validated.fixedConfig
    );
    const invariantOverrides: Record<string, unknown> = { ...canonicalOverrides };
    delete invariantOverrides.gpuLayers;
    delete invariantOverrides.swaFull;
    if (validated.includeKvCacheComparison) {
      delete invariantOverrides.cacheTypeK;
      delete invariantOverrides.cacheTypeV;
      delete invariantOverrides.flashAttention;
    }

    const profileInputs = [];
    for (let profileIndex = 0; profileIndex < validated.profiles.length; profileIndex++) {
      const profile = validated.profiles[profileIndex]!;
      const profileStartConfig: LlamaServerConfig & { port: number } = {
        modelId: model.id,
        port: 0,
        contextSize: profile.contextSize,
        parallelRequests: profile.parallelRequests,
        ...validated.fixedConfig,
        ...invariantOverrides,
        fit: 'off',
      };
      const profileServer =
        profileIndex === smallest.profileIndex
          ? canonicalServer
          : normalizeLlamaVCacheConfig(await this.autoConfigureIfNeeded(profileStartConfig, model));
      validated.signal?.throwIfAborted();
      const profilePreparationLimit = preparationTimeLimit(
        'The calibration time limit was reached while preparing profile configurations.'
      );
      if (profilePreparationLimit) return profilePreparationLimit;
      profileInputs.push({
        profileIndex,
        contextSize: profile.contextSize,
        parallelRequests: profile.parallelRequests,
        autoGpuLayers: gpuAvailable
          ? Math.min(
              totalLayers,
              Math.max(0, Number(profileServer.gpuLayers ?? canonicalResolved.gpuLayers ?? 0))
            )
          : 0,
        normalizedInvariantKey: JSON.stringify(invariantOverrides),
      });
    }

    const baselineKvPrecision =
      canonicalResolved.cacheTypeK === 'f16' && canonicalResolved.cacheTypeV === 'f16'
        ? 'f16'
        : canonicalResolved.cacheTypeK === 'q8_0' && canonicalResolved.cacheTypeV === 'q8_0'
          ? 'q8_0'
          : 'baseline';
    const hasSharedPrefixWorkload = validated.workloads.some(
      (workload) => workload.kind === 'shared-prefix'
    );
    const slidingWindow = getSlidingWindow(model);
    const anySwaRelevant = validated.profiles.some(
      (profile) =>
        validated.fixedConfig.swaFull === undefined &&
        slidingWindow !== undefined &&
        hasSharedPrefixWorkload &&
        Math.floor(profile.contextSize / profile.parallelRequests) > slidingWindow
    );
    state = createAdaptivePolicyState({
      profiles: profileInputs,
      totalLayers,
      gpuAvailable,
      fixedGpuLayers: validated.fixedConfig.gpuLayers,
      fixedSwaFull:
        validated.fixedConfig.swaFull ??
        (!anySwaRelevant ? (canonicalResolved.swaFull ?? false) : undefined),
      slidingWindow,
      hasSharedPrefixWorkload,
      includeKvCacheComparison: validated.includeKvCacheComparison,
      baselineKvPrecision,
      kvTransferCompatible:
        validated.includeKvCacheComparison &&
        (canonicalResolved.flashAttention === true || canonicalResolved.flashAttention === 'on'),
      contextPreferencePct: validated.contextPreferencePct,
      kvPrecisionPreferencePct: validated.kvPrecisionPreferencePct,
      tieTolerancePct: LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
      policy: {
        grossRegressionMultiplier: LLAMA_CALIBRATION_DEFAULTS.grossRegressionMultiplier,
        tieTolerancePct: LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
        contextPreferencePct: LLAMA_CALIBRATION_DEFAULTS.contextPreferencePct,
        kvPrecisionPreferencePct: LLAMA_CALIBRATION_DEFAULTS.kvPrecisionPreferencePct,
        searchNoiseAllowancePct: LLAMA_CALIBRATION_DEFAULTS.searchNoiseAllowancePct,
        nonMonotoneTriggerPct: LLAMA_CALIBRATION_DEFAULTS.nonMonotoneTriggerPct,
        guardDistanceMinLayers: LLAMA_CALIBRATION_DEFAULTS.guardDistanceMinLayers,
        guardDistanceFraction: LLAMA_CALIBRATION_DEFAULTS.guardDistanceFraction,
        stabilityTolerancePct: LLAMA_CALIBRATION_DEFAULTS.stabilityTolerancePct,
        maxRunnerStartAttempts: LLAMA_CALIBRATION_DEFAULTS.maxRunnerStartAttempts,
        capacityCheckTimeoutCapMs: LLAMA_CALIBRATION_DEFAULTS.capacityCheckTimeoutCapMs,
        processExitConfirmationMs: LLAMA_CALIBRATION_DEFAULTS.processExitConfirmationMs,
        processExitSettleGraceMs: LLAMA_CALIBRATION_DEFAULTS.processExitSettleGraceMs,
      },
    });
    const resourceGuard = this.createCalibrationResourceGuard();
    const baselineAdmissionLimit = preparationTimeLimit(
      'The calibration time limit was reached before fixed-baseline collection could start.'
    );
    if (baselineAdmissionLimit) return baselineAdmissionLimit;
    // Establish the one fixed baseline before any launch. This preparation is part of the same
    // method-entry wall-clock budget as the search itself.
    const resourceBaseline: ResourceBaseline = await this.collectCalibrationResourceBaseline(
      resourceGuard,
      validated.signal
    );
    validated.signal?.throwIfAborted();
    mergeCalibrationWarnings(warnings, resourceBaseline.warnings);
    const resourceMonitoring = resourceMonitoringRecord(resourceBaseline);
    runState.resourceMonitoring = resourceMonitoring;
    // Identity and the fixed baseline now exist, so later limit exits use the ordinary adaptive
    // report shape and can honestly return any clean incumbent already measured.
    progressBudget = resolvedProgressBudget();
    emitProgress('policy-ready');

    const cellById = new Map(state.cells.map((cell) => [cell.id, cell]));
    const profileByIndex = new Map(
      validated.profiles.map((profile, profileIndex) => [profileIndex, profile])
    );
    const resolveCellConfig = (
      cell: AdaptiveCell,
      gpuLayers: number
    ): ResolvedLlamaCalibrationConfig => {
      const profile = profileByIndex.get(cell.profileIndex)!;
      const overrides: LlamaCalibrationCombo['overrides'] = {
        ...(invariantOverrides as LlamaCalibrationCombo['overrides']),
        gpuLayers,
        swaFull: cell.swaFull,
      };
      if (validated.includeKvCacheComparison) {
        if (cell.kvPrecision === 'baseline') {
          throw new ServerError('Adaptive KV comparison produced an invalid baseline cell', {
            code: 'CALIBRATION_INVARIANT_FAILED',
            cellId: cell.id,
          });
        }
        overrides.cacheTypeK = cell.kvPrecision;
        overrides.cacheTypeV = cell.kvPrecision;
        overrides.flashAttention =
          cell.kvPrecision === 'q8_0' ? 'on' : (canonicalResolved.flashAttention ?? 'auto');
      }
      return normalizeLlamaVCacheConfig(
        resolveLlamaCalibrationConfig(profile, validated.fixedConfig, overrides)
      );
    };
    const candidateToRecommendation = (
      candidate: AdaptiveCandidate | undefined
    ): LlamaCalibrationRecommendation | undefined => {
      if (!candidate) return undefined;
      const cell = cellById.get(candidate.cellId);
      if (!cell) return undefined;
      return {
        profileIndex: candidate.profileIndex,
        cellId: candidate.cellId,
        startConfig: resolveCellConfig(cell, candidate.gpuLayers),
        scoreMs: candidate.scoreMs,
      };
    };
    const resolveCellInvariantConfig = (cell: AdaptiveCell) => {
      const resolved = { ...resolveCellConfig(cell, cell.initialGpuLayers) };
      delete resolved.gpuLayers;
      return resolved;
    };
    const argvKeyFor = (resolvedConfig: ResolvedLlamaCalibrationConfig): string =>
      JSON.stringify(
        buildLlamaServerArgs(
          {
            modelId: model.id,
            port: 0,
            host: '127.0.0.1',
            fit: 'off',
            ...resolvedConfig,
          },
          model
        )
      );
    const checkResourceBoundary = async (
      boundary: ResourceBoundaryKind
    ): Promise<ResourceBoundaryResult | undefined> =>
      this.checkCalibrationResourceBoundary(
        resourceGuard,
        resourceBaseline,
        boundary,
        validated.signal
      );
    const adaptiveCapFor = (action: AdaptiveProbeAction): number => {
      if (action.timeoutMode === 'full') return validated.requestTimeoutMs;
      const priorRequests = publicProbes
        .filter(
          (probe) =>
            probe.cellId === action.cellId && probe.boundaryDecision.classification === 'admissible'
        )
        .flatMap((probe) => probe.workloadResults)
        .flatMap((result) => result.samples)
        .flatMap((sample) => sample.requests)
        .map((request) => request.wallTimeMs);
      if (priorRequests.length === 0) return validated.requestTimeoutMs;
      // Observed request times are fractional, so floor the derived cap: timer
      // APIs downstream require an integer delay, and an unclamped float made
      // healthy probes fail with a spurious `error` status that then consumed the
      // point's ambiguity repeat and shifted its boundary.
      return Math.floor(
        Math.min(
          validated.requestTimeoutMs,
          Math.max(
            LLAMA_CALIBRATION_DEFAULTS.minimumAdaptiveRequestTimeoutMs,
            LLAMA_CALIBRATION_DEFAULTS.earlyStopMultiplier * Math.max(...priorRequests)
          )
        )
      );
    };

    /**
     * Accepted policy-evidence index -> public chronological probe index.
     *
     * The two spaces diverge the moment an invalidated probe joins the trail, so best-known source
     * evidence can only be translated into public probe indexes through this map.
     */
    const probeIndexByEvidenceIndex = new Map<number, number>();
    /**
     * Best start-ready adaptive recommendation supported only by clean committed evidence.
     */
    const adaptiveBestKnown = (): LlamaAdaptiveCalibrationBestKnown | undefined => {
      const incumbent = deriveAdaptiveIncumbent(state!);
      const recommendation = candidateToRecommendation(incumbent?.candidate);
      const sourceProbeIndexes = (incumbent?.candidate.evidenceIndices ?? [])
        .map((evidenceIndex) => probeIndexByEvidenceIndex.get(evidenceIndex))
        .filter((probeIndex): probeIndex is number => probeIndex !== undefined)
        .sort((left, right) => left - right);
      if (
        !incumbent ||
        !recommendation ||
        sourceProbeIndexes.length === 0 ||
        sourceProbeIndexes.length !== incumbent.candidate.evidenceIndices.length
      ) {
        return undefined;
      }
      const [firstProbeIndex, ...remainingProbeIndexes] = sourceProbeIndexes;
      return {
        recommendation,
        evidence: incumbent.evidenceLevel,
        sourceProbeIndexes: [firstProbeIndex!, ...remainingProbeIndexes],
      };
    };
    /**
     * Build the typed rejection for a boundary the guard refused to admit, then emit the single
     * `done`/`terminalStatus: 'failed'` payload.
     *
     * Order matters: candidate derivation and report construction run BEFORE the terminal payload,
     * so a throw in either escapes as an untyped error with no terminal payload emitted yet, and the
     * outer catch emits exactly one - rather than a second one after this function's. The emit lives
     * here rather than at the call sites so that ordering cannot be lost by a future caller.
     */
    const resourceStabilityError = (
      boundary: ResourceBoundaryKind,
      result: ResourceBoundaryResult,
      probeIndex?: number
    ): LlamaCalibrationResourceStabilityError => {
      const bestKnown = adaptiveBestKnown();
      const rejection = buildResourceStabilityError({
        boundary,
        result,
        ...(probeIndex !== undefined ? { probeIndex } : {}),
        strategy: 'adaptive',
        probes: publicProbes,
        warnings,
        resourceMonitoring,
        budget: adaptiveBudgetReport(),
        ...(bestKnown ? { bestKnown } : {}),
      });
      runState.resourceError = rejection;
      emitProgress('done', { terminalStatus: 'failed' });
      return rejection;
    };
    const inheritedCeilingByCell = new Map<
      string,
      { gpuLayers: number; sourceCellId: string; reason: string }
    >();
    let terminal: AdaptiveTerminalAction | undefined;
    while (!terminal) {
      // Caller cancellation is exceptional and takes precedence over both natural and resource
      // limit terminals whenever it is already active at the manager boundary.
      validated.signal?.throwIfAborted();
      const action = nextAdaptivePolicyAction(state);
      if (action.kind === 'terminal') {
        terminal = action;
        break;
      }
      if (performance.now() >= deadlineAt) {
        terminal = deriveAdaptiveLimitTerminal(
          state,
          'time',
          'the adaptive calibration wall-time limit was reached before the next launch'
        );
        break;
      }
      if (
        configuredBudget.maxProbes !== undefined &&
        launchedProbeCount >= configuredBudget.maxProbes
      ) {
        terminal = deriveAdaptiveLimitTerminal(
          state,
          'probe',
          'the explicit adaptive calibration probe limit was reached'
        );
        break;
      }
      const cell = cellById.get(action.cellId)!;
      if (action.inheritedCeiling) {
        inheritedCeilingByCell.set(cell.id, {
          gpuLayers: action.inheritedCeiling.gpuLayers,
          sourceCellId: action.inheritedCeiling.sourceCellId,
          reason: `${action.inheritedCeiling.kind}:${action.inheritedCeiling.axis}`,
        });
      }
      if (tokenCounts.size === 0 && cell.profileIndex !== smallest.profileIndex) {
        const incumbent = deriveAdaptiveIncumbent(state);
        terminal = {
          kind: 'terminal',
          status: 'inconclusive',
          reason: 'smallest-profile workload-capacity preflight was not completed',
          ...(incumbent
            ? {
                selected: incumbent.candidate,
                selectionEvidence: incumbent.evidenceLevel,
              }
            : {}),
        };
        warnings.push(terminal.reason);
        break;
      }
      const resolvedConfig = resolveCellConfig(cell, action.gpuLayers);
      const argvKey = argvKeyFor(resolvedConfig);
      const combo: LlamaCalibrationCombo = {
        label: `${action.purpose}:${cell.id}:g${action.gpuLayers}`,
        overrides: extractLlamaCalibrationOverrides(resolvedConfig, validated.fixedConfig),
      };
      let completionTimeoutMs = adaptiveCapFor(action);
      const bestDirectScore = Math.min(
        ...state.evidence
          .filter((evidence) => evidence.boundaryDecision === 'admissible')
          .map((evidence) => evidence.scoreMs)
          .filter(
            (score): score is number => score !== undefined && Number.isFinite(score) && score > 0
          )
      );
      const activePreferencePct = Math.max(
        LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
        validated.profiles.length > 1 ? validated.contextPreferencePct : 0,
        validated.includeKvCacheComparison ? validated.kvPrecisionPreferencePct : 0
      );
      const competitiveObservedRatio =
        ((1 + activePreferencePct / 100) *
          (1 + LLAMA_CALIBRATION_DEFAULTS.searchNoiseAllowancePct / 100)) /
        (1 - LLAMA_CALIBRATION_DEFAULTS.searchNoiseAllowancePct / 100);
      if (
        action.timeoutMode !== 'full' &&
        (!Number.isFinite(bestDirectScore) ||
          minimumAggregateLowerBoundAtCap(validated.workloads, completionTimeoutMs) <=
            bestDirectScore * competitiveObservedRatio)
      ) {
        completionTimeoutMs = validated.requestTimeoutMs;
      }
      if (action.timeoutMode === 'adaptive-with-full-continuation') {
        const hypotheticalCapDecision = classifyAdaptiveObservation(state.evidence, {
          cellId: action.cellId,
          gpuLayers: action.gpuLayers,
          purpose: action.purpose,
          fidelity: action.fidelity,
          operationalStatus: 'request-timeout',
          memoryEvidence: 'unknown',
          terminatedAtAdaptiveCap: true,
          aggregateLowerBoundMs: minimumAggregateLowerBoundAtCap(
            validated.workloads,
            completionTimeoutMs
          ),
          durationMs: completionTimeoutMs,
        });
        if (hypotheticalCapDecision.boundaryDecision !== 'unsuitable') {
          completionTimeoutMs = validated.requestTimeoutMs;
        }
      }
      const sampleCount =
        action.fidelity === 'search' ? LLAMA_CALIBRATION_DEFAULTS.searchSamples : validated.samples;
      const activeProbe: LlamaAdaptiveActiveProbe = {
        profileIndex: cell.profileIndex,
        profileOrdinal: cell.profileOrdinal,
        cellId: cell.id,
        purpose: action.purpose,
        gpuLayers: action.gpuLayers,
        fidelity: action.fidelity,
        resolvedConfig,
        argvKey,
      };
      const outerPhase = adaptiveProgressPhase(action.purpose);
      const probeCycleStartedAt = performance.now();
      // Pre-launch guard: a confirmed or unverifiable boundary rejects here, before the executor is
      // invoked and before any progress payload announces an active probe, so a disturbed machine
      // never costs a launch and no host UI is told about one that never happened. The confirmation
      // runs on the caller's signal, so a suspicion raised just before the wall deadline finishes.
      const preLaunchBoundary = await checkResourceBoundary('pre-launch');
      if (preLaunchBoundary && preLaunchBoundary.conclusion !== 'admitted') {
        throw resourceStabilityError('pre-launch', preLaunchBoundary);
      }
      mergeCalibrationWarnings(warnings, preLaunchBoundary?.warnings);
      validated.signal?.throwIfAborted();
      // A pre-launch boundary can settle after the deadline. It never consumes the optional launch
      // cap, and the manager returns the best clean incumbent without starting more work.
      if (performance.now() >= deadlineAt) {
        terminal = deriveAdaptiveLimitTerminal(
          state,
          'time',
          'the adaptive calibration wall-time limit was reached during the pre-launch guard'
        );
        break;
      }
      const probeStartedAt = performance.now();
      const reservedProbeIndex = publicProbes.length;
      try {
        // The optional cap counts runner invocations, including startup/capacity/deadline failures;
        // retries internal to the runner remain one invocation.
        launchedProbeCount++;
        const observationPromise = this.calibrationProbeExecutor({
          binaryPath: calibrationBinaryPath,
          model,
          combo,
          resolvedConfig,
          workloads: validated.workloads,
          purpose: action.purpose,
          fidelity: action.fidelity,
          sampleCount,
          seed: validated.seed,
          startupTimeoutMs: validated.startupTimeoutMs,
          requestTimeoutMs: validated.requestTimeoutMs,
          completionTimeoutMs,
          cachedPromptTokenCounts: tokenCounts,
          signal: workSignal,
          onProgress: ({ phase, workloadIndex, sampleIndex }) => {
            emitProgress(outerPhase, {
              activeProbe: { ...activeProbe, probePhase: phase },
              workloadIndex,
              sampleIndex,
              sampleCount,
            });
          },
        });
        emitProgress(outerPhase, { activeProbe, sampleCount });
        const observation = await observationPromise;
        // Snapshot interruption at the exact executor boundary. Cleanup and the post-cleanup
        // resource guard still run, but work that resolved only because its signal fired must
        // never enter policy evidence. A deadline that fires later, during those mandatory checks,
        // does not invalidate measured work that had already completed.
        const interruptedWhenExecutorResolved = {
          caller: validated.signal?.aborted === true,
          deadline: deadlineController.signal.aborted,
        };
        const durationMs = performance.now() - probeStartedAt;
        // Teardown is confirmed (the executor resolved) and `durationMs` is already fixed, so the
        // post-cleanup guard is measured from the real teardown instant without inflating the
        // recorded probe duration.
        const postCleanupBoundary = await this.settleAndCheckPostCleanupResourceBoundary(
          resourceGuard,
          resourceBaseline,
          validated.signal
        );
        const cycleDurationMs = performance.now() - probeCycleStartedAt;
        const run = observation.run;
        const terminatedAtAdaptiveCap =
          run.status === 'request-timeout' && observation.aggregateScoreLowerBoundMs !== undefined;
        const aggregateLowerBoundMs = terminatedAtAdaptiveCap
          ? observation.aggregateScoreLowerBoundMs
          : undefined;
        // The guard's own warnings are the whole truth about telemetry here: a disabled metric was
        // already warned about once, at baseline, and an enabled-but-untrusted boundary reading
        // warns per boundary. Neither is ever turned into a resource conclusion.
        const diagnosticWarnings: string[] = [...(postCleanupBoundary?.warnings ?? [])];
        mergeCalibrationWarnings(warnings, diagnosticWarnings);
        const resourceBoundaries = probeResourceBoundaries(preLaunchBoundary, postCleanupBoundary);
        /** Trusted post-cleanup availability, for the controller's passive record only. */
        const observedAvailableBytes = (metric: LlamaCalibrationResourceMetric) => {
          const reading = postCleanupBoundary?.initial.metrics[metric];
          return reading?.enabled && reading.trusted ? reading.availableBytes : undefined;
        };
        const hostAvailableBytes = observedAvailableBytes('hostMemory');
        const gpuAvailableBytes = observedAvailableBytes('vram');
        const diagnostics = {
          kvBytesEstimate:
            estimateKVBytesPerToken(model, resolvedConfig.cacheTypeK, resolvedConfig.cacheTypeV) *
            resolvedConfig.contextSize,
          modelBytes: model.size,
          expertWeightBytes: model.ggufMetadata?.expert_weights_bytes,
          hostAvailableBytes,
          gpuAvailableBytes,
          measurementAvailability: {
            hostAvailableBytes: hostAvailableBytes === undefined ? 'unavailable' : 'available',
            gpuAvailableBytes: gpuAvailableBytes === undefined ? 'unavailable' : 'available',
          },
          warnings: diagnosticWarnings,
        } as const;
        /** Everything about the probe record that does not depend on its resource validity. */
        const probeRecord = {
          probeIndex: reservedProbeIndex,
          strategy: 'adaptive' as const,
          purpose: action.purpose,
          fidelity: action.fidelity,
          independentLaunchIndex:
            publicProbes.filter((probe) => probe.cellId === cell.id && probe.argvKey === argvKey)
              .length + 1,
          profileIndex: cell.profileIndex,
          profileOrdinal: cell.profileOrdinal,
          cellId: cell.id,
          resolvedConfig,
          argvKey,
          operationalStatus: run.status,
          memoryEvidence: observation.memoryEvidence,
          loadTimeMs: run.loadTimeMs,
          effectiveContextSize: run.effectiveContextSize,
          effectiveParallelRequests: run.effectiveParallelRequests,
          workloadResults: run.workloadResults,
          scoreMs: run.scoreMs,
          aggregateLowerBoundMs,
          durationMs,
          capped: terminatedAtAdaptiveCap,
          diagnostics: {
            kvBytesEstimate: diagnostics.kvBytesEstimate,
            modelBytes: diagnostics.modelBytes,
            expertWeightBytes: diagnostics.expertWeightBytes,
            warnings: diagnosticWarnings,
          },
          ...(resourceBoundaries ? { resourceBoundaries } : {}),
          error: run.error,
          stderrTail: run.stderrTail,
          cleanup: observation.cleanup,
        };
        // Nothing above has mutated verified profiles, the token-count cache, or the policy state:
        // an observation whose post-cleanup boundary cannot be admitted is quarantined, so it must
        // not be able to leave a trace in any of them. Only the chronological trail keeps it, and
        // only as explicitly invalidated evidence.
        if (postCleanupBoundary && postCleanupBoundary.conclusion !== 'admitted') {
          publicProbes.push({
            ...probeRecord,
            boundaryDecision: {
              classification: 'ambiguous',
              reason: 'invalidated-by-resource-stability',
            },
            resourceValidity: 'invalidated-by-resource-stability',
            terminationReason: 'invalidated-by-resource-stability',
          });
          throw resourceStabilityError(
            'post-cleanup',
            postCleanupBoundary,
            publicProbes.length - 1
          );
        }
        if (interruptedWhenExecutorResolved.caller || interruptedWhenExecutorResolved.deadline) {
          const interruptionReason = interruptedWhenExecutorResolved.caller
            ? 'caller-abort'
            : 'internal-deadline';
          publicProbes.push({
            ...probeRecord,
            boundaryDecision: {
              classification: 'ambiguous',
              reason: interruptionReason,
            },
            resourceValidity: 'accepted',
            terminationReason: interruptionReason,
          });
          if (interruptedWhenExecutorResolved.caller) {
            emitProgress('done', { terminalStatus: 'aborted' });
            throw new ServerError('LLM calibration aborted', {
              code: 'CALIBRATION_ABORTED',
              cause: redact(String(validated.signal?.reason ?? 'caller-abort')),
              partialReport: {
                schemaVersion: 4,
                policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
                strategy: 'adaptive',
                status: 'aborted',
                createdAt: new Date().toISOString(),
                resourceMonitoring,
                probes: publicProbes,
                warnings,
                cleanupConfirmed: observation.cleanup.confirmed,
              },
            });
          }
          terminal = deriveAdaptiveLimitTerminal(
            state,
            'time',
            'the internal calibration wall-time deadline interrupted the active probe'
          );
          warnings.push(terminal.reason);
          break;
        }
        if (run.effectiveContextSize !== undefined && run.effectiveParallelRequests !== undefined) {
          verifiedProfiles.set(cell.profileIndex, {
            effectiveContextSize: run.effectiveContextSize,
            effectiveParallelRequests: run.effectiveParallelRequests,
          });
        }
        if (cell.profileIndex === smallest.profileIndex) {
          for (const [workloadId, counts] of observation.promptTokenCounts) {
            if (!tokenCounts.has(workloadId)) tokenCounts.set(workloadId, counts);
          }
        }
        state = applyAdaptivePolicyObservation(state, {
          cellId: cell.id,
          gpuLayers: action.gpuLayers,
          purpose: action.purpose,
          fidelity: action.fidelity,
          operationalStatus: run.status,
          memoryEvidence: observation.memoryEvidence.classification,
          scoreMs: run.scoreMs,
          terminatedAtAdaptiveCap,
          aggregateLowerBoundMs,
          durationMs: cycleDurationMs,
          diagnostics,
        });
        const evidence = state.evidence.at(-1)!;
        probeIndexByEvidenceIndex.set(evidence.index, probeRecord.probeIndex);
        publicProbes.push({
          ...probeRecord,
          boundaryDecision: {
            classification: evidence.boundaryDecision,
            reason: evidence.decisionReason,
          },
          resourceValidity: 'accepted',
        });
      } catch (error) {
        // Freeze interruption precedence at executor rejection. Mandatory post-cleanup resource
        // settlement may cross the deadline, but it must not duplicate or reclassify a probe whose
        // own fatal result had already settled.
        const interruptedByCallerAtExecutorBoundary = validated.signal?.aborted === true;
        const interruptedByDeadlineAtExecutorBoundary = deadlineController.signal.aborted;
        // A resource-stability rejection raised above is already the terminal decision, complete
        // with its partial report and its single terminal progress payload. Rebuilding it as a
        // generic adaptive failure would destroy the typed contract hosts branch on.
        if (error instanceof LlamaCalibrationResourceStabilityError) throw error;
        const sanitized = redactCalibrationError(error, redact);
        const sanitizedCode = calibrationErrorCode(sanitized);
        if (calibrationErrorDetail(sanitized, 'partialReport') !== undefined) throw sanitized;
        const fatalObservation = calibrationErrorDetail(sanitized, 'probeObservation') as
          | RunCalibrationProbeObservation
          | undefined;
        let recordedFatalObservation = false;
        if (fatalObservation?.run && fatalObservation.cleanup?.confirmed) {
          const { run } = fatalObservation;
          const fatalTerminationReason = interruptedByCallerAtExecutorBoundary
            ? 'caller-abort'
            : interruptedByDeadlineAtExecutorBoundary
              ? 'internal-deadline'
              : (sanitizedCode ?? 'fatal-probe-validation');
          const fatalProbe = {
            probeIndex: reservedProbeIndex,
            strategy: 'adaptive' as const,
            purpose: action.purpose,
            fidelity: action.fidelity,
            independentLaunchIndex:
              publicProbes.filter((probe) => probe.cellId === cell.id && probe.argvKey === argvKey)
                .length + 1,
            profileIndex: cell.profileIndex,
            profileOrdinal: cell.profileOrdinal,
            cellId: cell.id,
            resolvedConfig,
            argvKey,
            operationalStatus: run.status,
            memoryEvidence: fatalObservation.memoryEvidence,
            boundaryDecision: {
              classification: 'ambiguous' as const,
              reason: fatalTerminationReason,
            },
            loadTimeMs: run.loadTimeMs,
            effectiveContextSize: run.effectiveContextSize,
            effectiveParallelRequests: run.effectiveParallelRequests,
            workloadResults: run.workloadResults,
            scoreMs: run.scoreMs,
            durationMs: performance.now() - probeStartedAt,
            terminationReason: fatalTerminationReason,
            error: run.error,
            stderrTail: run.stderrTail,
            cleanup: fatalObservation.cleanup,
          };
          // Teardown was confirmed even though the probe failed fatally, so plan decision 8 still
          // owes this launch a post-cleanup boundary, on the caller's signal. Skipped only for a
          // caller abort, which keeps its own higher-priority contract, and for an unconfirmed
          // cleanup, which is decided first below.
          const fatalBoundary =
            sanitizedCode === 'CALIBRATION_CLEANUP_FAILED' || interruptedByCallerAtExecutorBoundary
              ? undefined
              : await this.settleAndCheckPostCleanupResourceBoundary(
                  resourceGuard,
                  resourceBaseline,
                  validated.signal
                );
          mergeCalibrationWarnings(warnings, fatalBoundary?.warnings);
          const fatalBoundaries = probeResourceBoundaries(preLaunchBoundary, fatalBoundary);
          if (fatalBoundary && fatalBoundary.conclusion !== 'admitted') {
            // Precedence: with cleanup confirmed, a resource failure supersedes the probe's own
            // operational/OOM outcome, because that outcome is no longer interpretable. The
            // original failure survives inside the invalidated probe record.
            publicProbes.push({
              ...fatalProbe,
              ...(fatalBoundaries ? { resourceBoundaries: fatalBoundaries } : {}),
              resourceValidity: 'invalidated-by-resource-stability',
            });
            throw resourceStabilityError('post-cleanup', fatalBoundary, publicProbes.length - 1);
          }
          publicProbes.push({
            ...fatalProbe,
            ...(fatalBoundaries ? { resourceBoundaries: fatalBoundaries } : {}),
            resourceValidity: 'accepted',
          });
          recordedFatalObservation = true;
        }
        if (sanitizedCode === 'CALIBRATION_CLEANUP_FAILED') {
          const orphanPid = calibrationErrorDetail(sanitized, 'pid');
          const errorStderr = calibrationErrorDetail(sanitized, 'stderrTail');
          const cleanup = calibrationErrorDetail(sanitized, 'cleanup');
          if (typeof orphanPid === 'number' && Number.isSafeInteger(orphanPid)) {
            this.calibrationOrphan = {
              pid: orphanPid,
              stderrTail: typeof errorStderr === 'string' ? errorStderr : undefined,
            };
          }
          publicProbes.push({
            probeIndex: reservedProbeIndex,
            strategy: 'adaptive',
            purpose: action.purpose,
            fidelity: action.fidelity,
            independentLaunchIndex:
              publicProbes.filter((probe) => probe.cellId === cell.id && probe.argvKey === argvKey)
                .length + 1,
            profileIndex: cell.profileIndex,
            profileOrdinal: cell.profileOrdinal,
            cellId: cell.id,
            resolvedConfig,
            argvKey,
            operationalStatus: 'error',
            memoryEvidence: {
              classification: 'unknown',
              reason: 'The fresh calibration process could not be confirmed stopped.',
              source: 'broad-operational-diagnostic',
            },
            boundaryDecision: {
              classification: 'ambiguous',
              reason: 'cleanup-unconfirmed',
            },
            // The guard never judged this launch: an unconfirmed teardown rejects before any
            // resource classification, so only the pre-launch side exists and the observation is
            // not invalidated by resource stability - it failed on its own terms.
            resourceValidity: 'accepted',
            resourceBoundaries: probeResourceBoundaries(preLaunchBoundary),
            workloadResults: validated.workloads.map((workload) => ({
              workloadId: workload.id,
              kind: workload.kind,
              workloadHash: workloadSignature(workload).hash,
              weight: workload.weight,
              samples: [],
              error: 'cleanup-unconfirmed',
            })),
            durationMs: performance.now() - probeStartedAt,
            terminationReason: 'cleanup-unconfirmed',
            error: calibrationErrorMessage(sanitized),
            stderrTail: typeof errorStderr === 'string' ? errorStderr : undefined,
            cleanup:
              cleanup && typeof cleanup === 'object'
                ? (cleanup as LlamaCalibrationProbe['cleanup'])
                : { confirmed: false, durationMs: 0, pid: this.calibrationOrphan?.pid },
          });
          emitProgress('done', { terminalStatus: 'failed' });
          throw new ServerError('Adaptive LLM calibration cleanup failed', {
            code: 'CALIBRATION_CLEANUP_FAILED',
            cause: calibrationErrorMessage(sanitized),
            partialReport: {
              schemaVersion: 4,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: 'failed',
              createdAt: new Date().toISOString(),
              resourceMonitoring,
              probes: publicProbes,
              warnings,
              cleanupConfirmed: false,
            },
          });
        }
        const interruptedByCaller = interruptedByCallerAtExecutorBoundary;
        const interruptedByDeadline = interruptedByDeadlineAtExecutorBoundary;
        if (
          (interruptedByCaller || interruptedByDeadline) &&
          sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED' &&
          !recordedFatalObservation
        ) {
          publicProbes.push({
            probeIndex: reservedProbeIndex,
            strategy: 'adaptive',
            purpose: action.purpose,
            fidelity: action.fidelity,
            independentLaunchIndex:
              publicProbes.filter((probe) => probe.cellId === cell.id && probe.argvKey === argvKey)
                .length + 1,
            profileIndex: cell.profileIndex,
            profileOrdinal: cell.profileOrdinal,
            cellId: cell.id,
            resolvedConfig,
            argvKey,
            operationalStatus: interruptedByCaller ? 'error' : 'request-timeout',
            memoryEvidence: {
              classification: 'unknown',
              reason: interruptedByCaller
                ? 'The caller aborted this launch.'
                : 'The internal calibration deadline interrupted this launch.',
              source: 'timeout',
            },
            boundaryDecision: {
              classification: 'ambiguous',
              reason: interruptedByCaller ? 'caller-abort' : 'internal-deadline',
            },
            // Interrupted before any post-cleanup classification: the guard did not invalidate it,
            // and the abort/deadline reason above already says why it carries no evidence.
            resourceValidity: 'accepted',
            resourceBoundaries: probeResourceBoundaries(preLaunchBoundary),
            workloadResults: validated.workloads.map((workload) => ({
              workloadId: workload.id,
              kind: workload.kind,
              workloadHash: workloadSignature(workload).hash,
              weight: workload.weight,
              samples: [],
              error: interruptedByCaller ? 'caller-abort' : 'internal-deadline',
            })),
            durationMs: performance.now() - probeStartedAt,
            terminationReason: interruptedByCaller ? 'caller-abort' : 'internal-deadline',
            cleanup: { confirmed: true, durationMs: 0 },
          });
        }
        if (interruptedByCaller) {
          emitProgress('done', { terminalStatus: 'aborted' });
          throw new ServerError('LLM calibration aborted', {
            code: 'CALIBRATION_ABORTED',
            cause: redact(String(validated.signal?.reason ?? calibrationErrorMessage(sanitized))),
            partialReport: {
              schemaVersion: 4,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: 'aborted',
              createdAt: new Date().toISOString(),
              resourceMonitoring,
              probes: publicProbes,
              warnings,
              cleanupConfirmed: sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED',
            },
          });
        }
        if (interruptedByDeadline) {
          terminal = deriveAdaptiveLimitTerminal(
            state,
            'time',
            'the internal calibration wall-time deadline interrupted the active probe'
          );
          warnings.push(terminal.reason);
          break;
        }
        emitProgress('done', { terminalStatus: 'failed' });
        throw new ServerError('Adaptive LLM calibration failed', {
          code: calibrationErrorCode(sanitized) ?? 'CALIBRATION_FAILED',
          cause: calibrationErrorMessage(sanitized),
          partialReport: {
            schemaVersion: 4,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'adaptive',
            status: 'failed',
            createdAt: new Date().toISOString(),
            resourceMonitoring,
            probes: publicProbes,
            warnings,
            cleanupConfirmed: sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED',
          },
        });
      }
      this.systemInfo.clearCache();
      validated.signal?.throwIfAborted();
    }

    terminal ??= nextAdaptivePolicyAction(state) as AdaptiveTerminalAction;
    const assertApplicationReadyCandidate = (candidate: AdaptiveCandidate | undefined): void => {
      if (!candidate) return;
      if (
        !Number.isFinite(candidate.scoreMs) ||
        candidate.scoreMs <= 0 ||
        candidate.evidenceIndices.length === 0
      ) {
        throw new ServerError('Adaptive calibration selected invalid score evidence', {
          code: 'CALIBRATION_INVARIANT_FAILED',
          cellId: candidate.cellId,
          gpuLayers: candidate.gpuLayers,
        });
      }
      for (const evidenceIndex of candidate.evidenceIndices) {
        const evidence = state.evidence[evidenceIndex];
        const probeIndex = probeIndexByEvidenceIndex.get(evidenceIndex);
        const probe = probeIndex === undefined ? undefined : publicProbes[probeIndex];
        if (
          !evidence ||
          !probe ||
          evidence.cellId !== candidate.cellId ||
          evidence.gpuLayers !== candidate.gpuLayers ||
          probe.cellId !== candidate.cellId ||
          probe.resolvedConfig.gpuLayers !== candidate.gpuLayers ||
          probe.resourceValidity !== 'accepted' ||
          probe.cleanup.confirmed !== true ||
          probe.operationalStatus !== 'ok' ||
          probe.capped === true ||
          probe.scoreMs === undefined ||
          !Number.isFinite(probe.scoreMs) ||
          probe.scoreMs <= 0 ||
          probe.effectiveContextSize === undefined ||
          probe.effectiveParallelRequests === undefined
        ) {
          throw new ServerError('Adaptive calibration selected unverified probe evidence', {
            code: 'CALIBRATION_INVARIANT_FAILED',
            cellId: candidate.cellId,
            gpuLayers: candidate.gpuLayers,
            evidenceIndex,
            probeIndex,
          });
        }
      }
    };
    assertApplicationReadyCandidate(terminal.selected);
    const selected = candidateToRecommendation(terminal.selected);
    const fallback = terminal.fallback
      ? terminal.fallback.validated &&
        terminal.fallback.evidenceIndex !== undefined &&
        state.evidence[terminal.fallback.evidenceIndex]?.scoreMs !== undefined
        ? {
            profileIndex: cellById.get(terminal.fallback.cellId)!.profileIndex,
            cellId: terminal.fallback.cellId,
            startConfig: resolveCellConfig(
              cellById.get(terminal.fallback.cellId)!,
              terminal.fallback.gpuLayers
            ),
            scoreMs: state.evidence[terminal.fallback.evidenceIndex]!.scoreMs!,
            evidence: 'direct-measurement' as const,
          }
        : {
            profileIndex: cellById.get(terminal.fallback.cellId)!.profileIndex,
            cellId: terminal.fallback.cellId,
            startConfig: resolveCellConfig(
              cellById.get(terminal.fallback.cellId)!,
              terminal.fallback.gpuLayers
            ),
            evidence: 'unvalidated-option' as const,
          }
      : undefined;
    const preference = terminal.preferenceResolution;
    const cellStateSummaries = new Map(
      summarizeAdaptiveCellStates(state).map((summary) => [summary.cell.id, summary])
    );
    const finalCeilingHints = deriveCeilingHints(state.cells, state.evidence);
    const profileReports = validated.profiles.map((profile, profileIndex) => {
      const profileCells = state!.cells.filter((cell) => cell.profileIndex === profileIndex);
      const profileCellSummaries = profileCells.map((cell) => cellStateSummaries.get(cell.id)!);
      const profileEvidence = state!.evidence.filter((evidence) =>
        profileCells.some((cell) => cell.id === evidence.cellId)
      );
      return {
        profileIndex,
        profileOrdinal: schedulingProfiles.findIndex(
          (entry) => entry.profileIndex === profileIndex
        ),
        profile,
        state:
          profileEvidence.length === 0
            ? ('unstarted' as const)
            : terminal.status === 'complete'
              ? profileCellSummaries.every((summary) =>
                  ['resolved', 'no-viable-point'].includes(summary.phase)
                )
                ? ('resolved' as const)
                : ('tested' as const)
              : terminal.status === 'no-viable-candidate'
                ? ('no-viable-point' as const)
                : ('unresolved' as const),
        verified: verifiedProfiles.get(profileIndex),
        bestCellId: preference?.eligible
          .filter((candidate) => candidate.profileIndex === profileIndex)
          .sort((left, right) => left.scoreMs - right.scoreMs)[0]?.cellId,
        warnings: [] as string[],
      };
    });
    const cellReports = state.cells.map((cell) => {
      const summary = cellStateSummaries.get(cell.id)!;
      const evidence = state!.evidence.filter((item) => item.cellId === cell.id);
      const admissible = evidence.filter((item) => item.boundaryDecision === 'admissible');
      const unsuitable = evidence.filter((item) => item.boundaryDecision === 'unsuitable');
      const lowGpuLayers = admissible.length
        ? Math.max(...admissible.map((item) => item.gpuLayers))
        : undefined;
      const highGpuLayers = unsuitable.length
        ? Math.min(...unsuitable.map((item) => item.gpuLayers))
        : undefined;
      const nonMonotoneCandidates = summary.candidates.filter(
        (candidate) => candidate.source === 'non-monotone'
      );
      const candidateLayers = summary.candidates.map((candidate) => candidate.gpuLayers);
      const measuredLayers = new Set(evidence.map((item) => item.gpuLayers));
      const unmeasuredGaps =
        nonMonotoneCandidates.length > 0 && candidateLayers.length > 1
          ? Array.from(
              {
                length: Math.max(...candidateLayers) - Math.min(...candidateLayers) + 1,
              },
              (_, offset) => Math.min(...candidateLayers) + offset
            ).filter((gpuLayers) => !measuredLayers.has(gpuLayers))
          : [];
      const inheritedCeiling =
        inheritedCeilingByCell.get(cell.id) ??
        finalCeilingHints
          .filter((hint) => hint.receivingCellId === cell.id)
          .map((hint) => ({
            gpuLayers: hint.gpuLayers,
            sourceCellId: hint.sourceCellId,
            reason: `${hint.kind}:${hint.axis}`,
          }))[0];
      return {
        cellId: cell.id,
        profileIndex: cell.profileIndex,
        profileOrdinal: cell.profileOrdinal,
        structuralOrder: cell.order,
        resolvedConfig: resolveCellInvariantConfig(cell),
        state: summary.phase,
        referenceGpuLayers: evidence.find((item) => item.purpose === 'reference')?.gpuLayers,
        lowGpuLayers,
        highGpuLayers,
        provisionalBoundaryGpuLayers: lowGpuLayers,
        finalistGpuLayers: preference?.eligible.find((candidate) => candidate.cellId === cell.id)
          ?.gpuLayers,
        inheritedCeiling,
        nonMonotoneWarning: nonMonotoneCandidates.length > 0,
        unmeasuredGaps,
        warnings: summary.unresolvedReason ? [summary.unresolvedReason] : [],
      };
    });
    const modelFiles = model.shards?.length
      ? model.shards.map((file) => ({
          name: path.basename(file.path),
          size: file.size,
          checksum: file.checksum,
          sourceRevision: model.source.revision,
        }))
      : [
          {
            name: path.basename(model.path),
            size: model.size,
            checksum: model.checksum,
            sourceRevision: model.source.revision,
          },
        ];
    const cacheabilityReasons: string[] = [];
    if (modelFiles.some((file) => !file.checksum)) {
      cacheabilityReasons.push('One or more model files have no stored checksum');
    }
    if (binaryIdentity.variant === 'unknown') {
      cacheabilityReasons.push('Installed binary backend variant is unknown');
    }
    if (model.source.type === 'huggingface' && !model.source.revision) {
      cacheabilityReasons.push('Hugging Face source revision is unknown');
    }
    if (capabilities.gpu.available) {
      cacheabilityReasons.push('GPU driver/runtime version is not discoverable');
    }
    const reportBase = {
      resultKind: 'report',
      schemaVersion: 4,
      policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
      createdAt: new Date().toISOString(),
      strategy: 'adaptive',
      status: terminal.status,
      searchCompleteness:
        terminal.status === 'complete' || terminal.status === 'no-viable-candidate'
          ? 'resolved'
          : 'partial',
      terminalReason: terminal.reason,
      model: {
        id: model.id,
        name: model.name,
        architecture: model.ggufMetadata?.architecture,
        size: model.size,
        checksum: model.checksum,
        sourceRevision: model.source.revision,
        files: modelFiles,
      },
      binary: binaryIdentity,
      machine: {
        platform: capabilities.platform,
        architecture: capabilities.cpu.architecture,
        osRelease: os.release(),
        cpuModel: capabilities.cpu.model,
        cpuCores: capabilities.cpu.cores,
        totalMemoryBytes: capabilities.memory.total,
        // The stabilized baseline replaces the one-shot detection reading whenever it exists:
        // the machine numbers a reader compares probes against must be the ones the guard used.
        // Each metric is substituted independently, so a disabled VRAM metric cannot suppress the
        // stabilized host value or vice versa.
        availableMemoryBytes:
          resourceBaseline.metrics.hostMemory.baselineBytes ?? capabilities.memory.available,
        gpu: capabilities.gpu.available
          ? [
              {
                name: capabilities.gpu.name ?? 'unknown',
                vendor: capabilities.gpu.type ?? 'unknown',
                memoryBytes: capabilities.gpu.vram,
                availableMemoryBytes:
                  resourceBaseline.metrics.vram.baselineBytes ?? capabilities.gpu.vramAvailable,
              },
            ]
          : [],
      },
      cacheability: {
        level: cacheabilityReasons.length === 0 ? 'stable' : 'best-effort',
        reasons: cacheabilityReasons,
      },
      fixedConfig: validated.fixedConfig,
      workloads: validated.workloads.map((workload) => ({
        ...workloadSignature(workload),
        promptTokenCounts: tokenCounts.get(workload.id),
      })),
      methodology: {
        layerCount: totalLayers,
        layerCountSource: model.ggufMetadata?.block_count ? 'metadata' : 'fallback',
        samples: validated.samples,
        searchSamples: LLAMA_CALIBRATION_DEFAULTS.searchSamples,
        warmups: 1,
        seed: validated.seed,
        startupTimeoutMs: validated.startupTimeoutMs,
        requestTimeoutMs: validated.requestTimeoutMs,
        resourceCooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
        tieTolerancePct: LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
        grossRegressionMultiplier: LLAMA_CALIBRATION_DEFAULTS.grossRegressionMultiplier,
        stabilityTolerancePct: LLAMA_CALIBRATION_DEFAULTS.stabilityTolerancePct,
        searchNoiseAllowancePct: LLAMA_CALIBRATION_DEFAULTS.searchNoiseAllowancePct,
        nonMonotoneTriggerPct: LLAMA_CALIBRATION_DEFAULTS.nonMonotoneTriggerPct,
        includeKvCacheComparison: validated.includeKvCacheComparison,
        kvPrecisionPreferencePct: validated.kvPrecisionPreferencePct,
        contextPreferencePct: validated.contextPreferencePct,
        scoreUnit: 'scenario-median-wall-ms',
        resourceStability: CALIBRATION_RESOURCE_STABILITY_METHODOLOGY,
      },
      resourceMonitoring,
      probes: publicProbes,
      warnings,
      profiles: profileReports,
      schedulingProfileIndexes: schedulingProfiles.map((entry) => entry.profileIndex),
      workloadComparability: tokenCounts.size > 0 ? 'verified' : 'unverified',
      cells: cellReports,
      budget: adaptiveBudgetReport(),
      globalFastestScoreMs: preference?.globalFastestScore,
      contextBandMaxScoreMs: preference?.contextBand,
      kvBandMaxScoreMs: preference?.kvBand,
      contextPreferenceResolution:
        validated.profiles.length === 1
          ? 'single-profile'
          : preference?.selectedContextSize ===
              Math.max(...validated.profiles.map((profile) => profile.contextSize))
            ? 'largest-in-band'
            : preference?.selected
              ? 'fastest-only'
              : 'unresolved',
      kvPrecisionPreferenceResolution:
        preference?.kvPrecisionPreferenceResolution === 'preferred-within-joint-band'
          ? 'largest-in-joint-band'
          : preference?.kvPrecisionPreferenceResolution === 'fallback-no-joint-eligible'
            ? 'fallback-no-joint-eligible'
            : validated.includeKvCacheComparison
              ? 'unresolved'
              : 'disabled',
      ...(fallback ? { fallback } : {}),
      pinnedMoePlacement: true,
    } as const;
    const report: LlamaAdaptiveCalibrationReport =
      selected && terminal.selectionEvidence
        ? { ...reportBase, selected, selectionEvidence: terminal.selectionEvidence }
        : reportBase;
    emitProgress('done', { terminalStatus: terminal.status });
    return report;
  }

  /**
   * Bounded, abortable telemetry capture for the fixed-baseline resource guard.
   *
   * The refresh-then-read ordering inside the adapter keeps every snapshot in one measurement
   * regime: the Windows standby-aware reading has a TTL, and a stale fallback to `os.freemem()`
   * would read a probe's own released mmap pages as a large availability drop. A failed refresh
   * yields an untrusted host reading rather than a comparable-looking number.
   *
   * Shared by both strategies: exact and adaptive calibration must guard identical boundaries with
   * identical telemetry trust, so neither owns its own capture wiring.
   */
  private createCalibrationResourceGuard(): ResourceGuardDependencies {
    return {
      captureSnapshot: createTelemetrySnapshotCapture(this.systemInfo, {
        telemetryTimeoutMs: LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs,
        onDiagnostic: (message, error) => debugLog(`[LlamaCalibration] ${message}`, error),
      }),
      delay: abortableDelay,
    };
  }

  /**
   * Capture the run's ONE fixed baseline.
   *
   * Called after provisioning/preparation and before any launch or probe clock, so the fixed settle
   * delay and the bounded cooldown-spaced samples are never paid out of a probe budget. A metric
   * with too few trusted samples is disabled for the whole run with a warning; nothing here loops
   * waiting for telemetry to become trustworthy.
   */
  private async collectCalibrationResourceBaseline(
    guard: ResourceGuardDependencies,
    signal?: AbortSignal
  ): Promise<ResourceBaseline> {
    return collectBaseline(guard, {
      cooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
      samples: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
      settleMs: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Evaluate one launch boundary against the run's fixed baseline.
   *
   * Always driven by the caller's signal, never by an internal per-probe deadline: plan decision 8
   * makes post-check correctness outrank an expired probe deadline, and decision 6 requires a
   * triggered confirmation to finish even past a wall budget. Confirmation is telemetry only, so it
   * consumes no launch or probe budget by construction.
   */
  private async checkCalibrationResourceBoundary(
    guard: ResourceGuardDependencies,
    baseline: ResourceBaseline,
    boundary: ResourceBoundaryKind,
    signal?: AbortSignal
  ): Promise<ResourceBoundaryResult | undefined> {
    if (baseline.enabledMetrics.length === 0) return undefined;
    return checkBoundary(guard, {
      baseline,
      thresholds: CALIBRATION_RESOURCE_THRESHOLDS,
      cooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
      confirmationReads: LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads,
      boundary,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Settle after a confirmed teardown, then evaluate the post-cleanup boundary.
   *
   * One cooldown first: an immediate snapshot is dominated by the probe's own released model
   * mappings on Windows, which is self-release lag rather than the environment. Both the cooldown
   * and the guard follow the caller's signal rather than a possibly expired per-probe deadline.
   */
  private async settleAndCheckPostCleanupResourceBoundary(
    guard: ResourceGuardDependencies,
    baseline: ResourceBaseline,
    signal?: AbortSignal
  ): Promise<ResourceBoundaryResult | undefined> {
    await calibrationDelay(LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs, signal);
    this.systemInfo.clearCache();
    return this.checkCalibrationResourceBoundary(guard, baseline, 'post-cleanup', signal);
  }

  private async assertNoCalibrationOrphan(): Promise<void> {
    const orphan = this.calibrationOrphan;
    if (!orphan) return;
    if (!this.processManager.isRunning(orphan.pid)) {
      this.calibrationOrphan = undefined;
      return;
    }
    throw new ServerError('A previous calibration process could not be cleaned up', {
      code: 'CALIBRATION_CLEANUP_FAILED',
      pid: orphan.pid,
      stderrTail: orphan.stderrTail,
      suggestion: 'Terminate the process before starting or calibrating again',
    });
  }

  /**
   * Get current server information (includes loadTimeMs of the last start)
   */
  override getInfo(): ServerInfo {
    const config = this._config as LlamaServerConfig | undefined;
    return {
      ...super.getInfo(),
      loadTimeMs: this._loadTimeMs,
      configuredContextSize: config?.contextSize,
      effectiveContextSize: this._effectiveContextSize,
      serverGeneration: this.serverGeneration,
      effectiveParallelRequests: this._effectiveParallelRequests,
    };
  }

  /**
   * Check if server is healthy
   *
   * @returns True if server responds with 'ok' status
   */
  async isHealthy(): Promise<boolean> {
    if (this._status !== 'running' || this._port === 0) {
      return false;
    }

    try {
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck, this.healthHost);
      return health.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Get detailed health status
   *
   * @returns Health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    if (this._status !== 'running' || this._port === 0) {
      return 'unknown';
    }

    try {
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck, this.healthHost);
      return health.status;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Ensure llama-server binary is downloaded
   *
   * Downloads binary from GitHub releases if not present. Tries multiple variants
   * in priority order (CUDA → Vulkan → CPU) and uses the first one that works.
   * Caches validation results for faster startup next time.
   *
   * For updating to new llama.cpp releases, see docs/dev/UPDATING-BINARIES.md
   *
   * @param modelPath - Optional model path for real functionality testing
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails for all variants
   * @private
   */
  private async ensureBinary(
    modelPath?: string,
    forceValidation = false,
    signal?: AbortSignal
  ): Promise<string> {
    return this.ensureBinaryHelper(
      'llama',
      'llama-server',
      BINARY_VERSIONS.llamaServer,
      modelPath,
      forceValidation,
      undefined,
      undefined,
      signal
    );
  }

  /**
   * Auto-configure server settings if not specified
   *
   * Uses SystemInfo to determine optimal settings for the model.
   *
   * @param config - User-provided configuration
   * @param modelInfo - Model information
   * @returns Final configuration with auto-configured values
   * @private
   */
  private async autoConfigureIfNeeded(
    config: ServerConfig & { port: number },
    modelInfo: any
  ): Promise<ResolvedLlamaServerConfig> {
    debugLog('[LlamaServer] autoConfigureIfNeeded input:', JSON.stringify(config));

    const llamaConfig = config as LlamaServerConfig & { port: number };
    const usePolicyForSizing = llamaConfig.contextSize === undefined;
    const optimalConfig = await this.systemInfo.getOptimalConfig(modelInfo, {
      contextSize: llamaConfig.contextSize,
      minimumContextSize: usePolicyForSizing ? llamaConfig.minimumContextSize : undefined,
      preferredContextSize: usePolicyForSizing ? llamaConfig.preferredContextSize : undefined,
      maximumContextSize: usePolicyForSizing ? llamaConfig.maximumContextSize : undefined,
      gpuLayers: llamaConfig.gpuLayers,
      parallelRequests: llamaConfig.parallelRequests,
      flashAttention: llamaConfig.flashAttention,
      cacheTypeK: llamaConfig.cacheTypeK,
      cacheTypeV: llamaConfig.cacheTypeV,
      cpuMoe: llamaConfig.cpuMoe,
      nCpuMoe: llamaConfig.nCpuMoe,
      overrideTensors: llamaConfig.overrideTensors,
    });
    debugLog('[LlamaServer] Optimal config:', JSON.stringify(optimalConfig));

    // With fit: 'on', llama-server's own auto-fit sizes unset memory-related
    // fields — leave gpuLayers/contextSize/cache recommendations unset instead
    // of filling them here.
    const delegateToFit = llamaConfig.fit === 'on';

    const finalConfig = {
      ...config,
      threads: config.threads ?? optimalConfig.threads,
      contextSize: config.contextSize ?? (delegateToFit ? undefined : optimalConfig.contextSize),
      gpuLayers: config.gpuLayers ?? (delegateToFit ? undefined : optimalConfig.gpuLayers),
      parallelRequests: config.parallelRequests ?? optimalConfig.parallelRequests,
      flashAttention:
        config.flashAttention ?? (delegateToFit ? undefined : optimalConfig.flashAttention),
      cacheTypeK: llamaConfig.cacheTypeK ?? (delegateToFit ? undefined : optimalConfig.cacheTypeK),
      cacheTypeV: llamaConfig.cacheTypeV ?? (delegateToFit ? undefined : optimalConfig.cacheTypeV),
      cpuMoe: llamaConfig.cpuMoe ?? (delegateToFit ? undefined : optimalConfig.cpuMoe),
    } as ResolvedLlamaServerConfig;

    debugLog('[LlamaServer] Final config:', JSON.stringify(finalConfig));

    return finalConfig;
  }

  /**
   * Handle stdout from llama-server
   *
   * Parses llama.cpp output to determine actual log levels and strips
   * llama.cpp's formatting to avoid duplicate timestamps.
   *
   * @param data - Stdout data
   * @private
   */
  private handleStdout(data: string): void {
    if (this.logManager) {
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        // Parse llama.cpp output to determine actual log level
        const level = parseLlamaCppLogLevel(line);

        // Strip llama.cpp's formatting (timestamp + level prefix)
        // so LogManager doesn't create duplicate timestamps
        const cleanMessage = stripLlamaCppFormatting(line);

        this.logManager.write(cleanMessage, level).catch(() => void 0);
      }
    }
  }

  /**
   * Handle stderr from llama-server
   *
   * Parses llama.cpp output to determine actual log levels and strips
   * llama.cpp's formatting to avoid duplicate timestamps.
   * llama.cpp logs everything to stderr as [ERROR], but we intelligently
   * categorize based on content (HTTP requests, slot operations, etc.)
   *
   * @param data - Stderr data
   * @private
   */
  private handleStderr(data: string): void {
    if (this.logManager) {
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        // Parse llama.cpp output to determine actual log level
        const level = parseLlamaCppLogLevel(line);

        // Strip llama.cpp's formatting (timestamp + level prefix)
        // so LogManager doesn't create duplicate timestamps
        const cleanMessage = stripLlamaCppFormatting(line);

        this.logManager.write(cleanMessage, level).catch(() => void 0);
      }
    }
  }

  /**
   * Assert that an asynchronous startup continuation still owns lifecycle state.
   *
   * @private
   */
  private assertStartupAttemptActive(
    generation: number,
    pid?: number,
    expectedStatus: 'starting' | 'running' = 'starting'
  ): void {
    if (
      generation !== this.processGeneration ||
      this._status !== expectedStatus ||
      (pid !== undefined && this._pid !== pid)
    ) {
      throw new ServerError('llama-server stopped or exited during startup', {
        suggestion: 'Retry start() after the active lifecycle operation has completed',
      });
    }
  }

  /**
   * Invalidate callbacks and continuations belonging to one lifecycle attempt.
   *
   * @private
   */
  private invalidateProcessGeneration(generation: number): void {
    if (generation === this.processGeneration) {
      this.processGeneration++;
    }
  }

  /**
   * Handle spawn errors (e.g., ENOENT when binary not found)
   *
   * @param error - Spawn error
   * @param generation - Process attempt that emitted the error
   * @private
   */
  private handleSpawnError(error: Error, generation: number): void {
    if (generation !== this.processGeneration) {
      return;
    }
    if (this.logManager) {
      this.logManager.write(`Spawn error: ${error.message}`, 'error').catch(() => void 0);
    }
    // The error will be handled by the exit handler
    // which will emit a 'crashed' event
  }

  /**
   * Handle process exit
   *
   * @param code - Exit code
   * @param signal - Exit signal
   * @param generation - Process attempt that emitted the exit
   * @private
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
    if (generation !== this.processGeneration) {
      return;
    }

    const wasRunning = this._status === 'running';
    const killedByWatchdog = this.watchdogKill;
    this.watchdogKill = false;
    this.invalidateProcessGeneration(generation);

    // The watchdog must not keep polling a dead process
    this.teardownWatchdog();

    if (this.logManager) {
      this.logManager
        .write(`Process exited with code ${code}, signal ${signal}`, 'warn')
        .catch(() => void 0);
    }

    // Clear dead-process state before synchronous lifecycle listeners run.
    this._pid = undefined;
    this._port = 0;
    this._effectiveContextSize = undefined;
    this._effectiveParallelRequests = undefined;

    // Update status
    if (wasRunning && ((code !== 0 && code !== null) || killedByWatchdog)) {
      // Unexpected exit (or watchdog-detected hang) = crash
      this.setStatus('crashed');
      this.emitEvent('crashed', { code, signal });
      this.scheduleAutoRestartIfEnabled();
    } else {
      this.setStatus('stopped');
    }
  }

  /**
   * Schedule an auto-restart after a crash, if enabled and budget remains
   *
   * The restart runs on a backoff timer (1s, 2s, 4s, ...) — never inline from
   * the synchronous exit handler — and reuses the previously RESOLVED config
   * (concrete port; 'auto' is not re-run). A failed attempt counts against the
   * budget and leaves the status 'crashed'.
   *
   * @private
   */
  private scheduleAutoRestartIfEnabled(): void {
    const config = this._config as LlamaServerConfig | undefined;
    if (!config || config.autoRestart !== true) {
      return;
    }

    const maxRestarts = config.maxRestarts ?? 3;
    if (this.restartAttempts >= maxRestarts) {
      this.logManager
        ?.write(
          `Auto-restart budget exhausted (${maxRestarts} attempts) - staying crashed`,
          'error'
        )
        .catch(() => void 0);
      return;
    }

    this.restartAttempts++;
    const delay = 1000 * 2 ** (this.restartAttempts - 1);
    this.logManager
      ?.write(
        `Auto-restarting in ${delay}ms (attempt ${this.restartAttempts}/${maxRestarts})`,
        'warn'
      )
      .catch(() => void 0);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      // Bail if the world changed during the backoff (manual start/stop):
      // only a still-crashed server should be auto-restarted
      if (this._status !== 'crashed') {
        return;
      }
      const cancellationEpoch = this.autoRestartCancellationEpoch;
      this.isAutoRestarting = true;
      this.start(this._config!)
        .then((info) => {
          if (
            cancellationEpoch === this.autoRestartCancellationEpoch &&
            this._status === 'running'
          ) {
            this.emitEvent('restarted', info);
          }
        })
        .catch((error: unknown) => {
          if (
            cancellationEpoch !== this.autoRestartCancellationEpoch ||
            (error instanceof ServerError &&
              (error.details as Record<string, unknown>).startupCancelled === true)
          ) {
            return;
          }

          // start() already reset status via handleStartupError; reflect the
          // crash-loop state and let the next crash (if any) consume budget
          this.setStatus('crashed');
          this.logManager
            ?.write(
              `Auto-restart attempt ${this.restartAttempts} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'error'
            )
            .catch(() => void 0);
          // Try again if budget remains
          this.scheduleAutoRestartIfEnabled();
        })
        .finally(() => {
          this.isAutoRestarting = false;
        });
    }, delay);
    this.restartTimer.unref?.();
  }

  /**
   * Cancel a pending auto-restart timer
   * @private
   */
  private cancelPendingRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  /**
   * Start the hang watchdog if healthCheckInterval is configured
   * @private
   */
  private startWatchdog(config: ResolvedLlamaServerConfig): void {
    const interval = config.healthCheckInterval;
    if (interval === undefined || interval <= 0) {
      return;
    }

    this.teardownWatchdog();
    this.consecutiveHealthFailures = 0;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdogCheck();
    }, interval);
    this.watchdogTimer.unref?.();
  }

  /**
   * Single watchdog tick: poll health, emit events, kill on 3 consecutive failures
   * @private
   */
  private async runWatchdogCheck(): Promise<void> {
    if (this._status !== 'running' || this._port === 0) {
      return;
    }

    // Reentrancy guard: a hung server makes checkHealth take up to its full
    // timeout, which can exceed healthCheckInterval — overlapping ticks would
    // inflate the failure count and issue repeated kills
    if (this.watchdogCheckInFlight) {
      return;
    }
    this.watchdogCheckInFlight = true;

    try {
      let healthy = false;
      try {
        const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck, this.healthHost);
        healthy = health.status === 'ok';
      } catch {
        healthy = false;
      }

      // The world may have changed while the check was in flight (stop(),
      // crash): never emit events or kill for a server that is gone
      if (this._status !== 'running' || this._pid === undefined) {
        return;
      }

      if (healthy) {
        this.consecutiveHealthFailures = 0;
        this.emitEvent('health-check-ok', this.getInfo());
        return;
      }

      this.consecutiveHealthFailures++;
      this.emitEvent('health-check-failed', {
        consecutiveFailures: this.consecutiveHealthFailures,
        serverInfo: this.getInfo(),
      });

      if (this.consecutiveHealthFailures >= 3) {
        this.logManager
          ?.write(
            `Watchdog: ${this.consecutiveHealthFailures} consecutive health-check failures - killing hung process`,
            'error'
          )
          .catch(() => void 0);
        this.teardownWatchdog();
        // Mark so handleExit treats the (signal-terminated) exit as a crash,
        // feeding auto-restart when enabled
        this.watchdogKill = true;
        try {
          await this.processManager.kill(this._pid, DEFAULT_TIMEOUTS.serverStop);
        } catch {
          this.watchdogKill = false;
        }
      }
    } finally {
      this.watchdogCheckInFlight = false;
    }
  }

  /**
   * Stop the hang watchdog
   * @private
   */
  private teardownWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Occupancy safety rail: probe common llama-server ports for other instances
   *
   * Prevents accidental VRAM double-loading when another app (or a stray
   * process) is already serving a model. Candidates are fingerprinted via
   * GET /props — an endpoint the diffusion HTTP wrapper does NOT serve — so
   * this app's own diffusion server on 8081 is never flagged.
   *
   * @private
   */
  private async runOccupancyCheck(mode: 'warn' | 'strict' | 'off', ownPort: number): Promise<void> {
    if (mode === 'off') {
      return;
    }

    const probePorts = [8080, 8081, 8082, 8083].filter((p) => p !== ownPort);
    const results = await Promise.all(probePorts.map((p) => this.isLlamaServerAt(p)));
    const occupied = probePorts.filter((_, i) => results[i]);

    if (occupied.length === 0) {
      return;
    }

    const message =
      `Another llama-server appears to be running on port${occupied.length > 1 ? 's' : ''} ` +
      `${occupied.join(', ')} - starting a second one may double-load VRAM`;

    if (mode === 'strict') {
      throw new ServerError(message, {
        occupiedPorts: occupied,
        suggestion:
          "Stop the other server, or set occupancyCheck: 'warn' or 'off' to proceed anyway",
      });
    }

    console.warn(`[genai-electron] ${message}`);
    debugLog('[LlamaServer] occupancy check:', { occupied, mode });
  }

  /**
   * Fingerprint a port as a llama-server: /health responds AND /props exists
   * (the diffusion wrapper 404s /props; other HTTP servers rarely serve both)
   *
   * @private
   */
  private async isLlamaServerAt(port: number, timeout = 800): Promise<boolean> {
    const probe = async (pathname: string): Promise<boolean> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    if (!(await probe('/health'))) {
      return false;
    }
    return probe('/props');
  }
}
