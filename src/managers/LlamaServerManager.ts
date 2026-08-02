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
  LlamaAdaptiveProgressBudget,
  LlamaCalibrationProgress,
  LlamaCalibrationProbe,
  LlamaCalibrationReport,
  LlamaCalibrationRun,
  ResolvedLlamaCalibrationConfig,
} from '../types/index.js';
import {
  ContextConstraintError,
  ServerError,
  InsufficientResourcesError,
} from '../errors/index.js';
import {
  BINARY_VERSIONS,
  DEFAULT_PORTS,
  DEFAULT_TIMEOUTS,
  LLAMA_CALIBRATION_DEFAULTS,
  resolveLlamaCalibrationBudgetDefaults,
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
  deriveCeilingHints,
  estimateConfiguredProbeDuration,
  nextAdaptivePolicyAction,
  summarizeAdaptiveCellStates,
  summarizeAdaptiveTimingAdmission,
  type AdaptiveCandidate,
  type AdaptiveCell,
  type AdaptivePolicyState,
  type AdaptiveProbeAction,
  type AdaptiveTerminalAction,
} from '../utils/llama-adaptive-calibration-policy.js';
// TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
// Phase 2.10 / 3.8. Not re-exported from src/index.ts and inert unless a development harness arms it.
import { getCalibrationResourceShadow } from '../utils/llama-resource-guard-shadow.js';
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

function calibrationScenarioRequestCount(
  workload: ValidatedLlamaAdaptiveCalibrationConfig['workloads'][number]
): number {
  const completions = workload.kind === 'cold-prefill' ? 1 : workload.suffixes.length;
  return 1 + completions; // slot erase plus completion request(s)
}

