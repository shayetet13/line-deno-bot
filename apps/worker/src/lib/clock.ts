/**
 * Injectable clock. Every module that reasons about time (TTL stores, rate
 * limiter, job registry) takes a `Clock` so tests advance time deterministically
 * instead of sleeping.
 *
 * `now()`      — wall-clock epoch milliseconds; used for TTL / retention math.
 * `monotonic()` — strictly non-decreasing milliseconds; used for durations.
 *                 Never subtract `monotonic()` across processes (Phases §5).
 */
export interface Clock {
  now(): number;
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/** Test clock. `advance()` moves both timelines together. */
export class FakeClock implements Clock {
  #wall: number;
  #mono: number;

  constructor(startEpochMs = 0) {
    this.#wall = startEpochMs;
    this.#mono = 0;
  }

  now(): number {
    return this.#wall;
  }

  monotonic(): number {
    return this.#mono;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock.advance: ms must be >= 0');
    this.#wall += ms;
    this.#mono += ms;
  }
}
