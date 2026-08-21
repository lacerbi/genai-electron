/**
 * ResourceOrchestrator - Manages resource allocation between servers
 *
 * Automatically offloads and reloads servers when resources are constrained.
 * For example, if VRAM is limited, it will stop the LLM server before
 * starting image generation, then restart the LLM after completion.
 *
 * @module managers/ResourceOrchestrator
 */

import { SystemInfo } from '../system/SystemInfo.js';
import type { LlamaServerManager } from './LlamaServerManager.js';
import type { DiffusionServerManager } from './DiffusionServerManager.js';
import { ModelManager } from './ModelManager.js';
import type {
  ServerConfig,
  LlamaServerConfig,
  DiffusionBackendReleaseReason,
  DiffusionUsageMode,
  ImageGenerationConfig,
  ImageGenerationResult,
  ModelInfo,
} from '../types/index.js';
import { estimateKVBytesPerToken } from '../utils/kv-cache-math.js';
import { getExpertWeightsBytesWithFallback } from '../utils/model-metadata-helpers.js';
import { ServerError } from '../errors/index.js';
import { debugLog } from '../utils/debug-log.js';

/**
 * Saved LLM state for restoration
 */
export interface SavedLLMState {
  /** LLM server configuration */
  config: ServerConfig;
  /** Whether LLM was running before offload */
  wasRunning: boolean;
  /** When state was saved */
  savedAt: Date;
}

/**
 * Resource requirements for a server
 */
interface ResourceRequirements {
  /** RAM usage in bytes */
  ram: number;
  /** VRAM usage in bytes (undefined for CPU-only) */
  vram?: number;
}

/**
 * ResourceOrchestrator class
 *
 * Manages resource allocation and automatic offload/reload logic.
 *
 * @example
 * ```typescript
 * import { llamaServer, diffusionServer, systemInfo } from 'genai-electron';
 * import { ResourceOrchestrator } from 'genai-electron';
 *
 * const orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, diffusionServer);
 *
 * // Start LLM server
 * await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
 *
 * // Start diffusion server
 * await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });
 *
 * // Generate image with automatic resource management
 * // If resources are constrained, LLM will be offloaded automatically
 * const result = await orchestrator.orchestrateImageGeneration({
 *   prompt: 'A serene mountain landscape'
 * });
 * // LLM is automatically reloaded after image generation
 * ```
 */
export class ResourceOrchestrator {
  private static readonly RELOAD_RETRY_DELAY_MS = 2000;

  /**
   * Backend release reasons that may bring a previously offloaded LLM back.
   *
   * `'cancel'` is in the set because a cancelled generation kills the backend and
   * then ends: under `'burst'` nothing else would ever release the VRAM, so the LLM
   * would stay down forever. Double reloads are impossible by construction —
   * {@link fireAndForgetReload} is the single trigger and every caller checks
   * `pendingReload` first.
   *
   * Everything else is deliberately silent: `'single'` reloads through the
   * orchestration branch that owns the offload context, `'llm-start'` fires from
   * inside the LLM's own pre-start hook, `'shutdown'` runs while the app is quitting,
   * `'calibration'` belongs to a sweep that restores the LLM itself, and
   * `'flags-changed'` is immediately followed by another spawn for the same image.
   */
  private static readonly RELOAD_RELEASE_REASONS: ReadonlySet<DiffusionBackendReleaseReason> =
    new Set<DiffusionBackendReleaseReason>([
      'idle-timeout',
      'explicit',
      'crashed',
      'stop',
      'cancel',
    ]);

  /** Backend states in which a process is holding (or about to hold) VRAM */
  private static readonly RESIDENT_BACKEND_STATES: ReadonlySet<string> = new Set([
    'starting',
    'ready',
    'busy',
  ]);

  private systemInfo: SystemInfo;
  private llamaServer: LlamaServerManager;
  private diffusionServer: DiffusionServerManager;
  private modelManager: ModelManager;
  private savedLLMState?: SavedLLMState;
  private pendingReload: Promise<void> | null = null;

