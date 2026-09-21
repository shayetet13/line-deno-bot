import { BoundedTtlMap, type BoundedTtlMapOptions } from '../../lib/bounded-ttl-map.ts';
import type { Clock } from '../../lib/clock.ts';

/** U+0000 cannot appear in a LINE id, so it is a safe composite-key delimiter. */
const KEY_SEP = String.fromCharCode(0);

export const claimKey = (...parts: readonly string[]): string => parts.join(KEY_SEP);

/**
 * A single "first caller wins" store. Backed by a {@link BoundedTtlMap} so it is
 * O(1) on the hot path and self-limits its memory (Playbook §5.2).
 */
export class ClaimStore {
  readonly #map: BoundedTtlMap<true>;

  constructor(clock: Clock, options: BoundedTtlMapOptions) {
    this.#map = new BoundedTtlMap<true>(clock, options);
  }

  /** Returns `true` iff this call acquired the claim. A second call with the
   * same key returns `false` until the entry expires. */
  tryClaim(key: string): boolean {
    if (this.#map.has(key)) return false;
    this.#map.set(key, true);
    return true;
  }

  /** Explicitly drop a claim (e.g. a bot that stopped — Playbook §10 reliability). */
  release(key: string): void {
    this.#map.delete(key);
  }

  get size(): number {
    return this.#map.size;
  }
}
