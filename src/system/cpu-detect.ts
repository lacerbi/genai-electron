/**
 * CPU detection utilities
 * @module system/cpu-detect
 */

import os from 'node:os';
import type { CPUInfo } from '../types/index.js';

/**
 * Get CPU information
 *
 * @returns CPU information
 *
 * @example
 * ```typescript
 * const cpu = getCPUInfo();
 * console.log(`CPU: ${cpu.model} (${cpu.cores} cores, ${cpu.architecture})`);
 * ```
 */
export function getCPUInfo(): CPUInfo {
  const cpus = os.cpus();
  const cores = cpus.length;
  const model = cpus[0]?.model || 'Unknown CPU';
  const architecture = os.arch();

  return {
    cores,
    model,
    architecture,
  };
}

/**
 * Get recommended number of threads for model inference
 * Leaves one core for OS and other processes
 *
 * @param cpuCores - Number of CPU cores (optional, auto-detected if not provided)
 * @returns Recommended thread count
 *
 * @example
 * ```typescript
 * const threads = getRecommendedThreads();
 * console.log(`Use ${threads} threads for inference`);
 * ```
 */
export function getRecommendedThreads(cpuCores?: number): number {
  const cores = cpuCores ?? getCPUInfo().cores;

  // Leave at least one core for OS, but use all cores if only 1-2 available
  if (cores <= 2) {
    return cores;
  }

  // For 3-8 cores: use cores - 1
  if (cores <= 8) {
    return cores - 1;
  }

  // For 9-16 cores: use cores - 2
  if (cores <= 16) {
    return cores - 2;
  }

  // For 17+ cores: use ~85% of cores
  return Math.floor(cores * 0.85);
}

/**
 * Check if CPU is likely suitable for AI inference
 * Based on core count and architecture
 *
 * @returns True if CPU is suitable for AI workloads
 *
 * @example
 * ```typescript
 * if (isCPUSuitable()) {
 *   console.log('CPU is suitable for AI inference');
 * }
 * ```
 */
export function isCPUSuitable(): boolean {
  const cpu = getCPUInfo();

  // Need at least 4 cores for reasonable performance
  if (cpu.cores < 4) {
    return false;
  }

  // x64 and arm64 are well-supported
  if (cpu.architecture === 'x64' || cpu.architecture === 'arm64') {
    return true;
  }

  // Other architectures may work but are not officially supported
  return false;
}

/**
 * Get CPU performance estimate (relative score)
 * Higher is better, based on cores and architecture
 *
 * @returns Performance score (0-100)
 *
 * @example
 * ```typescript
 * const score = getCPUPerformanceScore();
 * console.log(`CPU performance score: ${score}/100`);
 * ```
 */
export function getCPUPerformanceScore(): number {
  const cpu = getCPUInfo();

  // Base score from core count (0-70 points)
  const coreScore = Math.min(cpu.cores * 3.5, 70);

  // Architecture bonus (0-30 points)
  let archBonus = 0;
  if (cpu.architecture === 'arm64') {
    // Apple Silicon gets higher score due to unified memory and efficiency
    archBonus = 30;
  } else if (cpu.architecture === 'x64') {
    archBonus = 25;
  } else {
    archBonus = 10;
  }

  return Math.min(coreScore + archBonus, 100);
}

/**
 * Estimate inference speed category based on CPU
 *
 * @returns Speed category: 'slow', 'medium', 'fast', 'very-fast'
 *
 * @example
 * ```typescript
 * const speed = estimateInferenceSpeed();
 * console.log(`Expected inference speed: ${speed}`);
 * ```
 */
export function estimateInferenceSpeed(): 'slow' | 'medium' | 'fast' | 'very-fast' {
  const score = getCPUPerformanceScore();

  if (score >= 80) return 'very-fast';
  if (score >= 60) return 'fast';
  if (score >= 40) return 'medium';
  return 'slow';
}
