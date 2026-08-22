/**
 * DiffusionServerManager - Manages diffusion server lifecycle
 *
 * Creates an HTTP wrapper server (node:http) that is the public diffusion server, and
 * drives an internal, lazily-spawned stable-diffusion.cpp `sd-server` backend process
 * through its native job API. The backend may stay resident between images ('burst') or
 * be released right after one ('single'); the wrapper's HTTP contract is unchanged.
 *
 * @module managers/DiffusionServerManager
 */

import { ServerManager } from './ServerManager.js';
import { ModelManager } from './ModelManager.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { ResourceOrchestrator } from './ResourceOrchestrator.js';
import { GenerationRegistry } from './GenerationRegistry.js';
import http from 'node:http';
import { PATHS } from '../config/paths.js';
import {
  BINARY_VERSIONS,
  DEFAULT_PORTS,
  DIFFUSION_VRAM_THRESHOLDS,
  DIFFUSION_COMPONENT_FLAGS,
  DIFFUSION_COMPONENT_ORDER,
  DIFFUSION_CALIBRATION_DEFAULTS,
  DIFFUSION_BACKEND_DEFAULTS,
} from '../config/defaults.js';
import { ensureDirectory } from '../utils/file-utils.js';
import { debugLog } from '../utils/debug-log.js';
import { findFreePort } from '../process/port-utils.js';
import { normalizeHealthHost } from '../process/health-check.js';
import {
  isSdServerProgressBarLine,
  startSdServerRunner,
  type SdServerExit,
  type SdServerHandle,
  type SdServerStdoutEvent,
} from '../process/sd-server-runner.js';
import {
  SdServerClient,
  buildSdServerImageRequest,
  type SdServerJob,
  type SdServerJobStatus,
} from '../process/sd-server-client.js';
import {
  createTelemetrySnapshotCapture,
  type CaptureResourceSnapshot,
} from '../utils/llama-resource-guard-capture.js';
import {
  GenaiElectronError,
  ServerError,
  ModelNotFoundError,
  InsufficientResourcesError,
} from '../errors/index.js';
import type {
  CalibrationRun,
  CalibrationSize,
  DiffusionBackendInfo,
  DiffusionBackendReleaseReason,
  DiffusionBackendState,
  DiffusionBackendStatusEvent,
  DiffusionCalibrationConfig,
  DiffusionCalibrationProgress,
  DiffusionCalibrationReport,
  DiffusionOffloadCombo,
  DiffusionServerConfig,
  DiffusionServerInfo,
  DiffusionUsageMode,
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageSampler,
  ModelInfo,
  ServerInfo,
} from '../types/index.js';
import type { LlamaServerManager } from './LlamaServerManager.js';

interface ResolvedDiffusionOptimizations {
  clipOnCpu: boolean;
  vaeOnCpu: boolean;
  offloadToCpu: boolean;
  diffusionFlashAttention: boolean;
  batchSize?: number;
}

/** The four launch-time offload flags a backend process is pinned to. */
type ResolvedDiffusionFlags = Omit<ResolvedDiffusionOptimizations, 'batchSize'>;

/** Internal bookkeeping for the (at most one) resident backend process. */
interface DiffusionBackendRuntime {
  state: DiffusionBackendState;
  handle?: SdServerHandle;
  client?: SdServerClient;
  /** Flags the resident process was launched with (its identity for reuse) */
  flags?: ResolvedDiffusionFlags;
  pid?: number;
  startedAt?: number;
  loadTimeMs?: number;
  lastUsedAt?: number;
  idleTimer?: NodeJS.Timeout;
  /** In-progress spawn; awaited by concurrent ensureBackend() callers */
  startPromise?: Promise<void>;
  /** Cancels the in-progress spawn so a release never waits out a cold model load */
  startAbort?: AbortController;
  /** In-progress release; awaited before any respawn and by stop() */
  stopPromise?: Promise<void>;
  /**
   * Reason the in-progress release will report. A release that starts while another
   * one is already running upgrades this to the higher-ranked reason, so the event
   * and the orchestrator callback describe why the backend is really going away.
   */
  stopReason?: DiffusionBackendReleaseReason;
}

/**
 * Precedence of release reasons; the highest-ranked reason of the callers that
 * asked for one release wins (see {@link DiffusionServerManager.releaseBackend}).
 * @internal
 */
const RELEASE_REASON_RANK: Record<DiffusionBackendReleaseReason, number> = {
  shutdown: 100,
  stop: 90,
  'llm-start': 80,
  calibration: 70,
  'flags-changed': 60,
  'idle-timeout': 50,
  // Above 'explicit'/'cancel' so the watchdog's own reason survives the cancel-style
  // release the failing generation's catch path may join it with; below 'stop' and the
  // other host-driven reasons, which describe a bigger decision than one wedged job.
  stuck: 45,
  explicit: 40,
  single: 30,
  cancel: 20,
  crashed: 10,
};

/** `details.code` values from the client that a job poll may retry instead of failing. */
const TRANSIENT_POLL_ERROR_CODES: ReadonlySet<string> = new Set([
  'BACKEND_REQUEST_TIMEOUT',
  'BACKEND_REQUEST_FAILED',
]);

/**
 * Cadence of the calibration VRAM sampler, which fixes the resolution of the reported
 * peak. Each sample costs one platform telemetry command (e.g. `nvidia-smi`); the
 * measured work is GPU-bound, so the perturbation at 1 s is negligible.
 * @internal
 */
const CALIBRATION_VRAM_SAMPLE_INTERVAL_MS = 1_000;

/**
 * Longest gap between two stuck-job watchdog ticks.
 *
 * The watchdog polls its own clock instead of rescheduling a timeout on every sign of
 * life (activity arrives many times per second during sampling). The tick is
 * `min(this, timeout / 10)`, so the observed overshoot is at most ~10 % of the
 * configured budget — precise enough for a ten-minute default, cheap enough to leave
 * armed for a whole job.
 * @internal
 */
const JOB_ACTIVITY_TICK_MAX_MS = 30_000;

/** Per-read bound for one calibration VRAM telemetry capture. @internal */
const CALIBRATION_VRAM_TELEMETRY_TIMEOUT_MS = 5_000;

/** Machine-wide VRAM figures of one calibration timed sample. @internal */
interface CalibrationVramSample {
  vramPeakBytes?: number;
  vramIdleBytes?: number;
}

/**
 * The busy-gate claim for one generation request.
 *
 * Created synchronously by whoever starts a generation (HTTP route, generateImage(),
 * calibration) and released by that same owner in a `finally`, so batch loops keep the
 * gate closed between images. executeImageGeneration() never assigns or clears it — it
 * only refines the cancel behaviour once a backend job exists.
 */
interface GenerationClaim {
  /** Registry id, when the generation was started through the async HTTP API */
  id?: string;
  /** The owner's in-flight promise (used by releaseBackend({waitForInFlight})) */
  promise?: Promise<unknown>;
  /** Latched by cancel() so a cancel arriving before submit is not lost */
  cancelRequested: boolean;
  cancel: () => void;
}

/** Job-level handle owned by executeImageGeneration while a backend job is in flight. */
interface InFlightBackendJob {
  /** Cancel the backend job (cancel a queued job, kill the backend while generating) */
  cancel: () => void;
  /** Reject the generation promise (backend crash) */
  reject: (error: unknown) => void;
}

/**
 * DiffusionServerManager class
 *
 * Manages the lifecycle of diffusion HTTP wrapper server.
 *
 * Features:
 * - HTTP server wrapper in front of a stable-diffusion.cpp `sd-server` backend
 * - Lazily spawned backend process (no VRAM is held until the first image)
 * - Progress tracking during generation
 * - Automatic binary download and variant testing
 * - Log capture and retrieval
 *
 * @example
 * ```typescript
 * import { diffusionServer } from 'genai-electron';
 *
 * // Start server
 * await diffusionServer.start({
 *   modelId: 'sdxl-turbo',
 *   port: 8081
 * });
 *
 * // Generate image
 * const result = await diffusionServer.generateImage({
 *   prompt: 'A serene mountain landscape',
 *   width: 1024,
 *   height: 1024
 * });
 *
 * // Stop server
 * await diffusionServer.stop();
 * ```
 */
export class DiffusionServerManager extends ServerManager {
  /**
   * Fields accepted by DiffusionServerManager.start() (DiffusionServerConfig).
   *
   * `gpuLayers` is accepted but ignored: stable-diffusion.cpp has no GPU-layers flag
   * (that is llama.cpp). It stays in the allowlist because removing it would reject
   * configs that are valid today.
   */
  private static readonly VALID_CONFIG_FIELDS: ReadonlySet<string> = new Set([
    'modelId',
    'port',
    'host',
    'allowedOrigins',
    'startupTimeout',
    'usageMode',
    'idleTimeoutMs',
    'jobActivityTimeoutMs',
    'threads',
    'gpuLayers',
    'forceValidation',
    'clipOnCpu',
    'vaeOnCpu',
    'batchSize',
    'offloadToCpu',
    'diffusionFlashAttention',
  ]);

  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private orchestrator?: ResourceOrchestrator;
  private registry: GenerationRegistry;
  private binaryPath?: string;
  private httpServer?: http.Server;
  /**
   * Busy gate. Non-undefined means "a generation is in flight" — the single owner
   * that created it releases it; nothing else assigns or clears it.
   */
  private currentGeneration?: GenerationClaim;
  /** Backend job currently in flight (set by executeImageGeneration only) */
  private inFlight?: InFlightBackendJob;
  /**
   * When the backend last showed a sign of life, in epoch milliseconds.
   *
   * Written by {@link markBackendActivity} from the stdout tap, the log tap and the
   * job poll loop; read by the stuck-job watchdog only.
   */
  private lastBackendActivityAt = 0;
  /** Ticking stuck-job watchdog for the in-flight job (see armJobActivityWatchdog) */
  private jobActivityTimer?: NodeJS.Timeout;
  /** The job the armed watchdog belongs to; a later generation must not be killed by it */
  private jobActivityOwner?: InFlightBackendJob;
  /** The one resident backend process, if any */
  private backend: DiffusionBackendRuntime = { state: 'absent' };
  /** Normalized config of the generation whose progress the stdout tap feeds */
  private progressConfig?: ImageGenerationConfig;
  private currentModelInfo?: ModelInfo;
  /**
   * Flags resolved by the most recent computeDiffusionOptimizations() call.
   * Read by calibrate() after each run to report what auto-detection picked.
   */
  private lastResolvedOptimizations?: Omit<ResolvedDiffusionOptimizations, 'batchSize'>;
  /** True while an offload-calibration sweep is running (server stays 'stopped') */
  private calibrating = false;
  /**
   * PID of a backend whose termination could not be confirmed. Sticky: no second
   * backend is spawned while that process may still hold the GPU.
   */
  private unconfirmedBackendPid?: number;
  /**
   * Removes the LLM pre-start hook this manager registered (if any).
   *
   * Kept (and `protected` rather than `private`) so a subclass or a host that builds
   * extra managers around one shared `llamaServer` can detach again: every instance
   * registers its own hook, and each hook releases only its own backend.
   */
  protected unregisterPreStartHook?: () => void;

  // Time estimates for progress calculation (self-calibrating)
  /** Cold load: spawn + weight placement, measured only on generations that spawned */
  private modelLoadTime = 2000; // Fixed cost in ms
  /** Warm load: conditioning only, measured on generations that reused a backend */
  private warmLoadTime = 300; // Fixed cost in ms
  /** Load estimate chosen for the generation in flight (cold or warm) */
  private currentLoadEstimate = 2000;
  private diffusionTimePerStepPerMegapixel = 1000; // Time per step per megapixel in ms
  private vaeTimePerMegapixel = 8000; // Time per megapixel in ms

  // Current generation timing and progress tracking
  private generationStartTime?: number;
  private loadStartTime?: number;
  private loadEndTime?: number;
  private diffusionStartTime?: number;
  private diffusionEndTime?: number;
  private vaeStartTime?: number;
  private vaeEndTime?: number;
  private syntheticProgressInterval?: NodeJS.Timeout;
  private currentStage?: 'loading' | 'diffusion' | 'vae';
  private totalEstimatedTime = 0;
  /** Highest in-flight percentage reported for the generation in flight (never decreases) */
  private reportedPercentage = 0;
  private loadProgress = { current: 0, total: 0 };
  private diffusionProgress = { current: 0, total: 0 };

