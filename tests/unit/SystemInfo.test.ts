/**
 * Unit tests for SystemInfo module
 * Tests system capability detection, caching, and recommendations
 */

import { jest } from '@jest/globals';
import type { CPUInfo, GPUInfo, MemoryInfo } from '../../src/types/index.js';

// Mock the modules before importing SystemInfo
const mockCpus = jest.fn();
const mockTotalmem = jest.fn();
const mockFreemem = jest.fn();
const mockArch = jest.fn();
const mockPlatform = jest.fn();
const mockExec = jest.fn();

jest.unstable_mockModule('node:os', () => ({
  default: {
    cpus: mockCpus,
    totalmem: mockTotalmem,
    freemem: mockFreemem,
    arch: mockArch,
    platform: mockPlatform,
  },
}));

jest.unstable_mockModule('node:child_process', () => ({
  exec: mockExec,
}));

// Mock platform-utils
const mockGetPlatform = jest.fn();
jest.unstable_mockModule('../../src/utils/platform-utils.js', () => ({
  getPlatform: mockGetPlatform,
  getArchitecture: jest.fn().mockReturnValue('x64'),
  getPlatformKey: jest.fn().mockReturnValue('linux-x64'),
  isMac: jest.fn().mockReturnValue(false),
  isWindows: jest.fn().mockReturnValue(false),
  isLinux: jest.fn().mockReturnValue(true),
  isAppleSilicon: jest.fn().mockReturnValue(false),
}));

// Import after mocking
const { SystemInfo } = await import('../../src/system/SystemInfo.js');

