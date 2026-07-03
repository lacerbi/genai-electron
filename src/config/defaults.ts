/**
 * Default configuration values for genai-electron
 * @module config/defaults
 */

import type { DiffusionComponentRole } from '../types/index.js';

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
  /** Server start timeout (covers cold model loads of 10-20 GB GGUFs; override per-start via ServerConfig.startupTimeout) */
  serverStart: 120000, // 2 minutes
  /** Server stop timeout */
  serverStop: 10000, // 10 seconds
  /** Health check timeout */
  healthCheck: 5000, // 5 seconds
} as const;

/**
 * Default log-rotation settings for server log files
 */
export const DEFAULT_LOG_ROTATION = {
  /** Rotate when the log file exceeds this many bytes */
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  /** Number of rotated archives to keep (server.log.1, server.log.2, ...) */
  maxArchives: 2,
} as const;

/**
 * Constants for KV-cache-aware context/offload sizing (SystemInfo.getOptimalConfig)
 */
export const KV_SIZING = {
  /** Minimum recommended context (llama.cpp's historical default) */
  floorContextTokens: 4096,
  /** VRAM held back for llama.cpp compute/graph buffers and allocator slack */
  computeBufferBytes: 1 * 1024 ** 3,
  /** Weight-size multiplier for GPU-resident weights */
  gpuWeightsOverhead: 1.1,
  /** Weight-size multiplier for RAM-resident weights */
  cpuWeightsOverhead: 1.2,
  /** RAM held back for the OS and other processes in CPU sizing paths */
  osRamMarginBytes: 2 * 1024 ** 3,
  /** Minimum VRAM reserved for KV when partially offloading */
  minPartialReserveBytes: 1.5 * 1024 ** 3,
  /** Context recommendations are rounded down to this granularity */
  contextGranularityTokens: 1024,
} as const;

/**
 * Binary variant type
 */
export type BinaryVariant = 'cuda' | 'vulkan' | 'metal' | 'cpu';

/**
 * Binary dependency configuration
 * Used for additional files required by certain binary variants (e.g., CUDA runtime DLLs)
 */
