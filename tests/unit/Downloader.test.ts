/**
 * Unit tests for Downloader
 * Tests file downloading with progress tracking
 */

import { jest } from '@jest/globals';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';

// Helper to create a mock ReadableStream (Web API, not Node.js)
function createMockReadableStream(chunks: Uint8Array[]) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Create a mock WriteStream class
class MockWriteStream extends Writable {
  path: string;

  constructor(path: string) {
    super();
    this.path = path;
  }

  _write(chunk: any, encoding: string, callback: Function) {
    // Simulate successful write
    callback();
  }
}

// Mock node:fs
const mockCreateWriteStream = jest.fn();
jest.unstable_mockModule('node:fs', () => ({
  createWriteStream: mockCreateWriteStream,
}));

// Mock file-utils
const mockMoveFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockFileExists = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  moveFile: mockMoveFile,
  deleteFile: mockDeleteFile,
  fileExists: mockFileExists,
}));

// Import after mocking
const { Downloader } = await import('../../src/download/Downloader.js');

describe('Downloader', () => {
  let downloader: Downloader;

  beforeEach(() => {
    jest.clearAllMocks();
    downloader = new Downloader();

    // Setup createWriteStream to return a mock stream
    mockCreateWriteStream.mockImplementation((path: string) => {
      return new MockWriteStream(path);
    });
  });

  describe('download()', () => {
    it('should download a file with progress callbacks', async () => {
      const progressCallback = jest.fn();
      const totalSize = 1000;
      const chunkSize = 100;

      // Mock fetch response with streaming body
      const chunks = Array(10).fill(0).map(() => new Uint8Array(chunkSize));
      const mockStream = createMockReadableStream(chunks);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => {
            if (name === 'content-length') return totalSize.toString();
            return null;
          },
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
        onProgress: progressCallback,
      });

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/file.bin', expect.any(Object));

      // Verify progress was reported
      expect(progressCallback).toHaveBeenCalled();

      // Verify file operations
      expect(mockCreateWriteStream).toHaveBeenCalledWith(expect.stringContaining('.partial'));
      expect(mockMoveFile).toHaveBeenCalledWith(
        expect.stringContaining('.partial'),
        '/test/output.bin'
      );
    });

    it('should handle download errors and cleanup partial files', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      mockDeleteFile.mockResolvedValue(undefined);
      mockFileExists.mockResolvedValue(true);

      await expect(
        downloader.download({
          url: 'https://example.com/file.bin',
          destination: '/test/output.bin',
        })
      ).rejects.toThrow('Download failed');

      // Verify cleanup was attempted
      expect(mockDeleteFile).toHaveBeenCalled();
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        downloader.download({
          url: 'https://example.com/missing.bin',
          destination: '/test/output.bin',
        })
      ).rejects.toThrow();
    });

    it('should create partial file during download', async () => {
      const mockStream = createMockReadableStream([new Uint8Array(100)]);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
      });

      // Verify .partial file was created
      const createStreamCall = mockCreateWriteStream.mock.calls[0];
      expect(createStreamCall[0]).toContain('.partial');
    });

    it('should move file to final destination on completion', async () => {
      const mockStream = createMockReadableStream([new Uint8Array(100)]);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
      });

      expect(mockMoveFile).toHaveBeenCalledWith(
        expect.stringContaining('.partial'),
        '/test/output.bin'
      );
    });

    it('should handle missing content-length header', async () => {
      const mockStream = createMockReadableStream([new Uint8Array(100)]);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: () => null, // No content-length
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
      });

      // Should still work, just without total size
      expect(mockCreateWriteStream).toHaveBeenCalled();
      expect(mockMoveFile).toHaveBeenCalled();
    });
  });

  describe('cancel()', () => {
    it('should cancel ongoing download', async () => {
      // Create a stream that will be interrupted
      let rejectRead: (reason: any) => void;
      const mockStream = {
        getReader() {
          return {
            read() {
              // Return a promise that can be rejected externally
              return new Promise((resolve, reject) => {
                rejectRead = reject;
                // Simulate slow download
                setTimeout(() => {
                  resolve({ done: false, value: new Uint8Array(100) });
                }, 10000);
              });
            },
          };
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '1000' : null),
        },
        body: mockStream as any,
      });

      mockDeleteFile.mockResolvedValue(undefined);
      mockFileExists.mockResolvedValue(true);

      const downloadPromise = downloader.download({
        url: 'https://example.com/large-file.bin',
        destination: '/test/output.bin',
      });

      // Cancel after a tiny delay
      await new Promise(resolve => setTimeout(resolve, 10));
      downloader.cancel();

      // Trigger abort by rejecting the read
      rejectRead!(new Error('AbortError'));

      // Download should reject
      await expect(downloadPromise).rejects.toThrow();

      // Cleanup should be called
      expect(mockDeleteFile).toHaveBeenCalled();
    });

    it('should do nothing if no download is in progress', () => {
      expect(() => downloader.cancel()).not.toThrow();
    });
  });

  describe('Progress tracking', () => {
    it('should report accurate progress percentages', async () => {
      const progressValues: number[] = [];
      const totalSize = 1000;

      const chunks = [
        new Uint8Array(100),
        new Uint8Array(100),
        new Uint8Array(100),
      ];
      const mockStream = createMockReadableStream(chunks);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? totalSize.toString() : null),
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
        onProgress: (downloaded, total) => {
          progressValues.push((downloaded / total) * 100);
        },
      });

      // Should have reported progress
      expect(progressValues.length).toBeGreaterThan(0);

      // All values should be between 0 and 100
      progressValues.forEach((value) => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      });
    });

    it('should handle progress callback errors gracefully', async () => {
      const failingCallback = jest.fn(() => {
        throw new Error('Callback error');
      });

      const mockStream = createMockReadableStream([new Uint8Array(100)]);

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockMoveFile.mockResolvedValue(undefined);

      // Should not throw even if callback fails
      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
        onProgress: failingCallback,
      });

      expect(failingCallback).toHaveBeenCalled();
      expect(mockMoveFile).toHaveBeenCalled();
    });
  });
});
