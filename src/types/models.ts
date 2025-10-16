/**
 * Model management types for downloads, storage, and metadata
 * @module types/models
 */

/**
 * Type of AI model
 */
export type ModelType = 'llm' | 'diffusion';

/**
 * Model source information
 */
export interface ModelSource {
  /** Source type */
  type: 'huggingface' | 'url';

  /** Direct download URL */
  url: string;

  /** HuggingFace repository (e.g., "TheBloke/Llama-2-7B-GGUF") */
  repo?: string;

  /** HuggingFace file name (e.g., "llama-2-7b.Q4_K_M.gguf") */
  file?: string;
}

/**
 * Model metadata and information
 */
export interface ModelInfo {
  /** Unique model identifier */
  id: string;

  /** Human-readable model name */
  name: string;

  /** Model type (llm or diffusion) */
  type: ModelType;

  /** File size in bytes */
  size: number;

  /** Absolute path to model file */
  path: string;

  /** When the model was downloaded (ISO timestamp) */
  downloadedAt: string;

  /** Source information */
  source: ModelSource;

  /** SHA256 checksum (if available) */
  checksum?: string;
}

/**
 * Progress callback for download operations
 */
export type DownloadProgressCallback = (downloaded: number, total: number) => void;

/**
 * Download configuration
 */
export interface DownloadConfig {
  /** Download source type */
  source: 'huggingface' | 'url';

  /** Direct download URL (required if source is 'url') */
  url?: string;

  /** HuggingFace repository (required if source is 'huggingface') */
  repo?: string;

  /** HuggingFace file name (required if source is 'huggingface') */
  file?: string;

  /** Human-readable model name */
  name: string;

  /** Model type */
  type: ModelType;

  /** Expected SHA256 checksum (optional, for verification) */
  checksum?: string;

  /** Progress callback function */
  onProgress?: DownloadProgressCallback;
}

/**
 * Download progress information
 */
export interface DownloadProgress {
  /** Bytes downloaded so far */
  downloaded: number;

  /** Total bytes to download */
  total: number;

  /** Progress percentage (0-100) */
  percentage: number;

  /** Download speed in bytes per second */
  speed: number;

  /** Estimated time remaining in milliseconds */
  estimatedTimeRemaining?: number;
}
