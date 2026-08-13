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

type WorkerBehavior =
  | { type: 'success'; files: string[] }
  | { type: 'failure'; message: string }
  | { type: 'exit'; code: number };
let workerBehavior: WorkerBehavior = { type: 'success', files: ['nested/runtime.dll'] };
const workerConstructorCalls: Array<{ source: string; options: Record<string, unknown> }> = [];
let workerExitCode = 0;
let autoExitWorker = true;
let workerTerminateCalls = 0;
let latestWorker: MockWorker | undefined;

class MockWorker extends EventEmitter {
  constructor(source: string, options: Record<string, unknown>) {
    super();
    latestWorker = this;
    workerConstructorCalls.push({ source, options });
    const behavior = workerBehavior;
    setImmediate(() => {
      if (behavior.type === 'success') {
        this.emit('message', {
          type: 'progress',
          completedEntries: 0,
          totalEntries: behavior.files.length,
          writtenBytes: 0,
          totalUncompressedBytes: behavior.files.length * 100,
        });
        behavior.files.forEach((entry, index) => {
          this.emit('message', {
            type: 'progress',
            completedEntries: index + 1,
            totalEntries: behavior.files.length,
            writtenBytes: (index + 1) * 100,
            totalUncompressedBytes: behavior.files.length * 100,
            entry,
          });
        });
        this.emit('message', { type: 'done', files: behavior.files });
      } else {
        if (behavior.type === 'failure') {
          this.emit('message', { type: 'error', message: behavior.message });
        } else {
          this.emit('exit', behavior.code);
          return;
        }
      }
      if (autoExitWorker) {
        this.emit('exit', workerExitCode);
      }
    });
  }

  terminate(): Promise<number> {
    workerTerminateCalls++;
    return Promise.resolve(workerExitCode);
  }
}

jest.unstable_mockModule('node:worker_threads', () => ({
  Worker: MockWorker,
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
  workerExitCode = 0;
  autoExitWorker = true;
  workerTerminateCalls = 0;
  latestWorker = undefined;
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
    let settlingCalls = 0;

    await expect(
      extractArchive(
        '/tmp/runtime.zip',
        '/tmp/extract',
        (event) => progress.push(event),
        () => {
          settlingCalls++;
        }
      )
    ).resolves.toEqual(['nested/runtime.dll']);

    expect(progress).toEqual([
      {
        completedEntries: 0,
        totalEntries: 1,
        writtenBytes: 0,
        totalUncompressedBytes: 100,
        entry: undefined,
      },
      {
        completedEntries: 1,
        totalEntries: 1,
        writtenBytes: 100,
        totalUncompressedBytes: 100,
        entry: 'nested/runtime.dll',
      },
    ]);
    expect(workerConstructorCalls).toHaveLength(1);
    const workerCall = workerConstructorCalls[0]!;
    expect(workerCall.options).toEqual({
      eval: true,
      workerData: {
        archivePath: '/tmp/runtime.zip',
        extractTo: '/tmp/extract',
        admZipGlobalKey: '__genai_electron_adm_zip_0_6_0__',
      },
    });
    expect(workerCall.source).toContain('adm-zip 0.6.0 embedded by genai-electron');
    expect(workerCall.source).not.toContain('admZipModuleUrl');
    expect(settlingCalls).toBe(1);
    expect(workerTerminateCalls).toBe(1);
  });

  it('isolates a throwing worker-settling callback from successful extraction', async () => {
    await expect(
      extractArchive('/tmp/runtime.zip', '/tmp/extract', undefined, () => {
        throw new Error('consumer settlement callback failure');
      })
    ).resolves.toEqual(['nested/runtime.dll']);
    expect(workerTerminateCalls).toBe(1);
  });

  it('waits for the intentional termination exit before resolving a successful result', async () => {
    autoExitWorker = false;
    workerExitCode = 1;
    let settled = false;

    const extraction = extractArchive('/tmp/runtime.zip', '/tmp/extract').finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(workerTerminateCalls).toBe(1);
    expect(settled).toBe(false);
    latestWorker?.emit('exit', 1);
    await expect(extraction).resolves.toEqual(['nested/runtime.dll']);
    expect(settled).toBe(true);
  });

  it('rejects an abnormal non-zero exit after a successful result', async () => {
    workerExitCode = 2;

    await expect(extractArchive('/tmp/runtime.zip', '/tmp/extract')).rejects.toThrow(
      'Failed to extract archive: /tmp/runtime.zip'
    );
    expect(workerTerminateCalls).toBe(1);
  });

  it('rejects an unexpected non-zero exit before a result', async () => {
    workerBehavior = { type: 'exit', code: 2 };

    await expect(extractArchive('/tmp/runtime.zip', '/tmp/extract')).rejects.toThrow(
      'Failed to extract archive: /tmp/runtime.zip'
    );
    expect(workerTerminateCalls).toBe(0);
  });

  it('maps a worker failure through the archive error contract once', async () => {
    workerBehavior = { type: 'failure', message: 'central directory is corrupt' };

    await expect(extractArchive('/tmp/broken.zip', '/tmp/extract')).rejects.toThrow(
      'Failed to extract archive: /tmp/broken.zip'
    );
    expect(workerConstructorCalls).toHaveLength(1);
    expect(workerTerminateCalls).toBe(0);
  });
});
