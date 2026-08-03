/**
 * Bounded host-memory pressure helper for the Phase 6 enforcement scenarios of
 * PLAN-calibration-resource-stability.
 *
 * It commits a target number of MiB in fixed-size touched chunks and holds them until it is
 * released, so the calibration resource guard sees a real reduction in host availability rather
 * than an untouched reservation that Windows never charges against "Available Bytes".
 *
 * Plain Node (no dependencies, no Electron). `run-quiet-trace.mjs` spawns it with
 * `ELECTRON_RUN_AS_NODE=1` so the Electron binary behaves as Node.
 *
 * SAFETY RAILS - all mandatory, per the plan's rollback and incomplete-evidence policy. None of
 * them can be disabled from the CLI; the flags only tighten them:
 *
 *  1. Hard remaining-memory floor, re-checked before EVERY chunk. The helper refuses to take the
 *     machine below `--floor-mib` of `os.freemem()` and reports `FLOOR` instead of allocating on.
 *  2. TTL self-expiry. The armed (memory-holding) lifetime is bounded by `--ttl-ms`; an unarmed
 *     staged process is bounded by `--staged-ttl-ms`. Both hard-exit.
 *  3. Parent-death watchdog, polled every second: a changed/disappeared parent PID, or a closed
 *     stdin, exits immediately.
 *  4. Release on demand: `RELEASE` on stdin, or SIGTERM/SIGINT, frees everything and exits 0.
 *
 * Release is implemented as process exit on purpose: dropping Buffer references only returns the
 * pages after a GC, while exiting hands them back to the OS immediately, which is what the
 * transient-recovery scenario needs.
 *
 * Line protocol on stdout (stderr carries only `# ...` diagnostics):
 *
 * | Line                                     | Meaning                                            |
 * | ---------------------------------------- | -------------------------------------------------- |
 * | `STAGED <targetMib> <ppid>`              | `--wait-for-arm`: process up, holding nothing       |
 * | `READY <allocatedMib> <elapsedMs>`       | target committed                                    |
 * | `FLOOR <allocatedMib> <freeMib> <ms>`    | the memory floor stopped allocation early           |
 * | `EXIT <reason> <heldMib> <uptimeMs>`     | terminal line; reason is released/ttl/parent-death… |
 *
 * Usage:
 *   node host-pressure-helper.mjs --target-mib 800
 *   node host-pressure-helper.mjs --target-mib 512 --wait-for-arm   # then write "ARM" to stdin
 *   node host-pressure-helper.mjs --self-test                       # safe, allocates 64 MiB
 *
 * NOTE: there is deliberately no VRAM helper. VRAM pressure is produced by the operator launching
 * a second small llama-server, never by this script, and never while a calibration model is loaded.
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MIB = 1024 * 1024;
const PAGE_BYTES = 4096;

const DEFAULTS = {
  chunkMib: 64,
  floorMib: 4096,
  ttlMs: 120_000,
  stagedTtlMs: 1_800_000,
  watchdogIntervalMs: 1000,
};

const startedAt = performance.now();

/** Retained references to the committed chunks. Clearing this is the "free" half of a release. */
let chunks = [];
let allocatedMib = 0;
let exiting = false;
let ttlTimer;
let holdTimer;
let watchdogTimer;

/**
 * Line output.
 *
 * `writeSync` rather than `process.stdout.write`: stdout is a pipe here, pipe writes are
 * asynchronous, and the terminal `EXIT` line is written immediately before `process.exit()`. An
 * async write would be truncated exactly when the controller most needs the reason.
 */
function out(line) {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    /* the controller is gone; the rails handle the rest */
  }
}

function note(line) {
  try {
    writeSync(2, `# ${line}\n`);
  } catch {
    /* diagnostics only */
  }
}

function uptimeMs() {
  return Math.round(performance.now() - startedAt);
}

function freeMib() {
  return Math.floor(os.freemem() / MIB);
}

/**
 * Terminal path for every exit reason.
 *
 * Frees the references first so a slow stdout flush cannot leave the pages held, then hard-exits:
 * process teardown is what actually returns the committed pages to the OS.
 */
