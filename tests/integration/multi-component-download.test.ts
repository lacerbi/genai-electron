/**
 * Integration test for multi-component model downloads.
 *
 * Uses a REAL local HTTP server and REAL Downloader — no network mocks.
 * Only mocks: Electron paths (no electron in test), StorageManager (metadata persistence),
 * and GGUF parser (no remote HuggingFace calls for metadata).
 *
 * Verifies the complete downloadMultiComponentModel flow:
 * - HEAD requests for total size
 * - Sequential file downloads with real HTTP
 * - Progress callbacks with correct aggregate values
 * - onComponentStart callbacks
 * - Files written to disk with correct content
 * - ModelInfo with correct components map
 */

import { jest } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Test data ────────────────────────────────────────────────────────────────
// Small but non-trivial buffers so we can verify content integrity
const MODEL_CONTENT = Buffer.alloc(4096, 'M');
const ENCODER_CONTENT = Buffer.alloc(2048, 'E');
const VAE_CONTENT = Buffer.alloc(1024, 'V');

const FILES: Record<string, Buffer> = {
  '/model.bin': MODEL_CONTENT,
  '/encoder.bin': ENCODER_CONTENT,
  '/vae.bin': VAE_CONTENT,
};

// ── Shared mutable state (set in beforeAll, read by mock closures) ───────────
const testState = {
  tempDir: '',
};

// ── Saved metadata collector ─────────────────────────────────────────────────
const savedMetadata: unknown[] = [];

// ── Mocks (must be declared before any imports from src/) ────────────────────

// StorageManager — just collects metadata, no real persistence
const mockStorageManager = {
  initialize: async () => {},
  saveModelMetadata: async (info: unknown) => {
    savedMetadata.push(info);
  },
  getModelPath: (type: string, filename: string) => path.join(testState.tempDir, type, filename),
  listModelFiles: async () => [],
  loadModelMetadata: async () => {
    throw new Error('not found');
  },
  deleteModelFiles: async () => {},
  verifyModelIntegrity: async () => true,
};

jest.unstable_mockModule('../../src/managers/StorageManager.js', () => ({
  StorageManager: jest.fn(() => mockStorageManager),
  storageManager: mockStorageManager,
}));

// Paths — redirect to temp directory (avoids Electron app.getPath dependency)
jest.unstable_mockModule('../../src/config/paths.js', () => ({
  getModelDirectory: (type: string, modelId: string) => path.join(testState.tempDir, type, modelId),
  getModelFilePath: (type: string, filename: string) =>
    path.join(testState.tempDir, type, filename),
  getModelMetadataPath: (type: string, modelId: string) =>
    path.join(testState.tempDir, type, `${modelId}.json`),
  PATHS: {
    models: {
      llm: path.join(testState.tempDir, 'llm'),
      diffusion: path.join(testState.tempDir, 'diffusion'),
    },
    binaries: { llama: '', diffusion: '' },
    logs: '',
    config: '',
    temp: '',
  },
  BASE_DIR: testState.tempDir,
  ensureDirectories: async () => {},
  getBinaryPath: () => '',
  getLogPath: () => '',
  getConfigPath: () => '',
  getTempPath: () => '',
}));

// GGUF parser — avoid real HuggingFace network requests
jest.unstable_mockModule('../../src/utils/gguf-parser.js', () => ({
  fetchGGUFMetadata: async () => ({
    metadata: { version: 3, 'general.architecture': 'test' },
  }),
  fetchLocalGGUFMetadata: async () => ({ metadata: {} }),
  getArchField: () => undefined,
}));

// Reasoning models — trivial mock
jest.unstable_mockModule('../../src/config/reasoning-models.js', () => ({
  detectReasoningSupport: () => false,
  REASONING_MODEL_PATTERNS: [],
}));

// Model metadata helpers — not exercised in download path
jest.unstable_mockModule('../../src/utils/model-metadata-helpers.js', () => ({
  getLayerCountWithFallback: () => 32,
  getContextLengthWithFallback: () => 4096,
  getArchitectureWithFallback: () => 'test',
}));

