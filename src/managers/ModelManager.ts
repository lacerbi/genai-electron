/**
 * Model management for downloads, storage, and metadata
 * @module managers/ModelManager
 */

import path from 'node:path';
import type { ModelInfo, ModelType, DownloadConfig } from '../types/index.js';
import { ModelNotFoundError, DownloadError } from '../errors/index.js';
import { storageManager } from './StorageManager.js';
import { Downloader } from '../download/Downloader.js';
import { getHuggingFaceURL } from '../download/huggingface.js';
import { calculateSHA256, formatChecksum } from '../download/checksum.js';
import { fileExists, getFileSize, sanitizeFilename } from '../utils/file-utils.js';
import { detectReasoningSupport } from '../config/reasoning-models.js';

/**
 * Model manager for downloading and managing AI models
 *
 * @example
 * ```typescript
 * const modelManager = ModelManager.getInstance();
 * await modelManager.initialize();
 *
 * const models = await modelManager.listModels('llm');
 * console.log(models);
 * ```
 */
export class ModelManager {
  private static instance: ModelManager;
  private downloader: Downloader;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    this.downloader = new Downloader();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ModelManager {
    if (!ModelManager.instance) {
      ModelManager.instance = new ModelManager();
    }
    return ModelManager.instance;
  }

  /**
   * Initialize model manager
   * Ensures storage directories are created
   *
   * @example
   * ```typescript
   * await modelManager.initialize();
   * ```
   */
  public async initialize(): Promise<void> {
    await storageManager.initialize();
  }

  /**
   * List installed models
   *
   * @param type - Model type filter (optional)
   * @returns Array of model information
   *
   * @example
   * ```typescript
   * const llmModels = await modelManager.listModels('llm');
   * console.log(llmModels);
   * ```
   */
  public async listModels(type?: ModelType): Promise<ModelInfo[]> {
    const types: ModelType[] = type ? [type] : ['llm', 'diffusion'];
    const models: ModelInfo[] = [];

    for (const modelType of types) {
      const modelIds = await storageManager.listModelFiles(modelType);

      for (const modelId of modelIds) {
        try {
          const modelInfo = await storageManager.loadModelMetadata(modelType, modelId);
          models.push(modelInfo);
        } catch {
          // Skip models with corrupted metadata
        }
      }
    }

    return models;
  }

  /**
   * Download a model
   *
   * @param config - Download configuration
   * @returns Model information
   * @throws {DownloadError} If download fails
   *
   * @example
   * ```typescript
   * const model = await modelManager.downloadModel({
   *   source: 'url',
   *   url: 'https://example.com/model.gguf',
   *   name: 'My Model',
   *   type: 'llm',
   *   onProgress: (downloaded, total) => {
   *     console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
   *   }
   * });
   * ```
   */
  public async downloadModel(config: DownloadConfig): Promise<ModelInfo> {
    // Ensure storage is initialized
    await this.initialize();

    // Determine download URL
    let downloadURL: string;
    let sourceRepo: string | undefined;
    let sourceFile: string | undefined;

    if (config.source === 'url') {
      if (!config.url) {
        throw new DownloadError('URL is required when source is "url"');
      }
      downloadURL = config.url;
    } else if (config.source === 'huggingface') {
      if (!config.repo || !config.file) {
        throw new DownloadError('Repository and file are required when source is "huggingface"');
      }
      downloadURL = getHuggingFaceURL(config.repo, config.file);
      sourceRepo = config.repo;
      sourceFile = config.file;
    } else {
      throw new DownloadError(`Unsupported source type: ${config.source}`);
    }

    // Generate model ID from name
    const modelId = this.generateModelId(config.name);

    // Determine filename from URL
    const filename = this.extractFilename(downloadURL, sourceFile);

    // Get destination path
    const destinationPath = storageManager.getModelPath(config.type, filename);

    // Check if model already exists
    const exists = await fileExists(destinationPath);
    if (exists) {
      throw new DownloadError(`Model file already exists: ${filename}`, {
        path: destinationPath,
      });
    }

    // Download the model
    await this.downloader.download({
      url: downloadURL,
      destination: destinationPath,
      onProgress: config.onProgress,
    });

    // Get file size
    const size = await getFileSize(destinationPath);

    // Calculate checksum if requested or if one was provided for verification
    let checksum: string | undefined;
    if (config.checksum) {
      const calculatedChecksum = await calculateSHA256(destinationPath);
      const expectedChecksum = config.checksum.replace(/^sha256:/, '');

      if (calculatedChecksum !== expectedChecksum) {
        // Delete the downloaded file since checksum doesn't match
        await storageManager.deleteModelFiles(config.type, modelId).catch(() => {
          // Ignore errors during cleanup
        });

        throw new DownloadError('Checksum verification failed', {
          expected: expectedChecksum,
          actual: calculatedChecksum,
        });
      }

      checksum = formatChecksum(calculatedChecksum);
    }

    // Detect reasoning support based on filename
    const supportsReasoning = detectReasoningSupport(filename);

    // Create model info
    const modelInfo: ModelInfo = {
      id: modelId,
      name: config.name,
      type: config.type,
      size,
      path: destinationPath,
      downloadedAt: new Date().toISOString(),
      source: {
        type: config.source,
        url: downloadURL,
        repo: sourceRepo,
        file: sourceFile,
      },
      checksum,
      supportsReasoning,
    };

    // Save metadata
    await storageManager.saveModelMetadata(modelInfo);

    return modelInfo;
  }

