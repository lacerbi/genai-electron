/**
 * Unit tests for file-utils
 * Tests file system utility functions
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import crypto from 'crypto';

// Mock fs/promises
jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn(),
  },
  createReadStream: jest.fn(),
  constants: {
    F_OK: 0,
  },
}));

// Import after mocking
import {
  ensureDirectory,
  fileExists,
  formatBytes,
  sanitizeFilename,
} from '../../src/utils/file-utils.js';

describe('file-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('formatBytes()', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toBe('1.00 KB');
      expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
    });

    it('should handle decimals correctly', () => {
      expect(formatBytes(1536)).toBe('1.50 KB'); // 1.5 KB
      expect(formatBytes(2560 * 1024)).toBe('2.50 MB'); // 2.5 MB
    });

    it('should handle negative numbers', () => {
      expect(formatBytes(-1024)).toBe('-1.00 KB');
    });
  });

  describe('sanitizeFilename()', () => {
    it('should remove invalid characters', () => {
      expect(sanitizeFilename('file<name>.txt')).toBe('filename.txt');
      expect(sanitizeFilename('file|name.txt')).toBe('filename.txt');
      expect(sanitizeFilename('file:name.txt')).toBe('filename.txt');
      expect(sanitizeFilename('file"name".txt')).toBe('filename.txt');
    });

    it('should handle path separators', () => {
      expect(sanitizeFilename('path/to/file.txt')).toBe('pathtofile.txt');
      expect(sanitizeFilename('path\\to\\file.txt')).toBe('pathtofile.txt');
    });

    it('should handle special characters', () => {
      expect(sanitizeFilename('file*name?.txt')).toBe('filename.txt');
      expect(sanitizeFilename('file<>name.txt')).toBe('filename.txt');
    });

    it('should preserve valid characters', () => {
      expect(sanitizeFilename('valid-file_name.txt')).toBe('valid-file_name.txt');
      expect(sanitizeFilename('file (1).txt')).toBe('file (1).txt');
    });

    it('should handle empty strings', () => {
      expect(sanitizeFilename('')).toBe('');
    });
  });

  describe('ensureDirectory()', () => {
    it('should create directory if it does not exist', async () => {
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;

      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockMkdir.mockResolvedValue(undefined);

      await ensureDirectory('/test/path');

      expect(mockAccess).toHaveBeenCalledWith('/test/path');
      expect(mockMkdir).toHaveBeenCalledWith('/test/path', { recursive: true });
    });

    it('should not create directory if it already exists', async () => {
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;

      mockAccess.mockResolvedValue(undefined);

      await ensureDirectory('/test/path');

      expect(mockAccess).toHaveBeenCalledWith('/test/path');
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('should throw error if mkdir fails', async () => {
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;

      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(ensureDirectory('/test/path')).rejects.toThrow();
    });
  });

  describe('fileExists()', () => {
    it('should return true if file exists', async () => {
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      mockAccess.mockResolvedValue(undefined);

      const exists = await fileExists('/test/file.txt');

      expect(exists).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith('/test/file.txt');
    });

    it('should return false if file does not exist', async () => {
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const exists = await fileExists('/test/file.txt');

      expect(exists).toBe(false);
    });
  });
});
