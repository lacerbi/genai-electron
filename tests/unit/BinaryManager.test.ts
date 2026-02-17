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

// Mock archive-utils
const mockExtractBinary = jest.fn();
const mockExtractArchive = jest.fn();
const mockCleanupExtraction = jest.fn();
const mockGetArchiveExtension = jest.fn();

jest.unstable_mockModule('../../src/utils/archive-utils.js', () => ({
  extractBinary: mockExtractBinary,
  extractArchive: mockExtractArchive,
  cleanupExtraction: mockCleanupExtraction,
  getArchiveExtension: mockGetArchiveExtension,
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

// Mock child_process with spawn
// Store spawn behavior configuration for tests to control
type SpawnBehavior = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string | null;
  shouldError?: boolean;
  errorMessage?: string;
  shouldTimeout?: boolean;
};

let spawnBehavior: SpawnBehavior = {};
// For tests that need different behavior on each call, use this array
let spawnBehaviors: SpawnBehavior[] = [];
let spawnCallIndex = 0;

// Helper API for setting spawn responses (clearer intent for test scenarios)
const setSpawnResponses = (responses: SpawnBehavior[]) => {
  spawnBehaviors = responses;
  spawnCallIndex = 0;
};

const setSpawnResponse = (response: SpawnBehavior) => {
  spawnBehavior = response;
  setSpawnResponses([]);
  spawnCallIndex = 0;
};

// Helper function to create spawn implementation
// This will be reapplied after each jest.resetMocks()
const createSpawnImplementation = () => {
  return (command: string, args: string[], options: any) => {
    // Determine which behavior to use (array takes precedence)
    const currentBehavior =
      spawnBehaviors.length > 0
        ? spawnBehaviors[spawnCallIndex++ % spawnBehaviors.length]
        : spawnBehavior;

    // Create mock EventEmitter-like object for stdout/stderr
    const mockStdout = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'data' && currentBehavior.stdout) {
          // Use setImmediate for more realistic async behavior
          setImmediate(() => handler(Buffer.from(currentBehavior.stdout!)));
        }
        return mockStdout;
      }),
    };

    const mockStderr = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'data' && currentBehavior.stderr) {
          // Use setImmediate for more realistic async behavior
          setImmediate(() => handler(Buffer.from(currentBehavior.stderr!)));
        }
        return mockStderr;
      }),
    };

    // Create mock child process
    const mockChild: any = {
      stdout: mockStdout,
      stderr: mockStderr,
      killed: false,
      kill: jest.fn(() => {
        mockChild.killed = true;
      }),
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'exit' && !currentBehavior.shouldError && !currentBehavior.shouldTimeout) {
          // Use setImmediate for more realistic async behavior
          setImmediate(() => {
            const exitCode = currentBehavior.exitCode ?? 0;
            const signal = currentBehavior.signal ?? null;
            handler(exitCode, signal);
          });
        } else if (event === 'error' && currentBehavior.shouldError) {
          // Use setImmediate for more realistic async behavior
          setImmediate(() => handler(new Error(currentBehavior.errorMessage || 'Spawn error')));
        }
        // If shouldTimeout is true, don't emit any events (simulates hanging)
        return mockChild;
      }),
    };

    return mockChild;
  };
};

// Create the mock spawn function that will be exported from child_process
const mockSpawnFn = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawnFn,
}));

// Mock gpu-detect
const mockDetectGPU = jest.fn();
jest.unstable_mockModule('../../src/system/gpu-detect.js', () => ({
  detectGPU: mockDetectGPU,
}));

// Import after mocking
const { BinaryManager } = await import('../../src/managers/BinaryManager.js');
const { BinaryError } = await import('../../src/errors/index.js');

