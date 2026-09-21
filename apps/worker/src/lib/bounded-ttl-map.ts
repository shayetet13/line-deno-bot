import type { Clock } from './clock.ts';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface BoundedTtlMapOptions {
  ttlMs: number;
  maxEntries: number;
}

/**
 * Fixed-capacity map with per-entry TTL.
 *
 * Design constraints from Playbook §5.2 / §19:
 *  - eviction is O(1): JS `Map` keeps insertion order, so the oldest key is
 *    `keys().next()`. We never scan the whole map on the hot path.
 *  - expiry is lazy (checked on read). A background `prune()` is available for
 *    metrics but is not required for correctness.
 *  - `set` refreshes recency by re-inserting the key (delete + set).
 */
export class BoundedTtlMap<V> {
  readonly #map = new Map<string, Entry<V>>();
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(clock: Clock, options: BoundedTtlMapOptions) {
    if (options.ttlMs <= 0) throw new RangeError('BoundedTtlMap: ttlMs must be > 0');
    if (options.maxEntries <= 0) throw new RangeError('BoundedTtlMap: maxEntries must be > 0');
    this.#clock = clock;
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
  }

  get size(): number {
    return this.#map.size;
  }

  has(key: string): boolean {
    return this.#live(key) !== undefined;
  }

  get(key: string): V | undefined {
    return this.#live(key)?.value;
  }

  /** Insert or refresh. Returns the map for chaining. */
  set(key: string, value: V): this {
    this.#map.delete(key);
    this.#map.set(key, { value, expiresAt: this.#clock.now() + this.#ttlMs });
    if (this.#map.size > this.#maxEntries) this.#evictOldest();
    return this;
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }

  /** Drop every expired entry. O(n) — call off the hot path only. */
  prune(): number {
    const now = this.#clock.now();
    let removed = 0;
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt <= now) {
        this.#map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  #live(key: string): Entry<V> | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#clock.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry;
  }

  #evictOldest(): void {
    const oldest = this.#map.keys().next();
    if (!oldest.done) this.#map.delete(oldest.value);
  }
}
