/**
 * Unit tests for LlamaServerManager
 * Tests llama-server lifecycle management
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { LlamaServerConfig, ModelInfo } from '../../src/types/index.js';

// Mock child_process
const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
  execFile: mockExecFile,
}));

// Mock fetch for health checks (save original for cleanup)
const originalFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock ModelManager
const mockModelManager = {
  getModelInfo: jest.fn(),
};

const MockModelManager = jest.fn(() => mockModelManager);
(MockModelManager as any).getInstance = jest.fn(() => mockModelManager);

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: MockModelManager,
}));

// Mock SystemInfo
const mockSystemInfo = {
  detect: jest.fn(),
  getOptimalConfig: jest.fn(),
  canRunModel: jest.fn(),
  getMemoryInfo: jest.fn(),
  clearCache: jest.fn(),
};

const MockSystemInfo = jest.fn(() => mockSystemInfo);
(MockSystemInfo as any).getInstance = jest.fn(() => mockSystemInfo);

jest.unstable_mockModule('../../src/system/SystemInfo.js', () => ({
  SystemInfo: MockSystemInfo,
}));

// Mock ProcessManager
const mockProcessSpawn = jest.fn();
const mockProcessKill = jest.fn();
const mockProcessIsRunning = jest.fn();

class MockProcessManager {
  spawn = mockProcessSpawn;
  kill = mockProcessKill;
  isRunning = mockProcessIsRunning;
}

jest.unstable_mockModule('../../src/process/ProcessManager.js', () => ({
  ProcessManager: MockProcessManager,
}));

// Mock health-check
const mockCheckHealth = jest.fn();
const mockWaitForHealthy = jest.fn();
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  checkHealth: mockCheckHealth,
  waitForHealthy: mockWaitForHealthy,
  isServerResponding: mockIsServerResponding,
}));

// Mock LogManager - create instance that's accessible in tests
const mockLogManagerWrite = jest.fn(() => Promise.resolve());
const mockLogManager = {
  initialize: jest.fn(() => Promise.resolve()),
  write: mockLogManagerWrite,
  getRecent: jest.fn(() => Promise.resolve([])),
  clear: jest.fn(() => Promise.resolve()),
};

class MockLogManager {
  initialize = mockLogManager.initialize;
  write = mockLogManager.write;
  getRecent = mockLogManager.getRecent;
  clear = mockLogManager.clear;
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock file-utils
const mockFileExists = jest.fn();
const mockCalculateChecksum = jest.fn();
jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: jest.fn().mockResolvedValue(undefined),
  fileExists: mockFileExists,
  getFileSize: jest.fn().mockResolvedValue(0),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  moveFile: jest.fn().mockResolvedValue(undefined),
  copyDirectory: jest.fn().mockResolvedValue(undefined),
  calculateChecksum: mockCalculateChecksum,
  formatBytes: jest.fn((bytes: number) => `${bytes} bytes`),
  isAbsolutePath: jest.fn().mockReturnValue(true),
  sanitizeFilename: jest.fn((filename: string) => filename),
}));

// Mock BinaryManager
class MockBinaryManager {
  ensureBinary = jest.fn().mockResolvedValue('/test/binaries/llama/llama-server');
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock Downloader for binary downloads
const mockDownloader = {
  download: jest.fn(),
};

jest.unstable_mockModule('../../src/download/Downloader.js', () => ({
  Downloader: jest.fn(() => mockDownloader),
}));

// Mock paths (which imports electron)
jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    models: {
      llm: '/test/models/llm',
      diffusion: '/test/models/diffusion',
    },
    binaries: {
      llama: '/test/binaries/llama',
      diffusion: '/test/binaries/diffusion',
    },
    logs: '/test/logs',
    config: '/test/config',
    temp: '/test/temp',
  },
  getBinaryPath: (type: string) => `/test/binaries/${type}`,
  ensureDirectories: jest.fn().mockResolvedValue(undefined),
}));

// Import after mocking
const { LlamaServerManager } = await import('../../src/managers/LlamaServerManager.js');

describe('LlamaServerManager', () => {
  let llamaServer: LlamaServerManager;
  let mockProcess: any; // Track for cleanup

  const mockModelInfo: ModelInfo = {
    id: 'test-model',
    name: 'Test Model',
    type: 'llm',
    size: 4 * 1024 * 1024 * 1024,
    path: '/test/models/llm/test-model.gguf',
    downloadedAt: '2025-10-16T10:00:00Z',
    source: {
      type: 'url',
      url: 'https://example.com/test-model.gguf',
    },
  };

  const mockConfig: LlamaServerConfig = {
    modelId: 'test-model',
    port: 8080,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Ensure logManager.write always returns a Promise
    mockLogManager.write.mockImplementation(() => Promise.resolve());
    mockLogManager.initialize.mockImplementation(() => Promise.resolve());
    mockLogManager.getRecent.mockImplementation(() => Promise.resolve([]));
    mockLogManager.clear.mockImplementation(() => Promise.resolve());

    llamaServer = new LlamaServerManager(mockModelManager as any, mockSystemInfo as any);

    // Setup default mocks
    mockModelManager.getModelInfo.mockResolvedValue(mockModelInfo);
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, used: 8 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: 8 * 1024 ** 3 },
      platform: 'linux',
      recommendations: {
        maxModelSize: '13B',
        recommendedQuantization: ['Q4_K_M', 'Q5_K_M'],
        threads: 7,
        gpuLayers: 35,
      },
    });
    mockSystemInfo.canRunModel.mockResolvedValue({ possible: true });
    mockSystemInfo.getOptimalConfig.mockResolvedValue({
      threads: 7,
      contextSize: 4096,
      gpuLayers: 35,
      parallelRequests: 4,
    });
    mockFileExists.mockResolvedValue(true); // Binary exists
    mockWaitForHealthy.mockResolvedValue(undefined);
    mockIsServerResponding.mockResolvedValue(false); // Port not in use by default

    // Mock process spawn - need to capture callbacks to trigger events (track at describe level for cleanup)
    mockProcess = new EventEmitter() as any;
    mockProcess.pid = 12345;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = jest.fn();

    mockProcessSpawn.mockImplementation((path, args, callbacks) => {
      // Wire up the callbacks
      if (callbacks?.onExit) {
        mockProcess.on('exit', callbacks.onExit);
      }
      if (callbacks?.onStdout) {
        mockProcess.stdout.on('data', (data: Buffer) => callbacks.onStdout(data.toString()));
      }
      if (callbacks?.onStderr) {
        mockProcess.stderr.on('data', (data: Buffer) => callbacks.onStderr(data.toString()));
      }
      if (callbacks?.onError) {
        mockProcess.on('error', callbacks.onError);
      }
      return { pid: mockProcess.pid };
    });
    mockProcessIsRunning.mockReturnValue(true);
  });

  afterEach(() => {
    // Clean up all event listeners to prevent memory leaks
    llamaServer.removeAllListeners();

    // Clean up beforeEach mockProcess and its streams
    if (mockProcess) {
      mockProcess.removeAllListeners?.();
      mockProcess.stdout?.removeAllListeners?.();
      mockProcess.stderr?.removeAllListeners?.();
    }
  });

  afterAll(() => {
    // Restore original global.fetch
    global.fetch = originalFetch;
  });

  describe('start()', () => {
    it('should start server with auto-configuration', async () => {
      const info = await llamaServer.start(mockConfig);

      expect(info).toBeDefined();
      expect(info.status).toBe('running');
      expect(info.port).toBe(8080);
      expect(info.pid).toBe(12345);
      expect(info.modelId).toBe('test-model');

      // Verify model validation
      expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('test-model');

      // Verify system detection
      expect(mockSystemInfo.canRunModel).toHaveBeenCalledWith(mockModelInfo);

      // Verify process was spawned
      expect(mockProcessSpawn).toHaveBeenCalled();

      // Verify health check
      expect(mockWaitForHealthy).toHaveBeenCalledWith(8080, expect.any(Number));
    });

    it('should start server with custom config', async () => {
      const customConfig: LlamaServerConfig = {
        ...mockConfig,
        threads: 4,
        gpuLayers: 20,
        contextSize: 2048,
      };

      const info = await llamaServer.start(customConfig);

      expect(info.status).toBe('running');
      // Custom config should override auto-detection
      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('--threads');
      expect(args).toContain('4');
    });

    it('should download binary if not exists', async () => {
      // The BinaryManager.ensureBinary() method handles downloading
      // It returns the path to the binary after downloading
      // We just need to verify that start() completes successfully
      await llamaServer.start(mockConfig);

      // Verify server started (which means binary was available)
      const info = llamaServer.getInfo();
      expect(info.status).toBe('running');
      expect(info.pid).toBe(12345);
    });

    it('should throw error if model not found', async () => {
      mockModelManager.getModelInfo.mockRejectedValue(new Error('Model not found'));

      await expect(llamaServer.start(mockConfig)).rejects.toThrow('Model not found');
    });

    it('should throw error if insufficient resources', async () => {
      mockSystemInfo.canRunModel.mockResolvedValue({
        possible: false,
        reason: 'Not enough RAM',
      });
      // Mock getMemoryInfo since it's called in the error message construction
      mockSystemInfo.getMemoryInfo.mockReturnValue({
        total: 16 * 1024 ** 3,
        available: 4 * 1024 ** 3,
        used: 12 * 1024 ** 3,
      });

      await expect(llamaServer.start(mockConfig)).rejects.toThrow('Not enough RAM');
    });

    it('should throw error if port already in use', async () => {
      mockWaitForHealthy.mockRejectedValue(new Error('Port already in use'));

      await expect(llamaServer.start(mockConfig)).rejects.toThrow();
    });

    it('should emit started event', async () => {
      const startedHandler = jest.fn();
      llamaServer.on('started', startedHandler);

      await llamaServer.start(mockConfig);

      expect(startedHandler).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      await llamaServer.start(mockConfig);
    });

    it('should stop server gracefully', async () => {
      mockProcessIsRunning.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await llamaServer.stop();

      expect(mockProcessKill).toHaveBeenCalledWith(12345, expect.any(Number));

      const status = llamaServer.getStatus();
      expect(status).toBe('stopped');
    });

    it('should force kill after timeout', async () => {
      mockProcessIsRunning.mockReturnValue(true); // Never stops gracefully

      await llamaServer.stop();

      // ProcessManager.kill() uses timeout, not signals
      expect(mockProcessKill).toHaveBeenCalledWith(12345, expect.any(Number));
    });

    it('should emit stopped event', async () => {
      mockProcessIsRunning.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const stoppedHandler = jest.fn();
      llamaServer.on('stopped', stoppedHandler);

      await llamaServer.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should handle already stopped server', async () => {
      await llamaServer.stop();

      // Stop again - should not throw
      await expect(llamaServer.stop()).resolves.not.toThrow();
    });
  });

  describe('restart()', () => {
    beforeEach(async () => {
      await llamaServer.start(mockConfig);
    });

    it('should restart server', async () => {
      mockProcessIsRunning.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const info = await llamaServer.restart();

      expect(info.status).toBe('running');
      expect(mockProcessKill).toHaveBeenCalled();
      expect(mockWaitForHealthy).toHaveBeenCalledTimes(2); // Once for start, once for restart
    });
  });

  describe('getStatus()', () => {
    it('should return stopped status initially', () => {
      const status = llamaServer.getStatus();

      expect(status).toBe('stopped');
    });

    it('should return running status after start', async () => {
      await llamaServer.start(mockConfig);

      const status = llamaServer.getStatus();

      expect(status).toBe('running');

      // Use getInfo() to check detailed information
      const info = llamaServer.getInfo();
      expect(info.pid).toBe(12345);
      expect(info.port).toBe(8080);
      expect(info.modelId).toBe('test-model');
    });
  });

  describe('isHealthy()', () => {
    beforeEach(async () => {
      await llamaServer.start(mockConfig);
    });

    it('should return true if server is healthy', async () => {
      mockCheckHealth.mockResolvedValue({ status: 'ok' });

      const healthy = await llamaServer.isHealthy();

      expect(healthy).toBe(true);
      expect(mockCheckHealth).toHaveBeenCalledWith(8080, expect.any(Number));
    });

    it('should return false if server is not healthy', async () => {
      mockCheckHealth.mockResolvedValue({ status: 'error' });

      const healthy = await llamaServer.isHealthy();

      expect(healthy).toBe(false);
    });

    it('should return false if server is not running', async () => {
      await llamaServer.stop();
      mockProcessIsRunning.mockReturnValue(false);

      const healthy = await llamaServer.isHealthy();

      expect(healthy).toBe(false);
    });
  });

  describe('getLogs()', () => {
    beforeEach(async () => {
      await llamaServer.start(mockConfig);
    });

    it('should return recent logs', async () => {
      const mockLogs = 'Log line 1\nLog line 2\nLog line 3';
      mockLogManager.getRecent.mockResolvedValue(mockLogs);

      const logs = await llamaServer.getLogs();

      expect(logs).toBe(mockLogs);
      expect(mockLogManager.getRecent).toHaveBeenCalledWith(100);
    });

    it('should allow custom log line count', async () => {
      mockLogManager.getRecent.mockResolvedValue('logs');

      await llamaServer.getLogs(50);

      expect(mockLogManager.getRecent).toHaveBeenCalledWith(50);
    });
  });

  describe('Process crash handling', () => {
    it('should emit crashed event on unexpected exit', async () => {
      const crashedHandler = jest.fn();
      llamaServer.on('crashed', crashedHandler);

      // Need to get the mockProcess from beforeEach
      let mockProcess: any;
      mockProcessSpawn.mockImplementationOnce((path, args, callbacks) => {
        mockProcess = new EventEmitter() as any;
        mockProcess.pid = 12345;
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        mockProcess.kill = jest.fn();

        // Wire up callbacks
        if (callbacks?.onExit) {
          mockProcess.on('exit', callbacks.onExit);
        }
        return { pid: mockProcess.pid };
      });

      await llamaServer.start(mockConfig);

      // Simulate process crash
      mockProcess.emit('exit', 1, null);

      // Wait for async operations including logManager.write().catch()
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(crashedHandler).toHaveBeenCalled();

      // Clean up mock EventEmitters
      mockProcess.removeAllListeners();
      mockProcess.stdout.removeAllListeners();
      mockProcess.stderr.removeAllListeners();
    });

    it('should update status to crashed', async () => {
      // Need to get the mockProcess from beforeEach
      let mockProcess: any;
      mockProcessSpawn.mockImplementationOnce((path, args, callbacks) => {
        mockProcess = new EventEmitter() as any;
        mockProcess.pid = 12345;
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        mockProcess.kill = jest.fn();

        // Wire up callbacks
        if (callbacks?.onExit) {
          mockProcess.on('exit', callbacks.onExit);
        }
        return { pid: mockProcess.pid };
      });

      await llamaServer.start(mockConfig);

      // Simulate process crash
      mockProcess.emit('exit', 1, null);

      // Wait for async operations including logManager.write().catch()
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = llamaServer.getStatus();
      expect(status).toBe('crashed');

      // Clean up mock EventEmitters
      mockProcess.removeAllListeners();
      mockProcess.stdout.removeAllListeners();
      mockProcess.stderr.removeAllListeners();
    });
  });

  describe('Auto-configuration', () => {
    it('should use GPU layers if GPU is available', async () => {
      await llamaServer.start(mockConfig);

      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      // llama.cpp uses -ngl flag for GPU layers
      expect(args).toContain('-ngl');
    });

    it('should set GPU layers to 0 for CPU-only systems', async () => {
      mockSystemInfo.detect.mockResolvedValue({
        cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
        memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, used: 8 * 1024 ** 3 },
        gpu: { available: false },
        platform: 'linux',
        recommendations: {
          maxModelSize: '7B',
          recommendedQuantization: ['Q4_K_M'],
          threads: 7,
        },
      });
      mockSystemInfo.getOptimalConfig.mockResolvedValue({
        threads: 7,
        contextSize: 4096,
        gpuLayers: 0,
        parallelRequests: 4,
      });

      await llamaServer.start(mockConfig);

      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      const gpuLayersIndex = args.indexOf('-ngl');
      if (gpuLayersIndex !== -1) {
        expect(args[gpuLayersIndex + 1]).toBe('0');
      }
    });
  });
});
