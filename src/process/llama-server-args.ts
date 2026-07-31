/** Shared llama-server config normalization and argument construction. */

import { ServerError } from '../errors/index.js';
import type { LlamaServerConfig, ModelInfo } from '../types/index.js';

export type ResolvedLlamaServerConfig = LlamaServerConfig & { port: number };

/** Enforce llama.cpp's quantized-V/flash-attention constraint without mutation. */
export function normalizeLlamaVCacheConfig<T extends Partial<LlamaServerConfig>>(config: T): T {
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
  config: ResolvedLlamaServerConfig,
  modelInfo: ModelInfo,
  options: { enableSlotsEndpoint?: boolean; slotSavePath?: string } = {}
): string[] {
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
  if (options.enableSlotsEndpoint) args.push('--slots');
  if (options.slotSavePath) args.push('--slot-save-path', options.slotSavePath);
  return args;
}
