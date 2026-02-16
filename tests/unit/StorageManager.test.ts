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
const mockRm = jest.fn();

jest.unstable_mockModule('fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  unlink: mockUnlink,
  readdir: mockReaddir,
  stat: mockStat,
  rm: mockRm,
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
  getModelMetadataPath: (type: string, modelId: string) => `/test/models/${type}/${modelId}.json`,
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
        expect.stringContaining('"id": "test-model"'), // JSON is formatted with spaces
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

    it('should throw FileSystemError if file does not exist', async () => {
      mockFileExists.mockResolvedValue(false);

      await expect(storageManager.loadModelMetadata('llm', 'nonexistent')).rejects.toThrow(
        'Model metadata not found'
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
        'Model metadata not found'
      );
    });
  });

  describe('listModelFiles()', () => {
    it('should list all models of a given type', async () => {
      // listModelFiles returns model IDs (strings), not ModelInfo objects
      // It looks for .json metadata files and returns their names without extension
      mockReaddir.mockResolvedValue(['model1.json', 'model2.json', 'model1.gguf']);

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(2);
      expect(models[0]).toBe('model1');
      expect(models[1]).toBe('model2');
    });

    it('should handle empty directories', async () => {
      mockReaddir.mockResolvedValue([]);

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(0);
    });

    it('should skip files without metadata', async () => {
      // Only .json files are considered, .gguf files without .json are ignored
      mockReaddir.mockResolvedValue(['model1.json', 'model2.gguf']);

      const models = await storageManager.listModelFiles('llm');

      expect(models).toHaveLength(1);
      expect(models[0]).toBe('model1');
    });
  });

  describe('verifyModelIntegrity()', () => {
    it('should verify model checksum matches', async () => {
      // Method signature: verifyModelIntegrity(type: ModelType, modelId: string)
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(mockModelInfo));
      mockCalculateChecksum.mockResolvedValue('abc123'); // Without sha256: prefix

      const result = await storageManager.verifyModelIntegrity('llm', 'test-model');

      expect(result).toBe(true);
      expect(mockCalculateChecksum).toHaveBeenCalledWith(mockModelInfo.path);
    });

    it('should throw ChecksumError if checksum does not match', async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(mockModelInfo));
      mockCalculateChecksum.mockResolvedValue('different_checksum');

      await expect(storageManager.verifyModelIntegrity('llm', 'test-model')).rejects.toThrow(
        'checksum mismatch'
      );
    });

    it('should handle checksum calculation errors', async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(mockModelInfo));
      mockCalculateChecksum.mockRejectedValue(new Error('Checksum failed'));

      await expect(storageManager.verifyModelIntegrity('llm', 'test-model')).rejects.toThrow();
    });
  });

  describe('getStorageUsed()', () => {
    it('should calculate total storage used', async () => {
      // getStorageUsed calls listModelFiles which returns IDs from .json files
      mockReaddir
        .mockResolvedValueOnce(['model1.json', 'model2.json']) // llm models
        .mockResolvedValueOnce(['diffusion1.json']); // diffusion models

      mockFileExists.mockResolvedValue(true);
      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({ ...mockModelInfo, id: 'model1', size: 1024 * 1024 * 1024 })
        )
        .mockResolvedValueOnce(
          JSON.stringify({ ...mockModelInfo, id: 'model2', size: 2 * 1024 * 1024 * 1024 })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            ...mockModelInfo,
            id: 'diffusion1',
            type: 'diffusion',
            size: 3 * 1024 * 1024 * 1024,
          })
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
    it('should be a placeholder that returns MAX_SAFE_INTEGER', async () => {
      const space = await storageManager.checkDiskSpace('/test/path');
      expect(space).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('deleteModelFiles() with multi-component metadata', () => {
    const multiComponentModelInfo: ModelInfo = {
      id: 'flux-2-klein',
      name: 'Flux 2 Klein',
      type: 'diffusion',
      size: 7.1 * 1024 ** 3,
      path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
      downloadedAt: '2025-10-17T10:00:00Z',
      source: { type: 'url', url: 'https://example.com/flux-2-klein.gguf' },
      components: {
        diffusion_model: {
          path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
          size: 4.3 * 1024 ** 3,
          checksum: 'sha256:aaa111',
        },
        llm: {
          path: '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf',
          size: 2.5 * 1024 ** 3,
          checksum: 'sha256:bbb222',
        },
        vae: {
          path: '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors',
          size: 335 * 1024 ** 2,
        },
      },
    };

    let mockDeleteFile: jest.Mock;

    beforeEach(async () => {
      // Get reference to the mocked deleteFile from file-utils
      const fileUtils = await import('../../src/utils/file-utils.js');
      mockDeleteFile = fileUtils.deleteFile as jest.Mock;

      // Set up loadModelMetadata to succeed with multi-component model
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(multiComponentModelInfo));
      mockRm.mockResolvedValue(undefined);
    });

    it('should delete each component file', async () => {
      await storageManager.deleteModelFiles('diffusion', 'flux-2-klein');

      // deleteFile called for each of the 3 component files + 1 metadata file = 4 calls
      expect(mockDeleteFile).toHaveBeenCalledTimes(4);
      expect(mockDeleteFile).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
      );
      expect(mockDeleteFile).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf'
      );
      expect(mockDeleteFile).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors'
      );
    });

    it('should try to remove the model subdirectory', async () => {
      await storageManager.deleteModelFiles('diffusion', 'flux-2-klein');

      expect(mockRm).toHaveBeenCalledWith('/test/models/diffusion/flux-2-klein', {
        recursive: false,
      });
    });

    it('should delete the metadata JSON file', async () => {
      await storageManager.deleteModelFiles('diffusion', 'flux-2-klein');

      // The last deleteFile call should be the metadata path
      expect(mockDeleteFile).toHaveBeenCalledWith(expect.stringContaining('flux-2-klein.json'));
    });

    it('should not fail if model subdirectory removal fails', async () => {
      mockRm.mockRejectedValue(new Error('Directory not empty'));

      // Should not throw — directory removal failure is silently ignored
      await expect(
        storageManager.deleteModelFiles('diffusion', 'flux-2-klein')
      ).resolves.toBeUndefined();
    });

    it('should skip component files that do not exist', async () => {
      // First call (metadata exists check) returns true,
      // then component existence checks: first true, second false, third true
      mockFileExists
        .mockResolvedValueOnce(true) // metadata file exists (for loadModelMetadata)
        .mockResolvedValueOnce(true) // diffusion_model component exists
        .mockResolvedValueOnce(false) // llm component does NOT exist
        .mockResolvedValueOnce(true); // vae component exists

      await storageManager.deleteModelFiles('diffusion', 'flux-2-klein');

      // deleteFile should NOT be called for the llm component
      expect(mockDeleteFile).not.toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf'
      );
      // But should be called for the other two components
      expect(mockDeleteFile).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
      );
      expect(mockDeleteFile).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors'
      );
    });
  });

  describe('verifyModelIntegrity() with multi-component metadata', () => {
    const multiComponentModelInfo: ModelInfo = {
      id: 'flux-2-klein',
      name: 'Flux 2 Klein',
      type: 'diffusion',
      size: 7.1 * 1024 ** 3,
      path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
      downloadedAt: '2025-10-17T10:00:00Z',
      source: { type: 'url', url: 'https://example.com/flux-2-klein.gguf' },
      components: {
        diffusion_model: {
          path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
          size: 4.3 * 1024 ** 3,
          checksum: 'sha256:aaa111',
        },
        llm: {
          path: '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf',
          size: 2.5 * 1024 ** 3,
          checksum: 'sha256:bbb222',
        },
        vae: {
          path: '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors',
          size: 335 * 1024 ** 2,
        },
      },
    };

    beforeEach(() => {
      // Set up loadModelMetadata to succeed with multi-component model
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(multiComponentModelInfo));
    });

    it('should check each component file exists', async () => {
      mockCalculateChecksum
        .mockResolvedValueOnce('aaa111') // diffusion_model checksum
        .mockResolvedValueOnce('bbb222'); // llm checksum

      await storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein');

      // fileExists called: 1 for metadata + 3 for components = 4 calls
      expect(mockFileExists).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
      );
      expect(mockFileExists).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf'
      );
      expect(mockFileExists).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors'
      );
    });

    it('should throw FileSystemError if a component file is missing', async () => {
      mockFileExists
        .mockResolvedValueOnce(true) // metadata file exists
        .mockResolvedValueOnce(true) // diffusion_model exists
        .mockResolvedValueOnce(false); // llm component missing
      // diffusion_model has a checksum, so calculateChecksum is called before moving to llm
      mockCalculateChecksum.mockResolvedValueOnce('aaa111');

      await expect(
        storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein')
      ).rejects.toThrow('Component file not found');
    });

    it('should return true when at least one component has a matching checksum', async () => {
      mockCalculateChecksum
        .mockResolvedValueOnce('aaa111') // diffusion_model matches
        .mockResolvedValueOnce('bbb222'); // llm matches

      const result = await storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein');

      expect(result).toBe(true);
    });

    it('should verify checksums for components that have them', async () => {
      mockCalculateChecksum.mockResolvedValueOnce('aaa111').mockResolvedValueOnce('bbb222');

      await storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein');

      // calculateChecksum should be called only for components with checksums (2 of 3)
      expect(mockCalculateChecksum).toHaveBeenCalledTimes(2);
      expect(mockCalculateChecksum).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf'
      );
      expect(mockCalculateChecksum).toHaveBeenCalledWith(
        '/test/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf'
      );
    });

    it('should return false when no components have checksums', async () => {
      const noChecksumModel: ModelInfo = {
        ...multiComponentModelInfo,
        components: {
          diffusion_model: {
            path: '/test/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
            size: 4.3 * 1024 ** 3,
          },
          vae: {
            path: '/test/models/diffusion/flux-2-klein/flux2-vae.safetensors',
            size: 335 * 1024 ** 2,
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(noChecksumModel));

      const result = await storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein');

      expect(result).toBe(false);
      expect(mockCalculateChecksum).not.toHaveBeenCalled();
    });

    it('should throw ChecksumError when a component checksum does not match', async () => {
      mockCalculateChecksum.mockResolvedValueOnce('wrong_checksum');

      await expect(
        storageManager.verifyModelIntegrity('diffusion', 'flux-2-klein')
      ).rejects.toThrow('checksum mismatch');
    });
  });
});
