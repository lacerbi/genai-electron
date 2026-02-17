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
  getModelPath: jest
    .fn()
    .mockImplementation((type: string, filename: string) => `/test/models/${type}/${filename}`),
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

// Mock node:fs/promises (used for mkdir in downloadMultiComponentModel and rmdir in cleanup)
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockRmdir = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('node:fs/promises', () => ({
  mkdir: mockMkdir,
  rmdir: mockRmdir,
}));

// Mock file-utils
const mockFileExists = jest.fn();
const mockGetFileSize = jest.fn();
// sanitizeFilename must be a plain function (not jest.fn) to survive jest.clearAllMocks()
const mockSanitizeFilename = (filename: string) => filename;
const mockDeleteFile = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  fileExists: mockFileExists,
  getFileSize: mockGetFileSize,
  sanitizeFilename: mockSanitizeFilename,
  deleteFile: mockDeleteFile,
}));

// Mock paths - use plain functions to survive jest.clearAllMocks()
// Track getModelDirectory calls via shared state
const pathsMockState = {
  getModelDirectoryCalls: [] as Array<{ type: string; modelId: string }>,
};

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  getModelFilePath: (type: string, filename: string) => `/test/models/${type}/${filename}`,
  getModelMetadataPath: (type: string, modelId: string) => `/test/models/${type}/${modelId}.json`,
  getModelDirectory: (type: string, modelId: string) => {
    pathsMockState.getModelDirectoryCalls.push({ type, modelId });
    return `/test/models/${type}/${modelId}`;
  },
  PATHS: {
    models: { llm: '/test/models/llm', diffusion: '/test/models/diffusion' },
    binaries: { llama: '/test/binaries/llama', diffusion: '/test/binaries/diffusion' },
    logs: '/test/logs',
    config: '/test/config',
    temp: '/test/temp',
  },
  BASE_DIR: '/test',
  ensureDirectories: async () => undefined,
  getBinaryPath: (type: string, name: string) => `/test/binaries/${type}/${name}`,
  getLogPath: (name: string) => `/test/logs/${name}`,
  getConfigPath: (name: string) => `/test/config/${name}`,
  getTempPath: (name: string) => `/test/temp/${name}`,
}));

// Mock reasoning-models
jest.unstable_mockModule('../../src/config/reasoning-models.js', () => ({
  detectReasoningSupport: jest.fn().mockReturnValue(false),
}));

// Mock GGUF parser - use plain async functions for ESM compatibility
// Track calls via a shared state object (jest.fn() implementations get cleared by clearAllMocks)
const ggufMockState = {
  fetchGGUFMetadataCallCount: 0,
  fetchGGUFMetadataShouldReject: false,
  fetchGGUFMetadataRejectError: null as Error | null,
};

const defaultGGUFResponse = {
  metadata: {
    version: 3,
    tensor_count: 291n, // BigInt - matches real GGUF format
    kv_count: 19n, // BigInt - matches real GGUF format
    'general.architecture': 'llama',
    'general.name': 'Test Model',
    'general.file_type': 10,
    'llama.block_count': 32,
    'llama.context_length': 4096,
    'llama.attention.head_count': 32,
    'llama.embedding_length': 4096,
    'llama.feed_forward_length': 11008,
    'llama.vocab_size': 32000,
    'llama.rope.dimension_count': 128,
    'llama.rope.freq_base': 10000,
    'llama.attention.layer_norm_rms_epsilon': 1e-5,
  },
  tensorInfos: [],
};

jest.unstable_mockModule('../../src/utils/gguf-parser.js', () => ({
  fetchGGUFMetadata: async () => {
    ggufMockState.fetchGGUFMetadataCallCount++;
    if (ggufMockState.fetchGGUFMetadataShouldReject) {
      throw ggufMockState.fetchGGUFMetadataRejectError || new Error('GGUF fetch error');
    }
    return defaultGGUFResponse;
  },
  fetchLocalGGUFMetadata: async () => defaultGGUFResponse,
  getArchField: (metadata: Record<string, unknown>, fieldPath: string) => {
    const arch = metadata['general.architecture'];
    if (arch && typeof arch === 'string') {
      return metadata[`${arch}.${fieldPath}`];
    }
    return undefined;
  },
}));

// Mock model metadata helpers - use plain functions for ESM compatibility
jest.unstable_mockModule('../../src/utils/model-metadata-helpers.js', () => ({
  getLayerCountWithFallback: () => 32,
  getContextLengthWithFallback: () => 4096,
  getArchitectureWithFallback: () => 'llama',
  getAttentionHeadCountWithFallback: () => 32,
  getEmbeddingLengthWithFallback: () => 4096,
  hasGGUFMetadata: () => true,
  getMetadataCompleteness: () => 100,
}));

