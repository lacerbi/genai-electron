import { jest } from '@jest/globals';
import { LlamaCalibrationResourceStabilityError, ServerError } from '../../src/errors/index.js';
import { LLAMA_CALIBRATION_DEFAULTS } from '../../src/config/defaults.js';
import type {
  LlamaCalibrationConfig,
  LlamaCalibrationProgress,
  LlamaCalibrationRequestTiming,
  ModelInfo,
  SystemCapabilities,
} from '../../src/types/index.js';

const mockStartRunner = jest.fn();
const mockTokenize = jest.fn();
const mockEraseSlot = jest.fn();
const mockComplete = jest.fn();
const mockBinaryIdentity = jest.fn(async () => ({
  version: 'b9860',
  variant: 'cuda',
  checksum: 'binary-sha',
}));

jest.unstable_mockModule('electron', () => ({
  app: { getPath: jest.fn(() => 'C:\\test') },
}));

class MockCalibrationClient {
  tokenize = mockTokenize;
  eraseSlot = mockEraseSlot;
  complete = mockComplete;
}

jest.unstable_mockModule('../../src/process/llama-server-runner.js', () => ({
  startLlamaServerRunner: mockStartRunner,
}));
jest.unstable_mockModule('../../src/process/llama-calibration-client.js', () => ({
  LlamaCalibrationClient: MockCalibrationClient,
}));
jest.unstable_mockModule('../../src/utils/binary-identity.js', () => ({
  getInstalledBinaryIdentity: mockBinaryIdentity,
}));

const { LlamaServerManager } = await import('../../src/managers/LlamaServerManager.js');

const model: ModelInfo = {
  id: 'gemma',
  name: 'Gemma',
  type: 'llm',
  size: 1_000,
  path: 'C:\\models\\gemma.gguf',
  checksum: 'model-sha',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  source: { type: 'huggingface', url: 'https://example.test', revision: 'abc' },
  ggufMetadata: {
    architecture: 'gemma3',
    block_count: 40,
    attention_sliding_window: 4096,
  },
};

const capabilities: SystemCapabilities = {
  cpu: { cores: 8, model: 'CPU', architecture: 'x64' },
  memory: { total: 32_000, available: 20_000, used: 12_000 },
  gpu: { available: true, type: 'nvidia', name: 'GPU', vram: 8_000, vramAvailable: 7_000 },
  platform: 'win32',
  recommendations: {
    maxModelSize: '13B',
    recommendedQuantization: ['Q4_K_M'],
    threads: 8,
    gpuLayers: 30,
    gpuAcceleration: true,
  },
  detectedAt: '2026-01-01T00:00:00.000Z',
};

const config: LlamaCalibrationConfig = {
  modelId: model.id,
  profile: { contextSize: 12_288, parallelRequests: 2 },
  workloads: [
    {
      id: 'cold',
      kind: 'cold-prefill',
      prompt: 'PRIVATE-PROMPT',
      nPredict: 8,
    },
  ],
  combos: [
    { label: 'a', overrides: { gpuLayers: 28 } },
    { label: 'b', overrides: { gpuLayers: 32 } },
  ],
  samples: 1,
};

function timing(wallTimeMs: number): LlamaCalibrationRequestTiming {
  return {
    wallTimeMs,
    promptTokens: 10,
    predictedTokens: 8,
    cachedTokens: 0,
  };
}

/**
 * Drive a calibration to completion on fake timers.
 *
 * The fixed-baseline resource guard schedules real wall time (settle delay, cooldown-spaced
 * baseline samples, one cooldown before every post-cleanup boundary), so nothing settles on
 * microtasks alone. Faked time is advanced until the call resolves rather than the guard schedule
 * being mocked away.
 */
async function settleCalibration<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let turn = 0; turn < 100 && !settled; turn++) {
    await jest.advanceTimersByTimeAsync(1_000);
  }
  if (!settled) throw new Error('scripted calibration did not settle');
  return promise;
}

