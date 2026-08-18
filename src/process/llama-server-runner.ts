/** Electron-free isolated llama-server launch and confirmed teardown. */

import { DEFAULT_TIMEOUTS, LLAMA_CALIBRATION_DEFAULTS } from '../config/defaults.js';
import { PortInUseError, ServerError } from '../errors/index.js';
import type { LlamaServerRunnerConfig, ResolvedLlamaServerRunnerConfig } from '../types/index.js';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isServerResponding, normalizeHealthHost, waitForHealthy } from './health-check.js';
import { fetchLlamaRuntimeCapacity, type VerifiedLlamaRuntimeCapacity } from './llama-props.js';
import {
  buildLlamaServerArgs,
  normalizeLlamaVCacheConfig,
  type LlamaModelFile,
  type LlamaSlotsEndpointMode,
} from './llama-server-args.js';
import { findFreePort, isPortBindable } from './port-utils.js';
import { ProcessManager, type SpawnOptions, type SpawnResult } from './ProcessManager.js';

interface RunnerProcessManager {
  spawn(command: string, args: string[], options?: SpawnOptions): SpawnResult;
}

interface RunnerChildController {
  isRunning(child: ChildProcess): boolean;
  kill(child: ChildProcess, timeout?: number): Promise<void>;
}

type RunnerState = 'new' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Observed llama-server process termination.
 *
 * @example
 * ```ts
 * const exit: LlamaServerExit = { code: 0, signal: null };
 * ```
 */
export interface LlamaServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn error text when termination happened before a normal exit event. */
  error?: string;
}

/**
 * Supported options for launching one isolated llama-server process.
 *
 * `signal` cancels startup only. After this factory resolves, call the returned
 * handle's `stop()` method to terminate the server.
 *
 * @example
 * ```ts
 * const options: StartLlamaServerRunnerOptions = {
 *   binaryPath: '/opt/llama/bin/llama-server',
 *   model: { path: '/opt/models/model.gguf' },
 *   config: { host: '127.0.0.1', gpuLayers: 40 },
 *   contextSize: 8192,
 *   parallelRequests: 2,
 *   startupTimeoutMs: 120000,
 *   port: 12345,
 *   slotsEndpoint: 'disabled',
 * };
 * ```
 */
export interface StartLlamaServerRunnerOptions {
  /** Absolute or caller-resolved llama-server executable path. */
  binaryPath: string;
  /** GGUF model file supplied directly to llama-server. */
  model: LlamaModelFile;
  /**
   * Canonical runtime flags other than the required values below.
   * WARNING: `host: '0.0.0.0'` or `'::'` may expose the unauthenticated server
   * beyond loopback; use wildcard binds only with deliberate network controls.
   */
  config: LlamaServerRunnerConfig;
  /** Exact total context allocation (`-c`). */
  contextSize: number;
  /** Exact request-slot count (`-np`). */
  parallelRequests: number;
  /** Maximum startup/health wait in milliseconds. */
  startupTimeoutMs: number;
  /** Fixed port, or omit to allocate a free port with one collision retry. */
  port?: number;
  /** Child-process working directory; the current process cwd is used when omitted. */
  cwd?: string;
  /** Startup-only cancellation signal. */
  signal?: AbortSignal;
  /** Maximum retained bytes for each stdout/stderr tail. */
  stderrMaxBytes?: number;
  /** `/slots` exposure mode. Omission preserves the server's default. */
  slotsEndpoint?: LlamaSlotsEndpointMode;
  /** Caller-owned slot-state directory, never removed by this package. */
  slotSavePath?: string;
  /**
   * Create and own a temporary slot-state directory.
   * Requires `slotsEndpoint: 'enabled'` and no caller `slotSavePath`.
   */
  temporarySlotSavePath?: boolean;
}

/**
 * Post-start lifecycle handle returned only after strict capacity verification.
 *
 * @example
 * ```ts
 * const handle: LlamaServerHandle = await startLlamaServerRunner(options);
 * try { console.log(handle.pid, handle.capacity.totalSlots); }
 * finally { await handle.stop(); }
 * ```
 */
