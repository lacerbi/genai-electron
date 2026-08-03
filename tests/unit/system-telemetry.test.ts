/**
 * Unit tests for bounded, truthful platform telemetry
 *
 * Covers `refreshAvailableMemory()` / `SystemInfo.refreshMemoryTelemetry()`
 * status semantics and the abort/timeout bounding of the GPU telemetry
 * commands. Kept in its own suite so the module-scoped Windows
 * available-memory cache cannot leak into the broader SystemInfo assertions.
 */

import { jest } from '@jest/globals';

const mockCpus = jest.fn();
const mockTotalmem = jest.fn();
const mockFreemem = jest.fn();
const mockArch = jest.fn();
const mockPlatform = jest.fn();
const mockExec = jest.fn();

jest.unstable_mockModule('node:os', () => ({
  default: {
    cpus: mockCpus,
    totalmem: mockTotalmem,
    freemem: mockFreemem,
    arch: mockArch,
    platform: mockPlatform,
  },
}));

jest.unstable_mockModule('node:child_process', () => ({
  exec: mockExec,
}));

const mockIsMac = jest.fn();
const mockIsWindows = jest.fn();
const mockIsLinux = jest.fn();
const mockIsAppleSilicon = jest.fn();

jest.unstable_mockModule('../../src/utils/platform-utils.js', () => ({
  getPlatform: jest.fn(),
  getArchitecture: jest.fn(),
  getPlatformKey: jest.fn(),
  isMac: mockIsMac,
  isWindows: mockIsWindows,
  isLinux: mockIsLinux,
  isAppleSilicon: mockIsAppleSilicon,
}));

const { refreshAvailableMemory, getMemoryInfo } = await import('../../src/system/memory-detect.js');
const { SystemInfo } = await import('../../src/system/SystemInfo.js');

const GB = 1024 ** 3;

type ExecCallback = (error: unknown, result?: { stdout: string; stderr: string }) => void;

const originalPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Answer the promisified exec callback with successful stdout. */
function execResolvesWith(stdout: string): void {
  mockExec.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as ExecCallback;
    callback(null, { stdout, stderr: '' });
    return undefined;
  });
}

/** Answer the promisified exec callback with a spawn/command failure. */
function execFailsWith(message: string): void {
  mockExec.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as ExecCallback;
    callback(new Error(message));
    return undefined;
  });
}

/**
 * Simulate Node's own `timeout` handling: once the deadline passes, exec kills
 * the child and reports the kill through the callback.
 */
function execTimesOutAfterItsDeadline(): void {
  mockExec.mockImplementation((...args: unknown[]) => {
    const options = args[1] as { timeout?: number } | undefined;
    const callback = args[args.length - 1] as ExecCallback;
    const timer = setTimeout(() => {
      callback(
        Object.assign(new Error('Command failed: killed'), {
          killed: true,
          signal: 'SIGTERM',
          code: null,
        })
      );
    }, options?.timeout ?? 0);
    timer.unref?.();
    return undefined;
  });
}

/**
 * Simulate Node's own `signal` handling: aborting kills the child and reports
 * the abort through the callback. The command otherwise hangs forever.
 */
