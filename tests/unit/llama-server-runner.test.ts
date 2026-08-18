import type { ChildProcess } from 'node:child_process';
import { jest } from '@jest/globals';

import {
  LlamaServerRunner,
  startLlamaServerRunnerForTest,
  type LlamaServerRunnerOptions,
  type StartLlamaServerRunnerOptions,
} from '../../src/process/llama-server-runner.js';
import { DEFAULT_TIMEOUTS, LLAMA_CALIBRATION_DEFAULTS } from '../../src/config/defaults.js';
import { PortInUseError } from '../../src/errors/index.js';
import type { ModelInfo } from '../../src/types/index.js';
import type { SpawnOptions, SpawnResult } from '../../src/process/ProcessManager.js';

class FakeProcessManager {
  running = true;
  options?: SpawnOptions;
  child?: ChildProcess;
  spawnedChildren: ChildProcess[] = [];
  killedChildren: ChildProcess[] = [];
  killError?: Error;
  spawnStderr?: string;
  spawnError?: Error;
  spawnCount = 0;
  killTimeouts: (number | undefined)[] = [];
  remainRunningAfterKill = false;
  emitExitOnKill = true;
  onSpawn?: (count: number, options?: SpawnOptions) => void;

  spawn(_command: string, _args: string[], options?: SpawnOptions): SpawnResult {
    this.spawnCount++;
    if (this.spawnError) throw this.spawnError;
    this.running = true;
    this.options = options;
    this.child = { exitCode: null, signalCode: null } as ChildProcess;
    this.spawnedChildren.push(this.child);
    if (this.spawnStderr) options?.onStderr?.(this.spawnStderr);
    this.onSpawn?.(this.spawnCount, options);
    return { process: this.child, pid: 76 + this.spawnCount };
  }

  async kill(child: ChildProcess, timeout?: number): Promise<void> {
    this.killedChildren.push(child);
    this.killTimeouts.push(timeout);
    if (this.killError) throw this.killError;
    this.running = this.remainRunningAfterKill;
    if (!this.running && this.emitExitOnKill) {
      this.options?.onExit?.(0, null);
    }
  }

  isRunning(child: ChildProcess): boolean {
    return child === this.child && this.running;
  }
}

const model = {
  id: 'model',
  name: 'Model',
  type: 'llm',
  size: 100,
  path: 'C:\\models\\model.gguf',
  downloadedAt: '2026-01-01T00:00:00.000Z',
  source: { type: 'url', url: 'https://example.test/model' },
} satisfies ModelInfo;

function options(processManager: FakeProcessManager): LlamaServerRunnerOptions {
  return {
    binaryPath: 'llama-server',
    model,
    config: { host: '127.0.0.1', gpuLayers: 10 },
    contextSize: 12_288,
    parallelRequests: 2,
    startupTimeoutMs: 1_000,
    processManager,
    childController: processManager,
    slotsEndpoint: 'enabled',
    slotSavePath: 'C:\\temp\\calibration-slots',
  };
}

function publicOptions(): StartLlamaServerRunnerOptions {
  return {
    binaryPath: 'llama-server',
    model,
    config: { host: '127.0.0.1', gpuLayers: 10 },
    contextSize: 12_288,
    parallelRequests: 2,
    startupTimeoutMs: 1_000,
    slotsEndpoint: 'enabled',
    slotSavePath: 'C:\\temp\\calibration-slots',
  };
}

function factoryDependencies(processManager: FakeProcessManager) {
  return {
    processManager,
    childController: processManager,
    findFreePort: async () => 12_345,
    isPortBindable: async () => true,
    isServerResponding: async () => false,
  };
}

