/**
 * Electron-free llama-server launch facade.
 *
 * This package subpath supports native ESM import. CommonJS builds that rewrite
 * dynamic `import()` to `require()` are outside the execution contract.
 *
 * @module llama-server-launch
 */

export { buildLlamaServerArgs, normalizeLlamaVCacheConfig } from './process/llama-server-args.js';
export { startLlamaServerRunner } from './process/llama-server-runner.js';
export {
  waitForHealthy,
  checkHealth,
  isServerResponding,
  normalizeHealthHost,
  formatHttpHost,
} from './process/health-check.js';
export { fetchLlamaRuntimeCapacity } from './process/llama-props.js';
export { findFreePort, isPortBindable } from './process/port-utils.js';
export {
  GenaiElectronError,
  ServerError,
  ContextConstraintError,
  PortInUseError,
} from './errors/index.js';

export type {
  LlamaModelFile,
  LlamaSlotsEndpointMode,
  LlamaServerArgsOptions,
  ResolvedLlamaServerRuntimeConfig,
} from './process/llama-server-args.js';
export type {
  StartLlamaServerRunnerOptions,
  LlamaServerHandle,
  LlamaServerExit,
} from './process/llama-server-runner.js';
export type { LlamaRuntimeCapacity, VerifiedLlamaRuntimeCapacity } from './process/llama-props.js';
export type { HealthCheckResponse } from './process/health-check.js';
export type {
  LlamaServerConfig,
  LlamaServerRuntimeConfig,
  LlamaServerRunnerConfig,
  ResolvedLlamaServerRunnerConfig,
  KVCacheType,
  FlashAttentionSetting,
} from './types/servers.js';
