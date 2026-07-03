/**
 * Model metadata helper utilities
 *
 * Provides graceful fallback for models without GGUF metadata.
 * Ensures backward compatibility with models downloaded before GGUF integration.
 *
 * @module utils/model-metadata-helpers
 */

import type { ModelInfo } from '../types/index.js';

/**
 * Get layer count from model info with fallback to estimation
 *
 * Priority:
 * 1. Use GGUF metadata if available (accurate)
 * 2. Estimate based on model size (rough approximation)
 *
 * @param modelInfo - Model information
 * @returns Layer count (actual or estimated)
 *
 * @example
 * ```typescript
 * const layers = getLayerCountWithFallback(modelInfo);
 * console.log(`Model has ${layers} layers`);
 * ```
 */
export function getLayerCountWithFallback(modelInfo: ModelInfo): number {
  // Try GGUF metadata first (accurate)
  if (modelInfo.ggufMetadata?.block_count) {
    return modelInfo.ggufMetadata.block_count;
  }

  // Fallback: Estimate based on model size
  // This is a rough approximation:
  // - 7B models: ~32 layers
  // - 13B models: ~40 layers
  // - 34B models: ~60 layers
  // - 70B models: ~80 layers
  //
  // Formula: layers ≈ size_bytes / (150 MB per layer)
  const estimatedLayers = Math.round(modelInfo.size / (150 * 1024 ** 2));

  // Clamp to reasonable range (minimum 24, maximum 120)
  return Math.max(24, Math.min(120, estimatedLayers));
}

/**
 * Get context length from model info with fallback to default
 *
 * Priority:
 * 1. Use GGUF metadata if available (accurate)
 * 2. Use default based on model size
 *
 * @param modelInfo - Model information
 * @returns Context length (actual or default)
 *
 * @example
 * ```typescript
 * const contextLen = getContextLengthWithFallback(modelInfo);
 * console.log(`Context window: ${contextLen} tokens`);
 * ```
 */
export function getContextLengthWithFallback(modelInfo: ModelInfo): number {
  // Try GGUF metadata first (accurate)
  if (modelInfo.ggufMetadata?.context_length) {
    return modelInfo.ggufMetadata.context_length;
  }

  // Fallback: Default based on model size
  const sizeGB = modelInfo.size / 1024 ** 3;

  if (sizeGB >= 30) {
    // Very large models (70B+) often have 8K+ context
    return 8192;
  } else if (sizeGB >= 10) {
    // Large models (13B-34B) typically have 4K-8K
    return 4096;
  } else {
    // Smaller models (7B and below) typically have 2K-4K
    return 4096;
  }
}

/**
 * Get architecture type from model info with fallback to default
 *
 * Priority:
 * 1. Use GGUF metadata if available (accurate)
 * 2. Assume "llama" for LLM models (most common)
 *
 * @param modelInfo - Model information
 * @returns Architecture type
 *
 * @example
 * ```typescript
 * const arch = getArchitectureWithFallback(modelInfo);
 * console.log(`Model architecture: ${arch}`);
 * ```
 */
export function getArchitectureWithFallback(modelInfo: ModelInfo): string {
  // Try GGUF metadata first (accurate)
  if (modelInfo.ggufMetadata?.architecture) {
    return modelInfo.ggufMetadata.architecture;
  }

  // Fallback: Assume based on model type
  if (modelInfo.type === 'llm') {
    return 'llama'; // Most common LLM architecture
  } else if (modelInfo.type === 'diffusion') {
    return 'stable-diffusion';
  }

  return 'unknown';
}

/**
 * Get attention head count from model info with fallback to estimation
 *
 * Priority:
 * 1. Use GGUF metadata if available (accurate)
 * 2. Estimate based on model size
 *
 * @param modelInfo - Model information
 * @returns Attention head count (actual or estimated)
 *
 * @example
 * ```typescript
 * const heads = getAttentionHeadCountWithFallback(modelInfo);
 * console.log(`Attention heads: ${heads}`);
 * ```
 */
