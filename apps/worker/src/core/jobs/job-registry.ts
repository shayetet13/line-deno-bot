import {
  isTerminalJobState,
  type JobKey,
  type JobOutcome,
  type JobState,
} from '@line-first/contracts';
import { IllegalStateTransitionError } from '../../errors/base.ts';
import { BoundedTtlMap, type BoundedTtlMapOptions } from '../../lib/bounded-ttl-map.ts';
import type { Clock } from '../../lib/clock.ts';

export interface JobRecord {
  readonly key: JobKey;
  readonly state: JobState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED: Readonly<Record<JobState, readonly JobState[]>> = {
  waiting: ['eligible-trigger'],
  'eligible-trigger': ['first-response-dispatched'],
  'first-response-dispatched': ['won', 'lost', 'unknown'],
  won: [],
  lost: [],
  unknown: [],
};

/**
 * Tracks the lifecycle of every job the worker has seen recently. Entries expire
 * (`JOB_KEY_TTL_MS`) so a repeat of the same keyword in a later round is a new
 * job, while a redelivered event (push + poll) within the window resolves to the
 * same record and is not re-dispatched.
 */
export class JobRegistry {
  readonly #store: BoundedTtlMap<JobRecord>;
  readonly #clock: Clock;

  constructor(clock: Clock, options: BoundedTtlMapOptions) {
    this.#clock = clock;
    this.#store = new BoundedTtlMap<JobRecord>(clock, options);
  }

  get(key: JobKey): JobRecord | undefined {
    return this.#store.get(key);
  }

  /** Fetch the record, creating it in `waiting` when first seen. */
  ensure(key: JobKey): JobRecord {
    const existing = this.#store.get(key);
    if (existing !== undefined) return existing;
    const now = this.#clock.now();
    const created: JobRecord = { key, state: 'waiting', createdAt: now, updatedAt: now };
    this.#store.set(key, created);
    return created;
  }

  isTerminal(key: JobKey): boolean {
    const record = this.#store.get(key);
    return record !== undefined && isTerminalJobState(record.state);
  }

  markEligible(key: JobKey): JobRecord {
    return this.#transition(key, 'eligible-trigger');
  }

  markDispatched(key: JobKey): JobRecord {
    return this.#transition(key, 'first-response-dispatched');
  }

  /** Record the confirmed outcome. `unknown` (e.g. ACK timeout) is terminal but
   * explicitly not a loss (decision doc §5). */
  settle(key: JobKey, outcome: JobOutcome): JobRecord {
    return this.#transition(key, outcome);
  }

  get size(): number {
    return this.#store.size;
  }

  #transition(key: JobKey, to: JobState): JobRecord {
    const current = this.ensure(key);
    if (current.state === to) return current;
    if (!ALLOWED[current.state].includes(to)) {
      throw new IllegalStateTransitionError('illegal job transition', {
        key,
        from: current.state,
        to,
      });
    }
    const next: JobRecord = { ...current, state: to, updatedAt: this.#clock.now() };
    this.#store.set(key, next);
    return next;
  }
}