// Import after mocking
const { ModelManager } = await import('../../src/managers/ModelManager.js');
const { DownloadError } = await import('../../src/errors/index.js');

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
    // Reset GGUF mock state
    ggufMockState.fetchGGUFMetadataCallCount = 0;
    ggufMockState.fetchGGUFMetadataShouldReject = false;
    ggufMockState.fetchGGUFMetadataRejectError = null;
    // Reset paths mock state
    pathsMockState.getModelDirectoryCalls = [];
    modelManager = new ModelManager();
  });

  describe('listModels()', () => {
    it('should list all models', async () => {
      // listModelFiles returns string[] (model IDs), not ModelInfo[]
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
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
      mockGetHuggingFaceURL.mockReturnValue(
        'https://huggingface.co/test/model/resolve/main/model.gguf'
      );

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
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
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
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
      mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
      mockStorageManager.deleteModelFiles.mockRejectedValue(new Error('Delete failed'));

      await expect(modelManager.deleteModel('test-model')).rejects.toThrow('Delete failed');
    });
  });

  describe('getModelInfo()', () => {
    it('should return model info by ID', async () => {
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
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
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
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
      mockStorageManager.listModelFiles
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValueOnce([]);
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

  describe('updateModelMetadata()', () => {
    beforeEach(() => {
      // Reset mocks before each test
      mockStorageManager.listModelFiles.mockReset();
      mockStorageManager.loadModelMetadata.mockReset();
      mockStorageManager.saveModelMetadata.mockReset();
    });

    describe('local-only strategy (default)', () => {
      it('should fetch metadata from local file with default options', async () => {
        // Setup: Model exists in storage
        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model');

        expect(result).toBeDefined();
        expect(result.ggufMetadata).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(result.ggufMetadata?.context_length).toBe(4096);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });

      it('should fetch metadata from local file with explicit local-only option', async () => {
        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model', {
          source: 'local-only',
        });

        expect(result).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });
    });

    describe('remote-only strategy', () => {
      it('should fetch metadata from remote URL only', async () => {
        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model', {
          source: 'remote-only',
        });

        expect(result).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });

      it('should throw error if no remote URL available', async () => {
        const modelWithoutURL = {
          ...mockModelInfo,
          source: {
            ...mockModelInfo.source,
            url: '', // No URL
          },
        };

        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(modelWithoutURL);

        await expect(
          modelManager.updateModelMetadata('test-model', { source: 'remote-only' })
        ).rejects.toThrow(/No source URL available/);
      });
    });

    describe('local-remote strategy', () => {
      it('should fetch from local and skip remote on success', async () => {
        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model', {
          source: 'local-remote',
        });

        expect(result).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });
    });

    describe('remote-local strategy', () => {
      it('should fetch from remote and skip local on success', async () => {
        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(mockModelInfo);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model', {
          source: 'remote-local',
        });

        expect(result).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });

      it('should use local-only if no remote URL available', async () => {
        const modelWithoutURL = {
          ...mockModelInfo,
          source: {
            ...mockModelInfo.source,
            url: '', // No URL
          },
        };

        mockStorageManager.listModelFiles
          .mockResolvedValueOnce(['test-model'])
          .mockResolvedValueOnce([]);
        mockStorageManager.loadModelMetadata.mockResolvedValue(modelWithoutURL);
        mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);

        const result = await modelManager.updateModelMetadata('test-model', {
          source: 'remote-local',
        });

        expect(result).toBeDefined();
        expect(result.ggufMetadata?.block_count).toBe(32);
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalled();
      });
    });

    it('should throw error for model that does not exist', async () => {
      mockStorageManager.listModelFiles.mockResolvedValue([]);

      await expect(modelManager.updateModelMetadata('nonexistent')).rejects.toThrow(
        'Model not found'
      );
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

  describe('downloadMultiComponentModel()', () => {
    // Helper: create a mock HEAD response with content-length
    const createHeadResponse = (contentLength: number) =>
      ({
        headers: {
          get: (name: string) => (name === 'content-length' ? String(contentLength) : null),
        },
      }) as unknown as Response;

    // Flux 2 Klein-style 3-component config
    const flux2KleinConfig: DownloadConfig = {
      source: 'huggingface',
      repo: 'leejet/FLUX.2-klein-4B-GGUF',
      file: 'flux2-klein-4B-Q4_0.gguf',
      name: 'Flux 2 Klein 4B',
      type: 'diffusion',
      components: [
        {
          role: 'llm',
          source: 'huggingface',
          repo: 'unsloth/Qwen3-4B-GGUF',
          file: 'Qwen3-4B-Q4_0.gguf',
        },
        {
          role: 'vae',
          source: 'huggingface',
          repo: 'Comfy-Org/flux2-dev',
          file: 'flux2-vae.safetensors',
        },
      ],
    };

    let fetchSpy: jest.Spied<typeof globalThis.fetch>;

    beforeEach(() => {
      // Common setup for multi-component tests
      mockStorageManager.checkDiskSpace.mockResolvedValue(100 * 1024 * 1024 * 1024);
      mockDownload.mockResolvedValue(undefined);
      mockFileExists.mockResolvedValue(false); // No pre-existing files
      mockStorageManager.saveModelMetadata.mockResolvedValue(undefined);
      // Idempotency guard: model doesn't exist yet (loadModelMetadata throws)
      mockStorageManager.loadModelMetadata.mockRejectedValue(new Error('not found'));
      mockIsHuggingFaceURL.mockReturnValue(false);
      mockGetHuggingFaceURL.mockImplementation(
        (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`
      );
      // Default file sizes: primary 4.3GB, llm 2.5GB, vae 335MB
      // Called twice per component: once after download (completedBytes) + once for components map
      mockGetFileSize
        .mockResolvedValueOnce(4_300_000_000) // primary: after download
        .mockResolvedValueOnce(2_500_000_000) // llm: after download
        .mockResolvedValueOnce(335_000_000) // vae: after download
        .mockResolvedValueOnce(4_300_000_000) // primary: components map
        .mockResolvedValueOnce(2_500_000_000) // llm: components map
        .mockResolvedValueOnce(335_000_000); // vae: components map

      // Mock fetch for HEAD requests
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('flux2-klein')) {
            return createHeadResponse(4_300_000_000);
          } else if (url.includes('Qwen3')) {
            return createHeadResponse(2_500_000_000);
          } else if (url.includes('flux2-vae')) {
            return createHeadResponse(335_000_000);
          }
          return createHeadResponse(0);
        });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    describe('happy path', () => {
      it('should download 3-component Flux 2 Klein model', async () => {
        const model = await modelManager.downloadModel(flux2KleinConfig);

        // Verify mkdir was called for model subdirectory
        expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('flux-2-klein-4b'), {
          recursive: true,
        });

        // Verify all 3 components were downloaded
        expect(mockDownload).toHaveBeenCalledTimes(3);

        // Verify download order: primary, llm, vae
        const downloadCalls = mockDownload.mock.calls;
        expect(downloadCalls[0][0].url).toContain('flux2-klein-4B-Q4_0.gguf');
        expect(downloadCalls[1][0].url).toContain('Qwen3-4B-Q4_0.gguf');
        expect(downloadCalls[2][0].url).toContain('flux2-vae.safetensors');

        // Verify all destinations are within the model subdirectory
        for (const call of downloadCalls) {
          expect(call[0].destination).toContain('flux-2-klein-4b');
        }

        // Verify model info has correct structure
        expect(model.id).toBe('flux-2-klein-4b');
        expect(model.name).toBe('Flux 2 Klein 4B');
        expect(model.type).toBe('diffusion');
        expect(model.path).toContain('flux2-klein-4B-Q4_0.gguf');

        // Verify aggregate size
        expect(model.size).toBe(4_300_000_000 + 2_500_000_000 + 335_000_000);

        // Verify components map
        expect(model.components).toBeDefined();
        expect(model.components!.diffusion_model).toBeDefined();
        expect(model.components!.diffusion_model!.size).toBe(4_300_000_000);
        expect(model.components!.llm).toBeDefined();
        expect(model.components!.llm!.size).toBe(2_500_000_000);
        expect(model.components!.vae).toBeDefined();
        expect(model.components!.vae!.size).toBe(335_000_000);

        // Verify metadata was saved
        expect(mockStorageManager.saveModelMetadata).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'flux-2-klein-4b',
            components: expect.objectContaining({
              diffusion_model: expect.objectContaining({ size: 4_300_000_000 }),
              llm: expect.objectContaining({ size: 2_500_000_000 }),
              vae: expect.objectContaining({ size: 335_000_000 }),
            }),
          })
        );

        // Verify GGUF metadata was fetched for primary .gguf file
        expect(model.ggufMetadata).toBeDefined();
        expect(model.ggufMetadata!.architecture).toBe('llama');
      });

      it('should use direct URL source for components', async () => {
        const directURLConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/diffusion-model.gguf',
          name: 'Direct URL Model',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
            },
          ],
        };

        // Reset file sizes for 2 components
        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1_000_000_000).mockResolvedValueOnce(200_000_000);

        fetchSpy.mockImplementation(async () => createHeadResponse(500_000_000));

        const model = await modelManager.downloadModel(directURLConfig);

        expect(mockDownload).toHaveBeenCalledTimes(2);
        expect(mockDownload.mock.calls[0][0].url).toBe('https://example.com/diffusion-model.gguf');
        expect(mockDownload.mock.calls[1][0].url).toBe('https://example.com/vae.safetensors');
        expect(model.components).toBeDefined();
        expect(model.components!.diffusion_model).toBeDefined();
        expect(model.components!.vae).toBeDefined();
      });
    });

    describe('validation', () => {
      it('should reject diffusion_model role in components array', async () => {
        const invalidConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Invalid Config',
          type: 'diffusion',
          components: [
            {
              role: 'diffusion_model',
              source: 'url',
              url: 'https://example.com/another.gguf',
            },
          ],
        };

        await expect(modelManager.downloadModel(invalidConfig)).rejects.toThrow(DownloadError);
        await expect(modelManager.downloadModel(invalidConfig)).rejects.toThrow(
          /top-level config describes the primary diffusion model/
        );
      });
    });

    describe('progress aggregation', () => {
      it('should report aggregate progress across multiple components', async () => {
        const progressCallback = jest.fn();

        // 2 components: primary (1000 bytes) + vae (500 bytes)
        const twoComponentConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Progress Test',
          type: 'diffusion',
          onProgress: progressCallback,
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
            },
          ],
        };

        // HEAD requests return known sizes
        fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('primary')) return createHeadResponse(1000);
          if (url.includes('vae')) return createHeadResponse(500);
          return createHeadResponse(0);
        });

        // After first download, getFileSize returns 1000 (completedBytes), then 500
        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1000).mockResolvedValueOnce(500);

        // Capture onProgress wrappers from download calls
        mockDownload.mockImplementation(
          async (opts: { onProgress?: (d: number, t: number) => void }) => {
            // Simulate some progress during download
            if (opts.onProgress) {
              opts.onProgress(250, 500);
            }
          }
        );

        await modelManager.downloadModel(twoComponentConfig);

        // First component progress: completedBytes=0, downloaded=250, total=1500
        // Second component progress: completedBytes=1000, downloaded=250, total=1500
        expect(progressCallback).toHaveBeenCalled();

        // Check first call: should be (0 + 250, 1500) = (250, 1500)
        const firstCall = progressCallback.mock.calls[0];
        expect(firstCall[0]).toBe(250); // completedBytes(0) + downloaded(250)
        expect(firstCall[1]).toBe(1500); // totalBytes

        // Check second call: should be (1000 + 250, 1500) = (1250, 1500)
        const secondCall = progressCallback.mock.calls[1];
        expect(secondCall[0]).toBe(1250); // completedBytes(1000) + downloaded(250)
        expect(secondCall[1]).toBe(1500); // totalBytes
      });
    });

    describe('GGUF conditional fetch', () => {
      it('should fetch GGUF metadata when primary file is .gguf', async () => {
        // Reset counter to track calls in this test
        ggufMockState.fetchGGUFMetadataCallCount = 0;

        // flux2KleinConfig has primary file ending in .gguf
        const model = await modelManager.downloadModel(flux2KleinConfig);

        expect(model.ggufMetadata).toBeDefined();
        expect(model.ggufMetadata!.architecture).toBe('llama');
        expect(ggufMockState.fetchGGUFMetadataCallCount).toBeGreaterThan(0);
      });

      it('should NOT fetch GGUF metadata when primary file is .safetensors', async () => {
        const safetensorsConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/model.safetensors',
          name: 'Safetensors Model',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
            },
          ],
        };

        // Reset file sizes for 2 components
        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1_000_000_000).mockResolvedValueOnce(200_000_000);

        fetchSpy.mockImplementation(async () => createHeadResponse(500_000_000));

        // Reset counter to track calls in this test
        ggufMockState.fetchGGUFMetadataCallCount = 0;

        const model = await modelManager.downloadModel(safetensorsConfig);

        expect(model.ggufMetadata).toBeUndefined();
        expect(ggufMockState.fetchGGUFMetadataCallCount).toBe(0);
      });

      it('should succeed even if GGUF metadata fetch fails for multi-component', async () => {
        // Make GGUF metadata fetch fail
        ggufMockState.fetchGGUFMetadataShouldReject = true;
        ggufMockState.fetchGGUFMetadataRejectError = new Error('GGUF parse error');

        const model = await modelManager.downloadModel(flux2KleinConfig);

        // Should succeed without GGUF metadata (non-fatal for multi-component)
        expect(model).toBeDefined();
        expect(model.ggufMetadata).toBeUndefined();
        expect(model.components).toBeDefined();
      });
    });

    describe('partial failure cleanup', () => {
      it('should clean up downloaded files when second component fails', async () => {
        // First download succeeds, second fails
        mockDownload
          .mockResolvedValueOnce(undefined) // primary succeeds
          .mockRejectedValueOnce(new Error('Network error')); // llm fails

        await expect(modelManager.downloadModel(flux2KleinConfig)).rejects.toThrow(DownloadError);

        // Verify cleanup: deleteFile called for the first downloaded file
        expect(mockDeleteFile).toHaveBeenCalled();
        // The first file (primary) was downloaded and tracked
        expect(mockDeleteFile.mock.calls[0][0]).toContain('flux2-klein-4B-Q4_0.gguf');

        // Verify rmdir called to remove model directory (only if empty — protects shared files)
        expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining('flux-2-klein-4b'));
      });

      it('should clean up all downloaded files when third component fails', async () => {
        // First two downloads succeed, third fails
        mockDownload
          .mockResolvedValueOnce(undefined) // primary succeeds
          .mockResolvedValueOnce(undefined) // llm succeeds
          .mockRejectedValueOnce(new Error('Disk full')); // vae fails

        await expect(modelManager.downloadModel(flux2KleinConfig)).rejects.toThrow(DownloadError);

        // Both downloaded files should be cleaned up
        expect(mockDeleteFile).toHaveBeenCalledTimes(2);
        expect(mockDeleteFile.mock.calls[0][0]).toContain('flux2-klein-4B-Q4_0.gguf');
        expect(mockDeleteFile.mock.calls[1][0]).toContain('Qwen3-4B-Q4_0.gguf');

        // rmdir only removes empty directory (protects shared files from other variants)
        expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining('flux-2-klein-4b'));
      });

      it('should skip existing component files instead of throwing', async () => {
        // Simulate: primary exists, llm does not, vae does not
        // fileExists is called: 3x during HEAD pre-fetch, 3x during download loop
        mockFileExists.mockReset();
        // HEAD pre-fetch phase: primary exists (skip HEAD), llm doesn't, vae doesn't
        mockFileExists
          .mockResolvedValueOnce(true) // HEAD: primary exists
          .mockResolvedValueOnce(false) // HEAD: llm doesn't exist
          .mockResolvedValueOnce(false) // HEAD: vae doesn't exist
          // Download loop phase:
          .mockResolvedValueOnce(true) // download loop: primary exists → skip
          .mockResolvedValueOnce(false) // download loop: llm doesn't exist → download
          .mockResolvedValueOnce(false); // download loop: vae doesn't exist → download

        // getFileSize called: 1 for HEAD pre-fetch (primary exists), 1 for skip (primary exists),
        // plus 2 after download + 3 for components map
        mockGetFileSize.mockReset();
        mockGetFileSize
          .mockResolvedValueOnce(4_300_000_000) // HEAD pre-fetch: primary file size
          .mockResolvedValueOnce(4_300_000_000) // download loop: skip primary, count size
          .mockResolvedValueOnce(2_500_000_000) // download loop: after llm download
          .mockResolvedValueOnce(335_000_000) // download loop: after vae download
          .mockResolvedValueOnce(4_300_000_000) // components map: primary
          .mockResolvedValueOnce(2_500_000_000) // components map: llm
          .mockResolvedValueOnce(335_000_000); // components map: vae

        const model = await modelManager.downloadModel(flux2KleinConfig);

        // Only 2 components should be downloaded (primary was skipped)
        expect(mockDownload).toHaveBeenCalledTimes(2);
        // Skipped file should still appear in the components map
        expect(model.components).toBeDefined();
        expect(model.components!.diffusion_model).toBeDefined();
        expect(model.components!.llm).toBeDefined();
        expect(model.components!.vae).toBeDefined();
        // Aggregate size includes the skipped file
        expect(model.size).toBe(4_300_000_000 + 2_500_000_000 + 335_000_000);
      });

      it('should wrap non-DownloadError errors as DownloadError', async () => {
        // Simulate a generic error (not DownloadError) on first component download
        mockDownload.mockReset();
        mockDownload.mockRejectedValueOnce(new TypeError('fetch failed'));

        await expect(modelManager.downloadModel(flux2KleinConfig)).rejects.toThrow(DownloadError);

        // Verify the error message wraps the original
        mockDownload.mockReset();
        mockDownload.mockRejectedValueOnce(new TypeError('fetch failed'));
        try {
          await modelManager.downloadModel({
            ...flux2KleinConfig,
            name: 'Flux 2 Klein wrap test',
          });
          throw new Error('Should have thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(DownloadError);
          expect(error.message).toMatch(/Multi-component download failed/);
        }
      });
    });

    describe('idempotency guard', () => {
      it('should throw DownloadError when model ID already exists', async () => {
        // loadModelMetadata succeeds → model already exists
        mockStorageManager.loadModelMetadata.mockReset();
        mockStorageManager.loadModelMetadata.mockResolvedValueOnce({ id: 'flux-2-klein-4b' });

        await expect(modelManager.downloadModel(flux2KleinConfig)).rejects.toThrow(DownloadError);
        await expect(
          modelManager.downloadModel({
            ...flux2KleinConfig,
            name: 'Flux 2 Klein 4B dupe',
          })
        ).rejects.toThrow(/already exists/);
      });
    });

    describe('modelDirectory support', () => {
      it('should use modelDirectory for subdirectory instead of model ID', async () => {
        pathsMockState.getModelDirectoryCalls = [];

        await modelManager.downloadModel({
          ...flux2KleinConfig,
          name: 'Flux 2 Klein Q8_0',
          modelDirectory: 'flux-2-klein',
        });

        // getModelDirectory should be called with the sanitized modelDirectory, not the model ID
        expect(pathsMockState.getModelDirectoryCalls).toContainEqual({
          type: 'diffusion',
          modelId: 'flux-2-klein', // modelDirectory, NOT 'flux-2-klein-q80'
        });
      });

      it('should sanitize modelDirectory to prevent path traversal', async () => {
        pathsMockState.getModelDirectoryCalls = [];

        await modelManager.downloadModel({
          ...flux2KleinConfig,
          name: 'Flux 2 Klein Traversal',
          modelDirectory: '../../etc/evil',
        });

        // generateModelId strips special chars: '../../etc/evil' → 'etcevil'
        const dirCall = pathsMockState.getModelDirectoryCalls[0];
        expect(dirCall?.modelId).not.toContain('..');
        expect(dirCall?.modelId).not.toContain('/');
      });
    });

    describe('error cleanup with shared files', () => {
      it('should not delete pre-existing shared files on error', async () => {
        // Simulate: encoder.bin and vae.bin already exist (from variant A)
        // Primary downloads, then something fails
        mockFileExists.mockReset();
        // HEAD pre-fetch: primary doesn't exist, llm exists, vae exists
        mockFileExists
          .mockResolvedValueOnce(false) // HEAD: primary
          .mockResolvedValueOnce(true) // HEAD: llm exists
          .mockResolvedValueOnce(true) // HEAD: vae exists
          // Download loop: primary doesn't exist → download, llm exists → skip, vae exists → skip
          .mockResolvedValueOnce(false) // loop: primary
          .mockResolvedValueOnce(true) // loop: llm exists → skip
          .mockResolvedValueOnce(true); // loop: vae exists → skip

        // Primary download succeeds, but then we simulate a late failure
        // by making getFileSize fail after primary download
        mockGetFileSize.mockReset();
        mockGetFileSize
          .mockResolvedValueOnce(2_500_000_000) // HEAD: llm file size
          .mockResolvedValueOnce(335_000_000) // HEAD: vae file size
          .mockResolvedValueOnce(4_300_000_000) // loop: primary after download
          .mockResolvedValueOnce(2_500_000_000) // loop: llm skip size
          .mockResolvedValueOnce(335_000_000); // loop: vae skip size

        // Make primary download succeed but then checksum fails
        mockDownload.mockResolvedValueOnce(undefined);
        mockCalculateSHA256.mockResolvedValueOnce('wrong_hash');

        const configWithChecksum: DownloadConfig = {
          ...flux2KleinConfig,
          name: 'Flux 2 Klein Shared Cleanup',
          checksum: 'sha256:expected_hash',
          modelDirectory: 'flux-2-klein',
        };

        try {
          await modelManager.downloadModel(configWithChecksum);
        } catch {
          // Expected
        }

        // Only the primary file (downloaded in THIS attempt) should be cleaned up
        expect(mockDeleteFile).toHaveBeenCalledTimes(1);
        expect(mockDeleteFile.mock.calls[0][0]).toContain('flux2-klein-4B-Q4_0.gguf');
      });
    });

    describe('all components already exist', () => {
      it('should succeed without downloading when all components exist', async () => {
        // All files already exist on disk (e.g., from another variant)
        mockFileExists.mockReset();
        // HEAD pre-fetch: all exist
        mockFileExists
          .mockResolvedValueOnce(true) // HEAD: primary exists
          .mockResolvedValueOnce(true) // HEAD: llm exists
          .mockResolvedValueOnce(true) // HEAD: vae exists
          // Download loop: all exist → skip all
          .mockResolvedValueOnce(true) // loop: primary exists
          .mockResolvedValueOnce(true) // loop: llm exists
          .mockResolvedValueOnce(true); // loop: vae exists

        mockGetFileSize.mockReset();
        mockGetFileSize
          .mockResolvedValueOnce(4_300_000_000) // HEAD: primary size
          .mockResolvedValueOnce(2_500_000_000) // HEAD: llm size
          .mockResolvedValueOnce(335_000_000) // HEAD: vae size
          .mockResolvedValueOnce(4_300_000_000) // loop: primary skip size
          .mockResolvedValueOnce(2_500_000_000) // loop: llm skip size
          .mockResolvedValueOnce(335_000_000) // loop: vae skip size
          .mockResolvedValueOnce(4_300_000_000) // components map: primary
          .mockResolvedValueOnce(2_500_000_000) // components map: llm
          .mockResolvedValueOnce(335_000_000); // components map: vae

        const model = await modelManager.downloadModel({
          ...flux2KleinConfig,
          name: 'All Exist Model',
        });

        // No downloads should have been made
        expect(mockDownload).not.toHaveBeenCalled();
        // Model should still be valid with correct aggregate size
        expect(model.components).toBeDefined();
        expect(model.size).toBe(4_300_000_000 + 2_500_000_000 + 335_000_000);
      });
    });

    describe('existing file checksum verification', () => {
      it('should skip existing file when checksum matches', async () => {
        const configWithChecksums: DownloadConfig = {
          ...flux2KleinConfig,
          name: 'Checksum Skip Model',
          components: [
            {
              role: 'llm',
              source: 'huggingface',
              repo: 'unsloth/Qwen3-4B-GGUF',
              file: 'Qwen3-4B-Q4_0.gguf',
              checksum: 'sha256:goodhash',
            },
            {
              role: 'vae',
              source: 'huggingface',
              repo: 'Comfy-Org/flux2-dev',
              file: 'flux2-vae.safetensors',
            },
          ],
        };

        // Primary doesn't exist, LLM exists (has checksum), VAE doesn't exist
        mockFileExists.mockReset();
        mockFileExists
          .mockResolvedValueOnce(false) // HEAD: primary doesn't exist
          .mockResolvedValueOnce(true) // HEAD: llm exists
          .mockResolvedValueOnce(false) // HEAD: vae doesn't exist
          .mockResolvedValueOnce(false) // loop: primary → download
          .mockResolvedValueOnce(true) // loop: llm exists → verify checksum
          .mockResolvedValueOnce(false); // loop: vae → download

        mockGetFileSize.mockReset();
        mockGetFileSize
          .mockResolvedValueOnce(2_500_000_000) // HEAD: llm existing size
          .mockResolvedValueOnce(4_300_000_000) // loop: primary after download
          .mockResolvedValueOnce(2_500_000_000) // loop: llm skip size
          .mockResolvedValueOnce(335_000_000) // loop: vae after download
          .mockResolvedValueOnce(4_300_000_000) // components map: primary
          .mockResolvedValueOnce(2_500_000_000) // components map: llm
          .mockResolvedValueOnce(335_000_000); // components map: vae

        // Checksum matches → skip
        mockVerifyChecksum.mockResolvedValueOnce(true);

        const model = await modelManager.downloadModel(configWithChecksums);

        // LLM was skipped (checksum valid), so only 2 downloads
        expect(mockDownload).toHaveBeenCalledTimes(2);
        expect(mockVerifyChecksum).toHaveBeenCalledTimes(1);
        expect(model.components!.llm).toBeDefined();
      });

      it('should re-download existing file when checksum mismatches', async () => {
        const configWithChecksums: DownloadConfig = {
          ...flux2KleinConfig,
          name: 'Checksum Mismatch Model',
          components: [
            {
              role: 'llm',
              source: 'huggingface',
              repo: 'unsloth/Qwen3-4B-GGUF',
              file: 'Qwen3-4B-Q4_0.gguf',
              checksum: 'sha256:expectedhash',
            },
            {
              role: 'vae',
              source: 'huggingface',
              repo: 'Comfy-Org/flux2-dev',
              file: 'flux2-vae.safetensors',
            },
          ],
        };

        // Primary doesn't exist, LLM exists (bad checksum), VAE doesn't exist
        mockFileExists.mockReset();
        mockFileExists
          .mockResolvedValueOnce(false) // HEAD: primary doesn't exist
          .mockResolvedValueOnce(true) // HEAD: llm exists
          .mockResolvedValueOnce(false) // HEAD: vae doesn't exist
          .mockResolvedValueOnce(false) // loop: primary → download
          .mockResolvedValueOnce(true) // loop: llm exists → verify checksum (fails)
          .mockResolvedValueOnce(false); // loop: vae → download

        mockGetFileSize.mockReset();
        mockGetFileSize
          .mockResolvedValueOnce(2_500_000_000) // HEAD: llm existing size
          .mockResolvedValueOnce(4_300_000_000) // loop: primary after download
          .mockResolvedValueOnce(2_500_000_000) // loop: llm after re-download
          .mockResolvedValueOnce(335_000_000) // loop: vae after download
          .mockResolvedValueOnce(4_300_000_000) // components map: primary
          .mockResolvedValueOnce(2_500_000_000) // components map: llm
          .mockResolvedValueOnce(335_000_000); // components map: vae

        // Checksum mismatch → delete and re-download
        mockVerifyChecksum.mockResolvedValueOnce(false);
        // After re-download, post-download checksum verification must pass
        mockCalculateSHA256.mockResolvedValueOnce('expectedhash');

        const model = await modelManager.downloadModel(configWithChecksums);

        // LLM was re-downloaded after checksum mismatch, so all 3 downloaded
        expect(mockDownload).toHaveBeenCalledTimes(3);
        expect(mockVerifyChecksum).toHaveBeenCalledTimes(1);
        expect(mockDeleteFile).toHaveBeenCalled();
        expect(model.components!.llm).toBeDefined();
      });
    });

    describe('per-component checksum verification', () => {
      it('should verify checksums for all components when provided', async () => {
        const configWithChecksums: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Checksum Model',
          type: 'diffusion',
          checksum: 'sha256:aaa111',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
              checksum: 'sha256:bbb222',
            },
          ],
        };

        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1_000_000_000).mockResolvedValueOnce(200_000_000);
        fetchSpy.mockImplementation(async () => createHeadResponse(500_000_000));

        // Checksums match
        mockCalculateSHA256
          .mockResolvedValueOnce('aaa111') // primary
          .mockResolvedValueOnce('bbb222'); // vae
        mockFormatChecksum.mockImplementation((hash: string) => `sha256:${hash}`);

        const model = await modelManager.downloadModel(configWithChecksums);

        expect(model).toBeDefined();
        expect(mockCalculateSHA256).toHaveBeenCalledTimes(2);
        expect(model.components!.diffusion_model!.checksum).toBe('sha256:aaa111');
        expect(model.components!.vae!.checksum).toBe('sha256:bbb222');
      });

      it('should throw DownloadError when component checksum mismatches', async () => {
        const configWithBadChecksum: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Bad Checksum Model',
          type: 'diffusion',
          checksum: 'sha256:aaa111',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
              checksum: 'sha256:expected_hash',
            },
          ],
        };

        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1_000_000_000).mockResolvedValueOnce(200_000_000);
        fetchSpy.mockImplementation(async () => createHeadResponse(500_000_000));

        // Primary checksum matches, vae checksum mismatches
        mockCalculateSHA256
          .mockResolvedValueOnce('aaa111') // primary matches
          .mockResolvedValueOnce('wrong_hash'); // vae mismatches

        await expect(modelManager.downloadModel(configWithBadChecksum)).rejects.toThrow(
          DownloadError
        );
        await expect(
          modelManager
            .downloadModel({
              ...configWithBadChecksum,
              name: 'Bad Checksum Model 2',
            })
            .catch(async () => {
              // Need to reset mocks for second assertion
              mockCalculateSHA256
                .mockResolvedValueOnce('aaa111')
                .mockResolvedValueOnce('wrong_hash');
              mockGetFileSize.mockReset();
              mockGetFileSize
                .mockResolvedValueOnce(1_000_000_000)
                .mockResolvedValueOnce(200_000_000);
              mockFileExists.mockResolvedValue(false);
              throw await modelManager
                .downloadModel({
                  ...configWithBadChecksum,
                  name: 'Bad Checksum Model 3',
                })
                .catch((e) => e);
            })
        ).rejects.toThrow(/Checksum verification failed for component: vae/);
      });

      it('should clean up on checksum failure', async () => {
        const configWithBadChecksum: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Checksum Cleanup',
          type: 'diffusion',
          checksum: 'sha256:good_hash',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
              checksum: 'sha256:expected',
            },
          ],
        };

        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(1_000_000_000).mockResolvedValueOnce(200_000_000);
        fetchSpy.mockImplementation(async () => createHeadResponse(500_000_000));

        // Primary checksum matches, vae fails
        mockCalculateSHA256
          .mockResolvedValueOnce('good_hash') // primary OK
          .mockResolvedValueOnce('bad_hash'); // vae mismatch

        try {
          await modelManager.downloadModel(configWithBadChecksum);
        } catch {
          // Expected
        }

        // Primary was downloaded and tracked, should be cleaned up
        expect(mockDeleteFile).toHaveBeenCalled();
        // rmdir only removes empty directory (protects shared files from other variants)
        expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining('checksum-cleanup'));
      });
    });

    describe('resolveComponentURL', () => {
      it('should resolve HuggingFace source via getHuggingFaceURL', async () => {
        // The flux2KleinConfig uses HuggingFace sources
        await modelManager.downloadModel(flux2KleinConfig);

        // Primary + 2 components = 3 calls to getHuggingFaceURL
        expect(mockGetHuggingFaceURL).toHaveBeenCalledTimes(3);
        expect(mockGetHuggingFaceURL).toHaveBeenCalledWith(
          'leejet/FLUX.2-klein-4B-GGUF',
          'flux2-klein-4B-Q4_0.gguf'
        );
        expect(mockGetHuggingFaceURL).toHaveBeenCalledWith(
          'unsloth/Qwen3-4B-GGUF',
          'Qwen3-4B-Q4_0.gguf'
        );
        expect(mockGetHuggingFaceURL).toHaveBeenCalledWith(
          'Comfy-Org/flux2-dev',
          'flux2-vae.safetensors'
        );
      });

      it('should use direct URL when source is url', async () => {
        const urlConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'URL Test',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://cdn.example.com/vae.safetensors',
            },
          ],
        };

        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValueOnce(500_000_000).mockResolvedValueOnce(100_000_000);
        fetchSpy.mockImplementation(async () => createHeadResponse(300_000_000));

        await modelManager.downloadModel(urlConfig);

        // Direct URLs should be used directly, not via getHuggingFaceURL
        expect(mockDownload.mock.calls[0][0].url).toBe('https://example.com/primary.gguf');
        expect(mockDownload.mock.calls[1][0].url).toBe('https://cdn.example.com/vae.safetensors');
      });

      it('should throw DownloadError when URL source has no url', async () => {
        const noURLConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Missing URL Test',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'url',
              // Missing url!
            } as any,
          ],
        };

        await expect(modelManager.downloadModel(noURLConfig)).rejects.toThrow(DownloadError);
        await expect(
          modelManager.downloadModel({
            ...noURLConfig,
            name: 'Missing URL Test 2',
          })
        ).rejects.toThrow(/URL is required/);
      });

      it('should throw DownloadError when HuggingFace source missing repo/file', async () => {
        const noRepoConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/primary.gguf',
          name: 'Missing Repo Test',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'huggingface',
              // Missing repo and file!
            } as any,
          ],
        };

        await expect(modelManager.downloadModel(noRepoConfig)).rejects.toThrow(DownloadError);
        await expect(
          modelManager.downloadModel({
            ...noRepoConfig,
            name: 'Missing Repo Test 2',
          })
        ).rejects.toThrow(/Repository and file are required/);
      });

      it('should throw DownloadError when primary URL source has no url', async () => {
        const noPrimaryURLConfig: DownloadConfig = {
          source: 'url',
          // Missing url for primary!
          name: 'No Primary URL',
          type: 'diffusion',
          components: [
            {
              role: 'vae',
              source: 'url',
              url: 'https://example.com/vae.safetensors',
            },
          ],
        } as any;

        await expect(modelManager.downloadModel(noPrimaryURLConfig)).rejects.toThrow(DownloadError);
      });
    });

    describe('HEAD request pre-fetch', () => {
      it('should make parallel HEAD requests for all components', async () => {
        await modelManager.downloadModel(flux2KleinConfig);

        // 3 HEAD requests (one per component)
        const headCalls = fetchSpy.mock.calls.filter(
          (call) => (call[1] as RequestInit)?.method === 'HEAD'
        );
        expect(headCalls).toHaveLength(3);
      });

      it('should handle HEAD request failures gracefully', async () => {
        // HEAD requests all fail
        fetchSpy.mockRejectedValue(new Error('Network error'));

        // Should still succeed (totalBytes defaults to 0 for failed HEAD)
        const model = await modelManager.downloadModel(flux2KleinConfig);

        expect(model).toBeDefined();
        expect(model.components).toBeDefined();
      });
    });

    describe('empty components edge case', () => {
      it('should use single-file flow when components array is empty', async () => {
        const emptyComponentsConfig: DownloadConfig = {
          source: 'url',
          url: 'https://example.com/model.gguf',
          name: 'Empty Components',
          type: 'llm',
          components: [],
        };

        // Setup for single-file download path
        mockFileExists.mockReset();
        mockFileExists.mockResolvedValueOnce(false).mockResolvedValue(true);
        mockGetFileSize.mockReset();
        mockGetFileSize.mockResolvedValue(1_000_000_000);

        const model = await modelManager.downloadModel(emptyComponentsConfig);

        // Should NOT create a subdirectory (single-file path)
        expect(mockMkdir).not.toHaveBeenCalled();

        // Should download once (single file)
        expect(mockDownload).toHaveBeenCalledTimes(1);

        // Should not have components
        expect(model.components).toBeUndefined();
      });
    });
  });
});
