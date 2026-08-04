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

/**
 * Pass-through spy on the one call that hands an observation to the adaptive policy.
 *
 * Quarantine is a claim about what the policy never saw, and the policy's state is private to the
 * run, so the call itself is the only place that claim is directly observable. Every other export
 * is re-exported untouched, so behaviour is identical to the real module.
 */
const actualAdaptivePolicy = await import('../../src/utils/llama-adaptive-calibration-policy.js');
const applyAdaptivePolicyObservation = jest.fn(actualAdaptivePolicy.applyAdaptivePolicyObservation);
const nextAdaptivePolicyAction = jest.fn(actualAdaptivePolicy.nextAdaptivePolicyAction);
jest.unstable_mockModule('../../src/utils/llama-adaptive-calibration-policy.js', () => ({
  ...actualAdaptivePolicy,
  applyAdaptivePolicyObservation,
  nextAdaptivePolicyAction,
}));

const { LlamaServerManager } = await import('../../src/managers/LlamaServerManager.js');
const { LlamaCalibrationResourceStabilityError, ServerError } = await import(
  '../../src/errors/index.js'
);
const { LLAMA_CALIBRATION_DEFAULTS } = await import('../../src/config/defaults.js');

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
  maxWallTimeMs: 3_600_000,
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

async function settleCalibration<T>(
  promise: Promise<T>,
  stepMs = 1_000,
  maxTurns = 100
): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let turn = 0; turn < maxTurns && !settled; turn++) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  if (!settled) throw new Error('scripted calibration did not settle');
  return promise;
}

