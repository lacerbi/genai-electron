/** Lifecycle-neutral llama-server process used by runtime calibration. */

import { LLAMA_CALIBRATION_DEFAULTS } from '../config/defaults.js';
import { ServerError } from '../errors/index.js';
import type { LlamaServerConfig, ModelInfo } from '../types/index.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForHealthy } from './health-check.js';
import { fetchLlamaRuntimeCapacity, type LlamaRuntimeCapacity } from './llama-props.js';
import {
  buildLlamaServerArgs,
  normalizeLlamaVCacheConfig,
  type ResolvedLlamaServerConfig,
} from './llama-server-args.js';
import { findFreePort } from './port-utils.js';
import { ProcessManager, type SpawnOptions, type SpawnResult } from './ProcessManager.js';

interface RunnerProcessManager {
  spawn(command: string, args: string[], options?: SpawnOptions): SpawnResult;
  kill(pid: number, timeout?: number): Promise<void>;
  isRunning(pid: number): boolean;
}

export interface LlamaServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface LlamaServerRunnerOptions {
  binaryPath: string;
  model: ModelInfo;
  config: LlamaServerConfig;
  contextSize: number;
  parallelRequests: number;
  startupTimeoutMs: number;
  signal?: AbortSignal;
  stderrMaxBytes?: number;
  processManager?: RunnerProcessManager;
  /** Internal per-candidate directory required by b9860 slot erase. */
  slotSavePath?: string;
  /** Remove slotSavePath after confirmed teardown. */
  cleanupSlotSavePath?: boolean;
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

/** An isolated candidate process with local state and confirmed teardown. */
export class LlamaServerRunner {
  readonly port: number;
  readonly args: readonly string[];
  readonly config: ResolvedLlamaServerConfig;
  capacity?: LlamaRuntimeCapacity;
  loadTimeMs?: number;

  private readonly binaryPath: string;
  private readonly processManager: RunnerProcessManager;
  private readonly startupTimeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly lifecycleAbort = new AbortController();
  private readonly operationSignal: AbortSignal;
  private readonly stderrMaxBytes: number;
  private readonly slotSavePath?: string;
  private readonly cleanupSlotSavePath: boolean;
  private _pid?: number;
  private stderr = '';
  private stdout = '';
  private exitRecord?: LlamaServerExit;
  private resolveExit!: (exit: LlamaServerExit) => void;
  readonly exitPromise: Promise<LlamaServerExit>;

