/**
 * Unit tests for port-utils
 * Uses real loopback sockets (fast, no external dependencies)
 */

import net from 'node:net';
import { findFreePort, isPortBindable } from '../../src/process/port-utils.js';

describe('port-utils', () => {
  describe('findFreePort()', () => {
    it('should return a valid, currently bindable port', async () => {
      const port = await findFreePort();

      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
      await expect(isPortBindable(port)).resolves.toBe(true);
    });

    it('should return different ports across concurrent holds', async () => {
      // Hold a server on one free port, then ask for another
      const first = await findFreePort();
      const holder = net.createServer();
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(first, '127.0.0.1', () => resolve());
      });

      try {
        const second = await findFreePort();
        expect(second).not.toBe(first);
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });
  });

  describe('isPortBindable()', () => {
    it('should return false for an occupied port', async () => {
      const port = await findFreePort();
      const holder = net.createServer();
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(port, '127.0.0.1', () => resolve());
      });

      try {
        await expect(isPortBindable(port)).resolves.toBe(false);
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });

    it('should return true for a free port', async () => {
      const port = await findFreePort();
      await expect(isPortBindable(port)).resolves.toBe(true);
    });
  });
});
