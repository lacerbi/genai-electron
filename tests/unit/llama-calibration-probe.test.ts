import { jest } from '@jest/globals';

import { ServerError } from '../../src/errors/index.js';
import type { RunCalibrationProbeOptions } from '../../src/process/llama-calibration-probe.js';
import type {
  LlamaCalibrationRequestTiming,
  LlamaCalibrationWorkload,
  ModelInfo,
  ResolvedLlamaCalibrationConfig,
} from '../../src/types/index.js';

const mockStartRunner = jest.fn();
const mockTokenize = jest.fn();
const mockEraseSlot = jest.fn();
const mockComplete = jest.fn();
const mockClientConstructor = jest.fn();

class MockCalibrationClient {
  tokenize = mockTokenize;
  eraseSlot = mockEraseSlot;
  complete = mockComplete;

  constructor(runner: unknown, requestTimeoutMs: number, signal?: AbortSignal) {
    mockClientConstructor(runner, requestTimeoutMs, signal);
  }
}

jest.unstable_mockModule('../../src/process/llama-server-runner.js', () => ({
  startLlamaServerRunner: mockStartRunner,
}));
jest.unstable_mockModule('../../src/process/llama-calibration-client.js', () => ({
  LlamaCalibrationClient: MockCalibrationClient,
}));

const { runCalibrationProbe } = await import('../../src/process/llama-calibration-probe.js');

const model: ModelInfo = {
  id: 'gemma',
  name: 'Gemma',
  type: 'llm',
  size: 1_000,
  path: 'C:\\models\\gemma.gguf',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  source: { type: 'huggingface', url: 'https://example.test' },
};

const resolvedConfig: ResolvedLlamaCalibrationConfig = {
  contextSize: 12_288,
  parallelRequests: 2,
  gpuLayers: 30,
};

const workloads = [
  {
    id: 'cold',
    kind: 'cold-prefill',
    prompt: 'PRIVATE-PROMPT',
    nPredict: 8,
    weight: 1,
  },
] as const satisfies readonly (LlamaCalibrationWorkload & { weight: number })[];

function timing(wallTimeMs = 100): LlamaCalibrationRequestTiming {
  return {
    wallTimeMs,
    promptTokens: 10,
    predictedTokens: 8,
    cachedTokens: 0,
  };
}

function options(overrides: Partial<RunCalibrationProbeOptions> = {}): RunCalibrationProbeOptions {
  return {
    binaryPath: 'llama-server',
    model,
    combo: { label: 'candidate', overrides: { gpuLayers: 30 } },
    resolvedConfig,
    workloads,
    purpose: 'exact' as const,
    fidelity: 'full' as const,
    sampleCount: 2,
    seed: 42,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 900,
    completionTimeoutMs: 75,
    ...overrides,
  };
}

