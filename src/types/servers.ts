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
 * KV-cache quantization type for llama-server --cache-type-k/--cache-type-v
 * (llama-server default: f16)
 */
export type KVCacheType = 'f16' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'iq4_nl';

/**
 * Flash attention setting: llama-server tri-state, plus boolean for
 * backwards compatibility (true → 'on', false → 'off').
 * When unset, nothing is emitted and the server decides ('auto').
 */
export type FlashAttentionSetting = boolean | 'on' | 'off' | 'auto';

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
   * 'auto' picks a free OS-assigned port (see ServerInfo.port for the result).
   */
  port?: number | 'auto';

  /** Number of CPU threads (auto-detected if not specified) */
  threads?: number;

  /** Context size in tokens */
  contextSize?: number;

  /** Number of GPU layers to offload (auto-detected if not specified) */
  gpuLayers?: number;

  /** Number of parallel request slots */
  parallelRequests?: number;

  /**
   * Flash attention ('on' | 'off' | 'auto'; boolean accepted for
   * backwards compatibility: true → 'on', false → 'off').
   * Default: unset → server decides ('auto').
   */
  flashAttention?: FlashAttentionSetting;

  /**
   * Host/interface the server binds to (--host)
   * Default: unset → llama-server's default (127.0.0.1, loopback only).
   * Health checks target this host (0.0.0.0/:: are checked via 127.0.0.1).
   */
  host?: string;

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

  /**
   * How long the last successful start took, spawn → healthy, in milliseconds
   * (llama-server only; undefined before the first successful start)
   */
  loadTimeMs?: number;
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

  /**
   * KV-cache quantization for keys (--cache-type-k)
   * e.g. 'q8_0' — significant VRAM savings on long contexts. Default: unset (f16).
   */
  cacheTypeK?: KVCacheType;

  /**
   * KV-cache quantization for values (--cache-type-v)
   * NOTE: quantized V-cache requires flash attention ON. When set to a quantized
   * type with flashAttention unset, flash attention is auto-upgraded to 'on';
   * combining it with flashAttention: 'off'/false throws at start().
   */
  cacheTypeV?: KVCacheType;

  /**
   * Tensor buffer-type overrides (-ot / --override-tensor)
   * e.g. 'exps=CPU' keeps MoE expert weights on CPU to fit large MoE models in VRAM.
   */
  overrideTensors?: string;

  /**
   * Maximum CPU-side prompt/KV cache in MiB (--cache-ram)
   * Pairs with overrideTensors for MoE-offload setups. -1 = no limit, 0 = disable.
   */
  cacheRam?: number;

  /** Keep ALL MoE expert weights on CPU (--cpu-moe) — ergonomic alternative to overrideTensors */
  cpuMoe?: boolean;

  /** Keep the first N layers' MoE expert weights on CPU (--n-cpu-moe N) */
  nCpuMoe?: number;

  /**
   * Reasoning-content extraction format (--reasoning-format)
   * Default: unset → server default ('auto'). Set 'none' to leave thoughts
   * inline in message.content, or 'deepseek' to force reasoning_content parsing.
   */
  reasoningFormat?: 'auto' | 'deepseek' | 'deepseek-legacy' | 'none';

  /**
   * llama-server auto-fit of unset parameters to device memory (-fit)
   * Default: 'off' — genai-electron computes explicit values via its own
   * auto-configuration, and auto-fit has hung on some GPUs. Setting 'on'
   * delegates to llama-server instead: genai-electron then skips its own
   * gpuLayers/contextSize auto-configuration for unset fields.
   */
  fit?: 'on' | 'off';

  /**
   * Cross-app occupancy safety rail: before starting, probe common llama-server
   * ports (8080-8083) for another llama-server that could double-load VRAM.
   * 'warn' (default): log a warning and continue; 'strict': throw; 'off': skip.
   */
  occupancyCheck?: 'warn' | 'strict' | 'off';

  /**
   * Automatically restart the server after an unexpected crash (default: false)
   * Restarts are scheduled with exponential backoff (1s, 2s, 4s, ...) and reuse
   * the previously resolved configuration (including the concrete port).
   * Intentional stop() never triggers a restart.
   */
  autoRestart?: boolean;

  /** Maximum consecutive auto-restart attempts before staying 'crashed' (default: 3) */
  maxRestarts?: number;

  /**
   * Hang watchdog: poll the health endpoint every N milliseconds while running
   * (default: disabled). Emits 'health-check-ok' / 'health-check-failed' events;
   * after 3 consecutive failures the process is killed, which feeds autoRestart
   * when enabled.
   */
  healthCheckInterval?: number;
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
