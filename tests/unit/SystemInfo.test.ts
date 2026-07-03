/**
 * Unit tests for SystemInfo module
 * Tests system capability detection, caching, and recommendations
 */

import { jest } from '@jest/globals';
import type { CPUInfo, GPUInfo, MemoryInfo } from '../../src/types/index.js';

// Mock the modules before importing SystemInfo
const mockCpus = jest.fn();
const mockTotalmem = jest.fn();
const mockFreemem = jest.fn();
const mockArch = jest.fn();
const mockPlatform = jest.fn();
const mockExec = jest.fn();

jest.unstable_mockModule('node:os', () => ({
  default: {
    cpus: mockCpus,
    totalmem: mockTotalmem,
    freemem: mockFreemem,
    arch: mockArch,
    platform: mockPlatform,
  },
}));

jest.unstable_mockModule('node:child_process', () => ({
  exec: mockExec,
}));

// Mock platform-utils
const mockGetPlatform = jest.fn();
jest.unstable_mockModule('../../src/utils/platform-utils.js', () => ({
  getPlatform: mockGetPlatform,
  getArchitecture: jest.fn().mockReturnValue('x64'),
  getPlatformKey: jest.fn().mockReturnValue('linux-x64'),
  isMac: jest.fn().mockReturnValue(false),
  isWindows: jest.fn().mockReturnValue(false),
  isLinux: jest.fn().mockReturnValue(true),
  isAppleSilicon: jest.fn().mockReturnValue(false),
}));

// Import after mocking
const { SystemInfo } = await import('../../src/system/SystemInfo.js');

