/**
 * Default configuration values for genai-electron
 * @module config/defaults
 */

import type { DiffusionComponentRole, DiffusionOffloadCombo } from '../types/index.js';

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
  /**
   * Max fraction of TOTAL RAM that CPU-resident MoE expert weights may occupy.
   * Experts are mmap'd and sparsely activated (e.g. 8 of 128 per token), so
   * they page through the OS cache rather than requiring committed RAM —
   * gating them against free RAM would wrongly reject working setups.
   */
  moeExpertTotalRamFraction: 0.6,
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
 * **For updating to new llama.cpp / stable-diffusion.cpp releases, see docs/dev/UPDATING-BINARIES.md**
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
    version: 'master-746-2574f59',
    /**
     * Binary variants for each platform (in priority order for fallback)
     *
     * Checksums come from the GitHub releases API per-asset `digest` field.
     */
    variants: {
      'darwin-arm64': [
        {
          type: 'metal' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-Darwin-macOS-15.7.7-arm64.zip',
          checksum: '570213614f4021ee99f832169da5c0abb73b53d48c8be2252eda30e4df3c4a1d',
        },
      ],
      'darwin-x64': [
        // No darwin-x64 builds available in this release
      ],
      'win32-x64': [
        // Priority order: CUDA (fastest) → Vulkan (cross-GPU) → CPU fallback
        {
          type: 'cuda' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-win-cuda12-x64.zip',
          checksum: 'baa07994a81dcdf1b3895c9dd290aa87683a65120d196501e3d015daca71d2d5',
          dependencies: [
            {
              url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/cudart-sd-bin-win-cu12-x64.zip',
              checksum: 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d',
              description: 'CUDA 12 runtime libraries required for NVIDIA GPU acceleration',
            },
          ],
        },
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-win-vulkan-x64.zip',
          checksum: 'b6c9551a4e47cb7ce0b7ff41d382c12ec7f62f930a7d47fdc484851f19153248',
        },
        {
          // Runtime CPU dispatch — the single win-cpu zip ships all ISA variants
          // (sse42/avx/avx2/avx512/…) as loadable ggml backends; replaces the
          // former per-ISA avx2/avx512/avx/noavx zips
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-win-cpu-x64.zip',
          checksum: 'add4a495403e6170bb8ed6e68a5c6c59568f7d2ad28e773a9264a2a0537fc722',
        },
      ],
      'linux-x64': [
        {
          type: 'vulkan' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
          checksum: '79ea8096d1fdf35bdc9cf92f8008713cd5a0b2f0c23fa067e1c8144f89f902e2',
        },
        {
          type: 'cpu' as BinaryVariant,
          url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-746-2574f59/sd-master-2574f59-bin-Linux-Ubuntu-24.04-x86_64.zip',
          checksum: '80c6597f2ec18e7d2473bd3169db8b72500e50244110548d904216549993483c',
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
 * Defaults for DiffusionServerManager.calibrate() (offload-calibration sweeps).
 *
 * The combo set is curated — the full 2^4 flag grid is mostly dominated.
 * Combo labels are surfaced by progress UIs and persisted recommendations.
 */
export const DIFFUSION_CALIBRATION_DEFAULTS: {
  readonly combos: readonly DiffusionOffloadCombo[];
  readonly samples: number;
  readonly seed: number;
  readonly prompt: string;
  /** Runs within this % of the fastest prefer fewer forced flags (robustness tie-break) */
  readonly tieTolerancePct: number;
  /** Models matching this id/name pattern skip clipOnCpu combos (leejet/stable-diffusion.cpp#1578) */
  readonly sd35LargePattern: RegExp;
  /** stderr/message patterns classifying a failed generation as out-of-memory */
  readonly oomPatterns: readonly RegExp[];
} = {
  // steps/cfgScale/sampler/sizes are NOT defaulted — the caller must pass them
  // (via DiffusionCalibrationConfig.generation / .sizes) so the sweep measures the
  // same compute profile as production. See DiffusionCalibrationGeneration.
  combos: [
    { label: 'auto' },
    { label: 'clip-gpu', clipOnCpu: false },
    { label: 'clip-gpu+offload', clipOnCpu: false, offloadToCpu: true },
    { label: 'offload', offloadToCpu: true },
    { label: 'all-resident', clipOnCpu: false, vaeOnCpu: false, offloadToCpu: false },
    { label: 'max-savings', clipOnCpu: true, vaeOnCpu: true, offloadToCpu: true },
  ],
  samples: 2,
  seed: 42,
  prompt: 'a photograph of a lighthouse on a rocky coast at sunset, detailed',
  tieTolerancePct: 5,
  sd35LargePattern: /(?:sd|stable[-_.\s]?diffusion)[-_.\s]?3[-_.\s]?5.*?large/i,
  oomPatterns: [
    /out of memory/i,
    /cudaMalloc/i,
    /CUDA error/i,
    /ErrorOutOfDeviceMemory/i,
    /failed to allocate/i,
    /not enough memory/i,
  ],
};

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