export interface BinaryDependency {
  /** Download URL for this dependency */
  url: string;
  /** SHA256 checksum for verification */
  checksum: string;
  /** Human-readable description of this dependency */
  description?: string;
}

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
  /** Optional dependencies required by this variant (e.g., CUDA runtime DLLs for Windows CUDA variants) */
  dependencies?: readonly BinaryDependency[];
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
    version: 'b9860',
    /**
     * Binary variants for each platform (in priority order for fallback)
     *
     * Note: as of b9860 upstream no longer publishes a Linux x64 CUDA build —
     * Linux NVIDIA users get the Vulkan variant (build from source for CUDA).
     * Checksums come from the GitHub releases API per-asset `digest` field.
     */
    variants: {
      'darwin-arm64': [
        {
          type: 'metal' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-macos-arm64.tar.gz',
          checksum: '35a2e8c3528adc71db5044e7ad7de8d8b96a4221e737958915e31538a005f1d9',
        },
      ],
      'darwin-x64': [
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-macos-x64.tar.gz',
          checksum: 'd442123d5441c82b23b412a58d91e149f60723adfc20a7cc9df04a3908cb5113',
        },
      ],
      'win32-x64': [
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-win-cuda-12.4-x64.zip',
          checksum: '70c433fcb55bcb0e0ff0d4a4fc5f02c11a14303445e0525b526071bccdc6c848',
          dependencies: [
            {
              url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/cudart-llama-bin-win-cuda-12.4-x64.zip',
              checksum: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
              description: 'CUDA 12.4 runtime libraries required for NVIDIA GPU acceleration',
            },
          ],
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-win-vulkan-x64.zip',
          checksum: 'c3f0703c8fca8fa4cbc01a347d7180fca092e889fe693268bf1192fd07350c13',
        },
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-win-cpu-x64.zip',
          checksum: 'd33871623713345cd90b54e516ebada79039cab636e51b22c8c9feae72567837',
        },
      ],
      'linux-x64': [
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-ubuntu-vulkan-x64.tar.gz',
          checksum: '4aaa4ca2ed9f608cf26cb6ba0cdad9c5b8e8f2d1e95c4f04bb3fa9a1a8c86806',
        },
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9860/llama-b9860-bin-ubuntu-x64.tar.gz',
          checksum: 'b68e8072eb88d1cc8b8e9d6ea8237aae87b34c6d8bbffda958c870e4dc949714',
        },
      ],
    },
  },
  /** stable-diffusion.cpp configuration (Phase 2) */
  diffusionCpp: {
    /** Version/commit tag */
    version: 'master-504-636d3cb',
    /** Binary variants for each platform (in priority order for fallback) */
    variants: {
      'darwin-arm64': [
        {
          type: 'metal' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/sd-master-636d3cb-bin-Darwin-macOS-15.7.3-arm64.zip',
          checksum: '5053adb55137150b24a036c804329ec4063da32922b070fc800dbf785b819e63',
        },
      ],
      'darwin-x64': [
        // No darwin-x64 builds available in this release
      ],
      'win32-x64': [
        // Priority order: CUDA (fastest) → Vulkan (cross-GPU) → AVX2 (CPU fallback)
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/sd-master-636d3cb-bin-win-cuda12-x64.zip',
          checksum: '701dac9b0d7959daf20d56798c4791f750746aef568dd009eb3a1bc33d3ceec8',
          dependencies: [
            {
              url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/cudart-sd-bin-win-cu12-x64.zip',
              checksum: 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d',
              description: 'CUDA 12 runtime libraries required for NVIDIA GPU acceleration',
            },
          ],
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/sd-master-636d3cb-bin-win-vulkan-x64.zip',
          checksum: '5d6481fab70e3836ac04beac209ad93590cf4d2433d68a449f0b03586c94b0ee',
        },
        {
          type: 'cpu' as BinaryVariant, // AVX2 variant (most compatible CPU version)
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/sd-master-636d3cb-bin-win-avx2-x64.zip',
          checksum: 'd3c5f9ce9e78354ebf45590508e320416a430197957f74a60a8731151ea6a3bc',
        },
        // Additional CPU variants available if needed:
        // AVX512: 88c76d82ae458e90e36f767bcc64e46b4116edf315a982fdc4a2b34559108151
        // AVX: b54ed8ebe048a302f0d2b0a5ddec0af9bc52eb05c2ab595d58ece4ae4cd71014
        // No-AVX: aa80d621c41c40bcdbf6d48c069776524a63b699b79b282c30395e89bc1c65a6
        // ROCm: e41e2c2e870bada985b863d158a02207511d2e15342fef2a3ceaa6863b2c2a3c
      ],
      'linux-x64': [
        {
          type: 'cpu' as BinaryVariant, // Works with both CPU and CUDA (auto-detects)
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-504-636d3cb/sd-master-636d3cb-bin-Linux-Ubuntu-24.04-x86_64.zip',
          checksum: '7485c413f4ac55c08d137a5a3ba31987067de830092f2cf0aed859235b1c6782',
        },
      ],
    },
  },
} as const;

/**
 * Maps DiffusionComponentRole to the sd.cpp CLI flag.
 */
export const DIFFUSION_COMPONENT_FLAGS: Record<DiffusionComponentRole, string> = {
  diffusion_model: '--diffusion-model',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
  vae: '--vae',
};

/**
 * Canonical iteration order for component roles in CLI arg building.
 * Ensures deterministic, testable arg output regardless of object key order.
 */
export const DIFFUSION_COMPONENT_ORDER: readonly DiffusionComponentRole[] = [
  'diffusion_model',
  'clip_l',
  'clip_g',
  't5xxl',
  'llm',
  'llm_vision',
  'vae',
] as const;

/**
 * VRAM optimization thresholds for diffusion image generation.
 *
 * Used by DiffusionServerManager.computeDiffusionOptimizations() to decide
 * whether to offload CLIP/VAE to CPU based on available GPU headroom.
 *
 * headroom = totalVRAM - (modelFileSize * modelOverheadMultiplier)
 */
export const DIFFUSION_VRAM_THRESHOLDS = {
  /** Headroom below which --clip-on-cpu is auto-enabled (6 GB) */
  clipOnCpuHeadroomBytes: 6 * 1024 ** 3,
  /** Headroom below which --vae-on-cpu is auto-enabled (2 GB) */
  vaeOnCpuHeadroomBytes: 2 * 1024 ** 3,
  /** Multiplier applied to model file size to estimate runtime VRAM footprint */
  modelOverheadMultiplier: 1.2,
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
