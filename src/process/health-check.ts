/**
 * Health Check Utilities
 *
 * Utilities for checking HTTP server health and waiting for servers to become ready.
 * Implements exponential backoff retry logic for robust health checking.
 *
 * @module process/health-check
 */

import type { HealthStatus } from '../types/index.js';
import { ServerError } from '../errors/index.js';

/**
 * Health check response from llama-server
 */
export interface HealthCheckResponse {
  /** Health status: 'ok', 'loading', 'error', or 'unknown' */
  status: HealthStatus;
  /** Additional server information (optional) */
  [key: string]: unknown;
}

/**
 * Check server health at the given port
 *
 * Makes a GET request to http://127.0.0.1:{port}/health and parses the response.
 * Uses 127.0.0.1 rather than localhost: on Windows, localhost resolves to ::1 first
 * and llama-server binds IPv4 loopback only, costing ~2s IPv6 fallback per request.
 *
 * @param port - Server port to check
 * @param timeout - Request timeout in milliseconds (default: 5000)
 * @returns Health check response
 *
 * @example
 * ```typescript
 * const health = await checkHealth(8080);
 * if (health.status === 'ok') {
 *   console.log('Server is healthy');
 * }
 * ```
 */
export async function checkHealth(
  port: number,
  timeout = 5000,
  host = '127.0.0.1'
): Promise<HealthCheckResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: 'error' };
    }

    // Try to parse JSON response
    try {
      const data = (await response.json()) as HealthCheckResponse;
      // Validate status field
      if (
        data.status === 'ok' ||
        data.status === 'loading' ||
        data.status === 'error' ||
        data.status === 'unknown'
      ) {
        return data;
      }
      // Invalid status, default to unknown
      return { ...data, status: 'unknown' };
    } catch {
      // Failed to parse JSON - server might not be llama-server
      return { status: response.status === 200 ? 'ok' : 'unknown' };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        // Timeout
        return { status: 'unknown' };
      }
      // Network error (server not running or unreachable)
      return { status: 'unknown' };
    }
    return { status: 'unknown' };
  }
}

/**
 * Wait for server to become healthy
 *
 * Polls the health endpoint with exponential backoff until the server reports 'ok' status
 * or the timeout is reached.
 *
 * @param port - Server port to check
 * @param timeout - Total timeout in milliseconds (default: 60000 = 1 minute)
 * @param initialDelay - Initial delay between checks in milliseconds (default: 100)
 * @param maxDelay - Maximum delay between checks in milliseconds (default: 2000)
 * @returns Promise that resolves when server is healthy
 * @throws {ServerError} If timeout is reached before server becomes healthy
 *
 * @example
 * ```typescript
 * // Wait up to 60 seconds for server to be ready
 * await waitForHealthy(8080, 60000);
 * console.log('Server is ready!');
 * ```
 */
export async function waitForHealthy(
  port: number,
  timeout = 120000,
  initialDelay = 100,
  maxDelay = 2000,
  host = '127.0.0.1'
): Promise<void> {
  const startTime = Date.now();
  let delay = initialDelay;
  let attempt = 0;

  while (Date.now() - startTime < timeout) {
    attempt++;

    try {
      const health = await checkHealth(port, 5000, host);

      if (health.status === 'ok') {
        return; // Success!
      }

      // Server responded but not ready yet (loading)
      if (health.status === 'loading') {
        // Continue waiting
      } else if (health.status === 'error') {
        // Server reported error - might recover, keep trying
      }
      // 'unknown' means server didn't respond - keep trying
    } catch {
      // Health check failed - server might not be up yet
    }

    // Wait before next attempt (exponential backoff)
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Increase delay for next attempt (exponential backoff with max cap)
    delay = Math.min(delay * 1.5, maxDelay);

    // Check if we've exceeded timeout
    if (Date.now() - startTime >= timeout) {
      throw new ServerError(
        `Server health check timeout after ${timeout}ms (${attempt} attempts)`,
        {
          port,
          timeout,
          attempts: attempt,
          suggestion: 'Check server logs for startup errors or increase timeout',
        }
      );
    }
  }

  // Should not reach here, but just in case
  throw new ServerError(`Server health check timeout after ${timeout}ms`, {
    port,
    timeout,
    attempts: attempt,
  });
}

/**
 * Check if server is responding (simple ping without status validation)
 *
 * Useful for checking if a port is in use or if a server is listening.
 *
 * @param port - Server port to check
 * @param timeout - Request timeout in milliseconds (default: 2000)
 * @returns True if server responds, false otherwise
 *
 * @example
 * ```typescript
 * if (await isServerResponding(8080)) {
 *   console.log('Port 8080 is in use');
 * }
 * ```
 */
export async function isServerResponding(
  port: number,
  timeout = 2000,
  host = '127.0.0.1'
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Normalize a configured bind host into a host suitable for health checks
 *
 * Wildcard binds (0.0.0.0, ::) are reachable via loopback, so health checks
 * target 127.0.0.1 for them; undefined/empty falls back to 127.0.0.1
 * (llama-server's own default bind).
 *
 * @param host - Configured bind host (ServerConfig.host)
 * @returns Host to use in health-check URLs
 */
export function normalizeHealthHost(host?: string): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }
  return host;
}
