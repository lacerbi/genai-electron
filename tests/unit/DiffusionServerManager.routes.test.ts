/**
 * Unit tests for the DiffusionServerManager HTTP wrapper routes
 *
 * Everything here goes through the real `node:http` request handler (pulled out of the
 * mocked `createServer`), so the assertions are byte-level statements about the wire
 * contract genai-lite's GenaiElectronImageAdapter reads: POST/GET/DELETE
 * `/v1/images/generations`, `/health`, CORS, and the `{error:{message,code}}` envelope.
 *
 * Backend lifecycle lives in DiffusionServerManager.lifecycle.test.ts and job/progress
 * behaviour in DiffusionServerManager.generation.test.ts.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { DiffusionServerConfig, ModelInfo } from '../../src/types/index.js';

// Backend seam (shared with the other DiffusionServerManager suites): the manager
// drives `sd-server` through the runner + client pair, never a raw child process.
import {
  handles,
  mockCancelJob,
  mockGetJob,
  mockStartSdServerRunner,
  mockSubmitImageJob,
  resetSdServerMocks,
  sdServerReadyTimeoutError,
} from './helpers/sd-server-mocks.js';

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

// Mock http module. `listen` takes (port, host, callback) — the wrapper binds
// loopback-only by default.
const mockHttpServer = new EventEmitter() as any;
const resetHttpServerMocks = (): void => {
  mockHttpServer.listen = jest
    .fn()
    .mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback();
      return mockHttpServer;
    });
  // close() is also called without a callback (startup-error cleanup)
  mockHttpServer.close = jest.fn().mockImplementation((callback?: () => void) => {
    callback?.();
  });
};
resetHttpServerMocks();

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
}

jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// Mock BinaryManager
const mockEnsureBinary = jest.fn();
const mockBinaryConfigs: any[] = [];

class MockBinaryManager {
  ensureBinary = mockEnsureBinary;
  constructor(config: any) {
    mockBinaryConfigs.push(config);
  }
}

jest.unstable_mockModule('../../src/managers/BinaryManager.js', () => ({
  BinaryManager: MockBinaryManager,
}));

// Mock health-check
const mockIsServerResponding = jest.fn();

jest.unstable_mockModule('../../src/process/health-check.js', () => ({
  isServerResponding: mockIsServerResponding,
  checkHealth: jest.fn(),
  waitForHealthy: jest.fn(),
  normalizeHealthHost: (host?: string) => {
    if (host === '::') return '::1';
    if (host === undefined || host === '' || host === '0.0.0.0') return '127.0.0.1';
    return host;
  },
  formatHttpHost: (host: string) =>
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host,
}));

// Mock port-utils (never bind real sockets in unit tests)
const mockFindFreePort = jest.fn(async () => 49999);
const mockIsPortBindable = jest.fn(async () => true);

jest.unstable_mockModule('../../src/process/port-utils.js', () => ({
  findFreePort: mockFindFreePort,
  isPortBindable: mockIsPortBindable,
}));

// Mock file-utils
const mockEnsureDirectory = jest.fn(async () => undefined);
const mockDeleteFile = jest.fn(async () => undefined);

jest.unstable_mockModule('../../src/utils/file-utils.js', () => ({
  ensureDirectory: mockEnsureDirectory,
  deleteFile: mockDeleteFile,
  fileExists: jest.fn(),
  getFileSize: jest.fn(),
  moveFile: jest.fn(),
  copyDirectory: jest.fn(),
  calculateChecksum: jest.fn(),
  formatBytes: jest.fn(),
  isAbsolutePath: jest.fn(),
  sanitizeFilename: jest.fn(),
}));

// Mock paths
const mockGetTempPath = jest.fn((filename: string) => `/test/temp/${filename}`);
const mockGetBinaryPath = jest.fn(
  (type: string, binaryName: string) => `/test/binaries/${type}/${binaryName}`
);

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  BASE_DIR: '/test/userData',
  PATHS: {
    models: { llm: '/test/models/llm', diffusion: '/test/models/diffusion' },
    binaries: { llama: '/test/binaries/llama', diffusion: '/test/binaries/diffusion' },
    logs: '/test/logs',
    config: '/test/config',
    temp: '/test/temp',
    loras: '/test/loras',
  },
  getBinaryPath: mockGetBinaryPath,
  getTempPath: mockGetTempPath,
  getModelFilePath: jest.fn(),
  getModelDirectory: jest.fn(),
  ensureDirectories: jest.fn(),
}));

// Import after mocking
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');
const { ServerError } = await import('../../src/errors/index.js');

type Manager = InstanceType<typeof DiffusionServerManager>;
type RequestHandler = (req: any, res: any) => Promise<void> | void;

const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('DiffusionServerManager (HTTP routes)', () => {
  let diffusionServer: Manager;
  let requestHandler: RequestHandler;

  const mockModelInfo: ModelInfo = {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    type: 'diffusion',
    size: 6.5 * 1024 * 1024 * 1024,
    path: '/test/models/diffusion/sdxl-turbo.gguf',
    downloadedAt: '2025-10-17T10:00:00Z',
    source: { type: 'url', url: 'https://example.com/sdxl-turbo.gguf' },
  };

  const mockConfig: DiffusionServerConfig = {
    modelId: 'sdxl-turbo',
    port: 8081,
    clipOnCpu: true,
    vaeOnCpu: false,
    offloadToCpu: false,
    diffusionFlashAttention: false,
  };

  const createRes = (): any => ({
    setHeader: jest.fn(),
    writeHead: jest.fn(),
    end: jest.fn(),
  });

  const statusOf = (res: any): number => res.writeHead.mock.calls[0][0] as number;
  const bodyOf = (res: any): any => JSON.parse(res.end.mock.calls[0][0] as string);

  /**
   * Dispatch a request with no body (GET/DELETE/OPTIONS/unknown). `headers` stands in for
   * `IncomingMessage.headers` (always an object on a real request); pass `origin` / `host`
   * to exercise the CORS allowlist and the loopback Host guard.
   */
  const request = (
    url: string,
    method: string,
    headers: Record<string, string> = {}
  ): { res: any; done: Promise<void>; req: EventEmitter } => {
    const req = new EventEmitter() as any;
    req.url = url;
    req.method = method;
    req.headers = headers;
    const res = createRes();
    const done = Promise.resolve(requestHandler(req, res)) as Promise<void>;
    return { res, done, req };
  };

  /**
   * Dispatch POST /v1/images/generations.
   *
   * The body is emitted synchronously right after the handler registers its
   * `data`/`end` listeners, so two back-to-back calls both parse their body before
   * either continuation runs — that is what proves the busy claim is synchronous.
   */
  const post = (
    body: unknown,
    raw?: string,
    headers: Record<string, string> = {}
  ): { res: any; done: Promise<void> } => {
    const req = new EventEmitter() as any;
    req.url = '/v1/images/generations';
    req.method = 'POST';
    req.headers = headers;
    const res = createRes();
    const done = Promise.resolve(requestHandler(req, res)) as Promise<void>;
    req.emit('data', Buffer.from(raw ?? JSON.stringify(body)));
    req.emit('end');
    return { res, done };
  };

  const registryOf = (server: Manager): any => (server as any).registry;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetSdServerMocks();
    mockBinaryConfigs.length = 0;

    mockLogInitialize.mockResolvedValue(undefined);
    mockLogWrite.mockResolvedValue(undefined);
    mockLogGetRecent.mockResolvedValue([]);
    mockLogClear.mockResolvedValue(undefined);
    mockEnsureBinary.mockResolvedValue('/test/binaries/diffusion/sd-server');
    mockCreateServer.mockReturnValue(mockHttpServer);
    resetHttpServerMocks();
    mockEnsureDirectory.mockResolvedValue(undefined);

    diffusionServer = new DiffusionServerManager(mockModelManager as any, mockSystemInfo as any);

    mockModelManager.getModelInfo.mockResolvedValue(mockModelInfo);
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
    mockIsServerResponding.mockResolvedValue(false);
    mockIsPortBindable.mockResolvedValue(true);
    mockFindFreePort.mockResolvedValue(49999);

    await diffusionServer.start(mockConfig);
    requestHandler = mockCreateServer.mock.calls[0]![0] as RequestHandler;
  });

  afterEach(() => {
    // Any generation left in flight owns a poll loop; killing its backend makes that
    // loop reject on its next turn instead of polling into the following test
    for (const handle of handles) handle.emitExit({ code: 0, signal: null });
    diffusionServer.removeAllListeners();
    mockHttpServer.removeAllListeners();
  });

  /** Stop and restart the wrapper with a different config; rebinds `requestHandler`. */
  const restartWith = async (config: DiffusionServerConfig): Promise<void> => {
    await diffusionServer.stop();
    // The mocked close() never drops the 'error' listener listen() attached
    mockHttpServer.removeAllListeners('error');
    await diffusionServer.start(config);
    requestHandler = mockCreateServer.mock.calls.at(-1)![0] as RequestHandler;
  };

  const corsHeadersOf = (res: any): string[] =>
    (res.setHeader.mock.calls as [string, string][])
      .map(([name]) => name)
      .filter((name) => name.startsWith('Access-Control-'));

  describe('CORS (opt-in through allowedOrigins)', () => {
    it('sends no Access-Control headers by default, even to a browser Origin', async () => {
      const { res, done } = request('/health', 'GET', { origin: 'https://evil.example' });
      await done;

      expect(corsHeadersOf(res)).toEqual([]);
      // The response still varies with Origin (it would, once an allowlist is set)
      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
      expect(statusOf(res)).toBe(200);
    });

    it('still answers a preflight with a bare 200, without CORS headers', async () => {
      const { res, done } = request('/v1/images/generations', 'OPTIONS', {
        origin: 'https://evil.example',
      });
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(200);
      expect(res.end).toHaveBeenCalledWith();
      expect(corsHeadersOf(res)).toEqual([]);
    });

    it('echoes an exactly-listed Origin with the full CORS header set', async () => {
      await restartWith({ ...mockConfig, allowedOrigins: ['http://localhost:5173'] });

      const { res, done } = request('/health', 'GET', { origin: 'http://localhost:5173' });
      await done;

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'http://localhost:5173'
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS, DELETE'
      );
      expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'Content-Type');
    });

    it('ignores an Origin that is not listed (exact match, no prefix or wildcard logic)', async () => {
      await restartWith({ ...mockConfig, allowedOrigins: ['http://localhost:5173'] });

      const { res, done } = request('/health', 'GET', { origin: 'http://localhost:5174' });
      await done;

      expect(corsHeadersOf(res)).toEqual([]);
      expect(statusOf(res)).toBe(200);
    });

    it("restores the unconditional wildcard with allowedOrigins: ['*'], Origin or not", async () => {
      await restartWith({ ...mockConfig, allowedOrigins: ['*'] });

      const withOrigin = request('/health', 'GET', { origin: 'https://anything.example' });
      await withOrigin.done;
      const withoutOrigin = request('/health', 'GET');
      await withoutOrigin.done;

      expect(withOrigin.res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(withoutOrigin.res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });
  });

  describe('Host guard (loopback binds only)', () => {
    it.each(['localhost', 'localhost:8081', '127.0.0.1:8081', '[::1]:8081', 'app.localhost'])(
      'accepts Host %s on the default loopback bind',
      async (host) => {
        const { res, done } = request('/health', 'GET', { host });
        await done;

        expect(statusOf(res)).toBe(200);
      }
    );

    it('accepts a request without a Host header', async () => {
      const { res, done } = request('/health', 'GET');
      await done;

      expect(statusOf(res)).toBe(200);
    });

    it('rejects a DNS name that could have been rebound with 403 INVALID_HOST', async () => {
      const { res, done } = request('/health', 'GET', { host: 'attacker.example:8081' });
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
      const body = bodyOf(res);
      expect(body.error.code).toBe('INVALID_HOST');
      expect(body.error.message).toContain('attacker.example:8081');
    });

    it('guards POST and DELETE too, before any route logic runs', async () => {
      const { res, done } = request('/v1/images/generations/some-id', 'DELETE', {
        host: 'attacker.example',
      });
      await done;

      expect(statusOf(res)).toBe(403);
      expect(bodyOf(res).error.code).toBe('INVALID_HOST');
    });

    it('does not guard a deliberately widened bind', async () => {
      await restartWith({ ...mockConfig, host: '0.0.0.0' });

      const { res, done } = request('/health', 'GET', { host: 'my-workstation.lan:8081' });
      await done;

      expect(statusOf(res)).toBe(200);
    });

    it.each([
      '127.0.0.1.attacker.example',
      'localhost.attacker.example',
      '[::1]:abc',
      'localhost:8081:8081',
      'attacker.example:8081:8081',
    ])('rejects the suffix/format confusion %s', async (host) => {
      const { res, done } = request('/health', 'GET', { host });
      await done;

      expect(statusOf(res)).toBe(403);
      expect(bodyOf(res).error.code).toBe('INVALID_HOST');
    });

    it('treats an empty Host header like an absent one', async () => {
      const { res, done } = request('/health', 'GET', { host: '' });
      await done;

      expect(statusOf(res)).toBe(200);
    });
  });

  describe('cross-origin writes (INVALID_ORIGIN)', () => {
    it('refuses a POST carrying an Origin the allowlist does not cover', async () => {
      // A "simple" cross-origin POST needs no preflight, so CORS alone would not stop it
      const { res, done } = post({ prompt: 'x' }, undefined, { origin: 'https://evil.example' });
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
      expect(bodyOf(res).error.code).toBe('INVALID_ORIGIN');
      expect(corsHeadersOf(res)).toEqual([]);
      // Nothing was claimed: the gate is still free
      expect(diffusionServer.getActiveGenerationId()).toBeUndefined();
    });

    it('refuses a DELETE from a disallowed Origin before any route logic runs', async () => {
      const { res, done } = request('/v1/images/generations/some-id', 'DELETE', {
        origin: 'https://evil.example',
      });
      await done;

      expect(statusOf(res)).toBe(403);
      expect(bodyOf(res).error.code).toBe('INVALID_ORIGIN');
    });

    it('still answers a GET from a disallowed Origin (the browser withholds the body)', async () => {
      const { res, done } = request('/health', 'GET', { origin: 'https://evil.example' });
      await done;

      expect(statusOf(res)).toBe(200);
      expect(corsHeadersOf(res)).toEqual([]);
    });

    it('accepts a POST from a listed Origin', async () => {
      await restartWith({ ...mockConfig, allowedOrigins: ['http://localhost:5173'] });

      const { res, done } = post({ prompt: 'x' }, undefined, { origin: 'http://localhost:5173' });
      await done;

      expect(statusOf(res)).toBe(201);
    });

    it("accepts a POST from any Origin under ['*']", async () => {
      await restartWith({ ...mockConfig, allowedOrigins: ['*'] });

      const { res, done } = post({ prompt: 'x' }, undefined, {
        origin: 'https://anything.example',
      });
      await done;

      expect(statusOf(res)).toBe(201);
    });

    it('never touches a request without an Origin (genai-lite, Electron main, curl)', async () => {
      const { res, done } = post({ prompt: 'x' });
      await done;

      expect(statusOf(res)).toBe(201);
    });
  });

  describe('fallbacks', () => {
    it('returns the NOT_FOUND envelope for unknown routes', async () => {
      const { res, done } = request('/nope', 'GET');
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(bodyOf(res)).toEqual({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    });
  });

  describe('GET /health', () => {
    it('reports status/busy/backend and follows the backend state', async () => {
      const before = request('/health', 'GET');
      await before.done;

      expect(before.res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(bodyOf(before.res)).toEqual({ status: 'ok', busy: false, backend: 'absent' });

      await diffusionServer.executeImageGeneration({ prompt: 'a lighthouse' });

      const after = request('/health', 'GET');
      await after.done;
      expect(bodyOf(after.res)).toEqual({ status: 'ok', busy: false, backend: 'ready' });
    });

    it('reports busy while a generation holds the gate', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'a lighthouse' });
      await started.done;

      const { res, done } = request('/health', 'GET');
      await done;
      expect(bodyOf(res)).toMatchObject({ status: 'ok', busy: true });
    });
  });

  describe('POST /v1/images/generations', () => {
    it('returns 201 with {id, status, createdAt}', async () => {
      const { res, done } = post({ prompt: 'a lighthouse' });
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' });
      const body = bodyOf(res);
      expect(body.status).toBe('pending');
      expect(typeof body.id).toBe('string');
      expect(body.id.length).toBeGreaterThan(0);
      expect(typeof body.createdAt).toBe('number');
      await flush();
    });

    it('rejects a missing prompt with 400 INVALID_REQUEST', async () => {
      const { res, done } = post({ width: 512 });
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(bodyOf(res)).toEqual({
        error: { message: 'Missing required field: prompt', code: 'INVALID_REQUEST' },
      });
    });

    it.each([0, 6])('rejects count=%s with 400 INVALID_REQUEST', async (count) => {
      const { res, done } = post({ prompt: 'x', count });
      await done;

      expect(statusOf(res)).toBe(400);
      expect(bodyOf(res)).toEqual({
        error: { message: 'count must be between 1 and 5', code: 'INVALID_REQUEST' },
      });
    });

    it('rejects an unknown usageMode with 400 INVALID_REQUEST', async () => {
      const { res, done } = post({ prompt: 'x', usageMode: 'always' });
      await done;

      expect(statusOf(res)).toBe(400);
      expect(bodyOf(res)).toEqual({
        error: { message: "usageMode must be 'burst' or 'single'", code: 'INVALID_REQUEST' },
      });
      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
    });

    it('accepts a valid usageMode', async () => {
      const { res, done } = post({ prompt: 'x', usageMode: 'single' });
      await done;

      expect(statusOf(res)).toBe(201);
      await flush();
    });

    it('rejects a malformed JSON body with 400 INVALID_REQUEST', async () => {
      const { res, done } = post(undefined, '{ not json');
      await done;

      expect(statusOf(res)).toBe(400);
      expect(bodyOf(res)).toEqual({
        error: { message: 'Malformed JSON request body', code: 'INVALID_REQUEST' },
      });
      expect(mockStartSdServerRunner).not.toHaveBeenCalled();
    });

    it('answers a second concurrent POST with 503 SERVER_BUSY (synchronous claim)', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      // Both bodies are parsed before either handler continuation runs, so only the
      // synchronous claim installed by the first one can keep the second out.
      const first = post({ prompt: 'first' });
      const second = post({ prompt: 'second' });
      await Promise.all([first.done, second.done]);

      expect(statusOf(first.res)).toBe(201);
      expect(statusOf(second.res)).toBe(503);
      expect(bodyOf(second.res)).toEqual({
        error: {
          message: 'Server is busy generating another image',
          code: 'SERVER_BUSY',
          suggestion: 'Wait for current generation to complete and try again',
        },
      });
      // Only one generation ever reached the backend
      await flush();
      expect(mockStartSdServerRunner).toHaveBeenCalledTimes(1);
    });

    it('refuses with 503 SERVER_NOT_RUNNING once the wrapper is stopping', async () => {
      (diffusionServer as any)._status = 'stopping';

      const { res, done } = post({ prompt: 'x' });
      await done;

      expect(statusOf(res)).toBe(503);
      expect(bodyOf(res)).toEqual({
        error: {
          message: 'Server is not running',
          code: 'SERVER_NOT_RUNNING',
          suggestion: 'Start the server first with start()',
        },
      });
      (diffusionServer as any)._status = 'running';
    });
  });

  describe('GET /v1/images/generations/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const { res, done } = request('/v1/images/generations/missing', 'GET');
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(bodyOf(res)).toEqual({
        error: { message: 'Generation not found', code: 'NOT_FOUND' },
      });
    });

    it('reports a freshly registered generation as pending', async () => {
      const id = registryOf(diffusionServer).create({ prompt: 'x' });

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(statusOf(res)).toBe(200);
      expect(body.id).toBe(id);
      expect(body.status).toBe('pending');
      expect(typeof body.createdAt).toBe('number');
      expect(typeof body.updatedAt).toBe('number');
      expect(body.progress).toBeUndefined();
      expect(body.result).toBeUndefined();
      expect(body.error).toBeUndefined();
    });

    it('reports in_progress with the adapter-visible progress block', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x', steps: 4 });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      handles[0]!.launch.onStdoutEvent({ type: 'step', step: 2, steps: 4 });

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('in_progress');
      expect(body.progress).toMatchObject({
        currentStep: 2,
        totalSteps: 4,
        stage: 'diffusion',
      });
      expect(typeof body.progress.percentage).toBe('number');
      expect(body.progress.currentImage).toBeUndefined();
      expect(body.progress.totalImages).toBeUndefined();
    });

    it('carries batch counters in progress when count > 1', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x', steps: 4, count: 3 });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      handles[0]!.launch.onStdoutEvent({ type: 'step', step: 1, steps: 4 });

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('in_progress');
      expect(body.progress.totalImages).toBe(3);
      expect(body.progress.currentImage).toBeGreaterThanOrEqual(1);
      expect(body.progress.currentImage).toBeLessThanOrEqual(3);
    });

    it('returns the complete payload genai-lite decodes', async () => {
      const started = post({ prompt: 'x', width: 768, height: 512, seed: 99 });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush(5);

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('complete');
      expect(body.result.format).toBe('png');
      expect(typeof body.result.timeTaken).toBe('number');
      expect(body.result.images).toHaveLength(1);
      const image = body.result.images[0];
      // Raw base64 — no data: URI prefix (the adapter prepends its own)
      expect(image.image).toBe('aW1hZ2U=');
      expect(image.image.startsWith('data:')).toBe(false);
      expect(Buffer.from(image.image, 'base64').toString()).toBe('image');
      expect(image.seed).toBe(99);
      expect(image.width).toBe(768);
      expect(image.height).toBe(512);
      expect(body.error).toBeUndefined();
    });

    it('maps a failed backend job onto BACKEND_ERROR', async () => {
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'failed',
        error: { message: 'ggml_cuda: out of memory' },
      }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush(5);

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('BACKEND_ERROR');
      expect(body.error.message).toContain('job failed');
      expect(body.result).toBeUndefined();
    });

    it('maps a backend process exit onto BACKEND_ERROR', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      handles[0]!.stderrTail = 'CUDA error: out of memory';
      handles[0]!.emitExit({ code: 1, signal: null });
      await flush(5);

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('BACKEND_ERROR');
      expect(body.error.message).toContain('exited with code 1');
    });

    it('maps an undecodable image payload onto IO_ERROR', async () => {
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'completed',
        result: { output_format: 'png', images: [{ index: 0, b64_json: '' }] },
      }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush(5);

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('IO_ERROR');
      expect(body.error.message).toContain('Failed to decode generated image');
    });

    it('reports a cancelled generation with neither result nor error', async () => {
      const registry = registryOf(diffusionServer);
      const id = registry.create({ prompt: 'x' });
      registry.update(id, { status: 'cancelled' });

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;

      const body = bodyOf(res);
      expect(body.status).toBe('cancelled');
      expect(body.result).toBeUndefined();
      expect(body.error).toBeUndefined();
    });
  });

  describe('DELETE /v1/images/generations/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const { res, done } = request('/v1/images/generations/missing', 'DELETE');
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(bodyOf(res)).toEqual({
        error: { message: 'Generation not found', code: 'NOT_FOUND' },
      });
    });

    it.each(['complete', 'error'])(
      'returns 409 ALREADY_TERMINAL for a %s generation',
      async (status) => {
        const registry = registryOf(diffusionServer);
        const id = registry.create({ prompt: 'x' });
        registry.update(id, { status });

        const { res, done } = request(`/v1/images/generations/${id}`, 'DELETE');
        await done;

        expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
        expect(bodyOf(res)).toEqual({
          error: {
            message: `Generation is already ${status} and cannot be cancelled`,
            code: 'ALREADY_TERMINAL',
          },
        });
      }
    );

    it('is idempotent for an already-cancelled generation', async () => {
      const registry = registryOf(diffusionServer);
      const id = registry.create({ prompt: 'x' });
      registry.update(id, { status: 'cancelled' });

      const { res, done } = request(`/v1/images/generations/${id}`, 'DELETE');
      await done;

      expect(statusOf(res)).toBe(200);
      expect(bodyOf(res)).toEqual({ id, status: 'cancelled' });
    });

    it('answers 200 without waiting for the backend to die', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      // The kill never confirms until the test releases it
      let confirmDeath!: () => void;
      handles[0]!.stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            confirmDeath = () => {
              handles[0]!.emitExit({ code: null, signal: 'SIGTERM' });
              resolve();
            };
          })
      );

      const { res, done } = request(`/v1/images/generations/${id}`, 'DELETE');
      await done;

      expect(statusOf(res)).toBe(200);
      expect(bodyOf(res)).toEqual({ id, status: 'cancelled' });
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      // Still dying while the client already has its answer
      expect(diffusionServer.getBackendInfo().state).toBe('stopping');
      expect(registryOf(diffusionServer).get(id).status).toBe('cancelled');

      confirmDeath();
      await flush();
      expect(diffusionServer.getBackendInfo().state).toBe('absent');
    });

    it('cancels a still-queued job through the backend API instead of killing it', async () => {
      mockGetJob.mockImplementation(async () => ({
        id: 'job-1',
        status: 'queued',
        queue_position: 1,
      }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      const { res, done } = request(`/v1/images/generations/${id}`, 'DELETE');
      await done;
      await flush();

      expect(statusOf(res)).toBe(200);
      expect(mockCancelJob).toHaveBeenCalledWith('job-1');
      expect(handles[0]!.stop).not.toHaveBeenCalled();

      // Let the orphaned poll loop terminate
      mockGetJob.mockResolvedValue({ id: 'job-1', status: 'cancelled' });
      await flush();
    });

    it('never lets the failed generation overwrite the cancellation', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      const { done } = request(`/v1/images/generations/${id}`, 'DELETE');
      await done;
      await flush(5);

      expect(registryOf(diffusionServer).get(id).status).toBe('cancelled');
      expect(registryOf(diffusionServer).get(id).error).toBeUndefined();

      const get = request(`/v1/images/generations/${id}`, 'GET');
      await get.done;
      expect(bodyOf(get.res).status).toBe('cancelled');
    });
  });

  describe('error envelope', () => {
    it('answers 500 INTERNAL_ERROR when a route handler throws', async () => {
      registryOf(diffusionServer).get = (): never => {
        throw new Error('registry exploded');
      };

      const { res, done } = request('/v1/images/generations/some-id', 'GET');
      await done;

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      expect(bodyOf(res)).toEqual({
        error: { message: 'registry exploded', code: 'INTERNAL_ERROR' },
      });
    });
  });

  describe('wire error codes', () => {
    /**
     * Every message below is chosen so NO substring fallback in mapErrorCode could
     * match it — the mapping under test is the `details.code` one.
     */
    const cases: {
      name: string;
      install: (server: Manager) => void;
      expected: string;
    }[] = [
      {
        name: 'a request the backend rejected (400)',
        install: () =>
          mockSubmitImageJob.mockRejectedValue(
            new ServerError('sd-server rejected the job request: unsupported sampler', {
              code: 'BACKEND_BAD_REQUEST',
              status: 400,
            })
          ),
        expected: 'BACKEND_ERROR',
      },
      {
        name: 'a job that expired out of the backend cache (410)',
        install: () =>
          mockGetJob.mockRejectedValue(
            new ServerError('sd-server job job-1 expired before it was retrieved', {
              code: 'BACKEND_JOB_EXPIRED',
              status: 410,
            })
          ),
        expected: 'BACKEND_ERROR',
      },
      {
        name: 'a submit that timed out',
        install: () =>
          mockSubmitImageJob.mockRejectedValue(
            new ServerError('sd-server /sdcpp/v1/img_gen timed out', {
              code: 'BACKEND_REQUEST_TIMEOUT',
              timeoutMs: 5000,
            })
          ),
        expected: 'BACKEND_ERROR',
      },
      {
        name: 'a backend that never became ready',
        install: () => mockStartSdServerRunner.mockRejectedValue(sdServerReadyTimeoutError()),
        expected: 'BACKEND_ERROR',
      },
      {
        name: 'a prior termination that was never confirmed',
        install: (server) => {
          (server as any).unconfirmedBackendPid = 4242;
          (server as any).isProcessAlive = (): boolean => true;
        },
        expected: 'BACKEND_ERROR',
      },
    ];

    it.each(cases)('maps $name onto $expected', async ({ install, expected }) => {
      install(diffusionServer);

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush(6);

      const { res, done } = request(`/v1/images/generations/${id}`, 'GET');
      await done;
      const body = bodyOf(res);
      expect(body.status).toBe('error');
      expect(body.error.code).toBe(expected);
    });

    it('reports a generation cancelled by stop() as cancelled, never as an error', async () => {
      mockGetJob.mockImplementation(async () => ({ id: 'job-1', status: 'generating' }));

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      // stop() cancels the in-flight generation without going through
      // cancelImageGeneration(), so runAsyncGeneration owns the classification
      await diffusionServer.stop();
      await flush(6);

      const state = registryOf(diffusionServer).get(id);
      expect(state.status).toBe('cancelled');
      expect(state.error).toBeUndefined();
      expect(state.result).toBeUndefined();
    });

    it('reports a generation cancelled during the backend spawn as cancelled', async () => {
      // stop() aborts the spawn; the failure the generation sees is the aborted
      // startup, but the caller asked to cancel — the registry must say so
      mockStartSdServerRunner.mockImplementation(async (options: any) => {
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new ServerError('sd-server startup aborted', { code: 'SD_SERVER_START_ABORTED' })
              ),
            { once: true }
          );
        });
        throw new Error('unreachable');
      });

      const started = post({ prompt: 'x' });
      await started.done;
      const id = bodyOf(started.res).id as string;
      await flush();

      await diffusionServer.stop();
      await flush(6);

      const state = registryOf(diffusionServer).get(id);
      expect(state.status).toBe('cancelled');
      expect(state.error).toBeUndefined();
    });

    it('maps an unknown generation id onto NOT_FOUND', () => {
      const error = new ServerError('Generation not found: abc', {
        code: 'GENERATION_NOT_FOUND',
      });

      expect((diffusionServer as any).mapErrorCode(error)).toBe('NOT_FOUND');
    });
  });
});
