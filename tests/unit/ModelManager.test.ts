/**
 * Unit tests for ModelManager
 * Tests model download, listing, deletion, and verification
 */

import { jest } from '@jest/globals';
import type { ModelInfo, DownloadConfig } from '../../src/types/index.js';

// Mock StorageManager
const mockStorageManager = {
  initialize: jest.fn().mockResolvedValue(undefined),
  listModelFiles: jest.fn(),
  loadModelMetadata: jest.fn(),
  saveModelMetadata: jest.fn(),
  deleteModelFiles: jest.fn().mockResolvedValue(undefined),
  verifyModelIntegrity: jest.fn(),
  checkDiskSpace: jest.fn(),
  getStorageUsed: jest.fn(),
  getModelPath: jest.fn().mockImplementation((type: string, filename: string) => `/test/models/${type}/${filename}`),
};

jest.unstable_mockModule('../../src/managers/StorageManager.js', () => ({
  StorageManager: jest.fn(() => mockStorageManager),
  storageManager: mockStorageManager,
}));

// Mock Downloader
const mockDownload = jest.fn().mockResolvedValue(undefined);
const mockCancel = jest.fn();

class MockDownloader {
  download = mockDownload;
  cancel = mockCancel;
  downloading = false;
}

jest.unstable_mockModule('../../src/download/Downloader.js', () => ({
  Downloader: MockDownloader,
}));

// Mock HuggingFace utils
const mockGetHuggingFaceURL = jest.fn();
const mockIsHuggingFaceURL = jest.fn();

jest.unstable_mockModule('../../src/download/huggingface.js', () => ({
  getHuggingFaceURL: mockGetHuggingFaceURL,
  isHuggingFaceURL: mockIsHuggingFaceURL,
}));

// Mock checksum utils
const mockVerifyChecksum = jest.fn();
const mockCalculateSHA256 = jest.fn();
const mockFormatChecksum = jest.fn();

jest.unstable_mockModule('../../src/download/checksum.js', () => ({
  verifyChecksum: mockVerifyChecksum,
  calculateSHA256: mockCalculateSHA256,
  formatChecksum: mockFormatChecksum,
}));

// Mock file-utils
const mockFileExists = jest.fn();
const mockGetFileSize = jest.fn();
const mockSanitizeFilename = jest.fn((filename: string) => filename);

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: mockFileExists,
  getFileSize: mockGetFileSize,
  sanitizeFilename: mockSanitizeFilename,
}));

// Mock paths
jest.unstable_mockModule('../../src/config/paths.js', () => ({
  getModelFilePath: (type: string, filename: string) => `/test/models/${type}/${filename}`,
  getModelMetadataPath: (type: string, modelId: string) => `/test/models/${type}/${modelId}.json`,
}));

// Mock reasoning-models
jest.unstable_mockModule('../../src/config/reasoning-models.js', () => ({
  detectReasoningSupport: jest.fn().mockReturnValue(false),
}));

// Import after mocking
const { ModelManager } = await import('../../src/managers/ModelManager.js');

