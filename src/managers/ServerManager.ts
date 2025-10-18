/**
 * ServerManager - Abstract base class for server management
 *
 * Provides common functionality for managing server processes (llama-server, diffusion-server, etc.).
 * Extends EventEmitter to provide lifecycle events.
 *
 * @module managers/ServerManager
 */

import { EventEmitter } from 'events';
import path from 'node:path';
import { ServerStatus, ServerInfo, ServerConfig, ServerEvent } from '../types/index.js';
import {
  ServerError,
  PortInUseError,
  ModelNotFoundError,
  BinaryError,
  InsufficientResourcesError,
} from '../errors/index.js';
import { LogManager } from '../process/log-manager.js';
import { PATHS } from '../config/paths.js';

/**
 * Abstract ServerManager class
 *
 * Base class for all server managers. Provides common properties and methods
 * for managing server lifecycle.
 *
 * Emits the following events:
 * - 'started': When server starts successfully
 * - 'stopped': When server stops
 * - 'crashed': When server crashes unexpectedly
 * - 'restarted': When server restarts after a crash
 *
 * @example
 * ```typescript
 * class MyServerManager extends ServerManager {
 *   async start(config: ServerConfig): Promise<ServerInfo> {
 *     // Implementation
 *   }
 *
 *   async stop(): Promise<void> {
 *     // Implementation
 *   }
 * }
 *
 * const manager = new MyServerManager();
 * manager.on('started', () => console.log('Server started'));
 * manager.on('crashed', (error) => console.error('Server crashed:', error));
 * ```
 */
export abstract class ServerManager extends EventEmitter {
  /** Current server status */
  protected _status: ServerStatus = 'stopped';

  /** Process ID of the running server (undefined if not running) */
  protected _pid?: number;

  /** Port the server is listening on (0 if not running) */
  protected _port: number = 0;

  /** Current server configuration */
  protected _config?: ServerConfig;

  /** Timestamp when server was started */
  protected _startedAt?: Date;

  /** Log manager for server logs */
  protected logManager?: LogManager;

  /**
   * Create a new ServerManager
   */
  constructor() {
    super();
  }

  /**
   * Start the server
   *
   * Must be implemented by subclasses.
   *
   * @param config - Server configuration
   * @returns Server information
   * @throws {ServerError} If start fails
   */
  abstract start(config: ServerConfig): Promise<ServerInfo>;

  /**
   * Stop the server
   *
   * Must be implemented by subclasses.
   *
   * @throws {ServerError} If stop fails
   */
  abstract stop(): Promise<void>;

  /**
   * Restart the server
   *
   * Stops the server if running, then starts it again with the same configuration.
   *
   * @returns Server information
   * @throws {ServerError} If restart fails or no previous configuration exists
   */
  async restart(): Promise<ServerInfo> {
    if (!this._config) {
      throw new ServerError('Cannot restart: no previous configuration', {
        suggestion: 'Start the server first with a configuration',
      });
    }

    // Stop if running
    if (this._status !== 'stopped') {
      await this.stop();
    }

    // Start with previous config
    const info = await this.start(this._config);

    // Emit restart event
    this.emit('restarted', info);

    return info;
  }

  /**
   * Get current server status
   *
   * @returns Current server status
   */
  getStatus(): ServerStatus {
    return this._status;
  }

  /**
   * Get current server information
   *
   * @returns Server information
   */
  getInfo(): ServerInfo {
    return {
      status: this._status,
      health: 'unknown',
      pid: this._pid,
      port: this._port,
      modelId: this._config?.modelId || '',
      startedAt: this._startedAt?.toISOString(),
    };
  }

  /**
   * Get server port
   *
   * @returns Server port (0 if not running)
   */
  getPort(): number {
    return this._port;
  }

  /**
   * Get server PID
   *
   * @returns Server PID (undefined if not running)
   */
  getPid(): number | undefined {
    return this._pid;
  }

  /**
   * Get server configuration
   *
   * @returns Server configuration (undefined if never started)
   */
  getConfig(): ServerConfig | undefined {
    return this._config;
  }

  /**
   * Check if server is running
   *
   * @returns True if server is running
   */
  isRunning(): boolean {
    return this._status === 'running';
  }

  /**
   * Check if server is stopped
   *
   * @returns True if server is stopped
   */
  isStopped(): boolean {
    return this._status === 'stopped';
  }

  /**
   * Check if server is starting
   *
   * @returns True if server is starting
   */
  isStarting(): boolean {
    return this._status === 'starting';
  }

  /**
   * Check if server is stopping
   *
   * @returns True if server is stopping
   */
  isStopping(): boolean {
    return this._status === 'stopping';
  }

  /**
   * Check if server has crashed
   *
   * @returns True if server has crashed
   */
  hasCrashed(): boolean {
    return this._status === 'crashed';
  }

  /**
   * Set server status
   *
   * Updates the internal status and emits a status change event.
   *
   * @param status - New status
   * @protected
   */
  protected setStatus(status: ServerStatus): void {
    const oldStatus = this._status;
    this._status = status;

    // Emit generic status change event
    this.emit('status', status, oldStatus);
  }

  /**
   * Emit a typed server event
   *
   * @param event - Event type
   * @param data - Event data (optional)
   * @protected
   */
  protected emitEvent<T extends ServerEvent>(event: T, data?: unknown): void {
    this.emit(event, data);
  }

  /**
   * Check if a port is already in use
   *
   * @param port - Port number to check
   * @param timeout - Timeout in milliseconds (default: 2000)
   * @throws {PortInUseError} If port is already in use
   * @protected
   */
  protected async checkPortAvailability(port: number, timeout: number = 2000): Promise<void> {
    const { isServerResponding } = await import('../process/health-check.js');
    if (await isServerResponding(port, timeout)) {
      throw new PortInUseError(port);
    }
  }

  /**
   * Initialize the log manager with a specific log file name
   *
   * @param logFileName - Name of the log file (e.g., 'llama-server.log')
   * @param port - Port number to include in the startup message
   * @protected
   */
  protected async initializeLogManager(logFileName: string, port: number): Promise<void> {
    const logPath = path.join(PATHS.logs, logFileName);
    this.logManager = new LogManager(logPath);
    await this.logManager.initialize();
    await this.logManager.write(`Starting server on port ${port}`, 'info');
  }

  /**
   * Handle errors during server startup
   *
   * Logs the error, cleans up resources, and re-throws typed errors or wraps unknown errors.
   *
   * @param error - The error that occurred
   * @param serverName - Name of the server for error messages (e.g., 'llama-server')
   * @throws {ServerError} Always throws (either the original typed error or wrapped)
   * @protected
   */
  protected async handleStartupError(error: unknown, serverName: string): Promise<never> {
    // Log the error
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
      `Failed to start ${serverName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { error: error instanceof Error ? error.message : String(error) }
    );
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
   * Clear all server logs
   *
   * Removes all log entries by truncating the log file.
   * This is useful for clearing old/corrupted logs and starting fresh.
   */
  async clearLogs(): Promise<void> {
    if (!this.logManager) {
      return;
    }

    try {
      await this.logManager.clear();
    } catch {
      // Ignore errors
    }
  }
}
