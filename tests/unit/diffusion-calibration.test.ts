/**
 * Unit tests for DiffusionServerManager.calibrate() (offload calibration)
 * and the pickRecommended pure helper.
 *
 * The sweep runs against the mocked `sd-server` runner + client pair: each
 * generation is one submitted backend job, scriptable by index (failed job,
 * process exit, hang) so the sweep's failure classification and abort paths stay
 * deterministic. Winner picking is tested as a pure function — sweep tests never
 * assert wall-clock ordering.
 *
 * Launch counts are the signature of the measured mode, because offload flags are
 * LAUNCH arguments and a released backend must be respawned:
 * - `usageMode: 'single'` (the default) → combos × (1 warmup + samples × sizes)
 *   launches: every timed sample is its own cold spawn → generate → release cycle.
 * - `usageMode: 'burst'` → one launch per combo: the warmup absorbs the load and the
 *   timed samples are warm.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type {
  CalibrationRun,
  DiffusionBackendStatusEvent,
  DiffusionCalibrationConfig,
  DiffusionCalibrationGeneration,
  DiffusionCalibrationProgress,
  DiffusionCalibrationReport,
  DiffusionServerConfig,
  ModelInfo,
} from '../../src/types/index.js';

// Backend seam (shared with the DiffusionServerManager suites): the sweep drives
// `sd-server` through the runner + client pair.
import {
  createSdServerHandle,
  handles,
  mockBuildRequest,
  mockGetJob,
  mockStartSdServerRunner,
  mockSubmitImageJob,
  resetSdServerMocks,
  type FakeSdServerHandle,
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

// Mock http module (the wrapper binds (port, host, callback))
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
  constructor(_path: string) {
    // Path unused in tests
  }
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
const mockDeleteFile = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: mockEnsureDirectory,
  deleteFile: mockDeleteFile,
}));

// Mock paths
const mockGetTempPath = jest.fn();
const mockGetBinaryPath = jest.fn(
  (type: string, binaryName: string) => `/test/binaries/${type}/${binaryName}`
);

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  BASE_DIR: '/test/userData',
  PATHS: {
    root: '/test',
    models: '/test/models',
    binaries: '/test/binaries',
    logs: '/test/logs',
    temp: '/test/temp',
    loras: '/test/loras',
  },
  getBinaryPath: mockGetBinaryPath,
  getTempPath: mockGetTempPath,
}));

// Import after mocking
const { DiffusionServerManager, pickRecommended } = await import(
  '../../src/managers/DiffusionServerManager.js'
);
const { DIFFUSION_CALIBRATION_DEFAULTS } = await import('../../src/config/defaults.js');

/** Script for one generation (by generation index, i.e. submitted job order) */
interface GenerationScript {
  /** The backend job ends 'failed' with this message */
  fail?: string;
  /** The backend process dies mid-job with this exit code */
  exit?: number;
  /** stderr tail the failure classifier sees */
  stderr?: string;
  /** Never finish — only a cancel/kill ends it (abort tests) */
  hang?: boolean;
}

interface JobRecord {
  handle: FakeSdServerHandle;
  script: GenerationScript;
  exitEmitted: boolean;
}

