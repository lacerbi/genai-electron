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

  /**
   * Port to listen on
   * Optional — defaults to DEFAULT_PORTS.llama (8080) for LlamaServerManager
   * and DEFAULT_PORTS.diffusion (8081) for DiffusionServerManager.
   */
  port?: number;

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

  /**
   * Force binary validation even if cached validation exists
   * Default: false (use cached validation if available)
   * Set to true to re-run Phase 1 & Phase 2 tests (e.g., after driver updates)
   */
  forceValidation?: boolean;

  /**
   * Maximum time to wait for the server to become healthy after spawn (milliseconds)
   * Default: DEFAULT_TIMEOUTS.serverStart (120000 = 2 minutes).
   * Cold loads of large models (10-20 GB GGUFs, slow disks) may need more.
   */
  startupTimeout?: number;
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
  /**
   * Model alias reported by the server's API (--alias)
   *
   * WARNING: clients such as genai-lite detect the model family (sampling
   * defaults, reasoning capabilities) from the model name the server reports.
   * Setting an alias masks the GGUF filename and can break that detection —
   * leave unset unless you have a specific reason.
   */
  modelAlias?: string;

  /**
   * Continuous batching (llama-server default: enabled)
   * Set to false to disable via --no-cont-batching; true/undefined emit nothing.
   */
  continuousBatching?: boolean;

  /** Logical batch size (-b) */
  batchSize?: number;

  /**
   * Memory-map the model file (llama-server default: enabled)
   * Set to false to disable via --no-mmap; true/undefined emit nothing.
   */
  useMmap?: boolean;

  /** Lock model in memory to prevent swapping (--mlock) */
  useMlock?: boolean;

  /**
   * Use the model's embedded Jinja chat template (--jinja)
   * Default: true (required for chat_template_kwargs features such as
   * genai-lite's reasoning toggle on hybrid models). Set to false to disable.
   */
  jinja?: boolean;
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
  | 'health-check-failed'
  | 'binary-log';

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

/**
 * Binary download/testing log event data
 * Emitted during binary variant testing and download progress
 */
export interface BinaryLogEvent {
  /** Log message */
  message: string;

  /** Log level */
  level: 'info' | 'warn' | 'error';
}
