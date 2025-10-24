/**
 * System information and capability detection
 * @module system/SystemInfo
 */

import type {
  SystemCapabilities,
  SystemRecommendations,
  ModelInfo,
  ServerConfig,
} from '../types/index.js';
import { getCPUInfo, getRecommendedThreads } from './cpu-detect.js';
import { getMemoryInfo, estimateVRAM } from './memory-detect.js';
import { detectGPU, calculateGPULayers } from './gpu-detect.js';
import { getPlatform } from '../utils/platform-utils.js';
import { RECOMMENDED_QUANTIZATIONS } from '../config/defaults.js';
import {
  getLayerCountWithFallback,
  getContextLengthWithFallback,
} from '../utils/model-metadata-helpers.js';

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
    options?: { checkTotalMemory?: boolean }
  ): Promise<{
    possible: boolean;
    reason?: string;
    suggestion?: string;
  }> {
    const capabilities = await this.detect();
    const requiredMemory = modelInfo.size * 1.2; // 20% overhead

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
  public async getOptimalConfig(modelInfo: ModelInfo): Promise<Partial<ServerConfig>> {
    const capabilities = await this.detect();

    // Get fresh memory info (not cached) for accurate context size calculation
    const currentMemory = this.getMemoryInfo();

    // Use GGUF context length if available, otherwise fall back to recommendation
    const contextLength = getContextLengthWithFallback(modelInfo);
    const contextSize = Math.min(
      contextLength,
      this.recommendContextSize(currentMemory.available, modelInfo.size)
    );

    const config: Partial<ServerConfig> = {
      threads: getRecommendedThreads(capabilities.cpu.cores),
      contextSize,
      parallelRequests: this.recommendParallelRequests(capabilities.cpu.cores),
    };

    // Add GPU layers if GPU is available
    if (capabilities.gpu.available && capabilities.gpu.vram) {
      // Use actual layer count from GGUF metadata (or fallback to estimation)
      const actualLayers = getLayerCountWithFallback(modelInfo);
      config.gpuLayers = calculateGPULayers(actualLayers, capabilities.gpu.vram, modelInfo.size);
    } else {
      config.gpuLayers = 0; // CPU-only
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
   * Recommend context size based on available memory
   *
   * IMPORTANT: This is a placeholder implementation that uses llama.cpp's default (4096).
   * The previous RAM-based calculation was overly conservative and didn't consider VRAM.
   *
   * TODO: Implement proper VRAM-aware context size calculation:
   * - For GPU inference, calculate based on available VRAM (not RAM)
   * - Consider KV cache size: approximately 1-2MB per token depending on model architecture
   * - Account for model layers already loaded in VRAM
   * - Leave adequate VRAM buffer for inference operations
   * - For CPU-only inference, consider RAM but with better estimates
   *
   * For now, we use llama.cpp's default which provides good balance for most use cases.
   * Users can override via the `contextSize` parameter in ServerConfig if needed.
   */
  private recommendContextSize(_availableRAM: number, _modelSize: number): number {
    // Use llama.cpp's default context size
    // This provides good performance for most models without being overly conservative
    return 4096;
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
   * @param _cpuCores - Number of CPU cores (unused, kept for interface consistency)
   * @returns Recommended number of parallel request slots (always 1 for single-user apps)
   */
  private recommendParallelRequests(_cpuCores: number): number {
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