describe('ModelManager', () => {
  let modelManager: ModelManager;

  const mockModelInfo: ModelInfo = {
    id: 'test-model',
    name: 'Test Model',
    type: 'llm',
    size: 1024 * 1024 * 1024,
    path: '/test/models/llm/test-model.gguf',
    downloadedAt: '2025-10-16T10:00:00Z',
    source: {
      type: 'url',
      url: 'https://example.com/test-model.gguf',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    modelManager = new ModelManager();
  });

  describe('listModels()', () => {
    it('should list all models', async () => {
      // listModelFiles returns string[] (model IDs), not ModelInfo[]
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);

      const models = await modelManager.listModels();

      expect(models).toHaveLength(1);
      expect(models[0]).toEqual(mockModelInfo);
      expect(mockStorageManager.listModelFiles).toHaveBeenCalledWith('llm');
      expect(mockStorageManager.listModelFiles).toHaveBeenCalledWith('diffusion');
    });

    it('should filter by type', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue(['test-model']);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);

      const models = await modelManager.listModels('llm');

      expect(models).toHaveLength(1);
      expect(mockStorageManager.listModelFiles).toHaveBeenCalledWith('llm');
      expect(mockStorageManager.listModelFiles).not.toHaveBeenCalledWith('diffusion');
    });

    it('should handle empty model list', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue([]);

      const models = await modelManager.listModels();

      expect(models).toHaveLength(0);
    });

    it('should handle storage errors', async () => {
      mockStorageManager.listModelFiles.mockRejectedValue(new Error('Storage error'));

      await expect(modelManager.listModels()).rejects.toThrow('Storage error');
    });
  });

  describe('downloadModel()', () => {
    const downloadConfig: DownloadConfig = {
      source: 'url',
      url: 'https://example.com/model.gguf',
      name: 'Test Model',
      type: 'llm',
    };

    beforeEach(() => {
      mockStorageManager.checkDiskSpace.mockResolvedValue(100 * 1024 * 1024 * 1024); // 100 GB
      mockDownload.mockResolvedValue(undefined);
      // First call: file doesn't exist (allows download), second call: file exists (after download for size check)
      mockFileExists.mockResolvedValueOnce(false).mockResolvedValue(true);
      mockGetFileSize.mockResolvedValue(1024 * 1024 * 1024); // 1 GB
      mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);
      mockIsHuggingFaceURL.mockReturnValue(false);
    });

    it('should download model from URL', async () => {
      const model = await modelManager.downloadModel(downloadConfig);

      expect(model).toBeDefined();
      expect(model.type).toBe('llm');
      expect(model.name).toBe('Test Model');
      expect(mockDownload).toHaveBeenCalled();
      expect(mockDownload.mock.calls[0][0].url).toBe('https://example.com/model.gguf');
      expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
    });

    it('should download from HuggingFace', async () => {
      mockGetHuggingFaceURL.mockReturnValue('https://huggingface.co/test/model/resolve/main/model.gguf');

      const hfConfig: DownloadConfig = {
        source: 'huggingface',
        repo: 'test/model',
        file: 'model.gguf',
        name: 'HF Model',
        type: 'llm',
      };

      const model = await modelManager.downloadModel(hfConfig);

      expect(model).toBeDefined();
      expect(mockGetHuggingFaceURL).toHaveBeenCalledWith('test/model', 'model.gguf');
      expect(mockDownload).toHaveBeenCalled();
    });

    it('should call progress callback', async () => {
      const progressCallback = jest.fn();

      await modelManager.downloadModel({
        ...downloadConfig,
        onProgress: progressCallback,
      });

      // Progress callback should be passed through
      const downloadCall = mockDownload.mock.calls[0][0];
      expect(downloadCall.onProgress).toBeDefined();

      // Simulate progress
      downloadCall.onProgress(500, 1000);
      expect(progressCallback).toHaveBeenCalledWith(500, 1000);
    });

    it('should verify checksum if provided', async () => {
      mockCalculateSHA256.mockResolvedValue('abc123');
      mockFormatChecksum.mockReturnValue('sha256:abc123');

      const model = await modelManager.downloadModel({
        ...downloadConfig,
        checksum: 'sha256:abc123',
      });

      expect(model).toBeDefined();
      expect(mockCalculateSHA256).toHaveBeenCalled();
    });

    it('should throw error if checksum verification fails', async () => {
      mockCalculateSHA256.mockResolvedValue('wrong_checksum');
      mockFormatChecksum.mockReturnValue('sha256:wrong_checksum');
      // Ensure deleteModelFiles returns a Promise for cleanup
      mockStorageManager.deleteModelFiles.mockResolvedValue(undefined);

      await expect(
        modelManager.downloadModel({
          ...downloadConfig,
          checksum: 'sha256:abc123',
        })
      ).rejects.toThrow();
    });

    it('should handle download errors', async () => {
      mockDownload.mockRejectedValue(new Error('Download failed'));

      await expect(modelManager.downloadModel(downloadConfig)).rejects.toThrow('Download failed');
    });

    it('should validate required fields', async () => {
      await expect(
        modelManager.downloadModel({
          source: 'url',
          // Missing URL
          name: 'Test',
          type: 'llm',
        } as any)
      ).rejects.toThrow();
    });
  });

  describe('deleteModel()', () => {
    it('should delete model by ID', async () => {
      // listModelFiles returns string IDs, loadModelMetadata returns ModelInfo
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
      mockStorageManager.deleteModelFiles.mockResolvedValue(undefined);

      await modelManager.deleteModel('test-model');

      expect(mockStorageManager.deleteModelFiles).toHaveBeenCalledWith('llm', 'test-model');
    });

    it('should throw error if model not found', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue([]);

      await expect(modelManager.deleteModel('nonexistent')).rejects.toThrow('Model not found');
    });

    it('should handle deletion errors', async () => {
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
      mockStorageManager.deleteModelFiles.mockRejectedValue(new Error('Delete failed'));

      await expect(modelManager.deleteModel('test-model')).rejects.toThrow('Delete failed');
    });
  });

  describe('getModelInfo()', () => {
    it('should return model info by ID', async () => {
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);

      const info = await modelManager.getModelInfo('test-model');

      expect(info).toEqual(mockModelInfo);
    });

    it('should throw error if model not found', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue([]);

      await expect(modelManager.getModelInfo('nonexistent')).rejects.toThrow('Model not found');
    });
  });

  describe('verifyModel()', () => {
    beforeEach(() => {
      // listModelFiles returns string IDs
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue({
        ...mockModelInfo,
        checksum: 'sha256:abc123',
      });
    });

    it('should verify model with checksum', async () => {
      mockStorageManager.verifyModelIntegrity.mockResolvedValue(true);

      const result = await modelManager.verifyModel('test-model');

      expect(result).toBe(true);
      expect(mockStorageManager.verifyModelIntegrity).toHaveBeenCalledWith(
        mockModelInfo.type,
        mockModelInfo.id
      );
    });

    it('should fail if checksum does not match', async () => {
      // verifyModelIntegrity throws ChecksumError when mismatch
      const checksumError = new Error('SHA256 checksum mismatch');
      mockStorageManager.verifyModelIntegrity.mockRejectedValue(checksumError);

      await expect(modelManager.verifyModel('test-model')).rejects.toThrow('checksum mismatch');
    });

    it('should handle models without checksum', async () => {
      mockStorageManager.listModelFiles.mockResolvedValueOnce(['test-model']).mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue({
        ...mockModelInfo,
        checksum: undefined,
      });
      mockStorageManager.verifyModelIntegrity.mockResolvedValue(false);

      const result = await modelManager.verifyModel('test-model');

      expect(result).toBe(false);
    });

    it('should throw error if model not found', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue([]);

      await expect(modelManager.verifyModel('nonexistent')).rejects.toThrow('Model not found');
    });
  });

  describe('cancelDownload()', () => {
    it('should cancel ongoing download', () => {
      expect(() => modelManager.cancelDownload()).not.toThrow();
      expect(mockCancel).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should provide meaningful error messages', async () => {
      mockStorageManager.listModelFiles.mockRejectedValue(new Error('Disk read error'));

      try {
        await modelManager.listModels();
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).toContain('Disk read error');
      }
    });
  });
});
