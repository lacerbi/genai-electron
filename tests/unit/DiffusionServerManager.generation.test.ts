/**
 * Unit tests for DiffusionServerManager image generation
 *
 * Covers everything between `generateImage()`/`runAsyncGeneration()` and the
 * `sd-server` backend: request-body mapping, launch-argument resolution (VRAM
 * auto-detection, multi-component models, threads), progress derived from the
 * backend's stdout tap, error mapping, cancellation, and the batch loop.
 *
 * Route-level behaviour lives in DiffusionServerManager.routes.test.ts and wrapper
 * lifecycle in DiffusionServerManager.lifecycle.test.ts.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type {
  DiffusionBackendStatusEvent,
  DiffusionServerConfig,
  ModelInfo,
} from '../../src/types/index.js';

// Backend seam (shared with the other DiffusionServerManager suites): runner + client
// module mocks, never a raw child process.
import {
  COMPLETED_JOB,
  createSdServerHandle,
  handles,
  mockBuildRequest,
  mockCancelJob,
  mockGetJob,
  mockStartSdServerRunner,
  mockSubmitImageJob,
  resetSdServerMocks,
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

// Mock http module
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

// Mock node:fs so "the backend never writes a temp PNG" is an assertion, not a hope
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockFsPromises = { readFile: mockReadFile, writeFile: mockWriteFile };

jest.unstable_mockModule('node:fs', () => ({
  default: { promises: mockFsPromises },
  promises: mockFsPromises,
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

// Mock health-check
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

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: mockEnsureDirectory,
  deleteFile: mockDeleteFile,
  fileExists: jest.fn(),
  getFileSize: jest.fn(),
  moveFile: jest.fn(),
  copyDirectory: jest.fn(),
  calculateChecksum: jest.fn(),
  formatBytes: jest.fn(),
  isAbsolutePath: jest.fn(),
  sanitizeFilename: jest.fn(),
}));

// Mock paths
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

// Import after mocking (same registry instance as the manager's own imports)
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');
const { ServerError } = await import('../../src/errors/index.js');

type Manager = InstanceType<typeof DiffusionServerManager>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('DiffusionServerManager (generation)', () => {
  let diffusionServer: Manager;

  const mockModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 ** 3,
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-turbo.gguf' },
  };

  /** 2.9 GB single-file model → footprint 3.48 GB */
  const smallModelInfo: ModelInfo = { ...mockModelInfo, size: 2.9 * 1024 ** 3 };

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

  const sdxlSplitModelInfo: ModelInfo = {
    id: 'sdxl-split',
    name: 'SDXL Split',
    type: 'diffusion',
    size: 6.9 * 1024 ** 3,
    path: '/test/models/diffusion/sdxl-split/sdxl-unet.safetensors',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-split.safetensors' },
    components: {
      diffusion_model: {
        path: '/test/models/diffusion/sdxl-split/sdxl-unet.safetensors',
        size: 5.1 * 1024 ** 3,
      },
      clip_l: {
        path: '/test/models/diffusion/sdxl-split/clip_l.safetensors',
        size: 246 * 1024 ** 2,
      },
      clip_g: {
        path: '/test/models/diffusion/sdxl-split/clip_g.safetensors',
        size: 1.4 * 1024 ** 3,
      },
      vae: {
        path: '/test/models/diffusion/sdxl-split/sdxl-vae.safetensors',
        size: 335 * 1024 ** 2,
      },
    },
  };

  /** Auto-detection is exercised on purpose: no offload flags in the server config */
  const mockConfig: DiffusionServerConfig = { modelId: 'sdxl-turbo', port: 8081 };

  /** Server config with fully explicit offload flags (no auto-detection noise) */
  const explicitFlagsConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
    clipOnCpu: true,
    vaeOnCpu: false,
    offloadToCpu: false,
    diffusionFlashAttention: false,
  };

  const recordBackendEvents = (server: Manager): DiffusionBackendStatusEvent[] => {
    const events: DiffusionBackendStatusEvent[] = [];
    server.on('backend-status', (event: DiffusionBackendStatusEvent) => {
      events.push(event);
    });
    return events;
  };

  /** Replay backend stdout observations while the job is being submitted. */
  const emitOnSubmit = (events: unknown[], gapMs = 0): void => {
    mockSubmitImageJob.mockImplementation(async () => {
      const handle = handles.at(-1)!;
      for (const event of events) {
        handle.launch.onStdoutEvent(event);
        if (gapMs > 0) await sleep(gapMs);
      }
      return { id: 'job-1' };
    });
  };

  const holdJobGenerating = (): void => {
    mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));
  };

  /** Kick off a registry-backed generation exactly the way the POST route does. */
  const startAsync = (
    server: Manager,
    config: Record<string, unknown>
  ): { id: string; promise: Promise<void>; registry: any } => {
    const registry = (server as any).registry;
    const id = registry.create(config) as string;
    const claim = (server as any).createGenerationClaim(id);
    const promise = (server as any).runAsyncGeneration(id, config) as Promise<void>;
    claim.promise = promise;
    return { id, promise, registry };
  };

  /** Start a throwaway server with `model`, generate once, return the launch options. */
  const captureLaunch = async (
    config: DiffusionServerConfig,
    model: ModelInfo = mockModelInfo
  ): Promise<any> => {
    mockModelManager.getModelInfo.mockResolvedValue(model);
    const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
    await server.start(config);
    await server.executeImageGeneration({ prompt: 'test' });
    const launch = handles.at(-1)!.launch;
    await server.stop();
    server.removeAllListeners();
    return launch;
  };

  beforeEach(async () => {
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
    // The real field-by-field mapping is pinned by tests/unit/sd-server-client.test.ts;
    // here the mock's CALL ARGUMENTS are the assertion surface.
    mockBuildRequest.mockImplementation((config: any, batchSize?: number) => ({
      __builtFor: config.prompt,
      prompt: config.prompt,
      seed: config.seed,
      batch_count: batchSize ?? 1,
      sample_params: { guidance: {} },
    }));

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

    await diffusionServer.start(explicitFlagsConfig);
  });

  afterEach(() => {
    // Any generation left in flight owns a poll loop; killing its backend makes that
    // loop reject on its next turn instead of polling into the following test
    for (const handle of handles) handle.emitExit({ code: 0, signal: null });
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
  });

  describe('request mapping', () => {
    it('hands the fully normalized request to the backend body builder', async () => {
      await diffusionServer.executeImageGeneration({
        prompt: 'A serene mountain landscape at sunset',
        negativePrompt: 'blurry, low quality',
        width: 1024,
        height: 1024,
        steps: 30,
        cfgScale: 7.5,
        seed: 12345,
        sampler: 'euler_a',
      });

      expect(mockBuildRequest).toHaveBeenCalledTimes(1);
      const [config, batchSize] = mockBuildRequest.mock.calls[0]!;
      expect(config).toMatchObject({
        prompt: 'A serene mountain landscape at sunset',
        negativePrompt: 'blurry, low quality',
        width: 1024,
        height: 1024,
        steps: 30,
        cfgScale: 7.5,
        seed: 12345,
        sampler: 'euler_a',
      });
      expect(batchSize).toBeUndefined();
      // Whatever the builder produced is exactly what is submitted
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(1);
      expect(mockSubmitImageJob.mock.calls[0]![0]).toBe(mockBuildRequest.mock.results[0]!.value);
    });

    it('leaves unset fields undefined so sd.cpp defaults apply', async () => {
      const result = await diffusionServer.executeImageGeneration({ prompt: 'minimal' });

      const [config] = mockBuildRequest.mock.calls[0]!;
      expect(config.negativePrompt).toBeUndefined();
      expect(config.width).toBeUndefined();
      expect(config.height).toBeUndefined();
      expect(config.steps).toBeUndefined();
      expect(config.cfgScale).toBeUndefined();
      expect(config.sampler).toBeUndefined();
      // The reported result still falls back to the documented 512x512
      expect(result.width).toBe(512);
      expect(result.height).toBe(512);
      expect(result.format).toBe('png');
      expect(result.image).toEqual(Buffer.from('image'));
      expect(result.timeTaken).toBeGreaterThanOrEqual(0);
    });

    it('maps the server-level batchSize onto batch_count', async () => {
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      await server.start({ ...explicitFlagsConfig, batchSize: 3 });

      await server.executeImageGeneration({ prompt: 'x' });

      expect(mockBuildRequest.mock.calls.at(-1)![1]).toBe(3);
      expect(mockSubmitImageJob.mock.calls.at(-1)![0]).toMatchObject({ batch_count: 3 });

      await server.stop();
      server.removeAllListeners();
    });

    it.each([undefined, -1])(
      'normalizes seed %s to a random non-negative value echoed in the result',
      async (seed) => {
        const result = await diffusionServer.executeImageGeneration({ prompt: 'x', seed });

        const [config] = mockBuildRequest.mock.calls[0]!;
        expect(config.seed).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(config.seed)).toBe(true);
        expect(result.seed).toBe(config.seed);
      }
    );

    it('keeps a caller-provided seed untouched', async () => {
      const result = await diffusionServer.executeImageGeneration({ prompt: 'x', seed: 0 });

      expect(mockBuildRequest.mock.calls[0]![0].seed).toBe(0);
      expect(result.seed).toBe(0);
    });
  });

  describe('progress', () => {
    it('walks loading → diffusion → decoding and finishes at 100', async () => {
      emitOnSubmit([
        { type: 'bytes', done: 40, total: 100 },
        { type: 'marker', marker: 'generating' },
        { type: 'step', step: 2, steps: 4 },
        { type: 'step', step: 4, steps: 4 },
        { type: 'marker', marker: 'decoding' },
        { type: 'marker', marker: 'decoded' },
      ]);
      const onProgress = jest.fn();

      await diffusionServer.executeImageGeneration({ prompt: 'x', steps: 4, onProgress });

      const stages = onProgress.mock.calls.map((call) => call[2]);
      expect(stages[0]).toBe('loading');
      expect(stages).toContain('diffusion');
      expect(stages.indexOf('diffusion')).toBeLessThan(stages.indexOf('decoding'));
      expect(onProgress).toHaveBeenLastCalledWith(0, 0, 'decoding', 100);
    });

    it('turns byte bars into loading progress, never step progress', async () => {
      emitOnSubmit([{ type: 'bytes', done: 40, total: 100 }]);
      const onProgress = jest.fn();

      await diffusionServer.executeImageGeneration({ prompt: 'x', steps: 4, onProgress });

      expect(onProgress).toHaveBeenCalledWith(40, 100, 'loading', expect.any(Number));
      expect(onProgress.mock.calls.some((call) => call[2] === 'diffusion' && call[0] === 40)).toBe(
        false
      );
    });

    it('enters the diffusion stage on the first step even without the marker', async () => {
      emitOnSubmit([{ type: 'step', step: 1, steps: 4 }]);
      const onProgress = jest.fn();

      await diffusionServer.executeImageGeneration({ prompt: 'x', steps: 4, onProgress });

      expect(onProgress).toHaveBeenCalledWith(1, 4, 'diffusion', expect.any(Number));
    });

    it('falls back to decoding when the last step passed but the job still runs', async () => {
      emitOnSubmit([
        { type: 'marker', marker: 'generating' },
        { type: 'step', step: 4, steps: 4 },
      ]);
      holdJobGenerating();
      const onProgress = jest.fn();

      const generation = diffusionServer.executeImageGeneration({
        prompt: 'x',
        steps: 4,
        onProgress,
      });
      await flush();

      // No 'decoding' literal ever arrived, yet the stage advanced
      expect(onProgress).toHaveBeenCalledWith(0, 0, 'decoding', expect.any(Number));

      mockGetJob.mockResolvedValue(COMPLETED_JOB);
      await generation;
      expect(onProgress).toHaveBeenLastCalledWith(0, 0, 'decoding', 100);
    });

    it('measures the model load on a cold start and only conditioning when warm', async () => {
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        await sleep(45);
        const handle = createSdServerHandle();
        handle.launch = options;
        return handle;
      });
      emitOnSubmit([{ type: 'marker', marker: 'generating' }]);

      await diffusionServer.executeImageGeneration({ prompt: 'cold', steps: 4 });
      const cold = (diffusionServer as any).snapshotStageMs();

      await diffusionServer.executeImageGeneration({ prompt: 'warm', steps: 4 });
      const warm = (diffusionServer as any).snapshotStageMs();

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      expect(cold.loadMs).toBeGreaterThanOrEqual(40);
      expect(warm.loadMs).toBeLessThan(cold.loadMs);
      expect(warm.loadMs).toBeLessThan(40);
    });

    it('self-calibrates its time model across generations', async () => {
      emitOnSubmit(
        [
          { type: 'marker', marker: 'generating' },
          { type: 'step', step: 4, steps: 4 },
          { type: 'marker', marker: 'decoding' },
          { type: 'marker', marker: 'decoded' },
        ],
        6
      );

      const internals = diffusionServer as any;
      expect(internals.modelLoadTime).toBe(2000);
      expect(internals.diffusionTimePerStepPerMegapixel).toBe(1000);
      expect(internals.vaeTimePerMegapixel).toBe(8000);

      await diffusionServer.executeImageGeneration({
        prompt: 'first',
        width: 512,
        height: 512,
        steps: 4,
      });

      expect(internals.modelLoadTime).not.toBe(2000);
      expect(internals.diffusionTimePerStepPerMegapixel).not.toBe(1000);
      expect(internals.vaeTimePerMegapixel).not.toBe(8000);

      const percentages: number[] = [];
      await diffusionServer.executeImageGeneration({
        prompt: 'second',
        width: 512,
        height: 512,
        steps: 4,
        onProgress: (_step, _total, _stage, pct) => percentages.push(pct ?? -1),
      });

      expect(percentages.length).toBeGreaterThan(0);
      for (const pct of percentages) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
      expect(percentages).toContain(100);
    });
  });

  describe('error mapping', () => {
    it('keeps the backend stderr on a failed job and maps it to BACKEND_ERROR', async () => {
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'failed',
        error: { message: 'ggml_cuda_host_malloc failed' },
      }));
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        const handle = createSdServerHandle();
        handle.launch = options;
        handle.stderrTail = 'CUDA error: out of memory';
        return handle;
      });

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'x' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('stable-diffusion.cpp job failed');
        expect(error.details.code).toBe('BACKEND_JOB_FAILED');
        expect(error.details.backendError).toBe('ggml_cuda_host_malloc failed');
        expect(error.details.stderr).toContain('out of memory');
        expect(error.details.args).toContain('--listen-port');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }
    });

    it("re-wraps a mid-job backend exit as 'exited with code'", async () => {
      holdJobGenerating();

      const generation = diffusionServer.executeImageGeneration({ prompt: 'x' });
      const settled = generation.catch((error: unknown) => error as any);
      await flush();

      handles[0]!.stderrTail = 'cudaMalloc failed: out of memory';
      handles[0]!.emitExit({ code: 2, signal: null });

      const error = await settled;
      expect(error.message).toContain('exited with code 2');
      expect(error.details.code).toBe('SD_SERVER_EXITED');
      expect(error.details.exitCode).toBe(2);
      expect(error.details.stderr).toContain('out of memory');
      expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
    });

    it('maps an empty image payload to IO_ERROR', async () => {
      mockGetJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        result: { output_format: 'png', images: [{ index: 0, b64_json: '' }] },
      });

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'x' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Failed to decode generated image');
        expect(error.details.code).toBe('IMAGE_DECODE_FAILED');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('IO_ERROR');
      }
    });

    it('maps a full backend queue to BACKEND_ERROR', async () => {
      mockSubmitImageJob.mockRejectedValue(
        new ServerError('sd-server rejected the job: the backend queue is full', {
          code: 'BACKEND_QUEUE_FULL',
          status: 429,
        })
      );

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'x' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('BACKEND_QUEUE_FULL');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }
    });

    it('surfaces a missing model as an internal ServerError', async () => {
      (diffusionServer as any).currentModelInfo = undefined;

      await expect(diffusionServer.executeImageGeneration({ prompt: 'x' })).rejects.toThrow(
        'Model information not available'
      );
    });
  });

  describe('cancellation', () => {
    it('throws GENERATION_NOT_FOUND for an unknown id', async () => {
      try {
        await diffusionServer.cancelImageGeneration('no-such-id');
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Generation not found');
        expect(error.details.code).toBe('GENERATION_NOT_FOUND');
      }
    });

    it('kills the backend for a generating job and resolves before confirmed death', async () => {
      holdJobGenerating();
      const { id, promise, registry } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();
      const events = recordBackendEvents(diffusionServer);

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

      await diffusionServer.cancelImageGeneration(id);

      expect(registry.get(id).status).toBe('cancelled');
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      // cancelImageGeneration() returned while the child is still dying
      expect(diffusionServer.getBackendInfo().state).toBe('stopping');
      expect(events.map((event) => event.reason)).toEqual(['cancel']);

      const error = await settled;
      expect(error.message).toContain('cancelled');

      confirmDeath();
      await flush();
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(events.map((event) => `${event.state}:${event.reason}`)).toEqual([
        'stopping:cancel',
        'absent:cancel',
      ]);
    });

    it('latches a cancel that arrives before the job is submitted', async () => {
      let releaseSpawn!: () => void;
      const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        await spawnGate;
        const handle = createSdServerHandle();
        handle.launch = options;
        return handle;
      });

      const { id, promise, registry } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();

      // No backend job exists yet — only the claim can remember this cancel
      await diffusionServer.cancelImageGeneration(id);
      expect(mockSubmitImageJob).not.toHaveBeenCalled();
      expect((diffusionServer as any).currentGeneration.cancelRequested).toBe(true);

      releaseSpawn();
      const error = await settled;

      expect(error.message).toContain('cancelled');
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(1);
      // The just-submitted job is cancelled through the backend API
      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(registry.get(id).status).toBe('cancelled');
      expect(handles[0]!.stop).not.toHaveBeenCalled();
    });

    it('cancels a still-queued job through the backend instead of killing it', async () => {
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'queued',
        queue_position: 2,
      }));
      const { id, promise } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();

      await diffusionServer.cancelImageGeneration(id);
      await flush();

      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect((await settled).message).toContain('cancelled');

      mockGetJob.mockResolvedValue({ id: 'job-1', status: 'cancelled' });
      await flush();
    });

    it('kills the backend when the queued cancel is refused (409)', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'queued' }));
      mockCancelJob.mockResolvedValue({ cancelled: false, httpStatus: 409 });
      const { id, promise } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();

      await diffusionServer.cancelImageGeneration(id);
      await flush();

      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      await settled;
    });

    it('is an idempotent no-op for a terminal generation', async () => {
      const registry = (diffusionServer as any).registry;
      const id = registry.create({ prompt: 'x' }) as string;
      registry.update(id, { status: 'complete' });

      await expect(diffusionServer.cancelImageGeneration(id)).resolves.toBeUndefined();
      expect(registry.get(id).status).toBe('complete');
    });
  });

  describe('batch generation', () => {
    it('runs count images sequentially and derives seed+i from a given seed', async () => {
      const results = await diffusionServer.executeBatchGeneration({
        prompt: 'x',
        count: 3,
        seed: 100,
      });

      expect(results).toHaveLength(3);
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(3);
      expect(mockBuildRequest.mock.calls.map((call) => call[0].seed)).toEqual([100, 101, 102]);
      expect(results.map((result) => result.seed)).toEqual([100, 101, 102]);
      // One backend serves the whole batch
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
    });

    it('draws a fresh random seed per image when none was given', async () => {
      const results = await diffusionServer.executeBatchGeneration({ prompt: 'x', count: 3 });

      const seeds = results.map((result) => result.seed);
      expect(new Set(seeds).size).toBe(3);
      for (const seed of seeds) {
        expect(seed).toBeGreaterThanOrEqual(0);
      }
    });

    it('keeps the busy gate closed between images', async () => {
      const busyFlags: boolean[] = [];
      let refusal: Promise<string> | undefined;
      mockSubmitImageJob.mockImplementation(async () => {
        busyFlags.push(diffusionServer.getInfo().busy === true);
        refusal ??= diffusionServer.generateImage({ prompt: 'intruder' }).then(
          () => 'resolved',
          (error: Error) => error.message
        );
        return { id: 'job-1' };
      });

      const { promise } = startAsync(diffusionServer, { prompt: 'x', count: 3 });
      await promise;

      expect(busyFlags).toEqual([true, true, true]);
      await expect(refusal).resolves.toContain('busy');
      expect(diffusionServer.getInfo().busy).toBe(false);
    });

    it('reports batch-level progress across the images', async () => {
      const percentages: number[] = [];

      await diffusionServer.executeBatchGeneration({
        prompt: 'x',
        count: 2,
        onProgress: (_step, _total, _stage, pct) => percentages.push(pct ?? -1),
      });

      // Each image's own 100% folds into 50% / 100% of the batch
      expect(percentages).toContain(50);
      expect(percentages.at(-1)).toBe(100);
    });

    it('halts the loop when a cancel lands between images', async () => {
      let submits = 0;
      mockSubmitImageJob.mockImplementation(async () => {
        submits++;
        if (submits === 1) {
          (diffusionServer as any).currentGeneration.cancelRequested = true;
        }
        return { id: 'job-1' };
      });
      const { promise } = startAsync(diffusionServer, { prompt: 'x', count: 3 });

      await expect(promise).rejects.toThrow('cancelled');
      expect(submits).toBe(1);
    });

    it('refuses to start a batch whose claim is already cancelled', async () => {
      const claim = (diffusionServer as any).createGenerationClaim('gen-1');
      claim.cancelRequested = true;

      await expect(
        diffusionServer.executeBatchGeneration({ prompt: 'x', count: 3 })
      ).rejects.toThrow('cancelled');
      expect(mockSubmitImageJob).not.toHaveBeenCalled();
    });
  });

  describe('backend reuse', () => {
    it('reuses one backend for consecutive generations with identical flags', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      await diffusionServer.executeImageGeneration({ prompt: 'two' });

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(2);
    });

    it('respawns when per-generation flag overrides differ', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      await diffusionServer.executeImageGeneration(
        { prompt: 'two' },
        { clipOnCpu: false, vaeOnCpu: false, offloadToCpu: true, diffusionFlashAttention: false }
      );

      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(2);
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[0]!.launch.contextArgs).toEqual(['--clip-on-cpu']);
      expect(handles[1]!.launch.contextArgs).toEqual(['--offload-to-cpu']);
    });
  });

  describe('launch arguments: VRAM auto-detection', () => {
    it('enables --clip-on-cpu on an 8 GB GPU with a 2.9 GB model (headroom < 6 GB)', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const launch = await captureLaunch(mockConfig, smallModelInfo);

      expect(launch.contextArgs).toContain('--clip-on-cpu');
      expect(launch.contextArgs).not.toContain('--vae-on-cpu');
      expect(launch.contextArgs).not.toContain('--offload-to-cpu');
    });

    it('enables nothing on a 12 GB GPU with a 2.9 GB model (headroom >= 6 GB)', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 12 * 1024 ** 3,
      });

      const launch = await captureLaunch(mockConfig, smallModelInfo);

      expect(launch.contextArgs).toEqual([]);
    });

    it('enables both flags on an 8 GB GPU with a 6.5 GB model (headroom < 2 GB)', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const launch = await captureLaunch(mockConfig, mockModelInfo);

      expect(launch.contextArgs).toContain('--clip-on-cpu');
      expect(launch.contextArgs).toContain('--vae-on-cpu');
    });

    it('falls back to --clip-on-cpu when no GPU is available', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({ available: false });

      const launch = await captureLaunch(mockConfig, smallModelInfo);

      expect(launch.contextArgs).toEqual(['--clip-on-cpu']);
    });

    it('escalates to --clip-on-cpu when vramAvailable is critically low', async () => {
      // 12 GB total (no clip normally) but only 4 GB free → 0.52 GB after the footprint
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 12 * 1024 ** 3,
        vramAvailable: 4 * 1024 ** 3,
      });

      const launch = await captureLaunch(mockConfig, smallModelInfo);

      expect(launch.contextArgs).toContain('--clip-on-cpu');
    });

    it('auto-enables --offload-to-cpu when the footprint exceeds 85 % of VRAM', async () => {
      // Flux 2 Klein: 7.1 GB × 1.2 = 8.52 GB > 8 GB × 0.85
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const launch = await captureLaunch(mockConfig, fluxKleinModelInfo);

      expect(launch.contextArgs).toContain('--offload-to-cpu');
    });

    it('auto-enables --diffusion-fa only for models with an llm component', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 24 * 1024 ** 3,
      });

      const withLlm = await captureLaunch(mockConfig, fluxKleinModelInfo);
      const withoutLlm = await captureLaunch(mockConfig, sdxlSplitModelInfo);

      expect(withLlm.contextArgs).toContain('--diffusion-fa');
      expect(withoutLlm.contextArgs).not.toContain('--diffusion-fa');
    });

    it('lets the server config override auto-detection in both directions', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });
      const forcedOff = await captureLaunch({ ...mockConfig, clipOnCpu: false }, smallModelInfo);
      expect(forcedOff.contextArgs).not.toContain('--clip-on-cpu');

      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 24 * 1024 ** 3,
      });
      const forcedOn = await captureLaunch({ ...mockConfig, clipOnCpu: true }, smallModelInfo);
      expect(forcedOn.contextArgs).toContain('--clip-on-cpu');

      const noOffload = await captureLaunch(
        { ...mockConfig, offloadToCpu: false },
        fluxKleinModelInfo
      );
      expect(noOffload.contextArgs).not.toContain('--offload-to-cpu');

      const noFlashAttention = await captureLaunch(
        { ...mockConfig, diffusionFlashAttention: false },
        fluxKleinModelInfo
      );
      expect(noFlashAttention.contextArgs).not.toContain('--diffusion-fa');
    });

    it('keeps generation-only settings out of the launch arguments', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 24 * 1024 ** 3,
      });

      const launch = await captureLaunch(
        { ...mockConfig, batchSize: 4, threads: 8, gpuLayers: 25 },
        smallModelInfo
      );

      // batchSize is a request field (batch_count) now, never a launch flag
      expect(launch.contextArgs).not.toContain('-b');
      expect(launch.contextArgs).not.toContain('4');
      // stable-diffusion.cpp has no --n-gpu-layers (that is llama.cpp)
      expect(launch.contextArgs).not.toContain('--n-gpu-layers');
      expect(launch.modelArgs).not.toContain('--n-gpu-layers');
      // threads reach the runner as a dedicated option (it emits -t)
      expect(launch.threads).toBe(8);
      expect(mockBuildRequest.mock.calls.at(-1)![1]).toBe(4);
    });
  });

  describe('launch arguments: model topology', () => {
    it('uses per-component flags in DIFFUSION_COMPONENT_ORDER for Flux 2 Klein', async () => {
      const launch = await captureLaunch(explicitFlagsConfig, fluxKleinModelInfo);

      expect(launch.modelArgs).toEqual([
        '--diffusion-model',
        fluxKleinModelInfo.components!.diffusion_model!.path,
        '--llm',
        fluxKleinModelInfo.components!.llm!.path,
        '--vae',
        fluxKleinModelInfo.components!.vae!.path,
      ]);
      expect(launch.modelArgs).not.toContain('-m');
      expect(launch.modelArgs).not.toContain('--clip_l');
      expect(launch.modelArgs).not.toContain('--t5xxl');
    });

    it('uses per-component flags in DIFFUSION_COMPONENT_ORDER for an SDXL split model', async () => {
      const launch = await captureLaunch(explicitFlagsConfig, sdxlSplitModelInfo);
      const args = launch.modelArgs as string[];

      expect(args).toEqual([
        '--diffusion-model',
        sdxlSplitModelInfo.components!.diffusion_model!.path,
        '--clip_l',
        sdxlSplitModelInfo.components!.clip_l!.path,
        '--clip_g',
        sdxlSplitModelInfo.components!.clip_g!.path,
        '--vae',
        sdxlSplitModelInfo.components!.vae!.path,
      ]);
      expect(args.indexOf('--diffusion-model')).toBeLessThan(args.indexOf('--clip_l'));
      expect(args.indexOf('--clip_l')).toBeLessThan(args.indexOf('--clip_g'));
      expect(args.indexOf('--clip_g')).toBeLessThan(args.indexOf('--vae'));
      expect(args).not.toContain('--llm');
      expect(args).not.toContain('--llm_vision');
    });

    it('uses -m for a single-file model', async () => {
      const launch = await captureLaunch(explicitFlagsConfig, mockModelInfo);

      expect(launch.modelArgs).toEqual(['-m', mockModelInfo.path]);
      expect(launch.modelArgs).not.toContain('--diffusion-model');
      expect(launch.modelArgs).not.toContain('--vae');
    });

    it('rejects a components map without diffusion_model', async () => {
      const brokenModel: ModelInfo = {
        ...mockModelInfo,
        id: 'broken-model',
        components: {
          llm: { path: '/test/models/diffusion/broken/llm.gguf', size: 2 * 1024 ** 3 },
          vae: { path: '/test/models/diffusion/broken/vae.safetensors', size: 335 * 1024 ** 2 },
        },
      };
      mockModelManager.getModelInfo.mockResolvedValue(brokenModel);
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      await server.start({ ...explicitFlagsConfig, modelId: 'broken-model' });

      await expect(server.executeImageGeneration({ prompt: 'test' })).rejects.toThrow(
        'missing required diffusion_model component'
      );
      expect(server.getBackendInfo().state).toBe('absent');

      await server.stop();
      server.removeAllListeners();
    });
  });

  describe('side effects', () => {
    it('never touches the filesystem for image data', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'x' });

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockGetTempPath).not.toHaveBeenCalled();
      expect(mockDeleteFile).not.toHaveBeenCalled();
      // The only directory the manager creates is the library-owned lora dir
      expect(mockEnsureDirectory).toHaveBeenCalledWith('/test/loras');
    });

    it('forwards backend output lines to the log manager by stream', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'x' });
      const onLog = handles[0]!.launch.onLog as (line: string, stream: string) => void;

      onLog('decoding 1 latents', 'stdout');
      onLog('ggml_cuda warning', 'stderr');

      expect(mockLogWrite).toHaveBeenCalledWith('decoding 1 latents', 'info');
      expect(mockLogWrite).toHaveBeenCalledWith('ggml_cuda warning', 'warn');
    });

    it('keeps progress-bar redraws out of the log file', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'x' });
      const onLog = handles[0]!.launch.onLog as (line: string, stream: string) => void;

      onLog('  |======| 4/4 - 1.20it/s', 'stdout');
      onLog('  |==    | 512/1024 - 25.00MB/s', 'stdout');
      onLog('  |======| 4/4 - 0.80s/it', 'stdout');

      const written = mockLogWrite.mock.calls.map((call) => call[0]);
      expect(written.some((line) => String(line).includes('it/s'))).toBe(false);
      expect(written.some((line) => String(line).includes('MB/s'))).toBe(false);
      expect(written.some((line) => String(line).includes('s/it'))).toBe(false);
    });
  });

  describe('idle timer around jobs', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('arms the idle timer once a generation finishes', async () => {
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      await server.start({ ...explicitFlagsConfig, idleTimeoutMs: 1000 });
      await server.executeImageGeneration({ prompt: 'x' });
      expect(server.getBackendInfo().state).toBe('ready');

      await jest.advanceTimersByTimeAsync(1000);

      expect(handles.at(-1)!.stop).toHaveBeenCalledTimes(1);
      expect(server.getBackendInfo().state).toBe('absent');
      server.removeAllListeners();
    });

    it('disarms the idle timer while a job is in flight', async () => {
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      await server.start({ ...explicitFlagsConfig, idleTimeoutMs: 1000 });
      await server.executeImageGeneration({ prompt: 'first' });

      holdJobGenerating();
      const second = server.executeImageGeneration({ prompt: 'second' });
      await jest.advanceTimersByTimeAsync(5000);

      expect(handles.at(-1)!.stop).not.toHaveBeenCalled();
      expect(server.getBackendInfo().state).toBe('busy');

      mockGetJob.mockResolvedValue(COMPLETED_JOB);
      await jest.advanceTimersByTimeAsync(300);
      await second;
      expect(server.getBackendInfo().state).toBe('ready');
      server.removeAllListeners();
    });
  });

  describe('runAsyncGeneration registry transitions', () => {
    it('walks pending → in_progress → complete', async () => {
      const { id, promise, registry } = startAsync(diffusionServer, {
        prompt: 'x',
        width: 640,
        height: 384,
        seed: 7,
      });

      expect(registry.get(id).status).toBe('in_progress');
      await promise;

      const state = registry.get(id);
      expect(state.status).toBe('complete');
      expect(state.result.format).toBe('png');
      expect(state.result.images).toEqual([
        { image: 'aW1hZ2U=', seed: 7, width: 640, height: 384 },
      ]);
      expect(typeof state.result.timeTaken).toBe('number');
      // The claim is released by its owner once the generation settles
      expect(diffusionServer.getInfo().busy).toBe(false);
    });

    it('bails out immediately when the id was cancelled before it started', async () => {
      const registry = (diffusionServer as any).registry;
      const id = registry.create({ prompt: 'x' }) as string;
      registry.update(id, { status: 'cancelled' });

      await (diffusionServer as any).runAsyncGeneration(id, { prompt: 'x' });

      expect(registry.get(id).status).toBe('cancelled');
      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
    });

    it('never overwrites a cancellation with a completed result', async () => {
      const registry = (diffusionServer as any).registry;
      let cancelledId: string | undefined;
      mockGetJob.mockImplementation(async () => {
        if (cancelledId) registry.update(cancelledId, { status: 'cancelled' });
        return COMPLETED_JOB;
      });

      const started = startAsync(diffusionServer, { prompt: 'x' });
      cancelledId = started.id;
      await started.promise;

      expect(registry.get(started.id).status).toBe('cancelled');
      expect(registry.get(started.id).result).toBeUndefined();
    });
  });

  describe('job polling', () => {
    /** Polls issued for one specific job id (immune to loops left by other tests). */
    const pollsFor = (jobId: string): number =>
      mockGetJob.mock.calls.filter((call) => call[0] === jobId).length;

    it('stops polling once the backend process is gone', async () => {
      mockSubmitImageJob.mockResolvedValue({ id: 'job-poll-stop' });
      mockGetJob.mockImplementation(async (id?: string) => ({ id, status: 'generating' }));

      const generation = diffusionServer.executeImageGeneration({ prompt: 'x' });
      const settled = generation.catch((error: unknown) => error as any);
      await flush();

      handles[0]!.emitExit({ code: 1, signal: null });
      const error = await settled;
      expect(error.details.code).toBe('SD_SERVER_EXITED');

      // Let the orphaned loop take its last (rejecting) turn, then freeze the count
      await sleep(300);
      const calls = pollsFor('job-poll-stop');
      expect(calls).toBeGreaterThan(0);
      await sleep(600);

      expect(pollsFor('job-poll-stop')).toBe(calls);
    });

    it('retries transient poll failures and still completes', async () => {
      let attempt = 0;
      mockGetJob.mockImplementation(async () => {
        attempt++;
        if (attempt <= 2) {
          throw new ServerError('sd-server /sdcpp/v1/jobs/job-1 timed out', {
            code: 'BACKEND_REQUEST_TIMEOUT',
            timeoutMs: 5000,
          });
        }
        return COMPLETED_JOB;
      });

      const result = await diffusionServer.executeImageGeneration({ prompt: 'x' });

      expect(result.image).toEqual(Buffer.from('image'));
      expect(attempt).toBe(3);
      expect(mockLogWrite).toHaveBeenCalledWith(
        expect.stringContaining('Transient backend poll failure 1/3'),
        'warn'
      );
    });

    it('fails after three consecutive transient poll failures', async () => {
      mockSubmitImageJob.mockResolvedValue({ id: 'job-transient' });
      mockGetJob.mockRejectedValue(
        new ServerError('sd-server /sdcpp/v1/jobs/job-transient request failed: socket hang up', {
          code: 'BACKEND_REQUEST_FAILED',
        })
      );

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'x' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('BACKEND_REQUEST_FAILED');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }
      expect(pollsFor('job-transient')).toBe(3);
    });

    it('fails immediately on a non-transient poll error and keeps the backend usable', async () => {
      mockGetJob.mockRejectedValueOnce(
        new ServerError('sd-server job job-1 expired before it was retrieved', {
          code: 'BACKEND_JOB_EXPIRED',
          status: 410,
        })
      );

      try {
        await diffusionServer.executeImageGeneration({ prompt: 'one' });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('BACKEND_JOB_EXPIRED');
        expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
      }
      expect(mockGetJob).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('ready');

      // The backend itself is healthy — the next generation reuses it
      const result = await diffusionServer.executeImageGeneration({ prompt: 'two' });
      expect(result.image).toEqual(Buffer.from('image'));
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel during the submit round-trip', () => {
    it('cancels the just-submitted job through the backend API', async () => {
      let resolveSubmit!: (value: { id: string }) => void;
      mockSubmitImageJob.mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSubmit = resolve;
          })
      );

      const { id, promise, registry } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();

      // The cancel lands while the POST is still in flight: no job id exists yet
      await diffusionServer.cancelImageGeneration(id);
      expect(mockCancelJob).not.toHaveBeenCalled();

      resolveSubmit({ id: 'job-1' });
      await flush();

      expect((await settled).message).toContain('cancelled');
      // The job the backend accepted is not orphaned
      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(registry.get(id).status).toBe('cancelled');
      // The backend is idle for real: the job it accepted was cancelled, not orphaned
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('kills the backend when the late cancel is refused', async () => {
      let resolveSubmit!: (value: { id: string }) => void;
      mockSubmitImageJob.mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSubmit = resolve;
          })
      );
      mockCancelJob.mockResolvedValue({ cancelled: false, httpStatus: 409 });

      const { id, promise } = startAsync(diffusionServer, { prompt: 'x' });
      const settled = promise.catch((error: unknown) => error as Error);
      await flush();

      await diffusionServer.cancelImageGeneration(id);
      resolveSubmit({ id: 'job-1' });
      await flush();

      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect((diffusionServer as any).backend.idleTimer).toBeUndefined();
      expect((await settled).message).toContain('cancelled');
    });
  });

  describe('progress ownership', () => {
    it('ignores stdout from a stale backend handle', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      const staleTap = handles[0]!.launch.onStdoutEvent as (event: unknown) => void;

      holdJobGenerating();
      const onProgress = jest.fn();
      const generation = diffusionServer.executeImageGeneration(
        { prompt: 'two', steps: 4, onProgress },
        { clipOnCpu: false, vaeOnCpu: false, offloadToCpu: true, diffusionFlashAttention: false }
      );
      await flush();
      expect(handles).toHaveLength(2);

      staleTap({ type: 'step', step: 3, steps: 4 });
      expect(onProgress).not.toHaveBeenCalledWith(3, 4, 'diffusion', expect.any(Number));

      // ...while the live child still drives the progress model
      handles[1]!.launch.onStdoutEvent({ type: 'step', step: 2, steps: 4 });
      expect(onProgress).toHaveBeenCalledWith(2, 4, 'diffusion', expect.any(Number));

      mockGetJob.mockResolvedValue(COMPLETED_JOB);
      await generation;
    });

    it('ignores stdout arriving between two jobs on the same backend', async () => {
      await diffusionServer.executeImageGeneration({ prompt: 'one' });
      const tap = handles[0]!.launch.onStdoutEvent as (event: unknown) => void;

      // No generation owns the progress model right now
      tap({ type: 'step', step: 3, steps: 4 });
      tap({ type: 'marker', marker: 'decoding' });

      const onProgress = jest.fn();
      await diffusionServer.executeImageGeneration({ prompt: 'two', steps: 4, onProgress });

      const stages = onProgress.mock.calls.map((call) => call[2]);
      expect(stages[0]).toBe('loading');
      expect(onProgress).not.toHaveBeenCalledWith(3, 4, 'diffusion', expect.any(Number));
    });

    it('exposes the active generation id only while it is in flight', async () => {
      expect(diffusionServer.getActiveGenerationId()).toBeUndefined();

      holdJobGenerating();
      const { id, promise } = startAsync(diffusionServer, { prompt: 'x' });
      await flush();
      expect(diffusionServer.getActiveGenerationId()).toBe(id);

      mockGetJob.mockResolvedValue(COMPLETED_JOB);
      await promise;

      expect(diffusionServer.getActiveGenerationId()).toBeUndefined();
    });
  });

  describe('cold vs warm load estimates', () => {
    /** Cold spawns take ~60 ms and report weight-upload progress while they run. */
    const installSlowSpawn = (): void => {
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        for (let i = 1; i <= 3; i++) {
          await sleep(20);
          options.onStdoutEvent({ type: 'bytes', done: i * 100, total: 300 });
        }
        const handle = createSdServerHandle();
        handle.launch = options;
        return handle;
      });
    };

    const runGeneration = async (prompt: string): Promise<{ stage: string; value: number }[]> => {
      const reported: { stage: string; value: number }[] = [];
      await diffusionServer.executeImageGeneration({
        prompt,
        width: 512,
        height: 512,
        steps: 4,
        onProgress: (_step, _total, stage, percentage) =>
          reported.push({ stage: String(stage), value: percentage ?? -1 }),
      });
      return reported;
    };

    it('keeps a cold generation after warm ones from saturating during the load', async () => {
      installSlowSpawn();
      emitOnSubmit(
        [
          { type: 'marker', marker: 'generating' },
          { type: 'step', step: 4, steps: 4 },
          { type: 'marker', marker: 'decoding' },
          { type: 'marker', marker: 'decoded' },
        ],
        4
      );

      await runGeneration('cold');
      await runGeneration('warm-1');
      await runGeneration('warm-2');

      const internals = diffusionServer as any;
      expect(internals.modelLoadTime).toBeGreaterThanOrEqual(50);
      expect(internals.warmLoadTime).toBeLessThan(internals.modelLoadTime);

      await diffusionServer.releaseBackend({ reason: 'single' });
      const coldAgain = await runGeneration('cold-again');

      // The load stage must never reach 100 %: the denominator still carries the
      // COLD estimate, so a cold generation after warm ones cannot regress
      const loading = coldAgain.filter((entry) => entry.stage === 'loading');
      expect(loading.length).toBeGreaterThan(1);
      expect(loading.every((entry) => entry.value < 100)).toBe(true);
      expect(coldAgain.at(-1)!.value).toBe(100);
      expect(coldAgain.filter((entry) => entry.value === 100)).toHaveLength(1);
    });

    it('seeds the denominator with the warm estimate only when a backend is resident', async () => {
      const internals = diffusionServer as any;
      internals.modelLoadTime = 20_000;
      internals.warmLoadTime = 250;
      const config = { prompt: 'x', width: 512, height: 512, steps: 4 };

      internals.initializeProgressTracking(config, false);
      const coldTotal = internals.totalEstimatedTime as number;
      internals.initializeProgressTracking(config, true);
      const warmTotal = internals.totalEstimatedTime as number;

      expect(coldTotal - warmTotal).toBeCloseTo(20_000 - 250, 6);
    });
  });
});
