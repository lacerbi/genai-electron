/**
 * TEMPORARY Phase-0.8 shadow observation for the calibration resource guard.
 *
 * This module exists only so plan Phase 1 can collect production-timed quiet traces through the
 * exact code path that Phase 2/3 will later enforce. It is deliberately:
 *
 * - **Not exported from `src/index.ts`.** There is no caller-facing shadow option, and no host can
 *   reach it through the public API. The development harness under
 *   `scripts/calibration-quiet-trace/` deep-imports the built module instead.
 * - **Inert unless armed.** {@link getCalibrationResourceShadow} returns `undefined` until
 *   {@link armCalibrationResourceShadow} is called, so every manager hook is a single cheap check.
 * - **Decision-free.** Nothing here returns a value the manager acts on. Conclusions are recorded
 *   into a trace and dropped. Failures - telemetry throwing, the caller aborting mid-read - are
 *   caught and recorded as notes; they never propagate into calibration.
 *
 * The one thing the shadow cannot hide is time. Its settle/cooldown/confirmation waits are real
 * waits on the real machine, so an armed run takes longer than a disarmed one and the adaptive wall
 * budget sees that. Guard-added time is measured per event and totalled on the trace rather than
 * being pretended away; harness configurations must leave ample wall budget.
 *
 * Deleted by plan Phase 2.10 / 3.8, when the manager hooks become the enforcing path.
 *
 * @module utils/llama-resource-guard-shadow
 */

import {
  abortableDelay,
  checkBoundary,
  collectBaseline,
  createTelemetrySnapshotCapture,
  DEFAULT_BASELINE_SAMPLE_ATTEMPTS,
  DEFAULT_CONFIRMATION_READS,
} from './llama-resource-guard-capture.js';
import type {
  AbortableDelay,
  CaptureResourceSnapshot,
  ResourceTelemetrySource,
} from './llama-resource-guard-capture.js';
import type {
  ResourceBaseline,
  ResourceBoundaryKind,
  ResourceBoundaryResult,
  ResourceDecreaseThresholds,
  ResourceSnapshot,
} from './llama-resource-guard.js';

/** Which calibration strategy produced an observation. */
export type CalibrationResourceShadowStrategy = 'adaptive' | 'exact';

/** Fields every trace event carries, so a trace is self-describing without a separate index. */
export interface CalibrationResourceShadowEventBase {
  /** Position in this trace, from 0, in the order the events completed. */
  sequence: number;
  /** Monotonic `performance.now()` when the event finished. */
  atMs: number;
  /** Monotonic ms between arming the shadow and the event finishing. */
  sinceArmMs: number;
  /** Wall time this event itself consumed - the guard-added cost of the observation. */
  wallMs: number;
}

export interface CalibrationResourceShadowBaselineEvent extends CalibrationResourceShadowEventBase {
  type: 'baseline';
  strategy: CalibrationResourceShadowStrategy;
  settleMs: number;
  cooldownMs: number;
  requestedSamples: number;
  /** Every attempted snapshot, in capture order, including untrusted ones. */
  snapshots: readonly ResourceSnapshot[];
  /** Per-metric baseline/enablement/warnings. Absent when collection failed. */
  baseline?: ResourceBaseline;
  /** Present when the collection threw or aborted; the baseline is then unusable. */
  error?: string;
}

export interface CalibrationResourceShadowBoundaryEvent extends CalibrationResourceShadowEventBase {
  type: 'boundary';
  strategy: CalibrationResourceShadowStrategy;
  boundary: ResourceBoundaryKind;
  /** Chronological index of the probe this boundary belongs to. */
  probeOrdinal: number;
  /** Cooldown waited before the initial read (post-cleanup only; 0 for pre-launch). */
  preReadCooldownMs: number;
  initialSnapshot?: ResourceSnapshot;
  confirmationPerformed: boolean;
  /** Confirmation reads in capture order; empty when the initial read was clean. */
  confirmationSnapshots: readonly ResourceSnapshot[];
  /** The pure conclusion. Recorded only - the manager never reads it in shadow mode. */
  result?: ResourceBoundaryResult;
  error?: string;
}

