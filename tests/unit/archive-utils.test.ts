/**
 * Unit tests for archive-utils
 * Tests getArchiveExtension() for correct format detection
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

const mockMkdir = jest.fn();
const mockReaddir = jest.fn();
const mockRm = jest.fn();

jest.unstable_mockModule('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    readdir: mockReaddir,
    rm: mockRm,
  },
}));

type WorkerBehavior = { type: 'success'; files: string[] } | { type: 'failure'; message: string };
let workerBehavior: WorkerBehavior = { type: 'success', files: ['nested/runtime.dll'] };
const workerConstructorCalls: Array<{ source: string; options: Record<string, unknown> }> = [];

class MockWorker extends EventEmitter {
  constructor(source: string, options: Record<string, unknown>) {
    super();
    workerConstructorCalls.push({ source, options });
    setImmediate(() => {
      if (workerBehavior.type === 'success') {
        this.emit('message', {
          type: 'progress',
          completedEntries: 0,
          totalEntries: workerBehavior.files.length,
        });
        workerBehavior.files.forEach((entry, index) => {
          this.emit('message', {
            type: 'progress',
            completedEntries: index + 1,
            totalEntries: workerBehavior.files.length,
            entry,
          });
        });
        this.emit('message', { type: 'done', files: workerBehavior.files });
      } else {
        this.emit('message', { type: 'error', message: workerBehavior.message });
      }
      this.emit('exit', 0);
    });
  }
}

jest.unstable_mockModule('node:worker_threads', () => ({
  Worker: MockWorker,
}));

// Mock adm-zip (not used in these tests but required by module)
jest.unstable_mockModule('adm-zip', () => ({
  default: class MockAdmZip {
    extractAllTo = jest.fn();
  },
}));

// Mock tar (not used in these tests but required by module)
jest.unstable_mockModule('tar', () => ({
  x: jest.fn(),
}));

// Mock file-utils
jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: jest.fn(),
}));

// Mock errors
jest.unstable_mockModule('../../src/errors/index.js', () => ({
  FileSystemError: class FileSystemError extends Error {
    constructor(
      message: string,
      public details?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

// Import after mocking
const { extractArchive, getArchiveExtension } = await import('../../src/utils/archive-utils.js');

beforeEach(() => {
  jest.clearAllMocks();
  workerConstructorCalls.length = 0;
  workerBehavior = { type: 'success', files: ['nested/runtime.dll'] };
  mockMkdir.mockResolvedValue(undefined);
  mockReaddir.mockResolvedValue([]);
  mockRm.mockResolvedValue(undefined);
});

describe('getArchiveExtension()', () => {
  it('should return .tar.gz for .tar.gz URLs', () => {
    expect(getArchiveExtension('https://example.com/llama-b7956-bin-macos-arm64.tar.gz')).toBe(
      '.tar.gz'
    );
  });

  it('should return .tar.gz for .tgz URLs', () => {
    expect(getArchiveExtension('https://example.com/llama-b7956-bin-macos-arm64.tgz')).toBe(
      '.tar.gz'
    );
  });

  it('should return .zip for .zip URLs', () => {
    expect(getArchiveExtension('https://example.com/llama-b7956-bin-win-cpu-x64.zip')).toBe('.zip');
  });

  it('should return .zip for unknown extensions (safe default)', () => {
    expect(getArchiveExtension('https://example.com/binary-download')).toBe('.zip');
  });

  it('should be case-insensitive', () => {
    expect(getArchiveExtension('https://example.com/file.TAR.GZ')).toBe('.tar.gz');
    expect(getArchiveExtension('https://example.com/file.TGZ')).toBe('.tar.gz');
    expect(getArchiveExtension('https://example.com/file.ZIP')).toBe('.zip');
  });
});

describe('ZIP worker routing', () => {
  it('forwards worker progress and resolves only after its result exits', async () => {
    const progress: Array<{ completedEntries: number; totalEntries: number }> = [];

    await expect(
      extractArchive('/tmp/runtime.zip', '/tmp/extract', (event) => progress.push(event))
    ).resolves.toEqual(['nested/runtime.dll']);

    expect(progress).toEqual([
      { completedEntries: 0, totalEntries: 1, entry: undefined },
      { completedEntries: 1, totalEntries: 1, entry: 'nested/runtime.dll' },
    ]);
    expect(workerConstructorCalls).toHaveLength(1);
    expect(workerConstructorCalls[0]!.options).toMatchObject({
      eval: true,
      workerData: {
        archivePath: '/tmp/runtime.zip',
        extractTo: '/tmp/extract',
      },
    });
  });

  it('maps a worker failure through the archive error contract once', async () => {
    workerBehavior = { type: 'failure', message: 'central directory is corrupt' };

    await expect(extractArchive('/tmp/broken.zip', '/tmp/extract')).rejects.toThrow(
      'Failed to extract archive: /tmp/broken.zip'
    );
    expect(workerConstructorCalls).toHaveLength(1);
  });
});
