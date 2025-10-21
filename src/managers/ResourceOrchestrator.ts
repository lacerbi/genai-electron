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
import type { ServerConfig, ImageGenerationConfig, ImageGenerationResult } from '../types/index.js';
import { ServerError } from '../errors/index.js';

/**
 * Saved LLM state for restoration
 */
interface SavedLLMState {
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
  private systemInfo: SystemInfo;
  private llamaServer: LlamaServerManager;
  private diffusionServer: DiffusionServerManager;
  private modelManager: ModelManager;
  private savedLLMState?: SavedLLMState;

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
    console.log('[Orchestrator] orchestrateImageGeneration called');

    // Check if we need to offload LLM
    const needsOffload = await this.needsOffloadForImage();
    const llamaIsRunning = this.llamaServer.isRunning();

    console.log('[Orchestrator] needsOffload:', needsOffload);
    console.log('[Orchestrator] llamaServer.isRunning():', llamaIsRunning);

    if (needsOffload && llamaIsRunning) {
      console.log('[Orchestrator] ⚠️  Resources constrained - offloading LLM before generation');
      // Save LLM state and offload
      await this.offloadLLM();

      try {
        // Generate image directly (bypassing orchestrator to avoid recursion)
        console.log('[Orchestrator] Generating image with LLM offloaded...');
        const result = await this.diffusionServer.executeImageGeneration(config);
        return result;
      } finally {
        // Always reload LLM if it was running before
        console.log('[Orchestrator] Reloading LLM after generation...');
        await this.reloadLLM();
      }
    } else {
      if (!needsOffload) {
        console.log('[Orchestrator] ✅ Sufficient resources - generating directly without offload');
      } else {
        console.log('[Orchestrator] ✅ LLM not running - generating directly');
      }
      // Enough resources, generate directly (bypassing orchestrator to avoid recursion)
      return await this.diffusionServer.executeImageGeneration(config);
    }
  }

  /**
   * Check if we need to offload LLM for image generation
   *
   * Determines the bottleneck resource (RAM or VRAM) and checks if
   * there's enough space for both servers to run simultaneously.
   *
   * Uses 75% threshold to leave headroom for OS and other processes.
   *
   * @returns True if offload is needed
   * @private
   */
  private async needsOffloadForImage(): Promise<boolean> {
    console.log('[Orchestrator] Checking if offload needed...');

    const memory = this.systemInfo.getMemoryInfo();
    const capabilities = await this.systemInfo.detect();

    // Estimate resource usage
    const llamaUsage = await this.estimateLLMUsage();
    const diffusionUsage = await this.estimateDiffusionUsage();

    // Determine bottleneck resource
    const isGPUSystem = capabilities.gpu.available && capabilities.gpu.vram;

    console.log('[Orchestrator] System type:', isGPUSystem ? 'GPU' : 'CPU-only');

    if (isGPUSystem) {
      // VRAM is the bottleneck
      const totalVRAM = capabilities.gpu.vram || 0;
      const vramNeeded = (llamaUsage.vram || 0) + (diffusionUsage.vram || 0);
      const threshold = totalVRAM * 0.75;

      console.log('[Orchestrator] VRAM Analysis:');
      console.log('  - LLM VRAM usage:', (llamaUsage.vram || 0) / (1024 ** 3), 'GB');
      console.log('  - Diffusion VRAM usage:', (diffusionUsage.vram || 0) / (1024 ** 3), 'GB');
      console.log('  - Total VRAM needed:', vramNeeded / (1024 ** 3), 'GB');
      console.log('  - Total VRAM available:', totalVRAM / (1024 ** 3), 'GB');
      console.log('  - Threshold (75%):', threshold / (1024 ** 3), 'GB');
      console.log('  - Offload needed:', vramNeeded > threshold);

      // Need offload if combined VRAM usage > 75% of total
      return vramNeeded > threshold;
    } else {
      // RAM is the bottleneck
      const ramNeeded = llamaUsage.ram + diffusionUsage.ram;
      const threshold = memory.available * 0.75;

      console.log('[Orchestrator] RAM Analysis:');
      console.log('  - LLM RAM usage:', llamaUsage.ram / (1024 ** 3), 'GB');
      console.log('  - Diffusion RAM usage:', diffusionUsage.ram / (1024 ** 3), 'GB');
      console.log('  - Total RAM needed:', ramNeeded / (1024 ** 3), 'GB');
      console.log('  - Available RAM:', memory.available / (1024 ** 3), 'GB');
      console.log('  - Threshold (75%):', threshold / (1024 ** 3), 'GB');
      console.log('  - Offload needed:', ramNeeded > threshold);

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
   * @returns Resource requirements
   * @private
   */
  private async estimateLLMUsage(): Promise<ResourceRequirements> {
    if (!this.llamaServer.isRunning()) {
      console.log('[Orchestrator] LLM not running - usage: 0');
      return { ram: 0, vram: 0 };
    }

    const config = this.llamaServer.getConfig();
    if (!config) {
      console.log('[Orchestrator] LLM config not found - usage: 0');
      return { ram: 0, vram: 0 };
    }

    try {
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      const gpuLayers = config.gpuLayers || 0;

      // Get actual layer count from GGUF metadata (or fallback to estimation)
      const totalLayers = await this.modelManager.getModelLayerCount(config.modelId);

      console.log('[Orchestrator] LLM model:', config.modelId);
      console.log('[Orchestrator] LLM model size:', modelInfo.size / (1024 ** 3), 'GB');
      console.log('[Orchestrator] LLM GPU layers:', gpuLayers, '/', totalLayers);

      if (gpuLayers > 0) {
        // Mixed GPU/CPU
        const gpuRatio = Math.min(gpuLayers / totalLayers, 1.0);
        const result = {
          ram: modelInfo.size * (1 - gpuRatio) * 1.2,
          vram: modelInfo.size * gpuRatio * 1.2,
        };
        console.log('[Orchestrator] LLM usage (mixed):', {
          ram: result.ram / (1024 ** 3) + ' GB',
          vram: result.vram / (1024 ** 3) + ' GB'
        });
        return result;
      } else {
        // CPU only
        const result = {
          ram: modelInfo.size * 1.2,
          vram: 0,
        };
        console.log('[Orchestrator] LLM usage (CPU-only):', {
          ram: result.ram / (1024 ** 3) + ' GB',
          vram: '0 GB'
        });
        return result;
      }
    } catch (error) {
      // If we can't get model info, return conservative estimate
      console.log('[Orchestrator] Failed to get LLM model info:', error);
      return { ram: 0, vram: 0 };
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
      console.log('[Orchestrator] Diffusion config not found - using default estimate: 6.5GB');
      return { ram: defaultSize * 1.2, vram: defaultSize * 1.2 };
    }

    try {
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      console.log('[Orchestrator] Diffusion model:', config.modelId);
      console.log('[Orchestrator] Diffusion model size:', modelInfo.size / (1024 ** 3), 'GB');

      // Diffusion models typically need similar VRAM/RAM as their size
      const usage = modelInfo.size * 1.2;
      const result = {
        ram: usage,
        vram: usage,
      };
      console.log('[Orchestrator] Diffusion usage:', usage / (1024 ** 3), 'GB (both RAM and VRAM)');
      return result;
    } catch (error) {
      // If we can't get model info, return conservative estimate
      console.log('[Orchestrator] Failed to get diffusion model info:', error);
      const defaultSize = 6.5 * 1024 * 1024 * 1024;
      console.log('[Orchestrator] Using default estimate: 6.5GB');
      return { ram: defaultSize * 1.2, vram: defaultSize * 1.2 };
    }
  }

  /**
   * Offload LLM (save state and stop)
   *
   * Saves the current LLM configuration and stops the server to free resources.
   *
   * @throws {ServerError} If no configuration found
   * @private
   */
  private async offloadLLM(): Promise<void> {
    console.log('[Orchestrator] offloadLLM called');

    if (!this.llamaServer.isRunning()) {
      console.log('[Orchestrator] LLM not running - nothing to offload');
      return;
    }

    // Save current state
    const config = this.llamaServer.getConfig();
    if (!config) {
      throw new ServerError('Cannot offload LLM: no configuration found');
    }

    console.log('[Orchestrator] Saving LLM state:', {
      modelId: config.modelId,
      port: config.port,
      gpuLayers: config.gpuLayers
    });

    this.savedLLMState = {
      config,
      wasRunning: true,
      savedAt: new Date(),
    };

    // Stop LLM server gracefully
    console.log('[Orchestrator] Stopping LLM server...');
    await this.llamaServer.stop();
    console.log('[Orchestrator] ✅ LLM server stopped successfully');
  }

  /**
   * Reload LLM (restore from saved state)
   *
   * Restarts the LLM server with the previously saved configuration.
   * Errors are logged but not thrown to avoid disrupting image generation.
   *
   * @private
   */
  private async reloadLLM(): Promise<void> {
    console.log('[Orchestrator] reloadLLM called');

    if (!this.savedLLMState || !this.savedLLMState.wasRunning) {
      console.log('[Orchestrator] No saved LLM state - nothing to reload');
      return;
    }

    try {
      // Restart with saved configuration
      console.log('[Orchestrator] Restarting LLM with saved config:', {
        modelId: this.savedLLMState.config.modelId,
        port: this.savedLLMState.config.port
      });
      await this.llamaServer.start(this.savedLLMState.config);
      console.log('[Orchestrator] ✅ LLM server restarted successfully');
      this.savedLLMState = undefined;
    } catch (error) {
      // Log error but don't throw - image generation succeeded
      console.error('[Orchestrator] ❌ Failed to reload LLM:', error);
      // Keep saved state in case user wants to manually restart
    }
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
