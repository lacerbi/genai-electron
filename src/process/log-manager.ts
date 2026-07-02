/**
 * Log Manager
 *
 * Manages log file writing and retrieval for server processes.
 * Phase 1 includes basic logging; log rotation is deferred to Phase 4.
 *
 * @module process/log-manager
 */

import { promises as fs } from 'fs';
import { ensureDirectory, fileExists } from '../utils/file-utils.js';
import { FileSystemError } from '../errors/index.js';
import { DEFAULT_LOG_ROTATION } from '../config/defaults.js';
import path from 'path';

/**
 * Log rotation options
 */
export interface LogRotationOptions {
  /** Rotate when the log file exceeds this many bytes (default: 5 MB) */
  maxFileSize?: number;
  /** Number of rotated archives to keep, e.g. server.log.1/.2 (default: 2; 0 = truncate) */
  maxArchives?: number;
}

/**
 * Log level
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry format
 */
export interface LogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
}

/**
 * LogManager class for managing server logs
 *
 * Provides basic log file writing and retrieval. Rotation is deferred to Phase 4.
 *
 * @example
 * ```typescript
 * const logger = new LogManager('/path/to/logs/server.log');
 *
 * // Write log entries
 * await logger.write('Server starting...', 'info');
 * await logger.write('Error occurred', 'error');
 *
 * // Get recent logs
 * const recent = await logger.getRecent(50);
 * console.log(recent);
 *
 * // Clear log file
 * await logger.clear();
 * ```
 */
export class LogManager {
  private logPath: string;
  private maxFileSize: number;
  private maxArchives: number;
  /** Approximate current log-file size, tracked to avoid a stat per write */
  private approxSize = 0;

  /**
   * Create a LogManager instance
   *
   * @param logPath - Path to the log file
   * @param rotation - Optional rotation settings (defaults: 5 MB, 2 archives)
   */
  constructor(logPath: string, rotation?: LogRotationOptions) {
    this.logPath = logPath;
    this.maxFileSize = rotation?.maxFileSize ?? DEFAULT_LOG_ROTATION.maxFileSize;
    this.maxArchives = rotation?.maxArchives ?? DEFAULT_LOG_ROTATION.maxArchives;
  }

  /**
   * Initialize the log manager
   *
   * Creates the log directory if it doesn't exist and reads the current
   * log-file size (rotation bookkeeping).
   *
   * @throws {FileSystemError} If directory creation fails
   */
  async initialize(): Promise<void> {
    try {
      const logDir = path.dirname(this.logPath);
      await ensureDirectory(logDir);
    } catch (error) {
      throw new FileSystemError(
        `Failed to initialize log directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { path: this.logPath, error: error instanceof Error ? error.message : String(error) }
      );
    }

    try {
      const stat = await fs.stat(this.logPath);
      this.approxSize = stat.size;
    } catch {
      this.approxSize = 0; // No log file yet
    }
  }

  /**
   * Write a log entry
   *
   * Appends a formatted log entry to the log file, rotating first when the
   * file would exceed the configured maximum size.
   *
   * @param message - Log message
   * @param level - Log level (default: 'info')
   * @throws {FileSystemError} If write fails
   */
  async write(message: string, level: LogLevel = 'info'): Promise<void> {
    try {
      const entry = this.formatEntry({ timestamp: new Date().toISOString(), level, message });
      const line = `${entry}\n`;

      if (this.maxFileSize > 0 && this.approxSize + line.length > this.maxFileSize) {
        await this.rotate();
      }

      await fs.appendFile(this.logPath, line, 'utf8');
      this.approxSize += line.length;
    } catch (error) {
      throw new FileSystemError(
        `Failed to write to log file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { path: this.logPath, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Rotate the log file: server.log → server.log.1 → server.log.2 → deleted
   *
   * Best-effort: rotation failures are swallowed (logging must never take
   * the server down); with maxArchives = 0 the file is truncated instead.
   *
   * @private
   */
  private async rotate(): Promise<void> {
    try {
      if (this.maxArchives <= 0) {
        await fs.writeFile(this.logPath, '', 'utf8');
      } else {
        // Shift existing archives up, dropping the oldest
        for (let i = this.maxArchives - 1; i >= 1; i--) {
          const from = `${this.logPath}.${i}`;
          const to = `${this.logPath}.${i + 1}`;
          try {
            await fs.rename(from, to);
          } catch {
            // Archive doesn't exist — fine
          }
        }
        await fs.rename(this.logPath, `${this.logPath}.1`);
      }
    } catch {
      // Best-effort — keep appending to the current file on failure
    }
    this.approxSize = 0;
  }

  /**
   * Get recent log entries
   *
   * Returns the last N lines from the log file.
   *
   * @param lines - Number of lines to retrieve (default: 100)
   * @returns Array of log entry strings
   * @throws {FileSystemError} If read fails
   */
  async getRecent(lines = 100): Promise<string[]> {
    try {
      // Check if log file exists
      if (!(await fileExists(this.logPath))) {
        return []; // No logs yet
      }

      // Read entire file
      const content = await fs.readFile(this.logPath, 'utf8');

      // Split into lines and get last N
      const allLines = content.split('\n').filter((line) => line.trim() !== '');
      return allLines.slice(-lines);
    } catch (error) {
      throw new FileSystemError(
        `Failed to read log file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { path: this.logPath, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Clear the log file
   *
   * Removes all log entries by truncating the file.
   *
   * @throws {FileSystemError} If clear fails
   */
  async clear(): Promise<void> {
    try {
      await fs.writeFile(this.logPath, '', 'utf8');
      this.approxSize = 0;
    } catch (error) {
      throw new FileSystemError(
        `Failed to clear log file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { path: this.logPath, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Get the log file path
   *
   * @returns Path to the log file
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Format a log entry
   *
   * @param entry - Log entry to format
   * @returns Formatted log string
   * @private
   */
  private formatEntry(entry: LogEntry): string {
    const { timestamp, level, message } = entry;
    const levelUpper = level.toUpperCase().padEnd(5); // Align levels
    return `[${timestamp}] [${levelUpper}] ${message}`;
  }

  /**
   * Parse a log entry string
   *
   * Attempts to parse a formatted log string back into a LogEntry object.
   *
   * @param line - Log line to parse
   * @returns Parsed log entry or null if parsing fails
   */
  static parseEntry(line: string): LogEntry | null {
    // Trim any trailing whitespace including \r\n (llama.cpp outputs \r at end)
    // This was causing regex to fail and fallback to showing entire line with new timestamp
    const trimmedLine = line.trim();

    // Format: [timestamp] [LEVEL] message
    const match = trimmedLine.match(/^\[([^\]]+)\] \[(\w+)\s*\] (.+)$/);
    if (!match || !match[1] || !match[2] || !match[3]) {
      return null;
    }

    const timestamp = match[1];
    const levelStr = match[2];
    const message = match[3];
    const level = levelStr.trim().toLowerCase() as LogLevel;

    // Validate level
    if (!['debug', 'info', 'warn', 'error'].includes(level)) {
      return null;
    }

    return { timestamp, level, message };
  }
}
