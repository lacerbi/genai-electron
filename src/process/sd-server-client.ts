/**
 * Typed HTTP client for the stable-diffusion.cpp `sd-server` native job API.
 *
 * Electron-free by construction (global `fetch`, no `config/paths.js`) so the same
 * module drives production generation, binary validation, and calibration.
 *
 * Endpoint shapes follow stable-diffusion.cpp `examples/server/api.md` at the pinned
 * commit `b290693` (`master-782-b290693`): `GET /sdcpp/v1/capabilities`,
 * `POST /sdcpp/v1/img_gen` (202 + `{id}`, 429 when the 64-deep queue is full),
 * `GET /sdcpp/v1/jobs/{id}` (410 once the ~10-minute result TTL expires), and
 * `POST /sdcpp/v1/jobs/{id}/cancel` (409 while the job is already generating).
 *
 * @module process/sd-server-client
 */

import { ServerError } from '../errors/index.js';
import type { ImageGenerationConfig, ImageSampler } from '../types/index.js';
import { formatHttpHost } from './health-check.js';

/**
 * `details.code` values carried by every {@link ServerError} this client throws.
 *
 * The top-level `ServerError.code` stays `'SERVER_ERROR'`; the discriminant lives in
 * `details.code` so callers can map a backend failure onto their own wire codes.
 */
export type SdServerClientErrorCode =
  /** 429 — the backend job queue is full */
  | 'BACKEND_QUEUE_FULL'
  /** 400 — the backend rejected the request body (message forwarded verbatim) */
  | 'BACKEND_BAD_REQUEST'
  /** 404 — the backend does not know this job id */
  | 'BACKEND_JOB_NOT_FOUND'
  /** 410 — the job result expired out of the backend's result cache */
  | 'BACKEND_JOB_EXPIRED'
  /** Any other non-2xx status; `details.status` carries it */
  | 'BACKEND_HTTP_ERROR'
  /** A 2xx response whose JSON body did not match the documented shape */
  | 'BACKEND_INVALID_RESPONSE'
  /** The per-request timeout elapsed */
  | 'BACKEND_REQUEST_TIMEOUT'
  /** Transport failure (connection refused, socket reset, ...) */
  | 'BACKEND_REQUEST_FAILED';

/** Default per-request timeout, in milliseconds. */
export const SD_SERVER_DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Guidance block of a `sd-server` image request.
 *
 * Keys are omitted rather than set to `undefined` so the backend applies its own
 * defaults, exactly as omitting a CLI flag did.
 */
export interface SdServerGuidanceParams {
  /** Text guidance scale (our `cfgScale`) */
  txt_cfg?: number;
}

/** Sampling block of a `sd-server` image request. */
export interface SdServerSampleParams {
  /** Inference steps (our `steps`) */
  sample_steps?: number;
  /** Sampler algorithm (our `sampler`) */
  sample_method?: ImageSampler;
  /** Guidance scales; always present, possibly empty */
  guidance: SdServerGuidanceParams;
}

/**
 * Request body for `POST /sdcpp/v1/img_gen`.
 *
 * @example
 * ```typescript
 * const body: SdServerImageRequest = {
 *   prompt: 'a lighthouse',
 *   seed: 42,
 *   batch_count: 1,
 *   sample_params: { sample_steps: 4, guidance: { txt_cfg: 1 } },
 * };
 * ```
 */
export interface SdServerImageRequest {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  seed: number;
  batch_count: number;
  sample_params: SdServerSampleParams;
}

/** Lifecycle status of a `sd-server` job. */
export type SdServerJobStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';

/** One generated image inside a completed job result. */
export interface SdServerJobImage {
  /** Index within the batch */
  index: number;
  /** Base64-encoded image bytes */
  b64_json: string;
}

/** Result payload of a completed job. */
export interface SdServerJobResult {
  /** Encoding of `images[].b64_json` (e.g. `'png'`) */
  output_format?: string;
  images: SdServerJobImage[];
}

