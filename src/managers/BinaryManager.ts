/**
 * BinaryManager - Reusable binary download and variant management
 *
 * Provides generic functionality for downloading, extracting, and testing
 * binary variants. Used by both LlamaServerManager and DiffusionServerManager.
 *
 * @module managers/BinaryManager
 */

import { Downloader } from '../download/Downloader.js';
import { PATHS, getBinaryPath } from '../config/paths.js';
import { type BinaryVariantConfig } from '../config/defaults.js';
import { BinaryError } from '../errors/index.js';
import {
  fileExists,
  ensureDirectory,
  calculateChecksum,
  deleteFile,
  copyDirectory,
} from '../utils/file-utils.js';
import { extractBinary, cleanupExtraction } from '../utils/zip-utils.js';
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Configuration for binary download and management
 */
export interface BinaryManagerConfig {
  /** Binary type (llama or diffusion) */
  type: 'llama' | 'diffusion';
  /** Binary name (e.g., 'llama-server', 'sd') */
  binaryName: string;
  /** Platform key (e.g., 'win32-x64') */
  platformKey: string;
  /** Available binary variants in priority order */
  variants: readonly BinaryVariantConfig[];
  /** Optional logger function */
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * BinaryManager class
 *
 * Handles downloading, extracting, and testing binary variants.
 * Provides generic functionality that can be reused by different server managers.
 */
export class BinaryManager {
  private config: BinaryManagerConfig;

  constructor(config: BinaryManagerConfig) {
    this.config = config;
  }

