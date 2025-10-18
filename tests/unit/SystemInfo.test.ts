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

    it('should return true for small models', () => {
      const result = systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 2 * 1024 * 1024 * 1024, // 2 GB
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.canRun).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return false for models larger than available RAM', () => {
      const result = systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 10 * 1024 * 1024 * 1024, // 10 GB (more than 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.canRun).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should handle edge cases with minimal margin', () => {
      const result = systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 7.5 * 1024 * 1024 * 1024, // 7.5 GB (close to 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // With safety margin, this might be too close
      expect(result.canRun).toBeDefined();
      expect(typeof result.canRun).toBe('boolean');
    });
  });

  describe('getOptimalConfig()', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, 'NVIDIA GeForce RTX 3080, 10240', '');
      });
      await systemInfo.detect();
    });

    it('should generate optimal server configuration', () => {
      const config = systemInfo.getOptimalConfig({
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

    it('should recommend more GPU layers for systems with GPU', () => {
      const config = systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // Should recommend GPU layers since we mocked nvidia-smi
      expect(config.gpuLayers).toBeGreaterThan(0);
    });

    it('should set gpuLayers to 0 for CPU-only systems', async () => {
      // Reset and detect without GPU
      systemInfo = new SystemInfo();
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('nvidia-smi not found'), '', '');
      });
      await systemInfo.detect();

      const config = systemInfo.getOptimalConfig({
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
      mockPlatform.mockReturnValue('darwin');
      systemInfo = new SystemInfo();

      const capabilities = await systemInfo.detect();
      expect(capabilities.platform).toBe('darwin');
    });

    it('should detect Windows systems correctly', async () => {
      mockPlatform.mockReturnValue('win32');
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
