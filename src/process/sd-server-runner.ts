/**
 * Electron-free launch, readiness detection, stdout tap, and confirmed teardown for one
 * stable-diffusion.cpp `sd-server` process.
 *
 * The public diffusion server is a node:http wrapper; this module owns the backend child
 * it drives. It never touches Electron or `config/paths.js` so the same code path serves
 * production generation, binary validation, and calibration.
 *
 * @module process/sd-server-runner
 */

import { DIFFUSION_BACKEND_DEFAULTS } from '../config/defaults.js';
import { PortInUseError, ServerError } from '../errors/index.js';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { formatHttpHost } from './health-check.js';
import { findFreePort, isPortBindable } from './port-utils.js';
import { ProcessManager, type SpawnOptions, type SpawnResult } from './ProcessManager.js';

interface RunnerProcessManager {
  spawn(command: string, args: string[], options?: SpawnOptions): SpawnResult;
}

interface RunnerChildController {
  isRunning(child: ChildProcess): boolean;
  kill(child: ChildProcess, timeout?: number): Promise<void>;
}

/** Lifecycle state of one `sd-server` runner. */
export type SdServerRunnerState = 'new' | 'starting' | 'running' | 'stopping' | 'stopped';

/** Maximum launch attempts when the port is allocated by this module (`port: 'auto'`). */
const MAX_START_ATTEMPTS = 2;
/** How long `stop()` waits for the exact child to disappear after the kill completes. */
const EXIT_CONFIRMATION_MS = 2_000;
/** How long `stop()` waits for the exit callback once the child is already gone. */
const EXIT_SETTLE_GRACE_MS = 250;
/** Default retained bytes per stdout/stderr tail. */
const DEFAULT_TAIL_MAX_BYTES = 16 * 1024;
/** Hard cap on an unterminated line before the tap processes it anyway. */
const MAX_LINE_BUFFER_BYTES = 64 * 1024;
/** Readiness poll interval bounds. */
const READY_POLL_INITIAL_MS = 150;
const READY_POLL_MAX_MS = 1_000;
/** Per-probe timeout for the readiness capabilities request. */
const READY_PROBE_TIMEOUT_MS = 2_000;

/**
 * Structured stdout markers emitted by stable-diffusion.cpp.
 *
 * **Log-format coupling lives here and nowhere else.** The pinned build reports no
 * progress in the job JSON (upstream #1884 is unmerged), so generation progress is
 * derived from these literals plus the `it/s` progress bar. When a binary bump changes
 * the log wording, update this table (and `docs/dev/UPDATING-BINARIES.md`) — the parser
 * itself needs no change.
 *
 * @example
 * ```typescript
 * for (const { literal, marker } of SD_SERVER_STDOUT_MARKERS) {
 *   console.log(`${literal} -> ${marker}`);
 * }
 * ```
 */
export const SD_SERVER_STDOUT_MARKERS = [
  { literal: 'generating image:', marker: 'generating' },
  { literal: 'sampling using', marker: 'generating' },
  { literal: 'decoding 1 latents', marker: 'decoding' },
  { literal: 'decode_first_stage completed', marker: 'decoded' },
  { literal: 'generate_image completed', marker: 'completed' },
  // Hint only: the socket is listening before the capabilities endpoint answers, so
  // readiness is decided by GET /sdcpp/v1/capabilities, never by this line.
  { literal: 'listening on:', marker: 'listening' },
] as const satisfies readonly { literal: string; marker: SdServerStdoutMarker }[];

/** Marker vocabulary produced by the stdout tap. */
export type SdServerStdoutMarker =
  | 'generating'
  | 'decoding'
  | 'decoded'
  | 'completed'
  | 'listening';

/**
 * One structured observation parsed from the backend's stdout/stderr.
 *
 * @example
 * ```typescript
 * const event: SdServerStdoutEvent = { type: 'step', step: 3, steps: 4 };
 * ```
 */