describe('runCalibrationProbe', () => {
  let stop: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    stop = jest.fn(async () => undefined);
    mockStartRunner.mockResolvedValue({
      pid: 101,
      port: 20_001,
      loadTimeMs: 10,
      capacity: { effectiveContextSize: 6_144, totalSlots: 2 },
      stderrTail: '',
      stop,
    });
    mockTokenize.mockResolvedValue(10);
    mockEraseSlot.mockResolvedValue(undefined);
    mockComplete.mockResolvedValue(timing());
  });

  it('uses one fresh process, waits for confirmed cleanup, and scopes completion fidelity', async () => {
    let releaseStop!: () => void;
    let announceStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      announceStop = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    stop.mockImplementation(async () => {
      announceStop();
      await stopGate;
    });

    let settled = false;
    const pending = runCalibrationProbe(
      options({
        onProgress: () => {
          throw new Error('observer failure');
        },
      })
    ).then((observation) => {
      settled = true;
      return observation;
    });
    await stopStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseStop();
    const observation = await pending;

    expect(mockStartRunner).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(observation.cleanupConfirmed).toBe(true);
    expect(observation.cleanup).toMatchObject({ confirmed: true, pid: 101 });
    expect(observation.run.scoreMs).toBe(100);
    expect(mockClientConstructor).toHaveBeenCalledWith(expect.anything(), 900, undefined);
    expect(mockComplete).toHaveBeenCalledTimes(3); // one warmup plus two full samples
    expect(mockComplete.mock.calls.map((call) => call[1])).toEqual([900, 75, 75]);
  });

  it('reuses verified token counts while checking every launch capacity', async () => {
    const first = await runCalibrationProbe(options({ sampleCount: 1 }));
    expect(mockTokenize).toHaveBeenCalledTimes(1);

    mockStartRunner.mockResolvedValueOnce({
      pid: 102,
      port: 20_002,
      loadTimeMs: 11,
      capacity: { effectiveContextSize: 6_144, totalSlots: 2 },
      stderrTail: '',
      stop,
    });
    const second = await runCalibrationProbe(
      options({
        fidelity: 'search',
        sampleCount: 1,
        cachedPromptTokenCounts: first.promptTokenCounts,
      })
    );

    expect(mockStartRunner).toHaveBeenCalledTimes(2);
    expect(mockTokenize).toHaveBeenCalledTimes(1);
    expect(second.fidelity).toBe('search');
    expect(second.run.effectiveContextSize).toBe(6_144);

    mockStartRunner.mockResolvedValueOnce({
      pid: 103,
      port: 20_003,
      loadTimeMs: 11,
      capacity: { effectiveContextSize: 17, totalSlots: 2 },
      stderrTail: '',
      stop,
    });
    await expect(
      runCalibrationProbe(
        options({
          sampleCount: 1,
          cachedPromptTokenCounts: first.promptTokenCounts,
        })
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_INVALID_CONFIG' }),
    });
    expect(mockTokenize).toHaveBeenCalledTimes(1);
    expect(mockStartRunner).toHaveBeenCalledTimes(3);
  });

  it('redacts configured prompt text and keeps generic CUDA separate from confirmed memory evidence', async () => {
    mockStartRunner.mockResolvedValueOnce({
      pid: 103,
      port: 20_003,
      loadTimeMs: 10,
      capacity: { effectiveContextSize: 6_144, totalSlots: 2 },
      stderrTail: 'driver echoed PRIVATE-PROMPT after CUDA error',
      stop,
    });
    mockComplete.mockRejectedValueOnce(new Error('CUDA error while handling PRIVATE-PROMPT'));

    const observation = await runCalibrationProbe(options({ sampleCount: 1 }));

    expect(observation.run.status).toBe('oom');
    expect(observation.memoryEvidence.classification).toBe('suspected');
    expect(observation.run.error).not.toContain('PRIVATE-PROMPT');
    expect(observation.run.stderrTail).not.toContain('PRIVATE-PROMPT');
    expect(JSON.stringify(observation)).toContain('[REDACTED]');
    expect(JSON.stringify(observation)).not.toContain('PRIVATE-PROMPT');
  });

  it('requires a specific allocation diagnostic for confirmed memory evidence', async () => {
    mockComplete.mockRejectedValueOnce(new Error('cudaMalloc failed for PRIVATE-PROMPT'));

    const observation = await runCalibrationProbe(options({ sampleCount: 1 }));

    expect(observation.run.status).toBe('oom');
    expect(observation.memoryEvidence).toMatchObject({
      classification: 'confirmed',
      source: 'specific-allocation-diagnostic',
    });
  });

  it('reports a weighted lower bound only for an adaptive timeout during timed sampling', async () => {
    const weightedWorkloads = [
      { ...workloads[0], id: 'first', weight: 1 },
      { ...workloads[0], id: 'second', weight: 3 },
    ] as const;
    mockComplete
      .mockResolvedValueOnce(timing(40)) // first warmup
      .mockResolvedValueOnce(timing(40)) // second warmup
      .mockResolvedValueOnce(timing(100)) // first timed workload
      .mockRejectedValueOnce(
        new ServerError('Timed completion exceeded its adaptive cap', {
          code: 'CALIBRATION_REQUEST_TIMEOUT',
        })
      );

    const observation = await runCalibrationProbe(
      options({
        workloads: weightedWorkloads,
        purpose: 'boundary',
        fidelity: 'search',
        sampleCount: 1,
        completionTimeoutMs: 80,
      })
    );

    expect(observation.run.status).toBe('request-timeout');
    expect(observation.aggregateScoreLowerBoundMs).toBe(85);
    expect(observation.run.workloadResults[0]?.medianWallTimeMs).toBe(100);
    expect(observation.run.workloadResults[1]?.error).toContain('adaptive cap');

    jest.clearAllMocks();
    mockStartRunner.mockResolvedValue({
      pid: 101,
      port: 20_001,
      loadTimeMs: 10,
      capacity: { effectiveContextSize: 6_144, totalSlots: 2 },
      stderrTail: '',
      stop,
    });
    mockTokenize.mockResolvedValue(10);
    mockEraseSlot.mockResolvedValue(undefined);
    mockComplete.mockRejectedValueOnce(
      new ServerError('Warmup timed out', { code: 'CALIBRATION_REQUEST_TIMEOUT' })
    );
    const warmupTimeout = await runCalibrationProbe(
      options({ purpose: 'boundary', fidelity: 'search', sampleCount: 1 })
    );
    expect(warmupTimeout.aggregateScoreLowerBoundMs).toBeUndefined();
  });

  it('uses the full request timeout for shared-prefix priming and never derives a cap bound from it', async () => {
    const sharedWorkload = [
      {
        id: 'shared',
        kind: 'shared-prefix',
        sharedPrefix: 'PRIVATE-PREFIX',
        suffixes: ['prime', 'measured'],
        nPredict: 1,
        weight: 1,
      },
    ] as const;
    mockComplete
      .mockResolvedValueOnce(timing(20)) // warmup prime
      .mockResolvedValueOnce(timing(20)) // warmup measured suffix
      .mockRejectedValueOnce(
        new ServerError('Priming timed out at the full request timeout', {
          code: 'CALIBRATION_REQUEST_TIMEOUT',
        })
      );

    const result = await runCalibrationProbe(
      options({
        workloads: sharedWorkload,
        purpose: 'boundary',
        fidelity: 'search',
        sampleCount: 1,
        completionTimeoutMs: 75,
        requestTimeoutMs: 900,
      })
    );

    expect(result.run.status).toBe('request-timeout');
    expect(result.aggregateScoreLowerBoundMs).toBeUndefined();
    expect(mockComplete.mock.calls.map((call) => call[1])).toEqual([900, 900, 900]);
  });

  it('keeps transient adaptive capacity discovery operational while exact mode stays strict', async () => {
    const unavailable = new ServerError('Could not verify /props', {
      code: 'CALIBRATION_SLOTS_UNAVAILABLE',
      reason: 'runtime-capacity-unavailable',
    });
    mockStartRunner.mockRejectedValueOnce(unavailable);

    const adaptive = await runCalibrationProbe(
      options({ purpose: 'reference', fidelity: 'search', sampleCount: 1 })
    );

    expect(adaptive.run.status).toBe('error');
    expect(adaptive.memoryEvidence.classification).toBe('unknown');

    mockStartRunner.mockRejectedValueOnce(unavailable);
    await expect(runCalibrationProbe(options({ purpose: 'exact' }))).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SLOTS_UNAVAILABLE' }),
    });
  });

  it('attaches a cleaned-up observation to fatal post-start workload validation errors', async () => {
    mockTokenize.mockResolvedValueOnce(6_140);

    await expect(runCalibrationProbe(options({ purpose: 'exact' }))).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'CALIBRATION_INVALID_CONFIG',
        probeObservation: expect.objectContaining({
          run: expect.objectContaining({ status: 'error' }),
          cleanup: expect.objectContaining({ confirmed: true, pid: 101 }),
        }),
      }),
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup failure fatal and redacts its orphan diagnostics', async () => {
    stop.mockRejectedValueOnce(
      Object.assign(new Error('Could not clean PRIVATE-PROMPT'), {
        details: { stderrTail: 'PRIVATE-PROMPT remained in stderr' },
      })
    );

    let caught: unknown;
    try {
      await runCalibrationProbe(options({ sampleCount: 1 }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      details: expect.objectContaining({
        code: 'CALIBRATION_CLEANUP_FAILED',
        pid: 101,
        cleanup: expect.objectContaining({ confirmed: false }),
      }),
    });
    expect(JSON.stringify(caught)).not.toContain('PRIVATE-PROMPT');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
