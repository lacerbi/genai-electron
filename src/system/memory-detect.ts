/**
 * Memory detection utilities
 * @module system/memory-detect
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemoryInfo, GPUInfo } from '../types/index.js';

const execAsync = promisify(exec);

/**
 * Get system memory information
 *
 * @returns Memory information in bytes
 *
 * @example
 * ```typescript
 * const memory = getMemoryInfo();
 * console.log(`Total RAM: ${memory.total / (1024 ** 3)} GB`);
 * ```
 */
export function getMemoryInfo(): MemoryInfo {
  const total = os.totalmem();
  const available = os.freemem();
  const used = total - available;

  return {
    total,
    available,
    used,
  };
}

/**
 * Estimate VRAM for GPU (platform-specific)
 * Returns null if unable to detect or no GPU available
 *
 * @param gpu - GPU information from detectGPU()
 * @returns VRAM in bytes or null
 *
 * @example
 * ```typescript
 * const gpu = await detectGPU();
 * const vram = await estimateVRAM(gpu);
 * if (vram) {
 *   console.log(`VRAM: ${vram / (1024 ** 3)} GB`);
 * }
 * ```
 */
export async function estimateVRAM(gpu: GPUInfo): Promise<number | null> {
  if (!gpu.available) {
    return null;
  }

  const platform = process.platform;

  // macOS: Unified memory architecture
  // GPU shares RAM with CPU, so we can use a portion of total RAM
  if (platform === 'darwin' && gpu.metal) {
    const memory = getMemoryInfo();
    // On Apple Silicon, models can use ~70% of RAM for VRAM
    return Math.floor(memory.total * 0.7);
  }

  // Windows/Linux: Try to get VRAM from nvidia-smi
  if (gpu.type === 'nvidia' && gpu.cuda) {
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits'
      );
      const vramMB = parseInt(stdout.trim(), 10);
      if (!isNaN(vramMB)) {
        return vramMB * 1024 * 1024; // Convert MB to bytes
      }
    } catch {
      // nvidia-smi not available or failed
      return null;
    }
  }

  // AMD ROCm: Try rocm-smi (Linux only)
  if (platform === 'linux' && gpu.type === 'amd' && gpu.rocm) {
    try {
      const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv');
      // Parse CSV output to extract VRAM size
      const lines = stdout.split('\n');
      if (lines.length > 1 && lines[1]) {
        const values = lines[1].split(',');
        if (values[0]) {
          const vramMB = parseInt(values[0], 10);
          if (!isNaN(vramMB)) {
            return vramMB * 1024 * 1024;
          }
        }
      }
    } catch {
      // rocm-smi not available or failed
      return null;
    }
  }

  return null;
}

/**
 * Check if system has sufficient memory for a given requirement
 *
 * @param requiredBytes - Required memory in bytes
 * @param useVRAM - Whether to check VRAM instead of RAM
 * @param gpu - GPU information (required if useVRAM is true)
 * @returns True if sufficient memory available
 *
 * @example
 * ```typescript
 * const has8GB = hasSufficientMemory(8 * 1024 ** 3);
 * if (!has8GB) {
 *   console.log('Insufficient RAM for this model');
 * }
 * ```
 */
export async function hasSufficientMemory(
  requiredBytes: number,
  useVRAM = false,
  gpu?: GPUInfo
): Promise<boolean> {
  if (useVRAM) {
    if (!gpu || !gpu.available) {
      return false;
    }
    const vram = await estimateVRAM(gpu);
    if (!vram) {
      return false;
    }
    return vram >= requiredBytes;
  }

  const memory = getMemoryInfo();
  return memory.available >= requiredBytes;
}

/**
 * Get recommended memory allocation for model inference
 * Leaves headroom for OS and other processes
 *
 * @param modelSizeBytes - Model size in bytes
 * @returns Recommended memory allocation in bytes
 *
 * @example
 * ```typescript
 * const modelSize = 4.4 * 1024 ** 3; // 4.4GB model
 * const recommended = getRecommendedMemoryAllocation(modelSize);
 * console.log(`Allocate ${recommended / (1024 ** 3)} GB for this model`);
 * ```
 */
export function getRecommendedMemoryAllocation(modelSizeBytes: number): number {
  // Rule of thumb: Model needs ~1.2x its size for inference (overhead for KV cache, context)
  const baseRequirement = modelSizeBytes * 1.2;

  // Add 2GB buffer for OS and application overhead
  const buffer = 2 * 1024 ** 3;

  return baseRequirement + buffer;
}