export interface LlamaServerHandle {
  readonly port: number;
  readonly args: readonly string[];
  readonly config: ResolvedLlamaServerRunnerConfig;
  readonly capacity: VerifiedLlamaRuntimeCapacity;
  readonly loadTimeMs: number;
  readonly pid: number;
  readonly stderrTail: string;
  readonly stdoutTail: string;
  /**
   * Resolves after process exit and owned cleanup. Rejects when owned cleanup fails.
   */
  readonly exitPromise: Promise<LlamaServerExit>;
  raceWithExit<T>(operation: Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

/** Internal constructor shape retained for source-level tests; not re-exported by the facade. */
export interface LlamaServerRunnerOptions extends StartLlamaServerRunnerOptions {
  processManager?: RunnerProcessManager;
  childController?: RunnerChildController;
  cleanupSlotSavePath?: boolean;
  slotSaveDirectoryRemover?: (slotSavePath: string) => Promise<void>;
}

/** Source-only factory seams used by unit tests; not part of the package facade. */
export interface LlamaServerRunnerTestDependencies {
  processManager?: RunnerProcessManager;
  childController?: RunnerChildController;
  slotSaveDirectoryRemover?: (slotSavePath: string) => Promise<void>;
  temporaryDirectoryCreator?: () => Promise<string>;
  findFreePort?: (host?: string) => Promise<number>;
  isPortBindable?: (port: number, host?: string) => Promise<boolean>;
  isServerResponding?: (port: number, timeout?: number, host?: string) => Promise<boolean>;
}

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

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ServerError && error.details && typeof error.details === 'object') {
    return { ...(error.details as Record<string, unknown>) };
  }
  return {};
}

function positiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServerError(`${name} must be a positive safe integer`, {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      option: name,
      value,
    });
  }
}

function validateRunnerOptions(
  options: StartLlamaServerRunnerOptions,
  resolvedPort?: number
): void {
  positiveSafeInteger('contextSize', options.contextSize);
  positiveSafeInteger('parallelRequests', options.parallelRequests);
  positiveSafeInteger('startupTimeoutMs', options.startupTimeoutMs);
  if (options.stderrMaxBytes !== undefined) {
    positiveSafeInteger('stderrMaxBytes', options.stderrMaxBytes);
  }

  const port = resolvedPort ?? options.port;
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new ServerError('port must be a safe integer between 1 and 65535', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      option: 'port',
      value: port,
    });
  }

  if (options.config.host !== undefined && options.config.host.trim() !== options.config.host) {
    throw new ServerError('host must not be empty or contain surrounding whitespace', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      option: 'host',
      value: options.config.host,
    });
  }
  if (options.config.host === '') {
    throw new ServerError('host must not be empty or contain surrounding whitespace', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      option: 'host',
      value: options.config.host,
    });
  }
  if (options.slotSavePath !== undefined && options.slotSavePath.trim() === '') {
    throw new ServerError('slotSavePath must not be empty', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      option: 'slotSavePath',
    });
  }

  const slotsEndpoint = options.slotsEndpoint ?? 'default';
  if (slotsEndpoint === 'disabled' && (options.slotSavePath || options.temporarySlotSavePath)) {
    throw new ServerError('Disabled slots cannot use slot-save state', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      slotsEndpoint,
    });
  }
  if (options.temporarySlotSavePath && slotsEndpoint !== 'enabled') {
    throw new ServerError("temporarySlotSavePath requires slotsEndpoint: 'enabled'", {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
      slotsEndpoint,
    });
  }
  if (options.temporarySlotSavePath && options.slotSavePath) {
    throw new ServerError('temporarySlotSavePath cannot be combined with slotSavePath', {
      code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS',
    });
  }
}

function startupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ServerError('LLM calibration aborted', {
    code: 'CALIBRATION_ABORTED',
    cause: signal.reason,
  });
}

