import { describe, expect, it } from '@jest/globals';
// Value import from the error module, not the package root: this suite must stay free of the
// Electron runtime. The root's re-export is proven type-side below and at runtime by
// `npm run test:packed-api`.
import { LlamaCalibrationResourceStabilityError } from '../../src/errors/index.js';
import type { LlamaCalibrationResourceStabilityError as RootStabilityError } from '../../src/index.js';
import type {
  ContextConstraintDetails,
  ContextConstraintError,
  ContextConstraintReason,
  ContextConstraintStage,
  InsufficientResourcesDetails,
  LlamaServerReadyState,
  LlamaAdaptiveActiveProbe,
  LlamaAdaptiveCalibrationBestKnown,
  LlamaAdaptiveCalibrationBudgetReport,
  LlamaAdaptiveCalibrationConfig,
  LlamaAdaptiveCalibrationPreparationTimeLimit,
  LlamaAdaptiveCalibrationReport,
  LlamaAdaptiveProgressBudget,
  LlamaCalibrationConfig,
  LlamaCalibrationPartialReport,
  LlamaCalibrationProbeResourceBoundaries,
  LlamaCalibrationProbeResourceValidity,
  LlamaCalibrationProfile,
  LlamaCalibrationProgress,
  LlamaCalibrationRecommendation,
  LlamaCalibrationReport,
  LlamaCalibrationResourceBoundaryDiagnostic,
  LlamaCalibrationResourceBoundaryKind,
  LlamaCalibrationResourceChangeDirection,
  LlamaCalibrationResourceFailure,
  LlamaCalibrationResourceFailurePartialReport,
  LlamaCalibrationResourceMetric,
  LlamaCalibrationResourceMonitoring,
  LlamaCalibrationResourceReading,
  LlamaCalibrationResourceStabilityCode,
  LlamaCalibrationResourceStabilityDetails,
  LlamaCalibrationResourceUntrustedReason,
  LlamaExactCalibrationConfig,
  LlamaExactCalibrationBestKnown,
  LlamaExactCalibrationReport,
  MemoryTelemetryRefreshStatus,
  OptimalConfigHints,
  ServerEvent,
  ServerInfo,
  TelemetryCommandOptions,
} from '../../src/index.js';

