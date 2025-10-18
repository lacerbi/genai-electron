/**
 * Unit tests for DiffusionServerManager
 * Tests diffusion HTTP wrapper server lifecycle and image generation
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { DiffusionServerConfig, ModelInfo, ImageGenerationConfig } from '../../src/types/index.js';

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
    mockEnsureBinary.mockResolvedValue('/test/binaries/stable-diffusion');
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
    mockIsServerResponding.mockResolvedValue(false); // Port is available

    // Mock process spawn
    const mockProcess = new EventEmitter() as any;
    mockProcess.pid = 54321;
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.kill = jest.fn();
    mockProcessSpawn.mockReturnValue(mockProcess);
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

      // Verify system checks
      expect(mockSystemInfo.canRunModel).toHaveBeenCalledWith(mockModelInfo);

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
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate progress updates from stdout
      spawnedProcess.stdout.emit('data', 'step 5/30\n');
      spawnedProcess.stdout.emit('data', 'step 10/30\n');
      spawnedProcess.stdout.emit('data', 'step 30/30\n');

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

      // Verify progress callbacks were called
      expect(progressCallback).toHaveBeenCalledWith(5, 30);
      expect(progressCallback).toHaveBeenCalledWith(10, 30);
      expect(progressCallback).toHaveBeenCalledWith(30, 30);

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
      await new Promise(resolve => setTimeout(resolve, 50));

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
      await new Promise(resolve => setTimeout(resolve, 50));

      // Try to start second generation while first is running
      await expect(diffusionServer.generateImage(imageConfig)).rejects.toThrow('busy');

      // Complete first generation
      spawnedProcess.emit('exit', 0, null);
      await firstGeneration;
    });

    it('should throw ServerError if process exits with non-zero code', async () => {
      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise(resolve => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 1, null);

      await expect(resultPromise).rejects.toThrow('exited with code 1');
    });

    it('should throw ServerError if image file cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called
      await new Promise(resolve => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 0, null);

      await expect(resultPromise).rejects.toThrow('Failed to read generated image');
    });

    it('should include GPU layers in args if configured', async () => {
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
      await new Promise(resolve => setTimeout(resolve, 50));

      spawnedProcess.emit('exit', 0, null);
      await resultPromise;

      const spawnCall = mockProcessSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).toContain('--n-gpu-layers');
      expect(args).toContain('25');
      expect(args).toContain('-t');
      expect(args).toContain('8');
    });

    it('should update busy status correctly', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('image'));

      const resultPromise = diffusionServer.generateImage(imageConfig);

      // Wait for spawn to be called (currentGeneration is set after promise creation)
      await new Promise(resolve => setTimeout(resolve, 50));

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
      await new Promise(resolve => setTimeout(resolve, 50));

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
      expect(res.end).toHaveBeenCalledWith(
        expect.stringContaining('"status":"ok"')
      );
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
});