export type SdServerStdoutEvent =
  /** Sampling progress bar (`| 3/4 - 1.23it/s`) */
  | { type: 'step'; step: number; steps: number }
  /** Weight-upload progress bar (`| 512/1024 - 25.00MB/s`) */
  | { type: 'bytes'; done: number; total: number }
  /** A literal from {@link SD_SERVER_STDOUT_MARKERS} */
  | { type: 'marker'; marker: SdServerStdoutMarker };

/**
 * Observed `sd-server` process termination.
 *
 * @example
 * ```typescript
 * const exit: SdServerExit = { code: 0, signal: null };
 * ```
 */
export interface SdServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn error text when termination happened before a normal exit event. */
  error?: string;
}

/**
 * Options for launching one `sd-server` process.
 *
 * `signal` cancels startup only. After the factory resolves, terminate through the
 * handle's `stop()`.
 *
 * @example
 * ```typescript
 * const options: StartSdServerRunnerOptions = {
 *   binaryPath: 'C:\\userData\\binaries\\diffusion\\sd-server.exe',
 *   modelArgs: ['--diffusion-model', 'C:\\models\\flux.gguf', '--vae', 'C:\\models\\vae.gguf'],
 *   contextArgs: ['--offload-to-cpu', '--diffusion-fa'],
 *   loraDir: 'C:\\userData\\loras',
 *   threads: 8,
 * };
 * ```
 */
export interface StartSdServerRunnerOptions {
  /** Absolute or caller-resolved `sd-server` executable path. */
  binaryPath: string;
  /** Model/component flags (`--diffusion-model`, `--vae`, ...). */
  modelArgs: readonly string[];
  /** Offload and runtime flags (`--clip-on-cpu`, `--diffusion-fa`, ...). */
  contextArgs: readonly string[];
  /** CPU threads (`-t`). Omitted or non-positive leaves the sd.cpp default. */
  threads?: number;
  /**
   * Directory handed to `--lora-model-dir`. Always pass a library-owned directory —
   * pointing sd.cpp at the models directory makes it read model files as LoRAs
   * (leejet/stable-diffusion.cpp#1468).
   */
  loraDir: string;
  /** Interface to bind (default: `'127.0.0.1'`); the backend is reached on this host. */
  host?: string;
  /** Fixed port, or `'auto'` (default) to allocate a free port with one collision retry. */
  port?: number | 'auto';
  /** Maximum spawn-to-ready wait (default: `DIFFUSION_BACKEND_DEFAULTS.readyTimeoutMs`). */
  readyTimeoutMs?: number;
  /** SIGTERM-to-SIGKILL grace used by `stop()` (default: `DIFFUSION_BACKEND_DEFAULTS.stopTimeoutMs`). */
  stopTimeoutMs?: number;
  /** Structured progress observations parsed from the child's output. */
  onStdoutEvent?: (event: SdServerStdoutEvent) => void;
  /** Every complete output line, for log forwarding. */
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Startup-only cancellation signal. */
  signal?: AbortSignal;
  /** Child working directory (default: the binary's own directory, for co-located DLLs). */
  cwd?: string;
  /** Maximum retained bytes for each stdout/stderr tail (default: 16 KiB). */
  tailMaxBytes?: number;
}

/**
 * Post-start lifecycle handle for one `sd-server` process.
 *
 * @example
 * ```typescript
 * const handle = await startSdServerRunner(options);
 * try {
 *   const client = new SdServerClient(handle.port, handle.host);
 *   await handle.raceWithExit(client.capabilities());
 * } finally {
 *   await handle.stop();
 * }
 * ```
 */
export interface SdServerHandle {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly args: readonly string[];
  /** Spawn-to-ready duration in milliseconds. */
  readonly loadTimeMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly state: SdServerRunnerState;
  /** Resolves after the process exits. */
  readonly exitPromise: Promise<SdServerExit>;
  /** Race caller work against observed exit of this exact child. */
  raceWithExit<T>(operation: Promise<T>): Promise<T>;
  /** Idempotent; the first call's timeout wins. */
  stop(timeoutMs?: number): Promise<void>;
}

