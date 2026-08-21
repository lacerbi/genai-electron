/**
 * Integration-style residency tests: REAL ResourceOrchestrator + REAL
 * DiffusionServerManager over the shared `sd-server` backend seam.
 *
 * Everything below the manager (the runner/client pair) is faked exactly as in the
 * DiffusionServerManager suites; the LLM side is a hand-written fake that counts
 * `start()` calls, honours the running/stopped status, and — like the real
 * LlamaServerManager — runs the registered pre-start hooks inside `start()`.
 *
 * What these tests pin is the wiring the unit suites can only assert one side of:
 * exactly one LLM reload per offload cycle, no reload from inside the pre-start hook,
 * and a burst-deferred reload that really fires on the idle timeout.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { DiffusionServerConfig, LlamaServerConfig, ModelInfo } from '../../src/types/index.js';

import { handles, resetSdServerMocks } from './helpers/sd-server-mocks.js';

// Mock Electron app
jest.unstable_mockModule('electron', () => ({
  app: { getPath: jest.fn(() => '/test/userData') },
}));

// Mock http module (the wrapper never binds a real socket here)
const mockHttpServer = new EventEmitter() as any;
const resetHttpServerMocks = (): void => {
  mockHttpServer.listen = jest
    .fn()
    .mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback();
      return mockHttpServer;
    });
  mockHttpServer.close = jest.fn().mockImplementation((callback?: () => void) => {
    callback?.();
  });
};
resetHttpServerMocks();

const mockCreateServer = jest.fn().mockReturnValue(mockHttpServer);

jest.unstable_mockModule('node:http', () => {
  const httpModule = { createServer: mockCreateServer };
  return { default: httpModule, ...httpModule };
});

// Mock ModelManager (shared by the manager and the real orchestrator)
const mockModelManager = {
  getModelInfo: jest.fn(),
  getModelLayerCount: jest.fn(),
};

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: { getInstance: jest.fn(() => mockModelManager) },
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
  SystemInfo: { getInstance: jest.fn(() => mockSystemInfo) },
}));

// Mock LogManager
const mockLogWrite = jest.fn();

class MockLogManager {
  initialize = jest.fn(async () => undefined);
  write = mockLogWrite;
  getRecent = jest.fn(async () => []);
  clear = jest.fn(async () => undefined);
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock BinaryManager
const mockEnsureBinary = jest.fn();

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
  constructor(_config: any) {}
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock health-check + port-utils (never touch the network)
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  isServerResponding: mockIsServerResponding,
  checkHealth: jest.fn(),
  waitForHealthy: jest.fn(),
  normalizeHealthHost: (host?: string) =>
    host === undefined || host === '' || host === '0.0.0.0' ? '127.0.0.1' : host,
  formatHttpHost: (host: string) => host,
}));

const mockFindFreePort = jest.fn(async () => 49999);
const mockIsPortBindable = jest.fn(async () => true);

jest.unstable_mockModule('../../src/process/port-utils.js', () => ({
  findFreePort: mockFindFreePort,
  isPortBindable: mockIsPortBindable,
}));

// Mock file-utils
jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: jest.fn(async () => undefined),
  deleteFile: jest.fn(async () => undefined),
  fileExists: jest.fn(async () => true),
  getFileSize: jest.fn(),
  moveFile: jest.fn(),
  copyDirectory: jest.fn(),
  calculateChecksum: jest.fn(),
  formatBytes: jest.fn(),
  isAbsolutePath: jest.fn(),
  sanitizeFilename: jest.fn(),
}));

// Mock paths (imports electron)
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
  ensureDirectories: jest.fn(),
  getModelDirectory: jest.fn(),
  getModelMetadataPath: jest.fn(),
  getModelFilePath: jest.fn(),
  getBinaryPath: jest.fn((type: string, name: string) => `/test/binaries/${type}/${name}`),
  getLogPath: jest.fn(),
  getConfigPath: jest.fn(),
  getTempPath: jest.fn((filename: string) => `/test/temp/${filename}`),
}));

// Import after mocking
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');
const { DIFFUSION_BACKEND_DEFAULTS } = await import('../../src/config/defaults.js');

type Manager = InstanceType<typeof DiffusionServerManager>;

/**
 * Stand-in for LlamaServerManager: counts starts, tracks running state, and runs the
 * pre-start hooks inside start() exactly where the real manager does.
 */