function exitWith(reason, code = 0) {
  if (exiting) return;
  exiting = true;
  const heldMib = allocatedMib;
  chunks = [];
  allocatedMib = 0;
  if (ttlTimer) clearTimeout(ttlTimer);
  if (holdTimer) clearTimeout(holdTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  out(`EXIT ${reason} ${heldMib} ${uptimeMs()}`);
  process.exit(code);
}

/** Rail 2. Unref'd so it never keeps the process alive on its own; the watchdog interval does. */
function armTtl(ms, reason) {
  if (ttlTimer) clearTimeout(ttlTimer);
  ttlTimer = setTimeout(() => exitWith(reason), ms);
  ttlTimer.unref();
}

/**
 * Rail 3. `process.ppid` is captured at creation on Windows and does not change when the parent
 * dies, so existence is probed as well; EPERM means "alive but not ours to signal".
 */
function makeParentWatchdog(initialPpid) {
  return () => {
    if (process.ppid !== initialPpid) {
      exitWith('parent-death');
      return;
    }
    try {
      process.kill(initialPpid, 0);
    } catch (error) {
      if (error?.code === 'EPERM') return;
      exitWith('parent-death');
    }
  };
}

/**
 * Commit `targetMib` in touched chunks, re-checking the floor before every chunk (rail 1).
 *
 * Touching one byte per page is what charges the allocation against physical memory; an untouched
 * `Buffer` would leave Windows "Available Bytes" - the exact metric the guard reads - unchanged.
 * The event loop is yielded between chunks so a `RELEASE`, a signal, or the TTL can still land
 * while a large target is being committed.
 */
async function allocate(targetMib, { chunkMib, floorMib }) {
  const allocationStartedAt = performance.now();
  while (allocatedMib < targetMib && !exiting) {
    const nextMib = Math.min(chunkMib, targetMib - allocatedMib);
    const free = freeMib();
    if (free - nextMib < floorMib) {
      const elapsed = Math.round(performance.now() - allocationStartedAt);
      out(`FLOOR ${allocatedMib} ${free} ${elapsed}`);
      note(`memory floor reached: free=${free}MiB floor=${floorMib}MiB next=${nextMib}MiB`);
      return { stoppedByFloor: true, allocatedMib, freeMib: free, elapsedMs: elapsed };
    }
    const buffer = Buffer.allocUnsafeSlow(nextMib * MIB);
    for (let offset = 0; offset < buffer.length; offset += PAGE_BYTES) buffer[offset] = 1;
    buffer[buffer.length - 1] = 1;
    chunks.push(buffer);
    allocatedMib += nextMib;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const elapsed = Math.round(performance.now() - allocationStartedAt);
  if (!exiting) out(`READY ${allocatedMib} ${elapsed}`);
  return { stoppedByFloor: false, allocatedMib, freeMib: freeMib(), elapsedMs: elapsed };
}

/**
 * Drive one staged child through exactly the protocol `run-quiet-trace.mjs` uses: spawn with
 * `--wait-for-arm`, write `ARM`, wait for `READY`, write `RELEASE`, expect a clean `EXIT released`.
 *
 * The child is bounded by a 64 MiB target, a 10 s TTL, and a hard kill after 20 s, so this stays
 * as safe as the rest of the self-test.
 */
function selfTestStagedProtocol() {
  return new Promise((resolve) => {
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(
      process.execPath,
      [
        selfPath,
        '--target-mib',
        '64',
        '--chunk-mib',
        '64',
        '--floor-mib',
        String(Math.max(1, freeMib() - 512)),
        '--ttl-ms',
        '10000',
        '--staged-ttl-ms',
        '15000',
        '--wait-for-arm',
        '--label',
        'selftest-child',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    );
    const seen = [];
    let buffered = '';
    const finish = (result) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', seen }), 20_000);
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffered += data;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (line.length === 0) continue;
        seen.push(line);
        if (line.startsWith('STAGED')) child.stdin.write('ARM\n');
        else if (line.startsWith('READY')) child.stdin.write('RELEASE\n');
      }
    });
    child.on('error', (error) => finish({ ok: false, reason: String(error?.message), seen }));
    child.on('close', (code) => {
      const staged = seen.some((line) => line.startsWith('STAGED 64'));
      const ready = seen.some((line) => line.startsWith('READY 64'));
      const released = seen.some((line) => line.startsWith('EXIT released'));
      finish({ ok: staged && ready && released && code === 0, code, seen });
    });
  });
}

/**
 * `--self-test`: proves the floor logic, the allocate/release path, and the staged ARM/RELEASE
 * protocol without leaving pressure behind. Safe to run at any time; it commits at most one 64 MiB
 * chunk per process and exits 0.
 */
