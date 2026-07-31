import {
  BINARY_VERSIONS,
  LLAMA_CALIBRATION_DEFAULTS,
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
  it('keeps the core sweep bounded and KV comparison caller-controlled', () => {
    expect(LLAMA_CALIBRATION_DEFAULTS).toMatchObject({
      samples: 3,
      seed: 42,
      tieTolerancePct: 5,
      includeKvCacheComparison: false,
      kvPrecisionPreferencePct: 10,
      maxCandidates: 10,
    });
  });
});