function cleanupError(pid: number | undefined, stderrTail: string, error: unknown): ServerError {
  if (errorDetails(error).code === 'CALIBRATION_CLEANUP_FAILED' && error instanceof ServerError) {
    return error;
  }
  return new ServerError(`Could not confirm cleanup of calibration process ${String(pid)}`, {
    code: 'CALIBRATION_CLEANUP_FAILED',
    pid,
    stderrTail,
    cause: error instanceof Error ? error.message : String(error),
  });
}

const defaultChildController: RunnerChildController = {
  isRunning(child): boolean {
    return child.exitCode === null && child.signalCode === null;
  },
  async kill(child, timeout = DEFAULT_TIMEOUTS.serverStop): Promise<void> {
    if (!this.isRunning(child)) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + timeout;
    while (this.isRunning(child) && Date.now() < deadline) {
      await delay(25);
    }
    if (this.isRunning(child)) child.kill('SIGKILL');
  },
};

/** An isolated process implementation kept behind the public factory handle. */
export class LlamaServerRunner implements LlamaServerHandle {
  readonly port: number;
  readonly args: readonly string[];
  readonly config: ResolvedLlamaServerRunnerConfig;
  readonly exitPromise: Promise<LlamaServerExit>;

  private readonly binaryPath: string;
  private readonly processManager: RunnerProcessManager;
  private readonly childController: RunnerChildController;
  private readonly startupTimeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly lifecycleAbort = new AbortController();
  private readonly operationSignal: AbortSignal;
  private readonly stderrMaxBytes: number;
  private readonly cwd?: string;
  private readonly connectHost: string;
  private readonly slotSavePath?: string;
  private readonly cleanupSlotSavePath: boolean;
  private readonly slotSaveDirectoryRemover: (slotSavePath: string) => Promise<void>;
  private state: RunnerState = 'new';
  private child?: ChildProcess;
  private _pid?: number;
  private _capacity?: VerifiedLlamaRuntimeCapacity;
  private _loadTimeMs?: number;
  private stderr = '';
  private stdout = '';
  private exitRecord?: LlamaServerExit;
  private resolveExit!: (exit: LlamaServerExit) => void;
  private rejectExit!: (error: unknown) => void;
  private resolveExitObserved!: (exit: LlamaServerExit) => void;
  private readonly exitObservedPromise: Promise<LlamaServerExit>;
  private cleanupPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(options: LlamaServerRunnerOptions, port: number) {
    validateRunnerOptions(options, port);
    this.port = port;
    this.binaryPath = options.binaryPath;
    this.processManager = options.processManager ?? new ProcessManager();
    this.childController = options.childController ?? defaultChildController;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.signal = options.signal;
    this.operationSignal = options.signal
      ? AbortSignal.any([this.lifecycleAbort.signal, options.signal])
      : this.lifecycleAbort.signal;
    this.stderrMaxBytes = options.stderrMaxBytes ?? LLAMA_CALIBRATION_DEFAULTS.stderrMaxBytes;
    this.cwd = options.cwd;
    this.connectHost = normalizeHealthHost(options.config.host);
    this.slotSavePath = options.slotSavePath;
    this.cleanupSlotSavePath = options.cleanupSlotSavePath === true;
    this.slotSaveDirectoryRemover =
      options.slotSaveDirectoryRemover ??
      ((slotSavePath) => fs.rm(slotSavePath, { recursive: true, force: true }));
    this.config = normalizeLlamaVCacheConfig({
      ...options.config,
      contextSize: options.contextSize,
      parallelRequests: options.parallelRequests,
      port,
      fit: 'off' as const,
    });
    this.args = buildLlamaServerArgs(this.config, options.model, {
      slotsEndpoint: options.slotsEndpoint,
      slotSavePath: this.slotSavePath,
    });
    this.exitPromise = new Promise((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });
    // Cleanup failures remain observable to callers without becoming unhandled rejections.
    void this.exitPromise.catch(() => undefined);
    this.exitObservedPromise = new Promise<LlamaServerExit>((resolve) => {
      this.resolveExitObserved = resolve;
    });
  }

  get pid(): number {
    if (this._pid === undefined) throw this.invariantError('pid');
    return this._pid;
  }

  get capacity(): VerifiedLlamaRuntimeCapacity {
    if (this._capacity === undefined) throw this.invariantError('capacity');
    return this._capacity;
  }

