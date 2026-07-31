import type {
  LlamaCalibrationConfig,
  LlamaCalibrationRun,
  ModelInfo,
  ResolvedLlamaCalibrationConfig,
} from '../../src/types/index.js';
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
  profile: { contextSize: 12_288, parallelRequests: 2 },
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

      expect(result.workloads[0]!.weight).toBe(1);
      expect(result.samples).toBe(3);
      expect(result.seed).toBe(42);
      expect(result.includeKvCacheComparison).toBe(false);
      expect(result.kvPrecisionPreferencePct).toBe(10);
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

    it('rejects fixed/candidate overlap and duplicate custom candidates', () => {
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          fixedConfig: { gpuLayers: 10 },
          combos: [{ overrides: { gpuLayers: 9 } }],
        })
      ).toThrow(/overrides fixedConfig/);

      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          combos: [{ overrides: { swaFull: true } }, { overrides: { swaFull: true } }],
        })
      ).toThrow(/duplicates/);
    });

    it('rejects ambiguous KV opt-in and incompatible quantized V cache', () => {
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
          includeKvCacheComparison: true,
          fixedConfig: { cacheTypeK: 'f16' },
        })
      ).toThrow(/pinned by fixedConfig/);
      expect(() =>
        validateLlamaCalibrationConfig({
          ...baseConfig,
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
