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
      resourceDriftThresholdPct: 25,
      resourceDriftRetries: 1,
      unobservedProbeDurationPolicy: 'configured-conservative-estimate',
      policyVersion: 'llama-runtime-v2',
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
