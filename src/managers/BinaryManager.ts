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
import type { BinaryProgressEvent } from '../types/index.js';
import {
  fileExists,
  ensureDirectory,
  calculateChecksum,
  deleteFile,
  copyDirectory,
} from '../utils/file-utils.js';
import {
  extractBinary,
  extractArchive,
  cleanupExtraction,
  getArchiveExtension,
} from '../utils/archive-utils.js';
import { detectGPU } from '../system/gpu-detect.js';
import path from 'path';
import { constants as fsConstants, promises as fs } from 'fs';
import { spawn } from 'child_process';

/**
 * Validation cache structure
 * Stores results of binary validation to avoid redundant testing
 */
interface ValidationCache {
  /** Which variant is installed (cuda/vulkan/cpu) */
  variant: string;
  /** SHA256 checksum of the binary file */
  checksum: string;
  /** ISO timestamp when validation was performed */
  validatedAt: string;
  /** Whether Phase 1 (basic validation) passed */
  phase1Passed: boolean;
  /** Whether Phase 2 (real functionality test) passed (if model was available) */
  phase2Passed?: boolean;
  /** Binary version tag (e.g., 'b7956') — added for cache invalidation on upgrades */
  version?: string;
}

interface DependencyManifestEntry {
  /** Most recently configured source URL (content identity is the checksum) */
  url: string;
  /** Verified dependency archive SHA-256 */
  checksum: string;
  /** Installed archive-relative files needed to stage a fresh candidate */
  files: string[];
}

interface DependencyManifest {
  version: 1;
  dependencies: DependencyManifestEntry[];
}

interface PreparedDependencies {
  entries: DependencyManifestEntry[];
}

const VALIDATION_CHILD_TERMINATION_GRACE_MS = 1_000;

