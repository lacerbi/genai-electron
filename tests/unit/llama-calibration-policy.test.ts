import type {
  LlamaCalibrationConfig,
  LlamaCalibrationFixedConfig,
  LlamaCalibrationRun,
  ModelInfo,
  ResolvedLlamaCalibrationConfig,
} from '../../src/types/index.js';
import {
  enumerateAdaptiveCells,
  resolveAdaptiveRecommendation,
} from '../../src/utils/llama-adaptive-calibration-policy.js';
import { getSlidingWindow } from '../../src/utils/model-metadata-helpers.js';
import {
  generateDefaultLlamaCalibrationCombos,
  median,
  recommendLlamaCalibrationRun,
  validateLlamaCalibrationConfig,
  weightedCalibrationScore,
  workloadSignature,
} from '../../src/utils/llama-calibration.js';

const baseConfig: LlamaCalibrationConfig = {
  modelId: 'model',
  profiles: [{ contextSize: 12_288, parallelRequests: 2 }],
  workloads: [
    {
      id: 'chat',
      kind: 'cold-prefill',
      prompt: 'hello',
      nPredict: 32,
    },
  ],
};

const baseline: ResolvedLlamaCalibrationConfig = {
  contextSize: 12_288,
  parallelRequests: 2,
  gpuLayers: 30,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  flashAttention: 'on',
  threads: 8,
};

const exactRawBase = {
  modelId: 'model',
  profile: { contextSize: 12_288, parallelRequests: 2 },
  workloads: baseConfig.workloads,
  combos: [{ overrides: { gpuLayers: 30 } }],
};

function validateRaw(config: unknown) {
  return validateLlamaCalibrationConfig(config as LlamaCalibrationConfig);
}

function run(
  scoreMs: number,
  overrides: LlamaCalibrationRun['combo']['overrides'],
  resolved: Partial<ResolvedLlamaCalibrationConfig> = {}
): LlamaCalibrationRun {
  return {
    combo: { overrides },
    resolvedConfig: { ...baseline, ...resolved },
    status: 'ok',
    workloadResults: [],
    scoreMs,
  };
}

