/**
 * Registry for managing async image generation state
 * @module managers/GenerationRegistry
 */

import type { GenerationState, ImageGenerationConfig } from '../types/images.js';
import { generateId } from '../utils/generation-id.js';

/**
 * Configuration options for GenerationRegistry
 */
export interface GenerationRegistryConfig {
  /** Maximum age (in ms) for completed generations before cleanup (default: 5 minutes) */
  maxResultAgeMs?: number;

  /** Interval (in ms) between cleanup runs (default: 1 minute) */
  cleanupIntervalMs?: number;
}

/**
 * In-memory registry for managing image generation state.
 * Provides create/read/update/delete operations and automatic cleanup of old results.
 */
export class GenerationRegistry {
  private generations = new Map<string, GenerationState>();
  private cleanupInterval: NodeJS.Timeout;
  private maxResultAgeMs: number;

  constructor(config: GenerationRegistryConfig = {}) {
    this.maxResultAgeMs = config.maxResultAgeMs ?? 5 * 60 * 1000; // 5 minutes default
    const cleanupIntervalMs = config.cleanupIntervalMs ?? 60 * 1000; // 1 minute default

    // Start automatic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup(this.maxResultAgeMs);
    }, cleanupIntervalMs);
  }

  /**
   * Create a new generation entry
   * @param config - Image generation configuration
   * @returns The generated ID
   */
  create(config: ImageGenerationConfig): string {
    const id = generateId();
    const now = Date.now();

    this.generations.set(id, {
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      config,
    });

    return id;
  }

  /**
   * Get a generation by ID
   * @param id - Generation ID
   * @returns The generation state or null if not found
   */
  get(id: string): GenerationState | null {
    return this.generations.get(id) ?? null;
  }

  /**
   * Update a generation's state
   * @param id - Generation ID
   * @param updates - Partial state updates
   */
  update(id: string, updates: Partial<GenerationState>): void {
    const state = this.generations.get(id);
    if (!state) {
      return;
    }

    Object.assign(state, updates);
    state.updatedAt = Date.now();
  }

  /**
   * Delete a generation from the registry
   * @param id - Generation ID
   */
  delete(id: string): void {
    this.generations.delete(id);
  }

  /**
   * Get all generation IDs
   * @returns Array of all generation IDs
   */
  getAllIds(): string[] {
    return Array.from(this.generations.keys());
  }

  /**
   * Get count of stored generations
   * @returns Number of generations in registry
   */
  size(): number {
    return this.generations.size;
  }

  /**
   * Clean up old completed or errored generations
   * @param maxAgeMs - Maximum age in milliseconds for terminal states
   * @returns Number of generations cleaned up
   */
  cleanup(maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, state] of this.generations.entries()) {
      // Only clean up terminal states (complete/error)
      const isTerminal = state.status === 'complete' || state.status === 'error';
      if (isTerminal && now - state.updatedAt > maxAgeMs) {
        this.generations.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Stop the automatic cleanup interval
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  /**
   * Clear all generations (useful for testing)
   */
  clear(): void {
    this.generations.clear();
  }
}
