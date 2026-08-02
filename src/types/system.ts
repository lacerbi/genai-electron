/**
 * System capability types for hardware detection and recommendations
 * @module types/system
 */

/**
 * GPU information and capabilities
 */
export interface GPUInfo {
  /** Whether a GPU is available */
  available: boolean;

  /** GPU vendor/type */
  type?: 'nvidia' | 'amd' | 'apple' | 'intel';

  /** GPU model name */
  name?: string;

  /** VRAM in bytes (total) */
  vram?: number;

  /** Available VRAM in bytes (free) */
  vramAvailable?: number;

  /** NVIDIA CUDA support */
  cuda?: boolean;

  /** Apple Metal support */
  metal?: boolean;

  /** AMD ROCm support */
  rocm?: boolean;

  /** Vulkan support */
  vulkan?: boolean;
}

/**
 * CPU information
 */
export interface CPUInfo {
  /** Number of CPU cores */
  cores: number;

  /** CPU model name */
  model: string;

  /** CPU architecture (x64, arm64, etc.) */
  architecture: string;
}

/**
 * Memory information in bytes
 */
export interface MemoryInfo {
  /** Total system RAM in bytes */
  total: number;

  /** Available RAM in bytes */
  available: number;

  /** Used RAM in bytes */
  used: number;
}

/**
 * Outcome of a platform available-memory telemetry refresh.
 *
 * - `refreshed`: the platform command ran and stored a valid reading.
 * - `not-required`: the platform needs no command; its direct reading is trusted.
 * - `failed`: the command failed, timed out, or produced an unusable value.
 */
export type MemoryTelemetryRefreshStatus = 'refreshed' | 'not-required' | 'failed';

/**
 * Bounding options for a platform telemetry command (memory/GPU probes).
 *
 * Long-running callers (LLM calibration) pass their abort signal and a bounded
 * timeout so a hung platform command cannot stall a run or leak a child process.
 */
export interface TelemetryCommandOptions {
  /** Caller abort signal. Aborting rejects with the signal's reason. */
  signal?: AbortSignal;

  /** Per-command wall-clock bound in milliseconds (default: 10 000). */
  timeoutMs?: number;
}

/**
 * System recommendations for model configuration
 */
export interface SystemRecommendations {
  /** Maximum recommended model size (e.g., "7B", "13B", "70B") */
  maxModelSize: string;

  /** Recommended quantization levels (e.g., ["Q4_K_M", "Q5_K_M"]) */
  recommendedQuantization: readonly string[];

  /** Recommended number of CPU threads */
  threads: number;

  /** Recommended GPU layers to offload (undefined if no GPU) */
  gpuLayers?: number;

  /** Whether GPU acceleration is available */
  gpuAcceleration: boolean;
}

/**
 * Complete system capabilities
 */
export interface SystemCapabilities {
  /** CPU information */
  cpu: CPUInfo;

  /** Memory information */
  memory: MemoryInfo;

  /** GPU information */
  gpu: GPUInfo;

  /** Platform (darwin, win32, linux) */
  platform: NodeJS.Platform;

  /** System recommendations based on detected capabilities */
  recommendations: SystemRecommendations;

  /** When capabilities were detected (ISO timestamp) */
  detectedAt: string;
}
