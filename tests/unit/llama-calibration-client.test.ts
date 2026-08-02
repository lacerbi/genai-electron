import { jest } from '@jest/globals';

import { LlamaCalibrationClient } from '../../src/process/llama-calibration-client.js';
import type { LlamaServerRunner } from '../../src/process/llama-server-runner.js';

function runner(): LlamaServerRunner {
  return {
    port: 12_345,
    raceWithExit: <T>(operation: Promise<T>) => operation,
  } as LlamaServerRunner;
}

describe('LlamaCalibrationClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts a fractional request timeout', async () => {
    // Adaptive completion caps are derived from performance.now() deltas, so they
    // are fractional. AbortSignal.timeout() rejects a non-integer delay, which
    // previously surfaced as a spurious operational `error` on a healthy probe
    // ("The value of \"delay\" is out of range... Received 30709.872999999963"),
    // consuming that point's ambiguity repeat and shifting its boundary.
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [1, 2, 3] })));
    const client = new LlamaCalibrationClient(runner(), 30_709.872999999963);

    await expect(client.tokenize('prompt')).resolves.toBe(3);
  });

  it('tokenizes, erases the controlled slot, and sends deterministic completions', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [1, 2, 3] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_slot: 0, n_erased: 12 })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tokens_evaluated: 569,
            tokens_predicted: 8,
            timings: {
              prompt_n: 519,
              prompt_ms: 20,
              prompt_per_second: 100,
              predicted_n: 8,
              predicted_ms: 10,
              predicted_per_second: 80,
            },
          })
        )
      );
    const client = new LlamaCalibrationClient(runner(), 1_000);

    await expect(client.tokenize('secret prompt')).resolves.toBe(3);
    await client.eraseSlot(0);
    const timing = await client.complete({
      prompt: 'secret prompt',
      nPredict: 8,
      seed: 42,
      slotId: 0,
      cachePrompt: true,
      requireCacheObservation: true,
    });

    expect(timing.cachedTokens).toBe(50);
    expect(fetchMock.mock.calls[1]![0]).toContain('/slots/0?action=erase');
    const completionBody = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string);
    expect(completionBody).toMatchObject({
      seed: 42,
      temperature: 0,
      top_k: 1,
      stream: false,
      ignore_eos: true,
      cache_prompt: true,
      id_slot: 0,
    });
  });

  it('accepts a legitimate zero cache hit but rejects an unobservable cache hit', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tokens_evaluated: 20,
            tokens_cached: 999,
            tokens_predicted: 2,
            timings: { cache_n: 0, prompt_n: 20, predicted_n: 2 },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tokens_predicted: 2,
            timings: { prompt_n: 20, predicted_n: 2 },
          })
        )
      );
    const client = new LlamaCalibrationClient(runner(), 1_000);
    const options = {
      prompt: 'prompt',
      nPredict: 2,
      seed: 42,
      slotId: 0,
      cachePrompt: true,
      requireCacheObservation: true,
    };

    await expect(client.complete(options)).resolves.toMatchObject({ cachedTokens: 0 });
    await expect(client.complete(options)).rejects.toThrow(/omitted observable prompt-cache/);
  });

  it('rejects malformed erase acknowledgements and inconsistent cache counts', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tokens_evaluated: 20,
            tokens_predicted: 2,
            timings: { prompt_n: 21, predicted_n: 2 },
          })
        )
      );
    const client = new LlamaCalibrationClient(runner(), 1_000);

    await expect(client.eraseSlot(0)).rejects.toThrow(/invalid acknowledgement/);
    await expect(
      client.complete({
        prompt: 'prompt',
        nPredict: 2,
        seed: 42,
        slotId: 0,
        cachePrompt: true,
        requireCacheObservation: true,
      })
    ).rejects.toThrow(/inconsistent prompt-cache counts/);
  });

  it('rejects a completion that returns fewer tokens than requested', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tokens_evaluated: 20,
          tokens_predicted: 1,
          timings: { prompt_n: 20, predicted_n: 1 },
        })
      )
    );
    const client = new LlamaCalibrationClient(runner(), 1_000);

    await expect(
      client.complete({
        prompt: 'prompt',
        nPredict: 2,
        seed: 42,
        slotId: 0,
        cachePrompt: false,
        requireCacheObservation: false,
      })
    ).rejects.toThrow(/incomplete prediction/);
  });

  it('classifies request timeout without including prompt content', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    });
    const client = new LlamaCalibrationClient(runner(), 5);

    let caught: unknown;
    try {
      await client.tokenize('PRIVATE-CONTENT');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_REQUEST_TIMEOUT' }),
    });
    expect(String(caught)).not.toContain('PRIVATE-CONTENT');
  });

  it('applies an explicit completion timeout without changing the control timeout', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/tokenize')) {
        return Promise.resolve(new Response(JSON.stringify({ tokens: [1, 2] })));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    });
    const client = new LlamaCalibrationClient(runner(), 1_000);

    let caught: unknown;
    try {
      await client.complete(
        {
          prompt: 'prompt',
          nPredict: 2,
          seed: 42,
          slotId: 0,
          cachePrompt: false,
          requireCacheObservation: false,
        },
        5
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      details: expect.objectContaining({
        code: 'CALIBRATION_REQUEST_TIMEOUT',
        path: '/completion',
        timeoutMs: 5,
      }),
    });
    await expect(client.tokenize('prompt')).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