  /**
   * Delete a model
   *
   * @param id - Model ID
   * @throws {ModelNotFoundError} If model doesn't exist
   *
   * @example
   * ```typescript
   * await modelManager.deleteModel('llama-2-7b');
   * ```
   */
  public async deleteModel(id: string): Promise<void> {
    // Try to find the model in both types
    const models = await this.listModels();
    const model = models.find((m) => m.id === id);

    if (!model) {
      throw new ModelNotFoundError(id);
    }

    await storageManager.deleteModelFiles(model.type, model.id);
  }

  /**
   * Get model information
   *
   * @param id - Model ID
   * @returns Model information
   * @throws {ModelNotFoundError} If model doesn't exist
   *
   * @example
   * ```typescript
   * const model = await modelManager.getModelInfo('llama-2-7b');
   * console.log(model.name);
   * ```
   */
  public async getModelInfo(id: string): Promise<ModelInfo> {
    // Try to find the model in both types
    const models = await this.listModels();
    const model = models.find((m) => m.id === id);

    if (!model) {
      throw new ModelNotFoundError(id);
    }

    return model;
  }

  /**
   * Verify model integrity
   *
   * @param id - Model ID
   * @returns True if model is valid
   * @throws {ModelNotFoundError} If model doesn't exist
   * @throws {ChecksumError} If checksum doesn't match
   *
   * @example
   * ```typescript
   * const valid = await modelManager.verifyModel('llama-2-7b');
   * if (valid) {
   *   console.log('Model is valid');
   * }
   * ```
   */
  public async verifyModel(id: string): Promise<boolean> {
    const model = await this.getModelInfo(id);
    return storageManager.verifyModelIntegrity(model.type, model.id);
  }

  /**
   * Cancel ongoing download
   *
   * @example
   * ```typescript
   * modelManager.cancelDownload();
   * ```
   */
  public cancelDownload(): void {
    this.downloader.cancel();
  }

  /**
   * Check if a download is in progress
   *
   * @returns True if downloading
   */
  public isDownloading(): boolean {
    return this.downloader.downloading;
  }

  /**
   * Generate a model ID from name
   * Converts to lowercase, replaces spaces with hyphens, removes special chars
   */
  private generateModelId(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Extract filename from URL or use provided filename
   */
  private extractFilename(url: string, fallbackFilename?: string): string {
    if (fallbackFilename) {
      return sanitizeFilename(fallbackFilename);
    }

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = path.basename(pathname);

      return sanitizeFilename(filename);
    } catch {
      // If URL parsing fails, use a generic filename
      return 'model.gguf';
    }
  }
}

// Export singleton instance
export const modelManager = ModelManager.getInstance();