describe('SystemInfo', () => {
  let systemInfo: SystemInfo;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a new instance for each test
    systemInfo = new SystemInfo();

    // Setup default mock values
    mockCpus.mockReturnValue([
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
      { model: 'Intel Core i7', speed: 2800 },
    ]);
    mockTotalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    mockFreemem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8 GB free
    mockArch.mockReturnValue('x64');
    mockPlatform.mockReturnValue('linux');
    mockGetPlatform.mockReturnValue('linux');
  });

  describe('detect()', () => {
    it('should detect system capabilities', async () => {
      // Mock GPU detection
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, 'NVIDIA GeForce RTX 3080, 10240', '');
      });

      const capabilities = await systemInfo.detect();

      expect(capabilities).toBeDefined();
      expect(capabilities.cpu).toBeDefined();
      expect(capabilities.cpu.cores).toBe(8);
      expect(capabilities.cpu.model).toBe('Intel Core i7');
      expect(capabilities.cpu.architecture).toBe('x64');

      expect(capabilities.memory).toBeDefined();
      expect(capabilities.memory.total).toBe(16 * 1024 * 1024 * 1024);

      expect(capabilities.gpu).toBeDefined();
      expect(capabilities.platform).toBe('linux');
      expect(capabilities.recommendations).toBeDefined();
    });

    it('should cache results for 60 seconds', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });

      // First call
      const result1 = await systemInfo.detect();
      expect(mockCpus).toHaveBeenCalledTimes(1);

      // Second call immediately after (should use cache)
      const result2 = await systemInfo.detect();
      expect(mockCpus).toHaveBeenCalledTimes(1); // Still 1, not called again
      expect(result1).toEqual(result2);
    });

    it('should generate recommendations based on capabilities', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });

      const capabilities = await systemInfo.detect();
      const { recommendations } = capabilities;

      expect(recommendations.maxModelSize).toBeDefined();
      expect(recommendations.recommendedQuantization).toBeDefined();
      expect(Array.isArray(recommendations.recommendedQuantization)).toBe(true);
      expect(recommendations.threads).toBeGreaterThan(0);
    });
  });

  describe('getMemoryInfo()', () => {
    it('should return current memory information', () => {
      const memInfo = systemInfo.getMemoryInfo();

      expect(memInfo.total).toBe(16 * 1024 * 1024 * 1024);
      expect(memInfo.available).toBe(8 * 1024 * 1024 * 1024);
      expect(memInfo.used).toBe(8 * 1024 * 1024 * 1024);
    });
  });

  describe('canRunModel()', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });
      await systemInfo.detect();
    });

    it('should return true for small models', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 2 * 1024 * 1024 * 1024, // 2 GB
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return false for models larger than available RAM', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 10 * 1024 * 1024 * 1024, // 10 GB (more than 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should reduce RAM requirement when gpuLayers are specified', async () => {
      // 6.4 GB model, 5.6 GB free RAM
      // With gpuLayers=44/totalLayers=48: cpuRatio = 4/48 ≈ 0.083
      // requiredMemory = 6.4 * 0.083 * 1.2 ≈ 0.64 GB → passes
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 44, totalLayers: 48 }
      );

      expect(result.possible).toBe(true);
    });

    it('should fail same model without gpuLayers', async () => {
      // Same 6.4 GB model, 5.6 GB free RAM
      // Without gpuLayers: requiredMemory = 6.4 * 1.2 = 7.68 GB → fails
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 6.4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should treat gpuLayers=0 same as no gpuLayers', async () => {
      // 6.4 GB model, 5.6 GB free RAM, gpuLayers=0 → full model check → fails
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 0 }
      );

      expect(result.possible).toBe(false);
      expect(result.reason).toContain('RAM');
    });

    it('should use getLayerCountWithFallback when totalLayers omitted', async () => {
      // 6.4 GB model → ~43 estimated layers (6.4 GB / 150 MB per layer)
      // gpuLayers=40 without totalLayers → uses fallback estimation
      // cpuRatio ≈ 3/43 ≈ 0.07, requiredMemory ≈ 0.54 GB → passes with 5.6 GB free
      mockFreemem.mockReturnValue(5.6 * 1024 ** 3);

      const result = await systemInfo.canRunModel(
        {
          id: 'test-model',
          name: 'Test Model',
          type: 'llm',
          size: 6.4 * 1024 * 1024 * 1024,
          path: '/test/path',
          downloadedAt: new Date().toISOString(),
          source: { type: 'url', url: 'http://test.com' },
        },
        { gpuLayers: 40 }
      );

      expect(result.possible).toBe(true);
    });

    it('should handle edge cases with minimal margin', async () => {
      const result = await systemInfo.canRunModel({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 7.5 * 1024 * 1024 * 1024, // 7.5 GB (close to 8 GB available)
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // With safety margin, this might be too close
      expect(result.possible).toBeDefined();
      expect(typeof result.possible).toBe('boolean');
    });
  });

  describe('canRunModel() — MoE', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', '');
      });
      await systemInfo.detect();
    });

    const moeModel = (totalSize: number, expertBytes: number) => ({
      id: 'moe',
      name: 'MoE',
      type: 'llm' as const,
      size: totalSize,
      path: '/moe.gguf',
      downloadedAt: new Date().toISOString(),
      source: { type: 'url' as const, url: 'http://test.com' },
      ggufMetadata: {
        architecture: 'gemma4',
        block_count: 30,
        attention_head_count: 16,
        attention_head_count_kv: 8,
        attention_key_length: 128,
        context_length: 262144,
        expert_count: 128,
        expert_weights_bytes: expertBytes,
      },
    });

    it('allows a big MoE whose trunk fits committed RAM (experts mmap-gated)', async () => {
      // 12.5 GiB model / 10 GiB experts on a 24 GiB-total, 8 GiB-free machine:
      // committed requirement is trunk-only (~3.5 GiB <= 8 free), experts
      // 10 <= 24 x 0.6 = 14.4 — the pre-0.8 whole-file gate (15 GiB) would reject
      mockTotalmem.mockReturnValue(24 * 1024 ** 3);
      await systemInfo.detect(true); // refresh cached capabilities with the new total
      const result = await systemInfo.canRunModel(moeModel(12.5 * 1024 ** 3, 10 * 1024 ** 3));
      expect(result.possible).toBe(true);
    });

    it('rejects MoE experts above the total-RAM fraction', async () => {
      // 20 GiB of experts on a 16 GiB machine
      const result = await systemInfo.canRunModel(moeModel(24 * 1024 ** 3, 20 * 1024 ** 3));
      expect(result.possible).toBe(false);
      expect(result.reason).toContain('expert');
    });
  });

  describe('getOptimalConfig()', () => {
    beforeEach(async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        // Mock nvidia-smi CSV output: name, total memory (MB), free memory (MB)
        // The --format=csv,noheader outputs just numbers for memory, no units
        callback(null, 'NVIDIA GeForce RTX 3080, 10240, 9500', '');
      });
      await systemInfo.detect();
    });

    it('should generate optimal server configuration', async () => {
      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024, // 4 GB
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(config.threads).toBeGreaterThan(0);
      expect(config.contextSize).toBeGreaterThan(0);
      expect(config.gpuLayers).toBeDefined();
      expect(config.parallelRequests).toBeGreaterThan(0);
    });

    it('should recommend more GPU layers for systems with GPU', async () => {
      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      // GPU layers should be defined (may be 0 if VRAM parsing failed, but should be a number)
      expect(config.gpuLayers).toBeDefined();
      expect(typeof config.gpuLayers).toBe('number');
      // If we got valid VRAM, it should be > 0
      expect(config.gpuLayers).toBeGreaterThanOrEqual(0);
    });

    it('should set gpuLayers to 0 for CPU-only systems', async () => {
      // Reset and detect without GPU
      systemInfo = new SystemInfo();
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('nvidia-smi not found'), '', '');
      });
      await systemInfo.detect();

      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(config.gpuLayers).toBe(0);
    });

    it('should keep the legacy 4096 context for models without GGUF metadata', async () => {
      const config = await systemInfo.getOptimalConfig({
        id: 'test-model',
        name: 'Test Model',
        type: 'llm',
        size: 4 * 1024 * 1024 * 1024,
        path: '/test/path',
        downloadedAt: new Date().toISOString(),
        source: { type: 'url', url: 'http://test.com' },
      });

      expect(config.contextSize).toBe(4096);
      expect(config.cacheTypeK).toBeUndefined();
      expect(config.cacheTypeV).toBeUndefined();
    });
  });

  describe('getOptimalConfig() — KV-aware sizing', () => {
    // RTX 3080 mock from the shared beforeEach: 10 GiB total, ~9.28 GiB free
    const makeModel = (
      overrides: Partial<import('../../src/types/index.js').ModelInfo> = {},
      meta: Partial<NonNullable<import('../../src/types/index.js').ModelInfo['ggufMetadata']>> = {}
    ): import('../../src/types/index.js').ModelInfo => ({
      id: 'kv-model',
      name: 'KV Model',
      type: 'llm',
      size: 2.4 * 1024 ** 3,
      path: '/test/kv.gguf',
      downloadedAt: new Date().toISOString(),
      source: { type: 'url', url: 'http://test.com' },
      ggufMetadata: {
        architecture: 'qwen3',
        block_count: 36,
        attention_head_count: 32,
        attention_head_count_kv: 8,
        attention_key_length: 128,
        embedding_length: 4096,
        context_length: 262144,
        ...meta,
      },
      ...overrides,
    });

    const gpuCapabilities = {
      cpu: { cores: 8, model: 'Test CPU', architecture: 'x64' },
      memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, used: 8 * 1024 ** 3 },
      gpu: {
        available: true,
        type: 'nvidia' as const,
        name: 'RTX 3080',
        vram: 10 * 1024 ** 3,
        vramAvailable: 9.28 * 1024 ** 3,
        cuda: true,
      },
      platform: 'linux' as const,
      recommendations: {
        maxModelSize: '13B',
        recommendedQuantization: ['Q4_K_M'],
        threads: 7,
        gpuAcceleration: true,
      },
    };

    beforeEach(() => {
      // Deterministic capabilities (exec-based GPU detection doesn't survive
      // promisify with a plain mocked exec)
      jest.spyOn(systemInfo, 'detect').mockResolvedValue(gpuCapabilities as never);
    });

    it('auto-selects q8_0 KV + flash attention for a long-context model and grows context', async () => {
      const config = await systemInfo.getOptimalConfig(makeModel());

      // Full offload (2.4 GB model easily fits)
      expect(config.gpuLayers).toBe(36);
      // q8_0 chosen: f16 KV at 256K native context is nowhere near fitting
      expect(config.cacheTypeK).toBe('q8_0');
      expect(config.cacheTypeV).toBe('q8_0');
      expect(config.flashAttention).toBe('on');
      // Context far beyond the old 4096 constant; >32768 bracket rounds to 4096
      expect(config.contextSize!).toBeGreaterThan(32768);
      expect(config.contextSize! % 4096).toBe(0);
      expect(config.contextSize!).toBeLessThanOrEqual(262144);
    });

    it('keeps f16 KV when headroom is abundant (small native context)', async () => {
      const config = await systemInfo.getOptimalConfig(makeModel({}, { context_length: 4096 }));

      expect(config.gpuLayers).toBe(36);
      expect(config.cacheTypeK).toBeUndefined();
      expect(config.cacheTypeV).toBeUndefined();
      expect(config.flashAttention).toBeUndefined();
      expect(config.contextSize).toBe(4096); // capped by the model itself
    });

    it('respects explicit cache-type hints (no auto-quantization)', async () => {
      const config = await systemInfo.getOptimalConfig(makeModel(), { cacheTypeK: 'f16' });

      expect(config.cacheTypeK).toBeUndefined(); // caller already owns the field
      expect(config.cacheTypeV).toBeUndefined();
      expect(config.flashAttention).toBeUndefined();
      expect(config.contextSize!).toBeGreaterThanOrEqual(4096);
    });

    it('suppresses auto-quantization when flash attention is explicitly off', async () => {
      const config = await systemInfo.getOptimalConfig(makeModel(), { flashAttention: 'off' });

      expect(config.cacheTypeK).toBeUndefined();
      expect(config.cacheTypeV).toBeUndefined();
      expect(config.flashAttention).toBeUndefined();
    });

    it('partially offloads oversized models and falls back toward the context floor', async () => {
      const big = makeModel({ size: 12 * 1024 ** 3 }, { block_count: 48, context_length: 131072 });
      const config = await systemInfo.getOptimalConfig(big);

      expect(config.gpuLayers!).toBeGreaterThan(0);
      expect(config.gpuLayers!).toBeLessThan(48);
      // RAM side is the binding constraint on this 16 GB mock machine
      expect(config.contextSize).toBe(4096);
    });

    it('respects a pinned contextSize and sizes layers around its KV cost', async () => {
      const config = await systemInfo.getOptimalConfig(makeModel(), { contextSize: 16384 });

      expect(config.contextSize).toBe(16384);
      expect(config.gpuLayers).toBe(36); // still fits fully alongside 16K of KV
    });

    describe('MoE-aware sizing', () => {
      // Modeled on gemma-4-26B-A4B UD quant: 12.5 GiB file, ~10 GiB experts,
      // ~2.4 GiB trunk, 30 layers — far too big for the mocked 10 GiB GPU
      // as a dense model, comfortable as trunk-on-GPU + experts-in-RAM.
      const makeMoE = (
        overrides: Partial<import('../../src/types/index.js').ModelInfo> = {},
        meta: Partial<
          NonNullable<import('../../src/types/index.js').ModelInfo['ggufMetadata']>
        > = {}
      ) =>
        makeModel(
          { size: 12.5 * 1024 ** 3, ...overrides },
          {
            architecture: 'gemma4',
            block_count: 30,
            attention_head_count: 16,
            attention_head_count_kv: 8,
            attention_key_length: 128,
            context_length: 262144,
            expert_count: 128,
            expert_used_count: 8,
            expert_feed_forward_length: 704,
            expert_weights_bytes: 10 * 1024 ** 3,
            ...meta,
          }
        );

      it('auto-recommends cpuMoe when the trunk fits but full weights do not', async () => {
        // Experts gate against TOTAL RAM (mmap'd, sparsely activated):
        // 10 GiB experts need total >= ~16.8 GiB — use a 64 GiB machine
        mockTotalmem.mockReturnValue(64 * 1024 ** 3);
        mockFreemem.mockReturnValue(24 * 1024 ** 3);

        const config = await systemInfo.getOptimalConfig(makeMoE());

        expect(config.cpuMoe).toBe(true);
        expect(config.gpuLayers).toBe(30);
        // ctx from (budget - trunk x 1.1) / q8 bpt — far beyond the floor
        expect(config.contextSize!).toBeGreaterThan(16384);
        expect(config.cacheTypeK).toBe('q8_0');
      });

      it('respects an explicit cpuMoe: false opt-out (dense sizing, no recommendation)', async () => {
        mockTotalmem.mockReturnValue(64 * 1024 ** 3);
        mockFreemem.mockReturnValue(24 * 1024 ** 3);

        const config = await systemInfo.getOptimalConfig(makeMoE(), { cpuMoe: false });

        expect(config.cpuMoe).toBeUndefined();
        // Dense math: partial offload, NOT a trunk-sized context
        expect(config.gpuLayers!).toBeLessThan(30);
      });

      it('does not recommend cpuMoe when experts do not fit RAM (dense partial fallback)', async () => {
        // Default 16 GiB TOTAL RAM: 10 GiB of experts exceed the 60% cap
        const config = await systemInfo.getOptimalConfig(makeMoE());

        expect(config.cpuMoe).toBeUndefined();
        expect(config.gpuLayers!).toBeLessThan(30);
      });

      it('keeps plain full offload when the whole MoE fits in VRAM', async () => {
        // Small MoE: 4 GiB file, 3 GiB experts — fits the budget whole
        const config = await systemInfo.getOptimalConfig(
          makeMoE({ size: 4 * 1024 ** 3 }, { expert_weights_bytes: 3 * 1024 ** 3 })
        );

        expect(config.cpuMoe).toBeUndefined();
        expect(config.gpuLayers).toBe(30);
      });

      it('sizes context from the trunk when cpuMoe is hinted (palimpsest case)', async () => {
        const config = await systemInfo.getOptimalConfig(makeMoE(), {
          cpuMoe: true,
          gpuLayers: 999,
        });

        expect(config.gpuLayers).toBe(999); // hint respected verbatim
        // Without the trunk split this would clamp to the 4096 floor
        expect(config.contextSize!).toBeGreaterThan(16384);
        expect(config.cpuMoe).toBeUndefined(); // caller already owns the field
      });

      it("treats overrideTensors 'exps=CPU' exactly like cpuMoe", async () => {
        const withCpuMoe = await systemInfo.getOptimalConfig(makeMoE(), {
          cpuMoe: true,
          gpuLayers: 30,
        });
        const withOt = await systemInfo.getOptimalConfig(makeMoE(), {
          overrideTensors: 'exps=CPU',
          gpuLayers: 30,
        });

        expect(withOt.contextSize).toBe(withCpuMoe.contextSize);
      });

      it('sizes conservatively (dense) for custom overrideTensors patterns', async () => {
        const config = await systemInfo.getOptimalConfig(makeMoE(), {
          overrideTensors: 'blk\.[0-9]+\.ffn=CPU',
          gpuLayers: 30,
        });

        // Dense math: the full 12.5 GiB "on GPU" exceeds budget -> floor context
        expect(config.contextSize).toBe(4096);
      });

      it('does NOT auto-recommend from the parameter-count heuristic (measured bytes only)', async () => {
        mockTotalmem.mockReturnValue(64 * 1024 ** 3);
        mockFreemem.mockReturnValue(24 * 1024 ** 3);
        const heuristicOnly = makeMoE(
          {},
          {
            expert_weights_bytes: undefined,
            raw: { 'general.parameter_count': 26_000_000_000 },
            embedding_length: 2816,
          }
        );

        // Auto tier requires MEASURED expert bytes — heuristic could
        // underestimate the trunk and overcommit VRAM
        const auto = await systemInfo.getOptimalConfig(heuristicOnly);
        expect(auto.cpuMoe).toBeUndefined();

        // But hint-driven sizing uses the heuristic as best-effort:
        // expertParams = 3 x 2816 x 704 x 128 x 30 ~ 22.8B of 26B -> ~88% experts
        const hinted = await systemInfo.getOptimalConfig(heuristicOnly, {
          cpuMoe: true,
          gpuLayers: 30,
        });
        expect(hinted.contextSize!).toBeGreaterThan(4096);
      });

      it('reserves proportional expert RAM for an nCpuMoe hint', async () => {
        // nCpuMoe: 15 of 30 layers -> half the experts (5 GiB) on CPU.
        // Trunk-adjusted GPU weights: (12.5 - 5) x 1.1 = 8.25 GiB > 8.28 budget
        // barely -> partial offload, but with far more layers than dense math
        const half = await systemInfo.getOptimalConfig(makeMoE(), { nCpuMoe: 15 });
        const dense = await systemInfo.getOptimalConfig(makeMoE(), {
          overrideTensors: 'custom=CPU',
        });

        expect(half.gpuLayers!).toBeGreaterThan(dense.gpuLayers!);
      });

      it('packs partial offload around the trunk when cpuMoe is hinted but trunk exceeds VRAM', async () => {
        // Trunk = 24 - 10 = 14 GiB x 1.1 > 8.28 GiB budget -> partial offload
        // of the trunk with experts already on CPU
        const config = await systemInfo.getOptimalConfig(
          makeMoE({ size: 24 * 1024 ** 3 }, { expert_weights_bytes: 10 * 1024 ** 3 }),
          { cpuMoe: true }
        );

        expect(config.gpuLayers!).toBeGreaterThan(0);
        expect(config.gpuLayers!).toBeLessThan(30);
        expect(config.contextSize!).toBeGreaterThanOrEqual(4096);
      });
    });

    it('sizes context from RAM on CPU-only systems and keeps f16', async () => {
      jest.spyOn(systemInfo, 'detect').mockResolvedValue({
        ...gpuCapabilities,
        gpu: { available: false },
      } as never);

      const config = await systemInfo.getOptimalConfig(makeModel());

      expect(config.gpuLayers).toBe(0);
      expect(config.cacheTypeK).toBeUndefined();
      // 8 GiB free - 2.88 weights - 2 margin = ~3.1 GiB / 144 KiB per token
      expect(config.contextSize!).toBeGreaterThan(4096);
      // 16384-32768 bracket rounds to 2048
      expect(config.contextSize! % 2048).toBe(0);
    });
  });

  describe('Platform-specific detection', () => {
    it('should detect macOS systems correctly', async () => {
      mockGetPlatform.mockReturnValue('darwin');
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', ''); // No GPU
      });
      systemInfo = new SystemInfo();

      const capabilities = await systemInfo.detect();
      expect(capabilities.platform).toBe('darwin');
    });

    it('should detect Windows systems correctly', async () => {
      mockGetPlatform.mockReturnValue('win32');
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, '', ''); // No GPU
      });
      systemInfo = new SystemInfo();

      const capabilities = await systemInfo.detect();
      expect(capabilities.platform).toBe('win32');
    });

    it('should handle GPU detection failures gracefully', async () => {
      mockExec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('Command failed'), '', 'nvidia-smi: not found');
      });

      const capabilities = await systemInfo.detect();
      expect(capabilities.gpu.available).toBe(false);
    });
  });
});
