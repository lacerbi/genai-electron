import { describe, expect, it } from '@jest/globals';
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
  LlamaCalibrationProfile,
  LlamaCalibrationProgress,
  LlamaCalibrationReport,
  LlamaExactCalibrationConfig,
  LlamaExactCalibrationReport,
  OptimalConfigHints,
  ServerEvent,
  ServerInfo,
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
      progressTypeCheck,
    }).toBeDefined();
  });
});

describe('public LLM calibration schema-v2 types', () => {
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
      const schemaVersion: 2 = report.schemaVersion;
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

  it('rejects invalid schema-v2 shapes at compile time', () => {
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
