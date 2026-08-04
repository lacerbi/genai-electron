import {
  BINARY_VERSIONS,
  LLAMA_CALIBRATION_DEFAULTS,
  resolveLlamaCalibrationTimeBudget,
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
      policyVersion: 'llama-runtime-v4',
      adaptiveMaxWallTimeMs: 3_600_000,
      maxRunnerStartAttempts: 2,
      capacityCheckTimeoutCapMs: 5_000,
      processExitConfirmationMs: 2_000,
      processExitSettleGraceMs: 250,
      maxCandidates: 10,
    });
  });

  it('pins the frozen resource-stability protocol values approved on 2026-08-02', () => {
    // These are exported policy constants, not caller-configurable calibration fields: a report
    // that claims policy `llama-runtime-v4` must have been produced by exactly this protocol.
    expect(LLAMA_CALIBRATION_DEFAULTS.hostMemoryDecreaseThresholdPct).toBe(10);
    expect(LLAMA_CALIBRATION_DEFAULTS.hostMemoryIncreaseThresholdPct).toBe(20);
    expect(LLAMA_CALIBRATION_DEFAULTS.vramDecreaseThresholdPct).toBe(10);
    expect(LLAMA_CALIBRATION_DEFAULTS.vramIncreaseThresholdPct).toBe(10);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSettleMs).toBe(5_000);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceCooldownMs).toBe(750);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceTelemetryTimeoutMs).toBe(10_000);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceBaselineSamples).toBe(3);
    expect(LLAMA_CALIBRATION_DEFAULTS.resourceDriftConfirmationReads).toBe(1);
    expect(LLAMA_CALIBRATION_DEFAULTS.policyVersion).toBe('llama-runtime-v4');
  });

  it('exposes no field that would let a caller weaken or disable the guard', () => {
    // Confirmation cannot be switched off, and no key hints that any of this is per-call tunable.
    // (The compile-time half - that a calibration config literal rejects these names - lives in
    // public-types.test.ts.)
    const tunableLookingKeys = Object.keys(LLAMA_CALIBRATION_DEFAULTS).filter((key) =>
      /(disable|skip|override|enabled|allowUnverified)/i.test(key)
    );
    expect(tunableLookingKeys).toEqual([]);
  });

  it('removes every re-anchoring resource key the fixed-baseline guard replaced', () => {
    // Re-anchoring is gone, so a build that still reads these keys must fail loudly rather than
    // silently fall back to `undefined` inside a threshold comparison.
    for (const removed of [
      'resourceDriftThresholdPct',
      'resourceSettledTolerancePct',
      'resourceDriftRetries',
      'unobservedProbeDurationPolicy',
      'adaptiveAdmissionMarginMultiplier',
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

  it('resolves a fixed time budget with no default probe cap', () => {
    expect(resolveLlamaCalibrationTimeBudget()).toEqual({
      maxWallTimeMs: 3_600_000,
    });
    expect(resolveLlamaCalibrationTimeBudget({ maxWallTimeMs: 5_400_000, maxProbes: 7 })).toEqual({
      maxWallTimeMs: 5_400_000,
      maxProbes: 7,
    });
    expect(resolveLlamaCalibrationTimeBudget({ maxWallTimeMs: Number.MAX_SAFE_INTEGER })).toEqual({
      maxWallTimeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(JSON.stringify(resolveLlamaCalibrationTimeBudget())).not.toMatch(
      /Infinity|9007199254740991/
    );
  });

  it.each([
    ['maxWallTimeMs', 0],
    ['maxWallTimeMs', 1.5],
    ['maxProbes', 0],
    ['maxProbes', Number.POSITIVE_INFINITY],
  ] as const)('rejects invalid time-budget override %s=%p', (field, value) => {
    expect(() => resolveLlamaCalibrationTimeBudget({ [field]: value })).toThrow(
      new RegExp(`${field} must be a positive safe integer`)
    );
  });
});
