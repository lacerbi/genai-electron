/**
 * Unit tests for DiffusionServerManager.calibrate() (offload calibration)
 * and the pickRecommended pure helper.
 *
 * The spawn mock auto-completes each generation asynchronously and is
 * scriptable per spawn index (exit code / stderr / hang) so the sweep's
 * failure classification and abort paths can be exercised deterministically.
 * Winner picking is tested as a pure function — sweep tests never assert
 * wall-clock ordering.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type {
  CalibrationRun,
  DiffusionCalibrationProgress,
  DiffusionServerConfig,
  ModelInfo,
} from '../../src/types/index.js';

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
mockHttpServer.listen = jest.fn().mockImplementation((port: number, callback: () => void) => {
  callback();
  return mockHttpServer;
});
mockHttpServer.close = jest.fn().mockImplementation((callback: () => void) => {
  callback();
});

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

// Mock fs/promises
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
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

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
  constructor(_config: any) {
    // Config unused in tests
  }
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock health-check
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  isServerResponding: mockIsServerResponding,
}));

// Mock port-utils (never bind real sockets in unit tests)
const mockFindFreePort = jest.fn(async () => 49999);
const mockIsPortBindable = jest.fn(async () => true);

jest.unstable_mockModule('../../src/process/port-utils.js', () => ({
  findFreePort: mockFindFreePort,
  isPortBindable: mockIsPortBindable,
}));

// Mock file-utils
const mockDeleteFile = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  deleteFile: mockDeleteFile,
}));

// Mock paths
const mockGetTempPath = jest.fn();

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    root: '/test',
    models: '/test/models',
    binaries: '/test/binaries',
    logs: '/test/logs',
    temp: '/test/temp',
  },
  getTempPath: mockGetTempPath,
}));

// Import after mocking
const { DiffusionServerManager, pickRecommended } = await import(
  '../../src/managers/DiffusionServerManager.js'
);
const { DIFFUSION_CALIBRATION_DEFAULTS } = await import('../../src/config/defaults.js');

/** Script for one spawned generation (by spawn index) */
interface SpawnScript {
  /** Exit code (default 0) */
  exitCode?: number;
  /** stderr lines emitted before exit */
  stderr?: string[];
  /** stdout chunks emitted before exit */
  stdout?: string[];
  /** Never exit on its own — only via mocked kill() (abort tests) */
  hang?: boolean;
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

  /** Args of every spawned generation, in order */
  let spawnCalls: string[][] = [];
  /** Per-spawn options handles (for the kill → exit wiring) */
  let spawnOptionsByPid: Map<number, any>;
  /** Per-spawn-index script; return undefined for a clean instant success */
  let spawnScript: (index: number, args: string[]) => SpawnScript | undefined;

  /**
   * Install a spawn mock where each generation auto-completes on a later tick
   * (success by default; failures/hangs per spawnScript).
   */
  const installAutoSpawn = (): void => {
    spawnCalls = [];
    spawnOptionsByPid = new Map();
    mockProcessSpawn.mockImplementation((_binaryPath: any, args: any, options: any) => {
      const index = spawnCalls.length;
      spawnCalls.push(args as string[]);
      const pid = 1000 + index;
      spawnOptionsByPid.set(pid, options);
      const script = spawnScript(index, args as string[]) ?? {};
      if (!script.hang) {
        setTimeout(() => {
          for (const chunk of script.stdout ?? []) {
            options.onStdout?.(chunk);
          }
          for (const line of script.stderr ?? []) {
            options.onStderr?.(line);
          }
          options.onExit?.(script.exitCode ?? 0, null);
        }, 0);
      }
      return { pid };
    });
    // kill → the process "exits" (rejects as cancelled when the cancel flag is set)
    mockProcessKill.mockImplementation(async (pid: number) => {
      spawnOptionsByPid.get(pid)?.onExit?.(1, null);
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogInitialize.mockResolvedValue(undefined);
    mockLogWrite.mockResolvedValue(undefined);
    mockLogGetRecent.mockResolvedValue([]);
    mockLogClear.mockResolvedValue(undefined);
    mockEnsureBinary.mockResolvedValue('/test/binaries/sd');
    mockCreateServer.mockReturnValue(mockHttpServer);
    mockHttpServer.listen.mockImplementation((port: number, callback: () => void) => {
      callback();
      return mockHttpServer;
    });
    mockHttpServer.close.mockImplementation((callback: () => void) => {
      callback();
    });
    mockGetTempPath.mockImplementation((filename: string) => `/test/temp/${filename}`);
    mockDeleteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('fake-image-data'));

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
    mockProcessKill.mockResolvedValue(undefined);

    spawnScript = () => undefined; // all generations succeed by default
    installAutoSpawn();
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

      await expect(diffusionServer.calibrate({ modelId: 'sdxl-turbo' })).rejects.toThrow(
        /Cannot calibrate while the server is running/
      );

      await diffusionServer.stop();
    });

