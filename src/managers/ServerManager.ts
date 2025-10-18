/**
 * ServerManager - Abstract base class for server management
 *
 * Provides common functionality for managing server processes (llama-server, diffusion-server, etc.).
 * Extends EventEmitter to provide lifecycle events.
 *
 * @module managers/ServerManager
 */

import { EventEmitter } from 'events';
import { ServerStatus, ServerInfo, ServerConfig, ServerEvent } from '../types/index.js';
import { ServerError } from '../errors/index.js';

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
}
