/**
 * Context-capacity constraint validation shared by sizing and server startup.
 *
 * Constraints are effective per parallel request slot. The normalized total
 * values are the llama-server `-c` allocation required across all slots.
 *
 * @module utils/context-constraints
 */

import type { LlamaServerConfig, ModelInfo, OptimalConfigHints } from '../types/index.js';
import { ContextConstraintError } from '../errors/index.js';
import { KV_SIZING } from '../config/defaults.js';
import { getContextLengthWithFallback } from './model-metadata-helpers.js';

type ContextConstraintInput = Pick<
  OptimalConfigHints,
  'contextSize' | 'minimumContextSize' | 'maximumContextSize' | 'parallelRequests'
> &
  Pick<LlamaServerConfig, 'fit'>;

export interface NormalizedContextConstraints {
  hasRange: boolean;
  minimumContextSize?: number;
  maximumContextSize?: number;
  parallelRequests: number;
  totalMinimumContextSize?: number;
  totalMaximumContextSize?: number;
}

export interface ContextConstraintValidationOptions {
  /**
   * start() accepts a selected context together with its retained runtime range;
   * getOptimalConfig() input hints do not.
   */
  allowExactWithRange?: boolean;
}

export interface ValidatedModelContextRange {
  nativeContextPerSlot: number;
  totalNativeContext: number;
  authoritative: boolean;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function checkedMultiply(value: number, multiplier: number, kind: 'minimum' | 'maximum'): number {
  const result = value * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ContextConstraintError('Context capacity exceeds the safe numeric range', {
      reason: 'unsafe-total-capacity',
      stage: 'validation',
      minimumContextSize: kind === 'minimum' ? value : undefined,
      maximumContextSize: kind === 'maximum' ? value : undefined,
      parallelRequests: multiplier,
      suggestion: 'Use smaller context constraints or fewer parallel request slots',
    });
  }
  return result;
}

/**
 * Validate and normalize exact/range context fields.
 *
 * Legacy exact-only context values deliberately receive no new validation.
 */
export function normalizeContextConstraints(
  input: ContextConstraintInput,
  options: ContextConstraintValidationOptions = {}
): NormalizedContextConstraints {
  const minimum = input.minimumContextSize;
  const maximum = input.maximumContextSize;
  const hasRange = minimum !== undefined || maximum !== undefined;

  if (!hasRange) {
    return {
      hasRange: false,
      parallelRequests: input.parallelRequests ?? 1,
    };
  }

  if (minimum !== undefined && !isPositiveSafeInteger(minimum)) {
    throw new ContextConstraintError('minimumContextSize must be a positive safe integer', {
      reason: 'invalid-minimum',
      stage: 'validation',
      minimumContextSize: minimum,
      suggestion:
        'Set minimumContextSize to a positive integer no larger than Number.MAX_SAFE_INTEGER',
    });
  }

  if (maximum !== undefined && !isPositiveSafeInteger(maximum)) {
    throw new ContextConstraintError('maximumContextSize must be a positive safe integer', {
      reason: 'invalid-maximum',
      stage: 'validation',
      maximumContextSize: maximum,
      suggestion:
        'Set maximumContextSize to a positive integer no larger than Number.MAX_SAFE_INTEGER',
    });
  }

  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new ContextConstraintError(
      'minimumContextSize cannot be greater than maximumContextSize',
      {
        reason: 'minimum-exceeds-maximum',
        stage: 'validation',
        minimumContextSize: minimum,
        maximumContextSize: maximum,
        suggestion: 'Choose an inclusive range where minimumContextSize <= maximumContextSize',
      }
    );
  }

  if (input.contextSize !== undefined && !options.allowExactWithRange) {
    throw new ContextConstraintError(
      'contextSize is mutually exclusive with minimumContextSize/maximumContextSize',
      {
        reason: 'exact-range-conflict',
        stage: 'validation',
        contextSize: input.contextSize,
        minimumContextSize: minimum,
        maximumContextSize: maximum,
        suggestion: 'Use either an exact contextSize or a minimum/maximum range',
      }
    );
  }

  if (input.fit === 'on' && input.contextSize === undefined) {
    throw new ContextConstraintError(
      "fit: 'on' requires a concrete contextSize when context constraints are used",
      {
        reason: 'fit-range-conflict',
        stage: 'validation',
        minimumContextSize: minimum,
        maximumContextSize: maximum,
        suggestion:
          "Use genai-electron sizing with fit: 'off', or provide a precomputed contextSize with the range",
      }
    );
  }

  const parallelRequests = input.parallelRequests ?? 1;
  if (!isPositiveSafeInteger(parallelRequests)) {
    throw new ContextConstraintError(
      'parallelRequests must be a positive safe integer when context constraints are used',
      {
        reason: 'unsafe-total-capacity',
        stage: 'validation',
        minimumContextSize: minimum,
        maximumContextSize: maximum,
        parallelRequests,
        suggestion: 'Use a positive integer number of parallel request slots',
      }
    );
  }

  const totalMinimum =
    minimum !== undefined ? checkedMultiply(minimum, parallelRequests, 'minimum') : undefined;
  const totalMaximum =
    maximum !== undefined ? checkedMultiply(maximum, parallelRequests, 'maximum') : undefined;

  if (input.contextSize !== undefined && options.allowExactWithRange) {
    const effectiveConfigured = Math.floor(input.contextSize / parallelRequests);
    if (
      !Number.isSafeInteger(effectiveConfigured) ||
      effectiveConfigured <= 0 ||
      (minimum !== undefined && effectiveConfigured < minimum) ||
      (maximum !== undefined && effectiveConfigured > maximum)
    ) {
      throw new ContextConstraintError(
        'The configured contextSize does not satisfy the retained per-slot context range',
        {
          reason: 'precomputed-context-out-of-range',
          stage: 'validation',
          contextSize: input.contextSize,
          configuredContextSize: input.contextSize,
          effectiveContextSize: effectiveConfigured,
          minimumContextSize: minimum,
          maximumContextSize: maximum,
          parallelRequests,
          suggestion: 'Re-run getOptimalConfig() with the desired range or adjust contextSize',
        }
      );
    }
  }

  return {
    hasRange: true,
    minimumContextSize: minimum,
    maximumContextSize: maximum,
    parallelRequests,
    totalMinimumContextSize: totalMinimum,
    totalMaximumContextSize: totalMaximum,
  };
}