  /**
   * Create a new ResourceOrchestrator
   *
   * @param systemInfo - System information instance (default: singleton)
   * @param llamaServer - LLM server manager instance
   * @param diffusionServer - Diffusion server manager instance
   * @param modelManager - Model manager instance (default: singleton)
   */
  constructor(
    systemInfo: SystemInfo = SystemInfo.getInstance(),
    llamaServer: LlamaServerManager,
    diffusionServer: DiffusionServerManager,
    modelManager: ModelManager = ModelManager.getInstance()
  ) {
    this.systemInfo = systemInfo;
    this.llamaServer = llamaServer;
    this.diffusionServer = diffusionServer;
    this.modelManager = modelManager;
  }

  /**
   * Orchestrate image generation with automatic resource management
   *
   * Checks if there are enough resources. If not, offloads LLM first,
   * generates image, then reloads LLM.
   *
   * @param config - Image generation configuration
   * @returns Generated image result
   * @throws {ServerError} If diffusion server is not running
   *
   * @example
   * ```typescript
   * const result = await orchestrator.orchestrateImageGeneration({
   *   prompt: 'A beautiful sunset over mountains',
   *   width: 1024,
   *   height: 1024,
   *   steps: 30
   * });
   * ```
   */
  async orchestrateImageGeneration(config: ImageGenerationConfig): Promise<ImageGenerationResult> {
    debugLog('[Orchestrator] orchestrateImageGeneration called');
    return await this.orchestrateGeneration(config, () =>
      this.diffusionServer.executeImageGeneration(config)
    );
  }

  /**
   * Orchestrate a multi-image (batch) generation with automatic resource management
   *
   * Same offload window as {@link orchestrateImageGeneration}, opened once around the
   * whole batch: the LLM is offloaded at most once and residency is settled once, after
   * the last image.
   *
   * @param config - Image generation configuration (`count` > 1)
   * @returns One result per generated image
   *
   * @example
   * ```typescript
   * const results = await orchestrator.orchestrateBatchGeneration({
   *   prompt: 'A serene mountain landscape',
   *   count: 3,
   * });
   * ```
   */
  async orchestrateBatchGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult[]> {
    debugLog('[Orchestrator] orchestrateBatchGeneration called');
    return await this.orchestrateGeneration(config, () =>
      this.diffusionServer.executeBatchGeneration(config)
    );
  }

  /**
   * Shared offload window for single and batch generation
   *
   * Offloads the LLM when both servers would not fit, runs the generation, and then
   * settles diffusion residency exactly once — the orchestrator owns that decision
   * because it owns the offload context.
   *
   * @param config - Image generation configuration (its `usageMode` is the request hint)
   * @param run - The generation to execute inside the window
   * @private
   */
  private async orchestrateGeneration<T>(
    config: ImageGenerationConfig,
    run: () => Promise<T>
  ): Promise<T> {
    // If a previous generation's reload is still in progress, wait for it
    // to finish before potentially offloading again (prevents VRAM contention)
    const inFlightReload = this.pendingReload;
    if (inFlightReload) {
      debugLog('[Orchestrator] Awaiting pending LLM reload from previous generation...');
      await inFlightReload;
      if (this.pendingReload === inFlightReload) this.pendingReload = null;
    }

    // Check if we need to offload LLM
    const needsOffload = await this.needsOffloadForImage();
    const llamaIsRunning = this.llamaServer.isRunning();

    debugLog('[Orchestrator] needsOffload:', needsOffload);
    debugLog('[Orchestrator] llamaServer.isRunning():', llamaIsRunning);

    if (needsOffload && llamaIsRunning) {
      debugLog('[Orchestrator] ⚠️  Resources constrained - offloading LLM before generation');
      // Save LLM state and offload
      await this.offloadLLM();

      let result: T;
      try {
        // Generate directly (bypassing orchestrator to avoid recursion)
        debugLog('[Orchestrator] Generating image with LLM offloaded...');
        result = await run();
      } catch (error) {
        // Generation failed — still settle residency and reload, then rethrow
        debugLog('[Orchestrator] Image generation failed, settling residency...');
        await this.settleAfterOffload(config);
        throw error;
      }

      // Image ready — settle residency, then return (the reload runs in background)
      await this.settleAfterOffload(config);
      return result;
    }

    if (!needsOffload) {
      debugLog('[Orchestrator] ✅ Sufficient resources - generating directly without offload');
    } else {
      debugLog('[Orchestrator] ✅ LLM not running - generating directly');
    }
    // Enough resources, generate directly (bypassing orchestrator to avoid recursion)
    try {
      return await run();
    } finally {
      // No offload happened HERE, so the default residency is 'burst'
      const mode = this.diffusionServer.resolveUsageMode(config.usageMode, false);
      await this.settleResidency(mode);

      // An EARLIER 'burst' cycle may still be holding a saved LLM state. Releasing the
      // backend for reason 'single' does not qualify for the callback (it is normally
      // owned by the offload branch), so this branch has to bring the LLM back itself —
      // otherwise a burst-then-single sequence would leave the LLM down forever.
      if (
        mode === 'single' &&
        this.savedLLMState &&
        !this.pendingReload &&
        !this.diffusionServer.isCalibrating()
      ) {
        debugLog('[Orchestrator] Backend released for a single-mode request - reloading LLM');
        this.fireAndForgetReload();
      }
    }
  }