async function selfTest() {
  const failures = [];
  const free = freeMib();
  out(`SELF-TEST start freeMib=${free} totalMib=${Math.floor(os.totalmem() / MIB)}`);

  // 1. A floor above current free memory must stop allocation before the first chunk.
  const blocked = await allocate(64, { chunkMib: 64, floorMib: free + 1024 });
  if (!blocked.stoppedByFloor || blocked.allocatedMib !== 0) {
    failures.push(`floor did not block allocation (allocated=${blocked.allocatedMib}MiB)`);
  } else {
    out('SELF-TEST floor-blocks-allocation PASS');
  }

  // 2. With headroom, one touched 64 MiB chunk must be committed and then released.
  if (free < 1024) {
    out('SELF-TEST allocate-release SKIP (less than 1 GiB free)');
  } else {
    const rssBefore = process.memoryUsage().rss;
    const granted = await allocate(64, { chunkMib: 64, floorMib: Math.max(1, free - 512) });
    const rssAfter = process.memoryUsage().rss;
    if (granted.stoppedByFloor || granted.allocatedMib !== 64) {
      failures.push(`allocation did not reach 64 MiB (allocated=${granted.allocatedMib}MiB)`);
    } else if (rssAfter - rssBefore < 32 * MIB) {
      failures.push(
        `RSS grew by only ${Math.round((rssAfter - rssBefore) / MIB)}MiB; pages were not touched`
      );
    } else {
      out(
        `SELF-TEST allocate-touches-pages PASS rssDeltaMib=${Math.round((rssAfter - rssBefore) / MIB)}`
      );
    }
    chunks = [];
    allocatedMib = 0;
    out('SELF-TEST release PASS');
  }

  // 3. The rails must be installable and cancellable without holding the process open.
  armTtl(60_000, 'ttl');
  if (!ttlTimer) failures.push('TTL timer was not installed');
  clearTimeout(ttlTimer);
  ttlTimer = undefined;
  const watchdog = makeParentWatchdog(process.ppid);
  watchdog();
  if (exiting) failures.push('parent watchdog exited against a live parent');
  else out('SELF-TEST rails PASS');

  // 4. The staged protocol the harness controller drives.
  const protocol = await selfTestStagedProtocol();
  if (!protocol.ok) {
    failures.push(
      `staged ARM/RELEASE protocol failed (${protocol.reason ?? `code ${protocol.code}`}): ` +
        `${protocol.seen.join(' | ')}`
    );
  } else {
    out(`SELF-TEST staged-arm-release PASS ${protocol.seen.join(' | ')}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) out(`SELF-TEST FAIL ${failure}`);
    out(`EXIT self-test-failed 0 ${uptimeMs()}`);
    process.exit(1);
  }
  out(`SELF-TEST PASS`);
  out(`EXIT self-test 0 ${uptimeMs()}`);
  process.exit(0);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'target-mib': { type: 'string' },
      'chunk-mib': { type: 'string' },
      'floor-mib': { type: 'string' },
      'ttl-ms': { type: 'string' },
      'staged-ttl-ms': { type: 'string' },
      'hold-ms': { type: 'string' },
      'wait-for-arm': { type: 'boolean', default: false },
      label: { type: 'string' },
      'self-test': { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values['self-test']) {
    await selfTest();
    return;
  }

  const number = (key, fallback) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a number >= 0`);
    return parsed;
  };

  const targetMib = Math.floor(number('target-mib', 0));
  const chunkMib = Math.max(1, Math.floor(number('chunk-mib', DEFAULTS.chunkMib)));
  const floorMib = Math.floor(number('floor-mib', DEFAULTS.floorMib));
  const ttlMs = Math.floor(number('ttl-ms', DEFAULTS.ttlMs));
  const stagedTtlMs = Math.floor(number('staged-ttl-ms', DEFAULTS.stagedTtlMs));
  const holdMs = values['hold-ms'] === undefined ? undefined : Math.floor(number('hold-ms', 0));
  const label = values.label ?? 'helper';

  if (targetMib <= 0) throw new Error('--target-mib must be > 0');
  // Independent of the floor: never let a typo request half the machine.
  const totalMib = Math.floor(os.totalmem() / MIB);
  if (targetMib > totalMib / 2) {
    throw new Error(`--target-mib ${targetMib} exceeds half of total RAM (${totalMib} MiB)`);
  }
  if (ttlMs <= 0 || stagedTtlMs <= 0) throw new Error('TTL values must be > 0');

  process.on('SIGTERM', () => exitWith('released'));
  process.on('SIGINT', () => exitWith('released'));

  watchdogTimer = setInterval(makeParentWatchdog(process.ppid), DEFAULTS.watchdogIntervalMs);

  note(
    `${label}: target=${targetMib}MiB chunk=${chunkMib}MiB floor=${floorMib}MiB ttl=${ttlMs}ms ` +
      `stagedTtl=${stagedTtlMs}ms hold=${holdMs ?? 'none'} ppid=${process.ppid}`
  );

  const startHold = () => {
    if (holdMs === undefined) return;
    holdTimer = setTimeout(() => exitWith('hold-elapsed'), holdMs);
    holdTimer.unref();
  };

  const run = async () => {
    armTtl(ttlMs, 'ttl');
    await allocate(targetMib, { chunkMib, floorMib });
    startHold();
  };

  if (values['wait-for-arm']) {
    armTtl(stagedTtlMs, 'staged-ttl');
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data) => {
      buffered += data;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const command = buffered.slice(0, newline).trim().toUpperCase();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (command === 'ARM') {
          void run();
        } else if (command === 'RELEASE') {
          exitWith('released');
        } else if (command === 'PING') {
          out('PONG');
        } else if (command.length > 0) {
          note(`ignored unknown command "${command}"`);
        }
      }
    });
    // Rail 3 again: a closed stdin means the controller is gone.
    process.stdin.on('end', () => exitWith('parent-death'));
    process.stdin.on('close', () => exitWith('parent-death'));
    process.stdin.on('error', () => exitWith('parent-death'));
    process.stdin.resume();
    out(`STAGED ${targetMib} ${process.ppid}`);
    return;
  }

  await run();
}

main().catch((error) => {
  process.stderr.write(`host-pressure-helper: ${error?.stack ?? error}\n`);
  exitWith('error', 1);
});
