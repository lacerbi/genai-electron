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

jest.unstable_mockModule('child_process', () => ({
  spawn: jest.fn((command: string, args: string[], options: any) => {
    // Determine which behavior to use (array takes precedence)
    const currentBehavior = spawnBehaviors.length > 0
      ? spawnBehaviors[spawnCallIndex++ % spawnBehaviors.length]
      : spawnBehavior;

    // Create mock EventEmitter-like object for stdout/stderr
    const mockStdout = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'data' && currentBehavior.stdout) {
          // Emit synchronously for simplicity in tests
          handler(Buffer.from(currentBehavior.stdout));
        }
        return mockStdout;
      }),
    };

    const mockStderr = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'data' && currentBehavior.stderr) {
          // Emit synchronously for simplicity in tests
          handler(Buffer.from(currentBehavior.stderr));
        }
        return mockStderr;
      }),
    };

    // Create mock child process
    const mockChild: any = {
      stdout: mockStdout,
      stderr: mockStderr,
      kill: jest.fn(),
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'exit' && !currentBehavior.shouldError && !currentBehavior.shouldTimeout) {
          // Emit synchronously for simplicity in tests
          const exitCode = currentBehavior.exitCode ?? 0;
          const signal = currentBehavior.signal ?? null;
          handler(exitCode, signal);
        } else if (event === 'error' && currentBehavior.shouldError) {
          // Emit synchronously for simplicity in tests
          handler(new Error(currentBehavior.errorMessage || 'Spawn error'));
        }
        // If shouldTimeout is true, don't emit any events (simulates hanging)
        return mockChild;
      }),
    };

    return mockChild;
  }),
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

    // Reset spawn behavior for each test (tests will configure as needed)
    spawnBehavior = { stdout: 'version 1.0', stderr: '', exitCode: 0 };
    spawnBehaviors = []; // Clear multi-call behaviors
    spawnCallIndex = 0; // Reset call counter

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
      // Default spawnBehavior set in beforeEach works for this test

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockDownload).not.toHaveBeenCalled();
      expect(mockLogger).toHaveBeenCalledWith('Using existing binary', 'info');
    });

    it('should re-download if existing binary does not work', async () => {
      mockFileExists.mockResolvedValueOnce(true); // Binary exists
      // First spawn call fails, subsequent ones succeed
      spawnBehaviors = [
        { exitCode: 1, stderr: 'Execution failed' }, // First call fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls succeed
      ];

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
      spawnBehaviors = [
        { exitCode: 1, stderr: 'CUDA not available' }, // First call (CUDA) fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls (CPU) succeed
      ];

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
      // Default spawn behavior (set in beforeEach) works for this test

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
      spawnBehavior = { exitCode: 1, stderr: 'No drivers available' };

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
      // Default spawn behavior (set in beforeEach) works for this test

      const result = await binaryManager.ensureBinary();

      expect(result).toBe('/mock/binaries/llama/llama-server.exe');
      expect(mockLogger).toHaveBeenCalledWith('Using existing binary', 'info');
    });

    it('should return false when binary execution fails', async () => {
      mockFileExists.mockResolvedValue(true);
      // First call fails (existing binary check), subsequent calls succeed (after re-download)
      spawnBehaviors = [
        { exitCode: 1, stderr: 'Missing CUDA drivers' },
        { stdout: 'version 1.0', stderr: '', exitCode: 0 },
      ];

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
      spawnBehaviors = [
        { exitCode: 1, stderr: 'CUDA drivers not found' }, // First call (CUDA) fails
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // Subsequent calls succeed
      ];

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
      mockCleanupExtraction.mockResolvedValue(undefined);
      mockGetBinaryPath.mockReturnValue('/mock/binaries/llama/llama-server.exe');
      mockReadFile.mockRejectedValue(new Error('No cache'));
      mockWriteFile.mockResolvedValue(undefined);
      mockChmod.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockDownload.mockResolvedValue(undefined);
      // Default spawn behavior (set in beforeEach) works for this test
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
      // Make binary test fail on first call, succeed on second
      spawnBehaviors = [
        { exitCode: 1, stderr: 'Missing drivers' },
        { stdout: 'version 1.0', stderr: '', exitCode: 0 },
      ];

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

  describe('two-phase binary testing', () => {
    it('should run Phase 1 (basic validation) and Phase 2 (real functionality) when testModelPath is provided', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists to return true for both binary and llama-run
      mockFileExists.mockResolvedValue(true);

      // Mock spawn to succeed for both phases
      spawnBehavior = { stdout: 'test output', stderr: '', exitCode: 0 };

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

      // Phase 2: Should test llama-run with GPU
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: Testing GPU functionality with real inference...',
        'info'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: ✓ GPU functionality test passed (llama-run)',
        'info'
      );

      // Should call execFileAsync for llama-run with GPU testing args
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('llama-run'),
        expect.arrayContaining(['-ngl', '1', testModelPath, 'What is 2+2? Just answer with the number.']),
        expect.objectContaining({
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      );
    });

    it('should fail variant if Phase 1 (basic validation) fails', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // First variant: Phase 1 fails (first spawn call fails)
      // Second variant: Phase 1 & 2 succeed (second and third spawn calls succeed)
      spawnBehaviors = [
        { exitCode: 1, stderr: 'Binary not working' }, // First variant Phase 1 fails
        { stdout: 'success', stderr: '', exitCode: 0 }, // Second variant Phase 1 succeeds
        { stdout: 'success', stderr: '', exitCode: 0 }, // Second variant Phase 2 succeeds
      ];

      // Mock fileExists: binary doesn't exist (trigger download), llama-run exists for Phase 2
      mockFileExists.mockImplementation(async (path) => {
        // Binary doesn't exist initially (trigger download)
        if (path.includes('llama-server.exe')) {
          return false;
        }
        // llama-run exists (for Phase 2 test)
        if (path.includes('llama-run')) {
          return true;
        }
        // Test model exists
        if (path === testModelPath) {
          return true;
        }
        return false;
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
    });

    it('should fail variant if Phase 2 (real functionality) fails due to GPU errors', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists: binary doesn't exist (trigger download), llama-run exists for Phase 2
      mockFileExists.mockImplementation(async (path) => {
        if (path.includes('llama-server.exe')) {
          return false;
        }
        if (path.includes('llama-run')) {
          return true;
        }
        if (path === testModelPath) {
          return true;
        }
        return false;
      });

      // Phase 1 succeeds for both, Phase 2 fails for CUDA (GPU error), succeeds for CPU
      // Sequence: CUDA Phase1, CUDA Phase2 (fail), CPU Phase1, CPU Phase2 (success)
      spawnBehaviors = [
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CUDA Phase 1 success
        { stdout: '', stderr: 'CUDA error: out of memory', exitCode: 0 }, // CUDA Phase 2 GPU error
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CPU Phase 1 success
        { stdout: 'success', stderr: '', exitCode: 0 }, // CPU Phase 2 success
      ];

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
    });

    it('should fail variant if llama-run is not found', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists: binary exists, but llama-run doesn't
      mockFileExists.mockImplementation(async (path) => {
        return !path.includes('llama-run');
      });

      // Phase 1 succeeds
      // Default spawn behavior (set in beforeEach) works for this test

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant],
        testModelPath,
        log: mockLogger,
      });

      await expect(managerWithModel.ensureBinary()).rejects.toThrow(BinaryError);

      // Should log that llama-run was not found
      expect(mockLogger).toHaveBeenCalledWith(
        'Phase 2: ✗ llama-run not found in binary directory',
        'error'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'GPU functionality test failed, variant will be skipped',
        'warn'
      );
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
      spawnBehavior = { stdout: '', stderr: '', exitCode: 0 };

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

      // Should call sd with tiny image generation args
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
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      );
    });

    it('should treat timeout in Phase 2 as test failure', async () => {
      const testModelPath = '/mock/models/test-model.gguf';

      // Mock fileExists: binary doesn't exist (trigger download), llama-run exists for Phase 2
      mockFileExists.mockImplementation(async (path) => {
        if (path.includes('llama-server.exe')) {
          return false;
        }
        if (path.includes('llama-run')) {
          return true;
        }
        if (path === testModelPath) {
          return true;
        }
        return false;
      });

      // Phase 1 succeeds for both, Phase 2 times out for first variant, succeeds for second
      // Sequence: CUDA Phase1, CUDA Phase2 (timeout), CPU Phase1, CPU Phase2 (success)
      spawnBehaviors = [
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CUDA Phase 1 success
        { shouldError: true, errorMessage: 'Timeout' }, // CUDA Phase 2 timeout
        { stdout: 'version 1.0', stderr: '', exitCode: 0 }, // CPU Phase 1 success
        { stdout: 'success', stderr: '', exitCode: 0 }, // CPU Phase 2 success
      ];

      const managerWithModel = new BinaryManager({
        type: 'llama',
        binaryName: 'llama-server',
        platformKey: 'win32-x64',
        variants: [cudaVariant, cpuVariant],
        testModelPath,
        log: mockLogger,
      });

      await managerWithModel.ensureBinary();

      // Should log timeout as Phase 2 failure
      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('Phase 2: ✗ Real functionality test failed'),
        'warn'
      );
      expect(mockLogger).toHaveBeenCalledWith(
        'GPU functionality test failed, variant will be skipped',
        'warn'
      );

      // Should have tried CPU variant
      expect(mockDownload).toHaveBeenCalledTimes(2);
    });
  });
});
