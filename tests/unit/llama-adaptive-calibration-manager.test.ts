import { jest } from '@jest/globals';
import type {
  LlamaAdaptiveCalibrationConfig,
  LlamaCalibrationProgress,
  LlamaCalibrationRequestTiming,
  LlamaCalibrationRun,
  ModelInfo,
  SystemCapabilities,
} from '../../src/types/index.js';
import type {
  RunCalibrationProbeObservation,
  RunCalibrationProbeOptions,
} from '../../src/process/llama-calibration-probe.js';

const mockBinaryIdentity = jest.fn(async () => ({
  version: 'b9860',
  variant: 'cuda',
  checksum: 'binary-sha',
}));

jest.unstable_mockModule('electron', () => ({
  app: { getPath: jest.fn(() => 'C:\\test') },
}));
jest.unstable_mockModule('../../src/utils/binary-identity.js', () => ({
  getInstalledBinaryIdentity: mockBinaryIdentity,
}));

const { LlamaServerManager } = await import('../../src/managers/LlamaServerManager.js');
const { ServerError } = await import('../../src/errors/index.js');

type ProbeExecutor = (
  options: RunCalibrationProbeOptions
) => Promise<RunCalibrationProbeObservation>;

const model: ModelInfo = {
  id: 'adaptive-model',
  name: 'Adaptive model',
  type: 'llm',
  size: 1_000,
  path: 'C:\\models\\adaptive.gguf',
  checksum: 'model-sha',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  source: { type: 'huggingface', url: 'https://example.test', revision: 'abc' },
  ggufMetadata: {
    architecture: 'gemma3',
    block_count: 8,
  },
};

const capabilities: SystemCapabilities = {
  cpu: { cores: 8, model: 'CPU', architecture: 'x64' },
  memory: { total: 32_000, available: 20_000, used: 12_000 },
  gpu: {
    available: true,
    type: 'nvidia',
    name: 'GPU',
    vram: 8_000,
    vramAvailable: 7_000,
  },
  platform: 'win32',
  recommendations: {
    maxModelSize: '13B',
    recommendedQuantization: ['Q4_K_M'],
    threads: 8,
    gpuLayers: 4,
    gpuAcceleration: true,
  },
  detectedAt: '2026-01-01T00:00:00.000Z',
};

const workload = {
  id: 'cold',
  kind: 'cold-prefill' as const,
  prompt: 'PRIVATE-ADAPTIVE-PROMPT',
  nPredict: 8,
};

const baseConfig: LlamaAdaptiveCalibrationConfig = {
  modelId: model.id,
  profiles: [{ contextSize: 8192, parallelRequests: 2 }],
  workloads: [workload],
  samples: 2,
  maxProbes: 20,
  maxWallTimeMs: 2_000_000,
};

function timing(wallTimeMs: number): LlamaCalibrationRequestTiming {
  return {
    wallTimeMs,
    promptTokens: 10,
    predictedTokens: 8,
    cachedTokens: 0,
  };
}

function observation(
  options: RunCalibrationProbeOptions,
  result: {
    status?: LlamaCalibrationRun['status'];
    scoreMs?: number;
    memory?: 'none' | 'confirmed' | 'unknown';
    preflight?: boolean;
    aggregateLowerBoundMs?: number;
  } = {}
): RunCalibrationProbeObservation {
  const status = result.status ?? 'ok';
  const scoreMs = status === 'ok' ? (result.scoreMs ?? 100) : undefined;
  const successful = status === 'ok';
  options.onProgress?.({ phase: 'starting' });
  if (successful) {
    options.onProgress?.({ phase: 'capacity-check' });
    options.onProgress?.({ phase: 'warmup' });
    options.onProgress?.({ phase: 'sampling', workloadIndex: 0, sampleIndex: 0 });
  }
  options.onProgress?.({ phase: 'stopping' });

  const workloadResults = options.workloads.map((entry) => ({
    workloadId: entry.id,
    kind: entry.kind,
    workloadHash: `hash-${entry.id}`,
    weight: entry.weight,
    samples: successful
      ? Array.from({ length: options.sampleCount }, () => ({
          wallTimeMs: scoreMs!,
          requests: [timing(scoreMs!)],
        }))
      : [],
    ...(successful ? { medianWallTimeMs: scoreMs } : { error: status }),
  }));
  const memory = result.memory ?? (successful ? 'none' : 'unknown');
  const memoryEvidence =
    memory === 'confirmed'
      ? ({
          classification: 'confirmed',
          reason: 'scripted allocation failure',
          source: 'specific-allocation-diagnostic',
        } as const)
      : memory === 'none'
        ? ({
            classification: 'none',
            reason: 'scripted healthy launch',
            source: 'not-observed',
          } as const)
        : ({
            classification: 'unknown',
            reason: 'scripted non-memory failure',
            source: 'timeout',
          } as const);
  const preflight = result.preflight ?? successful;
  return {
    run: {
      combo: options.combo,
      resolvedConfig: options.resolvedConfig,
      status,
      ...(successful
        ? {
            loadTimeMs: 10,
            effectiveContextSize:
              options.resolvedConfig.contextSize / options.resolvedConfig.parallelRequests,
            effectiveParallelRequests: options.resolvedConfig.parallelRequests,
            scoreMs,
          }
        : { error: status }),
      workloadResults,
    },
    purpose: options.purpose,
    fidelity: options.fidelity,
    memoryEvidence,
    promptTokenCounts: preflight
      ? new Map(options.workloads.map((entry) => [entry.id, [10] as readonly number[]]))
      : new Map(),
    cleanup: { confirmed: true, durationMs: 1 },
    cleanupConfirmed: true,
    aggregateScoreLowerBoundMs: result.aggregateLowerBoundMs,
  };
}

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