/** Failure payload of a failed job. */
export interface SdServerJobError {
  code?: string;
  message: string;
}

/**
 * Job record returned by `GET /sdcpp/v1/jobs/{id}`.
 *
 * The pinned build reports no per-step progress here — progress is derived from the
 * backend's stdout tap (see `sd-server-runner.ts`).
 */
export interface SdServerJob {
  id: string;
  /** Job kind reported by the backend (e.g. `'img_gen'`) */
  kind?: string;
  status: SdServerJobStatus;
  /** Backend timestamps (seconds or milliseconds; treated as opaque) */
  created?: number;
  started?: number;
  completed?: number;
  /** Position in the backend queue while `status === 'queued'` */
  queue_position?: number;
  result?: SdServerJobResult | null;
  error?: SdServerJobError | null;
}

/**
 * Capabilities document returned by `GET /sdcpp/v1/capabilities`.
 *
 * Left open: the pinned build reports backend/sampler inventories that this library only
 * uses as a readiness proof, and a future binary bump may add fields.
 */
export type SdServerCapabilities = Record<string, unknown>;

/** Outcome of a cancel attempt. */
export interface SdServerCancelResult {
  /** True only when the backend accepted the cancellation */
  cancelled: boolean;
  /** HTTP status the backend answered with (409 = already generating) */
  httpStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isJobStatus(value: unknown): value is SdServerJobStatus {
  return (
    value === 'queued' ||
    value === 'generating' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

/**
 * Translate an image-generation request into the backend's nested job body.
 *
 * Keys whose source value is `undefined` are OMITTED rather than emitted as `null`, so
 * stable-diffusion.cpp falls back to its own defaults exactly as omitting a CLI flag
 * did before the migration. `seed` is required because the manager normalizes a random
 * seed before submitting (the resolved seed is reported back to the caller).
 *
 * @param config - Image request with an already-resolved seed
 * @param batchSize - Maps to `batch_count` (default: 1)
 * @returns Body for `POST /sdcpp/v1/img_gen`
 *
 * @example
 * ```typescript
 * const body = buildSdServerImageRequest(
 *   { prompt: 'a lighthouse', steps: 4, cfgScale: 1, sampler: 'euler', seed: 42 },
 *   1
 * );
 * // { prompt: 'a lighthouse', seed: 42, batch_count: 1,
 * //   sample_params: { sample_steps: 4, sample_method: 'euler', guidance: { txt_cfg: 1 } } }
 * ```
 */
export function buildSdServerImageRequest(
  config: ImageGenerationConfig & { seed: number },
  batchSize?: number
): SdServerImageRequest {
  const guidance: SdServerGuidanceParams = {};
  if (config.cfgScale !== undefined) guidance.txt_cfg = config.cfgScale;

  const sampleParams: SdServerSampleParams = { guidance };
  if (config.steps !== undefined) sampleParams.sample_steps = config.steps;
  if (config.sampler !== undefined) sampleParams.sample_method = config.sampler;

  const body: SdServerImageRequest = {
    prompt: config.prompt,
    seed: config.seed,
    batch_count: batchSize ?? 1,
    sample_params: sampleParams,
  };
  if (config.negativePrompt !== undefined) body.negative_prompt = config.negativePrompt;
  if (config.width !== undefined) body.width = config.width;
  if (config.height !== undefined) body.height = config.height;
  return body;
}

/**
 * Strict client for one `sd-server` instance.
 *
 * @example
 * ```typescript
 * const client = new SdServerClient(handle.port, handle.host);
 * const { id } = await client.submitImageJob(
 *   buildSdServerImageRequest({ prompt: 'a lighthouse', seed: 42 })
 * );
 * const job = await client.getJob(id);
 * console.log(job.status);
 * ```
 */
export class SdServerClient {
  private readonly baseUrl: string;

  /**
   * @param port - Port the backend listens on
   * @param host - Host to reach the backend on (default: `'127.0.0.1'`)
   * @param requestTimeoutMs - Per-request timeout (default:
   *   {@link SD_SERVER_DEFAULT_REQUEST_TIMEOUT_MS})
   */
  constructor(
    readonly port: number,
    readonly host = '127.0.0.1',
    private readonly requestTimeoutMs = SD_SERVER_DEFAULT_REQUEST_TIMEOUT_MS
  ) {
    this.baseUrl = `http://${formatHttpHost(host)}:${port}`;
  }

  /** Fetch the backend capabilities document (also the readiness probe). */
  async capabilities(signal?: AbortSignal): Promise<SdServerCapabilities> {
    const response = await this.send('/sdcpp/v1/capabilities', { method: 'GET' }, signal);
    if (!response.ok) throw this.statusError('/sdcpp/v1/capabilities', response.status);
    const payload = await this.readJson('/sdcpp/v1/capabilities', response);
    if (!isRecord(payload)) {
      throw new ServerError('sd-server /sdcpp/v1/capabilities returned a non-object body', {
        code: 'BACKEND_INVALID_RESPONSE' satisfies SdServerClientErrorCode,
        path: '/sdcpp/v1/capabilities',
      });
    }
    return payload;
  }

  /**
   * Submit one image job.
   *
   * @throws {ServerError} `details.code` is `'BACKEND_QUEUE_FULL'` (429),
   *   `'BACKEND_BAD_REQUEST'` (400, backend message forwarded), or
   *   `'BACKEND_HTTP_ERROR'` for any other non-2xx status.
   */
  async submitImageJob(body: SdServerImageRequest, signal?: AbortSignal): Promise<{ id: string }> {
    const path = '/sdcpp/v1/img_gen';
    const response = await this.send(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      },
      signal
    );

    if (response.status === 429) {
      throw new ServerError('sd-server rejected the job: the backend queue is full', {
        code: 'BACKEND_QUEUE_FULL' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
      });
    }
    if (response.status === 400) {
      const message = await this.readErrorMessage(response);
      throw new ServerError(`sd-server rejected the job request: ${message}`, {
        code: 'BACKEND_BAD_REQUEST' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
        backendMessage: message,
      });
    }
    if (!response.ok) throw this.statusError(path, response.status);

    const payload = await this.readJson(path, response);
    const id = isRecord(payload) && typeof payload.id === 'string' ? payload.id : undefined;
    if (id === undefined || id === '') {
      throw new ServerError('sd-server accepted the job without returning a job id', {
        code: 'BACKEND_INVALID_RESPONSE' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
      });
    }
    return { id };
  }

  /**
   * Read one job record.
   *
   * @throws {ServerError} `details.code` is `'BACKEND_JOB_NOT_FOUND'` (404),
   *   `'BACKEND_JOB_EXPIRED'` (410), or `'BACKEND_HTTP_ERROR'`.
   */
  async getJob(id: string, signal?: AbortSignal): Promise<SdServerJob> {
    const path = `/sdcpp/v1/jobs/${encodeURIComponent(id)}`;
    const response = await this.send(path, { method: 'GET' }, signal);

    if (response.status === 404) {
      throw new ServerError(`sd-server does not know job ${id}`, {
        code: 'BACKEND_JOB_NOT_FOUND' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
        jobId: id,
      });
    }
    if (response.status === 410) {
      throw new ServerError(`sd-server job ${id} expired before it was read`, {
        code: 'BACKEND_JOB_EXPIRED' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
        jobId: id,
      });
    }
    if (!response.ok) throw this.statusError(path, response.status);

    const payload = await this.readJson(path, response);
    if (!isRecord(payload) || !isJobStatus(payload.status)) {
      throw new ServerError(`sd-server returned an invalid job record for ${id}`, {
        code: 'BACKEND_INVALID_RESPONSE' satisfies SdServerClientErrorCode,
        path,
        jobId: id,
      });
    }

    const job: SdServerJob = {
      id: typeof payload.id === 'string' ? payload.id : id,
      status: payload.status,
    };
    if (typeof payload.kind === 'string') job.kind = payload.kind;
    const created = optionalNumber(payload.created);
    if (created !== undefined) job.created = created;
    const started = optionalNumber(payload.started);
    if (started !== undefined) job.started = started;
    const completed = optionalNumber(payload.completed);
    if (completed !== undefined) job.completed = completed;
    const queuePosition = optionalNumber(payload.queue_position);
    if (queuePosition !== undefined) job.queue_position = queuePosition;
    if (isRecord(payload.result)) {
      const images = Array.isArray(payload.result.images) ? payload.result.images : [];
      const result: SdServerJobResult = {
        images: images.filter(isRecord).map((image, index) => ({
          index: optionalNumber(image.index) ?? index,
          b64_json: typeof image.b64_json === 'string' ? image.b64_json : '',
        })),
      };
      if (typeof payload.result.output_format === 'string') {
        result.output_format = payload.result.output_format;
      }
      job.result = result;
    } else if (payload.result === null) {
      job.result = null;
    }
    if (isRecord(payload.error)) {
      const error: SdServerJobError = {
        message:
          typeof payload.error.message === 'string' ? payload.error.message : 'unknown error',
      };
      if (typeof payload.error.code === 'string') error.code = payload.error.code;
      job.error = error;
    } else if (payload.error === null) {
      job.error = null;
    }
    return job;
  }

  /**
   * Ask the backend to cancel a job.
   *
   * Never throws for a refused cancellation: the pinned build answers 409 while the job
   * is already generating (sampling cannot be interrupted), and 404/410 once the job is
   * gone. All three resolve with `cancelled: false` plus the observed status so callers
   * can decide whether to fall back to killing the backend.
   */
  async cancelJob(id: string, signal?: AbortSignal): Promise<SdServerCancelResult> {
    const path = `/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`;
    const response = await this.send(path, { method: 'POST', headers: { Accept: '*/*' } }, signal);

    if (response.ok) return { cancelled: true, httpStatus: response.status };
    if (response.status === 409 || response.status === 404 || response.status === 410) {
      return { cancelled: false, httpStatus: response.status };
    }
    throw this.statusError(path, response.status);
  }

  private async send(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(this.requestTimeoutMs)));
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: requestSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new ServerError(`sd-server ${path} timed out`, {
          code: 'BACKEND_REQUEST_TIMEOUT' satisfies SdServerClientErrorCode,
          path,
          timeoutMs: this.requestTimeoutMs,
        });
      }
      throw new ServerError(
        `sd-server ${path} request failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'BACKEND_REQUEST_FAILED' satisfies SdServerClientErrorCode,
          path,
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  private statusError(path: string, status: number): ServerError {
    return new ServerError(`sd-server ${path} returned HTTP ${status}`, {
      code: 'BACKEND_HTTP_ERROR' satisfies SdServerClientErrorCode,
      path,
      status,
    });
  }

  private async readJson(path: string, response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ServerError(`sd-server ${path} did not return valid JSON`, {
        code: 'BACKEND_INVALID_RESPONSE' satisfies SdServerClientErrorCode,
        path,
        status: response.status,
      });
    }
  }

  /** Best-effort extraction of the backend's own error text from a rejection body. */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as unknown;
      if (isRecord(payload)) {
        if (typeof payload.message === 'string') return payload.message;
        if (isRecord(payload.error) && typeof payload.error.message === 'string') {
          return payload.error.message;
        }
        if (typeof payload.error === 'string') return payload.error;
      }
    } catch {
      // Fall through to the generic message below.
    }
    return `HTTP ${response.status}`;
  }
}
