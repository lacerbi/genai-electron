/**
 * Unit tests for DiffusionServerManager
 * Tests diffusion HTTP wrapper server lifecycle and image generation
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type {
  DiffusionServerConfig,
  ModelInfo,
  ImageGenerationConfig,
} from '../../src/types/index.js';

// Mock Electron app
const mockApp = {
  getPath: jest.fn((name: string) => {
    if (name === 'userData') return '/test/userData';
    return '/test';
  }),
};

jest.unstable_mockModule('electron', () => ({
  app: mockApp,
}));

// Mock http module
const mockHttpServer = new EventEmitter() as any;
mockHttpServer.listen = jest.fn().mockImplementation((port: number, callback: () => void) => {
  callback();
  return mockHttpServer;
});
mockHttpServer.close = jest.fn().mockImplementation((callback: () => void) => {
  callback();
});

const mockCreateServer = jest.fn().mockReturnValue(mockHttpServer);

jest.unstable_mockModule('node:http', () => {
  const httpModule = {
    createServer: mockCreateServer,
  };
  return {
    default: httpModule,
    ...httpModule,
  };
});

// Mock fs/promises
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  },
}));

// Mock ModelManager
const mockModelManager = {
  getModelInfo: jest.fn(),
};

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: {
    getInstance: jest.fn(() => mockModelManager),
  },
}));

// Mock SystemInfo
const mockSystemInfo = {
  detect: jest.fn(),
  canRunModel: jest.fn(),
  getMemoryInfo: jest.fn(),
  getGPUInfo: jest.fn(),
  clearCache: jest.fn(),
};

jest.unstable_mockModule('../../src/system/SystemInfo.js', () => ({
  SystemInfo: {
    getInstance: jest.fn(() => mockSystemInfo),
  },
}));

// Mock ProcessManager
const mockProcessSpawn = jest.fn();
const mockProcessKill = jest.fn();
const mockProcessIsRunning = jest.fn();

class MockProcessManager {
  spawn = mockProcessSpawn;
  kill = mockProcessKill;
  isRunning = mockProcessIsRunning;
}

jest.unstable_mockModule('../../src/process/ProcessManager.js', () => ({
  ProcessManager: MockProcessManager,
}));

// Mock LogManager
const mockLogInitialize = jest.fn();
const mockLogWrite = jest.fn();
const mockLogGetRecent = jest.fn();
const mockLogClear = jest.fn();

class MockLogManager {
  initialize = mockLogInitialize;
  write = mockLogWrite;
  getRecent = mockLogGetRecent;
  clear = mockLogClear;
  constructor(path: string) {
    // Constructor can receive path but we don't need to do anything with it
  }
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock BinaryManager
const mockEnsureBinary = jest.fn();

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
  constructor(config: any) {
    // Constructor can receive config but we don't need to do anything with it
  }
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock health-check
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  isServerResponding: mockIsServerResponding,
}));

// Mock file-utils
const mockDeleteFile = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  deleteFile: mockDeleteFile,
}));

// Mock paths
const mockGetTempPath = jest.fn();

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    root: '/test',
    models: '/test/models',
    binaries: '/test/binaries',
    logs: '/test/logs',
    temp: '/test/temp',
  },
  getTempPath: mockGetTempPath,
}));

// Import after mocking
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');

describe('DiffusionServerManager', () => {
  let diffusionServer: DiffusionServerManager;
  let mockProcess: any; // Track for cleanup

  const mockModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 * 1024 * 1024, // 6.5GB
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: {
      type: 'url',
      url: 'https://example.com/sdxl-turbo.gguf',
    },
  };

  const mockConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-setup mock return values after clearAllMocks
    mockLogInitialize.mockResolvedValue(undefined);
    mockLogWrite.mockResolvedValue(undefined);
    mockLogGetRecent.mockResolvedValue([]);
    mockLogClear.mockResolvedValue(undefined);
    mockEnsureBinary.mockResolvedValue('/test/binaries/sd');
    mockCreateServer.mockReturnValue(mockHttpServer);
    mockHttpServer.listen.mockImplementation((port: number, callback: () => void) => {
      callback();
      return mockHttpServer;
    });
    mockHttpServer.close.mockImplementation((callback: () => void) => {
      callback();
    });
    mockGetTempPath.mockImplementation((filename: string) => `/test/temp/${filename}`);
    mockDeleteFile.mockResolvedValue(undefined);

    diffusionServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

    // Setup default mocks
    mockModelManager.getModelInfo.mockResolvedValue(mockModelInfo);
    mockSystemInfo.detect.mockResolvedValue({
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 10 * 1024 ** 3, used: 6 * 1024 ** 3 },
      gpu: { available: true, type: 'nvidia', vram: 8 * 1024 ** 3 },
      platform: 'linux',
      recommendations: {
        maxModelSize: '13B',
        recommendedQuantization: ['Q4_K_M', 'Q5_K_M'],
        threads: 7,
        gpuLayers: 35,
      },
    });
    mockSystemInfo.canRunModel.mockResolvedValue({ possible: true });
    mockSystemInfo.getMemoryInfo.mockReturnValue({
      total: 16 * 1024 ** 3,
      available: 10 * 1024 ** 3,
      used: 6 * 1024 ** 3,
    });
    mockSystemInfo.getGPUInfo.mockResolvedValue({
      available: true,
      type: 'nvidia',
      vram: 8 * 1024 ** 3,
    });
    mockIsServerResponding.mockResolvedValue(false); // Port is available

    // Mock process spawn (track at describe level for cleanup)
    mockProcess = new EventEmitter() as any;
    mockProcess.pid = 54321;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = jest.fn();
    mockProcessSpawn.mockReturnValue(mockProcess);
  });

  afterEach(() => {
    // Clean up all event listeners to prevent memory leaks
    diffusionServer.removeAllListeners();

    // Clean up module-level mock HTTP server
    mockHttpServer.removeAllListeners();

    // Ensure the mock server is properly closed
    // Reset the close implementation to ensure it cleans up properly
    mockHttpServer.close.mockClear();

    // Clean up beforeEach mockProcess and its streams
    if (mockProcess) {
      mockProcess.removeAllListeners?.();
      mockProcess.stdout?.removeAllListeners?.();
      mockProcess.stderr?.removeAllListeners?.();
    }
  });

  describe('start()', () => {
    it('should start HTTP wrapper server successfully', async () => {
      const info = await diffusionServer.start(mockConfig);

      expect(info).toBeDefined();
      expect(info.status).toBe('running');
      expect(info.port).toBe(8081);
      expect(info.modelId).toBe('sdxl-turbo');
      expect((info as any).busy).toBe(false);

      // Verify model validation
      expect(mockModelManager.getModelInfo).toHaveBeenCalledWith('sdxl-turbo');

      // Verify system checks (diffusion server checks total memory, not available)
      expect(mockSystemInfo.canRunModel).toHaveBeenCalledWith(mockModelInfo, {
        checkTotalMemory: true,
      });

      // Verify binary download
      expect(mockEnsureBinary).toHaveBeenCalled();

      // Verify HTTP server created
      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(8081, expect.any(Function));
    });

    it('should start with custom GPU layers and threads', async () => {
      const customConfig: DiffusionServerConfig = {
        ...mockConfig,
        threads: 4,
        gpuLayers: 20,
      };

      await diffusionServer.start(customConfig);

      const info = diffusionServer.getInfo();
      expect(info.status).toBe('running');
    });

    it('should throw ModelNotFoundError if model is not diffusion type', async () => {
      const llmModelInfo: ModelInfo = {
        ...mockModelInfo,
        type: 'llm',
      };
      mockModelManager.getModelInfo.mockResolvedValue(llmModelInfo);

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow(
        'Model sdxl-turbo is not a diffusion model'
      );
    });

    it('should throw InsufficientResourcesError if system cannot run model', async () => {
      mockSystemInfo.canRunModel.mockResolvedValue({
        possible: false,
        reason: 'Not enough RAM',
        suggestion: 'Close some applications',
      });

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('Not enough RAM');
    });

    it('should throw PortInUseError if port is already in use', async () => {
      mockIsServerResponding.mockResolvedValue(true);

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('Port 8081');
    });

    it('should throw ServerError if already running', async () => {
      await diffusionServer.start(mockConfig);

      await expect(diffusionServer.start(mockConfig)).rejects.toThrow('already running');
    });

    it('should emit started event', async () => {
      const startedHandler = jest.fn();
      diffusionServer.on('started', startedHandler);

      await diffusionServer.start(mockConfig);

      expect(startedHandler).toHaveBeenCalled();
    });

    it('should initialize log manager', async () => {
      await diffusionServer.start(mockConfig);

      expect(mockLogInitialize).toHaveBeenCalled();
      expect(mockLogWrite).toHaveBeenCalledWith(
        expect.stringContaining('Starting diffusion server'),
        'info'
      );
    });
  });

  describe('config validation', () => {
    it('should accept all valid DiffusionServerConfig fields without error', async () => {
      const validConfig: DiffusionServerConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        threads: 4,
        gpuLayers: 20,
        forceValidation: false,
        clipOnCpu: true,
        vaeOnCpu: false,
        batchSize: 4,
      };

      const info = await diffusionServer.start(validConfig);
      expect(info.status).toBe('running');
    });

    it('should throw ServerError for LLM-specific fields', async () => {
      const badConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        contextSize: 4096,
        parallelRequests: 4,
        flashAttention: true,
      };

      await expect(diffusionServer.start(badConfig as any)).rejects.toThrow(
        /Unknown configuration field.*contextSize/
      );
    });

    it('should list all unknown fields and include valid fields in error details', async () => {
      const badConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        contextSize: 4096,
        flashAttention: true,
      };

      try {
        await diffusionServer.start(badConfig as any);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('contextSize');
        expect(error.message).toContain('flashAttention');
        expect(error.message).toContain('Valid fields for DiffusionServerManager');
        expect(error.details.unknownFields).toEqual(
          expect.arrayContaining(['contextSize', 'flashAttention'])
        );
        expect(error.details.validFields).toEqual(
          expect.arrayContaining(['modelId', 'port', 'threads', 'gpuLayers'])
        );
      }
    });

    it('should reject completely unknown fields', async () => {
      const badConfig = {
        modelId: 'sdxl-turbo',
        port: 8081,
        randomField: 'nonsense',
      };

      try {
        await diffusionServer.start(badConfig as any);
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('SERVER_ERROR');
        expect(error.details.unknownFields).toEqual(['randomField']);
        expect(error.details.suggestion).toContain('Remove unrecognized fields');
      }
    });
  });

  describe('generateImage()', () => {
    let spawnedProcess: any;

    const imageConfig: ImageGenerationConfig = {
      prompt: 'A serene mountain landscape at sunset',
      negativePrompt: 'blurry, low quality',
      width: 1024,
      height: 1024,
      steps: 30,
      cfgScale: 7.5,
      seed: 12345,
      sampler: 'euler_a',
    };

    beforeEach(async () => {
      await diffusionServer.start(mockConfig);

      // Clear specific mocks from start(), but preserve process spawn setup
      mockModelManager.getModelInfo.mockClear();
      mockSystemInfo.detect.mockClear();
      mockSystemInfo.canRunModel.mockClear();
      mockEnsureBinary.mockClear();
      mockLogWrite.mockClear();
      mockLogInitialize.mockClear();

      // Re-setup process mock for generateImage tests
      spawnedProcess = new EventEmitter() as any;
      spawnedProcess.pid = 54321;
      spawnedProcess.stdout = new EventEmitter();
      spawnedProcess.stderr = new EventEmitter();
      spawnedProcess.kill = jest.fn();

      // Mock spawn to actually set up event listeners
      mockProcessSpawn.mockImplementation((binaryPath: string, args: string[], options: any) => {
        // Wire up callbacks to process events
        if (options.onStdout) {
          spawnedProcess.stdout.on('data', (data: Buffer) => {
            options.onStdout(data.toString());
          });
        }
        if (options.onStderr) {
          spawnedProcess.stderr.on('data', (data: Buffer) => {
            options.onStderr(data.toString());
          });
        }
        if (options.onExit) {
          spawnedProcess.on('exit', options.onExit);
        }
        if (options.onError) {
          spawnedProcess.on('error', options.onError);
        }
        return spawnedProcess;
      });

      mockProcessKill.mockResolvedValue(undefined); // kill() must return a promise
    });

    afterEach(() => {
      // Clean up test-specific EventEmitters
      if (spawnedProcess) {
        spawnedProcess.removeAllListeners?.();
        spawnedProcess.stdout?.removeAllListeners?.();
        spawnedProcess.stderr?.removeAllListeners?.();
      }
    });

    it('should generate image successfully', async () => {
      const mockImageBuffer = Buffer.from('fake-image-data');
      mockReadFile.mockResolvedValue(mockImageBuffer);
      mockDeleteFile.mockResolvedValue(undefined);

      const progressCallback = jest.fn();

      // Start generation in background
      const resultPromise = diffusionServer.generateImage({
        ...imageConfig,
        onProgress: progressCallback,
      });

      // Wait for spawn to be called (after async log write)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate realistic progress updates from stdout
      spawnedProcess.stdout.emit(
        'data',
        '[INFO ] stable-diffusion.cpp:2121 - generating image: 1/1 - seed 12345\n'
      );
      spawnedProcess.stdout.emit(
        'data',
        '  |====================                              | 5/30 - 2.50it/s\n'
      );
      spawnedProcess.stdout.emit(
        'data',
        '  |========================================          | 10/30 - 2.50it/s\n'
      );
      spawnedProcess.stdout.emit(
        'data',
        '  |==================================================| 30/30 - 2.50it/s\n'
      );

      // Simulate successful completion
      spawnedProcess.emit('exit', 0, null);

      const result = await resultPromise;

      expect(result).toBeDefined();
      expect(result.image).toEqual(mockImageBuffer);
      expect(result.format).toBe('png');
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);
      expect(result.seed).toBe(12345);
      expect(result.timeTaken).toBeGreaterThan(0);

      // Verify process was spawned with correct arguments
      expect(mockProcessSpawn).toHaveBeenCalled();
      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('-m');
      expect(args).toContain(mockModelInfo.path);
      expect(args).toContain('-p');
      expect(args).toContain(imageConfig.prompt);
      expect(args).toContain('-n');
      expect(args).toContain(imageConfig.negativePrompt);
      expect(args).toContain('-W');
      expect(args).toContain('1024');
      expect(args).toContain('-H');
      expect(args).toContain('1024');
      expect(args).toContain('--steps');
      expect(args).toContain('30');
      expect(args).toContain('--cfg-scale');
      expect(args).toContain('7.5');
      expect(args).toContain('-s');
      expect(args).toContain('12345');
      expect(args).toContain('--sampling-method');
      expect(args).toContain('euler_a');

      // Verify progress callbacks were called with stage information
      expect(progressCallback).toHaveBeenCalledWith(5, 30, 'diffusion', expect.any(Number));
      expect(progressCallback).toHaveBeenCalledWith(10, 30, 'diffusion', expect.any(Number));
      expect(progressCallback).toHaveBeenCalledWith(30, 30, 'diffusion', expect.any(Number));

      // Verify temp file was deleted
      expect(mockDeleteFile).toHaveBeenCalled();
    });

    it('should handle minimal configuration', async () => {
      const mockImageBuffer = Buffer.from('fake-image-data');
      mockReadFile.mockResolvedValue(mockImageBuffer);

      const minimalConfig: ImageGenerationConfig = {
        prompt: 'Simple prompt',
      };

      const resultPromise = diffusionServer.generateImage(minimalConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 0, null);

      const result = await resultPromise;

      expect(result).toBeDefined();
      expect(result.width).toBe(512); // Default
      expect(result.height).toBe(512); // Default
    });

    it('should throw ServerError if not running', async () => {
      await diffusionServer.stop();

      await expect(diffusionServer.generateImage(imageConfig)).rejects.toThrow('not running');
    });

    it('should throw ServerError if already busy', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('image'));

      // Start first generation (don't await yet)
      const firstGeneration = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to start second generation while first is running
      await expect(diffusionServer.generateImage(imageConfig)).rejects.toThrow('busy');

      // Complete first generation
      spawnedProcess.emit('exit', 0, null);
      await firstGeneration;
    });

    it('should throw ServerError if process exits with non-zero code', async () => {
      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 1, null);

      await expect(resultPromise).rejects.toThrow('exited with code 1');
    });

    it('should include stderr in error details on crash', async () => {
      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Emit stderr before crash
      spawnedProcess.stderr.emit('data', Buffer.from('CUDA error: out of memory\n'));
      spawnedProcess.stderr.emit('data', Buffer.from('Failed to allocate tensor\n'));
      spawnedProcess.emit('exit', 1, null);

      try {
        await resultPromise;
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('exited with code 1');
        expect(error.details).toBeDefined();
        expect(error.details.exitCode).toBe(1);
        expect(error.details.stderr).toContain('CUDA error: out of memory');
        expect(error.details.stderr).toContain('Failed to allocate tensor');
      }
    });

    it('should cap stderr at 20 lines in error details', async () => {
      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Emit 30 lines of stderr
      for (let i = 0; i < 30; i++) {
        spawnedProcess.stderr.emit('data', Buffer.from(`stderr line ${i}\n`));
      }
      spawnedProcess.emit('exit', 1, null);

      try {
        await resultPromise;
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.stderr).toBeDefined();
        const lines = error.details.stderr.split('\n');
        expect(lines).toHaveLength(20);
        // Should contain the last 20 lines (10-29), not the first
        expect(lines[0]).toBe('stderr line 10');
        expect(lines[19]).toBe('stderr line 29');
      }
    });

    it('should not include stderr field when no stderr output', async () => {
      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Exit with error but no stderr
      spawnedProcess.emit('exit', 1, null);

      try {
        await resultPromise;
        throw new Error('Should have thrown');
      } catch (error: any) {
        expect(error.details.exitCode).toBe(1);
        expect(error.details.stderr).toBeUndefined();
      }
    });

    it('should throw ServerError if image file cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 0, null);

      await expect(resultPromise).rejects.toThrow('Failed to read generated image');
    });

    it('should not pass --n-gpu-layers to sd.cpp (unsupported flag)', async () => {
      await diffusionServer.stop();

      const gpuConfig: DiffusionServerConfig = {
        ...mockConfig,
        gpuLayers: 25,
        threads: 8,
      };

      await diffusionServer.start(gpuConfig);
      mockReadFile.mockResolvedValue(Buffer.from('image'));

      const resultPromise = diffusionServer.generateImage({ prompt: 'test' });

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 0, null);
      await resultPromise;

      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      // stable-diffusion.cpp doesn't support --n-gpu-layers (that's llama.cpp)
      expect(args).not.toContain('--n-gpu-layers');
      // threads should still be passed
      expect(args).toContain('-t');
      expect(args).toContain('8');
    });

    it('should update busy status correctly', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('image'));

      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called (currentGeneration is set after promise creation)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check busy during generation
      let info = diffusionServer.getInfo();
      expect((info as any).busy).toBe(true);

      // Complete generation
      spawnedProcess.emit('exit', 0, null);
      await resultPromise;

      // Check not busy after completion
      info = diffusionServer.getInfo();
      expect((info as any).busy).toBe(false);
    });

    describe('progress calibration', () => {
      it('should report progress at stage transitions without progress bars', async () => {
        const mockImageBuffer = Buffer.from('fake-image-data');
        mockReadFile.mockResolvedValue(mockImageBuffer);
        mockDeleteFile.mockResolvedValue(undefined);

        const progressCallback = jest.fn();

        const resultPromise = diffusionServer.generateImage({
          ...imageConfig,
          onProgress: progressCallback,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Emit stage transitions only (no progress bars)
        spawnedProcess.stdout.emit('data', '[INFO ] loading tensors from /models/sdxl.gguf\n');
        spawnedProcess.stdout.emit(
          'data',
          '[INFO ] stable-diffusion.cpp:2121 - generating image: 1/1 - seed 12345\n'
        );
        spawnedProcess.stdout.emit('data', '[INFO ] decoding 1 latents\n');
        spawnedProcess.stdout.emit('data', '[INFO ] decode_first_stage completed\n');

        spawnedProcess.emit('exit', 0, null);
        await resultPromise;

        // Verify progress was reported at each stage transition
        expect(progressCallback).toHaveBeenCalledWith(0, 0, 'loading', expect.any(Number));
        expect(progressCallback).toHaveBeenCalledWith(0, 0, 'diffusion', expect.any(Number));
        expect(progressCallback).toHaveBeenCalledWith(0, 0, 'decoding', expect.any(Number));
        // VAE completion reports 100%
        expect(progressCallback).toHaveBeenCalledWith(0, 0, 'decoding', 100);
      });

      it('should recalculate denominator at stage transitions so percentage does not clamp prematurely', async () => {
        const mockImageBuffer = Buffer.from('fake-image-data');
        mockReadFile.mockResolvedValue(mockImageBuffer);
        mockDeleteFile.mockResolvedValue(undefined);

        const percentages: { stage: string; pct: number }[] = [];
        const progressCallback = jest.fn(
          (currentStep: number, totalSteps: number, stage: string, percentage: number) => {
            percentages.push({ stage, pct: percentage });
          }
        );

        const resultPromise = diffusionServer.generateImage({
          ...imageConfig,
          onProgress: progressCallback,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Simulate full pipeline with near-instantaneous loading
        spawnedProcess.stdout.emit('data', 'loading tensors from /models/sdxl.gguf\n');
        spawnedProcess.stdout.emit(
          'data',
          'stable-diffusion.cpp:2121 - generating image: 1/1 - seed 12345\n'
        );

        // Emit diffusion progress bars
        spawnedProcess.stdout.emit('data', '  |=====     | 1/4 - 2.00it/s\n');
        spawnedProcess.stdout.emit('data', '  |==========| 4/4 - 2.00it/s\n');

        spawnedProcess.stdout.emit('data', 'decoding 1 latents\n');
        spawnedProcess.stdout.emit('data', 'decode_first_stage completed\n');

        spawnedProcess.emit('exit', 0, null);
        await resultPromise;

        // Percentage at diffusion transition should be near 0% (not near 100%)
        // because recalculation replaced the estimated load time with actual (near-0)
        const diffusionTransition = percentages.find((p) => p.stage === 'diffusion');
        expect(diffusionTransition).toBeDefined();
        expect(diffusionTransition!.pct).toBeLessThan(10);
      });

      it('should infer VAE calibration when decode_first_stage completed is missing', async () => {
        const mockImageBuffer = Buffer.from('fake-image-data');
        mockReadFile.mockResolvedValue(mockImageBuffer);
        mockDeleteFile.mockResolvedValue(undefined);

        // Mock Date.now for controlled timing
        let mockTime = 10000;
        const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => mockTime);

        try {
          // --- Generation 1: loading + diffusion markers but NO VAE end marker ---
          // 512x512 = 0.262144 megapixels, 4 steps
          const gen1Promise = diffusionServer.generateImage({
            ...imageConfig,
            width: 512,
            height: 512,
            steps: 4,
            onProgress: jest.fn(),
          });

          await new Promise((resolve) => setTimeout(resolve, 50));

          // Loading at t=10s
          mockTime = 10000;
          spawnedProcess.stdout.emit('data', 'loading tensors from /models/sdxl.gguf\n');
          // Diffusion at t=11s (1s loading)
          mockTime = 11000;
          spawnedProcess.stdout.emit('data', 'generating image: 1/1 - seed 12345\n');
          // VAE at t=12s (1s diffusion)
          mockTime = 12000;
          spawnedProcess.stdout.emit('data', 'decoding 1 latents\n');
          // Exit at t=22s (10s VAE, no end marker)
          mockTime = 22000;
          spawnedProcess.emit('exit', 0, null);
          await gen1Promise;

          // After gen 1 inference:
          // actualLoad=1s, actualDiffusion=1s, inferredVAE ≈ 10s
          // vaeTimePerMegapixel = 10000 / 0.262144 ≈ 38147

          // --- Generation 2: verify calibrated VAE estimate ---
          spawnedProcess.removeAllListeners();
          spawnedProcess.stdout.removeAllListeners();
          spawnedProcess.stderr.removeAllListeners();
          spawnedProcess = new EventEmitter() as any;
          spawnedProcess.pid = 54322;
          spawnedProcess.stdout = new EventEmitter();
          spawnedProcess.stderr = new EventEmitter();
          spawnedProcess.kill = jest.fn();

          mockProcessSpawn.mockImplementation(
            (binaryPath: string, args: string[], options: any) => {
              if (options.onStdout) {
                spawnedProcess.stdout.on('data', (data: Buffer) => {
                  options.onStdout(data.toString());
                });
              }
              if (options.onStderr) {
                spawnedProcess.stderr.on('data', (data: Buffer) => {
                  options.onStderr(data.toString());
                });
              }
              if (options.onExit) {
                spawnedProcess.on('exit', options.onExit);
              }
              if (options.onError) {
                spawnedProcess.on('error', options.onError);
              }
              return spawnedProcess;
            }
          );

          const gen2Percentages: { stage: string; pct: number }[] = [];
          const gen2Callback = jest.fn(
            (_step: number, _total: number, stage: string, pct: number) => {
              gen2Percentages.push({ stage, pct });
            }
          );

          // Start gen 2 at t=30s
          mockTime = 30000;
          const gen2Promise = diffusionServer.generateImage({
            ...imageConfig,
            width: 512,
            height: 512,
            steps: 4,
            onProgress: gen2Callback,
          });

          await new Promise((resolve) => setTimeout(resolve, 50));

          // Loading at t=30s
          mockTime = 30000;
          spawnedProcess.stdout.emit('data', 'loading tensors from /models/sdxl.gguf\n');
          // Diffusion at t=31s (1s loading)
          mockTime = 31000;
          spawnedProcess.stdout.emit('data', 'generating image: 1/1 - seed 12345\n');
          // VAE at t=32s (1s diffusion)
          mockTime = 32000;
          spawnedProcess.stdout.emit('data', 'decoding 1 latents\n');

          // Exit at t=42s
          mockTime = 42000;
          spawnedProcess.emit('exit', 0, null);
          await gen2Promise;

          // With calibrated estimates from gen 1:
          // totalEstimatedTime at VAE start = actualLoad(1s) + actualDiffusion(1s) + estVAE(10s) = 12s
          // elapsedTotal at VAE start = 1s + 1s + 0 = 2s
          // percentage at VAE start = 2000/12000 * 100 ≈ 17%
          const vaeTransition = gen2Percentages.find((p) => p.stage === 'decoding');
          expect(vaeTransition).toBeDefined();
          expect(vaeTransition!.pct).toBeGreaterThan(0);
          expect(vaeTransition!.pct).toBeLessThan(50);

          // Without inference, the default vaeTimePerMegapixel=8000 would give estVAE=2097ms
          // totalEstimatedTime = 1000 + 1000 + 2097 = 4097ms
          // percentage at VAE start = 2000/4097 ≈ 49%
          // With inference, the calibrated vaeTimePerMegapixel≈38147 gives estVAE≈10000ms
          // percentage at VAE start = 2000/12000 ≈ 17%
          // So the percentage should be well below 49% (the default would give)
          expect(vaeTransition!.pct).toBeLessThan(30);
        } finally {
          dateNowSpy.mockRestore();
        }
      });

      it('should calibrate times across generations for better accuracy', async () => {
        const mockImageBuffer = Buffer.from('fake-image-data');
        mockReadFile.mockResolvedValue(mockImageBuffer);
        mockDeleteFile.mockResolvedValue(undefined);

        // --- Generation 1: all three stage markers present ---
        const gen1Promise = diffusionServer.generateImage({
          ...imageConfig,
          width: 512,
          height: 512,
          steps: 4,
          onProgress: jest.fn(),
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        spawnedProcess.stdout.emit('data', 'loading tensors from /models/sdxl.gguf\n');
        await new Promise((resolve) => setTimeout(resolve, 20));
        spawnedProcess.stdout.emit('data', 'generating image: 1/1 - seed 12345\n');
        await new Promise((resolve) => setTimeout(resolve, 20));
        spawnedProcess.stdout.emit('data', 'decoding 1 latents\n');
        await new Promise((resolve) => setTimeout(resolve, 20));
        spawnedProcess.stdout.emit('data', 'decode_first_stage completed\n');

        spawnedProcess.emit('exit', 0, null);
        await gen1Promise;

        // --- Generation 2: verify calibrated estimates produce non-default percentages ---
        spawnedProcess.removeAllListeners();
        spawnedProcess.stdout.removeAllListeners();
        spawnedProcess.stderr.removeAllListeners();
        spawnedProcess = new EventEmitter() as any;
        spawnedProcess.pid = 54323;
        spawnedProcess.stdout = new EventEmitter();
        spawnedProcess.stderr = new EventEmitter();
        spawnedProcess.kill = jest.fn();

        mockProcessSpawn.mockImplementation((binaryPath: string, args: string[], options: any) => {
          if (options.onStdout) {
            spawnedProcess.stdout.on('data', (data: Buffer) => {
              options.onStdout(data.toString());
            });
          }
          if (options.onStderr) {
            spawnedProcess.stderr.on('data', (data: Buffer) => {
              options.onStderr(data.toString());
            });
          }
          if (options.onExit) {
            spawnedProcess.on('exit', options.onExit);
          }
          if (options.onError) {
            spawnedProcess.on('error', options.onError);
          }
          return spawnedProcess;
        });

        const gen2Percentages: number[] = [];
        const gen2Callback = jest.fn(
          (_step: number, _total: number, _stage: string, pct: number) => {
            gen2Percentages.push(pct);
          }
        );

        const gen2Promise = diffusionServer.generateImage({
          ...imageConfig,
          width: 512,
          height: 512,
          steps: 4,
          onProgress: gen2Callback,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        spawnedProcess.stdout.emit('data', 'loading tensors from /models/sdxl.gguf\n');
        spawnedProcess.stdout.emit('data', 'generating image: 1/1 - seed 12345\n');
        spawnedProcess.stdout.emit('data', 'decoding 1 latents\n');
        spawnedProcess.stdout.emit('data', 'decode_first_stage completed\n');

        spawnedProcess.emit('exit', 0, null);
        await gen2Promise;

        // Gen 2 used calibrated estimates from gen 1, so progress was reported
        expect(gen2Callback).toHaveBeenCalled();
        // All percentages should be valid numbers between 0 and 100
        const nonFinalPcts = gen2Percentages.filter((p) => p < 100);
        for (const pct of nonFinalPcts) {
          expect(pct).toBeGreaterThanOrEqual(0);
          expect(pct).toBeLessThanOrEqual(100);
        }
        // Should reach 100% at completion
        expect(gen2Percentages).toContain(100);
      });
    });
  });

  describe('stop()', () => {
    let spawnedProcess: any;

    beforeEach(async () => {
      await diffusionServer.start(mockConfig);

      // Setup process mocks for "cancel ongoing generation" test
      spawnedProcess = new EventEmitter() as any;
      spawnedProcess.pid = 54321;
      spawnedProcess.stdout = new EventEmitter();
      spawnedProcess.stderr = new EventEmitter();
      spawnedProcess.kill = jest.fn();

      mockProcessSpawn.mockImplementation((binaryPath: string, args: string[], options: any) => {
        if (options.onStdout) {
          spawnedProcess.stdout.on('data', (data: Buffer) => {
            options.onStdout(data.toString());
          });
        }
        if (options.onStderr) {
          spawnedProcess.stderr.on('data', (data: Buffer) => {
            options.onStderr(data.toString());
          });
        }
        if (options.onExit) {
          spawnedProcess.on('exit', options.onExit);
        }
        if (options.onError) {
          spawnedProcess.on('error', options.onError);
        }
        return spawnedProcess;
      });

      mockProcessKill.mockResolvedValue(undefined);
    });

    afterEach(() => {
      // Clean up test-specific EventEmitters
      if (spawnedProcess) {
        spawnedProcess.removeAllListeners?.();
        spawnedProcess.stdout?.removeAllListeners?.();
        spawnedProcess.stderr?.removeAllListeners?.();
      }
    });

    it('should stop server gracefully', async () => {
      await diffusionServer.stop();

      expect(mockHttpServer.close).toHaveBeenCalled();

      const status = diffusionServer.getInfo();
      expect(status.status).toBe('stopped');
      expect(status.port).toBe(0);
    });

    it('should cancel ongoing generation', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('image'));

      // Start generation
      const resultPromise = diffusionServer.generateImage({ prompt: 'test' });

      // Wait for spawn to be called
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop server while generating
      await diffusionServer.stop();

      // Generation should be cancelled
      expect(mockProcessKill).toHaveBeenCalled();

      // Complete the promise (it will reject due to cancellation)
      spawnedProcess.emit('exit', 1, null);
      await expect(resultPromise).rejects.toThrow();
    });

    it('should emit stopped event', async () => {
      const stoppedHandler = jest.fn();
      diffusionServer.on('stopped', stoppedHandler);

      await diffusionServer.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should handle already stopped server', async () => {
      await diffusionServer.stop();

      // Stop again - should not throw
      await expect(diffusionServer.stop()).resolves.not.toThrow();
    });
  });

  describe('isHealthy()', () => {
    it('should return false when not running', async () => {
      const healthy = await diffusionServer.isHealthy();

      expect(healthy).toBe(false);
    });

    it('should return true when running', async () => {
      await diffusionServer.start(mockConfig);

      const healthy = await diffusionServer.isHealthy();

      expect(healthy).toBe(true);
    });

    it('should return false after stop', async () => {
      await diffusionServer.start(mockConfig);
      await diffusionServer.stop();

      const healthy = await diffusionServer.isHealthy();

      expect(healthy).toBe(false);
    });
  });

  describe('getLogs()', () => {
    beforeEach(async () => {
      await diffusionServer.start(mockConfig);
    });

    it('should return recent logs', async () => {
      const mockLogs = ['Log line 1', 'Log line 2', 'Log line 3'];
      mockLogGetRecent.mockResolvedValue(mockLogs);

      const logs = await diffusionServer.getLogs();

      expect(logs).toEqual(mockLogs);
      expect(mockLogGetRecent).toHaveBeenCalledWith(100);
    });

    it('should allow custom log line count', async () => {
      mockLogGetRecent.mockResolvedValue([]);

      await diffusionServer.getLogs(50);

      expect(mockLogGetRecent).toHaveBeenCalledWith(50);
    });

    it('should return empty array if no log manager', async () => {
      const newServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

      const logs = await newServer.getLogs();

      expect(logs).toEqual([]);
    });
  });

  describe('clearLogs()', () => {
    beforeEach(async () => {
      await diffusionServer.start(mockConfig);
    });

    it('should clear logs', async () => {
      await diffusionServer.clearLogs();

      expect(mockLogClear).toHaveBeenCalled();
    });

    it('should not throw if log manager not initialized', async () => {
      const newServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

      await expect(newServer.clearLogs()).resolves.not.toThrow();
    });
  });

  describe('HTTP endpoints', () => {
    beforeEach(async () => {
      await diffusionServer.start(mockConfig);
    });

    it('should handle /health endpoint', () => {
      const requestHandler = mockCreateServer.mock.calls[0][0];
      const req = new EventEmitter() as any;
      req.url = '/health';
      req.method = 'GET';

      const res = {
        setHeader: jest.fn(),
        writeHead: jest.fn(),
        end: jest.fn(),
      } as any;

      requestHandler(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('"status":"ok"'));
    });

    it('should handle CORS preflight', () => {
      const requestHandler = mockCreateServer.mock.calls[0][0];
      const req = new EventEmitter() as any;
      req.url = '/health';
      req.method = 'OPTIONS';

      const res = {
        setHeader: jest.fn(),
        writeHead: jest.fn(),
        end: jest.fn(),
      } as any;

      requestHandler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(res.writeHead).toHaveBeenCalledWith(200);
    });

    it('should return 404 for unknown endpoints', () => {
      const requestHandler = mockCreateServer.mock.calls[0][0];
      const req = new EventEmitter() as any;
      req.url = '/unknown';
      req.method = 'GET';

      const res = {
        setHeader: jest.fn(),
        writeHead: jest.fn(),
        end: jest.fn(),
      } as any;

      requestHandler(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('"error"'));
    });
  });

  describe('getInfo()', () => {
    it('should return stopped status initially', () => {
      const info = diffusionServer.getInfo();

      expect(info.status).toBe('stopped');
      expect((info as any).busy).toBe(false);
    });

    it('should return running status after start', async () => {
      await diffusionServer.start(mockConfig);

      const info = diffusionServer.getInfo();

      expect(info.status).toBe('running');
      expect(info.port).toBe(8081);
      expect(info.modelId).toBe('sdxl-turbo');
      expect((info as any).busy).toBe(false);
    });
  });

  describe('VRAM optimization auto-detection', () => {
    // Small model (2.9 GB) for headroom tests
    const smallModelInfo: ModelInfo = {
      ...mockModelInfo,
      size: 2.9 * 1024 ** 3, // 2.9 GB → footprint = 3.48 GB
    };

    let spawnedProcess: any;

    /**
     * Helper: start server with given model, run generateImage, return spawned args
     */
    async function generateAndCaptureArgs(
      server: DiffusionServerManager,
      serverConfig: DiffusionServerConfig,
      model: ModelInfo
    ): Promise<string[]> {
      mockModelManager.getModelInfo.mockResolvedValue(model);
      await server.start(serverConfig);

      const mockImageBuffer = Buffer.from('fake-image-data');
      mockReadFile.mockResolvedValue(mockImageBuffer);

      spawnedProcess = new EventEmitter() as any;
      spawnedProcess.pid = 99999;
      spawnedProcess.stdout = new EventEmitter();
      spawnedProcess.stderr = new EventEmitter();
      spawnedProcess.kill = jest.fn();

      mockProcessSpawn.mockImplementation((_bin: string, _args: string[], options: any) => {
        if (options.onExit) spawnedProcess.on('exit', options.onExit);
        if (options.onError) spawnedProcess.on('error', options.onError);
        return spawnedProcess;
      });

      const resultPromise = server.generateImage({ prompt: 'test' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      spawnedProcess.emit('exit', 0, null);
      await resultPromise;

      const spawnCall = mockProcessSpawn.mock.calls[0];
      return spawnCall[1] as string[];
    }

    afterEach(() => {
      if (spawnedProcess) {
        spawnedProcess.removeAllListeners?.();
        spawnedProcess.stdout?.removeAllListeners?.();
        spawnedProcess.stderr?.removeAllListeners?.();
      }
    });

    it('should enable --clip-on-cpu on 8 GB GPU with 2.9 GB model (headroom < 6 GB)', async () => {
      // 8 GB VRAM - 3.48 GB footprint = 4.52 GB headroom → clip ON, vae OFF
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, mockConfig, smallModelInfo);

      expect(args).toContain('--clip-on-cpu');
      expect(args).not.toContain('--vae-on-cpu');

      await server.stop();
    });

    it('should not enable either flag on 12 GB GPU with 2.9 GB model (headroom >= 6 GB)', async () => {
      // 12 GB VRAM - 3.48 GB footprint = 8.52 GB headroom → clip OFF, vae OFF
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 12 * 1024 ** 3,
      });

      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, mockConfig, smallModelInfo);

      expect(args).not.toContain('--clip-on-cpu');
      expect(args).not.toContain('--vae-on-cpu');

      await server.stop();
    });

    it('should enable both flags on 8 GB GPU with 6.5 GB model (headroom < 2 GB)', async () => {
      // 8 GB VRAM - 7.8 GB footprint = 0.2 GB headroom → clip ON, vae ON
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, mockConfig, mockModelInfo);

      expect(args).toContain('--clip-on-cpu');
      expect(args).toContain('--vae-on-cpu');

      await server.stop();
    });

    it('should enable --clip-on-cpu when no GPU is available', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: false,
      });

      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, mockConfig, smallModelInfo);

      expect(args).toContain('--clip-on-cpu');
      expect(args).not.toContain('--vae-on-cpu');

      await server.stop();
    });

    it('should respect user override clipOnCpu: false on 8 GB GPU', async () => {
      // Auto would be clip ON, but user says no
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 8 * 1024 ** 3,
      });

      const overrideConfig: DiffusionServerConfig = { ...mockConfig, clipOnCpu: false };
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, overrideConfig, smallModelInfo);

      expect(args).not.toContain('--clip-on-cpu');

      await server.stop();
    });

    it('should respect user override clipOnCpu: true on 24 GB GPU', async () => {
      // Auto would be clip OFF, but user forces it on
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 24 * 1024 ** 3,
      });

      const overrideConfig: DiffusionServerConfig = { ...mockConfig, clipOnCpu: true };
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, overrideConfig, smallModelInfo);

      expect(args).toContain('--clip-on-cpu');

      await server.stop();
    });

    it('should pass through batchSize as -b flag', async () => {
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 24 * 1024 ** 3,
      });

      const batchConfig: DiffusionServerConfig = { ...mockConfig, batchSize: 4 };
      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, batchConfig, smallModelInfo);

      expect(args).toContain('-b');
      expect(args).toContain('4');

      await server.stop();
    });

    it('should escalate to clip-on-cpu when vramAvailable is critically low', async () => {
      // Total VRAM is 12 GB (headroom = 8.52 GB, normally no clip-on-cpu)
      // But vramAvailable = 4 GB (available - footprint = 0.52 GB < 2 GB → escalate)
      mockSystemInfo.getGPUInfo.mockResolvedValue({
        available: true,
        type: 'nvidia',
        vram: 12 * 1024 ** 3,
        vramAvailable: 4 * 1024 ** 3,
      });

      const server = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);
      const args = await generateAndCaptureArgs(server, mockConfig, smallModelInfo);

      expect(args).toContain('--clip-on-cpu');

      await server.stop();
    });
  });
});
