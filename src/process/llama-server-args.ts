/** Shared llama-server config normalization and argument construction. */

import { ServerError } from '../errors/index.js';
import type { LlamaServerConfig, LlamaServerRuntimeConfig } from '../types/index.js';

export type ResolvedLlamaServerConfig = LlamaServerConfig & { port: number };

/**
 * Canonical runtime config with a concrete port.
 *
 * @example
 * ```ts
 * const config: ResolvedLlamaServerRuntimeConfig = { port: 12345, gpuLayers: 40 };
 * ```
 */
export type ResolvedLlamaServerRuntimeConfig = LlamaServerRuntimeConfig & { port: number };

/**
 * Minimal model input required to construct llama-server arguments.
 *
 * @example
 * ```ts
 * const model: LlamaModelFile = { path: '/opt/models/model.gguf' };
 * ```
 */
export interface LlamaModelFile {
  /** Absolute or caller-resolved GGUF path passed to llama-server via `-m`. */
  path: string;
}

/**
 * `/slots` endpoint exposure mode for the pinned llama-server contract.
 *
 * @example
 * ```ts
 * const slots: LlamaSlotsEndpointMode = 'disabled';
 * ```
 */
export type LlamaSlotsEndpointMode = 'default' | 'enabled' | 'disabled';

/**
 * Optional canonical argument-builder controls.
 *
 * @example
 * ```ts
 * const options: LlamaServerArgsOptions = {
 *   slotsEndpoint: 'enabled',
 *   slotSavePath: '/var/tmp/llama-slots',
 * };
 * ```
 */
export interface LlamaServerArgsOptions {
  /** Omit a flag for the server default, or explicitly enable/disable `/slots`. */
  slotsEndpoint?: LlamaSlotsEndpointMode;
  /** Directory supplied to llama-server for saved slot state. */
  slotSavePath?: string;
}

/** Enforce llama.cpp's quantized-V/flash-attention constraint without mutation. */
export function normalizeLlamaVCacheConfig<T extends Partial<LlamaServerRuntimeConfig>>(
  config: T
): T {
  const quantizedVCache =
    config.cacheTypeV !== undefined && config.cacheTypeV !== 'f16' && config.cacheTypeV !== 'bf16';
  if (!quantizedVCache) return { ...config };
  if (config.flashAttention === false || config.flashAttention === 'off') {
    throw new ServerError(
      `Quantized V-cache (cacheTypeV: '${config.cacheTypeV}') requires flash attention`,
      {
        suggestion:
          "Set flashAttention to 'on' (or leave it unset) when using a quantized cacheTypeV, or use cacheTypeV: 'f16'",
      }
    );
  }
  if (config.flashAttention === undefined || config.flashAttention === 'auto') {
    return { ...config, flashAttention: 'on' };
  }
  return { ...config };
}

/** Construct production-equivalent llama-server argv. */
export function buildLlamaServerArgs(
  config: ResolvedLlamaServerRuntimeConfig,
  modelInfo: LlamaModelFile,
  options: LlamaServerArgsOptions = {}
): string[] {
  if (options.slotsEndpoint === 'disabled' && options.slotSavePath !== undefined) {
    throw new ServerError('slotSavePath cannot be used when the /slots endpoint is disabled', {
      slotsEndpoint: options.slotsEndpoint,
      slotSavePath: options.slotSavePath,
      suggestion: "Use slotsEndpoint: 'enabled' or omit slotSavePath",
    });
  }

  const args: string[] = ['-m', modelInfo.path];
  args.push(config.jinja !== false ? '--jinja' : '--no-jinja');
  if (config.host !== undefined) args.push('--host', config.host);
  args.push('--port', String(config.port));
  if (config.threads !== undefined) args.push('--threads', String(config.threads));
  if (config.contextSize !== undefined) args.push('-c', String(config.contextSize));
  args.push('-n', '-1');
  if (config.gpuLayers !== undefined) args.push('-ngl', String(config.gpuLayers));
  if (config.parallelRequests !== undefined) args.push('-np', String(config.parallelRequests));
  if (config.flashAttention !== undefined) {
    const flashAttention =
      config.flashAttention === true
        ? 'on'
        : config.flashAttention === false
          ? 'off'
          : config.flashAttention;
    args.push('-fa', flashAttention);
  }
  args.push('-fit', config.fit ?? 'off');
  if (config.cacheTypeK !== undefined) args.push('--cache-type-k', config.cacheTypeK);
  if (config.cacheTypeV !== undefined) args.push('--cache-type-v', config.cacheTypeV);
  if (config.swaFull === true) args.push('--swa-full');
  if (config.overrideTensors !== undefined) args.push('-ot', config.overrideTensors);
  if (config.cacheRam !== undefined) args.push('--cache-ram', String(config.cacheRam));
  if (config.cpuMoe === true) args.push('--cpu-moe');
  if (config.nCpuMoe !== undefined) args.push('--n-cpu-moe', String(config.nCpuMoe));
  if (config.reasoningFormat !== undefined) args.push('--reasoning-format', config.reasoningFormat);
  if (config.modelAlias !== undefined) args.push('--alias', config.modelAlias);
  if (config.batchSize !== undefined) args.push('-b', String(config.batchSize));
  if (config.continuousBatching === false) args.push('--no-cont-batching');
  if (config.useMmap === false) args.push('--no-mmap');
  if (config.useMlock === true) args.push('--mlock');
  if (options.slotsEndpoint === 'enabled') args.push('--slots');
  if (options.slotsEndpoint === 'disabled') args.push('--no-slots');
  if (options.slotSavePath) args.push('--slot-save-path', options.slotSavePath);
  return args;
}
