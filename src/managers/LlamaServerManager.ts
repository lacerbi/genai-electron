/**
 * LlamaServerManager - Manages llama-server lifecycle
 *
 * Handles downloading binaries, starting/stopping llama-server processes,
 * health checking, and log management.
 *
 * @module managers/LlamaServerManager
 */

import { ServerManager } from './ServerManager.js';
import { ModelManager } from './ModelManager.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { ProcessManager } from '../process/ProcessManager.js';
import { checkHealth, waitForHealthy, normalizeHealthHost } from '../process/health-check.js';
import { parseLlamaCppLogLevel, stripLlamaCppFormatting } from '../process/llama-log-parser.js';
import type {
  ServerConfig,
  ServerInfo,
  LlamaServerConfig,
  HealthStatus,
  ModelInfo,
} from '../types/index.js';
import { ServerError, InsufficientResourcesError } from '../errors/index.js';
import { BINARY_VERSIONS, DEFAULT_PORTS, DEFAULT_TIMEOUTS } from '../config/defaults.js';
import { fileExists } from '../utils/file-utils.js';
import { debugLog } from '../utils/debug-log.js';

/**
 * Internal config shape after the port has been resolved to a concrete number
 */
type ResolvedLlamaServerConfig = LlamaServerConfig & { port: number };

/**
 * LlamaServerManager class
 *
 * Manages the lifecycle of llama-server processes.
 *
 * Features:
 * - Automatic binary download on first start
 * - Auto-configuration based on system capabilities
 * - Process monitoring and health checking
 * - Log capture and retrieval
 * - Graceful shutdown with timeout
 *
 * @example
 * ```typescript
 * import { llamaServer } from 'genai-electron';
 *
 * // Start server
 * await llamaServer.start({
 *   modelId: 'my-model',
 *   port: 8080
 * });
 *
 * // Check health
 * const healthy = await llamaServer.isHealthy();
 *
 * // Get logs
 * const logs = await llamaServer.getLogs();
 *
 * // Stop server
 * await llamaServer.stop();
 * ```
 */
export class LlamaServerManager extends ServerManager {
  /** Fields accepted by LlamaServerManager.start() (ServerConfig + LlamaServerConfig) */
  private static readonly VALID_CONFIG_FIELDS: ReadonlySet<string> = new Set([
    'modelId',
    'port',
    'threads',
    'contextSize',
    'gpuLayers',
    'parallelRequests',
    'flashAttention',
    'forceValidation',
    'modelAlias',
    'continuousBatching',
    'batchSize',
    'useMmap',
    'useMlock',
    'startupTimeout',
    'jinja',
    'host',
    'cacheTypeK',
    'cacheTypeV',
    'overrideTensors',
    'cacheRam',
    'cpuMoe',
    'nCpuMoe',
    'reasoningFormat',
    'fit',
  ]);

  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private binaryPath?: string;
  /** Host used for health checks (config.host normalized; 0.0.0.0/:: → 127.0.0.1) */
  private healthHost = '127.0.0.1';

  /**
   * Create a new LlamaServerManager
   *
   * @param modelManager - Model manager instance (default: singleton)
   * @param systemInfo - System info instance (default: singleton)
   */
  constructor(
    modelManager: ModelManager = ModelManager.getInstance(),
    systemInfo: SystemInfo = SystemInfo.getInstance()
  ) {
    super();
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;
  }

