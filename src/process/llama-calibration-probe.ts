/** One lifecycle-neutral, fresh-launch llama-server calibration observation. */

import { LLAMA_CALIBRATION_DEFAULTS } from '../config/defaults.js';
import { ServerError } from '../errors/index.js';
import type {
  LlamaCalibrationCombo,
  LlamaCalibrationCleanupRecord,
  LlamaCalibrationMemoryEvidence,
  LlamaCalibrationProbeFidelity,
  LlamaCalibrationProbePhase,
  LlamaCalibrationProbePurpose,
  LlamaCalibrationRequestTiming,
  LlamaCalibrationRun,
  LlamaCalibrationSample,
  LlamaCalibrationWorkload,
  LlamaCalibrationWorkloadResult,
  ModelInfo,
  ResolvedLlamaCalibrationConfig,
} from '../types/index.js';
import { median, weightedCalibrationScore, workloadSignature } from '../utils/llama-calibration.js';
import { LlamaCalibrationClient } from './llama-calibration-client.js';
import { startLlamaServerRunner, type LlamaServerRunner } from './llama-server-runner.js';

type WeightedWorkload = LlamaCalibrationWorkload & { weight: number };

export interface LlamaCalibrationProbeProgress {
  phase: LlamaCalibrationProbePhase;
  workloadIndex?: number;
  sampleIndex?: number;
}

export interface RunCalibrationProbeOptions {
  binaryPath: string;
  model: ModelInfo;
  combo: LlamaCalibrationCombo;
  resolvedConfig: ResolvedLlamaCalibrationConfig;
  workloads: readonly WeightedWorkload[];
  purpose: LlamaCalibrationProbePurpose;
  fidelity: LlamaCalibrationProbeFidelity;
  sampleCount: number;
  seed: number;
  startupTimeoutMs: number;
  /** Timeout for control requests such as `/tokenize` and slot erasure. */
  requestTimeoutMs: number;
  /** Timeout applied only to `/completion` requests in this probe. */
  completionTimeoutMs: number;
  cachedPromptTokenCounts?: ReadonlyMap<string, readonly number[]>;
  signal?: AbortSignal;
  onProgress?: (progress: LlamaCalibrationProbeProgress) => void;
}

export interface RunCalibrationProbeObservation {
  run: LlamaCalibrationRun;
  purpose: LlamaCalibrationProbePurpose;
  fidelity: LlamaCalibrationProbeFidelity;
  memoryEvidence: LlamaCalibrationMemoryEvidence;
  promptTokenCounts: ReadonlyMap<string, readonly number[]>;
  /** Conservative aggregate-score lower bound when a search sample hit its adaptive timeout. */
  aggregateScoreLowerBoundMs?: number;
  cleanup: LlamaCalibrationCleanupRecord & { confirmed: true };
  /** Concise compatibility flag for pre-schema-v2 internal callers. */
  cleanupConfirmed: true;
}

function calibrationErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ServerError) || typeof error.details !== 'object' || !error.details) {
    return undefined;
  }
  const code = (error.details as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function calibrationErrorDetail(error: unknown, key: string): unknown {
  if (!(error instanceof ServerError) || typeof error.details !== 'object' || !error.details) {
    return undefined;
  }
  return (error.details as Record<string, unknown>)[key];
}

function calibrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redact literal caller-provided prompt fragments before diagnostics escape the
 * probe boundary. This covers configured text verbatim; an arbitrary transform
 * produced by an upstream runtime cannot be proven absent by substring redaction.
 */
export function createCalibrationPromptRedactor(
  workloads: readonly LlamaCalibrationWorkload[]
): (value: string) => string {
  const secrets = new Set<string>();
  for (const workload of workloads) {
    if (workload.kind === 'cold-prefill') {
      if (workload.prompt) secrets.add(workload.prompt);
      continue;
    }
    if (workload.sharedPrefix) secrets.add(workload.sharedPrefix);
    for (const suffix of workload.suffixes) {
      if (suffix) secrets.add(suffix);
    }
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return (value: string): string => {
    let redacted = value;
    for (const secret of ordered) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  };
}

function redactUnknown(
  value: unknown,
  redact: (value: string) => string,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, redact, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = redactUnknown(entry, redact, seen);
  }
  return result;
}

/** Return an error whose serializable text no longer contains configured prompts. */
export function redactCalibrationError(error: unknown, redact: (value: string) => string): Error {
  const message = redact(calibrationErrorMessage(error));
  if (error instanceof ServerError) {
    const cleanMessage = message.replace(/^Server error: /, '');
    const sanitized = new ServerError(cleanMessage, redactUnknown(error.details, redact));
    sanitized.stack = error.stack ? redact(error.stack) : sanitized.stack;
    return sanitized;
  }
  const sanitized = new Error(message);
  if (error instanceof Error) {
    sanitized.name = error.name;
    sanitized.stack = error.stack ? redact(error.stack) : sanitized.stack;
  }
  return sanitized;
}

function classifyOperationalFailure(
  error: unknown,
  stderrTail: string
): LlamaCalibrationRun['status'] {
  const code = calibrationErrorCode(error);
  const message = `${calibrationErrorMessage(error)}\n${stderrTail}`;
  if (LLAMA_CALIBRATION_DEFAULTS.oomPatterns.some((pattern) => pattern.test(message))) {
    return 'oom';
  }
  if (code === 'CALIBRATION_CANDIDATE_CRASHED') return 'crashed';
  if (code === 'CALIBRATION_REQUEST_TIMEOUT') return 'request-timeout';
  if (/health check timeout/i.test(message)) return 'startup-timeout';
  return 'error';
}

function classifyMemoryEvidence(
  status: LlamaCalibrationRun['status'],
  error: unknown,
  stderrTail: string
): LlamaCalibrationMemoryEvidence {
  if (status === 'ok') {
    return {
      classification: 'none',
      reason: 'The probe completed without an operational failure.',
      source: 'not-observed',
    };
  }
  const message = `${calibrationErrorMessage(error)}\n${stderrTail}`;
  const specificAllocationPatterns = [
    /out of memory/i,
    /cudaMalloc/i,
    /ErrorOutOfDeviceMemory/i,
    /failed to allocate/i,
    /not enough memory/i,
  ];
  if (specificAllocationPatterns.some((pattern) => pattern.test(message))) {
    return {
      classification: 'confirmed',
      reason: 'A specific memory-allocation failure was observed.',
      source: 'specific-allocation-diagnostic',
    };
  }
  if (status === 'oom') {
    return {
      classification: 'suspected',
      reason:
        'A broad operational OOM diagnostic was observed without a specific allocation failure.',
      source: 'broad-operational-diagnostic',
    };
  }
  if (status === 'startup-timeout' || status === 'request-timeout') {
    return {
      classification: 'unknown',
      reason: 'A timeout alone does not establish memory pressure.',
      source: 'timeout',
    };
  }
  if (status === 'crashed') {
    return {
      classification: 'unknown',
      reason: 'A process exit alone does not establish memory pressure.',
      source: 'process-exit',
    };
  }
  return {
    classification: 'unknown',
    reason: 'No memory-specific diagnostic was observed.',
    source: 'not-observed',
  };
}

function workloadPrompts(workload: WeightedWorkload): readonly string[] {
  return workload.kind === 'cold-prefill'
    ? [workload.prompt]
    : workload.suffixes.map((suffix) => workload.sharedPrefix + suffix);
}

async function validatePromptCapacity(
  client: LlamaCalibrationClient,
  workloads: readonly WeightedWorkload[],
  effectiveContextSize: number,
  cachedPromptTokenCounts?: ReadonlyMap<string, readonly number[]>
): Promise<Map<string, readonly number[]>> {
  const result = new Map<string, readonly number[]>();
  for (const workload of workloads) {
    const prompts = workloadPrompts(workload);
    const cached = cachedPromptTokenCounts?.get(workload.id);
    const tokenCounts =
      cached?.length === prompts.length
        ? [...cached]
        : await Promise.all(prompts.map((prompt) => client.tokenize(prompt)));
    for (const promptTokens of tokenCounts) {
      if (promptTokens + workload.nPredict > effectiveContextSize) {
        throw new ServerError('A calibration workload does not fit the verified per-slot context', {
          code: 'CALIBRATION_INVALID_CONFIG',
          workloadId: workload.id,
          promptTokens,
          nPredict: workload.nPredict,
          effectiveContextSize,
        });
      }
    }
    result.set(workload.id, tokenCounts);
  }
  return result;
}

async function runCalibrationScenario(
  client: LlamaCalibrationClient,
  workload: WeightedWorkload,
  seed: number,
  completionTimeoutMs: number,
  primingTimeoutMs = completionTimeoutMs,
  onMeasuredWorkStart?: () => void
): Promise<LlamaCalibrationSample> {
  const slotId = 0;
  await client.eraseSlot(slotId);
  if (workload.kind === 'cold-prefill') {
    onMeasuredWorkStart?.();
    const request = await client.complete(
      {
        prompt: workload.prompt,
        nPredict: workload.nPredict,
        seed,
        slotId,
        cachePrompt: false,
        requireCacheObservation: false,
      },
      completionTimeoutMs
    );
    return { wallTimeMs: request.wallTimeMs, requests: [request] };
  }

  const primeSuffix = workload.suffixes[0];
  if (primeSuffix === undefined) {
    throw new ServerError('A shared-prefix calibration workload requires a priming suffix', {
      code: 'CALIBRATION_INVALID_CONFIG',
      workloadId: workload.id,
    });
  }
  await client.complete(
    {
      prompt: workload.sharedPrefix + primeSuffix,
      nPredict: workload.nPredict,
      seed,
      slotId,
      cachePrompt: true,
      requireCacheObservation: false,
    },
    primingTimeoutMs
  );
  onMeasuredWorkStart?.();
  const startedAt = performance.now();
  const requests: LlamaCalibrationRequestTiming[] = [];
  for (const suffix of workload.suffixes.slice(1)) {
    requests.push(
      await client.complete(
        {
          prompt: workload.sharedPrefix + suffix,
          nPredict: workload.nPredict,
          seed,
          slotId,
          cachePrompt: true,
          requireCacheObservation: true,
        },
        completionTimeoutMs
      )
    );
  }
  return { wallTimeMs: performance.now() - startedAt, requests };
}

function isFatalProbeError(
  error: unknown,
  purpose: LlamaCalibrationProbePurpose,
  signal?: AbortSignal
): boolean {
  const code = calibrationErrorCode(error);
  const reason = calibrationErrorDetail(error, 'reason');
  return (
    signal?.aborted === true ||
    code === 'CALIBRATION_ABORTED' ||
    code === 'CALIBRATION_CLEANUP_FAILED' ||
    code === 'CALIBRATION_INVALID_CONFIG' ||
    (code === 'CALIBRATION_SLOTS_UNAVAILABLE' &&
      (purpose === 'exact' || reason !== 'runtime-capacity-unavailable'))
  );
}

/**
 * Run exactly one fresh llama-server process and return only after confirmed
 * teardown. It returns strategy-neutral operational evidence; the manager adds
 * exact or adaptive boundary semantics when it builds the schema-v2 report.
 */
export async function runCalibrationProbe(
  options: RunCalibrationProbeOptions
): Promise<RunCalibrationProbeObservation> {
  const redact = createCalibrationPromptRedactor(options.workloads);
  const emitProgress = (progress: LlamaCalibrationProbeProgress): void => {
    try {
      options.onProgress?.(progress);
    } catch {
      // Progress observers must never influence process cleanup or probe results.
    }
  };
  const workloadResults: LlamaCalibrationWorkloadResult[] = [];
  const promptTokenCounts = new Map<string, readonly number[]>();
  let runner: LlamaServerRunner | undefined;
  let status: LlamaCalibrationRun['status'] = 'ok';
  let errorText: string | undefined;
  let stderrTail: string | undefined;
  let fatalError: unknown;
  let cleanupFailure: unknown;
  let cleanupDurationMs: number;
  let loadTimeMs: number | undefined;
  let effectiveContextSize: number | undefined;
  let effectiveParallelRequests: number | undefined;
  let timedWorkloadIndex: number | undefined;
  let timedMeasurementStarted = false;
  let memoryEvidence: LlamaCalibrationMemoryEvidence = {
    classification: 'none',
    reason: 'The probe completed without an operational failure.',
    source: 'not-observed',
  };

  emitProgress({ phase: 'starting' });
  try {
    options.signal?.throwIfAborted();
    runner = await startLlamaServerRunner({
      binaryPath: options.binaryPath,
      model: options.model,
      config: { modelId: options.model.id, ...options.resolvedConfig },
      contextSize: options.resolvedConfig.contextSize,
      parallelRequests: options.resolvedConfig.parallelRequests,
      startupTimeoutMs: options.startupTimeoutMs,
      signal: options.signal,
    });
    loadTimeMs = runner.loadTimeMs;
    const capacity = runner.capacity;
    if (!capacity || capacity.totalSlots === undefined) {
      throw new ServerError('llama-server capacity was not verified for calibration', {
        code: 'CALIBRATION_SLOTS_UNAVAILABLE',
      });
    }
    effectiveContextSize = capacity.effectiveContextSize;
    effectiveParallelRequests = capacity.totalSlots;
    const client = new LlamaCalibrationClient(runner, options.requestTimeoutMs, options.signal);

    emitProgress({ phase: 'capacity-check' });
    const counts = await validatePromptCapacity(
      client,
      options.workloads,
      effectiveContextSize,
      options.cachedPromptTokenCounts
    );
    for (const [workloadId, values] of counts) promptTokenCounts.set(workloadId, values);

    emitProgress({ phase: 'warmup' });
    for (const workload of options.workloads) {
      await runCalibrationScenario(client, workload, options.seed, options.requestTimeoutMs);
    }

    for (const [workloadIndex, workload] of options.workloads.entries()) {
      const samples: LlamaCalibrationSample[] = [];
      for (let sampleIndex = 0; sampleIndex < options.sampleCount; sampleIndex++) {
        emitProgress({ phase: 'sampling', workloadIndex, sampleIndex });
        timedWorkloadIndex = workloadIndex;
        timedMeasurementStarted = false;
        samples.push(
          await runCalibrationScenario(
            client,
            workload,
            options.seed,
            options.completionTimeoutMs,
            options.requestTimeoutMs,
            () => {
              timedMeasurementStarted = true;
            }
          )
        );
        timedWorkloadIndex = undefined;
        timedMeasurementStarted = false;
      }
      workloadResults.push({
        workloadId: workload.id,
        kind: workload.kind,
        workloadHash: workloadSignature(workload).hash,
        weight: workload.weight,
        samples,
        medianWallTimeMs: median(samples.map((sample) => sample.wallTimeMs)),
      });
    }
  } catch (error) {
    const rawStderr =
      runner?.stderrTail ??
      (typeof calibrationErrorDetail(error, 'stderrTail') === 'string'
        ? (calibrationErrorDetail(error, 'stderrTail') as string)
        : '');
    stderrTail = rawStderr ? redact(rawStderr) : undefined;
    if (isFatalProbeError(error, options.purpose, options.signal)) {
      status = classifyOperationalFailure(error, rawStderr);
      memoryEvidence = classifyMemoryEvidence(status, error, rawStderr);
      errorText = redact(calibrationErrorMessage(error));
      fatalError = redactCalibrationError(error, redact);
    } else {
      status = classifyOperationalFailure(error, rawStderr);
      memoryEvidence = classifyMemoryEvidence(status, error, rawStderr);
      errorText = redact(calibrationErrorMessage(error));
    }
  } finally {
    emitProgress({ phase: 'stopping' });
    const cleanupStartedAt = performance.now();
    if (runner) {
      try {
        await runner.stop();
      } catch (error) {
        const sanitized = redactCalibrationError(error, redact);
        const errorDetails =
          error &&
          typeof error === 'object' &&
          'details' in error &&
          typeof error.details === 'object' &&
          error.details
            ? (redactUnknown(error.details, redact) as Record<string, unknown>)
            : {};
        const cleanMessage = sanitized.message.replace(/^Server error: /, '');
        cleanupFailure = new ServerError(cleanMessage, {
          ...errorDetails,
          code: 'CALIBRATION_CLEANUP_FAILED',
          pid: runner.pid,
          stderrTail: redact(runner.stderrTail) || undefined,
          cause: sanitized.message,
          cleanup: {
            confirmed: false,
            durationMs: performance.now() - cleanupStartedAt,
            pid: runner.pid,
            error: sanitized.message,
          },
        });
      }
    }
    cleanupDurationMs = performance.now() - cleanupStartedAt;
  }

  if (cleanupFailure) throw cleanupFailure;

  const resultById = new Map(workloadResults.map((result) => [result.workloadId, result]));
  const completeWorkloadResults = options.workloads.map(
    (workload): LlamaCalibrationWorkloadResult =>
      resultById.get(workload.id) ?? {
        workloadId: workload.id,
        kind: workload.kind,
        workloadHash: workloadSignature(workload).hash,
        weight: workload.weight,
        samples: [],
        error: errorText,
      }
  );
  const scoreMs = status === 'ok' ? weightedCalibrationScore(completeWorkloadResults) : undefined;
  const timedOutWorkload =
    timedWorkloadIndex === undefined ? undefined : options.workloads[timedWorkloadIndex];
  const aggregateScoreLowerBoundMs =
    status === 'request-timeout' &&
    timedOutWorkload &&
    timedMeasurementStarted &&
    options.completionTimeoutMs < options.requestTimeoutMs &&
    options.sampleCount === 1
      ? workloadResults.reduce(
          (total, result) => total + (result.medianWallTimeMs ?? 0) * result.weight,
          timedOutWorkload.weight * options.completionTimeoutMs
        ) / options.workloads.reduce((total, workload) => total + workload.weight, 0)
      : undefined;
  const run: LlamaCalibrationRun = {
    combo: options.combo,
    resolvedConfig: options.resolvedConfig,
    status: scoreMs === undefined && status === 'ok' ? 'error' : status,
    loadTimeMs,
    effectiveContextSize,
    effectiveParallelRequests,
    workloadResults: completeWorkloadResults,
    scoreMs,
    error: errorText,
    stderrTail,
  };
  if (run.status !== status) {
    memoryEvidence = {
      classification: 'unknown',
      reason: 'The completed workload set did not produce a valid aggregate score.',
      source: 'performance',
    };
  }
  const observation: RunCalibrationProbeObservation = {
    run,
    purpose: options.purpose,
    fidelity: options.fidelity,
    memoryEvidence,
    promptTokenCounts,
    aggregateScoreLowerBoundMs,
    cleanup: {
      confirmed: true,
      durationMs: cleanupDurationMs,
      pid: runner?.pid,
    },
    cleanupConfirmed: true,
  };
  if (fatalError) {
    const fatalCode = calibrationErrorCode(fatalError);
    if (
      fatalCode === 'CALIBRATION_INVALID_CONFIG' ||
      fatalCode === 'CALIBRATION_SLOTS_UNAVAILABLE'
    ) {
      const details =
        fatalError instanceof ServerError &&
        typeof fatalError.details === 'object' &&
        fatalError.details
          ? (fatalError.details as Record<string, unknown>)
          : {};
      throw new ServerError(calibrationErrorMessage(fatalError).replace(/^Server error: /, ''), {
        ...details,
        probeObservation: observation,
      });
    }
    throw fatalError;
  }
  return observation;
}
