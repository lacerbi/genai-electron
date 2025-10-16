/**
 * Server management types for process lifecycle and configuration
 * @module types/servers
 */

/**
 * Server status
 */
export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

/**
 * Server health status
 */
export type HealthStatus = 'ok' | 'loading' | 'error' | 'unknown';

/**
 * Base server configuration
 */
export interface ServerConfig {
  /** Model ID to load */
  modelId: string;

  /** Port to listen on */
  port: number;

  /** Number of CPU threads (auto-detected if not specified) */
  threads?: number;

  /** Context size in tokens */
  contextSize?: number;

  /** Number of GPU layers to offload (auto-detected if not specified) */
  gpuLayers?: number;

  /** Number of parallel request slots */
  parallelRequests?: number;

  /** Enable flash attention (if supported) */
  flashAttention?: boolean;
}

/**
 * Server status information
 */
export interface ServerInfo {
  /** Current server status */
  status: ServerStatus;

  /** Health check status */
  health: HealthStatus;

  /** Process ID (if running) */
  pid?: number;

  /** Port server is listening on */
  port: number;

  /** Model ID being served */
  modelId: string;

  /** When server was started (ISO timestamp, if running) */
  startedAt?: string;

  /** Last error message (if crashed) */
  error?: string;
}

/**
 * llama-server specific configuration
 * Extends base ServerConfig with llama.cpp-specific options
 */
export interface LlamaServerConfig extends ServerConfig {
  /** Model alias (for API identification) */
  modelAlias?: string;

  /** Enable continuous batching */
  continuousBatching?: boolean;

  /** Batch size */
  batchSize?: number;

  /** Enable mmap for model loading */
  useMmap?: boolean;

  /** Lock model in memory (prevents swapping) */
  useMlock?: boolean;
}

/**
 * Server event types
 */
export type ServerEvent =
  | 'started'
  | 'stopped'
  | 'crashed'
  | 'restarted'
  | 'health-check-ok'
  | 'health-check-failed';

/**
 * Server event data
 */
export interface ServerEventData {
  /** Event type */
  event: ServerEvent;

  /** Server info at time of event */
  serverInfo: ServerInfo;

  /** Error details (if event is 'crashed' or 'health-check-failed') */
  error?: Error;

  /** Event timestamp */
  timestamp: string;
}
