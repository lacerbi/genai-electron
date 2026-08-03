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
  LlamaAdaptiveCalibrationConfig,
  LlamaAdaptiveCalibrationReport,
  LlamaCalibrationConfig,
  LlamaCalibrationDiagnosticCandidate,
  LlamaCalibrationDiagnosticEvidenceLevel,
  LlamaCalibrationPartialReport,
  LlamaCalibrationProbeResourceBoundaries,
  LlamaCalibrationProbeResourceValidity,
  LlamaCalibrationProfile,
  LlamaCalibrationProgress,
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
      if (report.strategy === 'adaptive') {
        return report.selectionEvidence === 'independent-reproduction'
          ? report.selected?.startConfig
          : report.provisional?.startConfig;
      }
      return report.selectionEvidence === 'single-launch-measurement'
        ? report.selected?.startConfig
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
      if (progress.strategy === 'adaptive') return progress.budget.resolved;
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

describe('public LLM calibration schema-v3 resource types', () => {
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
    const candidate: LlamaCalibrationDiagnosticCandidate = {
      sourceProbeIndexes: [0, 1],
      evidenceLevel: 'independent-reproduction',
      usability: 'diagnostic-only',
    };
    const partial: LlamaCalibrationResourceFailurePartialReport = {
      schemaVersion: 3,
      policyVersion: 'llama-runtime-v3',
      strategy: 'adaptive',
      status: 'failed',
      createdAt: '2026-08-02T12:00:00.000Z',
      resourceMonitoring: monitoring,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
      resourceFailure: failure,
      diagnosticCandidate: candidate,
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
    const evidenceLevels = [
      'independent-reproduction',
      'single-launch-measurement',
    ] as const satisfies readonly LlamaCalibrationDiagnosticEvidenceLevel[];

    expect(describeRejection(rootTyped)).toBe('drift:hostMemory');
    expect(codes).toHaveLength(2);
    expect(boundaries.preLaunch?.boundary).toBe('pre-launch');
    expect(telemetryOptions.timeoutMs).toBe(10_000);
    expect(refreshStatuses).toHaveLength(3);
    expect(directions).toEqual([failure.affectedDirections.hostMemory, 'increase']);
    expect(boundaryKinds).toContain(failure.boundary);
    expect(untrustedReasons).toContain(untrustedReading.untrustedReason);
    expect(evidenceLevels).toContain(candidate.evidenceLevel);
  });

  it('rejects removed schema-v2 resource assumptions at compile time', () => {
    const reportSchema = (report: LlamaCalibrationReport) => {
      const version: 3 = report.schemaVersion;
      // @ts-expect-error schema v2 reports cannot satisfy the v3 literal
      const staleVersion: 2 = report.schemaVersion;
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
    // @ts-expect-error a diagnostic candidate is never application-ready
    const invalidUsability: LlamaCalibrationDiagnosticCandidate['usability'] = 'applicable';
    // A diagnostic candidate is offered only by the resource-failure partial report. Reading it off
    // the general partial report (an abort, an unrelated failure) must not compile, or a host would
    // branch on a field that is never populated there.
    const generalPartialShape = (partial: LlamaCalibrationPartialReport) => ({
      // @ts-expect-error only the resource-failure partial report carries a diagnostic candidate
      candidate: partial.diagnosticCandidate,
      monitoring: partial.resourceMonitoring,
    });
    // The resource-failure partial report is defined by its failure record, so omitting it must not
    // compile: that record is the entire reason the type is distinct from the general one.
    // @ts-expect-error resourceFailure is required on the resource-failure partial report
    const partialWithoutFailure: LlamaCalibrationResourceFailurePartialReport = {
      schemaVersion: 3,
      policyVersion: 'llama-runtime-v3',
      strategy: 'exact',
      status: 'failed',
      createdAt: '2026-08-02T12:00:00.000Z',
      resourceMonitoring: monitoring,
      probes: [],
      warnings: [],
      cleanupConfirmed: true,
    };
    // The candidate carries indexes and markers only - never a startable config or a score - so a
    // host cannot mistake it for a recommendation.
    const candidateWithStartConfig: LlamaCalibrationDiagnosticCandidate = {
      sourceProbeIndexes: [0, 1],
      evidenceLevel: 'independent-reproduction',
      usability: 'diagnostic-only',
      // @ts-expect-error a diagnostic candidate never carries an application-ready start config
      startConfig: { contextSize: 12_288, parallelRequests: 2 },
    };
    const candidateWithScore: LlamaCalibrationDiagnosticCandidate = {
      sourceProbeIndexes: [0, 1],
      evidenceLevel: 'independent-reproduction',
      usability: 'diagnostic-only',
      // @ts-expect-error a diagnostic candidate never carries a score of its own
      scoreMs: 1234,
    };

    expect({
      reportSchema,
      probeShape,
      adaptiveWithThresholdOverride,
      exactWithConfirmationOverride,
      metrics,
      invalidMetric,
      invalidUsability,
      generalPartialShape,
      partialWithoutFailure,
      candidateWithStartConfig,
      candidateWithScore,
      monitoring,
    }).toBeDefined();
  });
});

describe('public LLM calibration schema-v3 types', () => {
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
        const resolvedTarget = progress.budget.resolved ? progress.budget.targetProbes : undefined;
        // @ts-expect-error exact candidate state is unavailable in adaptive progress
        void progress.candidates;
        return resolvedTarget;
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
      const schemaVersion: 3 = report.schemaVersion;
      if (report.strategy === 'adaptive') {
        const confidence: 'empirical-reproducibility' = report.confidence;
        // @ts-expect-error exact combo runs are unavailable in adaptive reports
        void report.runs;
        return { schemaVersion, confidence, selection: report.selectionEvidence };
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
      budget: { resolved: false },
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
        resolved: true,
        targetProbes: 10,
        maxProbes: 15,
        finalistReserve: 2,
        maxWallTimeMs: 1_800_000,
        finalistTimeReserveMs: 300_000,
        remainingWallTimeMs: 1_799_999,
        probeReserveActive: false,
        timeReserveActive: false,
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
        resolved: true,
        targetProbes: 10,
        maxProbes: 15,
        finalistReserve: 2,
        maxWallTimeMs: 1_800_000,
        finalistTimeReserveMs: 300_000,
        remainingWallTimeMs: 1_799_999,
        probeReserveActive: false,
        timeReserveActive: false,
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
    }).toBeDefined();
  });

  it('rejects invalid schema-v3 shapes at compile time', () => {
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
    // @ts-expect-error exact progress cannot terminate as budget-exhausted
    const exactBudgetTerminal: LlamaCalibrationProgress = {
      strategy: 'exact',
      phase: 'done',
      terminalStatus: 'budget-exhausted',
      overallPercent: 100,
      elapsedMs: 1,
      candidates: { resolved: true, comboCount: 1 },
    };
    // @ts-expect-error adaptive returned reports never carry rejected aborted/failed status
    const invalidAdaptiveReportStatus: LlamaAdaptiveCalibrationReport['status'] = 'aborted';
    // @ts-expect-error exact mode has no adaptive budget-exhausted report outcome
    const invalidExactReportStatus: LlamaExactCalibrationReport['status'] = 'budget-exhausted';
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
      adaptiveActiveProbe,
      exactBudgetTerminal,
      invalidAdaptiveReportStatus,
      invalidExactReportStatus,
      invalidAdaptiveEvidence,
      invalidExactEvidence,
    }).toBeDefined();
  });
});