export interface CalibrationResourceShadowExtraSampleEvent
  extends CalibrationResourceShadowEventBase {
  type: 'extra-sample';
  strategy: CalibrationResourceShadowStrategy;
  probeOrdinal: number;
  /** Configured offset from the teardown-confirmed instant. */
  offsetMs: number;
  /** Offset actually achieved, so scheduling slip is visible rather than assumed away. */
  actualOffsetMs?: number;
  snapshot?: ResourceSnapshot;
  error?: string;
}

/**
 * What the shipped v0.19 resource logic concluded for the same probe.
 *
 * Recorded so a trace can compare the old min(pre, post)/re-anchoring view against the new
 * fixed-baseline view without a second live run.
 */
export interface CalibrationResourceShadowLegacyOutcome {
  /** v0.19 `hostAvailableMemory.decreasePct`, measured against its re-anchorable baseline. */
  hostDecreasePct?: number;
  /** v0.19 `gpuAvailableMemory.decreasePct`. */
  gpuDecreasePct?: number;
  hostComparability?: string;
  gpuComparability?: string;
  /** v0.19 resource regime index at the time of the observation. */
  resourceRegime?: number;
  /** v0.19 `resourceDriftStatus` fed to the adaptive policy. */
  resourceDriftStatus?: string;
  /** v0.19 per-probe diagnostic warnings, including any re-anchor/regime warning. */
  warnings?: readonly string[];
}

export interface CalibrationResourceShadowLegacyEvent extends CalibrationResourceShadowEventBase {
  type: 'legacy-outcome';
  strategy: CalibrationResourceShadowStrategy;
  probeOrdinal: number;
  outcome: CalibrationResourceShadowLegacyOutcome;
}

export interface CalibrationResourceShadowNoteEvent extends CalibrationResourceShadowEventBase {
  type: 'note';
  message: string;
  detail?: unknown;
}

export type CalibrationResourceShadowEvent =
  | CalibrationResourceShadowBaselineEvent
  | CalibrationResourceShadowBoundaryEvent
  | CalibrationResourceShadowExtraSampleEvent
  | CalibrationResourceShadowLegacyEvent
  | CalibrationResourceShadowNoteEvent;

/** One event without the fields the recorder stamps. Distributes over the union deliberately. */
type CalibrationResourceShadowEventPayload<
  Event extends CalibrationResourceShadowEvent = CalibrationResourceShadowEvent,
> = Event extends CalibrationResourceShadowEvent
  ? Omit<Event, keyof CalibrationResourceShadowEventBase>
  : never;

/** The schedule actually used, echoed into every trace so an artifact is self-contained. */
export interface CalibrationResourceShadowSchedule {
  /**
   * Shadow thresholds. Phase 1 arms the LOWEST replay candidate (for example 10/10) so a
   * confirmation is triggered - and therefore captured - for every candidate at or above it, and
   * higher candidates can be replayed offline from the retained snapshots.
   */
  thresholds: ResourceDecreaseThresholds;
  cooldownMs: number;
  settleMs: number;
  baselineSamples: number;
  confirmationReads: number;
  telemetryTimeoutMs?: number;
  /** Extra post-teardown diagnostic offsets (plan Phase 1.5), ascending. */
  postCleanupExtraSampleOffsetsMs: readonly number[];
}

export interface CalibrationResourceShadowConfig {
  thresholds: ResourceDecreaseThresholds;
  /** Cooldown before the initial post-cleanup read and before each confirmation read. */
  cooldownMs: number;
  /** Fixed settle delay before the first baseline attempt. */
  settleMs?: number;
  baselineSamples?: number;
  confirmationReads?: number;
  telemetryTimeoutMs?: number;
  postCleanupExtraSampleOffsetsMs?: readonly number[];
  /** Free-form label recorded on the trace (for example the harness cell name). */
  label?: string;
  /** Live sink for events, in addition to the buffered trace. */
  onEvent?: (event: CalibrationResourceShadowEvent) => void;
  /** Test seam: replaces telemetry capture entirely. */
  captureSnapshot?: CaptureResourceSnapshot;
  /** Test seam: replaces every wait. */
  delay?: AbortableDelay;
}