/** Internal constructor shape retained for source-level tests. */
export interface SdServerRunnerOptions extends StartSdServerRunnerOptions {
  processManager?: RunnerProcessManager;
  childController?: RunnerChildController;
  fetchCapabilities?: SdServerCapabilitiesProbe;
}

/** Readiness probe seam: resolves true once the backend answers capabilities with 200. */
export type SdServerCapabilitiesProbe = (
  port: number,
  host: string,
  signal?: AbortSignal
) => Promise<boolean>;

/** Source-only factory seams used by unit tests; not part of the package facade. */
export interface SdServerRunnerTestDependencies {
  processManager?: RunnerProcessManager;
  childController?: RunnerChildController;
  findFreePort?: (host?: string) => Promise<number>;
  isPortBindable?: (port: number, host?: string) => Promise<boolean>;
  fetchCapabilities?: SdServerCapabilitiesProbe;
}

const STEP_BAR_PATTERN = /\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/g;
const BYTE_BAR_PATTERN = /\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:B|KB|MB|GB)\/s/g;
const BIND_COLLISION_PATTERN = /address already in use|failed to bind|bind[^\n]*failed/i;

function boundedTail(previous: string, next: string, maxBytes: number): string {
  let result = previous + next;
  while (Buffer.byteLength(result, 'utf8') > maxBytes && result.length > 1) {
    result = result.slice(Math.ceil(result.length / 4));
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ServerError && error.details && typeof error.details === 'object') {
    return { ...(error.details as Record<string, unknown>) };
  }
  return {};
}

function invalidOption(name: string, message: string, value?: unknown): ServerError {
  return new ServerError(message, {
    code: 'INVALID_SD_SERVER_RUNNER_OPTIONS',
    option: name,
    value,
  });
}

function validateRunnerOptions(options: StartSdServerRunnerOptions, resolvedPort?: number): void {
  if (options.binaryPath.trim() === '') {
    throw invalidOption('binaryPath', 'binaryPath must not be empty');
  }
  if (options.loraDir.trim() === '') {
    throw invalidOption('loraDir', 'loraDir must not be empty');
  }
  if (options.host !== undefined && (options.host === '' || options.host.trim() !== options.host)) {
    throw invalidOption(
      'host',
      'host must not be empty or contain surrounding whitespace',
      options.host
    );
  }
  if (
    options.threads !== undefined &&
    (!Number.isSafeInteger(options.threads) || options.threads < 0)
  ) {
    throw invalidOption('threads', 'threads must be a non-negative safe integer', options.threads);
  }
  for (const [name, value] of [
    ['readyTimeoutMs', options.readyTimeoutMs],
    ['stopTimeoutMs', options.stopTimeoutMs],
    ['tailMaxBytes', options.tailMaxBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw invalidOption(name, `${name} must be a positive safe integer`, value);
    }
  }
  const port = resolvedPort ?? (options.port === 'auto' ? undefined : options.port);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw invalidOption('port', 'port must be a safe integer between 1 and 65535', port);
  }
}

function startupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ServerError('sd-server startup aborted', {
    code: 'SD_SERVER_START_ABORTED',
    cause: signal.reason,
  });
}

const defaultChildController: RunnerChildController = {
  isRunning(child): boolean {
    return child.exitCode === null && child.signalCode === null;
  },
  async kill(child, timeout = DIFFUSION_BACKEND_DEFAULTS.stopTimeoutMs): Promise<void> {
    if (!this.isRunning(child)) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + timeout;
    while (this.isRunning(child) && Date.now() < deadline) {
      await delay(25);
    }
    if (this.isRunning(child)) child.kill('SIGKILL');
  },
};

/** Default readiness probe: one bounded `GET /sdcpp/v1/capabilities`. */
const defaultCapabilitiesProbe: SdServerCapabilitiesProbe = async (port, host, signal) => {
  const timeout = AbortSignal.timeout(READY_PROBE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetch(`http://${formatHttpHost(host)}:${port}/sdcpp/v1/capabilities`, {
      signal: requestSignal,
      headers: { Accept: 'application/json' },
    });
    // The body is irrelevant here; cancel it so the socket is released promptly.
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return false;
  }
};

