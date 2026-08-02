import { jest } from '@jest/globals';
import type {
  LlamaAdaptiveCalibrationConfig,
  LlamaCalibrationReport,
  LlamaCalibrationRequestTiming,
  LlamaCalibrationRun,
  ModelInfo,
  SystemCapabilities,
} from '../../src/types/index.js';
import type {
  RunCalibrationProbeObservation,
  RunCalibrationProbeOptions,
} from '../../src/process/llama-calibration-probe.js';
import type { ResourceSnapshot } from '../../src/utils/llama-resource-guard.js';
import type { CalibrationResourceShadowEvent } from '../../src/utils/llama-resource-guard-shadow.js';

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
const {
  armCalibrationResourceShadow,
  disarmCalibrationResourceShadow,
  getCalibrationResourceShadow,
} = await import('../../src/utils/llama-resource-guard-shadow.js');

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

const shadowSchedule = {
  thresholds: { hostMemoryDecreaseThresholdPct: 10, vramDecreaseThresholdPct: 10 },
  cooldownMs: 750,
  settleMs: 1_000,
  baselineSamples: 3,
  postCleanupExtraSampleOffsetsMs: [2_250, 3_000],
} as const;

function timing(wallTimeMs: number): LlamaCalibrationRequestTiming {
  return { wallTimeMs, promptTokens: 10, predictedTokens: 8, cachedTokens: 0 };
}

function observation(
  options: RunCalibrationProbeOptions,
  result: {
    status?: LlamaCalibrationRun['status'];
    scoreMs?: number;
    memory?: 'none' | 'confirmed' | 'unknown';
    preflight?: boolean;
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

/**
 * Wall-clock-derived report fields. Shadow waits legitimately consume time, so these are the only
 * fields allowed to differ between a disarmed and an armed run.
 */
const TIMING_KEYS = new Set([
  'createdAt',
  'durationMs',
  'elapsedMs',
  'remainingWallTimeMs',
  'observedProbeDurationMs',
]);

function withoutTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !TIMING_KEYS.has(key))
        .map(([key, entry]) => [key, withoutTiming(entry)])
    );
  }
  return value;
}

function snapshot(hostBytes: number, vramBytes: number): ResourceSnapshot {
  return {
    hostMemory: { trusted: true, availableBytes: hostBytes },
    vram: { trusted: true, availableBytes: vramBytes },
  };
}

