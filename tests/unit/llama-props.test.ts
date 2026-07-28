import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fetchLlamaRuntimeCapacity } from '../../src/process/llama-props.js';

const originalFetch = global.fetch;
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

describe('fetchLlamaRuntimeCapacity', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('normalizes effective context and matching slots', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        default_generation_settings: { n_ctx: 12288 },
        total_slots: 2,
      }),
    } as Response);

    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 2)).resolves.toEqual({
      effectiveContextSize: 12288,
      totalSlots: 2,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/props',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('accepts responses that omit total_slots', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ default_generation_settings: { n_ctx: 4096 } }),
    } as Response);

    await expect(fetchLlamaRuntimeCapacity(8080, 'localhost', 1)).resolves.toEqual({
      effectiveContextSize: 4096,
      totalSlots: undefined,
    });
  });

  it('brackets IPv6 hosts in the request URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ default_generation_settings: { n_ctx: 4096 } }),
    } as Response);

    await fetchLlamaRuntimeCapacity(8080, '::1', 1);

    expect(mockFetch).toHaveBeenCalledWith('http://[::1]:8080/props', expect.any(Object));
  });

  it('rejects HTTP, JSON, and schema failures with a typed unavailable reason', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 1)).rejects.toMatchObject({
      code: 'CONTEXT_CONSTRAINT_ERROR',
      details: { reason: 'runtime-capacity-unavailable', stage: 'runtime' },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Response);
    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 1)).rejects.toMatchObject({
      details: { reason: 'runtime-capacity-unavailable' },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_generation_settings: { n_ctx: '4096' } }),
    } as Response);
    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 1)).rejects.toMatchObject({
      details: { reason: 'runtime-capacity-unavailable' },
    });
  });

  it('rejects a runtime slot mismatch with a dedicated reason', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        default_generation_settings: { n_ctx: 8192 },
        total_slots: 2,
      }),
    } as Response);

    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 1)).rejects.toMatchObject({
      code: 'CONTEXT_CONSTRAINT_ERROR',
      details: {
        reason: 'runtime-slots-mismatch',
        parallelRequests: 1,
        effectiveParallelRequests: 2,
      },
    });
  });

  it('normalizes aborts as unavailable runtime capacity', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    mockFetch.mockRejectedValue(abort);

    await expect(fetchLlamaRuntimeCapacity(8080, '127.0.0.1', 1, 25)).rejects.toMatchObject({
      details: {
        reason: 'runtime-capacity-unavailable',
        cause: 'Timed out after 25ms',
      },
    });
  });
});
