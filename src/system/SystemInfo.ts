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
   * Check if system can run a specific model
   *
   * @param modelInfo - Model information
   * @returns True if model can run, with reason if false
   *
   * @example
   * ```typescript
   * const canRun = await systemInfo.canRunModel(modelInfo);
   * if (!canRun.possible) {
   *   console.log(`Cannot run model: ${canRun.reason}`);
   * }
   * ```
   */
  public async canRunModel(modelInfo: ModelInfo): Promise<{
    possible: boolean;
    reason?: string;
    suggestion?: string;
  }> {
    const capabilities = await this.detect();
    const requiredMemory = modelInfo.size * 1.2; // 20% overhead

    // Check if model fits in RAM
    const fitsInRAM = capabilities.memory.available >= requiredMemory;

    if (!fitsInRAM) {
      return {
        possible: false,
        reason: `Insufficient RAM: model requires ${(requiredMemory / 1024 ** 3).toFixed(1)}GB, but only ${(capabilities.memory.available / 1024 ** 3).toFixed(1)}GB available`,
        suggestion:
          'Try closing other applications or using a smaller quantization (Q4_K_M instead of Q8_0)',
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

    const config: Partial<ServerConfig> = {
      threads: getRecommendedThreads(capabilities.cpu.cores),
      contextSize: this.recommendContextSize(capabilities.memory.available, modelInfo.size),
      parallelRequests: this.recommendParallelRequests(capabilities.cpu.cores),
    };

    // Add GPU layers if GPU is available
    if (capabilities.gpu.available && capabilities.gpu.vram) {
      // Estimate total layers (rough approximation based on model size)
      // 7B models: ~32 layers, 13B: ~40 layers, 70B: ~80 layers
      const estimatedLayers = Math.round(modelInfo.size / (150 * 1024 ** 2));
      config.gpuLayers = calculateGPULayers(estimatedLayers, capabilities.gpu.vram, modelInfo.size);
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
   */
  private recommendContextSize(availableRAM: number, modelSize: number): number {
    const ramGB = availableRAM / 1024 ** 3;
    const modelGB = modelSize / 1024 ** 3;

    // Leave enough RAM for OS and model
    const remainingRAM = ramGB - modelGB - 2; // 2GB buffer

    if (remainingRAM >= 8) return 8192;
    if (remainingRAM >= 4) return 4096;
    if (remainingRAM >= 2) return 2048;
    return 1024;
  }

  /**
   * Recommend parallel request slots based on CPU cores
   */
  private recommendParallelRequests(cpuCores: number): number {
    if (cpuCores >= 16) return 8;
    if (cpuCores >= 8) return 4;
    if (cpuCores >= 4) return 2;
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
