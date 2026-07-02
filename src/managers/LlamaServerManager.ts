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
import { checkHealth, waitForHealthy } from '../process/health-check.js';
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
  ]);

  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private binaryPath?: string;

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
        finalConfig.startupTimeout ?? DEFAULT_TIMEOUTS.serverStart
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
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck);
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
      const health = await checkHealth(this._port, DEFAULT_TIMEOUTS.healthCheck);
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

    const finalConfig = {
      ...config,
      threads: config.threads ?? optimalConfig.threads,
      contextSize: config.contextSize ?? optimalConfig.contextSize,
      gpuLayers: config.gpuLayers ?? optimalConfig.gpuLayers,
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
    if (config.jinja !== false) {
      args.push('--jinja');
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

    // GPU layers
    if (config.gpuLayers !== undefined && config.gpuLayers > 0) {
      args.push('-ngl', String(config.gpuLayers));
    }

    // Parallel requests
    if (config.parallelRequests !== undefined) {
      args.push('-np', String(config.parallelRequests));
    }

    // Flash attention
    if (config.flashAttention) {
      args.push('--flash-attn');
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
