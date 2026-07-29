/**
 * Context-capacity constraint validation shared by sizing and server startup.
 *
 * Policy values are effective per parallel request slot. The normalized total
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
  | 'contextSize'
  | 'minimumContextSize'
  | 'preferredContextSize'
  | 'maximumContextSize'
  | 'parallelRequests'
> &
  Pick<LlamaServerConfig, 'fit'>;

export interface NormalizedContextConstraints {
  hasContextPolicy: boolean;
  minimumContextSize?: number;
  preferredContextSize?: number;
  maximumContextSize?: number;
  parallelRequests: number;
  totalMinimumContextSize?: number;
  totalPreferredContextSize?: number;
  totalMaximumContextSize?: number;
}

export interface ContextConstraintValidationOptions {
  /**
   * start() accepts a selected context together with its retained policy;
   * getOptimalConfig() input hints do not.
   */
  allowExactWithPolicy?: boolean;
}

export interface ValidatedModelContextRange {
  nativeContextPerSlot: number;
  totalNativeContext: number;
  authoritative: boolean;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function checkedMultiply(
  value: number,
  multiplier: number,
  kind: 'minimum' | 'preferred' | 'maximum'
): number {
  const result = value * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ContextConstraintError('Context capacity exceeds the safe numeric range', {
      reason: 'unsafe-total-capacity',
      stage: 'validation',
      minimumContextSize: kind === 'minimum' ? value : undefined,
      preferredContextSize: kind === 'preferred' ? value : undefined,
      maximumContextSize: kind === 'maximum' ? value : undefined,
      parallelRequests: multiplier,
      suggestion: 'Use smaller context values or fewer parallel request slots',
    });
  }
  return result;
}

/**
 * Validate and normalize exact/bounded/preferred context fields.
 *
 * Legacy exact-only context values deliberately receive no new validation.
 */
export function normalizeContextConstraints(
  input: ContextConstraintInput,
  options: ContextConstraintValidationOptions = {}
): NormalizedContextConstraints {
  const minimum = input.minimumContextSize;
  const preferred = input.preferredContextSize;
  const maximum = input.maximumContextSize;
  const hasContextPolicy =
    minimum !== undefined || preferred !== undefined || maximum !== undefined;

  if (!hasContextPolicy) {
    return {
      hasContextPolicy: false,
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

  if (preferred !== undefined && !isPositiveSafeInteger(preferred)) {
    throw new ContextConstraintError('preferredContextSize must be a positive safe integer', {
      reason: 'invalid-preferred',
      stage: 'validation',
      preferredContextSize: preferred,
      suggestion:
        'Set preferredContextSize to a positive integer no larger than Number.MAX_SAFE_INTEGER',
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

  if (minimum !== undefined && preferred !== undefined && minimum > preferred) {
    throw new ContextConstraintError(
      'minimumContextSize cannot be greater than preferredContextSize',
      {
        reason: 'minimum-exceeds-preferred',
        stage: 'validation',
        minimumContextSize: minimum,
        preferredContextSize: preferred,
        maximumContextSize: maximum,
        suggestion: 'Choose context values where minimumContextSize <= preferredContextSize',
      }
    );
  }

  if (preferred !== undefined && maximum !== undefined && preferred > maximum) {
    throw new ContextConstraintError(
      'preferredContextSize cannot be greater than maximumContextSize',
      {
        reason: 'preferred-exceeds-maximum',
        stage: 'validation',
        minimumContextSize: minimum,
        preferredContextSize: preferred,
        maximumContextSize: maximum,
        suggestion: 'Choose context values where preferredContextSize <= maximumContextSize',
      }
    );
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

  if (input.contextSize !== undefined && !options.allowExactWithPolicy) {
    throw new ContextConstraintError(
      'contextSize is mutually exclusive with minimumContextSize/preferredContextSize/maximumContextSize',
      {
        reason: 'exact-range-conflict',
        stage: 'validation',
        contextSize: input.contextSize,
        minimumContextSize: minimum,
        preferredContextSize: preferred,
        maximumContextSize: maximum,
        suggestion: 'Use either an exact contextSize or minimum/preferred/maximum context policy',
      }
    );
  }

  if (input.fit === 'on' && input.contextSize === undefined) {
    throw new ContextConstraintError(
      "fit: 'on' requires a concrete contextSize when context policy is used",
      {
        reason: 'fit-range-conflict',
        stage: 'validation',
        minimumContextSize: minimum,
        preferredContextSize: preferred,
        maximumContextSize: maximum,
        suggestion:
          "Use genai-electron sizing with fit: 'off', or provide a precomputed contextSize with the policy",
      }
    );
  }

  const parallelRequests = input.parallelRequests ?? 1;
  if (!isPositiveSafeInteger(parallelRequests)) {
    throw new ContextConstraintError(
      'parallelRequests must be a positive safe integer when context policy is used',
      {
        reason: 'unsafe-total-capacity',
        stage: 'validation',
        minimumContextSize: minimum,
        preferredContextSize: preferred,
        maximumContextSize: maximum,
        parallelRequests,
        suggestion: 'Use a positive integer number of parallel request slots',
      }
    );
  }

  const totalMinimum =
    minimum !== undefined ? checkedMultiply(minimum, parallelRequests, 'minimum') : undefined;
  const totalPreferred =
    preferred !== undefined ? checkedMultiply(preferred, parallelRequests, 'preferred') : undefined;
  const totalMaximum =
    maximum !== undefined ? checkedMultiply(maximum, parallelRequests, 'maximum') : undefined;

  if (input.contextSize !== undefined && options.allowExactWithPolicy) {
    const effectiveConfigured = Math.floor(input.contextSize / parallelRequests);
    if (
      !Number.isSafeInteger(effectiveConfigured) ||
      effectiveConfigured <= 0 ||
      (minimum !== undefined && effectiveConfigured < minimum) ||
      (maximum !== undefined && effectiveConfigured > maximum)
    ) {
      throw new ContextConstraintError(
        'The configured contextSize does not satisfy the retained per-slot hard bounds',
        {
          reason: 'precomputed-context-out-of-range',
          stage: 'validation',
          contextSize: input.contextSize,
          configuredContextSize: input.contextSize,
          effectiveContextSize: effectiveConfigured,
          minimumContextSize: minimum,
          preferredContextSize: preferred,
          maximumContextSize: maximum,
          parallelRequests,
          suggestion: 'Re-run getOptimalConfig() with the desired policy or adjust contextSize',
        }
      );
    }
  }

  return {
    hasContextPolicy: true,
    minimumContextSize: minimum,
    preferredContextSize: preferred,
    maximumContextSize: maximum,
    parallelRequests,
    totalMinimumContextSize: totalMinimum,
    totalPreferredContextSize: totalPreferred,
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
        preferredContextSize: constraints.preferredContextSize,
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
        preferredContextSize: constraints.preferredContextSize,
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
      preferredContextSize: constraints.preferredContextSize,
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
