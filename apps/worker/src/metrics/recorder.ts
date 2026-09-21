import { LatencyRing, type LatencySnapshot } from './ring.ts';
import type { SpanName, TraceLike } from './trace.ts';

/** Wall-clock, cross-host readings — LINE's timestamp compared against ours.
 * Kept in their own pool, never merged into `spans`, because they carry
 * clock-offset error that a purely-monotonic span does not (see trace.ts). */
export type CrossHostName = 'inbound' | 'line_round_trip';

export interface MetricsSnapshot {
  spans: Partial<Record<SpanName, LatencySnapshot>>;
  /** Optional in the type only so existing fixtures that predate cross-host
   * tracking still type-check without it — `snapshot()` always includes it. */
  crossHost?: Partial<Record<CrossHostName, LatencySnapshot>>;
  counters: Record<string, number>;
}

export interface MetricsOptions {
  /** Samples kept per span. */
  window?: number;
  /** When false, `record*` are no-ops — the off half of the overhead A/B. */
  enabled?: boolean;
}

/**
 * Collects spans and counters.
 *
 * A few phase samples are recorded while a reply is being prepared, but each
 * `record*` call is only a bounded map lookup plus array write. Sorting and
 * formatting happen in {@link snapshot}, which a dashboard or CLI calls —
 * never before network send (Playbook §6.2).
 */
export class MetricsRecorder {
  readonly #rings = new Map<SpanName, LatencyRing>();
  readonly #crossHostRings = new Map<CrossHostName, LatencyRing>();
  readonly #counters = new Map<string, number>();
  readonly #window: number;
  readonly enabled: boolean;

  constructor(options: MetricsOptions = {}) {
    this.#window = options.window ?? 512;
    this.enabled = options.enabled ?? true;
  }

  /** Files every local span a trace captured — including derived ones like
   * `pre_dispatch` that only `Trace.toRecord()` knows how to compute. Cross-host
   * spans never reach `toRecord().spans` in the first place; they belong with
   * an explicit clock-offset reading, not in this pool. */
  recordTrace(trace: TraceLike): void {
    if (!this.enabled) return;
    for (const [name, ms] of Object.entries(trace.toRecord().spans) as [SpanName, number][]) {
      this.recordSpan(name, ms);
    }
  }

  recordSpan(name: SpanName, ms: number | undefined): void {
    if (!this.enabled || ms === undefined) return;
    let ring = this.#rings.get(name);
    if (ring === undefined) {
      ring = new LatencyRing(this.#window);
      this.#rings.set(name, ring);
    }
    ring.add(ms);
  }

  /** Files a wall-clock, cross-host reading into its own pool — see
   * {@link CrossHostName}. */
  recordCrossHost(name: CrossHostName, ms: number | undefined): void {
    if (!this.enabled || ms === undefined) return;
    let ring = this.#crossHostRings.get(name);
    if (ring === undefined) {
      ring = new LatencyRing(this.#window);
      this.#crossHostRings.set(name, ring);
    }
    ring.add(ms);
  }

  /** Counts an occurrence — pipeline outcome, surface, winning receive path. */
  count(name: string, by = 1): void {
    if (!this.enabled) return;
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  snapshot(): MetricsSnapshot {
    const spans: Partial<Record<SpanName, LatencySnapshot>> = {};
    for (const [name, ring] of this.#rings) {
      const snap = ring.snapshot();
      if (snap !== undefined) spans[name] = snap;
    }
    const crossHost: Partial<Record<CrossHostName, LatencySnapshot>> = {};
    for (const [name, ring] of this.#crossHostRings) {
      const snap = ring.snapshot();
      if (snap !== undefined) crossHost[name] = snap;
    }
    return { spans, crossHost, counters: Object.fromEntries(this.#counters) };
  }

  reset(): void {
    this.#rings.clear();
    this.#crossHostRings.clear();
    this.#counters.clear();
  }
}
