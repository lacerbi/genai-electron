/**
 * GPU detection utilities (platform-specific)
 * @module system/gpu-detect
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { GPUInfo } from '../types/index.js';
import { isMac, isWindows, isLinux, isAppleSilicon } from '../utils/platform-utils.js';

const execAsync = promisify(exec);

/**
 * Detect GPU availability and capabilities
 * Platform-specific implementation
 *
 * @returns GPU information
 *
 * @example
 * ```typescript
 * const gpu = await detectGPU();
 * if (gpu.available) {
 *   console.log(`GPU: ${gpu.name} (${gpu.type})`);
 * }
 * ```
 */
export async function detectGPU(): Promise<GPUInfo> {
  if (isMac()) {
    return detectMacGPU();
  }

  if (isWindows()) {
    return detectWindowsGPU();
  }

  if (isLinux()) {
    return detectLinuxGPU();
  }

  // Unsupported platform
  return { available: false };
}

/**
 * Detect GPU on macOS
 * All modern Macs have Metal support
 */
async function detectMacGPU(): Promise<GPUInfo> {
  // All modern Macs (macOS 11+) have Metal support
  const gpuInfo: GPUInfo = {
    available: true,
    type: 'apple',
    metal: true,
  };

  // Try to get GPU name from system_profiler
  try {
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType | grep "Chipset Model"');
    const match = stdout.match(/Chipset Model:\s*(.+)/);
    if (match && match[1]) {
      gpuInfo.name = match[1].trim();
    }
  } catch {
    // Fallback: Use generic name based on architecture
    if (isAppleSilicon()) {
      gpuInfo.name = 'Apple Silicon GPU';
    } else {
      gpuInfo.name = 'Apple GPU';
    }
  }

  return gpuInfo;
}

/**
 * Detect GPU on Windows
 * Primarily checks for NVIDIA GPUs via nvidia-smi
 */
async function detectWindowsGPU(): Promise<GPUInfo> {
  // Try NVIDIA GPU detection via nvidia-smi
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader'
    );

    const parts = stdout.trim().split(',');
    if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
      const name = parts[0].trim();
      const vramTotalMB = parseInt(parts[1].trim(), 10);
      const vramFreeMB = parseInt(parts[2].trim(), 10);

      return {
        available: true,
        type: 'nvidia',
        name,
        vram: !isNaN(vramTotalMB) ? vramTotalMB * 1024 * 1024 : undefined,
        vramAvailable: !isNaN(vramFreeMB) ? vramFreeMB * 1024 * 1024 : undefined,
        cuda: true,
      };
    }
  } catch {
    // nvidia-smi not available or failed
  }

  // TODO Phase 4: Add AMD GPU detection for Windows
  // Could use DirectX diagnostics or WMI queries

  // No GPU detected
  return { available: false };
}

/**
 * Detect GPU on Linux
 * Checks for NVIDIA (CUDA), AMD (ROCm), and Intel GPUs
 */
async function detectLinuxGPU(): Promise<GPUInfo> {
  // Try NVIDIA GPU detection via nvidia-smi
  const nvidiaGPU = await detectLinuxNvidiaGPU();
  if (nvidiaGPU.available) {
    return nvidiaGPU;
  }

  // Try AMD GPU detection via rocm-smi
  const amdGPU = await detectLinuxAMDGPU();
  if (amdGPU.available) {
    return amdGPU;
  }

  // Try Intel GPU detection via /sys/class/drm
  const intelGPU = await detectLinuxIntelGPU();
  if (intelGPU.available) {
    return intelGPU;
  }

  // No GPU detected
  return { available: false };
}

/**
 * Detect NVIDIA GPU on Linux via nvidia-smi
 */
async function detectLinuxNvidiaGPU(): Promise<GPUInfo> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader'
    );

    const parts = stdout.trim().split(',');
    if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
      const name = parts[0].trim();
      const vramTotalMB = parseInt(parts[1].trim(), 10);
      const vramFreeMB = parseInt(parts[2].trim(), 10);

      return {
        available: true,
        type: 'nvidia',
        name,
        vram: !isNaN(vramTotalMB) ? vramTotalMB * 1024 * 1024 : undefined,
        vramAvailable: !isNaN(vramFreeMB) ? vramFreeMB * 1024 * 1024 : undefined,
        cuda: true,
      };
    }
  } catch {
    // nvidia-smi not available or failed
  }

  return { available: false };
}

