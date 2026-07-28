/**
 * Strict llama-server `/props` capacity discovery.
 *
 * @module process/llama-props
 */

import { ContextConstraintError } from '../errors/index.js';
import { formatHttpHost } from './health-check.js';

export interface LlamaRuntimeCapacity {
  /** Effective context tokens available to each request slot. */
  effectiveContextSize: number;
  /** Runtime slot count when reported by llama-server. */
  totalSlots?: number;
}

function runtimeUnavailable(
  message: string,
  cause: string,
  parallelRequests: number
): ContextConstraintError {
  return new ContextConstraintError(message, {
    reason: 'runtime-capacity-unavailable',
    stage: 'runtime',
    parallelRequests,
    cause,
    suggestion: 'Check llama-server logs and verify that GET /props returns a compatible response',
  });
}

/**
 * Fetch and normalize effective llama-server capacity.
 */
export async function fetchLlamaRuntimeCapacity(
  port: number,
  host: string,
  parallelRequests: number,
  timeout = 5000
): Promise<LlamaRuntimeCapacity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const url = `http://${formatHttpHost(host)}:${port}/props`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw runtimeUnavailable(
        `llama-server /props returned HTTP ${response.status}`,
        `HTTP ${response.status}`,
        parallelRequests
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw runtimeUnavailable(
        'llama-server /props did not return valid JSON',
        error instanceof Error ? error.message : String(error),
        parallelRequests
      );
    }

    if (typeof payload !== 'object' || payload === null) {
      throw runtimeUnavailable(
        'llama-server /props returned an invalid object',
        'Expected a JSON object',
        parallelRequests
      );
    }

    const defaultSettings = (payload as Record<string, unknown>).default_generation_settings;
    if (typeof defaultSettings !== 'object' || defaultSettings === null) {
      throw runtimeUnavailable(
        'llama-server /props is missing default_generation_settings',
        'Missing default_generation_settings object',
        parallelRequests
      );
    }

    const effectiveContextSize = (defaultSettings as Record<string, unknown>).n_ctx;
    if (
      typeof effectiveContextSize !== 'number' ||
      !Number.isSafeInteger(effectiveContextSize) ||
      effectiveContextSize <= 0
    ) {
      throw runtimeUnavailable(
        'llama-server /props reported an invalid effective context',
        `Invalid default_generation_settings.n_ctx: ${String(effectiveContextSize)}`,
        parallelRequests
      );
    }

    const rawTotalSlots = (payload as Record<string, unknown>).total_slots;
    let totalSlots: number | undefined;
    if (rawTotalSlots !== undefined) {
      if (
        typeof rawTotalSlots !== 'number' ||
        !Number.isSafeInteger(rawTotalSlots) ||
        rawTotalSlots <= 0
      ) {
        throw runtimeUnavailable(
          'llama-server /props reported an invalid slot count',
          `Invalid total_slots: ${String(rawTotalSlots)}`,
          parallelRequests
        );
      }
      totalSlots = rawTotalSlots;
      if (totalSlots !== parallelRequests) {
        throw new ContextConstraintError(
          `llama-server reported ${totalSlots} slots, but ${parallelRequests} were configured`,
          {
            reason: 'runtime-slots-mismatch',
            stage: 'runtime',
            effectiveContextSize,
            parallelRequests,
            effectiveParallelRequests: totalSlots,
            suggestion: 'Check the emitted -np argument and llama-server fitting behavior',
          }
        );
      }
    }

    return { effectiveContextSize, totalSlots };
  } catch (error) {
    if (error instanceof ContextConstraintError) {
      throw error;
    }
    const cause =
      error instanceof Error && error.name === 'AbortError'
        ? `Timed out after ${timeout}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw runtimeUnavailable(
      'Could not read effective context from llama-server /props',
      cause,
      parallelRequests
    );
  } finally {
    clearTimeout(timer);
  }
}