  get loadTimeMs(): number {
    if (this._loadTimeMs === undefined) throw this.invariantError('loadTimeMs');
    return this._loadTimeMs;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  get stdoutTail(): string {
    return this.stdout;
  }

  private invariantError(field: string): ServerError {
    return new ServerError(`Runner ${field} is unavailable before successful startup`, {
      code: 'LLAMA_SERVER_RUNNER_NOT_STARTED',
      field,
      state: this.state,
    });
  }

  private cleanupFailure(error: unknown): ServerError {
    return cleanupError(this._pid, this.stderr, error);
  }

  private ensureOwnedCleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = (async () => {
        if (!this.cleanupSlotSavePath || !this.slotSavePath) return;
        await this.slotSaveDirectoryRemover(this.slotSavePath);
      })().catch((error) => Promise.reject(this.cleanupFailure(error)));
    }
    return this.cleanupPromise;
  }

  private settleExit(exit: LlamaServerExit): void {
    if (this.exitRecord) return;
    this.exitRecord = exit;
    this.resolveExitObserved(exit);
    this.lifecycleAbort.abort(this.crashError(exit));
    void this.finalizeExit(exit);
  }

  private handleChildError(error: Error): void {
    const child = this.child;
    if (child && this.childController.isRunning(child)) {
      this.stderr = boundedTail(
        this.stderr,
        `\n[child process error] ${error.message}`,
        this.stderrMaxBytes
      );
      return;
    }
    this.settleExit({ code: null, signal: null, error: error.message });
  }

  private async finalizeExit(exit: LlamaServerExit): Promise<void> {
    try {
      await this.ensureOwnedCleanup();
      this.state = 'stopped';
      this.resolveExit(exit);
    } catch (error) {
      this.state = 'stopped';
      this.rejectExit(error);
    }
  }

  private crashError(exit: LlamaServerExit): ServerError {
    return new ServerError('Calibration candidate process exited unexpectedly', {
      code: 'CALIBRATION_CANDIDATE_CRASHED',
      pid: this._pid,
      exitCode: exit.code,
      signal: exit.signal,
      spawnError: exit.error,
      stderrTail: this.stderr,
    });
  }

  /** Race caller work against immediate exact-child exit observation. */
  raceWithExit<T>(operation: Promise<T>): Promise<T> {
    const guardedOperation = operation.then(
      (value) => {
        if (this.exitRecord) throw this.crashError(this.exitRecord);
        return value;
      },
      (error: unknown) => {
        if (this.exitRecord) throw this.crashError(this.exitRecord);
        throw error;
      }
    );
    return Promise.race([
      guardedOperation,
      this.exitObservedPromise.then((exit) => Promise.reject(this.crashError(exit))),
    ]);
  }

  /** Spawn, await health, and strictly verify the fixed capacity profile. */
  async start(): Promise<void> {
    if (this.state !== 'new') {
      throw new ServerError(`Runner cannot start from state '${this.state}'`, {
        code: 'LLAMA_SERVER_RUNNER_INVALID_STATE',
        state: this.state,
      });
    }
    this.state = 'starting';
    const startedAt = Date.now();
    try {
      startupAborted(this.signal);
      const spawned = this.processManager.spawn(this.binaryPath, [...this.args], {
        cwd: this.cwd,
        onStdout: (data) => {
          this.stdout = boundedTail(this.stdout, data, this.stderrMaxBytes);
        },
        onStderr: (data) => {
          this.stderr = boundedTail(this.stderr, data, this.stderrMaxBytes);
        },
        onExit: (code, signal) => this.settleExit({ code, signal }),
        onError: (error) => this.handleChildError(error),
      });
      this.child = spawned.process;
      this._pid = spawned.pid;

      await this.raceWithExit(
        waitForHealthy(
          this.port,
          this.startupTimeoutMs,
          100,
          2_000,
          this.connectHost,
          this.operationSignal
        )
      );
      if (!this.childController.isRunning(spawned.process)) {
        throw this.crashError(
          this.exitRecord ?? { code: spawned.process.exitCode, signal: spawned.process.signalCode }
        );
      }
      this._loadTimeMs = Date.now() - startedAt;

      let capacity;
      try {
        capacity = await this.raceWithExit(
          fetchLlamaRuntimeCapacity(
            this.port,
            this.connectHost,
            this.config.parallelRequests,
            Math.min(this.startupTimeoutMs, LLAMA_CALIBRATION_DEFAULTS.capacityCheckTimeoutCapMs),
            this.operationSignal
          )
        );
      } catch (error) {
        const details = errorDetails(error);
        if (
          details.code === 'CALIBRATION_CANDIDATE_CRASHED' ||
          details.code === 'CALIBRATION_CLEANUP_FAILED'
        ) {
          throw error;
        }
        const cause = error instanceof Error ? error.message : String(error);
        throw new ServerError(`Could not verify the fixed calibration capacity profile: ${cause}`, {
          ...details,
          code: 'CALIBRATION_SLOTS_UNAVAILABLE',
          cause,
          stderrTail: this.stderr || undefined,
        });
      }

      if (capacity.totalSlots === undefined) {
        throw new ServerError('llama-server did not report total_slots during calibration', {
          code: 'CALIBRATION_SLOTS_UNAVAILABLE',
          suggestion: 'Use the pinned llama-server build with a compatible /props endpoint',
        });
      }
      if (!this.childController.isRunning(spawned.process)) {
        throw this.crashError(
          this.exitRecord ?? { code: spawned.process.exitCode, signal: spawned.process.signalCode }
        );
      }
      const expectedPerSlot = Math.floor(this.config.contextSize / this.config.parallelRequests);
      if (capacity.effectiveContextSize !== expectedPerSlot) {
        throw new ServerError(
          `llama-server reported ${capacity.effectiveContextSize} context tokens per slot; expected ${expectedPerSlot}`,
          {
            code: 'CALIBRATION_SLOTS_UNAVAILABLE',
            configuredContextSize: this.config.contextSize,
            parallelRequests: this.config.parallelRequests,
            effectiveContextSize: capacity.effectiveContextSize,
          }
        );
      }
      this._capacity = { ...capacity, totalSlots: capacity.totalSlots };
      startupAborted(this.signal);
      this.state = 'running';
    } catch (error) {
      await this.stop();
      if (this.signal?.aborted && errorDetails(error).code !== 'CALIBRATION_ABORTED') {
        throw new ServerError('LLM calibration aborted', {
          code: 'CALIBRATION_ABORTED',
          cause: this.signal.reason,
        });
      }
      const details = errorDetails(error);
      if (this.stderr && typeof details.stderrTail !== 'string') {
        throw new ServerError(
          `Calibration candidate startup failed: ${error instanceof Error ? error.message : String(error)}`,
          { ...details, stderrTail: this.stderr }
        );
      }
      throw error;
    }
  }

  /** Stop idempotently and require confirmed disappearance of the exact child. */
  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (!this.lifecycleAbort.signal.aborted) {
      this.lifecycleAbort.abort(new DOMException('Runner stopping', 'AbortError'));
    }
    if (this.state !== 'stopped') this.state = 'stopping';

    try {
      const child = this.child;
      if (child && !this.exitRecord && this.childController.isRunning(child)) {
        await this.childController.kill(child, DEFAULT_TIMEOUTS.serverStop);
        const deadline = Date.now() + LLAMA_CALIBRATION_DEFAULTS.processExitConfirmationMs;
        while (this.childController.isRunning(child) && Date.now() < deadline) {
          await delay(25);
        }
        if (this.childController.isRunning(child)) {
          throw new Error('process is still alive after exact-child kill completed');
        }
      }

      if (!this.exitRecord) {
        await Promise.race([
          this.exitObservedPromise,
          delay(LLAMA_CALIBRATION_DEFAULTS.processExitSettleGraceMs),
        ]);
      }
      if (!this.exitRecord) this.settleExit({ code: null, signal: null });
      await this.exitPromise;
      this.state = 'stopped';
    } catch (error) {
      this.state = 'stopped';
      throw this.cleanupFailure(error);
    }
  }

  isBindCollision(): boolean {
    return /address already in use|failed to bind|bind[^\n]*failed/i.test(this.stderr);
  }
}

