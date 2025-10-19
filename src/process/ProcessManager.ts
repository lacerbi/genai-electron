/**
 * ProcessManager - Low-level process spawning and management utilities
 *
 * Provides utilities for spawning child processes, monitoring their lifecycle,
 * and performing graceful shutdown with fallback to force kill.
 *
 * @module process/ProcessManager
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { ServerError } from '../errors/index.js';

/**
 * Options for spawning a process
 */
export interface SpawnOptions {
  /** Current working directory for the process */
  cwd?: string;
  /** Environment variables (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** Callback for stdout data */
  onStdout?: (data: string) => void;
  /** Callback for stderr data */
  onStderr?: (data: string) => void;
  /** Callback for process exit */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Callback for spawn errors (e.g., ENOENT when binary not found) */
  onError?: (error: Error) => void;
}

/**
 * Result of spawning a process
 */
export interface SpawnResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Process ID */
  pid: number;
}

/**
 * ProcessManager class for managing child processes
 *
 * @example
 * ```typescript
 * const manager = new ProcessManager();
 *
 * // Spawn a process
 * const { process, pid } = manager.spawn('llama-server', ['-m', 'model.gguf'], {
 *   onStdout: (data) => console.log('stdout:', data),
 *   onStderr: (data) => console.error('stderr:', data),
 *   onExit: (code, signal) => console.log('exit:', code, signal)
 * });
 *
 * // Check if running
 * const running = manager.isRunning(pid);
 *
 * // Kill gracefully
 * await manager.kill(pid, 10000); // 10s timeout
 * ```
 */
export class ProcessManager {
  /**
   * Spawn a child process
   *
   * @param command - Command to execute
   * @param args - Command arguments
   * @param options - Spawn options
   * @returns Spawn result with process and PID
   * @throws {ServerError} If process fails to spawn
   */
  spawn(command: string, args: string[], options: SpawnOptions = {}): SpawnResult {
    try {
      const childProcess = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
      });

      if (!childProcess.pid) {
        throw new ServerError(`Failed to spawn process: ${command}`, { command, args });
      }

      // Capture stdout
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data: Buffer) => {
          if (options.onStdout) {
            options.onStdout(data.toString('utf8'));
          }
        });
      }

      // Capture stderr
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
          if (options.onStderr) {
            options.onStderr(data.toString('utf8'));
          }
        });
      }

      // Handle process exit
      childProcess.on('exit', (code, signal) => {
        if (options.onExit) {
          options.onExit(code, signal);
        }
      });

      // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
      childProcess.on('error', (error) => {
        // Call error callback if provided
        if (options.onError) {
          options.onError(error);
        }
        // Note: We don't throw here because event handlers can't throw synchronously.
        // The error will be handled by the caller through the exit event or onError callback.
      });

      return {
        process: childProcess,
        pid: childProcess.pid,
      };
    } catch (error) {
      if (error instanceof ServerError) {
        throw error;
      }
      throw new ServerError(
        `Failed to spawn process: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { command, args, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Kill a process gracefully with fallback to force kill
   *
   * Sends SIGTERM first, waits for the timeout, then sends SIGKILL if needed.
   *
   * @param pid - Process ID to kill
   * @param timeout - Timeout in milliseconds before force kill (default: 10000)
   * @returns Promise that resolves when process is killed
   */
  async kill(pid: number, timeout = 10000): Promise<void> {
    // Check if process exists
    if (!this.isRunning(pid)) {
      return; // Already dead
    }

    return new Promise((resolve, reject) => {
      let killed = false;
      const timeoutId = setTimeout(() => {
        if (!killed && this.isRunning(pid)) {
          // Force kill with SIGKILL
          try {
            process.kill(pid, 'SIGKILL');
            killed = true;
            resolve();
          } catch (error) {
            reject(
              new ServerError(`Failed to force kill process ${pid}`, {
                pid,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        }
      }, timeout);

      try {
        // Try graceful termination first
        process.kill(pid, 'SIGTERM');

        // Poll for process exit
        const checkInterval = setInterval(() => {
          if (!this.isRunning(pid)) {
            killed = true;
            clearTimeout(timeoutId);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      } catch (error) {
        clearTimeout(timeoutId);
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          // Process doesn't exist - that's fine
          resolve();
        } else {
          reject(
            new ServerError(`Failed to kill process ${pid}`, {
              pid,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
    });
  }

  /**
   * Check if a process is running
   *
   * @param pid - Process ID to check
   * @returns True if process is running, false otherwise
   */
  isRunning(pid: number): boolean {
    try {
      // Sending signal 0 doesn't kill the process, just checks if it exists
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH means process doesn't exist
      return false;
    }
  }
}
