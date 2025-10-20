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
const mockExtractBinary = jest.fn();
const mockCleanupExtraction = jest.fn();

jest.unstable_mockModule('../../src/utils/zip-utils.js', () => ({
  extractBinary: mockExtractBinary,
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
const mockMkdir = jest.fn();

jest.unstable_mockModule('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    chmod: mockChmod,
    mkdir: mockMkdir,
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

// Mock gpu-detect
const mockDetectGPU = jest.fn();
jest.unstable_mockModule('../../src/system/gpu-detect.js', () => ({
  detectGPU: mockDetectGPU,
}));

// Mock adm-zip
const mockExtractAllTo = jest.fn();
class MockAdmZip {
  extractAllTo = mockExtractAllTo;
}
jest.unstable_mockModule('adm-zip', () => ({
  default: MockAdmZip,
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
    mockExtractBinary.mockResolvedValue('/mock/extract/llama-server.exe');
    mockCleanupExtraction.mockResolvedValue(undefined);
    mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
    mockReadFile.mockRejectedValue(new Error('No cache'));
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockDownload.mockResolvedValue(undefined);
    mockExtractAllTo.mockReturnValue(undefined);
    // mockExecFileAsync setup moved to individual tests for better control

    // Default: Mock CUDA GPU detected (to not filter CUDA variants in most tests)
    mockDetectGPU.mockResolvedValue({
      available: true,
      type: 'nvidia',
      cuda: true,
    });

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
      mockReadFile.mockResolvedValue(JSON.stringify({ variant: 'cpu', platform: 'win32-x64' }));
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
      mockExtractBinary.mockRejectedValue(new Error('Extraction failed'));

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

  describe('CUDA GPU detection filtering', () => {
    it('should skip CUDA variants when no CUDA GPU is detected', async () => {
      // Mock detectGPU to return no CUDA support
      mockDetectGPU.mockResolvedValue({
        available: false,
      });

      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      const result = await binaryManager.ensureBinary();

      // Should only try CPU variant (CUDA filtered out)
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledWith({
        url: cpuVariant.url,
        destination: expect.stringContaining('.cpu.zip'),
        onProgress: expect.any(Function),
      });
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Skipping CUDA variants'),
        'info'
      );
      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
    });

    it('should try CUDA variants when CUDA GPU is detected', async () => {
      // Mock detectGPU to return CUDA support
      mockDetectGPU.mockResolvedValue({
        available: true,
        type: 'nvidia',
        cuda: true,
        name: 'NVIDIA RTX 4090',
      });

      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      const result = await binaryManager.ensureBinary();

      // Should try CUDA variant (not filtered)
      expect(mockDownload).toHaveBeenCalledWith({
        url: cudaVariant.url,
        destination: expect.stringContaining('.cuda.zip'),
        onProgress: expect.any(Function),
      });
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('CUDA GPU detected'),
        'info'
      );
      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
    });

    it('should skip CUDA variants when non-CUDA GPU is detected', async () => {
      // Mock detectGPU to return AMD GPU (no CUDA)
      mockDetectGPU.mockResolvedValue({
        available: true,
        type: 'amd',
        rocm: true,
        name: 'AMD Radeon RX 7900',
      });

      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      await binaryManager.ensureBinary();

      // Should skip CUDA, try CPU
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Skipping CUDA variants'),
        'info'
      );
      expect(mockDownload).toHaveBeenCalledWith({
        url: cpuVariant.url,
        destination: expect.stringContaining('.cpu.zip'),
        onProgress: expect.any(Function),
      });
    });
  });

  describe('dependency downloads', () => {
    const cudaVariantWithDeps: BinaryVariantConfig = {
      type: 'cuda',
      url: 'https://example.com/llama-cuda.zip',
      checksum: 'abc123cuda',
      dependencies: [
        {
          url: 'https://example.com/cudart.zip',
          checksum: 'def456cudart',
          description: 'CUDA runtime libraries',
        },
      ],
    };

    beforeEach(() => {
      // Don't clear all mocks - just reset specific ones needed for this suite
      // Clearing all mocks would break mockExecFileAsync setup

      // Mock CUDA GPU detected (default is already set in main beforeEach, but we make it explicit here)
      mockDetectGPU.mockResolvedValue({
        available: true,
        type: 'nvidia',
        cuda: true,
      });

      mockFileExists.mockResolvedValue(false);
      mockEnsureDirectory.mockResolvedValue(undefined);
      mockCalculateChecksum.mockImplementation(async (path: string) => {
        if (path.includes('.dep0.zip')) return 'def456cudart';
        if (path.includes('.cuda.zip')) return 'abc123cuda';
        if (path.includes('.cpu.zip')) return 'abc123cpu';
        return 'abc123';
      });
      mockDeleteFile.mockResolvedValue(undefined);
      mockCopyDirectory.mockResolvedValue(undefined);
      mockExtractBinary.mockResolvedValue('/mock/extract/llama-server.exe');
      mockCleanupExtraction.mockResolvedValue(undefined);
      mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
      mockReadFile.mockRejectedValue(new Error('No cache'));
      mockWriteFile.mockResolvedValue(undefined);
      mockChmod.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockDownload.mockResolvedValue(undefined);
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });
      mockExtractAllTo.mockReturnValue(undefined);
    });

    it('should download dependencies before main binary', async () => {
      const managerWithDeps = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariantWithDeps],
        log: mockLogger,
      });

      await managerWithDeps.ensureBinary();

      // Should download dependency first, then main binary
      expect(mockDownload).toHaveBeenCalledTimes(2);
      expect(mockDownload).toHaveBeenNthCalledWith(1, {
        url: 'https://example.com/cudart.zip',
        destination: expect.stringContaining('.dep0.zip'),
        onProgress: expect.any(Function),
      });
      expect(mockDownload).toHaveBeenNthCalledWith(2, {
        url: 'https://example.com/llama-cuda.zip',
        destination: expect.stringContaining('.cuda.zip'),
        onProgress: expect.any(Function),
      });
    });

    it('should fail variant if dependency checksum is wrong', async () => {
      // Make dependency checksum fail
      mockCalculateChecksum.mockImplementation(async (path: string) => {
        if (path.includes('.dep0.zip')) return 'wrongchecksum';
        if (path.includes('.cuda.zip')) return 'abc123cuda';
        if (path.includes('.cpu.zip')) return 'abc123cpu';
        return 'abc123';
      });

      const managerWithDeps = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariantWithDeps, cpuVariant],
        log: mockLogger,
      });

      // Should fall back to CPU variant
      await managerWithDeps.ensureBinary();

      // Should cleanup and try next variant
      expect(mockDeleteFile).toHaveBeenCalledWith(expect.stringContaining('.dep0.zip'));
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });

    it('should cleanup dependencies if binary test fails', async () => {
      // Make binary test fail
      mockExecFileAsync.mockRejectedValueOnce(new Error('Missing drivers'));

      const managerWithDeps = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariantWithDeps, cpuVariant],
        log: mockLogger,
      });

      // Mock second call (CPU variant) to succeed
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      await managerWithDeps.ensureBinary();

      // Should cleanup extraction dir (which contains both binary and dependencies)
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });
  });

  describe('real functionality testing', () => {
    it('should run real functionality test when testModelPath is provided', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock exec to succeed for real test
      mockExecFileAsync.mockResolvedValue({ stdout: 'test output', stderr: '' });

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        testModelPath,
        log: mockLogger,
      });

      await managerWithModel.ensureBinary();

      // Should call execFileAsync with model path and GPU testing args
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['-m', testModelPath, '-ngl', '1']),
        expect.objectContaining({ timeout: 30000 })
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Running real functionality test with model...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Real functionality test passed (GPU inference successful)',
        'info'
      );
    });

    it('should detect CUDA errors in real functionality test', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock exec to return CUDA error for first variant, success for second
      mockExecFileAsync
        .mockResolvedValueOnce({
          stdout: '',
          stderr: 'CUDA error: out of memory',
        })
        .mockResolvedValue({
          stdout: 'success',
          stderr: '',
        });

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant, cpuVariant],
        testModelPath,
        log: mockLogger,
      });

      await managerWithModel.ensureBinary();

      // Should detect CUDA error and try next variant
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Real functionality test detected GPU error'),
        'warn'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Real functionality test failed (GPU inference error), variant will be skipped',
        'warn'
      );
      // Should have tried CPU variant as fallback
      expect(mockDownload).toHaveBeenCalledTimes(2);
    });

    it('should fall back to basic test when no testModelPath provided', async () => {
      // No testModelPath provided
      mockExecFileAsync.mockResolvedValue({ stdout: 'version 1.0', stderr: '' });

      const managerWithoutModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      await managerWithoutModel.ensureBinary();

      // Should use basic --version test (not real functionality test)
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.anything(),
        ['--version'],
        expect.objectContaining({ timeout: 5000 })
      );
      expect(mockLogger).not.toHaveBeenCalledWith(
        'Running real functionality test with model...',
        'info'
      );
    });

    it('should run diffusion test with correct args when testModelPath provided', async () => {
      const testModelPath = '/mock/models/test-diffusion.safetensors';

      // Mock exec to succeed
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const diffusionManager = new BinaryManager({
        type: 'diffusion',
        binaryName: 'sd',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        testModelPath,
        log: mockLogger,
      });

      await diffusionManager.ensureBinary();

      // Should call sd with tiny image generation args
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          '-m',
          testModelPath,
          '-p',
          'test',
          '--width',
          '64',
          '--height',
          '64',
          '--steps',
          '1',
        ]),
        expect.objectContaining({ timeout: 30000 })
      );
    });

    it('should treat timeout as test failure', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock exec to timeout for first variant, succeed for second
      mockExecFileAsync
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValue({ stdout: 'success', stderr: '' });

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant, cpuVariant],
        testModelPath,
        log: mockLogger,
      });

      await managerWithModel.ensureBinary();

      // Should log timeout as failure and try next variant
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Real functionality test failed'),
        'warn'
      );
      // Should have tried CPU variant
      expect(mockDownload).toHaveBeenCalledTimes(2);
    });
  });
});