export function getAttentionHeadCountWithFallback(modelInfo: ModelInfo): number {
  // Try GGUF metadata first (accurate); per-layer arrays normalize via mean
  const typed = toScalarMean(modelInfo.ggufMetadata?.attention_head_count);
  if (typed) {
    return typed;
  }

  // Fallback: Estimate based on model size
  const sizeGB = modelInfo.size / 1024 ** 3;

  if (sizeGB >= 60) {
    // 70B+ models
    return 64;
  } else if (sizeGB >= 25) {
    // 34B models
    return 52;
  } else if (sizeGB >= 10) {
    // 13B models
    return 40;
  } else {
    // 7B and smaller
    return 32;
  }
}

/**
 * Normalize a GGUF numeric field that may be a per-layer array
 *
 * Heterogeneous-attention architectures (e.g. Gemma 4: full-attention layers
 * with 8 KV heads alternating with sliding-window layers with 2) store
 * per-layer arrays. The MEAN keeps summed per-layer KV totals exact:
 * sum(perLayer) === layers x mean.
 *
 * @returns Positive scalar, or undefined when the value is unusable
 */
function toScalarMean(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')) {
    const mean = value.reduce((a, b) => a + b, 0) / value.length;
    return mean > 0 ? mean : undefined;
  }
  return undefined;
}

/**
 * Get KV-head count (GQA) with fallback
 *
 * Priority:
 * 1. Typed GGUF field (attention_head_count_kv)
 * 2. Raw metadata lookup (models downloaded before this field was extracted)
 * 3. Full attention head count — the MHA assumption, which OVERESTIMATES the
 *    KV cost of GQA models and is therefore a safe (conservative) fallback
 *
 * @param modelInfo - Model information
 * @returns KV-head count (actual or conservative fallback)
 */
export function getKVHeadCountWithFallback(modelInfo: ModelInfo): number {
  const meta = modelInfo.ggufMetadata;
  const typed = toScalarMean(meta?.attention_head_count_kv);
  if (typed) {
    return typed;
  }

  const arch = meta?.architecture;
  if (arch && meta?.raw) {
    const value = toScalarMean(meta.raw[`${arch}.attention.head_count_kv`]);
    if (value) {
      return value;
    }
  }

  return getAttentionHeadCountWithFallback(modelInfo);
}

/**
 * Get per-head key dimension with fallback
 *
 * Priority:
 * 1. Typed GGUF field (attention_key_length — set when it differs from the
 *    conventional embedding_length / head_count, e.g. some Gemma models)
 * 2. Raw metadata lookup
 * 3. embedding_length / attention_head_count
 *
 * @param modelInfo - Model information
 * @returns Head dimension in elements
 */
export function getHeadDimensionWithFallback(modelInfo: ModelInfo): number {
  const meta = modelInfo.ggufMetadata;
  const typed = toScalarMean(meta?.attention_key_length);
  if (typed) {
    return typed;
  }

  const arch = meta?.architecture;
  if (arch && meta?.raw) {
    const value = toScalarMean(meta.raw[`${arch}.attention.key_length`]);
    if (value) {
      return value;
    }
  }

  return Math.round(
    getEmbeddingLengthWithFallback(modelInfo) / getAttentionHeadCountWithFallback(modelInfo)
  );
}

/**
 * Get embedding length from model info with fallback to estimation
 *
 * Priority:
 * 1. Use GGUF metadata if available (accurate)
 * 2. Estimate based on model size
 *
 * @param modelInfo - Model information
 * @returns Embedding length (actual or estimated)
 */
export function getEmbeddingLengthWithFallback(modelInfo: ModelInfo): number {
  // Try GGUF metadata first (accurate)
  if (modelInfo.ggufMetadata?.embedding_length) {
    return modelInfo.ggufMetadata.embedding_length;
  }

  // Fallback: Estimate based on model size
  const sizeGB = modelInfo.size / 1024 ** 3;

  if (sizeGB >= 60) {
    // 70B+ models
    return 8192;
  } else if (sizeGB >= 25) {
    // 34B models
    return 6656;
  } else if (sizeGB >= 10) {
    // 13B models
    return 5120;
  } else {
    // 7B and smaller
    return 4096;
  }
}

