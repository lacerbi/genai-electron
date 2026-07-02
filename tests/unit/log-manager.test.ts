/**
 * Unit tests for LogManager rotation
 * Uses the real filesystem in a temp directory (LogManager takes a plain path)
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogManager } from '../../src/process/log-manager.js';

describe('LogManager rotation', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'genai-log-test-'));
    logPath = path.join(tempDir, 'server.log');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };

  it('should rotate when the file exceeds maxFileSize, keeping archives', async () => {
    // Each formatted entry is ~60 bytes; rotate after ~2 entries
    const logger = new LogManager(logPath, { maxFileSize: 150, maxArchives: 2 });
    await logger.initialize();

    for (let i = 0; i < 10; i++) {
      await logger.write(`message number ${i}`, 'info');
    }

    expect(await exists(logPath)).toBe(true);
    expect(await exists(`${logPath}.1`)).toBe(true);
    expect(await exists(`${logPath}.2`)).toBe(true);
    // No archive beyond maxArchives
    expect(await exists(`${logPath}.3`)).toBe(false);

    // Current file stays under the cap (plus one entry of slack)
    const stat = await fs.stat(logPath);
    expect(stat.size).toBeLessThanOrEqual(150 + 80);
  });

  it('should preserve the newest rotated content in .1', async () => {
    const logger = new LogManager(logPath, { maxFileSize: 120, maxArchives: 1 });
    await logger.initialize();

    await logger.write('first', 'info');
    await logger.write('second', 'info');
    await logger.write('third', 'info'); // triggers rotation at some point
    await logger.write('fourth', 'info');

    const archived = await fs.readFile(`${logPath}.1`, 'utf8').catch(() => '');
    const current = await fs.readFile(logPath, 'utf8');
    // Everything written must live in either the current file or the archive
    const combined = archived + current;
    for (const msg of ['first', 'second', 'third', 'fourth']) {
      expect(combined).toContain(msg);
    }
  });

  it('should truncate instead of archiving when maxArchives is 0', async () => {
    const logger = new LogManager(logPath, { maxFileSize: 100, maxArchives: 0 });
    await logger.initialize();

    for (let i = 0; i < 6; i++) {
      await logger.write(`entry ${i}`, 'info');
    }

    expect(await exists(`${logPath}.1`)).toBe(false);
    const stat = await fs.stat(logPath);
    expect(stat.size).toBeLessThanOrEqual(100 + 80);
  });

  it('should not rotate when under the size cap', async () => {
    const logger = new LogManager(logPath, { maxFileSize: 1024 * 1024, maxArchives: 2 });
    await logger.initialize();

    await logger.write('one', 'info');
    await logger.write('two', 'info');

    expect(await exists(`${logPath}.1`)).toBe(false);
    const recent = await logger.getRecent(10);
    expect(recent).toHaveLength(2);
  });

  it('should pick up the existing file size on initialize', async () => {
    // Pre-existing large file rotates on the first write
    await fs.writeFile(logPath, 'x'.repeat(200), 'utf8');
    const logger = new LogManager(logPath, { maxFileSize: 150, maxArchives: 1 });
    await logger.initialize();

    await logger.write('fresh entry', 'info');

    expect(await exists(`${logPath}.1`)).toBe(true);
    const current = await fs.readFile(logPath, 'utf8');
    expect(current).toContain('fresh entry');
    expect(current).not.toContain('xxx');
  });

  it('clear() resets the size bookkeeping', async () => {
    const logger = new LogManager(logPath, { maxFileSize: 150, maxArchives: 1 });
    await logger.initialize();

    await logger.write('some message', 'info');
    await logger.clear();
    await logger.write('after clear', 'info');

    // No rotation should have happened from stale bookkeeping
    expect(await exists(`${logPath}.1`)).toBe(false);
    const recent = await logger.getRecent(10);
    expect(recent).toHaveLength(1);
  });
});
