/**
 * Unit tests for the calibration resource-stability guard.
 *
 * Everything here runs against injected fakes: no hardware, no real cooldowns, no timers. The fake
 * capture and delay record their calls so each test can also assert that collection stays strictly
 * bounded by the fixed sample/read counts.
 */

import { jest } from '@jest/globals';

import {
  buildResourceBaseline,
  concludeResourceBoundary,
  evaluateResourceSnapshot,
  medianOf,
  mergeResourceSnapshotEvaluations,
  trustedReading,
  untrustedReading,
  validateResourceStabilityThresholds,
} from '../../src/utils/llama-resource-guard.js';
import type {
  ResourceStabilityThresholds,
  ResourceMetricReading,
  ResourceReadingUntrustedReason,
  ResourceSnapshot,
} from '../../src/utils/llama-resource-guard.js';
import {
  checkBoundary,
  collectBaseline,
  createTelemetrySnapshotCapture,
} from '../../src/utils/llama-resource-guard-capture.js';
import type {
  AbortableDelay,
  CaptureResourceSnapshot,
  MemoryTelemetryRefreshStatus,
  ResourceTelemetryReadOptions,
} from '../../src/utils/llama-resource-guard-capture.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Baselines are 1000 "bytes" so percentages are exact binary fractions: 750 is exactly 25% below
 * and 500 exactly 50% below, which lets the inclusive-threshold tests assert equality rather than
 * an approximation.
 */
const BASE = 1000;

/**
 * Independent per-metric decrease bands; different values catch metric mix-ups.
 *
 * No increase bands, which is the Phase-1 replay shape: that direction is then simply not guarded.
 */
const THRESHOLDS: ResourceStabilityThresholds = {
  hostMemoryDecreaseThresholdPct: 25,
  vramDecreaseThresholdPct: 50,
};

/** The shipped shape: both directions guarded, all four values distinct. */
const BANDED: ResourceStabilityThresholds = {
  hostMemoryDecreaseThresholdPct: 25,
  vramDecreaseThresholdPct: 50,
  hostMemoryIncreaseThresholdPct: 20,
  vramIncreaseThresholdPct: 40,
};

const ok = (availableBytes: number): ResourceMetricReading => trustedReading(availableBytes);
const bad = (
  reason: ResourceReadingUntrustedReason = 'reading-unavailable'
): ResourceMetricReading => untrustedReading(reason);

const snap = (
  hostMemory: ResourceMetricReading,
  vram: ResourceMetricReading
): ResourceSnapshot => ({
  hostMemory,
  vram,
});

/** A healthy snapshot exactly at the baseline. */
const healthy = (): ResourceSnapshot => snap(ok(BASE), ok(BASE));

/** Both metrics enabled with a 1000-byte baseline. */
const enabledBaseline = () => buildResourceBaseline([healthy(), healthy(), healthy()]);

interface Harness {
  deps: { captureSnapshot: CaptureResourceSnapshot; delay: AbortableDelay };
  captures: number;
  waits: number[];
}

interface HarnessHooks {
  /** Runs before the fake delay checks the signal; use it to simulate an abort mid-wait. */
  beforeDelay?: (index: number) => void;
  /** Runs after the capture resolved its snapshot; use it to abort between steps. */
  afterCapture?: (index: number) => void;
}

