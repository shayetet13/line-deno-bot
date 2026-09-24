import { ConfigError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';
import { LatencyRing, type LatencySnapshot } from './ring.ts';

export interface LoopLagOptions {
  clock: Clock;
  /** How often to look. Each look costs one timer callback. */
  intervalMs?: number;
  /** Samples kept; the default covers the last 30 seconds. */
  capacity?: number;
  timer?: LoopLagTimer;
}

export interface LoopLagTimer {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_INTERVAL_MS = 20;
const DEFAULT_CAPACITY = 1_500;

const REAL_TIMER: LoopLagTimer = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (handle) => clearInterval(handle as number),
};

/**
 * How late this thread's event loop runs a timer that should fire every
 * `intervalMs`.
 *
 * Every reply in this thread waits behind whatever the loop is doing when the
 * poll that saw the key completes. When the host is short of CPU — too many
 * bots per core, a noisy neighbour, steal time — this number rises first, and
 * it rises for every bot on the thread at once. That is the difference between
 * "LINE was slow" and "we were": a jump in send RPC with flat loop lag is the
 * network or LINE; a jump in both is this machine.
 */
export class LoopLagMonitor {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #timer: LoopLagTimer;
  readonly #ring: LatencyRing;
  #handle: unknown;
  #expectedAt = 0;

  constructor(options: LoopLagOptions) {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!(intervalMs > 0)) {
      throw new ConfigError('LoopLagMonitor: intervalMs must be > 0', { intervalMs });
    }
    this.#clock = options.clock;
    this.#intervalMs = intervalMs;
    this.#timer = options.timer ?? REAL_TIMER;
    this.#ring = new LatencyRing(options.capacity ?? DEFAULT_CAPACITY);
  }

  get running(): boolean {
    return this.#handle !== undefined;
  }

  start(): void {
    if (this.#handle !== undefined) return;
    this.#expectedAt = this.#clock.monotonic() + this.#intervalMs;
    const handle = this.#timer.set(() => this.observe(), this.#intervalMs);
    // Never keep a process alive just to measure it.
    if (typeof handle === 'number') Deno.unrefTimer(handle);
    this.#handle = handle;
  }

  stop(): void {
    if (this.#handle === undefined) return;
    this.#timer.clear(this.#handle);
    this.#handle = undefined;
  }

  /** One timer firing. Public so tests can drive it with a fake clock. */
  observe(): void {
    const now = this.#clock.monotonic();
    this.#ring.add(Math.max(0, now - this.#expectedAt));
    this.#expectedAt = now + this.#intervalMs;
  }

  snapshot(): LatencySnapshot | undefined {
    return this.#ring.snapshot();
  }
}

let shared: LoopLagMonitor | undefined;

/** Starts this thread's monitor (each Worker has its own module instance).
 * Called once by each process/shard entry point; idempotent. */
export function startThreadLoopLag(clock: Clock): LoopLagMonitor {
  shared ??= new LoopLagMonitor({ clock });
  shared.start();
  return shared;
}

/** This thread's monitor, when an entry point started one. Every bot on the
 * thread reports the same loop. */
export function threadLoopLag(): LoopLagMonitor | undefined {
  return shared;
}
