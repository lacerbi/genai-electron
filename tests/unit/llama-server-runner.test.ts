import type { ChildProcess } from 'node:child_process';
import { jest } from '@jest/globals';

import {
  LlamaServerRunner,
  startLlamaServerRunner,
  type LlamaServerRunnerOptions,
} from '../../src/process/llama-server-runner.js';
import type { ModelInfo } from '../../src/types/index.js';
import type { SpawnOptions, SpawnResult } from '../../src/process/ProcessManager.js';

class FakeProcessManager {
  running = true;
  options?: SpawnOptions;
  killError?: Error;
  spawnStderr?: string;
  spawnError?: Error;
  spawnCount = 0;
  onSpawn?: (count: number, options?: SpawnOptions) => void;

  spawn(_command: string, _args: string[], options?: SpawnOptions): SpawnResult {
    this.spawnCount++;
    if (this.spawnError) throw this.spawnError;
    this.running = true;
    this.options = options;
    if (this.spawnStderr) options?.onStderr?.(this.spawnStderr);
    this.onSpawn?.(this.spawnCount, options);
    return { process: {} as ChildProcess, pid: 77 };
  }

  async kill(): Promise<void> {
    if (this.killError) throw this.killError;
    this.running = false;
    this.options?.onExit?.(0, null);
  }

  isRunning(): boolean {
    return this.running;
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
    config: { modelId: model.id, gpuLayers: 10 },
    contextSize: 12_288,
    parallelRequests: 2,
    startupTimeoutMs: 1_000,
    processManager,
    slotSavePath: 'C:\\temp\\calibration-slots',
  };
}

describe('LlamaServerRunner', () => {
  afterEach(() => jest.restoreAllMocks());

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
    expect(runner.pid).toBeUndefined();
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

    const runner = await startLlamaServerRunner(options(processManager));

    expect(processManager.spawnCount).toBe(2);
    await runner.stop();
  });

  it('treats unconfirmed teardown as fatal cleanup failure', async () => {
    const processManager = new FakeProcessManager();
    processManager.killError = new Error('access denied');
    const runner = new LlamaServerRunner(options(processManager), 12_345);
    (runner as unknown as { _pid: number })._pid = 77;

    await expect(runner.stop()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'CALIBRATION_CLEANUP_FAILED', pid: 77 }),
    });
  });
});
