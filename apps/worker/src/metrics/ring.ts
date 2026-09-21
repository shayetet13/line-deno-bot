import { ConfigError } from '../errors/base.ts';

export interface LatencySnapshot {
  count: number;
  /** Samples currently held. Older ones have been overwritten. */
  window: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Most recently recorded sample; unlike p50 this really means "latest". */
  /** Most recently recorded sample. Optional for older persisted/status payloads. */
  last?: number;
}

/**
 * Fixed-size ring of latency samples.
 *
 * `add` is a single array write — safe to call from the reply path. Percentiles
 * are computed only when someone asks for a {@link snapshot}, which sorts a copy
 * and must therefore stay off the hot path (Playbook §13.3).
 *
 * Reporting p50/p95/p99 rather than an average is deliberate: an average hides
 * exactly the tail that loses races (Playbook §12.3).
 */
export class LatencyRing {
  readonly #samples: Float64Array;
  #next = 0;
  #filled = 0;
  #total = 0;
  #count = 0;

  constructor(readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ConfigError('LatencyRing: capacity must be an integer >= 1', { capacity });
    }
    this.#samples = new Float64Array(capacity);
  }

  /** Total samples ever added, including ones the ring has overwritten. */
  get count(): number {
    return this.#count;
  }

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.#samples[this.#next] = ms;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#filled < this.capacity) this.#filled += 1;
    this.#count += 1;
    this.#total += ms;
  }

  snapshot(): LatencySnapshot | undefined {
    if (this.#filled === 0) return undefined;
    const sorted = this.#samples.slice(0, this.#filled).sort();
    return {
      count: this.#count,
      window: this.#filled,
      min: at(sorted, 0),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: at(sorted, sorted.length - 1),
      mean: this.#total / this.#count,
      last: this.#samples[(this.#next - 1 + this.capacity) % this.capacity] ?? 0,
    };
  }
}

const at = (sorted: Float64Array, index: number): number => sorted[index] ?? 0;

/** Nearest-rank percentile. With few samples p95 and max coincide — that is
 * honest, not a bug; report the sample count alongside (Phases §5). */
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return at(sorted, Math.min(sorted.length, Math.max(1, rank)) - 1);
}
