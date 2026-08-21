// Live smoke for the persistent sd-server diffusion backend (plan: docs/dev/plans/PLAN-sd-server-migration.md,
// Phase 7). Runs the library's REAL binaries/models on this machine — GPU-heavy, ~10 min, Windows/NVIDIA verified.
// Run under Electron (the root build must be fresh: `npm run build`), from the repo root:
//   examples/electron-control-panel/node_modules/electron/dist/electron.exe scripts/live-smoke/sd-server-live-smoke.mjs
// Env: SMOKE_USERDATA (default: the example app's userData — reuses its models + binaries), SMOKE_DIST (default:
//   ../../dist/index.js), SMOKE_DIFF_MODEL (default flux-2-klein-q40), SMOKE_LLM_MODEL (default
//   qwen-3-4b-instruct-2507-q6kxl), SMOKE_PORT (8081), SMOKE_STEPS (e.g. "S7,S8" to run a subset), SMOKE_OUT_DIR
//   (default scripts/live-smoke/artifacts/, gitignored). Writes <out>/live-smoke_<ts>.log and .json (per-step results).
// Do NOT run it as a background task that can be killed from outside — run it in the foreground (optionally in chunks).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const USERDATA =
  process.env.SMOKE_USERDATA || path.join(app.getPath('appData'), 'electron-control-panel');
const DIST = pathToFileURL(
  path.resolve(HERE, process.env.SMOKE_DIST || '../../dist/index.js')
).href;
const OUT_DIR = process.env.SMOKE_OUT_DIR || path.join(HERE, 'artifacts');
fs.mkdirSync(OUT_DIR, { recursive: true });
const RUN_ID = Date.now();
const LOG = path.join(OUT_DIR, `live-smoke_${RUN_ID}.log`);
const SUMMARY = path.join(OUT_DIR, `live-smoke_${RUN_ID}.json`);
const DIFF_MODEL = process.env.SMOKE_DIFF_MODEL || 'flux-2-klein-q40';
const LLM_MODEL = process.env.SMOKE_LLM_MODEL || 'qwen-3-4b-instruct-2507-q6kxl';
const PORT = Number(process.env.SMOKE_PORT || 8081);
const BASE = `http://127.0.0.1:${PORT}`;
const BEST = {
  clipOnCpu: false,
  vaeOnCpu: false,
  offloadToCpu: true,
  diffusionFlashAttention: true,
};
const ALL_RESIDENT = {
  clipOnCpu: false,
  vaeOnCpu: false,
  offloadToCpu: false,
  diffusionFlashAttention: true,
};
const GEN = {
  prompt: 'a photograph of a lighthouse on a rocky coast at sunset, detailed',
  width: 768,
  height: 768,
  steps: 4,
  cfgScale: 1,
  sampler: 'euler',
  seed: 42,
};

