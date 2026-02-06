/**
 * Unit tests for archive-utils
 * Tests getArchiveExtension() for correct format detection
 */

import { jest } from '@jest/globals';

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
const { getArchiveExtension } = await import('../../src/utils/archive-utils.js');

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