function createHarness(snapshots: readonly ResourceSnapshot[], hooks: HarnessHooks = {}): Harness {
  const harness: Harness = {
    captures: 0,
    waits: [],
    deps: {
      captureSnapshot: async ({ signal }) => {
        const index = harness.captures;
        harness.captures += 1;
        const snapshot = snapshots[index];
        if (!snapshot) throw new Error(`unexpected snapshot request #${index + 1}`);
        signal?.throwIfAborted();
        hooks.afterCapture?.(index);
        return snapshot;
      },
      delay: async (ms, signal) => {
        const index = harness.waits.length;
        harness.waits.push(ms);
        hooks.beforeDelay?.(index);
        // A real abortable delay rejects with the caller's reason when aborted while waiting.
        signal?.throwIfAborted();
      },
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Baseline construction
// ---------------------------------------------------------------------------

describe('resource guard - baseline', () => {
  it('takes the median of three trusted values regardless of capture order', () => {
    const baseline = buildResourceBaseline([
      snap(ok(300), ok(30)),
      snap(ok(100), ok(10)),
      snap(ok(200), ok(20)),
    ]);

    expect(baseline.metrics.hostMemory.enabled).toBe(true);
    expect(baseline.metrics.hostMemory.baselineBytes).toBe(200);
    expect(baseline.metrics.hostMemory.trustedSamples).toEqual([300, 100, 200]);
    expect(baseline.metrics.vram.baselineBytes).toBe(20);
    expect(baseline.coverage).toBe('complete');
    expect(baseline.enabledMetrics).toEqual(['hostMemory', 'vram']);
    expect(baseline.warnings).toEqual([]);
  });

  it('takes the median of two trusted values from three attempts', () => {
    const baseline = buildResourceBaseline([
      snap(ok(300), bad()),
      snap(bad('telemetry-refresh-failed'), ok(40)),
      snap(ok(100), ok(60)),
    ]);

    // Median of an even sample count averages the middle pair.
    expect(baseline.metrics.hostMemory.enabled).toBe(true);
    expect(baseline.metrics.hostMemory.baselineBytes).toBe(200);
    expect(baseline.metrics.hostMemory.trustedSamples).toEqual([300, 100]);
    expect(baseline.metrics.vram.baselineBytes).toBe(50);
    expect(baseline.attempts).toBe(3);
  });

  it('disables a metric with fewer than two trusted samples and warns, leaving the other enabled', () => {
    const baseline = buildResourceBaseline([
      snap(ok(1000), bad()),
      snap(bad('telemetry-refresh-failed'), ok(500)),
      snap(bad('telemetry-refresh-failed'), ok(500)),
    ]);

    expect(baseline.metrics.hostMemory.enabled).toBe(false);
    expect(baseline.metrics.hostMemory.baselineBytes).toBeUndefined();
    expect(baseline.metrics.vram.enabled).toBe(true);
    expect(baseline.coverage).toBe('partial');
    expect(baseline.enabledMetrics).toEqual(['vram']);
    expect(baseline.warnings).toHaveLength(1);
    expect(baseline.warnings[0]).toContain('hostMemory');
    expect(baseline.warnings[0]).toContain('1 of 3');
  });

  it('disables a metric whose median is not positive (zero-byte samples cannot be a denominator)', () => {
    const baseline = buildResourceBaseline([
      snap(ok(0), ok(1000)),
      snap(ok(0), ok(1000)),
      snap(ok(0), ok(1000)),
    ]);

    expect(baseline.metrics.hostMemory.enabled).toBe(false);
    expect(baseline.metrics.hostMemory.trustedSamples).toEqual([0, 0, 0]);
    expect(baseline.warnings[0]).toContain('not a finite positive byte count');
    expect(baseline.coverage).toBe('partial');
  });

  it('reports unavailable coverage when neither metric has enough trusted samples', () => {
    const baseline = buildResourceBaseline([
      snap(bad(), bad()),
      snap(bad(), bad()),
      snap(ok(1000), ok(1000)),
    ]);

    expect(baseline.enabledMetrics).toEqual([]);
    expect(baseline.coverage).toBe('unavailable');
    expect(baseline.warnings).toHaveLength(2);
  });

  it('keeps trust independent: a host refresh failure never disables healthy VRAM (and the reverse)', () => {
    const hostBlind = buildResourceBaseline([
      snap(bad('telemetry-refresh-failed'), ok(800)),
      snap(bad('telemetry-refresh-failed'), ok(800)),
      snap(bad('telemetry-refresh-failed'), ok(800)),
    ]);
    expect(hostBlind.metrics.hostMemory.enabled).toBe(false);
    expect(hostBlind.metrics.vram.enabled).toBe(true);
    expect(hostBlind.metrics.vram.baselineBytes).toBe(800);

    const gpuBlind = buildResourceBaseline([
      snap(ok(800), bad('reading-unavailable')),
      snap(ok(800), bad('reading-unavailable')),
      snap(ok(800), bad('reading-unavailable')),
    ]);
    expect(gpuBlind.metrics.hostMemory.enabled).toBe(true);
    expect(gpuBlind.metrics.hostMemory.baselineBytes).toBe(800);
    expect(gpuBlind.metrics.vram.enabled).toBe(false);
  });

  it('computes medians for odd and even sample counts', () => {
    expect(medianOf([5])).toBe(5);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([4, 2])).toBe(3);
    expect(medianOf([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bounded collection
// ---------------------------------------------------------------------------

describe('resource guard - bounded baseline collection', () => {
  it('takes exactly the requested attempts, cooldown-spaced, with no settle delay by default', async () => {
    const harness = createHarness([healthy(), healthy(), healthy()]);

    const baseline = await collectBaseline(harness.deps, { cooldownMs: 750, samples: 3 });

    expect(harness.captures).toBe(3);
    expect(harness.waits).toEqual([750, 750]);
    expect(baseline.coverage).toBe('complete');
  });

  it('waits the fixed settle delay once before the first attempt', async () => {
    const harness = createHarness([healthy(), healthy()]);

    await collectBaseline(harness.deps, { cooldownMs: 750, samples: 2, settleMs: 5000 });

    expect(harness.waits).toEqual([5000, 750]);
    expect(harness.captures).toBe(2);
  });

  it('rejects invalid sample counts and durations', async () => {
    const harness = createHarness([healthy(), healthy(), healthy()]);

    await expect(collectBaseline(harness.deps, { cooldownMs: 750, samples: 1 })).rejects.toThrow(
      RangeError
    );
    await expect(collectBaseline(harness.deps, { cooldownMs: -1 })).rejects.toThrow(RangeError);
    await expect(collectBaseline(harness.deps, { cooldownMs: 750, settleMs: 1.5 })).rejects.toThrow(
      RangeError
    );
    expect(harness.captures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Threshold semantics
// ---------------------------------------------------------------------------

describe('resource guard - threshold semantics', () => {
  it('rejects thresholds outside (0, 100]', () => {
    expect(() =>
      validateResourceStabilityThresholds({ ...THRESHOLDS, hostMemoryDecreaseThresholdPct: 0 })
    ).toThrow(RangeError);
    expect(() =>
      validateResourceStabilityThresholds({ ...THRESHOLDS, vramDecreaseThresholdPct: 100.5 })
    ).toThrow(RangeError);
    expect(() =>
      validateResourceStabilityThresholds({ ...THRESHOLDS, vramDecreaseThresholdPct: Number.NaN })
    ).toThrow(RangeError);
    expect(() =>
      validateResourceStabilityThresholds({ ...THRESHOLDS, hostMemoryDecreaseThresholdPct: 100 })
    ).not.toThrow();
    expect(() =>
      validateResourceStabilityThresholds({ ...BANDED, vramIncreaseThresholdPct: 0 })
    ).toThrow(RangeError);
    expect(() =>
      validateResourceStabilityThresholds({ ...BANDED, hostMemoryIncreaseThresholdPct: 101 })
    ).toThrow(RangeError);
    // An omitted increase band is legal: that metric is simply not guarded upward.
    expect(() =>
      validateResourceStabilityThresholds({
        ...BANDED,
        hostMemoryIncreaseThresholdPct: undefined,
      })
    ).not.toThrow();
  });

  it('admits a decrease just below the threshold without confirming', async () => {
    const harness = createHarness([snap(ok(751), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
      boundary: 'pre-launch',
    });

    expect(result.conclusion).toBe('admitted');
    expect(result.confirmationPerformed).toBe(false);
    expect(result.boundary).toBe('pre-launch');
    expect(harness.captures).toBe(1);
    expect(harness.waits).toEqual([]);
    expect(result.initial.metrics.hostMemory.decreasePctFromBaseline).toBeCloseTo(24.9, 10);
  });

  it('treats a decrease exactly at the threshold as suspicious (inclusive comparison)', async () => {
    const harness = createHarness([snap(ok(750), ok(BASE)), snap(ok(BASE), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.initial.metrics.hostMemory.decreasePctFromBaseline).toBe(25);
    expect(result.initial.suspiciousMetrics).toEqual(['hostMemory']);
    expect(result.confirmationPerformed).toBe(true);
    expect(result.conclusion).toBe('admitted');
  });

  it('treats a decrease just above the threshold as suspicious', async () => {
    const harness = createHarness([snap(ok(749), ok(BASE)), snap(ok(749), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
  });

  it('leaves an increase unguarded when no increase band is configured', async () => {
    const harness = createHarness([snap(ok(1400), ok(2000))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.conclusion).toBe('admitted');
    expect(result.initial.metrics.hostMemory.decreasePctFromBaseline).toBe(-40);
    expect(result.initial.metrics.hostMemory.decisionDecreasePct).toBe(0);
    expect(result.initial.metrics.hostMemory.decisionIncreasePct).toBe(40);
    expect(result.initial.metrics.vram.decreasePctFromBaseline).toBe(-100);
    expect(result.initial.suspiciousMetrics).toEqual([]);
    expect(harness.captures).toBe(1);
  });

  it('admits an increase strictly inside its band and records the direction of one at it', async () => {
    // 1199/1000 is +19.9 % - inside the 20 % host band, so no confirmation is taken at all.
    const inside = createHarness([snap(ok(1199), ok(BASE))]);
    const admitted = await checkBoundary(inside.deps, {
      baseline: enabledBaseline(),
      thresholds: BANDED,
      cooldownMs: 750,
    });
    expect(admitted.conclusion).toBe('admitted');
    expect(admitted.confirmationPerformed).toBe(false);
    expect(inside.captures).toBe(1);

    // Exactly at the band is suspicious, the same inclusive rule the decrease side uses.
    const atBand = createHarness([snap(ok(1200), ok(BASE)), snap(ok(1200), ok(BASE))]);
    const confirmed = await checkBoundary(atBand.deps, {
      baseline: enabledBaseline(),
      thresholds: BANDED,
      cooldownMs: 750,
      boundary: 'pre-launch',
    });
    expect(confirmed.initial.metrics.hostMemory.decreasePctFromBaseline).toBe(-20);
    expect(confirmed.initial.metrics.hostMemory.suspiciousDirection).toBe('increase');
    expect(confirmed.conclusion).toBe('confirmed-drift');
    expect(confirmed.affectedMetrics).toEqual(['hostMemory']);
    expect(confirmed.affectedMetricDirections).toEqual({ hostMemory: 'increase' });
  });

  it('admits an increase that recovers into the band on confirmation', async () => {
    const harness = createHarness([snap(ok(BASE), ok(1500)), snap(ok(BASE), ok(1100))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: BANDED,
      cooldownMs: 750,
    });

    expect(result.initial.suspiciousMetrics).toEqual(['vram']);
    expect(result.confirmationPerformed).toBe(true);
    expect(result.conclusion).toBe('admitted');
    expect(result.affectedMetrics).toEqual([]);
    expect(result.affectedMetricDirections).toEqual({});
  });

  it('reports both directions through one conclusion path with per-metric directions', async () => {
    // Host fell 30 % while VRAM rose 60 %: two crossings, opposite directions, one conclusion.
    const harness = createHarness([snap(ok(700), ok(1600)), snap(ok(700), ok(1600))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: BANDED,
      cooldownMs: 750,
      boundary: 'post-cleanup',
    });

    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory', 'vram']);
    expect(result.affectedMetricDirections).toEqual({
      hostMemory: 'decrease',
      vram: 'increase',
    });
  });

  it('treats a zero-byte trusted reading as the most severe valid decrease, not missing telemetry', async () => {
    const harness = createHarness([snap(ok(0), ok(BASE)), snap(ok(0), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.initial.metrics.hostMemory.trusted).toBe(true);
    expect(result.initial.metrics.hostMemory.availableBytes).toBe(0);
    expect(result.initial.metrics.hostMemory.decreasePctFromBaseline).toBe(100);
    expect(result.initial.untrustedMetrics).toEqual([]);
    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
  });

  it('ignores a disabled metric entirely, however large its apparent decrease', async () => {
    const baseline = buildResourceBaseline([
      snap(ok(BASE), bad()),
      snap(ok(BASE), bad()),
      snap(ok(BASE), ok(BASE)),
    ]);
    const harness = createHarness([snap(ok(BASE), ok(1))]);

    const result = await checkBoundary(harness.deps, {
      baseline,
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(baseline.metrics.vram.enabled).toBe(false);
    expect(result.conclusion).toBe('admitted');
    expect(result.initial.metrics.vram.enabled).toBe(false);
    expect(result.initial.metrics.vram.suspicious).toBe(false);
    expect(result.initial.metrics.vram.decreasePctFromBaseline).toBeUndefined();
    expect(harness.captures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Confirmation protocol
// ---------------------------------------------------------------------------

describe('resource guard - confirmation protocol', () => {
  it('records an isolated untrusted reading, warns, and never manufactures drift', async () => {
    const harness = createHarness([snap(bad('telemetry-refresh-failed'), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
      boundary: 'post-cleanup',
    });

    expect(result.conclusion).toBe('admitted');
    expect(result.confirmationPerformed).toBe(false);
    expect(result.initial.untrustedMetrics).toEqual(['hostMemory']);
    expect(result.affectedMetrics).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('cannot indicate resource drift');
    expect(harness.captures).toBe(1);
    expect(harness.waits).toEqual([]);
  });

  it('admits a transient suspicion that recovers on confirmation, after exactly one cooldown', async () => {
    const harness = createHarness([snap(ok(700), ok(BASE)), snap(ok(990), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
      boundary: 'post-cleanup',
    });

    expect(result.conclusion).toBe('admitted');
    expect(result.confirmationPerformed).toBe(true);
    expect(result.initiallySuspiciousMetrics).toEqual(['hostMemory']);
    expect(result.affectedMetrics).toEqual([]);
    expect(harness.captures).toBe(2);
    expect(harness.waits).toEqual([750]);
  });

  it('confirms drift when the same metric stays suspicious in both snapshots', async () => {
    const harness = createHarness([snap(ok(700), ok(BASE)), snap(ok(690), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
      boundary: 'pre-launch',
    });

    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
    expect(result.confirmation?.metrics.hostMemory.suspicious).toBe(true);
    expect(harness.captures).toBe(2);
  });

  it('fails as stability-unverified when the suspicious metric becomes untrusted', async () => {
    const harness = createHarness([
      snap(ok(700), ok(BASE)),
      snap(bad('telemetry-refresh-failed'), ok(BASE)),
    ]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.conclusion).toBe('stability-unverified');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
    expect(result.warnings.some((warning) => warning.includes('telemetry-refresh-failed'))).toBe(
      true
    );
    expect(harness.captures).toBe(2);
  });

  it('fails as stability-unverified when a different metric becomes newly suspicious', async () => {
    const harness = createHarness([snap(ok(700), ok(BASE)), snap(ok(BASE), ok(400))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.conclusion).toBe('stability-unverified');
    expect(result.affectedMetrics).toEqual(['vram']);
    expect(result.warnings.some((warning) => warning.includes('newly suspicious'))).toBe(true);
  });

  it('gives confirmed drift precedence over an untrusted second metric', async () => {
    const harness = createHarness([
      snap(ok(700), ok(400)),
      snap(ok(700), bad('reading-unavailable')),
    ]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.initiallySuspiciousMetrics).toEqual(['hostMemory', 'vram']);
    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
  });

  it('gives confirmed drift precedence over a newly suspicious second metric', async () => {
    const harness = createHarness([snap(ok(700), ok(BASE)), snap(ok(700), ok(400))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.conclusion).toBe('confirmed-drift');
    expect(result.affectedMetrics).toEqual(['hostMemory']);
    expect(result.warnings.some((warning) => warning.includes('newly suspicious'))).toBe(true);
  });

  it('admits only when every initially suspicious metric recovered', async () => {
    const harness = createHarness([snap(ok(700), ok(400)), snap(ok(BASE), ok(BASE))]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
    });

    expect(result.initiallySuspiciousMetrics).toEqual(['hostMemory', 'vram']);
    expect(result.conclusion).toBe('admitted');
    expect(result.affectedMetrics).toEqual([]);
  });

  it('never admits a suspicious boundary that was not confirmed at all', () => {
    const baseline = enabledBaseline();
    const initial = evaluateResourceSnapshot(baseline, snap(ok(700), ok(BASE)), THRESHOLDS);

    const result = concludeResourceBoundary({ boundary: 'pre-launch', initial });

    expect(result.conclusion).toBe('stability-unverified');
    expect(result.confirmationPerformed).toBe(false);
    expect(result.affectedMetrics).toEqual(['hostMemory']);
  });

  it('keeps confirmation reads bounded and merges several reads conservatively', async () => {
    // Read 1 still suspicious, read 2 recovered: the earlier observation must not be erased.
    const harness = createHarness([
      snap(ok(700), ok(BASE)),
      snap(ok(700), ok(BASE)),
      snap(ok(BASE), ok(BASE)),
    ]);

    const result = await checkBoundary(harness.deps, {
      baseline: enabledBaseline(),
      thresholds: THRESHOLDS,
      cooldownMs: 750,
      confirmationReads: 2,
    });

    expect(result.conclusion).toBe('confirmed-drift');
    expect(harness.captures).toBe(3);
    expect(harness.waits).toEqual([750, 750]);
  });

  it('merges multiple confirmation reads by worst trusted value and any untrusted read', () => {
    const baseline = enabledBaseline();
    const first = evaluateResourceSnapshot(baseline, snap(ok(900), ok(BASE)), THRESHOLDS);
    const second = evaluateResourceSnapshot(baseline, snap(ok(800), bad()), THRESHOLDS);

    const merged = mergeResourceSnapshotEvaluations([first, second]);

    expect(merged.metrics.hostMemory.availableBytes).toBe(800);
    expect(merged.metrics.vram.trusted).toBe(false);
    expect(merged.untrustedMetrics).toEqual(['vram']);
    expect(mergeResourceSnapshotEvaluations([first])).toBe(first);
    expect(() => mergeResourceSnapshotEvaluations([])).toThrow(RangeError);
  });

  it('rejects invalid thresholds and confirmation counts before reading anything', async () => {
    const harness = createHarness([healthy()]);

    await expect(
      checkBoundary(harness.deps, {
        baseline: enabledBaseline(),
        thresholds: { hostMemoryDecreaseThresholdPct: 0, vramDecreaseThresholdPct: 50 },
        cooldownMs: 750,
      })
    ).rejects.toThrow(RangeError);
    await expect(
      checkBoundary(harness.deps, {
        baseline: enabledBaseline(),
        thresholds: THRESHOLDS,
        cooldownMs: 750,
        confirmationReads: 0,
      })
    ).rejects.toThrow(RangeError);
    expect(harness.captures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort behaviour
// ---------------------------------------------------------------------------

describe('resource guard - abort', () => {
  it('rejects promptly with the caller reason during the settle delay', async () => {
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    const harness = createHarness([healthy(), healthy(), healthy()], {
      beforeDelay: (index) => {
        if (index === 0) controller.abort(reason);
      },
    });

    await expect(
      collectBaseline(harness.deps, {
        cooldownMs: 750,
        samples: 3,
        settleMs: 5000,
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(harness.waits).toEqual([5000]);
    expect(harness.captures).toBe(0);
  });

  it('rejects promptly with the caller reason between baseline samples', async () => {
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    const harness = createHarness([healthy(), healthy(), healthy()], {
      beforeDelay: (index) => {
        if (index === 0) controller.abort(reason);
      },
    });

    await expect(
      collectBaseline(harness.deps, { cooldownMs: 750, samples: 3, signal: controller.signal })
    ).rejects.toBe(reason);
    expect(harness.captures).toBe(1);
    expect(harness.waits).toEqual([750]);
  });

  it('rejects promptly with the caller reason before the confirmation snapshot', async () => {
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    const harness = createHarness([snap(ok(700), ok(BASE)), snap(ok(700), ok(BASE))], {
      afterCapture: (index) => {
        if (index === 0) controller.abort(reason);
      },
    });

    await expect(
      checkBoundary(harness.deps, {
        baseline: enabledBaseline(),
        thresholds: THRESHOLDS,
        cooldownMs: 750,
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(harness.captures).toBe(1);
    expect(harness.waits).toEqual([]);
  });

  it('rejects an already-aborted boundary check before capturing anything', async () => {
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    controller.abort(reason);
    const harness = createHarness([healthy()]);

    await expect(
      checkBoundary(harness.deps, {
        baseline: enabledBaseline(),
        thresholds: THRESHOLDS,
        cooldownMs: 750,
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(harness.captures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Telemetry adapter
// ---------------------------------------------------------------------------

describe('resource guard - telemetry adapter', () => {
  const createSource = (overrides: {
    refresh?: (options?: ResourceTelemetryReadOptions) => Promise<MemoryTelemetryRefreshStatus>;
    memory?: () => { available: number };
    gpu?: (options?: ResourceTelemetryReadOptions) => Promise<{ vramAvailable?: number }>;
  }) => ({
    refreshMemoryTelemetry: overrides.refresh ?? (async () => 'refreshed' as const),
    getMemoryInfo: overrides.memory ?? (() => ({ available: 4096 })),
    getGPUInfo: overrides.gpu ?? (async () => ({ vramAvailable: 2048 })),
  });

  it('trusts host memory for refreshed and not-required statuses', async () => {
    for (const status of ['refreshed', 'not-required'] as const) {
      const capture = createTelemetrySnapshotCapture(
        createSource({ refresh: async () => status }),
        { telemetryTimeoutMs: 2000 }
      );
      const snapshot = await capture({});
      expect(snapshot.hostMemory).toEqual({ trusted: true, availableBytes: 4096 });
      expect(snapshot.vram).toEqual({ trusted: true, availableBytes: 2048 });
    }
  });

  it('distrusts host memory on a failed refresh without touching the stale value or VRAM', async () => {
    const getMemoryInfo = jest.fn(() => ({ available: 4096 }));
    const capture = createTelemetrySnapshotCapture(
      createSource({ refresh: async () => 'failed' as const, memory: getMemoryInfo })
    );

    const snapshot = await capture({});

    expect(snapshot.hostMemory).toEqual({
      trusted: false,
      untrustedReason: 'telemetry-refresh-failed',
    });
    expect(getMemoryInfo).not.toHaveBeenCalled();
    expect(snapshot.vram).toEqual({ trusted: true, availableBytes: 2048 });
  });

  it('keeps a healthy host reading when GPU telemetry fails or is absent', async () => {
    const failing = createTelemetrySnapshotCapture(
      createSource({
        gpu: async () => {
          throw new Error('nvidia-smi missing');
        },
      })
    );
    const absent = createTelemetrySnapshotCapture(createSource({ gpu: async () => ({}) }));
    const invalid = createTelemetrySnapshotCapture(
      createSource({ gpu: async () => ({ vramAvailable: Number.NaN }) })
    );

    expect(await failing({})).toEqual({
      hostMemory: { trusted: true, availableBytes: 4096 },
      vram: { trusted: false, untrustedReason: 'reading-unavailable' },
    });
    expect((await absent({})).vram).toEqual({
      trusted: false,
      untrustedReason: 'reading-unavailable',
    });
    expect((await invalid({})).vram).toEqual({
      trusted: false,
      untrustedReason: 'reading-invalid',
    });
  });

  it('treats a throwing or invalid host reading as untrusted, not as zero bytes', async () => {
    const throwing = createTelemetrySnapshotCapture(
      createSource({
        memory: () => {
          throw new Error('memory telemetry unavailable');
        },
      })
    );
    const invalid = createTelemetrySnapshotCapture(
      createSource({ memory: () => ({ available: -1 }) })
    );

    expect((await throwing({})).hostMemory).toEqual({
      trusted: false,
      untrustedReason: 'reading-unavailable',
    });
    expect((await invalid({})).hostMemory).toEqual({
      trusted: false,
      untrustedReason: 'reading-invalid',
    });
  });

  it('accepts a zero-byte reading as trusted', async () => {
    const capture = createTelemetrySnapshotCapture(
      createSource({ memory: () => ({ available: 0 }), gpu: async () => ({ vramAvailable: 0 }) })
    );

    expect(await capture({})).toEqual({
      hostMemory: { trusted: true, availableBytes: 0 },
      vram: { trusted: true, availableBytes: 0 },
    });
  });

  it('forwards the abort signal and bounded timeout, and rejects on abort', async () => {
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    const refresh = jest.fn(async (options?: { signal?: AbortSignal; timeoutMs?: number }) => {
      expect(options?.signal).toBe(controller.signal);
      expect(options?.timeoutMs).toBe(1500);
      controller.abort(reason);
      throw reason;
    });
    const capture = createTelemetrySnapshotCapture(createSource({ refresh }), {
      telemetryTimeoutMs: 1500,
    });

    await expect(capture({ signal: controller.signal })).rejects.toBe(reason);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
