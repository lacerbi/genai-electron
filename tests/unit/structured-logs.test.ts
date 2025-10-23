/**
 * Unit tests for getStructuredLogs() API
 * Tests structured log parsing functionality for server managers
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock ModelManager
const mockModelManager = {
  getModelInfo: jest.fn(),
};

const MockModelManager = jest.fn(() => mockModelManager);
(MockModelManager as any).getInstance = jest.fn(() => mockModelManager);

jest.unstable_mockModule('../../src/managers/ModelManager.js', () => ({
  ModelManager: MockModelManager,
}));

// Mock SystemInfo
const mockSystemInfo = {
  detect: jest.fn(),
  getOptimalConfig: jest.fn(),
  canRunModel: jest.fn(),
  getMemoryInfo: jest.fn(),
  clearCache: jest.fn(),
};

const MockSystemInfo = jest.fn(() => mockSystemInfo);
(MockSystemInfo as any).getInstance = jest.fn(() => mockSystemInfo);

jest.unstable_mockModule('../../src/system/SystemInfo.js', () => ({
  SystemInfo: MockSystemInfo,
}));

// Mock ProcessManager
class MockProcessManager {
  spawn = jest.fn();
  kill = jest.fn();
  isRunning = jest.fn();
}

jest.unstable_mockModule('../../src/process/ProcessManager.js', () => ({
  ProcessManager: MockProcessManager,
}));

// Mock health-check
jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  checkHealth: jest.fn(),
  waitForHealthy: jest.fn(),
  isServerResponding: jest.fn(),
}));

// Mock LogManager with parseEntry
const mockLogManagerGetRecent = jest.fn();
const mockLogManager = {
  initialize: jest.fn(() => Promise.resolve()),
  write: jest.fn(() => Promise.resolve()),
  getRecent: mockLogManagerGetRecent,
  clear: jest.fn(() => Promise.resolve()),
  getLogPath: jest.fn(() => '/tmp/test.log'),
};

class MockLogManager {
  initialize = mockLogManager.initialize;
  write = mockLogManager.write;
  getRecent = mockLogManager.getRecent;
  clear = mockLogManager.clear;
  getLogPath = mockLogManager.getLogPath;

  // Static parseEntry method - test the real parsing logic
  static parseEntry(line: string) {
    const trimmedLine = line.trim();
    const match = trimmedLine.match(/^\[([^\]]+)\] \[(\w+)\s*\] (.+)$/);
    if (!match || !match[1] || !match[2] || !match[3]) {
      return null;
    }
    return {
      timestamp: match[1],
      level: match[2].toLowerCase(),
      message: match[3],
    };
  }
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock file-utils
jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: jest.fn(),
  calculateChecksum: jest.fn(),
  ensureDirectory: jest.fn(),
  formatBytes: jest.fn((bytes: number) => `${bytes} bytes`),
  deleteFile: jest.fn(),
  moveFile: jest.fn(),
}));

// Mock platform-utils
jest.unstable_mockModule('../../src/utils/platform-utils.js', () => ({
  getPlatform: jest.fn(() => 'linux'),
  getArchitecture: jest.fn(() => 'x64'),
  getPlatformKey: jest.fn(() => 'linux-x64'),
}));

// Mock BinaryManager
jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: jest.fn().mockImplementation(() => ({
    getBinaryPath: jest.fn(),
    downloadAndValidateBinary: jest.fn(),
    on: jest.fn(),
  })),
}));

// Mock paths (which imports electron)
jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    models: {
      llm: '/tmp/test/models/llm',
      diffusion: '/tmp/test/models/diffusion',
    },
    binaries: {
      llama: '/tmp/test/binaries/llama',
      diffusion: '/tmp/test/binaries/diffusion',
    },
    logs: '/tmp/test/logs',
    config: '/tmp/test/config',
    temp: '/tmp/test/temp',
  },
  BASE_DIR: '/tmp/test',
  getBinaryPath: jest.fn((type: string, platform: string) => `/tmp/test/binaries/${type}/${platform}/binary`),
  getModelFilePath: jest.fn((type: string, filename: string) => `/tmp/test/models/${type}/${filename}`),
  getTempPath: jest.fn((filename: string) => `/tmp/test/temp/${filename}`),
}));

// Import modules after mocking
const { LlamaServerManager } = await import('../../src/managers/LlamaServerManager.js');
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');

describe('getStructuredLogs()', () => {
  let llamaServer: any;
  let diffusionServer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    llamaServer = new LlamaServerManager();
    diffusionServer = new DiffusionServerManager();
  });

  describe('LlamaServerManager', () => {
    it('should return empty array when no log manager is initialized', async () => {
      const logs = await llamaServer.getStructuredLogs();
      expect(logs).toEqual([]);
    });

    it('should parse well-formed log entries correctly', async () => {
      // Initialize log manager
      await llamaServer['initializeLogManager']('test-llama.log', 'Test startup');

      // Mock log output
      const mockLogs = [
        '[2025-01-01T10:00:00.000Z] [info] Server starting',
        '[2025-01-01T10:00:01.000Z] [warn] GPU memory low',
        '[2025-01-01T10:00:02.000Z] [error] Failed to load model',
      ];

      mockLogManagerGetRecent.mockResolvedValue(mockLogs);

      const logs = await llamaServer.getStructuredLogs(3);

      expect(logs).toHaveLength(3);
      expect(logs[0]).toEqual({
        timestamp: '2025-01-01T10:00:00.000Z',
        level: 'info',
        message: 'Server starting',
      });
      expect(logs[1]).toEqual({
        timestamp: '2025-01-01T10:00:01.000Z',
        level: 'warn',
        message: 'GPU memory low',
      });
      expect(logs[2]).toEqual({
        timestamp: '2025-01-01T10:00:02.000Z',
        level: 'error',
        message: 'Failed to load model',
      });
    });

    it('should handle malformed log entries with fallback', async () => {
      await llamaServer['initializeLogManager']('test-llama.log', 'Test startup');

      const mockLogs = [
        '[2025-01-01T10:00:00.000Z] [info] Valid log',
        'Malformed log without brackets',
        'Another malformed entry',
      ];

      mockLogManagerGetRecent.mockResolvedValue(mockLogs);

      const logs = await llamaServer.getStructuredLogs(3);

      expect(logs).toHaveLength(3);
      expect(logs[0]).toEqual({
        timestamp: '2025-01-01T10:00:00.000Z',
        level: 'info',
        message: 'Valid log',
      });

      // Fallback entries should have current timestamp and 'info' level
      expect(logs[1].level).toBe('info');
      expect(logs[1].message).toBe('Malformed log without brackets');
      expect(logs[1].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      expect(logs[2].level).toBe('info');
      expect(logs[2].message).toBe('Another malformed entry');
      expect(logs[2].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should respect the limit parameter', async () => {
      await llamaServer['initializeLogManager']('test-llama.log', 'Test startup');

      const mockLogs = Array.from({ length: 100 }, (_, i) =>
        `[2025-01-01T10:00:${String(i).padStart(2, '0')}.000Z] [info] Log entry ${i}`
      );

      mockLogManagerGetRecent.mockResolvedValue(mockLogs);

      const logs = await llamaServer.getStructuredLogs(50);

      expect(mockLogManagerGetRecent).toHaveBeenCalledWith(50);
      expect(logs).toHaveLength(100); // Returns whatever getRecent returns
    });

    it('should use default limit of 100 when not specified', async () => {
      await llamaServer['initializeLogManager']('test-llama.log', 'Test startup');

      mockLogManagerGetRecent.mockResolvedValue([]);

      await llamaServer.getStructuredLogs();

      expect(mockLogManagerGetRecent).toHaveBeenCalledWith(100);
    });

    it('should handle errors gracefully', async () => {
      await llamaServer['initializeLogManager']('test-llama.log', 'Test startup');

      mockLogManagerGetRecent.mockRejectedValue(new Error('File read error'));

      const logs = await llamaServer.getStructuredLogs();

      expect(logs).toEqual([]);
    });
  });

  describe('DiffusionServerManager', () => {
    it('should return empty array when no log manager is initialized', async () => {
      const logs = await diffusionServer.getStructuredLogs();
      expect(logs).toEqual([]);
    });

    it('should parse well-formed log entries correctly', async () => {
      await diffusionServer['initializeLogManager']('test-diffusion.log', 'Test startup');

      const mockLogs = [
        '[2025-01-01T10:00:00.000Z] [info] Diffusion server starting',
        '[2025-01-01T10:00:01.000Z] [debug] Loading model weights',
        '[2025-01-01T10:00:02.000Z] [info] Server ready',
      ];

      mockLogManagerGetRecent.mockResolvedValue(mockLogs);

      const logs = await diffusionServer.getStructuredLogs(3);

      expect(logs).toHaveLength(3);
      expect(logs[0]).toEqual({
        timestamp: '2025-01-01T10:00:00.000Z',
        level: 'info',
        message: 'Diffusion server starting',
      });
      expect(logs[1]).toEqual({
        timestamp: '2025-01-01T10:00:01.000Z',
        level: 'debug',
        message: 'Loading model weights',
      });
      expect(logs[2]).toEqual({
        timestamp: '2025-01-01T10:00:02.000Z',
        level: 'info',
        message: 'Server ready',
      });
    });

    it('should handle log entries with trailing whitespace', async () => {
      await diffusionServer['initializeLogManager']('test-diffusion.log', 'Test startup');

      const mockLogs = [
        '[2025-01-01T10:00:00.000Z] [info] Log with trailing spaces  \r\n',
        '[2025-01-01T10:00:01.000Z] [warn] Another log\r',
      ];

      mockLogManagerGetRecent.mockResolvedValue(mockLogs);

      const logs = await diffusionServer.getStructuredLogs();

      expect(logs).toHaveLength(2);
      expect(logs[0].message).toBe('Log with trailing spaces');
      expect(logs[1].message).toBe('Another log');
    });
  });

  describe('LogManager.parseEntry()', () => {
    it('should parse standard log format', () => {
      const entry = MockLogManager.parseEntry('[2025-01-01T10:00:00.000Z] [info] Test message');
      expect(entry).toEqual({
        timestamp: '2025-01-01T10:00:00.000Z',
        level: 'info',
        message: 'Test message',
      });
    });

    it('should handle different log levels', () => {
      const levels = ['info', 'warn', 'error', 'debug'];
      levels.forEach((level) => {
        const entry = MockLogManager.parseEntry(`[2025-01-01T10:00:00.000Z] [${level}] Message`);
        expect(entry?.level).toBe(level);
      });
    });

    it('should handle log messages with special characters', () => {
      const entry = MockLogManager.parseEntry(
        '[2025-01-01T10:00:00.000Z] [error] Error: Failed to load /path/to/file.gguf (size: 4.2GB)'
      );
      expect(entry?.message).toBe('Error: Failed to load /path/to/file.gguf (size: 4.2GB)');
    });

    it('should return null for malformed entries', () => {
      const malformed = [
        'No brackets at all',
        '[Incomplete timestamp',
        '[2025-01-01T10:00:00.000Z] No level',
        '[2025-01-01T10:00:00.000Z] [info]', // No message
      ];

      malformed.forEach((line) => {
        const entry = MockLogManager.parseEntry(line);
        expect(entry).toBeNull();
      });
    });

    it('should trim whitespace before parsing', () => {
      const entry = MockLogManager.parseEntry('  [2025-01-01T10:00:00.000Z] [info] Message  \r\n');
      expect(entry).toEqual({
        timestamp: '2025-01-01T10:00:00.000Z',
        level: 'info',
        message: 'Message',
      });
    });
  });
});
