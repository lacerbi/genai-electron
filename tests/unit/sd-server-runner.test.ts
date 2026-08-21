import type { ChildProcess } from 'node:child_process';
import { jest } from '@jest/globals';

import {
  SD_SERVER_STDOUT_MARKERS,
  SdServerRunner,
  isSdServerProgressBarLine,
  startSdServerRunnerForTest,
  type SdServerHandle,
  type SdServerRunnerTestDependencies,
  type SdServerStdoutEvent,
  type StartSdServerRunnerOptions,
} from '../../src/process/sd-server-runner.js';
import { DIFFUSION_BACKEND_DEFAULTS } from '../../src/config/defaults.js';
import { PortInUseError } from '../../src/errors/index.js';
import type { SpawnOptions, SpawnResult } from '../../src/process/ProcessManager.js';

class FakeChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

class FakeProcessManager {
  spawnCount = 0;
  commands: string[] = [];
  argsList: string[][] = [];
  spawnedChildren: FakeChild[] = [];
  killedChildren: FakeChild[] = [];
  killTimeouts: (number | undefined)[] = [];
  lastOptions: SpawnOptions = {};
  lastChild?: FakeChild;
  killError?: Error;
  remainRunningAfterKill = false;
  emitExitOnKill = true;
  onSpawn?: (count: number, options: SpawnOptions) => void;

  private readonly alive = new Map<FakeChild, boolean>();

  spawn(command: string, args: string[], options: SpawnOptions = {}): SpawnResult {
    this.spawnCount++;
    const child = new FakeChild();
    this.commands.push(command);
    this.argsList.push(args);
    this.spawnedChildren.push(child);
    this.alive.set(child, true);
    this.lastChild = child;
    this.lastOptions = options;
    this.onSpawn?.(this.spawnCount, options);
    return { process: child as unknown as ChildProcess, pid: 4_000 + this.spawnCount };
  }

  async kill(child: ChildProcess, timeout?: number): Promise<void> {
    const fake = child as unknown as FakeChild;
    this.killedChildren.push(fake);
    this.killTimeouts.push(timeout);
    if (this.killError) throw this.killError;
    if (this.remainRunningAfterKill) return;
    this.alive.set(fake, false);
    if (this.emitExitOnKill) this.lastOptions.onExit?.(0, null);
  }

  isRunning(child: ChildProcess): boolean {
    return this.alive.get(child as unknown as FakeChild) === true;
  }

  /** Emit an exit for the most recently spawned child. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.lastChild) this.alive.set(this.lastChild, false);
    this.lastOptions.onExit?.(code, signal);
  }

  stdout(data: string): void {
    this.lastOptions.onStdout?.(data);
  }

  stderr(data: string): void {
    this.lastOptions.onStderr?.(data);
  }
}

function publicOptions(
  overrides: Partial<StartSdServerRunnerOptions> = {}
): StartSdServerRunnerOptions {
  return {
    binaryPath: '/opt/sd/sd-server',
    modelArgs: ['--diffusion-model', '/models/flux.gguf', '--vae', '/models/vae.gguf'],
    contextArgs: ['--offload-to-cpu', '--diffusion-fa'],
    loraDir: '/userData/loras',
    threads: 8,
    readyTimeoutMs: 1_000,
    ...overrides,
  };
}

function dependencies(
  processManager: FakeProcessManager,
  overrides: Partial<SdServerRunnerTestDependencies> = {}
): SdServerRunnerTestDependencies {
  let nextPort = 12_345;
  return {
    processManager,
    childController: processManager,
    findFreePort: async () => nextPort++,
    isPortBindable: async () => true,
    fetchCapabilities: async () => true,
    ...overrides,
  };
}

/** Never-settling probe that rejects only when its signal aborts. */
const pendingProbe = (_port: number, _host: string, signal?: AbortSignal): Promise<boolean> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as unknown));
  });

async function startReady(
  processManager: FakeProcessManager,
  overrides: Partial<StartSdServerRunnerOptions> = {},
  depOverrides: Partial<SdServerRunnerTestDependencies> = {}
): Promise<SdServerHandle> {
  return startSdServerRunnerForTest(
    publicOptions(overrides),
    dependencies(processManager, depOverrides)
  );
}

