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

  /** VRAM in bytes */
  vram?: number;

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
 * System recommendations for model configuration
 */
export interface SystemRecommendations {
  /** Maximum recommended model size (e.g., "7B", "13B", "70B") */
  maxModelSize: string;

  /** Recommended quantization levels (e.g., ["Q4_K_M", "Q5_K_M"]) */
  recommendedQuantization: string[];

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
