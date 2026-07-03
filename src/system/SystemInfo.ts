/**
 * System information and capability detection
 * @module system/SystemInfo
 */

import type {
  SystemCapabilities,
  SystemRecommendations,
  ModelInfo,
  LlamaServerConfig,
  KVCacheType,
  OptimalConfigHints,
} from '../types/index.js';
import { getCPUInfo, getRecommendedThreads } from './cpu-detect.js';
import { getMemoryInfo, estimateVRAM } from './memory-detect.js';
import { detectGPU, calculateGPULayers } from './gpu-detect.js';
import { getPlatform } from '../utils/platform-utils.js';
import { RECOMMENDED_QUANTIZATIONS, KV_SIZING } from '../config/defaults.js';
import {
  getLayerCountWithFallback,
  getContextLengthWithFallback,
  hasGGUFMetadata,
} from '../utils/model-metadata-helpers.js';
import { estimateKVBytesPerToken, floorContextToGranularity } from '../utils/kv-cache-math.js';

/**
 * System information singleton
 * Detects hardware capabilities and provides intelligent recommendations
 *
 * @example
 * ```typescript
 * const systemInfo = SystemInfo.getInstance();
 * const capabilities = await systemInfo.detect();
 * console.log(capabilities);
 * ```
 */
export class SystemInfo {
  private static instance: SystemInfo;
  private cachedCapabilities: SystemCapabilities | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL = 60000; // 60 seconds

  /**
   * Private constructor for singleton pattern
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): SystemInfo {
    if (!SystemInfo.instance) {
      SystemInfo.instance = new SystemInfo();
    }
    return SystemInfo.instance;
  }

  /**
   * Detect system capabilities
   * Results are cached for 60 seconds
   *
   * @param forceRefresh - Force refresh cache
   * @returns System capabilities
   *
   * @example
   * ```typescript
   * const capabilities = await systemInfo.detect();
   * console.log(`CPU: ${capabilities.cpu.cores} cores`);
   * console.log(`RAM: ${capabilities.memory.total / (1024 ** 3)} GB`);
   * ```
   */
  public async detect(forceRefresh = false): Promise<SystemCapabilities> {
    // Return cached result if still valid
    const now = Date.now();
    if (!forceRefresh && this.cachedCapabilities && now - this.cacheTimestamp < this.CACHE_TTL) {
      return this.cachedCapabilities;
    }

    // Detect hardware
    const cpu = getCPUInfo();
    const memory = getMemoryInfo();
    const gpu = await detectGPU();

    // Estimate VRAM if GPU is available
    if (gpu.available && !gpu.vram) {
      gpu.vram = (await estimateVRAM(gpu)) ?? undefined;
    }

    // Generate recommendations
    const recommendations = this.generateRecommendations(cpu.cores, memory.total, gpu);

    const capabilities: SystemCapabilities = {
      cpu,
      memory,
      gpu,
      platform: getPlatform(),
      recommendations,
      detectedAt: new Date().toISOString(),
    };

    // Update cache
    this.cachedCapabilities = capabilities;
    this.cacheTimestamp = now;

    return capabilities;
  }

  /**
   * Get real-time memory information (not cached)
   *
   * @returns Current memory information
   *
   * @example
   * ```typescript
   * const memory = systemInfo.getMemoryInfo();
   * console.log(`Available RAM: ${memory.available / (1024 ** 3)} GB`);
   * ```
   */
  public getMemoryInfo() {
    return getMemoryInfo();
  }

  /**
   * Get real-time GPU information (not cached)
   *
   * Useful for monitoring VRAM usage during active workloads like image generation.
   * Unlike detect(), this method always queries the system for current GPU state,
   * ensuring fresh VRAM availability data.
   *
   * @returns Current GPU information
   *
   * @example
   * ```typescript
   * const gpu = await systemInfo.getGPUInfo();
   * if (gpu.available && gpu.vramAvailable !== undefined) {
   *   console.log(`Available VRAM: ${gpu.vramAvailable / (1024 ** 3)} GB`);
   * }
   * ```
   */
  public async getGPUInfo() {
    const gpu = await detectGPU();

    // Estimate VRAM if GPU is available but VRAM is not detected
    if (gpu.available && !gpu.vram) {
      gpu.vram = (await estimateVRAM(gpu)) ?? undefined;
    }

    return gpu;
  }