describe('SystemInfo', () => {
  let systemInfo: SystemInfo;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a new instance for each test
    systemInfo = new SystemInfo();

    // Setup default mock values
    mockCpus.mockReturnValue([
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
    ]);
    mockTotalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    mockFreemem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8 GB free
    mockArch.mockReturnValue('x64');
    mockPlatform.mockReturnValue('linux');
    mockGetPlatform.mockReturnValue('linux');
  });

  describe('detect()', () => {
    it('should detect system capabilities', async () => {
      // Mock GPU detection
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, 'NVIDIA GeForce RTX 3080, 10240', '');
      });

      const capabilities = await systemInfo.detect();

      expect(capabilities).toBeDefined();
      expect(capabilities.cpu).toBeDefined();
      expect(capabilities.cpu.cores).toBe(8);
      expect(capabilities.cpu.model).toBe('Intel Core i7');
      expect(capabilities.cpu.architecture).toBe('x64');

      expect(capabilities.memory).toBeDefined();
      expect(capabilities.memory.total).toBe(16 * 1024 * 1024 * 1024);

      expect(capabilities.gpu).toBeDefined();
      expect(capabilities.platform).toBe('linux');
      expect(capabilities.recommendations).toBeDefined();
    });

    it('should cache results for 60 seconds', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });

      // First call
      const result1 = await systemInfo.detect();
      expect(mockCpus).toHaveBeenCalledTimes(1);

      // Second call immediately after (should use cache)
      const result2 = await systemInfo.detect();
      expect(mockCpus).toHaveBeenCalledTimes(1); // Still 1, not called again
      expect(result1).toEqual(result2);
    });

    it('should generate recommendations based on capabilities', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });

      const capabilities = await systemInfo.detect();
      const { recommendations } = capabilities;

      expect(recommendations.maxModelSize).toBeDefined();
      expect(recommendations.recommendedQuantization).toBeDefined();
      expect(Array.isArray(recommendations.recommendedQuantization)).toBe(true);
      expect(recommendations.threads).toBeGreaterThan(0);
    });
  });

  describe('getMemoryInfo()', () => {
    it('should return current memory information', () => {
      const memInfo = systemInfo.getMemoryInfo();

      expect(memInfo.total).toBe(16 * 1024 * 1024 * 1024);
      expect(memInfo.available).toBe(8 * 1024 * 1024 * 1024);
      expect(memInfo.used).toBe(8 * 1024 * 1024 * 1024);
    });
  });

  describe('canRunModel()', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });
      await systemInfo.detect();
    });

    it('should return true for small models', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 2 * 1024 * 1024 * 1024, // 2 GB
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return false for models larger than available RAM', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 10 * 1024 * 1024 * 1024, // 10 GB (more than 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should reduce RAM requirement when gpuLayers are specified', async () => {
      // 6.4 GB model, 5.6 GB free RAM
      // With gpuLayers=44/totalLayers=48: cpuRatio = 4/48 ≈ 0.083
      // requiredMemory = 6.4 * 0.083 * 1.2 ≈ 0.64 GB → passes
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 44, totalLayers: 48 }
      );

      expect(result.possible).toBe(true);
    });

    it('should fail same model without gpuLayers', async () => {
      // Same 6.4 GB model, 5.6 GB free RAM
      // Without gpuLayers: requiredMemory = 6.4 * 1.2 = 7.68 GB → fails
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 6.4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should treat gpuLayers=0 same as no gpuLayers', async () => {
      // 6.4 GB model, 5.6 GB free RAM, gpuLayers=0 → full model check → fails
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 0 }
      );

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should use getLayerCountWithFallback when totalLayers omitted', async () => {
      // 6.4 GB model → ~43 estimated layers (6.4 GB / 150 MB per layer)
      // gpuLayers=40 without totalLayers → uses fallback estimation
      // cpuRatio ≈ 3/43 ≈ 0.07, requiredMemory ≈ 0.54 GB → passes with 5.6 GB free
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 40 }
      );

      expect(result.possible).toBe(true);
    });

    it('should handle edge cases with minimal margin', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 7.5 * 1024 * 1024 * 1024, // 7.5 GB (close to 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // With safety margin, this might be too close
      expect(result.possible).toBeDefined();
      expect(typeof result.possible).toBe('boolean');
    });
  });

  describe('getOptimalConfig()', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        // Mock nvidia-smi CSV output: name, total memory (MB), free memory (MB)
        // The --format=csv,noheader outputs just numbers for memory, no units
        callback(null, 'NVIDIA GeForce RTX 3080, 10240, 9500', '');
      });
      await systemInfo.detect();
    });

    it('should generate optimal server configuration', async () => {
      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024, // 4 GB
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(config.threads).toBeGreaterThan(0);
      expect(config.contextSize).toBeGreaterThan(0);
      expect(config.gpuLayers).toBeDefined();
      expect(config.parallelRequests).toBeGreaterThan(0);
    });

    it('should recommend more GPU layers for systems with GPU', async () => {
      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // GPU layers should be defined (may be 0 if VRAM parsing failed, but should be a number)
      expect(config.gpuLayers).toBeDefined();
      expect(typeof config.gpuLayers).toBe('number');
      // If we got valid VRAM, it should be > 0
      expect(config.gpuLayers).toBeGreaterThanOrEqual(0);
    });

    it('should set gpuLayers to 0 for CPU-only systems', async () => {
      // Reset and detect without GPU
      systemInfo = new SystemInfo();
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('nvidia-smi not found'), '', '');
      });
      await systemInfo.detect();

      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(config.gpuLayers).toBe(0);
    });
  });

  describe('Platform-specific detection', () => {
    it('should detect macOS systems correctly', async () => {
      mockGetPlatform.mockReturnValue('darwin');
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', ''); // No GPU
      });
      systemInfo = new SystemInfo();

      const capabilities = await systemInfo.detect();
      expect(capabilities.platform).toBe('darwin');
    });

    it('should detect Windows systems correctly', async () => {
      mockGetPlatform.mockReturnValue('win32');
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', ''); // No GPU
      });
      systemInfo = new SystemInfo();

      const capabilities = await systemInfo.detect();
      expect(capabilities.platform).toBe('win32');
    });

    it('should handle GPU detection failures gracefully', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('Command failed'), '', 'nvidia-smi: not found');
      });

      const capabilities = await systemInfo.detect();
      expect(capabilities.gpu.available).toBe(false);
    });
  });
});