async function waitForExecutorCall(executor: jest.Mock, calls = 1): Promise<void> {
  // Real fake time has to pass here, not just microtasks: the resource guard's fixed settle delay
  // and its cooldown-spaced baseline samples are paid before the first launch.
  for (let turn = 0; turn < 200 && executor.mock.calls.length < calls; turn++) {
    await jest.advanceTimersByTimeAsync(250);
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

/** One whole-machine reading; `'untrusted'` makes that metric's source fail for this snapshot. */
interface ScriptedSnapshot {
  host: number | 'untrusted';
  vram: number | 'untrusted';
}

/** The quiet reading every unscripted snapshot returns. */
const QUIET_SNAPSHOT: ScriptedSnapshot = { host: 20_000, vram: 7_000 };

describe('LlamaServerManager adaptive calibration orchestration', () => {
  let manager: InstanceType<typeof LlamaServerManager>;
  let executor: jest.MockedFunction<ProbeExecutor>;
  let getMemoryInfo: jest.Mock;
  let getGPUInfo: jest.Mock;
  let refreshMemoryTelemetry: jest.Mock;

  /**
   * Script the guard's snapshots as one atomic queue keyed by snapshot ordinal.
   *
   * Host and GPU values are pinned together by the refresh call that opens every snapshot, so the
   * two sources cannot drift out of alignment however many reads a boundary happens to take.
   * Ordinals for one adaptive run are: 0-2 baseline, then per probe one pre-launch read followed
   * by one post-cleanup read, each immediately followed by its confirmation read when suspicious.
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
    // `resetMocks` strips implementations before every test, so the pass-through has to be re-armed
    // here or the policy call would silently return undefined for the whole suite.
    applyAdaptivePolicyObservation.mockImplementation(
      actualAdaptivePolicy.applyAdaptivePolicyObservation
    );
    nextAdaptivePolicyAction.mockImplementation(actualAdaptivePolicy.nextAdaptivePolicyAction);
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cuda',
      checksum: 'binary-sha',
    });
    executor = jest.fn<ProbeExecutor>();
    getMemoryInfo = jest.fn(() => capabilities.memory);
    getGPUInfo = jest.fn(async () => capabilities.gpu);
    refreshMemoryTelemetry = jest.fn(async () => 'refreshed');
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
        : observation(options, { scoreMs: 200 - gpuLayers * 10 });
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
    ]);
    expect(report).toMatchObject({
      status: 'complete',
      selectionEvidence: 'independent-reproduction',
      selected: { profileIndex: 0, startConfig: { gpuLayers: 6 } },
      fallback: { startConfig: { gpuLayers: 5 }, evidence: 'unvalidated-option' },
    });
    expect(report.terminalReason).toEqual(expect.any(String));
    expect(report.budget).toMatchObject({
      maxWallTimeMs: 3_600_000,
      overrunMs: 0,
      maxProbes: 20,
    });
    expect(report.probes.map((probe) => probe.independentLaunchIndex)).toEqual([1, 1, 1, 1, 2]);
  });

  it('keeps caller profile indexes separate from smaller-first scheduling ordinals', async () => {
    const profiles = [
      { contextSize: 16_384, parallelRequests: 2 },
      { contextSize: 8192, parallelRequests: 2 },
    ] as const;
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      const score =
        (options.resolvedConfig.contextSize === 16_384 ? 105 : 100) + (8 - gpuLayers) * 20;
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
        : observation(options, { scoreMs: 200 - gpuLayers * 10 });
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
      budget: {
        maxWallTimeMs: 3_600_000,
        maxProbes: 20,
        remainingProbes: 20,
      },
    });
    expect(callbackProgress.find((value) => value.phase === 'policy-ready')).toMatchObject({
      budget: {
        maxWallTimeMs: 3_600_000,
        maxProbes: 20,
      },
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
      completedProbes: 5,
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

  it('uses the optional final probe slot to strengthen the incumbent', async () => {
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
    expect(report.status).toBe('probe-limited');
    expect(report.searchCompleteness).toBe('partial');
    expect(report.selectionEvidence).toBe('independent-reproduction');
    expect(executor).toHaveBeenCalledTimes(5);
    expect(report.probes).toHaveLength(5);
    expect(report.budget.maxProbes).toBe(5);
    expect(executor.mock.calls.at(-1)![0].purpose).toBe('finalist');
  });

  it('reports no viable candidate only after confirmed failures descend through g=0', async () => {
    executor.mockImplementation(async (options) =>
      observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
    );

    const report = await settleCalibration(manager.calibrate(baseConfig));

    if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
    expect(report.status).toBe('no-viable-candidate');
    expect(report.selected).toBeUndefined();
    expect(report.selectionEvidence).toBeUndefined();
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
    it('accepts maxProbes: 1 without a cell-count reserve conflict', async () => {
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          profiles: [
            { contextSize: 8192, parallelRequests: 2 },
            { contextSize: 12_288, parallelRequests: 2 },
          ],
          includeKvCacheComparison: true,
          maxProbes: 1,
        })
      );
      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report).toMatchObject({
        status: 'probe-limited',
        searchCompleteness: 'partial',
        selectionEvidence: 'single-search-launch',
        budget: {
          maxProbes: 1,
        },
      });
      expect(report.selected).toBeDefined();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(ensureBinary).toHaveBeenCalledTimes(1);
    });

    it('consumes the cap at invocation while completedProbes still counts settled trail records', async () => {
      const progress: LlamaCalibrationProgress[] = [];
      let release!: (value: RunCalibrationProbeObservation) => void;
      executor.mockImplementationOnce(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((resolve) => {
            release = resolve;
            options.onProgress?.({ phase: 'starting' });
          })
      );

      const pending = manager.calibrate({
        ...baseConfig,
        maxProbes: 1,
        onProgress: (value) => progress.push(value),
      });
      await waitForExecutorCall(executor);

      expect(
        progress.find(
          (value) => value.strategy === 'adaptive' && value.activeProbe?.probePhase === 'starting'
        )
      ).toMatchObject({
        completedProbes: 0,
        budget: { maxProbes: 1, remainingProbes: 0 },
      });
      release(observation(executor.mock.calls[0]![0], { scoreMs: 100 }));
      const report = await settleCalibration(pending);
      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.probes).toHaveLength(1);
      expect(progress.at(-1)).toMatchObject({
        completedProbes: 1,
        budget: { maxProbes: 1, remainingProbes: 0 },
      });
    });

    it('keeps the probe limit unbounded across profile-local SWA cells when omitted', async () => {
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
      model.ggufMetadata!.attention_sliding_window = 5000;
      const { maxProbes: _omitted, ...withoutProbeLimit } = baseConfig;
      const report = await settleCalibration(
        manager.calibrate({
          ...withoutProbeLimit,
          profiles,
          workloads: [sharedWorkload],
        })
      );
      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.budget.maxProbes).toBeUndefined();
      expect(report.status).not.toBe('probe-limited');
      expect(report.cells).toHaveLength(3);
      expect(report.probes.length).toBeGreaterThan(0);
      expect(ensureBinary).toHaveBeenCalledTimes(1);
    });

    it('continues an unbounded eight-cell run beyond the old 19-of-23 reserve stop', async () => {
      model.ggufMetadata!.attention_sliding_window = 2048;
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
      const { maxProbes: _omitted, ...withoutProbeLimit } = baseConfig;

      const report = await settleCalibration(
        manager.calibrate({
          ...withoutProbeLimit,
          profiles: [
            { contextSize: 8192, parallelRequests: 2 },
            { contextSize: 12_288, parallelRequests: 2 },
          ],
          workloads: [
            {
              id: 'shared',
              kind: 'shared-prefix',
              sharedPrefix: 'prefix',
              suffixes: ['prime', 'measured'],
              nPredict: 1,
            },
          ],
          includeKvCacheComparison: true,
          maxWallTimeMs: 100_000_000,
        })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.budget.maxProbes).toBeUndefined();
      expect(report.probes.length).toBeGreaterThan(19);
      expect(report.status).not.toBe('probe-limited');
    });

    it('uses the real deadline without reserving a validation cycle', async () => {
      const progress: LlamaCalibrationProgress[] = [];
      executor.mockImplementation(async (options) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * 60_000));
        const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
        return gpuLayers >= 7
          ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
          : observation(options, { scoreMs: 100 - gpuLayers });
      });
      const { maxProbes: _omitted, ...withoutProbeLimit } = baseConfig;

      const report = await settleCalibration(
        manager.calibrate({
          ...withoutProbeLimit,
          maxWallTimeMs: 30 * 60_000,
          onProgress: (value) => progress.push(value),
        }),
        5 * 60_000,
        12
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report).toMatchObject({
        status: 'time-limited',
        searchCompleteness: 'partial',
        selectionEvidence: 'single-search-launch',
        budget: {
          maxWallTimeMs: 30 * 60_000,
        },
      });
      expect(report.selected?.startConfig.gpuLayers).toBeGreaterThanOrEqual(0);
      expect(executor).toHaveBeenCalled();
      expect(progress.at(-1)).toMatchObject({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus: 'time-limited',
      });
    });

    it('re-arms wall times above the Node timer range instead of expiring early', async () => {
      const maxWallTimeMs = 2_147_483_647 + 1_000_000;
      let workSignal: AbortSignal | undefined;
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((resolve) => {
            workSignal = options.signal;
            options.signal?.addEventListener(
              'abort',
              () => resolve(observation(options, { scoreMs: 100 })),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({ ...baseConfig, maxWallTimeMs });
      await waitForExecutorCall(executor);
      await jest.advanceTimersByTimeAsync(2_147_483_647);
      expect(workSignal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(1_000_000);
      const report = await settleCalibration(pending);
      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('time-limited');
      expect(report.budget.maxWallTimeMs).toBe(maxWallTimeMs);
    });

    it('returns an inconclusive manager report when multi-profile preflight remains incomplete', async () => {
      const progress: LlamaCalibrationProgress[] = [];
      executor.mockImplementation(async (options) =>
        observation(options, { scoreMs: 100, preflight: false })
      );

      const report = await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          profiles: [
            { contextSize: 8192, parallelRequests: 2 },
            { contextSize: 12_288, parallelRequests: 2 },
          ],
          fixedConfig: { gpuLayers: 0 },
          onProgress: (value) => progress.push(value),
        })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report).toMatchObject({
        status: 'inconclusive',
        searchCompleteness: 'partial',
        selectionEvidence: 'independent-reproduction',
        terminalReason: expect.stringContaining('preflight'),
      });
      expect(report.selected).toBeDefined();
      expect(executor).toHaveBeenCalledTimes(2);
      expect(progress.at(-1)).toMatchObject({
        strategy: 'adaptive',
        phase: 'done',
        terminalStatus: 'inconclusive',
      });
    });

    it('floors the derived adaptive completion cap to an integer', async () => {
      // Observed request times are fractional, and the cap is derived from them.
      // AbortSignal.timeout() rejects a non-integer delay, which surfaced live as
      // a spurious `error` on a healthy probe. Scripted timings are normally
      // whole numbers, so without a fractional score here the floor is a no-op
      // and the guard is untested.
      const caps: number[] = [];
      executor.mockImplementation(async (options) => {
        caps.push(options.completionTimeoutMs);
        return observation(options, { scoreMs: 12_345.678_9 });
      });

      await settleCalibration(manager.calibrate(baseConfig));

      // The first probe has no comparable reference and uses the caller timeout;
      // later probes derive their cap from the fractional observation above.
      const derived = caps.filter((cap) => cap !== baseConfig.startupTimeoutMs);
      expect(derived.length).toBeGreaterThan(0);
      for (const cap of caps) {
        expect(Number.isInteger(cap)).toBe(true);
      }
    });

    it('does not deny probes using configured-duration estimates', async () => {
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({
          ...baseConfig,
          maxWallTimeMs: 400_000,
        })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.warnings).toEqual([]);
      expect(executor).toHaveBeenCalled();
      expect(report.probes.length).toBeGreaterThan(1);
      expect(report.probes[0]).toMatchObject({ purpose: 'reference', probeIndex: 0 });
      expect(report.budget).toMatchObject({
        maxWallTimeMs: 400_000,
        overrunMs: 0,
      });
      expect(report.budget).not.toHaveProperty('durationEstimation');
    });

    it('uses the fixed 60-minute default without a cell-count warning', async () => {
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
      const {
        maxWallTimeMs: _omittedWall,
        maxProbes: _omittedProbes,
        ...withoutBudgetOverrides
      } = baseConfig;
      const report = await settleCalibration(
        manager.calibrate({
          ...withoutBudgetOverrides,
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
      expect(report.budget.maxWallTimeMs).toBe(3_600_000);
      expect(report.budget.maxProbes).toBeUndefined();
      expect(report.warnings).toEqual([]);
    });

    it('disables both metrics after unusable baseline telemetry and still selects a winner', async () => {
      // Fewer than two trusted baseline samples per metric disables that metric for the whole run
      // with a warning. A disabled metric can never trigger anything, so calibration proceeds - it
      // must not manufacture a drift decision out of absent telemetry.
      scriptSnapshots({
        0: { host: 'untrusted', vram: 'untrusted' },
        1: { host: 'untrusted', vram: 'untrusted' },
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.selected).toBeDefined();
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Resource metric hostMemory is disabled for this calibration run'
          ),
          expect.stringContaining('Resource metric vram is disabled for this calibration run'),
        ])
      );
      // Schema v3 states the loss once, as coverage, instead of manufacturing a per-probe
      // resource conclusion: both metrics are disabled and no boundary was ever evaluated.
      expect(report.resourceMonitoring).toMatchObject({
        coverage: 'unavailable',
        enabledMetrics: [],
      });
      expect(report.resourceMonitoring.metrics.map((metric) => metric.enabled)).toEqual([
        false,
        false,
      ]);
      expect(
        report.probes.every(
          (probe) => probe.resourceValidity === 'accepted' && probe.resourceBoundaries === undefined
        )
      ).toBe(true);
    });

    it('bounds every telemetry read and keeps the other metric usable when one source fails', async () => {
      // Only VRAM is unreadable here. Trust is per metric, so host memory stays guarded and the
      // report says exactly which half of the coverage was lost.
      scriptSnapshots({});
      getGPUInfo.mockImplementation(async () => ({
        ...capabilities.gpu,
        vramAvailable: undefined,
      }));
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Resource metric vram is disabled for this calibration run'),
        ])
      );
      expect(report.warnings).not.toEqual(
        expect.arrayContaining([expect.stringContaining('Resource metric hostMemory is disabled')])
      );
      // Partial coverage is explicit, and the surviving metric keeps a real fixed baseline that
      // every probe boundary was compared against.
      expect(report.resourceMonitoring.coverage).toBe('partial');
      expect(report.resourceMonitoring.enabledMetrics).toEqual(['hostMemory']);
      const hostMonitoring = report.resourceMonitoring.metrics.find(
        (metric) => metric.metric === 'hostMemory'
      );
      expect(hostMonitoring?.enabled).toBe(true);
      expect(hostMonitoring?.baselineBytes).toBeGreaterThan(0);
      expect(hostMonitoring?.decreaseThresholdPct).toBe(
        LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct
      );
      expect(hostMonitoring?.increaseThresholdPct).toBe(
        LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct
      );
      expect(
        report.probes.every((probe) => {
          const host = probe.resourceBoundaries?.postCleanup?.initial.readings.find(
            (reading) => reading.metric === 'hostMemory'
          );
          const vram = probe.resourceBoundaries?.postCleanup?.initial.readings.find(
            (reading) => reading.metric === 'vram'
          );
          return (
            probe.resourceBoundaries?.preLaunch?.boundary === 'pre-launch' &&
            host?.enabled === true &&
            host.trusted === true &&
            typeof host.availableBytes === 'number' &&
            typeof host.decreasePctFromBaseline === 'number' &&
            vram?.enabled === false
          );
        })
      ).toBe(true);
      // Every platform read is bounded and carries the caller's signal, so a hung command can
      // neither stall the run nor leak a child process.
      for (const [options] of getGPUInfo.mock.calls as [
        { timeoutMs?: number; signal?: AbortSignal } | undefined,
      ][]) {
        expect(options?.timeoutMs).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs);
      }
      for (const [options] of refreshMemoryTelemetry.mock.calls as [
        { timeoutMs?: number } | undefined,
      ][]) {
        expect(options?.timeoutMs).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs);
      }
    });

    it('refreshes host telemetry before every single host reading', async () => {
      // Baseline and boundary samples must share one measurement regime. Without a refresh in
      // front of each read the Windows standby-aware TTL expires mid-run and later snapshots
      // silently drop to os.freemem(), which excludes reclaimable standby pages. Counts alone
      // would pass vacuously if host telemetry were dropped, so interleave the call order.
      scriptSnapshots({});
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      await settleCalibration(manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } }));

      const refreshOrder = refreshMemoryTelemetry.mock.invocationCallOrder;
      const snapshotOrder = getMemoryInfo.mock.invocationCallOrder;
      expect(snapshotOrder.length).toBeGreaterThan(0);
      expect(refreshOrder.length).toBe(snapshotOrder.length);
      for (const [index, snapshotAt] of snapshotOrder.entries()) {
        expect(refreshOrder[index]).toBeLessThan(snapshotAt);
      }
    });

    it.each([
      [
        'a confirmed host decrease',
        { 3: { host: 17_000 }, 4: { host: 17_000 } },
        { metrics: ['hostMemory'], directions: { hostMemory: 'decrease' } },
      ],
      [
        'a confirmed VRAM decrease',
        { 3: { vram: 6_000 }, 4: { vram: 6_000 } },
        { metrics: ['vram'], directions: { vram: 'decrease' } },
      ],
      [
        'a confirmed host increase',
        { 3: { host: 25_000 }, 4: { host: 25_000 } },
        { metrics: ['hostMemory'], directions: { hostMemory: 'increase' } },
      ],
      [
        'a confirmed VRAM increase',
        { 3: { vram: 7_800 }, 4: { vram: 7_800 } },
        { metrics: ['vram'], directions: { vram: 'increase' } },
      ],
    ] as const)(
      'rejects %s at the pre-launch boundary without spending a launch',
      async (_label, overrides, expected) => {
        scriptSnapshots(overrides);
        executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
        const progress: LlamaCalibrationProgress[] = [];

        const error = (await captureRejection(
          manager.calibrate({ ...baseConfig, onProgress: (value) => progress.push(value) })
        )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

        expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
        expect(error).toBeInstanceOf(ServerError);
        expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
        expect(error.details.suggestion).toEqual(expect.stringContaining('Close other'));
        // Confirmation is telemetry only: no server was ever launched for this boundary.
        expect(executor).not.toHaveBeenCalled();
        const partial = error.details.partialReport;
        expect(partial).toMatchObject({
          strategy: 'adaptive',
          status: 'failed',
          probes: [],
          cleanupConfirmed: true,
        });
        expect(partial.resourceFailure).toMatchObject({
          boundary: 'pre-launch',
          affectedMetrics: expected.metrics,
          affectedDirections: expected.directions,
        });
        // A pre-launch failure has no probe by construction.
        expect(partial.resourceFailure.probeIndex).toBeUndefined();
        expect(partial.resourceFailure.diagnostics.confirmationPerformed).toBe(true);
        expect(partial.resourceFailure.diagnostics.confirmation).toBeDefined();
        expect(partial.bestKnown).toBeUndefined();
        const terminals = progress.filter((value) => value.phase === 'done');
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({ terminalStatus: 'failed' });
      }
    );

    it('admits a suspicious pre-launch reading that recovers on its confirmation', async () => {
      // One transient dip must not cost a run: the confirmation is a cheap telemetry read, and a
      // recovered boundary proceeds to launch normally.
      scriptSnapshots({ 3: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.selected).toBeDefined();
      expect(executor).toHaveBeenCalled();
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
    });

    it('fails stability verification when the suspicious metric recovers but another crosses', async () => {
      // Host recovers while VRAM becomes newly suspicious: nothing is independently confirmed, and
      // the guard refuses to loop for a third opinion.
      scriptSnapshots({ 3: { host: 17_000 }, 4: { vram: 6_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_STABILITY_UNVERIFIED');
      expect(error.details.partialReport.resourceFailure.affectedMetrics).toEqual(['vram']);
      expect(executor).not.toHaveBeenCalled();
    });

    it('never manufactures drift from an isolated untrusted reading', async () => {
      // The boundary reading is untrusted but no trusted reading was ever suspicious, so the
      // boundary is admitted with a warning rather than rejected.
      scriptSnapshots({ 3: { host: 'untrusted' } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('cannot indicate resource drift on its own'),
        ])
      );
    });

    it('quarantines a final-probe post-cleanup drift and commits none of its staged state', async () => {
      // The 5-probe boundary trace reaches an ordinary full-fidelity finalist launch. Its
      // post-cleanup
      // boundary drifts, so that observation must reach neither the verified-profile cache, the
      // prompt token-count cache, nor the policy - only the chronological trail, marked invalid.
      // Snapshot ordinals: 0-2 baseline, then pre/post per probe; probe 4's post read is 12.
      scriptSnapshots({ 12: { host: 17_000 }, 13: { host: 17_000 } });
      // Two workload ids make the token cache discriminating: only the drifted final probe ever
      // reports a count for `late`, so that id can appear in the cache the manager hands its
      // executor only if the quarantined observation was committed after all. With a single id the
      // cache is already full before the final probe and its size cannot tell the two cases apart.
      const workloads = [
        { ...workload, weight: 1 },
        { ...workload, id: 'late', weight: 1 },
      ] as const;
      const tokenCacheKeys: string[][] = [];
      /** The manager's live cache: it is passed by reference, so it stays readable after the throw. */
      let liveTokenCache: ReadonlyMap<string, readonly number[]> | undefined;
      executor.mockImplementation(async (options) => {
        liveTokenCache ??= options.cachedPromptTokenCounts;
        tokenCacheKeys.push([...(options.cachedPromptTokenCounts?.keys() ?? [])]);
        const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
        const scripted =
          gpuLayers >= 7
            ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
            : observation(options, { scoreMs: 100 - gpuLayers });
        if (scripted.promptTokenCounts.size === 0) return scripted;
        return {
          ...scripted,
          promptTokenCounts:
            options.purpose === 'finalist'
              ? new Map<string, readonly number[]>([
                  ['cold', [10]],
                  ['late', [11]],
                ])
              : new Map<string, readonly number[]>([['cold', [10]]]),
        };
      });
      const progress: LlamaCalibrationProgress[] = [];

      const error = (await captureRejection(
        manager.calibrate({
          ...baseConfig,
          workloads,
          onProgress: (value) => progress.push(value),
        })
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({
        boundary: 'post-cleanup',
        affectedMetrics: ['hostMemory'],
        affectedDirections: { hostMemory: 'decrease' },
        probeIndex: 4,
      });
      expect(partial.probes).toHaveLength(5);
      // Exactly one invalidated probe is appended, and it keeps its original operational outcome.
      const invalidated = partial.probes.filter(
        (probe) => probe.resourceValidity === 'invalidated-by-resource-stability'
      );
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]).toMatchObject({
        probeIndex: 4,
        operationalStatus: 'ok',
        boundaryDecision: {
          classification: 'ambiguous',
          reason: 'invalidated-by-resource-stability',
        },
      });
      expect(
        partial.probes.slice(0, 4).every((probe) => probe.resourceValidity === 'accepted')
      ).toBe(true);
      // The search stopped at the invalidated launch: no further probe was scheduled from it.
      expect(executor).toHaveBeenCalledTimes(5);
      expect(executor.mock.calls.at(-1)![0].purpose).toBe('finalist');
      expect(progress.filter((value) => value.phase === 'done')).toEqual([
        expect.objectContaining({ terminalStatus: 'failed' }),
      ]);
      expect(JSON.stringify(partial)).not.toContain(workload.prompt);
      // Token-count cache: `late` was offered exclusively by the quarantined probe, so its absence
      // after the rejection is direct evidence that nothing from that observation was committed.
      expect(tokenCacheKeys).toEqual([[], ['cold'], ['cold'], ['cold'], ['cold']]);
      expect(liveTokenCache).toBeDefined();
      expect([...liveTokenCache!.keys()]).toEqual(['cold']);
      // Policy: the invalidated observation was never handed to it. Four accepted probes were.
      expect(applyAdaptivePolicyObservation).toHaveBeenCalledTimes(4);
      expect(
        applyAdaptivePolicyObservation.mock.calls.map(([, applied]) => applied.purpose)
      ).toEqual(['reference', 'ceiling', 'boundary', 'boundary']);
      // Verified profiles: this map is read only while the final report is built, so a rejected run
      // exposes no public observable for it - the residual gap here. What is observable is that the
      // quarantined probe did carry the capacity readings that would have been staged, and that the
      // commit is unreachable: the verified-profile write, the token-cache write, and the policy
      // call sit in one straight-line block after the same early `throw`, so the two assertions
      // above cover the third by construction.
      expect(invalidated[0]).toMatchObject({
        effectiveContextSize: 4096,
        effectiveParallelRequests: 2,
      });
    });

    it('reports a start-ready bestKnown result built solely from reproduced clean probes', async () => {
      // The first fixed-placement profile is cleanly reproduced by probes 0-1. Probe 2 starts the
      // second profile and is invalidated after cleanup, leaving the earlier candidate diagnostic.
      scriptSnapshots({ 8: { host: 17_000 }, 9: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate({
          ...baseConfig,
          profiles: [
            { contextSize: 8192, parallelRequests: 2 },
            { contextSize: 12_288, parallelRequests: 2 },
          ],
          fixedConfig: { gpuLayers: 0 },
        })
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      const partial = error.details.partialReport;
      if (partial.strategy !== 'adaptive') throw new Error('expected adaptive partial');
      const bestKnown = partial.bestKnown;
      expect(bestKnown).toBeDefined();
      expect(bestKnown!.evidence).toBe('independent-reproduction');
      expect(bestKnown!.recommendation.startConfig).toMatchObject({
        contextSize: 8192,
        parallelRequests: 2,
        gpuLayers: 0,
      });
      const indexes = bestKnown!.sourceProbeIndexes;
      // `independent-reproduction` is a claim about more than one launch, so a single cited probe
      // would contradict the evidence level the candidate advertises.
      expect(indexes.length).toBeGreaterThanOrEqual(2);
      expect(new Set(indexes).size).toBe(indexes.length);
      expect([...indexes].sort((left, right) => left - right)).toEqual([...indexes]);
      for (const index of indexes) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(partial.probes.length);
        // Only accepted clean probes may be cited.
        expect(partial.probes[index]!.resourceValidity).toBe('accepted');
      }
      expect(Object.keys(bestKnown!).sort()).toEqual([
        'evidence',
        'recommendation',
        'sourceProbeIndexes',
      ]);
    });

    it('omits bestKnown when no clean point exists yet', async () => {
      // The very first probe's post-cleanup boundary drifts, so no clean evidence was ever
      // committed. A single launch is never promoted merely because the run ended.
      scriptSnapshots({ 4: { vram: 6_000 }, 5: { vram: 6_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({ boundary: 'post-cleanup', probeIndex: 0 });
      expect(partial.probes).toHaveLength(1);
      expect(partial.bestKnown).toBeUndefined();
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('quarantines a probe whose post-cleanup boundary confirms a host increase', async () => {
      // The upward band is guarded on the post-cleanup side too: a large release right after a
      // probe means the machine that produced the measurement is not the machine that was
      // baselined, so the observation is invalidated exactly as a decrease would be.
      scriptSnapshots({ 4: { host: 25_000 }, 5: { host: 25_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
      const progress: LlamaCalibrationProgress[] = [];

      const error = (await captureRejection(
        manager.calibrate({ ...baseConfig, onProgress: (value) => progress.push(value) })
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({
        boundary: 'post-cleanup',
        affectedMetrics: ['hostMemory'],
        affectedDirections: { hostMemory: 'increase' },
        probeIndex: 0,
      });
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]).toMatchObject({
        probeIndex: 0,
        operationalStatus: 'ok',
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'invalidated-by-resource-stability',
      });
      // The increase is recorded as a negative signed change, never as a decrease.
      const reading = partial.resourceFailure.diagnostics.initial.readings.find(
        (entry) => entry.metric === 'hostMemory'
      );
      expect(reading).toMatchObject({ suspicious: true, suspiciousDirection: 'increase' });
      expect(reading?.decreasePctFromBaseline).toBeCloseTo(-25, 6);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(progress.filter((value) => value.phase === 'done')).toEqual([
        expect.objectContaining({ terminalStatus: 'failed' }),
      ]);
    });

    it('tolerates a sub-threshold decrease and a sub-band increase without confirming', async () => {
      // 9% down and 15% up on a 20,000-byte host baseline, and 8.6% up on a 7,000-byte VRAM
      // baseline: every reading is strictly inside its band, so no confirmation is scheduled and
      // the adaptive search runs to a normal completion.
      const snapshots = scriptSnapshots({
        3: { host: 18_200 },
        4: { host: 23_000 },
        5: { vram: 7_600 },
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.selected).toBeDefined();
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
      // Three baseline reads plus one pre-launch and one post-cleanup read per probe, and nothing
      // else: a confirmation would show up here as an extra read.
      expect(snapshots.snapshotCount()).toBe(3 + 2 * report.probes.length);
      const boundaries = report.probes.flatMap((probe) => [
        probe.resourceBoundaries?.preLaunch,
        probe.resourceBoundaries?.postCleanup,
      ]);
      expect(boundaries.every((boundary) => boundary?.confirmationPerformed === false)).toBe(true);
      expect(boundaries.every((boundary) => boundary?.confirmation === undefined)).toBe(true);
      const readings = boundaries.flatMap((boundary) => boundary?.initial.readings ?? []);
      expect(readings.every((reading) => reading.suspicious === false)).toBe(true);
      // The tolerated increase is recorded as a negative signed change, never as a decrease.
      const increase = report.probes[0]!.resourceBoundaries?.postCleanup?.initial.readings.find(
        (reading) => reading.metric === 'hostMemory'
      );
      expect(increase?.decreasePctFromBaseline).toBeCloseTo(-15, 6);
    });

    it('lets a confirmed metric decide while the other metric confirmation is untrusted', async () => {
      // Both metrics are suspicious initially; the confirmation independently confirms host memory
      // while VRAM's reading becomes untrusted. Confirmed drift takes precedence, the untrusted
      // metric is recorded and warned about, and it never joins the affected set.
      scriptSnapshots({
        3: { host: 17_000, vram: 6_000 },
        4: { host: 17_000, vram: 'untrusted' },
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({
        boundary: 'pre-launch',
        affectedMetrics: ['hostMemory'],
        affectedDirections: { hostMemory: 'decrease' },
      });
      expect(partial.resourceFailure.diagnostics.initiallySuspiciousMetrics).toEqual([
        'hostMemory',
        'vram',
      ]);
      const confirmedVram = partial.resourceFailure.diagnostics.confirmation?.readings.find(
        (reading) => reading.metric === 'vram'
      );
      expect(confirmedVram).toMatchObject({ enabled: true, trusted: false });
      expect(confirmedVram?.availableBytes).toBeUndefined();
      expect(partial.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Resource metric vram was suspicious at the pre-launch boundary and its confirmation reading was untrusted'
          ),
        ])
      );
      expect(executor).not.toHaveBeenCalled();
    });

    it('admits a probe whose suspicious post-cleanup reading recovers on confirmation', async () => {
      scriptSnapshots({ 4: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
    });

    it('keeps unconfirmed cleanup fatal ahead of a coincident resource failure', async () => {
      // Precedence: possible process orphaning must never be hidden behind a drift error, so the
      // guard is not even consulted for an unconfirmed teardown.
      const snapshots = scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockRejectedValue(
        new ServerError('Probe cleanup failed', {
          code: 'CALIBRATION_CLEANUP_FAILED',
          pid: 4321,
          cleanup: { confirmed: false, durationMs: 2_000, pid: 4321 },
        })
      );

      const rejection = await captureRejection(manager.calibrate(baseConfig));

      expect(rejection).not.toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(rejection.details?.code).toBe('CALIBRATION_CLEANUP_FAILED');
      expect(rejection.details?.partialReport).toMatchObject({
        status: 'failed',
        cleanupConfirmed: false,
      });
      // Three baseline reads plus one pre-launch read: the drift scripted at ordinals 4/5 is never
      // read at all, which is what proves the guard was not consulted after the unconfirmed
      // teardown rather than merely outranked by it.
      expect(snapshots.snapshotCount()).toBe(4);
    });

    it('supersedes a fatal probe outcome when its confirmed cleanup is followed by drift', async () => {
      // With cleanup confirmed the probe's own failure is no longer interpretable, so the resource
      // failure wins - but the original failure survives inside the invalidated probe record.
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockImplementation(async (options) => {
        const failed = observation(options, { status: 'error', preflight: false });
        throw new ServerError('Workload exceeds verified capacity', {
          code: 'CALIBRATION_INVALID_CONFIG',
          probeObservation: failed,
        });
      });

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]).toMatchObject({
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'CALIBRATION_INVALID_CONFIG',
        operationalStatus: 'error',
      });
    });

    it('preserves the typed error identity, narrowing, and redaction through the adaptive outer catch', async () => {
      // The final caller boundary is `calibrate()`, whose outer catch re-sanitizes everything it
      // rethrows. It must not rebuild this as a base ServerError: hosts branch on the class and
      // then switch on the typed details code.
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error).toBeInstanceOf(ServerError);
      expect(error.name).toBe('LlamaCalibrationResourceStabilityError');
      // Both arms of the discriminated details union are reachable from one `instanceof` branch.
      const narrowed: string =
        error.details.code === 'CALIBRATION_RESOURCE_DRIFT'
          ? `drift:${error.details.partialReport.resourceFailure.boundary}`
          : `unverified:${error.details.partialReport.resourceFailure.boundary}`;
      expect(narrowed).toBe('drift:post-cleanup');
      const partial = error.details.partialReport;
      expect(partial.schemaVersion).toBe(4);
      expect(partial.policyVersion).toBe('llama-runtime-v4');
      expect(partial.resourceMonitoring).toMatchObject({
        coverage: 'complete',
        enabledMetrics: ['hostMemory', 'vram'],
      });
      // Boundary percentages in the failure are only meaningful against the run's fixed baseline,
      // so the partial report carries that baseline with them.
      for (const metric of partial.resourceMonitoring.metrics) {
        expect(metric.baselineBytes).toBeGreaterThan(0);
        expect(metric.trustedSamples.length).toBeGreaterThanOrEqual(2);
        expect(metric.attempts).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples);
      }
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
    });

    it('rejects a caller abort raised during baseline collection as an abort, not drift', async () => {
      const controller = new AbortController();
      scriptSnapshots({});
      refreshMemoryTelemetry.mockImplementation(async () => {
        controller.abort(`stop ${workload.prompt}`);
        return 'refreshed';
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = await captureRejection(
        manager.calibrate({ ...baseConfig, signal: controller.signal })
      );

      expect(error).not.toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
      expect(executor).not.toHaveBeenCalled();
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
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

    it('returns preparation-time-limit after owned preparation settles and publishes after unlock', async () => {
      const initializeLogManager = (
        manager as unknown as { initializeLogManager: jest.Mock<() => Promise<void>> }
      ).initializeLogManager;
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      let unlockedAtTerminal = false;
      let terminalElapsedMs: number | undefined;
      initializeLogManager.mockImplementationOnce(
        async () => new Promise<void>((resolve) => setTimeout(resolve, 100))
      );

      const pending = manager.calibrate({
        ...baseConfig,
        maxWallTimeMs: 50,
        onProgress: (value) => {
          if (value.phase === 'done') {
            unlockedAtTerminal = !manager.isCalibrating();
            terminalElapsedMs = value.elapsedMs;
          }
        },
      });
      await jest.advanceTimersByTimeAsync(100);
      const report = await settleCalibration(pending);

      expect(report).toMatchObject({
        resultKind: 'preparation-time-limit',
        strategy: 'adaptive',
        phase: 'preparing',
        status: 'time-limited',
        probes: [],
        cleanupConfirmed: true,
        budget: { maxWallTimeMs: 50 },
      });
      if (report.resultKind !== 'preparation-time-limit') {
        throw new Error('expected preparation-time-limit');
      }
      expect(report.budget.elapsedMs).toBeGreaterThanOrEqual(100);
      expect(report.budget.overrunMs).toBe(report.budget.elapsedMs - 50);
      expect(terminalElapsedMs).toBe(report.budget.elapsedMs);
      expect(ensureBinary).not.toHaveBeenCalled();
      expect(unlockedAtTerminal).toBe(true);
    });

    it('counts the orphan precondition wait against the method-entry deadline', async () => {
      const assertNoCalibrationOrphan = jest.fn(
        async () => new Promise<void>((resolve) => setTimeout(resolve, 100))
      );
      (
        manager as unknown as { assertNoCalibrationOrphan: jest.Mock<() => Promise<void>> }
      ).assertNoCalibrationOrphan = assertNoCalibrationOrphan;
      const ensureBinary = (
        manager as unknown as { ensureBinary: jest.Mock<() => Promise<string>> }
      ).ensureBinary;
      const pending = manager.calibrate({ ...baseConfig, maxWallTimeMs: 50 });
      await jest.advanceTimersByTimeAsync(100);
      const report = await settleCalibration(pending);

      expect(report).toMatchObject({
        resultKind: 'preparation-time-limit',
        status: 'time-limited',
        budget: { maxWallTimeMs: 50 },
      });
      if (report.resultKind !== 'preparation-time-limit') {
        throw new Error('expected preparation-time-limit');
      }
      expect(report.budget.elapsedMs).toBeGreaterThanOrEqual(100);
      expect(ensureBinary).not.toHaveBeenCalled();
    });

    it('signals binary provisioning at the deadline and returns preparation-time-limit', async () => {
      const ensureBinary = (
        manager as unknown as {
          ensureBinary: jest.Mock<
            (modelPath?: string, forceValidation?: boolean, signal?: AbortSignal) => Promise<string>
          >;
        }
      ).ensureBinary;
      let provisioningSignal: AbortSignal | undefined;
      ensureBinary.mockImplementationOnce(async (_modelPath, _forceValidation, signal) => {
        provisioningSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const pending = manager.calibrate({ ...baseConfig, maxWallTimeMs: 1_000 });
      for (let turn = 0; turn < 20 && ensureBinary.mock.calls.length === 0; turn++) {
        await jest.advanceTimersByTimeAsync(10);
      }
      expect(ensureBinary).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      const report = await settleCalibration(pending);

      expect(provisioningSignal?.aborted).toBe(true);
      expect(report).toMatchObject({
        resultKind: 'preparation-time-limit',
        status: 'time-limited',
        probes: [],
      });
      expect(executor).not.toHaveBeenCalled();
    });

    it('keeps caller abort exceptional when it coincides with the preparation deadline', async () => {
      const controller = new AbortController();
      const ensureBinary = (
        manager as unknown as {
          ensureBinary: jest.Mock<
            (modelPath?: string, forceValidation?: boolean, signal?: AbortSignal) => Promise<string>
          >;
        }
      ).ensureBinary;
      ensureBinary.mockImplementationOnce(async (_modelPath, _forceValidation, signal) => {
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              controller.abort('caller stop at deadline');
              reject(signal.reason);
            },
            { once: true }
          );
        });
      });

      const pending = manager.calibrate({
        ...baseConfig,
        maxWallTimeMs: 1_000,
        signal: controller.signal,
      });
      await waitForExecutorCall(ensureBinary);
      await jest.advanceTimersByTimeAsync(1_000);
      const error = await captureRejection(pending);

      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
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
      expect(progress.at(-1)!.overallPercent).toBeGreaterThanOrEqual(0);
      expect(progress.at(-1)!.overallPercent).toBeLessThan(100);
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
    });

    it('never commits an executor result that resolves normally on caller abort', async () => {
      const controller = new AbortController();
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((resolve) => {
            options.onProgress?.({ phase: 'starting' });
            options.signal?.addEventListener(
              'abort',
              () => resolve(observation(options, { scoreMs: 80 })),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({ ...baseConfig, signal: controller.signal });
      await waitForExecutorCall(executor);
      controller.abort('caller stop');
      const error = await captureRejection(pending);

      expect(error.details).toMatchObject({
        code: 'CALIBRATION_ABORTED',
        partialReport: {
          strategy: 'adaptive',
          status: 'aborted',
          probes: [
            expect.objectContaining({
              terminationReason: 'caller-abort',
              boundaryDecision: { classification: 'ambiguous', reason: 'caller-abort' },
            }),
          ],
        },
      });
      expect(applyAdaptivePolicyObservation).not.toHaveBeenCalled();
    });

    it('maps an active internal deadline to a trailed time-limited result, never caller abort', async () => {
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
      expect(report.status).toBe('time-limited');
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
        terminalStatus: 'time-limited',
      });
      expect(
        progress.some((value) => value.phase === 'done' && value.terminalStatus === 'aborted')
      ).toBe(false);
      expect(JSON.stringify(report)).not.toContain(workload.prompt);
    });

    it('quarantines a normally resolved deadline probe and preserves the prior clean incumbent', async () => {
      executor.mockImplementation(async (options) => {
        if (executor.mock.calls.length === 1) {
          return observation(options, { scoreMs: 100 });
        }
        return new Promise<RunCalibrationProbeObservation>((resolve) => {
          options.onProgress?.({ phase: 'starting' });
          options.signal?.addEventListener(
            'abort',
            () => resolve(observation(options, { scoreMs: 80 })),
            { once: true }
          );
        });
      });

      const pending = manager.calibrate({
        ...baseConfig,
        maxWallTimeMs: 2_000_000,
      });
      await waitForExecutorCall(executor, 2);
      await jest.advanceTimersByTimeAsync(2_000_001);
      const report = await settleCalibration(pending);

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report).toMatchObject({
        status: 'time-limited',
        searchCompleteness: 'partial',
        selectionEvidence: 'single-search-launch',
        selected: { scoreMs: 100 },
      });
      expect(report.probes).toHaveLength(2);
      expect(report.probes[1]).toMatchObject({
        operationalStatus: 'ok',
        scoreMs: 80,
        terminationReason: 'internal-deadline',
        boundaryDecision: { classification: 'ambiguous', reason: 'internal-deadline' },
        resourceValidity: 'accepted',
      });
      expect(report.selected?.scoreMs).not.toBe(80);
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

    it('bounds a hung GPU telemetry command instead of stalling the run', async () => {
      // The guard hands every platform read the configured bound rather than racing a bare
      // promise, which would leave the child process running. A command that honours that bound
      // and gives up simply disables its metric; the run itself stays bounded and completes.
      scriptSnapshots({});
      getGPUInfo.mockImplementation(
        (options: { timeoutMs?: number } | undefined) =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('GPU telemetry command timed out')),
              options?.timeoutMs ?? 10_000
            );
          })
      );
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Resource metric vram is disabled for this calibration run'),
        ])
      );
      expect(executor).toHaveBeenCalled();
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

    it('tolerates a decrease just under the threshold without paying for a confirmation', async () => {
      // 9% of the 20,000-byte baseline: strictly inside the 10% band, so the boundary is admitted
      // from its single read. (The inclusive at-threshold case is pinned in the guard's own suite.)
      const snapshots = scriptSnapshots({ 3: { host: 18_200 }, 4: { host: 18_200 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
      // Three baseline attempts plus exactly one pre-launch and one post-cleanup read per probe:
      // a sub-threshold reading never enters the confirmation schedule.
      expect(snapshots.snapshotCount()).toBe(3 + 2 * report.probes.length);
      const boundaries = report.probes.flatMap((probe) => [
        probe.resourceBoundaries?.preLaunch,
        probe.resourceBoundaries?.postCleanup,
      ]);
      expect(boundaries.every((boundary) => boundary?.confirmationPerformed === false)).toBe(true);
      expect(boundaries.every((boundary) => boundary?.confirmation === undefined)).toBe(true);
      const host = report.probes[0]!.resourceBoundaries?.preLaunch?.initial.readings.find(
        (reading) => reading.metric === 'hostMemory'
      );
      expect(host).toMatchObject({ enabled: true, trusted: true, suspicious: false });
      expect(host?.decreasePctFromBaseline).toBeCloseTo(9, 6);
      expect(host?.suspiciousDirection).toBeUndefined();
    });

    it.each([
      ['host memory', { 3: { host: 0 }, 4: { host: 0 } }, 'hostMemory'],
      ['VRAM', { 3: { vram: 0 }, 4: { vram: 0 } }, 'vram'],
    ] as const)(
      'rejects a confirmed zero-byte %s reading as the most severe valid decrease',
      async (_label, overrides, metric) => {
        // Zero available bytes is a real, maximally severe reading - never "telemetry missing" -
        // so it must be trusted, compared, confirmed, and fatal.
        scriptSnapshots(overrides);
        executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

        const error = (await captureRejection(
          manager.calibrate(baseConfig)
        )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

        expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
        const failure = error.details.partialReport.resourceFailure;
        expect(failure).toMatchObject({
          boundary: 'pre-launch',
          affectedMetrics: [metric],
          affectedDirections: { [metric]: 'decrease' },
        });
        const reading = failure.diagnostics.initial.readings.find(
          (entry) => entry.metric === metric
        );
        expect(reading).toMatchObject({ enabled: true, trusted: true, suspicious: true });
        expect(reading?.availableBytes).toBe(0);
        expect(reading?.decreasePctFromBaseline).toBe(100);
        expect(executor).not.toHaveBeenCalled();
      }
    );

    it('hard-fails on cumulative sub-threshold decreases measured from the one fixed baseline', async () => {
      // Steps of 5.0%, then 2.1%, then 3.8% against the reading before them: a guard that
      // re-anchored on each boundary would never fire. Against the ONE fixed 20,000-byte baseline
      // the third reading is a 10.5% decrease, which is the comparison that actually matters.
      scriptSnapshots({
        3: { host: 19_000 },
        4: { host: 18_600 },
        5: { host: 17_900 },
        6: { host: 17_900 },
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceFailure).toMatchObject({
        boundary: 'pre-launch',
        affectedMetrics: ['hostMemory'],
        affectedDirections: { hostMemory: 'decrease' },
      });
      // The first probe's own boundaries were admitted on one read each - each step was minor.
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]!.resourceValidity).toBe('accepted');
      expect(partial.probes[0]!.resourceBoundaries?.preLaunch?.confirmationPerformed).toBe(false);
      expect(partial.probes[0]!.resourceBoundaries?.postCleanup?.confirmationPerformed).toBe(false);
      expect(executor).toHaveBeenCalledTimes(1);
      // The baseline never moved, and the fatal percentage is measured against it rather than
      // against the 18,600 reading that immediately preceded it.
      const hostMonitoring = partial.resourceMonitoring.metrics.find(
        (entry) => entry.metric === 'hostMemory'
      );
      expect(hostMonitoring?.baselineBytes).toBe(20_000);
      const reading = partial.resourceFailure.diagnostics.initial.readings.find(
        (entry) => entry.metric === 'hostMemory'
      );
      expect(reading?.availableBytes).toBe(17_900);
      expect(reading?.decreasePctFromBaseline).toBeCloseTo(10.5, 6);
    });

    it('fails stability verification when VRAM recovers but host memory becomes newly suspicious', async () => {
      // The mirror of the host-recovers/VRAM-crosses case: nothing is independently confirmed in
      // either direction, so the boundary is unverifiable rather than confirmed drift.
      scriptSnapshots({ 3: { vram: 6_000 }, 4: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_STABILITY_UNVERIFIED');
      const failure = error.details.partialReport.resourceFailure;
      expect(failure.affectedMetrics).toEqual(['hostMemory']);
      expect(failure.diagnostics.initiallySuspiciousMetrics).toEqual(['vram']);
      // Exactly one confirmation was taken; the guard never loops for a third opinion.
      expect(failure.diagnostics.confirmationPerformed).toBe(true);
      expect(executor).not.toHaveBeenCalled();
    });

    it('fails stability verification when the suspicious metric loses telemetry in its confirmation', async () => {
      // A trusted suspicion followed by an untrusted confirmation can never be admitted, and it is
      // never mislabelled as confirmed drift either.
      scriptSnapshots({ 3: { host: 17_000 }, 4: { host: 'untrusted' } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_STABILITY_UNVERIFIED');
      const failure = error.details.partialReport.resourceFailure;
      expect(failure.affectedMetrics).toEqual(['hostMemory']);
      expect(failure.affectedDirections).toEqual({ hostMemory: 'decrease' });
      expect(failure.diagnostics.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('its confirmation reading was untrusted')])
      );
      const confirmed = failure.diagnostics.confirmation?.readings.find(
        (entry) => entry.metric === 'hostMemory'
      );
      expect(confirmed).toMatchObject({ trusted: false, suspicious: false });
      expect(confirmed?.availableBytes).toBeUndefined();
      expect(executor).not.toHaveBeenCalled();
    });

    it('confirms drift in one metric while the other is disabled for the whole run', async () => {
      // An unavailable metric must not mask its neighbour: partial coverage still rejects.
      scriptSnapshots({
        0: { vram: 'untrusted' },
        1: { vram: 'untrusted' },
        3: { host: 17_000 },
        4: { host: 17_000 },
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      expect(partial.resourceMonitoring).toMatchObject({
        coverage: 'partial',
        enabledMetrics: ['hostMemory'],
      });
      expect(partial.resourceFailure.affectedMetrics).toEqual(['hostMemory']);
      const vram = partial.resourceFailure.diagnostics.initial.readings.find(
        (entry) => entry.metric === 'vram'
      );
      expect(vram).toMatchObject({ enabled: false, suspicious: false });
      expect(executor).not.toHaveBeenCalled();
    });

    it('spends no launch or probe budget on confirmation reads', async () => {
      // Two boundaries go suspicious and recover. The whole cost is two extra telemetry reads:
      // no relaunch, no repeated probe, no budget consumption.
      const snapshots = scriptSnapshots({ 3: { host: 17_000 }, 6: { vram: 6_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.probes.length).toBeGreaterThanOrEqual(2);
      expect(executor).toHaveBeenCalledTimes(report.probes.length);
      const confirmedBoundaries = report.probes
        .flatMap((probe) => [
          probe.resourceBoundaries?.preLaunch,
          probe.resourceBoundaries?.postCleanup,
        ])
        .filter((boundary) => boundary?.confirmationPerformed === true);
      expect(confirmedBoundaries).toHaveLength(2);
      // Baseline attempts + one read per boundary + exactly one read per confirmation.
      expect(snapshots.snapshotCount()).toBe(3 + 2 * report.probes.length + 2);
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
    });

    it('quarantines confirmed-OOM memory evidence that coincides with post-cleanup drift', async () => {
      // The probe's own memory verdict is no longer interpretable once the environment moved, so
      // it must reach neither the controller nor the boundary classification - only the trail.
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockImplementation(async (options) =>
        observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
      );

      const error = (await captureRejection(
        manager.calibrate(baseConfig)
      )) as unknown as InstanceType<typeof LlamaCalibrationResourceStabilityError>;

      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      const partial = error.details.partialReport;
      // A confirmed OOM that reached the policy would have driven a descent probe; none happened.
      expect(executor).toHaveBeenCalledTimes(1);
      expect(partial.probes).toHaveLength(1);
      expect(partial.probes[0]).toMatchObject({
        operationalStatus: 'oom',
        memoryEvidence: { classification: 'confirmed' },
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'invalidated-by-resource-stability',
        boundaryDecision: {
          classification: 'ambiguous',
          reason: 'invalidated-by-resource-stability',
        },
      });
      // `unsuitable` is the classification a confirmed OOM earns from the controller; the guard
      // must have prevented that verdict from ever being computed.
      expect(partial.probes[0]!.boundaryDecision.classification).not.toBe('unsuitable');
      expect(partial.bestKnown).toBeUndefined();
    });

    it('completes the post-cleanup guard on the caller signal after the internal deadline expired', async () => {
      // Plan decision 8: once a launch begins, the bounded post-check follows the caller's signal,
      // not an expired per-probe deadline. Without it this contaminated final probe would be
      // published as an ordinary time-limited result.
      const snapshots = scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((resolve) => {
            options.onProgress?.({ phase: 'starting' });
            options.signal?.addEventListener(
              'abort',
              () => resolve(observation(options, { scoreMs: 100 })),
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({ ...baseConfig, maxWallTimeMs: 200_000 });
      await waitForExecutorCall(executor);
      await jest.advanceTimersByTimeAsync(200_001);
      const error = (await captureRejection(pending)) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      expect(error.details.partialReport.resourceFailure).toMatchObject({
        boundary: 'post-cleanup',
        probeIndex: 0,
      });
      expect(error.details.partialReport.probes[0]!.resourceValidity).toBe(
        'invalidated-by-resource-stability'
      );
      expect(error.details.partialReport.budget.elapsedMs).toBeGreaterThan(200_000);
      expect(error.details.partialReport.budget.overrunMs).toBe(
        error.details.partialReport.budget.elapsedMs - 200_000
      );
      // Baseline, pre-launch, post-cleanup, and its confirmation all happened.
      expect(snapshots.snapshotCount()).toBe(6);
    });

    it('checks post-cleanup resources for a real deadline rejection carrying settled evidence', async () => {
      scriptSnapshots({ 4: { host: 17_000 }, 5: { host: 17_000 } });
      executor.mockImplementation(
        async (options) =>
          new Promise<RunCalibrationProbeObservation>((_resolve, reject) => {
            options.onProgress?.({ phase: 'starting' });
            options.signal?.addEventListener(
              'abort',
              () => {
                reject(
                  new ServerError('Internal calibration deadline', {
                    code: 'CALIBRATION_ABORTED',
                    probeObservation: observation(options, {
                      status: 'request-timeout',
                      preflight: false,
                    }),
                  })
                );
              },
              { once: true }
            );
          })
      );

      const pending = manager.calibrate({ ...baseConfig, maxWallTimeMs: 200_000 });
      await waitForExecutorCall(executor);
      await jest.advanceTimersByTimeAsync(200_001);
      const error = (await captureRejection(pending)) as unknown as InstanceType<
        typeof LlamaCalibrationResourceStabilityError
      >;

      expect(error).toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      expect(error.details.partialReport.probes).toHaveLength(1);
      expect(error.details.partialReport.probes[0]).toMatchObject({
        probeIndex: 0,
        operationalStatus: 'request-timeout',
        resourceValidity: 'invalidated-by-resource-stability',
        terminationReason: 'internal-deadline',
        boundaryDecision: { reason: 'internal-deadline' },
        resourceBoundaries: { postCleanup: { boundary: 'post-cleanup' } },
      });
    });

    it('does not duplicate or time-limit a fatal probe when resource settlement crosses the deadline', async () => {
      scriptSnapshots();
      const refreshSnapshot = refreshMemoryTelemetry.getMockImplementation()!;
      let snapshotCount = 0;
      refreshMemoryTelemetry.mockImplementation(async () => {
        const result = await refreshSnapshot();
        snapshotCount += 1;
        if (snapshotCount === 5) jest.advanceTimersByTime(200_001);
        return result;
      });
      executor.mockImplementation(async (options) => {
        throw new ServerError('Workload exceeds verified capacity', {
          code: 'CALIBRATION_INVALID_CONFIG',
          probeObservation: observation(options, { status: 'error', preflight: false }),
        });
      });

      const error = await captureRejection(
        manager.calibrate({ ...baseConfig, maxWallTimeMs: 200_000 })
      );
      const partial = error.details?.partialReport as
        | { status?: string; probes?: Array<{ probeIndex?: number; terminationReason?: string }> }
        | undefined;

      expect(error.details?.code).toBe('CALIBRATION_INVALID_CONFIG');
      expect(partial?.status).toBe('failed');
      expect(partial?.probes).toEqual([
        expect.objectContaining({
          probeIndex: 0,
          terminationReason: 'CALIBRATION_INVALID_CONFIG',
        }),
      ]);
    });

    it('rejects a caller abort raised during the bounded confirmation as an abort, not drift', async () => {
      const controller = new AbortController();
      scriptSnapshots({ 3: { host: 17_000 } });
      let gpuReads = 0;
      getGPUInfo.mockImplementation(async () => {
        gpuReads += 1;
        // Read 5 is the pre-launch confirmation snapshot (3 baseline + 1 suspicious initial).
        if (gpuReads === 5) controller.abort(`stop ${workload.prompt}`);
        return { ...capabilities.gpu, vramAvailable: 7_000 };
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = await captureRejection(
        manager.calibrate({ ...baseConfig, signal: controller.signal })
      );

      expect(error).not.toBeInstanceOf(LlamaCalibrationResourceStabilityError);
      expect(error.details?.code).toBe('CALIBRATION_ABORTED');
      expect(gpuReads).toBe(5);
      expect(executor).not.toHaveBeenCalled();
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
        workload.prompt
      );
    });

    it('cannot manufacture drift from a telemetry command that times out during confirmation', async () => {
      // A bounded command that gives up mid-confirmation makes that reading untrusted. Since no
      // trusted reading of that metric was ever suspicious, the boundary is admitted with a
      // warning instead of being turned into a resource conclusion.
      scriptSnapshots({ 3: { host: 17_000 } });
      let gpuReads = 0;
      getGPUInfo.mockImplementation(async (options: { timeoutMs?: number } | undefined) => {
        gpuReads += 1;
        if (gpuReads === 5) {
          throw new Error(`GPU telemetry command timed out after ${options?.timeoutMs ?? 0} ms`);
        }
        return { ...capabilities.gpu, vramAvailable: 7_000 };
      });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.status).toBe('complete');
      expect(report.probes.every((probe) => probe.resourceValidity === 'accepted')).toBe(true);
      const preLaunch = report.probes[0]!.resourceBoundaries?.preLaunch;
      expect(preLaunch?.confirmationPerformed).toBe(true);
      // The lost reading is recorded verbatim, with no byte value that could be compared by
      // accident, and it neither confirms the host suspicion nor invents one of its own.
      expect(
        preLaunch?.confirmation?.readings.find((reading) => reading.metric === 'vram')
      ).toEqual({
        metric: 'vram',
        enabled: true,
        trusted: false,
        untrustedReason: 'reading-unavailable',
        decreaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
        increaseThresholdPct: LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
        suspicious: false,
      });
      expect(preLaunch?.confirmation?.suspiciousMetrics).toEqual([]);
      expect(preLaunch?.confirmation?.untrustedMetrics).toEqual(['vram']);
    });

    it('emits exactly one terminal failed payload to both the callback and the event listener', async () => {
      scriptSnapshots({ 3: { host: 17_000 }, 4: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));
      const callbackProgress: LlamaCalibrationProgress[] = [];
      const eventProgress: LlamaCalibrationProgress[] = [];
      manager.on('calibration-progress', (event) =>
        eventProgress.push(event as LlamaCalibrationProgress)
      );

      await captureRejection(
        manager.calibrate({ ...baseConfig, onProgress: (value) => callbackProgress.push(value) })
      );

      const terminal = (values: LlamaCalibrationProgress[]) =>
        values.filter((value) => value.phase === 'done');
      expect(terminal(callbackProgress)).toHaveLength(1);
      expect(terminal(callbackProgress)[0]).toMatchObject({
        strategy: 'adaptive',
        terminalStatus: 'failed',
      });
      expect(eventProgress).toEqual(callbackProgress);
      expect(callbackProgress.some((value) => value.overallPercent === 100)).toBe(false);
    });

    it('unlocks the manager after a resource-stability rejection and allows the next run', async () => {
      scriptSnapshots({ 3: { host: 17_000 }, 4: { host: 17_000 } });
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const error = await captureRejection(manager.calibrate(baseConfig));

      expect(error.details?.code).toBe('CALIBRATION_RESOURCE_DRIFT');
      expect(manager.isCalibrating()).toBe(false);
      // A rejected run leaves no lock and no orphan: recalibrating from the beginning is the
      // documented remedy, so it has to actually work.
      scriptSnapshots({});
      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );
      expect(report.status).toBe('complete');
      expect(manager.isCalibrating()).toBe(false);
    });

    it('reports schema-v4 boundaries, the fixed baseline, and protocol-only methodology', async () => {
      scriptSnapshots({});
      executor.mockImplementation(async (options) => observation(options, { scoreMs: 100 }));

      const report = await settleCalibration(
        manager.calibrate({ ...baseConfig, fixedConfig: { gpuLayers: 0 } })
      );

      if (report.strategy !== 'adaptive') throw new Error('expected adaptive report');
      expect(report.schemaVersion).toBe(4);
      expect(report.policyVersion).toBe('llama-runtime-v4');
      expect(report.resourceMonitoring.coverage).toBe('complete');
      const hostBaseline = report.resourceMonitoring.metrics.find(
        (metric) => metric.metric === 'hostMemory'
      );
      const vramBaseline = report.resourceMonitoring.metrics.find(
        (metric) => metric.metric === 'vram'
      );
      for (const metric of report.resourceMonitoring.metrics) {
        expect(metric.attempts).toBe(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples);
        expect(metric.trustedSamples).toHaveLength(
          LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples
        );
      }
      // Report-level machine memory is the stabilized baseline, independently per metric, so the
      // numbers a reader compares probe boundaries against are the ones the guard actually used.
      expect(report.machine.availableMemoryBytes).toBe(hostBaseline?.baselineBytes);
      expect(report.machine.gpu[0]?.availableMemoryBytes).toBe(vramBaseline?.baselineBytes);
      expect(report.methodology.resourceStability).toMatchObject({
        baselineSamples: LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples,
        confirmationReads: LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads,
        guardedDirections: ['decrease', 'increase'],
        guardedBoundaries: ['pre-launch', 'post-cleanup'],
        thresholdComparison: 'inclusive',
      });
      expect(JSON.stringify(report.methodology.resourceStability)).not.toContain(
        String(hostBaseline?.baselineBytes)
      );
      for (const probe of report.probes) {
        expect(probe.resourceBoundaries?.preLaunch).toMatchObject({ boundary: 'pre-launch' });
        expect(probe.resourceBoundaries?.postCleanup).toMatchObject({ boundary: 'post-cleanup' });
      }
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
