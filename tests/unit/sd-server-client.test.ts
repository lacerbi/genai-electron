import { jest } from '@jest/globals';

import {
  SdServerClient,
  buildSdServerImageRequest,
  type SdServerImageRequest,
} from '../../src/process/sd-server-client.js';
import type { ImageGenerationConfig } from '../../src/types/index.js';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(...responses: Response[]) {
  const spy = jest.spyOn(globalThis, 'fetch');
  for (const response of responses) spy.mockResolvedValueOnce(response);
  return spy;
}

describe('buildSdServerImageRequest', () => {
  it('maps every supported field onto the nested sd-server schema', () => {
    const config: ImageGenerationConfig & { seed: number } = {
      prompt: 'a lighthouse on a rocky coast',
      negativePrompt: 'blurry, watermark',
      width: 768,
      height: 512,
      steps: 4,
      cfgScale: 1,
      sampler: 'euler',
      seed: 42,
    };

    const body = buildSdServerImageRequest(config, 3);

    expect(body).toEqual({
      prompt: 'a lighthouse on a rocky coast',
      negative_prompt: 'blurry, watermark',
      width: 768,
      height: 512,
      seed: 42,
      batch_count: 3,
      sample_params: {
        sample_steps: 4,
        sample_method: 'euler',
        guidance: { txt_cfg: 1 },
      },
    } satisfies SdServerImageRequest);
  });

  it('omits keys whose source value is undefined so sd.cpp defaults apply', () => {
    const body = buildSdServerImageRequest({ prompt: 'minimal', seed: 7 });

    expect(body).toEqual({
      prompt: 'minimal',
      seed: 7,
      batch_count: 1,
      sample_params: { guidance: {} },
    });
    for (const key of ['negative_prompt', 'width', 'height'] as const) {
      expect(body).not.toHaveProperty(key);
    }
    for (const key of ['sample_steps', 'sample_method'] as const) {
      expect(body.sample_params).not.toHaveProperty(key);
    }
    expect(body.sample_params.guidance).not.toHaveProperty('txt_cfg');
    // JSON must not carry the omitted keys either (sd.cpp would read an explicit null).
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it('keeps falsy-but-meaningful values and defaults batch_count to 1', () => {
    const body = buildSdServerImageRequest({
      prompt: 'zero-ish',
      negativePrompt: '',
      cfgScale: 0,
      steps: 0,
      seed: 0,
    });

    expect(body.batch_count).toBe(1);
    expect(body.seed).toBe(0);
    expect(body.negative_prompt).toBe('');
    expect(body.sample_params.sample_steps).toBe(0);
    expect(body.sample_params.guidance.txt_cfg).toBe(0);
  });
});

describe('SdServerClient', () => {
  const client = new SdServerClient(12_345);
  const body = buildSdServerImageRequest({ prompt: 'a lighthouse', seed: 42 });

  it('submits a job to the native endpoint and returns the job id', async () => {
    const fetchSpy = mockFetch(json({ id: 'job-1' }, 202));

    await expect(client.submitImageJob(body)).resolves.toEqual({ id: 'job-1' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/sdcpp/v1/img_gen',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) })
    );
  });

  it('formats IPv6 hosts and honours a custom host', async () => {
    const fetchSpy = mockFetch(json({ id: 'job-6' }, 202));
    const ipv6 = new SdServerClient(9_000, '::1');

    await expect(ipv6.submitImageJob(body)).resolves.toEqual({ id: 'job-6' });
    expect(fetchSpy).toHaveBeenCalledWith('http://[::1]:9000/sdcpp/v1/img_gen', expect.any(Object));
  });

  it('maps a full backend queue to BACKEND_QUEUE_FULL', async () => {
    mockFetch(json({ message: 'queue full' }, 429));

    await expect(client.submitImageJob(body)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_QUEUE_FULL', status: 429 }),
    });
  });

  it('forwards the backend message for a rejected request body', async () => {
    mockFetch(json({ error: { message: 'width must be a multiple of 64' } }, 400));

    await expect(client.submitImageJob(body)).rejects.toMatchObject({
      message: expect.stringContaining('width must be a multiple of 64'),
      details: expect.objectContaining({
        code: 'BACKEND_BAD_REQUEST',
        status: 400,
        backendMessage: 'width must be a multiple of 64',
      }),
    });
  });

  it('maps any other non-2xx submit status to BACKEND_HTTP_ERROR with the status', async () => {
    mockFetch(json({}, 503));

    await expect(client.submitImageJob(body)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_HTTP_ERROR', status: 503 }),
    });
  });

  it('rejects an accepted submit that carries no job id', async () => {
    mockFetch(json({ ok: true }, 202));

    await expect(client.submitImageJob(body)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_INVALID_RESPONSE' }),
    });
  });

  it('reads a completed job with its base64 images', async () => {
    const fetchSpy = mockFetch(
      json(
        {
          id: 'job-1',
          kind: 'img_gen',
          status: 'completed',
          created: 1,
          started: 2,
          completed: 3,
          result: { output_format: 'png', images: [{ index: 0, b64_json: 'AAAA' }] },
          error: null,
        },
        200
      )
    );

    await expect(client.getJob('job-1')).resolves.toEqual({
      id: 'job-1',
      kind: 'img_gen',
      status: 'completed',
      created: 1,
      started: 2,
      completed: 3,
      result: { output_format: 'png', images: [{ index: 0, b64_json: 'AAAA' }] },
      error: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/sdcpp/v1/jobs/job-1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('reads a queued job with its queue position and a failed job with its error', async () => {
    mockFetch(json({ id: 'job-2', status: 'queued', queue_position: 3 }, 200));
    await expect(client.getJob('job-2')).resolves.toMatchObject({
      status: 'queued',
      queue_position: 3,
    });

    mockFetch(
      json({ id: 'job-3', status: 'failed', error: { code: 'oom', message: 'out of memory' } }, 200)
    );
    await expect(client.getJob('job-3')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'oom', message: 'out of memory' },
    });
  });

  it.each([
    [404, 'BACKEND_JOB_NOT_FOUND'],
    [410, 'BACKEND_JOB_EXPIRED'],
    [500, 'BACKEND_HTTP_ERROR'],
  ])('maps job status %s to %s', async (status, code) => {
    mockFetch(json({}, status));

    await expect(client.getJob('job-x')).rejects.toMatchObject({
      details: expect.objectContaining({ code, status }),
    });
  });

  it('rejects a job record with an unknown status', async () => {
    mockFetch(json({ id: 'job-4', status: 'thinking' }, 200));

    await expect(client.getJob('job-4')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_INVALID_RESPONSE' }),
    });
  });

  it('reports an accepted cancellation', async () => {
    const fetchSpy = mockFetch(json({ cancelled: true }, 200));

    await expect(client.cancelJob('job-1')).resolves.toEqual({ cancelled: true, httpStatus: 200 });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/sdcpp/v1/jobs/job-1/cancel',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([409, 404, 410])(
    'reports a refused cancellation (%s) without throwing',
    async (status) => {
      mockFetch(json({}, status));

      await expect(client.cancelJob('job-1')).resolves.toEqual({
        cancelled: false,
        httpStatus: status,
      });
    }
  );

  it('throws for an unexpected cancel status', async () => {
    mockFetch(json({}, 500));

    await expect(client.cancelJob('job-1')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_HTTP_ERROR', status: 500 }),
    });
  });

  it('returns the capabilities document and rejects a non-200 probe', async () => {
    const fetchSpy = mockFetch(json({ backends: ['cuda'] }, 200));

    await expect(client.capabilities()).resolves.toEqual({ backends: ['cuda'] });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/sdcpp/v1/capabilities',
      expect.objectContaining({ method: 'GET' })
    );

    mockFetch(json({}, 500));
    await expect(client.capabilities()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_HTTP_ERROR', status: 500 }),
    });
  });

  it('bounds each request with its own timeout signal', async () => {
    let aborted = false;
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        })
    );
    const impatient = new SdServerClient(12_345, '127.0.0.1', 5);

    await expect(impatient.capabilities()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_REQUEST_TIMEOUT', timeoutMs: 5 }),
    });
    expect(aborted).toBe(true);
  });

  it('propagates a caller abort untouched and maps transport failures', async () => {
    const controller = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const pending = client.capabilities(controller.signal);
    controller.abort('caller went away');
    await expect(pending).rejects.toBe('caller went away');

    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.capabilities()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'BACKEND_REQUEST_FAILED' }),
    });
  });
});