/**
 * Get MoE expert count with fallback (0 = dense model)
 *
 * Priority: typed field → raw metadata lookup → 0.
 */
export function getExpertCountWithFallback(modelInfo: ModelInfo): number {
  const meta = modelInfo.ggufMetadata;
  if (meta?.expert_count) {
    return meta.expert_count;
  }

  const arch = meta?.architecture;
  if (arch && meta?.raw) {
    const value = meta.raw[`${arch}.expert_count`];
    if (typeof value === 'number' && value > 0) {
      return value;
    }
  }

  return 0;
}

/**
 * Get the byte size of MoE expert weights, with fallback estimation
 *
 * Priority:
 * 1. Measured `expert_weights_bytes` (exact, from GGUF tensor offsets)
 * 2. Parameter-count heuristic: expertParams / totalParams × file size, using
 *    `general.parameter_count` and expert dims from metadata
 * 3. undefined — caller should treat the model as dense (conservative)
 *
 * @param modelInfo - Model information
 * @returns Expert weight bytes, or undefined when not estimable / dense
 */
export function getExpertWeightsBytesWithFallback(modelInfo: ModelInfo): number | undefined {
  const meta = modelInfo.ggufMetadata;
  if (meta?.expert_weights_bytes && meta.expert_weights_bytes > 0) {
    return meta.expert_weights_bytes;
  }

  const expertCount = getExpertCountWithFallback(modelInfo);
  if (expertCount <= 0) {
    return undefined;
  }

  // Heuristic: 3 projection matrices (gate/up/down) per expert per layer
  const expertFF =
    meta?.expert_feed_forward_length ??
    (meta?.architecture && meta.raw
      ? (meta.raw[`${meta.architecture}.expert_feed_forward_length`] as number | undefined)
      : undefined);
  const totalParams = meta?.raw?.['general.parameter_count'] as number | undefined;
  if (!expertFF || !totalParams || totalParams <= 0) {
    return undefined;
  }

  const layers = getLayerCountWithFallback(modelInfo);
  const embedding = getEmbeddingLengthWithFallback(modelInfo);
  const expertParams = 3 * embedding * expertFF * expertCount * layers;
  const fraction = Math.min(0.95, expertParams / totalParams);
  return fraction > 0 ? Math.round(modelInfo.size * fraction) : undefined;
}

/**
 * Check if model has GGUF metadata
 *
 * @param modelInfo - Model information
 * @returns True if model has GGUF metadata
 *
 * @example
 * ```typescript
 * if (hasGGUFMetadata(modelInfo)) {
 *   console.log('Model has accurate metadata');
 * } else {
 *   console.log('Model using estimated values');
 * }
 * ```
 */
export function hasGGUFMetadata(modelInfo: ModelInfo): boolean {
  return !!modelInfo.ggufMetadata && !!modelInfo.ggufMetadata.architecture;
}

/**
 * Get metadata completeness percentage
 *
 * Calculates how much of the standard GGUF metadata is available.
 * Useful for determining metadata quality.
 *
 * @param modelInfo - Model information
 * @returns Percentage (0-100) of metadata fields present
 *
 * @example
 * ```typescript
 * const completeness = getMetadataCompleteness(modelInfo);
 * console.log(`Metadata: ${completeness}% complete`);
 * ```
 */
export function getMetadataCompleteness(modelInfo: ModelInfo): number {
  if (!modelInfo.ggufMetadata) {
    return 0;
  }

  const fields = [
    'architecture',
    'block_count',
    'context_length',
    'attention_head_count',
    'embedding_length',
    'vocab_size',
  ];

  const presentFields = fields.filter((field) => {
    const value = modelInfo.ggufMetadata?.[field as keyof typeof modelInfo.ggufMetadata];
    return value !== undefined && value !== null;
  });

  return Math.round((presentFields.length / fields.length) * 100);
}