// ── Import real modules AFTER mocks ──────────────────────────────────────────
const { ModelManager } = await import('../../src/managers/ModelManager.js');
const { fileExists, getFileSize } = await import('../../src/utils/file-utils.js');

// ── HTTP server helpers ──────────────────────────────────────────────────────

function createTestServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const filePath = req.url || '/';
      const content = FILES[filePath];

      if (!content) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': String(content.length),
          'Content-Type': 'application/octet-stream',
        });
        res.end();
        return;
      }

      // GET
      res.writeHead(200, {
        'Content-Length': String(content.length),
        'Content-Type': 'application/octet-stream',
      });
      res.end(content);
    });

    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: srv, port });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Multi-component download integration', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    testState.tempDir = await mkdtemp(path.join(tmpdir(), 'genai-mc-test-'));
    const srv = await createTestServer();
    server = srv.server;
    port = srv.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(testState.tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedMetadata.length = 0;
  });

  it('downloads all components with correct progress and file output', async () => {
    const mm = ModelManager.getInstance();
    await mm.initialize();

    const progressCalls: Array<{ downloaded: number; total: number }> = [];
    const componentStarts: Array<{
      role: string;
      filename: string;
      index: number;
      total: number;
    }> = [];

    const result = await mm.downloadModel({
      source: 'url',
      url: `http://localhost:${port}/model.bin`,
      name: 'Test Multi Model',
      type: 'diffusion',
      onProgress: (downloaded: number, total: number) => {
        progressCalls.push({ downloaded, total });
      },
      onComponentStart: (info) => {
        componentStarts.push(info);
      },
      components: [
        {
          role: 'llm' as const,
          source: 'url' as const,
          url: `http://localhost:${port}/encoder.bin`,
        },
        {
          role: 'vae' as const,
          source: 'url' as const,
          url: `http://localhost:${port}/vae.bin`,
        },
      ],
    });

    // ── onComponentStart ────────────────────────────────────────────────
    expect(componentStarts).toHaveLength(3);
    expect(componentStarts[0]).toEqual({
      role: 'diffusion_model',
      filename: 'model.bin',
      index: 1,
      total: 3,
    });
    expect(componentStarts[1]).toEqual({
      role: 'llm',
      filename: 'encoder.bin',
      index: 2,
      total: 3,
    });
    expect(componentStarts[2]).toEqual({
      role: 'vae',
      filename: 'vae.bin',
      index: 3,
      total: 3,
    });

    // ── Progress callbacks ──────────────────────────────────────────────
    // Must have been called at least once with non-zero values
    expect(progressCalls.length).toBeGreaterThan(0);

    // Last call should have aggregate total = sum of all files
    const expectedTotal = MODEL_CONTENT.length + ENCODER_CONTENT.length + VAE_CONTENT.length;
    const lastCall = progressCalls[progressCalls.length - 1]!;
    expect(lastCall.downloaded).toBe(expectedTotal);
    expect(lastCall.total).toBe(expectedTotal);

    // Every call should have total >= downloaded (no nonsensical values)
    for (const call of progressCalls) {
      expect(call.total).toBeGreaterThanOrEqual(call.downloaded);
      expect(call.downloaded).toBeGreaterThan(0);
      expect(call.total).toBeGreaterThan(0);
    }

    // ── Files on disk ───────────────────────────────────────────────────
    const modelDir = path.join(testState.tempDir, 'diffusion', 'test-multi-model');
    expect(await fileExists(path.join(modelDir, 'model.bin'))).toBe(true);
    expect(await fileExists(path.join(modelDir, 'encoder.bin'))).toBe(true);
    expect(await fileExists(path.join(modelDir, 'vae.bin'))).toBe(true);

    // Verify sizes match
    expect(await getFileSize(path.join(modelDir, 'model.bin'))).toBe(MODEL_CONTENT.length);
    expect(await getFileSize(path.join(modelDir, 'encoder.bin'))).toBe(ENCODER_CONTENT.length);
    expect(await getFileSize(path.join(modelDir, 'vae.bin'))).toBe(VAE_CONTENT.length);

    // Verify content integrity
    const modelData = await readFile(path.join(modelDir, 'model.bin'));
    expect(modelData.equals(MODEL_CONTENT)).toBe(true);
    const encoderData = await readFile(path.join(modelDir, 'encoder.bin'));
    expect(encoderData.equals(ENCODER_CONTENT)).toBe(true);
    const vaeData = await readFile(path.join(modelDir, 'vae.bin'));
    expect(vaeData.equals(VAE_CONTENT)).toBe(true);

    // ── Returned ModelInfo ──────────────────────────────────────────────
    expect(result.id).toBe('test-multi-model');
    expect(result.name).toBe('Test Multi Model');
    expect(result.type).toBe('diffusion');
    expect(result.size).toBe(expectedTotal);

    // Components map
    expect(result.components).toBeDefined();
    expect(result.components!.diffusion_model).toBeDefined();
    expect(result.components!.diffusion_model!.size).toBe(MODEL_CONTENT.length);
    expect(result.components!.llm).toBeDefined();
    expect(result.components!.llm!.size).toBe(ENCODER_CONTENT.length);
    expect(result.components!.vae).toBeDefined();
    expect(result.components!.vae!.size).toBe(VAE_CONTENT.length);

    // All component paths should be absolute and inside the model dir
    for (const comp of Object.values(result.components!)) {
      expect(comp!.path.startsWith(modelDir)).toBe(true);
    }

    // ── Metadata saved ──────────────────────────────────────────────────
    expect(savedMetadata).toHaveLength(1);
    expect((savedMetadata[0] as { id: string }).id).toBe('test-multi-model');
  }, 15_000);

  it('reports correct progress when HEAD returns no Content-Length', async () => {
    // Create a server that omits Content-Length from HEAD responses
    const noHeadServer = http.createServer((req, res) => {
      const filePath = req.url || '/';
      const content = FILES[filePath];
      if (!content) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      if (req.method === 'HEAD') {
        // No Content-Length header — simulates CDN that doesn't support HEAD
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(content.length),
        'Content-Type': 'application/octet-stream',
      });
      res.end(content);
    });

    const noHeadPort = await new Promise<number>((resolve) => {
      noHeadServer.listen(0, () => {
        const addr = noHeadServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      // Need a fresh ModelManager instance — reset singleton
      // @ts-expect-error accessing private static for test
      ModelManager.instance = undefined;
      const mm = ModelManager.getInstance();
      await mm.initialize();

      const progressCalls: Array<{ downloaded: number; total: number }> = [];

      await mm.downloadModel({
        source: 'url',
        url: `http://localhost:${noHeadPort}/model.bin`,
        name: 'No HEAD Model',
        type: 'diffusion',
        onProgress: (downloaded: number, total: number) => {
          progressCalls.push({ downloaded, total });
        },
        components: [
          {
            role: 'llm' as const,
            source: 'url' as const,
            url: `http://localhost:${noHeadPort}/encoder.bin`,
          },
          {
            role: 'vae' as const,
            source: 'url' as const,
            url: `http://localhost:${noHeadPort}/vae.bin`,
          },
        ],
      });

      // Progress must have been called
      expect(progressCalls.length).toBeGreaterThan(0);

      // Key assertion: total should NEVER be 0 (the bug we're fixing)
      for (const call of progressCalls) {
        expect(call.total).toBeGreaterThan(0);
        expect(call.downloaded).toBeGreaterThan(0);
      }

      // Last call should still have the correct aggregate total
      // (recovered from GET Content-Length even though HEAD had no size)
      const expectedTotal = MODEL_CONTENT.length + ENCODER_CONTENT.length + VAE_CONTENT.length;
      const lastCall = progressCalls[progressCalls.length - 1]!;
      expect(lastCall.downloaded).toBe(expectedTotal);
      expect(lastCall.total).toBe(expectedTotal);

      // Verify files exist
      const modelDir = path.join(testState.tempDir, 'diffusion', 'no-head-model');
      expect(await fileExists(path.join(modelDir, 'model.bin'))).toBe(true);
      expect(await fileExists(path.join(modelDir, 'encoder.bin'))).toBe(true);
      expect(await fileExists(path.join(modelDir, 'vae.bin'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => noHeadServer.close(() => resolve()));
    }
  }, 15_000);
});
