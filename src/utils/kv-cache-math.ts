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