async function startLlamaServerRunnerInternal(
  options: StartLlamaServerRunnerOptions,
  dependencies: LlamaServerRunnerTestDependencies
): Promise<LlamaServerHandle> {
  validateRunnerOptions(options);
  startupAborted(options.signal);

  const bindHost = options.config.host ?? '127.0.0.1';
  const connectHost = normalizeHealthHost(options.config.host);
  const allocatePort = dependencies.findFreePort ?? findFreePort;
  const bindable = dependencies.isPortBindable ?? isPortBindable;
  const responding = dependencies.isServerResponding ?? isServerResponding;
  const removeSlotDirectory =
    dependencies.slotSaveDirectoryRemover ??
    ((slotSavePath: string) => fs.rm(slotSavePath, { recursive: true, force: true }));
  const createTemporaryDirectory =
    dependencies.temporaryDirectoryCreator ??
    (() => fs.mkdtemp(path.join(os.tmpdir(), 'genai-electron-llama-server-')));

  if (options.port !== undefined) {
    if (await responding(options.port, 2_000, connectHost)) {
      throw new PortInUseError(options.port);
    }
    startupAborted(options.signal);
    if (!(await bindable(options.port, bindHost))) {
      throw new PortInUseError(options.port);
    }
    startupAborted(options.signal);
  }

  const attempts =
    options.port === undefined ? LLAMA_CALIBRATION_DEFAULTS.maxRunnerStartAttempts : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    startupAborted(options.signal);
    const port = options.port ?? (await allocatePort(bindHost));
    let ownedSlotSavePath: string | undefined;
    let runner: LlamaServerRunner | undefined;
    try {
      if (options.temporarySlotSavePath) {
        ownedSlotSavePath = await createTemporaryDirectory();
      }
      startupAborted(options.signal);
      runner = new LlamaServerRunner(
        {
          ...options,
          temporarySlotSavePath: false,
          slotSavePath: ownedSlotSavePath ?? options.slotSavePath,
          cleanupSlotSavePath: ownedSlotSavePath !== undefined,
          processManager: dependencies.processManager,
          childController: dependencies.childController,
          slotSaveDirectoryRemover: removeSlotDirectory,
        },
        port
      );
      await runner.start();
      return runner;
    } catch (error) {
      lastError = error;
      if (!runner && ownedSlotSavePath) {
        try {
          await removeSlotDirectory(ownedSlotSavePath);
        } catch (removeError) {
          throw cleanupError(undefined, '', removeError);
        }
      }
      if (errorDetails(error).code === 'CALIBRATION_CLEANUP_FAILED') throw error;
      if (!runner?.isBindCollision() || attempt === attempts - 1) throw error;
    }
  }
  throw lastError;
}

/**
 * Launch one llama-server process and return a strict post-start handle.
 *
 * @example
 * ```ts
 * const handle = await startLlamaServerRunner({
 *   binaryPath: '/opt/llama/bin/llama-server',
 *   model: { path: '/opt/models/model.gguf' },
 *   config: { gpuLayers: 40 },
 *   contextSize: 8192,
 *   parallelRequests: 2,
 *   startupTimeoutMs: 120_000,
 *   slotsEndpoint: 'disabled',
 * });
 * try {
 *   console.log(handle.port, handle.capacity.effectiveContextSize);
 * } finally {
 *   await handle.stop();
 * }
 * ```
 */
export function startLlamaServerRunner(
  options: StartLlamaServerRunnerOptions
): Promise<LlamaServerHandle> {
  return startLlamaServerRunnerInternal(options, {});
}

/** Source-level test helper; intentionally omitted from the public package facade. */
export function startLlamaServerRunnerForTest(
  options: StartLlamaServerRunnerOptions,
  dependencies: LlamaServerRunnerTestDependencies
): Promise<LlamaServerHandle> {
  return startLlamaServerRunnerInternal(options, dependencies);
}