describe('startSdServerRunner argv and launch shape', () => {
  it('builds the exact argv and never emits --color', async () => {
    const processManager = new FakeProcessManager();

    const handle = await startReady(processManager);

    expect(processManager.commands[0]).toBe('/opt/sd/sd-server');
    expect(handle.args).toEqual([
      '--diffusion-model',
      '/models/flux.gguf',
      '--vae',
      '/models/vae.gguf',
      '--offload-to-cpu',
      '--diffusion-fa',
      '-t',
      '8',
      '--listen-ip',
      '127.0.0.1',
      '--listen-port',
      '12345',
      '--lora-model-dir',
      '/userData/loras',
    ]);
    expect(handle.args).not.toContain('--color');
    expect(handle.port).toBe(12_345);
    expect(handle.host).toBe('127.0.0.1');
    expect(handle.pid).toBe(4_001);
    expect(handle.state).toBe('running');
    await handle.stop();
  });

  it('omits -t when no positive thread count is given', async () => {
    const processManager = new FakeProcessManager();

    const handle = await startReady(processManager, { threads: undefined });
    expect(handle.args).not.toContain('-t');
    await handle.stop();

    const zeroThreads = new FakeProcessManager();
    const zeroHandle = await startReady(zeroThreads, { threads: 0 });
    expect(zeroHandle.args).not.toContain('-t');
    await zeroHandle.stop();
  });

  it('defaults cwd to the binary directory and honours an explicit cwd', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);
    expect(processManager.lastOptions.cwd).toBe('/opt/sd');
    await handle.stop();

    const custom = new FakeProcessManager();
    const customHandle = await startReady(custom, { cwd: '/elsewhere' });
    expect(custom.lastOptions.cwd).toBe('/elsewhere');
    await customHandle.stop();
  });

  it('binds and probes a caller-supplied host', async () => {
    const processManager = new FakeProcessManager();
    const probed: { port: number; host: string }[] = [];

    const handle = await startReady(
      processManager,
      { host: '0.0.0.0' },
      {
        fetchCapabilities: async (port, host) => {
          probed.push({ port, host });
          return true;
        },
      }
    );

    expect(handle.args).toEqual(expect.arrayContaining(['--listen-ip', '0.0.0.0']));
    expect(probed).toEqual([{ port: 12_345, host: '0.0.0.0' }]);
    await handle.stop();
  });

  it('records the spawn-to-ready duration', async () => {
    const processManager = new FakeProcessManager();
    let ready = false;
    const handle = await startReady(
      processManager,
      {},
      { fetchCapabilities: async () => (ready ? true : ((ready = true), false)) }
    );

    expect(handle.loadTimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(handle.loadTimeMs)).toBe(true);
    await handle.stop();
  });

  it('rejects a fixed port that cannot be bound and never spawns', async () => {
    const processManager = new FakeProcessManager();

    await expect(
      startSdServerRunnerForTest(
        publicOptions({ port: 8_099 }),
        dependencies(processManager, { isPortBindable: async () => false })
      )
    ).rejects.toBeInstanceOf(PortInUseError);
    expect(processManager.spawnCount).toBe(0);
  });

  it.each([
    [{ binaryPath: '  ' }, 'binaryPath'],
    [{ loraDir: '' }, 'loraDir'],
    [{ host: ' 127.0.0.1 ' }, 'host'],
    [{ port: 70_000 }, 'port'],
    [{ readyTimeoutMs: 0 }, 'readyTimeoutMs'],
    [{ threads: -1 }, 'threads'],
  ] as [Partial<StartSdServerRunnerOptions>, string][])(
    'rejects invalid options before any side effect: %s',
    async (override, option) => {
      const processManager = new FakeProcessManager();
      const bindable = jest.fn(async () => true);

      await expect(
        startSdServerRunnerForTest(
          publicOptions(override),
          dependencies(processManager, { isPortBindable: bindable })
        )
      ).rejects.toMatchObject({
        details: expect.objectContaining({
          code: 'INVALID_SD_SERVER_RUNNER_OPTIONS',
          option,
        }),
      });
      expect(bindable).not.toHaveBeenCalled();
      expect(processManager.spawnCount).toBe(0);
    }
  );
});

