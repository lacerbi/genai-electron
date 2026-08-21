/**
 * Shared `sd-server` backend seam for the DiffusionServerManager suites.
 *
 * The manager drives its backend through exactly two modules — `sd-server-runner`
 * (process lifecycle + stdout tap) and `sd-server-client` (job API) — so every
 * DiffusionServerManager suite mocks that pair and asserts against it. This module
 * owns the fakes so they stay faithful in one place; in particular `raceWithExit()`
 * really races the operation against observed exit, which is what makes "the poll
 * loop stops after the backend dies" a testable statement.
 *
 * **Import it STATICALLY, before the suite's dynamic `import()` of the manager.**
 * Static imports are evaluated before the importing file's body, so the
 * `jest.unstable_mockModule` registrations below are installed in time. Each test
 * file gets its own module registry, so the `jest.fn()`s here are per-file.
 *
 * `resetMocks: true` (jest.config.js) wipes mock implementations before every test —
 * call {@link resetSdServerMocks} from the suite's `beforeEach` to re-install them.
 */

import { jest } from '@jest/globals';
import { ServerError } from '../../../src/errors/index.js';

/** Observed process termination, mirroring `SdServerExit`. */
export interface FakeSdServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Minimal stand-in for a running `SdServerHandle`. */
export interface FakeSdServerHandle {
  pid: number;
  port: number;
  host: string;
  args: string[];
  loadTimeMs: number;
  stdoutTail: string;
  stderrTail: string;
  state: string;
  exitPromise: Promise<FakeSdServerExit>;
  raceWithExit: <T>(operation: Promise<T>) => Promise<T>;
  stop: jest.Mock;
  /** Launch options the manager passed to startSdServerRunner */
  launch?: any;
  /** Simulate an unexpected process exit (idempotent, like the real runner) */
  emitExit: (exit: FakeSdServerExit) => void;
  /** True once the child was observed to exit */
  exited: boolean;
  /** Backend state observed at the moment stop() was invoked (see setStopObserver) */
  stateAtStop?: string;
}

/** Every handle handed out by the mocked runner, in creation order. */
export const handles: FakeSdServerHandle[] = [];

/** Constructor arguments of every SdServerClient the manager created, in order. */
export const sdServerClientArgs: { port: number; host?: string }[] = [];

/** Hook so a test can observe manager state at kill time. */
let stopObserver: (() => string) | undefined;

/**
 * Record manager state at the moment a handle's `stop()` is entered.
 *
 * @param observe - Callback returning the state to record, or undefined to clear
 */
export function setStopObserver(observe?: () => string): void {
  stopObserver = observe;
}

/** The runner's own error for a child that died (details.code `SD_SERVER_EXITED`). */
export function sdServerExitError(handle: FakeSdServerHandle, exit: FakeSdServerExit): ServerError {
  return new ServerError(`stable-diffusion.cpp sd-server exited with code ${String(exit.code)}`, {
    code: 'SD_SERVER_EXITED',
    pid: handle.pid,
    exitCode: exit.code,
    signal: exit.signal,
    stderrTail: handle.stderrTail,
    stdoutTail: handle.stdoutTail,
    args: [...handle.args],
  });
}

/** The runner's error for a kill it could not confirm (blocks any respawn). */
export function sdServerTerminationUnconfirmedError(pid: number): ServerError {
  return new ServerError(`Could not confirm termination of the sd-server process ${pid}`, {
    code: 'SD_SERVER_TERMINATION_UNCONFIRMED',
    pid,
    stderrTail: '',
    cause: 'process is still alive after exact-child kill completed',
  });
}

/** The runner's error for a startup cancelled through `signal` (child confirmed dead). */
export function sdServerStartAbortedError(): ServerError {
  return new ServerError('sd-server startup aborted', { code: 'SD_SERVER_START_ABORTED' });
}

/** The runner's error for a readiness timeout (the child is already gone). */
export function sdServerReadyTimeoutError(timeoutMs = 120_000): ServerError {
  return new ServerError(`stable-diffusion.cpp sd-server was not ready within ${timeoutMs}ms`, {
    code: 'SD_SERVER_READY_TIMEOUT',
    port: 51234,
    host: '127.0.0.1',
    timeoutMs,
    suggestion: 'Increase DiffusionServerConfig.startupTimeout for large models',
  });
}

/**
 * Create one fake backend handle and register it in {@link handles}.
 *
 * `raceWithExit()` is faithful: once `emitExit()` has fired, every operation raced
 * through it rejects with the runner's `SD_SERVER_EXITED` error — including an
 * operation that resolves *after* the exit.
 */
