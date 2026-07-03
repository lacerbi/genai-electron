/**
 * KV-cache memory arithmetic
 *
 * Estimates the per-token KV-cache cost of a model from its GGUF metadata,
 * used by SystemInfo's adaptive context/offload recommendations and the
 * ResourceOrchestrator's memory estimates.
 *
 * GQA-correctness matters: modern models have far fewer KV heads than
 * attention heads (attention.head_count_kv), and using the full head count
 * would overestimate KV cost by 4-8x.
 *
 * @module utils/kv-cache-math
 */

import type { KVCacheType, ModelInfo } from '../types/index.js';
import {
  getLayerCountWithFallback,
  getKVHeadCountWithFallback,
  getHeadDimensionWithFallback,
} from './model-metadata-helpers.js';

/**
 * Bytes per KV-cache element by cache type, following llama.cpp's block
 * layouts (block bytes / 32 elements for the quantized types).
 */
export const KV_CACHE_BYTES_PER_ELEMENT: Record<KVCacheType, number> = {
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_0: 22 / 32,
  q5_1: 24 / 32,
  q4_0: 18 / 32,
  q4_1: 20 / 32,
  iq4_nl: 18 / 32,
};

/**
 * Progressive context-size granularity ladder: [upper bound, granularity].
 * Rounding stays proportional to scale (roughly within 6% of the value)
 * while producing "round" context sizes at every magnitude.
 */
export const CONTEXT_GRANULARITY_LADDER: readonly (readonly [number, number])[] = [
  [2048, 128],
  [4096, 256],
  [8192, 512],
  [16384, 1024],
  [32768, 2048],
  [Infinity, 4096],
];

/**
 * Floor a context-token count to the progressive granularity ladder
 *
 * ≤2048 → multiples of 128, ≤4096 → 256, ≤8192 → 512, ≤16384 → 1024,
 * ≤32768 → 2048, above → 4096.
 *
 * @param tokens - Raw context-token count
 * @returns Token count floored to the ladder granularity for its magnitude
 *
 * @example
 * ```typescript
 * floorContextToGranularity(58368); // 57344 (multiple of 4096)
 * floorContextToGranularity(5000);  // 4608  (multiple of 512)
 * ```
 */
export function floorContextToGranularity(tokens: number): number {
  for (const [upperBound, granularity] of CONTEXT_GRANULARITY_LADDER) {
    if (tokens <= upperBound) {
      return Math.floor(tokens / granularity) * granularity;
    }
  }
  return Math.floor(tokens); // Unreachable (ladder ends at Infinity)
}

/**
 * Estimate the KV-cache cost of ONE context token, in bytes
 *
 * Formula: layers x kvHeads x headDim x (bytes(K) + bytes(V)).
 * Uses GGUF metadata with conservative fallbacks (MHA head count when
 * head_count_kv is absent), so the estimate errs high, never low.
 *
 * Note: sliding-window models (e.g. Gemma) are priced as full-attention,
 * which overestimates their effective KV cost — conservative by design.
 *
 * @param modelInfo - Model information (ggufMetadata preferred)
 * @param cacheTypeK - K-cache quantization (default: f16, llama.cpp's default)
 * @param cacheTypeV - V-cache quantization (default: f16)
 * @returns Estimated bytes of KV cache per context token
 *
 * @example
 * ```typescript
 * const bytesPerToken = estimateKVBytesPerToken(modelInfo, 'q8_0', 'q8_0');
 * const kvFor32K = 32768 * bytesPerToken;
 * ```
 */
export function estimateKVBytesPerToken(
  modelInfo: ModelInfo,
  cacheTypeK: KVCacheType = 'f16',
  cacheTypeV: KVCacheType = 'f16'
): number {
  const layers = getLayerCountWithFallback(modelInfo);
  const kvHeads = getKVHeadCountWithFallback(modelInfo);
  const headDim = getHeadDimensionWithFallback(modelInfo);
  const bytesPerElement =
    KV_CACHE_BYTES_PER_ELEMENT[cacheTypeK] + KV_CACHE_BYTES_PER_ELEMENT[cacheTypeV];

  return layers * kvHeads * headDim * bytesPerElement;
}