// Import spawn to get reference to the mocked function
const { spawn: mockSpawn } = await import('child_process');

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

    // Reapply spawn implementation after jest.resetMocks() clears it
    (mockSpawn as jest.Mock).mockImplementation(createSpawnImplementation());

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
    mockExtractArchive.mockResolvedValue(undefined);
    mockCleanupExtraction.mockResolvedValue(undefined);
    mockGetArchiveExtension.mockReturnValue('.zip');
    mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
    mockReadFile.mockRejectedValue(new Error('No cache'));
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockDownload.mockResolvedValue(undefined);

    // Reset spawn behavior for each test (tests will configure as needed)
    setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

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
      // Default spawnBehavior set in beforeEach works for this test

      await binaryManager.ensureBinary();

      expect(mockEnsureDirectory).toHaveBeenCalledWith(MOCK_PATHS.binaries.llama);
    });

    it('should return existing binary path if binary works', async () => {
      mockFileExists.mockResolvedValue(true);
      // Mock no validation cache, so it runs tests
      mockReadFile.mockRejectedValue(new Error('No validation cache'));
      mockCalculateChecksum.mockResolvedValue('abc123');
      // Default spawnBehavior set in beforeEach works for this test

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockDownload).not.toHaveBeenCalled();
      // With the validation cache implementation, it validates and saves cache
      expect(mockLogger).toHaveBeenCalledWith('Binary validated successfully', 'info');
    });

    it('should re-download if existing binary does not work', async () => {
      mockFileExists.mockResolvedValueOnce(true); // Binary exists
      // First spawn call fails, subsequent ones succeed
      setSpawnResponses([
        { exitCode: 1, stderr: 'Execution failed' }, // First call fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls succeed
      ]);

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
      setSpawnResponses([
        { exitCode: 1, stderr: 'CUDA not available' }, // First call (CUDA) fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls (CPU) succeed
      ]);

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

    it('should respect priority order even if cache points to a different variant', async () => {
      // Simulate cache pointing to 'cpu' variant
      mockReadFile.mockResolvedValue(JSON.stringify({ variant: 'cpu', platform: 'win32-x64' }));
      // Default spawn behavior (set in beforeEach) works for this test

      await binaryManager.ensureBinary();

      // Should still try CUDA first (priority order), not CPU (cached)
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledWith({
        url: cudaVariant.url,
        destination: expect.stringContaining('.cuda.zip'),
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
      setSpawnResponse({ exitCode: 1, stderr: 'No drivers available' });

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
      // Mock existing binary with no validation cache (will run tests)
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockRejectedValue(new Error('No validation cache'));
      mockCalculateChecksum.mockResolvedValue('abc123');

      // Default spawn behavior (set in beforeEach) works for this test

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockLogger).toHaveBeenCalledWith('Binary validated successfully', 'info');
    });

    it('should return false when binary execution fails', async () => {
      mockFileExists.mockResolvedValue(true);
      // First call fails (existing binary check), subsequent calls succeed (after re-download)
      setSpawnResponses([
        { exitCode: 1, stderr: 'Missing CUDA drivers' },
        { stdout: 'version 1.0', stderr: '', exitCode: 0 },
      ]);

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
      setSpawnResponses([
        { exitCode: 1, stderr: 'CUDA drivers not found' }, // First call (CUDA) fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls succeed
      ]);

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

      // Default spawn behavior (set in beforeEach) works for this test

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

      // Default spawn behavior (set in beforeEach) works for this test

      const result = await binaryManager.ensureBinary();

      // Should try CUDA variant (not filtered)
      expect(mockDownload).toHaveBeenCalledWith({
        url: cudaVariant.url,
        destination: expect.stringContaining('.cuda.zip'),
        onProgress: expect.any(Function),
      });
      expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('CUDA GPU detected'), 'info');
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

      // Default spawn behavior (set in beforeEach) works for this test

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
      // Clearing all mocks would break spawn behavior setup

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
      mockExtractArchive.mockResolvedValue(undefined);
      mockCleanupExtraction.mockResolvedValue(undefined);
      mockGetArchiveExtension.mockReturnValue('.zip');
      mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
      mockReadFile.mockRejectedValue(new Error('No cache'));
      mockWriteFile.mockResolvedValue(undefined);
      mockChmod.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockDownload.mockResolvedValue(undefined);
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
      // Make binary test fail on first call, succeed on second
      setSpawnResponses([
        { exitCode: 1, stderr: 'Missing drivers' },
        { stdout: 'version 1.0', stderr: '', exitCode: 0 },
      ]);

      const managerWithDeps = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariantWithDeps, cpuVariant],
        log: mockLogger,
      });

      await managerWithDeps.ensureBinary();

      // Should cleanup extraction dir (which contains both binary and dependencies)
      expect(mockCleanupExtraction).toHaveBeenCalled();
    });
  });

  describe('tar.gz archive support', () => {
    it('should use .tar.gz extension for tar.gz variant URLs', async () => {
      const tarGzVariant: BinaryVariantConfig = {
        type: 'metal',
        url: 'https://example.com/llama-server-macos-arm64.tar.gz',
        checksum: 'abc123metal',
      };

      // Mock getArchiveExtension to return .tar.gz for this URL
      mockGetArchiveExtension.mockImplementation((url: string) => {
        if (url.endsWith('.tar.gz')) return '.tar.gz';
        return '.zip';
      });

      mockCalculateChecksum.mockImplementation(async (path: string) => {
        if (path.includes('.metal.tar.gz')) return 'abc123metal';
        return 'abc123';
      });

      const metalManager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'darwin-arm64',
        variants: [tarGzVariant],
        log: mockLogger,
      });

      await metalManager.ensureBinary();

      // Should call getArchiveExtension with the variant URL
      expect(mockGetArchiveExtension).toHaveBeenCalledWith(tarGzVariant.url);

      // Should use .tar.gz extension for download destination
      expect(mockDownload).toHaveBeenCalledWith({
        url: tarGzVariant.url,
        destination: expect.stringContaining('.metal.tar.gz'),
        onProgress: expect.any(Function),
      });
    });
  });

  describe('two-phase binary testing', () => {
    it('should run Phase 1 (basic validation) and Phase 2 (real functionality) when testModelPath is provided', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists to return true
      mockFileExists.mockResolvedValue(true);

      // Phase 1: --version exits normally; Phase 2: server stays alive (no exit)
      setSpawnResponses([
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Phase 1
        { shouldTimeout: true }, // Phase 2: server process stays running
      ]);

      // Mock fetch: health returns ok, completion returns success
      const mockFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.includes('/completion')) {
          return new Response(JSON.stringify({ content: '4' }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        testModelPath,
        log: mockLogger,
      });

      await managerWithModel.ensureBinary();

      // Phase 1: Should test llama-server --version
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 1: Testing binary basic validation...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 1: ✓ Binary validation passed (--version)',
        'info'
      );

      // Phase 2: Should start llama-server and test via HTTP
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: Testing GPU functionality with llama-server...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: ✓ GPU functionality test passed (llama-server)',
        'info'
      );

      // Should spawn llama-server with model and GPU args
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          '-m',
          testModelPath,
          '--port',
          expect.any(String),
          '-ngl',
          '1',
          '-c',
          '512',
        ]),
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );

      // Should have called fetch for health and completion
      expect(mockFetch).toHaveBeenCalled();

      mockFetch.mockRestore();
    });

    it('should fail variant if Phase 1 (basic validation) fails', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // First variant: Phase 1 fails
      // Second variant: Phase 1 succeeds, Phase 2 server stays running
      setSpawnResponses([
        { exitCode: 1, stderr: 'Binary not working' }, // First variant Phase 1 fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Second variant Phase 1 succeeds
        { shouldTimeout: true }, // Second variant Phase 2 server
      ]);

      // Mock fileExists: binary doesn't exist (trigger download), test model exists
      mockFileExists.mockImplementation(async (filePath) => {
        if (filePath.includes('llama-server.exe')) return false;
        if (filePath === testModelPath) return true;
        return false;
      });

      // Mock fetch for Phase 2 of second variant
      const mockFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.includes('/completion')) {
          return new Response(JSON.stringify({ content: '4' }), { status: 200 });
        }
        return new Response('', { status: 404 });
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

      // Should log Phase 1 failure
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Phase 1: ✗ Basic validation failed'),
        'error'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Binary validation failed, variant will be skipped',
        'warn'
      );

      // Should have tried both variants
      expect(mockDownload).toHaveBeenCalledTimes(2);

      mockFetch.mockRestore();
    });

    it('should fail variant if Phase 2 (real functionality) fails due to GPU errors', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists: binary doesn't exist (trigger download), test model exists
      mockFileExists.mockImplementation(async (filePath) => {
        if (filePath.includes('llama-server.exe')) return false;
        if (filePath === testModelPath) return true;
        return false;
      });

      // CUDA: Phase 1 succeeds, Phase 2 server emits GPU error in stderr
      // CPU: Phase 1 succeeds, Phase 2 server succeeds
      setSpawnResponses([
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CUDA Phase 1 success
        { shouldTimeout: true, stderr: 'CUDA error: out of memory' }, // CUDA Phase 2 GPU error in stderr
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CPU Phase 1 success
        { shouldTimeout: true }, // CPU Phase 2 server
      ]);

      // Health must fail initially so the poll loop iterates, giving setImmediate
      // time to populate stderr with the GPU error before health succeeds
      let healthCallCount = 0;
      const mockFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/health')) {
          healthCallCount++;
          // First 2 calls fail (CUDA variant — gives time for stderr GPU error)
          // Later calls succeed (CPU variant)
          if (healthCallCount <= 2) {
            throw new Error('Connection refused');
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.includes('/completion')) {
          return new Response(JSON.stringify({ content: '4' }), { status: 200 });
        }
        return new Response('', { status: 404 });
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

      // Should detect GPU error in Phase 2
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Phase 2: ✗ GPU error detected'),
        'warn'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'GPU functionality test failed, variant will be skipped',
        'warn'
      );

      // Should have tried CPU variant as fallback
      expect(mockDownload).toHaveBeenCalledTimes(2);

      mockFetch.mockRestore();
    });

    it('should skip Phase 2 when no testModelPath provided', async () => {
      // No testModelPath provided
      // Default spawn behavior (set in beforeEach) works for this test

      const managerWithoutModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      await managerWithoutModel.ensureBinary();

      // Should only run Phase 1 (basic validation)
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 1: Testing binary basic validation...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'No test model provided, skipping Phase 2 (GPU functionality test)',
        'info'
      );

      // Should NOT run Phase 2
      expect(mockLogger).not.toHaveBeenCalledWith(
        'Phase 2: Testing GPU functionality with real inference...',
        'info'
      );
    });

    it('should run diffusion test with two phases when testModelPath provided', async () => {
      const testModelPath = '/mock/models/test-diffusion.safetensors';

      // Mock fileExists to return true
      mockFileExists.mockResolvedValue(true);

      // Mock exec to succeed for both phases
      setSpawnResponse({ stdout: '', stderr: '', exitCode: 0 });

      const diffusionManager = new BinaryManager({
        type: 'diffusion',
        binaryName: 'sd',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        testModelPath,
        log: mockLogger,
      });

      await diffusionManager.ensureBinary();

      // Phase 1: Should test sd --help
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 1: Testing binary basic validation...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 1: ✓ Binary validation passed (--help)',
        'info'
      );

      // Phase 2: Should test sd with tiny image generation
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: Testing GPU functionality with real inference...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: ✓ GPU functionality test passed (sd)',
        'info'
      );

      // Should call sd with tiny image generation args (timeout handled internally)
      expect(mockSpawn).toHaveBeenCalledWith(
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
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    it('should fail variant if completion request fails during Phase 2', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists: binary doesn't exist (trigger download), test model exists
      mockFileExists.mockImplementation(async (filePath) => {
        if (filePath.includes('llama-server.exe')) return false;
        if (filePath === testModelPath) return true;
        return false;
      });

      // CUDA: Phase 1 succeeds, Phase 2 server starts (health ok but completion fails)
      // CPU: Phase 1 succeeds, Phase 2 server starts (everything succeeds)
      setSpawnResponses([
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CUDA Phase 1 success
        { shouldTimeout: true }, // CUDA Phase 2 server
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CPU Phase 1 success
        { shouldTimeout: true }, // CPU Phase 2 server
      ]);

      // First completion call fails (CUDA variant), second succeeds (CPU variant)
      let completionCallCount = 0;
      const mockFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.includes('/completion')) {
          completionCallCount++;
          if (completionCallCount <= 1) {
            return new Response('Internal Server Error', { status: 500 });
          }
          return new Response(JSON.stringify({ content: '4' }), { status: 200 });
        }
        return new Response('', { status: 404 });
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

      // Should log completion failure
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Phase 2: ✗ Completion request failed with status 500'),
        'warn'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'GPU functionality test failed, variant will be skipped',
        'warn'
      );

      // Should have tried CPU variant
      expect(mockDownload).toHaveBeenCalledTimes(2);

      mockFetch.mockRestore();
    });
  });

  describe('Validation Cache', () => {
    it('should skip validation tests if cache exists and checksum matches', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
        phase2Passed: true,
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile to return validation cache
      mockReadFile.mockResolvedValue(JSON.stringify(validationCache));

      // Mock checksum to match cache
      mockCalculateChecksum.mockResolvedValue('abc123');

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should use cached validation
      expect(result).toBe(binaryPath);
      expect(mockLogger).toHaveBeenCalledWith('Verifying binary integrity...', 'info');
      expect(mockLogger).toHaveBeenCalledWith(
        'Using cached validation result (binary verified)',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('Last validated:'), 'info');

      // Should NOT run tests (spawn not called)
      expect(mockSpawn).not.toHaveBeenCalled();
      // Should NOT download again
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('should re-run validation if checksum does not match cache', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile to return validation cache
      mockReadFile.mockResolvedValue(JSON.stringify(validationCache));

      // Mock checksum to NOT match cache (binary was modified)
      mockCalculateChecksum.mockResolvedValue('different-checksum');

      // Phase 1 test succeeds
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should detect checksum mismatch
      expect(mockLogger).toHaveBeenCalledWith('Binary checksum mismatch, re-validating...', 'warn');

      // Should run validation tests
      expect(mockSpawn).toHaveBeenCalled();

      // Should save new validation cache
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.validation.json'),
        expect.stringContaining('different-checksum'),
        'utf-8'
      );
    });

    it('should re-run validation if forceValidation=true', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile to return validation cache
      mockReadFile.mockResolvedValue(JSON.stringify(validationCache));

      // Mock checksum to match cache (binary unchanged)
      mockCalculateChecksum.mockResolvedValue('abc123');

      // Phase 1 test succeeds
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      const result = await manager.ensureBinary(true); // forceValidation=true

      // Should log force validation
      expect(mockLogger).toHaveBeenCalledWith(
        'Force validation requested, re-running tests...',
        'info'
      );

      // Should run validation tests even though cache is valid
      expect(mockSpawn).toHaveBeenCalled();

      // Should save new validation cache
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.validation.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should run validation on first run (no cache)', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';

      // Binary does NOT exist (first run), but extracted binary exists for testing
      mockFileExists.mockImplementation(async (path) => {
        // Binary doesn't exist at final location yet
        if (path === binaryPath) return false;
        // Extracted binary exists after download (for testing)
        if (path.includes('.extract') && path.includes('llama-server.exe')) return true;
        // For other paths, return true (variant cache file, etc.)
        return false;
      });

      mockGetBinaryPath.mockReturnValue(binaryPath);

      // No validation cache
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      // Mock successful download and extraction
      const extractedPath = '/mock/extract/llama-server.exe';
      mockDownload.mockResolvedValue(undefined);
      mockExtractBinary.mockResolvedValue(extractedPath);
      mockCalculateChecksum.mockImplementation(async (path) => {
        if (path.includes('.cuda.zip')) return 'abc123cuda';
        return 'new-checksum';
      });
      mockCopyDirectory.mockResolvedValue(undefined);
      mockCleanupExtraction.mockResolvedValue(undefined);

      // Phase 1 test succeeds
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should download and test binary
      expect(mockDownload).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalled();

      // Should save validation cache after successful validation
      const validationCacheCalls = (mockWriteFile as jest.Mock).mock.calls.filter((call) =>
        call[0].includes('.validation.json')
      );
      expect(validationCacheCalls.length).toBeGreaterThan(0);
      expect(validationCacheCalls[0][1]).toContain('new-checksum');
    });

    it('should re-download when configured version changes', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
        version: 'b6784',
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile: first call returns validation cache, second call fails (no variant cache)
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(validationCache))
        .mockRejectedValue(new Error('No cache'));

      mockCalculateChecksum.mockImplementation(async (path: string) => {
        if (path.includes('.cuda.zip')) return 'abc123cuda';
        return 'new-checksum';
      });

      // Spawn succeeds for downloaded binary
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        version: 'b7956',
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should detect version mismatch and re-download
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Binary version changed (b6784 → b7956)'),
        'info'
      );
      // Should delete old binary
      expect(mockDeleteFile).toHaveBeenCalledWith(binaryPath);
      // Should download new binary
      expect(mockDownload).toHaveBeenCalled();
      expect(result).toBe(binaryPath);
    });

    it('should re-download when old cache has no version field', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
        // No version field — simulating pre-upgrade cache
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile: first call returns validation cache, second call fails (no variant cache)
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(validationCache))
        .mockRejectedValue(new Error('No cache'));

      mockCalculateChecksum.mockImplementation(async (path: string) => {
        if (path.includes('.cuda.zip')) return 'abc123cuda';
        return 'new-checksum';
      });

      // Spawn succeeds for downloaded binary
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        version: 'b7956',
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should detect undefined !== 'b7956' as mismatch
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Binary version changed (unknown → b7956)'),
        'info'
      );
      // Should delete old binary and re-download
      expect(mockDeleteFile).toHaveBeenCalledWith(binaryPath);
      expect(mockDownload).toHaveBeenCalled();
      expect(result).toBe(binaryPath);
    });

    it('should use cached validation when version matches', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';
      const validationCache = {
        variant: 'cuda',
        checksum: 'abc123',
        validatedAt: new Date().toISOString(),
        phase1Passed: true,
        version: 'b7956',
      };

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile to return validation cache with matching version
      mockReadFile.mockResolvedValue(JSON.stringify(validationCache));

      // Mock checksum to match cache
      mockCalculateChecksum.mockResolvedValue('abc123');

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        version: 'b7956',
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should use cached result
      expect(result).toBe(binaryPath);
      expect(mockLogger).toHaveBeenCalledWith(
        'Using cached validation result (binary verified)',
        'info'
      );
      // Should NOT spawn or download
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('should fall back to validation if cache is corrupted', async () => {
      const binaryPath = '/mock/binaries/llama/llama-server.exe';

      // Binary exists
      mockFileExists.mockResolvedValue(true);
      mockGetBinaryPath.mockReturnValue(binaryPath);

      // Mock readFile to return corrupted cache (invalid JSON)
      mockReadFile.mockResolvedValue('{ invalid json');

      mockCalculateChecksum.mockResolvedValue('abc123');

      // Phase 1 test succeeds
      setSpawnResponse({ stdout: 'version 1.0', stderr: '', exitCode: 0 });

      const manager = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        log: mockLogger,
      });

      const result = await manager.ensureBinary(false);

      // Should run validation tests (cache corrupted, treated as no cache)
      expect(mockSpawn).toHaveBeenCalled();

      // Should save new validation cache
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.validation.json'),
        expect.any(String),
        'utf-8'
      );
    });
  });
});