describe('public context-capacity types', () => {
  it('are consumable through the package root', () => {
    const reason: ContextConstraintReason = 'runtime-below-minimum';
    const stage: ContextConstraintStage = 'runtime';
    const details: ContextConstraintDetails = {
      reason,
      stage,
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      configuredContextSize: 8192,
      effectiveContextSize: 2048,
      parallelRequests: 2,
      effectiveParallelRequests: 2,
    };
    const hints: OptimalConfigHints = {
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      maximumContextSize: 8192,
      parallelRequests: 2,
    };
    const info: Pick<ServerInfo, 'configuredContextSize' | 'effectiveContextSize'> = {
      configuredContextSize: 8192,
      effectiveContextSize: 4096,
    };
    const ready: LlamaServerReadyState = {
      serverGeneration: 1,
      modelId: 'test-model',
      port: 8080,
      configuredContextSize: 8192,
      effectiveContextSize: 4096,
      effectiveParallelRequests: 2,
      startedAt: '2026-07-29T12:00:00.000Z',
    };
    const readyEvent: ServerEvent = 'ready';
    const resources: InsufficientResourcesDetails = {
      required: '4096 tokens per slot',
      available: '2048 tokens per slot',
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      maxFeasibleContextSize: 2048,
    };
    const errorTypeCheck = (error: ContextConstraintError): ContextConstraintDetails =>
      error.details;
    const adaptiveCalibration: LlamaAdaptiveCalibrationConfig = {
      modelId: 'test-model',
      profiles: [{ contextSize: 12_288, parallelRequests: 2 }],
      workloads: [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }],
      fixedConfig: { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' },
    };
    const exactCalibration: LlamaExactCalibrationConfig = {
      modelId: 'test-model',
      profile: { contextSize: 12_288, parallelRequests: 2 },
      workloads: [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }],
      combos: [{ label: 'measured', overrides: { gpuLayers: 24 } }],
    };
    const calibration: readonly LlamaCalibrationConfig[] = [adaptiveCalibration, exactCalibration];
    const reportTypeCheck = (report: LlamaCalibrationReport) => {
      if (report.resultKind === 'preparation-time-limit') return report.terminalReason;
      if (report.strategy === 'adaptive') {
        return report.selectionEvidence ? report.selected.startConfig : undefined;
      }
      return report.selectionEvidence === 'single-launch-measurement'
        ? report.selected.startConfig
        : undefined;
    };
    const probeTypeCheck = (report: LlamaCalibrationReport) =>
      report.probes.map((probe) => ({
        // Resource regimes are gone: one calibration has ONE fixed baseline and never re-anchors,
        // so a probe is either usable evidence or explicitly invalidated. A build still reading
        // `resourceRegime` must fail to compile rather than silently read `undefined`.
        // @ts-expect-error resourceRegime was removed with the re-anchoring behaviour it described
        regime: probe.resourceRegime,
        // Required, not optional: every probe states whether the guard invalidated it.
        validity: probe.resourceValidity satisfies LlamaCalibrationProbeResourceValidity,
        boundary: probe.boundaryDecision.classification,
      }));
    const progressTypeCheck = (progress: LlamaCalibrationProgress) => {
      if (progress.phase === 'done') return progress.terminalStatus;
      if (progress.strategy === 'adaptive') return progress.budget.remainingMs;
      return progress.candidates.resolved;
    };

    expect({
      details,
      hints,
      info,
      ready,
      readyEvent,
      resources,
      errorTypeCheck,
      calibration,
      reportTypeCheck,
      probeTypeCheck,
      progressTypeCheck,
    }).toBeDefined();
  });
});