describe('startSdServerRunner readiness', () => {
  it('polls capabilities until the backend answers', async () => {
    const processManager = new FakeProcessManager();
    let attempts = 0;

    const handle = await startReady(
      processManager,
      {},
      {
        fetchCapabilities: async () => {
          attempts++;
          return attempts >= 3;
        },
      }
    );

    expect(attempts).toBe(3);
    expect(handle.state).toBe('running');
    await handle.stop();
  });

  it('rejects with the exit code and stderr tail when the backend dies before ready', async () => {
    const processManager = new FakeProcessManager();
    processManager.onSpawn = () => {
      queueMicrotask(() => {
        processManager.stderr('CUDA error: out of memory\n');
        processManager.exit(1, null);
      });
    };

    await expect(
      startSdServerRunnerForTest(
        publicOptions(),
        dependencies(processManager, { fetchCapabilities: pendingProbe })
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'SD_SERVER_EXITED',
        exitCode: 1,
        stderrTail: expect.stringContaining('CUDA error: out of memory'),
      }),
    });
    expect(processManager.spawnCount).toBe(1);
  });

  it('kills the child and reports SD_SERVER_READY_TIMEOUT when readiness never arrives', async () => {
    const processManager = new FakeProcessManager();

    await expect(
      startSdServerRunnerForTest(
        publicOptions({ readyTimeoutMs: 1 }),
        dependencies(processManager, { fetchCapabilities: async () => false })
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_READY_TIMEOUT', timeoutMs: 1 }),
    });
    expect(processManager.killedChildren).toHaveLength(1);
    expect(
      processManager.isRunning(processManager.spawnedChildren[0] as unknown as ChildProcess)
    ).toBe(false);
  });

  it('retries one proven bind collision on a fresh free port', async () => {
    const processManager = new FakeProcessManager();
    processManager.onSpawn = (count) => {
      if (count !== 1) return;
      queueMicrotask(() => {
        processManager.stderr('failed to bind: address already in use\n');
        processManager.exit(1, null);
      });
    };

    const handle = await startSdServerRunnerForTest(
      publicOptions(),
      dependencies(processManager, {
        fetchCapabilities: async (port) => port === 12_346,
      })
    );

    expect(processManager.spawnCount).toBe(2);
    expect(handle.port).toBe(12_346);
    expect(processManager.argsList[1]).toEqual(expect.arrayContaining(['--listen-port', '12346']));
    await handle.stop();
  });

  it('never retries when the port was chosen by the caller', async () => {
    const processManager = new FakeProcessManager();
    processManager.onSpawn = () => {
      queueMicrotask(() => {
        processManager.stderr('failed to bind: address already in use\n');
        processManager.exit(1, null);
      });
    };

    await expect(
      startSdServerRunnerForTest(
        publicOptions({ port: 8_099 }),
        dependencies(processManager, { fetchCapabilities: pendingProbe })
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_EXITED' }),
    });
    expect(processManager.spawnCount).toBe(1);
  });

  it('aborts startup through the caller signal and never spawns when pre-aborted', async () => {
    const processManager = new FakeProcessManager();
    const controller = new AbortController();
    const pending = startSdServerRunnerForTest(
      publicOptions({ signal: controller.signal }),
      dependencies(processManager, { fetchCapabilities: pendingProbe })
    );
    controller.abort('user cancelled');

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_START_ABORTED' }),
    });
    expect(
      processManager.isRunning(processManager.spawnedChildren[0] as unknown as ChildProcess)
    ).toBe(false);

    const preAborted = new AbortController();
    preAborted.abort('already gone');
    const untouched = new FakeProcessManager();
    await expect(
      startSdServerRunnerForTest(
        publicOptions({ signal: preAborted.signal }),
        dependencies(untouched)
      )
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_START_ABORTED' }),
    });
    expect(untouched.spawnCount).toBe(0);
  });

  it('rejects a second start on the same runner instance', async () => {
    const processManager = new FakeProcessManager();
    const runner = new SdServerRunner(
      {
        ...publicOptions(),
        processManager,
        childController: processManager,
        fetchCapabilities: async () => true,
      },
      12_345
    );
    await runner.start();

    await expect(runner.start()).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_RUNNER_INVALID_STATE' }),
    });
    expect(processManager.spawnCount).toBe(1);
    await runner.stop();
  });
});