function isValidationTerminationFailure(error: unknown): boolean {
  return (
    error instanceof BinaryError &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'code' in error.details &&
    error.details.code === 'BINARY_VALIDATION_TERMINATION_UNCONFIRMED'
  );
}

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
  /**
   * Optional structured progress callback ('binary-progress' event source).
   * Download progress is throttled to whole-percent changes. ZIP extraction
   * emits per-entry counters; verification and testing emit phase transitions.
   */
  onProgress?: (event: BinaryProgressEvent) => void;
  /**
   * Optional path to a test model for real functionality testing.
   * If provided, tests will run actual inference to verify CUDA/GPU functionality.
   * If not provided, falls back to basic --version/--help test.
   */
  testModelPath?: string;
  /**
   * Optional pre-built CLI args for the model in Phase 2 diffusion test.
   * When provided, these replace the default `-m <testModelPath>` args.
   * Used for multi-component models that require --diffusion-model + --llm + --vae.
   */
  testModelArgs?: string[];
  /**
   * Optional production-resolved optimization flags for the Phase 2 diffusion
   * test (for example --clip-on-cpu / --offload-to-cpu).
   */
  testOptimizationArgs?: string[];
  /** Expected binary version from BINARY_VERSIONS — used for cache invalidation */
  version?: string;
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
   * Load validation cache from disk
   * @returns ValidationCache if exists and valid, undefined otherwise
   * @private
   */
  private async loadValidationCache(): Promise<ValidationCache | undefined> {
    const { type } = this.config;
    const validationCachePath = path.join(PATHS.binaries[type], '.validation.json');

    try {
      const cacheContent = await fs.readFile(validationCachePath, 'utf-8');
      const cache = JSON.parse(cacheContent) as ValidationCache;

      // Validate cache structure
      if (
        cache.variant &&
        cache.checksum &&
        cache.validatedAt &&
        typeof cache.phase1Passed === 'boolean'
      ) {
        return cache;
      }

      return undefined;
    } catch {
      // No cache or invalid cache
      return undefined;
    }
  }

  /**
   * Save validation cache to disk
   * @param cache - Validation cache to save
   * @private
   */
  private async saveValidationCache(cache: ValidationCache): Promise<void> {
    const { type } = this.config;
    const validationCachePath = path.join(PATHS.binaries[type], '.validation.json');

    try {
      await fs.writeFile(validationCachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      // Non-fatal - just log warning
      this.log(`Failed to save validation cache: ${error}`, 'warn');
    }
  }

  /**
   * Load the installed dependency manifest.
   *
   * Missing, legacy, or malformed files safely degrade to an empty manifest.
   */
  private async loadDependencyManifest(): Promise<DependencyManifest> {
    const manifestPath = path.join(PATHS.binaries[this.config.type], '.deps.json');

    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as unknown;
      if (
        !BinaryManager.isRecord(parsed) ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.dependencies)
      ) {
        return { version: 1, dependencies: [] };
      }

      const dependencies: DependencyManifestEntry[] = [];
      for (const value of parsed.dependencies) {
        if (
          BinaryManager.isRecord(value) &&
          typeof value.url === 'string' &&
          typeof value.checksum === 'string' &&
          Array.isArray(value.files) &&
          value.files.every((file) => typeof file === 'string')
        ) {
          dependencies.push({
            url: value.url,
            checksum: value.checksum,
            files: [...value.files],
          });
        }
      }

      return { version: 1, dependencies };
    } catch {
      return { version: 1, dependencies: [] };
    }
  }

  /**
   * Save the dependency manifest atomically.
   *
   * Manifest persistence is non-fatal: a failure only forfeits reuse on the
   * next provisioning run.
   */
  private async saveDependencyManifest(manifest: DependencyManifest): Promise<void> {
    const manifestPath = path.join(PATHS.binaries[this.config.type], '.deps.json');
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;

    try {
      await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
      await fs.rename(tempPath, manifestPath);
    } catch (error) {
      await deleteFile(tempPath).catch(() => void 0);
      this.log(`Failed to save dependency manifest: ${error}`, 'warn');
    }
  }

  /**
   * Drop manifest entries whose checksums are no longer configured.
   */
  private async pruneDependencyManifest(): Promise<void> {
    const manifest = await this.loadDependencyManifest();
    if (manifest.dependencies.length === 0) {
      return;
    }

    const configuredChecksums = new Set(
      this.config.variants.flatMap((variant) =>
        (variant.dependencies ?? []).map((dependency) => dependency.checksum)
      )
    );
    const dependencies = manifest.dependencies.filter((entry) =>
      configuredChecksums.has(entry.checksum)
    );

    if (dependencies.length !== manifest.dependencies.length) {
      await this.saveDependencyManifest({ version: 1, dependencies });
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
   * Caches validation results for faster startup next time.
   *
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the working binary
   * @throws {BinaryError} If all variants fail
   */
  async ensureBinary(forceValidation = false, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();

    if (variants.length === 0) {
      throw new BinaryError(
        `No compatible binary variants available for platform: ${platformKey}`,
        {
          platform: platformKey,
          suggestion: 'All variants were filtered out (e.g., CUDA variants on non-NVIDIA system)',
        }
      );
    }

    // Ensure binary directory exists
    await ensureDirectory(PATHS.binaries[type]);
    signal?.throwIfAborted();
    await this.pruneDependencyManifest();
    signal?.throwIfAborted();

    const binaryPath = getBinaryPath(type, binaryName);

    // Check if binary already exists and handle version changes
    if (await fileExists(binaryPath)) {
      // Load validation cache
      const validationCache = await this.loadValidationCache();

      // Check if configured version has changed since last validation
      if (
        validationCache &&
        !forceValidation &&
        this.config.version &&
        validationCache.version !== this.config.version
      ) {
        this.log(
          `Binary version changed (${validationCache.version || 'unknown'} → ${this.config.version}), re-downloading...`,
          'info'
        );
        // Keep the live installation in place until a replacement has downloaded, extracted, and
        // passed validation. The candidate commit below is an owned settle-to-completion section,
        // so deadline cancellation cannot strand the host without its prior binary.
      } else {
        if (validationCache && !forceValidation) {
          // Calculate current checksum to verify binary hasn't been modified
          this.log('Verifying binary integrity...', 'info');
          signal?.throwIfAborted();
          const currentChecksum = await calculateChecksum(binaryPath);
          signal?.throwIfAborted();

          if (currentChecksum === validationCache.checksum) {
            // Cache is valid - skip validation tests
            this.log('Using cached validation result (binary verified)', 'info');
            this.log(
              `Last validated: ${new Date(validationCache.validatedAt).toLocaleString()}`,
              'info'
            );
            await this.cleanupInstalledBinaryResidue(binaryPath);
            return binaryPath;
          } else {
            // Checksum mismatch - binary was modified
            this.log('Binary checksum mismatch, re-validating...', 'warn');
          }
        } else if (forceValidation) {
          this.log('Force validation requested, re-running tests...', 'info');
        }

        // Run validation tests (cache invalid, missing, or forced)
        const works = await this.testBinary(binaryPath, signal);
        signal?.throwIfAborted();
        if (works) {
          // Save validation cache
          signal?.throwIfAborted();
          const checksum = await calculateChecksum(binaryPath);
          signal?.throwIfAborted();
          const variantType = validationCache?.variant || 'unknown';
          await this.saveValidationCache({
            variant: variantType,
            checksum,
            validatedAt: new Date().toISOString(),
            phase1Passed: true,
            phase2Passed: this.config.testModelPath ? true : undefined,
            version: this.config.version,
          });

          this.log('Binary validated successfully', 'info');
          await this.cleanupInstalledBinaryResidue(binaryPath);
          return binaryPath;
        } else {
          this.log('Existing binary not working, re-downloading...', 'warn');
          // Preserve the prior installation until a fully validated candidate is ready to replace
          // it. This is especially important when provisioning is cancelled by calibration time.
        }
      }
    }

    // Try each variant in priority order (defined in defaults.ts)
    // No reordering based on cached variant — priority order reflects performance
    // preference (e.g., CUDA > Vulkan > CPU) and should always be respected
    const orderedVariants = [...variants];
    const errors: string[] = [];
    for (const variant of orderedVariants) {
      this.log(`Trying ${variant.type} variant for ${platformKey}...`, 'info');

      try {
        signal?.throwIfAborted();
        const success = await this.downloadAndTestVariant(variant, binaryPath, signal);
        if (success) {
          this.log(`Successfully installed ${variant.type} variant`, 'info');
          return binaryPath;
        }
      } catch (error) {
        if (isValidationTerminationFailure(error)) throw error;
        if (signal?.aborted) throw signal.reason ?? error;
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
   * Download an archive only when a complete, checksum-matching copy is not
   * already present.
   */
  private async ensureVerifiedArchive(options: {
    url: string;
    destination: string;
    checksum: string;
    fileLabel: string;
    downloadLabel: string;
    dependency?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { url, destination, checksum, fileLabel, downloadLabel, dependency, signal } = options;

    if (await fileExists(destination)) {
      signal?.throwIfAborted();
      this.progress({ phase: 'verifying', file: fileLabel });
      signal?.throwIfAborted();
      const existingChecksum = await calculateChecksum(destination);
      signal?.throwIfAborted();
      if (existingChecksum === checksum) {
        this.log(`Reusing verified ${downloadLabel} archive`, 'info');
        return;
      }

      this.log(`Discarding checksum-mismatched ${downloadLabel} archive`, 'warn');
      await deleteFile(destination).catch(() => void 0);
    }

    signal?.throwIfAborted();
    this.log(`Downloading ${downloadLabel}...`, 'info');
    const downloader = new Downloader();
    let lastWholePercent = -1;
    await downloader.download({
      url,
      destination,
      signal,
      onProgress: (downloaded, total) => {
        const ratio = total > 0 ? downloaded / total : 0;
        const wholePercent = Math.floor(ratio * 100);
        this.log(`Downloading ${downloadLabel}: ${(ratio * 100).toFixed(1)}%`, 'info');
        if (wholePercent !== lastWholePercent) {
          lastWholePercent = wholePercent;
          this.progress({
            phase: 'downloading',
            file: fileLabel,
            downloaded,
            total,
            percent: wholePercent,
          });
        }
      },
    });

    signal?.throwIfAborted();
    this.progress({ phase: 'verifying', file: fileLabel });
    signal?.throwIfAborted();
    const actualChecksum = await calculateChecksum(destination);
    signal?.throwIfAborted();
    if (actualChecksum !== checksum) {
      await deleteFile(destination).catch(() => void 0);
      throw new BinaryError(
        dependency
          ? 'Dependency checksum verification failed'
          : 'Binary checksum verification failed',
        {
          ...(dependency ? { dependency: url } : {}),
          expected: checksum,
          actual: actualChecksum,
          suggestion: dependency
            ? 'The downloaded dependency may be corrupted. Try again.'
            : 'The downloaded file may be corrupted. Try deleting and re-downloading.',
        }
      );
    }
  }

  private getDependencyArchivePaths(dependencies: readonly BinaryDependency[]): string[] {
    return dependencies.map((dependency, index) =>
      path.join(
        PATHS.binaries[this.config.type],
        `.dep${index}${getArchiveExtension(dependency.url)}`
      )
    );
  }

  /**
   * Resolve an archive-relative dependency path inside a trusted root.
   */
  private resolveDependencyFile(rootDir: string, relativeFile: string): string | undefined {
    const portablePath = relativeFile.replaceAll('\\', '/');
    if (
      portablePath.length === 0 ||
      portablePath.startsWith('/') ||
      /^[A-Za-z]:/.test(portablePath) ||
      portablePath.split('/').includes('..')
    ) {
      return undefined;
    }

    const resolvedRoot = path.resolve(rootDir);
    const resolvedFile = path.resolve(resolvedRoot, portablePath);
    if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      return undefined;
    }
    return resolvedFile;
  }

  /**
   * Stage already-installed dependency files into a clean candidate directory.
   */
  private async stageCachedDependency(
    entry: DependencyManifestEntry,
    extractDir: string
  ): Promise<boolean> {
    const installedDir = PATHS.binaries[this.config.type];
    const stagedFiles: string[] = [];

    try {
      for (const relativeFile of entry.files) {
        const source = this.resolveDependencyFile(installedDir, relativeFile);
        const destination = this.resolveDependencyFile(extractDir, relativeFile);
        if (!source || !destination || !(await fileExists(source))) {
          throw new Error(`Installed dependency file is unavailable: ${relativeFile}`);
        }

        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
        stagedFiles.push(destination);
      }
      return entry.files.length > 0;
    } catch (error) {
      for (const stagedFile of stagedFiles) {
        await deleteFile(stagedFile).catch(() => void 0);
      }
      this.log(
        `Installed dependency cache is incomplete; provisioning it again: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'warn'
      );
      return false;
    }
  }

  private extractionProgress(
    file: string
  ): (progress: { completedEntries: number; totalEntries: number }) => void {
    return ({ completedEntries, totalEntries }) => {
      this.progress({
        phase: 'extracting',
        file,
        completedEntries,
        totalEntries,
        percent: totalEntries > 0 ? Math.floor((completedEntries / totalEntries) * 100) : 100,
      });
    };
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
    extractDir: string,
    signal?: AbortSignal
  ): Promise<PreparedDependencies> {
    const manifest = await this.loadDependencyManifest();
    const entries: DependencyManifestEntry[] = [];

    for (const [index, dependency] of dependencies.entries()) {
      signal?.throwIfAborted();
      const dependencyName = dependency.description || `Dependency ${index + 1}`;
      const cachedEntry = manifest.dependencies.find(
        (entry) => entry.checksum === dependency.checksum
      );

      if (cachedEntry && (await this.stageCachedDependency(cachedEntry, extractDir))) {
        this.log(`Using installed ${dependencyName} (checksum match)`, 'info');
        entries.push({
          url: dependency.url,
          checksum: dependency.checksum,
          files: [...cachedEntry.files],
        });
        continue;
      }

      const archivePath = path.join(
        PATHS.binaries[this.config.type],
        `.dep${index}${getArchiveExtension(dependency.url)}`
      );
      await this.ensureVerifiedArchive({
        url: dependency.url,
        destination: archivePath,
        checksum: dependency.checksum,
        fileLabel: dependencyName,
        downloadLabel: dependencyName,
        dependency: true,
        ...(signal ? { signal } : {}),
      });

      this.progress({ phase: 'extracting', file: dependencyName });
      const extractedFiles = await extractArchive(
        archivePath,
        extractDir,
        this.extractionProgress(dependencyName)
      );
      const files = [...new Set(extractedFiles)];

      if (
        files.length === 0 ||
        files.some((relativeFile) => !this.resolveDependencyFile(extractDir, relativeFile))
      ) {
        throw new BinaryError('Dependency archive contained no safe files', {
          dependency: dependency.url,
          suggestion: 'Check the configured dependency archive and checksum.',
        });
      }

      entries.push({
        url: dependency.url,
        checksum: dependency.checksum,
        files,
      });
      this.log(`${dependencyName} extracted successfully`, 'info');
    }

    return { entries };
  }

  /**
   * Explicitly install all dependency files, including nested paths.
   */
  private async installDependencyFiles(
    entries: readonly DependencyManifestEntry[],
    extractDir: string,
    installedDir: string
  ): Promise<void> {
    for (const entry of entries) {
      for (const relativeFile of entry.files) {
        const source = this.resolveDependencyFile(extractDir, relativeFile);
        const destination = this.resolveDependencyFile(installedDir, relativeFile);
        if (!source || !destination || !(await fileExists(source))) {
          throw new BinaryError('Dependency file missing after extraction', {
            file: relativeFile,
            checksum: entry.checksum,
          });
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
      }
    }
  }

  /**
   * Reject main archives that overwrite files attributed to a dependency
   * checksum. Matching is case-insensitive because dependencies are used
   * primarily on Windows.
   */
  private assertNoDependencyFileCollisions(
    entries: readonly DependencyManifestEntry[],
    mainArchiveFiles: readonly string[]
  ): void {
    const dependencyFiles = new Set(
      entries.flatMap((entry) =>
        entry.files.map((file) => file.replaceAll('\\', '/').toLowerCase())
      )
    );
    const collision = mainArchiveFiles.find((file) =>
      dependencyFiles.has(file.replaceAll('\\', '/').toLowerCase())
    );

    if (collision) {
      throw new BinaryError('Main binary archive conflicts with a dependency file', {
        file: collision,
        suggestion: 'Use binary and dependency archives with disjoint file paths.',
      });
    }
  }

  /**
   * Persist the dependencies present in a complete candidate installation.
   */
  private async commitDependencyManifest(
    prepared: PreparedDependencies,
    installedDir: string
  ): Promise<void> {
    await fs.writeFile(
      path.join(installedDir, '.deps.json'),
      JSON.stringify(
        {
          version: 1,
          dependencies: prepared.entries,
        } satisfies DependencyManifest,
        null,
        2
      ),
      'utf-8'
    );
  }

  private async cleanupVariantArtifacts(
    archivePath: string,
    extractDir: string,
    dependencyArchivePaths: readonly string[]
  ): Promise<void> {
    await deleteFile(archivePath).catch(() => void 0);
    for (const dependencyArchivePath of dependencyArchivePaths) {
      await deleteFile(dependencyArchivePath).catch(() => void 0);
    }
    await cleanupExtraction(extractDir).catch(() => void 0);
  }

  /**
   * Best-effort cleanup for artifacts left if the process was killed after a
   * candidate had been installed but before its normal cleanup completed.
   *
   * An unmanifested dependency archive may be the only reusable recovery copy
   * after a kill between dependency installation and manifest commit, so it is
   * retained. A manifested archive is deleted only after its own checksum
   * proves that the installed dependency state already records those bytes.
   */
  private async cleanupInstalledBinaryResidue(finalBinaryPath: string): Promise<void> {
    const manifest = await this.loadDependencyManifest();
    const manifestedChecksums = new Set(
      manifest.dependencies.map((dependency) => dependency.checksum)
    );
    const dependencyArchivePaths = new Set<string>();

    for (const variant of this.config.variants) {
      const archivePath = `${finalBinaryPath}.${variant.type}${getArchiveExtension(variant.url)}`;
      const extractDir = `${finalBinaryPath}.${variant.type}.extract`;
      for (const dependencyArchivePath of this.getDependencyArchivePaths(
        variant.dependencies ?? []
      )) {
        dependencyArchivePaths.add(dependencyArchivePath);
      }

      await deleteFile(archivePath).catch(() => void 0);
      await cleanupExtraction(extractDir).catch(() => void 0);
    }

    for (const dependencyArchivePath of dependencyArchivePaths) {
      if (!(await fileExists(dependencyArchivePath))) {
        continue;
      }

      try {
        const archiveChecksum = await calculateChecksum(dependencyArchivePath);
        if (manifestedChecksums.has(archiveChecksum)) {
          await deleteFile(dependencyArchivePath).catch(() => void 0);
        } else {
          this.log(
            `Preserving unmanifested dependency archive for recovery: ${path.basename(dependencyArchivePath)}`,
            'info'
          );
        }
      } catch (error) {
        this.log(
          `Could not verify leftover dependency archive; preserving it for recovery: ${error}`,
          'warn'
        );
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
    finalBinaryPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const { type } = this.config;
    const archiveExt = getArchiveExtension(variant.url);
    const archivePath = `${finalBinaryPath}.${variant.type}${archiveExt}`;
    const extractDir = `${finalBinaryPath}.${variant.type}.extract`;
    const dependencies = variant.dependencies ?? [];
    const dependencyArchivePaths = this.getDependencyArchivePaths(dependencies);
    const installedDir = PATHS.binaries[type];
    const transactionId = `${process.pid}-${Date.now()}-${variant.type}`;
    const candidateInstallDir = `${installedDir}.candidate-${transactionId}`;
    const priorInstallBackupDir = `${installedDir}.backup-${transactionId}`;

    await cleanupExtraction(extractDir);
    await fs.rm(candidateInstallDir, { recursive: true, force: true });
    await fs.rm(priorInstallBackupDir, { recursive: true, force: true });

    try {
      const preparedDependencies =
        dependencies.length > 0
          ? await this.downloadDependencies(dependencies, extractDir, signal)
          : {
              entries: [],
            };

      await this.ensureVerifiedArchive({
        url: variant.url,
        destination: archivePath,
        checksum: variant.checksum,
        fileLabel: 'binary',
        downloadLabel: `${variant.type} binary`,
        ...(signal ? { signal } : {}),
      });

      // Determine which binary names to search for based on type
      const binaryNamesToSearch =
        this.config.type === 'llama'
          ? ['llama-server.exe', 'llama-server', 'llama-cli.exe', 'llama-cli']
          : ['sd-cli.exe', 'sd-cli', 'sd.exe', 'sd'];

      // Extract main binary archive to same directory as dependencies
      this.progress({ phase: 'extracting', file: 'binary' });
      let mainArchiveFiles: readonly string[] = [];
      const extractedBinaryPath = await extractBinary(
        archivePath,
        extractDir,
        binaryNamesToSearch,
        this.extractionProgress('binary'),
        (files) => {
          mainArchiveFiles = files;
        }
      );
      signal?.throwIfAborted();
      this.assertNoDependencyFileCollisions(preparedDependencies.entries, mainArchiveFiles);

      // Test if binary works (has required drivers, etc.)
      this.progress({ phase: 'testing', file: 'binary' });
      const works = await this.testBinary(extractedBinaryPath, signal);
      signal?.throwIfAborted();

      if (works) {
        // Build the full replacement beside the live directory. The live installation remains
        // untouched until every copy, permission, manifest, and cache write has succeeded.
        await fs.mkdir(candidateInstallDir, { recursive: true });

        // Copy ALL files that sit next to the binary to the binaries directory
        // (the .exe/.so AND all required shared libraries). Unix tar.gz releases
        // nest everything under a top-level llama-<tag>/ directory, so copying
        // the extract root verbatim would strand the binary in a subdirectory
        // that finalBinaryPath/chmod/spawn never look at — flatten instead.
        const extractedBinaryDir = path.dirname(extractedBinaryPath);
        await copyDirectory(extractedBinaryDir, candidateInstallDir);

        // Dependencies (e.g. CUDA runtime DLLs) are extracted at the extract
        // root; when the main archive was nested they are not in the binary's
        // directory, so copy root-level files as well.
        if (path.resolve(extractedBinaryDir) !== path.resolve(extractDir)) {
          const rootEntries = await fs.readdir(extractDir, { withFileTypes: true });
          for (const entry of rootEntries) {
            if (entry.isFile()) {
              await fs.copyFile(
                path.join(extractDir, entry.name),
                path.join(candidateInstallDir, entry.name),
                fsConstants.COPYFILE_FICLONE
              );
            }
          }
        }
        await this.installDependencyFiles(
          preparedDependencies.entries,
          extractDir,
          candidateInstallDir
        );
        const candidateBinaryPath = path.join(candidateInstallDir, path.basename(finalBinaryPath));

        // Make executable (Unix-like systems)
        if (process.platform !== 'win32') {
          await fs.chmod(candidateBinaryPath, 0o755);
        }

        await this.commitDependencyManifest(preparedDependencies, candidateInstallDir);
        const checksum = await calculateChecksum(candidateBinaryPath);
        await fs.writeFile(
          path.join(candidateInstallDir, '.variant.json'),
          JSON.stringify({ variant: variant.type, platform: this.config.platformKey }),
          'utf-8'
        );
        await fs.writeFile(
          path.join(candidateInstallDir, '.validation.json'),
          JSON.stringify(
            {
              variant: variant.type,
              checksum,
              validatedAt: new Date().toISOString(),
              phase1Passed: true,
              phase2Passed: this.config.testModelPath ? true : undefined,
              version: this.config.version,
            } satisfies ValidationCache,
            null,
            2
          ),
          'utf-8'
        );

        // Publish the candidate with a recoverable directory swap. If the second rename fails,
        // restore the prior live directory before surfacing the variant failure.
        signal?.throwIfAborted();
        await fs.rename(installedDir, priorInstallBackupDir);
        try {
          await fs.rename(candidateInstallDir, installedDir);
        } catch (commitError) {
          try {
            await fs.rename(priorInstallBackupDir, installedDir);
          } catch (renameRestoreError) {
            try {
              await copyDirectory(priorInstallBackupDir, installedDir);
            } catch (copyRestoreError) {
              throw new BinaryError(
                'Binary installation failed and prior install restoration failed',
                {
                  commitError: String(commitError),
                  renameRestoreError: String(renameRestoreError),
                  copyRestoreError: String(copyRestoreError),
                  priorInstallBackupDir,
                }
              );
            }
          }
          throw commitError;
        }
        await fs.rm(priorInstallBackupDir, { recursive: true, force: true }).catch((error) => {
          this.log(`Could not remove prior binary backup: ${error}`, 'warn');
        });

        return true;
      } else {
        await this.cleanupVariantArtifacts(archivePath, extractDir, dependencyArchivePaths);
        return false;
      }
    } catch (error) {
      await fs.rm(candidateInstallDir, { recursive: true, force: true }).catch(() => void 0);
      await this.cleanupVariantArtifacts(archivePath, extractDir, dependencyArchivePaths);
      throw error;
    }
  }

  private async waitForValidationChildExit(
    child: ReturnType<typeof spawn>,
    timeoutMs: number
  ): Promise<boolean> {
    if (child.exitCode != null || child.signalCode != null) return true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener?.('exit', onSettled);
        child.removeListener?.('close', onSettled);
        resolve(exited);
      };
      const onSettled = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.on('exit', onSettled);
      child.on('close', onSettled);
      if (child.exitCode != null || child.signalCode != null) finish(true);
    });
  }

  private async terminateValidationChild(child: ReturnType<typeof spawn>): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return;

    const gracefulExit = this.waitForValidationChildExit(
      child,
      VALIDATION_CHILD_TERMINATION_GRACE_MS
    );
    child.kill('SIGTERM');
    if (await gracefulExit) return;

    const forcedExit = this.waitForValidationChildExit(
      child,
      VALIDATION_CHILD_TERMINATION_GRACE_MS
    );
    child.kill('SIGKILL');
    if (await forcedExit) return;

    throw new BinaryError('Binary validation child did not exit after forced termination', {
      code: 'BINARY_VALIDATION_TERMINATION_UNCONFIRMED',
      pid: child.pid,
    });
  }

  /**
   * Execute a process with proper stdio handling and timeout
   *
   * Uses spawn instead of execFile to ensure stdio configuration is properly applied.
   * Promisified execFile doesn't support custom stdio options, causing hangs.
   *
   * @param command - Command to execute
   * @param args - Command arguments
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise resolving to stdout and stderr
   * @private
   */
  private spawnWithTimeout(
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
      });

      let stdout = '';
      let stderr = '';
      let settling = false;
      let settled = false;
      const rejectAfterTermination = (reason: unknown): void => {
        if (settling || settled) return;
        settling = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void this.terminateValidationChild(child).then(
          () => {
            settled = true;
            reject(reason);
          },
          (terminationError) => {
            settled = true;
            reject(terminationError);
          }
        );
      };
      const abort = () =>
        rejectAfterTermination(
          signal?.reason ?? new DOMException('Binary validation aborted', 'AbortError')
        );
      signal?.addEventListener('abort', abort, { once: true });
      const finish = () => signal?.removeEventListener('abort', abort);

      // Timeout handler
      const timer = setTimeout(
        () => rejectAfterTermination(new Error(`Process timed out after ${timeoutMs}ms`)),
        timeoutMs
      );

      // Collect stdout
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });

      // Collect stderr
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      // Handle process exit
      child.on('exit', (code, exitSignal) => {
        if (settling || settled) return;
        settled = true;
        clearTimeout(timer);
        finish();

        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const error = Object.assign(
            new Error(
              `Process exited with code ${code}${exitSignal ? ` (signal: ${exitSignal})` : ''}`
            ),
            { code, signal: exitSignal, stdout, stderr }
          );
          reject(error);
        }
      });

      // Handle spawn errors (e.g., ENOENT)
      child.on('error', (error) => {
        if (settling || settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
        reject(error);
      });
    });
  }

  /**
   * Run Phase 1: Basic validation test
   *
   * Tests that the primary server binary executes correctly.
   * - For llama: llama-server --version
   * - For diffusion: sd --help
   *
   * @param binaryPath - Path to primary binary to test
   * @returns True if basic validation succeeds
   * @private
   */
  private async runBasicValidationTest(binaryPath: string, signal?: AbortSignal): Promise<boolean> {
    const { type } = this.config;

    try {
      this.log('Phase 1: Testing binary basic validation...', 'info');

      // Use different test flags based on binary type
      const testArgs = type === 'llama' ? ['--version'] : ['--help'];

      await this.spawnWithTimeout(binaryPath, testArgs, 5000, signal);

      this.log(`Phase 1: ✓ Binary validation passed (${testArgs[0]})`, 'info');
      return true;
    } catch (error) {
      if (isValidationTerminationFailure(error)) throw error;
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Phase 1: ✗ Basic validation failed: ${errorMsg}`, 'error');
      return false;
    }
  }

  /** Diagnostic-line patterns to check in server/process output */
  private static readonly GPU_ERROR_PATTERNS: readonly {
    label: string;
    pattern: RegExp;
  }[] = [
    {
      label: 'cuda error',
      pattern: /^(?:(?:ggml|llama|cuda|gpu)[\w.-]*:\s*)?cuda(?:\s+|_)error\b/i,
    },
    {
      label: 'failed to allocate',
      pattern: /^(?:(?:ggml|llama|cuda|vulkan|gpu)[\w.-]*:\s*)?failed to allocate\b/i,
    },
    { label: 'vkcreatedevice failed', pattern: /^vkcreatedevice failed\b/i },
    {
      label: 'vulkan error',
      pattern: /^(?:(?:ggml|vulkan|gpu)[\w.-]*:\s*)?vulkan error\b/i,
    },
    {
      label: 'gpu error',
      pattern: /^(?:(?:ggml|llama|cuda|vulkan|gpu)[\w.-]*:\s*)?gpu error\b/i,
    },
    {
      label: 'out of memory',
      pattern: /^(?:(?:ggml|llama|cuda|vulkan|gpu)[\w.-]*(?:\s+failed)?:\s*)?out of memory\b/i,
    },
    { label: 'llama_model_load: error', pattern: /^llama_model_load:\s*error\b/i },
    { label: 'failed to load model', pattern: /^failed to load model\b/i },
    { label: 'error: invalid argument', pattern: /^error:\s*invalid argument\b/i },
  ];

  /**
   * Check output string for GPU/CUDA error patterns
   *
   * @param output - Combined stdout+stderr output
   * @returns The matched error pattern, or null if none found
   * @private
   */
  private checkForGpuErrors(output: string): string | null {
    for (const rawLine of output.split(/\r?\n/)) {
      // Remove common bracketed timestamp/level prefixes while keeping the
      // diagnostic itself anchored to the beginning of the remaining line.
      const line = rawLine.trim().replace(/^(?:\[[^\]]+\]\s*)+/, '');
      for (const { label, pattern } of BinaryManager.GPU_ERROR_PATTERNS) {
        if (pattern.test(line)) {
          return label;
        }
      }
    }
    return null;
  }

  /**
   * Run Phase 2: Real functionality test to verify GPU/CUDA actually works
   *
   * Tests actual inference capability to catch GPU/CUDA errors.
   * - For llama: Starts llama-server, sends a completion request, then kills it
   * - For diffusion: Uses sd for tiny image generation
   *
   * @param binaryPath - Path to primary binary (llama-server or sd)
   * @param modelPath - Path to test model
   * @returns True if real inference test succeeds
   * @private
   */
  private async runRealFunctionalityTest(
    binaryPath: string,
    modelPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const { type } = this.config;

    if (type === 'llama') {
      return this.runLlamaServerTest(binaryPath, modelPath, signal);
    }
    return this.runDiffusionTest(binaryPath, modelPath, signal);
  }

  /**
   * Run Phase 2 for llama: start llama-server, send completion, kill
   *
   * Starts llama-server on an ephemeral port with GPU layers enabled,
   * waits for it to become healthy, sends a test completion request
   * to exercise the full GPU inference path, then kills the server.
   *
   * @param binaryPath - Path to llama-server binary
   * @param modelPath - Path to test model
   * @returns True if GPU inference test succeeds
   * @private
   */
  private async runLlamaServerTest(
    binaryPath: string,
    modelPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const testPort = 49152 + Math.floor(Math.random() * 16000);
    const timeout = 15000;
    let child: ReturnType<typeof spawn> | null = null;
    let stderr = '';
    let spawnFailure: Error | undefined;
    const abort = () => child?.kill('SIGTERM');
    const recordChildError = (error: Error) => {
      spawnFailure = error;
    };

    try {
      this.log('Phase 2: Testing GPU functionality with llama-server...', 'info');

      // Start llama-server with minimal config
      const testArgs = [
        '-m',
        modelPath,
        '--port',
        String(testPort),
        '-ngl',
        '1', // Force at least 1 GPU layer
        '-c',
        '512', // Minimal context for fast startup
      ];

      child = spawn(binaryPath, testArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('error', recordChildError);
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
      }

      // A failed spawn is reported asynchronously. Give that event a turn before
      // polling HTTP, and keep checking in case the process fails during startup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (spawnFailure) throw spawnFailure;

      // Collect stderr for GPU error detection
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      // Wait for server to become healthy
      const startTime = Date.now();
      let healthy = false;

      while (Date.now() - startTime < timeout) {
        signal?.throwIfAborted();
        if (spawnFailure) throw spawnFailure;
        // Check stderr for GPU errors while waiting
        const gpuError = this.checkForGpuErrors(stderr);
        if (gpuError) {
          this.log(`Phase 2: ✗ GPU error detected during startup: ${gpuError}`, 'warn');
          return false;
        }

        try {
          const controller = new AbortController();
          const fetchTimer = setTimeout(() => controller.abort(), 2000);
          try {
            const response = await fetch(`http://127.0.0.1:${testPort}/health`, {
              signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            });

            if (response.ok) {
              const data = (await response.json()) as { status?: string };
              if (data.status === 'ok') {
                healthy = true;
                break;
              }
            }
          } finally {
            clearTimeout(fetchTimer);
          }
        } catch {
          // Server not ready yet
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (!healthy) {
        this.log('Phase 2: ✗ llama-server did not become healthy within timeout', 'warn');
        if (stderr) {
          this.log(`Phase 2 stderr output:\n${stderr.slice(0, 500)}`, 'warn');
        }
        return false;
      }

      if (spawnFailure) throw spawnFailure;

      // Send a test completion request to exercise GPU inference
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 5000);
      let completionResponse: Response;
      try {
        completionResponse = await fetch(`http://127.0.0.1:${testPort}/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '2+2=', n_predict: 4 }),
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        });
      } finally {
        clearTimeout(fetchTimer);
      }

      if (spawnFailure) throw spawnFailure;

      if (!completionResponse.ok) {
        this.log(
          `Phase 2: ✗ Completion request failed with status ${completionResponse.status}`,
          'warn'
        );
        return false;
      }

      // Check stderr one final time for GPU errors during inference
      const gpuError = this.checkForGpuErrors(stderr);
      if (gpuError) {
        this.log(`Phase 2: ✗ GPU error detected during inference: ${gpuError}`, 'warn');
        return false;
      }

      this.log('Phase 2: ✓ GPU functionality test passed (llama-server)', 'info');
      return true;
    } catch (error) {
      if (isValidationTerminationFailure(error)) throw error;
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (stderr) {
        this.log(`Phase 2 output before failure:\nstderr: ${stderr.slice(0, 500)}`, 'warn');
      }

      const gpuError = this.checkForGpuErrors(stderr);
      if (gpuError) {
        this.log(`Phase 2: ✗ GPU error detected in output: ${gpuError}`, 'warn');
        return false;
      }

      this.log(`Phase 2: ✗ Real functionality test failed: ${errorMsg}`, 'warn');
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      try {
        // A child with no pid never started. Otherwise, confirm it is gone and
        // escalate if it ignores graceful termination.
        if (child && !(spawnFailure && child.pid === undefined)) {
          await this.terminateValidationChild(child);
        }
      } finally {
        child?.removeListener('error', recordChildError);
      }
    }
  }

  /**
   * Run Phase 2 for diffusion: one-shot tiny image generation
   *
   * @param binaryPath - Path to sd binary
   * @param modelPath - Path to test model
   * @returns True if test succeeds
   * @private
   */
  private async runDiffusionTest(
    binaryPath: string,
    modelPath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      this.log('Phase 2: Testing GPU functionality with real inference...', 'info');

      const tempOutput = path.join(PATHS.binaries[this.config.type], '.test-output.png');

      // Use pre-built model args for multi-component models, otherwise default to -m
      const modelArgs = this.config.testModelArgs || ['-m', modelPath];

      const testArgs = [
        ...modelArgs,
        ...(this.config.testOptimizationArgs ?? []),
        '-p',
        'test',
        '-o',
        tempOutput,
        '--width',
        '64',
        '--height',
        '64',
        '--steps',
        '1',
      ];

      // Multi-component models (7GB+) need more time to load all components
      const timeout = this.config.testModelArgs ? 120000 : 15000;
      const { stdout, stderr } = await this.spawnWithTimeout(binaryPath, testArgs, timeout, signal);

      const gpuError = this.checkForGpuErrors(`${stdout}\n${stderr}`);
      if (gpuError) {
        this.log(`Phase 2: ✗ GPU error detected: ${gpuError}`, 'warn');
        return false;
      }

      this.log('Phase 2: ✓ GPU functionality test passed (sd)', 'info');
      return true;
    } catch (error) {
      if (isValidationTerminationFailure(error)) throw error;
      if (signal?.aborted) throw signal.reason ?? error;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorObj = error as { stdout?: string; stderr?: string };
      const stdout = errorObj.stdout || '';
      const stderr = errorObj.stderr || '';

      if (stdout || stderr) {
        this.log(
          `Phase 2 output before failure:\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
          'warn'
        );
      }

      const gpuError = this.checkForGpuErrors(`${stdout}\n${stderr}`);
      if (gpuError) {
        this.log(`Phase 2: ✗ GPU error detected in output: ${gpuError}`, 'warn');
        return false;
      }

      this.log(`Phase 2: ✗ Real functionality test failed: ${errorMsg}`, 'warn');
      return false;
    }
  }

  /**
   * Test if a binary works using two-phase approach
   *
   * Phase 1 (always runs): Basic validation (--version / --help)
   * Phase 2 (if model available): Real functionality test (GPU inference)
   *
   * Both phases must pass for binary to be considered working.
   *
   * @param binaryPath - Path to binary to test
   * @returns True if all required tests pass
   * @private
   */
  private async testBinary(binaryPath: string, signal?: AbortSignal): Promise<boolean> {
    const { testModelPath } = this.config;

    // Phase 1: Basic validation (always required)
    const phase1Passed = await this.runBasicValidationTest(binaryPath, signal);
    if (!phase1Passed) {
      this.log('Binary validation failed, variant will be skipped', 'warn');
      return false;
    }

    // Phase 2: Real functionality test (if model available)
    if (testModelPath && (await fileExists(testModelPath))) {
      const phase2Passed = await this.runRealFunctionalityTest(binaryPath, testModelPath, signal);
      if (!phase2Passed) {
        this.log('GPU functionality test failed, variant will be skipped', 'warn');
        return false;
      }
    } else {
      this.log('No test model provided, skipping Phase 2 (GPU functionality test)', 'info');
    }

    // All required tests passed
    return true;
  }

  /**
   * Helper to log messages if logger is provided
   */
  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.config.log) {
      this.config.log(message, level);
    }
  }

  /**
   * Emit a structured provisioning progress event (no-op without a callback)
   * @private
   */
  private progress(event: BinaryProgressEvent): void {
    this.config.onProgress?.(event);
  }
}
