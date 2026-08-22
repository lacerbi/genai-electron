/**
 * Unit tests for the DiffusionServerManager stuck-job watchdog
 *
 * The failure this covers is a backend that stays ALIVE and keeps answering
 * `generating` forever: the process never exits, so crash detection never fires, and
 * without a watchdog the busy gate stays closed, the registry entry is never finished
 * and an offloaded LLM never comes back.
 *
 * Everything here runs on fake timers: the watchdog is a ticking timer compared
 * against a "last sign of life" stamp, so both the firing and the resets are exact.
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

// Mock node:fs (the backend never writes a temp PNG on this path)
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

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
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
const { DIFFUSION_BACKEND_DEFAULTS } = await import('../../src/config/defaults.js');
const { ServerError } = await import('../../src/errors/index.js');

type Manager = InstanceType<typeof DiffusionServerManager>;

/** Watchdog budget used by every test that expects it to fire (tick = 100 ms). */
const WATCHDOG_MS = 1_000;

describe('DiffusionServerManager (stuck-job watchdog)', () => {
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

  /** Explicit offload flags: auto-detection noise is irrelevant here */
  const baseConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
    clipOnCpu: true,
    vaeOnCpu: false,
    offloadToCpu: false,
    diffusionFlashAttention: false,
  };

  const watchdogConfig: DiffusionServerConfig = {
    ...baseConfig,
    jobActivityTimeoutMs: WATCHDOG_MS,
  };

  const recordBackendEvents = (server: Manager): DiffusionBackendStatusEvent[] => {
    const events: DiffusionBackendStatusEvent[] = [];
    server.on('backend-status', (event: DiffusionBackendStatusEvent) => {
      events.push(event);
    });
    return events;
  };

  /** The backend accepts the job and then answers `generating` forever. */
  const holdJobGenerating = (extra: Record<string, unknown> = {}): void => {
    mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating', ...extra }));
  };

  /**
   * Start one generation and let it reach the poll loop.
   *
   * The returned `settled` never rejects (it resolves WITH the error), so a test can
   * inspect the failure without racing an unhandled rejection.
   */
  const startHeldGeneration = async (
    server: Manager = diffusionServer
  ): Promise<{ settled: Promise<unknown> }> => {
    const generation = server.executeImageGeneration({ prompt: 'test' });
    const settled = generation.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    return { settled };
  };

  /** The most recent handle's runner callbacks (stdout tap + log tap). */
  const tapOf = (
    index = -1
  ): { onStdoutEvent: (event: unknown) => void; onLog: (line: string, stream: string) => void } =>
    handles.at(index)!.launch;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSdServerMocks();

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

  afterEach(async () => {
    // Any generation left in flight owns a poll loop; killing its backend makes that
    // loop reject on its next turn instead of polling into the following test
    for (const handle of handles) handle.emitExit({ code: 0, signal: null });
    await jest.advanceTimersByTimeAsync(0);
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
    jest.useRealTimers();
  });

  describe('firing', () => {
    it('fails a job that stops showing any sign of life', async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);

      const error = await settled;
      expect(error).toBeInstanceOf(ServerError);
      expect((error as InstanceType<typeof ServerError>).details).toMatchObject({
        code: 'BACKEND_JOB_STUCK',
        jobId: 'job-1',
        timeoutMs: WATCHDOG_MS,
        stage: 'loading',
      });
      expect(
        ((error as InstanceType<typeof ServerError>).details as any).idleMs
      ).toBeGreaterThanOrEqual(WATCHDOG_MS);
      // Repeated `generating` answers are not activity: the loop kept polling
      expect(mockGetJob.mock.calls.length).toBeGreaterThan(3);
    });

    it('maps the failure onto the BACKEND_ERROR wire code', async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);

      const error = await settled;
      expect((diffusionServer as any).mapErrorCode(error)).toBe('BACKEND_ERROR');
    });

    it("is never classified as an OOM by calibration's failure classifier", async () => {
      await diffusionServer.start(watchdogConfig);
      // A wedged backend whose last stderr line happens to mention CUDA must still be
      // an 'error': the watchdog observed silence, not an allocation failure.
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        const handle = createSdServerHandle({ stderrTail: 'CUDA error: out of memory' });
        handle.launch = options;
        return handle;
      });
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);

      const error = await settled;
      expect((diffusionServer as any).classifyCalibrationFailure(error).status).toBe('error');
    });

    it("cancels the backend job, releases with reason 'stuck' and frees the backend", async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const events = recordBackendEvents(diffusionServer);
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      await settled;
      await jest.advanceTimersByTimeAsync(0);

      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
      expect(
        events
          .filter((event) => event.reason === 'stuck')
          .map((event) => `${event.state}:${event.reason}`)
      ).toEqual(['stopping:stuck', 'absent:stuck']);
      // The wrapper itself keeps serving: only the backend went away
      expect(diffusionServer.getStatus()).toBe('running');
    });

    it("forwards 'stuck' to the orchestrator so an offloaded LLM can come back", async () => {
      await diffusionServer.start(watchdogConfig);
      const orchestrator = { onDiffusionBackendReleased: jest.fn() };
      (diffusionServer as any).orchestrator = orchestrator;
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      await settled;
      await jest.advanceTimersByTimeAsync(0);

      expect(orchestrator.onDiffusionBackendReleased).toHaveBeenCalledWith('stuck');
    });

    it('logs the wedge before killing the backend', async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      await settled;

      const errorLines = mockLogWrite.mock.calls
        .filter((call) => call[1] === 'error')
        .map((call) => String(call[0]));
      expect(
        errorLines.some((line) => line.includes('job-1') && line.includes('no activity'))
      ).toBe(true);
    });

    it('leaves the busy gate free for the next generation', async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const wedged = diffusionServer.generateImage({ prompt: 'wedged' }).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      const error = await wedged;
      expect((error as any).details.code).toBe('BACKEND_JOB_STUCK');
      await jest.advanceTimersByTimeAsync(0);

      // A healthy backend answers again: nothing is holding the gate closed
      mockGetJob.mockImplementation(async () => COMPLETED_JOB);
      const result = await diffusionServer.generateImage({ prompt: 'next' });

      expect(result.image.toString()).toBe('image');
      expect(mockSubmitImageJob).toHaveBeenCalledTimes(2);
      expect(handles).toHaveLength(2);
    });

    it("reports 'error' (not 'cancelled') to the async registry", async () => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();

      const req = new EventEmitter() as any;
      req.url = '/v1/images/generations';
      req.method = 'POST';
      const res = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
      const routed = (diffusionServer as any).handleStartGeneration(req, res) as Promise<void>;
      req.emit('data', Buffer.from(JSON.stringify({ prompt: 'test' })));
      req.emit('end');
      await routed;
      const id = JSON.parse((res.end.mock.calls[0] as any[])[0] as string).id as string;

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      await jest.advanceTimersByTimeAsync(0);

      const state = (diffusionServer as any).registry.get(id);
      expect(state.status).toBe('error');
      expect(state.error.code).toBe('BACKEND_ERROR');
      expect(String(state.error.message)).toContain('no activity');
    });
  });

  describe('activity resets the clock', () => {
    /** Advance to just under the budget, run `signal`, then prove the clock restarted. */
    const expectReset = async (signal: () => void): Promise<void> => {
      await diffusionServer.start(watchdogConfig);
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 100);
      signal();
      // Total elapsed is now well past the budget, but the idle stretch is not
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 100);
      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('busy');

      // ...and it still fires once the silence really does last the full budget
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      expect(((await settled) as any).details.code).toBe('BACKEND_JOB_STUCK');
    };

    it('is reset by a sampling-step stdout event', async () => {
      await expectReset(() => {
        tapOf().onStdoutEvent({ type: 'step', step: 1, steps: 20 });
      });
    });

    it('is reset by a weight-upload (bytes) stdout event', async () => {
      await expectReset(() => {
        tapOf().onStdoutEvent({ type: 'bytes', done: 512, total: 1024 });
      });
    });

    it('is reset by any backend log line', async () => {
      await expectReset(() => {
        tapOf().onLog('sd-server: still working', 'stdout');
      });
    });

    it('is reset by a job status change', async () => {
      await diffusionServer.start(watchdogConfig);
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'queued' }));
      const { settled } = await startHeldGeneration();

      // Switch well before the deadline: the NEXT poll (200 ms cadence) is what stamps
      // the transition, and it must land before the expiry tick, not tie with it.
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 300);
      holdJobGenerating(); // queued -> generating: a real transition
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 100);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      expect(((await settled) as any).details.code).toBe('BACKEND_JOB_STUCK');
    });

    it('is reset by a queue-position change', async () => {
      await diffusionServer.start(watchdogConfig);
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'queued',
        queue_position: 3,
      }));
      const { settled } = await startHeldGeneration();

      // Same margin as above: the next poll must stamp before the expiry tick.
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 300);
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'queued',
        queue_position: 2,
      }));
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 100);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      expect(((await settled) as any).details.code).toBe('BACKEND_JOB_STUCK');
    });
  });

  describe('arming policy', () => {
    it('never arms when jobActivityTimeoutMs is 0', async () => {
      await diffusionServer.start({ ...baseConfig, jobActivityTimeoutMs: 0 });
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('busy');

      // The generation is still perfectly alive; finish it normally
      mockGetJob.mockImplementation(async () => COMPLETED_JOB);
      await jest.advanceTimersByTimeAsync(DIFFUSION_BACKEND_DEFAULTS.jobPollIntervalMs);
      expect(await settled).toMatchObject({ format: 'png' });
    });

    it('defaults to ten minutes when the config says nothing', async () => {
      await diffusionServer.start(baseConfig);
      holdJobGenerating();
      const { settled } = await startHeldGeneration();

      await jest.advanceTimersByTimeAsync(DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs - 1_000);
      expect(handles[0]!.stop).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000 + 30_000);
      expect(((await settled) as any).details.code).toBe('BACKEND_JOB_STUCK');
      expect(DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs).toBe(600_000);
    });

    it('is disarmed once the generation ends, so a warm backend is never killed', async () => {
      await diffusionServer.start(watchdogConfig);
      await diffusionServer.executeImageGeneration({ prompt: 'test' });
      expect(diffusionServer.getBackendInfo().state).toBe('ready');

      // Ten minutes of a warm, idle backend: the watchdog belongs to a job, not to
      // the process (the idle timer owns residency).
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(diffusionServer.getBackendInfo().state).toBe('ready');
    });

    it('re-arms per image inside a batch instead of bounding the whole batch', async () => {
      await diffusionServer.start(watchdogConfig);
      // Each image answers after a delay that is under the budget on its own, but
      // three of them together exceed it.
      let call = 0;
      mockGetJob.mockImplementation(async () => {
        call++;
        return call % 4 === 0 ? COMPLETED_JOB : { id: 'job-1', status: 'generating' };
      });
      // Activity stamps (status changes per image) alone would keep a batch-wide watchdog
      // quiet under this fixture, so pin the arming itself: once per image, each with
      // its own owner.
      const arm = jest.spyOn(diffusionServer as any, 'armJobActivityWatchdog');
      const batch = (diffusionServer as any).executeBatchGeneration({
        prompt: 'test',
        count: 3,
      }) as Promise<unknown[]>;

      await jest.advanceTimersByTimeAsync(3 * WATCHDOG_MS);

      expect(await batch).toHaveLength(3);
      expect(handles[0]!.stop).not.toHaveBeenCalled();
      expect(arm).toHaveBeenCalledTimes(3);
      const owners = arm.mock.calls.map((call) => call[0]);
      expect(new Set(owners).size).toBe(3);
    });
  });
});
