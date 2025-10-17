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
 * Binary variant type
 */
export type BinaryVariant = 'cuda' | 'vulkan' | 'metal' | 'cpu';

/**
 * Binary variant configuration
 */
export interface BinaryVariantConfig {
  /** Variant type (cuda/vulkan/metal/cpu) */
  type: BinaryVariant;
  /** Download URL for this variant */
  url: string;
  /** SHA256 checksum for verification */
  checksum: string;
}

/**
 * Binary version configuration
 * Pinned to specific releases for stability
 *
 * Each platform has an array of variants in priority order.
 * The library will try each variant until one works (has required drivers).
 *
 * **For updating to new llama.cpp releases, see docs/dev/UPDATING-BINARIES.md**
 */
export const BINARY_VERSIONS = {
  /** llama-server (llama.cpp) configuration */
  llamaServer: {
    /** Version/commit tag */
    version: 'b6784',
    /** Binary variants for each platform (in priority order for fallback) */
    variants: {
      'darwin-arm64': [
        {
          type: 'metal' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-macos-arm64.zip',
          checksum: 'ea4be04a6de5348868730eb8665e62de40c469bc53d78ec44295ce29cf08fea1',
        },
      ],
      'darwin-x64': [
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-macos-x64.zip',
          checksum: '56d5c1c629c7bdcdbdb17c5a03fcec8cfabe2136f9ba8938cb22df6cdb5192cb',
        },
      ],
      'win32-x64': [
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-win-cuda-12.4-x64.zip',
          checksum: 'a7a8981f742cdc0e1c93c02caa955fb2ad2716407fb3556cbc71e7e4e44f7d72',
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-win-vulkan-x64.zip',
          checksum: 'b1e3cfa3a248424b171a9fa58ca2fe69f988516d03881270c116760566c95540',
        },
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-win-cpu-x64.zip',
          checksum: 'b6523cd0e87f2508a7b9d3f542850c0d04ffdeb143c79ca938b7d6fa28e2e15d',
        },
      ],
      'linux-x64': [
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-ubuntu-x64.zip',
          checksum: 'c853d5e85e012d869f308d4a329c8ccfd762dc600f44a7abdbae315b4f14d823',
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-ubuntu-vulkan-x64.zip',
          checksum: '3f1ba3be1dd9beda20989348cf881d725b33a8b04c74d7beefc98aa77ace6e7c',
        },
      ],
    },
  },
  /** stable-diffusion.cpp configuration (Phase 2) */
  diffusionCpp: {
    /** Version/commit tag */
    version: 'master-330-db6f479',
    /** Binary variants for each platform (in priority order for fallback) */
    variants: {
      'darwin-arm64': [
        {
          type: 'metal' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-330-db6f479/sd-master--bin-Darwin-macOS-15.6.1-arm64.zip',
          checksum: '63be1220757cb895432847967c3e17dd1fbcac8abdd77c100bee46c7d1a7c2a2',
        },
      ],
      'darwin-x64': [
        // No darwin-x64 builds available in this release
      ],
      'win32-x64': [
        // Priority order: CUDA (fastest) → Vulkan (cross-GPU) → AVX2 (CPU fallback)
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-330-db6f479/sd-master-db6f479-bin-win-cuda12-x64.zip',
          checksum: '5f15a0f08e2b34eaf8aa8b1bb50dd0b6a194bf21176ab9512ecacf0ccc8f1532',
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-330-db6f479/sd-master-db6f479-bin-win-vulkan-x64.zip',
          checksum: 'fbd737e427741d36abd5807b4b06920d0c4fa66423a0fc257e16586ed255621d',
        },
        {
          type: 'cpu' as BinaryVariant, // AVX2 variant (most compatible CPU version)
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-330-db6f479/sd-master-db6f479-bin-win-avx2-x64.zip',
          checksum: '908428c5f4e3743ceba5958157fc397c2a588acbf85d339ef0108a0a05611786',
        },
        // Additional CPU variants available if needed:
        // AVX512: 58aa48de2f67f1628365f8f3284a43903d3cd5880353c8d67060d60a257d5f4f
        // AVX: a1c5b5271e1256da68e9ccb931802f16fb3d150e73a829909b18314ddaaaf4dd
        // No-AVX: 884d86f534136feed662fb7c13f7f303e28c2960b119cd4b6bb6444bf69b6a7e
      ],
      'linux-x64': [
        {
          type: 'cpu' as BinaryVariant, // Works with both CPU and CUDA (auto-detects)
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-330-db6f479/sd-master--bin-Linux-Ubuntu-24.04-x86_64.zip',
          checksum: 'eb886cbd37cf927095255bc406858a5a131fcc141e04e68007be80a9156566c3',
        },
      ],
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
