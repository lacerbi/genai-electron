/**
 * Unit tests for BinaryManager
 * Tests binary download and variant management
 */

import { jest } from '@jest/globals';
import type { BinaryVariantConfig } from '../../src/config/defaults.js';

// Mock Downloader
const mockDownload = jest.fn();
const mockCancel = jest.fn();

class MockDownloader {
  download = mockDownload;
  cancel = mockCancel;
  downloading = false;
}

jest.unstable_mockModule('../../src/download/Downloader.js', () => ({
  Downloader: MockDownloader,
}));

// Mock file-utils
const mockFileExists = jest.fn();
const mockEnsureDirectory = jest.fn();
const mockCalculateChecksum = jest.fn();
const mockDeleteFile = jest.fn();
const mockCopyDirectory = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: mockFileExists,
  ensureDirectory: mockEnsureDirectory,
  calculateChecksum: mockCalculateChecksum,
  deleteFile: mockDeleteFile,
  copyDirectory: mockCopyDirectory,
}));

// Mock zip-utils
const mockExtractLlamaServerBinary = jest.fn();
const mockCleanupExtraction = jest.fn();

jest.unstable_mockModule('../../src/utils/zip-utils.js', () => ({
  extractLlamaServerBinary: mockExtractLlamaServerBinary,
  cleanupExtraction: mockCleanupExtraction,
}));

// Mock paths config
const MOCK_PATHS = {
  binaries: {
    llama: '/mock/binaries/llama',
    diffusion: '/mock/binaries/diffusion',
  },
};

const mockGetBinaryPath = jest.fn();

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: MOCK_PATHS,
  getBinaryPath: mockGetBinaryPath,
}));

// Mock fs.promises
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockChmod = jest.fn();

jest.unstable_mockModule('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    chmod: mockChmod,
  },
}));

// Mock child_process with promisified version
const mockExecFileAsync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execFile: jest.fn(), // Original callback version (not used)
}));

// Mock util.promisify to return our async mock
jest.unstable_mockModule('util', () => ({
  promisify: (fn: any) => mockExecFileAsync,
}));

// Import after mocking
const { BinaryManager } = await import('../../src/managers/BinaryManager.js');
const { BinaryError } = await import('../../src/errors/index.js');

