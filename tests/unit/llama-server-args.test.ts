import { describe, expect, it } from '@jest/globals';

import { ServerError } from '../../src/errors/index.js';
import {
  buildLlamaServerArgs,
  normalizeLlamaVCacheConfig,
  type ResolvedLlamaServerRuntimeConfig,
} from '../../src/process/llama-server-args.js';
import type { ModelInfo } from '../../src/types/index.js';

const model: ModelInfo = {
  id: 'model',
  name: 'Model',
  type: 'llm',
  size: 100,
  path: '/models/model.gguf',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  source: { type: 'url', url: 'https://example.test/model' },
};

const config: ResolvedLlamaServerRuntimeConfig = {
  port: 12_345,
  host: '127.0.0.1',
  threads: 8,
  contextSize: 12_288,
  gpuLayers: 20,
  parallelRequests: 2,
  flashAttention: 'on',
  fit: 'off',
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
};

const productionVector = [
  '-m',
  '/models/model.gguf',
  '--jinja',
  '--host',
  '127.0.0.1',
  '--port',
  '12345',
  '--threads',
  '8',
  '-c',
  '12288',
  '-n',
  '-1',
  '-ngl',
  '20',
  '-np',
  '2',
  '-fa',
  'on',
  '-fit',
  'off',
  '--cache-type-k',
  'q8_0',
  '--cache-type-v',
  'q8_0',
];

describe('buildLlamaServerArgs', () => {
  it('pins the canonical production/default runner vector', () => {
    expect(buildLlamaServerArgs(config, model)).toEqual(productionVector);
    expect(
      buildLlamaServerArgs(config, { path: model.path }, { slotsEndpoint: 'default' })
    ).toEqual(productionVector);
  });

  it('adds only the requested slots controls', () => {
    expect(
      buildLlamaServerArgs(
        config,
        { path: model.path },
        {
          slotsEndpoint: 'enabled',
          slotSavePath: '/tmp/slots',
        }
      )
    ).toEqual([...productionVector, '--slots', '--slot-save-path', '/tmp/slots']);
    expect(buildLlamaServerArgs(config, model, { slotsEndpoint: 'disabled' })).toEqual([
      ...productionVector,
      '--no-slots',
    ]);
  });

  it('rejects disabled slots with a save path', () => {
    expect(() =>
      buildLlamaServerArgs(config, model, {
        slotsEndpoint: 'disabled',
        slotSavePath: '/tmp/slots',
      })
    ).toThrow(ServerError);
  });
});

describe('normalizeLlamaVCacheConfig', () => {
  it('enables flash attention for quantized V cache without mutating the input', () => {
    const input = { cacheTypeV: 'q8_0' as const, flashAttention: 'auto' as const };
    expect(normalizeLlamaVCacheConfig(input)).toEqual({
      cacheTypeV: 'q8_0',
      flashAttention: 'on',
    });
    expect(input.flashAttention).toBe('auto');
  });

  it('rejects quantized V cache with flash attention disabled', () => {
    expect(() => normalizeLlamaVCacheConfig({ cacheTypeV: 'q4_0', flashAttention: false })).toThrow(
      /requires flash attention/
    );
  });
});