describe('public LLM calibration schema-v4 resource types', () => {
  const monitoring: LlamaCalibrationResourceMonitoring = {
    coverage: 'complete',
    enabledMetrics: ['hostMemory', 'vram'],
    metrics: [
      {
        metric: 'hostMemory',
        enabled: true,
        baselineBytes: 16_000_000_000,
        decreaseThresholdPct: 10,
        increaseThresholdPct: 20,
        attempts: 3,
        trustedSamples: [16_000_000_000, 16_050_000_000, 16_100_000_000],
      },
      {
        metric: 'vram',
        enabled: false,
        decreaseThresholdPct: 10,
        increaseThresholdPct: 10,
        attempts: 3,
        trustedSamples: [],
      },
    ],
  };
  const trustedReading: LlamaCalibrationResourceReading = {
    metric: 'hostMemory',
    enabled: true,
    trusted: true,
    availableBytes: 14_000_000_000,
    // Signed: positive is less availability than the baseline, negative is more.
    decreasePctFromBaseline: 12.5,
    decreaseThresholdPct: 10,
    increaseThresholdPct: 20,
    suspicious: true,
    suspiciousDirection: 'decrease',
  };
  const untrustedReading: LlamaCalibrationResourceReading = {
    metric: 'vram',
    enabled: false,
    trusted: false,
    untrustedReason: 'reading-unavailable',
    suspicious: false,
  };
  const boundary: LlamaCalibrationResourceBoundaryDiagnostic = {
    boundary: 'post-cleanup',
    confirmationPerformed: true,
    initial: {
      readings: [trustedReading, untrustedReading],
      suspiciousMetrics: ['hostMemory'],
      untrustedMetrics: [],
    },
    confirmation: {
      readings: [trustedReading, untrustedReading],
      suspiciousMetrics: ['hostMemory'],
      untrustedMetrics: [],
    },
    initiallySuspiciousMetrics: ['hostMemory'],
    warnings: ['Resource change confirmed at the post-cleanup boundary for hostMemory (decrease).'],
  };

  it('consumes monitoring, boundary diagnostics, and the typed rejection through the package root', () => {
    const boundaries: LlamaCalibrationProbeResourceBoundaries = {
      preLaunch: { ...boundary, boundary: 'pre-launch' },
      postCleanup: boundary,
    };
    const failure: LlamaCalibrationResourceFailure = {
      boundary: 'post-cleanup',
      affectedMetrics: ['hostMemory'],
      affectedDirections: { hostMemory: 'decrease' },
      probeIndex: 2,
      diagnostics: boundary,
    };
    const recommendation: LlamaCalibrationRecommendation = {
      profileIndex: 0,
      cellId: 'p0:c12288:swa-window:kv-q8_0',
      startConfig: { contextSize: 12_288, parallelRequests: 2, gpuLayers: 20 },
      scoreMs: 1_234,
    };
    const bestKnown: LlamaAdaptiveCalibrationBestKnown = {
      recommendation,
      evidence: 'independent-reproduction',
      sourceProbeIndexes: [0, 1],
    };
    const partial: LlamaCalibrationResourceFailurePartialReport = {
      schemaVersion: 4,
      policyVersion: 'llama-runtime-v4',
      strategy: 'adaptive',
      status: 'failed',
      createdAt: '2026-08-02T12:00:00.000Z',
      resourceMonitoring: monitoring,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
      resourceFailure: failure,
      searchCompleteness: 'partial',
      budget: { maxWallTimeMs: 3_600_000, elapsedMs: 10_000, overrunMs: 0 },
      bestKnown,
    };

    // One `instanceof` branch, then a typed switch on the details discriminant.
    const describeRejection = (error: unknown): string => {
      if (!(error instanceof LlamaCalibrationResourceStabilityError)) return 'other';
      const details: LlamaCalibrationResourceStabilityDetails = error.details;
      switch (details.code) {
        case 'CALIBRATION_RESOURCE_DRIFT':
          return `drift:${details.partialReport.resourceFailure.affectedMetrics.join(',')}`;
        case 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED':
          return `unverified:${details.partialReport.resourceFailure.boundary}`;
      }
    };
    const codes: readonly LlamaCalibrationResourceStabilityCode[] = [
      'CALIBRATION_RESOURCE_DRIFT',
      'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED',
    ];
    const error = new LlamaCalibrationResourceStabilityError('resources changed', {
      code: 'CALIBRATION_RESOURCE_DRIFT',
      suggestion: 'close heavy work and recalibrate',
      partialReport: partial,
    });
    // The package root exports the same class, so a host needs no deep import to branch on it.
    const rootTyped: RootStabilityError = error;
    const telemetryOptions: TelemetryCommandOptions = {
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    };
    const refreshStatuses: readonly MemoryTelemetryRefreshStatus[] = [
      'refreshed',
      'not-required',
      'failed',
    ];
    // The vocabulary types the diagnostics are written in are exported in their own right, so a
    // host can name them when it stores or renders a boundary rather than re-deriving them from
    // the structures above. Every literal each admits is consumed here, so narrowing one of these
    // unions is a compile break rather than a silently unreachable branch.
    const directions = [
      'decrease',
      'increase',
    ] as const satisfies readonly LlamaCalibrationResourceChangeDirection[];
    const boundaryKinds = [
      'pre-launch',
      'post-cleanup',
    ] as const satisfies readonly LlamaCalibrationResourceBoundaryKind[];
    const untrustedReasons = [
      'telemetry-refresh-failed',
      'reading-unavailable',
      'reading-invalid',
    ] as const satisfies readonly LlamaCalibrationResourceUntrustedReason[];
    const exactBestKnown: LlamaExactCalibrationBestKnown = {
      recommendation,
      evidence: 'single-launch-measurement',
      sourceProbeIndexes: [0],
    };

    expect(describeRejection(rootTyped)).toBe('drift:hostMemory');
    expect(codes).toHaveLength(2);
    expect(boundaries.preLaunch?.boundary).toBe('pre-launch');
    expect(telemetryOptions.timeoutMs).toBe(10_000);
    expect(refreshStatuses).toHaveLength(3);
    expect(directions).toEqual([failure.affectedDirections.hostMemory, 'increase']);
    expect(boundaryKinds).toContain(failure.boundary);
    expect(untrustedReasons).toContain(untrustedReading.untrustedReason);
    expect(bestKnown.evidence).toBe('independent-reproduction');
    expect(exactBestKnown.evidence).toBe('single-launch-measurement');
  });

  it('rejects removed schema-v2 resource assumptions at compile time', () => {
    const reportSchema = (report: LlamaCalibrationReport) => {
      const version: 4 = report.schemaVersion;
      // @ts-expect-error schema v3 reports cannot satisfy the v4 literal
      const staleVersion: 3 = report.schemaVersion;
      return { version, staleVersion };
    };
    const probeShape = (report: LlamaCalibrationReport) =>
      report.probes.map((probe) => ({
        // @ts-expect-error per-probe before/after memory reduction was replaced by boundaries
        legacyHostMemory: probe.diagnostics?.hostAvailableMemory,
        // @ts-expect-error per-probe before/after memory reduction was replaced by boundaries
        legacyGpuMemory: probe.diagnostics?.gpuAvailableMemory,
        boundaries: probe.resourceBoundaries,
      }));
    // Resource policy is not caller-configurable: no override may reach calibrate().
    const adaptiveWithThresholdOverride: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      profiles: [{ contextSize: 12_288, parallelRequests: 2 }],
      workloads: [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }],
      // @ts-expect-error resource bands are exported policy constants, never per-call fields
      hostMemoryDecreaseThresholdPct: 25,
    };
    const exactWithConfirmationOverride: LlamaExactCalibrationConfig = {
      modelId: 'model',
      profile: { contextSize: 12_288, parallelRequests: 2 },
      workloads: [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }],
      combos: [{ overrides: {} }],
      // @ts-expect-error confirmation cannot be disabled by a caller
      resourceDriftConfirmationReads: 0,
    };
    const metrics: readonly LlamaCalibrationResourceMetric[] = ['hostMemory', 'vram'];
    // @ts-expect-error there is no third guarded metric and no combined score
    const invalidMetric: LlamaCalibrationResourceMetric = 'disk';
    // A best-known result is offered only by the resource-failure partial report. Reading it off
    // the general partial report (an abort, an unrelated failure) must not compile, or a host would
    // branch on a field that is never populated there.
    const generalPartialShape = (partial: LlamaCalibrationPartialReport) => ({
      // @ts-expect-error only the resource-failure partial report carries bestKnown
      bestKnown: partial.bestKnown,
      monitoring: partial.resourceMonitoring,
    });
    // The resource-failure partial report is defined by its failure record, so omitting it must not
    // compile: that record is the entire reason the type is distinct from the general one.
    // @ts-expect-error resourceFailure is required on the resource-failure partial report
    const partialWithoutFailure: LlamaCalibrationResourceFailurePartialReport = {
      schemaVersion: 4,
      policyVersion: 'llama-runtime-v4',
      strategy: 'exact',
      status: 'failed',
      createdAt: '2026-08-02T12:00:00.000Z',
      resourceMonitoring: monitoring,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
    };
    const recommendation: LlamaCalibrationRecommendation = {
      startConfig: { contextSize: 12_288, parallelRequests: 2, gpuLayers: 20 },
      scoreMs: 1_234,
    };
    const emptyBestKnown: LlamaAdaptiveCalibrationBestKnown = {
      recommendation,
      evidence: 'single-full-launch',
      // @ts-expect-error bestKnown must cite at least one accepted source probe
      sourceProbeIndexes: [],
    };
    const wrongAdaptiveEvidence: LlamaAdaptiveCalibrationBestKnown = {
      recommendation,
      // @ts-expect-error exact evidence cannot appear in adaptive bestKnown
      evidence: 'single-launch-measurement',
      sourceProbeIndexes: [0],
    };
    // @ts-expect-error adaptive resource partials always report the elapsed-time budget
    const adaptivePartialWithoutBudget: LlamaCalibrationResourceFailurePartialReport = {
      schemaVersion: 4,
      policyVersion: 'llama-runtime-v4',
      strategy: 'adaptive',
      status: 'failed',
      createdAt: '2026-08-02T12:00:00.000Z',
      resourceMonitoring: monitoring,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
      resourceFailure: {
        boundary: 'pre-launch',
        affectedMetrics: ['hostMemory'],
        affectedDirections: { hostMemory: 'decrease' },
        diagnostics: boundary,
      },
    };

    expect({
      reportSchema,
      probeShape,
      adaptiveWithThresholdOverride,
      exactWithConfirmationOverride,
      metrics,
      invalidMetric,
      generalPartialShape,
      partialWithoutFailure,
      emptyBestKnown,
      wrongAdaptiveEvidence,
      adaptivePartialWithoutBudget,
      monitoring,
    }).toBeDefined();
  });
});

