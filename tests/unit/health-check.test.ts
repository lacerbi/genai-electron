/**
 * Unit tests for health-check utilities
 * Tests HTTP health checking with retry logic
 */

import { jest } from '@jest/globals';

// Mock fetch (save original for cleanup)
const originalFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Import after mocking
const { checkHealth, waitForHealthy, isServerResponding } = await import(
  '../../src/process/health-check.js'
);
const { ServerError } = await import('../../src/errors/index.js');

describe('health-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterAll(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('checkHealth()', () => {
    it('should return status "ok" on successful health check', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', model: 'llama-2-7b' }),
      });

      const result = await checkHealth(8080);

      expect(result.status).toBe('ok');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/health',
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        })
      );
    });

    it('should return status "error" on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal error' }),
      });

      const result = await checkHealth(8080);

      expect(result.status).toBe('error');
    });

    it('should return status "unknown" on timeout', async () => {
      mockFetch.mockImplementation(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          }, 10);
        });
      });

      const result = await checkHealth(8080, 50);

      expect(result.status).toBe('unknown');
    });

    it('should return status "unknown" on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await checkHealth(8080);

      expect(result.status).toBe('unknown');
    });

    it('should preserve valid status values from response', async () => {
      const statuses = ['ok', 'loading', 'error', 'unknown'] as const;

      for (const status of statuses) {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ status }),
        });

        const result = await checkHealth(8080);
        expect(result.status).toBe(status);
      }
    });

    it('should default to "unknown" for invalid status values', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'invalid-status' }),
      });

      const result = await checkHealth(8080);

      expect(result.status).toBe('unknown');
    });

    it('should return status "ok" for 200 response without JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Not JSON');
        },
      });

      const result = await checkHealth(8080);

      expect(result.status).toBe('ok');
    });

    it('should return status "error" for non-200 response without JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Not JSON');
        },
      });

      const result = await checkHealth(8080);

      expect(result.status).toBe('error');
    });

    it('should respect custom timeout parameter', async () => {
      let aborted = false;
      mockFetch.mockImplementation((url, options) => {
        return new Promise((resolve, reject) => {
          const signal = options?.signal as AbortSignal;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      });

      // Start check with 100ms timeout
      const promise = checkHealth(8080, 100);

      // Wait for timeout to occur
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await promise;

      expect(aborted).toBe(true);
      expect(result.status).toBe('unknown');
    });
  });

  describe('waitForHealthy()', () => {
    it('should return immediately when server is healthy', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });

      const startTime = Date.now();
      await waitForHealthy(8080, 5000, 100, 2000);
      const duration = Date.now() - startTime;

      // Should complete almost immediately (within 100ms)
      expect(duration).toBeLessThan(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry when server status is "loading"', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            status: callCount < 3 ? 'loading' : 'ok',
          }),
        });
      });

      await waitForHealthy(8080, 5000, 50, 500);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should retry when server status is "error"', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            status: callCount < 2 ? 'error' : 'ok',
          }),
        });
      });

      await waitForHealthy(8080, 5000, 50, 500);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry when server status is "unknown"', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' }),
        });
      });

      await waitForHealthy(8080, 5000, 50, 500);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw ServerError on timeout', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'loading' }),
      });

      await expect(waitForHealthy(8080, 500, 100, 200)).rejects.toThrow(ServerError);
      await expect(waitForHealthy(8080, 500, 100, 200)).rejects.toThrow(
        /Server health check timeout after 500ms/
      );
    });

    it('should include attempt count in timeout error', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'loading' }),
      });

      try {
        await waitForHealthy(8080, 500, 100, 200);
        fail('Should have thrown ServerError');
      } catch (error) {
        expect(error).toBeInstanceOf(ServerError);
        if (error instanceof ServerError) {
          expect(error.details).toMatchObject({
            port: 8080,
            timeout: 500,
            attempts: expect.any(Number),
          });
          expect((error.details as any).attempts).toBeGreaterThan(0);
        }
      }
    });

    it('should implement exponential backoff', async () => {
      jest.useFakeTimers();
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            status: callCount < 4 ? 'loading' : 'ok',
          }),
        });
      });

      const promise = waitForHealthy(8080, 10000, 100, 2000);

      // First call happens immediately
      await jest.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call after 100ms (initial delay)
      await jest.advanceTimersByTimeAsync(100);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Third call after 150ms (100 * 1.5)
      await jest.advanceTimersByTimeAsync(150);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Fourth call after 225ms (150 * 1.5)
      await jest.advanceTimersByTimeAsync(225);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      await promise;
      jest.useRealTimers();
    });

    it('should cap delay at maxDelay', async () => {
      jest.useFakeTimers();
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            status: callCount < 10 ? 'loading' : 'ok',
          }),
        });
      });

      const promise = waitForHealthy(8080, 20000, 100, 500);

      // Advance through multiple attempts
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(i === 0 ? 0 : 500);
      }

      await promise;

      // Verify max delay was enforced by checking we made all attempts
      expect(mockFetch).toHaveBeenCalledTimes(10);

      jest.useRealTimers();
    });
  });

  describe('isServerResponding()', () => {
    it('should return true when server responds with ok status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await isServerResponding(8080);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/health',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should return false on timeout', async () => {
      mockFetch.mockImplementation(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          }, 10);
        });
      });

      const result = await isServerResponding(8080, 50);

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await isServerResponding(8080);

      expect(result).toBe(false);
    });

    it('should return false when server responds with error status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await isServerResponding(8080);

      expect(result).toBe(false);
    });

    it('should respect custom timeout parameter', async () => {
      let aborted = false;
      mockFetch.mockImplementation((url, options) => {
        return new Promise((resolve, reject) => {
          const signal = options?.signal as AbortSignal;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      });

      // Start check with 100ms timeout
      const promise = isServerResponding(8080, 100);

      // Wait for timeout to occur
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await promise;

      expect(aborted).toBe(true);
      expect(result).toBe(false);
    });
  });
});
