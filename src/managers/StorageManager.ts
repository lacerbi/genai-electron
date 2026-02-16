/**
 * Storage management for models and metadata
 * @module managers/StorageManager
 */

import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ModelInfo, ModelType } from '../types/index.js';
import { FileSystemError, ChecksumError } from '../errors/index.js';
import {
  ensureDirectories,
  getModelMetadataPath,
  getModelFilePath,
  PATHS,
} from '../config/paths.js';
import { fileExists, deleteFile, calculateChecksum } from '../utils/file-utils.js';

/**
 * Storage manager for model files and metadata
 * Handles file system operations in Electron's userData directory
 *
 * @example
 * ```typescript
 * const storage = StorageManager.getInstance();
 * await storage.initialize();
 * await storage.saveModelMetadata(modelInfo);
 * ```
 */
export class StorageManager {
  private static instance: StorageManager;
  private initialized = false;

  /**
   * Private constructor for singleton pattern
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }

  /**
   * Initialize storage directories
   * Creates all required directories if they don't exist
   *
   * @throws {FileSystemError} If directory creation fails
   *
   * @example
   * ```typescript
   * await storage.initialize();
   * console.log('Storage ready');
   * ```
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await ensureDirectories();
      this.initialized = true;
    } catch (error) {
      throw new FileSystemError('Failed to initialize storage directories', { error });
    }
  }

  /**
   * Get the file path for a model
   *
   * @param type - Model type (llm or diffusion)
   * @param filename - Model filename
   * @returns Absolute path to model file
   *
   * @example
   * ```typescript
   * const path = storage.getModelPath('llm', 'llama-2-7b.gguf');
   * ```
   */
  public getModelPath(type: ModelType, filename: string): string {
    return getModelFilePath(type, filename);
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
   * const metaPath = storage.getModelMetadataPath('llm', 'llama-2-7b');
   * ```
   */
  public getModelMetadataPath(type: ModelType, modelId: string): string {
    return getModelMetadataPath(type, modelId);
  }

  /**
   * Save model metadata to disk
   *
   * @param modelInfo - Model information to save
   * @throws {FileSystemError} If save fails
   *
   * @example
   * ```typescript
   * await storage.saveModelMetadata({
   *   id: 'llama-2-7b',
   *   name: 'Llama 2 7B',
   *   type: 'llm',
   *   size: 4368769024,
   *   path: '/path/to/model.gguf',
   *   downloadedAt: new Date().toISOString(),
   *   source: { type: 'url', url: 'https://...' }
   * });
   * ```
   */
  public async saveModelMetadata(modelInfo: ModelInfo): Promise<void> {
    const metadataPath = this.getModelMetadataPath(modelInfo.type, modelInfo.id);

    try {
      const json = JSON.stringify(modelInfo, null, 2);
      await writeFile(metadataPath, json, 'utf-8');
    } catch (error) {
      throw new FileSystemError(`Failed to save model metadata: ${modelInfo.id}`, {
        path: metadataPath,
        error,
      });
    }
  }

  /**
   * Load model metadata from disk
   *
   * @param type - Model type (llm or diffusion)
   * @param modelId - Model identifier
   * @returns Model information
   * @throws {FileSystemError} If metadata file doesn't exist or is invalid
   *
   * @example
   * ```typescript
   * const modelInfo = await storage.loadModelMetadata('llm', 'llama-2-7b');
   * console.log(modelInfo.name);
   * ```
   */
  public async loadModelMetadata(type: ModelType, modelId: string): Promise<ModelInfo> {
    const metadataPath = this.getModelMetadataPath(type, modelId);

    try {
      const exists = await fileExists(metadataPath);
      if (!exists) {
        throw new FileSystemError(`Model metadata not found: ${modelId}`, {
          path: metadataPath,
          modelId,
        });
      }

      const json = await readFile(metadataPath, 'utf-8');
      const modelInfo = JSON.parse(json) as ModelInfo;

      return modelInfo;
    } catch (error) {
      if (error instanceof FileSystemError) {
        throw error;
      }
      throw new FileSystemError(`Failed to load model metadata: ${modelId}`, {
        path: metadataPath,
        error,
      });
    }
  }

  /**
   * Delete model files (model + metadata)
   *
   * @param type - Model type (llm or diffusion)
   * @param modelId - Model identifier
   * @throws {FileSystemError} If deletion fails
   *
   * @example
   * ```typescript
   * await storage.deleteModelFiles('llm', 'llama-2-7b');
   * console.log('Model deleted');
   * ```
   */
  public async deleteModelFiles(type: ModelType, modelId: string): Promise<void> {
    // Load metadata to get model file path
    const metadata = await this.loadModelMetadata(type, modelId);
    const metadataPath = this.getModelMetadataPath(type, modelId);

    if (metadata.components) {
      // Multi-component: delete each component file
      for (const component of Object.values(metadata.components)) {
        try {
          const exists = await fileExists(component.path);
          if (exists) {
            await deleteFile(component.path);
          }
        } catch (error) {
          throw new FileSystemError(`Failed to delete component file: ${component.path}`, {
            path: component.path,
            error,
          });
        }
      }

      // Try to remove the model subdirectory (only succeeds if empty)
      try {
        const modelDir = path.dirname(metadata.path);
        await rm(modelDir, { recursive: false });
      } catch {
        // Directory not empty or doesn't exist — ignore
      }
    } else {
      // Single-file: delete model file
      try {
        const modelExists = await fileExists(metadata.path);
        if (modelExists) {
          await deleteFile(metadata.path);
        }
      } catch (error) {
        throw new FileSystemError(`Failed to delete model file: ${metadata.path}`, {
          path: metadata.path,
          error,
        });
      }
    }

    // Delete metadata file
    try {
      await deleteFile(metadataPath);
    } catch (error) {
      throw new FileSystemError(`Failed to delete metadata file: ${metadataPath}`, {
        path: metadataPath,
        error,
      });
    }
  }

  /**
   * List all model files of a specific type
   *
   * @param type - Model type (llm or diffusion)
   * @returns Array of model filenames (without .json extension)
   *
   * @example
   * ```typescript
   * const llmModels = await storage.listModelFiles('llm');
   * console.log(llmModels); // ['llama-2-7b', 'mistral-7b']
   * ```
   */
  public async listModelFiles(type: ModelType): Promise<string[]> {
    const dir = PATHS.models[type];

    try {
      const files = await readdir(dir);

      // Filter for .json metadata files
      const metadataFiles = files.filter((file) => file.endsWith('.json'));

      // Remove .json extension to get model IDs
      const modelIds = metadataFiles.map((file) => file.replace(/\.json$/, ''));

      return modelIds;
    } catch (error) {
      // If directory doesn't exist, return empty array
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw new FileSystemError(`Failed to list model files in ${dir}`, {
        path: dir,
        error,
      });
    }
  }

  /**
   * Check available disk space
   * Note: This is a basic implementation. Full disk space checking would require
   * platform-specific commands or native modules.
   *
   * @returns Available disk space in bytes (approximate)
   *
   * @example
   * ```typescript
   * const available = await storage.checkDiskSpace();
   * console.log(`${available / (1024 ** 3)} GB available`);
   * ```
   */
  public async checkDiskSpace(): Promise<number> {
    // Note: Node.js doesn't have a built-in cross-platform way to check disk space
    // This is a placeholder that would need platform-specific implementation
    // For Phase 1 MVP, we'll skip this check and return a large value
    // Phase 3/4 can add proper disk space checking

    // Return a very large number to indicate "unknown but assumed sufficient"
    return Number.MAX_SAFE_INTEGER;

    // TODO Phase 3/4: Implement proper disk space checking
    // macOS/Linux: Use statvfs or df command
    // Windows: Use wmic or PowerShell
  }

  /**
   * Verify model file integrity using checksum
   *
   * @param type - Model type (llm or diffusion)
   * @param modelId - Model identifier
   * @returns True if checksum matches, false if no checksum stored
   * @throws {ChecksumError} If checksum doesn't match
   * @throws {FileSystemError} If file doesn't exist
   *
   * @example
   * ```typescript
   * const valid = await storage.verifyModelIntegrity('llm', 'llama-2-7b');
   * if (valid) {
   *   console.log('Model file is valid');
   * }
   * ```
   */
  public async verifyModelIntegrity(type: ModelType, modelId: string): Promise<boolean> {
    const metadata = await this.loadModelMetadata(type, modelId);

    if (metadata.components) {
      // Multi-component: verify each component file
      let hasAnyChecksum = false;

      for (const [role, component] of Object.entries(metadata.components)) {
        const exists = await fileExists(component.path);
        if (!exists) {
          throw new FileSystemError(`Component file not found (${role}): ${component.path}`, {
            path: component.path,
            modelId,
          });
        }

        if (component.checksum) {
          hasAnyChecksum = true;
          const actualChecksum = await calculateChecksum(component.path);
          const expected = component.checksum.replace(/^sha256:/, '');
          if (actualChecksum !== expected) {
            throw new ChecksumError(`SHA256 checksum mismatch for component: ${role}`, {
              expected,
              actual: actualChecksum,
            });
          }
        }
      }

      return hasAnyChecksum;
    }

    // Single-file: original behavior
    if (!metadata.checksum) {
      return false;
    }

    const exists = await fileExists(metadata.path);
    if (!exists) {
      throw new FileSystemError(`Model file not found: ${metadata.path}`, {
        path: metadata.path,
        modelId,
      });
    }

    const actualChecksum = await calculateChecksum(metadata.path);
    const expected = metadata.checksum.replace(/^sha256:/, '');
    if (actualChecksum !== expected) {
      throw new ChecksumError('SHA256 checksum mismatch', {
        expected,
        actual: actualChecksum,
      });
    }

    return true;
  }

  /**
   * Get total storage used by models
   *
   * @param type - Model type (llm, diffusion, or undefined for all)
   * @returns Total size in bytes
   *
   * @example
   * ```typescript
   * const used = await storage.getStorageUsed('llm');
   * console.log(`LLM models using ${used / (1024 ** 3)} GB`);
   * ```
   */
  public async getStorageUsed(type?: ModelType): Promise<number> {
    const types: ModelType[] = type ? [type] : ['llm', 'diffusion'];
    let totalSize = 0;

    for (const modelType of types) {
      const modelIds = await this.listModelFiles(modelType);

      for (const modelId of modelIds) {
        try {
          const metadata = await this.loadModelMetadata(modelType, modelId);
          totalSize += metadata.size;
        } catch {
          // Skip models with missing/corrupt metadata
        }
      }
    }

    return totalSize;
  }

  /**
   * Reset initialization state (mainly for testing)
   */
  public resetInitialization(): void {
    this.initialized = false;
  }
}

// Export singleton instance
export const storageManager = StorageManager.getInstance();
