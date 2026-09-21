import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { ConfigError } from '../errors/base.ts';

export interface WriteBehindOptions<T> {
  clock: Clock;
  logger: Logger;
  /** Persists one batch. Must not be called from the reply path. */
  flush: (batch: readonly T[]) => Promise<void> | void;
  /** Flush once this many items are queued. */
  batchSize?: number;
  /** Flush at least this often while items are waiting. */
  flushIntervalMs?: number;
  /** Hard cap. Past it, the OLDEST items are dropped and counted — a metrics
   * backlog must never grow without bound or block the hot path. */
  maxQueued?: number;
  timer?: { set(cb: () => void, ms: number): unknown; clear(h: unknown): void };
}

const DEFAULTS = { batchSize: 64, flushIntervalMs: 1_000, maxQueued: 10_000 } as const;

const REAL_TIMER = {
  set: (cb: () => void, ms: number): unknown => setTimeout(cb, ms),
  clear: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WriteBehindStats {
  queued: number;
  written: number;
  dropped: number;
  flushes: number;
  failures: number;
}

/**
 * Buffers writes so persistence never sits between a message and its reply
 * (Playbook §6.1 "database durability ใช้ write-behind worker", §13.3 "metrics
 * ต้องอยู่นอก hot path").
 *
 * `enqueue` is a single array push — no awaiting, no throwing. Everything else
 * happens on a timer or when a batch fills.
 */
export class WriteBehindQueue<T> {
  readonly #opts: Required<Omit<WriteBehindOptions<T>, 'clock' | 'logger' | 'flush' | 'timer'>>;
  readonly #flush: WriteBehindOptions<T>['flush'];
  readonly #logger: Logger;
  readonly #timer: NonNullable<WriteBehindOptions<T>['timer']>;
  readonly #queue: T[] = [];
  #handle: unknown;
  #flushing = false;
  #stats = { written: 0, dropped: 0, flushes: 0, failures: 0 };
  #closed = false;

  constructor(options: WriteBehindOptions<T>) {
    const batchSize = options.batchSize ?? DEFAULTS.batchSize;
    const maxQueued = options.maxQueued ?? DEFAULTS.maxQueued;
    if (batchSize < 1) throw new ConfigError('WriteBehindQueue: batchSize must be >= 1');
    if (maxQueued < batchSize) {
      throw new ConfigError('WriteBehindQueue: maxQueued must be >= batchSize');
    }
    this.#opts = {
      batchSize,
      maxQueued,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    };
    this.#flush = options.flush;
    this.#logger = options.logger;
    this.#timer = options.timer ?? REAL_TIMER;
  }

  get stats(): WriteBehindStats {
    return { queued: this.#queue.length, ...this.#stats };
  }

  /** Hot-path safe: never awaits, never throws. */
  enqueue(item: T): void {
    if (this.#closed) return;
    this.#queue.push(item);
    if (this.#queue.length > this.#opts.maxQueued) {
      this.#queue.shift();
      this.#stats.dropped += 1;
    }
    if (this.#queue.length >= this.#opts.batchSize) {
      void this.flushNow();
      return;
    }
    this.#arm();
  }

  /** Writes whatever is queued. Safe to call concurrently — overlapping calls
   * are collapsed so a slow disk cannot stack up flushes. */
  async flushNow(): Promise<void> {
    if (this.#flushing) return;
    const batch = this.#queue.splice(0, this.#opts.batchSize);
    if (batch.length === 0) return;
    this.#flushing = true;
    this.#stats.flushes += 1;
    try {
      await this.#flush(batch);
      this.#stats.written += batch.length;
    } catch (error: unknown) {
      this.#stats.failures += 1;
      this.#logger.error('write-behind flush failed', {
        items: batch.length,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.#flushing = false;
      if (this.#queue.length > 0) this.#arm();
    }
  }

  /** Flushes everything remaining, then stops accepting writes. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#disarm();
    while (this.#queue.length > 0) {
      const before = this.#queue.length;
      await this.flushNow();
      if (this.#queue.length >= before) break; // flush is failing; do not spin
    }
  }

  #arm(): void {
    if (this.#handle !== undefined || this.#closed) return;
    this.#handle = this.#timer.set(() => {
      this.#handle = undefined;
      void this.flushNow();
    }, this.#opts.flushIntervalMs);
  }

  #disarm(): void {
    if (this.#handle !== undefined) this.#timer.clear(this.#handle);
    this.#handle = undefined;
  }
}
