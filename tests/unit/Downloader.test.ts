/**
 * Unit tests for Downloader
 * Tests file downloading with progress tracking
 */

import { jest } from '@jest/globals';
import { Readable } from 'stream';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock fs/promises
const mockWriteFile = jest.fn();
jest.unstable_mockModule('fs/promises', () => ({
  writeFile: mockWriteFile,
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
  });

  describe('download()', () => {
    it('should download a file with progress callbacks', async () => {
      const progressCallback = jest.fn();
      const totalSize = 1000;
      const chunkSize = 100;

      // Mock fetch response with streaming body
      const chunks = Array(10).fill(new Uint8Array(chunkSize));
      let chunkIndex = 0;

      const mockStream = new Readable({
        read() {
          if (chunkIndex < chunks.length) {
            this.push(chunks[chunkIndex++]);
          } else {
            this.push(null);
          }
        },
      });

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

      mockWriteFile.mockResolvedValue(undefined);
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
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockMoveFile).toHaveBeenCalledWith(
        expect.stringContaining('.partial'),
        '/test/output.bin'
      );
    });

    it('should handle download errors and cleanup partial files', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      mockDeleteFile.mockResolvedValue(undefined);

      await expect(
        downloader.download({
          url: 'https://example.com/file.bin',
          destination: '/test/output.bin',
        })
      ).rejects.toThrow('Network error');

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
      const mockStream = new Readable({
        read() {
          this.push(new Uint8Array(100));
          this.push(null);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
      });

      // Verify .partial file was created
      const writeFileCall = mockWriteFile.mock.calls[0];
      expect(writeFileCall[0]).toContain('.partial');
    });

    it('should move file to final destination on completion', async () => {
      const mockStream = new Readable({
        read() {
          this.push(new Uint8Array(100));
          this.push(null);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
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
      const mockStream = new Readable({
        read() {
          this.push(new Uint8Array(100));
          this.push(null);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: () => null, // No content-length
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
      mockMoveFile.mockResolvedValue(undefined);

      await downloader.download({
        url: 'https://example.com/file.bin',
        destination: '/test/output.bin',
      });

      // Should still work, just without total size
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockMoveFile).toHaveBeenCalled();
    });
  });

  describe('cancel()', () => {
    it('should cancel ongoing download', async () => {
      const mockStream = new Readable({
        read() {
          // Never push data, simulating a slow download
          setTimeout(() => this.push(new Uint8Array(100)), 10000);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '1000' : null),
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
      mockDeleteFile.mockResolvedValue(undefined);

      const downloadPromise = downloader.download({
        url: 'https://example.com/large-file.bin',
        destination: '/test/output.bin',
      });

      // Cancel immediately
      downloader.cancel();

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

      const mockStream = new Readable({
        read() {
          this.push(new Uint8Array(100));
          this.push(new Uint8Array(100));
          this.push(new Uint8Array(100));
          this.push(null);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? totalSize.toString() : null),
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
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

      const mockStream = new Readable({
        read() {
          this.push(new Uint8Array(100));
          this.push(null);
        },
      });

      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '100' : null),
        },
        body: mockStream as any,
      });

      mockWriteFile.mockResolvedValue(undefined);
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