describe('LlamaServerRunner', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts locally, enables slots, and verifies exact per-slot capacity', async () => {
    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_slots: 2,
            default_generation_settings: { n_ctx: 6144 },
          })
        )
      );
    const runner = new LlamaServerRunner(options(processManager), 12_345);

    await runner.start();

    expect(runner.pid).toBe(77);
    expect(runner.args).toEqual(
      expect.arrayContaining([
        '--host',
        '127.0.0.1',
        '-c',
        '12288',
        '-np',
        '2',
        '--slots',
        '--slot-save-path',
        'C:\\temp\\calibration-slots',
      ])
    );
    expect(runner.capacity).toEqual({ effectiveContextSize: 6144, totalSlots: 2 });
    await runner.stop();
    expect(processManager.running).toBe(false);
    expect(processManager.killTimeouts).toEqual([DEFAULT_TIMEOUTS.serverStop]);
  });

  it('fails when total slot evidence is missing and cleans up', async () => {
    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_generation_settings: { n_ctx: 6144 } }))
      );
    const runner = new LlamaServerRunner(options(processManager), 12_345);

    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SLOTS_UNAVAILABLE' }),
    });
    expect(processManager.running).toBe(false);
  });

  it('caps the capacity check with the shared calibration timeout', async () => {
    jest.useFakeTimers();
    const processManager = new FakeProcessManager();
    let propsAborted = false;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              propsAborted = true;
              reject(init.signal?.reason);
            });
          })
      );
    const runner = new LlamaServerRunner(
      {
        ...options(processManager),
        startupTimeoutMs: LLAMA_CALIBRATION_DEFAULTS.capacityCheckTimeoutCapMs + 1_000,
      },
      12_345
    );

    const pending = runner.start();
    const failure = expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_SLOTS_UNAVAILABLE' }),
    });
    await jest.advanceTimersByTimeAsync(LLAMA_CALIBRATION_DEFAULTS.capacityCheckTimeoutCapMs - 1);
    expect(propsAborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await failure;
    expect(propsAborted).toBe(true);
  });

  it('races readiness against early process exit', async () => {
    const processManager = new FakeProcessManager();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    queueMicrotask(() => {
      processManager.running = false;
      processManager.options?.onStderr?.('backend failed');
      processManager.options?.onExit?.(1, null);
    });

    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CANDIDATE_CRASHED' }),
    });
    expect(runner.stderrTail).toContain('backend failed');
  });

  it('surfaces a synchronous spawn failure without retaining a PID', async () => {
    const processManager = new FakeProcessManager();
    processManager.spawnError = new Error('spawn failed');
    const runner = new LlamaServerRunner(options(processManager), 12_345);

    await expect(runner.start()).rejects.toThrow('spawn failed');
    expect(() => runner.pid).toThrow(/unavailable before successful startup/);
  });

  it('preserves stderr when readiness times out before the process exits', async () => {
    const processManager = new FakeProcessManager();
    processManager.spawnStderr = 'CUDA out of memory';
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'loading' })));
    const runner = new LlamaServerRunner(
      { ...options(processManager), startupTimeoutMs: 1 },
      12_345
    );

    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ stderrTail: 'CUDA out of memory' }),
    });
    expect(processManager.running).toBe(false);
  });

  it('aborts readiness and confirms child cleanup', async () => {
    const processManager = new FakeProcessManager();
    const controller = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const runner = new LlamaServerRunner(
      { ...options(processManager), signal: controller.signal },
      12_345
    );
    const pending = runner.start();
    controller.abort('test abort');

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_ABORTED' }),
    });
    expect(processManager.running).toBe(false);
  });

  it.each([
    ['a props HTTP failure', new Response('', { status: 500 }), /\/props returned HTTP 500/],
    [
      'a slot mismatch',
      new Response(
        JSON.stringify({
          total_slots: 3,
          default_generation_settings: { n_ctx: 6144 },
        })
      ),
      /reported 3 slots/,
    ],
  ])('cleans up after %s', async (_label, propsResponse, expected) => {
    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(propsResponse as Response);
    const runner = new LlamaServerRunner(options(processManager), 12_345);

    await expect(runner.start()).rejects.toThrow(expected as RegExp);
    expect(processManager.running).toBe(false);
  });

  it('races an in-flight request against process exit', async () => {
    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    await runner.start();

    const pending = runner.raceWithExit(new Promise<never>(() => undefined));
    processManager.running = false;
    processManager.options?.onExit?.(1, null);

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CANDIDATE_CRASHED' }),
    });
    await runner.stop();
  });

  it('retries one proven bind collision with a fresh runner', async () => {
    const processManager = new FakeProcessManager();
    processManager.onSpawn = (count, spawnOptions) => {
      if (count === 1) {
        queueMicrotask(() => {
          processManager.running = false;
          spawnOptions?.onStderr?.('failed to bind: address already in use');
          spawnOptions?.onExit?.(1, null);
        });
      }
    };
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );

    const runner = await startLlamaServerRunnerForTest(
      publicOptions(),
      factoryDependencies(processManager)
    );

    expect(processManager.spawnCount).toBe(LLAMA_CALIBRATION_DEFAULTS.maxRunnerStartAttempts);
    await runner.stop();
  });

  it('never retries a bind collision when cleanup of the first process is unconfirmed', async () => {
    const processManager = new FakeProcessManager();
    processManager.spawnStderr = 'failed to bind: address already in use';
    processManager.killError = new Error('access denied');
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_generation_settings: { n_ctx: 6144 } }))
      );

    await expect(
      startLlamaServerRunnerForTest(publicOptions(), factoryDependencies(processManager))
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 77 }),
    });
    expect(processManager.spawnCount).toBe(1);
  });

  it('treats unconfirmed teardown as fatal cleanup failure', async () => {
    const processManager = new FakeProcessManager();
    processManager.killError = new Error('access denied');
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    processManager.spawnError = undefined;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    await runner.start();
    processManager.killError = new Error('access denied');

    await expect(runner.stop()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 77 }),
    });
  });

  it('treats leftover temporary slot state as a fatal cleanup failure', async () => {
    const processManager = new FakeProcessManager();
    const runner = new LlamaServerRunner(
      {
        ...options(processManager),
        cleanupSlotSavePath: true,
        slotSaveDirectoryRemover: async () => {
          throw new Error('directory is locked');
        },
      },
      12_345
    );
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    await runner.start();

    await expect(runner.stop()).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'CALIBRATION_CLEANUP_FAILED',
        pid: 77,
        cause: 'directory is locked',
      }),
    });
  });

  it('uses the shared confirmation deadline when teardown leaves the process running', async () => {
    jest.useFakeTimers();
    const processManager = new FakeProcessManager();
    processManager.remainRunningAfterKill = true;
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    await runner.start();

    const pending = runner.stop();
    const failure = expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 77 }),
    });
    await jest.advanceTimersByTimeAsync(LLAMA_CALIBRATION_DEFAULTS.processExitConfirmationMs - 1);
    expect(processManager.running).toBe(true);
    await jest.advanceTimersByTimeAsync(1);

    await failure;
  });

  it('uses the shared exit-settle grace when no exit callback arrives', async () => {
    jest.useFakeTimers();
    const processManager = new FakeProcessManager();
    processManager.emitExitOnKill = false;
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    await runner.start();
    let settled = false;

    const pending = runner.stop().then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(LLAMA_CALIBRATION_DEFAULTS.processExitSettleGraceMs - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toBe(true);
  });

  it('preserves production defaults, cwd, and caller-owned slot state', async () => {
    const processManager = new FakeProcessManager();
    const remove = jest.fn(async () => undefined);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = new LlamaServerRunner(
      {
        binaryPath: 'llama-server',
        model,
        config: { gpuLayers: 10 },
        contextSize: 12_288,
        parallelRequests: 2,
        startupTimeoutMs: 1_000,
        cwd: 'C:\\runtime',
        processManager,
        childController: processManager,
        slotSaveDirectoryRemover: remove,
      },
      12_345
    );

    await runner.start();

    expect(runner.args).not.toEqual(expect.arrayContaining(['--host']));
    expect(runner.args).not.toEqual(expect.arrayContaining(['--slots']));
    expect(runner.args).not.toEqual(expect.arrayContaining(['--no-slots']));
    expect(runner.args).not.toEqual(expect.arrayContaining(['--slot-save-path']));
    expect(processManager.options?.cwd).toBe('C:\\runtime');
    await runner.stop();
    expect(remove).not.toHaveBeenCalled();
    expect(processManager.killedChildren[0]).toBe(processManager.spawnedChildren[0]);
  });

  it('emits --no-slots while retaining mandatory capacity verification', async () => {
    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = new LlamaServerRunner(
      {
        ...options(processManager),
        slotsEndpoint: 'disabled',
        slotSavePath: undefined,
      },
      12_345
    );

    await runner.start();
    expect(runner.args).toContain('--no-slots');
    expect(runner.capacity.totalSlots).toBe(2);
    await runner.stop();
  });

  it.each([
    [{ contextSize: 0 }, 'contextSize'],
    [{ parallelRequests: Number.NaN }, 'parallelRequests'],
    [{ startupTimeoutMs: -1 }, 'startupTimeoutMs'],
    [{ stderrMaxBytes: 0 }, 'stderrMaxBytes'],
    [{ port: 65_536 }, 'port'],
    [{ config: { host: '' } }, 'host'],
    [{ config: { host: ' ::1 ' } }, 'host'],
  ])('rejects invalid options before side effects: %s', async (override, option) => {
    const processManager = new FakeProcessManager();
    const createDirectory = jest.fn(async () => 'C:\\temp\\owned');
    const responding = jest.fn(async () => false);
    const bindable = jest.fn(async () => true);

    await expect(
      startLlamaServerRunnerForTest(
        { ...publicOptions(), temporarySlotSavePath: false, slotSavePath: undefined, ...override },
        {
          ...factoryDependencies(processManager),
          temporaryDirectoryCreator: createDirectory,
          isServerResponding: responding,
          isPortBindable: bindable,
        }
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ option }),
    });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(responding).not.toHaveBeenCalled();
    expect(bindable).not.toHaveBeenCalled();
    expect(processManager.spawnCount).toBe(0);
  });

  it.each([
    [{ slotsEndpoint: 'disabled' as const, slotSavePath: 'C:\\slots' }],
    [{ slotsEndpoint: 'disabled' as const, temporarySlotSavePath: true }],
    [{ slotsEndpoint: 'default' as const, temporarySlotSavePath: true }],
    [
      {
        slotsEndpoint: 'enabled' as const,
        slotSavePath: 'C:\\slots',
        temporarySlotSavePath: true,
      },
    ],
  ])('rejects incompatible slot options before spawn', async (override) => {
    const processManager = new FakeProcessManager();
    await expect(
      startLlamaServerRunnerForTest(
        { ...publicOptions(), slotSavePath: undefined, ...override },
        factoryDependencies(processManager)
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'INVALID_LLAMA_SERVER_RUNNER_OPTIONS' }),
    });
    expect(processManager.spawnCount).toBe(0);
  });

  it('checks fixed-port HTTP occupancy and bindability without retrying', async () => {
    const occupiedManager = new FakeProcessManager();
    const occupied = jest.fn(async () => true);
    const bindable = jest.fn(async () => true);
    await expect(
      startLlamaServerRunnerForTest(
        { ...publicOptions(), port: 12_345 },
        {
          ...factoryDependencies(occupiedManager),
          isServerResponding: occupied,
          isPortBindable: bindable,
        }
      )
    ).rejects.toBeInstanceOf(PortInUseError);
    expect(occupied).toHaveBeenCalledWith(12_345, 2_000, '127.0.0.1');
    expect(bindable).not.toHaveBeenCalled();
    expect(occupiedManager.spawnCount).toBe(0);

    const boundManager = new FakeProcessManager();
    await expect(
      startLlamaServerRunnerForTest(
        { ...publicOptions(), port: 12_345 },
        {
          ...factoryDependencies(boundManager),
          isServerResponding: async () => false,
          isPortBindable: async () => false,
        }
      )
    ).rejects.toBeInstanceOf(PortInUseError);
    expect(boundManager.spawnCount).toBe(0);
  });

  it.each([
    ['::', '::1', 'http://[::1]:12345/health', 'http://[::1]:12345/props'],
    ['::1', '::1', 'http://[::1]:12345/health', 'http://[::1]:12345/props'],
    ['0.0.0.0', '127.0.0.1', 'http://127.0.0.1:12345/health', 'http://127.0.0.1:12345/props'],
  ])(
    'uses bind host %s and reachable HTTP host %s',
    async (host, connectHost, healthUrl, propsUrl) => {
      const processManager = new FakeProcessManager();
      const responding = jest.fn(async () => false);
      const bindable = jest.fn(async () => true);
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
          )
        );

      const runner = await startLlamaServerRunnerForTest(
        { ...publicOptions(), config: { host }, port: 12_345 },
        {
          ...factoryDependencies(processManager),
          isServerResponding: responding,
          isPortBindable: bindable,
        }
      );

      expect(responding).toHaveBeenCalledWith(12_345, 2_000, connectHost);
      expect(bindable).toHaveBeenCalledWith(12_345, host);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(1, healthUrl, expect.any(Object));
      expect(globalThis.fetch).toHaveBeenNthCalledWith(2, propsUrl, expect.any(Object));
      await runner.stop();
    }
  );

  it('uses one fixed-port launch attempt and propagates non-occupancy bind errors', async () => {
    const bindError = Object.assign(new Error('bad interface'), { code: 'EADDRNOTAVAIL' });
    const failedManager = new FakeProcessManager();
    await expect(
      startLlamaServerRunnerForTest(
        { ...publicOptions(), port: 12_345 },
        {
          ...factoryDependencies(failedManager),
          isPortBindable: async () => {
            throw bindError;
          },
        }
      )
    ).rejects.toBe(bindError);

    const processManager = new FakeProcessManager();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = await startLlamaServerRunnerForTest(
      { ...publicOptions(), port: 12_345 },
      factoryDependencies(processManager)
    );
    expect(processManager.spawnCount).toBe(1);
    await runner.stop();
  });

  it('rejects duplicate, concurrent, and post-stop starts without respawning', async () => {
    const processManager = new FakeProcessManager();
    let releaseHealth!: () => void;
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseHealth = () => resolve(new Response(JSON.stringify({ status: 'ok' })));
          })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    const first = runner.start();
    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'LLAMA_SERVER_RUNNER_INVALID_STATE' }),
    });
    releaseHealth();
    await first;
    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'LLAMA_SERVER_RUNNER_INVALID_STATE' }),
    });
    await runner.stop();
    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'LLAMA_SERVER_RUNNER_INVALID_STATE' }),
    });
    expect(processManager.spawnCount).toBe(1);
  });

  it('shares concurrent stop and removes factory-owned state exactly once', async () => {
    const processManager = new FakeProcessManager();
    const remove = jest.fn(async () => undefined);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = await startLlamaServerRunnerForTest(
      {
        ...publicOptions(),
        slotSavePath: undefined,
        temporarySlotSavePath: true,
      },
      {
        ...factoryDependencies(processManager),
        temporaryDirectoryCreator: async () => 'C:\\temp\\owned',
        slotSaveDirectoryRemover: remove,
      }
    );

    const first = runner.stop();
    const second = runner.stop();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await expect(runner.exitPromise).resolves.toEqual({ code: 0, signal: null });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('treats the caller signal as startup-only after the factory resolves', async () => {
    const processManager = new FakeProcessManager();
    const controller = new AbortController();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = await startLlamaServerRunnerForTest(
      { ...publicOptions(), signal: controller.signal },
      factoryDependencies(processManager)
    );

    controller.abort('too late');
    await Promise.resolve();
    expect(processManager.running).toBe(true);
    expect(processManager.killedChildren).toHaveLength(0);
    await runner.stop();
  });

  it('cleans owned state on spontaneous exit and shares cleanup failure with stop', async () => {
    const processManager = new FakeProcessManager();
    const cleanupFailure = new Error('directory locked');
    const remove = jest.fn(async () => {
      throw cleanupFailure;
    });
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = await startLlamaServerRunnerForTest(
      { ...publicOptions(), slotSavePath: undefined, temporarySlotSavePath: true },
      {
        ...factoryDependencies(processManager),
        temporaryDirectoryCreator: async () => 'C:\\temp\\owned',
        slotSaveDirectoryRemover: remove,
      }
    );
    processManager.running = false;
    processManager.options?.onExit?.(1, null);

    const exitFailure = await runner.exitPromise.catch((error: unknown) => error);
    const stopFailure = await runner.stop().catch((error: unknown) => error);
    expect(exitFailure).toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED' }),
    });
    expect(stopFailure).toBe(exitFailure);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not treat a nonterminal child error as confirmed exit', async () => {
    const processManager = new FakeProcessManager();
    const remove = jest.fn(async () => undefined);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 6144 } })
        )
      );
    const runner = new LlamaServerRunner(
      {
        ...options(processManager),
        cleanupSlotSavePath: true,
        slotSaveDirectoryRemover: remove,
      },
      12_345
    );
    await runner.start();
    let exited = false;
    void runner.exitPromise.then(() => {
      exited = true;
    });

    processManager.options?.onError?.(new Error('failed to send signal'));
    await Promise.resolve();

    expect(processManager.running).toBe(true);
    expect(exited).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(runner.stderrTail).toContain('failed to send signal');
    await runner.stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('classifies exit during props immediately even while owned cleanup is pending', async () => {
    const processManager = new FakeProcessManager();
    let announceProps!: () => void;
    let releaseCleanup!: () => void;
    const propsStarted = new Promise<void>((resolve) => {
      announceProps = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const remove = jest.fn(async () => cleanupGate);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            announceProps();
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      );
    const runner = new LlamaServerRunner(
      {
        ...options(processManager),
        cleanupSlotSavePath: true,
        slotSaveDirectoryRemover: remove,
      },
      12_345
    );
    const pending = runner.start();
    await propsStarted;

    processManager.running = false;
    processManager.options?.onExit?.(1, null);
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    releaseCleanup();

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CANDIDATE_CRASHED' }),
    });
  });

  it('removes factory-created state after constructor failure and avoids creating it on pre-abort', async () => {
    const processManager = new FakeProcessManager();
    const remove = jest.fn(async () => undefined);
    await expect(
      startLlamaServerRunnerForTest(
        {
          ...publicOptions(),
          config: { cacheTypeV: 'q8_0', flashAttention: 'off' },
          slotSavePath: undefined,
          temporarySlotSavePath: true,
        },
        {
          ...factoryDependencies(processManager),
          temporaryDirectoryCreator: async () => 'C:\\temp\\owned',
          slotSaveDirectoryRemover: remove,
        }
      )
    ).rejects.toThrow(/requires flash attention/);
    expect(remove).toHaveBeenCalledWith('C:\\temp\\owned');

    const controller = new AbortController();
    controller.abort('already aborted');
    const create = jest.fn(async () => 'C:\\temp\\never-created');
    await expect(
      startLlamaServerRunnerForTest(
        {
          ...publicOptions(),
          signal: controller.signal,
          slotSavePath: undefined,
          temporarySlotSavePath: true,
        },
        {
          ...factoryDependencies(new FakeProcessManager()),
          temporaryDirectoryCreator: create,
        }
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_ABORTED' }),
    });
    expect(create).not.toHaveBeenCalled();
  });
});