  /**
   * Settle diffusion residency for a generation that ran with the LLM offloaded
   *
   * `'single'` releases the backend BEFORE the LLM reload starts, so the two never
   * hold VRAM at the same time. `'burst'` keeps the backend (and the saved LLM state):
   * the reload is deferred until the backend is released for a qualifying reason
   * (idle timeout, explicit release, crash, cancel, or `stop()`).
   *
   * The `'single'` reload is skipped when one is already in flight: a cancelled or
   * crashed generation already released the backend for a qualifying reason, and
   * {@link onDiffusionBackendReleased} started the reload from there.
   *
   * @param config - The generation's configuration (its `usageMode` is the request hint)
   * @private
   */
  private async settleAfterOffload(config: ImageGenerationConfig): Promise<void> {
    const mode = this.diffusionServer.resolveUsageMode(config.usageMode, true);
    debugLog('[Orchestrator] Settling residency after offload:', mode);

    await this.settleResidency(mode);

    if (mode === 'single' && !this.pendingReload) {
      debugLog('[Orchestrator] Backend released, reloading LLM in background...');
      this.fireAndForgetReload();
    } else if (mode === 'single') {
      debugLog('[Orchestrator] Backend released - a reload is already in flight');
    } else {
      debugLog('[Orchestrator] Backend stays warm - LLM reload deferred until it is released');
    }
  }

  /**
   * Ask the diffusion manager to apply a residency decision
   *
   * Never throws: a backend that refuses to die must not keep the LLM offloaded.
   *
   * @param mode - Residency policy to apply
   * @private
   */
  private async settleResidency(mode: DiffusionUsageMode): Promise<void> {
    try {
      await this.diffusionServer.settleResidency(mode);
    } catch (error) {
      console.warn('[Orchestrator] ⚠️ Failed to settle diffusion residency:', error);
    }
  }

  /**
   * React to the diffusion backend becoming absent
   *
   * Called by DiffusionServerManager after every confirmed release (with the final,
   * rank-upgraded reason). Brings a deferred LLM back when — and only when — the
   * release means "the VRAM is free again and nobody else is about to use it":
   * see {@link ResourceOrchestrator.RELOAD_RELEASE_REASONS}.
   *
   * @param reason - Why the backend was released
   * @internal
   */
  onDiffusionBackendReleased(reason: DiffusionBackendReleaseReason): void {
    if (!ResourceOrchestrator.RELOAD_RELEASE_REASONS.has(reason)) {
      debugLog('[Orchestrator] Backend released - no reload for reason:', reason);
      return;
    }
    if (this.llamaServer.isRunning()) {
      // The host (or the pre-start hook's own caller) already brought the LLM back;
      // the saved state describes a server that exists again. Starting it a second
      // time would throw, and keeping the state would make a later release restart
      // a configuration the host has since replaced.
      debugLog('[Orchestrator] Backend released - LLM already running, dropping saved state');
      this.savedLLMState = undefined;
      return;
    }
    if (!this.savedLLMState) {
      debugLog('[Orchestrator] Backend released - no saved LLM state to restore');
      return;
    }
    if (this.pendingReload) {
      debugLog('[Orchestrator] Backend released - a reload is already in flight');
      return;
    }
    if (this.diffusionServer.isCalibrating()) {
      // A sweep releases its backend between combos and restores the LLM itself
      debugLog('[Orchestrator] Backend released - suppressed while calibrating');
      return;
    }

    debugLog('[Orchestrator] Backend released - reloading deferred LLM:', reason);
    this.fireAndForgetReload();
  }

