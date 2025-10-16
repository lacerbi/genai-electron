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
import { LogManager } from '../process/log-manager.js';
import { checkHealth, waitForHealthy } from '../process/health-check.js';
import { Downloader } from '../download/Downloader.js';
import {
  ServerConfig,
  ServerInfo,
  LlamaServerConfig,
  HealthStatus,
} from '../types/index.js';
import {
  ServerError,
  ModelNotFoundError,
  PortInUseError,
  BinaryError,
  InsufficientResourcesError,
} from '../errors/index.js';
import { PATHS, getBinaryPath } from '../config/paths.js';
import { BINARY_VERSIONS, DEFAULT_TIMEOUTS } from '../config/defaults.js';
import { getPlatformKey } from '../utils/platform-utils.js';
import { fileExists, ensureDirectory, calculateChecksum } from '../utils/file-utils.js';
import { ChildProcess } from 'child_process';
import path from 'path';

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
  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private logManager?: LogManager;
  private _childProcess?: ChildProcess;
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

    this.setStatus('starting');
    this._config = config;

    try {
      // 1. Validate model exists
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);

      // 2. Check if system can run this model
      const canRun = await this.systemInfo.canRunModel(modelInfo);
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

      // 3. Ensure binary is downloaded
      this.binaryPath = await this.ensureBinary();

      // 4. Check if port is in use
      const { isServerResponding } = await import('../process/health-check.js');
      if (await isServerResponding(config.port, 2000)) {
        throw new PortInUseError(config.port);
      }

      // 5. Auto-configure if needed
      const finalConfig = await this.autoConfigureIfNeeded(config, modelInfo);

      // 6. Initialize log manager
      const logPath = path.join(PATHS.logs, 'llama-server.log');
      this.logManager = new LogManager(logPath);
      await this.logManager.initialize();
      await this.logManager.write(`Starting llama-server on port ${finalConfig.port}`, 'info');

      // 7. Build command-line arguments
      const args = this.buildCommandLineArgs(finalConfig, modelInfo.path);

      // 8. Spawn the process
      const { process: childProcess, pid } = this.processManager.spawn(
        this.binaryPath,
        args,
        {
          onStdout: (data) => this.handleStdout(data),
          onStderr: (data) => this.handleStderr(data),
          onExit: (code, signal) => this.handleExit(code, signal),
        }
      );

      this._childProcess = childProcess;
      this._pid = pid;
      this._port = finalConfig.port;

      await this.logManager.write(
        `Process spawned with PID ${pid}, waiting for health check...`,
        'info'
      );

      // 9. Wait for server to be healthy
      await waitForHealthy(finalConfig.port, DEFAULT_TIMEOUTS.serverStart);

      this._startedAt = new Date();
      this.setStatus('running');

      await this.logManager.write('Server is running and healthy', 'info');

      // Emit started event
      this.emitEvent('started', this.getInfo());

      return this.getInfo();
    } catch (error) {
      // Cleanup on failure
      this.setStatus('stopped');
      if (this._pid && this.processManager.isRunning(this._pid)) {
        await this.processManager.kill(this._pid, 5000);
      }

      if (this.logManager) {
        await this.logManager.write(
          `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
      }

      // Re-throw typed errors
      if (
        error instanceof ModelNotFoundError ||
        error instanceof PortInUseError ||
        error instanceof BinaryError ||
        error instanceof InsufficientResourcesError ||
        error instanceof ServerError
      ) {
        throw error;
      }

      // Wrap unknown errors
      throw new ServerError(
        `Failed to start llama-server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
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
      this._childProcess = undefined;

      if (this.logManager) {
        await this.logManager.write('Server stopped', 'info');
      }

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
   * Get recent server logs
   *
   * @param lines - Number of lines to retrieve (default: 100)
   * @returns Array of log lines
   */
  async getLogs(lines: number = 100): Promise<string[]> {
    if (!this.logManager) {
      return [];
    }

    try {
      return await this.logManager.getRecent(lines);
    } catch {
      return [];
    }
  }

  /**
   * Get log file path
   *
   * @returns Path to log file (undefined if log manager not initialized)
   */
  getLogPath(): string | undefined {
    return this.logManager?.getLogPath();
  }

  /**
   * Ensure llama-server binary is downloaded
   *
   * Downloads binary from GitHub releases if not present, verifies checksum.
   *
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails
   * @private
   */
  private async ensureBinary(): Promise<string> {
    const platformKey = getPlatformKey();
    const binaryConfig = BINARY_VERSIONS.llamaServer;

    if (!binaryConfig.urls[platformKey]) {
      throw new BinaryError(
        `No llama-server binary available for platform: ${platformKey}`,
        {
          platform: platformKey,
          suggestion: 'Check platform support in DESIGN.md',
        }
      );
    }

    // Ensure binaries directory exists
    await ensureDirectory(PATHS.binaries);

    const binaryPath = getBinaryPath('llama-server');

    // Check if binary already exists
    if (await fileExists(binaryPath)) {
      // TODO: Version checking - for Phase 1, assume existing binary is good
      return binaryPath;
    }

    // Download binary
    const url = binaryConfig.urls[platformKey];
    const expectedChecksum = binaryConfig.checksums[platformKey];

    if (!url) {
      throw new BinaryError(`No download URL for platform: ${platformKey}`, {
        platform: platformKey,
      });
    }

    try {
      const downloader = new Downloader();

      // Download to temporary file first
      const tempPath = `${binaryPath}.download`;

      await downloader.download({
        url,
        destination: tempPath,
        onProgress: (downloaded, total) => {
          const percent = ((downloaded / total) * 100).toFixed(1);
          if (this.logManager) {
            this.logManager.write(
              `Downloading llama-server binary: ${percent}%`,
              'info'
            ).catch(() => {});
          }
        }
      });

      // Verify checksum if provided
      if (expectedChecksum) {
        const actualChecksum = await calculateChecksum(tempPath);
        if (actualChecksum !== expectedChecksum) {
          throw new BinaryError('Binary checksum verification failed', {
            expected: expectedChecksum,
            actual: actualChecksum,
            suggestion: 'Try deleting the binary and downloading again',
          });
        }
      }

      // Move to final location and make executable
      const { moveFile } = await import('../utils/file-utils.js');
      await moveFile(tempPath, binaryPath);

      // Make executable (Unix-like systems)
      if (process.platform !== 'win32') {
        const { chmod } = await import('fs/promises');
        await chmod(binaryPath, 0o755);
      }

      if (this.logManager) {
        await this.logManager.write('Binary downloaded and verified', 'info');
      }

      return binaryPath;
    } catch (error) {
      if (error instanceof BinaryError) {
        throw error;
      }
      throw new BinaryError(
        `Failed to download llama-server binary: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { url, error: error instanceof Error ? error.message : String(error) }
      );
    }
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
    config: ServerConfig,
    modelInfo: any
  ): Promise<LlamaServerConfig> {
    const optimalConfig = await this.systemInfo.getOptimalConfig(modelInfo);

    return {
      ...config,
      threads: config.threads ?? optimalConfig.threads,
      contextSize: config.contextSize ?? optimalConfig.contextSize,
      gpuLayers: config.gpuLayers ?? optimalConfig.gpuLayers,
      parallelRequests: config.parallelRequests ?? optimalConfig.parallelRequests,
      flashAttention: config.flashAttention ?? optimalConfig.flashAttention,
    } as LlamaServerConfig;
  }

  /**
   * Build command-line arguments for llama-server
   *
   * @param config - Server configuration
   * @param modelPath - Path to model file
   * @returns Array of command-line arguments
   * @private
   */
  private buildCommandLineArgs(config: LlamaServerConfig, modelPath: string): string[] {
    const args: string[] = [];

    // Model path
    args.push('-m', modelPath);

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

    return args;
  }

  /**
   * Handle stdout from llama-server
   *
   * @param data - Stdout data
   * @private
   */
  private handleStdout(data: string): void {
    if (this.logManager) {
      // Split by newlines and log each line
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        this.logManager.write(line, 'info').catch(() => {});
      }
    }
  }

  /**
   * Handle stderr from llama-server
   *
   * @param data - Stderr data
   * @private
   */
  private handleStderr(data: string): void {
    if (this.logManager) {
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      for (const line of lines) {
        this.logManager.write(line, 'error').catch(() => {});
      }
    }
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
        .catch(() => {});
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
    this._childProcess = undefined;
  }
}
