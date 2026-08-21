/**
 * Unit tests for ResourceOrchestrator
 * Tests automatic resource management and offload/reload logic
 */

import { jest } from '@jest/globals';
import type {
  ServerConfig,
  LlamaServerConfig,
  ImageGenerationConfig,
} from '../../src/types/index.js';

// Mock SystemInfo
const mockSystemInfo = {
  detect: jest.fn(),
  getMemoryInfo: jest.fn(),
  clearCache: jest.fn(),
};

jest.unstable_mockModule('../../src/system/SystemInfo.js', () => ({
  SystemInfo: {
    getInstance: jest.fn(() => mockSystemInfo),
  },
}));

// Mock ModelManager
const mockModelManager = {
  getModelInfo: jest.fn(),
  getModelLayerCount: jest.fn(),
};

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: {
    getInstance: jest.fn(() => mockModelManager),
  },
}));

// Import after mocking
const { ResourceOrchestrator } = await import('../../src/managers/ResourceOrchestrator.js');

describe('ResourceOrchestrator', () => {
  let orchestrator: ResourceOrchestrator;
  let mockLlamaServer: any;
  let mockDiffusionServer: any;

  // Mock model infos
  const llmModelInfo = {
    id: 'llama-2-7b',
    name: 'Llama 2 7B',
    type: 'llm',
    size: 4 * 1024 * 1024 * 1024, // 4GB
    path: '/test/models/llm/llama-2-7b.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/llama-2-7b.gguf' },
  };

  const diffusionModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 * 1024 * 1024, // 6.5GB
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-turbo.gguf' },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock servers
    mockLlamaServer = {
      isRunning: jest.fn(),
      getConfig: jest.fn(),
      stop: jest.fn(),
      start: jest.fn(),
    };

    // Plain-object stand-in for DiffusionServerManager. The residency methods mirror
    // the real manager's semantics (see resolveUsageMode/settleResidency there) so the
    // orchestration branches are exercised against faithful defaults.
    mockDiffusionServer = {
      isRunning: jest.fn(),
      getConfig: jest.fn(),
      generateImage: jest.fn(),
      executeImageGeneration: jest.fn(),
      executeBatchGeneration: jest.fn(),
      resolveUsageMode: jest.fn(
        (requestMode: 'burst' | 'single' | undefined, llmWasOffloaded: boolean) =>
          requestMode ?? (llmWasOffloaded ? 'single' : 'burst')
      ),
      settleResidency: jest.fn(async () => {}),
      releaseBackend: jest.fn(async () => {}),
      isCalibrating: jest.fn(() => false),
      getBackendInfo: jest.fn(() => ({ state: 'absent' })),
    };

    // Setup default mocks
    mockSystemInfo.getMemoryInfo.mockReturnValue({
      total: 16 * 1024 ** 3, // 16GB
      available: 12 * 1024 ** 3, // 12GB available
      used: 4 * 1024 ** 3, // 4GB used
    });

    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: 8 * 1024 ** 3 }, // 8GB VRAM
      platform: 'linux',
      recommendations: {
        maxModelSize: '13B',
        recommendedQuantization: ['Q4_K_M', 'Q5_K_M'],
        threads: 7,
        gpuLayers: 35,
      },
    });

    mockModelManager.getModelInfo.mockImplementation((modelId: string) => {
      if (modelId === 'llama-2-7b') return Promise.resolve(llmModelInfo);
      if (modelId === 'sdxl-turbo') return Promise.resolve(diffusionModelInfo);
      return Promise.reject(new Error('Model not found'));
    });
    // Default: layer count unavailable → estimateLLMUsage falls back to its
    // conservative default estimates (the pre-existing behavior these tests
    // were written against). MoE tests below override this.
    mockModelManager.getModelLayerCount.mockImplementation(() => {
      throw new Error('layer count not mocked');
    });

    mockLlamaServer.isRunning.mockReturnValue(false);
    mockLlamaServer.stop.mockResolvedValue(undefined);
    mockLlamaServer.start.mockResolvedValue({ status: 'running', port: 8080 });

    mockDiffusionServer.isRunning.mockReturnValue(false);
    mockDiffusionServer.getConfig.mockReturnValue({ modelId: 'sdxl-turbo', port: 8081 });
    mockDiffusionServer.executeImageGeneration.mockResolvedValue({
      image: Buffer.from('fake-image'),
      format: 'png',
      timeTaken: 5000,
      seed: 12345,
      width: 1024,
      height: 1024,
    });
    mockDiffusionServer.executeBatchGeneration.mockImplementation(async (config: any) =>
      Array.from({ length: config.count ?? 1 }, (_unused, index) => ({
        image: Buffer.from(`fake-image-${index}`),
        format: 'png',
        timeTaken: 5000,
        seed: 12345 + index,
        width: 1024,
        height: 1024,
      }))
    );

    // Create orchestrator with mocked servers
    orchestrator = new ResourceOrchestrator(
      mockSystemInfo,
      mockLlamaServer,
      mockDiffusionServer,
      mockModelManager
    );
  });

  /** 6 GB VRAM: the LLM + a 6.5 GB diffusion model never fit together. */
  const constrainVram = (vramGiB = 6): void => {
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: vramGiB * 1024 ** 3 },
      platform: 'linux',
      recommendations: {
        maxModelSize: '7B',
        recommendedQuantization: ['Q4_K_M'],
        threads: 7,
        gpuLayers: 35,
      },
    });
  };

  /** A running LLM whose offload the constrained-VRAM setup will require. */
  const runningLLM = (): void => {
    mockLlamaServer.isRunning.mockReturnValue(true);
    mockLlamaServer.getConfig.mockReturnValue({
      modelId: 'llama-2-7b',
      port: 8080,
      gpuLayers: 35,
    });
  };

  describe('orchestrateImageGeneration()', () => {
    const imageConfig: ImageGenerationConfig = {
      prompt: 'A beautiful sunset over mountains',
      width: 1024,
      height: 1024,
      steps: 30,
    };

    it('should generate image directly when resources are sufficient', async () => {
      // LLM not running, plenty of resources
      mockLlamaServer.isRunning.mockReturnValue(false);

      const result = await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(result).toBeDefined();
      expect(result.image).toEqual(Buffer.from('fake-image'));

      // Should not offload/reload LLM
      expect(mockLlamaServer.stop).not.toHaveBeenCalled();
      expect(mockLlamaServer.start).not.toHaveBeenCalled();

      // Should generate directly (using internal method)
      expect(mockDiffusionServer.executeImageGeneration).toHaveBeenCalledWith(imageConfig);
    });

    it('should offload LLM when VRAM is constrained', async () => {
      // LLM running with GPU layers
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35, // Using GPU
      });

      // Small VRAM (6GB total)
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 }, // Only 6GB VRAM
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      const result = await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(result).toBeDefined();

      // Should offload LLM
      expect(mockLlamaServer.stop).toHaveBeenCalled();

      // Should generate image (using internal method)
      expect(mockDiffusionServer.executeImageGeneration).toHaveBeenCalledWith(imageConfig);

      // Wait for background reload to complete before asserting
      await orchestrator.waitForReload();

      // Should reload LLM
      expect(mockLlamaServer.start).toHaveBeenCalledWith({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
    });

    it('should offload LLM when RAM is constrained (CPU-only system)', async () => {
      // LLM running on CPU
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 0, // CPU only
      });

      // No GPU available
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 8 * 1024 ** 3, available: 5 * 1024 ** 3, used: 3 * 1024 ** 3 },
        gpu: { available: false }, // No GPU
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
        },
      });

      // With small RAM, combined usage would exceed 75% threshold
      mockSystemInfo.getMemoryInfo.mockReturnValue({
        total: 8 * 1024 ** 3,
        available: 5 * 1024 ** 3, // 5GB available
        used: 3 * 1024 ** 3,
      });

      const result = await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(result).toBeDefined();

      // Should offload LLM due to RAM constraint
      expect(mockLlamaServer.stop).toHaveBeenCalled();

      // Wait for background reload
      await orchestrator.waitForReload();
      expect(mockLlamaServer.start).toHaveBeenCalled();
    });

    it('should preserve LLM configuration during offload/reload', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);

      const llmConfig: LlamaServerConfig = {
        modelId: 'llama-2-7b',
        port: 8080,
        threads: 8,
        gpuLayers: 35,
        contextSize: 4096,
        minimumContextSize: 1024,
        preferredContextSize: 1536,
        maximumContextSize: 2048,
        parallelRequests: 4,
        flashAttention: 'on',
        cacheTypeK: 'q8_0',
        cacheTypeV: 'q8_0',
        swaFull: true,
      };

      mockLlamaServer.getConfig.mockReturnValue(llmConfig);

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      await orchestrator.orchestrateImageGeneration(imageConfig);

      // Wait for background reload
      await orchestrator.waitForReload();

      // Should reload with exact same configuration
      expect(mockLlamaServer.start).toHaveBeenCalledWith(llmConfig);
    });

    it('should not reload LLM if it was not running before', async () => {
      mockLlamaServer.isRunning.mockReturnValue(false);

      await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(mockLlamaServer.stop).not.toHaveBeenCalled();
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
    });

    it('should reload LLM even if image generation fails', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // Make image generation fail
      mockDiffusionServer.executeImageGeneration.mockRejectedValue(new Error('Generation failed'));

      await expect(orchestrator.orchestrateImageGeneration(imageConfig)).rejects.toThrow(
        'Generation failed'
      );

      // Wait for background reload (fires even on image generation failure)
      await orchestrator.waitForReload();

      // Should still reload LLM
      expect(mockLlamaServer.start).toHaveBeenCalled();
    });

    it('should reload LLM when an orchestrated generation is cancelled', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // Cancellation surfaces as a rejection from the killed sd-cli process
      mockDiffusionServer.executeImageGeneration.mockRejectedValue(
        new Error('Image generation cancelled')
      );

      await expect(orchestrator.orchestrateImageGeneration(imageConfig)).rejects.toThrow(
        'cancelled'
      );

      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalled();
    });

    it('should handle LLM reload failure gracefully after retry', async () => {
      jest.useFakeTimers();

      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // Make both reload attempts fail
      mockLlamaServer.start.mockRejectedValue(new Error('Failed to start'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Orchestration now resolves immediately after image generation
      const result = await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(result).toBeDefined();

      // Background reload is in progress — advance past the 2s retry delay
      await jest.advanceTimersByTimeAsync(3000);

      // Wait for the reload promise to settle
      await orchestrator.waitForReload();

      // Both attempts should have been made
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(2);
      // Cache should be cleared between attempts
      expect(mockSystemInfo.clearCache).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Orchestrator] ❌ Failed to reload LLM after retry:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    });

    it('should succeed on retry when first reload attempt fails', async () => {
      jest.useFakeTimers();

      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // First attempt fails, retry succeeds
      mockLlamaServer.start
        .mockRejectedValueOnce(new Error('Insufficient RAM'))
        .mockResolvedValueOnce({ status: 'running', port: 8080 });

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Orchestration resolves immediately
      const result = await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(result).toBeDefined();

      // Advance past the 2s retry delay for background reload
      await jest.advanceTimersByTimeAsync(3000);

      // Wait for reload to settle
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalledTimes(2);
      expect(mockSystemInfo.clearCache).toHaveBeenCalled();
      // Saved state should be cleared after successful retry
      expect(orchestrator.getSavedState()).toBeUndefined();

      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    });

    it('should await pending reload before starting new orchestration', async () => {
      jest.useFakeTimers();

      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // First reload: first attempt fails with delay, retry succeeds
      // Second reload: succeeds immediately
      mockLlamaServer.start
        .mockRejectedValueOnce(new Error('Insufficient RAM'))
        .mockResolvedValueOnce({ status: 'running', port: 8080 })
        .mockResolvedValueOnce({ status: 'running', port: 8080 });

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // First generation: image resolves immediately, reload fires in background
      const result1 = await orchestrator.orchestrateImageGeneration(imageConfig);
      expect(result1).toBeDefined();

      // Don't advance timers yet — reload is pending (waiting for 2s retry delay)
      // Start second generation — it should block until the first reload completes
      const result2Promise = orchestrator.orchestrateImageGeneration(imageConfig);

      // Now advance timers to let the first reload's retry happen
      await jest.advanceTimersByTimeAsync(3000);

      const result2 = await result2Promise;
      expect(result2).toBeDefined();

      // First gen: 2 start calls (fail + retry)
      // Second gen: 1 start call (background reload)
      // Total: at least 2 start calls from first gen's reload
      expect(mockLlamaServer.start.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Clean up any pending reload from second generation
      await jest.advanceTimersByTimeAsync(3000);
      await orchestrator.waitForReload();

      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('residency settle (Phase 4)', () => {
    const imageConfig: ImageGenerationConfig = { prompt: 'a cat', width: 512, height: 512 };

    it("releases the backend BEFORE the LLM reload starts in 'single' mode", async () => {
      runningLLM();
      constrainVram();

      await orchestrator.orchestrateImageGeneration(imageConfig);

      // Default after an offload is 'single'
      expect(mockDiffusionServer.resolveUsageMode).toHaveBeenCalledWith(undefined, true);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('single');
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);

      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
      // Release-before-reload: the settle is awaited before start() is even called
      expect(mockDiffusionServer.settleResidency.mock.invocationCallOrder[0]).toBeLessThan(
        mockLlamaServer.start.mock.invocationCallOrder[0]
      );
    });

    it("settles once and reloads once when the generation FAILS in 'single' mode", async () => {
      runningLLM();
      constrainVram();
      mockDiffusionServer.executeImageGeneration.mockRejectedValue(new Error('Generation failed'));

      await expect(orchestrator.orchestrateImageGeneration(imageConfig)).rejects.toThrow(
        'Generation failed'
      );

      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('single');

      await orchestrator.waitForReload();
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
    });

    it("keeps the backend and DEFERS the reload in 'burst' mode", async () => {
      runningLLM();
      constrainVram();

      await orchestrator.orchestrateImageGeneration({ ...imageConfig, usageMode: 'burst' });

      expect(mockDiffusionServer.resolveUsageMode).toHaveBeenCalledWith('burst', true);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('burst');

      await orchestrator.waitForReload();

      // Still offloaded: nothing released the backend yet
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
      expect(orchestrator.getSavedState()).toBeDefined();

      // The deferred reload fires on a qualifying release
      orchestrator.onDiffusionBackendReleased('idle-timeout');
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
      expect(orchestrator.getSavedState()).toBeUndefined();
    });

    it('honours a server-level usageMode through the manager resolver', async () => {
      runningLLM();
      constrainVram();
      // The manager (not the orchestrator) applies request > server config > default
      mockDiffusionServer.resolveUsageMode.mockReturnValue('burst');

      await orchestrator.orchestrateImageGeneration(imageConfig);
      await orchestrator.waitForReload();

      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('burst');
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
    });

    it('settles with the no-offload default when nothing had to be offloaded', async () => {
      mockLlamaServer.isRunning.mockReturnValue(false);

      await orchestrator.orchestrateImageGeneration(imageConfig);

      expect(mockDiffusionServer.resolveUsageMode).toHaveBeenCalledWith(undefined, false);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('burst');
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
    });

    it("settles an explicit 'single' request even without an offload", async () => {
      mockLlamaServer.isRunning.mockReturnValue(false);

      await orchestrator.orchestrateImageGeneration({ ...imageConfig, usageMode: 'single' });

      expect(mockDiffusionServer.resolveUsageMode).toHaveBeenCalledWith('single', false);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('single');
    });

    it('still settles when a non-offloaded generation fails', async () => {
      mockLlamaServer.isRunning.mockReturnValue(false);
      mockDiffusionServer.executeImageGeneration.mockRejectedValue(new Error('boom'));

      await expect(orchestrator.orchestrateImageGeneration(imageConfig)).rejects.toThrow('boom');

      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);
    });

    it('reloads the LLM even when the settle itself fails', async () => {
      runningLLM();
      constrainVram();
      mockDiffusionServer.settleResidency.mockRejectedValue(new Error('kill failed'));
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await orchestrator.orchestrateImageGeneration(imageConfig);
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
      consoleWarnSpy.mockRestore();
    });
  });

  describe('onDiffusionBackendReleased()', () => {
    const imageConfig: ImageGenerationConfig = { prompt: 'a cat' };

    /** Offload the LLM and leave the backend resident (burst), so a reload is pending. */
    const offloadAndDefer = async (): Promise<void> => {
      runningLLM();
      constrainVram();
      await orchestrator.orchestrateImageGeneration({ ...imageConfig, usageMode: 'burst' });
      await orchestrator.waitForReload();
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
      mockLlamaServer.isRunning.mockReturnValue(false);
    };

    it.each(['idle-timeout', 'explicit', 'crashed', 'stop'] as const)(
      "reloads the deferred LLM for reason '%s'",
      async (reason) => {
        await offloadAndDefer();

        orchestrator.onDiffusionBackendReleased(reason);
        await orchestrator.waitForReload();

        expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
      }
    );

    it.each(['single', 'llm-start', 'shutdown', 'calibration', 'cancel', 'flags-changed'] as const)(
      "never reloads for reason '%s'",
      async (reason) => {
        await offloadAndDefer();

        orchestrator.onDiffusionBackendReleased(reason);
        await orchestrator.waitForReload();

        expect(mockLlamaServer.start).not.toHaveBeenCalled();
        expect(orchestrator.getSavedState()).toBeDefined();
      }
    );

    it('does nothing without saved LLM state', async () => {
      orchestrator.onDiffusionBackendReleased('idle-timeout');
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).not.toHaveBeenCalled();
    });

    it('does not start a second reload while one is already in flight', async () => {
      await offloadAndDefer();

      orchestrator.onDiffusionBackendReleased('explicit');
      // Second release before the first reload settled
      orchestrator.onDiffusionBackendReleased('explicit');
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
    });

    it('is suppressed while an offload calibration sweep is running', async () => {
      await offloadAndDefer();
      mockDiffusionServer.isCalibrating.mockReturnValue(true);

      orchestrator.onDiffusionBackendReleased('explicit');
      await orchestrator.waitForReload();

      expect(mockLlamaServer.start).not.toHaveBeenCalled();
      expect(orchestrator.getSavedState()).toBeDefined();
    });
  });

  describe('orchestrateBatchGeneration()', () => {
    const batchConfig: ImageGenerationConfig = { prompt: 'a cat', count: 3 };

    it('opens ONE offload window around the whole batch', async () => {
      runningLLM();
      constrainVram();

      const results = await orchestrator.orchestrateBatchGeneration(batchConfig);

      expect(results).toHaveLength(3);
      expect(mockDiffusionServer.executeBatchGeneration).toHaveBeenCalledWith(batchConfig);
      expect(mockDiffusionServer.executeImageGeneration).not.toHaveBeenCalled();
      expect(mockLlamaServer.stop).toHaveBeenCalledTimes(1);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('single');

      await orchestrator.waitForReload();
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
    });

    it('settles once without offloading when resources are sufficient', async () => {
      mockLlamaServer.isRunning.mockReturnValue(false);

      const results = await orchestrator.orchestrateBatchGeneration(batchConfig);

      expect(results).toHaveLength(3);
      expect(mockLlamaServer.stop).not.toHaveBeenCalled();
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);
      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledWith('burst');
    });

    it('settles and reloads when the batch fails midway', async () => {
      runningLLM();
      constrainVram();
      mockDiffusionServer.executeBatchGeneration.mockRejectedValue(new Error('image 2 failed'));

      await expect(orchestrator.orchestrateBatchGeneration(batchConfig)).rejects.toThrow(
        'image 2 failed'
      );

      expect(mockDiffusionServer.settleResidency).toHaveBeenCalledTimes(1);
      await orchestrator.waitForReload();
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('prepareForLLMStart()', () => {
    const llmStartConfig: LlamaServerConfig = {
      modelId: 'llama-2-7b',
      port: 8080,
      gpuLayers: 32,
    };

    beforeEach(() => {
      // A concrete layer count makes the LLM estimate meaningful (the default mock
      // throws, which collapses the estimate to zero)
      mockModelManager.getModelLayerCount.mockResolvedValue(32);
      mockDiffusionServer.getBackendInfo.mockReturnValue({ state: 'ready' });
    });

    it.each(['absent', 'stopping'] as const)(
      "is a no-op when the backend is '%s'",
      async (state) => {
        mockDiffusionServer.getBackendInfo.mockReturnValue({ state });

        await orchestrator.prepareForLLMStart({ config: llmStartConfig });

        expect(mockDiffusionServer.releaseBackend).not.toHaveBeenCalled();
        expect(mockSystemInfo.detect).not.toHaveBeenCalled();
      }
    );

    it.each(['starting', 'ready', 'busy'] as const)(
      "releases a '%s' backend when both would not fit",
      async (state) => {
        mockDiffusionServer.getBackendInfo.mockReturnValue({ state });
        // 12 GB: diffusion 7.8 GB + LLM 4.8 GB = 12.6 GB > 9 GB threshold
        constrainVram(12);

        await orchestrator.prepareForLLMStart({ config: llmStartConfig });

        expect(mockDiffusionServer.releaseBackend).toHaveBeenCalledWith({
          reason: 'llm-start',
          waitForInFlight: true,
        });
      }
    );

    it('keeps the backend resident when both fit', async () => {
      // 24 GB: 12.6 GB < 18 GB threshold
      constrainVram(24);

      await orchestrator.prepareForLLMStart({ config: llmStartConfig });

      expect(mockDiffusionServer.releaseBackend).not.toHaveBeenCalled();
    });

    it('estimates from the override config, not from the (not yet running) server', async () => {
      // The LLM is NOT running: the legacy estimator short-circuit would report zero
      // usage here and make the hook a permanent no-op.
      mockLlamaServer.isRunning.mockReturnValue(false);
      mockLlamaServer.getConfig.mockReturnValue(undefined);
      constrainVram(12);

      await orchestrator.prepareForLLMStart({ config: llmStartConfig });

      expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('llama-2-7b');
      expect(mockDiffusionServer.releaseBackend).toHaveBeenCalledWith({
        reason: 'llm-start',
        waitForInFlight: true,
      });
    });

    it('never triggers an LLM reload from inside the hook', async () => {
      // Saved state from an earlier burst-deferred cycle
      runningLLM();
      constrainVram();
      await orchestrator.orchestrateImageGeneration({ prompt: 'x', usageMode: 'burst' });
      await orchestrator.waitForReload();
      expect(orchestrator.getSavedState()).toBeDefined();
      mockLlamaServer.start.mockClear();

      // The manager forwards the release reason exactly as the real seam does
      mockDiffusionServer.releaseBackend.mockImplementation(async (options: any) => {
        orchestrator.onDiffusionBackendReleased(options.reason);
      });
      mockDiffusionServer.getBackendInfo.mockReturnValue({ state: 'ready' });
      constrainVram(12);

      await orchestrator.prepareForLLMStart({ config: llmStartConfig });
      await orchestrator.waitForReload();

      expect(mockDiffusionServer.releaseBackend).toHaveBeenCalled();
      expect(mockLlamaServer.start).not.toHaveBeenCalled();
    });
  });

  describe('wouldNeedOffload()', () => {
    it('should return false when resources are sufficient', async () => {
      // LLM not running - no offload needed
      mockLlamaServer.isRunning.mockReturnValue(false);

      // Diffusion server not configured - uses default estimate
      mockDiffusionServer.getConfig.mockReturnValue(null);

      // Plenty of resources
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3, used: 8 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 24 * 1024 ** 3 }, // 24GB VRAM
        platform: 'linux',
        recommendations: {
          maxModelSize: '70B',
          recommendedQuantization: ['Q4_K_M', 'Q5_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      const needsOffload = await orchestrator.wouldNeedOffload();

      expect(needsOffload).toBe(false);
    });

    it('should return true when VRAM would be constrained', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      const needsOffload = await orchestrator.wouldNeedOffload();

      expect(needsOffload).toBe(true);
    });

    it('should return true when RAM would be constrained', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 0, // CPU only
      });

      // No GPU, small RAM
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 8 * 1024 ** 3, available: 5 * 1024 ** 3, used: 3 * 1024 ** 3 },
        gpu: { available: false },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
        },
      });

      mockSystemInfo.getMemoryInfo.mockReturnValue({
        total: 8 * 1024 ** 3,
        available: 5 * 1024 ** 3,
        used: 3 * 1024 ** 3,
      });

      const needsOffload = await orchestrator.wouldNeedOffload();

      expect(needsOffload).toBe(true);
    });
  });

  describe('estimateLLMUsage() — MoE split', () => {
    const GiB = 1024 ** 3;
    const moeModelInfo = {
      ...llmModelInfo,
      id: 'moe-26b',
      size: 12 * GiB,
      // No block_count: KV term stays 0, isolating the weights arithmetic
      ggufMetadata: { expert_count: 128, expert_weights_bytes: 10 * GiB },
    };
    type UsageProbe = { estimateLLMUsage(): Promise<{ ram: number; vram?: number }> };
    const estimate = () => (orchestrator as unknown as UsageProbe).estimateLLMUsage();

    beforeEach(() => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockModelManager.getModelInfo.mockResolvedValue(moeModelInfo);
      mockModelManager.getModelLayerCount.mockResolvedValue(30);
    });

    it('moves expert bytes from VRAM to RAM under cpuMoe', async () => {
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'moe-26b',
        port: 8080,
        gpuLayers: 30,
        cpuMoe: true,
      });

      const usage = await estimate();

      // Trunk (12 - 10 = 2 GiB) x 1.2 on GPU; experts (10 GiB) x 1.2 in RAM
      expect(usage.vram!).toBeCloseTo(2 * GiB * 1.2, -8);
      expect(usage.ram).toBeCloseTo(10 * GiB * 1.2, -8);
    });

    it("treats overrideTensors 'exps=CPU' like cpuMoe", async () => {
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'moe-26b',
        port: 8080,
        gpuLayers: 30,
        overrideTensors: 'exps=CPU',
      });

      const usage = await estimate();

      expect(usage.vram!).toBeCloseTo(2 * GiB * 1.2, -8);
      expect(usage.ram).toBeCloseTo(10 * GiB * 1.2, -8);
    });

    it('splits expert bytes proportionally under nCpuMoe', async () => {
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'moe-26b',
        port: 8080,
        gpuLayers: 30,
        nCpuMoe: 15, // half the 30 layers → 5 GiB of experts on CPU
      });

      const usage = await estimate();

      expect(usage.vram!).toBeCloseTo((12 - 5) * GiB * 1.2, -8);
      expect(usage.ram).toBeCloseTo(5 * GiB * 1.2, -8);
    });

    it('keeps all weights on VRAM without MoE offload flags (control)', async () => {
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'moe-26b',
        port: 8080,
        gpuLayers: 30,
      });

      const usage = await estimate();

      expect(usage.vram!).toBeCloseTo(12 * GiB * 1.2, -8);
      expect(usage.ram).toBeCloseTo(0, -8);
    });
  });

  describe('getSavedState()', () => {
    it('should return undefined when no state is saved', () => {
      const state = orchestrator.getSavedState();

      expect(state).toBeUndefined();
    });

    it('should return saved state after offload', async () => {
      jest.useFakeTimers();

      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // Prevent reload to keep saved state (both attempts fail)
      mockLlamaServer.start.mockRejectedValue(new Error('Prevent reload'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Orchestration resolves immediately
      await orchestrator.orchestrateImageGeneration({ prompt: 'test' });

      // Advance past the retry delay for background reload
      await jest.advanceTimersByTimeAsync(3000);

      // Wait for reload to settle (both attempts fail, keeping saved state)
      await orchestrator.waitForReload();

      const state = orchestrator.getSavedState();

      expect(state).toBeDefined();
      expect(state?.config.modelId).toBe('llama-2-7b');
      expect(state?.wasRunning).toBe(true);
      expect(state?.savedAt).toBeInstanceOf(Date);

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    });

    it('should return undefined after successful reload', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      await orchestrator.orchestrateImageGeneration({ prompt: 'test' });

      // Wait for background reload to complete
      await orchestrator.waitForReload();

      // After successful reload, state should be cleared
      const state = orchestrator.getSavedState();

      expect(state).toBeUndefined();
    });
  });

  describe('clearSavedState()', () => {
    it('should clear saved state', async () => {
      jest.useFakeTimers();

      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 35,
      });

      // Small VRAM to trigger offload
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: true, type: 'nvidia', vram: 6 * 1024 ** 3 },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
          gpuLayers: 35,
        },
      });

      // Prevent reload to keep saved state (both attempts fail)
      mockLlamaServer.start.mockRejectedValue(new Error('Prevent reload'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Orchestration resolves immediately
      await orchestrator.orchestrateImageGeneration({ prompt: 'test' });

      // Advance past the retry delay for background reload
      await jest.advanceTimersByTimeAsync(3000);

      // Wait for reload to settle (both attempts fail, keeping saved state)
      await orchestrator.waitForReload();

      // State should exist
      expect(orchestrator.getSavedState()).toBeDefined();

      // Clear it
      orchestrator.clearSavedState();

      // State should be gone
      expect(orchestrator.getSavedState()).toBeUndefined();

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('Resource estimation', () => {
    it('should estimate LLM usage with GPU layers', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 16, // Half on GPU
      });

      // Trigger estimation
      await orchestrator.wouldNeedOffload();

      // Model size is 4GB
      // With 16/32 layers on GPU (50%), expect:
      // - VRAM: 4GB * 0.5 * 1.2 = 2.4GB
      // - RAM: 4GB * 0.5 * 1.2 = 2.4GB
      // Total with diffusion (6.5GB * 1.2 = 7.8GB each):
      // - VRAM: 2.4 + 7.8 = 10.2GB
      // - Available VRAM: 8GB
      // - 10.2 > 8 * 0.75 (6GB) = true (would need offload)

      expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('llama-2-7b');
    });

    it('should estimate LLM usage for CPU-only', async () => {
      mockLlamaServer.isRunning.mockReturnValue(true);
      mockLlamaServer.getConfig.mockReturnValue({
        modelId: 'llama-2-7b',
        port: 8080,
        gpuLayers: 0, // All on CPU
      });

      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
        gpu: { available: false },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
        },
      });

      await orchestrator.wouldNeedOffload();

      // Model size is 4GB
      // All on CPU: 4GB * 1.2 = 4.8GB RAM
      // Diffusion: 6.5GB * 1.2 = 7.8GB RAM
      // Total: 12.6GB RAM
      // Available: 12GB
      // 12.6 > 12 * 0.75 (9GB) = true (would need offload)

      expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('llama-2-7b');
    });

    it('should use default estimate when model info unavailable', async () => {
      mockDiffusionServer.getConfig.mockReturnValue(null);

      // Should not throw, uses default 6.5GB estimate
      const needsOffload = await orchestrator.wouldNeedOffload();

      expect(needsOffload).toBeDefined();
    });

    describe('multi-component model estimation', () => {
      const multiComponentDiffusionModel = {
        id: 'flux-2-klein',
        name: 'Flux 2 Klein',
        type: 'diffusion',
        size: 7.1 * 1024 * 1024 * 1024, // 7.1GB aggregate
        path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
        downloadedAt: '2025-10-17T10:00:00Z',
        source: { type: 'url', url: 'https://example.com/flux-2-klein.gguf' },
        components: {
          diffusion_model: {
            path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
            size: 4.3 * 1024 * 1024 * 1024,
          },
          llm: {
            path: '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf',
            size: 2.5 * 1024 * 1024 * 1024,
          },
          vae: {
            path: '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors',
            size: 335 * 1024 * 1024,
          },
        },
      };

      it('should estimate using aggregate size for multi-component models', async () => {
        // Set up multi-component model
        mockModelManager.getModelInfo.mockImplementation((modelId: string) => {
          if (modelId === 'llama-2-7b') return Promise.resolve(llmModelInfo);
          if (modelId === 'flux-2-klein') return Promise.resolve(multiComponentDiffusionModel);
          return Promise.reject(new Error('Model not found'));
        });

        mockDiffusionServer.getConfig.mockReturnValue({
          modelId: 'flux-2-klein',
          port: 8081,
        });

        // LLM not running
        mockLlamaServer.isRunning.mockReturnValue(false);

        // 8GB VRAM (constrained)
        mockSystemInfo.detect.mockResolvedValue({
          cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
          memory: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3, used: 4 * 1024 ** 3 },
          gpu: { available: true, type: 'nvidia', vram: 8 * 1024 ** 3 }, // 8GB VRAM
          platform: 'linux',
          recommendations: {
            maxModelSize: '7B',
            recommendedQuantization: ['Q4_K_M'],
            threads: 7,
            gpuLayers: 35,
          },
        });

        const needsOffload = await orchestrator.wouldNeedOffload();

        // Multi-component model size: 7.1GB
        // Estimated footprint: 7.1 * 1.2 ≈ 8.52GB
        // Available VRAM threshold: 8GB * 0.75 = 6GB
        // 8.52 > 6 = true (needs offload)
        expect(needsOffload).toBe(true);
        expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('flux-2-klein');
      });

      it('should not need offload with large VRAM for multi-component models', async () => {
        // Set up multi-component model
        mockModelManager.getModelInfo.mockImplementation((modelId: string) => {
          if (modelId === 'llama-2-7b') return Promise.resolve(llmModelInfo);
          if (modelId === 'flux-2-klein') return Promise.resolve(multiComponentDiffusionModel);
          return Promise.reject(new Error('Model not found'));
        });

        mockDiffusionServer.getConfig.mockReturnValue({
          modelId: 'flux-2-klein',
          port: 8081,
        });

        // LLM not running
        mockLlamaServer.isRunning.mockReturnValue(false);

        // 24GB VRAM (plenty of room)
        mockSystemInfo.detect.mockResolvedValue({
          cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
          memory: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3, used: 8 * 1024 ** 3 },
          gpu: { available: true, type: 'nvidia', vram: 24 * 1024 ** 3 }, // 24GB VRAM
          platform: 'linux',
          recommendations: {
            maxModelSize: '70B',
            recommendedQuantization: ['Q4_K_M', 'Q5_K_M'],
            threads: 7,
            gpuLayers: 35,
          },
        });

        const needsOffload = await orchestrator.wouldNeedOffload();

        // Multi-component model size: 7.1GB
        // Estimated footprint: 7.1 * 1.2 ≈ 8.52GB
        // Available VRAM threshold: 24GB * 0.75 = 18GB
        // 8.52 < 18 = false (no offload needed)
        expect(needsOffload).toBe(false);
        expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('flux-2-klein');
      });
    });
  });
});
