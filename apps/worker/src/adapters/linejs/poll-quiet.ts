import type { Clock } from '../../lib/clock.ts';

/**
 * Prevents a zero-delay room poll from starting beside the reply it just
 * triggered. The gate only tracks configured dedicated rooms, so marking a
 * reply in any other room is one bounded Set lookup and allocates nothing.
 */
export class SquarePollQuietGate {
  readonly #clock: Clock;
  readonly #windowMs: number;
  readonly #untilByRoom: Map<string, number>;

  constructor(clock: Clock, rooms: readonly string[], windowMs: number) {
    this.#clock = clock;
    this.#windowMs = windowMs;
    this.#untilByRoom = new Map(rooms.map((room) => [room, 0]));
  }

  /** Called immediately before a real Square send starts. */
  markReplyStarted(room: string): void {
    if (this.#windowMs <= 0 || !this.#untilByRoom.has(room)) return;
    this.#untilByRoom.set(room, this.#clock.monotonic() + this.#windowMs);
  }

  /** Remaining hold before this room may start its next poll. */
  remainingMs(room: string): number {
    const until = this.#untilByRoom.get(room);
    if (until === undefined || until === 0) return 0;
    const remaining = until - this.#clock.monotonic();
    if (remaining > 0) return remaining;
    this.#untilByRoom.set(room, 0);
    return 0;
  }
}
