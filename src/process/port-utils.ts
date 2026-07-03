/**
 * Port allocation utilities
 *
 * @module process/port-utils
 */

import net from 'node:net';

/**
 * Find a free TCP port by binding to port 0 (OS-assigned)
 *
 * Note: there is an unavoidable race window between releasing the probe
 * socket and the server binding the port; callers should treat the result
 * as a strong hint, not a reservation.
 *
 * @param host - Host/interface to bind on (default: 127.0.0.1)
 * @returns A currently free port number
 *
 * @example
 * ```typescript
 * const port = await findFreePort();
 * await llamaServer.start({ modelId: 'my-model', port });
 * ```
 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a free port')));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Check whether a TCP port can be bound on the given host
 *
 * Catches ANY occupant of the port (not just HTTP servers), unlike an
 * HTTP-probe based check.
 *
 * @param port - Port number to test
 * @param host - Host/interface to bind on (default: 127.0.0.1)
 * @returns True if a bind succeeds (port is free)
 */
export function isPortBindable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}