  /**
   * Create a new DiffusionServerManager
   *
   * @param modelManager - Model manager instance (default: singleton)
   * @param systemInfo - System info instance (default: singleton)
   * @param llamaServer - Optional LLM server manager for automatic resource orchestration
   */
  constructor(
    modelManager: ModelManager = ModelManager.getInstance(),
    systemInfo: SystemInfo = SystemInfo.getInstance(),
    llamaServer?: LlamaServerManager
  ) {
    super();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;

    // Initialize generation registry for async API
    this.registry = this.createRegistry();

    // Create orchestrator if llamaServer is provided (enables automatic resource management)
    if (llamaServer) {
      const orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, this, modelManager);
      this.orchestrator = orchestrator;

      // Symmetric orchestration: an LLM start yields the resident backend when both
      // would not fit. Registered here (not in start()) because a backend can outlive
      // the wrapper — calibrate() runs with the wrapper stopped.
      // NOTE: every manager constructed with the same llamaServer registers its own
      // hook. That is intentional (each one owns its own backend), but it means a host
      // creating extra DiffusionServerManager instances pays one hook per instance;
      // the unregister handle is kept so a host can drop them again.
      this.unregisterPreStartHook = llamaServer.registerPreStartHook((ctx) =>
        orchestrator.prepareForLLMStart(ctx)
      );
    }
  }

  /**
   * Create a fresh generation registry (TTLs configurable via env vars)
   * @private
   */
  private createRegistry(): GenerationRegistry {
    return new GenerationRegistry({
      maxResultAgeMs: parseInt(process.env.IMAGE_RESULT_TTL_MS || '300000', 10), // 5 minutes default
      cleanupIntervalMs: parseInt(process.env.IMAGE_CLEANUP_INTERVAL_MS || '60000', 10), // 1 minute default
    });
  }

  /**
   * Start diffusion HTTP wrapper server
   *
   * Brings up the public HTTP wrapper only — the stable-diffusion.cpp backend is
   * spawned lazily on the first image request, so no VRAM is held by start().
   * The wrapper binds `127.0.0.1` unless `config.host` says otherwise.
   *
   * @param config - Server configuration
   * @returns Server information
   * @throws {ModelNotFoundError} If model doesn't exist or wrong type
   * @throws {PortInUseError} If port is already in use
   * @throws {BinaryError} If binary download/verification fails
   * @throws {InsufficientResourcesError} If system can't run the model
   * @throws {ServerError} If server fails to start
   */
  async start(config: DiffusionServerConfig): Promise<ServerInfo> {
    if (this._status === 'running' || this._status === 'starting') {
      throw new ServerError(
        this._status === 'running' ? 'Server is already running' : 'Server is already starting',
        {
          suggestion:
            this._status === 'running'
              ? 'Stop the server first with stop()'
              : 'Wait for the current start() call to finish',
        }
      );
    }

    if (this.calibrating) {
      throw new ServerError('Cannot start server while offload calibration is in progress', {
        suggestion: 'Wait for calibrate() to finish, or abort it via its AbortSignal',
      });
    }

    // Validate config fields before proceeding
    this.validateConfigFields(
      config as unknown as Record<string, unknown>,
      DiffusionServerManager.VALID_CONFIG_FIELDS,
      'DiffusionServerManager'
    );

    this.setStatus('starting');
    // DiffusionServerConfig has optional port (resolved later), so cast via unknown
    this._config = config as unknown as typeof this._config;

    // A prior stop() destroyed the registry's cleanup timer — start with a
    // fresh registry so terminal results (incl. cancelled ones holding image
    // data) keep getting garbage-collected across stop/start cycles
    this.registry.destroy();
    this.registry = this.createRegistry();

    try {
      await this.initializeLogManager(
        'diffusion-server.log',
        `Preparing diffusion server for model ${config.modelId}`
      );

      // 1. Validate model exists and is correct type
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      if (modelInfo.type !== 'diffusion') {
        throw new ModelNotFoundError(
          `Model ${config.modelId} is not a diffusion model (type: ${modelInfo.type})`
        );
      }
      this.currentModelInfo = modelInfo;

      // 2. Check if system can run this model (check total memory since model loads on-demand)
      const canRun = await this.systemInfo.canRunModel(modelInfo, { checkTotalMemory: true });
      if (!canRun.possible) {
        const memoryInfo = this.systemInfo.getMemoryInfo();
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Total RAM: ${Math.round(memoryInfo.total / 1024 / 1024 / 1024)}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
          }
        );
      }

      // 3. Ensure binary is downloaded (pass model info for real functionality testing)
      this.binaryPath = await this.ensureBinary(modelInfo, config.forceValidation);

      // 4. Resolve the bind host, then the port ONCE ('auto' → OS-assigned free port)
      // and check it. createHTTPServer receives the resolved number — resolving twice
      // would probe one port and bind another.
      // `||`, not `??`: an empty string would bind every interface (Node's default)
      // while sidestepping the loopback Host guard.
      const host = config.host || '127.0.0.1';
      const port =
        config.port === 'auto'
          ? await findFreePort(host)
          : (config.port ?? DEFAULT_PORTS.diffusion);
      // Wildcard binds are probed through a loopback address of the same family
      await this.checkPortAvailability(port, undefined, normalizeHealthHost(host));

      // 5. Record the resolved port in the provisioning log
      await this.logManager?.write(`Starting diffusion server on ${host}:${port}`, 'info');

      // 6. Create HTTP server
      await this.createHTTPServer(port, host);

      this._port = port;
      this._startedAt = new Date();
      this.setStatus('running');

      if (this.logManager) {
        await this.logManager.write('Diffusion server is running', 'info');
      }

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      this.emitEvent('started', this.getInfo());

      return this.getInfo() as DiffusionServerInfo;
    } catch (error) {
      throw await this.handleStartupError('diffusion-server', error, async () => {
        if (this.httpServer) {
          this.httpServer.close();
          this.httpServer = undefined;
        }
      });
    }
  }

  /**
   * Stop diffusion server
   *
   * Releases the stable-diffusion.cpp backend (confirmed death), closes the HTTP
   * wrapper and cancels any ongoing generation. Also releases a backend left behind
   * by calibrate(), which runs while the wrapper itself is stopped.
   *
   * @throws {ServerError} If stop fails
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      // A calibration sweep can leave a backend alive while the wrapper is stopped
      await this.releaseBackend({ reason: 'stop' });
      return;
    }

    this.setStatus('stopping');

    try {
      if (this.logManager) {
        await this.logManager.write('Stopping diffusion server...', 'info');
      }

      // Cancel any ongoing generation (incl. halting a batch between images).
      // The claim itself is cleared by its owner's finally block.
      this.currentGeneration?.cancel();

      // Release the backend and require confirmed death before the wrapper closes
      await this.releaseBackend({ reason: 'stop' });

      // Close HTTP server
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer?.close(() => resolve());
        });
        this.httpServer = undefined;
      }

      // Cleanup registry
      this.registry.destroy();

      this.setStatus('stopped');
      this._port = 0;

      if (this.logManager) {
        await this.logManager.write('Diffusion server stopped', 'info');
      }

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      this.emitEvent('stopped');
    } catch (error) {
      this.setStatus('stopped');
      throw new ServerError(
        `Failed to stop server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Get the registry ID of the async generation currently being processed
   *
   * Useful for cancelling the in-flight generation when the ID is otherwise
   * only known to the HTTP client that started it (e.g. genai-lite).
   *
   * @returns Generation ID, or undefined when idle
   */
  getActiveGenerationId(): string | undefined {
    return this.currentGeneration?.id;
  }

  /**
   * Cancel an in-flight async generation by its registry ID
   *
   * Marks the generation 'cancelled' in the registry, halts the batch loop (also
   * between images) and stops the backend job: a still-queued job is cancelled
   * through the backend's own API, a generating one by killing the backend (upstream
   * cannot interrupt sampling). The kill is *initiated*, not awaited — this method
   * resolves as soon as the in-flight generation has been rejected, and the next
   * spawn waits for the confirmed death.
   * Idempotent: cancelling an already-terminal generation is a no-op.
   *
   * Only generations started through the async HTTP API (or runAsyncGeneration)
   * have IDs; direct generateImage() calls are cancelled by stop().
   *
   * Compatibility note: genai-lite clients that don't yet recognize the
   * 'cancelled' status keep polling until their own client-side timeout.
   *
   * @param id - Generation ID (from POST /v1/images/generations)
   * @throws {ServerError} If the generation ID is unknown
   */
  async cancelImageGeneration(id: string): Promise<void> {
    const state = this.registry.get(id);
    if (!state) {
      throw new ServerError(`Generation not found: ${id}`, {
        code: 'GENERATION_NOT_FOUND',
        suggestion: 'The generation may have expired from the registry or the ID is wrong',
      });
    }

    if (state.status === 'complete' || state.status === 'error' || state.status === 'cancelled') {
      return; // Terminal — nothing to cancel (idempotent)
    }

    // Mark cancelled FIRST so the in-flight promise's rejection/completion
    // handlers see the status and never overwrite it
    this.registry.update(id, { status: 'cancelled' });

    if (this.currentGeneration?.id === id) {
      // Latches cancelRequested and, when a job is already in flight, cancels/kills it
      this.currentGeneration.cancel();
    }

    await this.logManager?.write(`Generation ${id} cancelled`, 'info');
  }

  /**
   * Release the internal stable-diffusion.cpp backend process
   *
   * Idempotent and safe to call at any time: `'absent'` returns immediately, an
   * in-progress release is awaited rather than duplicated. The backend state is set to
   * `'stopping'` BEFORE the kill so the exit handler treats the exit as intended
   * (no `'crashed'` reporting), and the method resolves after the stop completes. A
   * termination that could NOT be confirmed is logged, the state still becomes
   * `'absent'`, and the orphan PID blocks new spawns until it is gone
   * (`BACKEND_TERMINATION_UNCONFIRMED`).
   *
   * An in-progress spawn is aborted rather than waited out, so a `stop()` during a
   * cold model load returns in milliseconds. When a release is already running, the
   * higher-ranked reason wins — a `stop()` arriving behind a `'cancel'` release
   * reports `'stop'`.
   *
   * @param options - Release reason (default `'explicit'`) and whether to let an
   *   in-flight generation finish first (bounded by that generation, not a timer)
   *
   * @example
   * ```typescript
   * // Free VRAM without stopping the wrapper
   * await diffusionServer.releaseBackend({ reason: 'explicit' });
   * ```
   */
  async releaseBackend(
    options: { reason?: DiffusionBackendReleaseReason; waitForInFlight?: boolean } = {}
  ): Promise<void> {
    const reason = options.reason ?? 'explicit';

    // NOTE: everything up to the state flip below must stay synchronous on the
    // no-wait path — cancelImageGeneration() relies on 'stopping' being visible
    // before it returns, so no respawn can slip past a dying backend.
    this.disarmIdleTimer();

    if (options.waitForInFlight) {
      // Deliberately BEFORE the progress teardown: the generation we are waiting for is
      // still reporting, and killing its synthetic ticker here would freeze its progress
      // for the rest of its run.
      const pending = this.currentGeneration?.promise;
      if (pending) await pending.catch(() => undefined);
    }

    this.cleanupSyntheticProgress();

    // Abort a spawn in progress instead of waiting out a 120 s cold load. The runner
    // maps an aborted start to SD_SERVER_START_ABORTED after a confirmed kill.
    this.backend.startAbort?.abort(
      new ServerError('stable-diffusion.cpp backend released before it was ready', {
        code: 'BACKEND_RELEASED_DURING_START',
        reason,
      })
    );

    while (this.backend.state === 'starting' && this.backend.startPromise) {
      await this.backend.startPromise.catch(() => undefined);
    }

    if (this.backend.state === 'stopping') {
      this.upgradeStopReason(reason);
      await this.backend.stopPromise;
      return;
    }
    if (this.backend.state === 'absent') {
      return;
    }

    const handle = this.backend.handle;
    this.backend.stopReason = reason;
    this.setBackendState('stopping', reason);
    const stopPromise = this.finishRelease(handle);
    this.backend.stopPromise = stopPromise;
    await stopPromise;
  }

  /**
   * Raise the pending release reason when a more important caller joins it
   * @private
   */
  private upgradeStopReason(reason: DiffusionBackendReleaseReason): void {
    const current = this.backend.stopReason;
    if (current === undefined || RELEASE_REASON_RANK[reason] > RELEASE_REASON_RANK[current]) {
      this.backend.stopReason = reason;
    }
  }

  /**
   * Snapshot of the internal stable-diffusion.cpp backend process
   *
   * @returns Backend state plus pid/timings/flags while a process is resident
   *
   * @example
   * ```typescript
   * if (diffusionServer.getBackendInfo().state === 'ready') {
   *   console.log('the next image skips the model load');
   * }
   * ```
   */
  getBackendInfo(): DiffusionBackendInfo {
    const info: DiffusionBackendInfo = { state: this.backend.state };
    if (this.backend.pid !== undefined) info.pid = this.backend.pid;
    if (this.backend.startedAt !== undefined) {
      info.startedAt = new Date(this.backend.startedAt).toISOString();
    }
    if (this.backend.loadTimeMs !== undefined) info.loadTimeMs = this.backend.loadTimeMs;
    if (this.backend.lastUsedAt !== undefined) {
      info.lastUsedAt = new Date(this.backend.lastUsedAt).toISOString();
    }
    if (this.backend.flags) info.flags = { ...this.backend.flags };
    return info;
  }

  /**
   * The built-in ResourceOrchestrator — the instance that performs the offload/reload
   * cycle for every generation routed through this manager (HTTP, async, batch) and
   * that yields a resident backend to an LLM start.
   *
   * Present when the manager was constructed with a `LlamaServerManager` (the exported
   * `diffusionServer` singleton always is); `undefined` otherwise. Use it to observe the
   * cycle — `getSavedState()`, `waitForReload()`, `wouldNeedOffload()` — instead of
   * constructing a second orchestrator, which would be a separate instance that never
   * receives this manager's backend-release notifications.
   *
   * @returns The live built-in orchestrator, or `undefined` without an LLM manager
   *
   * @example
   * ```typescript
   * const orchestrator = diffusionServer.getOrchestrator();
   * if (orchestrator?.getSavedState()) {
   *   await orchestrator.waitForReload();
   * }
   * ```
   */
  getOrchestrator(): ResourceOrchestrator | undefined {
    return this.orchestrator;
  }

  /**
   * Resolve the residency policy for one generation
   *
   * Precedence: the request's `usageMode` → the server-level
   * `DiffusionServerConfig.usageMode` (when set and not `'auto'`) → the computed
   * default, which is `'single'` when the LLM had to be offloaded to make room for
   * this image (release the VRAM so it can come back) and `'burst'` otherwise (stay
   * warm for the next image).
   *
   * @param requestMode - Per-request policy, if the caller set one
   * @param llmWasOffloaded - Whether the LLM was offloaded for this generation
   * @returns The policy {@link settleResidency} should apply
   * @internal
   */
  public resolveUsageMode(
    requestMode: DiffusionUsageMode | undefined,
    llmWasOffloaded: boolean
  ): DiffusionUsageMode {
    if (requestMode === 'burst' || requestMode === 'single') {
      return requestMode;
    }

    const configured = (this._config as DiffusionServerConfig | undefined)?.usageMode;
    if (configured === 'burst' || configured === 'single') {
      return configured;
    }

    return llmWasOffloaded ? 'single' : 'burst';
  }

  /**
   * Apply a residency policy once a generation is done
   *
   * `'single'` releases the backend (and its VRAM) right away; `'burst'` leaves it
   * resident and arms the idle timer. Called exactly once per generation by whoever
   * owns the offload context — the ResourceOrchestrator when one is wired up, and
   * `generateImage()`/the async HTTP path otherwise. Calibration never settles: it
   * manages the backend itself.
   *
   * @param mode - Residency policy from {@link resolveUsageMode}
   * @internal
   */
  public async settleResidency(mode: DiffusionUsageMode): Promise<void> {
    if (mode === 'single') {
      await this.releaseBackend({ reason: 'single' });
      return;
    }
    this.armIdleTimer();
  }

  /**
   * Settle residency for a path that owns the (empty) offload context
   *
   * Used by the no-orchestrator branches, where no LLM was offloaded. Never throws:
   * a failed release must not mask the generation's own outcome.
   *
   * @param requestMode - The request's `usageMode`, if any
   * @private
   */
  private async settleResidencyWithoutOffload(
    requestMode: DiffusionUsageMode | undefined
  ): Promise<void> {
    try {
      await this.settleResidency(this.resolveUsageMode(requestMode, false));
    } catch (error) {
      debugLog('[Diffusion] residency settle failed:', error);
    }
  }

  /**
   * Transition the backend state machine and announce it
   * @private
   */
  private setBackendState(
    state: DiffusionBackendState,
    reason?: DiffusionBackendStatusEvent['reason'],
    exit?: SdServerExit
  ): void {
    const previous = this.backend.state;
    if (previous === state && reason === undefined) return;
    this.backend.state = state;

    const event: DiffusionBackendStatusEvent = { state, previous };
    if (reason !== undefined) event.reason = reason;
    if (exit) event.exit = { code: exit.code, signal: exit.signal };
    try {
      this.emitEvent('backend-status', event);
    } catch (error) {
      // A host listener must never be able to derail the state machine
      debugLog('[Diffusion] backend-status listener threw:', error);
    }
  }

  /**
   * Ensure a backend process with exactly these offload flags is ready
   *
   * Reuses a resident backend when the flags match, awaits an in-progress spawn or
   * release, and respawns when the flags differ (offload flags are launch args).
   *
   * @param flags - Resolved offload flags for this generation
   * @param options - Startup-only cancellation signal
   * @returns The ready handle, a client bound to it, and whether this call had to
   *   spawn (the caller's progress model needs cold vs warm)
   * @throws {ServerError} When the wrapper is stopping/stopped (outside calibration),
   *   or a previous backend's termination was never confirmed and its PID is alive
   * @private
   */
  private async ensureBackend(
    flags: ResolvedDiffusionFlags,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ handle: SdServerHandle; client: SdServerClient; spawned: boolean }> {
    let spawned = false;

    // Each iteration makes progress (await a spawn/release, or spawn). The cap only
    // exists so a pathological state machine surfaces as an error, never as a livelock.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this._status === 'stopping' || (this._status === 'stopped' && !this.calibrating)) {
        throw new ServerError('Server is not running', {
          code: 'SERVER_NOT_RUNNING',
          status: this._status,
          suggestion: 'Start the server first with start()',
        });
      }

      if (this.backend.state === 'starting' && this.backend.startPromise) {
        spawned = true;
        await this.backend.startPromise;
        continue;
      }

      if (this.backend.state === 'stopping') {
        // Never spawn a second child while the first one's death is unproven
        await (this.backend.stopPromise ?? delay(0));
        continue;
      }

      if (this.backend.state === 'ready' || this.backend.state === 'busy') {
        if (
          this.backend.handle &&
          this.backend.client &&
          this.backend.flags &&
          flagsEqual(this.backend.flags, flags)
        ) {
          return { handle: this.backend.handle, client: this.backend.client, spawned };
        }
        await this.releaseBackend({ reason: 'flags-changed' });
        continue;
      }

      this.assertNoUnconfirmedBackend();

      spawned = true;
      const startAbort = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, startAbort.signal])
        : startAbort.signal;
      const startPromise = this.spawnBackend(flags, signal);
      this.backend.startPromise = startPromise;
      this.backend.startAbort = startAbort;
      try {
        await startPromise;
      } finally {
        if (this.backend.startPromise === startPromise) {
          this.backend.startPromise = undefined;
        }
        if (this.backend.startAbort === startAbort) {
          this.backend.startAbort = undefined;
        }
      }
    }

    throw new ServerError('Could not settle the stable-diffusion.cpp backend state', {
      code: 'BACKEND_STATE_UNSETTLED',
      state: this.backend.state,
      suggestion: 'Stop and restart the diffusion server',
    });
  }

  /**
   * Refuse to spawn while a previously killed backend may still be alive
   *
   * A `SD_SERVER_TERMINATION_UNCONFIRMED` release leaves a PID behind; starting a
   * second backend over it would double the VRAM claim. The record is sticky until
   * the PID is observably gone.
   * @private
   */
  private assertNoUnconfirmedBackend(): void {
    const pid = this.unconfirmedBackendPid;
    if (pid === undefined) return;

    if (!this.isProcessAlive(pid)) {
      this.unconfirmedBackendPid = undefined;
      return;
    }

    throw new ServerError(
      `stable-diffusion.cpp backend termination could not be confirmed (pid ${pid}); refusing to start a second backend`,
      {
        code: 'BACKEND_TERMINATION_UNCONFIRMED',
        pid,
        suggestion: `End process ${pid} manually, then retry`,
      }
    );
  }

  /**
   * Liveness probe for a PID (same semantics as ProcessManager.isRunning)
   * @private
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 performs the permission/existence check without delivering a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn one backend process with the given flags and wait until it is ready
   * @private
   */
  private async spawnBackend(flags: ResolvedDiffusionFlags, signal?: AbortSignal): Promise<void> {
    if (!this.currentModelInfo) {
      throw new ServerError('Model information not available', {
        suggestion: 'This is an internal error - model should have been loaded',
      });
    }
    if (!this.binaryPath) {
      throw new ServerError('stable-diffusion.cpp binary is not available', {
        suggestion: 'This is an internal error - the binary is provisioned by start()',
      });
    }

    const serverConfig = (this._config ?? {}) as DiffusionServerConfig;
    const modelArgs = this.buildBackendModelArgs(this.currentModelInfo);
    const contextArgs = this.buildDiffusionOptimizationArgs(flags);

    // Published before the first await so a concurrent ensureBackend() awaits this
    // spawn instead of starting a second one
    this.setBackendState('starting', 'spawned');
    // Cold start: the model load belongs to this generation's 'loading' stage. Whatever
    // the caller assumed when it seeded the progress model, this IS a cold generation —
    // re-seed with the cold estimate before any loading progress is reported.
    this.loadStartTime = Date.now();
    this.currentLoadEstimate = this.modelLoadTime;
    if (this.progressConfig) this.recalculateTotalEstimatedTime(this.progressConfig);
    const startedAt = Date.now();

    // Electron-side directory creation keeps the runner Node-safe
    await ensureDirectory(PATHS.loras);

    void this.logManager
      ?.write(
        `Starting sd-server backend: ${this.binaryPath} ${[...modelArgs, ...contextArgs].join(' ')}`,
        'info'
      )
      .catch(() => void 0);

    // Filled in once the child is up, so the tap can drop events from a stale child
    const tap: { handle?: SdServerHandle } = {};

    let handle: SdServerHandle;
    try {
      handle = await startSdServerRunner({
        binaryPath: this.binaryPath,
        modelArgs,
        contextArgs,
        ...(serverConfig.threads !== undefined ? { threads: serverConfig.threads } : {}),
        loraDir: PATHS.loras,
        readyTimeoutMs: serverConfig.startupTimeout ?? DIFFUSION_BACKEND_DEFAULTS.readyTimeoutMs,
        onStdoutEvent: (event) => {
          // Before the handle exists these are this spawn's own startup lines;
          // afterwards, only the resident child may drive the progress model.
          if (tap.handle !== undefined && this.backend.handle !== tap.handle) return;
          // Ahead of the progress model: a byte/step bar is a sign of life even when
          // no generation is in flight to attribute it to (handleBackendStdoutEvent
          // returns early without a progressConfig).
          this.markBackendActivity();
          this.handleBackendStdoutEvent(event);
        },
        onLog: (line, stream) => {
          // Any complete line from the resident child is a sign of life, including the
          // progress-bar frames dropped from the log file just below. Trailing lines
          // flushed by a dying child are still logged but — same guard as
          // onStdoutEvent — must not reset a newer job's watchdog clock.
          if (tap.handle === undefined || this.backend.handle === tap.handle) {
            this.markBackendActivity();
          }
          // Progress bars redraw many times per second and already reach the
          // progress model as structured events — keep them out of the log file.
          if (isSdServerProgressBarLine(line)) return;
          void this.logManager
            ?.write(line, stream === 'stderr' ? 'warn' : 'info')
            .catch(() => void 0);
        },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      this.cleanupSyntheticProgress();
      // A failed start whose teardown could not be confirmed leaves a live child that
      // still owns the GPU. Record it exactly as finishRelease() does, so the next
      // ensureBackend() refuses to spawn a second backend over it.
      const details =
        error instanceof GenaiElectronError && error.details && typeof error.details === 'object'
          ? (error.details as Record<string, unknown>)
          : undefined;
      if (details?.code === 'SD_SERVER_TERMINATION_UNCONFIRMED') {
        this.unconfirmedBackendPid =
          typeof details.pid === 'number' ? details.pid : this.backend.pid;
      }
      // The runner already killed (and confirmed) the child it could not bring up —
      // 'start-failed', not 'crashed': no working backend ever existed.
      if (this.backend.state === 'starting') this.setBackendState('absent', 'start-failed');
      throw error;
    }

    tap.handle = handle;
    this.backend.handle = handle;
    this.backend.client = new SdServerClient(
      handle.port,
      handle.host,
      DIFFUSION_BACKEND_DEFAULTS.jobRequestTimeoutMs
    );
    this.backend.flags = { ...flags };
    this.backend.pid = handle.pid;
    this.backend.startedAt = startedAt;
    this.backend.loadTimeMs = handle.loadTimeMs;
    this.backend.lastUsedAt = undefined;

    // Exact-child exit watcher: an unexpected exit fails the in-flight job and
    // leaves the wrapper running (the next request simply respawns).
    void handle.exitPromise
      .then((exit) => {
        this.handleBackendExit(handle, exit);
      })
      .catch(() => void 0);

    this.setBackendState('ready', 'ready');
    void this.logManager
      ?.write(`sd-server backend ready on port ${handle.port} (${handle.loadTimeMs} ms)`, 'info')
      .catch(() => void 0);
  }

  /**
   * Kill the backend and wait for confirmed death, then publish 'absent'
   *
   * The reason reported here is read from `backend.stopReason` at the end, so a
   * higher-ranked release that joined mid-kill is the one the event and the
   * orchestrator callback see.
   * @private
   */
  private async finishRelease(handle: SdServerHandle | undefined): Promise<void> {
    this.cleanupSyntheticProgress();

    try {
      await handle?.stop();
    } catch (error) {
      // A stop failure (incl. SD_SERVER_TERMINATION_UNCONFIRMED) must not leave the
      // manager stuck in 'stopping' — it is logged loudly and the state machine moves
      // on; the runner already escalated to SIGKILL before giving up.
      const details =
        error instanceof GenaiElectronError && error.details && typeof error.details === 'object'
          ? (error.details as Record<string, unknown>)
          : undefined;
      if (details?.code === 'SD_SERVER_TERMINATION_UNCONFIRMED') {
        // Sticky until the PID is observably gone: a live orphan still owns the GPU
        this.unconfirmedBackendPid =
          typeof details.pid === 'number' ? details.pid : this.backend.pid;
      }
      void this.logManager
        ?.write(
          `Failed to stop the sd-server backend cleanly: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error'
        )
        .catch(() => void 0);
      debugLog('[Diffusion] backend stop failed:', error);
    }

    const reason = this.backend.stopReason ?? 'explicit';
    this.backend.handle = undefined;
    this.backend.client = undefined;
    this.backend.flags = undefined;
    this.backend.pid = undefined;
    this.backend.startedAt = undefined;
    this.backend.loadTimeMs = undefined;
    this.backend.lastUsedAt = undefined;
    this.backend.stopPromise = undefined;
    this.backend.stopReason = undefined;
    this.setBackendState('absent', reason);
    this.onBackendReleased(reason);
  }

  /**
   * Handle an observed backend exit
   *
   * Intentional kills are already accounted for by releaseBackend() (state
   * 'stopping'). Anything else is a crash: the in-flight job fails, the backend
   * becomes 'absent' and the wrapper keeps running — 'crashed' as a server event
   * keeps meaning "the server is down".
   * @private
   */
  private handleBackendExit(handle: SdServerHandle, exit: SdServerExit): void {
    if (this.backend.handle !== handle) return; // stale child
    if (this.backend.state === 'stopping') return; // intended kill

    this.cleanupSyntheticProgress();
    this.disarmIdleTimer();
    this.backend.handle = undefined;
    this.backend.client = undefined;
    this.backend.flags = undefined;
    this.backend.pid = undefined;
    this.backend.startedAt = undefined;
    this.backend.loadTimeMs = undefined;
    this.backend.lastUsedAt = undefined;
    this.setBackendState('absent', 'crashed', exit);

    void this.logManager
      ?.write(
        `sd-server backend exited unexpectedly (code ${String(exit.code)}, signal ${String(
          exit.signal
        )})`,
        'error'
      )
      .catch(() => void 0);

    this.inFlight?.reject(backendExitError(handle, exit));
    this.onBackendReleased('crashed');
  }

  /**
   * Arm the idle timer for a resident backend
   *
   * `idleTimeoutMs: 0` disables it entirely (the host owns the release).
   * Armed only by `settleResidency('burst')`, which owns the residency decision —
   * a bare `executeImageGeneration()` (calibration, a batch loop between images)
   * deliberately leaves the backend warm with no timer.
   * @private
   */
  private armIdleTimer(): void {
    this.disarmIdleTimer();
    if (this.backend.state !== 'ready') return;

    const serverConfig = (this._config ?? {}) as DiffusionServerConfig;
    const idleTimeoutMs = serverConfig.idleTimeoutMs ?? DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      this.backend.idleTimer = undefined;
      void this.releaseBackend({ reason: 'idle-timeout' }).catch((error: unknown) => {
        debugLog('[Diffusion] idle release failed:', error);
      });
    }, idleTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.backend.idleTimer = timer;
  }

  /**
   * Cancel a pending idle release
   * @private
   */
  private disarmIdleTimer(): void {
    if (this.backend.idleTimer) {
      clearTimeout(this.backend.idleTimer);
      this.backend.idleTimer = undefined;
    }
  }

  /**
   * Record a sign of life from the backend (resets the stuck-job watchdog)
   *
   * Called from the stdout tap (progress bars, stage markers), the log tap (any
   * complete line) and the job poll loop (a status or queue-position CHANGE). A poll
   * that answers `generating` again is deliberately NOT activity: that is exactly what
   * a wedged backend keeps doing.
   * @private
   */
  private markBackendActivity(): void {
    this.lastBackendActivityAt = Date.now();
  }

  /**
   * Arm the stuck-job watchdog for one in-flight backend job
   *
   * `jobActivityTimeoutMs: 0` (or a non-finite value) disables it entirely. The timer
   * ticks rather than being rescheduled per event, because activity arrives many times
   * per second while sampling; each tick compares the configured budget against
   * {@link lastBackendActivityAt} and, on expiry, hands `onExpiry` the observed idle
   * time. Armed and disarmed strictly inside one `executeImageGeneration()` call, so a
   * batch loop gets one watchdog per image and never one around the batch.
   *
   * @param owner - The job this watchdog belongs to (identity guard: a later
   *   generation owning the slot silences an inherited tick)
   * @param onExpiry - Invoked once, after the watchdog is disarmed
   * @private
   */
  private armJobActivityWatchdog(
    owner: InFlightBackendJob,
    onExpiry: (idleMs: number, timeoutMs: number) => void
  ): void {
    this.clearJobActivityTimer();

    const serverConfig = (this._config ?? {}) as DiffusionServerConfig;
    const timeoutMs =
      serverConfig.jobActivityTimeoutMs ?? DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    this.markBackendActivity();

    const tickMs = Math.max(1, Math.min(JOB_ACTIVITY_TICK_MAX_MS, Math.floor(timeoutMs / 10)));
    const timer = setInterval(() => {
      if (this.jobActivityOwner !== owner) return;
      const idleMs = Date.now() - this.lastBackendActivityAt;
      if (idleMs < timeoutMs) return;
      this.disarmJobActivityWatchdog(owner);
      onExpiry(idleMs, timeoutMs);
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.jobActivityTimer = timer;
    this.jobActivityOwner = owner;
  }

  /**
   * Disarm the stuck-job watchdog owned by `owner` (no-op for a foreign owner)
   * @private
   */
  private disarmJobActivityWatchdog(owner: InFlightBackendJob): void {
    if (this.jobActivityOwner !== owner) return;
    this.clearJobActivityTimer();
  }

  /**
   * Drop whatever stuck-job watchdog is armed
   * @private
   */
  private clearJobActivityTimer(): void {
    if (this.jobActivityTimer) clearInterval(this.jobActivityTimer);
    this.jobActivityTimer = undefined;
    this.jobActivityOwner = undefined;
  }

  /**
   * Hook invoked after the backend is confirmed gone
   *
   * Forwards the FINAL (rank-upgraded) release reason to the orchestrator so a
   * previously offloaded LLM can come back — but only for the reasons that really
   * mean "the VRAM is free again"; the orchestrator owns that filter.
   * @private
   */
  private onBackendReleased(reason: DiffusionBackendReleaseReason): void {
    debugLog('[Diffusion] backend released:', reason);
    try {
      this.orchestrator?.onDiffusionBackendReleased(reason);
    } catch (error) {
      // A throwing callback must never derail the backend state machine
      debugLog('[Diffusion] orchestrator release callback threw:', error);
    }
  }

  /**
   * Model/component launch arguments for the backend process
   * @private
   */
  private buildBackendModelArgs(modelInfo: ModelInfo): string[] {
    const args: string[] = [];

    if (modelInfo.components) {
      if (!modelInfo.components.diffusion_model) {
        throw new ServerError(
          'Multi-component model is missing required diffusion_model component',
          {
            modelId: modelInfo.id,
            components: Object.keys(modelInfo.components),
            suggestion: 'The model metadata appears corrupted. Try re-downloading the model.',
          }
        );
      }
      for (const role of DIFFUSION_COMPONENT_ORDER) {
        const component = modelInfo.components[role];
        if (component) {
          args.push(DIFFUSION_COMPONENT_FLAGS[role], component.path);
        }
      }
    } else {
      args.push('-m', modelInfo.path);
    }

    return args;
  }

  /**
   * Benchmark CPU-offload flag combinations on this machine (offload calibration)
   *
   * Runs a sweep of real generations across the given sizes × combos and returns
   * a report with per-run timings, per-stage splits, OOM/error classification,
   * and the fastest working combo per size. The optimum depends on the whole
   * system (driver behaviour, PCIe/RAM bandwidth, CPU speed, OS) and the flags
   * interact — measuring on the target machine is the only reliable way to pick.
   *
   * Contract:
   * - The server must be STOPPED and is left stopped afterwards; start() throws
   *   while a calibration is in flight.
   * - config.usageMode selects WHAT is measured (default 'single'): 'single' makes
   *   every timed sample a cold spawn -> generate -> release cycle (single-shot
   *   latency), 'burst' launches the backend once per combo and times warm samples.
   *   The report echoes the mode and the policy version, because timings from the two
   *   modes are not comparable.
   * - When constructed with a llamaServer, a running LLM is offloaded once for
   *   the whole sweep and restored afterwards. Otherwise stop the LLM yourself
   *   before calibrating.
   * - Combos that fail are recorded ('oom'/'error') and never abort the sweep.
   * - Progress is delivered via config.onProgress and 'calibration-progress'
   *   events (same payload); first-run binary provisioning happens during the
   *   'preparing' phase and reports via 'binary-progress'.
   * - Aborting via config.signal rejects with a ServerError whose
   *   details.code === 'CALIBRATION_ABORTED' and details.runs = partial runs.
   *
   * @param config - Calibration configuration (modelId required)
   * @returns Calibration report — the caller persists/applies the recommendation
   * @throws {ServerError} If the server is running, a calibration is already in
   *   flight, sizes are invalid, or the sweep is aborted
   * @throws {ModelNotFoundError} If the model doesn't exist or is not a diffusion model
   * @throws {InsufficientResourcesError} If the system cannot run the model
   *
   * @example
   * ```typescript
   * const report = await diffusionServer.calibrate({
   *   modelId: 'flux-2-klein',
   *   sizes: [{ width: 768, height: 768 }],
   *   steps: 4, // your app's real step count
   *   onProgress: (p) => console.log(`${p.phase} ${Math.round(p.overallPercent)}%`),
   * });
   * const best = report.recommended['768x768'];
   * // Persist `best` and pass its flags to future start() calls
   * ```
   */
  async calibrate(config: DiffusionCalibrationConfig): Promise<DiffusionCalibrationReport> {
    if (this._status !== 'stopped') {
      throw new ServerError('Cannot calibrate while the server is running', {
        suggestion: 'Stop the server with stop() before calibrating',
      });
    }
    if (this.calibrating) {
      throw new ServerError('Calibration is already in progress', {
        suggestion: 'Wait for the current calibrate() call to finish',
      });
    }

    const defaults = DIFFUSION_CALIBRATION_DEFAULTS;
    const sizes = config.sizes;
    if (!sizes || sizes.length === 0) {
      throw new ServerError('Calibration requires at least one size in config.sizes', {
        suggestion:
          'Pass the size(s) your app generates at, e.g. sizes: [{ width: 768, height: 768 }]',
      });
    }
    for (const size of sizes) {
      if (
        !Number.isInteger(size.width) ||
        !Number.isInteger(size.height) ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width % 64 !== 0 ||
        size.height % 64 !== 0
      ) {
        throw new ServerError(
          `Invalid calibration size ${size.width}x${size.height}: dimensions must be positive multiples of 64`,
          { suggestion: 'Use sd.cpp-compatible dimensions, e.g. 512x512, 768x768, 512x1024' }
        );
      }
    }
    const samples = Math.max(1, Math.floor(config.samples ?? defaults.samples));
    // What the sweep measures: cold single-shot latency ('single') or warm burst
    // latency ('burst'). Echoed in the report — the two are not comparable.
    const usageMode: DiffusionUsageMode = config.usageMode ?? defaults.usageMode;
    const steps = config.generation.steps;
    const cfgScale = config.generation.cfgScale;
    const seed = config.seed ?? defaults.seed;
    const sampler = config.generation.sampler;
    const prompt = config.prompt ?? defaults.prompt;

    const runs: CalibrationRun[] = [];
    if (config.signal?.aborted) {
      throw this.calibrationAbortError(runs);
    }

    this.calibrating = true;

    // Instance state executeImageGeneration depends on — restored in finally
    const savedConfig = this._config;
    const savedModelInfo = this.currentModelInfo;
    const savedBinaryPath = this.binaryPath;

    const abortListener = (): void => {
      this.currentGeneration?.cancel();
    };
    config.signal?.addEventListener('abort', abortListener);

    // Hoisted for the finally block ('restoring-llm'/'done' emits, sampler teardown)
    let emitFn: ((p: DiffusionCalibrationProgress) => void) | undefined;
    let comboCountForProgress = 0;
    let lastOverallPercent = 0;
    let succeeded = false;
    let vramSampler: CalibrationVramSampler | undefined;

    try {
      // --- Setup (phase 'preparing') ---
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      if (modelInfo.type !== 'diffusion') {
        throw new ModelNotFoundError(
          `Model ${config.modelId} is not a diffusion model (type: ${modelInfo.type})`
        );
      }

      // Combo list (SD3.5-Large filter applied up-front so progress counts are accurate).
      // Per-sweep copies: report.runs[].combo / recommended hand these objects to the
      // caller, so never share references with DIFFUSION_CALIBRATION_DEFAULTS.combos.
      const requestedCombos = (
        config.combos && config.combos.length > 0 ? config.combos : defaults.combos
      ).map((combo) => ({ ...combo }));
      const skippedCombos: { combo: DiffusionOffloadCombo; reason: string }[] = [];
      let combos = requestedCombos;
      if (
        defaults.sd35LargePattern.test(modelInfo.id) ||
        defaults.sd35LargePattern.test(modelInfo.name)
      ) {
        combos = requestedCombos.filter((combo) => {
          if (combo.clipOnCpu === true) {
            skippedCombos.push({
              combo,
              reason:
                'SD3.5-Large produces garbled output with --clip-on-cpu (leejet/stable-diffusion.cpp#1578)',
            });
            return false;
          }
          return true;
        });
      }
      if (combos.length === 0) {
        throw new ServerError('No offload combos left to benchmark after SD3.5-Large filtering', {
          skippedCombos,
          suggestion: 'Provide combos without clipOnCpu: true for this model',
        });
      }
      comboCountForProgress = combos.length;

      // Progress plumbing: units = every generation in the sweep (warmups included).
      // Units skipped by failure handling are counted as completed so the bar
      // still reaches 100 by folding (no stall-then-jump).
      const totalUnits = combos.length * (1 + samples * sizes.length);
      let completedUnits = 0;
      const emit = (p: DiffusionCalibrationProgress): void => {
        try {
          config.onProgress?.(p);
        } catch (error) {
          debugLog('[Calibrate] onProgress callback threw:', error);
        }
        try {
          this.emit('calibration-progress', p);
        } catch (error) {
          debugLog('[Calibrate] calibration-progress listener threw:', error);
        }
      };
      emitFn = emit;
      const overallPercent = (generationFraction = 0): number => {
        const pct = Math.min(100, ((completedUnits + generationFraction) / totalUnits) * 100);
        // Clamp monotonic: per-generation estimates can dip when their
        // denominator re-calibrates mid-generation
        lastOverallPercent = Math.max(lastOverallPercent, pct);
        return lastOverallPercent;
      };

      emit({
        phase: 'preparing',
        comboIndex: 0,
        comboCount: combos.length,
        sizeIndex: 0,
        sizeCount: sizes.length,
        overallPercent: 0,
      });

      const canRun = await this.systemInfo.canRunModel(modelInfo, { checkTotalMemory: true });
      if (!canRun.possible) {
        const memoryInfo = this.systemInfo.getMemoryInfo();
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Total RAM: ${Math.round(memoryInfo.total / 1024 / 1024 / 1024)}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
          }
        );
      }

      if (!this.logManager) {
        await this.initializeLogManager('diffusion-server.log', 'Offload calibration starting');
      }
      // Fire-and-forget (matching executeImageGeneration): a log-write failure
      // must never abort a sweep this expensive
      void this.logManager
        ?.write(
          `Calibration: model=${config.modelId}, sizes=${sizes
            .map((s) => `${s.width}x${s.height}`)
            .join(',')}, combos=${combos.length}${
            skippedCombos.length > 0 ? ` (${skippedCombos.length} skipped: SD3.5-Large)` : ''
          }, steps=${steps}, samples=${samples}, usageMode=${usageMode}`,
          'info'
        )
        .catch(() => void 0);

      // Install working state. May download the binary on first run
      // (long; reports via 'binary-progress'/'binary-log' events).
      this.currentModelInfo = modelInfo;
      const syntheticConfig: DiffusionServerConfig = { modelId: config.modelId };
      if (config.generation.threads !== undefined) {
        syntheticConfig.threads = config.generation.threads;
      }
      if (config.generation.batchSize !== undefined) {
        syntheticConfig.batchSize = config.generation.batchSize;
      }
      this._config = syntheticConfig as unknown as typeof this._config;
      this.binaryPath = await this.ensureBinary(modelInfo);
      if (config.signal?.aborted) {
        throw this.calibrationAbortError(runs);
      }

      // Offload a running LLM once for the whole sweep (measurement hygiene).
      // waitForReload() first: a background reload from a prior orchestrated
      // generation would otherwise read as not-running and come back mid-sweep.
      await this.orchestrator?.waitForReload();
      await this.orchestrator?.offloadLLM();

      // Machine-wide VRAM sampling for the timed windows (undefined when the platform
      // exposes no trustworthy VRAM availability — the sweep runs unchanged either way)
      vramSampler = await this.createCalibrationVramSampler();

      // --- Sweep (combo-outer, size-inner; every generation does identical work) ---
      for (let comboIndex = 0; comboIndex < combos.length; comboIndex++) {
        const combo = combos[comboIndex]!;
        const baseProgress = {
          comboIndex,
          comboCount: combos.length,
          combo,
          sizeCount: sizes.length,
        };

        // Warmup at the first size. Discarded either way, but for different reasons:
        // in 'burst' it absorbs the spawn and the lazy weight placement so the timed
        // samples are warm; in 'single' it primes the OS page cache and the driver so
        // the timed cold spawns are not the first one on this machine.
        let warmupFailure: { status: 'oom' | 'error'; message: string } | undefined;
        if (config.signal?.aborted) {
          throw this.calibrationAbortError(runs);
        }
        emit({
          phase: 'warmup',
          ...baseProgress,
          sizeIndex: 0,
          size: sizes[0]!,
          overallPercent: overallPercent(),
        });
        try {
          if (usageMode === 'single') {
            // Cold by construction, and re-check the signal afterwards so an abort
            // that lands during the release cannot buy a whole extra generation
            await this.releaseCalibrationBackend();
            if (config.signal?.aborted) {
              throw this.calibrationAbortError(runs);
            }
          }
          await this.runCalibrationGeneration({
            prompt,
            size: sizes[0]!,
            steps,
            cfgScale,
            seed,
            sampler,
            combo,
            onGenerationProgress: (pct) =>
              emit({
                phase: 'warmup',
                ...baseProgress,
                sizeIndex: 0,
                size: sizes[0]!,
                generationPercent: pct,
                overallPercent: overallPercent(pct / 100),
              }),
          });
        } catch (error) {
          if (config.signal?.aborted) {
            throw this.calibrationAbortError(runs);
          }
          warmupFailure = this.classifyCalibrationFailure(error);
        } finally {
          // Also on failure: the next attempt must start from no backend at all
          if (usageMode === 'single') {
            await this.releaseCalibrationBackend();
          }
        }
        completedUnits++;

        for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
          const size = sizes[sizeIndex]!;
          const samplesMs: number[] = [];
          const snapshots: { loadMs?: number; diffusionMs?: number; decodeMs?: number }[] = [];
          const vramSamples: CalibrationVramSample[] = [];
          let resolved: CalibrationRun['resolved'];
          let failure: { status: 'oom' | 'error'; message: string } | undefined;

          if (sizeIndex === 0 && warmupFailure) {
            // Warmup already failed at this size — skip its timed samples.
            // Later sizes are still attempted (failure at one size doesn't
            // imply failure at another).
            failure = warmupFailure;
            completedUnits += samples;
          } else {
            for (let sample = 1; sample <= samples; sample++) {
              if (config.signal?.aborted) {
                throw this.calibrationAbortError(runs);
              }
              emit({
                phase: 'sampling',
                ...baseProgress,
                sizeIndex,
                size,
                sample,
                sampleCount: samples,
                overallPercent: overallPercent(),
              });
              try {
                if (usageMode === 'single') {
                  // Release BEFORE the timed window: the sample must pay for the spawn
                  // and the weight load, exactly like a one-off production image does
                  await this.releaseCalibrationBackend();
                  if (config.signal?.aborted) {
                    throw this.calibrationAbortError(runs);
                  }
                }
                let result: ImageGenerationResult;
                await vramSampler?.begin();
                try {
                  result = await this.runCalibrationGeneration({
                    prompt,
                    size,
                    steps,
                    cfgScale,
                    seed,
                    sampler,
                    combo,
                    onGenerationProgress: (pct) =>
                      emit({
                        phase: 'sampling',
                        ...baseProgress,
                        sizeIndex,
                        size,
                        sample,
                        sampleCount: samples,
                        generationPercent: pct,
                        overallPercent: overallPercent(pct / 100),
                      }),
                  });
                } finally {
                  // Close the peak window, then settle: 'single' releases the backend
                  // first (untimed), so its idle figure is what the combo leaves behind;
                  // 'burst' reads what it keeps resident between images.
                  await vramSampler?.end();
                  if (usageMode === 'single') {
                    await this.releaseCalibrationBackend();
                  }
                  await vramSampler?.measureIdle();
                }
                // executeImageGeneration() times itself from before ensureBackend(), so
                // a cold sample's total already includes spawn + weight load
                samplesMs.push(result.timeTaken);
                // Snapshot per sample: the stage timestamps are instance
                // fields reset by the next generation
                snapshots.push(this.snapshotStageMs());
                vramSamples.push(vramSampler?.result() ?? {});
                resolved = this.lastResolvedOptimizations
                  ? { ...this.lastResolvedOptimizations }
                  : undefined;
                completedUnits++;
              } catch (error) {
                if (config.signal?.aborted) {
                  throw this.calibrationAbortError(runs);
                }
                failure = this.classifyCalibrationFailure(error);
                // Failed sample + skipped remainder count as completed units
                completedUnits += samples - sample + 1;
                break;
              }
            }
          }

          // Bookkeeping invariant: exactly one CalibrationRun per (combo, size)
          const run: CalibrationRun = { size, combo, status: failure ? failure.status : 'ok' };
          if (resolved) {
            run.resolved = resolved;
          }
          if (samplesMs.length > 0) {
            run.samplesMs = samplesMs;
          }
          if (failure) {
            run.error = failure.message;
          } else {
            const median = medianOf(samplesMs);
            run.timeTakenMs = median;
            // Stage split of the sample whose total is closest to the median
            let bestIdx = 0;
            for (let i = 1; i < samplesMs.length; i++) {
              if (Math.abs(samplesMs[i]! - median) < Math.abs(samplesMs[bestIdx]! - median)) {
                bestIdx = i;
              }
            }
            const stage = snapshots[bestIdx];
            if (
              stage &&
              (stage.loadMs !== undefined ||
                stage.diffusionMs !== undefined ||
                stage.decodeMs !== undefined)
            ) {
              run.stageMs = stage;
            }
            // VRAM comes from the same representative sample as the stage split
            const vram = vramSamples[bestIdx];
            if (vram?.vramPeakBytes !== undefined) {
              run.vramPeakBytes = vram.vramPeakBytes;
            }
            if (vram?.vramIdleBytes !== undefined) {
              run.vramIdleBytes = vram.vramIdleBytes;
            }
          }
          runs.push(run);
          void this.logManager
            ?.write(
              `Calibration run: ${combo.label ?? JSON.stringify(combo)} @ ${size.width}x${size.height} → ${run.status}${
                run.timeTakenMs !== undefined ? ` (${Math.round(run.timeTakenMs)} ms)` : ''
              }${run.error ? ` — ${run.error.split('\n')[0]}` : ''}`,
              run.status === 'ok' ? 'info' : 'warn'
            )
            .catch(() => void 0);
        }

        // 'burst' held one backend for the whole combo — free its VRAM before the next
        // combo's launch ('single' already released after every generation)
        if (usageMode === 'burst') {
          await this.releaseCalibrationBackend();
        }
      }

      // --- Report ---
      const recommended = pickRecommended(runs, defaults.tieTolerancePct);

      const machine: DiffusionCalibrationReport['machine'] = {};
      try {
        const gpu = await this.systemInfo.getGPUInfo();
        machine.gpuType = gpu.type;
        machine.gpuName = gpu.name;
        machine.vramBytes = gpu.vram;
        machine.vramAvailableBytes = gpu.vramAvailable;
      } catch {
        // GPU info unavailable — leave the machine fingerprint empty
      }

      const report: DiffusionCalibrationReport = {
        machine,
        modelId: config.modelId,
        steps,
        cfgScale,
        sampler,
        samples,
        usageMode,
        policyVersion: defaults.policyVersion,
        runs,
        recommended,
      };
      if (skippedCombos.length > 0) {
        report.skippedCombos = skippedCombos;
      }

      succeeded = true;
      return report;
    } finally {
      config.signal?.removeEventListener('abort', abortListener);

      // First: no sampling timer may outlive the sweep, whatever ended it
      vramSampler?.dispose();

      // Never leave a backend (and its VRAM) behind: an aborted sweep, or a 'burst'
      // combo that failed before its release, would otherwise stay resident while the
      // server is 'stopped'
      await this.releaseCalibrationBackend();

      // Restore instance state (server remains stopped)
      this._config = savedConfig;
      this.currentModelInfo = savedModelInfo;
      this.binaryPath = savedBinaryPath;

      // Release the manager before the awaited LLM reload: reloadLLM() is
      // contractually never-throwing, but if that ever regressed a throw here
      // must not leave the manager permanently locked in calibrating state
      this.calibrating = false;

      if (this.orchestrator) {
        emitFn?.({
          phase: 'restoring-llm',
          comboIndex: Math.max(0, comboCountForProgress - 1),
          comboCount: comboCountForProgress,
          sizeIndex: Math.max(0, sizes.length - 1),
          sizeCount: sizes.length,
          overallPercent: succeeded ? 100 : lastOverallPercent,
        });
        await this.orchestrator.reloadLLM();
      }

      if (succeeded) {
        emitFn?.({
          phase: 'done',
          comboIndex: Math.max(0, comboCountForProgress - 1),
          comboCount: comboCountForProgress,
          sizeIndex: Math.max(0, sizes.length - 1),
          sizeCount: sizes.length,
          overallPercent: 100,
        });
      }
    }
  }

  /**
   * Check if an offload-calibration sweep is currently running
   *
   * The server status stays 'stopped' during calibration; this is the
   * dedicated signal for calibration exclusivity.
   *
   * @returns True while calibrate() is in flight
   */
  isCalibrating(): boolean {
    return this.calibrating;
  }

  /**
   * Build the standard calibration-abort error
   * (top-level code is 'SERVER_ERROR'; discriminate via details.code)
   * @private
   */
  private calibrationAbortError(runs: CalibrationRun[]): ServerError {
    return new ServerError('Calibration aborted', {
      code: 'CALIBRATION_ABORTED',
      runs: [...runs],
      suggestion: 'Partial results are available in error.details.runs',
    });
  }

  /**
   * Release the backend between calibration generations
   *
   * Never throws: a release that could not be completed is logged, and the sweep
   * continues (the next `ensureBackend()` refuses to start a second process while a
   * previous one may still be alive, so a lost backend surfaces as a run failure
   * rather than as two children fighting over the GPU).
   *
   * Reason `'calibration'` is deliberate: the orchestrator ignores it, so these
   * releases never bring the offloaded LLM back mid-sweep.
   * @private
   */
  private async releaseCalibrationBackend(): Promise<void> {
    try {
      await this.releaseBackend({ reason: 'calibration' });
    } catch (error) {
      debugLog('[Calibrate] backend release failed:', error);
    }
  }

  /**
   * Build the sweep's VRAM sampler, or undefined when this machine cannot support it
   *
   * Gated up front (once per sweep) rather than per sample: macOS has unified memory
   * and no VRAM availability telemetry, and a platform that reports no `vramAvailable`
   * would only produce untrusted readings. The adapter reads the GPU exclusively —
   * host-memory telemetry is not refreshed, since the sweep never compares it.
   * @private
   */
  private async createCalibrationVramSampler(): Promise<CalibrationVramSampler | undefined> {
    // No explicit platform gate: the `vramAvailable` probe below is the real criterion. macOS
    // (unified memory) never reports it, so it is excluded by construction — and a platform check
    // on `process.platform` would be untestable on arm64 macOS runners, where pinning the platform
    // breaks binary provisioning (`win32-arm64` is not a supported platform key).
    try {
      const gpu = await this.systemInfo.getGPUInfo({
        timeoutMs: CALIBRATION_VRAM_TELEMETRY_TIMEOUT_MS,
      });
      if (gpu.vramAvailable === undefined) return undefined;
      if (gpu.vram === undefined || !Number.isFinite(gpu.vram) || gpu.vram <= 0) return undefined;

      const capture = createTelemetrySnapshotCapture(
        {
          // Host memory is never read by this sampler; claiming 'not-required' keeps the
          // shared adapter's VRAM path (and its trust rules) without paying for a host
          // telemetry command every second.
          refreshMemoryTelemetry: async () => 'not-required',
          getMemoryInfo: () => ({ available: 0 }),
          getGPUInfo: (options) => this.systemInfo.getGPUInfo(options),
        },
        {
          telemetryTimeoutMs: CALIBRATION_VRAM_TELEMETRY_TIMEOUT_MS,
          onDiagnostic: (message, error) => debugLog(`[Calibrate] ${message}`, error),
        }
      );
      return new CalibrationVramSampler(capture, gpu.vram, CALIBRATION_VRAM_SAMPLE_INTERVAL_MS);
    } catch (error) {
      debugLog('[Calibrate] VRAM sampling unavailable:', error);
      return undefined;
    }
  }

  /**
   * Run one calibration generation with per-combo flag overrides
   * @private
   */
  private async runCalibrationGeneration(params: {
    prompt: string;
    size: CalibrationSize;
    steps: number;
    cfgScale: number;
    seed: number;
    sampler: ImageSampler;
    combo: DiffusionOffloadCombo;
    onGenerationProgress: (percentage: number) => void;
  }): Promise<ImageGenerationResult> {
    const genConfig: ImageGenerationConfig = {
      prompt: params.prompt,
      width: params.size.width,
      height: params.size.height,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed: params.seed,
      sampler: params.sampler,
      onProgress: (_currentStep, _totalSteps, _stage, percentage) => {
        if (percentage !== undefined) {
          params.onGenerationProgress(percentage);
        }
      },
    };

    // Calibration owns the busy claim for its own generations, so the sweep's
    // AbortSignal listener (which calls currentGeneration?.cancel()) can reach them.
    const claim = this.createGenerationClaim();
    try {
      const promise = this.executeImageGeneration(genConfig, params.combo);
      claim.promise = promise;
      return await promise;
    } finally {
      this.releaseGenerationClaim(claim);
    }
  }

  /**
   * Snapshot per-stage durations from the last generation's timestamps
   * @private
   */
  private snapshotStageMs(): { loadMs?: number; diffusionMs?: number; decodeMs?: number } {
    const stage: { loadMs?: number; diffusionMs?: number; decodeMs?: number } = {};
    if (this.loadStartTime && this.loadEndTime) {
      stage.loadMs = this.loadEndTime - this.loadStartTime;
    }
    if (this.diffusionStartTime && this.diffusionEndTime) {
      stage.diffusionMs = this.diffusionEndTime - this.diffusionStartTime;
    }
    if (this.vaeStartTime && this.vaeEndTime) {
      stage.decodeMs = this.vaeEndTime - this.vaeStartTime;
    }
    return stage;
  }

  /**
   * Classify a failed calibration generation as OOM or generic error
   * (from the error message + captured stderr)
   *
   * Two spellings carry the backend output: a failed job and a mid-job exit put it in
   * `details.stderr`, while a startup failure (a load-time OOM never reaches the job
   * API at all) comes straight from the runner as `details.stderrTail`.
   * @private
   */
  private classifyCalibrationFailure(error: unknown): {
    status: 'oom' | 'error';
    message: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    let stderr = '';
    if (error instanceof GenaiElectronError && error.details && typeof error.details === 'object') {
      const details = error.details as Record<string, unknown>;
      const detailStderr = details.stderr ?? details.stderrTail;
      if (typeof detailStderr === 'string') {
        stderr = detailStderr;
      }
    }
    const text = `${message}\n${stderr}`;
    const isOom = DIFFUSION_CALIBRATION_DEFAULTS.oomPatterns.some((pattern) => pattern.test(text));
    return { status: isOom ? 'oom' : 'error', message };
  }

  /**
   * Generate an image
   *
   * Runs the request against the internal stable-diffusion.cpp backend, spawning it
   * first when no backend with matching offload flags is resident. For cancellable
   * generations, use the async HTTP API and cancelImageGeneration(); direct calls run
   * to completion or error (or are cancelled by stop()).
   *
   * @param config - Image generation configuration
   * @returns Generated image result
   * @throws {ServerError} If server is not running or already busy
   */
  async generateImage(config: ImageGenerationConfig): Promise<ImageGenerationResult> {
    if (this._status !== 'running') {
      throw new ServerError('Server is not running', {
        suggestion: 'Start the server first with start()',
      });
    }

    if (this.currentGeneration) {
      throw new ServerError('Server is busy generating another image', {
        suggestion: 'Wait for current generation to complete',
      });
    }

    // Claim the busy gate synchronously (before any await) so two concurrent
    // callers can never both pass the check above
    const claim = this.createGenerationClaim();
    try {
      if (this.orchestrator) {
        // The orchestrator owns the offload context, so it settles residency
        const promise = this.orchestrator.orchestrateImageGeneration(config);
        claim.promise = promise;
        return await promise;
      }

      const promise = this.executeImageGeneration(config);
      claim.promise = promise;
      try {
        return await promise;
      } finally {
        // No orchestrator: nothing was offloaded, and this call settles residency
        await this.settleResidencyWithoutOffload(config.usageMode);
      }
    } finally {
      this.releaseGenerationClaim(claim);
    }
  }

  /**
   * Check if server is healthy
   *
   * Wrapper-scoped by design: backend residency is not wrapper liveness, so a
   * 'single'-mode release after every image never flips this to false.
   *
   * @returns True if server is running and HTTP server is available
   */
  async isHealthy(): Promise<boolean> {
    return this._status === 'running' && this.httpServer !== undefined;
  }

  /**
   * Get the process ID of the internal stable-diffusion.cpp backend
   *
   * The public server is an in-process node:http wrapper with no PID of its own, so
   * this reports the backend process (identical to `getInfo().pid`).
   *
   * @returns Backend PID while it is resident, otherwise undefined
   */
  override getPid(): number | undefined {
    return this.backend.pid;
  }

  /**
   * Get server information with diffusion-specific fields
   *
   * `pid` is the backend process ID while it is resident (the wrapper is in-process
   * and has no PID of its own).
   *
   * @returns Server information including busy status and backend snapshot
   */
  override getInfo(): DiffusionServerInfo {
    const baseInfo = super.getInfo();
    const backend = this.getBackendInfo();
    return {
      ...baseInfo,
      pid: backend.pid,
      busy: !!this.currentGeneration,
      backend,
    } as DiffusionServerInfo;
  }

  /**
   * Create and install the busy-gate claim for one generation
   *
   * The claim's cancel() latches `cancelRequested` (so a cancel arriving before the
   * backend job is submitted is not lost) and forwards to the in-flight job when one
   * already exists.
   * @private
   */
  private createGenerationClaim(id?: string): GenerationClaim {
    const claim: GenerationClaim = {
      cancelRequested: false,
      cancel: () => {
        claim.cancelRequested = true;
        this.inFlight?.cancel();
      },
    };
    if (id !== undefined) claim.id = id;
    this.currentGeneration = claim;
    return claim;
  }

  /**
   * Release the busy gate, but only if this claim still owns it
   * @private
   */
  private releaseGenerationClaim(claim: GenerationClaim): void {
    if (this.currentGeneration === claim) {
      this.currentGeneration = undefined;
    }
  }

  /**
   * Ensure stable-diffusion.cpp binary is downloaded
   *
   * @param modelInfo - Optional model info for real functionality testing (Phase 2)
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails
   * @private
   */
  private async ensureBinary(modelInfo?: ModelInfo, forceValidation = false): Promise<string> {
    // Build the correct test model args based on single-file vs multi-component
    let testModelArgs: string[] | undefined;
    if (modelInfo?.components) {
      testModelArgs = [];
      for (const role of DIFFUSION_COMPONENT_ORDER) {
        const component = modelInfo.components[role];
        if (component) {
          testModelArgs.push(DIFFUSION_COMPONENT_FLAGS[role], component.path);
        }
      }
    }

    const testOptimizationArgs = modelInfo
      ? this.buildDiffusionOptimizationArgs(await this.computeDiffusionOptimizations())
      : undefined;

    return this.ensureBinaryHelper(
      'diffusion',
      'sd-server',
      BINARY_VERSIONS.diffusionCpp,
      modelInfo?.path,
      forceValidation,
      testModelArgs,
      testOptimizationArgs
    );
  }

  /**
   * Create HTTP server with async generation endpoints
   *
   * @param port - Resolved port number to listen on
   * @param host - Interface to bind (raw, as configured)
   * @private
   */
  private async createHTTPServer(port: number, host: string): Promise<void> {
    // DNS-rebinding guard: a page on the public web can resolve its own hostname to
    // 127.0.0.1 and then talk to a loopback server as "same origin". While bound to
    // loopback, only Host headers that cannot be a rebound name are accepted. A
    // deliberately widened bind (`host: '0.0.0.0'`) is the host's call; no guard.
    const guardHostHeader = isLoopbackBindAddress(host);
    // Key allowlist only validates names, so a JS caller can still pass a string here;
    // `String.prototype.includes` would then do substring matching. Arrays only.
    const configuredOrigins = ((this._config ?? {}) as DiffusionServerConfig).allowedOrigins;
    const allowedOrigins: readonly string[] = Array.isArray(configuredOrigins)
      ? configuredOrigins
      : [];

    this.httpServer = http.createServer(async (req, res) => {
      try {
        if (guardHostHeader && !isLoopbackHostHeader(req.headers.host)) {
          const shown = (req.headers.host ?? '').slice(0, 100);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Rejected Host header "${shown}": the diffusion server is bound to a loopback address and only accepts localhost or IP-literal hosts`,
                code: 'INVALID_HOST',
              },
            })
          );
          return;
        }

        // CORS is opt-in: without `allowedOrigins` the wrapper advertises nothing, so a
        // browser context cannot READ from it cross-origin. Node/Electron-main clients
        // send no Origin and are unaffected. The response varies with Origin either way.
        res.setHeader('Vary', 'Origin');
        const origin = req.headers.origin;
        const allowedOrigin = resolveAllowedOrigin(allowedOrigins, origin);
        if (allowedOrigin !== undefined) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // CORS only stops a browser from reading the answer: a "simple" cross-origin
        // POST (e.g. text/plain) needs no preflight and would still start GPU work. A
        // state-changing request from an origin the allowlist does not cover is
        // therefore refused outright. GET/HEAD answered without CORS headers are
        // harmless — the browser withholds the body.
        if (
          origin !== undefined &&
          allowedOrigin === undefined &&
          req.method !== 'GET' &&
          req.method !== 'HEAD'
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Rejected cross-origin ${req.method} from "${origin.slice(0, 100)}": add the origin to DiffusionServerConfig.allowedOrigins to allow browser clients`,
                code: 'INVALID_ORIGIN',
              },
            })
          );
          return;
        }

        // Health endpoint
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              busy: !!this.currentGeneration,
              backend: this.backend.state,
            })
          );
          return;
        }

        // Start async image generation (POST /v1/images/generations)
        if (req.url === '/v1/images/generations' && req.method === 'POST') {
          await this.handleStartGeneration(req, res);
          return;
        }

        // Get generation status/result (GET /v1/images/generations/:id)
        const getMatch = req.url?.match(/^\/v1\/images\/generations\/([^/]+)$/);
        if (getMatch && getMatch[1] && req.method === 'GET') {
          const generationId = getMatch[1];
          await this.handleGetGeneration(generationId, res);
          return;
        }

        // Cancel generation (DELETE /v1/images/generations/:id)
        if (getMatch && getMatch[1] && req.method === 'DELETE') {
          await this.handleCancelGeneration(getMatch[1], res);
          return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found', code: 'NOT_FOUND' } }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : 'Internal server error',
              code: 'INTERNAL_ERROR',
            },
          })
        );
      }
    });

    // Start listening (loopback-only unless the host explicitly widened the bind)
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => resolve());
      this.httpServer!.on('error', reject);
    });

    await this.logManager?.write(`HTTP server listening on ${host}:${port}`, 'info');
  }

  /**
   * Handle POST /v1/images/generations - Start async generation
   * @private
   */
  private async handleStartGeneration(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Refuse while the wrapper is not serving (e.g. stop() already closed the gate)
    if (this._status !== 'running') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'Server is not running',
            code: 'SERVER_NOT_RUNNING',
            suggestion: 'Start the server first with start()',
          },
        })
      );
      return;
    }

    // Parse request body
    const body = await this.parseRequestBody(req);
    let imageConfig: ImageGenerationConfig;
    try {
      imageConfig = JSON.parse(body) as ImageGenerationConfig;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Malformed JSON request body', code: 'INVALID_REQUEST' },
        })
      );
      return;
    }

    // Validate required fields
    if (!imageConfig || typeof imageConfig !== 'object' || !imageConfig.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Missing required field: prompt', code: 'INVALID_REQUEST' },
        })
      );
      return;
    }

    // Validate count parameter
    if (imageConfig.count !== undefined) {
      if (imageConfig.count < 1 || imageConfig.count > 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'count must be between 1 and 5', code: 'INVALID_REQUEST' },
          })
        );
        return;
      }
    }

    // Validate residency policy
    if (
      imageConfig.usageMode !== undefined &&
      imageConfig.usageMode !== 'burst' &&
      imageConfig.usageMode !== 'single'
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: "usageMode must be 'burst' or 'single'", code: 'INVALID_REQUEST' },
        })
      );
      return;
    }

    // Check if server is busy
    if (this.currentGeneration) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'Server is busy generating another image',
            code: 'SERVER_BUSY',
            suggestion: 'Wait for current generation to complete and try again',
          },
        })
      );
      return;
    }

    // Claim the busy gate synchronously — BEFORE registry.create() and any await —
    // so two back-to-back POSTs can never both get past the check above
    const claim = this.createGenerationClaim();

    // Create generation entry in registry
    const id = this.registry.create(imageConfig);
    claim.id = id;

    // Start generation asynchronously (don't await)
    const generation = this.runAsyncGeneration(id, imageConfig);
    claim.promise = generation;
    generation.catch((error: unknown) => {
      // Never overwrite a cancellation: the rejection of a killed backend job
      // lands here after cancelImageGeneration set 'cancelled'
      const state = this.registry.get(id);
      if (!state || state.status === 'cancelled') {
        return;
      }
      this.registry.update(id, {
        status: 'error',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: this.mapErrorCode(error),
        },
      });
    });

    // Return generation ID immediately
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        status: 'pending',
        createdAt: Date.now(),
      })
    );
  }

  /**
   * Handle GET /v1/images/generations/:id - Get generation status/result
   * @private
   */
  private async handleGetGeneration(id: string, res: http.ServerResponse): Promise<void> {
    const state = this.registry.get(id);

    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Generation not found', code: 'NOT_FOUND' } }));
      return;
    }

    // Build response based on status
    const response: any = {
      id: state.id,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };

    if (state.status === 'in_progress' && state.progress) {
      response.progress = state.progress;
    }

    if (state.status === 'complete' && state.result) {
      response.result = state.result;
    }

    if (state.status === 'error' && state.error) {
      response.error = state.error;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Handle DELETE /v1/images/generations/:id - Cancel generation
   * @private
   */
  private async handleCancelGeneration(id: string, res: http.ServerResponse): Promise<void> {
    const state = this.registry.get(id);

    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Generation not found', code: 'NOT_FOUND' } }));
      return;
    }

    if (state.status === 'complete' || state.status === 'error') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `Generation is already ${state.status} and cannot be cancelled`,
            code: 'ALREADY_TERMINAL',
          },
        })
      );
      return;
    }

    // 'cancelled' falls through: cancelling twice is idempotent
    await this.cancelImageGeneration(id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, status: 'cancelled' }));
  }

  /**
   * Run async generation and update registry
   * @private
   */
  private async runAsyncGeneration(id: string, config: ImageGenerationConfig): Promise<void> {
    const startTime = Date.now();
    // The claim was installed synchronously by the POST handler; this call owns it
    const claim = this.currentGeneration;

    // A cancel may have landed between create and this call
    if (this.registry.get(id)?.status === 'cancelled') {
      if (claim) this.releaseGenerationClaim(claim);
      return;
    }

    // Update to in_progress
    this.registry.update(id, { status: 'in_progress' });

    // Wrap onProgress to update registry
    const wrappedConfig: ImageGenerationConfig = {
      ...config,
      onProgress: (currentStep, totalSteps, stage, percentage) => {
        this.registry.update(id, {
          progress: {
            currentStep,
            totalSteps,
            stage,
            percentage,
            // Folded batch progress reaches 100 only on the last image, so clamp: at
            // exactly 100 the floor division would otherwise yield count + 1
            currentImage:
              config.count && config.count > 1
                ? Math.min(config.count, Math.floor((percentage || 0) / (100 / config.count)) + 1)
                : undefined,
            totalImages: config.count && config.count > 1 ? config.count : undefined,
          },
        });
        // Also call original callback if provided
        config.onProgress?.(currentStep, totalSteps, stage, percentage);
      },
    };

    try {
      // Generate images (batch or single, with orchestration if available)
      const count = config.count || 1;
      let results: ImageGenerationResult[];

      if (this.orchestrator) {
        // One offload window for the whole request; the orchestrator settles residency
        results =
          count > 1
            ? await this.orchestrator.orchestrateBatchGeneration(wrappedConfig)
            : [await this.orchestrator.orchestrateImageGeneration(wrappedConfig)];
      } else {
        // No orchestrator: nothing was offloaded, and this call settles residency once
        try {
          results =
            count > 1
              ? await this.executeBatchGeneration(wrappedConfig)
              : [await this.executeImageGeneration(wrappedConfig)];
        } finally {
          await this.settleResidencyWithoutOffload(config.usageMode);
        }
      }

      // Never overwrite a cancellation that landed just before completion;
      // partial results of a cancelled generation are discarded
      if (this.registry.get(id)?.status === 'cancelled') {
        return;
      }

      // Convert results to base64 for JSON response
      const images = results.map((result) => ({
        image: result.image.toString('base64'),
        seed: result.seed,
        width: result.width,
        height: result.height,
      }));

      // Update registry with complete result
      this.registry.update(id, {
        status: 'complete',
        result: {
          images,
          format: 'png',
          timeTaken: Date.now() - startTime,
        },
      });
    } catch (error) {
      // A cancelled generation is 'cancelled', never 'error' — stop() cancels the
      // in-flight job without going through cancelImageGeneration(), so this is the
      // only place that can classify it. The claim flag covers a cancel that landed
      // before a backend job existed (the failure is then the aborted spawn).
      // Rethrown so the caller still sees a failure.
      const state = this.registry.get(id);
      if (
        state &&
        state.status !== 'complete' &&
        state.status !== 'error' &&
        state.status !== 'cancelled' &&
        (claim?.cancelRequested === true || this.mapErrorCode(error) === 'GENERATION_CANCELLED')
      ) {
        this.registry.update(id, { status: 'cancelled' });
      }
      throw error;
    } finally {
      if (claim) this.releaseGenerationClaim(claim);
    }
  }

  /**
   * Map an error onto the wire error code
   *
   * `details.code` wins when present (the backend client/runner carry their
   * discriminant there); the substring fallbacks keep older paths mapped.
   * @private
   */
  private mapErrorCode(error: unknown): string {
    const details =
      error instanceof GenaiElectronError && error.details && typeof error.details === 'object'
        ? (error.details as Record<string, unknown>)
        : undefined;
    const detailCode = typeof details?.code === 'string' ? details.code : undefined;

    if (detailCode !== undefined) {
      if (detailCode === 'GENERATION_NOT_FOUND') return 'NOT_FOUND';
      if (detailCode === 'SERVER_NOT_RUNNING') return 'SERVER_NOT_RUNNING';
      if (detailCode === 'IMAGE_DECODE_FAILED') return 'IO_ERROR';
      // A full backend queue is a transient "come back later", exactly what the
      // wrapper's own busy gate reports — not a backend malfunction.
      if (detailCode === 'BACKEND_QUEUE_FULL') return 'SERVER_BUSY';
      // A spawn aborted through the startup signal IS the cancellation: the only
      // thing that aborts it is a cancel that arrived before the backend was ready.
      if (detailCode === 'SD_SERVER_START_ABORTED') return 'GENERATION_CANCELLED';
      if (detailCode.startsWith('BACKEND_') || detailCode.startsWith('SD_SERVER_')) {
        return 'BACKEND_ERROR';
      }
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      // Cancellation travels as a plain Error ('Image generation cancelled')
      if (message.includes('cancelled')) return 'GENERATION_CANCELLED';
      if (message.includes('server is busy')) return 'SERVER_BUSY';
      if (message.includes('not running')) return 'SERVER_NOT_RUNNING';
      if (message.includes('failed to spawn')) return 'BACKEND_ERROR';
      if (message.includes('exited with code')) return 'BACKEND_ERROR';
      if (message.includes('job failed')) return 'BACKEND_ERROR';
      if (message.includes('failed to read')) return 'IO_ERROR';
      if (message.includes('failed to decode')) return 'IO_ERROR';
    }
    return 'UNKNOWN_ERROR';
  }

  /**
   * Parse request body
   *
   * @param req - HTTP request
   * @returns Request body as string
   * @private
   */
  private parseRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Execute image generation against the stable-diffusion.cpp backend
   *
   * This is the direct execution method used internally and by ResourceOrchestrator.
   * External callers should use generateImage() which includes automatic resource
   * management. Spawns the backend when none with matching flags is resident, submits
   * one job and polls it to a terminal status while the backend's stdout tap drives
   * the progress model.
   *
   * @param config - Image generation configuration
   * @param flagOverrides - Per-generation offload-flag overrides (used by calibrate();
   *   takes precedence over server config and auto-detection)
   * @returns Generated image result
   * @internal
   */
  public async executeImageGeneration(
    config: ImageGenerationConfig,
    flagOverrides?: DiffusionOffloadCombo
  ): Promise<ImageGenerationResult> {
    const startTime = Date.now();

    if (!this.currentModelInfo) {
      throw new ServerError('Model information not available', {
        suggestion: 'This is an internal error - model should have been loaded',
      });
    }

    // Normalize seed: generate random seed if not provided or negative
    const normalizedConfig = {
      ...config,
      seed: config.seed === undefined || config.seed < 0 ? this.generateRandomSeed() : config.seed,
    };

    // Initialize progress tracking (the backend's stdout tap reads progressConfig).
    // A resident backend means no model load, so the estimate must be the warm one —
    // otherwise a cold generation after warm ones would over- or under-shoot.
    const backendResident = this.backend.state === 'ready' || this.backend.state === 'busy';
    this.initializeProgressTracking(normalizedConfig, backendResident);
    this.progressConfig = normalizedConfig;
    this.currentStage = 'loading';
    this.reportProgress(normalizedConfig);

    // Compute VRAM optimizations (fresh GPU info, respects user overrides).
    // These are LAUNCH flags: a change forces the backend to be respawned.
    const optimizations = await this.computeDiffusionOptimizations(flagOverrides);
    const flags: ResolvedDiffusionFlags = {
      clipOnCpu: optimizations.clipOnCpu,
      vaeOnCpu: optimizations.vaeOnCpu,
      offloadToCpu: optimizations.offloadToCpu,
      diffusionFlashAttention: optimizations.diffusionFlashAttention,
    };

    // A cold spawn can take minutes; a cancel arriving during it must not be parked
    // until the backend is ready. This gate makes the spawn itself cancellable: the
    // claim's cancel() reaches it through `inFlight`, and the runner maps the aborted
    // startup to SD_SERVER_START_ABORTED (wire code GENERATION_CANCELLED).
    const spawnAbort = new AbortController();
    const spawnGate: InFlightBackendJob = {
      cancel: () => {
        spawnAbort.abort(
          new ServerError('Image generation cancelled before the backend was ready', {
            code: 'GENERATION_CANCELLED',
          })
        );
      },
      // No backend job exists yet, so there is nothing a crash could fail here; the
      // spawn's own error path reports it.
      reject: () => undefined,
    };
    this.inFlight = spawnGate;

    let handle: SdServerHandle;
    let client: SdServerClient;
    let spawned: boolean;
    try {
      // Cold path: 'loading' covers the spawn (loadStartTime is set when it begins)
      ({ handle, client, spawned } = await this.ensureBackend(flags, {
        signal: spawnAbort.signal,
      }));
    } catch (error) {
      this.finishProgressTracking(normalizedConfig);
      throw error;
    } finally {
      // Identity check: a later generation may already own the slot
      if (this.inFlight === spawnGate) this.inFlight = undefined;
    }

    // Warm path: the weights are already resident, so 'loading' is only the
    // pre-sampling (conditioning) work that starts when the job is submitted
    if (this.loadStartTime === undefined) this.loadStartTime = Date.now();

    const serverConfig = (this._config ?? {}) as DiffusionServerConfig;
    const request = buildSdServerImageRequest(normalizedConfig, serverConfig.batchSize);
    void this.logManager
      ?.write(
        `Generating image on backend port ${handle.port}: ` +
          `${normalizedConfig.width ?? 512}x${normalizedConfig.height ?? 512}, ` +
          `seed=${normalizedConfig.seed}, steps=${normalizedConfig.steps ?? 'default'}`,
        'info'
      )
      .catch(() => void 0);

    this.setBackendState('busy', 'job');
    this.disarmIdleTimer();

    let cancelled = false;
    let rejectInFlight!: (error: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectInFlight = reject;
    });
    // Every use below races this promise (which attaches a handler); this keeps a
    // never-raced rejection from surfacing as an unhandled rejection.
    abortPromise.catch(() => undefined);

    let jobId: string | undefined;
    let jobStatus: SdServerJobStatus = 'queued';

    /** Stop the backend-side job, once its id is known. Safe to call twice. */
    let jobStopRequested = false;
    const stopBackendJob = (): void => {
      if (jobId === undefined || jobStopRequested) return;
      jobStopRequested = true;
      if (jobStatus === 'queued') {
        void this.cancelQueuedJob(client, jobId);
      } else {
        // Upstream cannot interrupt sampling (409), so the backend is killed.
        // Initiated, not awaited: the flip to 'stopping' is synchronous, so no
        // respawn can slip past the dying child.
        void this.releaseBackend({ reason: 'cancel' }).catch(() => void 0);
      }
    };

    const inFlightJob: InFlightBackendJob = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        this.cleanupSyntheticProgress();
        rejectInFlight(new Error('Image generation cancelled'));
        stopBackendJob();
      },
      reject: (error: unknown) => {
        rejectInFlight(error);
      },
    };
    this.inFlight = inFlightJob;

    // Stuck-job watchdog. The one failure the job API cannot report is a backend that
    // stays alive and keeps answering 'generating' forever: without this, the busy gate
    // stays closed, the registry entry is never finished and an offloaded LLM never
    // comes back. Armed per generation (never around a batch) and disarmed below.
    // Kept so the catch below can surface it: an expiry that lands while the submit
    // round-trip is still in flight (deliberately not raced against abortPromise) would
    // otherwise be masked by the SD_SERVER_EXITED error the kill produces.
    let stuckError: ServerError | undefined;
    this.armJobActivityWatchdog(inFlightJob, (idleMs, timeoutMs) => {
      const stage = this.currentStage === 'vae' ? 'decoding' : (this.currentStage ?? 'loading');
      const label = jobId ?? '(not yet submitted)';
      void this.logManager
        ?.write(
          `sd-server backend job ${label} showed no activity for ${idleMs} ms ` +
            `(limit ${timeoutMs} ms, stage ${stage}) - releasing the backend`,
          'error'
        )
        .catch(() => void 0);

      // Ladder, all best effort: ask the backend to drop the job (the pinned build
      // answers 409 once it is generating), then kill it. Latching jobStopRequested
      // keeps this generation's own catch path from asking for a second release.
      jobStopRequested = true;
      if (jobId !== undefined) {
        void client.cancelJob(jobId).catch(() => undefined);
      }
      // Initiated, not awaited: the flip to 'stopping' is synchronous, so no respawn
      // can slip past the dying child.
      void this.releaseBackend({ reason: 'stuck' }).catch((error: unknown) => {
        debugLog('[Diffusion] stuck-job release failed:', error);
      });

      stuckError = new ServerError(
        `stable-diffusion.cpp backend job ${label} showed no activity for ${idleMs} ms; ` +
          'the backend was released',
        {
          code: 'BACKEND_JOB_STUCK',
          jobId,
          idleMs,
          timeoutMs,
          stage,
          args: handle.args.join(' '),
          // Deliberately NOT the `stderr`/`stderrTail` keys: those drive OOM
          // classification (classifyCalibrationFailure), and a wedged backend is an
          // error, never an out-of-memory result.
          backendStderrTail: handle.stderrTail || undefined,
          suggestion:
            'The backend stopped reporting progress and was killed. Retry the image; ' +
            'raise DiffusionServerConfig.jobActivityTimeoutMs (or set it to 0 to disable ' +
            'the watchdog) if this hardware legitimately goes that long without output.',
        }
      );
      rejectInFlight(stuckError);
    });

    try {
      // Deliberately NOT raced against abortPromise: a cancel landing mid-round-trip
      // would leave the backend running a job nobody owns. The latch below cancels it
      // as soon as the id exists.
      const submitted = await handle.raceWithExit(client.submitImageJob(request));
      jobId = submitted.id;
      // The backend answered the submit: a sign of life the watchdog must not miss
      // when the round-trip itself took a while.
      this.markBackendActivity();

      // A cancel that arrived before the job existed is latched on the claim (or,
      // when it landed during the round-trip, on `cancelled`)
      if (cancelled || this.currentGeneration?.cancelRequested === true) {
        inFlightJob.cancel();
        // Already-cancelled: cancel() short-circuited before the id existed
        stopBackendJob();
        throw new Error('Image generation cancelled');
      }

      const job = await Promise.race([
        this.pollJobToCompletion(handle, client, jobId, normalizedConfig, (status) => {
          jobStatus = status;
        }),
        abortPromise,
      ]);

      if (job.status !== 'completed') {
        throw this.jobFailureError(handle, job);
      }

      const base64 = job.result?.images[0]?.b64_json;
      if (base64 === undefined || base64 === '') {
        throw new ServerError('Failed to decode generated image: no image data in job result', {
          code: 'IMAGE_DECODE_FAILED',
          jobId,
          args: handle.args.join(' '),
        });
      }
      const imageBuffer = Buffer.from(base64, 'base64');
      if (imageBuffer.length === 0) {
        throw new ServerError('Failed to decode generated image: empty image payload', {
          code: 'IMAGE_DECODE_FAILED',
          jobId,
          args: handle.args.join(' '),
        });
      }

      // Only now: the 100 % callback promises an image that exists, so it must follow
      // the payload checks above, not the bare 'completed' status.
      this.completeVaeStage(normalizedConfig);

      // The request never asks for a format, so the pinned build returns PNG; surface a
      // change rather than silently reporting `format: 'png'` and the requested size.
      const outputFormat = job.result?.output_format;
      if (outputFormat !== undefined && outputFormat !== 'png') {
        await this.logManager?.write(
          `sd-server returned output_format=${outputFormat}; the result is reported as PNG`,
          'warn'
        );
      }

      // Update time estimates based on actual generation times
      this.updateTimeEstimates(normalizedConfig, spawned);

      // Report what was rendered, not what was asked for: an omitted size means the
      // backend's own default, which only the image itself can tell us.
      const dimensions = readPngDimensions(imageBuffer) ?? {
        width: normalizedConfig.width || 512,
        height: normalizedConfig.height || 512,
      };

      return {
        image: imageBuffer,
        format: 'png',
        timeTaken: Date.now() - startTime,
        seed: normalizedConfig.seed,
        width: dimensions.width,
        height: dimensions.height,
      };
    } catch (error) {
      // A job the backend may still be working on must not outlive the generation that
      // owns it: it would hold the GPU with nobody left to read its result. Skipped for
      // an exited backend (nothing is running) and for a job the backend already
      // reported terminal (nothing to stop). Best effort — stopBackendJob() is
      // idempotent and never throws.
      if (jobId !== undefined && !isTerminalJobStatus(jobStatus) && !isBackendExit(error)) {
        stopBackendJob();
      }
      // A watchdog expiry during the un-raced submit surfaces as the kill's exit error
      // here; the stuck error is the one the caller should see.
      throw this.toGenerationError(handle, stuckError ?? error);
    } finally {
      // Identity checks: a later generation may already own these
      this.disarmJobActivityWatchdog(inFlightJob);
      if (this.inFlight === inFlightJob) this.inFlight = undefined;
      this.finishProgressTracking(normalizedConfig);
      if (this.backend.state === 'busy') {
        this.backend.lastUsedAt = Date.now();
        this.setBackendState('ready', 'job');
        // Residency (release now vs stay warm under the idle timeout) is NOT decided
        // here: settleResidency() owns it, called once per generation by whoever owns
        // the offload context. A batch loop and calibration run through this method
        // repeatedly and must not arm anything in between.
      }
    }
  }

  /**
   * Poll one backend job until it reaches a terminal status
   *
   * A dropped socket or a slow answer is not a failed image: up to
   * `DIFFUSION_BACKEND_DEFAULTS.maxTransientPollFailures - 1` consecutive transient
   * client failures are retried. Everything else (expired/unknown job, HTTP error,
   * invalid body, backend exit) fails the generation immediately.
   *
   * The loop feeds the stuck-job watchdog, but only on a status or queue-position
   * CHANGE — an answered poll that still says `generating` proves the HTTP thread is
   * alive, not that the job is progressing.
   * @private
   */
  private async pollJobToCompletion(
    handle: SdServerHandle,
    client: SdServerClient,
    jobId: string,
    config: ImageGenerationConfig,
    onStatus: (status: SdServerJobStatus) => void
  ): Promise<SdServerJob> {
    let transientFailures = 0;
    let lastStatus: SdServerJobStatus | undefined;
    let lastQueuePosition: number | undefined;

    for (;;) {
      let job: SdServerJob;
      try {
        job = await handle.raceWithExit(client.getJob(jobId));
        transientFailures = 0;
      } catch (error) {
        const details =
          error instanceof GenaiElectronError && error.details && typeof error.details === 'object'
            ? (error.details as Record<string, unknown>)
            : undefined;
        const code = typeof details?.code === 'string' ? details.code : undefined;
        if (code === undefined || !TRANSIENT_POLL_ERROR_CODES.has(code)) throw error;

        transientFailures++;
        if (transientFailures >= DIFFUSION_BACKEND_DEFAULTS.maxTransientPollFailures) throw error;

        void this.logManager
          ?.write(
            `Transient backend poll failure ${transientFailures}/${
              DIFFUSION_BACKEND_DEFAULTS.maxTransientPollFailures
            } for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
          )
          .catch(() => void 0);
        await delay(DIFFUSION_BACKEND_DEFAULTS.jobPollIntervalMs);
        continue;
      }

      onStatus(job.status);

      if (job.status !== lastStatus || job.queue_position !== lastQueuePosition) {
        lastStatus = job.status;
        lastQueuePosition = job.queue_position;
        this.markBackendActivity();
      }

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return job;
      }

      // Fallback when the 'decoding' literal never arrives: the last sampling step
      // was reached while the job is still running, so decoding must be under way.
      // Identity-checked like every other progress write: a later generation may
      // already own the tracking state (this poll loop can outlive its own job).
      if (
        job.status === 'generating' &&
        this.progressConfig === config &&
        this.currentStage === 'diffusion' &&
        this.diffusionProgress.total > 0 &&
        this.diffusionProgress.current >= this.diffusionProgress.total
      ) {
        this.beginVaeStage(config);
      }

      await delay(DIFFUSION_BACKEND_DEFAULTS.jobPollIntervalMs);
    }
  }

  /**
   * Cancel a job the backend has not started yet; kill the backend if it did
   * @private
   */
  private async cancelQueuedJob(client: SdServerClient, jobId: string): Promise<void> {
    try {
      const result = await client.cancelJob(jobId);
      if (result.cancelled) return;
    } catch (error) {
      debugLog('[Diffusion] backend job cancel failed:', error);
    }
    // 409 (already generating) or a failed cancel: killing is the only way out
    await this.releaseBackend({ reason: 'cancel' }).catch(() => void 0);
  }

  /**
   * Build the error for a job that ended in a non-completed status
   * @private
   */
  private jobFailureError(handle: SdServerHandle, job: SdServerJob): Error {
    if (job.status === 'cancelled') {
      return new Error('Image generation cancelled');
    }
    const backendError = job.error?.message ?? 'unknown backend error';
    return new ServerError(`stable-diffusion.cpp job failed: ${backendError}`, {
      code: 'BACKEND_JOB_FAILED',
      jobId: job.id,
      backendError,
      args: handle.args.join(' '),
      // Kept so classifyCalibrationFailure()/oomPatterns still see the backend output
      stderr: handle.stderrTail || undefined,
      stdout: handle.stdoutTail || undefined,
    });
  }

  /**
   * Normalize a generation failure
   *
   * The runner reports an exit through its own `SD_SERVER_EXITED` error; re-wrap it so
   * the message keeps the historical 'exited with code' wording and `details.stderr`
   * stays where OOM classification looks for it.
   * @private
   */
  private toGenerationError(handle: SdServerHandle, error: unknown): unknown {
    const details =
      error instanceof GenaiElectronError && error.details && typeof error.details === 'object'
        ? (error.details as Record<string, unknown>)
        : undefined;
    if (details?.code !== 'SD_SERVER_EXITED') return error;

    return backendExitError(handle, {
      code: typeof details.exitCode === 'number' ? details.exitCode : null,
      signal: (details.signal as NodeJS.Signals | null | undefined) ?? null,
    });
  }

  /**
   * Tear down per-generation progress state
   *
   * No-op unless the given generation still owns the tracking state: a later
   * generation must keep its own progressConfig and synthetic interval.
   * @private
   */
  private finishProgressTracking(config: ImageGenerationConfig): void {
    if (this.progressConfig !== config) return;
    this.cleanupSyntheticProgress();
    this.progressConfig = undefined;
  }

  /**
   * Execute batch image generation (multiple images sequentially)
   *
   * Generates multiple images by calling executeImageGeneration in a loop.
   * Updates progress to reflect overall batch progress.
   *
   * @param config - Image generation configuration with count parameter
   * @returns Array of generated image results
   * @internal
   */
  public async executeBatchGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult[]> {
    const count = config.count || 1;
    const images: ImageGenerationResult[] = [];

    for (let i = 0; i < count; i++) {
      // Honor cancellation between images: no backend job is in flight in this
      // gap, so the latched claim flag is the only way a cancel can halt the batch
      if (this.currentGeneration?.cancelRequested === true) {
        throw new Error('Image generation cancelled');
      }

      // Calculate seed for this image
      // If user provided a non-negative seed, use seed+i for variations
      // Otherwise, generate a fresh random seed for each image
      const imageSeed =
        config.seed !== undefined && config.seed >= 0 ? config.seed + i : this.generateRandomSeed();

      // Wrap progress callback to include batch information
      const wrappedConfig: ImageGenerationConfig = {
        ...config,
        seed: imageSeed,
        onProgress: config.onProgress
          ? (currentStep, totalSteps, stage, percentage) => {
              // Calculate overall batch percentage
              const completedImages = i;
              const currentImageProgress = (percentage || 0) / 100;
              const overallPercentage = ((completedImages + currentImageProgress) / count) * 100;

              // Call original progress callback with batch information
              config.onProgress!(currentStep, totalSteps, stage, overallPercentage);
            }
          : undefined,
      };

      // Generate single image
      const result = await this.executeImageGeneration(wrappedConfig);
      images.push(result);
    }

    return images;
  }

  /**
   * Compute VRAM optimization flags based on current GPU state and model size.
   *
   * Called at generation time (not start time) so headroom reflects the current
   * VRAM landscape — the orchestrator may have offloaded the LLM between start()
   * and generation.
   *
   * Precedence per flag: flagOverrides (per-generation, used by calibrate())
   * → DiffusionServerConfig (user start-config) → auto-detection.
   *
   * @param flagOverrides - Optional per-generation offload-flag overrides
   * @returns Resolved optimization flags: clipOnCpu, vaeOnCpu, batchSize
   * @private
   */
  private async computeDiffusionOptimizations(
    flagOverrides?: DiffusionOffloadCombo
  ): Promise<ResolvedDiffusionOptimizations> {
    const serverConfig = this._config as DiffusionServerConfig;
    const modelSize = this.currentModelInfo?.size ?? 0;
    const modelFootprint = modelSize * DIFFUSION_VRAM_THRESHOLDS.modelOverheadMultiplier;

    let autoClipOnCpu: boolean;
    let autoVaeOnCpu: boolean;
    let autoOffloadToCpu: boolean;

    try {
      const gpu = await this.systemInfo.getGPUInfo();

      if (!gpu.available || gpu.vram === undefined) {
        // No GPU or no VRAM info — safe default: clip on CPU, VAE stays on GPU
        autoClipOnCpu = true;
        autoVaeOnCpu = false;
        autoOffloadToCpu = false;
      } else {
        const headroom = gpu.vram - modelFootprint;

        // CPU offloading flags apply to all backends. (They crashed sd.cpp CUDA
        // builds up to master-504-636d3cb and were suppressed for CUDA installs;
        // fixed upstream — re-verified live on master-746-2574f59.)
        autoClipOnCpu = headroom < DIFFUSION_VRAM_THRESHOLDS.clipOnCpuHeadroomBytes;
        autoVaeOnCpu = headroom < DIFFUSION_VRAM_THRESHOLDS.vaeOnCpuHeadroomBytes;
        autoOffloadToCpu = modelFootprint > gpu.vram * 0.85;

        // Escalation: if vramAvailable is known and critically low, force clip-on-cpu
        if (gpu.vramAvailable !== undefined && gpu.vramAvailable - modelFootprint < 2 * 1024 ** 3) {
          autoClipOnCpu = true;
        }
      }
    } catch {
      // GPU detection failed — use safe defaults
      autoClipOnCpu = true;
      autoVaeOnCpu = false;
      autoOffloadToCpu = false;
    }

    // Auto-enable diffusion flash attention when model has an 'llm' component (Flux 2)
    const hasLLMComponent = !!this.currentModelInfo?.components?.llm;
    const autoDiffusionFlashAttention = hasLLMComponent;

    const clipOnCpu = flagOverrides?.clipOnCpu ?? serverConfig.clipOnCpu ?? autoClipOnCpu;
    const vaeOnCpu = flagOverrides?.vaeOnCpu ?? serverConfig.vaeOnCpu ?? autoVaeOnCpu;
    const offloadToCpu =
      flagOverrides?.offloadToCpu ?? serverConfig.offloadToCpu ?? autoOffloadToCpu;
    const diffusionFlashAttention =
      flagOverrides?.diffusionFlashAttention ??
      serverConfig.diffusionFlashAttention ??
      autoDiffusionFlashAttention;
    const batchSize = serverConfig.batchSize;

    this.lastResolvedOptimizations = { clipOnCpu, vaeOnCpu, offloadToCpu, diffusionFlashAttention };

    await this.logManager?.write(
      `VRAM optimizations: clipOnCpu=${clipOnCpu}, vaeOnCpu=${vaeOnCpu}, offloadToCpu=${offloadToCpu}, diffusionFa=${diffusionFlashAttention}${batchSize !== undefined ? `, batchSize=${batchSize}` : ''} (auto: clip=${autoClipOnCpu}, vae=${autoVaeOnCpu}, offload=${autoOffloadToCpu}, fa=${autoDiffusionFlashAttention})`,
      'info'
    );

    return { clipOnCpu, vaeOnCpu, offloadToCpu, diffusionFlashAttention, batchSize };
  }

  /**
   * Convert resolved production optimization decisions into backend launch flags.
   *
   * Kept separate from generation-only settings such as batch size and thread
   * count so binary validation exercises the same backend/offload path without
   * changing its deliberately tiny workload.
   */
  private buildDiffusionOptimizationArgs(optimizations: ResolvedDiffusionOptimizations): string[] {
    const args: string[] = [];

    if (optimizations.clipOnCpu) {
      args.push('--clip-on-cpu');
    }
    if (optimizations.vaeOnCpu) {
      args.push('--vae-on-cpu');
    }
    if (optimizations.offloadToCpu) {
      args.push('--offload-to-cpu');
    }
    if (optimizations.diffusionFlashAttention) {
      args.push('--diffusion-fa');
    }

    return args;
  }

  /**
   * Generate a random non-negative seed for image generation
   * @returns Random non-negative integer seed (0 to 2147483646)
   * @private
   */
  private generateRandomSeed(): number {
    // Generate random non-negative 32-bit integer
    return Math.floor(Math.random() * 2147483647);
  }

  /**
   * Initialize progress tracking for a new generation
   *
   * @param config - Normalized generation config
   * @param warmStart - True when a matching backend is already resident, so the load
   *   stage is only conditioning; the cold estimate would inflate the denominator
   * @private
   */
  private initializeProgressTracking(config: ImageGenerationConfig, warmStart: boolean): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    // Calculate total estimated time
    this.currentLoadEstimate = warmStart ? this.warmLoadTime : this.modelLoadTime;
    this.totalEstimatedTime =
      this.currentLoadEstimate +
      steps * megapixels * this.diffusionTimePerStepPerMegapixel +
      megapixels * this.vaeTimePerMegapixel;

    // Reset tracking variables
    this.generationStartTime = Date.now();
    this.reportedPercentage = 0;
    this.currentStage = undefined;
    this.loadStartTime = undefined;
    this.loadEndTime = undefined;
    this.diffusionStartTime = undefined;
    this.diffusionEndTime = undefined;
    this.vaeStartTime = undefined;
    this.vaeEndTime = undefined;
    this.loadProgress = { current: 0, total: 0 };
    this.diffusionProgress = { current: 0, total: 0 };
  }

  /**
   * Recalculate totalEstimatedTime using actual durations for completed stages
   * and estimated durations for remaining stages. Called at stage transitions
   * to keep the denominator aligned with the numerator in calculateOverallPercentage().
   * @private
   */
  private recalculateTotalEstimatedTime(config: ImageGenerationConfig): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    const loadTime =
      this.loadStartTime && this.loadEndTime
        ? this.loadEndTime - this.loadStartTime
        : this.currentLoadEstimate;

    const diffusionTime =
      this.diffusionStartTime && this.diffusionEndTime
        ? this.diffusionEndTime - this.diffusionStartTime
        : steps * megapixels * this.diffusionTimePerStepPerMegapixel;

    const vaeTime =
      this.vaeStartTime && this.vaeEndTime
        ? this.vaeEndTime - this.vaeStartTime
        : megapixels * this.vaeTimePerMegapixel;

    this.totalEstimatedTime = loadTime + diffusionTime + vaeTime;
  }

  /**
   * Feed one structured backend observation into the progress model
   *
   * The pinned build reports no progress in the job JSON, so generation progress is
   * derived from the backend's line-buffered stdout tap (marker literals live in
   * `SD_SERVER_STDOUT_MARKERS`). No-op when no generation is in flight — the same
   * backend process outlives individual jobs.
   * @private
   */
  private handleBackendStdoutEvent(event: SdServerStdoutEvent): void {
    const config = this.progressConfig;
    if (!config) return;

    if (event.type === 'marker') {
      if (event.marker === 'generating') {
        this.beginDiffusionStage(config);
      } else if (event.marker === 'decoding') {
        this.beginVaeStage(config);
      } else if (event.marker === 'decoded') {
        this.completeVaeStage(config);
      }
      // 'completed'/'listening' carry no progress meaning for the caller
      return;
    }

    if (event.type === 'step') {
      // The first step proves sampling started even when the marker literal drifted
      if (this.currentStage !== 'diffusion' && this.currentStage !== 'vae') {
        this.beginDiffusionStage(config);
      }
      if (this.currentStage === 'diffusion') {
        this.diffusionProgress = { current: event.step, total: event.steps };
        this.reportProgress(config);
      }
      return;
    }

    // Byte bars are weight uploads: loading progress only, never step progress
    if (this.currentStage === undefined || this.currentStage === 'loading') {
      this.currentStage = 'loading';
      this.loadStartTime ??= Date.now();
      this.loadProgress = { current: event.done, total: event.total };
      this.reportProgress(config);
    }
  }

  /**
   * Enter the sampling stage (idempotent)
   * @private
   */
  private beginDiffusionStage(config: ImageGenerationConfig): void {
    if (this.currentStage === 'diffusion' || this.currentStage === 'vae') return;

    // Unconditional: whatever preceded sampling (spawn, weight upload, conditioning)
    // is the load stage of this generation
    this.loadEndTime = Date.now();
    this.currentStage = 'diffusion';
    this.diffusionStartTime = Date.now();
    this.recalculateTotalEstimatedTime(config);
    this.reportProgress(config);
  }

  /**
   * Enter the VAE-decode stage (idempotent); reported as the 'decoding' wire token
   * @private
   */
  private beginVaeStage(config: ImageGenerationConfig): void {
    if (this.currentStage === 'vae') return;

    if (this.currentStage === 'diffusion') {
      this.diffusionEndTime = Date.now();
    } else {
      // Decoding without an observed sampling stage: close the load stage here
      this.loadEndTime ??= Date.now();
    }
    this.currentStage = 'vae';
    this.vaeStartTime = Date.now();
    this.recalculateTotalEstimatedTime(config);
    this.reportProgress(config);
    this.startSyntheticVaeProgress(config);
  }

  /**
   * Close the VAE stage and report 100% (idempotent)
   *
   * Fired by the 'decoded' marker or by the job reaching `completed`, whichever
   * lands first.
   * @private
   */
  private completeVaeStage(config: ImageGenerationConfig): void {
    if (this.vaeEndTime !== undefined) return;

    this.vaeEndTime = Date.now();
    this.recalculateTotalEstimatedTime(config);
    this.cleanupSyntheticProgress();
    if (config.onProgress) {
      config.onProgress(0, 0, 'decoding', 100);
    }
  }

  /**
   * Report current progress based on all stage timings
   * @private
   */
  private reportProgress(config: ImageGenerationConfig): void {
    if (!config.onProgress || !this.generationStartTime) return;

    // Calculate overall percentage
    const percentage = this.calculateOverallPercentage();

    // Report progress based on current stage with stage information
    if (this.currentStage === 'loading') {
      config.onProgress(this.loadProgress.current, this.loadProgress.total, 'loading', percentage);
    } else if (this.currentStage === 'diffusion') {
      config.onProgress(
        this.diffusionProgress.current,
        this.diffusionProgress.total,
        'diffusion',
        percentage
      );
    } else if (this.currentStage === 'vae') {
      // For VAE: no step count, just percentage with decoding stage
      config.onProgress(0, 0, 'decoding', percentage);
    }
  }

  /**
   * Calculate overall progress percentage
   *
   * In-flight values are capped at 99 and never decrease within a generation: a stage
   * that overruns its learned estimate would otherwise saturate the bar at 100 and fall
   * back at the next stage transition, when the denominator absorbs the overrun. Only
   * `completeVaeStage()` reports 100, once the image exists.
   * @private
   */
  private calculateOverallPercentage(): number {
    if (!this.generationStartTime) return 0;
    if (this.totalEstimatedTime <= 0) return this.reportedPercentage;

    let elapsedTotal = 0;

    // Loading stage
    if (this.currentStage === 'loading') {
      const elapsedLoad = Date.now() - (this.loadStartTime || this.generationStartTime);
      elapsedTotal = elapsedLoad;
    }
    // Diffusion stage
    else if (this.currentStage === 'diffusion') {
      const actualLoadTime = this.loadEndTime
        ? this.loadEndTime - (this.loadStartTime || this.generationStartTime)
        : this.currentLoadEstimate;
      const elapsedDiffusion = Date.now() - (this.diffusionStartTime || Date.now());
      elapsedTotal = actualLoadTime + elapsedDiffusion;
    }
    // VAE stage
    else if (this.currentStage === 'vae') {
      const actualLoadTime = this.loadEndTime
        ? this.loadEndTime - (this.loadStartTime || this.generationStartTime)
        : this.currentLoadEstimate;
      const actualDiffusionTime = this.diffusionEndTime
        ? this.diffusionEndTime - (this.diffusionStartTime || Date.now())
        : 0;
      const elapsedVae = Date.now() - (this.vaeStartTime || Date.now());
      elapsedTotal = actualLoadTime + actualDiffusionTime + elapsedVae;
    }

    const raw = Math.min(99, Math.round((elapsedTotal / this.totalEstimatedTime) * 100));
    this.reportedPercentage = Math.max(this.reportedPercentage, raw);
    return this.reportedPercentage;
  }

  /**
   * Start synthetic progress updates for VAE stage
   * @private
   */
  private startSyntheticVaeProgress(config: ImageGenerationConfig): void {
    if (!config.onProgress) return;

    // Clean up any existing interval
    this.cleanupSyntheticProgress();

    // Update progress every 100ms
    this.syntheticProgressInterval = setInterval(() => {
      // Calculate overall percentage
      const percentage = this.calculateOverallPercentage();

      // Report VAE decoding progress with stage information
      config.onProgress!(0, 0, 'decoding', percentage);
    }, 100);

    // Prevent synthetic interval from keeping the event loop alive
    if (
      this.syntheticProgressInterval &&
      typeof this.syntheticProgressInterval.unref === 'function'
    ) {
      this.syntheticProgressInterval.unref();
    }
  }

  /**
   * Clean up synthetic progress interval
   * @private
   */
  private cleanupSyntheticProgress(): void {
    if (this.syntheticProgressInterval) {
      clearInterval(this.syntheticProgressInterval);
      this.syntheticProgressInterval = undefined;
    }
  }

  /**
   * Update time estimates based on actual generation times
   *
   * @param config - Normalized generation config
   * @param spawned - True when this generation had to spawn the backend; its load
   *   measurement calibrates the COLD estimate, otherwise the warm one
   * @private
   */
  private updateTimeEstimates(config: ImageGenerationConfig, spawned: boolean): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;
    if (megapixels === 0 || steps === 0) return;

    // Compute actual times for stages with both start+end markers
    const hasLoad = !!(this.loadStartTime && this.loadEndTime);
    const hasDiffusion = !!(this.diffusionStartTime && this.diffusionEndTime);
    const hasVae = !!(this.vaeStartTime && this.vaeEndTime);

    const actualLoadTime = hasLoad ? this.loadEndTime! - this.loadStartTime! : undefined;
    const actualDiffusionTime = hasDiffusion
      ? this.diffusionEndTime! - this.diffusionStartTime!
      : undefined;
    const actualVaeTime = hasVae ? this.vaeEndTime! - this.vaeStartTime! : undefined;

    // Direct calibration for stages with known times
    if (actualLoadTime !== undefined) {
      if (spawned) this.modelLoadTime = actualLoadTime;
      else this.warmLoadTime = actualLoadTime;
    }
    if (actualDiffusionTime !== undefined) {
      this.diffusionTimePerStepPerMegapixel = actualDiffusionTime / (steps * megapixels);
    }
    if (actualVaeTime !== undefined) {
      this.vaeTimePerMegapixel = actualVaeTime / megapixels;
    }

    // Inference: if exactly one stage is missing, infer from total wall-clock time
    const knownCount = (hasLoad ? 1 : 0) + (hasDiffusion ? 1 : 0) + (hasVae ? 1 : 0);
    if (knownCount !== 2 || !this.generationStartTime) return;

    const totalActualTime = Date.now() - this.generationStartTime;
    const knownSum = (actualLoadTime || 0) + (actualDiffusionTime || 0) + (actualVaeTime || 0);

    // Subtract inter-stage gaps (overhead not belonging to any stage)
    let gaps = 0;
    if (this.loadStartTime && this.generationStartTime) {
      gaps += this.loadStartTime - this.generationStartTime;
    }
    if (this.loadEndTime && this.diffusionStartTime) {
      gaps += this.diffusionStartTime - this.loadEndTime;
    }
    if (this.diffusionEndTime && this.vaeStartTime) {
      gaps += this.vaeStartTime - this.diffusionEndTime;
    }

    const inferredTime = Math.max(0, totalActualTime - knownSum - gaps);

    if (!hasLoad) {
      if (spawned) this.modelLoadTime = inferredTime;
      else this.warmLoadTime = inferredTime;
    } else if (!hasDiffusion) {
      this.diffusionTimePerStepPerMegapixel = inferredTime / (steps * megapixels);
    } else if (!hasVae) {
      this.vaeTimePerMegapixel = inferredTime / megapixels;
    }
  }
}

