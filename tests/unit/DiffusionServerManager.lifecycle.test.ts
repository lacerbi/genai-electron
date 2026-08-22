/**
 * Unit tests for DiffusionServerManager lifecycle
 *
 * Covers the HTTP wrapper's start/stop, the config allowlist, and the internal
 * `sd-server` backend state machine (spawn/reuse/release/crash/idle timeout).
 * Route-level behaviour lives in DiffusionServerManager.routes.test.ts and job/progress
 * behaviour in DiffusionServerManager.generation.test.ts.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type {
  DiffusionBackendStatusEvent,
  DiffusionServerConfig,
  ModelInfo,
} from '../../src/types/index.js';

// Backend seam: the manager drives `sd-server` through the runner + client pair, so
// the tests assert against those module boundaries (never a raw child process).
// Imported statically so its unstable_mockModule registrations run before the
// dynamic import of the manager below.
import {
  COMPLETED_JOB,
  MockSdServerClient,
  createSdServerHandle,
  handles,
  mockGetJob,
  mockStartSdServerRunner,
  mockSubmitImageJob,
  resetSdServerMocks,
  sdServerClientArgs,
  sdServerTerminationUnconfirmedError,
  sdServerReadyTimeoutError,
  setStopObserver,
} from './helpers/sd-server-mocks.js';

// Mock Electron app
const mockApp = {
  getPath: jest.fn((name: string) => {
    if (name === 'userData') return '/test/userData';
    return '/test';
  }),
};

jest.unstable_mockModule('electron', () => ({
  app: mockApp,
}));

// Mock http module. `listen` now takes (port, host, callback) — the wrapper binds
// loopback-only by default.
const mockHttpServer = new EventEmitter() as any;
const resetHttpServerMocks = (): void => {
  mockHttpServer.listen = jest
    .fn()
    .mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback();
      return mockHttpServer;
    });
  // close() is also called without a callback (startup-error cleanup)
  mockHttpServer.close = jest.fn().mockImplementation((callback?: () => void) => {
    callback?.();
  });
};
resetHttpServerMocks();

const mockCreateServer = jest.fn().mockReturnValue(mockHttpServer);

jest.unstable_mockModule('node:http', () => {
  const httpModule = {
    createServer: mockCreateServer,
  };
  return {
    default: httpModule,
    ...httpModule,
  };
});

// Mock ModelManager
const mockModelManager = {
  getModelInfo: jest.fn(),
};

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: {
    getInstance: jest.fn(() => mockModelManager),
  },
}));

// Mock SystemInfo
const mockSystemInfo = {
  detect: jest.fn(),
  canRunModel: jest.fn(),
  getMemoryInfo: jest.fn(),
  getGPUInfo: jest.fn(),
  clearCache: jest.fn(),
};

jest.unstable_mockModule('../../src/system/SystemInfo.js', () => ({
  SystemInfo: {
    getInstance: jest.fn(() => mockSystemInfo),
  },
}));

// Mock LogManager
const mockLogInitialize = jest.fn();
const mockLogWrite = jest.fn();
const mockLogGetRecent = jest.fn();
const mockLogClear = jest.fn();

class MockLogManager {
  initialize = mockLogInitialize;
  write = mockLogWrite;
  getRecent = mockLogGetRecent;
  clear = mockLogClear;
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock BinaryManager
const mockEnsureBinary = jest.fn();
const mockBinaryConfigs: any[] = [];

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
  constructor(config: any) {
    mockBinaryConfigs.push(config);
  }
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock health-check (normalizeHealthHost keeps its real mapping so the wildcard-bind
// assertion is meaningful)
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  isServerResponding: mockIsServerResponding,
  checkHealth: jest.fn(),
  waitForHealthy: jest.fn(),
  normalizeHealthHost: (host?: string) => {
    if (host === '::') return '::1';
    if (host === undefined || host === '' || host === '0.0.0.0') return '127.0.0.1';
    return host;
  },
  formatHttpHost: (host: string) =>
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host,
}));

// Mock port-utils (never bind real sockets in unit tests)
const mockFindFreePort = jest.fn(async () => 49999);
const mockIsPortBindable = jest.fn(async () => true);

jest.unstable_mockModule('../../src/process/port-utils.js', () => ({
  findFreePort: mockFindFreePort,
  isPortBindable: mockIsPortBindable,
}));

// Mock file-utils
const mockEnsureDirectory = jest.fn(async () => undefined);
const mockDeleteFile = jest.fn(async () => undefined);
const mockFileExists = jest.fn(async () => true);

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: mockEnsureDirectory,
  deleteFile: mockDeleteFile,
  fileExists: mockFileExists,
  getFileSize: jest.fn(),
  moveFile: jest.fn(),
  copyDirectory: jest.fn(),
  calculateChecksum: jest.fn(),
  formatBytes: jest.fn(),
  isAbsolutePath: jest.fn(),
  sanitizeFilename: jest.fn(),
}));

// Mock paths (the backend needs PATHS.loras and the binary path helper)
const mockGetTempPath = jest.fn((filename: string) => `/test/temp/${filename}`);
const mockGetBinaryPath = jest.fn(
  (type: string, binaryName: string) => `/test/binaries/${type}/${binaryName}`
);

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  BASE_DIR: '/test/userData',
  PATHS: {
    models: { llm: '/test/models/llm', diffusion: '/test/models/diffusion' },
    binaries: { llama: '/test/binaries/llama', diffusion: '/test/binaries/diffusion' },
    logs: '/test/logs',
    config: '/test/config',
    temp: '/test/temp',
    loras: '/test/loras',
  },
  getBinaryPath: mockGetBinaryPath,
  getTempPath: mockGetTempPath,
  getModelFilePath: jest.fn(),
  getModelDirectory: jest.fn(),
  ensureDirectories: jest.fn(),
}));

// Import after mocking
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');
const { DIFFUSION_BACKEND_DEFAULTS } = await import('../../src/config/defaults.js');
const { ServerError } = await import('../../src/errors/index.js');

type Manager = InstanceType<typeof DiffusionServerManager>;

const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('DiffusionServerManager (lifecycle)', () => {
  let diffusionServer: Manager;

  const mockModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 * 1024 * 1024,
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-turbo.gguf' },
  };

  const fluxKleinModelInfo: ModelInfo = {
    id: 'flux-2-klein',
    name: 'Flux 2 Klein',
    type: 'diffusion',
    size: 7.1 * 1024 ** 3,
    path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/flux-2-klein.gguf' },
    components: {
      diffusion_model: {
        path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
        size: 4.3 * 1024 ** 3,
      },
      llm: {
        path: '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf',
        size: 2.5 * 1024 ** 3,
      },
      vae: {
        path: '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors',
        size: 335 * 1024 ** 2,
      },
    },
  };

  /** Server config with fully explicit offload flags (no auto-detection noise) */
  const explicitFlagsConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
    clipOnCpu: true,
    vaeOnCpu: false,
    offloadToCpu: false,
    diffusionFlashAttention: true,
  };

  const mockConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
  };

  /** Collect every 'backend-status' payload emitted by a manager. */
  const recordBackendEvents = (server: Manager): DiffusionBackendStatusEvent[] => {
    const events: DiffusionBackendStatusEvent[] = [];
    server.on('backend-status', (event: DiffusionBackendStatusEvent) => {
      events.push(event);
    });
    return events;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetSdServerMocks();
    mockBinaryConfigs.length = 0;

    mockLogInitialize.mockResolvedValue(undefined);
    mockLogWrite.mockResolvedValue(undefined);
    mockLogGetRecent.mockResolvedValue([]);
    mockLogClear.mockResolvedValue(undefined);
    mockEnsureBinary.mockResolvedValue('/test/binaries/diffusion/sd-server');
    mockCreateServer.mockReturnValue(mockHttpServer);
    resetHttpServerMocks();
    mockEnsureDirectory.mockResolvedValue(undefined);

    diffusionServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

    mockModelManager.getModelInfo.mockResolvedValue(mockModelInfo);
    mockSystemInfo.canRunModel.mockResolvedValue({ possible: true });
    mockSystemInfo.getMemoryInfo.mockReturnValue({
      total: 16 * 1024 ** 3,
      available: 10 * 1024 ** 3,
      used: 6 * 1024 ** 3,
    });
    mockSystemInfo.getGPUInfo.mockResolvedValue({
      available: true,
      type: 'nvidia',
      vram: 8 * 1024 ** 3,
    });
    mockIsServerResponding.mockResolvedValue(false);
    mockIsPortBindable.mockResolvedValue(true);
    mockFindFreePort.mockResolvedValue(49999);
  });

  afterEach(() => {
    // Any generation left in flight owns a poll loop; killing its backend makes that
    // loop reject on its next turn instead of polling into the following test
    for (const handle of handles) handle.emitExit({ code: 0, signal: null });
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
  });

  describe('start()', () => {
    it('binds the HTTP wrapper to 127.0.0.1 by default', async () => {
      const info = await diffusionServer.start(mockConfig);

      expect(info.status).toBe('running');
      expect(info.port).toBe(8081);
      expect(info.modelId).toBe('sdxl-turbo');
      expect(mockHttpServer.listen).toHaveBeenCalledWith(8081, '127.0.0.1', expect.any(Function));
      expect(mockSystemInfo.canRunModel).toHaveBeenCalledWith(mockModelInfo, {
        checkTotalMemory: true,
      });
    });

    it('honours an explicit host and probes it through a loopback address', async () => {
      await diffusionServer.start({ ...mockConfig, host: '0.0.0.0' });

      // Raw host at the bind...
      expect(mockHttpServer.listen).toHaveBeenCalledWith(8081, '0.0.0.0', expect.any(Function));
      // ...normalized host for the availability probes
      expect(mockIsServerResponding).toHaveBeenCalledWith(8081, 2000, '127.0.0.1');
      expect(mockIsPortBindable).toHaveBeenCalledWith(8081, '127.0.0.1');
    });

    it("resolves port 'auto' exactly once via findFreePort(host)", async () => {
      const info = await diffusionServer.start({ ...mockConfig, port: 'auto', host: '0.0.0.0' });

      expect(mockFindFreePort).toHaveBeenCalledTimes(1);
      expect(mockFindFreePort).toHaveBeenCalledWith('0.0.0.0');
      expect(info.port).toBe(49999);
      expect(mockHttpServer.listen).toHaveBeenCalledWith(49999, '0.0.0.0', expect.any(Function));
    });

    it('never spawns the backend (no VRAM is held by start())', async () => {
      await diffusionServer.start(mockConfig);

      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
      expect(diffusionServer.getInfo().pid).toBeUndefined();
    });

    it('validates the binary as sd-server with production-resolved offload flags', async () => {
      await diffusionServer.start({ ...explicitFlagsConfig, threads: 3, batchSize: 4 });

      expect(mockBinaryConfigs.at(-1)).toMatchObject({
        binaryName: 'sd-server',
        testOptimizationArgs: ['--clip-on-cpu', '--diffusion-fa'],
      });
    });

    it('emits started and initializes the log manager', async () => {
      const startedHandler = jest.fn();
      diffusionServer.on('started', startedHandler);

      await diffusionServer.start(mockConfig);

      expect(startedHandler).toHaveBeenCalled();
      expect(mockLogInitialize).toHaveBeenCalled();
      expect(mockLogWrite).toHaveBeenCalledWith(
        expect.stringContaining('Starting diffusion server on 127.0.0.1:8081'),
        'info'
      );
    });

    it('throws ModelNotFoundError if the model is not a diffusion model', async () => {
      mockModelManager.getModelInfo.mockResolvedValue({ ...mockModelInfo, type: 'llm' });

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow(
        'Model sdxl-turbo is not a diffusion model'
      );
    });

    it('throws PortInUseError if the port is already in use', async () => {
      mockIsServerResponding.mockResolvedValue(true);

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('Port 8081');
    });

    it('throws if already running', async () => {
      await diffusionServer.start(mockConfig);

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('already running');
    });
  });

  describe('config validation', () => {
    it('accepts every DiffusionServerConfig field, including the backend ones', async () => {
      const validConfig: DiffusionServerConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        host: '127.0.0.1',
        startupTimeout: 90_000,
        usageMode: 'burst',
        idleTimeoutMs: 0,
        threads: 4,
        gpuLayers: 20,
        forceValidation: false,
        clipOnCpu: true,
        vaeOnCpu: false,
        batchSize: 4,
        offloadToCpu: true,
        diffusionFlashAttention: true,
      };

      const info = await diffusionServer.start(validConfig);
      expect(info.status).toBe('running');
    });

    it('rejects unknown fields and lists the valid ones', async () => {
      const badConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        contextSize: 4096,
        flashAttention: true,
      };

      try {
        await diffusionServer.start(badConfig as any);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR');
        expect(error.message).toContain('contextSize');
        expect(error.message).toContain('flashAttention');
        expect(error.details.unknownFields).toEqual(
          expect.arrayContaining(['contextSize', 'flashAttention'])
        );
        expect(error.details.validFields).toEqual(
          expect.arrayContaining(['host', 'startupTimeout', 'usageMode', 'idleTimeoutMs'])
        );
      }
    });
  });

  describe('backend spawn', () => {
    it('launches sd-server with model, offload, thread and lora arguments', async () => {
      await diffusionServer.start({
        ...explicitFlagsConfig,
        threads: 3,
        startupTimeout: 45_000,
      });

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      expect(handles[0]!.launch).toMatchObject({
        binaryPath: '/test/binaries/diffusion/sd-server',
        modelArgs: ['-m', mockModelInfo.path],
        contextArgs: ['--clip-on-cpu', '--diffusion-fa'],
        threads: 3,
        loraDir: '/test/loras',
        readyTimeoutMs: 45_000,
      });
      // The lora directory is created by the manager (Electron side)
      expect(mockEnsureDirectory).toHaveBeenCalledWith('/test/loras');
      // The client is bound to the backend's own ephemeral port
      expect(sdServerClientArgs.at(-1)).toEqual({ port: 51234, host: '127.0.0.1' });
    });

    it('emits component flags in DIFFUSION_COMPONENT_ORDER for multi-component models', async () => {
      mockModelManager.getModelInfo.mockResolvedValue(fluxKleinModelInfo);
      await diffusionServer.start({ ...explicitFlagsConfig, modelId: 'flux-2-klein' });

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      const modelArgs = handles[0]!.launch.modelArgs as string[];
      expect(modelArgs).toEqual([
        '--diffusion-model',
        fluxKleinModelInfo.components!.diffusion_model!.path,
        '--llm',
        fluxKleinModelInfo.components!.llm!.path,
        '--vae',
        fluxKleinModelInfo.components!.vae!.path,
      ]);
    });

    it('reuses the resident backend when the resolved flags are unchanged', async () => {
      await diffusionServer.start(explicitFlagsConfig);

      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      await diffusionServer.executeImageGeneration({ prompt: 'two' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('releases and respawns when the offload flags change', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const events = recordBackendEvents(diffusionServer);

      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      await diffusionServer.executeImageGeneration(
        { prompt: 'two' },
        {
          clipOnCpu: false,
          vaeOnCpu: false,
          offloadToCpu: true,
          diffusionFlashAttention: false,
        }
      );

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[1]!.launch.contextArgs).toEqual(['--offload-to-cpu']);
      expect(events.some((event) => event.reason === 'flags-changed')).toBe(true);
    });

    it('reports the backend lifecycle through backend-status events', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const events = recordBackendEvents(diffusionServer);

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      expect(events.map((event) => `${event.previous}->${event.state}:${event.reason}`)).toEqual([
        'absent->starting:spawned',
        'starting->ready:ready',
        'ready->busy:job',
        'busy->ready:job',
      ]);
    });

    it('refuses to spawn while the wrapper is stopped', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      await diffusionServer.stop();

      await expect(diffusionServer.executeImageGeneration({ prompt: 'test' })).rejects.toThrow(
        'not running'
      );
      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
    });

    it('refuses to spawn while the wrapper is stopping', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      (diffusionServer as any)._status = 'stopping';

      await expect(diffusionServer.executeImageGeneration({ prompt: 'test' })).rejects.toThrow(
        'not running'
      );
      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
    });

    it('spawns during calibration even though the wrapper is stopped', async () => {
      // calibrate() runs with the wrapper stopped; the exclusivity flag is the gate
      (diffusionServer as any).currentModelInfo = mockModelInfo;
      (diffusionServer as any).binaryPath = '/test/binaries/diffusion/sd-server';
      (diffusionServer as any)._config = explicitFlagsConfig;
      (diffusionServer as any).calibrating = true;

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      await diffusionServer.releaseBackend({ reason: 'calibration' });
    });
  });

  describe('releaseBackend()', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('is a no-op when no backend is resident', async () => {
      const events = recordBackendEvents(diffusionServer);

      await diffusionServer.releaseBackend({ reason: 'explicit' });

      expect(events).toEqual([]);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
    });

    it("sets the backend state to 'stopping' BEFORE killing the child", async () => {
      setStopObserver(() => diffusionServer.getBackendInfo().state);
      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      await diffusionServer.releaseBackend({ reason: 'explicit' });

      expect(handles[0]!.stateAtStop).toBe('stopping');
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    });

    it('is idempotent and never kills twice', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      await Promise.all([
        diffusionServer.releaseBackend({ reason: 'explicit' }),
        diffusionServer.releaseBackend({ reason: 'explicit' }),
      ]);
      await diffusionServer.releaseBackend({ reason: 'explicit' });

      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
    });

    it('does not report an intentional kill as a crash', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      const events = recordBackendEvents(diffusionServer);
      const crashed = jest.fn();
      diffusionServer.on('crashed', crashed);

      await diffusionServer.releaseBackend({ reason: 'explicit' });
      // The exit callback of the killed child fires after stop() resolves
      await new Promise((resolve) => setImmediate(resolve));

      expect(events.map((event) => event.reason)).toEqual(['explicit', 'explicit']);
      expect(events.some((event) => event.reason === 'crashed')).toBe(false);
      expect(crashed).not.toHaveBeenCalled();
    });

    it('spawns a fresh backend after a release', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      await diffusionServer.releaseBackend({ reason: 'explicit' });

      await diffusionServer.executeImageGeneration({ prompt: 'two' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('leaves wrapper health untouched', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      await diffusionServer.releaseBackend({ reason: 'single' });

      await expect(diffusionServer.isHealthy()).resolves.toBe(true);
      expect(diffusionServer.getStatus()).toBe('running');
    });
  });

  describe('backend crash', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it("reports an unexpected exit as 'crashed' without stopping the wrapper", async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      const events = recordBackendEvents(diffusionServer);
      const crashed = jest.fn();
      diffusionServer.on('crashed', crashed);

      handles[0]!.emitExit({ code: 3, signal: null });
      await new Promise((resolve) => setImmediate(resolve));

      expect(events).toEqual([
        {
          state: 'absent',
          previous: 'ready',
          reason: 'crashed',
          exit: { code: 3, signal: null },
        },
      ]);
      expect(crashed).not.toHaveBeenCalled();
      expect(diffusionServer.getStatus()).toBe('running');
      await expect(diffusionServer.isHealthy()).resolves.toBe(true);
    });

    it('fails the in-flight job when the backend dies mid-generation', async () => {
      // Hold the job in 'generating' until the process exits
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }) as any);

      const generation = diffusionServer.executeImageGeneration({ prompt: 'test' });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      handles[0]!.stderrTail = 'CUDA error: out of memory';
      handles[0]!.emitExit({ code: 1, signal: null });

      await expect(generation).rejects.toThrow('exited with code 1');
      try {
        await generation;
      } catch (error: any) {
        expect(error.details.exitCode).toBe(1);
        expect(error.details.stderr).toContain('out of memory');
        expect(error.details.args).toContain('--listen-port');
      }
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(diffusionServer.getStatus()).toBe('running');
    });
  });

  describe('idle timer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('releases a warm backend once the idle timeout elapses', async () => {
      await diffusionServer.start({ ...explicitFlagsConfig, idleTimeoutMs: 1000 });
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      // settleResidency('burst') owns the arming decision (Phase 4)
      await diffusionServer.settleResidency('burst');
      const events = recordBackendEvents(diffusionServer);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');

      await jest.advanceTimersByTimeAsync(1000);

      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(events.map((event) => `${event.state}:${event.reason}`)).toEqual([
        'stopping:idle-timeout',
        'absent:idle-timeout',
      ]);
    });

    it('never arms the timer when idleTimeoutMs is 0', async () => {
      await diffusionServer.start({ ...explicitFlagsConfig, idleTimeoutMs: 0 });
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      await diffusionServer.settleResidency('burst');

      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('is not armed by executeImageGeneration alone', async () => {
      // A batch loop and calibration run generations back to back; only the owner of
      // the offload context settles residency, and only that arms the timer.
      await diffusionServer.start({ ...explicitFlagsConfig, idleTimeoutMs: 1000 });
      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });
  });

  describe('residency policy', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('resolves request > server config > offload-aware default', async () => {
      // Server config is 'auto' here (unset), so the computed default applies
      expect(diffusionServer.resolveUsageMode(undefined, false)).toBe('burst');
      expect(diffusionServer.resolveUsageMode(undefined, true)).toBe('single');
      // A request value always wins
      expect(diffusionServer.resolveUsageMode('burst', true)).toBe('burst');
      expect(diffusionServer.resolveUsageMode('single', false)).toBe('single');

      // A server-level value sits between the request and the computed default
      await diffusionServer.stop();
      await diffusionServer.start({ ...explicitFlagsConfig, usageMode: 'burst' });
      expect(diffusionServer.resolveUsageMode(undefined, true)).toBe('burst');
      expect(diffusionServer.resolveUsageMode('single', true)).toBe('single');

      await diffusionServer.stop();
      await diffusionServer.start({ ...explicitFlagsConfig, usageMode: 'auto' });
      expect(diffusionServer.resolveUsageMode(undefined, true)).toBe('single');
    });

    it("releases the backend with reason 'single'", async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      const events = recordBackendEvents(diffusionServer);

      await diffusionServer.settleResidency('single');

      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(events.map((event) => `${event.state}:${event.reason}`)).toEqual([
        'stopping:single',
        'absent:single',
      ]);
    });

    it("keeps the backend resident under 'burst'", async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      await diffusionServer.settleResidency('burst');

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('is a harmless no-op when no backend is resident', async () => {
      await expect(diffusionServer.settleResidency('single')).resolves.toBeUndefined();
      await expect(diffusionServer.settleResidency('burst')).resolves.toBeUndefined();
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    });
  });

  describe('stop()', () => {
    it('releases the backend before closing the HTTP wrapper', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      await diffusionServer.stop();

      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[0]!.stop.mock.invocationCallOrder[0]!).toBeLessThan(
        mockHttpServer.close.mock.invocationCallOrder[0]!
      );
      const info = diffusionServer.getInfo();
      expect(info.status).toBe('stopped');
      expect(info.port).toBe(0);
      expect(info.backend).toEqual({ state: 'absent' });
    });

    it('emits stopped and tolerates a second stop', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const stoppedHandler = jest.fn();
      diffusionServer.on('stopped', stoppedHandler);

      await diffusionServer.stop();
      await expect(diffusionServer.stop()).resolves.not.toThrow();

      expect(stoppedHandler).toHaveBeenCalledTimes(1);
    });

    it('releases a backend left behind while the wrapper is stopped (calibration)', async () => {
      // calibrate() runs with status 'stopped'; a backend may still be resident
      const handle = createSdServerHandle();
      (diffusionServer as any).backend = {
        state: 'ready',
        handle,
        client: new MockSdServerClient(handle.port, handle.host),
        flags: {
          clipOnCpu: true,
          vaeOnCpu: false,
          offloadToCpu: false,
          diffusionFlashAttention: false,
        },
        pid: handle.pid,
      };

      await diffusionServer.stop();

      expect(handle.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
    });

    it('cancels an in-flight generation', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }) as any);

      const generation = diffusionServer.generateImage({ prompt: 'test' });
      const settled = generation.catch((error: unknown) => error as Error);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      await diffusionServer.stop();

      await expect(settled).resolves.toBeInstanceOf(Error);
      expect((await settled).message).toContain('cancelled');
      expect(handles[0]!.stop).toHaveBeenCalled();
    });
  });

  describe('getInfo() / health', () => {
    it('exposes the backend snapshot and its pid while resident', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      expect(diffusionServer.getInfo().backend).toEqual({ state: 'absent' });

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      const info = diffusionServer.getInfo();
      expect(info.pid).toBe(4242);
      expect(info.busy).toBe(false);
      expect(info.backend).toMatchObject({
        state: 'ready',
        pid: 4242,
        loadTimeMs: 25,
        flags: {
          clipOnCpu: true,
          vaeOnCpu: false,
          offloadToCpu: false,
          diffusionFlashAttention: true,
        },
      });
      expect(info.backend?.startedAt).toEqual(expect.any(String));
      expect(info.backend?.lastUsedAt).toEqual(expect.any(String));
    });

    it('reports the backend state on /health', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const requestHandler = mockCreateServer.mock.calls[0]![0] as any;

      const callHealth = (): any => {
        const req = new EventEmitter() as any;
        req.url = '/health';
        req.method = 'GET';
        req.headers = {};
        const res = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
        requestHandler(req, res);
        return res;
      };

      const before = callHealth();
      expect(before.end).toHaveBeenCalledWith(
        JSON.stringify({ status: 'ok', busy: false, backend: 'absent' })
      );

      await diffusionServer.executeImageGeneration({ prompt: 'test' });

      const after = callHealth();
      expect(after.end).toHaveBeenCalledWith(
        JSON.stringify({ status: 'ok', busy: false, backend: 'ready' })
      );
    });

    it('returns a stopped snapshot before the first start', () => {
      const info = diffusionServer.getInfo();

      expect(info.status).toBe('stopped');
      expect(info.busy).toBe(false);
      expect(info.backend).toEqual({ state: 'absent' });
    });
  });

  describe('isHealthy()', () => {
    it('is false when not running', async () => {
      await expect(diffusionServer.isHealthy()).resolves.toBe(false);
    });

    it('is true while the wrapper is running and false after stop', async () => {
      await diffusionServer.start(mockConfig);
      await expect(diffusionServer.isHealthy()).resolves.toBe(true);

      await diffusionServer.stop();
      await expect(diffusionServer.isHealthy()).resolves.toBe(false);
    });
  });

  describe('logs', () => {
    beforeEach(async () => {
      await diffusionServer.start(mockConfig);
    });

    it('returns recent logs', async () => {
      mockLogGetRecent.mockResolvedValue(['Log line 1', 'Log line 2']);

      const logs = await diffusionServer.getLogs();

      expect(logs).toEqual(['Log line 1', 'Log line 2']);
      expect(mockLogGetRecent).toHaveBeenCalledWith(100);
    });

    it('allows a custom log line count', async () => {
      mockLogGetRecent.mockResolvedValue([]);

      await diffusionServer.getLogs(50);

      expect(mockLogGetRecent).toHaveBeenCalledWith(50);
    });

    it('clears logs', async () => {
      await diffusionServer.clearLogs();

      expect(mockLogClear).toHaveBeenCalled();
    });

    it('is a no-op without a log manager', async () => {
      const fresh = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

      await expect(fresh.getLogs()).resolves.toEqual([]);
      await expect(fresh.clearLogs()).resolves.not.toThrow();
    });

    it('forwards backend output lines to the log file but drops bar redraws', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      const onLog = handles[0]!.launch.onLog as (line: string, stream: string) => void;

      onLog('  |======| 4/4 - 1.20it/s', 'stdout');
      onLog('  |==    | 512/1024 - 25.00MB/s', 'stdout');
      onLog('generating image: 1/1 - seed 42', 'stdout');
      onLog('ggml_cuda warning', 'stderr');

      // Bar frames redraw many times per second and already reach the progress model
      // as structured events — they must never reach the log file
      expect(mockLogWrite).not.toHaveBeenCalledWith('  |======| 4/4 - 1.20it/s', 'info');
      expect(mockLogWrite).not.toHaveBeenCalledWith('  |==    | 512/1024 - 25.00MB/s', 'info');
      expect(mockLogWrite).toHaveBeenCalledWith('generating image: 1/1 - seed 42', 'info');
      expect(mockLogWrite).toHaveBeenCalledWith('ggml_cuda warning', 'warn');
    });
  });

  describe('backend release with work in flight', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('fails the in-flight job with SD_SERVER_EXITED and keeps the wrapper running', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }) as any);

      const generation = diffusionServer.executeImageGeneration({ prompt: 'x' });
      const settled = generation.catch((error: unknown) => error as any);
      await flush();

      await diffusionServer.releaseBackend({ reason: 'explicit' });

      const error = await settled;
      expect(error.details.code).toBe('SD_SERVER_EXITED');
      expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      expect(diffusionServer.getStatus()).toBe('running');
      await expect(diffusionServer.isHealthy()).resolves.toBe(true);
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    });

    it('waits for an in-flight generation when asked, then releases', async () => {
      let finishJob!: () => void;
      mockGetJob.mockImplementation(
        async () =>
          new Promise((resolve) => {
            finishJob = () => resolve(COMPLETED_JOB as any);
          })
      );

      const claim = (diffusionServer as any).createGenerationClaim('gen-1');
      const generation = diffusionServer.executeImageGeneration({ prompt: 'x' });
      claim.promise = generation;
      await flush();

      let released = false;
      const release = diffusionServer.releaseBackend({ reason: 'explicit', waitForInFlight: true });
      void release.then(() => {
        released = true;
      });
      await flush();

      // Still waiting on the generation, backend untouched
      expect(released).toBe(false);
      expect(handles[0]!.stop).not.toHaveBeenCalled();

      finishJob();
      const result = await generation;
      await release;

      expect(result.image).toEqual(Buffer.from('image'));
      expect(result.format).toBe('png');
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      (diffusionServer as any).releaseGenerationClaim(claim);
    });

    it('upgrades a cancel release to stop when stop() joins it', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }) as any);
      const released: string[] = [];
      (diffusionServer as any).onBackendReleased = (reason: string) => released.push(reason);

      const generation = diffusionServer.generateImage({ prompt: 'x' });
      const settled = generation.catch((error: unknown) => error as Error);
      await flush();
      // Recorded from here on: only the release edges matter for this test
      const events = recordBackendEvents(diffusionServer);

      // The kill is held open so stop()'s release lands on top of the cancel one
      let confirmDeath!: () => void;
      handles[0]!.stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            confirmDeath = () => {
              handles[0]!.emitExit({ code: null, signal: 'SIGTERM' });
              resolve();
            };
          })
      );

      const stopped = diffusionServer.stop();
      await flush();
      confirmDeath();
      await stopped;

      expect((await settled).message).toContain('cancelled');
      // The 'stopping' edge keeps the reason that started it; the final release reports
      // the highest-ranked reason that asked for it
      expect(events.map((event) => `${event.state}:${event.reason}`)).toEqual([
        'stopping:cancel',
        'absent:stop',
      ]);
      expect(released).toEqual(['stop']);
    });
  });

  describe('spawn concurrency', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('spawns exactly one backend for two concurrent generations', async () => {
      let releaseSpawn!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        await gate;
        const handle = createSdServerHandle();
        handle.launch = options;
        return handle;
      });

      const first = diffusionServer.executeImageGeneration({ prompt: 'one' });
      const second = diffusionServer.executeImageGeneration({ prompt: 'two' });
      await flush();

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);

      releaseSpawn();
      await Promise.all([first, second]);

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      expect(handles).toHaveLength(1);
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(2);
    });

    it('never spawns a second backend while the first death is unproven', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });

      let confirmDeath!: () => void;
      handles[0]!.stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            confirmDeath = () => {
              handles[0]!.emitExit({ code: null, signal: 'SIGTERM' });
              resolve();
            };
          })
      );

      const release = diffusionServer.releaseBackend({ reason: 'explicit' });
      const generation = diffusionServer.executeImageGeneration({ prompt: 'two' });
      await flush();

      expect(diffusionServer.getBackendInfo().state).toBe('stopping');
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);

      confirmDeath();
      await release;
      await generation;

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });
  });

  describe('unconfirmed termination', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('resolves the release, logs it, then refuses to spawn over the live pid', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      const pid = handles[0]!.pid;
      handles[0]!.stop.mockImplementation(async () => {
        throw sdServerTerminationUnconfirmedError(pid);
      });

      await expect(diffusionServer.releaseBackend({ reason: 'explicit' })).resolves.toBeUndefined();
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
      expect(mockLogWrite).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop the sd-server backend cleanly'),
        'error'
      );

      // The orphan still answers a liveness probe, so no second backend goes over it
      (diffusionServer as any).isProcessAlive = jest.fn(() => true);
      try {
        await diffusionServer.executeImageGeneration({ prompt: 'two' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('BACKEND_TERMINATION_UNCONFIRMED');
        expect(error.details.pid).toBe(pid);
        expect(error.message).toContain('refusing to start a second backend');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
    });

    it('clears the record and spawns once the pid is gone', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      handles[0]!.stop.mockImplementation(async () => {
        throw sdServerTerminationUnconfirmedError(handles[0]!.pid);
      });
      await diffusionServer.releaseBackend({ reason: 'explicit' });

      const alive = jest.fn(() => false);
      (diffusionServer as any).isProcessAlive = alive;

      await diffusionServer.executeImageGeneration({ prompt: 'two' });

      expect(alive).toHaveBeenCalledWith(4242);
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect((diffusionServer as any).unconfirmedBackendPid).toBeUndefined();
    });
  });

  describe('spawn failure', () => {
    beforeEach(async () => {
      await diffusionServer.start(explicitFlagsConfig);
    });

    it('publishes start-failed and lets a retry spawn again', async () => {
      const events = recordBackendEvents(diffusionServer);
      mockStartSdServerRunner.mockImplementationOnce(async () => {
        throw sdServerReadyTimeoutError(45_000);
      });

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'one' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('SD_SERVER_READY_TIMEOUT');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }

      expect(events.map((event) => `${event.state}:${event.reason}`)).toEqual([
        'starting:spawned',
        'absent:start-failed',
      ]);
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });

      // A retry is not blocked by the failed attempt
      await diffusionServer.executeImageGeneration({ prompt: 'two' });
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('aborts an in-flight spawn instead of waiting it out', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        capturedSignal = options.signal;
        // Faithful to the runner: an aborted startup rejects after a confirmed kill
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new ServerError('sd-server startup aborted', { code: 'SD_SERVER_START_ABORTED' })
              ),
            { once: true }
          );
        });
        throw new Error('unreachable');
      });

      const generation = diffusionServer.generateImage({ prompt: 'x' });
      const settled = generation.catch((error: unknown) => error as any);
      await flush();
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      // stop() must not wait out a cold model load
      await diffusionServer.stop();

      expect(capturedSignal!.aborted).toBe(true);
      expect((await settled).details.code).toBe('SD_SERVER_START_ABORTED');
      expect(diffusionServer.getStatus()).toBe('stopped');
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    });

    it('records the sticky pid when a failed start could not be torn down', async () => {
      // The runner could not confirm the death of the child it failed to bring up:
      // that orphan still owns the GPU, so no second backend may go over it.
      mockStartSdServerRunner.mockImplementationOnce(async () => {
        throw sdServerTerminationUnconfirmedError(9_931);
      });

      await expect(diffusionServer.executeImageGeneration({ prompt: 'one' })).rejects.toMatchObject(
        {
          details: expect.objectContaining({ code: 'SD_SERVER_TERMINATION_UNCONFIRMED' }),
        }
      );
      expect((diffusionServer as any).unconfirmedBackendPid).toBe(9_931);

      (diffusionServer as any).isProcessAlive = jest.fn(() => true);
      try {
        await diffusionServer.executeImageGeneration({ prompt: 'two' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('BACKEND_TERMINATION_UNCONFIRMED');
        expect(error.details.pid).toBe(9_931);
      }
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
    });
  });

  describe('synthetic VAE progress', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Drive a generation into the VAE stage, where the synthetic ticker runs. */
    const startDecodingGeneration = async (
      server: Manager
    ): Promise<{ onProgress: jest.Mock; settled: Promise<unknown> }> => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }) as any);
      const onProgress = jest.fn();
      const generation = server.executeImageGeneration({ prompt: 'x', steps: 4, onProgress });
      const settled = generation.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(0);
      handles[0]!.launch.onStdoutEvent({ type: 'marker', marker: 'decoding' });
      await jest.advanceTimersByTimeAsync(500);
      return { onProgress, settled };
    };

    it('stops the interval when the backend is released', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const { onProgress, settled } = await startDecodingGeneration(diffusionServer);
      const ticks = onProgress.mock.calls.length;
      expect(ticks).toBeGreaterThan(2);

      await diffusionServer.releaseBackend({ reason: 'explicit' });
      await jest.advanceTimersByTimeAsync(1000);

      expect(onProgress).toHaveBeenCalledTimes(ticks);
      await settled;
    });

    it('stops the interval when the backend crashes', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      const { onProgress, settled } = await startDecodingGeneration(diffusionServer);
      const ticks = onProgress.mock.calls.length;
      expect(ticks).toBeGreaterThan(2);

      handles[0]!.emitExit({ code: 1, signal: null });
      await jest.advanceTimersByTimeAsync(1000);

      expect(onProgress).toHaveBeenCalledTimes(ticks);
      await settled;
    });
  });

  describe('start() failure handling', () => {
    it('throws InsufficientResourcesError when the model does not fit', async () => {
      mockSystemInfo.canRunModel.mockResolvedValue({
        possible: false,
        reason: 'Model requires 6GB, only 2GB total',
        suggestion: 'Try a smaller model',
      });

      try {
        await diffusionServer.start(mockConfig);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('INSUFFICIENT_RESOURCES');
        expect(error.message).toContain('System cannot run model');
        expect(error.details.suggestion).toBe('Try a smaller model');
      }
      expect(diffusionServer.getStatus()).toBe('stopped');
    });

    it('rejects a concurrent start() while provisioning is still running', async () => {
      let releaseProvisioning!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseProvisioning = resolve;
      });
      mockEnsureBinary.mockImplementation(async () => {
        await gate;
        return '/test/binaries/diffusion/sd-server';
      });

      const first = diffusionServer.start(mockConfig);
      await flush();

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('already starting');

      releaseProvisioning();
      await expect(first).resolves.toMatchObject({ status: 'running' });
    });

    it('records the failure in the provisioning log and closes a half-open HTTP server', async () => {
      mockHttpServer.listen = jest.fn().mockImplementation(() => {
        setImmediate(() => mockHttpServer.emit('error', new Error('listen EADDRINUSE')));
        return mockHttpServer;
      });

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('listen EADDRINUSE');

      expect(mockHttpServer.close).toHaveBeenCalled();
      expect(mockLogWrite).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start: listen EADDRINUSE'),
        'error'
      );
      expect(diffusionServer.getStatus()).toBe('stopped');
      expect((diffusionServer as any).httpServer).toBeUndefined();
      await expect(diffusionServer.isHealthy()).resolves.toBe(false);
    });
  });

  describe('library defaults', () => {
    it('passes the default ready timeout when startupTimeout is omitted', async () => {
      await diffusionServer.start(explicitFlagsConfig);

      await diffusionServer.executeImageGeneration({ prompt: 'x' });

      expect(handles[0]!.launch.readyTimeoutMs).toBe(DIFFUSION_BACKEND_DEFAULTS.readyTimeoutMs);
    });

    it('holds the backend for the default idle timeout, then releases it', async () => {
      jest.useFakeTimers();
      try {
        await diffusionServer.start(explicitFlagsConfig);
        await diffusionServer.executeImageGeneration({ prompt: 'x' });
        await diffusionServer.settleResidency('burst');

        await jest.advanceTimersByTimeAsync(DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs - 1000);
        expect(handles[0]!.stop).not.toHaveBeenCalled();
        expect(diffusionServer.getBackendInfo().state).toBe('ready');

        await jest.advanceTimersByTimeAsync(1000);
        expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
        expect(diffusionServer.getBackendInfo().state).toBe('absent');
      } finally {
        jest.useRealTimers();
      }
    });

    it('respawns for the next generation after a crash', async () => {
      await diffusionServer.start(explicitFlagsConfig);
      await diffusionServer.executeImageGeneration({ prompt: 'one' });

      handles[0]!.emitExit({ code: 139, signal: null });
      await flush();
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });

      await diffusionServer.executeImageGeneration({ prompt: 'two' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });
  });
});
