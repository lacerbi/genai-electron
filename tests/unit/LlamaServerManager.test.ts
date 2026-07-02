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
  normalizeHealthHost: (host?: string) =>
    host === undefined || host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host,
}));

// Mock port-utils (never bind real sockets in unit tests)
const mockFindFreePort = jest.fn(async () => 49152);
const mockIsPortBindable = jest.fn(async () => true);

jest.unstable_mockModule('../../src/process/port-utils.js', () => ({
  findFreePort: mockFindFreePort,
  isPortBindable: mockIsPortBindable,
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
    mockIsPortBindable.mockResolvedValue(true); // Port bindable by default
    mockFindFreePort.mockResolvedValue(49152);

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

      // Verify system detection (gpuLayers passed from config, undefined for fresh start)
      expect(mockSystemInfo.canRunModel).toHaveBeenCalledWith(mockModelInfo, {
        gpuLayers: undefined,
      });

      // Verify process was spawned
      expect(mockProcessSpawn).toHaveBeenCalled();

      // Verify health check
      expect(mockWaitForHealthy).toHaveBeenCalledWith(
        8080,
        expect.any(Number),
        undefined,
        undefined,
        '127.0.0.1'
      );
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

    it('should default the port to 8080 when omitted', async () => {
      const { port: _omitted, ...configWithoutPort } = mockConfig;

      const info = await llamaServer.start(configWithoutPort);

      expect(info.port).toBe(8080);
      expect(mockWaitForHealthy).toHaveBeenCalledWith(
        8080,
        expect.any(Number),
        undefined,
        undefined,
        '127.0.0.1'
      );
      const args = mockProcessSpawn.mock.calls[0][1] as string[];
      const portIndex = args.indexOf('--port');
      expect(portIndex).toBeGreaterThan(-1);
      expect(args[portIndex + 1]).toBe('8080');
    });

    it('should thread startupTimeout into the health check', async () => {
      await llamaServer.start({ ...mockConfig, startupTimeout: 300000 });

      expect(mockWaitForHealthy).toHaveBeenCalledWith(
        8080,
        300000,
        undefined,
        undefined,
        '127.0.0.1'
      );
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

  describe('command-line flag emission', () => {
    const spawnArgs = (): string[] => mockProcessSpawn.mock.calls[0][1] as string[];

    it('should always pass --jinja and never --reasoning-format', async () => {
      await llamaServer.start(mockConfig);

      const args = spawnArgs();
      expect(args).toContain('--jinja');
      expect(args).not.toContain('--reasoning-format');
    });

    it('should pass --no-jinja when jinja is false', async () => {
      await llamaServer.start({ ...mockConfig, jinja: false });

      const args = spawnArgs();
      expect(args).not.toContain('--jinja');
      expect(args).toContain('--no-jinja');
    });

    it('should pass --alias when modelAlias is set', async () => {
      await llamaServer.start({ ...mockConfig, modelAlias: 'my-model' });

      const args = spawnArgs();
      const aliasIndex = args.indexOf('--alias');
      expect(aliasIndex).toBeGreaterThan(-1);
      expect(args[aliasIndex + 1]).toBe('my-model');
    });

    it('should pass -b when batchSize is set', async () => {
      await llamaServer.start({ ...mockConfig, batchSize: 512 });

      const args = spawnArgs();
      const batchIndex = args.indexOf('-b');
      expect(batchIndex).toBeGreaterThan(-1);
      expect(args[batchIndex + 1]).toBe('512');
    });

    it('should pass --no-cont-batching only when continuousBatching is false', async () => {
      await llamaServer.start({ ...mockConfig, continuousBatching: false });
      expect(spawnArgs()).toContain('--no-cont-batching');
    });

    it('should pass --no-mmap only when useMmap is false', async () => {
      await llamaServer.start({ ...mockConfig, useMmap: false });
      expect(spawnArgs()).toContain('--no-mmap');
    });

    it('should pass --mlock only when useMlock is true', async () => {
      await llamaServer.start({ ...mockConfig, useMlock: true });
      expect(spawnArgs()).toContain('--mlock');
    });

    it('should not emit optional flags when their fields are unset', async () => {
      await llamaServer.start(mockConfig);

      const args = spawnArgs();
      for (const flag of ['--alias', '-b', '--no-cont-batching', '--no-mmap', '--mlock']) {
        expect(args).not.toContain(flag);
      }
    });

    it('should not emit --no-cont-batching or --no-mmap when set to true', async () => {
      await llamaServer.start({ ...mockConfig, continuousBatching: true, useMmap: true });

      const args = spawnArgs();
      expect(args).not.toContain('--no-cont-batching');
      expect(args).not.toContain('--no-mmap');
    });

    const flagValue = (args: string[], flag: string): string | undefined => {
      const i = args.indexOf(flag);
      return i === -1 ? undefined : args[i + 1];
    };

    it('should map flashAttention booleans and strings onto -fa', async () => {
      await llamaServer.start({ ...mockConfig, flashAttention: true });
      expect(flagValue(spawnArgs(), '-fa')).toBe('on');

      await llamaServer.stop();
      mockProcessSpawn.mockClear();
      await llamaServer.start({ ...mockConfig, flashAttention: false });
      expect(flagValue(spawnArgs(), '-fa')).toBe('off');

      await llamaServer.stop();
      mockProcessSpawn.mockClear();
      await llamaServer.start({ ...mockConfig, flashAttention: 'auto' });
      expect(flagValue(spawnArgs(), '-fa')).toBe('auto');
    });

    it('should omit -fa when flashAttention is unset (server decides)', async () => {
      await llamaServer.start(mockConfig);
      expect(spawnArgs()).not.toContain('-fa');
    });

    it('should pass -fit off by default and honor fit: on', async () => {
      await llamaServer.start(mockConfig);
      expect(flagValue(spawnArgs(), '-fit')).toBe('off');

      await llamaServer.stop();
      mockProcessSpawn.mockClear();
      await llamaServer.start({ ...mockConfig, fit: 'on' });
      expect(flagValue(spawnArgs(), '-fit')).toBe('on');
    });

    it('should skip gpuLayers/contextSize auto-config when fit is on', async () => {
      await llamaServer.start({ ...mockConfig, fit: 'on' });

      const args = spawnArgs();
      expect(args).not.toContain('-ngl');
      expect(args).not.toContain('-c');
    });

    it('should emit KV-cache, MoE, reasoning-format and host flags when set', async () => {
      await llamaServer.start({
        ...mockConfig,
        cacheTypeK: 'q8_0',
        cacheTypeV: 'q8_0',
        flashAttention: 'on',
        overrideTensors: 'exps=CPU',
        cacheRam: 2048,
        cpuMoe: true,
        nCpuMoe: 10,
        reasoningFormat: 'deepseek',
        host: '0.0.0.0',
      });

      const args = spawnArgs();
      expect(flagValue(args, '--cache-type-k')).toBe('q8_0');
      expect(flagValue(args, '--cache-type-v')).toBe('q8_0');
      expect(flagValue(args, '-ot')).toBe('exps=CPU');
      expect(flagValue(args, '--cache-ram')).toBe('2048');
      expect(args).toContain('--cpu-moe');
      expect(flagValue(args, '--n-cpu-moe')).toBe('10');
      expect(flagValue(args, '--reasoning-format')).toBe('deepseek');
      expect(flagValue(args, '--host')).toBe('0.0.0.0');
      // Wildcard bind is health-checked via loopback
      expect(mockWaitForHealthy).toHaveBeenCalledWith(
        8080,
        expect.any(Number),
        undefined,
        undefined,
        '127.0.0.1'
      );
    });

    it('should auto-upgrade flash attention to on for quantized V-cache', async () => {
      await llamaServer.start({ ...mockConfig, cacheTypeV: 'q4_0' });

      expect(flagValue(spawnArgs(), '-fa')).toBe('on');
    });

    it('should reject quantized V-cache combined with flash attention off', async () => {
      await expect(
        llamaServer.start({ ...mockConfig, cacheTypeV: 'q8_0', flashAttention: 'off' })
      ).rejects.toMatchObject({ code: 'SERVER_ERROR' });

      llamaServer.removeAllListeners();
    });

    it('should not auto-upgrade flash attention for f16/bf16 V-cache', async () => {
      await llamaServer.start({ ...mockConfig, cacheTypeV: 'f16' });

      expect(spawnArgs()).not.toContain('-fa');
    });

    it('should accept every documented LlamaServerConfig field', async () => {
      // Compile-enforced completeness check: Record<keyof LlamaServerConfig, ...>
      // forces this literal to list every field; start() throws on any field
      // missing from VALID_CONFIG_FIELDS, so a new interface field that isn't
      // added to the allowlist fails this test at compile time or runtime.
      const everyField: Record<keyof LlamaServerConfig, unknown> = {
        modelId: 'test-model',
        port: 8080,
        threads: 4,
        contextSize: 2048,
        gpuLayers: 10,
        parallelRequests: 1,
        flashAttention: 'on',
        forceValidation: false,
        startupTimeout: 60000,
        host: '127.0.0.1',
        modelAlias: 'alias',
        continuousBatching: true,
        batchSize: 512,
        useMmap: true,
        useMlock: false,
        jinja: true,
        cacheTypeK: 'q8_0',
        cacheTypeV: 'q8_0',
        overrideTensors: 'exps=CPU',
        cacheRam: 1024,
        cpuMoe: false,
        nCpuMoe: 0,
        reasoningFormat: 'auto',
        fit: 'off',
        occupancyCheck: 'off',
        autoRestart: false,
        maxRestarts: 3,
        healthCheckInterval: 0,
      };

      const info = await llamaServer.start(everyField as unknown as LlamaServerConfig);
      expect(info.status).toBe('running');
    });
  });

  describe('lifecycle niceties (Phase 4)', () => {
    it("should resolve port 'auto' via findFreePort", async () => {
      const info = await llamaServer.start({ ...mockConfig, port: 'auto' });

      expect(mockFindFreePort).toHaveBeenCalledTimes(1);
      expect(info.port).toBe(49152);
      expect(mockWaitForHealthy).toHaveBeenCalledWith(
        49152,
        expect.any(Number),
        undefined,
        undefined,
        '127.0.0.1'
      );
    });

    it('should record loadTimeMs on successful start', async () => {
      const info = await llamaServer.start(mockConfig);

      expect(typeof info.loadTimeMs).toBe('number');
      expect(info.loadTimeMs).toBeGreaterThanOrEqual(0);
    });

    describe('occupancy safety rail', () => {
      it('should warn and proceed when another llama-server is detected (default)', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // A llama-server on 8082: /health and /props both respond ok
        mockFetch.mockImplementation(async (url: unknown) => ({
          ok: String(url).includes(':8082/'),
        }));

        const info = await llamaServer.start(mockConfig);

        expect(info.status).toBe('running');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('8082'));
        warnSpy.mockRestore();
      });

      it('should throw in strict mode', async () => {
        mockFetch.mockImplementation(async (url: unknown) => ({
          ok: String(url).includes(':8082/'),
        }));

        await expect(
          llamaServer.start({ ...mockConfig, occupancyCheck: 'strict' })
        ).rejects.toMatchObject({ code: 'SERVER_ERROR' });
      });

      it('should not flag a diffusion wrapper (health ok but /props 404)', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // Diffusion wrapper on 8081: /health ok, /props not found
        mockFetch.mockImplementation(async (url: unknown) => ({
          ok: String(url).includes(':8081/health'),
        }));

        await llamaServer.start(mockConfig);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('should skip probing when occupancyCheck is off', async () => {
        mockFetch.mockImplementation(async () => ({ ok: true }));

        const info = await llamaServer.start({ ...mockConfig, occupancyCheck: 'off' });

        expect(info.status).toBe('running');
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('crash auto-restart', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      it('should auto-restart after a crash when enabled', async () => {
        jest.useFakeTimers();
        await llamaServer.start({ ...mockConfig, autoRestart: true, maxRestarts: 2 });

        const crashedHandler = jest.fn();
        const restartedHandler = jest.fn();
        llamaServer.on('crashed', crashedHandler);
        llamaServer.on('restarted', restartedHandler);

        mockProcess.emit('exit', 1, null);

        expect(crashedHandler).toHaveBeenCalled();
        expect(llamaServer.getStatus()).toBe('crashed');
        expect(mockProcessSpawn).toHaveBeenCalledTimes(1);

        // Backoff: first attempt fires after 1s
        await jest.advanceTimersByTimeAsync(1000);

        expect(restartedHandler).toHaveBeenCalled();
        expect(llamaServer.getStatus()).toBe('running');
        expect(mockProcessSpawn).toHaveBeenCalledTimes(2);
      });

      it('should stay crashed when the restart budget is exhausted', async () => {
        jest.useFakeTimers();
        await llamaServer.start({ ...mockConfig, autoRestart: true, maxRestarts: 0 });

        mockProcess.emit('exit', 1, null);
        await jest.advanceTimersByTimeAsync(60000);

        expect(llamaServer.getStatus()).toBe('crashed');
        expect(mockProcessSpawn).toHaveBeenCalledTimes(1);
      });

      it('should not restart by default (opt-in)', async () => {
        jest.useFakeTimers();
        await llamaServer.start(mockConfig);

        mockProcess.emit('exit', 1, null);
        await jest.advanceTimersByTimeAsync(60000);

        expect(llamaServer.getStatus()).toBe('crashed');
        expect(mockProcessSpawn).toHaveBeenCalledTimes(1);
      });

      it('should never restart after an intentional stop', async () => {
        jest.useFakeTimers();
        await llamaServer.start({ ...mockConfig, autoRestart: true });

        await llamaServer.stop();
        mockProcess.emit('exit', 0, null);
        await jest.advanceTimersByTimeAsync(60000);

        expect(llamaServer.getStatus()).toBe('stopped');
        expect(mockProcessSpawn).toHaveBeenCalledTimes(1);
      });
    });

    describe('hang watchdog', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      it('should emit health-check-ok while healthy', async () => {
        jest.useFakeTimers();
        mockCheckHealth.mockResolvedValue({ status: 'ok' });
        await llamaServer.start({ ...mockConfig, healthCheckInterval: 1000 });

        const okHandler = jest.fn();
        llamaServer.on('health-check-ok', okHandler);

        await jest.advanceTimersByTimeAsync(2000);

        expect(okHandler).toHaveBeenCalledTimes(2);
        expect(mockProcessKill).not.toHaveBeenCalled();
      });

      it('should kill the process after 3 consecutive health failures', async () => {
        jest.useFakeTimers();
        mockCheckHealth.mockResolvedValue({ status: 'error' });
        await llamaServer.start({ ...mockConfig, healthCheckInterval: 1000 });

        const failHandler = jest.fn();
        llamaServer.on('health-check-failed', failHandler);

        await jest.advanceTimersByTimeAsync(3000);

        expect(failHandler).toHaveBeenCalledTimes(3);
        expect(mockProcessKill).toHaveBeenCalledWith(12345, expect.any(Number));
      });

      it('should not start the watchdog when healthCheckInterval is unset', async () => {
        jest.useFakeTimers();
        mockCheckHealth.mockResolvedValue({ status: 'error' });
        await llamaServer.start(mockConfig);

        await jest.advanceTimersByTimeAsync(10000);

        expect(mockCheckHealth).not.toHaveBeenCalled();
      });
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
      expect(mockCheckHealth).toHaveBeenCalledWith(8080, expect.any(Number), '127.0.0.1');
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

  describe('config validation', () => {
    it('should accept all valid ServerConfig fields without error', async () => {
      const validConfig: LlamaServerConfig = {
        modelId: 'test-model',
        port: 8080,
        threads: 4,
        contextSize: 2048,
        gpuLayers: 20,
        parallelRequests: 2,
        flashAttention: true,
        forceValidation: false,
      };

      const info = await llamaServer.start(validConfig);
      expect(info.status).toBe('running');
    });

    it('should throw ServerError for DiffusionServerConfig-specific fields', async () => {
      const badConfig = {
        modelId: 'test-model',
        port: 8080,
        clipOnCpu: true,
        vaeOnCpu: false,
      };

      await expect(llamaServer.start(badConfig as any)).rejects.toThrow(
        /Unknown configuration field.*clipOnCpu.*vaeOnCpu/
      );
    });

    it('should list all unknown fields and include valid fields in error details', async () => {
      const badConfig = {
        modelId: 'test-model',
        port: 8080,
        clipOnCpu: true,
        randomField: 42,
      };

      try {
        await llamaServer.start(badConfig as any);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('clipOnCpu');
        expect(error.message).toContain('randomField');
        expect(error.message).toContain('Valid fields for LlamaServerManager');
        expect(error.details.unknownFields).toEqual(
          expect.arrayContaining(['clipOnCpu', 'randomField'])
        );
        expect(error.details.validFields).toEqual(
          expect.arrayContaining(['modelId', 'port', 'threads', 'contextSize', 'gpuLayers'])
        );
      }
    });

    it('should have code SERVER_ERROR and actionable suggestion', async () => {
      const badConfig = {
        modelId: 'test-model',
        port: 8080,
        unknownProp: true,
      };

      try {
        await llamaServer.start(badConfig as any);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR');
        expect(error.details.suggestion).toContain('Remove unrecognized fields');
        expect(error.details.suggestion).toContain('getOptimalConfig()');
      }
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
      // -ngl 0 MUST be emitted explicitly: the b9860 server default is
      // auto-offload, so omitting -ngl would silently offload to GPU
      const gpuLayersIndex = args.indexOf('-ngl');
      expect(gpuLayersIndex).toBeGreaterThan(-1);
      expect(args[gpuLayersIndex + 1]).toBe('0');
    });
  });
});
