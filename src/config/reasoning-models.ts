/**
 * Reasoning model detection for llama.cpp
 *
 * This module provides utilities to detect reasoning-capable GGUF models
 * based on filename patterns. When detected, genai-electron automatically
 * adds --jinja --reasoning-format deepseek flags to llama-server.
 *
 * @module config/reasoning-models
 */

/**
 * Known patterns for reasoning-capable models
 *
 * These patterns are matched case-insensitively against GGUF filenames.
 * If a match is found, the model is assumed to support reasoning via
 * llama.cpp's --reasoning-format deepseek feature.
 *
 * Supported model families:
 * - qwen3: Qwen 3 family (0.6B, 1.7B, 4B, 8B, 14B, 30B - all variants)
 * - deepseek-r1: DeepSeek R1 reasoning models (8B, 32B, distilled variants)
 * - gpt-oss: OpenAI's open-source reasoning model
 *
 * All these models use <think>...</think> tags for reasoning output.
 */
export const REASONING_MODEL_PATTERNS: readonly string[] = [
  'qwen3', // Qwen 3 series - all sizes
  'deepseek-r1', // DeepSeek R1 reasoning models
  'gpt-oss', // OpenAI GPT-OSS
];

/**
 * Detect if a GGUF model supports reasoning based on its filename
 *
 * Performs case-insensitive substring matching against known patterns.
 * This is a simple heuristic - it may produce false positives/negatives
 * for models with similar names.
 *
 * @param filename - GGUF filename (e.g., "Qwen3-8B-Instruct-Q4_K_M.gguf")
 * @returns True if the model is known to support reasoning
 *
 * @example
 * ```typescript
 * detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf') // true
 * detectReasoningSupport('deepseek-r1-distill-llama-8b.gguf') // true
 * detectReasoningSupport('llama-2-7b-chat.gguf') // false
 * ```
 */
export function detectReasoningSupport(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return REASONING_MODEL_PATTERNS.some((pattern) => lowerFilename.includes(pattern));
}