/** An isolated `sd-server` process implementation kept behind the public factory handle. */
export class SdServerRunner implements SdServerHandle {
  readonly port: number;
  readonly host: string;
  readonly args: readonly string[];
  readonly exitPromise: Promise<SdServerExit>;

  private readonly binaryPath: string;
  private readonly processManager: RunnerProcessManager;
  private readonly childController: RunnerChildController;
  private readonly probeCapabilities: SdServerCapabilitiesProbe;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly tailMaxBytes: number;
  private readonly cwd: string;
  private readonly signal?: AbortSignal;
  private readonly lifecycleAbort = new AbortController();
  private readonly operationSignal: AbortSignal;
  private readonly onStdoutEvent?: (event: SdServerStdoutEvent) => void;
  private readonly onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  private _state: SdServerRunnerState = 'new';
  private child?: ChildProcess;
  private _pid?: number;
  private _loadTimeMs?: number;
  private stdout = '';
  private stderr = '';
  private stdoutLine = '';
  private stderrLine = '';
  private exitRecord?: SdServerExit;
  private resolveExit!: (exit: SdServerExit) => void;
  private readonly exitObservedPromise: Promise<SdServerExit>;
  private resolveExitObserved!: (exit: SdServerExit) => void;
  private stopPromise?: Promise<void>;

  constructor(options: SdServerRunnerOptions, port: number) {
    validateRunnerOptions(options, port);
    this.port = port;
    this.host = options.host ?? '127.0.0.1';
    this.binaryPath = options.binaryPath;
    this.processManager = options.processManager ?? new ProcessManager();
    this.childController = options.childController ?? defaultChildController;
    this.probeCapabilities = options.fetchCapabilities ?? defaultCapabilitiesProbe;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DIFFUSION_BACKEND_DEFAULTS.readyTimeoutMs;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DIFFUSION_BACKEND_DEFAULTS.stopTimeoutMs;
    this.tailMaxBytes = options.tailMaxBytes ?? DEFAULT_TAIL_MAX_BYTES;
    this.cwd = options.cwd ?? path.dirname(options.binaryPath);
    this.signal = options.signal;
    this.operationSignal = options.signal
      ? AbortSignal.any([this.lifecycleAbort.signal, options.signal])
      : this.lifecycleAbort.signal;
    this.onStdoutEvent = options.onStdoutEvent;
    this.onLog = options.onLog;
    this.args = buildSdServerArgs(options, this.host, port);
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.exitObservedPromise = new Promise<SdServerExit>((resolve) => {
      this.resolveExitObserved = resolve;
    });
  }

  get state(): SdServerRunnerState {
    return this._state;
  }

  get pid(): number {
    if (this._pid === undefined) throw this.invariantError('pid');
    return this._pid;
  }

  get loadTimeMs(): number {
    if (this._loadTimeMs === undefined) throw this.invariantError('loadTimeMs');
    return this._loadTimeMs;
  }

