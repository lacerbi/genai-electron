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
import { type BinaryVariantConfig, type BinaryDependency } from '../config/defaults.js';
import { BinaryError } from '../errors/index.js';
import {
  fileExists,
  ensureDirectory,
  calculateChecksum,
  deleteFile,
  copyDirectory,
} from '../utils/file-utils.js';
import { extractBinary, cleanupExtraction } from '../utils/zip-utils.js';
import { detectGPU } from '../system/gpu-detect.js';
import AdmZip from 'adm-zip';
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
   * Filter variants based on CUDA GPU availability
   *
   * Removes CUDA variants if no CUDA-capable GPU is detected.
   * This prevents unnecessary downloads (~100-200MB) of CUDA runtime dependencies
   * on systems without NVIDIA GPUs.
   *
   * @param variants - Original list of variants
   * @returns Filtered list of variants
   * @private
   */
  private async filterVariantsByCudaAvailability(
    variants: readonly BinaryVariantConfig[]
  ): Promise<readonly BinaryVariantConfig[]> {
    // Check if any CUDA variants exist
    const hasCudaVariants = variants.some((v) => v.type === 'cuda');
    if (!hasCudaVariants) {
      return variants;
    }

    // Detect GPU capabilities
    const gpu = await detectGPU();

    // If CUDA is available, return all variants
    if (gpu.available && gpu.cuda === true) {
      this.log('CUDA GPU detected, CUDA variants will be tried', 'info');
      return variants;
    }

    // Filter out CUDA variants
    const filtered = variants.filter((v) => v.type !== 'cuda');

    if (filtered.length < variants.length) {
      const reason = gpu.available
        ? `GPU detected (${gpu.type}) but CUDA not supported`
        : 'No GPU detected';
      this.log(`Skipping CUDA variants: ${reason}`, 'info');
    }

    return filtered;
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
    const { type, binaryName, platformKey } = this.config;
    let { variants } = this.config;

    if (!variants || variants.length === 0) {
      throw new BinaryError(`No binary variants available for platform: ${platformKey}`, {
        platform: platformKey,
        suggestion: 'Check platform support in DESIGN.md',
      });
    }

    // Filter variants based on CUDA availability
    variants = await this.filterVariantsByCudaAvailability(variants);

    if (variants.length === 0) {
      throw new BinaryError(`No compatible binary variants available for platform: ${platformKey}`, {
        platform: platformKey,
        suggestion: 'All variants were filtered out (e.g., CUDA variants on non-NVIDIA system)',
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
   * Download and extract binary dependencies (e.g., CUDA runtime DLLs)
   *
   * Dependencies are downloaded and extracted BEFORE the main binary is tested.
   * This ensures all required files are present during binary testing.
   *
   * @param dependencies - List of dependencies to download
   * @param extractDir - Directory to extract dependencies into
   * @throws {BinaryError} If any dependency fails to download or verify
   * @private
   */
  private async downloadDependencies(
    dependencies: readonly BinaryDependency[],
    extractDir: string
  ): Promise<void> {
    const { type } = this.config;

    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      if (!dep) continue;

      const depName = dep.description || `Dependency ${i + 1}`;
      this.log(`Downloading ${depName}...`, 'info');

      const downloader = new Downloader();
      const depZipPath = path.join(PATHS.binaries[type], `.dep${i}.zip`);

      try {
        // Download dependency
        await downloader.download({
          url: dep.url,
          destination: depZipPath,
          onProgress: (downloaded, total) => {
            const percent = ((downloaded / total) * 100).toFixed(1);
            this.log(`Downloading ${depName}: ${percent}%`, 'info');
          },
        });

        // Verify checksum
        const actualChecksum = await calculateChecksum(depZipPath);
        if (actualChecksum !== dep.checksum) {
          throw new BinaryError('Dependency checksum verification failed', {
            dependency: dep.url,
            expected: dep.checksum,
            actual: actualChecksum,
            suggestion: 'The downloaded dependency may be corrupted. Try again.',
          });
        }

        // Extract dependency to same directory as main binary
        // This ensures DLLs are in the same directory as the executable
        // Use AdmZip directly to extract all files (not searching for specific binary)
        await fs.mkdir(extractDir, { recursive: true });
        const zip = new AdmZip(depZipPath);
        zip.extractAllTo(extractDir, true);

        // Cleanup dependency ZIP
        await deleteFile(depZipPath).catch(() => void 0);

        this.log(`${depName} extracted successfully`, 'info');
      } catch (error) {
        // Cleanup on error
        await deleteFile(depZipPath).catch(() => void 0);
        throw error;
      }
    }
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
      // Download and extract dependencies FIRST (e.g., CUDA runtime DLLs)
      // This ensures all required files are present when testing the binary
      if (variant.dependencies && variant.dependencies.length > 0) {
        await this.downloadDependencies(variant.dependencies, extractDir);
      }

      // Download main binary ZIP
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

      // Extract main binary ZIP to same directory as dependencies
      const extractedBinaryPath = await extractBinary(zipPath, extractDir, binaryNamesToSearch);

      // Test if binary works (has required drivers, etc.)
      const works = await this.testBinary(extractedBinaryPath);

      if (works) {
        // Copy ALL extracted files to binaries directory
        // This includes the .exe AND all required DLLs (from dependencies)
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
        // Cleanup everything including dependencies and return false to try next variant
        await deleteFile(zipPath).catch(() => void 0);
        await cleanupExtraction(extractDir).catch(() => void 0);
        return false;
      }
    } catch (error) {
      // Cleanup everything on error (including dependencies)
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
