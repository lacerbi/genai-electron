import {
  BINARY_VERSIONS,
  LLAMA_CALIBRATION_DEFAULTS,
  resolveLlamaCalibrationBudgetDefaults,
  type BinaryVariantConfig,
} from '../../src/config/defaults.js';

describe('binary defaults', () => {
  it('keeps every stable-diffusion.cpp asset on the configured release with a SHA-256 pin', () => {
    const config = BINARY_VERSIONS.diffusionCpp;
    const variants: readonly BinaryVariantConfig[] = [
      ...config.variants['darwin-arm64'],
      ...config.variants['win32-x64'],
      ...config.variants['linux-x64'],
    ];
    const releasePrefix = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${config.version}/`;

    expect(config.version).toBe('master-782-b290693');
    expect(config.variants['darwin-x64']).toHaveLength(0);
    expect(variants.map(({ type }) => type)).toEqual([
      'metal',
      'cuda',
      'vulkan',
      'cpu',
      'vulkan',
      'cpu',
    ]);

    for (const variant of variants) {
      expect(variant.url.startsWith(releasePrefix)).toBe(true);
      expect(variant.checksum).toMatch(/^[a-f0-9]{64}$/);

      for (const dependency of variant.dependencies ?? []) {
        expect(dependency.url.startsWith(releasePrefix)).toBe(true);
        expect(dependency.checksum).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });
});

describe('LLM calibration defaults', () => {
  it('freezes the adaptive policy while retaining the generated ladder only for rollback', () => {
    expect(LLAMA_CALIBRATION_DEFAULTS).toMatchObject({
      samples: 3,
      searchSamples: 1,
      seed: 42,
      grossRegressionMultiplier: 1.5,
      earlyStopMultiplier: 2,
      minimumAdaptiveRequestTimeoutMs: 15_000,
      tieTolerancePct: 5,
      contextPreferencePct: 10,
      includeKvCacheComparison: false,
      kvPrecisionPreferencePct: 10,
      searchNoiseAllowancePct: 20,
      nonMonotoneTriggerPct: 20,
      guardDistanceMinLayers: 2,
      guardDistanceFraction: 0.1,
      stabilityTolerancePct: 25,
      hostMemoryDecreaseThresholdPct: 10,
      vramDecreaseThresholdPct: 10,
      hostMemoryIncreaseThresholdPct: 20,
      vramIncreaseThresholdPct: 10,
      resourceBaselineSamples: 3,
      resourceBaselineSettleMs: 5_000,
      resourceDriftConfirmationReads: 1,
      resourceTelemetryTimeoutMs: 10_000,
      resourceCooldownMs: 750,
      unobservedProbeDurationPolicy: 'configured-conservative-estimate',
      policyVersion: 'llama-runtime-v3',
      maxRunnerStartAttempts: 2,
      capacityCheckTimeoutCapMs: 5_000,
      processExitConfirmationMs: 2_000,
      processExitSettleGraceMs: 250,
      adaptiveBudgetFormula: {
        version: 'cell-count-v1',
        minCellCount: 1,
        maxCellCount: 8,
        targetProbesCap: 24,
        targetProbesBase: 6,
        targetProbesPerCell: 2,
        maxProbesCap: 36,
        maxProbesBase: 7,
        maxProbesPerCell: 4,
        finalistReserveCap: 6,
        finalistReserveFloor: 2,
        maxWallTimeCapMs: 4_500_000,
        maxWallTimeBaseMs: 900_000,
        maxWallTimePerCellMs: 450_000,
        finalistTimeReserveCapMs: 900_000,
        finalistTimeReservePerCellMs: 150_000,
      },
      maxCandidates: 10,
    });
  });

  it('removes every re-anchoring resource key the fixed-baseline guard replaced', () => {
    // Re-anchoring is gone, so a build that still reads these keys must fail loudly rather than
    // silently fall back to `undefined` inside a threshold comparison.
    for (const removed of [
      'resourceDriftThresholdPct',
      'resourceSettledTolerancePct',
      'resourceDriftRetries',
    ]) {
      expect(LLAMA_CALIBRATION_DEFAULTS).not.toHaveProperty(removed);
    }
  });

  it('keeps every resource band and schedule value inside its stated invariant', () => {
    const bands = [
      LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct,
      LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct,
      LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct,
      LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct,
    ];
    for (const band of bands) {
      expect(Number.isFinite(band)).toBe(true);
      expect(band).toBeGreaterThan(0);
      expect(band).toBeLessThanOrEqual(100);
    }
    // At least two trusted values are required for a median, and a suspicious reading is never
    // admitted without at least one confirmation.
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples).toBeGreaterThanOrEqual(2);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads).toBeGreaterThanOrEqual(1);
    expect(Number.isSafeInteger(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs)).toBe(true);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs).toBeGreaterThanOrEqual(0);
    for (const duration of [
      LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs,
      LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs,
    ]) {
      expect(Number.isSafeInteger(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0);
    }
  });

  it.each([
    [1, 8, 11, 2, 1_350_000, 150_000],
    [2, 10, 15, 2, 1_800_000, 300_000],
    [4, 14, 23, 4, 2_700_000, 600_000],
    [8, 22, 36, 6, 4_500_000, 900_000],
  ])(
    'resolves cell-count budgets for %i cells',
    (cellCount, targetProbes, maxProbes, finalistReserve, maxWallTimeMs, finalistTimeReserveMs) => {
      expect(resolveLlamaCalibrationBudgetDefaults(cellCount)).toEqual({
        formulaVersion: 'cell-count-v1',
        cellCount,
        targetProbes,
        maxProbes,
        finalistReserve,
        maxWallTimeMs,
        finalistTimeReserveMs,
      });
    }
  );

  it.each([0, 9, 1.5, Number.NaN])('rejects an invalid adaptive cell count %p', (cellCount) => {
    expect(() => resolveLlamaCalibrationBudgetDefaults(cellCount)).toThrow(
      /cellCount must be a safe integer from 1 through 8/
    );
  });
});