describe('sd-server stdout tap', () => {
  async function tapped(processManager: FakeProcessManager) {
    const events: SdServerStdoutEvent[] = [];
    const logs: { line: string; stream: 'stdout' | 'stderr' }[] = [];
    const handle = await startReady(processManager, {
      onStdoutEvent: (event) => events.push(event),
      onLog: (line, stream) => logs.push({ line, stream }),
    });
    return { handle, events, logs };
  }

  it('buffers partial lines across chunk boundaries', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('  |1/');
    expect(events).toHaveLength(0);
    processManager.stdout('4 - 1.00it/s\n');

    expect(events).toEqual([{ type: 'step', step: 1, steps: 4 }]);
    await handle.stop();
  });

  it('emits one step event per bar frame when a chunk carries several \\r-separated bars', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('  |1/4 - 1.00it/s\r  |2/4 - 1.10it/s\r  |3/4 - 1.20it/s\r');

    expect(events).toEqual([
      { type: 'step', step: 1, steps: 4 },
      { type: 'step', step: 2, steps: 4 },
      { type: 'step', step: 3, steps: 4 },
    ]);
    await handle.stop();
  });

  it('emits one step event per match when several bars share a single line', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('  |1/4 - 1.00it/s|2/4 - 1.10it/s\n');

    expect(events).toEqual([
      { type: 'step', step: 1, steps: 4 },
      { type: 'step', step: 2, steps: 4 },
    ]);
    await handle.stop();
  });

  it('clamps a bar that overshoots its own total (upstream #1884)', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('  |21/20 - 1.00it/s\n  |0/0 - 1.00it/s\n');

    expect(events).toEqual([{ type: 'step', step: 20, steps: 20 }]);
    await handle.stop();
  });

  it('separates byte bars from step bars', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('  |512/1024 - 25.00MB/s\n');
    processManager.stdout('  |7/8 - 3.20s/it\n');

    expect(events).toEqual([
      { type: 'bytes', done: 512, total: 1024 },
      { type: 'step', step: 7, steps: 8 },
    ]);
    await handle.stop();
  });

  it('emits every marker in the exported table, including the listening hint', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('sd-server listening on: 127.0.0.1:12345\n');
    processManager.stdout('generating image: 1/1 - seed 42\n');
    processManager.stdout('sampling using Euler method\n');
    processManager.stdout('decoding 1 latents\n');
    processManager.stdout('decode_first_stage completed, taking 0.44s\n');
    processManager.stdout('generate_image completed in 11.20s\n');

    expect(events).toEqual([
      { type: 'marker', marker: 'listening' },
      { type: 'marker', marker: 'generating' },
      { type: 'marker', marker: 'generating' },
      { type: 'marker', marker: 'decoding' },
      { type: 'marker', marker: 'decoded' },
      { type: 'marker', marker: 'completed' },
    ]);
    expect(new Set(SD_SERVER_STDOUT_MARKERS.map((entry) => entry.marker))).toEqual(
      new Set(events.map((event) => (event.type === 'marker' ? event.marker : 'step')))
    );
    await handle.stop();
  });

  it('taps stderr as well as stdout and forwards complete lines to onLog', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events, logs } = await tapped(processManager);

    processManager.stderr('decoding 1 latents\n');
    processManager.stdout('generate_image completed\n');

    expect(events).toEqual([
      { type: 'marker', marker: 'decoding' },
      { type: 'marker', marker: 'completed' },
    ]);
    expect(logs).toEqual([
      { line: 'decoding 1 latents', stream: 'stderr' },
      { line: 'generate_image completed', stream: 'stdout' },
    ]);
    await handle.stop();
  });

  it('flushes an unterminated final line when the process exits', async () => {
    const processManager = new FakeProcessManager();
    const { handle, events } = await tapped(processManager);

    processManager.stdout('generate_image completed in 11.20s');
    expect(events).toHaveLength(0);
    processManager.exit(0, null);

    expect(events).toEqual([{ type: 'marker', marker: 'completed' }]);
    await handle.stop();
  });

  it('keeps bounded stdout/stderr tails', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager, { tailMaxBytes: 64 });

    processManager.stdout(`${'a'.repeat(200)}\n`);
    processManager.stderr(`${'b'.repeat(200)}\n`);

    expect(Buffer.byteLength(handle.stdoutTail, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(handle.stderrTail, 'utf8')).toBeLessThanOrEqual(64);
    await handle.stop();
  });
});

