import { jest } from '@jest/globals';
import { ServerError } from '../../src/errors/index.js';
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
  gpu: { available: true, type: 'nvidia', name: 'GPU', vram: 8_000 },
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

describe('LlamaServerManager.calibrate', () => {
  let manager: InstanceType<typeof LlamaServerManager>;
  let runnerStops: jest.Mock[];
  let actions: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cuda',
      checksum: 'binary-sha',
    });
    actions = [];
    runnerStops = [];
    const modelManager = { getModelInfo: jest.fn(async () => model) };
    const systemInfo = {
      detect: jest.fn(async () => capabilities),
      clearCache: jest.fn(),
      getMemoryInfo: jest.fn(() => capabilities.memory),
      getGPUInfo: jest.fn(async () => capabilities.gpu),
      // Required by the resource guard's snapshots. A `'failed'` status makes host memory
      // untrusted, so returning the real success status here keeps the suite on the normal
      // fully-guarded path instead of the degraded-telemetry one.
      refreshMemoryTelemetry: jest.fn(async () => 'refreshed'),
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

    const report = await manager.calibrate({
      ...config,
      onProgress: (event) => progress.push(event.overallPercent),
    });

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

    const report = await manager.calibrate(config);

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

    const report = await manager.calibrate(config);

    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(report.runs.map((run) => run.status)).toEqual(['oom', 'ok']);
    expect(report.selected?.combo?.label).toBe('b');
    expect(runnerStops).toHaveLength(1);
  });

  it('rejects normalized-equivalent custom candidates before provisioning', async () => {
    await expect(
      manager.calibrate({
        ...config,
        combos: [
          { overrides: { cacheTypeV: 'q8_0' } },
          { overrides: { cacheTypeV: 'q8_0', flashAttention: 'on' } },
        ],
      })
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

    const report = await manager.calibrate({
      ...config,
      combos: [{ label: 'cpu', overrides: { gpuLayers: 0 } }],
    });

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

    const report = await manager.calibrate({
      modelId: model.id,
      profiles: [{ contextSize: 4096, parallelRequests: 1 }],
      workloads: [{ id: 'cold', kind: 'cold-prefill', prompt: 'PRIVATE-PROMPT', nPredict: 8 }],
      samples: 1,
      onProgress: (progress) => callbackProgress.push(progress),
    });

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
    // This suite runs on real timers, and the resource guard's schedule is real wall time: a fixed
    // settle delay plus cooldown-spaced baseline samples before the probe clock starts, then one
    // cooldown after each probe's teardown. That is the cost the plan accepted, so the timeout is
    // raised here rather than the schedule being mocked away.
  }, 60_000);

  it('erases, primes, and times a complete shared-prefix burst on one slot', async () => {
    mockComplete.mockReset().mockResolvedValue(timing(10));
    const report = await manager.calibrate({
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
    });

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

    await expect(manager.calibrate(config)).rejects.toMatchObject({
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
    await new Promise((resolve) => setImmediate(resolve));

    await expect(manager.start({ modelId: model.id })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_BUSY' }),
    });
    await expect(
      manager.calibrate({ ...config, combos: [config.combos![0]!] })
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_BUSY' }),
    });
    release();
    await pending;
  });

  it('rejects calibration while the normal server is running', async () => {
    (manager as unknown as { _status: string })._status = 'running';

    await expect(manager.calibrate(config)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SERVER_RUNNING' }),
    });
  });

  it('reports strict occupancy and capability-detection preparation failures', async () => {
    (manager as unknown as { runOccupancyCheck: () => Promise<void> }).runOccupancyCheck = jest.fn(
      async () => Promise.reject(new Error('occupied'))
    );
    await expect(manager.calibrate(config)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_RESOURCE_BUSY' }),
    });

    (manager as unknown as { runOccupancyCheck: () => Promise<void> }).runOccupancyCheck = jest.fn(
      async () => undefined
    );
    (manager as unknown as { systemInfo: { detect: () => Promise<never> } }).systemInfo.detect =
      jest.fn(async () => Promise.reject(new Error('detection failed')));
    await expect(manager.calibrate(config)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_PREPARATION_FAILED' }),
    });
  });

  it('treats an unverifiable fixed slot profile as a calibration-level failure', async () => {
    mockStartRunner.mockRejectedValue(
      new ServerError('slot count missing', { code: 'CALIBRATION_SLOTS_UNAVAILABLE' })
    );

    await expect(
      manager.calibrate({ ...config, combos: [config.combos![0]!] })
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
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort('test');

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_ABORTED', runs: [] }),
    });
    expect(manager.isCalibrating()).toBe(false);
  });

  it('isolates throwing progress consumers from the sweep', async () => {
    manager.on('calibration-progress', () => {
      throw new Error('listener failed');
    });

    await expect(
      manager.calibrate({
        ...config,
        combos: [config.combos![0]!],
        onProgress: () => {
          throw new Error('callback failed');
        },
      })
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

    await expect(manager.calibrate({ ...config, combos: [config.combos![0]!] })).rejects.toThrow(
      'cleanup failed'
    );
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
      manager.calibrate({ ...config, combos: [config.combos![0]!] })
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 555 }),
    });
    await expect(manager.start({ modelId: model.id })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 555 }),
    });
  });
});