  get stdoutTail(): string {
    return this.stdout;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  private invariantError(field: string): ServerError {
    return new ServerError(`sd-server runner ${field} is unavailable before successful startup`, {
      code: 'SD_SERVER_RUNNER_NOT_STARTED',
      field,
      state: this._state,
    });
  }

  /** True when the child's output proves the listen port was already taken. */
  isBindCollision(): boolean {
    return BIND_COLLISION_PATTERN.test(this.stderr) || BIND_COLLISION_PATTERN.test(this.stdout);
  }

  private exitError(exit: SdServerExit): ServerError {
    return new ServerError(
      exit.error === undefined
        ? `stable-diffusion.cpp sd-server exited with code ${String(exit.code)}`
        : `stable-diffusion.cpp sd-server failed to run: ${exit.error}`,
      {
        code: 'SD_SERVER_EXITED',
        pid: this._pid,
        exitCode: exit.code,
        signal: exit.signal,
        spawnError: exit.error,
        stderrTail: this.stderr,
        stdoutTail: this.stdout,
        args: [...this.args],
      }
    );
  }

  /** Race caller work against immediate exact-child exit observation. */
  raceWithExit<T>(operation: Promise<T>): Promise<T> {
    const guarded = operation.then(
      (value) => {
        if (this.exitRecord) throw this.exitError(this.exitRecord);
        return value;
      },
      (error: unknown) => {
        if (this.exitRecord) throw this.exitError(this.exitRecord);
        throw error;
      }
    );
    return Promise.race([
      guarded,
      this.exitObservedPromise.then((exit) => Promise.reject(this.exitError(exit))),
    ]);
  }

  /** Spawn the backend and resolve once it answers `GET /sdcpp/v1/capabilities`. */
  async start(): Promise<void> {
    if (this._state !== 'new') {
      throw new ServerError(`sd-server runner cannot start from state '${this._state}'`, {
        code: 'SD_SERVER_RUNNER_INVALID_STATE',
        state: this._state,
      });
    }
    this._state = 'starting';
    const startedAt = Date.now();
    try {
      startupAborted(this.signal);
      const spawned = this.processManager.spawn(this.binaryPath, [...this.args], {
        cwd: this.cwd,
        onStdout: (data) => this.consume(data, 'stdout'),
        onStderr: (data) => this.consume(data, 'stderr'),
        onExit: (code, signal) => this.settleExit({ code, signal }),
        onError: (error) => this.handleChildError(error),
      });
      this.child = spawned.process;
      this._pid = spawned.pid;

      await this.raceWithExit(this.waitForReady());
      if (!this.childController.isRunning(spawned.process)) {
        throw this.exitError(
          this.exitRecord ?? { code: spawned.process.exitCode, signal: spawned.process.signalCode }
        );
      }
      this._loadTimeMs = Date.now() - startedAt;
      startupAborted(this.signal);
      this._state = 'running';
    } catch (error) {
      // An unconfirmed teardown outranks the startup failure: a live orphan must never be
      // reported as a plain "did not start", or callers would spawn another over it.
      await this.stop();
      if (this.signal?.aborted && errorDetails(error).code !== 'SD_SERVER_START_ABORTED') {
        throw new ServerError('sd-server startup aborted', {
          code: 'SD_SERVER_START_ABORTED',
          cause: this.signal.reason,
        });
      }
      throw error;
    }
  }

  /** Stop idempotently and require confirmed disappearance of the exact child. */
  stop(timeoutMs?: number): Promise<void> {
    this.stopPromise ??= this.performStop(timeoutMs ?? this.stopTimeoutMs);
    return this.stopPromise;
  }

  private async performStop(timeoutMs: number): Promise<void> {
    if (!this.lifecycleAbort.signal.aborted) {
      this.lifecycleAbort.abort(new DOMException('sd-server runner stopping', 'AbortError'));
    }
    if (this._state !== 'stopped') this._state = 'stopping';

    const child = this.child;
    if (child && !this.exitRecord && this.childController.isRunning(child)) {
      try {
        await this.childController.kill(child, timeoutMs);
      } catch (error) {
        this._state = 'stopped';
        throw this.terminationUnconfirmed(error);
      }
      const deadline = Date.now() + EXIT_CONFIRMATION_MS;
      while (this.childController.isRunning(child) && Date.now() < deadline) {
        await delay(25);
      }
      if (this.childController.isRunning(child)) {
        this._state = 'stopped';
        throw this.terminationUnconfirmed(
          new Error('process is still alive after exact-child kill completed')
        );
      }
    }

    if (!this.exitRecord) {
      await Promise.race([this.exitObservedPromise, delay(EXIT_SETTLE_GRACE_MS)]);
    }
    if (!this.exitRecord) this.settleExit({ code: null, signal: null });
    await this.exitPromise;
    this._state = 'stopped';
  }

  private terminationUnconfirmed(cause: unknown): ServerError {
    return new ServerError(
      `Could not confirm termination of the sd-server process ${String(this._pid)}`,
      {
        code: 'SD_SERVER_TERMINATION_UNCONFIRMED',
        pid: this._pid,
        stderrTail: this.stderr,
        cause: cause instanceof Error ? cause.message : String(cause),
      }
    );
  }

  private handleChildError(error: Error): void {
    const child = this.child;
    if (child && this.childController.isRunning(child)) {
      this.stderr = boundedTail(
        this.stderr,
        `\n[child process error] ${error.message}`,
        this.tailMaxBytes
      );
      return;
    }
    this.settleExit({ code: null, signal: null, error: error.message });
  }

  private settleExit(exit: SdServerExit): void {
    if (this.exitRecord) return;
    // Anything still buffered without a terminating newline is a real observation:
    // stable-diffusion.cpp ends progress bars with `\r`, not `\n`.
    this.flushLine('stdout');
    this.flushLine('stderr');
    this.exitRecord = exit;
    this._state = 'stopped';
    this.resolveExitObserved(exit);
    this.lifecycleAbort.abort(this.exitError(exit));
    this.resolveExit(exit);
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let interval = READY_POLL_INITIAL_MS;
    for (;;) {
      this.operationSignal.throwIfAborted();
      if (await this.probeCapabilities(this.port, this.host, this.operationSignal)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ServerError(
          `stable-diffusion.cpp sd-server was not ready within ${this.readyTimeoutMs}ms`,
          {
            code: 'SD_SERVER_READY_TIMEOUT',
            pid: this._pid,
            port: this.port,
            host: this.host,
            timeoutMs: this.readyTimeoutMs,
            stderrTail: this.stderr || undefined,
            stdoutTail: this.stdout || undefined,
            suggestion:
              'Increase DiffusionServerConfig.startupTimeout for large multi-component models',
          }
        );
      }
      await delayWithSignal(Math.min(interval, remaining), this.operationSignal);
      interval = Math.min(interval * 1.5, READY_POLL_MAX_MS);
    }
  }

  /**
   * Line-buffered tap over BOTH streams.
   *
   * stable-diffusion.cpp redraws progress bars with `\r`, so one chunk can carry several
   * complete bar frames and end mid-frame; splitting on `\r`/`\n` and carrying the tail
   * across chunks keeps every frame intact and attributable.
   */
  private consume(chunk: string, stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') {
      this.stdout = boundedTail(this.stdout, chunk, this.tailMaxBytes);
    } else {
      this.stderr = boundedTail(this.stderr, chunk, this.tailMaxBytes);
    }

    const buffered = (stream === 'stdout' ? this.stdoutLine : this.stderrLine) + chunk;
    const segments = buffered.split(/\r\n|\r|\n/);
    let tail = segments.pop() ?? '';
    // Defensive: a pathological unterminated line must not grow without bound.
    if (Buffer.byteLength(tail, 'utf8') > MAX_LINE_BUFFER_BYTES) {
      segments.push(tail);
      tail = '';
    }
    if (stream === 'stdout') this.stdoutLine = tail;
    else this.stderrLine = tail;
    for (const line of segments) this.handleLine(line, stream);
  }