describe('LLM calibration policy', () => {
  describe('validation', () => {
    it('defaults a sole workload weight and protocol settings', () => {
      const result = validateLlamaCalibrationConfig(baseConfig);

      expect(result.strategy).toBe('adaptive');
      expect(result.workloads[0]!.weight).toBe(1);
      expect(result.samples).toBe(3);
      expect(result.seed).toBe(42);
      expect(result.strategy === 'adaptive' && result.includeKvCacheComparison).toBe(false);
      expect(result.kvPrecisionPreferencePct).toBe(10);
    });

    it.each([
      [
        'legacy singular profile without combos',
        {
          modelId: baseConfig.modelId,
          profile: { contextSize: 12_288, parallelRequests: 2 },
          workloads: baseConfig.workloads,
        },
        /profiles: \[profile\]/,
      ],
      [
        'profiles with combos',
        { ...baseConfig, combos: [{ overrides: { gpuLayers: 1 } }] },
        /singular profile/,
      ],
      [
        'simultaneous profile and profiles',
        { ...baseConfig, profile: { contextSize: 12_288, parallelRequests: 2 } },
        /either profile or profiles/,
      ],
      [
        'multiple profiles presented as exact mode',
        {
          ...baseConfig,
          profiles: [
            { contextSize: 8_192, parallelRequests: 2 },
            { contextSize: 12_288, parallelRequests: 2 },
          ],
          combos: [{ overrides: { gpuLayers: 1 } }],
        },
        /singular profile/,
      ],
    ])('rejects the runtime-only %s shape with a targeted error', (_label, raw, expected) => {
      expect(() => validateRaw(raw)).toThrow(expected as RegExp);
    });

    it('validates adaptive profile cardinality, uniqueness, and common slots', () => {
      const invalidProfiles = [
        [],
        [
          { contextSize: 4_096, parallelRequests: 1 },
          { contextSize: 8_192, parallelRequests: 1 },
          { contextSize: 12_288, parallelRequests: 1 },
        ],
      ];
      for (const profiles of invalidProfiles) {
        expect(() =>
          validateLlamaCalibrationConfig({
            ...baseConfig,
            profiles,
          } as unknown as LlamaCalibrationConfig)
        ).toThrow(/one or two/);
      }
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          profiles: [
            { contextSize: 4_096, parallelRequests: 1 },
            { contextSize: 4_096, parallelRequests: 1 },
          ],
        })
      ).toThrow(/unique/);
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          profiles: [
            { contextSize: 4_096, parallelRequests: 1 },
            { contextSize: 8_192, parallelRequests: 2 },
          ],
        })
      ).toThrow(/same parallelRequests/);
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          profiles: [{ contextSize: 4_096, parallelRequests: 4_097 }],
        })
      ).toThrow(/parallelRequests cannot exceed contextSize/);
    });

    it.each([
      ['contextSize', 0],
      ['contextSize', 1.5],
      ['parallelRequests', 0],
      ['parallelRequests', 1.5],
    ] as const)('applies profile numeric validation to adaptive %s=%p', (field, value) => {
      expect(() =>
        validateRaw({
          ...baseConfig,
          profiles: [{ contextSize: 4_096, parallelRequests: 1, [field]: value }],
        })
      ).toThrow(/positive safe integer/);
    });

    it.each([
      ['contextSize', 0],
      ['contextSize', 1.5],
      ['parallelRequests', 0],
      ['parallelRequests', 1.5],
    ] as const)('applies profile numeric validation to exact %s=%p', (field, value) => {
      expect(() =>
        validateRaw({
          ...exactRawBase,
          profile: { contextSize: 4_096, parallelRequests: 1, [field]: value },
        })
      ).toThrow(/positive safe integer/);
    });

    it('rejects exact parallelRequests greater than contextSize', () => {
      expect(() =>
        validateRaw({
          ...exactRawBase,
          profile: { contextSize: 4_096, parallelRequests: 4_097 },
        })
      ).toThrow(/parallelRequests cannot exceed contextSize/);
    });

    it('keeps caller profile order distinct from smaller-context scheduling order', () => {
      const profiles = [
        { profileIndex: 0, contextSize: 16_384, parallelRequests: 2, autoGpuLayers: 40 },
        { profileIndex: 1, contextSize: 8_192, parallelRequests: 2, autoGpuLayers: 44 },
      ];

      const cells = enumerateAdaptiveCells({
        profiles,
        totalLayers: 48,
        gpuAvailable: true,
        hasSharedPrefixWorkload: false,
        includeKvCacheComparison: false,
        baselineKvPrecision: 'q8_0',
      });

      expect(profiles.map((profile) => profile.contextSize)).toEqual([16_384, 8_192]);
      expect(
        cells.map(({ profileIndex, profileOrdinal, contextSize }) => ({
          profileIndex,
          profileOrdinal,
          contextSize,
        }))
      ).toEqual([
        { profileIndex: 1, profileOrdinal: 0, contextSize: 8_192 },
        { profileIndex: 0, profileOrdinal: 1, contextSize: 16_384 },
      ]);
    });

    it('requires explicit positive weights for multiple complete scenarios', () => {
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          workloads: [
            baseConfig.workloads[0]!,
            {
              id: 'prefix',
              kind: 'shared-prefix',
              sharedPrefix: 'common',
              suffixes: ['a', 'b'],
              nPredict: 8,
              weight: 1,
            },
          ],
        })
      ).toThrow(/weight is required/);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid KV precision preference %p',
      (value) => {
        expect(() =>
          validateLlamaCalibrationConfig({ ...baseConfig, kvPrecisionPreferencePct: value })
        ).toThrow(/finite and non-negative/);
      }
    );

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid context preference %p',
      (value) => {
        expect(() =>
          validateLlamaCalibrationConfig({ ...baseConfig, contextPreferencePct: value })
        ).toThrow(/finite and non-negative/);
      }
    );

    it('accepts a one-profile context preference as a recorded no-op', () => {
      const result = validateLlamaCalibrationConfig({ ...baseConfig, contextPreferencePct: 0 });
      const candidate = {
        cellId: 'only-profile',
        cellOrder: 0,
        profileIndex: 0,
        contextSize: 12_288,
        kvPrecision: 'q8_0' as const,
        swaFull: false,
        gpuLayers: 30,
        scoreMs: 100,
        evidenceIndices: [0],
        source: 'boundary' as const,
      };
      const withoutPreference = resolveAdaptiveRecommendation([candidate], {
        contextPreferencePct: 0,
        kvPrecisionPreferencePct: 10,
        tieTolerancePct: 5,
        contextPreferenceActive: false,
        kvPreferenceActive: false,
      });
      const withIgnoredPreference = resolveAdaptiveRecommendation([candidate], {
        contextPreferencePct: 100,
        kvPrecisionPreferencePct: 10,
        tieTolerancePct: 5,
        contextPreferenceActive: false,
        kvPreferenceActive: false,
      });

      expect(result).toMatchObject({
        strategy: 'adaptive',
        profiles: [{ contextSize: 12_288, parallelRequests: 2 }],
        contextPreferencePct: 0,
      });
      expect(withIgnoredPreference.selected).toEqual(withoutPreference.selected);
    });

    it('validates adaptive budget overrides and their ordering constraints', () => {
      expect(
        validateLlamaCalibrationConfig({
          ...baseConfig,
          targetProbes: 10,
          maxProbes: 15,
          maxWallTimeMs: 1_800_000,
        })
      ).toMatchObject({ targetProbes: 10, maxProbes: 15, maxWallTimeMs: 1_800_000 });

      for (const field of ['targetProbes', 'maxProbes', 'maxWallTimeMs'] as const) {
        for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
          expect(() => validateRaw({ ...baseConfig, [field]: value })).toThrow(
            new RegExp(`${field} must be a positive safe integer`)
          );
        }
      }
      expect(() =>
        validateLlamaCalibrationConfig({ ...baseConfig, targetProbes: 16, maxProbes: 15 })
      ).toThrow(/targetProbes cannot exceed maxProbes/);
      expect(() => validateLlamaCalibrationConfig({ ...baseConfig, maxProbes: 2 })).toThrow(
        /finalist reserve/
      );
    });

    it.each([
      ['includeKvCacheComparison', true],
      ['contextPreferencePct', 10],
      ['targetProbes', 10],
      ['maxProbes', 15],
      ['maxWallTimeMs', 1_800_000],
    ] as const)('rejects adaptive-only exact field %s', (field, value) => {
      expect(() => validateRaw({ ...exactRawBase, [field]: value })).toThrow(
        new RegExp(`${field} is adaptive-only`)
      );
    });

    it('requires a non-empty exact combo tuple at runtime', () => {
      expect(() => validateRaw({ ...exactRawBase, combos: [] })).toThrow(
        /combos must be non-empty/
      );
    });

    it('rejects fixed/candidate overlap and duplicate custom candidates', () => {
      expect(() =>
        validateLlamaCalibrationConfig({
          modelId: baseConfig.modelId,
          profile: { contextSize: 12_288, parallelRequests: 2 },
          workloads: baseConfig.workloads,
          fixedConfig: { gpuLayers: 10 },
          combos: [{ overrides: { gpuLayers: 9 } }],
        })
      ).toThrow(/overrides fixedConfig/);

      expect(() =>
        validateLlamaCalibrationConfig({
          modelId: baseConfig.modelId,
          profile: { contextSize: 12_288, parallelRequests: 2 },
          workloads: baseConfig.workloads,
          combos: [{ overrides: { swaFull: true } }, { overrides: { swaFull: true } }],
        })
      ).toThrow(/duplicates/);
    });

    it('rejects KV comparison against every fixed KV/FA axis', () => {
      const fixedCases: readonly LlamaCalibrationFixedConfig[] = [
        { cacheTypeK: 'f16' },
        { cacheTypeV: 'f16' },
        { flashAttention: 'on' },
      ];
      for (const fixedConfig of fixedCases) {
        expect(() =>
          validateLlamaCalibrationConfig({
            ...baseConfig,
            includeKvCacheComparison: true,
            fixedConfig,
          })
        ).toThrow(/pinned by fixedConfig/);
      }
    });

    it('rejects incompatible quantized V cache settings in exact mode', () => {
      expect(() =>
        validateLlamaCalibrationConfig({
          modelId: baseConfig.modelId,
          profile: { contextSize: 12_288, parallelRequests: 2 },
          workloads: baseConfig.workloads,
          combos: [{ overrides: { cacheTypeV: 'q8_0', flashAttention: 'off' } }],
        })
      ).toThrow(/quantized V cache/);
    });
  });

  describe('default candidates', () => {
    it('uses a bounded GPU ladder and pins baseline KV fields', () => {
      const result = generateDefaultLlamaCalibrationCombos({
        baseline,
        fixedConfig: {},
        totalLayers: 40,
        gpuAvailable: true,
        hasSharedPrefixWorkload: false,
        includeKvCacheComparison: false,
      });

      expect(result.combos.map((combo) => combo.overrides.gpuLayers)).toEqual([30, 26, 34, 40]);
      expect(result.combos).toHaveLength(4);
      expect(result.combos.every((combo) => combo.overrides.cacheTypeK === 'q8_0')).toBe(true);
    });

    it('emits explicit SWA pairs only when the workload crosses the window', () => {
      const result = generateDefaultLlamaCalibrationCombos({
        baseline,
        fixedConfig: {},
        totalLayers: 40,
        gpuAvailable: true,
        slidingWindow: 4096,
        hasSharedPrefixWorkload: true,
        includeKvCacheComparison: false,
      });

      expect(result.combos).toHaveLength(8);
      expect(result.combos.map((combo) => combo.overrides.swaFull)).toEqual([
        false,
        true,
        false,
        true,
        false,
        true,
        false,
        true,
      ]);
    });

    it('adds only one KV counterfactual and stays at ten candidates with MoE', () => {
      const result = generateDefaultLlamaCalibrationCombos({
        baseline,
        fixedConfig: {},
        totalLayers: 40,
        gpuAvailable: true,
        slidingWindow: 4096,
        hasSharedPrefixWorkload: true,
        exactExpertWeightsBytes: 1_000,
        includeKvCacheComparison: true,
      });

      expect(result.combos).toHaveLength(10);
      expect(result.combos.filter((combo) => combo.label === 'kv-f16')).toHaveLength(1);
    });

    it('does not manufacture GPU placements on CPU-only systems', () => {
      const result = generateDefaultLlamaCalibrationCombos({
        baseline: { ...baseline, gpuLayers: 0 },
        fixedConfig: {},
        totalLayers: 40,
        gpuAvailable: false,
        hasSharedPrefixWorkload: false,
        includeKvCacheComparison: false,
      });

      expect(result.combos).toHaveLength(1);
      expect(result.combos[0]!.overrides.gpuLayers).toBe(0);
    });

    it('does not repeat a fixed GPU axis in generated MoE or KV candidates', () => {
      const result = generateDefaultLlamaCalibrationCombos({
        baseline,
        fixedConfig: { gpuLayers: 30 },
        totalLayers: 40,
        gpuAvailable: true,
        hasSharedPrefixWorkload: false,
        exactExpertWeightsBytes: 1_000,
        includeKvCacheComparison: true,
      });

      expect(result.combos).toHaveLength(3);
      expect(result.combos.every((combo) => combo.overrides.gpuLayers === undefined)).toBe(true);
    });
  });

  describe('scoring and recommendation', () => {
    it('computes medians and normalized weighted scores', () => {
      expect(median([9, 1, 5, 3])).toBe(4);
      expect(
        weightedCalibrationScore([
          { weight: 1, medianWallTimeMs: 100 },
          { weight: 3, medianWallTimeMs: 200 },
        ])
      ).toBe(175);
    });

    it('prefers f16 within the default 10% precision window', () => {
      const q8 = run(100, { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' });
      const f16 = run(
        109,
        { cacheTypeK: 'f16', cacheTypeV: 'f16' },
        { cacheTypeK: 'f16', cacheTypeV: 'f16' }
      );

      expect(recommendLlamaCalibrationRun([q8, f16], 10)?.scoreMs).toBe(109);
      expect(recommendLlamaCalibrationRun([q8, f16], 0)?.scoreMs).toBe(100);
    });

    it('uses the 5% same-precision window, fewer flags, then stable order', () => {
      const forced = run(100, { gpuLayers: 30, swaFull: false });
      const simple = run(104, { gpuLayers: 26 });

      expect(recommendLlamaCalibrationRun([forced, simple], 10)?.combo).toBe(simple.combo);
    });
  });

  it('normalizes sliding-window metadata and hashes workload content', () => {
    const model = {
      ggufMetadata: {
        architecture: 'gemma3',
        attention_sliding_window: [0, 4096, 0, 2048],
      },
    } as ModelInfo;
    const validated = validateLlamaCalibrationConfig(baseConfig);

    expect(getSlidingWindow(model)).toBe(4096);
    expect(workloadSignature(validated.workloads[0]!).hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