function plannedCalibrationRequestCount(
  workloads: ValidatedLlamaAdaptiveCalibrationConfig['workloads'],
  samples: number,
  includeTokenization: boolean
): number {
  const tokenizations = includeTokenization
    ? workloads.reduce(
        (total, workload) =>
          total + (workload.kind === 'cold-prefill' ? 1 : workload.suffixes.length),
        0
      )
    : 0;
  const perPass = workloads.reduce(
    (total, workload) => total + calibrationScenarioRequestCount(workload),
    0
  );
  return tokenizations + perPass * (1 + samples); // one warmup plus timed repetitions
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
   * remains publicly stopped and the result is never auto-applied.
   */
  async calibrate(config: LlamaCalibrationConfig): Promise<LlamaCalibrationReport> {
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
    let adaptiveProgressSnapshot: {
      overallPercent: number;
      budget: LlamaAdaptiveProgressBudget;
    } = { overallPercent: 0, budget: { resolved: false } };
    const calibrationStartedAt = performance.now();
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
        return await this.runAdaptiveCalibration(
          validated,
          calibrationStartedAt,
          probes,
          (snapshot) => {
            adaptiveProgressSnapshot = snapshot;
          }
        );
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

      // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
      // Phase 2.10 / 3.8. Preparation is complete and no combo has launched yet, so this is the
      // exact-mode equivalent of the adaptive pre-`policyReadyAt` baseline placement.
      await getCalibrationResourceShadow()?.observeBaseline({
        source: this.systemInfo,
        strategy: 'exact',
        ...(validated.signal ? { signal: validated.signal } : {}),
      });

      for (let comboIndex = 0; comboIndex < candidates.length; comboIndex++) {
        const { combo, resolvedConfig, argvKey } = candidates[comboIndex]!;
        // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
        // Phase 2.10 / 3.8. Before `probeStartedAt` so the recorded probe duration keeps meaning
        // the launch/workload duration; the conclusion is recorded and never acted on.
        await getCalibrationResourceShadow()?.observePreLaunch({
          source: this.systemInfo,
          strategy: 'exact',
          probeOrdinal: probes.length,
          ...(validated.signal ? { signal: validated.signal } : {}),
        });
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
          runs.push(run);
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
            operationalStatus: run.status,
            memoryEvidence: observation.memoryEvidence,
            boundaryDecision: {
              classification: 'not-applicable',
              reason: 'Exact candidates do not participate in adaptive boundary search.',
            },
            loadTimeMs: run.loadTimeMs,
            effectiveContextSize: run.effectiveContextSize,
            effectiveParallelRequests: run.effectiveParallelRequests,
            workloadResults: run.workloadResults,
            scoreMs: run.scoreMs,
            durationMs: performance.now() - probeStartedAt,
            error: run.error,
            stderrTail: run.stderrTail,
            cleanup: observation.cleanup,
          });
        } catch (error) {
          const sanitized = redactCalibrationError(error, redactCalibrationText);
          const fatalObservation = calibrationErrorDetail(sanitized, 'probeObservation') as
            | RunCalibrationProbeObservation
            | undefined;
          if (fatalObservation?.run && fatalObservation.cleanup?.confirmed) {
            const { run } = fatalObservation;
            runs.push(run);
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
              operationalStatus: run.status,
              memoryEvidence: fatalObservation.memoryEvidence,
              boundaryDecision: {
                classification: 'not-applicable',
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
            });
            // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by
            // plan Phase 2.10 / 3.8. A fatally-failed probe whose teardown was still confirmed is
            // exactly the case where Phase 3.6 must know whether resources were stable. Skipped
            // after a caller abort so the abort rejection is not delayed.
            if (!validated.signal?.aborted) {
              await getCalibrationResourceShadow()?.observePostCleanup({
                source: this.systemInfo,
                strategy: 'exact',
                probeOrdinal: probes.length - 1,
                beforeInitialRead: () => {
                  this.systemInfo.clearCache();
                },
                ...(validated.signal ? { signal: validated.signal } : {}),
              });
            }
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
        // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
        // Phase 2.10 / 3.8. Teardown is confirmed here (the executor resolved), so the shadow owns
        // its own cooldown/clearCache/read/confirmation sequence measured from this instant. The
        // v0.19 debug-only post-run check below still runs unchanged, afterwards.
        await getCalibrationResourceShadow()?.observePostCleanup({
          source: this.systemInfo,
          strategy: 'exact',
          probeOrdinal: probes.length - 1,
          beforeInitialRead: () => {
            this.systemInfo.clearCache();
          },
          ...(validated.signal ? { signal: validated.signal } : {}),
        });
        this.systemInfo.clearCache();
        try {
          const currentMemory = this.systemInfo.getMemoryInfo();
          const currentGpu = await this.systemInfo.getGPUInfo();
          const legacyDrifted =
            currentMemory.available < capabilities.memory.available * 0.75 ||
            (capabilities.gpu.vramAvailable !== undefined &&
              currentGpu.vramAvailable !== undefined &&
              currentGpu.vramAvailable < capabilities.gpu.vramAvailable * 0.75);
          if (legacyDrifted) {
            debugLog(
              '[LlamaCalibration] available resources drifted by more than 25% during the sweep'
            );
          }
          // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
          // Phase 2.10 / 3.8. Records the v0.19 view of the same probe so traces can compare it
          // against the fixed-baseline view without another live run.
          getCalibrationResourceShadow()?.recordLegacyOutcome({
            strategy: 'exact',
            probeOrdinal: probes.length - 1,
            outcome: {
              hostDecreasePct:
                capabilities.memory.available > 0
                  ? ((capabilities.memory.available - currentMemory.available) /
                      capabilities.memory.available) *
                    100
                  : undefined,
              gpuDecreasePct:
                capabilities.gpu.vramAvailable !== undefined &&
                capabilities.gpu.vramAvailable > 0 &&
                currentGpu.vramAvailable !== undefined
                  ? ((capabilities.gpu.vramAvailable - currentGpu.vramAvailable) /
                      capabilities.gpu.vramAvailable) *
                    100
                  : undefined,
              resourceDriftStatus: legacyDrifted ? 'debug-25pct-drift' : 'debug-within-25pct',
            },
          });
        } catch (error) {
          debugLog('[LlamaCalibration] resource drift snapshot failed:', error);
        }
        if (comboIndex < combos.length - 1) {
          await calibrationDelay(LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs, validated.signal);
        }
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
      const report: LlamaCalibrationReport = {
        schemaVersion: 2,
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
          availableMemoryBytes: capabilities.memory.available,
          gpu: capabilities.gpu.available
            ? [
                {
                  name: capabilities.gpu.name ?? 'unknown',
                  vendor: capabilities.gpu.type ?? 'unknown',
                  memoryBytes: capabilities.gpu.vram,
                  availableMemoryBytes: capabilities.gpu.vramAvailable,
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
        },
        combos,
        skippedCombos,
        runs,
        probes,
        warnings: [],
        selected,
        ...(selected ? { selectionEvidence: 'single-launch-measurement' as const } : {}),
        confidence: 'single-launch-measurement',
      };
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
      const sanitized = redactCalibrationError(error, redactCalibrationText);
      if (validated.strategy === 'adaptive') {
        if (calibrationErrorDetail(sanitized, 'partialReport') !== undefined) {
          throw sanitized;
        }
        const terminalStatus = validated.signal?.aborted ? 'aborted' : 'failed';
        const payload: LlamaCalibrationProgress = {
          strategy: 'adaptive',
          phase: 'done',
          terminalStatus,
          overallPercent: adaptiveProgressSnapshot.overallPercent,
          elapsedMs: performance.now() - calibrationStartedAt,
          completedProbes: probes.length,
          budget: adaptiveProgressSnapshot.budget,
        };
        try {
          validated.onProgress?.(payload);
        } catch (progressError) {
          debugLog('[LlamaCalibration] adaptive terminal callback threw:', progressError);
        }
        try {
          this.emit('calibration-progress', { ...payload });
        } catch (progressError) {
          debugLog('[LlamaCalibration] adaptive terminal event listener threw:', progressError);
        }
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
                : (calibrationErrorCode(sanitized) ?? 'CALIBRATION_FAILED'),
            cause: redactCalibrationText(calibrationErrorMessage(sanitized)),
            partialReport: {
              schemaVersion: 2,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: terminalStatus,
              createdAt: new Date().toISOString(),
              probes,
              warnings: [],
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
            schemaVersion: 2,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'exact',
            status: 'aborted',
            createdAt: new Date().toISOString(),
            probes,
            warnings: [],
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
            schemaVersion: 2,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'exact',
            status: 'failed',
            createdAt: new Date().toISOString(),
            probes,
            warnings: [],
            cleanupConfirmed,
          },
        });
      }
      throw new ServerError('LLM calibration failed', {
        code: 'CALIBRATION_FAILED',
        cause: calibrationErrorMessage(sanitized),
        partialReport: {
          schemaVersion: 2,
          policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
          strategy: 'exact',
          status: 'failed',
          createdAt: new Date().toISOString(),
          probes,
          warnings: [],
          cleanupConfirmed,
        },
      });
    } finally {
      this.binaryPath = savedBinaryPath;
      this.logManager = savedLogManager;
      this.systemInfo.clearCache();
      this.calibrating = false;
    }
  }

  private async runAdaptiveCalibration(
    validated: ValidatedLlamaAdaptiveCalibrationConfig,
    calibrationStartedAt: number,
    publicProbes: LlamaCalibrationProbe[],
    onProgressSnapshot: (snapshot: {
      overallPercent: number;
      budget: LlamaAdaptiveProgressBudget;
    }) => void
  ): Promise<LlamaCalibrationReport> {
    const redact = createCalibrationPromptRedactor(validated.workloads);
    const warnings: string[] = [];
    const tokenCounts = new Map<string, readonly number[]>();
    const verifiedProfiles = new Map<
      number,
      { effectiveContextSize: number; effectiveParallelRequests: number }
    >();
    let lastProgress = 0;
    let progressBudget: LlamaAdaptiveProgressBudget = { resolved: false };
    const policyTiming: { readyAt?: number } = {};
    let state: AdaptivePolicyState | undefined;

    const resolvedProgressBudget = (): LlamaAdaptiveProgressBudget => {
      if (!state || policyTiming.readyAt === undefined) return progressBudget;
      const remainingWallTimeMs = Math.max(
        0,
        state.budgets.maxWallTimeMs - (performance.now() - policyTiming.readyAt)
      );
      return {
        resolved: true,
        targetProbes: state.budgets.targetProbes,
        maxProbes: state.budgets.maxProbes,
        finalistReserve: state.budgets.finalistReserve,
        maxWallTimeMs: state.budgets.maxWallTimeMs,
        finalistTimeReserveMs: state.budgets.finalistTimeReserveMs,
        remainingWallTimeMs,
        probeReserveActive:
          state.budgets.maxProbes - publicProbes.length <= state.budgets.finalistReserve,
        timeReserveActive: remainingWallTimeMs <= state.budgets.finalistTimeReserveMs,
      };
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
          | 'budget-exhausted'
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
      const maxProbes = progressBudget.resolved ? progressBudget.maxProbes : 1;
      const phaseFraction: Record<string, number> = {
        starting: 0.05,
        'capacity-check': 0.1,
        warmup: 0.15,
        sampling:
          0.2 +
          (0.7 *
            ((options.workloadIndex ?? 0) * (options.sampleCount ?? validated.samples) +
              (options.sampleIndex ?? 0))) /
            Math.max(1, validated.workloads.length * (options.sampleCount ?? validated.samples)),
        stopping: 0.95,
      };
      const activeFraction = options.activeProbe?.probePhase
        ? (phaseFraction[options.activeProbe.probePhase] ?? 0)
        : 0;
      const calculated =
        phase === 'done'
          ? options.terminalStatus === 'aborted' || options.terminalStatus === 'failed'
            ? lastProgress
            : 100
          : progressBudget.resolved
            ? ((publicProbes.length + activeFraction) / maxProbes) * 100
            : 0;
      lastProgress = Math.max(lastProgress, Math.min(100, calculated));
      const payload: LlamaCalibrationProgress =
        phase === 'done'
          ? {
              strategy: 'adaptive',
              phase,
              terminalStatus: options.terminalStatus ?? 'failed',
              overallPercent: lastProgress,
              elapsedMs: performance.now() - calibrationStartedAt,
              completedProbes: publicProbes.length,
              budget: progressBudget,
            }
          : {
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

    emitProgress('preparing');
    validated.signal?.throwIfAborted();

    const firstProbeRequestCount = plannedCalibrationRequestCount(
      validated.workloads,
      LLAMA_CALIBRATION_DEFAULTS.searchSamples,
      true
    );
    const configuredDurationEstimate = estimateConfiguredProbeDuration({
      startupTimeoutMs: validated.startupTimeoutMs,
      requestTimeoutMs: validated.requestTimeoutMs,
      serverStopTimeoutMs: DEFAULT_TIMEOUTS.serverStop,
      plannedPostStartupRequestCount: firstProbeRequestCount,
      maxRunnerStartAttempts: LLAMA_CALIBRATION_DEFAULTS.maxRunnerStartAttempts,
      capacityCheckTimeoutCapMs: LLAMA_CALIBRATION_DEFAULTS.capacityCheckTimeoutCapMs,
      processExitConfirmationMs: LLAMA_CALIBRATION_DEFAULTS.processExitConfirmationMs,
      processExitSettleGraceMs: LLAMA_CALIBRATION_DEFAULTS.processExitSettleGraceMs,
    });
    const maximumEnumeratedCellCount =
      validated.profiles.length *
      (validated.fixedConfig.swaFull === undefined ? 2 : 1) *
      (validated.includeKvCacheComparison ? 2 : 1);
    const preProvisioningWallTimeMs =
      validated.maxWallTimeMs ??
      resolveLlamaCalibrationBudgetDefaults(maximumEnumeratedCellCount).maxWallTimeMs;
    if (configuredDurationEstimate.estimateMs > preProvisioningWallTimeMs) {
      warnings.push(
        `The configured conservative first-probe estimate (${Math.round(
          configuredDurationEstimate.estimateMs
        )} ms) exceeds the pre-provisioning wall-time allowance (${preProvisioningWallTimeMs} ms); calibration may end budget-exhausted before search evidence is available.`
      );
    }

    const model = await this.modelManager.getModelInfo(validated.modelId);
    validated.signal?.throwIfAborted();
    if (model.type !== 'llm') {
      throw new ServerError('LLM calibration requires an LLM model', {
        code: 'CALIBRATION_INVALID_CONFIG',
        modelId: model.id,
      });
    }
    const preflightHasSharedPrefix = validated.workloads.some(
      (workload) => workload.kind === 'shared-prefix'
    );
    const preflightSlidingWindow = getSlidingWindow(model);
    const preflightStructuralCellCount = validated.profiles.reduce((count, profile) => {
      const swaRelevant =
        validated.fixedConfig.swaFull === undefined &&
        preflightHasSharedPrefix &&
        preflightSlidingWindow !== undefined &&
        Math.floor(profile.contextSize / profile.parallelRequests) > preflightSlidingWindow;
      return count + (swaRelevant ? 2 : 1);
    }, 0);
    const preflightCellCount =
      preflightStructuralCellCount * (validated.includeKvCacheComparison ? 2 : 1);
    const preflightBudgetDefaults = resolveLlamaCalibrationBudgetDefaults(preflightCellCount);
    const preflightMaxProbes = validated.maxProbes ?? preflightBudgetDefaults.maxProbes;
    const preflightMaxWallTimeMs = validated.maxWallTimeMs ?? preflightBudgetDefaults.maxWallTimeMs;
    if (preflightMaxProbes <= preflightBudgetDefaults.finalistReserve) {
      throw new ServerError('maxProbes must exceed the resolved finalist reserve', {
        code: 'CALIBRATION_INVALID_CONFIG',
        maxProbes: preflightMaxProbes,
        finalistReserve: preflightBudgetDefaults.finalistReserve,
        cellCount: preflightCellCount,
      });
    }
    if (preflightMaxWallTimeMs <= preflightBudgetDefaults.finalistTimeReserveMs) {
      throw new ServerError('maxWallTimeMs must exceed the resolved finalist time reserve', {
        code: 'CALIBRATION_INVALID_CONFIG',
        maxWallTimeMs: preflightMaxWallTimeMs,
        finalistTimeReserveMs: preflightBudgetDefaults.finalistTimeReserveMs,
        cellCount: preflightCellCount,
      });
    }
    await this.initializeLogManager(
      'llama-server.log',
      `Adaptive LLM runtime calibration starting for model ${model.id}`
    );
    validated.signal?.throwIfAborted();
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

    this.binaryPath = await this.ensureBinary(model.path);
    validated.signal?.throwIfAborted();
    const calibrationBinaryPath = this.binaryPath;
    const binaryIdentity = await getInstalledBinaryIdentity(
      'llama',
      calibrationBinaryPath,
      BINARY_VERSIONS.llamaServer.version
    );
    validated.signal?.throwIfAborted();
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
      budgetOverrides: {
        targetProbes: validated.targetProbes,
        maxProbes: validated.maxProbes,
        maxWallTimeMs: validated.maxWallTimeMs,
      },
      unobservedProbeDurationEstimateMs: configuredDurationEstimate.estimateMs,
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
    if (state.budgets.maxProbes <= state.budgets.finalistReserve) {
      throw new ServerError('maxProbes must exceed the resolved finalist reserve', {
        code: 'CALIBRATION_INVALID_CONFIG',
        maxProbes: state.budgets.maxProbes,
        finalistReserve: state.budgets.finalistReserve,
      });
    }
    if (state.budgets.maxWallTimeMs <= state.budgets.finalistTimeReserveMs) {
      throw new ServerError('maxWallTimeMs must exceed the resolved finalist time reserve', {
        code: 'CALIBRATION_INVALID_CONFIG',
        maxWallTimeMs: state.budgets.maxWallTimeMs,
        finalistTimeReserveMs: state.budgets.finalistTimeReserveMs,
      });
    }
    // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
    // Phase 2.10 / 3.8. Provisioning, profile/cell preparation, and binary readiness are complete,
    // and the adaptive probe wall clock has not started yet: plan decision 2's baseline placement.
    await getCalibrationResourceShadow()?.observeBaseline({
      source: this.systemInfo,
      strategy: 'adaptive',
      ...(validated.signal ? { signal: validated.signal } : {}),
    });
    const policyReadyAt = performance.now();
    policyTiming.readyAt = policyReadyAt;
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
    const captureAvailableResources = async (
      signal?: AbortSignal
    ): Promise<{
      hostAvailableBytes?: number;
      gpuAvailableBytes?: number;
      /** False when the platform telemetry refresh failed, so the reading may be from a degraded regime. */
      telemetryRefreshed?: boolean;
    }> => {
      const capture = async () => {
        let hostAvailableBytes: number | undefined;
        let gpuAvailableBytes: number | undefined;
        let telemetryRefreshed = true;
        try {
          // Keep every snapshot in one measurement regime. The Windows
          // standby-aware reading has a 60 s TTL refreshed only by detect(),
          // which calibration calls once at preparation; after it expires
          // getMemoryInfo() falls back to os.freemem(), which excludes the
          // standby list. A probe's own released mmap pages then read as a large
          // availability drop against a standby-aware baseline, and the drift
          // guard rejects the heaviest cells for a purely instrumental reason.
          await this.systemInfo.refreshMemoryTelemetry();
        } catch (error) {
          // A failed refresh may silently degrade the reading to a different
          // measurement regime. Report it rather than letting the degraded value
          // look like an ordinary observation — two consecutive degraded readings
          // agree with each other and would otherwise re-anchor the drift
          // reference onto an instrument artifact.
          telemetryRefreshed = false;
          debugLog('[LlamaCalibration] memory telemetry refresh failed:', error);
        }
        try {
          hostAvailableBytes = this.systemInfo.getMemoryInfo().available;
        } catch (error) {
          debugLog('[LlamaCalibration] host-memory snapshot unavailable:', error);
        }
        try {
          gpuAvailableBytes = (await this.systemInfo.getGPUInfo()).vramAvailable;
        } catch (error) {
          debugLog('[LlamaCalibration] GPU-memory snapshot unavailable:', error);
        }
        return { hostAvailableBytes, gpuAvailableBytes, telemetryRefreshed };
      };
      if (!signal) return capture();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (snapshot: {
          hostAvailableBytes?: number;
          gpuAvailableBytes?: number;
          telemetryRefreshed?: boolean;
        }): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(snapshot);
        };
        const onAbort = (): void => finish({});
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        void capture().then(finish);
      });
    };
    const resourceMetric = (beforeBytes?: number, afterBytes?: number) => {
      if (
        beforeBytes === undefined ||
        afterBytes === undefined ||
        !Number.isFinite(beforeBytes) ||
        !Number.isFinite(afterBytes) ||
        beforeBytes <= 0
      ) {
        return {
          beforeBytes,
          afterBytes,
          comparability: 'unavailable' as const,
        };
      }
      const decreasePct = ((beforeBytes - afterBytes) / beforeBytes) * 100;
      return {
        beforeBytes,
        afterBytes,
        comparability:
          decreasePct > LLAMA_CALIBRATION_DEFAULTS.resourceDriftThresholdPct
            ? ('material' as const)
            : ('available' as const),
        decreasePct,
      };
    };
    /**
     * Whether two availability readings describe the same settled level. Used to
     * tell a one-off step change (tolerable: re-anchor and continue) from an
     * environment that is still moving (not tolerable: the launches are not
     * comparable). Metrics missing from either reading are skipped; if nothing is
     * comparable the levels cannot be called settled.
     *
     * The tolerance is `resourceSettledTolerancePct`, deliberately far tighter
     * than the drift threshold: at the drift threshold a monotonically declining
     * machine would re-anchor on every probe and never be reported as unstable.
     */
    const comparableResourceLevels = (
      previous: { hostAvailableBytes?: number; gpuAvailableBytes?: number },
      current: { hostAvailableBytes?: number; gpuAvailableBytes?: number }
    ): boolean => {
      const pairs: [number | undefined, number | undefined][] = [
        [previous.hostAvailableBytes, current.hostAvailableBytes],
        [previous.gpuAvailableBytes, current.gpuAvailableBytes],
      ];
      let compared = 0;
      for (const [left, right] of pairs) {
        if (left === undefined || right === undefined) continue;
        if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0) continue;
        compared += 1;
        const changePct = (Math.abs(right - left) / left) * 100;
        if (changePct > LLAMA_CALIBRATION_DEFAULTS.resourceSettledTolerancePct) return false;
      }
      return compared > 0;
    };
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

    const materialDriftAttempts = new Map<string, number>();
    const materialDriftReadings = new Map<
      string,
      { hostAvailableBytes?: number; gpuAvailableBytes?: number }
    >();
    // Re-anchorable reference level. A confirmed one-off step change (the user
    // opens a browser mid-run) shifts every later reading against a t=0 anchor
    // even though those readings remain comparable with each other. Probes carry
    // the regime they were measured in so reproduction never spans a step.
    let resourceRegime = 0;
    const resourceBaseline: {
      hostAvailableBytes?: number;
      gpuAvailableBytes?: number;
    } = {};
    const inheritedCeilingByCell = new Map<
      string,
      { gpuLayers: number; sourceCellId: string; reason: string }
    >();
    let terminal: AdaptiveTerminalAction | undefined;
    while (!terminal) {
      const action = nextAdaptivePolicyAction(state);
      if (action.kind === 'terminal') {
        terminal = action;
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
        terminal = {
          kind: 'terminal',
          status: 'budget-exhausted',
          reason: 'smallest-profile workload-capacity preflight was not completed',
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
          .filter(
            (evidence) =>
              evidence.boundaryDecision === 'admissible' &&
              evidence.resourceDriftStatus !== 'material'
          )
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
      emitProgress(outerPhase, { activeProbe, sampleCount });
      const probeStartedAt = performance.now();
      const remainingWallTimeMs = Math.max(
        1,
        state.budgets.maxWallTimeMs - (performance.now() - policyReadyAt)
      );
      const deadlineController = new AbortController();
      const deadlineTimer = setTimeout(
        () => deadlineController.abort(new DOMException('Calibration deadline', 'TimeoutError')),
        remainingWallTimeMs
      );
      const probeSignal = validated.signal
        ? AbortSignal.any([validated.signal, deadlineController.signal])
        : deadlineController.signal;
      const resourcesBefore = await captureAvailableResources(probeSignal);
      resourceBaseline.hostAvailableBytes ??= resourcesBefore.hostAvailableBytes;
      resourceBaseline.gpuAvailableBytes ??= resourcesBefore.gpuAvailableBytes;
      // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
      // Phase 2.10 / 3.8. Placed after the v0.19 pre-launch capture so that capture keeps its
      // original position relative to preparation, and immediately before the executor invocation.
      // Uses the probe signal the surrounding code uses; the conclusion is recorded, never acted on.
      const shadowProbeOrdinal = publicProbes.length;
      await getCalibrationResourceShadow()?.observePreLaunch({
        source: this.systemInfo,
        strategy: 'adaptive',
        probeOrdinal: shadowProbeOrdinal,
        signal: probeSignal,
      });
      try {
        const observation = await this.calibrationProbeExecutor({
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
          signal: probeSignal,
          onProgress: ({ phase, workloadIndex, sampleIndex }) => {
            emitProgress(outerPhase, {
              activeProbe: { ...activeProbe, probePhase: phase },
              workloadIndex,
              sampleIndex,
              sampleCount,
            });
          },
        });
        const durationMs = performance.now() - probeStartedAt;
        // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
        // Phase 2.10 / 3.8. Teardown is confirmed here (the executor resolved) and `durationMs` is
        // already fixed, so the shadow's cooldown/clearCache/read/confirmation sequence is measured
        // from the real teardown instant without inflating the recorded probe duration. The v0.19
        // cooldown/capture/re-anchor block below runs unchanged, afterwards; its own reading is
        // therefore taken later in wall-clock terms than in a disarmed run, which is recorded
        // rather than hidden.
        await getCalibrationResourceShadow()?.observePostCleanup({
          source: this.systemInfo,
          strategy: 'adaptive',
          probeOrdinal: shadowProbeOrdinal,
          beforeInitialRead: () => {
            this.systemInfo.clearCache();
          },
          signal: probeSignal,
        });
        // Let process teardown and OS/GPU accounting settle before treating an
        // availability delta as environmental drift. An immediate snapshot is
        // dominated by the probe's own model mappings on Windows.
        const remainingForCooldownMs =
          state.budgets.maxWallTimeMs - (performance.now() - policyReadyAt);
        const cooldownCompleted =
          remainingForCooldownMs >= LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs;
        if (cooldownCompleted) {
          await calibrationDelay(LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs);
          this.systemInfo.clearCache();
        }
        const resourcesAfter = cooldownCompleted
          ? await captureAvailableResources(probeSignal)
          : {};
        const run = observation.run;
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
        const terminatedAtAdaptiveCap =
          run.status === 'request-timeout' && observation.aggregateScoreLowerBoundMs !== undefined;
        const aggregateLowerBoundMs = terminatedAtAdaptiveCap
          ? observation.aggregateScoreLowerBoundMs
          : undefined;
        const currentMinimum = (before?: number, after?: number): number | undefined =>
          before === undefined || after === undefined ? undefined : Math.min(before, after);
        const currentReading = {
          hostAvailableBytes: currentMinimum(
            resourcesBefore.hostAvailableBytes,
            resourcesAfter.hostAvailableBytes
          ),
          gpuAvailableBytes: currentMinimum(
            resourcesBefore.gpuAvailableBytes,
            resourcesAfter.gpuAvailableBytes
          ),
        };
        const measureAgainstBaseline = () => ({
          host: resourceMetric(
            resourceBaseline.hostAvailableBytes,
            currentReading.hostAvailableBytes
          ),
          gpu: resourceMetric(resourceBaseline.gpuAvailableBytes, currentReading.gpuAvailableBytes),
        });
        let measured = measureAgainstBaseline();
        const driftKey = `${cell.id}:${action.gpuLayers}`;
        const priorDriftAttempts = materialDriftAttempts.get(driftKey) ?? 0;
        const isMaterial = () =>
          measured.host.comparability === 'material' || measured.gpu.comparability === 'material';
        const regimeChangeWarnings: string[] = [];
        const telemetryTrustworthy =
          resourcesBefore.telemetryRefreshed !== false &&
          resourcesAfter.telemetryRefreshed !== false;
        if (!telemetryTrustworthy) {
          regimeChangeWarnings.push(
            'Platform memory-telemetry refresh failed for this probe; the availability reading may come from a degraded measurement regime and cannot re-anchor the drift reference.'
          );
        }
        // A repeat that reproduces the same new level is a settled environment,
        // not an unstable one: re-anchor to it, start a new regime, and keep
        // searching. Readings that are still moving stay material and terminate
        // the run as before. A degraded reading is never allowed to re-anchor:
        // two consecutive instrument artifacts agree with each other and would
        // otherwise move the baseline onto the artifact.
        if (
          isMaterial() &&
          telemetryTrustworthy &&
          observation.memoryEvidence.classification !== 'confirmed' &&
          priorDriftAttempts >= LLAMA_CALIBRATION_DEFAULTS.resourceDriftRetries
        ) {
          const previous = materialDriftReadings.get(driftKey);
          if (previous && comparableResourceLevels(previous, currentReading)) {
            if (currentReading.hostAvailableBytes !== undefined) {
              resourceBaseline.hostAvailableBytes = currentReading.hostAvailableBytes;
            }
            if (currentReading.gpuAvailableBytes !== undefined) {
              resourceBaseline.gpuAvailableBytes = currentReading.gpuAvailableBytes;
            }
            resourceRegime += 1;
            measured = measureAgainstBaseline();
            materialDriftAttempts.delete(driftKey);
            materialDriftReadings.delete(driftKey);
            regimeChangeWarnings.push(
              `Available resources settled at a new level; calibration re-anchored and continued in resource regime ${resourceRegime}. Launches are only reproduced within one regime.`
            );
          }
        }
        const hostAvailableMemory = measured.host;
        const gpuAvailableMemory = measured.gpu;
        const diagnosticWarnings: string[] = [...regimeChangeWarnings];
        if (hostAvailableMemory.comparability === 'unavailable') {
          diagnosticWarnings.push(
            'Host available-memory telemetry was unavailable for one or both probe snapshots.'
          );
        }
        if (gpuAvailableMemory.comparability === 'unavailable') {
          diagnosticWarnings.push(
            'GPU available-memory telemetry was unavailable for one or both probe snapshots.'
          );
        }
        if (!cooldownCompleted) {
          diagnosticWarnings.push(
            'Post-probe resource telemetry was skipped because the hard deadline did not leave a complete cooldown interval.'
          );
        }
        const materialResourceDrift =
          hostAvailableMemory.comparability === 'material' ||
          gpuAvailableMemory.comparability === 'material';
        if (materialResourceDrift) {
          diagnosticWarnings.push(
            `Available resources fell by more than ${LLAMA_CALIBRATION_DEFAULTS.resourceDriftThresholdPct}% during this decision-relevant probe.`
          );
        }
        for (const warning of diagnosticWarnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
        const diagnostics = {
          kvBytesEstimate:
            estimateKVBytesPerToken(model, resolvedConfig.cacheTypeK, resolvedConfig.cacheTypeV) *
            resolvedConfig.contextSize,
          modelBytes: model.size,
          expertWeightBytes: model.ggufMetadata?.expert_weights_bytes,
          hostAvailableBytes: resourcesAfter.hostAvailableBytes,
          gpuAvailableBytes: resourcesAfter.gpuAvailableBytes,
          measurementAvailability: {
            hostAvailableBytes:
              hostAvailableMemory.comparability === 'unavailable'
                ? ('unavailable' as const)
                : ('available' as const),
            gpuAvailableBytes:
              gpuAvailableMemory.comparability === 'unavailable'
                ? ('unavailable' as const)
                : ('available' as const),
          },
          warnings: diagnosticWarnings,
        };
        const driftCanInvalidateDecision =
          materialResourceDrift && observation.memoryEvidence.classification !== 'confirmed';
        if (driftCanInvalidateDecision) {
          materialDriftAttempts.set(driftKey, priorDriftAttempts + 1);
          materialDriftReadings.set(driftKey, currentReading);
        }
        const persistentResourceDrift =
          driftCanInvalidateDecision &&
          priorDriftAttempts >= LLAMA_CALIBRATION_DEFAULTS.resourceDriftRetries;
        const resourceDriftStatus = materialResourceDrift
          ? ('material' as const)
          : hostAvailableMemory.comparability === 'unavailable' &&
              gpuAvailableMemory.comparability === 'unavailable'
            ? ('unavailable' as const)
            : ('available' as const);
        // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
        // Phase 2.10 / 3.8. Records the v0.19 view of this probe (its measured decrease pcts, its
        // regime, and any re-anchor warning) beside the shadow boundaries, so one trace can compare
        // the old min(pre, post)/re-anchoring view with the fixed-baseline view.
        getCalibrationResourceShadow()?.recordLegacyOutcome({
          strategy: 'adaptive',
          probeOrdinal: shadowProbeOrdinal,
          outcome: {
            hostDecreasePct: hostAvailableMemory.decreasePct,
            gpuDecreasePct: gpuAvailableMemory.decreasePct,
            hostComparability: hostAvailableMemory.comparability,
            gpuComparability: gpuAvailableMemory.comparability,
            resourceRegime,
            resourceDriftStatus,
            warnings: diagnosticWarnings,
          },
        });
        const policyObservation = {
          cellId: cell.id,
          gpuLayers: action.gpuLayers,
          purpose: action.purpose,
          fidelity: action.fidelity,
          operationalStatus: run.status,
          memoryEvidence: observation.memoryEvidence.classification,
          scoreMs: run.scoreMs,
          terminatedAtAdaptiveCap,
          aggregateLowerBoundMs,
          resourceDriftStatus,
          resourceRegime,
          durationMs,
          diagnostics,
        } as const;
        let evidence:
          | AdaptivePolicyState['evidence'][number]
          | {
              index: number;
              boundaryDecision: 'ambiguous';
              decisionReason: string;
            };
        if (persistentResourceDrift) {
          evidence = {
            index: state.evidence.length,
            boundaryDecision: 'ambiguous',
            decisionReason: 'persistent-resource-drift',
          };
          terminal = {
            kind: 'terminal',
            status: 'budget-exhausted',
            reason: 'persistent decision-relevant resource drift prevented comparable evidence',
          };
          if (!warnings.includes(terminal.reason)) warnings.push(terminal.reason);
        } else {
          const nextState = applyAdaptivePolicyObservation(state, policyObservation);
          // Admission is based on the whole adaptive search clock, including cooldown and resource
          // snapshots, while the probe record's duration remains the launch/workload duration.
          state = {
            ...nextState,
            elapsedMs: Math.max(nextState.elapsedMs, performance.now() - policyReadyAt),
          };
          evidence = state.evidence.at(-1)!;
        }
        publicProbes.push({
          probeIndex: publicProbes.length,
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
          operationalStatus: run.status,
          memoryEvidence: observation.memoryEvidence,
          boundaryDecision: {
            classification: evidence.boundaryDecision,
            reason: evidence.decisionReason,
          },
          resourceRegime,
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
            hostAvailableMemory,
            gpuAvailableMemory,
            warnings: diagnosticWarnings,
          },
          error: run.error,
          stderrTail: run.stderrTail,
          cleanup: observation.cleanup,
        });
      } catch (error) {
        const sanitized = redactCalibrationError(error, redact);
        const sanitizedCode = calibrationErrorCode(sanitized);
        const fatalObservation = calibrationErrorDetail(sanitized, 'probeObservation') as
          | RunCalibrationProbeObservation
          | undefined;
        if (fatalObservation?.run && fatalObservation.cleanup?.confirmed) {
          const { run } = fatalObservation;
          publicProbes.push({
            probeIndex: publicProbes.length,
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
            operationalStatus: run.status,
            memoryEvidence: fatalObservation.memoryEvidence,
            boundaryDecision: {
              classification: 'ambiguous',
              reason: sanitizedCode ?? 'fatal-probe-validation',
            },
            resourceRegime,
            loadTimeMs: run.loadTimeMs,
            effectiveContextSize: run.effectiveContextSize,
            effectiveParallelRequests: run.effectiveParallelRequests,
            workloadResults: run.workloadResults,
            scoreMs: run.scoreMs,
            durationMs: performance.now() - probeStartedAt,
            terminationReason: sanitizedCode ?? 'fatal-probe-validation',
            error: run.error,
            stderrTail: run.stderrTail,
            cleanup: fatalObservation.cleanup,
          });
          // TEMPORARY Phase-0.8 shadow observation — converted to enforcement and deleted by plan
          // Phase 2.10 / 3.8. Teardown was confirmed even though the probe failed fatally, which is
          // precisely the precedence case Phase 2.5 has to decide. Skipped once the probe signal
          // has aborted so neither a caller abort nor the internal deadline is delayed.
          if (!probeSignal.aborted) {
            await getCalibrationResourceShadow()?.observePostCleanup({
              source: this.systemInfo,
              strategy: 'adaptive',
              probeOrdinal: shadowProbeOrdinal,
              beforeInitialRead: () => {
                this.systemInfo.clearCache();
              },
              signal: probeSignal,
            });
          }
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
            probeIndex: publicProbes.length,
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
            resourceRegime,
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
              schemaVersion: 2,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: 'failed',
              createdAt: new Date().toISOString(),
              probes: publicProbes,
              warnings,
              cleanupConfirmed: false,
            },
          });
        }
        const interruptedByCaller = validated.signal?.aborted === true;
        const interruptedByDeadline = deadlineController.signal.aborted;
        if (
          (interruptedByCaller || interruptedByDeadline) &&
          sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED'
        ) {
          publicProbes.push({
            probeIndex: publicProbes.length,
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
            operationalStatus: interruptedByDeadline ? 'request-timeout' : 'error',
            memoryEvidence: {
              classification: 'unknown',
              reason: interruptedByDeadline
                ? 'The internal calibration deadline interrupted this launch.'
                : 'The caller aborted this launch.',
              source: 'timeout',
            },
            boundaryDecision: {
              classification: 'ambiguous',
              reason: interruptedByDeadline ? 'internal-deadline' : 'caller-abort',
            },
            resourceRegime,
            workloadResults: validated.workloads.map((workload) => ({
              workloadId: workload.id,
              kind: workload.kind,
              workloadHash: workloadSignature(workload).hash,
              weight: workload.weight,
              samples: [],
              error: interruptedByDeadline ? 'internal-deadline' : 'caller-abort',
            })),
            durationMs: performance.now() - probeStartedAt,
            terminationReason: interruptedByDeadline ? 'internal-deadline' : 'caller-abort',
            cleanup: { confirmed: true, durationMs: 0 },
          });
        }
        if (validated.signal?.aborted) {
          emitProgress('done', { terminalStatus: 'aborted' });
          throw new ServerError('LLM calibration aborted', {
            code: 'CALIBRATION_ABORTED',
            cause: redact(String(validated.signal.reason ?? calibrationErrorMessage(sanitized))),
            partialReport: {
              schemaVersion: 2,
              policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
              strategy: 'adaptive',
              status: 'aborted',
              createdAt: new Date().toISOString(),
              probes: publicProbes,
              warnings,
              cleanupConfirmed: sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED',
            },
          });
        }
        if (deadlineController.signal.aborted) {
          terminal = {
            kind: 'terminal',
            status: 'budget-exhausted',
            reason: 'the internal calibration wall-time deadline interrupted the active probe',
          };
          warnings.push(terminal.reason);
          break;
        }
        emitProgress('done', { terminalStatus: 'failed' });
        throw new ServerError('Adaptive LLM calibration failed', {
          code: calibrationErrorCode(sanitized) ?? 'CALIBRATION_FAILED',
          cause: calibrationErrorMessage(sanitized),
          partialReport: {
            schemaVersion: 2,
            policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
            strategy: 'adaptive',
            status: 'failed',
            createdAt: new Date().toISOString(),
            probes: publicProbes,
            warnings,
            cleanupConfirmed: sanitizedCode !== 'CALIBRATION_CLEANUP_FAILED',
          },
        });
      } finally {
        clearTimeout(deadlineTimer);
      }
      this.systemInfo.clearCache();
      validated.signal?.throwIfAborted();
      if (performance.now() - policyReadyAt >= state.budgets.maxWallTimeMs) {
        terminal = {
          kind: 'terminal',
          status: 'budget-exhausted',
          reason: 'the adaptive calibration wall-time budget was exhausted',
        };
        break;
      }
    }

    terminal ??= nextAdaptivePolicyAction(state) as AdaptiveTerminalAction;
    const candidateToRecommendation = (
      candidate: AdaptiveCandidate | undefined
    ): LlamaCalibrationReport extends infer _Report
      ?
          | {
              profileIndex: number;
              cellId: string;
              startConfig: ResolvedLlamaCalibrationConfig;
              scoreMs: number;
            }
          | undefined
      : never => {
      if (!candidate) return undefined;
      const cell = cellById.get(candidate.cellId)!;
      return {
        profileIndex: candidate.profileIndex,
        cellId: candidate.cellId,
        startConfig: resolveCellConfig(cell, candidate.gpuLayers),
        scoreMs: candidate.scoreMs,
      };
    };
    const selected = candidateToRecommendation(terminal.selected);
    const provisional = candidateToRecommendation(terminal.provisional);
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
    const budgetDefaults = resolveLlamaCalibrationBudgetDefaults(state.cells.length);
    const timingAdmission = summarizeAdaptiveTimingAdmission(state);
    const budgetElapsedMs = performance.now() - policyReadyAt;
    const report: LlamaCalibrationReport = {
      schemaVersion: 2,
      policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
      createdAt: new Date().toISOString(),
      strategy: 'adaptive',
      status: terminal.status,
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
        availableMemoryBytes: capabilities.memory.available,
        gpu: capabilities.gpu.available
          ? [
              {
                name: capabilities.gpu.name ?? 'unknown',
                vendor: capabilities.gpu.type ?? 'unknown',
                memoryBytes: capabilities.gpu.vram,
                availableMemoryBytes: capabilities.gpu.vramAvailable,
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
      },
      probes: publicProbes,
      warnings,
      profiles: profileReports,
      schedulingProfileIndexes: schedulingProfiles.map((entry) => entry.profileIndex),
      workloadComparability: tokenCounts.size > 0 ? 'verified' : 'unverified',
      cells: cellReports,
      budget: {
        formulaVersion: budgetDefaults.formulaVersion,
        cellCount: state.cells.length,
        targetProbes: state.budgets.targetProbes,
        maxProbes: state.budgets.maxProbes,
        finalistReserve: state.budgets.finalistReserve,
        maxWallTimeMs: state.budgets.maxWallTimeMs,
        finalistTimeReserveMs: state.budgets.finalistTimeReserveMs,
        effectiveFinalistTimeReserveMs: timingAdmission.effectiveFinalistTimeReserveMs,
        completedProbes: publicProbes.length,
        elapsedMs: budgetElapsedMs,
        cleanupOverrunMs: Math.max(0, budgetElapsedMs - state.budgets.maxWallTimeMs),
        overrides: [
          ...(validated.targetProbes !== undefined ? (['targetProbes'] as const) : []),
          ...(validated.maxProbes !== undefined ? (['maxProbes'] as const) : []),
          ...(validated.maxWallTimeMs !== undefined ? (['maxWallTimeMs'] as const) : []),
        ],
        timeAdmission: {
          policy: timingAdmission.policy,
          estimatedNextProbeDurationMs: timingAdmission.estimatedNextProbeDurationMs,
          plannedPostStartupRequestCount: configuredDurationEstimate.plannedPostStartupRequestCount,
          maxRunnerStartAttempts: configuredDurationEstimate.maxRunnerStartAttempts,
          startupTimeoutMs: validated.startupTimeoutMs,
          resolvedCapacityCheckTimeoutMs: configuredDurationEstimate.resolvedCapacityCheckTimeoutMs,
          configuredAttemptTeardownMs: configuredDurationEstimate.configuredAttemptTeardownMs,
          caveat:
            timingAdmission.policy === 'observed-comparable-launches'
              ? 'Observed timing is the median of complete comparable fresh launches; future launch duration can still vary and remains bounded by the hard deadline.'
              : 'This deterministic conservative estimate is not a formal wall-clock upper bound; filesystem and OS scheduling can add delay.',
        },
      },
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
      selected,
      provisional,
      fallback,
      ...(selected ? { selectionEvidence: 'independent-reproduction' as const } : {}),
      confidence: 'empirical-reproducibility',
      pinnedMoePlacement: true,
    };
    emitProgress('done', { terminalStatus: terminal.status });
    return report;
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
  private async ensureBinary(modelPath?: string, forceValidation = false): Promise<string> {
    return this.ensureBinaryHelper(
      'llama',
      'llama-server',
      BINARY_VERSIONS.llamaServer,
      modelPath,
      forceValidation
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
