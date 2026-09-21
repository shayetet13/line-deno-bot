import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';

/**
 * Worker lifecycle (decision doc §8 / Phases §8):
 *
 *   STARTING → AUTHENTICATED → SYNCING → WARMING → ARMED
 *                                              ↓
 *                          DEGRADED ← problem, then REPAIR → SYNCING → …
 *
 * ARMED means every precondition holds at once: a usable session, a subscribed
 * receiver, rules loaded, sender ready, and no backlog that would make old data
 * look like a new job. Anything less is DEGRADED with a reason.
 */
export const READINESS_STATES = [
  'starting',
  'authenticated',
  'syncing',
  'warming',
  'armed',
  'degraded',
  'repair',
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

/** The independent conditions ARMED depends on. All true ⇒ ARMED is reachable. */
export interface ReadinessChecks {
  sessionValid: boolean;
  receiverSubscribed: boolean;
  rulesLoaded: boolean;
  senderReady: boolean;
  backlogDrained: boolean;
}

const ALL_FALSE: ReadinessChecks = {
  sessionValid: false,
  receiverSubscribed: false,
  rulesLoaded: false,
  senderReady: false,
  backlogDrained: false,
};

/** The happy-path ladder. Forward moves step through it; a regression jumps
 * straight down it; DEGRADED / REPAIR sit outside it and are entered explicitly. */
const LADDER = ['starting', 'authenticated', 'syncing', 'warming', 'armed'] as const;

export interface ReadinessSnapshot {
  state: ReadinessState;
  checks: ReadinessChecks;
  reason: string | undefined;
  since: number;
}

/**
 * Tracks readiness from the individual checks. The worker calls `set(...)` as
 * each condition changes; the FSM decides the state and refuses to report ARMED
 * unless every check passes (Phases: "ARMED ต้องมี session ใช้งานได้, receiver
 * พร้อมรับ, rules โหลดครบ, sender พร้อม ...").
 */
export class ReadinessFsm {
  #state: ReadinessState = 'starting';
  #checks: ReadinessChecks = { ...ALL_FALSE };
  #reason: string | undefined;
  #since: number;

  constructor(private readonly clock: Clock, private readonly logger: Logger) {
    this.#since = clock.monotonic();
  }

  get state(): ReadinessState {
    return this.#state;
  }

  get isArmed(): boolean {
    return this.#state === 'armed';
  }

  snapshot(): ReadinessSnapshot {
    return {
      state: this.#state,
      checks: { ...this.#checks },
      reason: this.#reason,
      since: this.#since,
    };
  }

  /** Update one or more checks and recompute the state. */
  set(patch: Partial<ReadinessChecks>): ReadinessState {
    this.#checks = { ...this.#checks, ...patch };
    return this.#recompute();
  }

  /** Force DEGRADED with a reason — a dropped connection, an invalid
   * subscription, a rejected session (Phases: alarm from disconnect, not from a
   * short read timeout on a quiet room). */
  degrade(reason: string): void {
    if (this.#state === 'degraded') return;
    this.#transition('degraded', reason);
  }

  /** Begin recovery. From DEGRADED only. */
  beginRepair(): void {
    if (this.#state !== 'degraded') return;
    this.#transition('repair', this.#reason);
  }

  #recompute(): ReadinessState {
    if (this.#state === 'degraded') return this.#state;
    const c = this.#checks;
    const target: ReadinessState = !c.sessionValid
      ? 'starting'
      : !c.receiverSubscribed || !c.backlogDrained
      ? 'syncing'
      : !c.rulesLoaded || !c.senderReady
      ? 'warming'
      : 'armed';
    if (target === this.#state) return this.#state;
    this.#advanceToward(target);
    return this.#state;
  }

  /** Forward progress is one observable step at a time; a regression (a check
   * that was passing now fails) drops straight to the lower state. */
  #advanceToward(target: ReadinessState): void {
    const here = LADDER.indexOf(this.#state as (typeof LADDER)[number]);
    const there = LADDER.indexOf(target as (typeof LADDER)[number]);
    if (here === -1 || there === -1) return;
    if (there < here) {
      this.#transition(target, undefined);
      return;
    }
    const next = LADDER[here + 1];
    if (next !== undefined) {
      this.#transition(next, undefined);
      if (next !== target) this.#advanceToward(target);
    }
  }

  #transition(to: ReadinessState, reason: string | undefined): void {
    this.logger.info('readiness', { from: this.#state, to, reason });
    this.#state = to;
    this.#reason = reason;
    this.#since = this.clock.monotonic();
  }
}