  private flushLine(stream: 'stdout' | 'stderr'): void {
    const pending = stream === 'stdout' ? this.stdoutLine : this.stderrLine;
    if (stream === 'stdout') this.stdoutLine = '';
    else this.stderrLine = '';
    if (pending !== '') this.handleLine(pending, stream);
  }

  private handleLine(line: string, stream: 'stdout' | 'stderr'): void {
    if (line.trim() === '') return;
    this.onLog?.(line, stream);
    if (!this.onStdoutEvent) return;

    for (const match of line.matchAll(STEP_BAR_PATTERN)) {
      const step = Number(match[1]);
      const steps = Number(match[2]);
      // Upstream #1884: the bar can overshoot its own total. Clamp rather than drop, so
      // "final step reached" stays observable instead of silently disappearing.
      if (steps > 0) this.onStdoutEvent({ type: 'step', step: Math.min(step, steps), steps });
    }
    for (const match of line.matchAll(BYTE_BAR_PATTERN)) {
      this.onStdoutEvent({ type: 'bytes', done: Number(match[1]), total: Number(match[2]) });
    }
    for (const { literal, marker } of SD_SERVER_STDOUT_MARKERS) {
      if (line.includes(literal)) this.onStdoutEvent({ type: 'marker', marker });
    }
  }
}

