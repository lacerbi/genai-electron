import {
  ADAPTIVE_POLICY_DEFAULTS,
  applyAdaptivePolicyObservation,
  assessMixedFidelityStability,
  canCloseCappedPoint,
  classifyAdaptiveObservation,
  competitiveObservedRatio,
  createAdaptivePolicyState,
  deriveCeilingHints,
  enumerateAdaptiveCells,
  estimateConfiguredProbeDuration,
  evaluateProbeAdmission,
  evaluateReferenceGuard,
  findStableCliffReference,
  isAdaptiveCellCompetitive,
  nextAdaptivePolicyAction,
  resolveAdaptiveBudgets,
  resolveAdaptiveRecommendation,
  summarizeAdaptiveCellStates,
  summarizeAdaptiveTimingAdmission,
  type AdaptiveCandidate,
  type AdaptiveCellEnumerationInput,
  type AdaptiveEvidence,
  type AdaptivePolicyConfig,
  type AdaptiveProbeObservation,
} from '../../src/utils/llama-adaptive-calibration-policy.js';
import {
  defineAdaptiveTrace,
  executeAdaptiveTrace,
  traceCell,
  type AdaptiveTraceRow,
} from '../fixtures/llama-adaptive-trace.js';

const baseEnumeration: AdaptiveCellEnumerationInput = {
  profiles: [
    {
      profileIndex: 0,
      contextSize: 12_288,
      parallelRequests: 2,
      autoGpuLayers: 45,
      normalizedInvariantKey: 'model',
    },
  ],
  totalLayers: 48,
  gpuAvailable: true,
  slidingWindow: 4096,
  hasSharedPrefixWorkload: true,
  includeKvCacheComparison: false,
  baselineKvPrecision: 'q8_0',
};

const basePolicyConfig: AdaptivePolicyConfig = {
  ...baseEnumeration,
  unobservedProbeDurationEstimateMs: 1,
  budgetOverrides: { maxProbes: 36, maxWallTimeMs: 4_500_000 },
};

function evidence(
  index: number,
  overrides: Partial<AdaptiveEvidence> & Pick<AdaptiveEvidence, 'cellId' | 'gpuLayers'>
): AdaptiveEvidence {
  return {
    index,
    purpose: 'boundary',
    fidelity: 'search',
    operationalStatus: 'ok',
    memoryEvidence: 'none',
    durationMs: 1,
    boundaryDecision: 'admissible',
    decisionReason: 'test',
    ...overrides,
  };
}

function candidate(scoreMs: number, overrides: Partial<AdaptiveCandidate> = {}): AdaptiveCandidate {
  return {
    cellId: 'cell',
    cellOrder: 0,
    profileIndex: 0,
    contextSize: 8192,
    kvPrecision: 'q8_0',
    swaFull: false,
    gpuLayers: 40,
    scoreMs,
    evidenceIndices: [0, 1],
    source: 'boundary',
    ...overrides,
  };
}