/**
 * Validate a normalized range against authoritative GGUF context metadata.
 */
export function validateModelContextRange(
  modelInfo: ModelInfo,
  constraints: NormalizedContextConstraints
): ValidatedModelContextRange {
  const fallbackNativeContext = getContextLengthWithFallback(modelInfo);
  const conservativeLegacyContext = Math.min(fallbackNativeContext, KV_SIZING.floorContextTokens);
  const metadataNativeContext = modelInfo.ggufMetadata?.context_length;
  const authoritativeNativeContext =
    typeof metadataNativeContext === 'number' &&
    Number.isSafeInteger(metadataNativeContext) &&
    metadataNativeContext > 0
      ? metadataNativeContext
      : undefined;
  const minimum = constraints.minimumContextSize;

  if (
    minimum !== undefined &&
    authoritativeNativeContext !== undefined &&
    minimum > authoritativeNativeContext
  ) {
    throw new ContextConstraintError(
      `Minimum context ${minimum} exceeds the model's native context ${authoritativeNativeContext}`,
      {
        reason: 'minimum-exceeds-native',
        stage: 'sizing',
        minimumContextSize: minimum,
        maximumContextSize: constraints.maximumContextSize,
        nativeContextSize: authoritativeNativeContext,
        parallelRequests: constraints.parallelRequests,
        suggestion: `Choose minimumContextSize <= ${authoritativeNativeContext}`,
      }
    );
  }

  if (
    minimum !== undefined &&
    authoritativeNativeContext === undefined &&
    minimum > conservativeLegacyContext
  ) {
    throw new ContextConstraintError(
      `Cannot verify minimum context ${minimum} because native context metadata is unavailable`,
      {
        reason: 'model-context-unknown',
        stage: 'sizing',
        minimumContextSize: minimum,
        maximumContextSize: constraints.maximumContextSize,
        parallelRequests: constraints.parallelRequests,
        suggestion:
          'Refresh the model GGUF metadata, or choose a minimum no larger than the conservative legacy recommendation',
      }
    );
  }

  const nativeContextPerSlot = authoritativeNativeContext ?? conservativeLegacyContext;
  const totalNativeContext = nativeContextPerSlot * constraints.parallelRequests;
  if (!Number.isSafeInteger(totalNativeContext) || totalNativeContext <= 0) {
    throw new ContextConstraintError('Native multi-slot context exceeds the safe numeric range', {
      reason: 'unsafe-total-capacity',
      stage: 'sizing',
      minimumContextSize: minimum,
      maximumContextSize: constraints.maximumContextSize,
      nativeContextSize: nativeContextPerSlot,
      parallelRequests: constraints.parallelRequests,
      suggestion: 'Use fewer parallel request slots',
    });
  }

  return {
    nativeContextPerSlot,
    totalNativeContext,
    authoritative: authoritativeNativeContext !== undefined,
  };
}
