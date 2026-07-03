/**
 * Unit tests for KV-cache memory arithmetic
 */

import {
  estimateKVBytesPerToken,
  floorContextToGranularity,
  KV_CACHE_BYTES_PER_ELEMENT,
} from '../../src/utils/kv-cache-math.js';
import type { ModelInfo } from '../../src/types/index.js';

const baseModel = (ggufMetadata?: ModelInfo['ggufMetadata']): ModelInfo => ({
  id: 'm',
  name: 'M',
  type: 'llm',
  size: 4 * 1024 ** 3,
  path: '/m.gguf',
  downloadedAt: '2026-07-03T00:00:00Z',
  source: { type: 'url', url: 'https://x/m.gguf' },
  ggufMetadata,
});

describe('kv-cache-math', () => {
  it('computes f16 KV bytes/token for a GQA model (typed fields)', () => {
    const model = baseModel({
      architecture: 'qwen3',
      block_count: 36,
      attention_head_count: 32,
      attention_head_count_kv: 8,
      attention_key_length: 128,
      embedding_length: 4096,
      context_length: 262144,
    });

    // 36 layers x 8 KV heads x 128 dim x (2 + 2) bytes
    expect(estimateKVBytesPerToken(model)).toBe(36 * 8 * 128 * 4);
  });

  it('falls back to MHA head count when head_count_kv is absent (conservative)', () => {
    const model = baseModel({
      architecture: 'llama',
      block_count: 32,
      attention_head_count: 32,
      embedding_length: 4096,
      context_length: 4096,
    });

    // headDim = 4096/32 = 128; MHA: kvHeads = 32
    expect(estimateKVBytesPerToken(model)).toBe(32 * 32 * 128 * 4);
  });

  it('reads head_count_kv from raw metadata for older downloads', () => {
    const model = baseModel({
      architecture: 'llama',
      block_count: 32,
      attention_head_count: 32,
      embedding_length: 4096,
      context_length: 8192,
      raw: { 'llama.attention.head_count_kv': 8 },
    });

    expect(estimateKVBytesPerToken(model)).toBe(32 * 8 * 128 * 4);
  });

  it('halves-ish the cost with q8_0 K and V', () => {
    const model = baseModel({
      architecture: 'qwen3',
      block_count: 36,
      attention_head_count: 32,
      attention_head_count_kv: 8,
      attention_key_length: 128,
      context_length: 262144,
    });

    const f16 = estimateKVBytesPerToken(model, 'f16', 'f16');
    const q8 = estimateKVBytesPerToken(model, 'q8_0', 'q8_0');
    expect(q8).toBeCloseTo(f16 * (KV_CACHE_BYTES_PER_ELEMENT.q8_0 / 2), 5);
    expect(q8).toBeLessThan(f16 * 0.6);
  });

  it('supports mixed K/V cache types', () => {
    const model = baseModel({
      architecture: 'qwen3',
      block_count: 10,
      attention_head_count_kv: 4,
      attention_head_count: 16,
      attention_key_length: 64,
      context_length: 4096,
    });

    const mixed = estimateKVBytesPerToken(model, 'f16', 'q4_0');
    expect(mixed).toBe(10 * 4 * 64 * (2 + 18 / 32));
  });

  it('normalizes per-layer head_count_kv arrays via mean (Gemma 4 style)', () => {
    const model = baseModel({
      architecture: 'gemma4',
      block_count: 30,
      attention_head_count: 16,
      // 25 full-attention layers with 8 KV heads, 5 sliding-window with 2
      attention_head_count_kv: [
        8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2,
      ],
      attention_key_length: 512,
      context_length: 262144,
    });

    // mean kvHeads = (25x8 + 5x2)/30 = 7 → exact summed KV cost
    expect(estimateKVBytesPerToken(model)).toBe(30 * 7 * 512 * 4);
    expect(Number.isFinite(estimateKVBytesPerToken(model, 'q8_0', 'q8_0'))).toBe(true);
  });

  describe('floorContextToGranularity()', () => {
    it.each([
      [1500, 1408], // <=2048: multiples of 128
      [3000, 2816], // <=4096: multiples of 256
      [5000, 4608], // <=8192: multiples of 512
      [8300, 8192], // <=16384: multiples of 1024
      [20000, 18432], // <=32768: multiples of 2048
      [58368, 57344], // above: multiples of 4096
      [100000, 98304],
    ])('floors %d to %d', (input, expected) => {
      expect(floorContextToGranularity(input)).toBe(expected);
    });

    it('keeps exact ladder boundaries unchanged', () => {
      for (const exact of [2048, 4096, 8192, 16384, 32768]) {
        expect(floorContextToGranularity(exact)).toBe(exact);
      }
    });
  });

  it('produces a finite positive estimate without any metadata (size fallback)', () => {
    const model = baseModel(undefined);
    const bpt = estimateKVBytesPerToken(model);
    expect(bpt).toBeGreaterThan(0);
    expect(Number.isFinite(bpt)).toBe(true);
  });
});
