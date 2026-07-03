/**
 * Model management types for downloads, storage, and metadata
 * @module types/models
 */

/**
 * Type of AI model
 */
export type ModelType = 'llm' | 'diffusion';

/**
 * Component roles in a multi-file diffusion model.
 * Each role maps to a specific sd.cpp CLI flag.
 */
export type DiffusionComponentRole =
  | 'diffusion_model' // --diffusion-model (main UNet/DiT)
  | 'clip_l' // --clip_l (CLIP-L text encoder)
  | 'clip_g' // --clip_g (CLIP-G text encoder, SDXL)
  | 't5xxl' // --t5xxl (T5-XXL text encoder, SD3/Flux 1)
  | 'llm' // --llm (LLM text encoder, Flux 2/Qwen Image)
  | 'llm_vision' // --llm_vision (LLM vision, Qwen Image)
  | 'vae'; // --vae (VAE decoder)

/** Info about a single component file within a multi-component model. */
export interface DiffusionComponentInfo {
  /** Absolute path to this component file on disk. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** SHA256 checksum with sha256: prefix. */
  checksum?: string;
}

/**
 * Map of component roles to their file info.
 * Present on ModelInfo only for multi-component diffusion models.
 */
export type DiffusionModelComponents = Partial<
  Record<DiffusionComponentRole, DiffusionComponentInfo>
>;

/**
 * Download specification for a single component within a multi-file model.
 * Used inside DownloadConfig.components.
 */
export interface DiffusionComponentDownload {
  /** Which component this file represents. */
  role: DiffusionComponentRole;
  /** Download source type. */
  source: 'huggingface' | 'url';
  /** Direct download URL (required if source is 'url'). */
  url?: string;
  /** HuggingFace repository (required if source is 'huggingface'). */
  repo?: string;
  /** File path within the HuggingFace repo (required if source is 'huggingface'). */
  file?: string;
  /** Expected SHA256 checksum for verification. */
  checksum?: string;
}

/**
 * Strategy for fetching GGUF metadata when updating model metadata
 *
 * @remarks
 * - `local-remote`: Try local first, fallback to remote (default - fast + resilient)
 * - `local-only`: Read from local file only (fastest, offline-capable)
 * - `remote-only`: Fetch from remote URL only (requires network)
 * - `remote-local`: Try remote first, fallback to local if remote fails
 */
export type MetadataFetchStrategy = 'local-only' | 'remote-only' | 'local-remote' | 'remote-local';

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
  tensor_count?: number;

  /** Number of key-value metadata pairs */
  kv_count?: number;

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

  /** Number of KV heads (GQA models have fewer than attention_head_count) */
  attention_head_count_kv?: number;

  /** Per-head key dimension (set when it differs from embedding_length / head_count) */
  attention_key_length?: number;

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
 * A single shard of a multi-shard GGUF model
 * (files split as model-00001-of-0000N.gguf)
 */
export interface ShardInfo {
  /** Absolute path to this shard file */
  path: string;

  /** Shard file size in bytes */
  size: number;

  /** SHA256 checksum (if verified; typically only the first shard) */
  checksum?: string;
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
   * Whether this model is reasoning-capable, detected from GGUF filename
   * patterns (e.g., qwen3, deepseek-r1). Informational metadata for apps;
   * does not change how the server is launched (reasoning extraction is
   * handled by llama-server's --reasoning-format, default 'auto').
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

  /**
   * Component files for multi-component diffusion models.
   * Undefined for single-file models (LLM, monolithic diffusion).
   * When present, `path` points to the diffusion_model component
   * and `size` is the aggregate total.
   */
  components?: DiffusionModelComponents;

  /**
   * Shard files for multi-shard GGUF models (model-00001-of-0000N.gguf).
   * Lists ALL shards in order, including the first; `path` equals the first
   * shard's path (llama-server auto-discovers siblings from there) and
   * `size` is the aggregate total. Undefined for single-file models.
   */
  shards?: ShardInfo[];
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

  /** Expected SHA256 checksum (optional, for verification; sharded models: verifies the first shard) */
  checksum?: string;

  /** Progress callback function */
  onProgress?: DownloadProgressCallback;

  /**
   * Additional sibling shards for multi-shard GGUF models.
   * Usually unnecessary: names matching model-00001-of-0000N.gguf are
   * auto-detected and the siblings derived. Provide explicitly for
   * non-standard shard naming — entries are filenames resolved next to
   * the primary file (same HF repo path / same URL directory), or full
   * http(s) URLs.
   */
  shardFiles?: string[];

  /**
   * Additional component files for multi-component diffusion models.
   * When present, the top-level url/repo/file describes the primary
   * diffusion model, and each entry here describes an additional component.
   */
  components?: DiffusionComponentDownload[];

  /**
   * Subdirectory name for multi-component model storage.
   * When provided, used instead of the model ID for the directory name.
   * Allows multiple model variants to share the same directory on disk
   * (e.g., different quant levels sharing encoder/VAE files).
   */
  modelDirectory?: string;

  /**
   * Called when each component download begins (multi-component only).
   * Useful for displaying which component is currently being downloaded.
   */
  onComponentStart?: (info: {
    role: string;
    filename: string;
    index: number;
    total: number;
  }) => void;
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