export interface CalibrationResourceShadowTrace {
  label?: string;
  /** Wall-clock time the shadow was armed. */
  armedAt: string;
  schedule: CalibrationResourceShadowSchedule;
  events: readonly CalibrationResourceShadowEvent[];
  /** Total wall time the shadow itself consumed for these events. */
  guardAddedMs: number;
}

export interface CalibrationResourceShadowObserveOptions {
  source: ResourceTelemetrySource;
  strategy: CalibrationResourceShadowStrategy;
  signal?: AbortSignal;
}

export interface CalibrationResourceShadowBoundaryOptions
  extends CalibrationResourceShadowObserveOptions {
  probeOrdinal: number;
}

export interface CalibrationResourceShadowPostCleanupOptions
  extends CalibrationResourceShadowBoundaryOptions {
  /**
   * Invoked after the cooldown and immediately before the initial read - the manager passes
   * `systemInfo.clearCache()` so the shadow reads exactly what the enforcing path will read.
   */
  beforeInitialRead?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Buffered observation state for one armed session.
 *
 * All public methods are total: they never throw and never return a decision.
 */
export class CalibrationResourceShadow {
  readonly schedule: CalibrationResourceShadowSchedule;
  readonly label?: string;
  private readonly armedAtWallClock = new Date().toISOString();
  private readonly armedAtMonotonic = performance.now();
  private readonly onEvent?: (event: CalibrationResourceShadowEvent) => void;
  private readonly captureOverride?: CaptureResourceSnapshot;
  private readonly delay: AbortableDelay;
  private events: CalibrationResourceShadowEvent[] = [];
  private sequence = 0;
  private guardAddedMs = 0;
  private baseline?: ResourceBaseline;

  constructor(config: CalibrationResourceShadowConfig) {
    this.schedule = {
      thresholds: { ...config.thresholds },
      cooldownMs: config.cooldownMs,
      settleMs: config.settleMs ?? 0,
      baselineSamples: config.baselineSamples ?? DEFAULT_BASELINE_SAMPLE_ATTEMPTS,
      confirmationReads: config.confirmationReads ?? DEFAULT_CONFIRMATION_READS,
      telemetryTimeoutMs: config.telemetryTimeoutMs,
      postCleanupExtraSampleOffsetsMs: [...(config.postCleanupExtraSampleOffsetsMs ?? [])].sort(
        (left, right) => left - right
      ),
    };
    this.label = config.label;
    this.onEvent = config.onEvent;
    this.captureOverride = config.captureSnapshot;
    this.delay = config.delay ?? abortableDelay;
  }

  /** Whether a usable baseline exists, i.e. whether boundary observation can run at all. */
  hasBaseline(): boolean {
    return this.baseline !== undefined;
  }

  /**
   * Drain the accumulated trace.
   *
   * Successive calls partition the trace rather than repeating it, and the guard-added total is
   * reset with the buffer, so a harness can take one trace per `calibrate()` call.
   */
  takeTrace(): CalibrationResourceShadowTrace {
    const trace: CalibrationResourceShadowTrace = {
      ...(this.label !== undefined ? { label: this.label } : {}),
      armedAt: this.armedAtWallClock,
      schedule: this.schedule,
      events: this.events,
      guardAddedMs: this.guardAddedMs,
    };
    this.events = [];
    this.guardAddedMs = 0;
    return trace;
  }

  /** Record a free-form observation. Used for every caught shadow failure. */
  recordNote(message: string, detail?: unknown): void {
    this.push({ type: 'note', message, ...(detail !== undefined ? { detail } : {}) }, 0);
  }

  /** Record what the shipped v0.19 logic concluded for the same probe. */
  recordLegacyOutcome(options: {
    strategy: CalibrationResourceShadowStrategy;
    probeOrdinal: number;
    outcome: CalibrationResourceShadowLegacyOutcome;
  }): void {
    this.push(
      {
        type: 'legacy-outcome',
        strategy: options.strategy,
        probeOrdinal: options.probeOrdinal,
        outcome: options.outcome,
      },
      0
    );
  }

  /**
   * Collect the run's fixed baseline: settle delay, then cooldown-spaced attempts.
   *
   * Called after provisioning/preparation and before the probe loop starts. A failure leaves the
   * shadow baseline-less, which only means later boundary observations are skipped with a note.
   */
  async observeBaseline(options: CalibrationResourceShadowObserveOptions): Promise<void> {
    const startedAt = performance.now();
    const snapshots: ResourceSnapshot[] = [];
    try {
      const baseline = await collectBaseline(
        {
          captureSnapshot: this.recordingCapture(options.source, snapshots),
          delay: this.delay,
        },
        {
          cooldownMs: this.schedule.cooldownMs,
          samples: this.schedule.baselineSamples,
          settleMs: this.schedule.settleMs,
          ...(options.signal ? { signal: options.signal } : {}),
        }
      );
      this.baseline = baseline;
      this.push(
        {
          type: 'baseline',
          strategy: options.strategy,
          settleMs: this.schedule.settleMs,
          cooldownMs: this.schedule.cooldownMs,
          requestedSamples: this.schedule.baselineSamples,
          snapshots,
          baseline,
        },
        performance.now() - startedAt
      );
    } catch (error) {
      this.push(
        {
          type: 'baseline',
          strategy: options.strategy,
          settleMs: this.schedule.settleMs,
          cooldownMs: this.schedule.cooldownMs,
          requestedSamples: this.schedule.baselineSamples,
          snapshots,
          error: errorMessage(error),
        },
        performance.now() - startedAt
      );
      this.recordNote('shadow baseline collection failed; boundary observation is disabled', {
        error: errorMessage(error),
      });
    }
  }

  /**
   * Observe the pre-launch boundary immediately before the executor is invoked.
   *
   * No cooldown: the enforcing path checks the machine as it is at launch time.
   */
  async observePreLaunch(options: CalibrationResourceShadowBoundaryOptions): Promise<void> {
    await this.observeBoundary('pre-launch', 0, options);
  }

  /**
   * Observe the post-cleanup boundary once teardown is confirmed.
   *
   * Runs the production sequence in full: cooldown, cache invalidation, initial read, and - only if
   * the initial read is suspicious at the armed thresholds - one further cooldown plus confirmation.
   * Any configured extra diagnostic offsets are then sampled relative to the teardown instant.
   */
  async observePostCleanup(options: CalibrationResourceShadowPostCleanupOptions): Promise<void> {
    const teardownAt = performance.now();
    await this.observeBoundary('post-cleanup', this.schedule.cooldownMs, options);
    for (const offsetMs of this.schedule.postCleanupExtraSampleOffsetsMs) {
      const startedAt = performance.now();
      try {
        const waitMs = Math.max(0, Math.round(teardownAt + offsetMs - performance.now()));
        if (waitMs > 0) await this.delay(waitMs, options.signal);
        const snapshot = await this.capture(options.source)({
          ...(options.signal ? { signal: options.signal } : {}),
        });
        this.push(
          {
            type: 'extra-sample',
            strategy: options.strategy,
            probeOrdinal: options.probeOrdinal,
            offsetMs,
            actualOffsetMs: performance.now() - teardownAt,
            snapshot,
          },
          performance.now() - startedAt
        );
      } catch (error) {
        this.push(
          {
            type: 'extra-sample',
            strategy: options.strategy,
            probeOrdinal: options.probeOrdinal,
            offsetMs,
            error: errorMessage(error),
          },
          performance.now() - startedAt
        );
        return;
      }
    }
  }

  private async observeBoundary(
    boundary: ResourceBoundaryKind,
    preReadCooldownMs: number,
    options: CalibrationResourceShadowPostCleanupOptions
  ): Promise<void> {
    const baseline = this.baseline;
    if (!baseline) {
      this.recordNote(`shadow ${boundary} boundary skipped: no baseline was collected`, {
        probeOrdinal: options.probeOrdinal,
        strategy: options.strategy,
      });
      return;
    }
    const startedAt = performance.now();
    const snapshots: ResourceSnapshot[] = [];
    try {
      if (preReadCooldownMs > 0) await this.delay(preReadCooldownMs, options.signal);
      options.beforeInitialRead?.();
      const result = await checkBoundary(
        {
          captureSnapshot: this.recordingCapture(options.source, snapshots),
          delay: this.delay,
        },
        {
          baseline,
          thresholds: this.schedule.thresholds,
          cooldownMs: this.schedule.cooldownMs,
          confirmationReads: this.schedule.confirmationReads,
          boundary,
          ...(options.signal ? { signal: options.signal } : {}),
        }
      );
      const [initialSnapshot, ...confirmationSnapshots] = snapshots;
      this.push(
        {
          type: 'boundary',
          strategy: options.strategy,
          boundary,
          probeOrdinal: options.probeOrdinal,
          preReadCooldownMs,
          ...(initialSnapshot ? { initialSnapshot } : {}),
          confirmationPerformed: result.confirmationPerformed,
          confirmationSnapshots,
          result,
        },
        performance.now() - startedAt
      );
    } catch (error) {
      const [initialSnapshot, ...confirmationSnapshots] = snapshots;
      this.push(
        {
          type: 'boundary',
          strategy: options.strategy,
          boundary,
          probeOrdinal: options.probeOrdinal,
          preReadCooldownMs,
          ...(initialSnapshot ? { initialSnapshot } : {}),
          confirmationPerformed: confirmationSnapshots.length > 0,
          confirmationSnapshots,
          error: errorMessage(error),
        },
        performance.now() - startedAt
      );
      this.recordNote(`shadow ${boundary} boundary observation failed`, {
        probeOrdinal: options.probeOrdinal,
        error: errorMessage(error),
      });
    }
  }

  private capture(source: ResourceTelemetrySource): CaptureResourceSnapshot {
    if (this.captureOverride) return this.captureOverride;
    return createTelemetrySnapshotCapture(source, {
      ...(this.schedule.telemetryTimeoutMs !== undefined
        ? { telemetryTimeoutMs: this.schedule.telemetryTimeoutMs }
        : {}),
    });
  }

  /** Wrap capture so every attempted snapshot is retained, including the ones that stay untrusted. */
  private recordingCapture(
    source: ResourceTelemetrySource,
    sink: ResourceSnapshot[]
  ): CaptureResourceSnapshot {
    const capture = this.capture(source);
    return async (captureOptions) => {
      const snapshot = await capture(captureOptions);
      sink.push(snapshot);
      return snapshot;
    };
  }

  private push(event: CalibrationResourceShadowEventPayload, wallMs: number): void {
    const atMs = performance.now();
    const complete = {
      ...event,
      sequence: this.sequence++,
      atMs,
      sinceArmMs: atMs - this.armedAtMonotonic,
      wallMs,
    } as CalibrationResourceShadowEvent;
    this.events.push(complete);
    this.guardAddedMs += wallMs;
    try {
      this.onEvent?.(complete);
    } catch {
      // A trace sink must never be able to influence calibration.
    }
  }
}

let activeShadow: CalibrationResourceShadow | undefined;

/**
 * Arm the process-wide shadow observer.
 *
 * Replaces any previously armed shadow. Intended to be called by the development harness
 * immediately before one `calibrate()` call.
 */
export function armCalibrationResourceShadow(
  config: CalibrationResourceShadowConfig
): CalibrationResourceShadow {
  activeShadow = new CalibrationResourceShadow(config);
  return activeShadow;
}

/** Disarm the shadow and drain whatever it still holds. Later runs are traceless. */
export function disarmCalibrationResourceShadow(): CalibrationResourceShadowTrace | undefined {
  const trace = activeShadow?.takeTrace();
  activeShadow = undefined;
  return trace;
}

/** The armed shadow, or `undefined` when the manager hooks must stay inert. */
export function getCalibrationResourceShadow(): CalibrationResourceShadow | undefined {
  return activeShadow;
}