/** Assemble the exact argv; `--color` is never emitted (it would corrupt the tap). */
function buildSdServerArgs(
  options: StartSdServerRunnerOptions,
  host: string,
  port: number
): readonly string[] {
  return [
    ...options.modelArgs,
    ...options.contextArgs,
    ...(options.threads !== undefined && options.threads > 0
      ? ['-t', String(options.threads)]
      : []),
    '--listen-ip',
    host,
    '--listen-port',
    String(port),
    '--lora-model-dir',
    options.loraDir,
  ];
}

async function startSdServerRunnerInternal(
  options: StartSdServerRunnerOptions,
  dependencies: SdServerRunnerTestDependencies
): Promise<SdServerHandle> {
  validateRunnerOptions(options);
  startupAborted(options.signal);

  const host = options.host ?? '127.0.0.1';
  const allocatePort = dependencies.findFreePort ?? findFreePort;
  const bindable = dependencies.isPortBindable ?? isPortBindable;
  const fixedPort =
    options.port === 'auto' || options.port === undefined ? undefined : options.port;

  if (fixedPort !== undefined) {
    if (!(await bindable(fixedPort, host))) throw new PortInUseError(fixedPort);
    startupAborted(options.signal);
  }

  const attempts = fixedPort === undefined ? MAX_START_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    startupAborted(options.signal);
    const port = fixedPort ?? (await allocatePort(host));
    const runner = new SdServerRunner(
      {
        ...options,
        processManager: dependencies.processManager,
        childController: dependencies.childController,
        fetchCapabilities: dependencies.fetchCapabilities,
      },
      port
    );
    try {
      await runner.start();
      return runner;
    } catch (error) {
      lastError = error;
      // Never spawn a second child while the first one's death is unproven.
      if (errorDetails(error).code === 'SD_SERVER_TERMINATION_UNCONFIRMED') throw error;
      if (!runner.isBindCollision() || attempt === attempts - 1) throw error;
    }
  }
  throw lastError;
}

/**
 * Launch one `sd-server` process and return a handle only after it reports ready.
 *
 * @param options - Launch options; see {@link StartSdServerRunnerOptions}
 * @returns Handle whose `stop()` confirms the exact child disappeared
 * @throws {ServerError} `details.code` is `'SD_SERVER_EXITED'` when the process dies
 *   before it is ready, `'SD_SERVER_READY_TIMEOUT'` when readiness times out (the child
 *   is killed first), `'SD_SERVER_START_ABORTED'` when `signal` fires during startup, or
 *   `'INVALID_SD_SERVER_RUNNER_OPTIONS'` for a malformed option.
 * @throws {PortInUseError} When a fixed `port` cannot be bound.
 *
 * @example
 * ```typescript
 * const handle = await startSdServerRunner({
 *   binaryPath: getBinaryPath('diffusion', 'sd-server'),
 *   modelArgs: ['-m', modelPath],
 *   contextArgs: ['--offload-to-cpu'],
 *   loraDir: PATHS.loras,
 *   onStdoutEvent: (event) => {
 *     if (event.type === 'step') console.log(`${event.step}/${event.steps}`);
 *   },
 * });
 * try {
 *   console.log('ready in', handle.loadTimeMs, 'ms on port', handle.port);
 * } finally {
 *   await handle.stop();
 * }
 * ```
 */
export function startSdServerRunner(options: StartSdServerRunnerOptions): Promise<SdServerHandle> {
  return startSdServerRunnerInternal(options, {});
}

/** Source-level test helper; intentionally omitted from the public package facade. */
export function startSdServerRunnerForTest(
  options: StartSdServerRunnerOptions,
  dependencies: SdServerRunnerTestDependencies
): Promise<SdServerHandle> {
  return startSdServerRunnerInternal(options, dependencies);
}