  /**
   * Start llama-server
   *
   * Downloads binary if not present, validates model exists, auto-configures
   * settings if not specified, spawns the process, and waits for health check.
   *
   * @param config - Server configuration
   * @returns Server information
   * @throws {ModelNotFoundError} If model doesn't exist
   * @throws {PortInUseError} If port is already in use
   * @throws {BinaryError} If binary download/verification fails
   * @throws {InsufficientResourcesError} If system can't run the model
   * @throws {ServerError} If server fails to start
   */
  async start(config: ServerConfig): Promise<ServerInfo> {
    // Check if already running
    if (this._status === 'running') {
      throw new ServerError('Server is already running', {
        suggestion: 'Stop the server first with stop()',
      });
    }

    // Validate config fields before proceeding
    this.validateConfigFields(
      config as unknown as Record<string, unknown>,
      LlamaServerManager.VALID_CONFIG_FIELDS,
      'LlamaServerManager'
    );

    this.setStatus('starting');

    // Resolve the port once, up front — every later step (availability check,
    // health polling, CLI args, saved config for restart) uses this value.
    const resolvedPort = config.port ?? DEFAULT_PORTS.llama;

    try {
      // 1. Validate model exists
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);

      // 2. Check if system can run this model
      const canRun = await this.systemInfo.canRunModel(modelInfo, {
        gpuLayers: config.gpuLayers,
      });
      if (!canRun.possible) {
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Available RAM: ${Math.round(
              (await this.systemInfo.getMemoryInfo()).available / 1024 / 1024 / 1024
            )}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
          }
        );
      }

      // 3. Ensure binary is downloaded (pass model path for real functionality testing)
      this.binaryPath = await this.ensureBinary(modelInfo.path, config.forceValidation);

      // 4. Check if port is in use
      await this.checkPortAvailability(resolvedPort);

      // 5. Auto-configure if needed
      const finalConfig = await this.autoConfigureIfNeeded(
        { ...config, port: resolvedPort },
        modelInfo
      );

      // 5b. Quantized V-cache requires flash attention ON (llama.cpp runtime constraint)
      const quantizedVCache =
        finalConfig.cacheTypeV !== undefined &&
        finalConfig.cacheTypeV !== 'f16' &&
        finalConfig.cacheTypeV !== 'bf16';
      if (quantizedVCache) {
        if (finalConfig.flashAttention === undefined || finalConfig.flashAttention === 'auto') {
          debugLog('[LlamaServer] cacheTypeV is quantized - forcing flashAttention on');
          finalConfig.flashAttention = 'on';
        } else if (finalConfig.flashAttention === false || finalConfig.flashAttention === 'off') {
          throw new ServerError(
            `Quantized V-cache (cacheTypeV: '${finalConfig.cacheTypeV}') requires flash attention`,
            {
              suggestion:
                "Set flashAttention to 'on' (or leave it unset) when using a quantized cacheTypeV, or use cacheTypeV: 'f16'",
            }
          );
        }
      }

      this.healthHost = normalizeHealthHost(finalConfig.host);

      // 6. Save final configuration (AFTER auto-configuration)
      this._config = finalConfig;

      // 7. Initialize log manager
      await this.initializeLogManager(
        'llama-server.log',
        `Starting llama-server on port ${finalConfig.port}`
      );

      // 8. Build command-line arguments
      const args = this.buildCommandLineArgs(finalConfig, modelInfo);

      // 9. Verify binary exists before spawning
      if (!this.binaryPath) {
        throw new ServerError('Binary path is not set', {
          suggestion: 'This is an internal error - binary should have been downloaded',
        });
      }

      if (!(await fileExists(this.binaryPath))) {
        throw new ServerError(`Binary file not found: ${this.binaryPath}`, {
          path: this.binaryPath,
          suggestion: 'Try deleting the binaries directory and restarting the app',
        });
      }

      await this.logManager!.write(
        `Spawning llama-server: ${this.binaryPath} with args: ${args.join(' ')}`,
        'info'
      );

      // 10. Spawn the process
      const { pid } = this.processManager.spawn(this.binaryPath, args, {
        onStdout: (data) => this.handleStdout(data),
        onStderr: (data) => this.handleStderr(data),
        onExit: (code, signal) => this.handleExit(code, signal),
        onError: (error) => this.handleSpawnError(error),
      });

      this._pid = pid;
      this._port = finalConfig.port;

      await this.logManager!.write(
        `Process spawned with PID ${pid}, waiting for health check...`,
        'info'
      );

      // 10. Wait for server to be healthy
      await waitForHealthy(
        finalConfig.port,
        finalConfig.startupTimeout ?? DEFAULT_TIMEOUTS.serverStart,
        undefined,
        undefined,
        this.healthHost
      );

      this._startedAt = new Date();
      this.setStatus('running');

      await this.logManager!.write('Server is running and healthy', 'info');

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      // Emit started event
      this.emitEvent('started', this.getInfo());

      return this.getInfo();
    } catch (error) {
      throw await this.handleStartupError('llama-server', error, async () => {
        if (this._pid && this.processManager.isRunning(this._pid)) {
          await this.processManager.kill(this._pid, 5000);
        }
      });
    }
  }

  /**
   * Stop llama-server
   *
   * Performs graceful shutdown with SIGTERM, waits for timeout, then force kills if needed.
   *
   * @throws {ServerError} If stop fails
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      return; // Already stopped
    }

    this.setStatus('stopping');

    try {
      if (this.logManager) {
        await this.logManager.write('Stopping server...', 'info');
      }

      if (this._pid) {
        await this.processManager.kill(this._pid, DEFAULT_TIMEOUTS.serverStop);
      }

      this.setStatus('stopped');
      this._pid = undefined;
      this._port = 0;

      if (this.logManager) {
        await this.logManager.write('Server stopped', 'info');
      }

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      // Emit stopped event
      this.emitEvent('stopped');
    } catch (error) {
      this.setStatus('stopped'); // Force to stopped state
      throw new ServerError(
        `Failed to stop server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Check if server is healthy
   *
   * @returns True if server responds with 'ok' status
   */
  async isHealthy(): Promise<boolean> {
    if (this._status !== 'running' || this._port === 0) {
      return false;
    }

    try {
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck, this.healthHost);
      return health.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Get detailed health status
   *
   * @returns Health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    if (this._status !== 'running' || this._port === 0) {
      return 'unknown';
    }

    try {
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck, this.healthHost);
      return health.status;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Ensure llama-server binary is downloaded
   *
   * Downloads binary from GitHub releases if not present. Tries multiple variants
   * in priority order (CUDA → Vulkan → CPU) and uses the first one that works.
   * Caches validation results for faster startup next time.
   *
   * For updating to new llama.cpp releases, see docs/dev/UPDATING-BINARIES.md
   *
   * @param modelPath - Optional model path for real functionality testing
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails for all variants
   * @private
   */
  private async ensureBinary(modelPath?: string, forceValidation = false): Promise<string> {
    return this.ensureBinaryHelper(
      'llama',
      'llama-server',
      BINARY_VERSIONS.llamaServer,
      modelPath,
      forceValidation
    );
  }

  /**
   * Auto-configure server settings if not specified
   *
   * Uses SystemInfo to determine optimal settings for the model.
   *
   * @param config - User-provided configuration
   * @param modelInfo - Model information
   * @returns Final configuration with auto-configured values
   * @private
   */
  private async autoConfigureIfNeeded(
    config: ServerConfig & { port: number },
    modelInfo: any
  ): Promise<ResolvedLlamaServerConfig> {
    debugLog('[LlamaServer] autoConfigureIfNeeded input:', JSON.stringify(config));

    const optimalConfig = await this.systemInfo.getOptimalConfig(modelInfo);
    debugLog('[LlamaServer] Optimal config:', JSON.stringify(optimalConfig));

    // With fit: 'on', llama-server's own auto-fit sizes unset memory-related
    // fields — leave gpuLayers/contextSize unset instead of filling them here.
    const delegateToFit = (config as LlamaServerConfig).fit === 'on';

    const finalConfig = {
      ...config,
      threads: config.threads ?? optimalConfig.threads,
      contextSize: config.contextSize ?? (delegateToFit ? undefined : optimalConfig.contextSize),
      gpuLayers: config.gpuLayers ?? (delegateToFit ? undefined : optimalConfig.gpuLayers),
      parallelRequests: config.parallelRequests ?? optimalConfig.parallelRequests,
      flashAttention: config.flashAttention ?? optimalConfig.flashAttention,
    } as ResolvedLlamaServerConfig;

    debugLog('[LlamaServer] Final config:', JSON.stringify(finalConfig));

    return finalConfig;
  }

  /**
   * Build command-line arguments for llama-server
   *
   * --jinja is passed unconditionally (unless config.jinja === false): the
   * model's embedded chat template is required for chat_template_kwargs
   * features (e.g. genai-lite's reasoning toggle on hybrid models). Reasoning
   * extraction itself is left to the server default (--reasoning-format auto).
   *
   * @param config - Server configuration (port already resolved)
   * @param modelInfo - Model information (includes path)
   * @returns Array of command-line arguments
   * @private
   */
  private buildCommandLineArgs(config: ResolvedLlamaServerConfig, modelInfo: ModelInfo): string[] {
    const args: string[] = [];

    // Model path
    args.push('-m', modelInfo.path);

    // Use the model's embedded Jinja chat template (default: on)
    // --jinja is the b9860 server default; both flags are passed explicitly to
    // pin behavior regardless of the binary's own default.
    if (config.jinja !== false) {
      args.push('--jinja');
    } else {
      args.push('--no-jinja');
    }

    // Host binding (server default: 127.0.0.1)
    if (config.host !== undefined) {
      args.push('--host', config.host);
    }

    // Port
    args.push('--port', String(config.port));

    // Threads
    if (config.threads !== undefined) {
      args.push('--threads', String(config.threads));
    }

    // Context size
    if (config.contextSize !== undefined) {
      args.push('-c', String(config.contextSize));
    }

    // Max predict tokens (-1 = unlimited, respect per-request max_tokens from API)
    // Without this flag, llama-server caps at contextSize/4 by default
    args.push('-n', '-1');

    // GPU layers — emitted even for 0: the b9860 server default is auto-offload,
    // so omitting -ngl for a CPU-only config would silently offload to GPU
    if (config.gpuLayers !== undefined) {
      args.push('-ngl', String(config.gpuLayers));
    }

    // Parallel requests
    if (config.parallelRequests !== undefined) {
      args.push('-np', String(config.parallelRequests));
    }

    // Flash attention tri-state (boolean accepted: true → on, false → off);
    // unset → omit and let the server decide ('auto')
    if (config.flashAttention !== undefined) {
      const fa =
        config.flashAttention === true
          ? 'on'
          : config.flashAttention === false
            ? 'off'
            : config.flashAttention;
      args.push('-fa', fa);
    }

    // Auto-fit of unset args to device memory. Default OFF: genai-electron
    // passes explicit values from its own auto-configuration, and auto-fit
    // has hung on some GPUs. fit: 'on' delegates sizing to llama-server.
    args.push('-fit', config.fit ?? 'off');

    // KV-cache quantization
    if (config.cacheTypeK !== undefined) {
      args.push('--cache-type-k', config.cacheTypeK);
    }
    if (config.cacheTypeV !== undefined) {
      args.push('--cache-type-v', config.cacheTypeV);
    }

    // MoE / tensor placement
    if (config.overrideTensors !== undefined) {
      args.push('-ot', config.overrideTensors);
    }
    if (config.cacheRam !== undefined) {
      args.push('--cache-ram', String(config.cacheRam));
    }
    if (config.cpuMoe === true) {
      args.push('--cpu-moe');
    }
    if (config.nCpuMoe !== undefined) {
      args.push('--n-cpu-moe', String(config.nCpuMoe));
    }

    // Reasoning-content extraction (server default: auto)
    if (config.reasoningFormat !== undefined) {
      args.push('--reasoning-format', config.reasoningFormat);
    }

    // Model alias reported by the API (see LlamaServerConfig.modelAlias warning)
    if (config.modelAlias !== undefined) {
      args.push('--alias', config.modelAlias);
    }

    // Logical batch size
    if (config.batchSize !== undefined) {
      args.push('-b', String(config.batchSize));
    }

    // Continuous batching is the server default; only the opt-out is emitted
    if (config.continuousBatching === false) {
      args.push('--no-cont-batching');
    }

    // mmap is the server default; only the opt-out is emitted
    if (config.useMmap === false) {
      args.push('--no-mmap');
    }

    // Lock model in memory
    if (config.useMlock === true) {
      args.push('--mlock');
    }

    return args;
  }

  /**
   * Handle stdout from llama-server
   *
   * Parses llama.cpp output to determine actual log levels and strips
   * llama.cpp's formatting to avoid duplicate timestamps.
   *
   * @param data - Stdout data
   * @private
   */
  private handleStdout(data: string): void {
    if (this.logManager) {
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        // Parse llama.cpp output to determine actual log level
        const level = parseLlamaCppLogLevel(line);

        // Strip llama.cpp's formatting (timestamp + level prefix)
        // so LogManager doesn't create duplicate timestamps
        const cleanMessage = stripLlamaCppFormatting(line);

        this.logManager.write(cleanMessage, level).catch(() => void 0);
      }
    }
  }

  /**
   * Handle stderr from llama-server
   *
   * Parses llama.cpp output to determine actual log levels and strips
   * llama.cpp's formatting to avoid duplicate timestamps.
   * llama.cpp logs everything to stderr as [ERROR], but we intelligently
   * categorize based on content (HTTP requests, slot operations, etc.)
   *
   * @param data - Stderr data
   * @private
   */
  private handleStderr(data: string): void {
    if (this.logManager) {
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        // Parse llama.cpp output to determine actual log level
        const level = parseLlamaCppLogLevel(line);

        // Strip llama.cpp's formatting (timestamp + level prefix)
        // so LogManager doesn't create duplicate timestamps
        const cleanMessage = stripLlamaCppFormatting(line);

        this.logManager.write(cleanMessage, level).catch(() => void 0);
      }
    }
  }

  /**
   * Handle spawn errors (e.g., ENOENT when binary not found)
   *
   * @param error - Spawn error
   * @private
   */
  private handleSpawnError(error: Error): void {
    if (this.logManager) {
      this.logManager.write(`Spawn error: ${error.message}`, 'error').catch(() => void 0);
    }
    // The error will be handled by the exit handler
    // which will emit a 'crashed' event
  }

  /**
   * Handle process exit
   *
   * @param code - Exit code
   * @param signal - Exit signal
   * @private
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasRunning = this._status === 'running';

    if (this.logManager) {
      this.logManager
        .write(`Process exited with code ${code}, signal ${signal}`, 'warn')
        .catch(() => void 0);
    }

    // Update status
    if (wasRunning && code !== 0 && code !== null) {
      // Unexpected exit = crash
      this.setStatus('crashed');
      this.emitEvent('crashed', { code, signal });
    } else {
      this.setStatus('stopped');
    }

    // Cleanup
    this._pid = undefined;
    this._port = 0;
  }
}
