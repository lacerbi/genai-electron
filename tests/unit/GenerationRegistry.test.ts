/**
 * Unit tests for GenerationRegistry
 */

import { jest } from '@jest/globals';
import { GenerationRegistry } from '../../src/managers/GenerationRegistry.js';
import type { ImageGenerationConfig } from '../../src/types/images.js';

describe('GenerationRegistry', () => {
  let registry: GenerationRegistry;

  beforeEach(() => {
    registry = new GenerationRegistry({
      maxResultAgeMs: 50, // 50ms for faster tests
      cleanupIntervalMs: 1000, // 1 second cleanup interval (disable auto-cleanup during tests)
    });
  });

  afterEach(() => {
    registry.destroy();
  });

  describe('create()', () => {
    it('should create a new generation with unique ID', () => {
      const config: ImageGenerationConfig = {
        prompt: 'test prompt',
        width: 512,
        height: 512,
      };

      const id = registry.create(config);

      expect(id).toMatch(/^gen_\d+_[a-z0-9]+$/);
      expect(registry.get(id)).toBeDefined();
    });

    it('should initialize generation with pending status', () => {
      const config: ImageGenerationConfig = {
        prompt: 'test prompt',
      };

      const id = registry.create(config);
      const state = registry.get(id);

      expect(state).toBeDefined();
      expect(state!.status).toBe('pending');
      expect(state!.config).toEqual(config);
      expect(state!.createdAt).toBeGreaterThan(0);
      expect(state!.updatedAt).toEqual(state!.createdAt);
    });

    it('should generate unique IDs for multiple generations', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };

      const id1 = registry.create(config);
      const id2 = registry.create(config);
      const id3 = registry.create(config);

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe('get()', () => {
    it('should retrieve existing generation', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      const state = registry.get(id);

      expect(state).toBeDefined();
      expect(state!.id).toBe(id);
    });

    it('should return null for non-existent ID', () => {
      const state = registry.get('non_existent_id');

      expect(state).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update generation status', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, { status: 'in_progress' });

      const state = registry.get(id);
      expect(state!.status).toBe('in_progress');
    });

    it('should update progress information', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, {
        status: 'in_progress',
        progress: {
          currentStep: 5,
          totalSteps: 20,
          stage: 'diffusion',
          percentage: 25,
        },
      });

      const state = registry.get(id);
      expect(state!.progress).toBeDefined();
      expect(state!.progress!.currentStep).toBe(5);
      expect(state!.progress!.totalSteps).toBe(20);
      expect(state!.progress!.stage).toBe('diffusion');
      expect(state!.progress!.percentage).toBe(25);
    });

    it('should update result on completion', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, {
        status: 'complete',
        result: {
          images: [
            {
              image: 'base64data',
              seed: 42,
              width: 512,
              height: 512,
            },
          ],
          format: 'png',
          timeTaken: 5000,
        },
      });

      const state = registry.get(id);
      expect(state!.status).toBe('complete');
      expect(state!.result).toBeDefined();
      expect(state!.result!.images).toHaveLength(1);
      expect(state!.result!.images[0].seed).toBe(42);
    });

    it('should update error information', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, {
        status: 'error',
        error: {
          message: 'Generation failed',
          code: 'BACKEND_ERROR',
        },
      });

      const state = registry.get(id);
      expect(state!.status).toBe('error');
      expect(state!.error).toBeDefined();
      expect(state!.error!.message).toBe('Generation failed');
      expect(state!.error!.code).toBe('BACKEND_ERROR');
    });

    it('should update updatedAt timestamp', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      const initialState = registry.get(id);
      const initialUpdatedAt = initialState!.updatedAt;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      registry.update(id, { status: 'in_progress' });

      const updatedState = registry.get(id);
      expect(updatedState!.updatedAt).toBeGreaterThan(initialUpdatedAt);
    });

    it('should do nothing for non-existent ID', () => {
      registry.update('non_existent_id', { status: 'complete' });
      // Should not throw, just silently do nothing
      expect(registry.get('non_existent_id')).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should remove generation from registry', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      expect(registry.get(id)).toBeDefined();

      registry.delete(id);

      expect(registry.get(id)).toBeNull();
    });

    it('should handle deletion of non-existent ID gracefully', () => {
      registry.delete('non_existent_id');
      // Should not throw
    });
  });

  describe('getAllIds()', () => {
    it('should return empty array when no generations exist', () => {
      expect(registry.getAllIds()).toEqual([]);
    });

    it('should return all generation IDs', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id1 = registry.create(config);
      const id2 = registry.create(config);
      const id3 = registry.create(config);

      const ids = registry.getAllIds();

      expect(ids).toHaveLength(3);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).toContain(id3);
    });
  });

  describe('size()', () => {
    it('should return 0 when empty', () => {
      expect(registry.size()).toBe(0);
    });

    it('should return correct count of generations', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };

      registry.create(config);
      expect(registry.size()).toBe(1);

      registry.create(config);
      expect(registry.size()).toBe(2);

      registry.create(config);
      expect(registry.size()).toBe(3);
    });

    it('should decrease after deletion', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      expect(registry.size()).toBe(1);

      registry.delete(id);

      expect(registry.size()).toBe(0);
    });
  });

  describe('cleanup()', () => {
    it('should remove old completed generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, { status: 'complete' });

      expect(registry.get(id)).toBeDefined();

      // Wait for generation to age beyond TTL (50ms)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(1);
      expect(registry.get(id)).toBeNull();
    });

    it('should remove old errored generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, {
        status: 'error',
        error: { message: 'test error', code: 'TEST_ERROR' },
      });

      expect(registry.get(id)).toBeDefined();

      // Wait for generation to age beyond TTL (50ms)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(1);
      expect(registry.get(id)).toBeNull();
    });

    it('should NOT remove recent completed generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, { status: 'complete' });

      // Wait a short time (less than TTL)
      await new Promise((resolve) => setTimeout(resolve, 20));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(0);
      expect(registry.get(id)).toBeDefined();
    });

    it('should NOT remove pending generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      // Leave in pending state

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(0);
      expect(registry.get(id)).toBeDefined();
    });

    it('should NOT remove in_progress generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, { status: 'in_progress' });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(0);
      expect(registry.get(id)).toBeDefined();
    });

    it('should clean up multiple old generations', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };

      const id1 = registry.create(config);
      registry.update(id1, { status: 'complete' });

      const id2 = registry.create(config);
      registry.update(id2, { status: 'error', error: { message: '', code: '' } });

      const id3 = registry.create(config);
      registry.update(id3, { status: 'complete' });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleaned = registry.cleanup(50);

      expect(cleaned).toBe(3);
      expect(registry.size()).toBe(0);
    });

    it('should run automatically via interval', async () => {
      // Create registry with shorter interval for this test
      const testRegistry = new GenerationRegistry({
        maxResultAgeMs: 50,
        cleanupIntervalMs: 75,
      });

      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = testRegistry.create(config);

      testRegistry.update(id, { status: 'complete' });

      expect(testRegistry.get(id)).toBeDefined();

      // Wait for automatic cleanup to run (cleanup interval is 75ms)
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(testRegistry.get(id)).toBeNull();

      testRegistry.destroy();
    });
  });

  describe('clear()', () => {
    it('should remove all generations', () => {
      const config: ImageGenerationConfig = { prompt: 'test' };

      registry.create(config);
      registry.create(config);
      registry.create(config);

      expect(registry.size()).toBe(3);

      registry.clear();

      expect(registry.size()).toBe(0);
      expect(registry.getAllIds()).toEqual([]);
    });
  });

  describe('destroy()', () => {
    it('should stop cleanup interval', async () => {
      const config: ImageGenerationConfig = { prompt: 'test' };
      const id = registry.create(config);

      registry.update(id, { status: 'complete' });

      registry.destroy();

      // Wait for what would have been a cleanup cycle
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Generation should still be there since cleanup was stopped
      expect(registry.get(id)).toBeDefined();
    });
  });
});