/** Advance faked time until `condition` holds, e.g. until the first launch is in flight. */
async function advanceUntil(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) {
    await jest.advanceTimersByTimeAsync(250);
  }
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
}

async function captureRejection(promise: Promise<unknown>): Promise<{
  message?: string;
  details?: Record<string, unknown>;
}> {
  try {
    await settleCalibration(promise);
  } catch (error) {
    return error as { message?: string; details?: Record<string, unknown> };
  }
  throw new Error('expected calibration to reject');
}

/** One whole-machine reading; `'untrusted'` makes that metric's source fail for this snapshot. */
interface ScriptedSnapshot {
  host: number | 'untrusted';
  vram: number | 'untrusted';
}

/** The quiet reading every unscripted snapshot returns. */
const QUIET_SNAPSHOT: ScriptedSnapshot = { host: 20_000, vram: 7_000 };

describe('LlamaServerManager.calibrate', () => {
  let manager: InstanceType<typeof LlamaServerManager>;
  let runnerStops: jest.Mock[];
  let actions: string[];
  let getMemoryInfo: jest.Mock;
  let getGPUInfo: jest.Mock;
  let refreshMemoryTelemetry: jest.Mock;

  /**
   * Script the guard's snapshots as one atomic queue keyed by snapshot ordinal.
   *
   * Host and GPU values are pinned together by the refresh call that opens every snapshot, so the
   * two sources cannot drift out of alignment however many reads a boundary happens to take.
   * Ordinals for one exact sweep are: 0-2 baseline, then per combo one pre-launch read followed by
   * one post-cleanup read, each immediately followed by its confirmation read when suspicious.
   */
  function scriptSnapshots(overrides: Readonly<Record<number, Partial<ScriptedSnapshot>>> = {}): {
    snapshotCount: () => number;
  } {
    let ordinal = -1;
    let current: ScriptedSnapshot = { ...QUIET_SNAPSHOT };
    refreshMemoryTelemetry.mockImplementation(async () => {
      ordinal += 1;
      current = { ...QUIET_SNAPSHOT, ...(overrides[ordinal] ?? {}) };
      return current.host === 'untrusted' ? 'failed' : 'refreshed';
    });
    getMemoryInfo.mockImplementation(() => {
      if (current.host === 'untrusted') throw new Error('host telemetry unavailable');
      return {
        ...capabilities.memory,
        available: current.host,
        used: capabilities.memory.total - current.host,
      };
    });
    getGPUInfo.mockImplementation(async () => ({
      ...capabilities.gpu,
      vramAvailable: current.vram === 'untrusted' ? undefined : current.vram,
    }));
    return { snapshotCount: () => ordinal + 1 };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cuda',
      checksum: 'binary-sha',
    });
    actions = [];
    runnerStops = [];
    const modelManager = { getModelInfo: jest.fn(async () => model) };
    getMemoryInfo = jest.fn(() => capabilities.memory);
    getGPUInfo = jest.fn(async () => capabilities.gpu);
    // Required by the resource guard's snapshots. A `'failed'` status makes host memory untrusted,
    // so returning the real success status here keeps the suite on the normal fully-guarded path
    // instead of the degraded-telemetry one.
    refreshMemoryTelemetry = jest.fn(async () => 'refreshed');
    const systemInfo = {
      detect: jest.fn(async () => capabilities),
      clearCache: jest.fn(),
      getMemoryInfo,
      getGPUInfo,
      refreshMemoryTelemetry,
    };
    manager = new LlamaServerManager(modelManager as never, systemInfo as never);
    (manager as unknown as { initializeLogManager: () => Promise<void> }).initializeLogManager =
      jest.fn(async () => undefined);
    (manager as unknown as { runOccupancyCheck: () => Promise<void> }).runOccupancyCheck = jest.fn(
      async () => undefined
    );
    (manager as unknown as { ensureBinary: () => Promise<string> }).ensureBinary = jest.fn(
      async () => 'llama-server'
    );
    (
      manager as unknown as { autoConfigureIfNeeded: (value: unknown) => Promise<unknown> }
    ).autoConfigureIfNeeded = jest.fn(async (value: Record<string, unknown>) => ({
      ...value,
      threads: 8,
      gpuLayers: 30,
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      flashAttention: 'on',
    }));

    mockStartRunner.mockImplementation(async () => {
      actions.push('start');
      const stop = jest.fn(async () => {
        actions.push('stop');
      });
      runnerStops.push(stop);
      return {
        pid: 100 + runnerStops.length,
        port: 20_000 + runnerStops.length,
        loadTimeMs: 10,
        capacity: { effectiveContextSize: 6144, totalSlots: 2 },
        stderrTail: '',
        stop,
      };
    });
    mockTokenize.mockResolvedValue(10);
    mockEraseSlot.mockResolvedValue(undefined);
    mockComplete
      .mockResolvedValueOnce(timing(999))
      .mockResolvedValueOnce(timing(100))
      .mockResolvedValueOnce(timing(999))
      .mockResolvedValueOnce(timing(90));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs exact custom candidates serially and returns a report-only recommendation', async () => {
    const before = manager.getInfo();
    const lifecycle = jest.fn();
    manager.on('started', lifecycle);
    manager.on('stopped', lifecycle);
    manager.on('crashed', lifecycle);
    const progress: number[] = [];
    const eventProgress: number[] = [];
    manager.on('calibration-progress', (event) =>
      eventProgress.push((event as { overallPercent: number }).overallPercent)
    );

    const report = await settleCalibration(
      manager.calibrate({
        ...config,
        onProgress: (event) => progress.push(event.overallPercent),
      })
    );

    expect(actions).toEqual(['start', 'stop', 'start', 'stop']);
    expect(mockStartRunner).toHaveBeenCalledTimes(2);
    for (const call of mockStartRunner.mock.calls) {
      expect(call[0]).toMatchObject({ contextSize: 12_288, parallelRequests: 2 });
    }
    expect(report).toMatchObject({ schemaVersion: 2, strategy: 'exact', status: 'complete' });
    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(report.runs.map((run) => run.scoreMs)).toEqual([100, 90]);
    expect(report.selected?.combo?.label).toBe('b');
    expect(report.selected?.startConfig).toMatchObject({
      contextSize: 12_288,
      parallelRequests: 2,
      gpuLayers: 32,
      cacheTypeK: 'q8_0',
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE-PROMPT');
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true
    );
    expect(eventProgress).toEqual(progress);
    expect(manager.getInfo()).toEqual(before);
    expect(manager.isCalibrating()).toBe(false);
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('returns an all-failed diagnostic report without a recommendation', async () => {
    mockStartRunner.mockReset();
    mockStartRunner.mockRejectedValue(new Error('backend failed'));

    const report = await settleCalibration(manager.calibrate(config));

    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(report.runs).toHaveLength(2);
    expect(report.runs.every((run) => run.status === 'error')).toBe(true);
    expect(report.runs.every((run) => run.workloadResults.length === 1)).toBe(true);
    expect(report.selected).toBeUndefined();
    expect(report.status).toBe('no-viable-candidate');
  });

  it('classifies startup OOM and continues to the next candidate', async () => {
    mockStartRunner.mockRejectedValueOnce(
      new ServerError('candidate did not become ready', {
        stderrTail: 'CUDA out of memory',
      })
    );

    const report = await settleCalibration(manager.calibrate(config));

    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(report.runs.map((run) => run.status)).toEqual(['oom', 'ok']);
    expect(report.selected?.combo?.label).toBe('b');
    expect(runnerStops).toHaveLength(1);
  });

  it('rejects normalized-equivalent custom candidates before provisioning', async () => {
    await expect(
      settleCalibration(
        manager.calibrate({
          ...config,
          combos: [
            { overrides: { cacheTypeV: 'q8_0' } },
            { overrides: { cacheTypeV: 'q8_0', flashAttention: 'on' } },
          ],
        })
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_INVALID_CONFIG' }),
    });
    expect((manager as unknown as { ensureBinary: jest.Mock }).ensureBinary).not.toHaveBeenCalled();
    expect(mockStartRunner).not.toHaveBeenCalled();
  });

  it('runs an explicit CPU-only exact candidate without manufacturing GPU placement', async () => {
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cpu',
      checksum: 'binary-sha',
    });

    const report = await settleCalibration(
      manager.calibrate({
        ...config,
        combos: [{ label: 'cpu', overrides: { gpuLayers: 0 } }],
      })
    );

    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0]!.overrides.gpuLayers).toBe(0);
  });

  it('runs the adaptive controller and emits progress suitable for a host progress bar', async () => {
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cpu',
      checksum: 'binary-sha',
    });
    mockStartRunner.mockImplementation(async () => {
      actions.push('start');
      const stop = jest.fn(async () => actions.push('stop'));
      runnerStops.push(stop);
      return {
        pid: 500 + runnerStops.length,
        port: 25_000 + runnerStops.length,
        loadTimeMs: 10,
        capacity: { effectiveContextSize: 4096, totalSlots: 1 },
        stderrTail: '',
        stop,
      };
    });
    const callbackProgress: LlamaCalibrationProgress[] = [];
    const eventProgress: LlamaCalibrationProgress[] = [];
    manager.on('calibration-progress', (event) =>
      eventProgress.push(event as LlamaCalibrationProgress)
    );

    const report = await settleCalibration(
      manager.calibrate({
        modelId: model.id,
        profiles: [{ contextSize: 4096, parallelRequests: 1 }],
        workloads: [{ id: 'cold', kind: 'cold-prefill', prompt: 'PRIVATE-PROMPT', nPredict: 8 }],
        samples: 1,
        onProgress: (progress) => callbackProgress.push(progress),
      })
    );

    expect(report.strategy).toBe('adaptive');
    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(report.status).toBe('complete');
    expect(report.selectionEvidence).toBe('independent-reproduction');
    expect(report.selected?.startConfig).toMatchObject({
      contextSize: 4096,
      parallelRequests: 1,
      gpuLayers: 0,
    });
    expect(report.probes.map((probe) => [probe.purpose, probe.fidelity])).toEqual([
      ['reference', 'search'],
      ['finalist', 'full'],
    ]);
    expect(report.workloadComparability).toBe('verified');
    expect(report.budget.completedProbes).toBe(2);
    expect(callbackProgress[0]).toMatchObject({
      strategy: 'adaptive',
      phase: 'preparing',
      budget: { resolved: false },
    });
    expect(callbackProgress.some((progress) => progress.phase === 'policy-ready')).toBe(true);
    expect(callbackProgress.at(-1)).toMatchObject({
      strategy: 'adaptive',
      phase: 'done',
      terminalStatus: 'complete',
      overallPercent: 100,
    });
    expect(
      callbackProgress.every(
        (progress, index) =>
          index === 0 || progress.overallPercent >= callbackProgress[index - 1]!.overallPercent
      )
    ).toBe(true);
    expect(eventProgress).toEqual(callbackProgress);
    expect(JSON.stringify(report)).not.toContain('PRIVATE-PROMPT');
    expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
  });

  it('erases, primes, and times a complete shared-prefix burst on one slot', async () => {
    mockComplete.mockReset().mockResolvedValue(timing(10));
    const report = await settleCalibration(
      manager.calibrate({
        ...config,
        combos: [config.combos![0]!],
        workloads: [
          {
            id: 'prefix',
            kind: 'shared-prefix',
            sharedPrefix: 'PRIVATE-PREFIX:',
            suffixes: ['prime', 'one', 'two'],
            nPredict: 8,
          },
        ],
      })
    );

    expect(mockTokenize.mock.calls.map((call) => call[0])).toEqual([
      'PRIVATE-PREFIX:prime',
      'PRIVATE-PREFIX:one',
      'PRIVATE-PREFIX:two',
    ]);
    expect(mockEraseSlot).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls.map((call) => call[0].prompt)).toEqual([
      'PRIVATE-PREFIX:prime',
      'PRIVATE-PREFIX:one',
      'PRIVATE-PREFIX:two',
      'PRIVATE-PREFIX:prime',
      'PRIVATE-PREFIX:one',
      'PRIVATE-PREFIX:two',
    ]);
    expect(report.runs[0]!.workloadResults[0]!.samples[0]!.requests).toHaveLength(2);
    expect(report.workloads[0]!.promptTokenCounts).toEqual([10, 10, 10]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE-PREFIX');
  });

  it('rejects an oversized prompt as a calibration-level config error after cleanup', async () => {
    mockTokenize.mockResolvedValue(6140);

    await expect(settleCalibration(manager.calibrate(config))).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_INVALID_CONFIG' }),
    });
    expect(runnerStops[0]).toHaveBeenCalled();
    expect(manager.isCalibrating()).toBe(false);
  });

  it('blocks normal start and a second calibration while the sweep lock is held', async () => {
    let release!: () => void;
    mockStartRunner.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              pid: 100,
              port: 20_000,
              loadTimeMs: 10,
              capacity: { effectiveContextSize: 6144, totalSlots: 2 },
              stderrTail: '',
              stop: jest.fn(async () => undefined),
            });
        })
    );
    mockComplete.mockReset().mockResolvedValue(timing(10));
    const pending = manager.calibrate({ ...config, combos: [config.combos![0]!] });
    // The lock is taken immediately, but the launch only happens after the guard's baseline
    // schedule, so faked time has to pass before the sweep is genuinely in flight.
    await advanceUntil(() => mockStartRunner.mock.calls.length > 0, 'the first launch');

    await expect(manager.start({ modelId: model.id })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_BUSY' }),
    });
    await expect(
      manager.calibrate({ ...config, combos: [config.combos![0]!] })
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_BUSY' }),
    });
    release();
    await settleCalibration(pending);
  });

  it('rejects calibration while the normal server is running', async () => {
    (manager as unknown as { _status: string })._status = 'running';

    await expect(settleCalibration(manager.calibrate(config))).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SERVER_RUNNING' }),
    });
  });

  it('reports strict occupancy and capability-detection preparation failures', async () => {
    (manager as unknown as { runOccupancyCheck: () => Promise<void> }).runOccupancyCheck = jest.fn(
      async () => Promise.reject(new Error('occupied'))
    );
    await expect(settleCalibration(manager.calibrate(config))).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_RESOURCE_BUSY' }),
    });

    (manager as unknown as { runOccupancyCheck: () => Promise<void> }).runOccupancyCheck = jest.fn(
      async () => undefined
    );
    (manager as unknown as { systemInfo: { detect: () => Promise<never> } }).systemInfo.detect =
      jest.fn(async () => Promise.reject(new Error('detection failed')));
    await expect(settleCalibration(manager.calibrate(config))).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_PREPARATION_FAILED' }),
    });
  });

  it('treats an unverifiable fixed slot profile as a calibration-level failure', async () => {
    mockStartRunner.mockRejectedValue(
      new ServerError('slot count missing', { code: 'CALIBRATION_SLOTS_UNAVAILABLE' })
    );

    await expect(
      settleCalibration(manager.calibrate({ ...config, combos: [config.combos![0]!] }))
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SLOTS_UNAVAILABLE' }),
    });
  });

  it('aborts an in-flight start with partial runs and unlocks the manager', async () => {
    const controller = new AbortController();
    mockStartRunner.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        })
    );
    const pending = manager.calibrate({
      ...config,
      combos: [config.combos![0]!],
      signal: controller.signal,
    });
    await advanceUntil(() => mockStartRunner.mock.calls.length > 0, 'the first launch');
    controller.abort('test');

    await expect(settleCalibration(pending)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_ABORTED', runs: [] }),
    });
    expect(manager.isCalibrating()).toBe(false);
  });

  it('isolates throwing progress consumers from the sweep', async () => {
    manager.on('calibration-progress', () => {
      throw new Error('listener failed');
    });

    await expect(
      settleCalibration(
        manager.calibrate({
          ...config,
          combos: [config.combos![0]!],
          onProgress: () => {
            throw new Error('callback failed');
          },
        })
      )
    ).resolves.toMatchObject({ runs: [{ status: 'ok' }] });
  });

  it('retains an unsafe orphan guard after teardown cannot be confirmed', async () => {
    const cleanupFailure = Object.assign(new Error('cleanup failed'), {
      details: { code: 'CALIBRATION_CLEANUP_FAILED' },
    });
    mockStartRunner.mockResolvedValue({
      pid: 444,
      port: 20_000,
      loadTimeMs: 10,
      capacity: { effectiveContextSize: 6144, totalSlots: 2 },
      stderrTail: 'tail',
      stop: jest.fn(async () => Promise.reject(cleanupFailure)),
    });
    (manager as unknown as { processManager: { isRunning: () => boolean } }).processManager = {
      isRunning: () => true,
    };

    await expect(
      settleCalibration(manager.calibrate({ ...config, combos: [config.combos![0]!] }))
    ).rejects.toThrow('cleanup failed');
    await expect(manager.start({ modelId: model.id })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 444 }),
    });
  });

  it('installs the orphan guard when startup cleanup fails before a runner is returned', async () => {
    mockStartRunner.mockRejectedValue(
      new ServerError('startup cleanup failed', {
        code: 'CALIBRATION_CLEANUP_FAILED',
        pid: 555,
        stderrTail: 'startup tail',
      })
    );
    (manager as unknown as { processManager: { isRunning: () => boolean } }).processManager = {
      isRunning: () => true,
    };

    await expect(
      settleCalibration(manager.calibrate({ ...config, combos: [config.combos![0]!] }))
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 555 }),
    });
    await expect(manager.start({ modelId: model.id })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 555 }),
    });
  });

  describe('exact-mode resource stability', () => {
    it('guards both boundaries of every combo and admits a quiet sweep', async () => {
      const snapshots = scriptSnapshots({});

      const report = await settleCalibration(manager.calibrate(config));

      if (report.strategy !== 'exact') throw new Error('expected exact report');
      expect(report.status).toBe('complete');
      expect(report.selected?.combo?.label).toBe('b');
      expect(report.probes).toHaveLength(2);
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
      // Three baseline attempts, then one pre-launch and one post-cleanup read per combo. A quiet
      // machine never triggers a confirmation, so there are exactly seven snapshots.
      expect(snapshots.snapshotCount()).toBe(7);
      expect(report.warnings).toEqual([]);
      // Every platform read is bounded and carries the caller's signal, so a hung command can
      // neither stall the sweep nor leak a child process.
      for (const [options] of getGPUInfo.mock.calls as [{ timeoutMs?: number } | undefined][]) {
        expect(options?.timeoutMs).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs);
      }
      for (const [options] of refreshMemoryTelemetry.mock.calls as [
        { timeoutMs?: number } | undefined,
      ][]) {
        expect(options?.timeoutMs).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs);
      }
    });

    it('disables an untrusted baseline metric with a warning and still completes', async () => {
      // Fewer than two trusted baseline samples disable that metric for the whole run. A disabled
      // metric can never trigger anything, so the sweep proceeds - it must not manufacture a drift
      // decision out of absent telemetry.
      scriptSnapshots({ 0: { vram: 'untrusted' }, 1: { vram: 'untrusted' } });

      const report = await settleCalibration(manager.calibrate(config));

      if (report.strategy !== 'exact') throw new Error('expected exact report');
      expect(report.status).toBe('complete');
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Resource metric vram is disabled for this calibration run'),
        ])
      );
      expect(report.warnings).not.toEqual(
        expect.arrayContaining([expect.stringContaining('Resource metric hostMemory is disabled')])
      );
    });

    it.each([
      [
        'decrease',
        { 5: { host: 17_000 }, 6: { host: 17_000 } },
        { hostMemory: 'decrease' as const },
      ],
      [
        'increase',
        { 5: { host: 25_000 }, 6: { host: 25_000 } },
        { hostMemory: 'increase' as const },
      ],
    ])(
      'rejects a confirmed host %s before the second combo without spending its launch',
      async (_direction, overrides, directions) => {
        scriptSnapshots(overrides);
        const progress: LlamaCalibrationProgress[] = [];

        const error = (await captureRejection(
          manager.calibrate({ ...config, onProgress: (value) => progress.push(value) })
        )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

        expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
        expect(error).toBeInstanceOf(ServerError);
        expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
        expect(error.details.suggestion).toEqual(expect.stringContaining('close heavy'));
        // Confirmation is telemetry only: the second candidate never launched.
        expect(mockStartRunner).toHaveBeenCalledTimes(1);
        expect(actions).toEqual(['start', 'stop']);
        const partial = error.details.partialReport;
        expect(partial).toMatchObject({
          strategy: 'exact',
          status: 'failed',
          cleanupConfirmed: true,
        });
        expect(partial.resourceFailure).toMatchObject({
          boundary: 'pre-launch',
          affectedMetrics: ['hostMemory'],
          affectedDirections: directions,
        });
        // A pre-launch failure has no probe by construction.
        expect(partial.resourceFailure.probeIndex).toBeUndefined();
        expect(partial.resourceFailure.diagnostics.confirmationPerformed).toBe(true);
        expect(partial.resourceFailure.diagnostics.confirmation).toBeDefined();
        // The already-clean first launch remains defensible under exact mode's single-launch
        // evidence rule, and is reported by public probe index only.
        expect(partial.probes).toHaveLength(1);
        expect(partial.probes[0]!.resourceValidity).toBe('accepted');
        expect(partial.diagnosticCandidate).toEqual({
          sourceProbeIndexes: [0],
          evidenceLevel: 'single-launch-measurement',
          usability: 'diagnostic-only',
        });
        const terminals = progress.filter((value) => value.phase === 'done');
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({ strategy: 'exact', terminalStatus: 'failed' });
      }
    );

    it('quarantines the first combo on confirmed post-cleanup drift and reports no candidate', async () => {
      // The contaminated run never entered the clean collection, so no candidate is defensible:
      // exact mode must not promote a launch merely because drift ended the sweep.
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });

      const error = (await captureRejection(manager.calibrate(config))) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({
        boundary: 'post-cleanup',
        affectedMetrics: ['hostMemory'],
        probeIndex: 0,
      });
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]).toMatchObject({
        probeIndex: 0,
        operationalStatus: 'ok',
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'invalidated-by-resource-stability',
      });
      expect(partial.diagnosticCandidate).toBeUndefined();
      // The sweep stopped at the invalidated launch: the second candidate never started.
      expect(mockStartRunner).toHaveBeenCalledTimes(1);
    });

    it('admits a suspicious post-cleanup reading that recovers on its confirmation', async () => {
      // One transient dip must not cost a sweep: the confirmation is a cheap telemetry read.
      scriptSnapshots({ 4: { host: 17_000 } });

      const report = await settleCalibration(manager.calibrate(config));

      if (report.strategy !== 'exact') throw new Error('expected exact report');
      expect(report.status).toBe('complete');
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
      expect(mockStartRunner).toHaveBeenCalledTimes(2);
    });

    it('fails stability verification when a different metric crosses in the confirmation', async () => {
      // Host recovers while VRAM becomes newly suspicious: nothing is independently confirmed, and
      // the guard refuses to loop for a third opinion.
      scriptSnapshots({ 5: { host: 17_000 }, 6: { vram: 6_000 } });

      const error = (await captureRejection(manager.calibrate(config))) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_STABILITY_UNVERIFIED');
      expect(error.details.partialReport.resourceFailure.affectedMetrics).toEqual(['vram']);
      expect(mockStartRunner).toHaveBeenCalledTimes(1);
    });

    it('keeps unconfirmed cleanup fatal ahead of a coincident resource failure', async () => {
      // Precedence: possible process orphaning must never be hidden behind a drift error, so the
      // guard is not even consulted for an unconfirmed teardown.
      const snapshots = scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      const cleanupFailure = Object.assign(new Error('cleanup failed'), {
        details: { code: 'CALIBRATION_CLEANUP_FAILED' },
      });
      mockStartRunner.mockReset();
      mockStartRunner.mockResolvedValue({
        pid: 444,
        port: 20_000,
        loadTimeMs: 10,
        capacity: { effectiveContextSize: 6144, totalSlots: 2 },
        stderrTail: 'tail',
        stop: jest.fn(async () => Promise.reject(cleanupFailure)),
      });

      const rejection = await captureRejection(manager.calibrate(config));

      expect(rejection).not.toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(rejection.details?.code).toBe('CALIBRATION_CLEANUP_FAILED');
      expect(rejection.details?.partialReport).toMatchObject({
        strategy: 'exact',
        status: 'failed',
        cleanupConfirmed: false,
      });
      // Three baseline reads plus one pre-launch read: no post-cleanup boundary was taken.
      expect(snapshots.snapshotCount()).toBe(4);
    });

    it('supersedes a fatal probe outcome when its confirmed cleanup is followed by drift', async () => {
      // With cleanup confirmed the probe's own failure is no longer interpretable, so the resource
      // failure wins - but the original failure survives inside the invalidated probe record.
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      mockTokenize.mockResolvedValue(6140);

      const error = (await captureRejection(manager.calibrate(config))) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]).toMatchObject({
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'CALIBRATION_INVALID_CONFIG',
      });
      expect(partial.diagnosticCandidate).toBeUndefined();
    });

    it('never reports a completed sweep after a final-combo post-cleanup drift', async () => {
      // Both launches succeeded, so without the guard this sweep would have returned `complete`.
      scriptSnapshots({ 6: { host: 17_000 }, 7: { host: 17_000 } });
      const progress: LlamaCalibrationProgress[] = [];

      const error = (await captureRejection(
        manager.calibrate({ ...config, onProgress: (value) => progress.push(value) })
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({ boundary: 'post-cleanup', probeIndex: 1 });
      expect(partial.probes).toHaveLength(2);
      expect(partial.probes.map((probe) => probe.resourceValidity)).toEqual([
        'accepted',
        'invalidated-by-resource-stability',
      ]);
      // The candidate may cite only the clean first launch, never the quarantined second one.
      expect(partial.diagnosticCandidate).toEqual({
        sourceProbeIndexes: [0],
        evidenceLevel: 'single-launch-measurement',
        usability: 'diagnostic-only',
      });
      const terminals = progress.filter((value) => value.phase === 'done');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ terminalStatus: 'failed' });
      expect(progress.some((value) => value.overallPercent === 100)).toBe(false);
    });

    it('rejects a caller abort raised during baseline collection as an abort, not drift', async () => {
      const controller = new AbortController();
      scriptSnapshots({});
      refreshMemoryTelemetry.mockImplementation(async () => {
        controller.abort('stop PRIVATE-PROMPT');
        return 'refreshed';
      });

      const error = await captureRejection(
        manager.calibrate({ ...config, signal: controller.signal })
      );

      expect(error).not.toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
      expect(mockStartRunner).not.toHaveBeenCalled();
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        'PRIVATE-PROMPT'
      );
    });

    it('preserves the typed error identity and redaction through the exact outer catch', async () => {
      scriptSnapshots({ 5: { host: 17_000 }, 6: { host: 17_000 } });

      const error = (await captureRejection(manager.calibrate(config))) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      // The outer catch must not rebuild this as a base ServerError: hosts branch on the class and
      // then switch on the typed details code.
      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.name).toBe('LlamaCalibrationResourceStabilityError');
      expect(error.message).toEqual(expect.stringContaining('hostMemory'));
      expect(error.details.partialReport.resourceFailure).toBeDefined();
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        'PRIVATE-PROMPT'
      );
    });
  });
});