/** PNG file signature — the first eight bytes of every PNG */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read the pixel dimensions from a PNG payload's IHDR chunk
 *
 * The signature is followed by the IHDR chunk: a 4-byte length, the `IHDR` tag, then
 * width and height as big-endian 32-bit integers. Returns `undefined` for anything that
 * is not a well-formed PNG header so the caller can fall back to the requested size.
 * @internal
 */
function readPngDimensions(image: Buffer): { width: number; height: number } | undefined {
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (image.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * Whether a bind address is loopback (`127.0.0.1` — the default — `localhost`, `::1`)
 *
 * Not the same question as `normalizeHealthHost()` (health-check.ts): that maps the
 * wildcards `0.0.0.0` / `::` TO a loopback address because a wildcard bind is reachable
 * through loopback, whereas here a wildcard is a deliberately widened bind that must stay
 * unguarded. Do not merge the two.
 * @internal
 */
function isLoopbackBindAddress(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}

/**
 * Host headers that cannot be a rebound DNS name: `localhost` (and `*.localhost`, which
 * resolvers pin to loopback), an IPv4 literal, or a bracketed IPv6 literal, each with an
 * optional port.
 */
const LOOPBACK_HOST_HEADER =
  /^(?:(?:[a-z0-9-]+\.)*localhost\.?|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Whether a request's `Host` header is acceptable on a loopback-bound wrapper. An absent
 * or empty header is accepted: browsers always send a real one, so neither can be a
 * rebinding attempt.
 * @internal
 */
function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  return LOOPBACK_HOST_HEADER.test(hostHeader.trim());
}

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request: `'*'` when the allowlist
 * carries the wildcard, the request origin when it is listed exactly, and `undefined` (no
 * CORS headers at all) otherwise — including the default empty allowlist.
 * @internal
 */
function resolveAllowedOrigin(
  allowedOrigins: readonly string[],
  origin: string | undefined
): string | undefined {
  if (allowedOrigins.includes('*')) return '*';
  if (origin !== undefined && allowedOrigins.includes(origin)) return origin;
  return undefined;
}

/**
 * Sleep helper for the job poll loop
 * @internal
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the backend already reported this job as finished (nothing left to stop)
 * @internal
 */
function isTerminalJobStatus(status: SdServerJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Whether a rejection means the backend process itself is gone
 * @internal
 */
function isBackendExit(error: unknown): boolean {
  if (
    !(error instanceof GenaiElectronError) ||
    !error.details ||
    typeof error.details !== 'object'
  ) {
    return false;
  }
  return (error.details as Record<string, unknown>).code === 'SD_SERVER_EXITED';
}

/**
 * Whether two resolved flag sets describe the same backend process
 * @internal
 */
function flagsEqual(a: ResolvedDiffusionFlags, b: ResolvedDiffusionFlags): boolean {
  return (
    a.clipOnCpu === b.clipOnCpu &&
    a.vaeOnCpu === b.vaeOnCpu &&
    a.offloadToCpu === b.offloadToCpu &&
    a.diffusionFlashAttention === b.diffusionFlashAttention
  );
}

/**
 * Error for a backend process that died while a job was in flight.
 *
 * The message keeps the historical 'exited with code' wording (mapped to
 * `BACKEND_ERROR` at the wire) and `details.stderr` keeps OOM classification working.
 * @internal
 */
function backendExitError(handle: SdServerHandle, exit: SdServerExit): ServerError {
  const stderr = handle.stderrTail || undefined;
  const args = handle.args.join(' ');
  return new ServerError(
    `stable-diffusion.cpp exited with code ${String(exit.code)}${
      stderr ? `\n${stderr}` : ''
    }\nArgs: ${args}`,
    {
      code: 'SD_SERVER_EXITED',
      exitCode: exit.code,
      signal: exit.signal,
      stderr,
      stdout: handle.stdoutTail || undefined,
      args,
    }
  );
}

/**
 * Machine-wide VRAM sampler for the timed samples of a calibration sweep.
 *
 * One instance serves a whole sweep and is reused window by window: {@link begin}
 * opens a measurement window (immediate reading plus a periodic timer), {@link end}
 * closes it with a final reading, and {@link measureIdle} takes the single settled
 * reading after the backend was released (`'single'`) or the job finished (`'burst'`).
 *
 * Two invariants make it safe to run inside an expensive sweep:
 *
 * - **Never throws into the sweep.** A failed or untrusted reading marks the window
 *   untrusted and both figures are omitted; a benchmark is never lost to telemetry.
 * - **Never leaks a timer.** The interval is unref'd and cleared by `end()`/`dispose()`.
 *
 * Trust rules are not reimplemented here: the injected capture is the same
 * {@link createTelemetrySnapshotCapture} adapter the LLM calibration guard uses, so
 * "VRAM is trusted only when a fresh `getGPUInfo()` supplies a finite non-negative
 * `vramAvailable`" is stated in exactly one place.
 * @internal
 */
class CalibrationVramSampler {
  /** Lowest trusted `vramAvailable` observed in the current window */
  private minAvailableBytes?: number;
  /** Settled `vramAvailable` from the current window's idle reading */
  private idleAvailableBytes?: number;
  /** Cleared by any unusable reading in the current window */
  private trusted = true;
  private timer?: NodeJS.Timeout;
  /** Serializes readings: a telemetry command may outlive one interval tick */
  private pending = false;
  /** Identifies the current window so a late reading cannot land in the next one */
  private windowId = 0;

  constructor(
    private readonly capture: CaptureResourceSnapshot,
    private readonly totalBytes: number,
    private readonly intervalMs: number
  ) {}

  /** Open a measurement window: reset, read once, then sample periodically */
  async begin(): Promise<void> {
    this.disarm();
    this.windowId++;
    this.minAvailableBytes = undefined;
    this.idleAvailableBytes = undefined;
    this.trusted = true;
    await this.sample();
    this.arm();
  }

  /** Close the window with a final reading and stop sampling */
  async end(): Promise<void> {
    this.disarm();
    await this.sample();
  }

  /** Take the settled reading the idle figure is computed from */
  async measureIdle(): Promise<void> {
    const available = await this.read();
    if (available === undefined) {
      this.trusted = false;
      return;
    }
    this.idleAvailableBytes = available;
  }

  /**
   * Figures of the window just closed
   *
   * All or nothing: the two are read together (peak vs idle of the same combo), so a
   * window that lost either reading reports neither rather than an unpaired half.
   */
  result(): CalibrationVramSample {
    if (!this.trusted) return {};
    if (this.minAvailableBytes === undefined || this.idleAvailableBytes === undefined) return {};
    return {
      vramPeakBytes: Math.max(0, this.totalBytes - this.minAvailableBytes),
      vramIdleBytes: Math.max(0, this.totalBytes - this.idleAvailableBytes),
    };
  }

  /** Stop sampling for good (idempotent; safe from a `finally`) */
  dispose(): void {
    this.disarm();
    this.windowId++;
  }

  /** One reading folded into the window's minimum @private */
  private async sample(): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    const windowId = this.windowId;
    try {
      const available = await this.read();
      if (windowId !== this.windowId) return; // the window closed while this was in flight
      if (available === undefined) {
        this.trusted = false;
        return;
      }
      if (this.minAvailableBytes === undefined || available < this.minAvailableBytes) {
        this.minAvailableBytes = available;
      }
    } finally {
      this.pending = false;
    }
  }

  /** Available VRAM in bytes, or undefined when the reading is unusable @private */
  private async read(): Promise<number | undefined> {
    try {
      const snapshot = await this.capture({});
      return snapshot.vram.trusted ? snapshot.vram.availableBytes : undefined;
    } catch (error) {
      debugLog('[Calibrate] VRAM reading failed:', error);
      return undefined;
    }
  }

  /** @private */
  private arm(): void {
    const timer = setInterval(() => {
      void this.sample();
    }, this.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timer = timer;
  }

  /** @private */
  private disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Median of a non-empty numeric array (mean of the middle two for even counts)
 * @internal
 */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Number of explicitly forced flags in a combo (label excluded)
 * @internal
 */
function countForcedFlags(combo: DiffusionOffloadCombo): number {
  let count = 0;
  if (combo.clipOnCpu !== undefined) count++;
  if (combo.vaeOnCpu !== undefined) count++;
  if (combo.offloadToCpu !== undefined) count++;
  if (combo.diffusionFlashAttention !== undefined) count++;
  return count;
}

/**
 * Pick the recommended offload combo per size from calibration runs.
 *
 * Per size: the fastest run with status 'ok' wins; any OK run within
 * `tolerancePct` percent of the fastest that forces FEWER flags wins the tie
 * (robustness preference — closer to auto). Sizes where every combo failed
 * are absent from the result.
 *
 * Exported for direct unit testing; not part of the public package API.
 * @internal
 */
export function pickRecommended(
  runs: CalibrationRun[],
  tolerancePct: number
): Record<string, DiffusionOffloadCombo> {
  const bySize = new Map<string, CalibrationRun[]>();
  for (const run of runs) {
    if (run.status !== 'ok' || run.timeTakenMs === undefined) {
      continue;
    }
    const key = `${run.size.width}x${run.size.height}`;
    const list = bySize.get(key);
    if (list) {
      list.push(run);
    } else {
      bySize.set(key, [run]);
    }
  }

  const recommended: Record<string, DiffusionOffloadCombo> = {};
  for (const [key, okRuns] of bySize) {
    const fastest = okRuns.reduce((a, b) => (b.timeTakenMs! < a.timeTakenMs! ? b : a));
    const threshold = fastest.timeTakenMs! * (1 + tolerancePct / 100);
    const winner = okRuns
      .filter((run) => run.timeTakenMs! <= threshold)
      .sort(
        (a, b) =>
          countForcedFlags(a.combo) - countForcedFlags(b.combo) || a.timeTakenMs! - b.timeTakenMs!
      )[0]!;
    recommended[key] = winner.combo;
  }
  return recommended;
}