async function waitForExecutorCall(executor: jest.Mock, calls = 1): Promise<void> {
  for (let turn = 0; turn < 50 && executor.mock.calls.length < calls; turn++) {
    await jest.advanceTimersByTimeAsync(0);
  }
  if (executor.mock.calls.length < calls) {
    throw new Error(`scripted executor did not receive call ${calls}`);
  }
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

describe('LlamaServerManager adaptive calibration orchestration', () => {
  let manager: InstanceType<typeof LlamaServerManager>;
  let executor: jest.MockedFunction<ProbeExecutor>;
  let getMemoryInfo: jest.Mock;
  let getGPUInfo: jest.Mock;
  let refreshMemoryTelemetry: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cuda',
      checksum: 'binary-sha',
    });
    executor = jest.fn<ProbeExecutor>();
    getMemoryInfo = jest.fn(() => capabilities.memory);
    getGPUInfo = jest.fn(async () => capabilities.gpu);
    refreshMemoryTelemetry = jest.fn(async () => undefined);
    const modelManager = { getModelInfo: jest.fn(async () => model) };
    const systemInfo = {
      detect: jest.fn(async () => capabilities),
      clearCache: jest.fn(),
      getMemoryInfo,
      getGPUInfo,
      refreshMemoryTelemetry,
    };
    manager = new LlamaServerManager(modelManager as never, systemInfo as never, executor);
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
      gpuLayers: 4,
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      flashAttention: 'on',
      swaFull: false,
    }));
  });

  afterEach(() => {
    if (model.ggufMetadata) delete model.ggufMetadata.attention_sliding_window;
    jest.useRealTimers();
  });

  it('executes a nontrivial GPU boundary trace and returns the reproduced winner', async () => {
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      return gpuLayers >= 7
        ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
        : observation(options, { scoreMs: 100 - gpuLayers });
    });

    const report = await settleCalibration(manager.calibrate(baseConfig));

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(
      executor.mock.calls.map(([options]) => [
        options.purpose,
        options.fidelity,
        options.resolvedConfig.gpuLayers,
      ])
    ).toEqual([
      ['reference', 'search', 4],
      ['ceiling', 'search', 8],
      ['boundary', 'search', 6],
      ['boundary', 'search', 7],
      ['finalist', 'full', 6],
      ['fallback-validation', 'search', 5],
    ]);
    expect(report).toMatchObject({
      status: 'complete',
      selectionEvidence: 'independent-reproduction',
      selected: { profileIndex: 0, startConfig: { gpuLayers: 6 } },
      fallback: { startConfig: { gpuLayers: 5 }, evidence: 'direct-measurement' },
    });
    expect(report.terminalReason).toEqual(expect.any(String));
    // Scripted probes complete in the same mocked clock tick, so no positive observed duration is
    // available to replace the configured estimate in this fixture.
    expect(report.budget.timeAdmission.policy).toBe('configured-conservative-estimate');
    expect(report.budget.effectiveFinalistTimeReserveMs).toBeGreaterThanOrEqual(
      report.budget.finalistTimeReserveMs
    );
    expect(report.probes.map((probe) => probe.independentLaunchIndex)).toEqual([1, 1, 1, 1, 2, 1]);
  });

  it('keeps caller profile indexes separate from smaller-first scheduling ordinals', async () => {
    const profiles = [
      { contextSize: 16_384, parallelRequests: 2 },
      { contextSize: 8192, parallelRequests: 2 },
    ] as const;
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      const score = options.resolvedConfig.contextSize === 16_384 ? 105 : 100;
      return gpuLayers >= 7
        ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
        : observation(options, { scoreMs: score });
    });

    const report = await settleCalibration(
      manager.calibrate({ ...baseConfig, profiles, contextPreferencePct: 10 })
    );

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(report.schedulingProfileIndexes).toEqual([1, 0]);
    expect(
      report.profiles.map(({ profileIndex, profileOrdinal }) => [profileIndex, profileOrdinal])
    ).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(report.probes[0]).toMatchObject({
      profileIndex: 1,
      profileOrdinal: 0,
      resolvedConfig: { contextSize: 8192 },
    });
    expect(report.selected).toMatchObject({
      profileIndex: 0,
      startConfig: { contextSize: 16_384, parallelRequests: 2, gpuLayers: 6 },
    });
  });

  it('emits payload-identical unresolved, policy-ready, active, and terminal progress', async () => {
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      return gpuLayers >= 7
        ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
        : observation(options, { scoreMs: 100 - gpuLayers });
    });
    const callbackProgress: LlamaCalibrationProgress[] = [];
    const eventProgress: LlamaCalibrationProgress[] = [];
    manager.on('calibration-progress', (value) =>
      eventProgress.push(value as LlamaCalibrationProgress)
    );

    const report = await settleCalibration(
      manager.calibrate({
        ...baseConfig,
        onProgress: (value) => callbackProgress.push(value),
      })
    );

    expect(report.status).toBe('complete');
    expect(eventProgress).toEqual(callbackProgress);
    expect(callbackProgress[0]).toMatchObject({
      strategy: 'adaptive',
      phase: 'preparing',
      completedProbes: 0,
      budget: { resolved: false },
    });
    expect(callbackProgress.find((value) => value.phase === 'policy-ready')).toMatchObject({
      budget: { resolved: true, maxProbes: 20 },
    });
    expect(
      callbackProgress.find(
        (value) => value.phase === 'bisecting' && value.activeProbe?.probePhase === 'starting'
      )
    ).toMatchObject({
      activeProbe: {
        purpose: 'boundary',
        gpuLayers: 6,
        resolvedConfig: { contextSize: 8192, parallelRequests: 2, gpuLayers: 6 },
      },
    });
    expect(
      callbackProgress.find(
        (value) =>
          value.strategy === 'adaptive' &&
          value.activeProbe?.fidelity === 'search' &&
          value.activeProbe.probePhase === 'sampling'
      )
    ).toMatchObject({ sampleCount: 1 });
    expect(
      callbackProgress.find(
        (value) =>
          value.strategy === 'adaptive' &&
          value.activeProbe?.fidelity === 'full' &&
          value.activeProbe.probePhase === 'sampling'
      )
    ).toMatchObject({ sampleCount: 2 });
    expect(callbackProgress.at(-1)).toMatchObject({
      strategy: 'adaptive',
      phase: 'done',
      terminalStatus: 'complete',
      overallPercent: 100,
      completedProbes: 6,
    });
  });

  it('isolates active progress payloads from callback and event-listener mutation', async () => {
    let eventGpuLayers: number | undefined;
    manager.on('calibration-progress', (value) => {
      const progress = value as LlamaCalibrationProgress;
      if (progress.strategy === 'adaptive' && progress.activeProbe) {
        eventGpuLayers ??= progress.activeProbe.resolvedConfig.gpuLayers;
        (progress.activeProbe.resolvedConfig as { gpuLayers?: number }).gpuLayers = 98;
      }
    });
    executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

    const report = await settleCalibration(
      manager.calibrate({
        ...baseConfig,
        fixedConfig: { gpuLayers: 0 },
        onProgress: (progress) => {
          if (progress.strategy === 'adaptive' && progress.activeProbe) {
            (progress.activeProbe.resolvedConfig as { gpuLayers?: number }).gpuLayers = 99;
          }
        },
      })
    );

    expect(report.status).toBe('complete');
    expect(eventGpuLayers).toBe(0);
    expect(executor.mock.calls.every(([options]) => options.resolvedConfig.gpuLayers === 0)).toBe(
      true
    );
  });

  it('protects the finalist launch reserve without starting the next search probe', async () => {
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      return gpuLayers >= 5
        ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
        : observation(options, { scoreMs: 100 });
    });

    const report = await settleCalibration(
      manager.calibrate({
        ...baseConfig,
        maxProbes: 5,
      })
    );

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(report.status).toBe('budget-exhausted');
    expect(report.terminalReason).toContain('launch-reserve');
    expect(executor).toHaveBeenCalledTimes(3);
    expect(report.budget.completedProbes).toBe(3);
    expect(report.budget.completedProbes).toBeLessThanOrEqual(report.budget.maxProbes);
    expect(report.budget.targetProbes).toBe(5);
    expect(executor.mock.calls.at(-1)![0].purpose).toBe('boundary');
  });

  it('reports no viable candidate only after confirmed failures descend through g=0', async () => {
    executor.mockImplementation(async (options) =>
      observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
    );

    const report = await settleCalibration(manager.calibrate(baseConfig));

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(report.status).toBe('no-viable-candidate');
    expect(report.selected).toBeUndefined();
    expect(report.provisional).toBeUndefined();
    expect(executor.mock.calls.map(([options]) => options.resolvedConfig.gpuLayers)).toEqual([
      4, 2, 1, 0,
    ]);
    expect(report.cells).toEqual([
      expect.objectContaining({ state: 'no-viable-point', lowGpuLayers: undefined }),
    ]);
  });

  it('defers smallest-profile preflight through reproduced startup failure and descent', async () => {
    const cachedTokenSizes: number[] = [];
    executor.mockImplementation(async (options) => {
      cachedTokenSizes.push(options.cachedPromptTokenCounts?.size ?? -1);
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      if (gpuLayers === 4) {
        return observation(options, {
          status: 'startup-timeout',
          memory: 'unknown',
          preflight: false,
        });
      }
      if (gpuLayers >= 7) {
        return observation(options, { status: 'oom', memory: 'confirmed', preflight: false });
      }
      return observation(options, { scoreMs: 100 - gpuLayers, preflight: true });
    });

    const report = await settleCalibration(manager.calibrate(baseConfig));

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(
      executor.mock.calls
        .slice(0, 3)
        .map(([options]) => [options.purpose, options.resolvedConfig.gpuLayers])
    ).toEqual([
      ['reference', 4],
      ['ambiguity-repeat', 4],
      ['reference', 2],
    ]);
    expect(cachedTokenSizes.slice(0, 4)).toEqual([0, 0, 0, 1]);
    expect(executor.mock.calls[3]![0].cachedPromptTokenCounts?.get(workload.id)).toEqual([10]);
    expect(report.workloadComparability).toBe('verified');
    expect(report.profiles[0]!.verified).toEqual({
      effectiveContextSize: 4096,
      effectiveParallelRequests: 2,
    });
    expect(report.probes.slice(0, 3).map((probe) => probe.operationalStatus)).toEqual([
      'startup-timeout',
      'startup-timeout',
      'ok',
    ]);
  });

  describe('Phase 4 operational hardening', () => {
    it('rejects resolved 4-cell and 8-cell reserve conflicts before binary provisioning', async () => {
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      const profiles = [
        { contextSize: 8192, parallelRequests: 2 },
        { contextSize: 12_288, parallelRequests: 2 },
      ] as const;

      const fourCellError = await captureRejection(
        manager.calibrate({
          ...baseConfig,
          profiles,
          includeKvCacheComparison: true,
          maxProbes: 4,
        })
      );
      expect(fourCellError.details).toMatchObject({
        code: 'CALIBRATION_INVALID_CONFIG',
        finalistReserve: 4,
        cellCount: 4,
      });
      expect(ensureBinary).not.toHaveBeenCalled();

      model.ggufMetadata!.attention_sliding_window = 2048;
      const eightCellError = await captureRejection(
        manager.calibrate({
          ...baseConfig,
          profiles,
          includeKvCacheComparison: true,
          workloads: [
            {
              id: 'shared',
              kind: 'shared-prefix',
              sharedPrefix: 'prefix',
              suffixes: ['prime', 'measured'],
              nPredict: 1,
            },
          ],
          maxProbes: 6,
        })
      );
      expect(eightCellError.details).toMatchObject({
        code: 'CALIBRATION_INVALID_CONFIG',
        finalistReserve: 6,
        cellCount: 8,
      });
      expect(ensureBinary).not.toHaveBeenCalled();
    });

    it('counts SWA relevance per profile during pre-provisioning budget validation', async () => {
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      const profiles = [
        { contextSize: 8192, parallelRequests: 2 },
        { contextSize: 12_288, parallelRequests: 2 },
      ] as const;
      const sharedWorkload = {
        id: 'shared',
        kind: 'shared-prefix' as const,
        sharedPrefix: 'prefix',
        suffixes: ['prime', 'measured'],
        nPredict: 1,
      };
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      model.ggufMetadata!.attention_sliding_window = 8192;
      const belowWindowReport = await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          profiles,
          workloads: [sharedWorkload],
          maxProbes: 3,
        })
      );
      expect(belowWindowReport.status).toBe('budget-exhausted');
      expect(ensureBinary).toHaveBeenCalledTimes(1);

      ensureBinary.mockClear();
      model.ggufMetadata!.attention_sliding_window = 5000;
      const mixedError = await captureRejection(
        manager.calibrate({
          ...baseConfig,
          profiles,
          workloads: [sharedWorkload],
          maxProbes: 3,
        })
      );
      expect(mixedError.details).toMatchObject({
        code: 'CALIBRATION_INVALID_CONFIG',
        finalistReserve: 3,
        cellCount: 3,
      });
      expect(ensureBinary).not.toHaveBeenCalled();
    });

    it('still attempts the first probe when the configured estimate exceeds the budget', async () => {
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          maxWallTimeMs: 400_000,
        })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      // The configured conservative estimate prices every planned request at the
      // full request timeout, so it exceeds this budget. Reserves protect later
      // validation launches only: with no evidence yet there is nothing to
      // protect, and refusing here would return a zero-probe report. The warning
      // is retained, the first probe runs, and admission then uses observed
      // launch durations.
      expect(report.warnings).toEqual([
        expect.stringContaining('configured conservative first-probe estimate'),
      ]);
      expect(executor).toHaveBeenCalled();
      expect(report.probes.length).toBeGreaterThan(0);
      expect(report.probes[0]).toMatchObject({ purpose: 'reference', probeIndex: 0 });
      // The budget really is too small for this workload, so it still exhausts
      // honestly - but now after one probe of real evidence instead of zero.
      expect(report.status).toBe('budget-exhausted');
      expect(report.budget).toMatchObject({
        completedProbes: report.probes.length,
        maxWallTimeMs: 400_000,
      });
    });

    it('warns against the maximum possible default cell budget before provisioning', async () => {
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
      const { maxWallTimeMs: _omitted, ...withoutWallOverride } = baseConfig;
      const report = await settleCalibration(
        manager.calibrate({
          ...withoutWallOverride,
          workloads: [
            { ...workload, weight: 1 },
            {
              id: 'shared',
              kind: 'shared-prefix',
              sharedPrefix: 'shared prefix',
              suffixes: ['prime', 'one', 'two', 'three'],
              nPredict: 1,
              weight: 1,
            },
          ],
        })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      // The warning resolves against the maximum possible cell-count default
      // (1,800,000 ms) even though this run enumerates one cell (1,350,000 ms).
      expect(report.budget.maxWallTimeMs).toBe(1_350_000);
      expect(report.warnings).toEqual([
        expect.stringContaining('pre-provisioning wall-time allowance (1800000 ms)'),
      ]);
    });

    it.each(['wholly', 'partially'] as const)(
      'warns for %s unavailable telemetry without blocking selection',
      async (availability) => {
        if (availability === 'wholly') {
          getMemoryInfo.mockImplementation(() => {
            throw new Error('host telemetry unavailable');
          });
        }
        getGPUInfo.mockImplementation(async () =>
          availability === 'wholly'
            ? Promise.reject(new Error('GPU telemetry unavailable'))
            : { ...capabilities.gpu, vramAvailable: undefined }
        );
        executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

        const report = await settleCalibration(
          manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
        );

        if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
        expect(report.status).toBe('complete');
        expect(report.selected).toBeDefined();
        expect(report.warnings).toContain(
          'GPU available-memory telemetry was unavailable for one or both probe snapshots.'
        );
        if (availability === 'wholly') {
          expect(report.warnings).toContain(
            'Host available-memory telemetry was unavailable for one or both probe snapshots.'
          );
        } else {
          expect(report.warnings).not.toContain(
            'Host available-memory telemetry was unavailable for one or both probe snapshots.'
          );
        }
        expect(report.probes).not.toHaveLength(0);
        expect(
          report.probes.every(
            (probe) =>
              probe.diagnostics?.gpuAvailableMemory.comparability === 'unavailable' &&
              (availability === 'partially' ||
                probe.diagnostics.hostAvailableMemory.comparability === 'unavailable')
          )
        ).toBe(true);
        expect(
          report.probes.every((probe) => probe.boundaryDecision.classification !== 'unsuitable')
        ).toBe(true);
      }
    );

    it('repeats a drifting point and ends unresolved when the level never settles', async () => {
      const memory = (available: number) => ({
        ...capabilities.memory,
        available,
        used: capabilities.memory.total - available,
      });
      // The repeat lands on a different level again (10_000 then 5_000), so the
      // environment is still moving and the launches are not comparable.
      getMemoryInfo
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(10_000))
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(5_000));
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(manager.calibrate(baseConfig));

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('budget-exhausted');
      expect(
        executor.mock.calls.map(([options]) => [options.purpose, options.resolvedConfig.gpuLayers])
      ).toEqual([
        ['reference', 4],
        ['ambiguity-repeat', 4],
      ]);
      expect(report.probes).toHaveLength(2);
      expect(report.probes.map((probe) => probe.boundaryDecision.classification)).toEqual([
        'ambiguous',
        'ambiguous',
      ]);
      expect(report.probes.at(-1)?.boundaryDecision.reason).toBe('persistent-resource-drift');
      expect(
        report.probes.some((probe) => probe.boundaryDecision.classification === 'unsuitable')
      ).toBe(false);
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Available resources fell by more than'),
          'persistent decision-relevant resource drift prevented comparable evidence',
        ])
      );
      // Every host snapshot must be preceded by a telemetry refresh so the
      // baseline and each probe reading share one measurement regime. Without
      // it the Windows standby-aware TTL expires mid-run and later snapshots
      // silently drop to os.freemem(), which excludes reclaimable standby pages.
      expect(refreshMemoryTelemetry.mock.calls.length).toBeGreaterThanOrEqual(
        getMemoryInfo.mock.calls.length
      );
    });

    it('resolves a one-off material drift after clean reproducible launches', async () => {
      const memory = (available: number) => ({
        ...capabilities.memory,
        available,
        used: capabilities.memory.total - available,
      });
      getMemoryInfo
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(10_000))
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(19_000));
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.selected).toBeDefined();
      expect(report.probes[0]?.boundaryDecision).toEqual({
        classification: 'ambiguous',
        reason: 'resource-drift',
      });
      expect(report).toMatchObject({
        selectionEvidence: 'independent-reproduction',
        selected: { scoreMs: 100 },
      });
      expect(report.probes.slice(1).every((probe) => probe.operationalStatus === 'ok')).toBe(true);
    });

    it('re-anchors and continues when a step change settles at a new level', async () => {
      const memory = (available: number) => ({
        ...capabilities.memory,
        available,
        used: capabilities.memory.total - available,
      });
      // Baseline 20_000, then a one-off step to a level that holds across the
      // repeat - a user opening a browser, not an unstable machine.
      getMemoryInfo
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(20_000))
        .mockReturnValueOnce(memory(10_000))
        .mockReturnValueOnce(memory(10_000))
        .mockReturnValueOnce(memory(10_000))
        .mockReturnValueOnce(memory(10_000));
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      // The first drop is still treated as drift and repeated; the repeat proves
      // the level settled, so the reference re-anchors instead of ending the run.
      expect(report.probes[0]?.diagnostics?.hostAvailableMemory.comparability).toBe('available');
      expect(report.probes[1]?.boundaryDecision.reason).toBe('resource-drift');
      // The pre-step launches cannot reproduce the point for the post-step one,
      // so regime 1 has to earn its own second launch before selection.
      expect(report.probes.map((probe) => probe.resourceRegime)).toEqual([0, 0, 1, 1]);
      expect(
        report.probes.some((probe) => probe.boundaryDecision.reason === 'persistent-resource-drift')
      ).toBe(false);
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('re-anchored and continued in resource regime 1'),
        ])
      );
      expect(report.status).toBe('complete');
    });

    it('returns a redacted aborted partial report when already aborted during preparation', async () => {
      const controller = new AbortController();
      const progress: LlamaCalibrationProgress[] = [];
      controller.abort(`stop ${workload.prompt}`);

      const error = await captureRejection(
        manager.calibrate({
          ...baseConfig,
          signal: controller.signal,
          onProgress: (value) => progress.push(value),
        })
      );

      expect(error.details).toMatchObject({
        code: 'CALIBRATION_ABORTED',
        partialReport: {
          strategy: 'adaptive',
          status: 'aborted',
          probes: [],
          cleanupConfirmed: true,
        },
      });
      expect(executor).not.toHaveBeenCalled();
      expect(progress.at(-1)).toMatchObject({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus: 'aborted',
      });
      expect(progress.at(-1)!.overallPercent).toBeLessThan(100);
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
    });

    it('checks caller abort immediately after binary provisioning', async () => {
      const controller = new AbortController();
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      const autoConfigure = (
        manager as unknown as {
          autoConfigureIfNeeded: jest.Mock<(value: unknown) => Promise<unknown>>;
        }
      ).autoConfigureIfNeeded;
      ensureBinary.mockImplementationOnce(async () => {
        controller.abort('stop after provisioning');
        return 'llama-server';
      });

      const error = await captureRejection(
        manager.calibrate({ ...baseConfig, signal: controller.signal })
      );

      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
      expect(mockBinaryIdentity).not.toHaveBeenCalled();
      expect(autoConfigure).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
    });

    it('checks caller abort immediately after adaptive log preparation', async () => {
      const controller = new AbortController();
      const initializeLogManager = (
        manager as unknown as { initializeLogManager: jest.Mock<() => Promise<void>> }
      ).initializeLogManager;
      const runOccupancyCheck = (
        manager as unknown as { runOccupancyCheck: jest.Mock<() => Promise<void>> }
      ).runOccupancyCheck;
      initializeLogManager.mockImplementationOnce(async () => {
        controller.abort('stop after log preparation');
      });

      const error = await captureRejection(
        manager.calibrate({ ...baseConfig, signal: controller.signal })
      );

      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
      expect(runOccupancyCheck).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
    });

    it('trails an active caller abort in a redacted aborted partial report below 100%', async () => {
      const controller = new AbortController();
      const progress: LlamaCalibrationProgress[] = [];
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((_resolve, reject) => {
            options.onProgress?.({ phase: 'starting' });
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error(`active failure ${workload.prompt}`)),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({
        ...baseConfig,
        signal: controller.signal,
        onProgress: (value) => progress.push(value),
      });
      await waitForExecutorCall(executor);
      controller.abort(`caller reason ${workload.prompt}`);
      const error = await captureRejection(pending);

      expect(error.details).toMatchObject({
        code: 'CALIBRATION_ABORTED',
        partialReport: {
          strategy: 'adaptive',
          status: 'aborted',
          cleanupConfirmed: true,
          probes: [
            expect.objectContaining({
              terminationReason: 'caller-abort',
              boundaryDecision: { classification: 'ambiguous', reason: 'caller-abort' },
            }),
          ],
        },
      });
      expect(progress.at(-1)).toMatchObject({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus: 'aborted',
        completedProbes: 1,
      });
      expect(progress.at(-1)!.overallPercent).toBeGreaterThan(0);
      expect(progress.at(-1)!.overallPercent).toBeLessThan(100);
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
    });

    it('maps an active internal deadline to a trailed budget exhaustion, never caller abort', async () => {
      const progress: LlamaCalibrationProgress[] = [];
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((_resolve, reject) => {
            options.onProgress?.({ phase: 'starting' });
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error(`deadline failure ${workload.prompt}`)),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({
        ...baseConfig,
        startupTimeoutMs: 1,
        requestTimeoutMs: 1,
        maxWallTimeMs: 200_000,
        onProgress: (value) => progress.push(value),
      });
      await waitForExecutorCall(executor);
      await jest.advanceTimersByTimeAsync(200_001);
      const report = await settleCalibration(pending);

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('budget-exhausted');
      expect(report.probes).toEqual([
        expect.objectContaining({
          operationalStatus: 'request-timeout',
          terminationReason: 'internal-deadline',
          boundaryDecision: { classification: 'ambiguous', reason: 'internal-deadline' },
        }),
      ]);
      expect(report.probes[0]!.boundaryDecision.classification).not.toBe('unsuitable');
      expect(progress.at(-1)).toMatchObject({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus: 'budget-exhausted',
      });
      expect(
        progress.some((value) => value.phase === 'done' && value.terminalStatus === 'aborted')
      ).toBe(false);
      expect(JSON.stringify(report)).not.toContain(workload.prompt);
    });

    it('keeps cleanup failure fatal when it coincides with caller abort', async () => {
      const controller = new AbortController();
      const progress: LlamaCalibrationProgress[] = [];
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  new ServerError('Cleanup failed during abort', {
                    code: 'CALIBRATION_CLEANUP_FAILED',
                    pid: 4321,
                    cleanup: { confirmed: false, durationMs: 10, pid: 4321 },
                  })
                ),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({
        ...baseConfig,
        signal: controller.signal,
        onProgress: (value) => progress.push(value),
      });
      await waitForExecutorCall(executor);
      controller.abort('caller stop');
      const error = await captureRejection(pending);

      expect(error.details).toMatchObject({
        code: 'CALIBRATION_CLEANUP_FAILED',
        partialReport: { status: 'failed', cleanupConfirmed: false },
      });
      expect(progress.at(-1)).toMatchObject({
        phase: 'done',
        terminalStatus: 'failed',
      });
    });

    it('keeps cleanup failure fatal when it coincides with the internal deadline', async () => {
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  new ServerError('Cleanup failed at deadline', {
                    code: 'CALIBRATION_CLEANUP_FAILED',
                    pid: 4321,
                    cleanup: { confirmed: false, durationMs: 10, pid: 4321 },
                  })
                ),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({
        ...baseConfig,
        startupTimeoutMs: 1,
        requestTimeoutMs: 1,
        maxWallTimeMs: 200_000,
      });
      await waitForExecutorCall(executor);
      await jest.advanceTimersByTimeAsync(200_001);
      const error = await captureRejection(pending);

      expect(error.details).toMatchObject({
        code: 'CALIBRATION_CLEANUP_FAILED',
        partialReport: { status: 'failed', cleanupConfirmed: false },
      });
    });

    it('does not let unavailable GPU telemetry outlive the hard deadline', async () => {
      getGPUInfo.mockImplementation(() => new Promise(() => undefined));
      executor.mockImplementation(async (options) => {
        expect(options.signal?.aborted).toBe(true);
        return observation(options, { scoreMs: 100 });
      });

      const pending = manager.calibrate({
        ...baseConfig,
        fixedConfig: { gpuLayers: 0 },
        startupTimeoutMs: 1,
        requestTimeoutMs: 1,
        maxWallTimeMs: 200_000,
      });
      await jest.advanceTimersByTimeAsync(200_001);
      const report = await settleCalibration(pending);

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('budget-exhausted');
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('uses the lowest workload weight when deciding whether a repeated cap can close', async () => {
      const weightedWorkloads = [
        { ...workload, id: 'heavy', weight: 10 },
        { ...workload, id: 'light', weight: 1 },
      ] as const;
      executor.mockImplementation(async (options) => {
        const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
        if (gpuLayers === 8 && options.purpose === 'ceiling') {
          return observation(options, {
            status: 'request-timeout',
            memory: 'unknown',
            preflight: false,
            aggregateLowerBoundMs: 9_000,
          });
        }
        if (gpuLayers === 8 && options.purpose === 'ambiguity-repeat') {
          expect(options.completionTimeoutMs).toBe(options.requestTimeoutMs);
          return observation(options, { scoreMs: 5_100 });
        }
        return observation(options, { scoreMs: 5_000 });
      });

      await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          workloads: weightedWorkloads,
          maxProbes: 8,
        })
      );

      expect(
        executor.mock.calls.some(
          ([options]) =>
            options.purpose === 'ambiguity-repeat' && options.resolvedConfig.gpuLayers === 8
        )
      ).toBe(true);
    });
  });

  it('keeps exact mode to one full fresh launch per caller-ordered combo', async () => {
    executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
    const exactConfig = {
      modelId: model.id,
      profile: { contextSize: 8192, parallelRequests: 2 },
      workloads: [workload],
      samples: 2,
      combos: [
        { label: 'first', overrides: { gpuLayers: 2 } },
        { label: 'second', overrides: { gpuLayers: 6 } },
      ],
    } as const;

    const report = await settleCalibration(manager.calibrate(exactConfig));

    if (report.strategy !== 'exact') throw new Error('expected exact report');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(
      executor.mock.calls.map(([options]) => [
        options.combo.label,
        options.purpose,
        options.fidelity,
        options.sampleCount,
      ])
    ).toEqual([
      ['first', 'exact', 'full', 2],
      ['second', 'exact', 'full', 2],
    ]);
    expect(report.probes.map((probe) => probe.independentLaunchIndex)).toEqual([1, 1]);
    expect(report.selectionEvidence).toBe('single-launch-measurement');
  });

  it('isolates exact progress payload mutation from the launched candidate', async () => {
    executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
    const exactConfig = {
      modelId: model.id,
      profile: { contextSize: 8192, parallelRequests: 2 },
      workloads: [workload],
      combos: [{ label: 'only', overrides: { gpuLayers: 2 } }],
      onProgress: (progress: LlamaCalibrationProgress) => {
        if (progress.strategy === 'exact' && progress.activeCandidate) {
          (progress.activeCandidate.resolvedConfig as { gpuLayers?: number }).gpuLayers = 99;
        }
      },
    } as const;

    const report = await settleCalibration(manager.calibrate(exactConfig));

    expect(report.status).toBe('complete');
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedConfig: expect.objectContaining({ gpuLayers: 2 }) })
    );
  });

  it.each(['adaptive', 'exact'] as const)(
    'trails a fatal post-start validation launch in the %s failed partial report',
    async (strategy) => {
      executor.mockImplementation(async (options) => {
        const failed = observation(options, { status: 'error', preflight: false });
        throw new ServerError('Workload exceeds verified capacity', {
          code: 'CALIBRATION_INVALID_CONFIG',
          probeObservation: failed,
        });
      });
      const config =
        strategy === 'adaptive'
          ? baseConfig
          : {
              modelId: model.id,
              profile: { contextSize: 8192, parallelRequests: 2 },
              workloads: [workload],
              combos: [{ label: 'only', overrides: { gpuLayers: 2 } }],
            };

      const error = await captureRejection(manager.calibrate(config));
      const partial = error.details?.partialReport as
        | { status?: string; probes?: Array<{ terminationReason?: string }> }
        | undefined;
      expect(error.details?.code).toBe('CALIBRATION_INVALID_CONFIG');
      expect(partial).toMatchObject({
        status: 'failed',
        probes: [expect.objectContaining({ terminationReason: 'CALIBRATION_INVALID_CONFIG' })],
      });
    }
  );

  it('retains unconfirmed cleanup evidence and blocks a later calibration while the orphan lives', async () => {
    executor.mockRejectedValue(
      new ServerError('Probe cleanup failed', {
        code: 'CALIBRATION_CLEANUP_FAILED',
        pid: 4321,
        stderrTail: `failure near ${workload.prompt}`,
        cleanup: {
          confirmed: false,
          durationMs: 2_000,
          pid: 4321,
          error: `could not stop after ${workload.prompt}`,
        },
      })
    );

    const rejection = await captureRejection(manager.calibrate(baseConfig));
    const partialReport = rejection.details?.partialReport as
      | {
          status?: string;
          cleanupConfirmed?: boolean;
          probes?: Array<{
            boundaryDecision: { reason: string };
            cleanup: { confirmed: boolean };
          }>;
        }
      | undefined;
    expect(rejection.details?.code).toBe('CALIBRATION_CLEANUP_FAILED');
    expect(partialReport).toMatchObject({ status: 'failed', cleanupConfirmed: false });
    expect(partialReport?.probes?.at(-1)).toMatchObject({
      boundaryDecision: { reason: 'cleanup-unconfirmed' },
      cleanup: { confirmed: false },
    });
    expect(JSON.stringify(partialReport)).not.toContain(workload.prompt);

    const processManager = (
      manager as unknown as { processManager: { isRunning: (pid: number) => boolean } }
    ).processManager;
    processManager.isRunning = jest.fn(() => true);
    const blocked = await captureRejection(manager.calibrate(baseConfig));
    expect(blocked.details).toMatchObject({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 4321 });
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