describe('DiffusionServerManager calibration', () => {
  let diffusionServer: InstanceType<typeof DiffusionServerManager>;

  // 2 GB model on an 8 GB GPU → footprint 2.4 GB, headroom 5.6 GB:
  // auto-detection resolves clipOnCpu=true, vaeOnCpu=false, offloadToCpu=false
  const mockModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 2 * 1024 * 1024 * 1024,
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: {
      type: 'url',
      url: 'https://example.com/sdxl-turbo.gguf',
    },
  };

  const mockServerConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
  };

  // Required generation params (mirror production). Tests default to a distilled
  // cfg=1 profile; assertions that care about steps/sampler rely on these.
  const BASE_GEN: DiffusionCalibrationGeneration = { steps: 4, cfgScale: 1, sampler: 'euler' };
  const DEFAULT_SIZES = [{ width: 768, height: 768 }];

  /**
   * Invoke calibrate() with the now-required `sizes` + `generation` filled in.
   * Overrides win; a partial `generation` is merged onto BASE_GEN.
   */
  const runCalibrate = (
    target: InstanceType<typeof DiffusionServerManager>,
    overrides: Omit<Partial<DiffusionCalibrationConfig>, 'generation'> & {
      generation?: Partial<DiffusionCalibrationGeneration>;
    } = {}
  ): Promise<DiffusionCalibrationReport> => {
    const { generation, sizes, modelId, ...rest } = overrides;
    return target.calibrate({
      modelId: modelId ?? 'sdxl-turbo',
      sizes: sizes ?? DEFAULT_SIZES,
      generation: { ...BASE_GEN, ...generation },
      ...rest,
    });
  };

  /** Normalized ImageGenerationConfig of every generation, in order */
  let generationConfigs: any[] = [];
  /** Per-generation-index script; return undefined for a clean instant success */
  let generationScript: (index: number) => GenerationScript | undefined;
  let generationIndex = 0;
  let jobs: Map<string, JobRecord>;

  /** Number of backend jobs submitted (= generations executed) */
  const generationCount = (): number => mockSubmitImageJob.mock.calls.length;
  /** Number of `sd-server` processes launched (cold spawns paid by the sweep) */
  const launchCount = (): number => mockStartSdServerRunner.mock.calls.length;
  /** Offload flags of every launch, in order */
  const launchContextArgs = (): string[][] =>
    handles.map((handle) => handle.launch.contextArgs as string[]);

  /** Give every spawn a measurable cost, so a cold `loadMs` is distinguishable */
  const withSpawnDelay = (ms: number): void => {
    mockStartSdServerRunner.mockImplementation(async (options: any) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const handle = createSdServerHandle();
      handle.launch = options;
      return handle;
    });
  };

  /** Pin process.platform for one test; the returned function restores it */
  const withPlatform = (platform: string): (() => void) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    return () => Object.defineProperty(process, 'platform', original);
  };

  const GPU_TOTAL_BYTES = 8 * 1024 ** 3;

  /**
   * Script the VRAM telemetry the calibration sampler reads.
   *
   * The sampler goes through the shared telemetry-capture adapter, which always passes
   * TelemetryCommandOptions; auto-detection and the report's machine block call
   * getGPUInfo() bare. That difference is the seam used to script only the sampler's
   * readings (the last entry repeats).
   */
  const scriptVramReadings = (readings: (number | undefined)[]): void => {
    let index = 0;
    mockSystemInfo.getGPUInfo.mockImplementation(async (options?: any) => {
      const base = {
        available: true,
        type: 'nvidia',
        name: 'RTX Test 8GB',
        vram: GPU_TOTAL_BYTES,
      };
      if (!options) return { ...base, vramAvailable: 7 * 1024 ** 3 };
      const value = readings[Math.min(index, readings.length - 1)];
      index++;
      return { ...base, vramAvailable: value };
    });
  };

  /** getGPUInfo calls made by the sampler (they carry telemetry options) */
  const telemetryReadCount = (): number =>
    mockSystemInfo.getGPUInfo.mock.calls.filter((call: any[]) => call[0] !== undefined).length;

  /**
   * Install the job harness: every generation submits one job that completes on its
   * first poll (unless scripted otherwise) and replays the backend's stdout markers.
   */
  const installJobHarness = (): void => {
    generationConfigs = [];
    generationIndex = 0;
    jobs = new Map();

    mockBuildRequest.mockImplementation((config: any, batchSize?: number) => {
      generationConfigs.push(config);
      return { prompt: config.prompt, seed: config.seed, batch_count: batchSize ?? 1 };
    });

    mockSubmitImageJob.mockImplementation(async () => {
      const index = generationIndex++;
      const script = generationScript(index) ?? {};
      const handle = handles[handles.length - 1]!;
      const id = `job-${index}`;
      jobs.set(id, { handle, script, exitEmitted: false });
      if (script.stderr) handle.stderrTail = script.stderr;

      // Structured stdout of one generation (sd.cpp marker literals via the runner tap)
      if (!script.hang) {
        handle.launch.onStdoutEvent({ type: 'marker', marker: 'generating' });
        handle.launch.onStdoutEvent({ type: 'step', step: 2, steps: 4 });
        handle.launch.onStdoutEvent({ type: 'step', step: 4, steps: 4 });
        handle.launch.onStdoutEvent({ type: 'marker', marker: 'decoding' });
        handle.launch.onStdoutEvent({ type: 'marker', marker: 'decoded' });
      }
      return { id };
    });

    mockGetJob.mockImplementation(async (id: string) => {
      const record = jobs.get(id);
      if (!record) return { id, status: 'completed', result: { images: [] } };
      // A dead backend ends the (already rejected) poll loop instead of spinning
      if (record.handle.state === 'stopped') return { id, status: 'cancelled' };
      if (record.script.hang) return { id, status: 'generating' };
      if (record.script.exit !== undefined) {
        if (!record.exitEmitted) {
          record.exitEmitted = true;
          record.handle.emitExit({ code: record.script.exit, signal: null });
        }
        return { id, status: 'generating' };
      }
      if (record.script.fail) {
        return { id, status: 'failed', error: { message: record.script.fail } };
      }
      return {
        id,
        status: 'completed',
        result: { output_format: 'png', images: [{ index: 0, b64_json: 'aW1hZ2U=' }] },
      };
    });
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
    mockGetTempPath.mockImplementation((filename: string) => `/test/temp/${filename}`);
    mockDeleteFile.mockResolvedValue(undefined);
    mockEnsureDirectory.mockResolvedValue(undefined);

    diffusionServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

    mockModelManager.getModelInfo.mockResolvedValue(mockModelInfo);
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 10 * 1024 ** 3, used: 6 * 1024 ** 3 },
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
    mockSystemInfo.getMemoryInfo.mockReturnValue({
      total: 16 * 1024 ** 3,
      available: 10 * 1024 ** 3,
      used: 6 * 1024 ** 3,
    });
    mockSystemInfo.getGPUInfo.mockResolvedValue({
      available: true,
      type: 'nvidia',
      name: 'RTX Test 8GB',
      vram: 8 * 1024 ** 3,
      vramAvailable: 7 * 1024 ** 3,
    });
    mockIsServerResponding.mockResolvedValue(false);
    mockIsPortBindable.mockResolvedValue(true);
    mockFindFreePort.mockResolvedValue(49999);

    generationScript = () => undefined; // all generations succeed by default
    installJobHarness();
  });

  afterEach(() => {
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
  });

  describe('pickRecommended (pure)', () => {
    const run = (
      width: number,
      time: number | undefined,
      status: CalibrationRun['status'],
      combo: CalibrationRun['combo']
    ): CalibrationRun => ({
      size: { width, height: width },
      combo,
      status,
      ...(time !== undefined ? { timeTakenMs: time } : {}),
    });

    it('picks the fastest OK combo per size', () => {
      const runs = [
        run(768, 200, 'ok', { label: 'a' }),
        run(768, 150, 'ok', { label: 'b', clipOnCpu: false }),
        run(768, undefined, 'oom', { label: 'c', offloadToCpu: true }),
      ];
      const recommended = pickRecommended(runs, 5);
      expect(recommended['768x768']).toEqual({ label: 'b', clipOnCpu: false });
    });

    it('prefers fewer forced flags within the tolerance window', () => {
      const runs = [
        run(768, 100, 'ok', {
          label: 'forced',
          clipOnCpu: false,
          vaeOnCpu: false,
          offloadToCpu: true,
        }),
        run(768, 104, 'ok', { label: 'auto' }), // within 5% of 100 → fewer flags wins
      ];
      const recommended = pickRecommended(runs, 5);
      expect(recommended['768x768']).toEqual({ label: 'auto' });
    });

    it('does not apply the tie-break outside the tolerance window', () => {
      const runs = [
        run(768, 100, 'ok', {
          label: 'forced',
          clipOnCpu: false,
          vaeOnCpu: false,
          offloadToCpu: true,
        }),
        run(768, 106, 'ok', { label: 'auto' }), // > 105 → fastest wins despite more flags
      ];
      const recommended = pickRecommended(runs, 5);
      expect(recommended['768x768']!.label).toBe('forced');
    });

    it('omits sizes where every combo failed and keys sizes independently', () => {
      const runs = [
        run(768, undefined, 'oom', { label: 'a' }),
        run(768, undefined, 'error', { label: 'b', clipOnCpu: false }),
        run(512, 90, 'ok', { label: 'a' }),
      ];
      const recommended = pickRecommended(runs, 5);
      expect(recommended['768x768']).toBeUndefined();
      expect(recommended['512x512']).toEqual({ label: 'a' });
    });
  });

  describe('guards', () => {
    it('throws if the server is running', async () => {
      await diffusionServer.start(mockServerConfig);

      await expect(runCalibrate(diffusionServer, { modelId: 'sdxl-turbo' })).rejects.toThrow(
        /Cannot calibrate while the server is running/
      );

      await diffusionServer.stop();
    });

    it('rejects invalid sizes (non-multiple of 64) before any launch', async () => {
      await expect(
        runCalibrate(diffusionServer, {
          modelId: 'sdxl-turbo',
          sizes: [{ width: 500, height: 512 }],
        })
      ).rejects.toThrow(/multiples of 64/);
      expect(launchCount()).toBe(0);
    });

    it('rejects a pre-aborted signal immediately with empty partial runs', async () => {
      const controller = new AbortController();
      controller.abort();

      try {
        await runCalibrate(diffusionServer, { modelId: 'sdxl-turbo', signal: controller.signal });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR'); // top-level code is generic
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
        expect(error.details.runs).toEqual([]);
      }
      expect(launchCount()).toBe(0);
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('blocks start() while a calibration is in flight', async () => {
      let startRejection: Promise<void> | undefined;
      const calibratePromise = runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        onProgress: (p) => {
          if (p.phase === 'warmup' && !startRejection) {
            expect(diffusionServer.isCalibrating()).toBe(true);
            startRejection = expect(diffusionServer.start(mockServerConfig)).rejects.toThrow(
              /calibration is in progress/
            );
          }
        },
        combos: [{ label: 'auto' }],
      });

      await calibratePromise;
      expect(startRejection).toBeDefined();
      await startRejection;
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('rejects a second calibrate() while one is in flight', async () => {
      let secondRejection: Promise<void> | undefined;
      const calibratePromise = runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        onProgress: (p) => {
          if (p.phase === 'warmup' && !secondRejection) {
            secondRejection = expect(
              runCalibrate(diffusionServer, { modelId: 'sdxl-turbo' })
            ).rejects.toThrow(/already in progress/);
          }
        },
        combos: [{ label: 'auto' }],
      });

      await calibratePromise;
      expect(secondRejection).toBeDefined();
      await secondRejection;
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('resolves validation flags from calibration state instead of stale stopped-server config', async () => {
      (
        diffusionServer as unknown as {
          _config: DiffusionServerConfig;
        }
      )._config = {
        modelId: 'old-model',
        clipOnCpu: false,
        vaeOnCpu: true,
        offloadToCpu: true,
        diffusionFlashAttention: true,
      };

      await runCalibrate(diffusionServer, {
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // The mocked 2 GB model on an 8 GB GPU auto-resolves only clip-on-cpu.
      // Stale flags from a prior stopped configuration must not leak into the
      // provisioning test that calibrate() performs before its sweep.
      expect(mockBinaryConfigs[0]).toMatchObject({
        binaryName: 'sd-server',
        testOptimizationArgs: ['--clip-on-cpu'],
      });
    });
  });

  describe('sweep structure and per-run flag resolution', () => {
    it('runs combos × (warmup + samples × sizes) generations on one launch per combo in burst mode', async () => {
      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        usageMode: 'burst',
        sizes: [
          { width: 768, height: 768 },
          { width: 512, height: 1024 },
        ],
        samples: 1,
        combos: [
          { label: 'clip-gpu', clipOnCpu: false },
          { label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true },
        ],
      });

      // 2 combos × (1 warmup + 1 sample × 2 sizes) = 6 generations...
      expect(generationCount()).toBe(6);
      // ...on one warm backend per combo (the samples reuse the warmup's process)
      expect(launchCount()).toBe(2);
      expect(report.usageMode).toBe('burst');

      // Combo 1 (clipOnCpu: false overrides auto=true): no offload flags at all
      expect(launchContextArgs()[0]).toEqual([]);
      // Combo 2: all three forced on
      expect(launchContextArgs()[1]).toEqual(['--clip-on-cpu', '--vae-on-cpu', '--offload-to-cpu']);

      // Identical work per generation: fixed seed/steps/sampler; warmup at first size
      for (const config of generationConfigs) {
        expect(config.seed).toBe(42);
        expect(config.steps).toBe(4);
        expect(config.cfgScale).toBe(1);
        expect(config.sampler).toBe('euler');
      }
      const sizeOf = (config: any): string => `${config.width}x${config.height}`;
      expect(sizeOf(generationConfigs[0])).toBe('768x768'); // warmup @ first size
      expect(sizeOf(generationConfigs[1])).toBe('768x768');
      expect(sizeOf(generationConfigs[2])).toBe('512x1024');

      // One run per (combo, size), all OK, with timings and resolved flags
      expect(report.runs).toHaveLength(4);
      for (const calRun of report.runs) {
        expect(calRun.status).toBe('ok');
        expect(calRun.timeTakenMs).toBeDefined();
        expect(calRun.samplesMs).toHaveLength(1);
        expect(calRun.resolved).toBeDefined();
      }
      // Combo 1 resolved: override wins over auto (auto would be clip=true)
      const clipGpuRun = report.runs.find(
        (r) => r.combo.label === 'clip-gpu' && r.size.width === 768
      )!;
      expect(clipGpuRun.resolved!.clipOnCpu).toBe(false);

      // Recommendation exists for both sizes; methodology echo present
      expect(report.recommended['768x768']).toBeDefined();
      expect(report.recommended['512x1024']).toBeDefined();
      expect(report.steps).toBe(4);
      expect(report.cfgScale).toBe(1);
      expect(report.sampler).toBe('euler');
      expect(report.samples).toBe(1);
      expect(report.modelId).toBe('sdxl-turbo');
      expect(report.machine.gpuName).toBe('RTX Test 8GB');
      expect(report.machine.vramBytes).toBe(8 * 1024 ** 3);

      // Server left stopped, state restored
      expect(diffusionServer.getStatus()).toBe('stopped');
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('spawns a cold backend per warmup and per timed sample in single mode (default)', async () => {
      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        sizes: [
          { width: 768, height: 768 },
          { width: 512, height: 1024 },
        ],
        samples: 1,
        combos: [
          { label: 'clip-gpu', clipOnCpu: false },
          { label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true },
        ],
      });

      // Same 6 generations as burst, but every one of them is cold:
      // 2 combos × (1 warmup + 1 sample × 2 sizes) = 6 launches
      expect(generationCount()).toBe(6);
      expect(launchCount()).toBe(6);
      // ...and each is released before the next one starts
      for (const handle of handles) {
        expect(handle.stop).toHaveBeenCalled();
      }

      // Flags follow the combo, not the launch: 3 launches per combo
      expect(launchContextArgs()).toEqual([
        [],
        [],
        [],
        ['--clip-on-cpu', '--vae-on-cpu', '--offload-to-cpu'],
        ['--clip-on-cpu', '--vae-on-cpu', '--offload-to-cpu'],
        ['--clip-on-cpu', '--vae-on-cpu', '--offload-to-cpu'],
      ]);

      // Methodology echo: 'single' is the library default, and the policy version
      // marks the report as post-sd-server (absent = pre-migration v1)
      expect(report.usageMode).toBe('single');
      expect(report.usageMode).toBe(DIFFUSION_CALIBRATION_DEFAULTS.usageMode);
      expect(report.policyVersion).toBe('diffusion-offload-v2');
      expect(report.policyVersion).toBe(DIFFUSION_CALIBRATION_DEFAULTS.policyVersion);

      // The warmup stays discarded in both modes: one timed sample per (combo, size)
      expect(report.runs).toHaveLength(4);
      for (const calRun of report.runs) {
        expect(calRun.samplesMs).toHaveLength(1);
      }
    });

    it('releases the backend when the sweep ends', async () => {
      const events: DiffusionBackendStatusEvent[] = [];
      diffusionServer.on('backend-status', (event: DiffusionBackendStatusEvent) =>
        events.push(event)
      );

      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // Default 'single': warmup + 1 timed sample = 2 cold backends, both released
      expect(launchCount()).toBe(2);
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[1]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo()).toEqual({ state: 'absent' });
      expect(events.at(-1)).toMatchObject({ state: 'absent', reason: 'calibration' });
    });

    it('releases the burst backend at the end of each combo', async () => {
      const events: DiffusionBackendStatusEvent[] = [];
      diffusionServer.on('backend-status', (event: DiffusionBackendStatusEvent) =>
        events.push(event)
      );

      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        usageMode: 'burst',
        samples: 2,
        combos: [{ label: 'auto' }, { label: 'clip-gpu', clipOnCpu: false }],
      });

      // One warm backend per combo, each killed before the next combo launches
      expect(generationCount()).toBe(6);
      expect(launchCount()).toBe(2);
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[1]!.stop).toHaveBeenCalledTimes(1);
      // The releases are attributed to the sweep (the orchestrator ignores that reason)
      expect(
        events.filter((event) => event.state === 'absent').every((e) => e.reason === 'calibration')
      ).toBe(true);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
    });

    it('lets auto-detection resolve omitted flags (auto combo carries resolved values)', async () => {
      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // 8 GB GPU, 2 GB model → auto: clip=true, vae=false, offload=false.
      // Re-resolved per generation, so every cold spawn of the sweep agrees.
      expect(launchContextArgs()).toEqual([['--clip-on-cpu'], ['--clip-on-cpu']]);
      const calRun = report.runs[0]!;
      expect(calRun.resolved).toEqual({
        clipOnCpu: true,
        vaeOnCpu: false,
        offloadToCpu: false,
        diffusionFlashAttention: false,
      });
      // Recommended combo is the AS-REQUESTED combo (auto), not the resolved flags
      expect(report.recommended['768x768']).toEqual({ label: 'auto' });
    });

    it('mirrors production batching through generation.batchSize', async () => {
      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
        generation: { batchSize: 2 },
      });

      for (const call of mockBuildRequest.mock.calls) {
        expect(call[1]).toBe(2);
      }
    });
  });

  describe('stage timing and medians (backend-marker driven)', () => {
    it('populates stageMs from the backend markers and medians multi-sample timings', async () => {
      const progressEvents: DiffusionCalibrationProgress[] = [];

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 2,
        combos: [{ label: 'auto' }],
        onProgress: (p) => progressEvents.push(p),
      });

      // 1 combo × (1 warmup + 2 samples) = 3 generations, each cold under 'single'
      expect(generationCount()).toBe(3);
      expect(launchCount()).toBe(3);
      const calRun = report.runs[0]!;
      expect(calRun.status).toBe('ok');

      // Happy-path median of two samples = mean of the pair
      expect(calRun.samplesMs).toHaveLength(2);
      const [s1, s2] = calRun.samplesMs!;
      expect(calRun.timeTakenMs).toBeCloseTo((s1! + s2!) / 2, 5);

      // Stage split extracted from the stdout stage markers (instant mock → 0 ms is fine)
      expect(calRun.stageMs).toBeDefined();
      expect(calRun.stageMs!.loadMs).toBeGreaterThanOrEqual(0);
      expect(calRun.stageMs!.diffusionMs).toBeGreaterThanOrEqual(0);
      expect(calRun.stageMs!.decodeMs).toBeGreaterThanOrEqual(0);

      // The step bars drove within-generation progress into the sweep stream...
      expect(
        progressEvents.some(
          (p) =>
            (p.phase === 'warmup' || p.phase === 'sampling') && p.generationPercent !== undefined
        )
      ).toBe(true);
      // ...and overall stays monotonic through the fractional folding
      let last = -1;
      for (const p of progressEvents) {
        expect(p.overallPercent).toBeGreaterThanOrEqual(last);
        last = p.overallPercent;
      }
    });

    it('measures a cold load in single mode and a warm one in burst mode', async () => {
      // 40 ms of spawn cost separates "this loadMs contains a process start" from
      // "this loadMs is only the pre-sampling work on resident weights"
      withSpawnDelay(40);

      const cold = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // 'single': loadStartTime is the spawn, so the load stage swallows it
      expect(cold.usageMode).toBe('single');
      expect(cold.runs[0]!.stageMs!.loadMs).toBeGreaterThanOrEqual(40);

      resetSdServerMocks();
      withSpawnDelay(40);
      installJobHarness();

      const warm = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        usageMode: 'burst',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // 'burst': the warmup paid for the spawn; the timed sample's loadStartTime is
      // the job submission, so loadMs is only the small pre-sampling time
      expect(warm.usageMode).toBe('burst');
      expect(warm.runs[0]!.stageMs!.loadMs).toBeLessThan(40);
    });

    it('hands back per-sweep combo copies, never the module default objects', async () => {
      const report = await runCalibrate(diffusionServer, { modelId: 'sdxl-turbo', samples: 1 });

      // Default sweep: 6 combos × (1 warmup + 1 sample × 1 size) = 12 generations,
      // all cold under the default 'single' mode
      expect(generationCount()).toBe(12);
      expect(launchCount()).toBe(12);
      const firstDefault = DIFFUSION_CALIBRATION_DEFAULTS.combos[0]!;
      const firstRun = report.runs.find((r) => r.combo.label === firstDefault.label)!;
      expect(firstRun.combo).toEqual(firstDefault);
      expect(firstRun.combo).not.toBe(firstDefault); // mutation-safe copy
    });
  });

  describe('failure classification', () => {
    it('classifies an OOM combo from a backend exit, continues the sweep, and excludes it', async () => {
      // Combo B's warmup (generation index 2) crashes with CUDA OOM
      generationScript = (index) =>
        index === 2
          ? { exit: 1, stderr: 'ggml_cuda_host_malloc: CUDA error: out of memory' }
          : undefined;

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [
          { label: 'auto' },
          { label: 'all-resident', clipOnCpu: false, vaeOnCpu: false, offloadToCpu: false },
        ],
      });

      // Combo A: warmup + 1 sample; combo B: failed warmup only (samples skipped)
      expect(generationCount()).toBe(3);

      const okRun = report.runs.find((r) => r.combo.label === 'auto')!;
      const oomRun = report.runs.find((r) => r.combo.label === 'all-resident')!;
      expect(okRun.status).toBe('ok');
      expect(oomRun.status).toBe('oom');
      expect(oomRun.error).toContain('exited with code 1');
      expect(oomRun.timeTakenMs).toBeUndefined();

      expect(report.recommended['768x768']).toEqual({ label: 'auto' });
    });

    it('classifies an OOM combo from a failed backend job (details.stderr)', async () => {
      generationScript = (index) =>
        index === 0
          ? { fail: 'image generation failed', stderr: 'cudaMalloc failed: out of memory' }
          : undefined;

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      const calRun = report.runs[0]!;
      expect(calRun.status).toBe('oom');
      expect(calRun.error).toContain('stable-diffusion.cpp job failed');
      expect(report.recommended['768x768']).toBeUndefined();
    });

    it('classifies a non-OOM failure as error and keeps successful samplesMs', async () => {
      // Second timed sample (generation index 2: warmup, sample1, sample2) fails generically
      generationScript = (index) =>
        index === 2 ? { exit: 1, stderr: 'some unrelated failure' } : undefined;

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 2,
        combos: [{ label: 'auto' }],
      });

      expect(generationCount()).toBe(3);
      const calRun = report.runs[0]!;
      expect(calRun.status).toBe('error');
      expect(calRun.samplesMs).toHaveLength(1); // first sample kept for diagnostics
      expect(calRun.timeTakenMs).toBeUndefined(); // never recommended
      expect(report.recommended['768x768']).toBeUndefined();
    });

    it('records a warmup failure on the first size but still attempts later sizes', async () => {
      const progress: DiffusionCalibrationProgress[] = [];
      // Warmup (generation 0) OOMs; the second size's sample (generation 1) succeeds
      generationScript = (index) =>
        index === 0 ? { exit: 1, stderr: 'cudaMalloc failed: out of memory' } : undefined;

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        sizes: [
          { width: 768, height: 768 },
          { width: 512, height: 512 },
        ],
        samples: 1,
        combos: [{ label: 'auto' }],
        onProgress: (p) => progress.push(p),
      });

      expect(generationCount()).toBe(2); // failed warmup + second size's sample
      // The crashed backend is gone, so the surviving generation respawns one
      expect(launchCount()).toBe(2);

      const firstSizeRun = report.runs.find((r) => r.size.width === 768)!;
      const secondSizeRun = report.runs.find((r) => r.size.width === 512)!;
      expect(firstSizeRun.status).toBe('oom');
      expect(secondSizeRun.status).toBe('ok');

      // Progress still reaches 100 despite the skipped units
      expect(progress[progress.length - 1]!.phase).toBe('done');
      expect(progress[progress.length - 1]!.overallPercent).toBe(100);
    });
  });

  describe('progress reporting', () => {
    it('reports phases in order, monotonic 0→100, with event parity', async () => {
      const callbackPayloads: DiffusionCalibrationProgress[] = [];
      const eventPayloads: DiffusionCalibrationProgress[] = [];
      diffusionServer.on('calibration-progress', (p: DiffusionCalibrationProgress) =>
        eventPayloads.push(p)
      );

      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }, { label: 'clip-gpu', clipOnCpu: false }],
        onProgress: (p) => callbackPayloads.push(p),
      });

      // Same payload stream on both channels
      expect(eventPayloads).toEqual(callbackPayloads);

      // Phase ordering: preparing first, done last, warmup before its sampling
      expect(callbackPayloads[0]!.phase).toBe('preparing');
      expect(callbackPayloads[0]!.overallPercent).toBe(0);
      expect(callbackPayloads[callbackPayloads.length - 1]!.phase).toBe('done');
      expect(callbackPayloads[callbackPayloads.length - 1]!.overallPercent).toBe(100);
      const phases = callbackPayloads.map((p) => p.phase);
      expect(phases).toContain('warmup');
      expect(phases).toContain('sampling');
      expect(phases.indexOf('warmup')).toBeLessThan(phases.indexOf('sampling'));

      // Monotonic overall percent
      for (let i = 1; i < callbackPayloads.length; i++) {
        expect(callbackPayloads[i]!.overallPercent).toBeGreaterThanOrEqual(
          callbackPayloads[i - 1]!.overallPercent
        );
      }

      // Combo context present on warmup/sampling payloads
      const sampling = callbackPayloads.find((p) => p.phase === 'sampling')!;
      expect(sampling.combo).toBeDefined();
      expect(sampling.comboCount).toBe(2);
      expect(sampling.sampleCount).toBe(1);
    });

    it('survives throwing onProgress callbacks and event listeners', async () => {
      diffusionServer.on('calibration-progress', () => {
        throw new Error('listener boom');
      });

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
        onProgress: () => {
          throw new Error('callback boom');
        },
      });

      expect(report.runs).toHaveLength(1);
      expect(report.runs[0]!.status).toBe('ok');
    });
  });

  describe('abort', () => {
    it('aborts between generations with partial runs attached', async () => {
      const controller = new AbortController();

      try {
        await runCalibrate(diffusionServer, {
          modelId: 'sdxl-turbo',
          samples: 1,
          combos: [{ label: 'auto' }, { label: 'clip-gpu', clipOnCpu: false }],
          signal: controller.signal,
          onProgress: (p) => {
            // Abort when the second combo is about to warm up
            if (p.phase === 'warmup' && p.comboIndex === 1) {
              controller.abort();
            }
          },
        });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR');
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
        // Combo A's run completed before the abort
        expect(error.details.runs).toHaveLength(1);
        expect(error.details.runs[0].combo.label).toBe('auto');
      }

      expect(diffusionServer.isCalibrating()).toBe(false);
      // No backend survives an aborted sweep
      expect(diffusionServer.getBackendInfo().state).toBe('absent');

      // A fresh calibrate works afterwards (state fully torn down)
      installJobHarness();
      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });
      expect(report.runs[0]!.status).toBe('ok');
    });

    it('aborts an in-flight generation via the cancel path', async () => {
      const controller = new AbortController();
      const events: DiffusionBackendStatusEvent[] = [];
      diffusionServer.on('backend-status', (event: DiffusionBackendStatusEvent) =>
        events.push(event)
      );
      // The first timed sample hangs; abort fires while it is in flight
      generationScript = (index) => {
        if (index === 1) {
          setTimeout(() => controller.abort(), 10);
          return { hang: true };
        }
        return undefined;
      };

      try {
        await runCalibrate(diffusionServer, {
          modelId: 'sdxl-turbo',
          samples: 1,
          combos: [{ label: 'auto' }],
          signal: controller.signal,
        });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
      }

      // The hanging backend (the timed sample's own cold spawn) was killed via the
      // cancel path, not merely by the sweep's 'calibration' release in the finally
      expect(handles.at(-1)!.stop).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.reason)).toContain('cancel');
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('does not start a generation when the abort lands during the cold release', async () => {
      const controller = new AbortController();

      try {
        await runCalibrate(diffusionServer, {
          modelId: 'sdxl-turbo',
          samples: 1,
          combos: [{ label: 'auto' }],
          signal: controller.signal,
          onProgress: (p) => {
            // The 'sampling' emit happens BEFORE the release that makes the sample
            // cold, i.e. exactly in the window the release opens
            if (p.phase === 'sampling' && !controller.signal.aborted) {
              controller.abort();
            }
          },
        });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
      }

      // Only the warmup ran: the abort is re-checked after the release, so the sweep
      // never buys a full extra generation while tearing the backend down
      expect(generationCount()).toBe(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(diffusionServer.isCalibrating()).toBe(false);
    });
  });

  describe('SD3.5-Large guard', () => {
    it('skips clipOnCpu combos for SD3.5-Large models and records them', async () => {
      mockModelManager.getModelInfo.mockResolvedValue({
        ...mockModelInfo,
        id: 'sd3.5-large-q4',
        name: 'Stable Diffusion 3.5 Large',
      });

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sd3.5-large-q4',
        samples: 1,
      });

      // Default set has exactly one clipOnCpu: true combo (max-savings)
      expect(report.skippedCombos).toHaveLength(1);
      expect(report.skippedCombos![0]!.combo.label).toBe('max-savings');
      expect(report.skippedCombos![0]!.reason).toContain('1578');

      // 5 active combos × (1 warmup + 1 sample × 1 size) = 10 cold generations
      expect(report.runs).toHaveLength(5);
      expect(generationCount()).toBe(10);
      expect(launchCount()).toBe(10);
      expect(report.runs.every((r) => r.combo.clipOnCpu !== true)).toBe(true);
    });
  });

  describe('LLM orchestration', () => {
    it('offloads a running LLM once at sweep start and restores it at the end', async () => {
      const callOrder: string[] = [];
      const llmConfig = { modelId: 'llama-test', port: 8080 };
      const mockLlamaServer: any = {
        isRunning: jest.fn(() => true),
        getConfig: jest.fn(() => llmConfig),
        stop: jest.fn(async () => {
          callOrder.push('llm-stop');
        }),
        start: jest.fn(async () => {
          callOrder.push('llm-start');
          return {};
        }),
        // The manager registers a pre-start hook so an LLM start can reclaim VRAM
        registerPreStartHook: jest.fn(() => () => {}),
      };
      const server = new DiffusionServerManager(
        mockModelManager as any,
        mockSystemInfo as any,
        mockLlamaServer
      );
      const phases: string[] = [];

      const report = await runCalibrate(server, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
        onProgress: (p) => phases.push(p.phase),
      });

      // Offloaded exactly once, before the first generation; restored once after
      expect(mockLlamaServer.stop).toHaveBeenCalledTimes(1);
      expect(mockLlamaServer.start).toHaveBeenCalledTimes(1);
      expect(mockLlamaServer.start).toHaveBeenCalledWith(llmConfig);
      expect(callOrder).toEqual(['llm-stop', 'llm-start']);
      expect(phases).toContain('restoring-llm');
      // done comes after the restore
      expect(phases.indexOf('restoring-llm')).toBeLessThan(phases.indexOf('done'));
      expect(report.runs[0]!.status).toBe('ok');
      // The sweep owns the LLM state itself; the residency policy stays out of it
      expect(mockLlamaServer.registerPreStartHook).toHaveBeenCalledTimes(1);

      server.removeAllListeners();
    });
  });

  describe('VRAM sampling', () => {
    let restorePlatform: (() => void) | undefined;

    afterEach(() => {
      restorePlatform?.();
      restorePlatform = undefined;
    });

    it('reports machine-wide peak and idle VRAM per run when telemetry is trusted', async () => {
      restorePlatform = withPlatform('win32');
      // gate, window start, window end, idle-after-release (then repeats)
      scriptVramReadings([
        7 * 1024 ** 3,
        6 * 1024 ** 3,
        2 * 1024 ** 3, // deepest point of the timed window
        5 * 1024 ** 3, // settled, after the 'single' release
      ]);

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      const calRun = report.runs[0]!;
      // peak = total − min(available) over the window; idle = total − settled available
      expect(calRun.vramPeakBytes).toBe(GPU_TOTAL_BYTES - 2 * 1024 ** 3);
      expect(calRun.vramIdleBytes).toBe(GPU_TOTAL_BYTES - 5 * 1024 ** 3);
    });

    it('measures the burst idle figure right after the job, with the backend resident', async () => {
      restorePlatform = withPlatform('linux');
      scriptVramReadings([
        7 * 1024 ** 3,
        6 * 1024 ** 3,
        3 * 1024 ** 3,
        5.5 * 1024 ** 3, // still holding the weights: burst idle > single idle
      ]);

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        usageMode: 'burst',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      const calRun = report.runs[0]!;
      expect(calRun.vramPeakBytes).toBe(GPU_TOTAL_BYTES - 3 * 1024 ** 3);
      expect(calRun.vramIdleBytes).toBe(GPU_TOTAL_BYTES - 5.5 * 1024 ** 3);
    });

    it('omits both fields when any reading in the window is untrusted', async () => {
      restorePlatform = withPlatform('win32');
      // The window's first reading has no vramAvailable → nothing is comparable
      scriptVramReadings([7 * 1024 ** 3, undefined, 4 * 1024 ** 3, 5 * 1024 ** 3]);

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      const calRun = report.runs[0]!;
      expect(calRun.status).toBe('ok'); // a telemetry gap never fails a benchmark
      expect(calRun.vramPeakBytes).toBeUndefined();
      expect(calRun.vramIdleBytes).toBeUndefined();
    });

    it('does not sample at all when the platform reports no VRAM availability', async () => {
      restorePlatform = withPlatform('linux');
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'amd',
        name: 'Radeon Test',
        vram: GPU_TOTAL_BYTES,
      });

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      expect(report.runs[0]!.vramPeakBytes).toBeUndefined();
      expect(report.runs[0]!.vramIdleBytes).toBeUndefined();
      // Only the one-time gate probe was paid for
      expect(telemetryReadCount()).toBe(1);
    });

    it('never samples on macOS (unified memory has no VRAM availability)', async () => {
      restorePlatform = withPlatform('darwin');
      scriptVramReadings([7 * 1024 ** 3, 2 * 1024 ** 3]);

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      expect(report.runs[0]!.vramPeakBytes).toBeUndefined();
      expect(report.runs[0]!.vramIdleBytes).toBeUndefined();
      expect(telemetryReadCount()).toBe(0);
    });

    it('leaves no sampling timer behind when the sweep ends', async () => {
      restorePlatform = withPlatform('win32');
      scriptVramReadings([7 * 1024 ** 3, 6 * 1024 ** 3]);
      // Only setTimeout/setInterval are faked (auto-advanced by real time), so the
      // sweep runs normally while pending timers stay observable
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date', 'performance'],
        advanceTimers: true,
      });

      try {
        await runCalibrate(diffusionServer, {
          modelId: 'sdxl-turbo',
          samples: 2,
          combos: [{ label: 'auto' }],
        });

        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('residency policy', () => {
    it('never settles residency (the sweep manages the backend itself)', async () => {
      const settle = jest.spyOn(diffusionServer, 'settleResidency');

      const report = await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 2,
        combos: [{ label: 'auto' }, { label: 'clip-gpu', clipOnCpu: false }],
      });

      expect(report.runs).toHaveLength(2);
      expect(settle).not.toHaveBeenCalled();
      settle.mockRestore();
    });

    it('leaves no idle timer armed behind a sweep', async () => {
      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      expect((diffusionServer as any).backend.idleTimer).toBeUndefined();
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
    });
  });

  describe('state restore', () => {
    it('restores server state so a normal start()+generateImage() works afterwards', async () => {
      // Establish prior state: a started-then-stopped server keeps its config
      await diffusionServer.start(mockServerConfig);
      await diffusionServer.stop();
      const configBefore = diffusionServer.getConfig();

      await runCalibrate(diffusionServer, {
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true }],
      });

      // Config restored (not the synthetic calibration config)
      expect(diffusionServer.getConfig()).toBe(configBefore);
      expect(diffusionServer.getStatus()).toBe('stopped');
      expect(diffusionServer.getBackendInfo().state).toBe('absent');

      // Normal operation unaffected — and no leftover combo overrides
      handles.length = 0;
      installJobHarness();
      await diffusionServer.start(mockServerConfig);
      const result = await diffusionServer.generateImage({ prompt: 'test' });
      expect(result.image).toEqual(Buffer.from('image'));
      // Auto flags for this model/GPU: clip on CPU only (not the forced max-savings set)
      expect(handles.at(-1)!.launch.contextArgs).toEqual(['--clip-on-cpu']);
      await diffusionServer.stop();
    });
  });
});
