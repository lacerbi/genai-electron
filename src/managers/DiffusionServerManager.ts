/**
 * DiffusionServerManager - Manages diffusion server lifecycle
 *
 * Creates an HTTP wrapper server for stable-diffusion.cpp executable.
 * Unlike llama-server (native HTTP server), stable-diffusion.cpp is a
 * one-shot executable, so we create our own HTTP server that spawns
 * the executable on-demand.
 *
 * @module managers/DiffusionServerManager
 */

import { ServerManager } from './ServerManager.js';
import { ModelManager } from './ModelManager.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { ProcessManager } from '../process/ProcessManager.js';
import { ResourceOrchestrator } from './ResourceOrchestrator.js';
import { GenerationRegistry } from './GenerationRegistry.js';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { getTempPath } from '../config/paths.js';
import {
  BINARY_VERSIONS,
  DEFAULT_PORTS,
  DIFFUSION_VRAM_THRESHOLDS,
  DIFFUSION_COMPONENT_FLAGS,
  DIFFUSION_COMPONENT_ORDER,
  DIFFUSION_CALIBRATION_DEFAULTS,
} from '../config/defaults.js';
import { deleteFile } from '../utils/file-utils.js';
import { debugLog } from '../utils/debug-log.js';
import { findFreePort } from '../process/port-utils.js';
import {
  GenaiElectronError,
  ServerError,
  ModelNotFoundError,
  InsufficientResourcesError,
} from '../errors/index.js';
import type {
  CalibrationRun,
  CalibrationSize,
  DiffusionCalibrationConfig,
  DiffusionCalibrationProgress,
  DiffusionCalibrationReport,
  DiffusionOffloadCombo,
  DiffusionServerConfig,
  DiffusionServerInfo,
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageSampler,
  ModelInfo,
  ServerInfo,
} from '../types/index.js';
import type { LlamaServerManager } from './LlamaServerManager.js';

