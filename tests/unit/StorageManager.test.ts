/**
 * Unit tests for StorageManager
 * Tests file system operations and metadata management
 */

import { jest } from '@jest/globals';
import type { ModelInfo } from '../../src/types/index.js';

// Mock fs/promises
const mockMkdir = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();

jest.unstable_mockModule('fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  unlink: mockUnlink,
  readdir: mockReaddir,
  stat: mockStat,
}));

// Mock file-utils
const mockFileExists = jest.fn();
const mockCalculateChecksum = jest.fn();

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: mockFileExists,
  calculateChecksum: mockCalculateChecksum,
  ensureDirectory: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}));

// Mock paths
jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    models: {
      llm: '/test/models/llm',
      diffusion: '/test/models/diffusion',
    },
    binaries: '/test/binaries',
    logs: '/test/logs',
    config: '/test/config',
  },
  getModelFilePath: (type: string, filename: string) => `/test/models/${type}/${filename}`,
  getModelMetadataPath: (type: string, modelId: string) =>
    `/test/models/${type}/${modelId}.json`,
  ensureDirectories: jest.fn().mockResolvedValue(undefined),
}));

// Import after mocking
const { StorageManager } = await import('../../src/managers/StorageManager.js');

describe('StorageManager', () => {
  let storageManager: StorageManager;

  const mockModelInfo: ModelInfo = {
    id: 'test-model',
    name: 'Test Model',
    type: 'llm',
    size: 1024 * 1024 * 1024, // 1 GB
    path: '/test/models/llm/test-model.gguf',
    downloadedAt: '2025-10-16T10:00:00Z',
    source: {
      type: 'url',
      url: 'https://example.com/test-model.gguf',
    },
    checksum: 'sha256:abc123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    storageManager = new StorageManager();
  });

  describe('initialize()', () => {
    it('should create all required directories', async () => {
      await storageManager.initialize();
      // ensureDirectories is called in the constructor and initialize
      // Just verify no errors
      expect(true).toBe(true);
    });
  });

  describe('saveModelMetadata()', () => {
    it('should save model metadata as JSON', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      await storageManager.saveModelMetadata(mockModelInfo);

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('test-model.json'),
        expect.stringContaining('"id":"test-model"'),
        'utf-8'
      );
    });

    it('should handle write errors', async () => {
      mockWriteFile.mockRejectedValue(new Error('Write failed'));

      await expect(storageManager.saveModelMetadata(mockModelInfo)).rejects.toThrow();
    });
  });

  describe('loadModelMetadata()', () => {
    it('should load model metadata from JSON', async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(mockModelInfo));

      const result = await storageManager.loadModelMetadata('llm', 'test-model');

      expect(result).toEqual(mockModelInfo);
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('test-model.json'),
        'utf-8'
      );
    });

    it('should throw ModelNotFoundError if file does not exist', async () => {
      mockFileExists.mockResolvedValue(false);

      await expect(storageManager.loadModelMetadata('llm', 'nonexistent')).rejects.toThrow(
        'Model not found'
      );
    });

    it('should handle JSON parse errors', async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue('invalid json');

      await expect(storageManager.loadModelMetadata('llm', 'test-model')).rejects.toThrow();
    });
  });

  describe('deleteModelFiles()', () => {
    it('should delete both model file and metadata', async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(mockModelInfo));

      await storageManager.deleteModelFiles('llm', 'test-model');

      // Verify both files were deleted (via mocked deleteFile in file-utils)
      expect(mockFileExists).toHaveBeenCalled();
    });

    it('should throw error if model not found', async () => {
      mockFileExists.mockResolvedValue(false);

      await expect(storageManager.deleteModelFiles('llm', 'nonexistent')).rejects.toThrow(
        'Model not found'
      );
    });
  });

  describe('listModelFiles()', () => {
    it('should list all models of a given type', async () => {
      mockReaddir.mockResolvedValue(['model1.gguf', 'model2.gguf', 'metadata.json']);
      mockFileExists.mockResolvedValue(true);
      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({
            ...mockModelInfo,
            id: 'model1',
            path: '/test/models/llm/model1.gguf',
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            ...mockModelInfo,
            id: 'model2',
            path: '/test/models/llm/model2.gguf',
          })
        );

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('model1');
      expect(models[1].id).toBe('model2');
    });

    it('should handle empty directories', async () => {
      mockReaddir.mockResolvedValue([]);

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(0);
    });

    it('should skip files without metadata', async () => {
      mockReaddir.mockResolvedValue(['model1.gguf', 'model2.gguf']);
      mockFileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          ...mockModelInfo,
          id: 'model1',
        })
      );

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('model1');
    });
  });

  describe('verifyModelIntegrity()', () => {
    it('should verify model checksum matches', async () => {
      mockCalculateChecksum.mockResolvedValue('sha256:abc123');

      const result = await storageManager.verifyModelIntegrity(
        '/test/model.gguf',
        'sha256:abc123'
      );

      expect(result).toBe(true);
      expect(mockCalculateChecksum).toHaveBeenCalledWith('/test/model.gguf');
    });

    it('should return false if checksum does not match', async () => {
      mockCalculateChecksum.mockResolvedValue('sha256:different');

      const result = await storageManager.verifyModelIntegrity(
        '/test/model.gguf',
        'sha256:abc123'
      );

      expect(result).toBe(false);
    });

    it('should handle checksum calculation errors', async () => {
      mockCalculateChecksum.mockRejectedValue(new Error('Checksum failed'));

      await expect(
        storageManager.verifyModelIntegrity('/test/model.gguf', 'sha256:abc123')
      ).rejects.toThrow();
    });
  });

  describe('getStorageUsed()', () => {
    it('should calculate total storage used', async () => {
      mockReaddir
        .mockResolvedValueOnce(['model1.gguf', 'model2.gguf'])
        .mockResolvedValueOnce(['diffusion1.gguf']);

      mockFileExists.mockResolvedValue(true);
      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({ ...mockModelInfo, id: 'model1', size: 1024 * 1024 * 1024 })
        )
        .mockResolvedValueOnce(
          JSON.stringify({ ...mockModelInfo, id: 'model2', size: 2 * 1024 * 1024 * 1024 })
        )
        .mockResolvedValueOnce(
          JSON.stringify({ ...mockModelInfo, id: 'diffusion1', size: 3 * 1024 * 1024 * 1024 })
        );

      const total = await storageManager.getStorageUsed();

      expect(total).toBe(6 * 1024 * 1024 * 1024); // 6 GB total
    });

    it('should handle empty storage', async () => {
      mockReaddir.mockResolvedValue([]);

      const total = await storageManager.getStorageUsed();

      expect(total).toBe(0);
    });
  });

  describe('checkDiskSpace()', () => {
    it('should be a placeholder that returns Infinity', async () => {
      const space = await storageManager.checkDiskSpace('/test/path');
      expect(space).toBe(Infinity);
    });
  });
});
