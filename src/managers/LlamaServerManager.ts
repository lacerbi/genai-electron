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
import { LlamaCalibrationClient } from '../process/llama-calibration-client.js';
import { startLlamaServerRunner, type LlamaServerRunner } from '../process/llama-server-runner.js';
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
  LlamaCalibrationProgress,
  LlamaCalibrationReport,
  LlamaCalibrationRun,
  LlamaCalibrationSample,
  LlamaCalibrationWorkloadResult,
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
} from '../config/defaults.js';
import { fileExists } from '../utils/file-utils.js';
import { debugLog } from '../utils/debug-log.js';
import { getInstalledBinaryIdentity } from '../utils/binary-identity.js';
import {
  extractLlamaCalibrationOverrides,
  generateDefaultLlamaCalibrationCombos,
  median,
  recommendLlamaCalibrationRun,
  resolveLlamaCalibrationConfig,
  validateLlamaCalibrationConfig,
  weightedCalibrationScore,
  workloadSignature,
  type ValidatedLlamaCalibrationConfig,
} from '../utils/llama-calibration.js';
import {
  getExpertWeightsBytesWithFallback,
  getLayerCountWithFallback,
  getSlidingWindow,
} from '../utils/model-metadata-helpers.js';
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
    systemInfo: SystemInfo = SystemInfo.getInstance()
  ) {
    super();
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;
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
   * Benchmark a bounded set of llama-server configurations for one exact
   * total-context and slot profile. Candidates and requests run serially; the
   * manager remains publicly stopped and the result is never auto-applied.
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
    const savedBinaryPath = this.binaryPath;
    const savedLogManager = this.logManager;
    const runs: LlamaCalibrationRun[] = [];
    let activeRunner: LlamaServerRunner | undefined;
    let lastProgress = 0;
    this.calibrating = true;

    const progress = (
      phase: LlamaCalibrationProgress['phase'],
      comboIndex: number,
      comboCount: number,
      combo?: LlamaCalibrationCombo,
      workloadIndex?: number,
      sampleIndex?: number
    ) => {
      const fractionByPhase: Record<LlamaCalibrationProgress['phase'], number> = {
        preparing: 0,
        starting: 0.05,
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
          ? 100
          : comboCount === 0
            ? 0
            : ((comboIndex + fractionByPhase[phase]) / comboCount) * 100;
      lastProgress = Math.max(lastProgress, Math.min(100, calculated));
      const payload: LlamaCalibrationProgress = {
        overallPercent: lastProgress,
        phase,
        comboIndex,
        comboCount,
        combo,
        workloadIndex,
        workloadCount: validated.workloads.length,
        sampleIndex,
        sampleCount: validated.samples,
      };
      try {
        validated.onProgress?.(payload);
      } catch (error) {
        debugLog('[LlamaCalibration] progress callback threw:', error);
      }
      try {
        this.emit('calibration-progress', payload);
      } catch (error) {
        debugLog('[LlamaCalibration] calibration-progress listener threw:', error);
      }
    };

    try {
      progress('preparing', 0, 0);
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
      let customCandidates: readonly ReturnType<typeof resolveCandidate>[] | undefined;
      if (validated.combos) {
        customCandidates = validated.combos.map(resolveCandidate);
        const seen = new Set<string>();
        for (const candidate of customCandidates) {
          if (seen.has(candidate.argvKey)) {
            throw new ServerError(
              'Custom calibration combos resolve to duplicate server arguments',
              {
                code: 'CALIBRATION_INVALID_CONFIG',
                combo: candidate.combo,
              }
            );
          }
          seen.add(candidate.argvKey);
        }
      }

      validated.signal?.throwIfAborted();
      this.binaryPath = await this.ensureBinary(model.path);
      validated.signal?.throwIfAborted();
      const binaryIdentity = await getInstalledBinaryIdentity(
        'llama',
        this.binaryPath,
        BINARY_VERSIONS.llamaServer.version
      );
      const generated = customCandidates
        ? {
            combos: customCandidates.map((candidate) => candidate.combo),
            skippedCombos: [] as const,
          }
        : generateDefaultLlamaCalibrationCombos({
            baseline,
            fixedConfig: validated.fixedConfig,
            totalLayers: getLayerCountWithFallback(model),
            gpuAvailable: capabilities.gpu.available && binaryIdentity.variant !== 'cpu',
            slidingWindow: getSlidingWindow(model),
            hasSharedPrefixWorkload: validated.workloads.some(
              (workload) => workload.kind === 'shared-prefix'
            ),
            exactExpertWeightsBytes: model.ggufMetadata?.expert_weights_bytes,
            moeCounterfactualFeasible: getExpertWeightsBytesWithFallback(model) !== undefined,
            includeKvCacheComparison: validated.includeKvCacheComparison,
          });
      const skippedCombos = [...generated.skippedCombos];
      const candidates = customCandidates ? [...customCandidates] : [];
      if (!customCandidates) {
        const seen = new Set<string>();
        for (const combo of generated.combos) {
          const candidate = resolveCandidate(combo);
          if (seen.has(candidate.argvKey)) {
            skippedCombos.push({ combo, reason: 'duplicate-resolved-config' });
            continue;
          }
          seen.add(candidate.argvKey);
          candidates.push(candidate);
        }
      }
      const combos = candidates.map((candidate) => candidate.combo);
      let verifiedProfile: LlamaCalibrationReport['verifiedProfile'];
      const observedPromptTokenCounts = new Map<string, readonly number[]>();

      for (let comboIndex = 0; comboIndex < candidates.length; comboIndex++) {
        const { combo, resolvedConfig } = candidates[comboIndex]!;
        const workloadResults: LlamaCalibrationWorkloadResult[] = [];
        let status: LlamaCalibrationRun['status'] = 'ok';
        let errorText: string | undefined;
        let loadTimeMs: number | undefined;
        let effectiveContextSize: number | undefined;
        let effectiveParallelRequests: number | undefined;
        let stderrTail: string | undefined;
        let fatalCandidateError: unknown;
        let cleanupFailure: unknown;

        progress('starting', comboIndex, combos.length, combo);
        try {
          validated.signal?.throwIfAborted();
          activeRunner = await startLlamaServerRunner({
            binaryPath: this.binaryPath,
            model,
            config: { modelId: model.id, ...resolvedConfig },
            contextSize: validated.profile.contextSize,
            parallelRequests: validated.profile.parallelRequests,
            startupTimeoutMs: validated.startupTimeoutMs,
            signal: validated.signal,
          });
          loadTimeMs = activeRunner.loadTimeMs;
          effectiveContextSize = activeRunner.capacity!.effectiveContextSize;
          effectiveParallelRequests = activeRunner.capacity!.totalSlots;
          verifiedProfile ??= {
            effectiveContextSize,
            effectiveParallelRequests: effectiveParallelRequests!,
          };
          const client = new LlamaCalibrationClient(
            activeRunner,
            validated.requestTimeoutMs,
            validated.signal
          );
          const candidateTokenCounts = await this.validateCalibrationPromptCapacity(
            client,
            validated.workloads,
            effectiveContextSize
          );
          for (const [workloadId, tokenCounts] of candidateTokenCounts) {
            if (!observedPromptTokenCounts.has(workloadId)) {
              observedPromptTokenCounts.set(workloadId, tokenCounts);
            }
          }

          progress('warmup', comboIndex, combos.length, combo);
          for (const workload of validated.workloads) {
            await this.runCalibrationScenario(client, workload, validated.seed);
          }

          for (let workloadIndex = 0; workloadIndex < validated.workloads.length; workloadIndex++) {
            const workload = validated.workloads[workloadIndex]!;
            const samples: LlamaCalibrationSample[] = [];
            for (let sampleIndex = 0; sampleIndex < validated.samples; sampleIndex++) {
              progress('sampling', comboIndex, combos.length, combo, workloadIndex, sampleIndex);
              samples.push(await this.runCalibrationScenario(client, workload, validated.seed));
            }
            workloadResults.push({
              workloadId: workload.id,
              kind: workload.kind,
              workloadHash: workloadSignature(workload).hash,
              weight: workload.weight,
              samples,
              medianWallTimeMs: median(samples.map((sample) => sample.wallTimeMs)),
            });
          }
        } catch (error) {
          const code = calibrationErrorCode(error);
          if (
            code === 'CALIBRATION_ABORTED' ||
            code === 'CALIBRATION_CLEANUP_FAILED' ||
            code === 'CALIBRATION_INVALID_CONFIG' ||
            code === 'CALIBRATION_SLOTS_UNAVAILABLE' ||
            validated.signal?.aborted
          ) {
            if (code === 'CALIBRATION_CLEANUP_FAILED') {
              const orphanPid = calibrationErrorDetail(error, 'pid');
              const errorStderr = calibrationErrorDetail(error, 'stderrTail');
              if (typeof orphanPid === 'number' && Number.isSafeInteger(orphanPid)) {
                this.calibrationOrphan = {
                  pid: orphanPid,
                  stderrTail: typeof errorStderr === 'string' ? errorStderr : undefined,
                };
              }
            }
            fatalCandidateError = error;
          } else {
            errorText = calibrationErrorMessage(error);
            const errorStderr = calibrationErrorDetail(error, 'stderrTail');
            stderrTail =
              activeRunner?.stderrTail ??
              (typeof errorStderr === 'string' ? errorStderr : undefined);
            status = this.classifyCalibrationFailure(error, stderrTail ?? '');
          }
        } finally {
          progress('stopping', comboIndex, combos.length, combo);
          if (activeRunner) {
            try {
              await activeRunner.stop();
            } catch (error) {
              if (activeRunner.pid) {
                this.calibrationOrphan = {
                  pid: activeRunner.pid,
                  stderrTail: activeRunner.stderrTail,
                };
              }
              cleanupFailure = error;
            }
          }
        }
        if (cleanupFailure) throw cleanupFailure;
        if (fatalCandidateError) throw fatalCandidateError;

        const resultById = new Map(workloadResults.map((result) => [result.workloadId, result]));
        const completeWorkloadResults = validated.workloads.map(
          (workload): LlamaCalibrationWorkloadResult =>
            resultById.get(workload.id) ?? {
              workloadId: workload.id,
              kind: workload.kind,
              workloadHash: workloadSignature(workload).hash,
              weight: workload.weight,
              samples: [],
              error: errorText,
            }
        );
        const scoreMs =
          status === 'ok' ? weightedCalibrationScore(completeWorkloadResults) : undefined;
        runs.push({
          combo,
          resolvedConfig,
          status: scoreMs === undefined && status === 'ok' ? 'error' : status,
          loadTimeMs,
          effectiveContextSize,
          effectiveParallelRequests,
          workloadResults: completeWorkloadResults,
          scoreMs,
          error: errorText,
          stderrTail,
        });
        activeRunner = undefined;
        this.systemInfo.clearCache();
        try {
          const currentMemory = this.systemInfo.getMemoryInfo();
          const currentGpu = await this.systemInfo.getGPUInfo();
          if (
            currentMemory.available < capabilities.memory.available * 0.75 ||
            (capabilities.gpu.vramAvailable !== undefined &&
              currentGpu.vramAvailable !== undefined &&
              currentGpu.vramAvailable < capabilities.gpu.vramAvailable * 0.75)
          ) {
            debugLog(
              '[LlamaCalibration] available resources drifted by more than 25% during the sweep'
            );
          }
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
      const report: LlamaCalibrationReport = {
        schemaVersion: 1,
        policyVersion: LLAMA_CALIBRATION_DEFAULTS.policyVersion,
        createdAt: new Date().toISOString(),
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
          samples: validated.samples,
          warmups: 1,
          seed: validated.seed,
          startupTimeoutMs: validated.startupTimeoutMs,
          requestTimeoutMs: validated.requestTimeoutMs,
          resourceCooldownMs: LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
          tieTolerancePct: LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct,
          includeKvCacheComparison: validated.includeKvCacheComparison,
          kvPrecisionPreferencePct: validated.kvPrecisionPreferencePct,
          scoreUnit: 'scenario-median-wall-ms',
        },
        comboSource: validated.combos ? 'custom' : 'default',
        combos,
        skippedCombos,
        runs,
        recommended: recommendLlamaCalibrationRun(runs, validated.kvPrecisionPreferencePct),
      };
      progress('done', combos.length, combos.length);
      return report;
    } catch (error) {
      if (validated.signal?.aborted || calibrationErrorCode(error) === 'CALIBRATION_ABORTED') {
        throw new ServerError('LLM calibration aborted', {
          code: 'CALIBRATION_ABORTED',
          runs,
          cause: validated.signal?.reason ?? calibrationErrorMessage(error),
        });
      }
      throw error;
    } finally {
      if (activeRunner) {
        try {
          await activeRunner.stop();
        } catch {
          if (activeRunner.pid) {
            this.calibrationOrphan = {
              pid: activeRunner.pid,
              stderrTail: activeRunner.stderrTail,
            };
          }
        }
      }
      this.binaryPath = savedBinaryPath;
      this.logManager = savedLogManager;
      this.systemInfo.clearCache();
      this.calibrating = false;
    }
  }

  private async validateCalibrationPromptCapacity(
    client: LlamaCalibrationClient,
    workloads: ValidatedLlamaCalibrationConfig['workloads'],
    effectiveContextSize: number
  ): Promise<Map<string, readonly number[]>> {
    const result = new Map<string, readonly number[]>();
    for (const workload of workloads) {
      const prompts =
        workload.kind === 'cold-prefill'
          ? [workload.prompt]
          : workload.suffixes.map((suffix) => workload.sharedPrefix + suffix);
      const tokenCounts: number[] = [];
      for (const prompt of prompts) {
        const promptTokens = await client.tokenize(prompt);
        tokenCounts.push(promptTokens);
        if (promptTokens + workload.nPredict > effectiveContextSize) {
          throw new ServerError(
            'A calibration workload does not fit the verified per-slot context',
            {
              code: 'CALIBRATION_INVALID_CONFIG',
              workloadId: workload.id,
              promptTokens,
              nPredict: workload.nPredict,
              effectiveContextSize,
            }
          );
        }
      }
      result.set(workload.id, tokenCounts);
    }
    return result;
  }

  private async runCalibrationScenario(
    client: LlamaCalibrationClient,
    workload: ValidatedLlamaCalibrationConfig['workloads'][number],
    seed: number
  ): Promise<LlamaCalibrationSample> {
    const slotId = 0;
    await client.eraseSlot(slotId);
    if (workload.kind === 'cold-prefill') {
      const request = await client.complete({
        prompt: workload.prompt,
        nPredict: workload.nPredict,
        seed,
        slotId,
        cachePrompt: false,
        requireCacheObservation: false,
      });
      return { wallTimeMs: request.wallTimeMs, requests: [request] };
    }

    await client.complete({
      prompt: workload.sharedPrefix + workload.suffixes[0]!,
      nPredict: workload.nPredict,
      seed,
      slotId,
      cachePrompt: true,
      requireCacheObservation: false,
    });
    const startedAt = performance.now();
    const requests = [];
    for (const suffix of workload.suffixes.slice(1)) {
      requests.push(
        await client.complete({
          prompt: workload.sharedPrefix + suffix,
          nPredict: workload.nPredict,
          seed,
          slotId,
          cachePrompt: true,
          requireCacheObservation: true,
        })
      );
    }
    return { wallTimeMs: performance.now() - startedAt, requests };
  }

  private classifyCalibrationFailure(
    error: unknown,
    stderrTail: string
  ): LlamaCalibrationRun['status'] {
    const code = calibrationErrorCode(error);
    const message = `${calibrationErrorMessage(error)}\n${stderrTail}`;
    if (LLAMA_CALIBRATION_DEFAULTS.oomPatterns.some((pattern) => pattern.test(message))) {
      return 'oom';
    }
    if (code === 'CALIBRATION_CANDIDATE_CRASHED') return 'crashed';
    if (code === 'CALIBRATION_REQUEST_TIMEOUT') return 'request-timeout';
    if (/health check timeout/i.test(message)) return 'startup-timeout';
    return 'error';
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