  /**
   * Check if system can run a specific model
   *
   * @param modelInfo - Model information
   * @param options - Optional configuration
   * @param options.checkTotalMemory - If true, checks against total system memory instead of currently available memory.
   *                                    Use this for servers that load models on-demand (e.g., diffusion server).
   *                                    Default: false (checks available memory)
   * @returns True if model can run, with reason if false
   *
   * @example
   * ```typescript
   * // Check if model fits in available memory (default - for servers that load model at startup)
   * const canRun = await systemInfo.canRunModel(modelInfo);
   * if (!canRun.possible) {
   *   console.log(`Cannot run model: ${canRun.reason}`);
   * }
   *
   * // Check if model will ever fit in total memory (for servers that load model on-demand)
   * const canRunEventually = await systemInfo.canRunModel(modelInfo, { checkTotalMemory: true });
   * ```
   */
  public async canRunModel(
    modelInfo: ModelInfo,
    options?: {
      checkTotalMemory?: boolean;
      gpuLayers?: number;
      totalLayers?: number;
    }
  ): Promise<{
    possible: boolean;
    reason?: string;
    suggestion?: string;
  }> {
    const capabilities = await this.detect();

    // Floor-context KV cost (real arithmetic when GGUF metadata is present;
    // models without metadata keep the legacy weights-only estimate)
    const kvFloorBytes =
      hasGGUFMetadata(modelInfo) && modelInfo.ggufMetadata?.block_count
        ? KV_SIZING.floorContextTokens * estimateKVBytesPerToken(modelInfo)
        : 0;

    // When GPU layers are specified, only the CPU portion (weights + its KV
    // share) needs to fit in RAM
    const gpuLayers = options?.gpuLayers;
    let requiredMemory: number;
    if (gpuLayers && gpuLayers > 0) {
      const totalLayers = options?.totalLayers ?? getLayerCountWithFallback(modelInfo);
      const cpuRatio = Math.max(0, 1 - gpuLayers / totalLayers);
      requiredMemory = (modelInfo.size * 1.2 + kvFloorBytes) * cpuRatio;
    } else {
      requiredMemory = modelInfo.size * 1.2 + kvFloorBytes; // 20% overhead + KV floor
    }

    // Get fresh memory info (not cached) for accurate availability check
    const currentMemory = this.getMemoryInfo();

    // Determine which memory metric to check against
    const checkTotalMemory = options?.checkTotalMemory ?? false;
    const memoryToCheck = checkTotalMemory ? currentMemory.total : currentMemory.available;
    const memoryType = checkTotalMemory ? 'total' : 'available';

    // Check if model fits in RAM using real-time memory data
    const fitsInRAM = memoryToCheck >= requiredMemory;

    if (!fitsInRAM) {
      return {
        possible: false,
        reason: `Insufficient RAM: model requires ${(requiredMemory / 1024 ** 3).toFixed(1)}GB, but only ${(memoryToCheck / 1024 ** 3).toFixed(1)}GB ${memoryType}`,
        suggestion: checkTotalMemory
          ? 'This model is too large for your system. Try a smaller model or quantization.'
          : 'Try closing other applications or using a smaller quantization (Q4_K_M instead of Q8_0)',
      };
    }

    // Check if GPU is needed but not available (for very large models)
    if (modelInfo.size > 8 * 1024 ** 3 && !capabilities.gpu.available) {
      return {
        possible: true,
        reason: 'Model will run on CPU only, which may be slow for this size',
        suggestion: 'Consider using a GPU for better performance with large models',
      };
    }

    return { possible: true };
  }