  constructor(options: LlamaServerRunnerOptions, port: number) {
    this.port = port;
    this.binaryPath = options.binaryPath;
    this.processManager = options.processManager ?? new ProcessManager();
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.signal = options.signal;
    this.operationSignal = options.signal
      ? AbortSignal.any([this.lifecycleAbort.signal, options.signal])
      : this.lifecycleAbort.signal;
    this.stderrMaxBytes = options.stderrMaxBytes ?? LLAMA_CALIBRATION_DEFAULTS.stderrMaxBytes;
    this.slotSavePath = options.slotSavePath;
    this.cleanupSlotSavePath = options.cleanupSlotSavePath === true;
    this.config = normalizeLlamaVCacheConfig({
      ...options.config,
      contextSize: options.contextSize,
      parallelRequests: options.parallelRequests,
      host: '127.0.0.1',
      port,
      fit: 'off',
      occupancyCheck: 'off',
      autoRestart: false,
      healthCheckInterval: 0,
    });
    this.args = buildLlamaServerArgs(this.config, options.model, {
      enableSlotsEndpoint: true,
      slotSavePath: this.slotSavePath,
    });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  get stdoutTail(): string {
    return this.stdout;
  }

  private settleExit(exit: LlamaServerExit): void {
    if (this.exitRecord) return;
    this.exitRecord = exit;
    this.lifecycleAbort.abort(this.crashError(exit));
    this.resolveExit(exit);
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

  /** Race an operation against candidate exit. */
  raceWithExit<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([
      operation,
      this.exitPromise.then((exit) => Promise.reject(this.crashError(exit))),
    ]);
  }

  /** Spawn, await health, and strictly verify the fixed capacity profile. */
  async start(): Promise<void> {
    this.signal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      const spawned = this.processManager.spawn(this.binaryPath, [...this.args], {
        onStdout: (data) => {
          this.stdout = boundedTail(this.stdout, data, this.stderrMaxBytes);
        },
        onStderr: (data) => {
          this.stderr = boundedTail(this.stderr, data, this.stderrMaxBytes);
        },
        onExit: (code, signal) => this.settleExit({ code, signal }),
        onError: (error) => this.settleExit({ code: null, signal: null, error: error.message }),
      });
      this._pid = spawned.pid;

      await this.raceWithExit(
        waitForHealthy(
          this.port,
          this.startupTimeoutMs,
          100,
          2_000,
          '127.0.0.1',
          this.operationSignal
        )
      );
      this.loadTimeMs = Date.now() - startedAt;
      try {
        this.capacity = await this.raceWithExit(
          fetchLlamaRuntimeCapacity(
            this.port,
            '127.0.0.1',
            this.config.parallelRequests!,
            Math.min(this.startupTimeoutMs, 5_000),
            this.operationSignal
          )
        );
      } catch (error) {
        const details = errorDetails(error);
        if (details.code === 'CALIBRATION_CANDIDATE_CRASHED') throw error;
        const cause = error instanceof Error ? error.message : String(error);
        throw new ServerError(`Could not verify the fixed calibration capacity profile: ${cause}`, {
          ...details,
          code: 'CALIBRATION_SLOTS_UNAVAILABLE',
          cause,
          stderrTail: this.stderr || undefined,
        });
      }

      if (this.capacity.totalSlots === undefined) {
        throw new ServerError('llama-server did not report total_slots during calibration', {
          code: 'CALIBRATION_SLOTS_UNAVAILABLE',
          suggestion: 'Use the pinned llama-server build with a compatible /props endpoint',
        });
      }
      const expectedPerSlot = Math.floor(this.config.contextSize! / this.config.parallelRequests!);
      if (this.capacity.effectiveContextSize !== expectedPerSlot) {
        throw new ServerError(
          `llama-server reported ${this.capacity.effectiveContextSize} context tokens per slot; expected ${expectedPerSlot}`,
          {
            code: 'CALIBRATION_SLOTS_UNAVAILABLE',
            configuredContextSize: this.config.contextSize,
            parallelRequests: this.config.parallelRequests,
            effectiveContextSize: this.capacity.effectiveContextSize,
          }
        );
      }
    } catch (error) {
      await this.stop();
      if (this.signal?.aborted) {
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

  /** Stop idempotently and require confirmed process disappearance. */
  async stop(): Promise<void> {
    if (!this.lifecycleAbort.signal.aborted) {
      this.lifecycleAbort.abort(new DOMException('Runner stopping', 'AbortError'));
    }
    const pid = this._pid;
    if (!pid || this.exitRecord || !this.processManager.isRunning(pid)) {
      await this.removeSlotSaveDirectory();
      return;
    }
    try {
      await this.processManager.kill(pid);
      const deadline = Date.now() + 2_000;
      while (this.processManager.isRunning(pid) && Date.now() < deadline) {
        await delay(25);
      }
      if (this.processManager.isRunning(pid)) {
        throw new Error('process is still alive after kill completed');
      }
      await Promise.race([this.exitPromise, delay(250)]);
      await this.removeSlotSaveDirectory();
    } catch (error) {
      throw new ServerError(`Could not confirm cleanup of calibration process ${pid}`, {
        code: 'CALIBRATION_CLEANUP_FAILED',
        pid,
        stderrTail: this.stderr,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removeSlotSaveDirectory(): Promise<void> {
    if (!this.cleanupSlotSavePath || !this.slotSavePath) return;
    await fs.rm(this.slotSavePath, { recursive: true, force: true }).catch(() => void 0);
  }

  isBindCollision(): boolean {
    return /address already in use|failed to bind|bind[^\n]*failed/i.test(this.stderr);
  }
}

/** Start a runner and retry the unavoidable ephemeral-port race once. */
export async function startLlamaServerRunner(
  options: LlamaServerRunnerOptions
): Promise<LlamaServerRunner> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await findFreePort('127.0.0.1');
    const slotSavePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'genai-electron-llama-calibration-')
    );
    const runner = new LlamaServerRunner(
      { ...options, slotSavePath, cleanupSlotSavePath: true },
      port
    );
    try {
      await runner.start();
      return runner;
    } catch (error) {
      lastError = error;
      if (!runner.isBindCollision() || attempt === 1) throw error;
    }
  }
  throw lastError;
}