const summary = { runId: RUN_ID, startedAt: new Date().toISOString(), steps: [] };
const ts = () => new Date().toISOString();
const log = (...a) => {
  const line = `[${ts()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vram = () => {
  try {
    return parseInt(
      execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits', {
        encoding: 'utf8',
      }).trim(),
      10
    );
  } catch {
    return -1;
  }
};
const netstat8081 = () => {
  try {
    return execSync('netstat -ano | findstr :8081 | findstr LISTENING', {
      encoding: 'utf8',
      shell: 'cmd.exe',
    }).trim();
  } catch {
    return '(none)';
  }
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const saveSummary = () => {
  try {
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  } catch {}
};

app.setPath('userData', USERDATA);
// Electron ESM entry: 'ready' fires only after top-level evaluation completes, so never await it at top level.
process.on('uncaughtException', (e) => {
  log('UNCAUGHT', e?.stack ?? String(e));
  saveSummary();
  app.exit(4);
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED REJECTION', e?.stack ?? String(e));
});
app
  .whenReady()
  .then(main)
  .catch((e) => {
    log('MAIN FAILED', e?.stack ?? String(e));
    saveSummary();
    app.exit(3);
  });

async function main() {
  const globalTimer = setTimeout(() => {
    log('GLOBAL TIMEOUT — exiting');
    saveSummary();
    app.exit(2);
  }, 75 * 60_000);
  globalTimer.unref?.();

  const lib = await import(DIST);
  const { diffusionServer, llamaServer } = lib;
  log('lib loaded; userData =', app.getPath('userData'), '; GPU idle MiB =', vram());
  llamaServer.on('binary-log', (e) => {
    if (!/Downloading .*%/.test(e.message) || /: (25|50|75|100)\.0%/.test(e.message))
      log('LLAMA-BINARY-LOG', `[${e.level}] ${e.message}`);
  });

  const backendEvents = [];
  diffusionServer.on('backend-status', (e) => {
    backendEvents.push({ t: Date.now(), ...e });
    log('EVENT backend-status', e);
  });
  diffusionServer.on('binary-log', (e) => log('BINARY-LOG', `[${e.level}] ${e.message}`));
  diffusionServer.on('binary-progress', (e) => {
    if (e.phase === 'download' && e.percent !== undefined && e.percent % 20 === 0)
      log('BINARY-PROGRESS', e);
  });
  diffusionServer.on('started', (i) =>
    log('EVENT diffusion started', { port: i.port, backend: i.backend })
  );
  diffusionServer.on('stopped', () => log('EVENT diffusion stopped'));
  diffusionServer.on('calibration-progress', (p) => {
    if (p.phase !== 'sampling' || p.generationPercent === undefined)
      log('CAL', {
        phase: p.phase,
        combo: p.combo?.label,
        sample: p.sample,
        overall: p.overallPercent,
      });
  });
  llamaServer.on('started', () => log('EVENT llama started'));
  llamaServer.on('stopped', () => log('EVENT llama stopped'));
  llamaServer.on('status', (n, o) => log('EVENT llama status', o, '->', n));

  const ONLY_STEPS = (process.env.SMOKE_STEPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  async function step(name, fn) {
    if (ONLY_STEPS.length && !ONLY_STEPS.some((p) => name.startsWith(p + ' '))) {
      log(`--- SKIP ${name} (SMOKE_STEPS filter)`);
      return { name, skipped: true };
    }
    const rec = { name, startedAt: ts(), ok: false };
    summary.steps.push(rec);
    log(`=== STEP ${name} ===`);
    const t0 = Date.now();
    try {
      rec.result = await fn(rec);
      rec.ok = true;
    } catch (e) {
      rec.error = { message: e?.message, code: e?.code, details: e?.details };
      log(`STEP ${name} FAILED:`, rec.error);
    }
    rec.ms = Date.now() - t0;
    saveSummary();
    log(`=== END ${name} (${rec.ms} ms, ok=${rec.ok}) ===`);
    return rec;
  }

  // --- HTTP helpers (mirror genai-lite's adapter) ---
  async function postGen(body) {
    const r = await fetch(`${BASE}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: j };
  }
  async function getGen(id) {
    const r = await fetch(`${BASE}/v1/images/generations/${id}`);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  async function delGen(id) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/v1/images/generations/${id}`, { method: 'DELETE' });
    return { status: r.status, json: await r.json().catch(() => ({})), ms: Date.now() - t0 };
  }
  async function health() {
    const r = await fetch(`${BASE}/health`);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  async function pollGen(id, { timeoutMs = 240_000, onProgress } = {}) {
    const t0 = Date.now();
    const stages = [];
    let last;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(500);
      const { status, json } = await getGen(id);
      last = json;
      if (status !== 200) return { terminal: 'http-' + status, json, ms: Date.now() - t0, stages };
      if (json.status === 'in_progress' && json.progress) {
        const s = json.progress.stage;
        if (!stages.length || stages[stages.length - 1].stage !== s)
          stages.push({ stage: s, atMs: Date.now() - t0 });
        onProgress?.(json.progress);
      }
      if (['complete', 'error', 'cancelled'].includes(json.status))
        return { terminal: json.status, json, ms: Date.now() - t0, stages };
    }
    return { terminal: 'timeout', json: last, ms: Date.now() - t0, stages };
  }
  async function httpGenerate(label, overrides = {}, opts = {}) {
    const peak = { v: vram() };
    const sampler = setInterval(() => {
      const v = vram();
      if (v > peak.v) peak.v = v;
    }, 500);
    const t0 = Date.now();
    const post = await postGen({ ...GEN, negativePrompt: undefined, count: 1, ...overrides });
    if (post.status !== 201) {
      clearInterval(sampler);
      return { label, postStatus: post.status, postJson: post.json };
    }
    const res = await pollGen(post.json.id, opts);
    clearInterval(sampler);
    const out = {
      label,
      id: post.json.id,
      postStatus: post.status,
      terminal: res.terminal,
      totalMs: Date.now() - t0,
      pollMs: res.ms,
      stages: res.stages,
      vramPeakMiB: peak.v,
      vramAfterMiB: vram(),
      imageBytes: res.json?.result?.images?.[0]?.image
        ? Buffer.from(res.json.result.images[0].image, 'base64').length
        : 0,
      error: res.json?.error,
      timeTaken: res.json?.result?.timeTaken,
    };
    log(`GEN ${label}:`, out);
    return out;
  }
  const waitFor = async (pred, { timeoutMs = 120_000, every = 500, what = 'condition' } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await pred()) return Date.now() - t0;
      await sleep(every);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  try {
    await step('S1 start wrapper (provisions pinned binary if needed)', async (rec) => {
      const t0 = Date.now();
      const info = await diffusionServer.start({ modelId: DIFF_MODEL, port: PORT, ...BEST });
      rec.startMs = Date.now() - t0;
      const ns = netstat8081();
      const vj = JSON.parse(
        fs.readFileSync(path.join(USERDATA, 'binaries', 'diffusion', '.validation.json'), 'utf8')
      );
      return {
        startMs: rec.startMs,
        info: { status: info.status, port: info.port, backend: info.backend, pid: info.pid },
        netstat: ns,
        validation: vj,
        health: (await health()).json,
        vramIdle: vram(),
      };
    });

    await step('S2 cold HTTP generation', async () => {
      const r = await httpGenerate('cold');
      return {
        ...r,
        backendAfter: diffusionServer.getBackendInfo(),
        infoPid: diffusionServer.getInfo().pid,
        health: (await health()).json,
      };
    });

    await step('S3 warm HTTP generation (burst default, LLM not running)', async () =>
      httpGenerate('warm')
    );

    await step(
      'S4 cancel mid-generation (DELETE answers on initiation; respawn works)',
      async () => {
        const pidBefore = diffusionServer.getBackendInfo().pid;
        const post = await postGen({ ...GEN, seed: 7 });
        await sleep(1500);
        const del = await delGen(post.json.id);
        const after = await getGen(post.json.id);
        const evs = backendEvents.slice(-4).map((e) => `${e.state}:${e.reason}`);
        await sleep(1500);
        const next = await httpGenerate('after-cancel');
        return {
          del,
          statusAfterDelete: after.json.status,
          backendEventsTail: evs,
          pidBefore,
          pidAfterNext: diffusionServer.getBackendInfo().pid,
          next: { terminal: next.terminal, totalMs: next.totalMs },
        };
      }
    );

    await step(
      'S5 crash mid-generation (taskkill backend; job -> error; wrapper running; respawn)',
      async () => {
        const pid = diffusionServer.getBackendInfo().pid;
        const post = await postGen({ ...GEN, seed: 8 });
        await sleep(1500);
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        const res = await pollGen(post.json.id, { timeoutMs: 30_000 });
        const evs = backendEvents.slice(-3).map((e) => `${e.state}:${e.reason}`);
        const status = diffusionServer.getStatus();
        const next = await httpGenerate('after-crash');
        return {
          killedPid: pid,
          terminal: res.terminal,
          error: res.json?.error,
          backendEventsTail: evs,
          wrapperStatus: status,
          next: { terminal: next.terminal, totalMs: next.totalMs },
        };
      }
    );

    await step('S6 idle timeout (restart with idleTimeoutMs=5000)', async () => {
      await diffusionServer.stop();
      await diffusionServer.start({
        modelId: DIFF_MODEL,
        port: PORT,
        ...BEST,
        idleTimeoutMs: 5000,
      });
      const g = await httpGenerate('idle-probe');
      const stateRight = diffusionServer.getBackendInfo().state;
      const waited = await waitFor(() => diffusionServer.getBackendInfo().state === 'absent', {
        timeoutMs: 20_000,
        what: 'idle release',
      });
      return {
        gen: { terminal: g.terminal, totalMs: g.totalMs },
        stateRightAfter: stateRight,
        releasedAfterMs: waited,
        lastEvents: backendEvents.slice(-2).map((e) => `${e.state}:${e.reason}`),
        vramAfter: vram(),
      };
    });

    await step(
      'S7 LLM cycle: yield on LLM start, offload for image, single->reload, burst defers, explicit release reloads',
      async (rec) => {
        // make the backend resident first (burst default, LLM not running)
        await diffusionServer.stop();
        await diffusionServer.start({ modelId: DIFF_MODEL, port: PORT, ...BEST });
        await httpGenerate('pre-llm-warmup');
        const residentBefore = diffusionServer.getBackendInfo().state;
        const t0 = Date.now();
        await llamaServer.start({ modelId: LLM_MODEL, port: 8080 });
        rec.llmStartMs = Date.now() - t0;
        const backendAfterLlmStart = diffusionServer.getBackendInfo().state;
        const evsYield = backendEvents.slice(-2).map((e) => `${e.state}:${e.reason}`);
        const vramWithLlm = vram();
        // image while LLM running -> orchestrator offloads, single -> release -> reload
        const llmStatusSeq = [];
        const watch = setInterval(() => {
          const s = llamaServer.getStatus();
          if (!llmStatusSeq.length || llmStatusSeq[llmStatusSeq.length - 1] !== s)
            llmStatusSeq.push(s);
        }, 200);
        const g1 = await httpGenerate('with-llm-single');
        const backendAfterSingle = diffusionServer.getBackendInfo().state;
        const reloadMs = await waitFor(() => llamaServer.getStatus() === 'running', {
          timeoutMs: 180_000,
          what: 'llm reload',
        });
        clearInterval(watch);
        // burst via Node API: LLM offloaded, backend stays, reload deferred
        const g2t0 = Date.now();
        const g2 = await diffusionServer.generateImage({ ...GEN, seed: 9, usageMode: 'burst' });
        const g2ms = Date.now() - g2t0;
        await sleep(4000);
        const llmStillStopped = llamaServer.getStatus();
        const backendAfterBurst = diffusionServer.getBackendInfo().state;
        await diffusionServer.releaseBackend();
        const reload2Ms = await waitFor(() => llamaServer.getStatus() === 'running', {
          timeoutMs: 180_000,
          what: 'llm reload after explicit release',
        });
        await llamaServer.stop();
        return {
          residentBefore,
          llmStartMs: rec.llmStartMs,
          backendAfterLlmStart,
          evsYield,
          vramWithLlm,
          g1: { terminal: g1.terminal, totalMs: g1.totalMs },
          llmStatusSeq,
          backendAfterSingle,
          reloadMs,
          g2: { bytes: g2.image.length, ms: g2ms },
          llmStillStopped,
          backendAfterBurst,
          reload2Ms,
        };
      }
    );

    await step('S8 stop() with resident backend', async () => {
      await httpGenerate('pre-stop');
      const pid = diffusionServer.getBackendInfo().pid;
      const t0 = Date.now();
      await diffusionServer.stop();
      await sleep(1000);
      return {
        stopMs: Date.now() - t0,
        pidAlive: pidAlive(pid),
        vramAfter: vram(),
        lastEvents: backendEvents.slice(-2).map((e) => `${e.state}:${e.reason}`),
        netstat: netstat8081(),
      };
    });

    for (const mode of ['single', 'burst']) {
      await step(`S9 calibrate usageMode=${mode}`, async () => {
        const report = await diffusionServer.calibrate({
          modelId: DIFF_MODEL,
          sizes: [{ width: 512, height: 512 }],
          combos: [
            { label: 'offload', ...BEST },
            { label: 'all-resident', ...ALL_RESIDENT },
          ],
          samples: 2,
          generation: { steps: 4, cfgScale: 1, sampler: 'euler' },
          usageMode: mode,
        });
        return {
          usageMode: report.usageMode,
          policyVersion: report.policyVersion,
          recommended: report.recommended,
          runs: report.runs.map((r) => ({
            combo: r.combo.label,
            status: r.status,
            timeTakenMs: r.timeTakenMs,
            samplesMs: r.samplesMs,
            stageMs: r.stageMs,
            vramPeakBytes: r.vramPeakBytes,
            vramIdleBytes: r.vramIdleBytes,
            error: r.error,
          })),
          backendAfter: diffusionServer.getBackendInfo().state,
          vramAfter: vram(),
        };
      });
    }

    await step('S10 re-validation without re-download (.validation.json deleted)', async () => {
      const vpath = path.join(USERDATA, 'binaries', 'diffusion', '.validation.json');
      fs.unlinkSync(vpath);
      const lines = [];
      const h = (e) => lines.push(`[${e.level}] ${e.message}`);
      diffusionServer.on('binary-log', h);
      const t0 = Date.now();
      await diffusionServer.start({ modelId: DIFF_MODEL, port: PORT, ...BEST });
      diffusionServer.off('binary-log', h);
      const vj = JSON.parse(fs.readFileSync(vpath, 'utf8'));
      await diffusionServer.stop();
      return {
        startMs: Date.now() - t0,
        downloaded: lines.some((l) => /download/i.test(l)),
        phase1: lines.some((l) => /Phase 1/.test(l)),
        phase2: lines.some((l) => /Phase 2/.test(l)),
        validation: vj,
        logTail: lines.slice(-6),
      };
    });

    await step('S11 OOM probe (all-resident, 2048x2048)', async () => {
      await diffusionServer.start({ modelId: DIFF_MODEL, port: PORT, ...ALL_RESIDENT });
      const r = await httpGenerate(
        'oom-probe',
        { width: 2048, height: 2048 },
        { timeoutMs: 180_000 }
      );
      if (r.terminal === 'timeout' && r.id) {
        await delGen(r.id);
      }
      const evs = backendEvents.slice(-3).map((e) => `${e.state}:${e.reason}`);
      await diffusionServer.stop();
      return {
        terminal: r.terminal,
        totalMs: r.totalMs,
        error: r.error,
        vramPeakMiB: r.vramPeakMiB,
        backendEventsTail: evs,
      };
    });
  } finally {
    try {
      await diffusionServer.stop();
    } catch {}
    try {
      await llamaServer.stop();
    } catch {}
    summary.finishedAt = ts();
    summary.backendEvents = backendEvents.map(
      (e) => `${new Date(e.t).toISOString()} ${e.state}:${e.reason}`
    );
    saveSummary();
    log('SUMMARY written to', SUMMARY, '; GPU MiB =', vram());
    clearTimeout(globalTimer);
    app.exit(0);
  }
}