describe('calibration resource-guard shadow observation', () => {
  let manager: InstanceType<typeof LlamaServerManager>;
  let executor: jest.MockedFunction<ProbeExecutor>;

  const buildManager = (): void => {
    executor = jest.fn<ProbeExecutor>();
    const modelManager = { getModelInfo: jest.fn(async () => model) };
    const systemInfo = {
      detect: jest.fn(async () => capabilities),
      clearCache: jest.fn(),
      getMemoryInfo: jest.fn(() => capabilities.memory),
      getGPUInfo: jest.fn(async () => capabilities.gpu),
      refreshMemoryTelemetry: jest.fn(async () => 'refreshed' as const),
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
    executor.mockImplementation(async (options) => {
      const gpuLayers = options.resolvedConfig.gpuLayers ?? 0;
      return gpuLayers >= 7
        ? observation(options, { status: 'oom', memory: 'confirmed', preflight: false })
        : observation(options, { scoreMs: 100 - gpuLayers });
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockBinaryIdentity.mockResolvedValue({
      version: 'b9860',
      variant: 'cuda',
      checksum: 'binary-sha',
    });
    buildManager();
  });

  afterEach(() => {
    disarmCalibrationResourceShadow();
    jest.useRealTimers();
  });

  async function runCalibration(): Promise<LlamaCalibrationReport> {
    return settleCalibration(manager.calibrate(baseConfig));
  }

  it('observes baseline and both boundaries per probe without changing the report', async () => {
    const disarmedReport = await runCalibration();
    expect(getCalibrationResourceShadow()).toBeUndefined();

    buildManager();
    let captureCount = 0;
    const shadow = armCalibrationResourceShadow({
      ...shadowSchedule,
      label: 'unit-test',
      // Baseline reads are quiet; every later read shows a decrease far above the armed
      // thresholds, so boundaries conclude confirmed drift. The report must not notice.
      captureSnapshot: async () => {
        captureCount += 1;
        return captureCount <= shadowSchedule.baselineSamples
          ? snapshot(20_000, 7_000)
          : snapshot(15_000, 5_000);
      },
      delay: async () => undefined,
    });

    const armedReport = await runCalibration();
    const trace = shadow.takeTrace();

    expect(withoutTiming(armedReport)).toEqual(withoutTiming(disarmedReport));
    expect(armedReport.status).toBe('complete');
    expect(armedReport.probes).toHaveLength(6);

    const baselineEvents = trace.events.filter((event) => event.type === 'baseline');
    expect(baselineEvents).toHaveLength(1);
    const [baselineEvent] = baselineEvents;
    if (baselineEvent?.type !== 'baseline') throw new Error('expected a baseline event');
    expect(baselineEvent.strategy).toBe('adaptive');
    expect(baselineEvent.snapshots).toHaveLength(3);
    expect(baselineEvent.baseline?.enabledMetrics).toEqual(['hostMemory', 'vram']);
    expect(baselineEvent.baseline?.coverage).toBe('complete');
    expect(baselineEvent.baseline?.metrics.hostMemory.baselineBytes).toBe(20_000);

    const boundaries = trace.events.filter(
      (event): event is Extract<CalibrationResourceShadowEvent, { type: 'boundary' }> =>
        event.type === 'boundary'
    );
    for (let probeOrdinal = 0; probeOrdinal < armedReport.probes.length; probeOrdinal++) {
      const forProbe = boundaries.filter((event) => event.probeOrdinal === probeOrdinal);
      expect(forProbe.map((event) => event.boundary)).toEqual(['pre-launch', 'post-cleanup']);
    }
    expect(boundaries.every((event) => event.confirmationPerformed)).toBe(true);
    expect(boundaries.every((event) => event.result?.conclusion === 'confirmed-drift')).toBe(true);
    expect(boundaries.every((event) => event.confirmationSnapshots.length === 1)).toBe(true);
    // The post-cleanup sequence pays a cooldown before its first read; pre-launch does not.
    expect(
      boundaries.filter((event) => event.boundary === 'post-cleanup')[0]?.preReadCooldownMs
    ).toBe(shadowSchedule.cooldownMs);

    const extras = trace.events.filter((event) => event.type === 'extra-sample');
    expect(extras).toHaveLength(
      armedReport.probes.length * shadowSchedule.postCleanupExtraSampleOffsetsMs.length
    );

    const legacy = trace.events.filter((event) => event.type === 'legacy-outcome');
    expect(legacy).toHaveLength(armedReport.probes.length);
    expect(trace.events.every((event) => typeof event.atMs === 'number')).toBe(true);
    expect(trace.events.every((event) => typeof event.wallMs === 'number')).toBe(true);
    expect(trace.schedule.thresholds).toEqual(shadowSchedule.thresholds);
    expect(trace.label).toBe('unit-test');
  });

  it('records a note and leaves the report intact when telemetry capture throws', async () => {
    const disarmedReport = await runCalibration();

    buildManager();
    const shadow = armCalibrationResourceShadow({
      ...shadowSchedule,
      captureSnapshot: async () => {
        throw new Error('scripted telemetry failure');
      },
      delay: async () => undefined,
    });

    const armedReport = await runCalibration();
    const trace = shadow.takeTrace();

    expect(armedReport.status).toBe(disarmedReport.status);
    expect(withoutTiming(armedReport)).toEqual(withoutTiming(disarmedReport));

    const notes = trace.events.filter((event) => event.type === 'note');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatchObject({
      type: 'note',
      message: expect.stringContaining('baseline collection failed'),
    });
    const baselineEvents = trace.events.filter((event) => event.type === 'baseline');
    expect(baselineEvents).toHaveLength(1);
    expect(baselineEvents[0]).toMatchObject({ error: 'scripted telemetry failure' });
    // Without a baseline no boundary can be evaluated, and none is silently faked.
    expect(trace.events.some((event) => event.type === 'boundary')).toBe(false);
    expect(shadow.hasBaseline()).toBe(false);
  });

  it('observes the same boundaries in exact mode without changing the report', async () => {
    const exactConfig = {
      modelId: model.id,
      profile: { contextSize: 8192, parallelRequests: 2 },
      combos: [
        { label: 'a', overrides: { gpuLayers: 4 } },
        { label: 'b', overrides: { gpuLayers: 5 } },
      ],
      workloads: [workload],
      samples: 2,
    } as const;

    const disarmedReport = await settleCalibration(manager.calibrate(exactConfig));

    buildManager();
    const shadow = armCalibrationResourceShadow({
      ...shadowSchedule,
      captureSnapshot: async () => snapshot(20_000, 7_000),
      delay: async () => undefined,
    });
    const armedReport = await settleCalibration(manager.calibrate(exactConfig));
    const trace = shadow.takeTrace();

    expect(withoutTiming(armedReport)).toEqual(withoutTiming(disarmedReport));
    expect(armedReport.strategy).toBe('exact');

    expect(trace.events.filter((event) => event.type === 'baseline')).toHaveLength(1);
    const boundaries = trace.events.filter(
      (event): event is Extract<CalibrationResourceShadowEvent, { type: 'boundary' }> =>
        event.type === 'boundary'
    );
    expect(boundaries.every((event) => event.strategy === 'exact')).toBe(true);
    for (let probeOrdinal = 0; probeOrdinal < exactConfig.combos.length; probeOrdinal++) {
      expect(
        boundaries
          .filter((event) => event.probeOrdinal === probeOrdinal)
          .map((event) => event.boundary)
      ).toEqual(['pre-launch', 'post-cleanup']);
    }
    // Quiet readings never require a confirmation, so no extra cooldown is paid.
    expect(boundaries.every((event) => event.confirmationPerformed)).toBe(false);
    expect(boundaries.every((event) => event.result?.conclusion === 'admitted')).toBe(true);
  });

  it('leaves later runs traceless once disarmed', async () => {
    const shadow = armCalibrationResourceShadow({
      ...shadowSchedule,
      captureSnapshot: async () => snapshot(20_000, 7_000),
      delay: async () => undefined,
    });
    await runCalibration();
    expect(shadow.takeTrace().events.length).toBeGreaterThan(0);

    disarmCalibrationResourceShadow();
    expect(getCalibrationResourceShadow()).toBeUndefined();

    buildManager();
    const report = await runCalibration();

    expect(report.status).toBe('complete');
    expect(shadow.takeTrace().events).toEqual([]);
    expect(shadow.takeTrace().guardAddedMs).toBe(0);
  });
});
