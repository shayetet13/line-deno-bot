import type { RaceStats } from '../adapters/racing.ts';
import type { Clock } from '../lib/clock.ts';
import type { MetricsRecorder, MetricsSnapshot } from '../metrics/recorder.ts';
import type { LatencySnapshot } from '../metrics/ring.ts';
import type { ReadinessFsm, ReadinessSnapshot } from '../readiness/state.ts';
import type { LanePool } from '../transport/lane-pool.ts';
import type { WarmerStatus } from '../warm/warmer.ts';
import { classifyLanes, type LaneView } from './status.ts';

/** Everything one worker reports. Assembled off the hot path, on request. */
export interface StatusSnapshot {
  workerId: string;
  origin: string;
  /** Wall-clock ms when this snapshot was built, for the UI to show staleness. */
  generatedAtMs: number;
  uptimeMs: number;
  readiness: ReadinessSnapshot | undefined;
  lanes: readonly LaneView[];
  metrics: MetricsSnapshot;
  race: RaceStats | undefined;
  warm: WarmerStatus | undefined;
  /** The thread this bot runs on. Optional for older snapshots. */
  host?: HostSnapshot | undefined;
}

export interface HostSnapshot {
  /** Which bot shard (worker thread) runs this bot; absent in-process. */
  shard: string | undefined;
  /** How late this thread's event loop fires a timer. High = CPU-starved. */
  loopLagMs: LatencySnapshot | undefined;
}

export interface StatusSourceOptions {
  workerId: string;
  origin: string;
  clock: Clock;
  metrics: MetricsRecorder;
  readiness?: ReadinessFsm | undefined;
  lanePool?: LanePool | undefined;
  race?: { stats: RaceStats } | undefined;
  warmer?: { status: WarmerStatus } | undefined;
  sampleMaxAgeMs?: number | undefined;
  loopLag?: { snapshot(): LatencySnapshot | undefined } | undefined;
  shard?: string | undefined;
}

/**
 * Builds the dashboard payload.
 *
 * Every derived judgement — which lane is hot, whether a sample is stale — is
 * made here, so the UI only renders. That is the fix for the class of bug where
 * a dashboard recomputed routing state and disagreed with the router
 * (Playbook §10.9, §13.2).
 */
export class StatusSource {
  readonly #startedMono: number;

  constructor(private readonly options: StatusSourceOptions) {
    this.#startedMono = options.clock.monotonic();
  }

  snapshot(): StatusSnapshot {
    const o = this.options;
    return {
      workerId: o.workerId,
      origin: o.origin,
      generatedAtMs: o.clock.now(),
      uptimeMs: o.clock.monotonic() - this.#startedMono,
      readiness: o.readiness?.snapshot(),
      lanes: o.lanePool === undefined ? [] : classifyLanes(o.lanePool.stats, {
        clock: o.clock,
        workerId: o.workerId,
        origin: o.origin,
        ...(o.sampleMaxAgeMs === undefined ? {} : { sampleMaxAgeMs: o.sampleMaxAgeMs }),
      }),
      metrics: o.metrics.snapshot(),
      race: o.race?.stats,
      warm: o.warmer?.status,
      ...(o.loopLag === undefined && o.shard === undefined
        ? {}
        : { host: { shard: o.shard, loopLagMs: o.loopLag?.snapshot() } }),
    };
  }
}
