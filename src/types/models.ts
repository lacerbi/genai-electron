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
 * GGUF metadata extracted from model file
 *
 * Contains architecture-specific metadata from GGUF format.
 * All fields are optional as they depend on the model architecture.
 */
export interface GGUFMetadata {
  /** GGUF version */
  version?: number;

  /** Number of tensors in the model */
  tensor_count?: bigint;

  /** Number of key-value metadata pairs */
  kv_count?: bigint;

  /** Model architecture (e.g., "llama", "mamba", "gpt2") */
  architecture?: string;

  /** General model name from GGUF */
  general_name?: string;

  /** File type / quantization type */
  file_type?: number;

  /** Number of layers/blocks in the model */
  block_count?: number;

  /** Context length (maximum sequence length) */
  context_length?: number;

  /** Number of attention heads */
  attention_head_count?: number;

  /** Embedding dimension length */
  embedding_length?: number;

  /** Feed-forward length */
  feed_forward_length?: number;

  /** RMS normalization epsilon */
  attention_layer_norm_rms_epsilon?: number;

  /** Vocabulary size */
  vocab_size?: number;

  /** Rope dimension count */
  rope_dimension_count?: number;

  /** Rope frequency base */
  rope_freq_base?: number;

  /**
   * Complete raw metadata from GGUF file
   *
   * Contains all metadata key-value pairs including architecture-specific fields,
   * tokenizer data, and tensor information. Stored as JSON-serializable object.
   */
  raw?: Record<string, unknown>;
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

  /**
   * Whether this model supports reasoning/thinking capabilities
   *
   * When true, llama-server will be started with --jinja --reasoning-format deepseek
   * to extract reasoning content from <think>...</think> tags.
   *
   * Automatically detected based on GGUF filename patterns (e.g., qwen3, deepseek-r1).
   */
  supportsReasoning?: boolean;

  /**
   * GGUF metadata extracted from the model file
   *
   * Contains accurate model information including:
   * - Layer count (block_count)
   * - Context length
   * - Architecture type
   * - Attention heads
   * - And more...
   *
   * Available for models downloaded after GGUF integration.
   * May be undefined for models downloaded before this feature.
   */
  ggufMetadata?: GGUFMetadata;
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