class FakeLlamaServer {
  readonly start = jest.fn(async (config: LlamaServerConfig) => {
    // The real manager rejects a start while it is already running; anything that
    // "restores" a server that never went down has to fail here, not silently pass.
    if (this.running) throw new Error('Server is already running');
    this.startConfigs.push(config);
    for (const hook of [...this.hooks]) {
      await hook({ config, reason: 'start' });
    }
    this.running = true;
    this.config = config;
    return { status: 'running', port: config.port } as never;
  });

  readonly stop = jest.fn(async () => {
    this.running = false;
  });

  readonly startConfigs: LlamaServerConfig[] = [];
  private readonly hooks = new Set<(ctx: any) => Promise<void> | void>();
  private running = false;
  private config?: LlamaServerConfig;

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): LlamaServerConfig | undefined {
    return this.config;
  }

  registerPreStartHook(hook: (ctx: any) => Promise<void> | void): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  /** Put the fake in the "running with this config" state without counting a start */
  seedRunning(config: LlamaServerConfig): void {
    this.running = true;
    this.config = config;
  }
}

describe('ResourceOrchestrator + DiffusionServerManager (residency)', () => {
  const llmModelInfo: ModelInfo = {
    id: 'llama-2-7b',
    name: 'Llama 2 7B',
    type: 'llm',
    size: 4 * 1024 ** 3,
    path: '/test/models/llm/llama-2-7b.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/llama-2-7b.gguf' },
  };

  const diffusionModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 ** 3,
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-turbo.gguf' },
  };

  const llmConfig: LlamaServerConfig = { modelId: 'llama-2-7b', port: 8080, gpuLayers: 35 };

  /** Explicit offload flags keep auto-detection out of the picture */
  const serverConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
    clipOnCpu: true,
    vaeOnCpu: false,
    offloadToCpu: false,
    diffusionFlashAttention: true,
  };

  let llamaServer: FakeLlamaServer;
  let diffusionServer: Manager;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetSdServerMocks();
    resetHttpServerMocks();
    mockCreateServer.mockReturnValue(mockHttpServer);
    mockEnsureBinary.mockResolvedValue('/test/binaries/diffusion/sd-server');
    mockLogWrite.mockResolvedValue(undefined);

    mockModelManager.getModelInfo.mockImplementation(async (modelId: string) => {
      if (modelId === 'llama-2-7b') return llmModelInfo;
      if (modelId === 'sdxl-turbo') return diffusionModelInfo;
      throw new Error(`Model not found: ${modelId}`);
    });
    mockModelManager.getModelLayerCount.mockResolvedValue(35);

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
    // 8 GB VRAM: diffusion (7.8 GB) + LLM (4.8 GB) never fit under the 75 % threshold
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 10 * 1024 ** 3, used: 6 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: 8 * 1024 ** 3 },
      platform: 'linux',
      recommendations: {
        maxModelSize: '7B',
        recommendedQuantization: ['Q4_K_M'],
        threads: 7,
        gpuLayers: 35,
      },
    });
    mockIsServerResponding.mockResolvedValue(false);
    mockIsPortBindable.mockResolvedValue(true);
    mockFindFreePort.mockResolvedValue(49999);

    llamaServer = new FakeLlamaServer();
    diffusionServer = new DiffusionServerManager(
      mockModelManager as any,
      mockSystemInfo as any,
      llamaServer as any
    );
    await diffusionServer.start(serverConfig);
  });

  afterEach(() => {
    for (const handle of handles) handle.emitExit({ code: 0, signal: null });
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
  });

  const orchestrator = (): any => (diffusionServer as any).orchestrator;

  it("releases the backend and reloads the LLM exactly once in 'single' mode", async () => {
    llamaServer.seedRunning(llmConfig);

    const result = await diffusionServer.generateImage({ prompt: 'a cat' });

    expect(result.format).toBe('png');
    // Offloaded for the image...
    expect(llamaServer.stop).toHaveBeenCalledTimes(1);
    // ...and the backend is gone again ('single' is the default after an offload)
    expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });

    await orchestrator().waitForReload();

    expect(llamaServer.start).toHaveBeenCalledTimes(1);
    expect(llamaServer.startConfigs).toEqual([llmConfig]);
    // Release BEFORE reload: the backend was killed before llama-server came back
    expect(handles[0]!.stop.mock.invocationCallOrder[0]!).toBeLessThan(
      llamaServer.start.mock.invocationCallOrder[0]!
    );
    expect(orchestrator().getSavedState()).toBeUndefined();
  });

  it('starts no second LLM from inside the pre-start hook', async () => {
    llamaServer.seedRunning(llmConfig);

    await diffusionServer.generateImage({ prompt: 'a cat' });
    await orchestrator().waitForReload();

    // The reload itself ran the pre-start hook; it must not have recursed
    expect(llamaServer.start).toHaveBeenCalledTimes(1);
    expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
  });

  it('yields a resident backend to an LLM start without reloading anything', async () => {
    llamaServer.seedRunning(llmConfig);

    // Burst keeps the backend warm and defers the reload
    await diffusionServer.generateImage({ prompt: 'a cat', usageMode: 'burst' });
    await orchestrator().waitForReload();

    expect(diffusionServer.getBackendInfo().state).toBe('ready');
    expect(llamaServer.start).not.toHaveBeenCalled();
    expect(orchestrator().getSavedState()).toBeDefined();

    // The host starts the LLM itself: the hook releases the backend to make room
    await llamaServer.start(llmConfig);

    expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
    // Exactly the one start the host asked for — 'llm-start' never triggers a reload
    await orchestrator().waitForReload();
    expect(llamaServer.start).toHaveBeenCalledTimes(1);
  });

  it('drops the deferred reload when the host started the LLM itself', async () => {
    llamaServer.seedRunning(llmConfig);

    // Burst keeps the backend warm and defers the reload
    await diffusionServer.generateImage({ prompt: 'a cat', usageMode: 'burst' });
    expect(diffusionServer.getBackendInfo().state).toBe('ready');
    expect(orchestrator().getSavedState()).toBeDefined();

    // The host restarts the LLM while both happen to fit, so the pre-start hook keeps
    // the backend resident
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 64 * 1024 ** 3, available: 48 * 1024 ** 3, used: 16 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: 48 * 1024 ** 3 },
      platform: 'linux',
      recommendations: {
        maxModelSize: '70B',
        recommendedQuantization: ['Q4_K_M'],
        threads: 7,
        gpuLayers: 99,
      },
    });
    await llamaServer.start(llmConfig);
    expect(llamaServer.start).toHaveBeenCalledTimes(1);
    expect(diffusionServer.getBackendInfo().state).toBe('ready');

    // Releasing the (still warm) backend must NOT start a second LLM over the running one
    await diffusionServer.releaseBackend({ reason: 'idle-timeout' });
    await orchestrator().waitForReload();

    expect(llamaServer.start).toHaveBeenCalledTimes(1);
    expect(orchestrator().getSavedState()).toBeUndefined();
  });

  it('yields the backend to a raw start config that has no gpuLayers yet', async () => {
    llamaServer.seedRunning(llmConfig);
    await diffusionServer.generateImage({ prompt: 'a cat', usageMode: 'burst' });
    expect(diffusionServer.getBackendInfo().state).toBe('ready');

    // Exactly what a host passes to start(): LlamaServerManager auto-configures
    // gpuLayers later, so the hook must not read the raw 0 as "costs no VRAM"
    await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

    expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
    expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("fires the deferred 'burst' reload on the idle timeout", async () => {
    jest.useFakeTimers();
    try {
      await diffusionServer.stop();
      await diffusionServer.start({ ...serverConfig, idleTimeoutMs: 1000 });
      llamaServer.seedRunning(llmConfig);

      await diffusionServer.generateImage({ prompt: 'a cat', usageMode: 'burst' });

      expect(llamaServer.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
      expect(llamaServer.start).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);

      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
      await orchestrator().waitForReload();
      expect(llamaServer.start).toHaveBeenCalledTimes(1);
      expect(llamaServer.startConfigs).toEqual([llmConfig]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the LLM down until the backend is released under burst', async () => {
    jest.useFakeTimers();
    try {
      await diffusionServer.stop();
      // idleTimeoutMs 0 = never; the host owns the release
      await diffusionServer.start({ ...serverConfig, idleTimeoutMs: 0, usageMode: 'burst' });
      llamaServer.seedRunning(llmConfig);

      await diffusionServer.generateImage({ prompt: 'a cat' });

      await jest.advanceTimersByTimeAsync(DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs * 2);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
      expect(llamaServer.start).not.toHaveBeenCalled();

      // An explicit release is a qualifying reason
      await diffusionServer.releaseBackend({ reason: 'explicit' });
      await orchestrator().waitForReload();

      expect(llamaServer.start).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
