/**
 * Image generation types
 * @module types/images
 */

import type { ServerStatus, HealthStatus } from './servers.js';

/**
 * Available sampler algorithms for image generation
 */
export type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm';

/**
 * Image generation progress stage
 */
export type ImageGenerationStage = 'loading' | 'diffusion' | 'decoding';

/**
 * Image generation progress information
 */
export interface ImageGenerationProgress {
  /** Current step within the stage */
  currentStep: number;

  /** Total steps in the stage */
  totalSteps: number;

  /** Current stage of generation */
  stage: ImageGenerationStage;

  /** Overall progress percentage (0-100) */
  percentage?: number;

  /** Current image being generated (1-indexed, for batch generation) */
  currentImage?: number;

  /** Total images in batch (for batch generation) */
  totalImages?: number;
}

/**
 * Image generation request configuration
 */
export interface ImageGenerationConfig {
  /** Text prompt describing the image */
  prompt: string;

  /** Negative prompt (what to avoid) */
  negativePrompt?: string;

  /** Image width in pixels (default: 512) */
  width?: number;

  /** Image height in pixels (default: 512) */
  height?: number;

  /** Number of inference steps (default: 20, more = better quality but slower) */
  steps?: number;

  /** Guidance scale (default: 7.5, higher = closer to prompt) */
  cfgScale?: number;

  /** Random seed for reproducibility (undefined or negative = random, actual seed returned in result) */
  seed?: number;

  /** Sampler algorithm (default: 'euler_a') */
  sampler?: ImageSampler;

  /** Number of images to generate (default: 1, recommended max: 5) */
  count?: number;

  /** Progress callback with stage information */
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: ImageGenerationStage,
    percentage?: number
  ) => void;
}

/**
 * Image generation result
 */
export interface ImageGenerationResult {
  /** Generated image data (Buffer) */
  image: Buffer;

  /** Image format (always 'png' for stable-diffusion.cpp) */
  format: 'png';

  /** Time taken in milliseconds */
  timeTaken: number;

  /** Seed used (for reproducibility) */
  seed: number;

  /** Image dimensions */
  width: number;
  height: number;
}

/**
 * Diffusion server configuration
 */
export interface DiffusionServerConfig {
  /** Model ID to load */
  modelId: string;

  /** Port to listen on (default: 8081) */
  port?: number;

  /** Number of CPU threads (auto-detected if not specified) */
  threads?: number;

  /** Number of GPU layers to offload (auto-detected if not specified, 0 = CPU-only) */
  gpuLayers?: number;

  /**
   * Force binary validation even if cached validation exists
   * Default: false (use cached validation if available)
   * Set to true to re-run Phase 1 & Phase 2 tests (e.g., after driver updates)
   */
  forceValidation?: boolean;

  /**
   * Offload CLIP text encoder to CPU to reduce VRAM usage (~1-2 GB savings).
   *
   * Auto-detected if not specified: enabled when GPU VRAM headroom < 6 GB after
   * accounting for the model footprint. Disabled for CUDA backend (crashes sd.cpp
   * CUDA builds silently). Set explicitly to override auto-detection.
   *
   * Maps to `--clip-on-cpu` flag in stable-diffusion.cpp.
   */
  clipOnCpu?: boolean;

  /**
   * Offload VAE decoder to CPU to reduce VRAM usage.
   *
   * Auto-detected if not specified: enabled when GPU VRAM headroom < 2 GB after
   * accounting for the model footprint. Only use when severely VRAM-constrained
   * as CPU VAE decoding is significantly slower. Disabled for CUDA backend
   * (crashes sd.cpp CUDA builds silently).
   *
   * Maps to `--vae-on-cpu` flag in stable-diffusion.cpp.
   */
  vaeOnCpu?: boolean;

  /**
   * Batch size for image generation. Lower values reduce VRAM usage.
   *
   * Not auto-detected — passthrough only. If specified, maps to `-b` flag
   * in stable-diffusion.cpp.
   */
  batchSize?: number;

  /**
   * Offload model weights to CPU RAM, load to VRAM on demand (--offload-to-cpu).
   *
   * undefined = auto-detect (enabled when modelInfo.size > availableVRAM * 0.85,
   *   but disabled for CUDA backend — crashes sd.cpp CUDA builds silently),
   * true = force on, false = force off.
   */
  offloadToCpu?: boolean;

  /**
   * Enable flash attention in the diffusion model (--diffusion-fa).
   *
   * undefined = auto-detect (enabled when model has an 'llm' component, indicating Flux 2),
   * true = force on, false = force off.
   */
  diffusionFlashAttention?: boolean;
}

/**
 * Diffusion server status information
 */
export interface DiffusionServerInfo {
  /** Current server status */
  status: ServerStatus;

  /** Health check status */
  health: HealthStatus;

  /** Process ID (if running) - for HTTP wrapper, this is the wrapper's PID */
  pid?: number;

  /** Port server is listening on */
  port: number;

  /** Model ID being served */
  modelId: string;

  /** When server was started (ISO timestamp, if running) */
  startedAt?: string;

  /** Last error message (if crashed) */
  error?: string;

  /** Whether currently generating an image */
  busy?: boolean;
}

/**
 * Generation status for async API
 */
export type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error';

/**
 * Generation state for async API registry
 */
export interface GenerationState {
  /** Unique generation ID */
  id: string;

  /** Current status */
  status: GenerationStatus;

  /** Timestamp when generation was created */
  createdAt: number;

  /** Timestamp when generation was last updated */
  updatedAt: number;

  /** Original request configuration */
  config: ImageGenerationConfig;

  /** Progress information (when status is 'in_progress') */
  progress?: ImageGenerationProgress;

  /** Final result (when status is 'complete') */
  result?: {
    /** Array of generated images */
    images: {
      /** Base64-encoded PNG image data */
      image: string;
      /** Seed used for generation */
      seed: number;
      /** Image width */
      width: number;
      /** Image height */
      height: number;
    }[];
    /** Image format (always 'png') */
    format: 'png';
    /** Total time taken in milliseconds */
    timeTaken: number;
  };

  /** Error details (when status is 'error') */
  error?: {
    /** Error message */
    message: string;
    /** Error code */
    code: string;
  };
}
