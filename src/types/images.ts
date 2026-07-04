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
  | 'lcm'
  | 'er_sde'
  | 'euler_cfg_pp'
  | 'euler_a_cfg_pp';

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

  /** Port to listen on (default: 8081; 'auto' picks a free OS-assigned port) */
  port?: number | 'auto';

  /** Number of CPU threads (auto-detected if not specified) */
  threads?: number;

  /**
   * Accepted for config-shape compatibility but NOT passed to sd.cpp —
   * stable-diffusion.cpp has no GPU-layers flag; GPU offload is automatic
   * (use clipOnCpu/vaeOnCpu/offloadToCpu to manage VRAM instead)
   */
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
   * accounting for the model footprint. Set explicitly to override auto-detection.
   *
   * Maps to `--clip-on-cpu` flag in stable-diffusion.cpp.
   */
  clipOnCpu?: boolean;

  /**
   * Offload VAE decoder to CPU to reduce VRAM usage.
   *
   * Auto-detected if not specified: enabled when GPU VRAM headroom < 2 GB after
   * accounting for the model footprint. Only use when severely VRAM-constrained
   * as CPU VAE decoding is significantly slower.
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
   * undefined = auto-detect (enabled when modelInfo.size > availableVRAM * 0.85),
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
 *
 * Note: 'cancelled' is terminal. genai-lite clients older than the version
 * that recognizes it poll until their own client-side timeout when a
 * generation is cancelled from another code path.
 */
export type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error' | 'cancelled';

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

/**
 * One offload combination to benchmark during offload calibration.
 *
 * Omitted flags are auto-detected, exactly as when they are omitted in
 * DiffusionServerConfig.
 */
export interface DiffusionOffloadCombo {
  /** Human-readable label for progress UIs and reports (ignored by flag resolution) */
  label?: string;

  /** Force CLIP/text-encoder placement (--clip-on-cpu). Omitted = auto-detect */
  clipOnCpu?: boolean;

  /** Force VAE decoder placement (--vae-on-cpu). Omitted = auto-detect */
  vaeOnCpu?: boolean;

  /** Force managed weight streaming (--offload-to-cpu). Omitted = auto-detect */
  offloadToCpu?: boolean;

  /** Force diffusion flash attention (--diffusion-fa). Omitted = auto-detect */
  diffusionFlashAttention?: boolean;
}

/**
 * Image dimensions to benchmark during offload calibration
 */
export interface CalibrationSize {
  /** Image width in pixels (must be a positive multiple of 64) */
  width: number;

  /** Image height in pixels (must be a positive multiple of 64) */
  height: number;
}

/**
 * Configuration for DiffusionServerManager.calibrate()
 */
export interface DiffusionCalibrationConfig {
  /** Diffusion model ID to calibrate */
  modelId: string;

  /** Sizes to benchmark (default: [{ width: 768, height: 768 }]). Pass your app's real sizes */
  sizes?: CalibrationSize[];

  /** Offload combos to benchmark (default: curated set in DIFFUSION_CALIBRATION_DEFAULTS) */
  combos?: DiffusionOffloadCombo[];

  /**
   * Inference steps per generation (default: 4).
   * Offload cost scales with steps — prefer your app's real step count.
   */
  steps?: number;

  /** Guidance scale (default: omitted, uses the sd.cpp default) */
  cfgScale?: number;

  /** Sampler algorithm (default: 'euler') */
  sampler?: ImageSampler;

  /** Fixed seed so every combo does identical work (default: 42) */
  seed?: number;

  /** Benchmark prompt (default: neutral built-in prompt) */
  prompt?: string;

  /** Timed samples per (combo, size), after 1 discarded warmup per combo (default: 2) */
  samples?: number;

  /** CPU threads passthrough — match your production config (default: omitted) */
  threads?: number;

  /** Batch size passthrough — match your production config (default: omitted) */
  batchSize?: number;

  /** Progress callback (the same payload is also emitted as 'calibration-progress' events) */
  onProgress?: (progress: DiffusionCalibrationProgress) => void;

  /**
   * Abort the sweep. calibrate() then rejects with a ServerError whose
   * details.code === 'CALIBRATION_ABORTED' and details.runs = partial runs.
   */
  signal?: AbortSignal;
}

/**
 * Progress payload for an offload-calibration sweep
 * (delivered via onProgress and the 'calibration-progress' event)
 */
export interface DiffusionCalibrationProgress {
  /** Sweep phase */
  phase: 'preparing' | 'warmup' | 'sampling' | 'restoring-llm' | 'done';

  /** 0-based index into the active (post-skip) combo list */
  comboIndex: number;

  /** Number of active combos (skipped combos excluded) */
  comboCount: number;

  /** Current combo (UI text via combo.label; the default combos are labeled) */
  combo?: DiffusionOffloadCombo;

  /** 0-based index of the current size */
  sizeIndex: number;

  /** Number of sizes */
  sizeCount: number;

  /** Current size */
  size?: CalibrationSize;

  /** 1-based timed-sample number (timed samples only) */
  sample?: number;

  /** Timed samples per (combo, size) */
  sampleCount?: number;

  /** Progress within the current generation (0-100), when reported by sd.cpp */
  generationPercent?: number;

  /** Smooth overall sweep progress (0-100) */
  overallPercent: number;
}

/**
 * Result of benchmarking one (combo, size) pair
 */
export interface CalibrationRun {
  /** Image size benchmarked */
  size: CalibrationSize;

  /** Combo as requested (omitted flags = auto-detect) */
  combo: DiffusionOffloadCombo;

  /** What auto-detection resolved omitted flags to for this run */
  resolved?: {
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
  };

  /** Outcome: ok, out-of-memory, or other failure */
  status: 'ok' | 'oom' | 'error';

  /** Median of samplesMs (mean of the middle two for even counts); only when status === 'ok' */
  timeTakenMs?: number;

  /**
   * Per-stage wall-clock split of the sample closest to the median
   * (fields omitted when stage markers were missed)
   */
  stageMs?: { loadMs?: number; diffusionMs?: number; decodeMs?: number };

  /** Raw totals of successful samples (kept even on failed runs, for diagnostics) */
  samplesMs?: number[];

  /** Failure message when status !== 'ok' */
  error?: string;
}

/**
 * Report returned by DiffusionServerManager.calibrate()
 */
export interface DiffusionCalibrationReport {
  /** Machine fingerprint (from SystemInfo.getGPUInfo()) */
  machine: {
    gpuType?: string;
    gpuName?: string;
    vramBytes?: number;
    vramAvailableBytes?: number;
  };

  /** Model that was calibrated */
  modelId: string;

  /** Inference steps used per generation (methodology echo for persistence keying) */
  steps: number;

  /** Sampler used (methodology echo) */
  sampler: ImageSampler;

  /** Timed samples per (combo, size) (methodology echo) */
  samples: number;

  /** All benchmark runs (one per active combo × size) */
  runs: CalibrationRun[];

  /**
   * Fastest OK combo per size, keyed "<width>x<height>" (e.g. "768x768").
   * Values are combos AS REQUESTED (the winner may be the empty auto combo);
   * what auto-detection resolved to is in the winning run's `resolved`.
   * A size where every combo failed is absent.
   */
  recommended: Record<string, DiffusionOffloadCombo>;

  /** Combos excluded up-front (e.g. clipOnCpu combos for SD3.5-Large) */
  skippedCombos?: { combo: DiffusionOffloadCombo; reason: string }[];
}