/**
 * Detect AMD GPU on Linux via rocm-smi
 */
async function detectLinuxAMDGPU(): Promise<GPUInfo> {
  try {
    // Check if ROCm is available
    const { stdout: rocmVersion } = await execAsync('rocm-smi --version');
    if (!rocmVersion) {
      return { available: false };
    }

    // Get GPU info
    const { stdout } = await execAsync('rocm-smi --showproductname --csv');
    const lines = stdout.split('\n');

    if (lines.length > 1 && lines[1]) {
      const namePart = lines[1].split(',')[0];
      if (!namePart) {
        return { available: false };
      }
      const name = namePart.trim();

      // Try to get VRAM info
      try {
        const { stdout: vramOut } = await execAsync('rocm-smi --showmeminfo vram --csv');
        const vramLines = vramOut.split('\n');
        if (vramLines.length > 1 && vramLines[1]) {
          const vramPart = vramLines[1].split(',')[0];
          if (vramPart) {
            const vramMB = parseInt(vramPart, 10);
            return {
              available: true,
              type: 'amd',
              name,
              vram: !isNaN(vramMB) ? vramMB * 1024 * 1024 : undefined,
              rocm: true,
            };
          }
        }
      } catch {
        // VRAM info not available, but GPU is detected
      }

      return {
        available: true,
        type: 'amd',
        name,
        rocm: true,
      };
    }
  } catch {
    // rocm-smi not available or failed
  }

  return { available: false };
}

/**
 * Detect Intel GPU on Linux via /sys/class/drm
 */
async function detectLinuxIntelGPU(): Promise<GPUInfo> {
  try {
    // Check for Intel GPU in /sys/class/drm
    const { stdout } = await execAsync(
      'ls /sys/class/drm/card*/device/vendor 2>/dev/null | head -1 | xargs cat 2>/dev/null'
    );

    // Intel vendor ID: 0x8086
    if (stdout.trim() === '0x8086') {
      // Try to get GPU name from device info
      try {
        const { stdout: deviceInfo } = await execAsync('lspci | grep -i vga | grep -i intel');
        const match = deviceInfo.match(/Intel.*?:\s*(.+)/);
        const name = match && match[1] ? match[1].trim() : 'Intel GPU';

        return {
          available: true,
          type: 'intel',
          name,
          vulkan: true, // Intel GPUs generally support Vulkan
        };
      } catch {
        // lspci not available, use generic name
        return {
          available: true,
          type: 'intel',
          name: 'Intel GPU',
          vulkan: true,
        };
      }
    }
  } catch {
    // /sys/class/drm not available or detection failed
  }

  return { available: false };
}

/**
 * Calculate recommended GPU layers for model offloading
 *
 * @param totalLayers - Total number of layers in the model
 * @param vramBytes - Available VRAM in bytes
 * @param modelSizeBytes - Model size in bytes
 * @returns Recommended number of GPU layers (0 if CPU-only)
 *
 * @example
 * ```typescript
 * const layers = calculateGPULayers(32, 8 * 1024 ** 3, 4.4 * 1024 ** 3);
 * console.log(`Offload ${layers} layers to GPU`);
 * ```
 */
export function calculateGPULayers(
  totalLayers: number,
  vramBytes: number,
  modelSizeBytes: number
): number {
  // If no VRAM or model is larger than VRAM, use CPU only
  if (vramBytes === 0 || modelSizeBytes >= vramBytes) {
    return 0;
  }

  // Estimate VRAM per layer (rough approximation)
  const vramPerLayer = modelSizeBytes / totalLayers;

  // Leave 2GB buffer for KV cache and context
  const buffer = 2 * 1024 ** 3;
  const usableVRAM = Math.max(0, vramBytes - buffer);

  // Calculate how many layers fit in usable VRAM
  const recommendedLayers = Math.floor(usableVRAM / vramPerLayer);

  // Cap at total layers
  return Math.min(recommendedLayers, totalLayers);
}