  /**
   * Free VRAM for an LLM that is about to start
   *
   * Registered as a `LlamaServerManager` pre-start hook, making the orchestrator
   * symmetric: an image request may offload the LLM, and an LLM start may release a
   * resident stable-diffusion.cpp backend. No-op unless a backend is actually resident
   * and the two would not fit together (same 75 % arithmetic as the image path, but
   * estimating the LLM from the configuration it is about to start with).
   *
   * The hook sees the RAW configuration, before `start()` auto-configures it, so an
   * omitted `gpuLayers` is resolved the way auto-configuration will resolve it — see
   * {@link estimateAutoGpuLayers}. An explicit `gpuLayers: 0` is honoured as "CPU-only
   * LLM" and yields nothing.
   *
   * The release carries reason `'llm-start'`, which never triggers a reload — the LLM
   * start that caused it is already under way.
   *
   * @param ctx - The start context handed to the hook
   * @throws {ServerError} `details.code` `'CALIBRATION_IN_PROGRESS'` when an offload
   *   calibration sweep is running: the sweep owns the backend (and restores the LLM
   *   itself when it is done), so a manual start must fail loudly instead of racing it.
   *   The auto-restart path logs and ignores hook errors by design.
   * @internal
   */
  async prepareForLLMStart(ctx: { config: LlamaServerConfig }): Promise<void> {
    if (this.diffusionServer.isCalibrating()) {
      throw new ServerError('Cannot start the LLM while diffusion calibration is running', {
        code: 'CALIBRATION_IN_PROGRESS',
        suggestion:
          'Wait for calibrate() to finish (it restores the LLM itself), or abort it via its AbortSignal',
      });
    }

    const backendState = this.diffusionServer.getBackendInfo().state;
    if (!ResourceOrchestrator.RESIDENT_BACKEND_STATES.has(backendState)) {
      debugLog('[Orchestrator] LLM start - no resident diffusion backend:', backendState);
      return;
    }

    const needsRelease = await this.needsOffloadForImage(ctx.config);
    if (!needsRelease) {
      debugLog('[Orchestrator] LLM start - both fit, keeping the diffusion backend resident');
      return;
    }

    debugLog('[Orchestrator] ⚠️  LLM start - releasing the diffusion backend to make room');
    await this.diffusionServer.releaseBackend({ reason: 'llm-start', waitForInFlight: true });
  }

  /**
   * Check if we need to offload LLM for image generation
   *
   * Determines the bottleneck resource (RAM or VRAM) and checks if
   * there's enough space for both servers to run simultaneously.
   *
   * Uses 75% threshold to leave headroom for OS and other processes.
   *
   * @param llmConfigOverride - Estimate the LLM from this configuration instead of the
   *   running server's (used by {@link prepareForLLMStart}, where the LLM is not up yet)
   * @returns True if offload is needed
   * @private
   */
  private async needsOffloadForImage(llmConfigOverride?: LlamaServerConfig): Promise<boolean> {
    debugLog('[Orchestrator] Checking if offload needed...');

    const memory = this.systemInfo.getMemoryInfo();
    const capabilities = await this.systemInfo.detect();

    // Estimate resource usage
    const llamaUsage = await this.estimateLLMUsage(llmConfigOverride);
    const diffusionUsage = await this.estimateDiffusionUsage();

    // Determine bottleneck resource
    const isGPUSystem = capabilities.gpu.available && capabilities.gpu.vram;

    debugLog('[Orchestrator] System type:', isGPUSystem ? 'GPU' : 'CPU-only');

    if (isGPUSystem) {
      // VRAM is the bottleneck
      const totalVRAM = capabilities.gpu.vram || 0;
      const vramNeeded = (llamaUsage.vram || 0) + (diffusionUsage.vram || 0);
      const threshold = totalVRAM * 0.75;

      debugLog('[Orchestrator] VRAM Analysis:');
      debugLog('  - LLM VRAM usage:', (llamaUsage.vram || 0) / 1024 ** 3, 'GB');
      debugLog('  - Diffusion VRAM usage:', (diffusionUsage.vram || 0) / 1024 ** 3, 'GB');
      debugLog('  - Total VRAM needed:', vramNeeded / 1024 ** 3, 'GB');
      debugLog('  - Total VRAM available:', totalVRAM / 1024 ** 3, 'GB');
      debugLog('  - Threshold (75%):', threshold / 1024 ** 3, 'GB');
      debugLog('  - Offload needed:', vramNeeded > threshold);

      // Need offload if combined VRAM usage > 75% of total
      return vramNeeded > threshold;
    } else {
      // RAM is the bottleneck
      const ramNeeded = llamaUsage.ram + diffusionUsage.ram;
      const threshold = memory.available * 0.75;

      debugLog('[Orchestrator] RAM Analysis:');
      debugLog('  - LLM RAM usage:', llamaUsage.ram / 1024 ** 3, 'GB');
      debugLog('  - Diffusion RAM usage:', diffusionUsage.ram / 1024 ** 3, 'GB');
      debugLog('  - Total RAM needed:', ramNeeded / 1024 ** 3, 'GB');
      debugLog('  - Available RAM:', memory.available / 1024 ** 3, 'GB');
      debugLog('  - Threshold (75%):', threshold / 1024 ** 3, 'GB');
      debugLog('  - Offload needed:', ramNeeded > threshold);

      // Need offload if combined RAM usage > 75% of available
      return ramNeeded > threshold;
    }
  }

