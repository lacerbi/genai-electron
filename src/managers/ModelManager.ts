/**
 * Model management for downloads, storage, and metadata
 * @module managers/ModelManager
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  ModelInfo,
  ModelType,
  DownloadConfig,
  GGUFMetadata,
  MetadataFetchStrategy,
  DiffusionModelComponents,
  DiffusionComponentInfo,
  DiffusionComponentRole,
} from '../types/index.js';
import { ModelNotFoundError, DownloadError } from '../errors/index.js';
import { storageManager } from './StorageManager.js';
import { Downloader } from '../download/Downloader.js';
import { getHuggingFaceURL } from '../download/huggingface.js';
import { calculateSHA256, formatChecksum } from '../download/checksum.js';
import { fileExists, getFileSize, sanitizeFilename, deleteFile } from '../utils/file-utils.js';
import { detectReasoningSupport } from '../config/reasoning-models.js';
import { fetchGGUFMetadata, fetchLocalGGUFMetadata, getArchField } from '../utils/gguf-parser.js';
import { getModelDirectory } from '../config/paths.js';
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

    // If multi-component, delegate to specialized method
    if (config.components && config.components.length > 0) {
      return this.downloadMultiComponentModel(config);
    }

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
      ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
    } catch (error) {
      // Per user requirement: fail download if metadata fetch fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new DownloadError(`Failed to fetch GGUF metadata before download: ${errorMessage}`, {
        url: downloadURL,
        originalError: error,
        suggestion:
          'Verify the URL points to a valid GGUF file. Check network connectivity if the error persists.',
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
      ggufMetadata, // Include GGUF metadata
    };

    // Save metadata
    await storageManager.saveModelMetadata(modelInfo);

    return modelInfo;
  }

  /**
   * Download a multi-component diffusion model.
   *
   * Downloads the primary diffusion model and all additional components
   * into a per-model subdirectory. Reports aggregate progress across all files.
   *
   * @private
   */
  private async downloadMultiComponentModel(config: DownloadConfig): Promise<ModelInfo> {
    const components = config.components!;

    // Validate: reject if any component declares role 'diffusion_model'
    // (the top-level config IS the diffusion_model)
    const duplicatePrimary = components.find((c) => c.role === 'diffusion_model');
    if (duplicatePrimary) {
      throw new DownloadError(
        'Component with role "diffusion_model" is not allowed — the top-level config describes the primary diffusion model'
      );
    }

    // Resolve primary download URL
    const primaryURL = this.resolveComponentURL(config);
    const primaryFile = config.file ?? this.extractFilename(primaryURL);

    // Generate model ID and create subdirectory
    const modelId = this.generateModelId(config.name);
    const modelDir = getModelDirectory(config.type, modelId);
    await mkdir(modelDir, { recursive: true });

    // Build download plan: primary + all components
    interface DownloadItem {
      role: string;
      url: string;
      filename: string;
      destination: string;
      checksum?: string;
    }

    const downloadItems: DownloadItem[] = [
      {
        role: 'diffusion_model',
        url: primaryURL,
        filename: primaryFile,
        destination: path.join(modelDir, sanitizeFilename(primaryFile)),
        checksum: config.checksum,
      },
    ];

    for (const comp of components) {
      const compURL = this.resolveComponentURL(comp);
      const compFile = comp.file ?? this.extractFilename(compURL);
      downloadItems.push({
        role: comp.role,
        url: compURL,
        filename: compFile,
        destination: path.join(modelDir, sanitizeFilename(compFile)),
        checksum: comp.checksum,
      });
    }

    // Pre-fetch total size via HEAD requests for aggregate progress
    let totalBytes = 0;
    const itemSizes: number[] = [];
    await Promise.all(
      downloadItems.map(async (item, index) => {
        try {
          const response = await fetch(item.url, { method: 'HEAD' });
          const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
          itemSizes[index] = contentLength;
        } catch {
          itemSizes[index] = 0; // Unknown size, will adjust when GET arrives
        }
      })
    );
    totalBytes = itemSizes.reduce((sum, s) => sum + s, 0);

    // Fetch GGUF metadata for the primary model (only if it's a .gguf file)
    let ggufMetadata: GGUFMetadata | undefined;
    if (this.isGGUFFile(primaryFile)) {
      try {
        const parsedGGUF = await fetchGGUFMetadata(primaryURL);
        ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
      } catch {
        // Non-fatal for multi-component: metadata is optional
      }
    }

    // Download components sequentially with aggregate progress
    const downloadedPaths: string[] = [];
    let completedBytes = 0;

    try {
      for (let i = 0; i < downloadItems.length; i++) {
        const item = downloadItems[i]!;

        // Notify caller which component is being downloaded
        config.onComponentStart?.({
          role: item.role,
          filename: item.filename,
          index: i + 1,
          total: downloadItems.length,
        });

        // Check if file already exists
        const exists = await fileExists(item.destination);
        if (exists) {
          throw new DownloadError(`Component file already exists: ${item.filename}`, {
            path: item.destination,
            component: item.role,
          });
        }

        // Create wrapped progress callback for aggregate reporting
        // Clamp to prevent >100% when HEAD requests failed to get accurate sizes
        const wrappedProgress = config.onProgress
          ? (downloaded: number, _total: number) => {
              const aggregateDownloaded = completedBytes + downloaded;
              const clampedTotal = Math.max(totalBytes, aggregateDownloaded);
              config.onProgress!(aggregateDownloaded, clampedTotal);
            }
          : undefined;

        await this.downloader.download({
          url: item.url,
          destination: item.destination,
          onProgress: wrappedProgress,
        });

        downloadedPaths.push(item.destination);

        // Verify checksum if provided
        if (item.checksum) {
          const calculatedChecksum = await calculateSHA256(item.destination);
          const expectedChecksum = item.checksum.replace(/^sha256:/, '');

          if (calculatedChecksum !== expectedChecksum) {
            throw new DownloadError(`Checksum verification failed for component: ${item.role}`, {
              expected: expectedChecksum,
              actual: calculatedChecksum,
              component: item.role,
            });
          }
        }

        // Update completed bytes for next component's progress offset
        const actualSize = await getFileSize(item.destination);
        completedBytes += actualSize;
      }
    } catch (error) {
      // Clean up all downloaded files on failure
      for (const filePath of downloadedPaths) {
        try {
          await deleteFile(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
      // Try to remove the model directory
      try {
        const { rm } = await import('node:fs/promises');
        await rm(modelDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      if (error instanceof DownloadError) {
        throw error;
      }
      throw new DownloadError('Multi-component download failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Build components map and calculate aggregate size
    const componentsMap: DiffusionModelComponents = {};
    let aggregateSize = 0;

    for (const item of downloadItems) {
      const fileSize = await getFileSize(item.destination);
      aggregateSize += fileSize;

      const compInfo: DiffusionComponentInfo = {
        path: item.destination,
        size: fileSize,
      };

      if (item.checksum) {
        compInfo.checksum = formatChecksum(item.checksum.replace(/^sha256:/, ''));
      }

      componentsMap[item.role as DiffusionComponentRole] = compInfo;
    }

    // Create model info — primary is always the first item (diffusion_model)
    const primaryItem = downloadItems[0]!;
    const modelInfo: ModelInfo = {
      id: modelId,
      name: config.name,
      type: config.type,
      size: aggregateSize,
      path: primaryItem.destination,
      downloadedAt: new Date().toISOString(),
      source: {
        type: config.source,
        url: primaryURL,
        repo: config.repo,
        file: config.file,
      },
      ggufMetadata,
      components: componentsMap,
    };

    // Save metadata
    await storageManager.saveModelMetadata(modelInfo);

    return modelInfo;
  }

  /**
   * Resolve a component download specification to a URL.
   */
  private resolveComponentURL(spec: {
    source: 'huggingface' | 'url';
    url?: string;
    repo?: string;
    file?: string;
  }): string {
    if (spec.source === 'url') {
      if (!spec.url) {
        throw new DownloadError('URL is required when source is "url"');
      }
      return spec.url;
    }
    if (spec.source === 'huggingface') {
      if (!spec.repo || !spec.file) {
        throw new DownloadError('Repository and file are required when source is "huggingface"');
      }
      return getHuggingFaceURL(spec.repo, spec.file);
    }
    throw new DownloadError(`Unsupported source type: ${spec.source}`);
  }

  /**
   * Check if a filename has a GGUF extension.
   */
  private isGGUFFile(filename: string): boolean {
    return filename.toLowerCase().endsWith('.gguf');
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
  private convertToSerializableMetadata(
    metadata: Record<string, unknown>
  ): Record<string, unknown> {
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
   * Helper method to create GGUFMetadata from parsed GGUF data
   * Reduces code duplication across download and metadata update operations
   *
   * @private
   */
  private createGGUFMetadataFromParsed(parsedGGUF: {
    metadata: Record<string, unknown>;
  }): GGUFMetadata {
    return {
      version: parsedGGUF.metadata['version'] as number | undefined,
      tensor_count: this.convertBigIntToNumber(parsedGGUF.metadata['tensor_count']),
      kv_count: this.convertBigIntToNumber(parsedGGUF.metadata['kv_count']),
      architecture: parsedGGUF.metadata['general.architecture'] as string | undefined,
      general_name: parsedGGUF.metadata['general.name'] as string | undefined,
      file_type: parsedGGUF.metadata['general.file_type'] as number | undefined,
      block_count: getArchField(parsedGGUF.metadata, 'block_count') as number | undefined,
      context_length: getArchField(parsedGGUF.metadata, 'context_length') as number | undefined,
      attention_head_count: getArchField(parsedGGUF.metadata, 'attention.head_count') as
        | number
        | undefined,
      embedding_length: getArchField(parsedGGUF.metadata, 'embedding_length') as number | undefined,
      feed_forward_length: getArchField(parsedGGUF.metadata, 'feed_forward_length') as
        | number
        | undefined,
      attention_layer_norm_rms_epsilon: getArchField(
        parsedGGUF.metadata,
        'attention.layer_norm_rms_epsilon'
      ) as number | undefined,
      vocab_size: getArchField(parsedGGUF.metadata, 'vocab_size') as number | undefined,
      rope_dimension_count: getArchField(parsedGGUF.metadata, 'rope.dimension_count') as
        | number
        | undefined,
      rope_freq_base: getArchField(parsedGGUF.metadata, 'rope.freq_base') as number | undefined,
      raw: this.convertToSerializableMetadata(parsedGGUF.metadata),
    };
  }

  /**
   * Update GGUF metadata for an existing model
   *
   * Fetches and stores GGUF metadata for models that were downloaded
   * before GGUF integration. Does not re-download the model file.
   *
   * @param id - Model ID
   * @param options - Optional configuration for metadata fetch
   * @param options.source - Strategy for fetching metadata (default: 'local-remote')
   * @returns Updated model information
   * @throws {ModelNotFoundError} If model doesn't exist
   * @throws {DownloadError} If metadata fetch fails
   *
   * @example
   * ```typescript
   * // Default: Try local first, fallback to remote (fast + resilient)
   * const updatedModel = await modelManager.updateModelMetadata('llama-2-7b');
   * console.log('Layer count:', updatedModel.ggufMetadata?.block_count);
   *
   * // Force local only (fastest, but may fail on corruption)
   * const localOnly = await modelManager.updateModelMetadata('llama-2-7b', { source: 'local-only' });
   *
   * // Force fetch from remote source
   * const freshMetadata = await modelManager.updateModelMetadata('llama-2-7b', { source: 'remote-only' });
   *
   * // Try remote first, fallback to local
   * const authoritative = await modelManager.updateModelMetadata('llama-2-7b', { source: 'remote-local' });
   * ```
   */
  public async updateModelMetadata(
    id: string,
    options?: { source?: MetadataFetchStrategy }
  ): Promise<ModelInfo> {
    // Get existing model info
    const modelInfo = await this.getModelInfo(id);

    // Determine fetch strategy (default: local-remote for speed + resilience)
    const strategy = options?.source ?? 'local-remote';

    let ggufMetadata: GGUFMetadata | undefined;

    // Implement each strategy
    switch (strategy) {
      case 'local-only': {
        // Read from local file only
        try {
          const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);
          ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          throw new DownloadError(`Failed to read GGUF metadata from local file: ${errorMsg}`, {
            modelId: id,
            path: modelInfo.path,
            suggestion:
              'The file may be corrupted. Try re-downloading the model or use source: "remote-only" to fetch from the original URL.',
          });
        }
        break;
      }

      case 'remote-only': {
        // Fetch from remote URL only
        if (!modelInfo.source.url) {
          throw new DownloadError(
            'Cannot fetch remote metadata: No source URL available for this model',
            {
              modelId: id,
              suggestion:
                'This model does not have a source URL. Use source: "local-only" instead.',
            }
          );
        }

        try {
          const parsedGGUF = await fetchGGUFMetadata(modelInfo.source.url);
          ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          throw new DownloadError(`Failed to fetch GGUF metadata from remote URL: ${errorMsg}`, {
            modelId: id,
            url: modelInfo.source.url,
            suggestion:
              'Check network connectivity. If the URL is no longer valid, use source: "local-only" to read from the downloaded file.',
          });
        }
        break;
      }

      case 'local-remote': {
        // Try local first, fallback to remote
        try {
          const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);
          ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
        } catch (localError) {
          // Local failed, try remote
          if (!modelInfo.source.url) {
            const localMsg = localError instanceof Error ? localError.message : String(localError);
            throw new DownloadError(
              `Failed to read GGUF metadata from local file and no remote URL available: ${localMsg}`,
              {
                modelId: id,
                path: modelInfo.path,
              }
            );
          }

          try {
            const parsedGGUF = await fetchGGUFMetadata(modelInfo.source.url);
            ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
          } catch (remoteError) {
            // Both failed
            const localMsg = localError instanceof Error ? localError.message : String(localError);
            const remoteMsg =
              remoteError instanceof Error ? remoteError.message : String(remoteError);
            throw new DownloadError(
              'Failed to fetch GGUF metadata from both local and remote sources',
              {
                modelId: id,
                localError: localMsg,
                remoteError: remoteMsg,
              }
            );
          }
        }
        break;
      }

      case 'remote-local': {
        // Try remote first, fallback to local
        if (modelInfo.source.url) {
          try {
            const parsedGGUF = await fetchGGUFMetadata(modelInfo.source.url);
            ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
          } catch (remoteError) {
            // Remote failed, try local
            try {
              const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);
              ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
            } catch (localError) {
              // Both failed
              const remoteMsg =
                remoteError instanceof Error ? remoteError.message : String(remoteError);
              const localMsg =
                localError instanceof Error ? localError.message : String(localError);
              throw new DownloadError(
                'Failed to fetch GGUF metadata from both remote and local sources',
                {
                  modelId: id,
                  remoteError: remoteMsg,
                  localError: localMsg,
                }
              );
            }
          }
        } else {
          // No remote URL, fall back to local only
          try {
            const parsedGGUF = await fetchLocalGGUFMetadata(modelInfo.path);
            ggufMetadata = this.createGGUFMetadataFromParsed(parsedGGUF);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new DownloadError(`No remote URL available and local fetch failed: ${errorMsg}`, {
              modelId: id,
              path: modelInfo.path,
            });
          }
        }
        break;
      }

      default: {
        // TypeScript should prevent this, but handle it for safety
        throw new DownloadError(`Invalid metadata fetch strategy: ${strategy}`);
      }
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