    it('rejects invalid sizes (non-multiple of 64) before any spawn', async () => {
      await expect(
        diffusionServer.calibrate({
          modelId: 'sdxl-turbo',
          sizes: [{ width: 500, height: 512 }],
        })
      ).rejects.toThrow(/multiples of 64/);
      expect(mockProcessSpawn).not.toHaveBeenCalled();
    });

    it('rejects a pre-aborted signal immediately with empty partial runs', async () => {
      const controller = new AbortController();
      controller.abort();

      try {
        await diffusionServer.calibrate({ modelId: 'sdxl-turbo', signal: controller.signal });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR'); // top-level code is generic
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
        expect(error.details.runs).toEqual([]);
      }
      expect(mockProcessSpawn).not.toHaveBeenCalled();
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('blocks start() while a calibration is in flight', async () => {
      let startRejection: Promise<void> | undefined;
      const calibratePromise = diffusionServer.calibrate({
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
      const calibratePromise = diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 1,
        onProgress: (p) => {
          if (p.phase === 'warmup' && !secondRejection) {
            secondRejection = expect(
              diffusionServer.calibrate({ modelId: 'sdxl-turbo' })
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
  });

  describe('sweep structure and per-run flag resolution', () => {
    it('spawns combos × (warmup + samples × sizes) and applies per-combo flags', async () => {
      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        sizes: [
          { width: 768, height: 768 },
          { width: 512, height: 1024 },
        ],
        samples: 1,
        steps: 4,
        combos: [
          { label: 'clip-gpu', clipOnCpu: false },
          { label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true },
        ],
      });

      // 2 combos × (1 warmup + 1 sample × 2 sizes) = 6 generations
      expect(spawnCalls).toHaveLength(6);

      // Combo 1 (clipOnCpu: false overrides auto=true): no offload flags at all
      for (const args of spawnCalls.slice(0, 3)) {
        expect(args).not.toContain('--clip-on-cpu');
        expect(args).not.toContain('--vae-on-cpu');
        expect(args).not.toContain('--offload-to-cpu');
      }
      // Combo 2: all three forced on
      for (const args of spawnCalls.slice(3, 6)) {
        expect(args).toContain('--clip-on-cpu');
        expect(args).toContain('--vae-on-cpu');
        expect(args).toContain('--offload-to-cpu');
      }

      // Identical work per generation: fixed seed/steps/sampler; warmup at first size
      for (const args of spawnCalls) {
        expect(args).toContain('-s');
        expect(args[args.indexOf('-s') + 1]).toBe('42');
        expect(args).toContain('--steps');
        expect(args[args.indexOf('--steps') + 1]).toBe('4');
        expect(args).toContain('--sampling-method');
        expect(args[args.indexOf('--sampling-method') + 1]).toBe('euler');
      }
      const sizeOf = (args: string[]): string =>
        `${args[args.indexOf('-W') + 1]}x${args[args.indexOf('-H') + 1]}`;
      expect(sizeOf(spawnCalls[0]!)).toBe('768x768'); // warmup @ first size
      expect(sizeOf(spawnCalls[1]!)).toBe('768x768');
      expect(sizeOf(spawnCalls[2]!)).toBe('512x1024');

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
      expect(report.sampler).toBe('euler');
      expect(report.samples).toBe(1);
      expect(report.modelId).toBe('sdxl-turbo');
      expect(report.machine.gpuName).toBe('RTX Test 8GB');
      expect(report.machine.vramBytes).toBe(8 * 1024 ** 3);

      // Server left stopped, state restored
      expect(diffusionServer.getStatus()).toBe('stopped');
      expect(diffusionServer.isCalibrating()).toBe(false);
    });

    it('lets auto-detection resolve omitted flags (auto combo carries resolved values)', async () => {
      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });

      // 8 GB GPU, 2 GB model → auto: clip=true, vae=false, offload=false
      for (const args of spawnCalls) {
        expect(args).toContain('--clip-on-cpu');
        expect(args).not.toContain('--vae-on-cpu');
        expect(args).not.toContain('--offload-to-cpu');
      }
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
  });

  describe('stage timing and medians (stdout-driven)', () => {
    // Realistic sd-cli stdout for one generation (sd.cpp master-746 literals)
    const SD_STDOUT = [
      'loading model from /test/models/diffusion/sdxl-turbo.gguf\n',
      'generating image: 1/1 - seed 42\n',
      '  |==>               | 2/4 - 1.50it/s\n',
      '  |=========>        | 4/4 - 1.45it/s\n',
      'decoding 1 latents\n',
      'decode_first_stage completed, taking 1.23s\n',
    ];

    it('populates stageMs from stdout markers and medians multi-sample timings', async () => {
      spawnScript = () => ({ stdout: [...SD_STDOUT] });
      const progressEvents: DiffusionCalibrationProgress[] = [];

      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 2,
        steps: 4,
        combos: [{ label: 'auto' }],
        onProgress: (p) => progressEvents.push(p),
      });

      // 1 combo × (1 warmup + 2 samples) = 3 generations
      expect(spawnCalls).toHaveLength(3);
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

    it('hands back per-sweep combo copies, never the module default objects', async () => {
      const report = await diffusionServer.calibrate({ modelId: 'sdxl-turbo', samples: 1 });

      // Default sweep: 6 combos × (1 warmup + 1 sample × 1 size) = 12 generations
      expect(spawnCalls).toHaveLength(12);
      const firstDefault = DIFFUSION_CALIBRATION_DEFAULTS.combos[0]!;
      const firstRun = report.runs.find((r) => r.combo.label === firstDefault.label)!;
      expect(firstRun.combo).toEqual(firstDefault);
      expect(firstRun.combo).not.toBe(firstDefault); // mutation-safe copy
    });
  });

  describe('failure classification', () => {
    it('classifies an OOM combo, continues the sweep, and excludes it from recommendation', async () => {
      // Combo B's warmup (spawn index 2) crashes with CUDA OOM
      spawnScript = (index) =>
        index === 2
          ? { exitCode: 1, stderr: ['ggml_cuda_host_malloc: CUDA error: out of memory'] }
          : undefined;

      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [
          { label: 'auto' },
          { label: 'all-resident', clipOnCpu: false, vaeOnCpu: false, offloadToCpu: false },
        ],
      });

      // Combo A: warmup + 1 sample; combo B: failed warmup only (samples skipped)
      expect(spawnCalls).toHaveLength(3);

      const okRun = report.runs.find((r) => r.combo.label === 'auto')!;
      const oomRun = report.runs.find((r) => r.combo.label === 'all-resident')!;
      expect(okRun.status).toBe('ok');
      expect(oomRun.status).toBe('oom');
      expect(oomRun.error).toContain('exited with code 1');
      expect(oomRun.timeTakenMs).toBeUndefined();

      expect(report.recommended['768x768']).toEqual({ label: 'auto' });
    });

    it('classifies a non-OOM failure as error and keeps successful samplesMs', async () => {
      // Second timed sample (spawn index 2: warmup, sample1, sample2) fails generically
      spawnScript = (index) =>
        index === 2 ? { exitCode: 1, stderr: ['some unrelated failure'] } : undefined;

      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 2,
        combos: [{ label: 'auto' }],
      });

      expect(spawnCalls).toHaveLength(3);
      const calRun = report.runs[0]!;
      expect(calRun.status).toBe('error');
      expect(calRun.samplesMs).toHaveLength(1); // first sample kept for diagnostics
      expect(calRun.timeTakenMs).toBeUndefined(); // never recommended
      expect(report.recommended['768x768']).toBeUndefined();
    });

    it('records a warmup failure on the first size but still attempts later sizes', async () => {
      const progress: DiffusionCalibrationProgress[] = [];
      // Warmup (spawn 0) OOMs; the second size's sample (spawn 1) succeeds
      spawnScript = (index) =>
        index === 0 ? { exitCode: 1, stderr: ['cudaMalloc failed: out of memory'] } : undefined;

      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        sizes: [
          { width: 768, height: 768 },
          { width: 512, height: 512 },
        ],
        samples: 1,
        combos: [{ label: 'auto' }],
        onProgress: (p) => progress.push(p),
      });

      expect(spawnCalls).toHaveLength(2); // failed warmup + second size's sample

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

      await diffusionServer.calibrate({
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

      const report = await diffusionServer.calibrate({
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
        await diffusionServer.calibrate({
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
      // A fresh calibrate works afterwards (state fully torn down)
      const report = await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'auto' }],
      });
      expect(report.runs[0]!.status).toBe('ok');
    });

    it('aborts an in-flight generation via the cancel path', async () => {
      const controller = new AbortController();
      // Second spawn hangs; abort fires while it is in flight
      spawnScript = (index) => {
        if (index === 1) {
          setTimeout(() => controller.abort(), 10);
          return { hang: true };
        }
        return undefined;
      };

      try {
        await diffusionServer.calibrate({
          modelId: 'sdxl-turbo',
          samples: 1,
          combos: [{ label: 'auto' }],
          signal: controller.signal,
        });
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.code).toBe('CALIBRATION_ABORTED');
      }

      // The hanging process was killed via the cancel path
      expect(mockProcessKill).toHaveBeenCalled();
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

      const report = await diffusionServer.calibrate({
        modelId: 'sd3.5-large-q4',
        samples: 1,
      });

      // Default set has exactly one clipOnCpu: true combo (max-savings)
      expect(report.skippedCombos).toHaveLength(1);
      expect(report.skippedCombos![0]!.combo.label).toBe('max-savings');
      expect(report.skippedCombos![0]!.reason).toContain('1578');

      // 5 active combos × (1 warmup + 1 sample × 1 size) = 10 generations
      expect(report.runs).toHaveLength(5);
      expect(spawnCalls).toHaveLength(10);
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
      };
      const server = new DiffusionServerManager(
        mockModelManager as any,
        mockSystemInfo as any,
        mockLlamaServer
      );
      const phases: string[] = [];

      const report = await server.calibrate({
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

      server.removeAllListeners();
    });
  });

  describe('state restore', () => {
    it('restores server state so a normal start()+generateImage() works afterwards', async () => {
      // Establish prior state: a started-then-stopped server keeps its config
      await diffusionServer.start(mockServerConfig);
      await diffusionServer.stop();
      const configBefore = diffusionServer.getConfig();

      await diffusionServer.calibrate({
        modelId: 'sdxl-turbo',
        samples: 1,
        combos: [{ label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true }],
      });

      // Config restored (not the synthetic calibration config)
      expect(diffusionServer.getConfig()).toBe(configBefore);
      expect(diffusionServer.getStatus()).toBe('stopped');

      // Normal operation unaffected — and no leftover combo overrides
      spawnCalls = [];
      await diffusionServer.start(mockServerConfig);
      const result = await diffusionServer.generateImage({ prompt: 'test' });
      expect(result.image).toEqual(Buffer.from('fake-image-data'));
      const lastArgs = spawnCalls[spawnCalls.length - 1]!;
      // Auto flags for this model/GPU: clip on CPU only (not the forced max-savings set)
      expect(lastArgs).toContain('--clip-on-cpu');
      expect(lastArgs).not.toContain('--vae-on-cpu');
      expect(lastArgs).not.toContain('--offload-to-cpu');
      await diffusionServer.stop();
    });
  });
});