function execAbortsWithItsSignal(): void {
  mockExec.mockImplementation((...args: unknown[]) => {
    const options = args[1] as { signal?: AbortSignal } | undefined;
    const callback = args[args.length - 1] as ExecCallback;
    options?.signal?.addEventListener(
      'abort',
      () => {
        callback(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      },
      { once: true }
    );
    return undefined;
  });
}

function execOptionsOfCall(index: number): { timeout?: number; signal?: AbortSignal } {
  return mockExec.mock.calls[index]?.[1] as { timeout?: number; signal?: AbortSignal };
}

describe('memory telemetry refresh status', () => {
  beforeEach(() => {
    mockCpus.mockReturnValue([{ model: 'Test CPU', speed: 2800 }]);
    mockTotalmem.mockReturnValue(16 * GB);
    mockFreemem.mockReturnValue(8 * GB);
    mockArch.mockReturnValue('x64');
    mockPlatform.mockReturnValue('win32');
    mockIsMac.mockReturnValue(false);
    mockIsWindows.mockReturnValue(true);
    mockIsLinux.mockReturnValue(false);
    mockIsAppleSilicon.mockReturnValue(false);
    setProcessPlatform('win32');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("returns 'not-required' on non-Windows platforms without spawning anything", async () => {
    setProcessPlatform('linux');

    await expect(refreshAvailableMemory()).resolves.toBe('not-required');
    await expect(SystemInfo.getInstance().refreshMemoryTelemetry()).resolves.toBe('not-required');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns 'refreshed' and stores a valid Windows PerfOS reading", async () => {
    execResolvesWith(`${12 * GB}\n`);

    await expect(refreshAvailableMemory()).resolves.toBe('refreshed');

    // Stored: the standby-aware value now backs getMemoryInfo()
    const memory = getMemoryInfo();
    expect(memory.available).toBe(12 * GB);
    expect(memory.used).toBe(16 * GB - 12 * GB);
    // Bounded by default even when the caller passes nothing
    expect(execOptionsOfCall(0).timeout).toBe(10000);
  });

  it("returns 'failed' for non-numeric output and never re-reports a stale cached value", async () => {
    // A previous invocation succeeded (12 GB is still cached from above)
    execResolvesWith('Get-CimInstance : Access denied\n');

    await expect(refreshAvailableMemory()).resolves.toBe('failed');

    // Fallback behavior for ordinary callers is unchanged: the cached reading
    // still backs getMemoryInfo() until its TTL expires...
    expect(getMemoryInfo().available).toBe(12 * GB);
    // ...but the status describes THIS invocation, not the cache.
  });

  it("returns 'failed' for empty output", async () => {
    execResolvesWith('   \n');
    await expect(refreshAvailableMemory()).resolves.toBe('failed');
  });

  it("returns 'failed' for a negative reading", async () => {
    execResolvesWith('-1\n');
    await expect(refreshAvailableMemory()).resolves.toBe('failed');
  });

  it("returns 'failed' when the command fails", async () => {
    execFailsWith('powershell is not recognized');
    await expect(refreshAvailableMemory()).resolves.toBe('failed');
  });

  it("returns 'failed' when a hung command hits its timeout", async () => {
    execTimesOutAfterItsDeadline();

    await expect(refreshAvailableMemory({ timeoutMs: 25 })).resolves.toBe('failed');

    // The deadline is handed to exec, which kills the child process on expiry
    expect(execOptionsOfCall(0).timeout).toBe(25);
  });

  it('never settles on its own while the command hangs (no bare promise race)', async () => {
    // exec never answers: a bare race would resolve at the deadline and leave
    // the child process running. Only exec's own timeout may end this call.
    mockExec.mockImplementation(() => undefined);

    let settled = false;
    void refreshAvailableMemory({ timeoutMs: 20 }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(settled).toBe(false);
    expect(execOptionsOfCall(0).timeout).toBe(20);
  });

  it('rejects with the caller abort reason when the signal fires mid-command', async () => {
    execAbortsWithItsSignal();
    const controller = new AbortController();
    const reason = new Error('calibration aborted by caller');

    const pending = refreshAvailableMemory({ signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    // The signal is handed to exec, which kills the child process on abort
    expect(execOptionsOfCall(0).signal).toBe(controller.signal);
  });

  it('rejects with the default AbortError reason without spawning an already-aborted command', async () => {
    execResolvesWith(`${12 * GB}\n`);
    const controller = new AbortController();
    controller.abort();

    await expect(refreshAvailableMemory({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('forwards options and the status through SystemInfo.refreshMemoryTelemetry()', async () => {
    execResolvesWith(`${9 * GB}\n`);

    await expect(
      SystemInfo.getInstance().refreshMemoryTelemetry({ timeoutMs: 1500 })
    ).resolves.toBe('refreshed');
    expect(execOptionsOfCall(0).timeout).toBe(1500);
  });

  it('keeps detect() best-effort when the refresh fails', async () => {
    execFailsWith('powershell is not recognized');
    const systemInfo = SystemInfo.getInstance();
    systemInfo.clearCache();

    const capabilities = await systemInfo.detect(true);

    expect(capabilities.memory.total).toBe(16 * GB);
    expect(capabilities.gpu.available).toBe(false);
  });
});

describe('GPU telemetry bounding', () => {
  beforeEach(() => {
    mockCpus.mockReturnValue([{ model: 'Test CPU', speed: 2800 }]);
    mockTotalmem.mockReturnValue(16 * GB);
    mockFreemem.mockReturnValue(8 * GB);
    mockArch.mockReturnValue('x64');
    mockPlatform.mockReturnValue('win32');
    mockIsMac.mockReturnValue(false);
    mockIsWindows.mockReturnValue(true);
    mockIsLinux.mockReturnValue(false);
    mockIsAppleSilicon.mockReturnValue(false);
    setProcessPlatform('win32');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('bounds nvidia-smi with the caller timeout and keeps the failure result shape', async () => {
    execTimesOutAfterItsDeadline();

    const gpu = await SystemInfo.getInstance().getGPUInfo({ timeoutMs: 25 });

    expect(gpu).toEqual({ available: false });
    expect(mockExec.mock.calls[0]?.[0]).toContain('nvidia-smi');
    expect(execOptionsOfCall(0).timeout).toBe(25);
  });

  it('bounds nvidia-smi with the default timeout when the caller passes nothing', async () => {
    execFailsWith('nvidia-smi not found');

    const gpu = await SystemInfo.getInstance().getGPUInfo();

    expect(gpu).toEqual({ available: false });
    expect(execOptionsOfCall(0).timeout).toBe(10000);
  });

  it('rejects with the caller abort reason instead of reporting "no GPU"', async () => {
    execAbortsWithItsSignal();
    const controller = new AbortController();
    const reason = new Error('calibration aborted by caller');

    const pending = SystemInfo.getInstance().getGPUInfo({ signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(execOptionsOfCall(0).signal).toBe(controller.signal);
  });

  it('still reports detected NVIDIA VRAM through the bounded command', async () => {
    execResolvesWith('NVIDIA GeForce RTX 4090, 24576 MiB, 20480 MiB\n');

    const gpu = await SystemInfo.getInstance().getGPUInfo({ timeoutMs: 5000 });

    expect(gpu.available).toBe(true);
    expect(gpu.type).toBe('nvidia');
    expect(gpu.vram).toBe(24576 * 1024 * 1024);
    expect(gpu.vramAvailable).toBe(20480 * 1024 * 1024);
    expect(execOptionsOfCall(0).timeout).toBe(5000);
  });
});