  /**
   * Get optimal configuration for a model
   *
   * @param modelInfo - Model information
   * @returns Recommended server configuration
   *
   * @example
   * ```typescript
   * const config = await systemInfo.getOptimalConfig(modelInfo);
   * console.log(`Use ${config.threads} threads and ${config.gpuLayers} GPU layers`);
   * ```
   */
  public async getOptimalConfig(
    modelInfo: ModelInfo,
    hints: OptimalConfigHints = {}
  ): Promise<Partial<LlamaServerConfig>> {
    const capabilities = await this.detect();

    // Get fresh memory info (not cached) for accurate sizing
    const currentMemory = this.getMemoryInfo();

    const config: Partial<LlamaServerConfig> = {
      threads: getRecommendedThreads(capabilities.cpu.cores),
      parallelRequests: hints.parallelRequests ?? this.recommendParallelRequests(),
    };

    const modelCtx = getContextLengthWithFallback(modelInfo);
    const totalLayers = getLayerCountWithFallback(modelInfo);
    const gpu = capabilities.gpu;
    const hasVRAM = gpu.available && !!gpu.vram;

    // Legacy path when GGUF metadata is missing: previous behavior exactly
    // (fixed 4096 context, flat-reserve layer packing, no cache recommendation)
    if (!hasGGUFMetadata(modelInfo) || !modelInfo.ggufMetadata?.block_count) {
      config.contextSize = hints.contextSize ?? Math.min(modelCtx, KV_SIZING.floorContextTokens);
      config.gpuLayers =
        hints.gpuLayers ??
        (hasVRAM ? calculateGPULayers(totalLayers, gpu.vram!, modelInfo.size) : 0);
      return config;
    }

    // --- KV-aware sizing ---
    const floor = KV_SIZING.floorContextTokens;
    const clampCtx = (tokens: number): number => {
      // Progressive granularity: fine steps at small contexts, multiples of
      // 4096 at large ones (see CONTEXT_GRANULARITY_LADDER)
      const rounded = floorContextToGranularity(tokens);
      return Math.max(floor, Math.min(modelCtx, rounded));
    };

    const weightsGPU = modelInfo.size * KV_SIZING.gpuWeightsOverhead;
    const vramBudget = hasVRAM
      ? Math.max(0, (gpu.vramAvailable ?? gpu.vram!) - KV_SIZING.computeBufferBytes)
      : 0;
    const cpuContext = (bytesPerToken: number): number =>
      clampCtx(
        (currentMemory.available -
          modelInfo.size * KV_SIZING.cpuWeightsOverhead -
          KV_SIZING.osRamMarginBytes) /
          bytesPerToken
      );

    // 1. Choose KV cache types. Default policy: q8_0 (small quality loss,
    // ~2x cheaper KV) unless f16 KV at the model's FULL native context fits
    // alongside fully-offloaded weights ("abundant headroom"). Explicit user
    // cache types always win; explicit flashAttention off suppresses
    // quantization (quantized V requires flash attention); CPU-only stays f16.
    const userPinnedCacheType = hints.cacheTypeK !== undefined || hints.cacheTypeV !== undefined;
    const flashAttentionOff = hints.flashAttention === 'off' || hints.flashAttention === false;
    let cacheTypeK: KVCacheType = hints.cacheTypeK ?? 'f16';
    let cacheTypeV: KVCacheType = hints.cacheTypeV ?? 'f16';
    let autoQuantized = false;

    if (!userPinnedCacheType && !flashAttentionOff && hasVRAM && vramBudget > 0) {
      const bptF16 = estimateKVBytesPerToken(modelInfo, 'f16', 'f16');
      const abundantHeadroom = weightsGPU + modelCtx * bptF16 <= vramBudget;
      if (!abundantHeadroom) {
        cacheTypeK = 'q8_0';
        cacheTypeV = 'q8_0';
        autoQuantized = true;
      }
    }

    const bpt = estimateKVBytesPerToken(modelInfo, cacheTypeK, cacheTypeV);

    // 2. Offload + context. Full GPU offload is the prize: the KV reserve
    // flexes down to the floor-context cost to win it; when full offload is
    // impossible, fall back to packing layers around a KV reserve.
    let gpuLayers: number;
    let contextTokens: number;

    if (hasVRAM && vramBudget > 0) {
      const pinnedCtx = hints.contextSize;
      const requiredKV = (pinnedCtx ?? floor) * bpt;
      const fullOffloadFits = weightsGPU + requiredKV <= vramBudget;

      if (hints.gpuLayers !== undefined ? hints.gpuLayers >= totalLayers : fullOffloadFits) {
        // Full offload: all leftover VRAM becomes context budget
        gpuLayers = hints.gpuLayers ?? totalLayers;
        contextTokens = pinnedCtx ?? clampCtx((vramBudget - weightsGPU) / bpt);
      } else {
        // Partial offload: reserve KV (at least the floor's worth), pack layers
        const reserve = Math.max(requiredKV, KV_SIZING.minPartialReserveBytes);
        const perLayer = weightsGPU / totalLayers;
        gpuLayers =
          hints.gpuLayers ??
          Math.min(totalLayers, Math.max(0, Math.floor((vramBudget - reserve) / perLayer)));

        if (gpuLayers <= 0) {
          gpuLayers = 0;
          contextTokens = pinnedCtx ?? cpuContext(bpt);
        } else {
          // Context bounded by BOTH the GPU-side KV share and the RAM-side share
          const gpuShare = gpuLayers / totalLayers;
          const cpuShare = 1 - gpuShare;
          const gpuKVBudget = Math.max(0, vramBudget - gpuLayers * perLayer);
          const ramKVBudget = Math.max(
            0,
            currentMemory.available -
              modelInfo.size * cpuShare * KV_SIZING.cpuWeightsOverhead -
              KV_SIZING.osRamMarginBytes
          );
          const byGPU = gpuShare > 0 ? gpuKVBudget / (bpt * gpuShare) : Infinity;
          const byRAM = cpuShare > 0 ? ramKVBudget / (bpt * cpuShare) : Infinity;
          contextTokens = pinnedCtx ?? clampCtx(Math.min(byGPU, byRAM));
        }
      }
    } else {
      gpuLayers = hints.gpuLayers ?? 0;
      contextTokens = hints.contextSize ?? cpuContext(bpt);
    }

    config.contextSize = contextTokens;
    config.gpuLayers = gpuLayers;
    if (autoQuantized) {
      config.cacheTypeK = cacheTypeK;
      config.cacheTypeV = cacheTypeV;
      // Quantized V-cache requires flash attention; make the recommendation
      // self-consistent (LlamaServerManager enforces the same constraint)
      config.flashAttention = 'on';
    }

    return config;
  }

