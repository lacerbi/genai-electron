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

  /** Random seed for reproducibility (-1 = random) */
  seed?: number;

  /** Sampler algorithm (default: 'euler_a') */
  sampler?: ImageSampler;

  /** Progress callback (currentStep, totalSteps) */
  onProgress?: (currentStep: number, totalSteps: number) => void;
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

  /** VRAM budget in MB (optional, stable-diffusion.cpp will try to fit within this) */
  vramBudget?: number;

  /**
   * Force binary validation even if cached validation exists
   * Default: false (use cached validation if available)
   * Set to true to re-run Phase 1 & Phase 2 tests (e.g., after driver updates)
   */
  forceValidation?: boolean;
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