describe('BinaryManager', () => {
  // Sample variant configs for testing
  const cudaVariant: BinaryVariantConfig = {
    type: 'cuda',
    url: 'https://example.com/llama-cuda.zip',
    checksum: 'abc123cuda',
  };

  const cpuVariant: BinaryVariantConfig = {
    type: 'cpu',
    url: 'https://example.com/llama-cpu.zip',
    checksum: 'abc123cpu',
  };

  const vulkanVariant: BinaryVariantConfig = {
    type: 'vulkan',
    url: 'https://example.com/llama-vulkan.zip',
    checksum: 'abc123vulkan',
  };

  let binaryManager: BinaryManager;
  const mockLogger = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockFileExists.mockResolvedValue(false);
    mockEnsureDirectory.mockResolvedValue(undefined);
    // Return correct checksum based on which variant is being tested
    mockCalculateChecksum.mockImplementation(async (path: string) => {
      if (path.includes('.cuda.zip')) return 'abc123cuda';
      if (path.includes('.cpu.zip')) return 'abc123cpu';
      if (path.includes('.vulkan.zip')) return 'abc123vulkan';
      return 'abc123'; // Default
    });
    mockDeleteFile.mockResolvedValue(undefined);
    mockCopyDirectory.mockResolvedValue(undefined);
    mockExtractLlamaServerBinary.mockResolvedValue('/mock/extract/llama-server.exe');
    mockCleanupExtraction.mockResolvedValue(undefined);
    mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
    mockReadFile.mockRejectedValue(new Error('No cache'));
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockDownload.mockResolvedValue(undefined);
    // mockExecFileAsync setup moved to individual tests for better control

    binaryManager = new BinaryManager({
      type: 'llama',
      binaryName: 'llama-server',
      platformKey: 'win32-x64',
      variants: [cudaVariant, cpuVariant],
      log: mockLogger,
    });
  });

  describe('ensureBinary()', () => {
    it('should throw BinaryError when no variants are available', async () => {
      const emptyManager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [],
      });

      await expect(emptyManager.ensureBinary()).rejects.toThrow(BinaryError);
      await expect(emptyManager.ensureBinary()).rejects.toThrow(
        'No binary variants available for platform: win32-x64'
      );
    });

    it('should ensure binary directory exists', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      await binaryManager.ensureBinary();

      expect(mockEnsureDirectory).toHaveBeenCalledWith(MOCK_PATHS.binaries.llama);
    });

    it('should return existing binary path if binary works', async () => {
      mockFileExists.mockResolvedValue(true);
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockDownload).not.toHaveBeenCalled();
      expect(mockLogger).toHaveBeenCalledWith('Using existing binary', 'info');
    });

    it('should re-download if existing binary does not work', async () => {
      mockFileExists.mockResolvedValueOnce(true); // Binary exists
      mockExecFileAsync
        .mockRejectedValueOnce(new Error('Execution failed')) // First call (testBinary) fails
        .mockResolvedValue({ stdout: 'version 1.0', stderr: '' }); // Subsequent calls succeed

      const result = await binaryManager.ensureBinary();

      expect(mockDeleteFile).toHaveBeenCalledWith('/mock/binaries/llama/llama-server.exe');
      expect(mockDownload).toHaveBeenCalled();
      expect(mockLogger).toHaveBeenCalledWith(
        'Existing binary not working, re-downloading...',
        'warn'
      );
      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
    });

    it('should try variants in priority order when no cache exists', async () => {
      // First variant (CUDA) fails testBinary, second (CPU) succeeds
      let callCount = 0;
      mockExecFileAsync.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('CUDA not available'); // First call (CUDA) fails
        }
        return { stdout: 'version 1.0', stderr: '' }; // Subsequent calls succeed
      });

      const result = await binaryManager.ensureBinary();

      // Should have tried CUDA first, then CPU
      expect(mockDownload).toHaveBeenCalledTimes(2);
      expect(mockDownload).toHaveBeenNthCalledWith(1, {
        url: cudaVariant.url,
        destination: expect.stringContaining('.cuda.zip'),
        onProgress: expect.any(Function),
      });
      expect(mockDownload).toHaveBeenNthCalledWith(2, {
        url: cpuVariant.url,
        destination: expect.stringContaining('.cpu.zip'),
        onProgress: expect.any(Function),
      });
      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
    });

    it('should try cached variant first if cache exists', async () => {
      // Simulate cache pointing to 'cpu' variant
      mockReadFile.mockResolvedValue(
        JSON.stringify({ variant: 'cpu', platform: 'win32-x64' })
      );
      // Ensure testBinary succeeds for all calls
      mockExecFileAsync.mockImplementation(async () => {
        return { stdout: 'version 1.0', stderr: '' };
      });

      await binaryManager.ensureBinary();

      // Should try CPU first (cached), and it should succeed on first try
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledWith({
        url: cpuVariant.url,
        destination: expect.stringContaining('.cpu.zip'),
        onProgress: expect.any(Function),
      });
    });

    it('should write variant cache on successful download', async () => {
      await binaryManager.ensureBinary();

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.variant.json'),
        JSON.stringify({ variant: 'cuda', platform: 'win32-x64' }),
        'utf-8'
      );
    });

    it('should throw BinaryError if all variants fail', async () => {
      // Make all variants fail testBinary
      mockExecFileAsync.mockRejectedValue(new Error('No drivers available'));

      // Test the error (only call once to avoid double execution)
      await expect(binaryManager.ensureBinary()).rejects.toThrow(BinaryError);

      // Should have tried both variants
      expect(mockDownload).toHaveBeenCalledTimes(2);
    });

    it('should throw BinaryError with checksum mismatch', async () => {
      // Make checksum verification fail for ALL variants
      mockCalculateChecksum.mockResolvedValue('wrongchecksum');

      // Test the error (only call once)
      await expect(binaryManager.ensureBinary()).rejects.toThrow(BinaryError);
    });

    it('should call progress callback during download', async () => {
      const progressSpy = jest.fn();
      mockDownload.mockImplementation(async ({ onProgress }) => {
        if (onProgress) {
          onProgress(50, 100);
          onProgress(100, 100);
        }
      });

      await binaryManager.ensureBinary();

      // Logger should show progress
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Downloading cuda binary: 50.0%'),
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Downloading cuda binary: 100.0%'),
        'info'
      );
    });

    it('should call chmod on Unix-like systems', async () => {
      // Simulate Linux platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });

      await binaryManager.ensureBinary();

      expect(mockChmod).toHaveBeenCalledWith('/mock/binaries/llama/llama-server.exe', 0o755);

      // Restore platform
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should log messages when logger is provided', async () => {
      await binaryManager.ensureBinary();

      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Trying cuda variant'),
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Successfully installed cuda variant'),
        'info'
      );
    });
  });

  describe('downloadAndTestVariant()', () => {
    it('should cleanup on download failure', async () => {
      // Make download fail for ALL variants
      mockDownload.mockRejectedValue(new Error('Network error'));

      await expect(binaryManager.ensureBinary()).rejects.toThrow(BinaryError);
      await expect(binaryManager.ensureBinary()).rejects.toThrow(
        'Failed to download binary. Tried all variants'
      );

      // Should cleanup zip file for each variant attempted
      expect(mockDeleteFile).toHaveBeenCalled();
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });

    it('should cleanup on checksum failure', async () => {
      // Make checksum fail for ALL variants
      mockCalculateChecksum.mockResolvedValue('wrongchecksum');

      await expect(binaryManager.ensureBinary()).rejects.toThrow(BinaryError);

      // Should cleanup zip file for each variant attempted
      expect(mockDeleteFile).toHaveBeenCalled();
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });

    it('should cleanup on extraction failure', async () => {
      // Make extraction fail for ALL variants
      mockExtractLlamaServerBinary.mockRejectedValue(new Error('Extraction failed'));

      await expect(binaryManager.ensureBinary()).rejects.toThrow(BinaryError);
      await expect(binaryManager.ensureBinary()).rejects.toThrow(
        'Failed to download binary. Tried all variants'
      );

      // Should cleanup for each variant attempted
      expect(mockDeleteFile).toHaveBeenCalled();
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });
  });

  describe('testBinary()', () => {
    it('should return true when binary executes successfully', async () => {
      mockFileExists.mockResolvedValue(true);
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockLogger).toHaveBeenCalledWith('Using existing binary', 'info');
    });

    it('should return false when binary execution fails', async () => {
      mockFileExists.mockResolvedValue(true);
      // First call fails (existing binary check), subsequent calls succeed (after re-download)
      mockExecFileAsync
        .mockRejectedValueOnce(new Error('Missing CUDA drivers'))
        .mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      // Should re-download and succeed
      const result = await binaryManager.ensureBinary();

      expect(mockDeleteFile).toHaveBeenCalled();
      expect(mockDownload).toHaveBeenCalled();
      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
    });
  });

  describe('variant fallback behavior', () => {
    it('should successfully fall back from CUDA to CPU variant', async () => {
      // CUDA variant fails, CPU succeeds
      let callCount = 0;
      mockExecFileAsync.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('CUDA drivers not found'); // First call (CUDA) fails
        }
        return { stdout: 'version 1.0', stderr: '' }; // Subsequent calls succeed
      });

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      // testBinary catches errors and returns false, so no warning is logged
      // Only "Trying" and "Successfully installed" messages
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Trying cuda variant'),
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Trying cpu variant'),
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Successfully installed cpu variant'),
        'info'
      );
    });
  });
});
