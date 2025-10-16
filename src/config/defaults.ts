/**
 * Default configuration values for genai-electron
 * @module config/defaults
 */

import type { ServerConfig } from '../types/index.js';

/**
 * Default ports for different server types
 */
export const DEFAULT_PORTS = {
  /** Default port for llama-server */
  llama: 8080,
  /** Default port for diffusion server (Phase 2) */
  diffusion: 8081,
} as const;

/**
 * Default timeouts (in milliseconds)
 */
export const DEFAULT_TIMEOUTS = {
  /** Download timeout */
  download: 300000, // 5 minutes
  /** Server start timeout */
  serverStart: 60000, // 1 minute
  /** Server stop timeout */
  serverStop: 10000, // 10 seconds
  /** Health check timeout */
  healthCheck: 5000, // 5 seconds
} as const;

/**
 * Default server configuration
 * Values marked as -1 will be auto-detected based on system capabilities
 */
export const DEFAULT_SERVER_CONFIG: Partial<ServerConfig> = {
  threads: -1, // Auto-detect based on CPU cores
  contextSize: 4096,
  gpuLayers: -1, // Auto-detect based on GPU availability
  parallelRequests: 4,
  flashAttention: false,
} as const;

/**
 * Binary version configuration
 * Pinned to specific releases for stability
 */
export const BINARY_VERSIONS = {
  /** llama-server (llama.cpp) configuration */
  llamaServer: {
    /** Version/commit tag */
    version: 'b4313', // Example: llama.cpp commit or release tag
    /** Download URLs for each platform */
    urls: {
      'darwin-arm64':
        'https://github.com/ggml-org/llama.cpp/releases/download/b4313/llama-server-darwin-arm64',
      'darwin-x64':
        'https://github.com/ggml-org/llama.cpp/releases/download/b4313/llama-server-darwin-x64',
      'win32-x64':
        'https://github.com/ggml-org/llama.cpp/releases/download/b4313/llama-server-win32-x64.exe',
      'linux-x64':
        'https://github.com/ggml-org/llama.cpp/releases/download/b4313/llama-server-linux-x64',
    },
    /** SHA256 checksums for verification */
    checksums: {
      'darwin-arm64': 'sha256:placeholder_checksum_darwin_arm64',
      'darwin-x64': 'sha256:placeholder_checksum_darwin_x64',
      'win32-x64': 'sha256:placeholder_checksum_win32_x64',
      'linux-x64': 'sha256:placeholder_checksum_linux_x64',
    },
  },
  /** diffusion-cpp configuration (Phase 2) */
  diffusionCpp: {
    version: 'v1.0.0', // Example version
    urls: {
      'darwin-arm64':
        'https://github.com/leejet/stable-diffusion.cpp/releases/download/v1.0.0/diffusion-darwin-arm64',
      'darwin-x64':
        'https://github.com/leejet/stable-diffusion.cpp/releases/download/v1.0.0/diffusion-darwin-x64',
      'win32-x64':
        'https://github.com/leejet/stable-diffusion.cpp/releases/download/v1.0.0/diffusion-win32-x64.exe',
      'linux-x64':
        'https://github.com/leejet/stable-diffusion.cpp/releases/download/v1.0.0/diffusion-linux-x64',
    },
    checksums: {
      'darwin-arm64': 'sha256:placeholder_checksum_darwin_arm64',
      'darwin-x64': 'sha256:placeholder_checksum_darwin_x64',
      'win32-x64': 'sha256:placeholder_checksum_win32_x64',
      'linux-x64': 'sha256:placeholder_checksum_linux_x64',
    },
  },
} as const;

/**
 * Health check configuration
 */
export const HEALTH_CHECK_CONFIG = {
  /** Initial retry delay in milliseconds */
  initialDelay: 500,
  /** Maximum retry delay in milliseconds */
  maxDelay: 5000,
  /** Backoff multiplier */
  backoffMultiplier: 1.5,
  /** Maximum number of retries */
  maxRetries: 10,
} as const;

/**
 * Model size recommendations (in GB)
 * Based on quantization and parameter count
 */
export const MODEL_SIZE_ESTIMATES = {
  /** 7B parameter models */
  '7B': {
    Q4_K_M: 4.4, // ~4.4GB
    Q5_K_M: 5.2, // ~5.2GB
    Q8_0: 7.2, // ~7.2GB
  },
  /** 13B parameter models */
  '13B': {
    Q4_K_M: 8.1, // ~8.1GB
    Q5_K_M: 9.5, // ~9.5GB
    Q8_0: 13.5, // ~13.5GB
  },
  /** 70B parameter models */
  '70B': {
    Q4_K_M: 41.0, // ~41GB
    Q5_K_M: 48.0, // ~48GB
  },
} as const;

/**
 * Recommended quantizations by use case
 */
export const RECOMMENDED_QUANTIZATIONS = {
  /** Best quality (largest size) */
  quality: ['Q8_0', 'Q6_K', 'Q5_K_M'],
  /** Balanced quality and size */
  balanced: ['Q5_K_M', 'Q4_K_M'],
  /** Smallest size (lower quality) */
  compact: ['Q4_K_M', 'Q4_K_S', 'Q3_K_M'],
} as const;
