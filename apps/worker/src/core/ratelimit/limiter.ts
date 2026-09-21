import type { BotId, RoomId } from '@line-first/contracts';
import { MS_PER_SECOND } from '../../config/constants.ts';
import { ConfigError } from '../../errors/base.ts';
import { BoundedTtlMap } from '../../lib/bounded-ttl-map.ts';
import type { Clock } from '../../lib/clock.ts';

const DEFAULT_MAX_ROOMS = 10_000;
const DEFAULT_IDLE_TTL_MS = 600_000;
const KEY_SEP = String.fromCharCode(0);

export interface RateLimiterOptions {
  /** Bucket depth — the largest burst allowed. */
  capacity: number;
  /** Steady admission rate once the burst is spent. */
  refillPerSec: number;
  maxRooms?: number;
  idleTtlMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-`(bot, room)` token bucket. On refusal the caller must **drop** the
 * message, not queue it (Playbook §6.3): a late reply loses the race anyway and
 * arrives out of context.
 */
export class RateLimiter {
  readonly #buckets: BoundedTtlMap<Bucket>;
  readonly #clock: Clock;
  readonly #capacity: number;
  readonly #refillPerMs: number;

  constructor(clock: Clock, options: RateLimiterOptions) {
    assertValidOptions(options);
    this.#clock = clock;
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerSec / MS_PER_SECOND;
    this.#buckets = new BoundedTtlMap<Bucket>(clock, {
      ttlMs: options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      maxEntries: options.maxRooms ?? DEFAULT_MAX_ROOMS,
    });
  }

  /** `true` = admitted (a token was spent). `false` = drop this message. */
  tryAdmit(botId: BotId, room: RoomId): boolean {
    const key = botId + KEY_SEP + room;
    const refilled = this.#refill(this.#buckets.get(key));
    const admitted = refilled.tokens >= 1;
    const next = admitted
      ? { tokens: refilled.tokens - 1, lastRefillMs: refilled.lastRefillMs }
      : refilled;
    this.#buckets.set(key, next);
    return admitted;
  }

  get trackedRooms(): number {
    return this.#buckets.size;
  }

  #refill(existing: Bucket | undefined): Bucket {
    const now = this.#clock.now();
    if (existing === undefined) return { tokens: this.#capacity, lastRefillMs: now };
    const elapsed = Math.max(0, now - existing.lastRefillMs);
    const tokens = Math.min(this.#capacity, existing.tokens + elapsed * this.#refillPerMs);
    return { tokens, lastRefillMs: now };
  }
}

function assertValidOptions(options: RateLimiterOptions): void {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) {
    throw new ConfigError('rate limiter: capacity must be an integer >= 1', {
      capacity: options.capacity,
    });
  }
  if (!(options.refillPerSec > 0)) {
    throw new ConfigError('rate limiter: refillPerSec must be > 0', {
      refillPerSec: options.refillPerSec,
    });
  }
}
