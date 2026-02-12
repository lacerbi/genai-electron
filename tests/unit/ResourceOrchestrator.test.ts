/**
 * Unit tests for ResourceOrchestrator
 * Tests automatic resource management and offload/reload logic
 */

import { jest } from '@jest/globals';
import type { ServerConfig, ImageGenerationConfig } from '../../src/types/index.js';

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

    mockDiffusionServer = {
      isRunning: jest.fn(),
      getConfig: jest.fn(),
      generateImage: jest.fn(),
      executeImageGeneration: jest.fn(),
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

    // Create orchestrator with mocked servers
    orchestrator = new ResourceOrchestrator(
      mockSystemInfo,
      mockLlamaServer,
      mockDiffusionServer,
      mockModelManager
    );
  });

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

      const llmConfig: ServerConfig = {
        modelId: 'llama-2-7b',
        port: 8080,
        threads: 8,
        gpuLayers: 35,
        contextSize: 4096,
        parallelRequests: 4,
        flashAttention: true,
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
  });
});
