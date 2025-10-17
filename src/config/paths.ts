/**
 * Path configuration for genai-electron
 * Manages file system paths in Electron's userData directory
 * @module config/paths
 */

import { app } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Base directory for all genai-electron data
 * Uses Electron's userData path (e.g., ~/Library/Application Support/YourAppName on macOS)
 */
export const BASE_DIR = app.getPath('userData');

/**
 * Directory paths for different data types
 */
export const PATHS = {
  /** Model storage paths */
  models: {
    /** LLM models directory */
    llm: path.join(BASE_DIR, 'models', 'llm'),
    /** Diffusion models directory */
    diffusion: path.join(BASE_DIR, 'models', 'diffusion'),
  },
  /** Binary executables directories (separated by type) */
  binaries: {
    /** llama.cpp binaries (llama-server.exe and DLLs) */
    llama: path.join(BASE_DIR, 'binaries', 'llama'),
    /** stable-diffusion.cpp binaries (Phase 2) */
    diffusion: path.join(BASE_DIR, 'binaries', 'diffusion'),
  },
  /** Log files directory */
  logs: path.join(BASE_DIR, 'logs'),
  /** Configuration files directory */
  config: path.join(BASE_DIR, 'config'),
  /** Temporary files directory (for intermediate image generation outputs, etc.) */
  temp: path.join(BASE_DIR, 'temp'),
} as const;

/**
 * Ensure all required directories exist
 * Creates directories if they don't exist
 *
 * @throws {Error} If directory creation fails
 *
 * @example
 * ```typescript
 * await ensureDirectories();
 * console.log('All directories ready');
 * ```
 */
export async function ensureDirectories(): Promise<void> {
  const directories = [
    PATHS.models.llm,
    PATHS.models.diffusion,
    PATHS.binaries.llama,
    PATHS.binaries.diffusion,
    PATHS.logs,
    PATHS.config,
    PATHS.temp,
  ];

  await Promise.all(
    directories.map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
}

/**
 * Get the metadata file path for a model
 *
 * @param type - Model type (llm or diffusion)
 * @param modelId - Model identifier
 * @returns Absolute path to metadata JSON file
 *
 * @example
 * ```typescript
 * const metaPath = getModelMetadataPath('llm', 'llama-2-7b');
 * // Returns: /path/to/userData/models/llm/llama-2-7b.json
 * ```
 */
export function getModelMetadataPath(type: 'llm' | 'diffusion', modelId: string): string {
  return path.join(PATHS.models[type], `${modelId}.json`);
}

/**
 * Get the model file path
 *
 * @param type - Model type (llm or diffusion)
 * @param filename - Model filename (e.g., "llama-2-7b.gguf")
 * @returns Absolute path to model file
 *
 * @example
 * ```typescript
 * const modelPath = getModelFilePath('llm', 'llama-2-7b.gguf');
 * // Returns: /path/to/userData/models/llm/llama-2-7b.gguf
 * ```
 */
export function getModelFilePath(type: 'llm' | 'diffusion', filename: string): string {
  return path.join(PATHS.models[type], filename);
}

/**
 * Get the binary file path
 *
 * Automatically adds .exe extension on Windows platforms.
 *
 * @param type - Binary type ('llama' or 'diffusion')
 * @param binaryName - Binary name (e.g., "llama-server", "stable-diffusion")
 * @returns Absolute path to binary file
 *
 * @example
 * ```typescript
 * const binaryPath = getBinaryPath('llama', 'llama-server');
 * // Returns: /path/to/userData/binaries/llama/llama-server (Unix)
 * // Returns: C:\...\userData\binaries\llama\llama-server.exe (Windows)
 * ```
 */
export function getBinaryPath(type: 'llama' | 'diffusion', binaryName: string): string {
  // On Windows, executables need .exe extension
  const filename = process.platform === 'win32' ? `${binaryName}.exe` : binaryName;
  return path.join(PATHS.binaries[type], filename);
}

/**
 * Get the log file path
 *
 * @param logName - Log file name (e.g., "llama-server.log")
 * @returns Absolute path to log file
 *
 * @example
 * ```typescript
 * const logPath = getLogPath('llama-server.log');
 * // Returns: /path/to/userData/logs/llama-server.log
 * ```
 */
export function getLogPath(logName: string): string {
  return path.join(PATHS.logs, logName);
}

/**
 * Get the config file path
 *
 * @param configName - Config file name (e.g., "settings.json")
 * @returns Absolute path to config file
 *
 * @example
 * ```typescript
 * const configPath = getConfigPath('settings.json');
 * // Returns: /path/to/userData/config/settings.json
 * ```
 */
export function getConfigPath(configName: string): string {
  return path.join(PATHS.config, configName);
}

/**
 * Get the temp file path
 *
 * @param filename - Temporary file name (e.g., "sd-output-12345.png")
 * @returns Absolute path to temp file
 *
 * @example
 * ```typescript
 * const tempPath = getTempPath('sd-output-12345.png');
 * // Returns: /path/to/userData/temp/sd-output-12345.png
 * ```
 */
export function getTempPath(filename: string): string {
  return path.join(PATHS.temp, filename);
}