export function createSdServerHandle(
  overrides: Partial<FakeSdServerHandle> = {}
): FakeSdServerHandle {
  let settle!: (exit: FakeSdServerExit) => void;
  const exitPromise = new Promise<FakeSdServerExit>((resolve) => {
    settle = resolve;
  });
  let exitRecord: FakeSdServerExit | undefined;

  const settleOnce = (exit: FakeSdServerExit): void => {
    if (exitRecord) return;
    exitRecord = exit;
    handle.exited = true;
    handle.state = 'stopped';
    settle(exit);
  };

  const handle: FakeSdServerHandle = {
    pid: 4242 + handles.length,
    port: 51234,
    host: '127.0.0.1',
    args: ['--listen-ip', '127.0.0.1', '--listen-port', '51234'],
    loadTimeMs: 25,
    stdoutTail: '',
    stderrTail: '',
    state: 'running',
    exited: false,
    exitPromise,
    raceWithExit: <T>(operation: Promise<T>): Promise<T> => {
      const guarded = operation.then(
        (value) => {
          if (exitRecord) throw sdServerExitError(handle, exitRecord);
          return value;
        },
        (error: unknown) => {
          if (exitRecord) throw sdServerExitError(handle, exitRecord);
          throw error;
        }
      );
      return Promise.race([
        guarded,
        exitPromise.then((exit) => Promise.reject(sdServerExitError(handle, exit))),
      ]) as Promise<T>;
    },
    stop: jest.fn(async () => {
      handle.stateAtStop = stopObserver?.();
      settleOnce({ code: null, signal: 'SIGTERM' });
    }),
    emitExit: settleOnce,
    ...overrides,
  };
  handles.push(handle);
  return handle;
}

/** Default backend answer for a finished job (base64 of `image`). */
export const COMPLETED_JOB = {
  id: 'job-1',
  status: 'completed',
  result: { output_format: 'png', images: [{ index: 0, b64_json: 'aW1hZ2U=' }] },
};

export const mockStartSdServerRunner = jest.fn(async (options: any): Promise<any> => {
  const handle = createSdServerHandle();
  handle.launch = options;
  return handle;
});

export const mockSubmitImageJob = jest.fn(async (): Promise<any> => ({ id: 'job-1' }));
export const mockGetJob = jest.fn(async (_id?: string): Promise<any> => COMPLETED_JOB);
export const mockCancelJob = jest.fn(
  async (): Promise<any> => ({ cancelled: true, httpStatus: 200 })
);
export const mockCapabilities = jest.fn(async (): Promise<any> => ({}));
export const mockBuildRequest = jest.fn((config: any, batchSize?: number) => ({
  prompt: config.prompt,
  seed: config.seed,
  batch_count: batchSize ?? 1,
  sample_params: { guidance: {} },
}));

export class MockSdServerClient {
  submitImageJob = mockSubmitImageJob;
  getJob = mockGetJob;
  cancelJob = mockCancelJob;
  capabilities = mockCapabilities;

  constructor(
    readonly port: number,
    readonly host?: string
  ) {
    sdServerClientArgs.push({ port, host });
  }
}

/** Real behaviour (not a mock): the manager filters bar frames out of its log file. */
const PROGRESS_BAR_PATTERN =
  /\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)|\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:B|KB|MB|GB)\/s/;

export function isSdServerProgressBarLine(line: string): boolean {
  return PROGRESS_BAR_PATTERN.test(line);
}

jest.unstable_mockModule('../../../src/process/sd-server-runner.js', () => ({
  startSdServerRunner: mockStartSdServerRunner,
  SD_SERVER_STDOUT_MARKERS: [],
  isSdServerProgressBarLine,
}));

jest.unstable_mockModule('../../../src/process/sd-server-client.js', () => ({
  SdServerClient: MockSdServerClient,
  buildSdServerImageRequest: mockBuildRequest,
  SD_SERVER_DEFAULT_REQUEST_TIMEOUT_MS: 5000,
}));

/**
 * Re-install every default implementation and clear the per-test collections.
 *
 * Call from the suite's `beforeEach` (after `jest.clearAllMocks()`): `resetMocks: true`
 * strips implementations from every `jest.fn()` before each test.
 */
export function resetSdServerMocks(): void {
  handles.length = 0;
  sdServerClientArgs.length = 0;
  setStopObserver(undefined);

  mockStartSdServerRunner.mockImplementation(async (options: any) => {
    const handle = createSdServerHandle();
    handle.launch = options;
    return handle;
  });
  mockSubmitImageJob.mockImplementation(async () => ({ id: 'job-1' }));
  mockGetJob.mockImplementation(async () => COMPLETED_JOB);
  mockCancelJob.mockImplementation(async () => ({ cancelled: true, httpStatus: 200 }));
  mockCapabilities.mockImplementation(async () => ({}));
  mockBuildRequest.mockImplementation((config: any, batchSize?: number) => ({
    prompt: config.prompt,
    seed: config.seed,
    batch_count: batchSize ?? 1,
    sample_params: { guidance: {} },
  }));
}