/**
 * DiffusionServerManager class
 *
 * Manages the lifecycle of diffusion HTTP wrapper server.
 *
 * Features:
 * - HTTP server wrapper around stable-diffusion.cpp executable
 * - On-demand spawning of stable-diffusion.cpp for image generation
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
  /** Fields accepted by DiffusionServerManager.start() (DiffusionServerConfig) */
  private static readonly VALID_CONFIG_FIELDS: ReadonlySet<string> = new Set([
    'modelId',
    'port',
    'threads',
    'gpuLayers',
    'forceValidation',
    'clipOnCpu',
    'vaeOnCpu',
    'batchSize',
    'offloadToCpu',
    'diffusionFlashAttention',
  ]);

  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private orchestrator?: ResourceOrchestrator;
  private registry: GenerationRegistry;
  private binaryPath?: string;
  private httpServer?: http.Server;
  private currentGeneration?: {
    promise: Promise<ImageGenerationResult>;
    cancel: () => void;
  };
  /**
   * Registry-tracked generation currently being processed by
   * runAsyncGeneration. The `cancelled` flag is checked between batch
   * iterations, so cancellation also works in the gap when no sd-cli
   * child process is alive.
   */
  private activeGeneration?: { id: string; cancelled: boolean };
  private currentModelInfo?: ModelInfo;
  /**
   * Flags resolved by the most recent computeDiffusionOptimizations() call.
   * Read by calibrate() after each run to report what auto-detection picked.
   */
  private lastResolvedOptimizations?: {
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
  };
  /** True while an offload-calibration sweep is running (server stays 'stopped') */
  private calibrating = false;

  // Time estimates for progress calculation (self-calibrating)
  private modelLoadTime = 2000; // Fixed cost in ms
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
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;

    // Initialize generation registry for async API
    this.registry = this.createRegistry();

    // Create orchestrator if llamaServer is provided (enables automatic resource management)
    if (llamaServer) {
      this.orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, this, modelManager);
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
   * Creates an HTTP server that will spawn stable-diffusion.cpp on-demand
   * when image generation requests are received.
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
    if (this._status === 'running') {
      throw new ServerError('Server is already running', {
        suggestion: 'Stop the server first with stop()',
      });
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

      // 4. Resolve the port ONCE ('auto' → OS-assigned free port), then check it.
      // createHTTPServer receives the resolved number — resolving twice would
      // probe one port and bind another.
      const port =
        config.port === 'auto' ? await findFreePort() : (config.port ?? DEFAULT_PORTS.diffusion);
      await this.checkPortAvailability(port);

      // 5. Initialize log manager
      await this.initializeLogManager(
        'diffusion-server.log',
        `Starting diffusion server on port ${port}`
      );

      // 6. Create HTTP server
      await this.createHTTPServer(port);

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
   * Closes HTTP wrapper server and cancels any ongoing generation.
   *
   * @throws {ServerError} If stop fails
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      return;
    }

    this.setStatus('stopping');

    try {
      if (this.logManager) {
        await this.logManager.write('Stopping diffusion server...', 'info');
      }

      // Cancel any ongoing generation (incl. halting a batch between images)
      if (this.activeGeneration) {
        this.activeGeneration.cancelled = true;
      }
      if (this.currentGeneration) {
        this.currentGeneration.cancel();
        this.currentGeneration = undefined;
      }

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
    return this.activeGeneration?.id;
  }

  /**
   * Cancel an in-flight async generation by its registry ID
   *
   * Marks the generation 'cancelled' in the registry, halts the batch loop
   * (also between images), and kills the running sd-cli process if any.
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

    if (this.activeGeneration?.id === id) {
      this.activeGeneration.cancelled = true;
      this.currentGeneration?.cancel();
      this.currentGeneration = undefined;
    }

    await this.logManager?.write(`Generation ${id} cancelled`, 'info');
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
    const sizes = config.sizes && config.sizes.length > 0 ? config.sizes : [...defaults.sizes];
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
    const steps = config.steps ?? defaults.steps;
    const seed = config.seed ?? defaults.seed;
    const sampler = config.sampler ?? defaults.sampler;
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

    // Hoisted for the finally block ('restoring-llm'/'done' emits)
    let emitFn: ((p: DiffusionCalibrationProgress) => void) | undefined;
    let comboCountForProgress = 0;
    let lastOverallPercent = 0;
    let succeeded = false;

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
          }, steps=${steps}, samples=${samples}`,
          'info'
        )
        .catch(() => void 0);

      // Install working state. May download the binary on first run
      // (long; reports via 'binary-progress'/'binary-log' events).
      this.currentModelInfo = modelInfo;
      this.binaryPath = await this.ensureBinary(modelInfo);
      if (config.signal?.aborted) {
        throw this.calibrationAbortError(runs);
      }
      const syntheticConfig: DiffusionServerConfig = { modelId: config.modelId };
      if (config.threads !== undefined) {
        syntheticConfig.threads = config.threads;
      }
      if (config.batchSize !== undefined) {
        syntheticConfig.batchSize = config.batchSize;
      }
      this._config = syntheticConfig as unknown as typeof this._config;

      // Offload a running LLM once for the whole sweep (measurement hygiene).
      // waitForReload() first: a background reload from a prior orchestrated
      // generation would otherwise read as not-running and come back mid-sweep.
      await this.orchestrator?.waitForReload();
      await this.orchestrator?.offloadLLM();

      // --- Sweep (combo-outer, size-inner; every generation does identical work) ---
      for (let comboIndex = 0; comboIndex < combos.length; comboIndex++) {
        const combo = combos[comboIndex]!;
        const baseProgress = {
          comboIndex,
          comboCount: combos.length,
          combo,
          sizeCount: sizes.length,
        };

        // Warmup at the first size (discarded; stabilizes disk cache / first-spawn overhead)
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
          await this.runCalibrationGeneration({
            prompt,
            size: sizes[0]!,
            steps,
            cfgScale: config.cfgScale,
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
        }
        completedUnits++;

        for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
          const size = sizes[sizeIndex]!;
          const samplesMs: number[] = [];
          const snapshots: { loadMs?: number; diffusionMs?: number; decodeMs?: number }[] = [];
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
                const result = await this.runCalibrationGeneration({
                  prompt,
                  size,
                  steps,
                  cfgScale: config.cfgScale,
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
                samplesMs.push(result.timeTaken);
                // Snapshot per sample: the stage timestamps are instance
                // fields reset by the next generation
                snapshots.push(this.snapshotStageMs());
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
        sampler,
        samples,
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
   * Run one calibration generation with per-combo flag overrides
   * @private
   */
  private async runCalibrationGeneration(params: {
    prompt: string;
    size: CalibrationSize;
    steps: number;
    cfgScale?: number;
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
      seed: params.seed,
      sampler: params.sampler,
      onProgress: (_currentStep, _totalSteps, _stage, percentage) => {
        if (percentage !== undefined) {
          params.onGenerationProgress(percentage);
        }
      },
    };
    if (params.cfgScale !== undefined) {
      genConfig.cfgScale = params.cfgScale;
    }
    return this.executeImageGeneration(genConfig, params.combo);
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
   * @private
   */
  private classifyCalibrationFailure(error: unknown): {
    status: 'oom' | 'error';
    message: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    let stderr = '';
    if (error instanceof GenaiElectronError && error.details && typeof error.details === 'object') {
      const detailStderr = (error.details as Record<string, unknown>).stderr;
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
   * Spawns stable-diffusion.cpp executable with the provided configuration.
   * For cancellable generations, use the async HTTP API and
   * cancelImageGeneration(); direct calls run to completion or error
   * (or are cancelled by stop()).
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

    if (this.orchestrator) {
      return this.orchestrator.orchestrateImageGeneration(config);
    } else {
      return this.executeImageGeneration(config);
    }
  }

  /**
   * Check if server is healthy
   *
   * @returns True if server is running and HTTP server is available
   */
  async isHealthy(): Promise<boolean> {
    return this._status === 'running' && this.httpServer !== undefined;
  }

  /**
   * Get server information with diffusion-specific fields
   *
   * @returns Server information including busy status
   */
  override getInfo(): DiffusionServerInfo {
    const baseInfo = super.getInfo();
    return {
      ...baseInfo,
      busy: !!this.currentGeneration,
    } as DiffusionServerInfo;
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

    return this.ensureBinaryHelper(
      'diffusion',
      'sd-cli',
      BINARY_VERSIONS.diffusionCpp,
      modelInfo?.path,
      forceValidation,
      testModelArgs
    );
  }

  /**
   * Create HTTP server with async generation endpoints
   *
   * @param port - Resolved port number to listen on
   * @private
   */
  private async createHTTPServer(port: number): Promise<void> {
    this.httpServer = http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        // Health endpoint
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', busy: !!this.currentGeneration }));
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

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, () => resolve());
      this.httpServer!.on('error', reject);
    });

    await this.logManager?.write(`HTTP server listening on port ${port}`, 'info');
  }

  /**
   * Handle POST /v1/images/generations - Start async generation
   * @private
   */
  private async handleStartGeneration(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Parse request body
    const body = await this.parseRequestBody(req);
    const imageConfig: ImageGenerationConfig = JSON.parse(body);

    // Validate required fields
    if (!imageConfig.prompt) {
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

    // Create generation entry in registry
    const id = this.registry.create(imageConfig);

    // Start generation asynchronously (don't await)
    this.runAsyncGeneration(id, imageConfig).catch((error) => {
      // Never overwrite a cancellation: the rejection of a killed sd-cli
      // process lands here after cancelImageGeneration set 'cancelled'
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

    // A cancel may have landed between create and this call
    if (this.registry.get(id)?.status === 'cancelled') {
      return;
    }

    this.activeGeneration = { id, cancelled: false };

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
            currentImage:
              config.count && config.count > 1
                ? Math.floor((percentage || 0) / (100 / config.count)) + 1
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

      if (count > 1) {
        // Batch generation (orchestration not yet supported for batch)
        results = await this.executeBatchGeneration(wrappedConfig);
      } else {
        // Single image: use orchestrator if available (same logic as public generateImage method)
        if (this.orchestrator) {
          results = [await this.orchestrator.orchestrateImageGeneration(wrappedConfig)];
        } else {
          results = [await this.executeImageGeneration(wrappedConfig)];
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
    } finally {
      this.activeGeneration = undefined;
    }
  }

  /**
   * Map error to error code
   * @private
   */
  private mapErrorCode(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes('server is busy')) return 'SERVER_BUSY';
      if (message.includes('not running')) return 'SERVER_NOT_RUNNING';
      if (message.includes('failed to spawn')) return 'BACKEND_ERROR';
      if (message.includes('exited with code')) return 'BACKEND_ERROR';
      if (message.includes('failed to read')) return 'IO_ERROR';
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
   * Execute image generation by spawning stable-diffusion.cpp
   *
   * This is the direct execution method used internally and by ResourceOrchestrator.
   * External callers should use generateImage() which includes automatic resource management.
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

    // Initialize progress tracking
    this.initializeProgressTracking(normalizedConfig);

    // Compute VRAM optimizations (fresh GPU info, respects user overrides)
    const optimizations = await this.computeDiffusionOptimizations(flagOverrides);

    // Build command-line arguments
    const args = this.buildDiffusionArgs(normalizedConfig, this.currentModelInfo, optimizations);

    // Output file path
    const outputPath = getTempPath(`sd-output-${Date.now()}.png`);
    args.push('-o', outputPath);

    await this.logManager?.write(`Generating image: ${this.binaryPath} ${args.join(' ')}`, 'info');
    await this.logManager?.write(
      `Model info: id=${this.currentModelInfo.id}, components=${this.currentModelInfo.components ? Object.keys(this.currentModelInfo.components).join(',') : 'none'}, path=${this.currentModelInfo.path}`,
      'info'
    );

    // Spawn stable-diffusion.cpp
    let cancelled = false;
    let pid: number | undefined;
    const stderrLines: string[] = [];
    const MAX_STDERR_LINES = 20;

    const generationPromise = new Promise<ImageGenerationResult>((resolve, reject) => {
      const spawnResult = this.processManager.spawn(this.binaryPath!, args, {
        onStdout: (data) => {
          this.processStdoutForProgress(data, normalizedConfig);
          this.logManager?.write(data, 'info').catch(() => void 0);
        },
        onStderr: (data) => {
          this.logManager?.write(data, 'warn').catch(() => void 0);
          // Accumulate stderr for error diagnostics (sliding window of last N lines)
          const lines = data.split('\n').filter((line: string) => line.trim() !== '');
          for (const line of lines) {
            stderrLines.push(line);
          }
          if (stderrLines.length > MAX_STDERR_LINES) {
            stderrLines.splice(0, stderrLines.length - MAX_STDERR_LINES);
          }
        },
        onExit: async (code) => {
          // Clean up synthetic progress interval
          this.cleanupSyntheticProgress();

          if (cancelled) {
            reject(new Error('Image generation cancelled'));
            return;
          }

          if (code !== 0) {
            const stderrOutput = stderrLines.length > 0 ? stderrLines.join('\n') : '';
            const argsStr = args.join(' ');
            reject(
              new ServerError(
                `stable-diffusion.cpp exited with code ${code}${stderrOutput ? `\n${stderrOutput}` : ''}\nArgs: ${argsStr}`,
                {
                  exitCode: code,
                  stderr: stderrOutput || undefined,
                  args: argsStr,
                }
              )
            );
            return;
          }

          // Read generated image
          try {
            const imageBuffer = await fs.readFile(outputPath);
            await deleteFile(outputPath).catch(() => void 0);

            // Update time estimates based on actual generation times
            this.updateTimeEstimates(normalizedConfig);

            resolve({
              image: imageBuffer,
              format: 'png',
              timeTaken: Date.now() - startTime,
              seed: normalizedConfig.seed,
              width: normalizedConfig.width || 512,
              height: normalizedConfig.height || 512,
            });
          } catch (error) {
            reject(
              new ServerError('Failed to read generated image', {
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        },
        onError: (error) => {
          this.cleanupSyntheticProgress();
          reject(
            new ServerError('Failed to spawn stable-diffusion.cpp', {
              error: error.message,
            })
          );
        },
      });
      pid = spawnResult.pid;
    });

    // Store cancellation function AFTER promise is created
    this.currentGeneration = {
      promise: generationPromise,
      cancel: () => {
        cancelled = true;
        this.cleanupSyntheticProgress();
        if (pid !== undefined) {
          this.processManager.kill(pid, 5000).catch(() => void 0);
        }
      },
    };

    try {
      const result = await generationPromise;
      this.currentGeneration = undefined;
      return result;
    } catch (error) {
      this.currentGeneration = undefined;
      throw error;
    }
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
      // Honor cancellation between images: currentGeneration is undefined in
      // this gap, so the flag is the only way a cancel can halt the batch
      if (this.activeGeneration?.cancelled) {
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
  private async computeDiffusionOptimizations(flagOverrides?: DiffusionOffloadCombo): Promise<{
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
    batchSize?: number;
  }> {
    const serverConfig = this._config as DiffusionServerConfig;
    const modelSize = this.currentModelInfo?.size ?? 0;
    const modelFootprint = modelSize * DIFFUSION_VRAM_THRESHOLDS.modelOverheadMultiplier;

    let autoClipOnCpu = false;
    let autoVaeOnCpu = false;
    let autoOffloadToCpu = false;

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
   * Build command-line arguments for stable-diffusion.cpp
   *
   * @param config - Image generation configuration
   * @param modelInfo - Model information
   * @param optimizations - Resolved VRAM optimization flags
   * @returns Array of command-line arguments
   * @private
   */
  private buildDiffusionArgs(
    config: ImageGenerationConfig,
    modelInfo: ModelInfo,
    optimizations?: {
      clipOnCpu: boolean;
      vaeOnCpu: boolean;
      offloadToCpu: boolean;
      diffusionFlashAttention: boolean;
      batchSize?: number;
    }
  ): string[] {
    const args: string[] = [];

    // Model path(s) — multi-component or single-file
    if (modelInfo.components) {
      // Validate that the components map includes the primary diffusion_model
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

    // Prompt (required)
    if (config.prompt) {
      args.push('-p', config.prompt);
    }

    // Negative prompt (optional)
    if (config.negativePrompt) {
      args.push('-n', config.negativePrompt);
    }

    // Image dimensions
    if (config.width) {
      args.push('-W', String(config.width));
    }
    if (config.height) {
      args.push('-H', String(config.height));
    }

    // Steps
    if (config.steps) {
      args.push('--steps', String(config.steps));
    }

    // CFG scale
    if (config.cfgScale) {
      args.push('--cfg-scale', String(config.cfgScale));
    }

    // Seed (always present after normalization in executeImageGeneration)
    if (config.seed !== undefined) {
      args.push('-s', String(config.seed));
    }

    // Sampler
    if (config.sampler) {
      args.push('--sampling-method', config.sampler);
    }

    // Note: gpuLayers is accepted in DiffusionServerConfig but stable-diffusion.cpp
    // does not have a --n-gpu-layers flag (that's llama.cpp). GPU offload in sd.cpp
    // is automatic when built with CUDA/Metal support. The field is kept in the config
    // for future use and for consistency with the ServerConfig pattern.

    // Threads
    const serverConfig = this._config as DiffusionServerConfig;
    if (serverConfig.threads) {
      args.push('-t', String(serverConfig.threads));
    }

    // VRAM optimization flags
    if (optimizations) {
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
      if (optimizations.batchSize !== undefined) {
        args.push('-b', String(optimizations.batchSize));
      }
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
   * @private
   */
  private initializeProgressTracking(config: ImageGenerationConfig): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    // Calculate total estimated time
    this.totalEstimatedTime =
      this.modelLoadTime +
      steps * megapixels * this.diffusionTimePerStepPerMegapixel +
      megapixels * this.vaeTimePerMegapixel;

    // Reset tracking variables
    this.generationStartTime = Date.now();
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
        : this.modelLoadTime;

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
   * Process stdout data for progress tracking
   * @private
   */
  private processStdoutForProgress(data: string, config: ImageGenerationConfig): void {
    // Detect stage transitions ('loading tensors from' up to sd.cpp master-504;
    // 'loading model from' since master-746)
    if (data.includes('loading tensors from') || data.includes('loading model from')) {
      this.currentStage = 'loading';
      this.loadStartTime = Date.now();
      this.reportProgress(config);
    } else if (data.includes('generating image:') || data.includes('sampling using')) {
      if (this.currentStage === 'loading') {
        this.loadEndTime = Date.now();
      }
      this.currentStage = 'diffusion';
      this.diffusionStartTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
      this.reportProgress(config);
    } else if (data.includes('decoding 1 latents')) {
      if (this.currentStage === 'diffusion') {
        this.diffusionEndTime = Date.now();
      }
      this.currentStage = 'vae';
      this.vaeStartTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
      this.reportProgress(config);
      // Start synthetic progress for VAE stage
      this.startSyntheticVaeProgress(config);
    } else if (data.includes('decode_first_stage completed')) {
      this.vaeEndTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
      this.cleanupSyntheticProgress();
      // Report 100% completion with decoding stage
      if (config.onProgress) {
        config.onProgress(0, 0, 'decoding', 100);
      }
    }

    // Parse step progress bar: "| X/Y - Z.ZZit/s" — the it-rate unit is required
    // so byte-progress bars ("# X/Y - Z.ZZMB/s", tensor loading) can't register as steps
    const progressMatch = data.match(/\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/);
    if (progressMatch && progressMatch[1] && progressMatch[2]) {
      const current = parseInt(progressMatch[1], 10);
      const total = parseInt(progressMatch[2], 10);

      if (this.currentStage === 'loading') {
        this.loadProgress = { current, total };
        this.reportProgress(config);
      } else if (this.currentStage === 'diffusion') {
        this.diffusionProgress = { current, total };
        this.reportProgress(config);
      } else if (this.currentStage === undefined) {
        // If stage not set yet but we're seeing progress bars, assume it's loading
        // This handles the case where progress bars arrive before stage detection
        this.currentStage = 'loading';
        this.loadStartTime = Date.now();
        this.loadProgress = { current, total };
        this.reportProgress(config);
      }
    }

    // Byte-progress bar: "|####    | X/Y - Z.ZZMB/s" — printed while loading
    // model/tensor data (sd.cpp master-746+). Feeds loading progress only;
    // component reloads mid-generation must never touch step progress.
    const byteMatch = data.match(/\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:B|KB|MB|GB)\/s/);
    if (byteMatch && byteMatch[1] && byteMatch[2]) {
      const current = parseInt(byteMatch[1], 10);
      const total = parseInt(byteMatch[2], 10);

      if (this.currentStage === 'loading') {
        this.loadProgress = { current, total };
        this.reportProgress(config);
      } else if (this.currentStage === undefined) {
        // Byte bars before any stage marker mean the model is loading
        this.currentStage = 'loading';
        this.loadStartTime = Date.now();
        this.loadProgress = { current, total };
        this.reportProgress(config);
      }
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
   * @private
   */
  private calculateOverallPercentage(): number {
    if (!this.generationStartTime || this.totalEstimatedTime === 0) return 0;

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
        : this.modelLoadTime;
      const elapsedDiffusion = Date.now() - (this.diffusionStartTime || Date.now());
      elapsedTotal = actualLoadTime + elapsedDiffusion;
    }
    // VAE stage
    else if (this.currentStage === 'vae') {
      const actualLoadTime = this.loadEndTime
        ? this.loadEndTime - (this.loadStartTime || this.generationStartTime)
        : this.modelLoadTime;
      const actualDiffusionTime = this.diffusionEndTime
        ? this.diffusionEndTime - (this.diffusionStartTime || Date.now())
        : 0;
      const elapsedVae = Date.now() - (this.vaeStartTime || Date.now());
      elapsedTotal = actualLoadTime + actualDiffusionTime + elapsedVae;
    }

    return Math.min(100, Math.round((elapsedTotal / this.totalEstimatedTime) * 100));
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
   * @private
   */
  private updateTimeEstimates(config: ImageGenerationConfig): void {
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
      this.modelLoadTime = actualLoadTime;
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
      this.modelLoadTime = inferredTime;
    } else if (!hasDiffusion) {
      this.diffusionTimePerStepPerMegapixel = inferredTime / (steps * megapixels);
    } else if (!hasVae) {
      this.vaeTimePerMegapixel = inferredTime / megapixels;
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