describe('public LLM calibration schema-v4 types', () => {
  const profile: LlamaCalibrationProfile = { contextSize: 12_288, parallelRequests: 2 };
  const workloads = [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }] as const;

  it('narrows input, progress, and report variants by their public discriminants', () => {
    const inputTypeCheck = (config: LlamaCalibrationConfig) => {
      if (config.combos !== undefined) {
        const exact: LlamaExactCalibrationConfig = config;
        return exact.combos[0].overrides;
      }
      const adaptive: LlamaAdaptiveCalibrationConfig = config;
      return adaptive.profiles[0].contextSize;
    };
    const progressTypeCheck = (progress: LlamaCalibrationProgress) => {
      if (progress.strategy === 'adaptive') {
        if (progress.phase === 'done') {
          return progress.terminalStatus;
        }
        const remainingMs = progress.budget.remainingMs;
        // @ts-expect-error exact candidate state is unavailable in adaptive progress
        void progress.candidates;
        return remainingMs;
      }
      if (progress.phase === 'done') {
        return progress.terminalStatus;
      }
      const comboCount = progress.candidates.resolved ? progress.candidates.comboCount : undefined;
      // @ts-expect-error adaptive budget state is unavailable in exact progress
      void progress.budget;
      return comboCount;
    };
    const reportTypeCheck = (report: LlamaCalibrationReport) => {
      const schemaVersion: 4 = report.schemaVersion;
      if (report.resultKind === 'preparation-time-limit') {
        // @ts-expect-error preparation expiry cannot fabricate an ordinary machine identity
        void report.machine;
        return { schemaVersion, reason: report.terminalReason };
      }
      if (report.strategy === 'adaptive') {
        // @ts-expect-error exact combo runs are unavailable in adaptive reports
        void report.runs;
        // @ts-expect-error adaptive confidence was replaced by explicit selection evidence
        void report.confidence;
        return {
          schemaVersion,
          completeness: report.searchCompleteness,
          selection: report.selectionEvidence,
        };
      }
      const confidence: 'single-launch-measurement' = report.confidence;
      // @ts-expect-error adaptive cell state is unavailable in exact reports
      void report.cells;
      return { schemaVersion, confidence, selection: report.selectionEvidence };
    };

    const adaptivePreparing: LlamaCalibrationProgress = {
      strategy: 'adaptive',
      phase: 'preparing',
      overallPercent: 0,
      elapsedMs: 0,
      completedProbes: 0,
      budget: {
        maxWallTimeMs: 3_600_000,
        remainingMs: 3_600_000,
      },
    };
    const exactPreparing: LlamaCalibrationProgress = {
      strategy: 'exact',
      phase: 'preparing',
      overallPercent: 0,
      elapsedMs: 0,
      candidates: { resolved: false },
    };
    const adaptiveActive: LlamaCalibrationProgress = {
      strategy: 'adaptive',
      phase: 'finding-reference',
      overallPercent: 10,
      elapsedMs: 1,
      completedProbes: 0,
      budget: {
        maxWallTimeMs: 1_800_000,
        remainingMs: 1_799_999,
        maxProbes: 15,
        remainingProbes: 15,
      },
      activeProbe: {
        profileIndex: 0,
        profileOrdinal: 0,
        cellId: 'p0:c12288:swa-window:kv-q8_0',
        purpose: 'reference',
        gpuLayers: 20,
        fidelity: 'search',
        resolvedConfig: { ...profile, gpuLayers: 20 },
        argvKey: 'argv',
        probePhase: 'starting',
      },
      workloadIndex: 0,
      workloadCount: 1,
      sampleIndex: 0,
      sampleCount: 1,
    };
    const exactActive: LlamaCalibrationProgress = {
      strategy: 'exact',
      phase: 'sampling',
      overallPercent: 50,
      elapsedMs: 1,
      candidates: { resolved: true, comboCount: 1 },
      activeCandidate: {
        comboIndex: 0,
        combo: { overrides: { gpuLayers: 20 } },
        resolvedConfig: { ...profile, gpuLayers: 20 },
        gpuLayers: 20,
      },
      workloadIndex: 0,
      workloadCount: 1,
      sampleIndex: 0,
      sampleCount: 3,
    };
    const adaptiveDone: LlamaCalibrationProgress = {
      strategy: 'adaptive',
      phase: 'done',
      terminalStatus: 'complete',
      overallPercent: 100,
      elapsedMs: 1,
      completedProbes: 2,
      budget: {
        maxWallTimeMs: 1_800_000,
        remainingMs: 1_799_999,
        maxProbes: 15,
        remainingProbes: 13,
      },
    };
    const exactDone: LlamaCalibrationProgress = {
      strategy: 'exact',
      phase: 'done',
      terminalStatus: 'complete',
      overallPercent: 100,
      elapsedMs: 1,
      candidates: { resolved: true, comboCount: 1 },
    };
    const unboundedBudget: LlamaAdaptiveProgressBudget = {
      maxWallTimeMs: 3_600_000,
      remainingMs: 3_500_000,
    };
    const boundedBudget: LlamaAdaptiveProgressBudget = {
      maxWallTimeMs: 3_600_000,
      remainingMs: 3_500_000,
      maxProbes: 10,
      remainingProbes: 8,
    };
    const reportBudget: LlamaAdaptiveCalibrationBudgetReport = {
      maxWallTimeMs: 3_600_000,
      elapsedMs: 3_601_000,
      overrunMs: 1_000,
    };
    const preparationLimit: LlamaAdaptiveCalibrationPreparationTimeLimit = {
      resultKind: 'preparation-time-limit',
      schemaVersion: 4,
      policyVersion: 'llama-runtime-v4',
      createdAt: '2026-08-04T12:00:00.000Z',
      strategy: 'adaptive',
      phase: 'preparing',
      status: 'time-limited',
      searchCompleteness: 'partial',
      terminalReason: 'deadline reached while provisioning',
      budget: reportBudget,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
    };

    expect({
      inputTypeCheck,
      progressTypeCheck,
      reportTypeCheck,
      adaptivePreparing,
      exactPreparing,
      adaptiveActive,
      exactActive,
      adaptiveDone,
      exactDone,
      unboundedBudget,
      boundedBudget,
      reportBudget,
      preparationLimit,
    }).toBeDefined();
  });

  it('rejects invalid schema-v4 shapes at compile time', () => {
    // @ts-expect-error legacy profile-only input is neither adaptive nor exact
    const legacyProfileOnly: LlamaCalibrationConfig = {
      modelId: 'model',
      profile,
      workloads,
    };
    const adaptiveWithCombos: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      profiles: [profile],
      workloads,
      // @ts-expect-error adaptive mode cannot supply exact combos
      combos: [{ overrides: { gpuLayers: 1 } }],
    };
    const adaptiveWithProfile: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      profiles: [profile],
      workloads,
      // @ts-expect-error adaptive mode cannot supply singular profile
      profile,
    };
    const adaptiveEmptyProfiles: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      // @ts-expect-error adaptive profiles are a non-empty tuple
      profiles: [],
      workloads,
    };
    const adaptiveTooManyProfiles: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      // @ts-expect-error adaptive profiles contain at most two entries
      profiles: [profile, { ...profile, contextSize: 16_384 }, { ...profile, contextSize: 20_480 }],
      workloads,
    };
    const exactEmptyCombos: LlamaExactCalibrationConfig = {
      modelId: 'model',
      profile,
      workloads,
      // @ts-expect-error exact combos are a non-empty tuple
      combos: [],
    };
    const exactWithProfiles: LlamaExactCalibrationConfig = {
      modelId: 'model',
      profile,
      workloads,
      combos: [{ overrides: {} }],
      // @ts-expect-error exact mode cannot supply profiles
      profiles: [profile, { ...profile, contextSize: 16_384 }],
    };
    const exactWithAdaptiveBudget: LlamaExactCalibrationConfig = {
      modelId: 'model',
      profile,
      workloads,
      combos: [{ overrides: {} }],
      // @ts-expect-error exact mode cannot supply adaptive budgets
      maxProbes: 10,
    };
    const adaptiveWithRemovedTarget: LlamaAdaptiveCalibrationConfig = {
      modelId: 'model',
      profiles: [profile],
      workloads,
      // @ts-expect-error targetProbes was removed in schema v4
      targetProbes: 10,
    };
    const adaptiveActiveProbe: LlamaAdaptiveActiveProbe = {
      profileIndex: 0,
      profileOrdinal: 0,
      cellId: 'p0:c12288:swa-window:kv-q8_0',
      // @ts-expect-error exact is not an adaptive probe purpose
      purpose: 'exact',
      gpuLayers: 20,
      fidelity: 'search',
      resolvedConfig: { ...profile, gpuLayers: 20 },
      argvKey: 'argv',
    };
    // @ts-expect-error exact progress cannot terminate as time-limited
    const exactBudgetTerminal: LlamaCalibrationProgress = {
      strategy: 'exact',
      phase: 'done',
      terminalStatus: 'time-limited',
      overallPercent: 100,
      elapsedMs: 1,
      candidates: { resolved: true, comboCount: 1 },
    };
    // @ts-expect-error adaptive returned reports never carry rejected aborted/failed status
    const invalidAdaptiveReportStatus: LlamaAdaptiveCalibrationReport['status'] = 'aborted';
    // @ts-expect-error exact mode has no adaptive time-limited report outcome
    const invalidExactReportStatus: LlamaExactCalibrationReport['status'] = 'time-limited';
    // @ts-expect-error adaptive selection evidence cannot claim exact single-launch confidence
    const invalidAdaptiveEvidence: LlamaAdaptiveCalibrationReport['selectionEvidence'] =
      'single-launch-measurement';
    // @ts-expect-error exact selection evidence cannot claim adaptive independent reproduction
    const invalidExactEvidence: LlamaExactCalibrationReport['selectionEvidence'] =
      'independent-reproduction';

    expect({
      legacyProfileOnly,
      adaptiveWithCombos,
      adaptiveWithProfile,
      adaptiveEmptyProfiles,
      adaptiveTooManyProfiles,
      exactEmptyCombos,
      exactWithProfiles,
      exactWithAdaptiveBudget,
      adaptiveWithRemovedTarget,
      adaptiveActiveProbe,
      exactBudgetTerminal,
      invalidAdaptiveReportStatus,
      invalidExactReportStatus,
      invalidAdaptiveEvidence,
      invalidExactEvidence,
    }).toBeDefined();
  });
});