  /**
   * Generate system recommendations
   */
  private generateRecommendations(
    cpuCores: number,
    totalRAM: number,
    gpu: SystemCapabilities['gpu']
  ): SystemRecommendations {
    const ramGB = totalRAM / 1024 ** 3;
    const vramGB = gpu.vram ? gpu.vram / 1024 ** 3 : 0;

    // Determine max model size based on available resources
    let maxModelSize: string;
    let recommendedQuantization: readonly string[];

    if (gpu.available && vramGB >= 24) {
      maxModelSize = '70B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.balanced;
    } else if (gpu.available && vramGB >= 16) {
      maxModelSize = '34B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.balanced;
    } else if (ramGB >= 32) {
      maxModelSize = '34B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.compact;
    } else if (ramGB >= 16) {
      maxModelSize = '13B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.balanced;
    } else if (ramGB >= 8) {
      maxModelSize = '7B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.balanced;
    } else {
      maxModelSize = '7B';
      recommendedQuantization = RECOMMENDED_QUANTIZATIONS.compact;
    }

    return {
      maxModelSize,
      recommendedQuantization,
      threads: getRecommendedThreads(cpuCores),
      gpuLayers: gpu.available ? undefined : 0,
      gpuAcceleration: gpu.available,
    };
  }

  /**
   * Recommend parallel request slots
   *
   * Returns 1 for single-user Electron apps. The KV cache is shared across all parallel
   * slots, so with N slots, each slot gets approximately contextSize/N tokens. For single-user
   * interactive use (chat, writing assistance, etc.), parallel requests waste context capacity.
   *
   * Multi-user server deployments should explicitly set parallelRequests based on expected
   * concurrent load rather than relying on this auto-configuration.
   *
   * @returns Recommended number of parallel request slots (always 1 for single-user apps)
   */
  private recommendParallelRequests(): number {
    // Always return 1 for single-user Electron apps
    // The previous CPU-based logic (8 for 16+ cores) was designed for multi-user servers
    // and caused issues where KV cache was split across slots, limiting per-request tokens
    return 1;
  }

  /**
   * Clear the capabilities cache
   * Useful for testing or when hardware changes
   */
  public clearCache(): void {
    this.cachedCapabilities = null;
    this.cacheTimestamp = 0;
  }
}

// Export singleton instance
export const systemInfo = SystemInfo.getInstance();
