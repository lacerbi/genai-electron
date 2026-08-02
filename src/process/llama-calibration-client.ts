/** Strict HTTP client for llama-server calibration workloads. */

import { ServerError } from '../errors/index.js';
import type { LlamaCalibrationRequestTiming } from '../types/index.js';
import type { LlamaServerRunner } from './llama-server-runner.js';

interface CompletionOptions {
  prompt: string;
  nPredict: number;
  seed: number;
  slotId: number;
  cachePrompt: boolean;
  requireCacheObservation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class LlamaCalibrationClient {
  private readonly baseUrl: string;

  constructor(
    private readonly runner: LlamaServerRunner,
    private readonly requestTimeoutMs: number,
    private readonly signal?: AbortSignal
  ) {
    this.baseUrl = `http://127.0.0.1:${runner.port}`;
  }

  private async request(
    path: string,
    init: RequestInit,
    requestTimeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    this.signal?.throwIfAborted();
    // AbortSignal.timeout() rejects a non-integer delay. Adaptive completion caps
    // are derived from performance.now() deltas and are therefore fractional, so
    // normalize here as well as at the source: a caller passing a float must not
    // turn a healthy probe into a spurious operational failure.
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(requestTimeoutMs)));
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    try {
      const response = await this.runner.raceWithExit(
        fetch(`${this.baseUrl}${path}`, { ...init, signal })
      );
      if (!response.ok) {
        throw new ServerError(`llama-server ${path} returned HTTP ${response.status}`, {
          code: 'CALIBRATION_REQUEST_FAILED',
          path,
          status: response.status,
        });
      }
      try {
        return await this.runner.raceWithExit(response.json() as Promise<unknown>);
      } catch (error) {
        if (error instanceof ServerError) throw error;
        throw new ServerError(`llama-server ${path} did not return valid JSON`, {
          code: 'CALIBRATION_REQUEST_FAILED',
          path,
        });
      }
    } catch (error) {
      if (this.signal?.aborted) {
        throw new ServerError('LLM calibration aborted', {
          code: 'CALIBRATION_ABORTED',
          cause: this.signal.reason,
        });
      }
      if (timeout.aborted) {
        throw new ServerError(`llama-server ${path} timed out`, {
          code: 'CALIBRATION_REQUEST_TIMEOUT',
          path,
          timeoutMs: requestTimeoutMs,
        });
      }
      throw error;
    }
  }

  async tokenize(prompt: string): Promise<number> {
    const payload = await this.request('/tokenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ content: prompt, add_special: true, parse_special: true }),
    });
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.tokens) ||
      payload.tokens.some((token) => nonNegativeSafeInteger(token) === undefined)
    ) {
      throw new ServerError('llama-server /tokenize returned an invalid token array', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    return payload.tokens.length;
  }

  async eraseSlot(slotId: number): Promise<void> {
    const payload = await this.request(`/slots/${slotId}?action=erase`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!isRecord(payload)) {
      throw new ServerError('llama-server slot erase returned an invalid response', {
        code: 'CALIBRATION_REQUEST_FAILED',
        slotId,
      });
    }
    const responseSlot = nonNegativeSafeInteger(payload.id_slot);
    const erasedTokens = nonNegativeSafeInteger(payload.n_erased);
    if (responseSlot !== slotId || erasedTokens === undefined) {
      throw new ServerError('llama-server slot erase returned an invalid acknowledgement', {
        code: 'CALIBRATION_REQUEST_FAILED',
        slotId,
        responseSlot,
        erasedTokens,
      });
    }
  }

  async complete(
    options: CompletionOptions,
    completionTimeoutMs = this.requestTimeoutMs
  ): Promise<LlamaCalibrationRequestTiming> {
    const startedAt = performance.now();
    const payload = await this.request(
      '/completion',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          prompt: options.prompt,
          n_predict: options.nPredict,
          seed: options.seed,
          temperature: 0,
          top_k: 1,
          top_p: 1,
          min_p: 0,
          stream: false,
          ignore_eos: true,
          cache_prompt: options.cachePrompt,
          id_slot: options.slotId,
        }),
      },
      completionTimeoutMs
    );
    const wallTimeMs = performance.now() - startedAt;
    if (!isRecord(payload) || !isRecord(payload.timings)) {
      throw new ServerError('llama-server /completion returned invalid timing data', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }

    const timings = payload.timings;
    const processedPromptTokens = nonNegativeSafeInteger(timings.prompt_n);
    const totalPromptTokens = nonNegativeSafeInteger(payload.tokens_evaluated);
    if (
      ('prompt_n' in timings && processedPromptTokens === undefined) ||
      ('tokens_evaluated' in payload && totalPromptTokens === undefined)
    ) {
      throw new ServerError('llama-server /completion returned invalid prompt token counts', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    const promptTokens = processedPromptTokens ?? totalPromptTokens;
    const promptMs = finiteNonNegative(timings.prompt_ms);
    const promptTokensPerSecond = finiteNonNegative(timings.prompt_per_second);
    const predictedTokens =
      nonNegativeSafeInteger(timings.predicted_n) ??
      nonNegativeSafeInteger(payload.tokens_predicted);
    if (
      ('predicted_n' in timings && nonNegativeSafeInteger(timings.predicted_n) === undefined) ||
      ('tokens_predicted' in payload &&
        nonNegativeSafeInteger(payload.tokens_predicted) === undefined)
    ) {
      throw new ServerError('llama-server /completion returned invalid prediction token counts', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    const predictedMs = finiteNonNegative(timings.predicted_ms);
    const predictedTokensPerSecond = finiteNonNegative(timings.predicted_per_second);
    const explicitCacheHit = nonNegativeSafeInteger(timings.cache_n);
    if ('cache_n' in timings && explicitCacheHit === undefined) {
      throw new ServerError('llama-server /completion returned an invalid cache count', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    if (
      totalPromptTokens !== undefined &&
      processedPromptTokens !== undefined &&
      processedPromptTokens > totalPromptTokens
    ) {
      throw new ServerError('llama-server /completion returned inconsistent prompt-cache counts', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    const cachedTokens =
      explicitCacheHit ??
      (totalPromptTokens !== undefined && processedPromptTokens !== undefined
        ? totalPromptTokens - processedPromptTokens
        : undefined);

    if (promptTokens === undefined || predictedTokens === undefined) {
      throw new ServerError('llama-server /completion omitted prompt/prediction token counts', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }
    if (predictedTokens !== options.nPredict) {
      throw new ServerError('llama-server /completion returned an incomplete prediction', {
        code: 'CALIBRATION_REQUEST_FAILED',
        expectedPredictedTokens: options.nPredict,
        predictedTokens,
      });
    }
    if (options.requireCacheObservation && cachedTokens === undefined) {
      throw new ServerError('llama-server /completion omitted observable prompt-cache counts', {
        code: 'CALIBRATION_REQUEST_FAILED',
      });
    }

    return {
      wallTimeMs,
      promptTokens,
      promptMs,
      promptTokensPerSecond,
      predictedTokens,
      predictedMs,
      predictedTokensPerSecond,
      cachedTokens,
    };
  }
}
