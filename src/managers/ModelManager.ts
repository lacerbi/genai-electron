/**
 * Model management for downloads, storage, and metadata
 * @module managers/ModelManager
 */

import path from 'node:path';
import type { ModelInfo, ModelType, DownloadConfig, GGUFMetadata } from '../types/index.js';
import { ModelNotFoundError, DownloadError } from '../errors/index.js';
import { storageManager } from './StorageManager.js';
import { Downloader } from '../download/Downloader.js';
import { getHuggingFaceURL } from '../download/huggingface.js';
import { calculateSHA256, formatChecksum } from '../download/checksum.js';
import { fileExists, getFileSize, sanitizeFilename } from '../utils/file-utils.js';
import { detectReasoningSupport } from '../config/reasoning-models.js';
import { fetchGGUFMetadata, fetchLocalGGUFMetadata, getArchField } from '../utils/gguf-parser.js';
import {
  getLayerCountWithFallback,
  getContextLengthWithFallback,
  getArchitectureWithFallback,
} from '../utils/model-metadata-helpers.js';

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

    // Fetch GGUF metadata before downloading
    // This validates the file is a valid GGUF and extracts model information
    let ggufMetadata: GGUFMetadata | undefined;
    try {
      const parsedGGUF = await fetchGGUFMetadata(downloadURL);

      // Extract and store key metadata fields
      ggufMetadata = {
        version: parsedGGUF.metadata['version'] as number | undefined,
        tensor_count: this.convertBigIntToNumber(parsedGGUF.metadata['tensor_count']),
        kv_count: this.convertBigIntToNumber(parsedGGUF.metadata['kv_count']),
        architecture: parsedGGUF.metadata['general.architecture'] as string | undefined,
        general_name: parsedGGUF.metadata['general.name'] as string | undefined,
        file_type: parsedGGUF.metadata['general.file_type'] as number | undefined,
        block_count: getArchField(parsedGGUF.metadata, 'block_count') as number | undefined,
        context_length: getArchField(parsedGGUF.metadata, 'context_length') as number | undefined,
        attention_head_count: getArchField(parsedGGUF.metadata, 'attention.head_count') as number | undefined,
        embedding_length: getArchField(parsedGGUF.metadata, 'embedding_length') as number | undefined,
        feed_forward_length: getArchField(parsedGGUF.metadata, 'feed_forward_length') as number | undefined,
        attention_layer_norm_rms_epsilon: getArchField(
          parsedGGUF.metadata,
          'attention.layer_norm_rms_epsilon'
        ) as number | undefined,
        vocab_size: getArchField(parsedGGUF.metadata, 'vocab_size') as number | undefined,
        rope_dimension_count: getArchField(parsedGGUF.metadata, 'rope.dimension_count') as number | undefined,
        rope_freq_base: getArchField(parsedGGUF.metadata, 'rope.freq_base') as number | undefined,
        // Store complete raw metadata (JSON-serializable)
        raw: this.convertToSerializableMetadata(parsedGGUF.metadata),
      };
    } catch (error) {
      // Per user requirement: fail download if metadata fetch fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new DownloadError(
        `Failed to fetch GGUF metadata before download: ${errorMessage}`,
        {
          url: downloadURL,
          originalError: error,
          suggestion:
            'Verify the URL points to a valid GGUF file. Check network connectivity if the error persists.',
        }
      );
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
      ggufMetadata, // Include GGUF metadata
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

  /**
   * Convert GGUF metadata to JSON-serializable format
   *
   * Handles BigInt conversion and filters out non-serializable values
   */
  private convertToSerializableMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const serializable: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'bigint') {
        // Convert BigInt to number (safe for values within Number.MAX_SAFE_INTEGER)
        serializable[key] = Number(value);
      } else if (Array.isArray(value)) {
        // Handle arrays (tokenizer tokens, scores, etc.)
        serializable[key] = value.map((item) => {
          if (typeof item === 'bigint') {
            return Number(item);
          }
          return item;
        });
      } else if (typeof value === 'object' && value !== null) {
        // Skip complex objects that might not be serializable
        // We already extract key fields individually
        continue;
      } else {
        serializable[key] = value;
      }
    }

    return serializable;
  }

  /**
   * Safely convert BigInt to number for JSON serialization
   *
   * @param value - Value that might be BigInt
   * @returns Number if BigInt, undefined otherwise
   */
  private convertBigIntToNumber(value: unknown): number | undefined {
    if (typeof value === 'bigint') {
      return Number(value);
    }
    return value as number | undefined;
  }

  /**
   * Update GGUF metadata for an existing model
   *
   * Fetches and stores GGUF metadata for models that were downloaded
   * before GGUF integration. Does not re-download the model file.
   *
   * @param id - Model ID
   * @returns Updated model information
   * @throws {ModelNotFoundError} If model doesn't exist
   * @throws {DownloadError} If metadata fetch fails
   *
   * @example
   * ```typescript
   * // Update metadata for an existing model
   * const updatedModel = await modelManager.updateModelMetadata('llama-2-7b');
   * console.log('Layer count:', updatedModel.ggufMetadata?.block_count);
   * ```
   */
  public async updateModelMetadata(id: string): Promise<ModelInfo> {
    // Get existing model info
    const modelInfo = await this.getModelInfo(id);

    // Try fetching from original source URL first (remote)
    let ggufMetadata: GGUFMetadata | undefined;

    if (modelInfo.source.url) {
      try {
        const parsedGGUF = await fetchGGUFMetadata(modelInfo.source.url);

        ggufMetadata = {
          version: parsedGGUF.metadata['version'] as number | undefined,
          tensor_count: this.convertBigIntToNumber(parsedGGUF.metadata['tensor_count']),
          kv_count: this.convertBigIntToNumber(parsedGGUF.metadata['kv_count']),
          architecture: parsedGGUF.metadata['general.architecture'] as string | undefined,
          general_name: parsedGGUF.metadata['general.name'] as string | undefined,
          file_type: parsedGGUF.metadata['general.file_type'] as number | undefined,
          block_count: getArchField(parsedGGUF.metadata, 'block_count') as number | undefined,
          context_length: getArchField(parsedGGUF.metadata, 'context_length') as number | undefined,
          attention_head_count: getArchField(parsedGGUF.metadata, 'attention.head_count') as number | undefined,
          embedding_length: getArchField(parsedGGUF.metadata, 'embedding_length') as number | undefined,
          feed_forward_length: getArchField(parsedGGUF.metadata, 'feed_forward_length') as number | undefined,
          attention_layer_norm_rms_epsilon: getArchField(
            parsedGGUF.metadata,
            'attention.layer_norm_rms_epsilon'
          ) as number | undefined,
          vocab_size: getArchField(parsedGGUF.metadata, 'vocab_size') as number | undefined,
          rope_dimension_count: getArchField(parsedGGUF.metadata, 'rope.dimension_count') as number | undefined,
          rope_freq_base: getArchField(parsedGGUF.metadata, 'rope.freq_base') as number | undefined,
          raw: this.convertToSerializableMetadata(parsedGGUF.metadata),
        };
      } catch (remoteError) {
        // If remote fetch fails, try local file
        try {
          const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);

          ggufMetadata = {
            version: parsedGGUF.metadata['version'] as number | undefined,
            tensor_count: this.convertBigIntToNumber(parsedGGUF.metadata['tensor_count']),
            kv_count: this.convertBigIntToNumber(parsedGGUF.metadata['kv_count']),
            architecture: parsedGGUF.metadata['general.architecture'] as string | undefined,
            general_name: parsedGGUF.metadata['general.name'] as string | undefined,
            file_type: parsedGGUF.metadata['general.file_type'] as number | undefined,
            block_count: getArchField(parsedGGUF.metadata, 'block_count') as number | undefined,
            context_length: getArchField(parsedGGUF.metadata, 'context_length') as number | undefined,
            attention_head_count: getArchField(parsedGGUF.metadata, 'attention.head_count') as number | undefined,
            embedding_length: getArchField(parsedGGUF.metadata, 'embedding_length') as number | undefined,
            feed_forward_length: getArchField(parsedGGUF.metadata, 'feed_forward_length') as number | undefined,
            attention_layer_norm_rms_epsilon: getArchField(
              parsedGGUF.metadata,
              'attention.layer_norm_rms_epsilon'
            ) as number | undefined,
            vocab_size: getArchField(parsedGGUF.metadata, 'vocab_size') as number | undefined,
            rope_dimension_count: getArchField(parsedGGUF.metadata, 'rope.dimension_count') as number | undefined,
            rope_freq_base: getArchField(parsedGGUF.metadata, 'rope.freq_base') as number | undefined,
            raw: this.convertToSerializableMetadata(parsedGGUF.metadata),
          };
        } catch (localError) {
          // Both remote and local fetch failed
          const remoteMsg = remoteError instanceof Error ? remoteError.message : String(remoteError);
          const localMsg = localError instanceof Error ? localError.message : String(localError);
          throw new DownloadError(
            `Failed to fetch GGUF metadata from both remote and local sources`,
            {
              modelId: id,
              remoteError: remoteMsg,
              localError: localMsg,
            }
          );
        }
      }
    } else {
      // No source URL, try local file only
      const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);

      ggufMetadata = {
        version: parsedGGUF.metadata['version'] as number | undefined,
        tensor_count: this.convertBigIntToNumber(parsedGGUF.metadata['tensor_count']),
        kv_count: this.convertBigIntToNumber(parsedGGUF.metadata['kv_count']),
        architecture: parsedGGUF.metadata['general.architecture'] as string | undefined,
        general_name: parsedGGUF.metadata['general.name'] as string | undefined,
        file_type: parsedGGUF.metadata['general.file_type'] as number | undefined,
        block_count: getArchField(parsedGGUF.metadata, 'block_count') as number | undefined,
        context_length: getArchField(parsedGGUF.metadata, 'context_length') as number | undefined,
        attention_head_count: getArchField(parsedGGUF.metadata, 'attention.head_count') as number | undefined,
        embedding_length: getArchField(parsedGGUF.metadata, 'embedding_length') as number | undefined,
        feed_forward_length: getArchField(parsedGGUF.metadata, 'feed_forward_length') as number | undefined,
        attention_layer_norm_rms_epsilon: getArchField(
          parsedGGUF.metadata,
          'attention.layer_norm_rms_epsilon'
        ) as number | undefined,
        vocab_size: getArchField(parsedGGUF.metadata, 'vocab_size') as number | undefined,
        rope_dimension_count: getArchField(parsedGGUF.metadata, 'rope.dimension_count') as number | undefined,
        rope_freq_base: getArchField(parsedGGUF.metadata, 'rope.freq_base') as number | undefined,
        raw: this.convertToSerializableMetadata(parsedGGUF.metadata),
      };
    }

    // Update model info with new metadata
    const updatedModelInfo: ModelInfo = {
      ...modelInfo,
      ggufMetadata,
    };

    // Save updated metadata
    await storageManager.saveModelMetadata(updatedModelInfo);

    return updatedModelInfo;
  }

  /**
   * Get layer count for a model
   *
   * Uses GGUF metadata if available, falls back to estimation.
   *
   * @param id - Model ID
   * @returns Layer count (actual or estimated)
   * @throws {ModelNotFoundError} If model doesn't exist
   *
   * @example
   * ```typescript
   * const layers = await modelManager.getModelLayerCount('llama-2-7b');
   * console.log(`Model has ${layers} layers`);
   * ```
   */
  public async getModelLayerCount(id: string): Promise<number> {
    const modelInfo = await this.getModelInfo(id);
    return getLayerCountWithFallback(modelInfo);
  }

  /**
   * Get context length for a model
   *
   * Uses GGUF metadata if available, falls back to default.
   *
   * @param id - Model ID
   * @returns Context length (actual or default)
   * @throws {ModelNotFoundError} If model doesn't exist
   *
   * @example
   * ```typescript
   * const contextLen = await modelManager.getModelContextLength('llama-2-7b');
   * console.log(`Context window: ${contextLen} tokens`);
   * ```
   */
  public async getModelContextLength(id: string): Promise<number> {
    const modelInfo = await this.getModelInfo(id);
    return getContextLengthWithFallback(modelInfo);
  }

  /**
   * Get architecture type for a model
   *
   * Uses GGUF metadata if available, falls back to default.
   *
   * @param id - Model ID
   * @returns Architecture type (e.g., 'llama', 'mamba', 'gpt2')
   * @throws {ModelNotFoundError} If model doesn't exist
   *
   * @example
   * ```typescript
   * const arch = await modelManager.getModelArchitecture('llama-2-7b');
   * console.log(`Architecture: ${arch}`);
   * ```
   */
  public async getModelArchitecture(id: string): Promise<string> {
    const modelInfo = await this.getModelInfo(id);
    return getArchitectureWithFallback(modelInfo);
  }
}

// Export singleton instance
export const modelManager = ModelManager.getInstance();
