import type { Clock } from '../lib/clock.ts';

/**
 * Experiment: single-use prepared request slot (Phases §17.3).
 *
 * Hypothesis: part of the send path is serialisation the worker could have done
 * during idle time. Preparing the request while nothing is happening and firing
 * the prepared bytes when the job arrives should cut the pre-network work.
 *
 * The danger is the whole point of the design here. A prepared request is bound
 * to a route key and a sequence number; if either has moved on — a new session,
 * a rotated token, a re-keyed route — sending the prepared bytes replays a
 * request against state that no longer exists. So the slot:
 *
 *   - is single-use: a successful take empties it, no double-send;
 *   - refuses a mismatched key or sequence, AND drops the payload when it sees
 *     one, because a mismatch means the world moved and the bytes are garbage;
 *   - expires on age, so a slot prepared before a long idle is not trusted.
 *
 * Failing closed costs one preparation. Failing open sends a stale request.
 */

export type SlotState = 'empty' | 'ready' | 'consumed' | 'invalidated';

export interface SlotStatus {
  state: SlotState;
  routeKey: string | undefined;
  sequence: number | undefined;
  /** Age of the held payload in ms, or undefined when nothing is held. */
  ageMs: number | undefined;
  reason: string | undefined;
  prepared: number;
  hits: number;
  misses: number;
}

export interface PreparedSlotOptions {
  clock: Clock;
  /** A payload older than this is discarded rather than sent. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 60_000;

export class PreparedSlot<T> {
  readonly #clock: Clock;
  readonly #maxAgeMs: number;

  #value: T | undefined;
  #routeKey: string | undefined;
  #sequence: number | undefined;
  #preparedMono = 0;
  #state: SlotState = 'empty';
  #reason: string | undefined;
  #prepared = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: PreparedSlotOptions) {
    this.#clock = options.clock;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  get status(): SlotStatus {
    return {
      state: this.#state,
      routeKey: this.#routeKey,
      sequence: this.#sequence,
      ageMs: this.#state === 'ready' ? this.#clock.monotonic() - this.#preparedMono : undefined,
      reason: this.#reason,
      prepared: this.#prepared,
      hits: this.#hits,
      misses: this.#misses,
    };
  }

  /** Build the payload now, for a later `take` with the same key and sequence.
   * Preparing over a ready slot replaces it — the newer binding is the live one. */
  prepare(routeKey: string, sequence: number, build: () => T): void {
    this.#value = build();
    this.#routeKey = routeKey;
    this.#sequence = sequence;
    this.#preparedMono = this.#clock.monotonic();
    this.#state = 'ready';
    this.#reason = undefined;
    this.#prepared += 1;
  }

  /**
   * Claim the payload. Returns it at most once, and only when the key and
   * sequence still match and it has not gone stale; otherwise `undefined`, and
   * the slot is emptied so the caller falls back to building the request.
   */
  take(routeKey: string, sequence: number): T | undefined {
    if (this.#state !== 'ready') {
      this.#misses += 1;
      return undefined;
    }
    if (this.#routeKey !== routeKey || this.#sequence !== sequence) {
      this.#misses += 1;
      this.#drop('invalidated', 'route key or sequence moved on');
      return undefined;
    }
    if (this.#clock.monotonic() - this.#preparedMono > this.#maxAgeMs) {
      this.#misses += 1;
      this.#drop('invalidated', 'payload older than maxAgeMs');
      return undefined;
    }
    const value = this.#value as T;
    this.#hits += 1;
    this.#drop('consumed', undefined);
    return value;
  }

  /** Drop whatever is held. Called on session change, token rotation, GOAWAY —
   * anything that could have moved the state the payload was built against. */
  invalidate(reason: string): void {
    if (this.#state !== 'ready') {
      this.#reason = reason;
      return;
    }
    this.#drop('invalidated', reason);
  }

  /** Convenience for the common trigger: the route's sequence advanced. */
  invalidateSequence(routeKey: string, sequence: number): void {
    if (this.#state !== 'ready') return;
    if (this.#routeKey === routeKey && this.#sequence === sequence) return;
    this.#drop('invalidated', 'sequence advanced');
  }

  #drop(state: SlotState, reason: string | undefined): void {
    this.#value = undefined;
    this.#routeKey = undefined;
    this.#sequence = undefined;
    this.#preparedMono = 0;
    this.#state = state;
    this.#reason = reason;
  }
}