  /**
   * Ensure binary is available, downloading if necessary
   *
   * Tries each variant in priority order until one works.
   * Caches which variant worked for faster startup next time.
   *
   * @returns Path to the working binary
   * @throws {BinaryError} If all variants fail
   */
  async ensureBinary(): Promise<string> {
    const { type, binaryName, variants, platformKey } = this.config;

    if (!variants || variants.length === 0) {
      throw new BinaryError(`No binary variants available for platform: ${platformKey}`, {
        platform: platformKey,
        suggestion: 'Check platform support in DESIGN.md',
      });
    }

    // Ensure binary directory exists
    await ensureDirectory(PATHS.binaries[type]);

    const binaryPath = getBinaryPath(type, binaryName);
    const variantCachePath = path.join(PATHS.binaries[type], '.variant.json');

    // Check if binary already exists and works
    if (await fileExists(binaryPath)) {
      const works = await this.testBinary(binaryPath);
      if (works) {
        this.log('Using existing binary', 'info');
        return binaryPath;
      } else {
        this.log('Existing binary not working, re-downloading...', 'warn');
        await deleteFile(binaryPath).catch(() => void 0);
      }
    }

    // Check if we have a cached variant preference
    let cachedVariant: string | undefined;
    try {
      const cache = await fs.readFile(variantCachePath, 'utf-8');
      cachedVariant = JSON.parse(cache).variant;
    } catch {
      // No cache or invalid cache
    }

    // Reorder variants to try cached one first
    const orderedVariants = [...variants];
    if (cachedVariant) {
      const cachedIndex = orderedVariants.findIndex((v) => v.type === cachedVariant);
      if (cachedIndex > 0) {
        const cached = orderedVariants.splice(cachedIndex, 1)[0];
        if (cached) {
          orderedVariants.unshift(cached);
        }
      }
    }

    // Try each variant until one works
    const errors: string[] = [];
    for (const variant of orderedVariants) {
      this.log(`Trying ${variant.type} variant for ${platformKey}...`, 'info');

      try {
        const success = await this.downloadAndTestVariant(variant, binaryPath);
        if (success) {
          // Cache this variant for next time
          await fs.writeFile(
            variantCachePath,
            JSON.stringify({ variant: variant.type, platform: platformKey }),
            'utf-8'
          );

          this.log(`Successfully installed ${variant.type} variant`, 'info');
          return binaryPath;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${variant.type}: ${errorMsg}`);
        this.log(`Failed to use ${variant.type} variant: ${errorMsg}`, 'warn');
      }
    }

    // All variants failed
    throw new BinaryError(`Failed to download binary. Tried all variants for ${platformKey}.`, {
      platform: platformKey,
      errors: errors.join('; '),
      suggestion: 'Check your GPU drivers are installed, or the system may not support any variant',
    });
  }

  /**
   * Download and test a binary variant
   *
   * @param variant - Binary variant configuration
   * @param finalBinaryPath - Where to install the binary if successful
   * @returns True if variant works, false otherwise
   * @private
   */
  private async downloadAndTestVariant(
    variant: BinaryVariantConfig,
    finalBinaryPath: string
  ): Promise<boolean> {
    const { type } = this.config;
    const downloader = new Downloader();
    const zipPath = `${finalBinaryPath}.${variant.type}.zip`;
    const extractDir = `${finalBinaryPath}.${variant.type}.extract`;

    try {
      // Download ZIP
      await downloader.download({
        url: variant.url,
        destination: zipPath,
        onProgress: (downloaded, total) => {
          const percent = ((downloaded / total) * 100).toFixed(1);
          this.log(`Downloading ${variant.type} binary: ${percent}%`, 'info');
        },
      });

      // Verify checksum
      const actualChecksum = await calculateChecksum(zipPath);
      if (actualChecksum !== variant.checksum) {
        throw new BinaryError('Binary checksum verification failed', {
          expected: variant.checksum,
          actual: actualChecksum,
          suggestion: 'The downloaded file may be corrupted. Try deleting and re-downloading.',
        });
      }

      // Determine which binary names to search for based on type
      const binaryNamesToSearch =
        this.config.type === 'llama'
          ? ['llama-server.exe', 'llama-server', 'llama-cli.exe', 'llama-cli']
          : ['sd.exe', 'sd'];

      // Extract ZIP
      const extractedBinaryPath = await extractBinary(zipPath, extractDir, binaryNamesToSearch);

      // Test if binary works (has required drivers, etc.)
      const works = await this.testBinary(extractedBinaryPath);

      if (works) {
        // Copy ALL extracted files to binaries directory
        // This includes the .exe AND all required DLLs
        await copyDirectory(extractDir, PATHS.binaries[type]);

        // Make executable (Unix-like systems)
        if (process.platform !== 'win32') {
          await fs.chmod(finalBinaryPath, 0o755);
        }

        // Cleanup
        await deleteFile(zipPath).catch(() => void 0);
        await cleanupExtraction(extractDir).catch(() => void 0);

        return true;
      } else {
        // Binary doesn't work (missing drivers, etc.)
        // Cleanup and return false to try next variant
        await deleteFile(zipPath).catch(() => void 0);
        await cleanupExtraction(extractDir).catch(() => void 0);
        return false;
      }
    } catch (error) {
      // Cleanup on error
      await deleteFile(zipPath).catch(() => void 0);
      await cleanupExtraction(extractDir).catch(() => void 0);
      throw error;
    }
  }

  /**
   * Test if a binary works by running it with appropriate test flag
   *
   * Different binaries support different flags:
   * - llama-server: supports --version
   * - sd (diffusion): does NOT support --version, use --help instead
   *
   * @param binaryPath - Path to binary to test
   * @returns True if binary executes successfully
   * @private
   */
  private async testBinary(binaryPath: string): Promise<boolean> {
    try {
      // Use different test flags based on binary type
      // llama-server supports --version, sd supports --help
      const testArgs = this.config.type === 'llama' ? ['--version'] : ['--help'];

      // Try to execute binary with test flag
      // If it exits successfully, the binary works (drivers are present)
      await execFileAsync(binaryPath, testArgs, { timeout: 5000 });
      return true;
    } catch {
      // Binary failed to execute (missing drivers, wrong architecture, etc.)
      return false;
    }
  }

  /**
   * Helper to log messages if logger is provided
   */
  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.config.log) {
      this.config.log(message, level);
    }
  }
}