describe('pure adaptive LLM calibration policy', () => {
  it('enumerates profile-local SWA/KV cells in structural-pressure order', () => {
    const cells = enumerateAdaptiveCells({
      ...baseEnumeration,
      profiles: [
        { profileIndex: 1, contextSize: 12_288, parallelRequests: 2, autoGpuLayers: 40 },
        { profileIndex: 0, contextSize: 4096, parallelRequests: 2, autoGpuLayers: 44 },
      ],
      includeKvCacheComparison: true,
    });

    expect(
      cells.map((cell) => [cell.profileIndex, cell.contextSize, cell.swaFull, cell.kvPrecision])
    ).toEqual([
      [0, 4096, false, 'q8_0'],
      [0, 4096, false, 'f16'],
      [1, 12_288, false, 'q8_0'],
      [1, 12_288, false, 'f16'],
      [1, 12_288, true, 'q8_0'],
      [1, 12_288, true, 'f16'],
    ]);
    expect(cells.map((cell) => cell.profileOrdinal)).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it('enforces common slots and collapses fixed positive GPU placement on CPU-only runtimes', () => {
    expect(() =>
      enumerateAdaptiveCells({
        ...baseEnumeration,
        profiles: [
          { profileIndex: 0, contextSize: 8192, parallelRequests: 1, autoGpuLayers: 40 },
          { profileIndex: 1, contextSize: 12_288, parallelRequests: 2, autoGpuLayers: 40 },
        ],
      })
    ).toThrow(/shared parallelRequests/);
    const [cell] = enumerateAdaptiveCells({
      ...baseEnumeration,
      gpuAvailable: false,
      fixedGpuLayers: 12,
    });
    expect(cell).toMatchObject({ physicalCeiling: 0, initialGpuLayers: 0 });
  });

  it('resolves capped cell-count budgets and deterministic time admission', () => {
    expect(resolveAdaptiveBudgets(2)).toMatchObject({
      targetProbes: 10,
      maxProbes: 15,
      finalistReserve: 2,
      maxWallTimeMs: 1_800_000,
      finalistTimeReserveMs: 300_000,
    });
    expect(resolveAdaptiveBudgets(8)).toMatchObject({
      targetProbes: 22,
      maxProbes: 36,
      finalistReserve: 6,
      maxWallTimeMs: 4_500_000,
      finalistTimeReserveMs: 900_000,
    });

    const duration = estimateConfiguredProbeDuration({
      startupTimeoutMs: 120_000,
      requestTimeoutMs: 120_000,
      serverStopTimeoutMs: 10_000,
      plannedPostStartupRequestCount: 3,
    });
    expect(duration).toEqual({
      policy: 'configured-conservative-estimate',
      estimateMs: 634_500,
      resolvedCapacityCheckTimeoutMs: 5_000,
      configuredAttemptTeardownMs: 12_250,
      plannedPostStartupRequestCount: 3,
      maxRunnerStartAttempts: 2,
      isFormalUpperBound: false,
    });

    const budgets = resolveAdaptiveBudgets(2);
    expect(
      evaluateProbeAdmission({
        probesUsed: 13,
        elapsedMs: 1_000_000,
        budgets,
        finalistPurpose: false,
        estimatedNextProbeDurationMs: 100_000,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: false, reason: 'launch-reserve' });
    expect(
      evaluateProbeAdmission({
        probesUsed: 13,
        elapsedMs: 1_000_000,
        budgets,
        finalistPurpose: true,
        estimatedNextProbeDurationMs: 100_000,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: true, reason: 'allowed' });
    expect(
      evaluateProbeAdmission({
        probesUsed: 13,
        elapsedMs: 1_750_000,
        budgets,
        finalistPurpose: true,
        estimatedNextProbeDurationMs: 100_000,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: false, reason: 'wall-time' });
    // Probe zero bypasses the reserve checks: reserves protect later validation
    // launches, and the configured conservative estimate can exceed an ordinary
    // budget on its own, which would otherwise return a zero-probe report.
    expect(
      evaluateProbeAdmission({
        probesUsed: 0,
        elapsedMs: 0,
        budgets,
        finalistPurpose: false,
        estimatedNextProbeDurationMs: 2_194_500,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: true, reason: 'allowed' });
    expect(
      evaluateProbeAdmission({
        probesUsed: 1,
        elapsedMs: 0,
        budgets,
        finalistPurpose: false,
        estimatedNextProbeDurationMs: 2_194_500,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: false, reason: 'time-reserve' });
    // An already-expired deadline still refuses probe zero.
    expect(
      evaluateProbeAdmission({
        probesUsed: 0,
        elapsedMs: budgets.maxWallTimeMs,
        budgets,
        finalistPurpose: false,
        estimatedNextProbeDurationMs: 1_000,
        effectiveFinalistTimeReserveMs: 300_000,
      })
    ).toEqual({ allowed: false, reason: 'wall-time' });

    const emptyState = createAdaptivePolicyState(basePolicyConfig);
    expect(summarizeAdaptiveTimingAdmission(emptyState)).toMatchObject({
      policy: 'configured-conservative-estimate',
      estimatedNextProbeDurationMs: 1,
    });
    const cellId = emptyState.cells[0]!.id;
    const observedState = {
      ...emptyState,
      evidence: [
        evidence(0, { cellId, gpuLayers: 4, durationMs: 10 }),
        evidence(1, { cellId, gpuLayers: 4, durationMs: 30 }),
        evidence(2, {
          cellId,
          gpuLayers: 8,
          durationMs: 100,
          operationalStatus: 'request-timeout',
          terminatedAtAdaptiveCap: true,
        }),
        evidence(3, {
          cellId,
          gpuLayers: 6,
          durationMs: 1_000,
          resourceDriftStatus: 'material',
        }),
      ],
    };
    expect(summarizeAdaptiveTimingAdmission(observedState)).toMatchObject({
      policy: 'observed-comparable-launches',
      estimatedNextProbeDurationMs: 20,
    });
  });

  it('keeps cells competitive until direct boundaries and uses the symmetric active window', () => {
    expect(
      competitiveObservedRatio({ contextPreferenceActive: false, kvPreferenceActive: false })
    ).toBeCloseTo(1.575);
    expect(
      competitiveObservedRatio({ contextPreferenceActive: true, kvPreferenceActive: true })
    ).toBeCloseTo(1.65);
    expect(
      isAdaptiveCellCompetitive({
        hasDirectBoundary: false,
        cellBestDirectScoreMs: 999,
        globalBestDirectScoreMs: 100,
        triggeredNonMonotoneCandidate: false,
        contextPreferenceActive: true,
        kvPreferenceActive: false,
      })
    ).toBe(true);
    expect(
      isAdaptiveCellCompetitive({
        hasDirectBoundary: true,
        cellBestDirectScoreMs: 166,
        globalBestDirectScoreMs: 100,
        triggeredNonMonotoneCandidate: false,
        contextPreferenceActive: true,
        kvPreferenceActive: false,
      })
    ).toBe(false);
  });

  it('reserves only the largest mutually exclusive winner-validation tail across resolved cells', () => {
    const created = createAdaptivePolicyState({
      profiles: [
        { profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 },
        { profileIndex: 1, contextSize: 12_288, parallelRequests: 2, autoGpuLayers: 4 },
      ],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: true,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 100_000,
      budgetOverrides: { maxProbes: 30, maxWallTimeMs: 3_000_000 },
    });
    const trace = created.cells.flatMap((cell, cellIndex) => [
      evidence(cellIndex * 3, {
        cellId: cell.id,
        gpuLayers: 4,
        scoreMs: 100 + cellIndex,
        durationMs: 100_000,
      }),
      evidence(cellIndex * 3 + 1, {
        cellId: cell.id,
        gpuLayers: 4,
        fidelity: 'full',
        scoreMs: 100 + cellIndex,
        durationMs: 100_000,
      }),
      evidence(cellIndex * 3 + 2, {
        cellId: cell.id,
        gpuLayers: 5,
        operationalStatus: 'oom',
        memoryEvidence: 'confirmed',
        scoreMs: undefined,
        boundaryDecision: 'unsuitable',
        durationMs: 100_000,
      }),
    ]);

    expect(
      summarizeAdaptiveTimingAdmission({ ...created, evidence: trace, elapsedMs: 1_200_000 })
    ).toMatchObject({ effectiveFinalistTimeReserveMs: 600_000 });
  });

  it('requires a stable slower lower denominator before two caps can close high', () => {
    const lower = [
      evidence(0, { cellId: 'cell', gpuLayers: 4, scoreMs: 100 }),
      evidence(1, { cellId: 'cell', gpuLayers: 4, scoreMs: 120 }),
    ];
    const stable = findStableCliffReference(lower, 'cell', 8);
    expect(stable).toMatchObject({
      status: 'eligible',
      gpuLayers: 4,
      denominatorScoreMs: 120,
    });
    const firstCap = evidence(2, {
      cellId: 'cell',
      gpuLayers: 8,
      operationalStatus: 'request-timeout',
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 190,
      boundaryDecision: 'ambiguous',
    });
    const secondCap: AdaptiveProbeObservation = {
      cellId: 'cell',
      gpuLayers: 8,
      purpose: 'ambiguity-repeat',
      fidelity: 'search',
      operationalStatus: 'request-timeout',
      memoryEvidence: 'none',
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 181,
      durationMs: 1,
    };
    expect(canCloseCappedPoint([...lower, firstCap], secondCap, stable)).toBe(true);
    expect(classifyAdaptiveObservation([...lower, firstCap], secondCap)).toEqual({
      boundaryDecision: 'unsuitable',
      reason: 'reproduced-capped-gross-regression',
    });
    expect(
      canCloseCappedPoint(
        [...lower, firstCap],
        { ...secondCap, aggregateLowerBoundMs: 180 },
        stable
      )
    ).toBe(false);
  });

  it('uses the reproduced slower lower score for successful cliff classification', () => {
    const lower = [
      evidence(0, { cellId: 'cell', gpuLayers: 4, scoreMs: 100 }),
      evidence(1, { cellId: 'cell', gpuLayers: 4, scoreMs: 120 }),
    ];
    const withinConservativeLimit: AdaptiveProbeObservation = {
      cellId: 'cell',
      gpuLayers: 8,
      purpose: 'boundary',
      fidelity: 'search',
      operationalStatus: 'ok',
      memoryEvidence: 'none',
      scoreMs: 170,
      durationMs: 1,
    };

    expect(classifyAdaptiveObservation(lower, withinConservativeLimit)).toEqual({
      boundaryDecision: 'admissible',
      reason: 'completed-within-cliff-limit',
    });
    expect(classifyAdaptiveObservation(lower, { ...withinConservativeLimit, scoreMs: 0 })).toEqual({
      boundaryDecision: 'ambiguous',
      reason: 'missing-or-invalid-score',
    });
  });

  it('never lets materially drifted evidence reproduce a non-memory boundary failure', () => {
    const lower = [
      evidence(0, { cellId: 'cell', gpuLayers: 4, scoreMs: 100 }),
      evidence(1, { cellId: 'cell', gpuLayers: 4, scoreMs: 100 }),
    ];
    const driftedCap = evidence(2, {
      cellId: 'cell',
      gpuLayers: 8,
      operationalStatus: 'request-timeout',
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 200,
      resourceDriftStatus: 'material',
      boundaryDecision: 'ambiguous',
    });
    const cap: AdaptiveProbeObservation = {
      cellId: 'cell',
      gpuLayers: 8,
      purpose: 'ambiguity-repeat',
      fidelity: 'search',
      operationalStatus: 'request-timeout',
      memoryEvidence: 'unknown',
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 200,
      durationMs: 1,
    };
    expect(classifyAdaptiveObservation([...lower, driftedCap], cap)).toMatchObject({
      boundaryDecision: 'ambiguous',
      reason: 'adaptive-cap',
    });
    expect(
      classifyAdaptiveObservation([...lower], { ...cap, resourceDriftStatus: 'material' })
    ).toEqual({ boundaryDecision: 'ambiguous', reason: 'resource-drift' });

    const driftedGross = evidence(3, {
      cellId: 'cell',
      gpuLayers: 8,
      scoreMs: 200,
      resourceDriftStatus: 'material',
      boundaryDecision: 'ambiguous',
    });
    expect(
      classifyAdaptiveObservation([...lower, driftedGross], {
        ...cap,
        operationalStatus: 'ok',
        terminatedAtAdaptiveCap: false,
        aggregateLowerBoundMs: undefined,
        scoreMs: 200,
      })
    ).toEqual({ boundaryDecision: 'ambiguous', reason: 'first-performance-cliff' });

    const driftedFailure = evidence(4, {
      cellId: 'cell',
      gpuLayers: 8,
      operationalStatus: 'request-timeout',
      scoreMs: undefined,
      resourceDriftStatus: 'material',
      boundaryDecision: 'ambiguous',
    });
    expect(
      classifyAdaptiveObservation([driftedFailure], {
        ...cap,
        terminatedAtAdaptiveCap: false,
        aggregateLowerBoundMs: undefined,
      })
    ).toEqual({ boundaryDecision: 'ambiguous', reason: 'generic-operational-failure' });
  });

  it('lets an inconclusive second capped launch continue in place and classify its full outcome', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const append = (overrides: Partial<AdaptiveProbeObservation>): void => {
      const action = nextAdaptivePolicyAction(state);
      expect(action.kind).toBe('probe');
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: 'ok',
        memoryEvidence: 'none',
        scoreMs: 100,
        durationMs: 1,
        ...overrides,
      });
    };
    append({ scoreMs: 100 });
    append({
      operationalStatus: 'request-timeout',
      scoreMs: undefined,
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 190,
    });
    append({ scoreMs: 110 });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      timeoutMode: 'adaptive-with-full-continuation',
    });
    append({ scoreMs: 130, terminatedAtAdaptiveCap: false });

    expect(state.evidence.filter((item) => item.gpuLayers === 8)).toHaveLength(2);
    expect(state.evidence.at(-1)).toMatchObject({
      boundaryDecision: 'admissible',
      decisionReason: 'completed-within-cliff-limit',
    });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'probe',
      gpuLayers: 8,
      purpose: 'finalist',
    });
  });

  it('repeats a warmup cap directly and treats a second full-timeout failure as unsuitable', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const append = (overrides: Partial<AdaptiveProbeObservation>): void => {
      const action = nextAdaptivePolicyAction(state);
      expect(action.kind).toBe('probe');
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: 'ok',
        memoryEvidence: 'none',
        scoreMs: 100,
        durationMs: 1,
        ...overrides,
      });
    };

    append({ scoreMs: 100 });
    append({
      operationalStatus: 'request-timeout',
      memoryEvidence: 'unknown',
      scoreMs: undefined,
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: undefined,
    });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'probe',
      gpuLayers: 8,
      purpose: 'ambiguity-repeat',
      fidelity: 'full',
      timeoutMode: 'full',
    });
    append({
      operationalStatus: 'request-timeout',
      memoryEvidence: 'unknown',
      scoreMs: undefined,
      terminatedAtAdaptiveCap: false,
    });

    expect(state.evidence.at(-1)).toMatchObject({
      boundaryDecision: 'unsuitable',
      decisionReason: 'reproduced-operational-failure',
    });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({ kind: 'probe', gpuLayers: 6 });
  });

  it('uses persistent ambiguous highs for scheduling and blocks only competitive unresolved cells', () => {
    const makeState = (unresolvedScore: number) => {
      const created = createAdaptivePolicyState({
        profiles: [
          { profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 },
          { profileIndex: 1, contextSize: 12_288, parallelRequests: 2, autoGpuLayers: 4 },
        ],
        totalLayers: 8,
        gpuAvailable: true,
        hasSharedPrefixWorkload: false,
        includeKvCacheComparison: false,
        baselineKvPrecision: 'q8_0',
        unobservedProbeDurationEstimateMs: 1,
        budgetOverrides: { maxProbes: 30, maxWallTimeMs: 3_000_000 },
      });
      const [resolvedCell, unresolvedCell] = created.cells;
      const trace = [
        evidence(0, { cellId: resolvedCell!.id, gpuLayers: 3, scoreMs: 95 }),
        evidence(1, { cellId: resolvedCell!.id, gpuLayers: 4, scoreMs: 92 }),
        evidence(2, { cellId: resolvedCell!.id, gpuLayers: 5, scoreMs: 90 }),
        evidence(3, {
          cellId: resolvedCell!.id,
          gpuLayers: 5,
          fidelity: 'full',
          scoreMs: 90,
        }),
        evidence(4, {
          cellId: resolvedCell!.id,
          gpuLayers: 6,
          operationalStatus: 'oom',
          memoryEvidence: 'confirmed',
          scoreMs: undefined,
          boundaryDecision: 'unsuitable',
        }),
        evidence(5, { cellId: unresolvedCell!.id, gpuLayers: 7, scoreMs: unresolvedScore }),
        evidence(6, {
          cellId: unresolvedCell!.id,
          gpuLayers: 7,
          fidelity: 'full',
          scoreMs: unresolvedScore,
        }),
        evidence(7, {
          cellId: unresolvedCell!.id,
          gpuLayers: 8,
          operationalStatus: 'ok',
          scoreMs: undefined,
          boundaryDecision: 'ambiguous',
          decisionReason: 'missing-or-invalid-score',
        }),
        evidence(8, {
          cellId: unresolvedCell!.id,
          gpuLayers: 8,
          purpose: 'ambiguity-repeat',
          fidelity: 'full',
          operationalStatus: 'ok',
          scoreMs: undefined,
          boundaryDecision: 'ambiguous',
          decisionReason: 'missing-or-invalid-score',
        }),
      ];
      return { ...created, evidence: trace, elapsedMs: trace.length };
    };

    expect(nextAdaptivePolicyAction(makeState(200))).toMatchObject({
      kind: 'terminal',
      status: 'complete',
      selected: { scoreMs: 90 },
    });
    expect(nextAdaptivePolicyAction(makeState(120))).toMatchObject({
      kind: 'terminal',
      status: 'budget-exhausted',
      reason: expect.stringContaining('adjacent higher layer remains ambiguous'),
      provisional: { scoreMs: 90 },
    });
  });

  it('keeps generic failures separate from confirmed memory evidence', () => {
    const timeout: AdaptiveProbeObservation = {
      cellId: 'cell',
      gpuLayers: 8,
      purpose: 'ceiling',
      fidelity: 'search',
      operationalStatus: 'request-timeout',
      memoryEvidence: 'unknown',
      durationMs: 1,
    };
    expect(classifyAdaptiveObservation([], timeout)).toMatchObject({
      boundaryDecision: 'ambiguous',
    });
    const first = evidence(0, {
      ...timeout,
      boundaryDecision: 'ambiguous',
      decisionReason: 'generic-operational-failure',
    });
    expect(classifyAdaptiveObservation([first], timeout)).toEqual({
      boundaryDecision: 'unsuitable',
      reason: 'reproduced-operational-failure',
    });
    expect(classifyAdaptiveObservation([], { ...timeout, memoryEvidence: 'confirmed' })).toEqual({
      boundaryDecision: 'unsuitable',
      reason: 'confirmed-allocation-failure',
    });
    expect(
      classifyAdaptiveObservation([], {
        ...timeout,
        operationalStatus: 'oom',
        memoryEvidence: 'confirmed',
        resourceDriftStatus: 'material',
      })
    ).toEqual({
      boundaryDecision: 'unsuitable',
      reason: 'confirmed-allocation-failure',
    });
  });

  it('keeps material-drift evidence in the trail without poisoning a clean repeated point', () => {
    const drifted = evidence(0, {
      fidelity: 'full',
      operationalStatus: 'ok',
      scoreMs: 500,
      resourceDriftStatus: 'material',
      boundaryDecision: 'ambiguous',
      decisionReason: 'resource-drift',
    });
    const cleanOne = evidence(1, {
      fidelity: 'full',
      operationalStatus: 'ok',
      scoreMs: 100,
      resourceDriftStatus: 'available',
    });
    const cleanTwo = evidence(2, {
      fidelity: 'full',
      operationalStatus: 'ok',
      scoreMs: 104,
      resourceDriftStatus: 'available',
    });

    expect(assessMixedFidelityStability([drifted, cleanOne, cleanTwo])).toMatchObject({
      status: 'stable',
      recommendationScoreMs: 102,
      evidenceIndices: [1, 2],
    });
  });

  it('uses all search launches with one full launch, then all full launches only', () => {
    const point = [
      evidence(0, { cellId: 'cell', gpuLayers: 8, scoreMs: 100 }),
      evidence(1, { cellId: 'cell', gpuLayers: 8, scoreMs: 130 }),
      evidence(2, { cellId: 'cell', gpuLayers: 8, scoreMs: 105, fidelity: 'full' }),
    ];
    expect(assessMixedFidelityStability(point)).toMatchObject({ status: 'unstable' });
    expect(
      assessMixedFidelityStability([
        ...point,
        evidence(3, { cellId: 'cell', gpuLayers: 8, scoreMs: 110, fidelity: 'full' }),
      ])
    ).toMatchObject({ status: 'stable', recommendationScoreMs: 107.5 });
  });

  it('includes comparable ambiguous full launches in stability spread without using them in the median', () => {
    const point = [
      evidence(0, { cellId: 'cell', gpuLayers: 8, scoreMs: 90 }),
      evidence(1, {
        cellId: 'cell',
        gpuLayers: 8,
        scoreMs: 160,
        fidelity: 'full',
        boundaryDecision: 'ambiguous',
      }),
      evidence(2, { cellId: 'cell', gpuLayers: 8, scoreMs: 90, fidelity: 'full' }),
    ];

    expect(assessMixedFidelityStability(point)).toMatchObject({
      status: 'unstable',
      recommendationScoreMs: 90,
      evidenceIndices: [1, 2],
    });
  });

  it('does not let an excluded drifted full launch consume the clean reproduction slot', () => {
    const created = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      fixedGpuLayers: 4,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const cellId = created.cells[0]!.id;
    const trace = [
      evidence(0, { cellId, gpuLayers: 4, scoreMs: 100 }),
      evidence(1, {
        cellId,
        gpuLayers: 4,
        fidelity: 'full',
        scoreMs: 500,
        resourceDriftStatus: 'material',
        boundaryDecision: 'ambiguous',
      }),
      evidence(2, { cellId, gpuLayers: 4, fidelity: 'full', scoreMs: 123 }),
    ];

    expect(nextAdaptivePolicyAction({ ...created, evidence: trace, elapsedMs: 3 })).toMatchObject({
      kind: 'probe',
      purpose: 'winner-validation',
      fidelity: 'full',
      gpuLayers: 4,
    });
  });

  it('does not let an older ambiguous high mask a nearer resolved unsuitable high', () => {
    const created = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 6 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const cellId = created.cells[0]!.id;
    const trace = [
      evidence(0, { cellId, gpuLayers: 6, scoreMs: 100 }),
      evidence(1, { cellId, gpuLayers: 6, fidelity: 'full', scoreMs: 100 }),
      evidence(2, {
        cellId,
        gpuLayers: 7,
        operationalStatus: 'oom',
        memoryEvidence: 'confirmed',
        scoreMs: undefined,
        boundaryDecision: 'unsuitable',
      }),
      evidence(3, {
        cellId,
        gpuLayers: 8,
        scoreMs: undefined,
        boundaryDecision: 'ambiguous',
        decisionReason: 'missing-or-invalid-score',
      }),
      evidence(4, {
        cellId,
        gpuLayers: 8,
        purpose: 'ambiguity-repeat',
        fidelity: 'full',
        scoreMs: undefined,
        boundaryDecision: 'ambiguous',
        decisionReason: 'missing-or-invalid-score',
      }),
    ];

    expect(
      summarizeAdaptiveCellStates({ ...created, evidence: trace, elapsedMs: 5 })[0]
    ).toMatchObject({ phase: 'resolved', boundaryGpuLayers: 6, highGpuLayers: 7 });
  });

  it('skips finalist work for a clearly uncompetitive direct boundary', () => {
    const created = createAdaptivePolicyState({
      profiles: [
        { profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 },
        { profileIndex: 1, contextSize: 12_288, parallelRequests: 2, autoGpuLayers: 4 },
      ],
      totalLayers: 8,
      gpuAvailable: true,
      fixedGpuLayers: 4,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const [fast, slow] = created.cells;
    const trace = [
      evidence(0, { cellId: fast!.id, gpuLayers: 4, scoreMs: 100 }),
      evidence(1, { cellId: fast!.id, gpuLayers: 4, fidelity: 'full', scoreMs: 100 }),
      evidence(2, { cellId: slow!.id, gpuLayers: 4, scoreMs: 200 }),
    ];

    expect(nextAdaptivePolicyAction({ ...created, evidence: trace, elapsedMs: 3 })).toMatchObject({
      kind: 'terminal',
      status: 'complete',
      selected: { cellId: fast!.id },
    });
  });

  it('derives source-only context/SWA/KV ceiling hints with memory provenance', () => {
    const cells = enumerateAdaptiveCells({
      ...baseEnumeration,
      profiles: [
        { profileIndex: 0, contextSize: 10_240, parallelRequests: 2, autoGpuLayers: 40 },
        { profileIndex: 1, contextSize: 16_384, parallelRequests: 2, autoGpuLayers: 40 },
      ],
      includeKvCacheComparison: true,
      kvTransferCompatible: true,
    });
    const source = cells.find(
      (cell) => cell.contextSize === 10_240 && !cell.swaFull && cell.kvPrecision === 'q8_0'
    )!;
    const sourceFailure = evidence(0, {
      cellId: source.id,
      gpuLayers: 42,
      operationalStatus: 'oom',
      memoryEvidence: 'confirmed',
      boundaryDecision: 'unsuitable',
    });
    const hints = deriveCeilingHints(cells, [sourceFailure]);

    expect(hints.some((hint) => hint.axis === 'context')).toBe(true);
    expect(hints.some((hint) => hint.axis === 'swa')).toBe(true);
    expect(hints.some((hint) => hint.axis === 'kv')).toBe(true);
    expect(hints.every((hint) => hint.kind === 'hard-high-hypothesis')).toBe(true);
  });

  it('keeps unequal context/KV fallback non-empty and inside the context band', () => {
    const result = resolveAdaptiveRecommendation(
      [
        candidate(100),
        candidate(107, {
          cellId: 'large-q8',
          cellOrder: 1,
          profileIndex: 1,
          contextSize: 16_384,
          kvPrecision: 'q8_0',
        }),
        candidate(108, {
          cellId: 'large-f16',
          cellOrder: 2,
          profileIndex: 1,
          contextSize: 16_384,
          kvPrecision: 'f16',
        }),
      ],
      {
        contextPreferencePct: 10,
        kvPrecisionPreferencePct: 5,
        tieTolerancePct: 5,
        contextPreferenceActive: true,
        kvPreferenceActive: true,
      }
    );

    expect(result.kvPrecisionPreferenceResolution).toBe('fallback-no-joint-eligible');
    expect(result.selected).toMatchObject({ cellId: 'large-q8', scoreMs: 107 });
    expect(result.finalEquivalenceSet.length).toBeGreaterThan(0);
    expect(result.finalEquivalenceSet.every((item) => item.scoreMs <= result.contextBand!)).toBe(
      true
    );
  });

  it('anchors product bands globally and never lets structural ties escape them', () => {
    const result = resolveAdaptiveRecommendation(
      [
        candidate(100),
        candidate(109, {
          cellId: 'preferred-fast',
          cellOrder: 1,
          profileIndex: 1,
          contextSize: 16_384,
          kvPrecision: 'f16',
          gpuLayers: 45,
        }),
        candidate(114, {
          cellId: 'preferred-low-pressure',
          cellOrder: 2,
          profileIndex: 1,
          contextSize: 16_384,
          kvPrecision: 'f16',
          gpuLayers: 40,
        }),
      ],
      {
        contextPreferencePct: 10,
        kvPrecisionPreferencePct: 10,
        tieTolerancePct: 5,
        contextPreferenceActive: true,
        kvPreferenceActive: true,
      }
    );

    expect(result.selected?.cellId).toBe('preferred-fast');
    expect(result.finalEquivalenceSet.map((item) => item.scoreMs)).toEqual([109]);
  });

  it('requires and evaluates the materially lower winner reference guard', () => {
    const selected = candidate(100, { gpuLayers: 40 });
    expect(evaluateReferenceGuard(selected, [], 48)).toEqual({
      status: 'probe-required',
      targetGpuLayers: 35,
    });
    const guard = evidence(0, {
      cellId: selected.cellId,
      gpuLayers: 35,
      purpose: 'reference-guard',
      scoreMs: 75,
    });
    expect(evaluateReferenceGuard(selected, [guard], 48)).toMatchObject({
      status: 'satisfied',
      targetGpuLayers: 35,
      promotionGpuLayers: 35,
    });
    expect(evaluateReferenceGuard(selected, [], 48, ADAPTIVE_POLICY_DEFAULTS, true)).toEqual({
      status: 'not-applicable',
      targetGpuLayers: 40,
      reason: 'fixed-gpu-layers',
    });
  });

  it('never varies a fixed GPU layer and reports the reference guard not applicable', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 8 }],
      totalLayers: 8,
      gpuAvailable: true,
      fixedGpuLayers: 4,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 10, maxWallTimeMs: 2_000_000 },
    });
    for (const [fidelity, score] of [
      ['search', 100],
      ['full', 101],
    ] as const) {
      const action = nextAdaptivePolicyAction(state);
      expect(action).toMatchObject({ kind: 'probe', gpuLayers: 4, fidelity });
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: 'ok',
        memoryEvidence: 'none',
        scoreMs: score,
        durationMs: 1,
      });
    }
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'terminal',
      status: 'complete',
      selected: { gpuLayers: 4 },
      referenceGuard: { status: 'not-applicable', reason: 'fixed-gpu-layers' },
    });
    expect(state.evidence.every((item) => item.gpuLayers === 4)).toBe(true);
  });

  it('runs a deterministic ordinary bisection trace through finalist, guard, and fallback', () => {
    const cell = traceCell(8192, 'window', 'q8_0');
    const rows: readonly AdaptiveTraceRow[] = [
      [cell, 4, 'reference', 'search', 'ok', 100, 'admissible'],
      [cell, 8, 'ceiling', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [cell, 6, 'boundary', 'search', 'ok', 90, 'admissible'],
      [cell, 7, 'boundary', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [cell, 6, 'finalist', 'full', 'ok', 91, 'admissible'],
      [cell, 5, 'fallback-validation', 'search', 'ok', 95, 'admissible'],
    ];
    const fixture = defineAdaptiveTrace(
      'ordinary boundary',
      {
        profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
        totalLayers: 8,
        gpuAvailable: true,
        hasSharedPrefixWorkload: false,
        includeKvCacheComparison: false,
        baselineKvPrecision: 'q8_0',
        unobservedProbeDurationEstimateMs: 1,
        budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
      },
      rows
    );
    const result = executeAdaptiveTrace(fixture);

    expect(result.terminal).toMatchObject({
      status: 'complete',
      selected: { gpuLayers: 6 },
      fallback: { gpuLayers: 5, validated: true },
    });
    expect(result.actions.map((action) => action.kind)).toEqual([
      'probe',
      'probe',
      'probe',
      'probe',
      'probe',
      'probe',
      'terminal',
    ]);
  });

  it('never reproduces a point across a resource-regime change', () => {
    const cellId = 'cell';
    const before = [
      evidence(0, { cellId, gpuLayers: 40, fidelity: 'full', scoreMs: 100, resourceRegime: 0 }),
      evidence(1, { cellId, gpuLayers: 40, fidelity: 'full', scoreMs: 104, resourceRegime: 0 }),
    ];
    // Two agreeing full-fidelity launches in one regime reproduce the point.
    expect(assessMixedFidelityStability(before)).toMatchObject({ status: 'stable' });

    // A confirmed step change re-anchors the reference. The newest regime now has
    // a single launch, so the point is no longer reproduced and needs another
    // launch under the current conditions - the earlier pair cannot stand in.
    const afterStep = [
      ...before,
      evidence(2, { cellId, gpuLayers: 40, fidelity: 'full', scoreMs: 103, resourceRegime: 1 }),
    ];
    expect(assessMixedFidelityStability(afterStep)).toMatchObject({ status: 'insufficient' });

    // Once the new regime has its own agreeing pair, it reproduces again, and the
    // recommendation score comes only from that regime.
    const settled = [
      ...afterStep,
      evidence(3, { cellId, gpuLayers: 40, fidelity: 'full', scoreMs: 107, resourceRegime: 1 }),
    ];
    const resolved = assessMixedFidelityStability(settled);
    expect(resolved).toMatchObject({ status: 'stable' });
    expect(resolved.recommendationScoreMs).toBe(105);
    expect(resolved.evidenceIndices).toEqual([2, 3]);
  });

  it('explores a second cell rather than pruning it on a slow low-layer reference', () => {
    // Regression for the 2026-08-02 live run: the swa-full cell was abandoned in
    // `establishing-ceiling` after one ngl=19 reference, because the interim low
    // was treated as a converged boundary. At ngl=19 almost the whole model is on
    // CPU, so that score measures offload level rather than the cell's own axis:
    // the windowed cell improved 10102 -> 3205 ms across exactly that span.
    const windowCell = traceCell(12_288, 'window', 'q8_0');
    const fullCell = traceCell(12_288, 'full', 'q8_0');
    const config: AdaptivePolicyConfig = {
      ...basePolicyConfig,
      profiles: [{ ...basePolicyConfig.profiles[0]!, autoGpuLayers: 19 }],
    };
    const rows: readonly AdaptiveTraceRow[] = [
      [windowCell, 19, 'reference', 'search', 'ok', 10_102, 'admissible'],
      [windowCell, 48, 'ceiling', 'search', 'ok', 3_205, 'admissible'],
      [windowCell, 48, 'finalist', 'full', 'ok', 3_834, 'admissible'],
      [fullCell, 19, 'reference', 'search', 'ok', 17_612, 'admissible'],
      [fullCell, 48, 'ceiling', 'search', 'ok', 5_200, 'admissible'],
      [fullCell, 48, 'finalist', 'full', 'ok', 5_300, 'admissible'],
    ];
    const result = executeAdaptiveTrace(
      defineAdaptiveTrace('slow low-layer reference', config, rows)
    );

    expect(result.terminal).toMatchObject({
      status: 'complete',
      selected: { gpuLayers: 48, swaFull: false },
    });
    expect(
      result.state.evidence
        .filter((item) => item.cellId.includes('swa-full'))
        .map((item) => item.gpuLayers)
    ).toEqual([19, 48, 48]);
  });

  it('still prunes a cell once its own converged boundary is uncompetitive', () => {
    // The cut-off is preserved: it just compares the cell's converged boundary
    // instead of its reference, so no finalist launch is spent on the loser.
    const windowCell = traceCell(12_288, 'window', 'q8_0');
    const fullCell = traceCell(12_288, 'full', 'q8_0');
    const config: AdaptivePolicyConfig = {
      ...basePolicyConfig,
      profiles: [{ ...basePolicyConfig.profiles[0]!, autoGpuLayers: 19 }],
    };
    const rows: readonly AdaptiveTraceRow[] = [
      [windowCell, 19, 'reference', 'search', 'ok', 10_102, 'admissible'],
      [windowCell, 48, 'ceiling', 'search', 'ok', 3_205, 'admissible'],
      [windowCell, 48, 'finalist', 'full', 'ok', 3_834, 'admissible'],
      [fullCell, 19, 'reference', 'search', 'ok', 17_612, 'admissible'],
      [fullCell, 48, 'ceiling', 'search', 'ok', 12_000, 'admissible'],
    ];
    const result = executeAdaptiveTrace(
      defineAdaptiveTrace('uncompetitive converged boundary', config, rows)
    );

    expect(result.terminal).toMatchObject({
      status: 'complete',
      selected: { gpuLayers: 48, swaFull: false },
    });
    // 12000 exceeds 3834 * 1.575, so the cell is dropped without a finalist launch.
    expect(
      result.state.evidence.filter(
        (item) => item.cellId.includes('swa-full') && item.fidelity === 'full'
      )
    ).toHaveLength(0);
  });

  it('replays a supplemented q8 trace and selects reproduced full-SWA g=45', () => {
    const window = traceCell(12_288, 'window', 'q8_0');
    const full = traceCell(12_288, 'full', 'q8_0');
    const rows: readonly AdaptiveTraceRow[] = [
      [window, 45, 'reference', 'search', 'ok', 3.5, 'admissible'],
      [window, 48, 'ceiling', 'search', 'ok', 3.3, 'admissible'],
      [window, 48, 'finalist', 'full', 'timeout', undefined, 'ambiguous'],
      [window, 48, 'ambiguity-repeat', 'full', 'timeout', undefined, 'unsuitable'],
      [window, 46, 'boundary', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [window, 45, 'finalist', 'full', 'ok', 3.5, 'admissible'],
      [full, 45, 'reference', 'search', 'ok', 3.31, 'admissible'],
      [full, 46, 'ceiling', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [full, 45, 'finalist', 'full', 'ok', 3.32, 'admissible'],
      [full, 40, 'reference-guard', 'search', 'ok', 3.6, 'admissible'],
      [full, 44, 'fallback-validation', 'search', 'ok', 3.7, 'admissible'],
    ];
    const result = executeAdaptiveTrace(
      defineAdaptiveTrace('supplemented q8 trace', basePolicyConfig, rows)
    );

    expect(result.terminal).toMatchObject({
      status: 'complete',
      selected: { gpuLayers: 45, swaFull: true },
    });
    expect(result.state.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cellId: expect.stringContaining('swa-window'),
          gpuLayers: 48,
          boundaryDecision: 'unsuitable',
        }),
      ])
    );
  });

  it('promotes a materially faster interior point without expanding to its neighbors', () => {
    const cell = traceCell(8192, 'window', 'q8_0');
    const rows: readonly AdaptiveTraceRow[] = [
      [cell, 4, 'reference', 'search', 'ok', 80, 'admissible'],
      [cell, 10, 'ceiling', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [cell, 7, 'boundary', 'search', 'ok', 100, 'admissible'],
      [cell, 8, 'boundary', 'search', 'confirmed-oom', undefined, 'unsuitable'],
      [cell, 7, 'finalist', 'full', 'ok', 100, 'admissible'],
      [cell, 4, 'winner-validation', 'full', 'ok', 82, 'admissible'],
      [cell, 2, 'reference-guard', 'search', 'ok', 85, 'admissible'],
    ];
    const result = executeAdaptiveTrace(
      defineAdaptiveTrace(
        'non-monotone interior',
        {
          profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
          totalLayers: 10,
          gpuAvailable: true,
          hasSharedPrefixWorkload: false,
          includeKvCacheComparison: false,
          baselineKvPrecision: 'q8_0',
          unobservedProbeDurationEstimateMs: 1,
          budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
        },
        rows
      )
    );

    expect(result.terminal).toMatchObject({
      status: 'complete',
      selected: { gpuLayers: 4, source: 'non-monotone' },
    });
    expect(result.state.evidence.some((item) => [3, 5].includes(item.gpuLayers))).toBe(false);
  });

  it('drives the capped-repeat controller through lower-reference reproduction without a third high launch', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const append = (overrides: Partial<AdaptiveProbeObservation>): void => {
      const action = nextAdaptivePolicyAction(state);
      expect(action.kind).toBe('probe');
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: 'ok',
        memoryEvidence: 'none',
        scoreMs: 100,
        durationMs: 1,
        ...overrides,
      });
    };
    append({ scoreMs: 100 });
    append({
      operationalStatus: 'request-timeout',
      scoreMs: undefined,
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 190,
    });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'probe',
      gpuLayers: 4,
      purpose: 'ambiguity-repeat',
    });
    append({ scoreMs: 110 });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'probe',
      gpuLayers: 8,
      purpose: 'ambiguity-repeat',
      timeoutMode: 'adaptive-with-full-continuation',
    });
    append({
      operationalStatus: 'request-timeout',
      scoreMs: undefined,
      terminatedAtAdaptiveCap: true,
      aggregateLowerBoundMs: 180,
    });

    expect(state.evidence.filter((item) => item.gpuLayers === 8)).toHaveLength(2);
    expect(state.evidence.at(-1)).toMatchObject({ boundaryDecision: 'unsuitable' });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({ kind: 'probe', gpuLayers: 6 });
  });

  it('uses a lower-memory source ceiling as the receiving cell reference ceiling, never as bracket evidence', () => {
    let state = createAdaptivePolicyState({
      profiles: [
        { profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 },
        { profileIndex: 1, contextSize: 16_384, parallelRequests: 2, autoGpuLayers: 8 },
      ],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 24, maxWallTimeMs: 3_000_000 },
    });
    const append = (
      operationalStatus: AdaptiveProbeObservation['operationalStatus'],
      scoreMs?: number
    ): void => {
      const action = nextAdaptivePolicyAction(state);
      expect(action.kind).toBe('probe');
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus,
        memoryEvidence: operationalStatus === 'oom' ? 'confirmed' : 'none',
        scoreMs,
        durationMs: 1,
      });
    };
    append('ok', 100); // small reference g4
    append('oom'); // small physical ceiling g8
    append('oom'); // small bisection g6
    append('ok', 95); // small boundary g5
    append('ok', 96); // small full-fidelity g5

    const next = nextAdaptivePolicyAction(state);
    expect(next).toMatchObject({
      kind: 'probe',
      gpuLayers: 6,
      purpose: 'reference',
      inheritedCeiling: { axis: 'context', sourceCellId: state.cells[0]!.id },
    });
    const receivingSummary = summarizeAdaptiveCellStates(state)[1]!;
    expect(receivingSummary.phase).toBe('finding-reference');
    expect(receivingSummary).not.toHaveProperty('lowGpuLayers');
    expect(receivingSummary).not.toHaveProperty('highGpuLayers');

    if (next.kind !== 'probe') return;
    state = applyAdaptivePolicyObservation(state, {
      cellId: next.cellId,
      gpuLayers: next.gpuLayers,
      purpose: next.purpose,
      fidelity: next.fidelity,
      operationalStatus: 'ok',
      memoryEvidence: 'none',
      scoreMs: 90,
      durationMs: 1,
    });
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'probe',
      cellId: state.cells[1]!.id,
      gpuLayers: 8,
      purpose: 'ceiling',
    });
  });

  it('descends references through g=0 before returning no viable candidate', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { maxProbes: 20, maxWallTimeMs: 2_000_000 },
    });
    const attempted: number[] = [];
    while (true) {
      const action = nextAdaptivePolicyAction(state);
      if (action.kind === 'terminal') {
        expect(action).toMatchObject({ status: 'no-viable-candidate' });
        break;
      }
      attempted.push(action.gpuLayers);
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: 'oom',
        memoryEvidence: 'confirmed',
        durationMs: 1,
      });
    }
    expect(attempted).toEqual([4, 2, 1, 0]);
  });

  it('returns budget exhausted instead of weakening unresolved boundary evidence', () => {
    let state = createAdaptivePolicyState({
      profiles: [{ profileIndex: 0, contextSize: 8192, parallelRequests: 2, autoGpuLayers: 4 }],
      totalLayers: 8,
      gpuAvailable: true,
      hasSharedPrefixWorkload: false,
      includeKvCacheComparison: false,
      baselineKvPrecision: 'q8_0',
      unobservedProbeDurationEstimateMs: 1,
      budgetOverrides: { targetProbes: 5, maxProbes: 5, maxWallTimeMs: 2_000_000 },
    });
    for (const result of ['ok', 'oom', 'oom'] as const) {
      const action = nextAdaptivePolicyAction(state);
      expect(action.kind).toBe('probe');
      if (action.kind !== 'probe') return;
      state = applyAdaptivePolicyObservation(state, {
        cellId: action.cellId,
        gpuLayers: action.gpuLayers,
        purpose: action.purpose,
        fidelity: action.fidelity,
        operationalStatus: result,
        memoryEvidence: result === 'oom' ? 'confirmed' : 'none',
        scoreMs: result === 'ok' ? 100 : undefined,
        durationMs: 1,
      });
    }
    expect(nextAdaptivePolicyAction(state)).toMatchObject({
      kind: 'terminal',
      status: 'budget-exhausted',
      reason: expect.stringContaining('launch-reserve'),
    });
  });
});