describe('sd-server runner lifecycle', () => {
  it('stops with a confirmed exit and is idempotent', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);

    const first = handle.stop();
    const second = handle.stop();
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(processManager.killedChildren).toEqual([processManager.spawnedChildren[0]]);
    expect(processManager.killTimeouts).toEqual([DIFFUSION_BACKEND_DEFAULTS.stopTimeoutMs]);
    expect(handle.state).toBe('stopped');
    await expect(handle.exitPromise).resolves.toEqual({ code: 0, signal: null });
  });

  it('passes an explicit stop timeout through to the kill', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);

    await handle.stop(1_234);

    expect(processManager.killTimeouts).toEqual([1_234]);
  });

  it('reports SD_SERVER_TERMINATION_UNCONFIRMED with the pid when the kill fails', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);
    processManager.killError = new Error('access denied');

    await expect(handle.stop()).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'SD_SERVER_TERMINATION_UNCONFIRMED',
        pid: 4_001,
        cause: 'access denied',
      }),
    });
  });

  it('reports SD_SERVER_TERMINATION_UNCONFIRMED when the child survives the kill', async () => {
    jest.useFakeTimers();
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);
    processManager.remainRunningAfterKill = true;

    const pending = handle.stop();
    const failure = expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'SD_SERVER_TERMINATION_UNCONFIRMED', pid: 4_001 }),
    });
    // The confirmation deadline is 2 s of polling after the kill resolves.
    await jest.advanceTimersByTimeAsync(2_100);

    await failure;
    jest.useRealTimers();
  });

  it('stops cleanly when the backend already exited on its own', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);

    processManager.exit(3, 'SIGSEGV');
    await expect(handle.exitPromise).resolves.toEqual({ code: 3, signal: 'SIGSEGV' });

    await handle.stop();
    expect(processManager.killedChildren).toHaveLength(0);
    expect(handle.state).toBe('stopped');
  });

  it('races in-flight work against an unexpected exit', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);

    const pending = handle.raceWithExit(new Promise<never>(() => undefined));
    processManager.stderr('ggml_cuda: out of memory\n');
    processManager.exit(1, null);

    await expect(pending).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'SD_SERVER_EXITED',
        exitCode: 1,
        stderrTail: expect.stringContaining('out of memory'),
      }),
    });
    await handle.stop();
  });

  it('resolves raceWithExit with the operation result while the backend is alive', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);

    await expect(handle.raceWithExit(Promise.resolve('ok'))).resolves.toBe('ok');
    await handle.stop();
  });

  it('treats a non-terminal child error as diagnostics, not an exit', async () => {
    const processManager = new FakeProcessManager();
    const handle = await startReady(processManager);
    let exited = false;
    void handle.exitPromise.then(() => {
      exited = true;
    });

    processManager.lastOptions.onError?.(new Error('failed to send signal'));
    await Promise.resolve();

    expect(exited).toBe(false);
    expect(handle.stderrTail).toContain('failed to send signal');
    await handle.stop();
  });
});

describe('isSdServerProgressBarLine', () => {
  it.each([
    '  |==================| 4/4 - 1.20it/s',
    '|=====             | 2/4 - 0.83s/it',
    '  |======| 512/1024 - 25.00MB/s',
    '|=| 12/2048 - 1.50KB/s',
    '|=| 1/2 - 3.00GB/s',
    '|=| 900/1024 - 512.00B/s',
  ])('recognizes the bar frame %s', (line) => {
    expect(isSdServerProgressBarLine(line)).toBe(true);
  });

  it.each([
    'generating image: 1/1 - seed 42',
    'sampling using Euler method',
    'decoding 1 latents',
    'decode_first_stage completed, taking 0.42s',
    'listening on: 127.0.0.1:51234',
    'ggml_cuda_init: found 1 CUDA device',
    '',
  ])('leaves the ordinary line %s alone', (line) => {
    expect(isSdServerProgressBarLine(line)).toBe(false);
  });

  it('is stateless across repeated calls (no sticky lastIndex)', () => {
    const line = '  |==| 3/4 - 1.20it/s';

    expect(isSdServerProgressBarLine(line)).toBe(true);
    expect(isSdServerProgressBarLine(line)).toBe(true);
    expect(isSdServerProgressBarLine(line)).toBe(true);
  });
});