  /**
   * Estimate LLM resource usage
   *
   * Calculates RAM and VRAM usage based on model size and GPU layer configuration.
   *
   * Formula:
   * - RAM = model_size * (1 - gpu_ratio) * 1.2
   * - VRAM = model_size * gpu_ratio * 1.2
   * where gpu_ratio = gpu_layers / estimated_total_layers
   *
   * @param configOverride - Estimate this configuration instead of the running
   *   server's. With an override the "is it running?" short-circuit is skipped
   *   entirely: the caller is asking what the LLM WOULD cost, which is exactly the
   *   question a pre-start hook has to answer, and an omitted `gpuLayers` is resolved
   *   the way `start()` will resolve it (see {@link estimateAutoGpuLayers}).
   * @returns Resource requirements
   * @private
   */
  private async estimateLLMUsage(
    configOverride?: LlamaServerConfig
  ): Promise<ResourceRequirements> {
    let config: ServerConfig | undefined = configOverride;

    if (!config) {
      if (!this.llamaServer.isRunning()) {
        debugLog('[Orchestrator] LLM not running - usage: 0');
        return { ram: 0, vram: 0 };
      }

      config = this.llamaServer.getConfig();
    }

    if (!config) {
      debugLog('[Orchestrator] LLM config not found - usage: 0');
      return { ram: 0, vram: 0 };
    }

    try {
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);

      // Get actual layer count from GGUF metadata (or fallback to estimation)
      const totalLayers = await this.modelManager.getModelLayerCount(config.modelId);

      // A RAW start configuration usually has no gpuLayers yet — start() fills it in
      // from SystemInfo. Taking it at face value would price the LLM at zero VRAM.
      const gpuLayers =
        configOverride !== undefined && configOverride.gpuLayers === undefined
          ? await this.estimateAutoGpuLayers(modelInfo, configOverride, totalLayers)
          : config.gpuLayers || 0;

      // Real KV-cache cost for the configured context (0 without metadata,
      // matching the legacy weights-only estimate)
      const llamaConfig = config as LlamaServerConfig;
      const kvBytes = modelInfo.ggufMetadata?.block_count
        ? (llamaConfig.contextSize ?? 4096) *
          estimateKVBytesPerToken(modelInfo, llamaConfig.cacheTypeK, llamaConfig.cacheTypeV)
        : 0;

      // Under --cpu-moe (or -ot exps=CPU) the expert weights live in RAM, not
      // VRAM; --n-cpu-moe N moves a proportional share of the experts
      const expertBytes = getExpertWeightsBytesWithFallback(modelInfo) ?? 0;
      let cpuExpertBytes = 0;
      if (llamaConfig.cpuMoe === true || llamaConfig.overrideTensors === 'exps=CPU') {
        cpuExpertBytes = expertBytes;
      } else if (typeof llamaConfig.nCpuMoe === 'number' && llamaConfig.nCpuMoe > 0) {
        cpuExpertBytes = expertBytes * Math.min(1, llamaConfig.nCpuMoe / totalLayers);
      }
      const gpuResidentWeights = modelInfo.size - cpuExpertBytes;

      debugLog('[Orchestrator] LLM model:', config.modelId);
      debugLog('[Orchestrator] LLM model size:', modelInfo.size / 1024 ** 3, 'GB');
      debugLog('[Orchestrator] LLM GPU layers:', gpuLayers, '/', totalLayers);
      debugLog('[Orchestrator] LLM KV cache:', kvBytes / 1024 ** 3, 'GB');

      if (gpuLayers > 0) {
        // Mixed GPU/CPU: KV follows the layer split; CPU-resident experts
        // always count against RAM
        const gpuRatio = Math.min(gpuLayers / totalLayers, 1.0);
        const result = {
          ram: (gpuResidentWeights * 1.2 + kvBytes) * (1 - gpuRatio) + cpuExpertBytes * 1.2,
          vram: (gpuResidentWeights * 1.2 + kvBytes) * gpuRatio,
        };
        debugLog('[Orchestrator] LLM usage (mixed):', {
          ram: `${result.ram / 1024 ** 3} GB`,
          vram: `${result.vram / 1024 ** 3} GB`,
        });
        return result;
      } else {
        // CPU only
        const result = {
          ram: modelInfo.size * 1.2 + kvBytes,
          vram: 0,
        };
        debugLog('[Orchestrator] LLM usage (CPU-only):', {
          ram: `${result.ram / 1024 ** 3} GB`,
          vram: '0 GB',
        });
        return result;
      }
    } catch (error) {
      // If we can't get model info, return conservative estimate
      debugLog('[Orchestrator] Failed to get LLM model info:', error);
      return { ram: 0, vram: 0 };
    }
  }

  /**
   * GPU layers an LLM start would actually end up using
   *
   * `prepareForLLMStart()` is handed the RAW configuration the caller passed to
   * `start()`, where `gpuLayers` is normally absent — `LlamaServerManager` resolves it
   * from `SystemInfo.getOptimalConfig()` later, inside `start()` itself. Reading the raw
   * value would score the LLM at 0 VRAM, the two would always "fit", and the hook would
   * never yield the diffusion backend.
   *
   * Mirrors the auto-configuration by asking the same source, with the same hints. When
   * that is unavailable, falls back to "everything on the GPU" whenever a GPU with VRAM
   * is detected — the conservative answer for a fit question.
   *
   * @param modelInfo - The LLM model that is about to start
   * @param config - The raw start configuration (its `gpuLayers` is undefined)
   * @param totalLayers - Layer count of the model
   * @returns Layers that would be placed on the GPU
   * @private
   */
  private async estimateAutoGpuLayers(
    modelInfo: ModelInfo,
    config: LlamaServerConfig,
    totalLayers: number
  ): Promise<number> {
    try {
      // Same hint shape LlamaServerManager.autoConfigureIfNeeded() passes: the exact
      // context size wins, otherwise the context POLICY fields do (mutually exclusive).
      const usePolicyForSizing = config.contextSize === undefined;
      const optimal = await this.systemInfo.getOptimalConfig(modelInfo, {
        contextSize: config.contextSize,
        minimumContextSize: usePolicyForSizing ? config.minimumContextSize : undefined,
        preferredContextSize: usePolicyForSizing ? config.preferredContextSize : undefined,
        maximumContextSize: usePolicyForSizing ? config.maximumContextSize : undefined,
        parallelRequests: config.parallelRequests,
        flashAttention: config.flashAttention,
        cacheTypeK: config.cacheTypeK,
        cacheTypeV: config.cacheTypeV,
        cpuMoe: config.cpuMoe,
        nCpuMoe: config.nCpuMoe,
        overrideTensors: config.overrideTensors,
      });
      if (typeof optimal.gpuLayers === 'number' && Number.isFinite(optimal.gpuLayers)) {
        debugLog(
          '[Orchestrator] LLM start - auto gpuLayers from optimal config:',
          optimal.gpuLayers
        );
        return optimal.gpuLayers;
      }
    } catch (error) {
      debugLog('[Orchestrator] LLM start - optimal config unavailable:', error);
    }

    try {
      const capabilities = await this.systemInfo.detect();
      const onGpu = capabilities.gpu.available && !!capabilities.gpu.vram;
      debugLog('[Orchestrator] LLM start - assuming', onGpu ? 'a full' : 'no', 'GPU offload');
      return onGpu ? totalLayers : 0;
    } catch (error) {
      debugLog('[Orchestrator] LLM start - GPU detection failed:', error);
      return 0;
    }
  }

  /**
   * Estimate diffusion resource usage
   *
   * Calculates RAM and VRAM usage based on model size.
   * Diffusion models typically need similar VRAM/RAM as their size.
   *
   * Formula: RAM/VRAM = model_size * 1.2
   *
   * @returns Resource requirements
   * @private
   */
  private async estimateDiffusionUsage(): Promise<ResourceRequirements> {
    const config = this.diffusionServer.getConfig();
    if (!config) {
      // Default estimate for typical SDXL model (6-7GB)
      const defaultSize = 6.5 * 1024 * 1024 * 1024; // 6.5GB in bytes
      debugLog('[Orchestrator] Diffusion config not found - using default estimate: 6.5GB');
      return { ram: defaultSize * 1.2, vram: defaultSize * 1.2 };
    }

    try {
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      debugLog('[Orchestrator] Diffusion model:', config.modelId);
      debugLog('[Orchestrator] Diffusion model size:', modelInfo.size / 1024 ** 3, 'GB');

      // Diffusion models typically need similar VRAM/RAM as their size
      const usage = modelInfo.size * 1.2;
      const result = {
        ram: usage,
        vram: usage,
      };
      debugLog('[Orchestrator] Diffusion usage:', usage / 1024 ** 3, 'GB (both RAM and VRAM)');
      return result;
    } catch (error) {
      // If we can't get model info, return conservative estimate
      debugLog('[Orchestrator] Failed to get diffusion model info:', error);
      const defaultSize = 6.5 * 1024 * 1024 * 1024;
      debugLog('[Orchestrator] Using default estimate: 6.5GB');
      return { ram: defaultSize * 1.2, vram: defaultSize * 1.2 };
    }
  }

  /**
   * Offload the LLM (save state and stop)
   *
   * Saves the current LLM configuration and stops the server to free resources.
   * Used internally by orchestrateImageGeneration() and by
   * DiffusionServerManager.calibrate() for sweep-level offload.
   *
   * No-ops when the LLM server is not running.
   *
   * @throws {ServerError} If the LLM is running but its configuration cannot be retrieved
   *
   * @example
   * ```typescript
   * await orchestrator.offloadLLM();
   * // ... run VRAM-heavy work ...
   * await orchestrator.reloadLLM();
   * ```
   */
  async offloadLLM(): Promise<void> {
    debugLog('[Orchestrator] offloadLLM called');

    if (!this.llamaServer.isRunning()) {
      debugLog('[Orchestrator] LLM not running - nothing to offload');
      return;
    }

    // Save current state
    const config = this.llamaServer.getConfig();
    if (!config) {
      throw new ServerError('Cannot offload LLM: no configuration found');
    }

    debugLog('[Orchestrator] Saving LLM state:', {
      modelId: config.modelId,
      port: config.port,
      gpuLayers: config.gpuLayers,
    });

    this.savedLLMState = {
      config,
      wasRunning: true,
      savedAt: new Date(),
    };

    // Stop LLM server gracefully
    debugLog('[Orchestrator] Stopping LLM server...');
    await this.llamaServer.stop();
    debugLog('[Orchestrator] ✅ LLM server stopped successfully');
  }

  /**
   * Reload the LLM (restore from saved state)
   *
   * Restarts the LLM server with the previously saved configuration, retrying
   * once after a short delay. No-ops when there is no saved state.
   *
   * Never throws — errors are logged and the saved state is kept so the
   * caller (or user) can retry manually.
   */
  async reloadLLM(): Promise<void> {
    debugLog('[Orchestrator] reloadLLM called');

    if (!this.savedLLMState || !this.savedLLMState.wasRunning) {
      debugLog('[Orchestrator] No saved LLM state - nothing to reload');
      return;
    }

    const savedConfig = this.savedLLMState.config;

    // First attempt
    try {
      debugLog('[Orchestrator] Restarting LLM with saved config:', {
        modelId: savedConfig.modelId,
        port: savedConfig.port,
      });
      await this.llamaServer.start(savedConfig);
      debugLog('[Orchestrator] ✅ LLM server restarted successfully');
      this.savedLLMState = undefined;
      return;
    } catch (firstError) {
      console.warn('[Orchestrator] ⚠️ First reload attempt failed:', firstError);
    }

    // Retry after delay (allows OS memory reclamation)
    try {
      debugLog(
        `[Orchestrator] Retrying reload after ${ResourceOrchestrator.RELOAD_RETRY_DELAY_MS}ms...`
      );
      await this.delay(ResourceOrchestrator.RELOAD_RETRY_DELAY_MS);
      this.systemInfo.clearCache();
      await this.llamaServer.start(savedConfig);
      debugLog('[Orchestrator] ✅ LLM server restarted on retry');
      this.savedLLMState = undefined;
    } catch (retryError) {
      // Log error but don't throw - image generation succeeded
      console.error('[Orchestrator] ❌ Failed to reload LLM after retry:', retryError);
      // Keep saved state in case user wants to manually restart
    }
  }

  /**
   * Start LLM reload in the background (fire-and-forget)
   *
   * Stores the reload promise so concurrent orchestration calls
   * can await it before starting a new offload cycle, and clears that slot again once
   * this cycle settles — otherwise a completed reload would keep every later
   * qualifying release from starting a new one.
   *
   * The single trigger for an LLM reload: every caller checks `pendingReload` first,
   * which is what makes "exactly one reload per offload cycle" true even when a cancel
   * or a crash releases the backend before the orchestration branch settles.
   *
   * @private
   */
  private fireAndForgetReload(): void {
    const reload = this.reloadLLM();
    this.pendingReload = reload;
    // Safety net: prevent unhandled rejection warnings.
    // reloadLLM() handles all errors internally, but Node.js
    // may still flag the detached promise.
    void reload
      .catch(() => undefined)
      .finally(() => {
        // Identity check: a newer cycle may already own the slot
        if (this.pendingReload === reload) this.pendingReload = null;
      });
  }

  /**
   * Delay helper for retry logic
   * @private
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clear saved LLM state
   *
   * Useful for cleanup or when you want to prevent automatic reload.
   *
   * @example
   * ```typescript
   * orchestrator.clearSavedState();
   * ```
   */
  clearSavedState(): void {
    this.savedLLMState = undefined;
  }

  /**
   * Get saved LLM state
   *
   * Returns the currently saved LLM configuration if any.
   * Useful for debugging or displaying state to user.
   *
   * @returns Saved state or undefined if none
   *
   * @example
   * ```typescript
   * const saved = orchestrator.getSavedState();
   * if (saved) {
   *   console.log('LLM was offloaded at:', saved.savedAt);
   * }
   * ```
   */
  getSavedState(): SavedLLMState | undefined {
    return this.savedLLMState;
  }

  /**
   * Wait for any pending LLM reload to complete
   *
   * After `orchestrateImageGeneration()` returns, the LLM reload runs
   * asynchronously in the background. Call this method if you need to
   * ensure the LLM is fully restored before proceeding.
   *
   * Resolves immediately if no reload is in progress.
   *
   * **Residency caveat**: under `'burst'` after an offload the LLM is intentionally
   * still down when this resolves — no reload has been started yet. The deferred
   * reload fires when the diffusion backend is released (idle timeout, an explicit
   * `releaseBackend()`, a backend crash, a cancelled generation, or
   * `diffusionServer.stop()`), so a caller that needs the LLM back right away should
   * release the backend first.
   *
   * @example
   * ```typescript
   * const result = await orchestrator.orchestrateImageGeneration(config);
   * // Image is ready, but LLM may still be reloading
   * await orchestrator.waitForReload();
   * // LLM is now fully reloaded (or reload has failed)
   * ```
   */
  async waitForReload(): Promise<void> {
    const inFlightReload = this.pendingReload;
    if (inFlightReload) {
      await inFlightReload;
      if (this.pendingReload === inFlightReload) this.pendingReload = null;
    }
  }

  /**
   * Check if LLM offload would be needed for image generation
   *
   * Public wrapper around needsOffloadForImage for diagnostic purposes.
   *
   * @returns True if offload would be needed
   *
   * @example
   * ```typescript
   * const needsOffload = await orchestrator.wouldNeedOffload();
   * if (needsOffload) {
   *   console.warn('Image generation will temporarily stop LLM server');
   * }
   * ```
   */
  async wouldNeedOffload(): Promise<boolean> {
    return await this.needsOffloadForImage();
  }
}
