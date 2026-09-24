import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import type { Alert, AlertKind } from './alerts.ts';

/**
 * The recovery ladder (Playbook §16):
 *
 *   avoid the slow lane
 *   → reconnect one lane
 *   → rearm the room poll
 *   → reconnect one bot's session
 *   → restart the worker
 *
 * The point of a ladder rather than a set of handlers is stated in the same
 * section: "การ restart service ทั้ง worker เป็น recovery ขั้นแรง ไม่ควรถูกเรียกจาก
 * latency spike เดี่ยว ๆ". A single spike must never reach the bottom rung. So
 * escalation is one rung at a time, each rung gets a cooldown to prove itself,
 * and a clean snapshot walks the ladder back down.
 */

export const RECOVERY_RUNGS = [
  'none',
  'avoid-lane',
  'reconnect-lane',
  'rearm-poll',
  'reconnect-session',
  'restart-worker',
] as const;

export type RecoveryRung = (typeof RECOVERY_RUNGS)[number];

/** The rung an alert kind starts at. Escalation past it is earned, not assumed. */
type ActionableAlertKind = Exclude<AlertKind, 'line-trigger-reply-budget' | 'host-cpu-starved'>;

const ENTRY_RUNG: Readonly<Record<ActionableAlertKind, RecoveryRung>> = {
  'first-response-regression': 'avoid-lane',
  'no-lane-available': 'reconnect-lane',
  'missed-events': 'rearm-poll',
  'failure-rate': 'reconnect-lane',
  'readiness-loss': 'reconnect-session',
};

/** A trigger-to-reply result combines inbound and outbound paths. It is the
 * outcome budget operators need to see, but by itself cannot prove a lane is
 * at fault. Alert it; do not tear down a healthy connection automatically.
 * A CPU-starved host is the same: reconnecting spends more CPU, not less. */
const OBSERVATION_ONLY = new Set<AlertKind>(['line-trigger-reply-budget', 'host-cpu-starved']);

export interface RecoveryAction {
  rung: RecoveryRung;
  /** Why we are here, in one line, for the operator and the log. */
  reason: string;
  /** How many rungs we have climbed for this incident. */
  step: number;
}

export interface RecoveryOptions {
  clock: Clock;
  logger: Logger;
  /** A rung must be given this long to work before we climb past it. */
  cooldownMs?: number;
  /** Consecutive clean evaluations before the ladder resets. One good
   * snapshot after a restart proves nothing. */
  clearAfterCleanChecks?: number;
  /** Highest rung this planner may reach. Set below `restart-worker` when a
   * human must approve the last step. */
  ceiling?: RecoveryRung;
}

const DEFAULTS = { cooldownMs: 120_000, clearAfterCleanChecks: 3 } as const;

const rungIndex = (rung: RecoveryRung): number => RECOVERY_RUNGS.indexOf(rung);

/**
 * Decides the recovery step, and nothing else — it performs no action. The
 * worker owns the effects; keeping the decision pure means the ladder can be
 * tested exhaustively without reconnecting anything.
 */
export class RecoveryPlanner {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #cooldownMs: number;
  readonly #clearAfter: number;
  readonly #ceilingIndex: number;

  #rung: RecoveryRung = 'none';
  #enteredMono = 0;
  #cleanChecks = 0;
  #step = 0;

  constructor(options: RecoveryOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
    this.#clearAfter = options.clearAfterCleanChecks ?? DEFAULTS.clearAfterCleanChecks;
    this.#ceilingIndex = rungIndex(options.ceiling ?? 'restart-worker');
  }

  get rung(): RecoveryRung {
    return this.#rung;
  }

  /** ms spent on the current rung. */
  get onRungMs(): number {
    return this.#rung === 'none' ? 0 : this.#clock.monotonic() - this.#enteredMono;
  }

  /**
   * Feed the alerts from one evaluation. Returns an action when the rung
   * changed, `undefined` when the right move is to keep waiting.
   */
  next(alerts: readonly Alert[]): RecoveryAction | undefined {
    if (alerts.length === 0) return this.#observeClean();
    this.#cleanChecks = 0;

    const actionable = alerts.filter((alert) => !OBSERVATION_ONLY.has(alert.kind));
    if (actionable.length === 0) return undefined;

    // The most serious alert sets the floor: a critical one should not be
    // answered by the rung a warning would have earned.
    const worst = [...actionable].sort(
      (a, b) => rungIndex(entryRung(b.kind)) - rungIndex(entryRung(a.kind)),
    )[0];
    if (worst === undefined) return undefined;
    const entry = entryRung(worst.kind);

    if (this.#rung === 'none') return this.#enter(entry, worst.message);

    // Still on a rung that has not had its chance yet: wait.
    if (this.onRungMs < this.#cooldownMs) return undefined;

    // A new, more serious problem jumps straight to its own entry rung.
    if (rungIndex(entry) > rungIndex(this.#rung)) return this.#enter(entry, worst.message);

    // Same problem, cooldown elapsed, still failing: climb exactly one rung.
    const next = RECOVERY_RUNGS[rungIndex(this.#rung) + 1];
    if (next === undefined) return undefined;
    if (rungIndex(next) > this.#ceilingIndex) {
      this.#logger.warn('recovery ceiling reached', {
        rung: this.#rung,
        wanted: next,
        reason: worst.message,
      });
      return undefined;
    }
    return this.#enter(next, `${worst.message} (still failing after ${this.#rung})`);
  }

  /** Force the ladder back to the bottom — after a confirmed manual fix. */
  reset(): void {
    if (this.#rung === 'none') return;
    this.#logger.info('recovery cleared', { from: this.#rung, steps: this.#step });
    this.#rung = 'none';
    this.#step = 0;
    this.#cleanChecks = 0;
  }

  #observeClean(): RecoveryAction | undefined {
    if (this.#rung === 'none') return undefined;
    this.#cleanChecks += 1;
    if (this.#cleanChecks < this.#clearAfter) return undefined;
    this.reset();
    return { rung: 'none', reason: 'recovered', step: 0 };
  }

  #enter(rung: RecoveryRung, reason: string): RecoveryAction {
    this.#rung = rung;
    this.#enteredMono = this.#clock.monotonic();
    this.#step += 1;
    this.#cleanChecks = 0;
    this.#logger.warn('recovery step', { rung, reason, step: this.#step });
    return { rung, reason, step: this.#step };
  }
}

function entryRung(kind: AlertKind): RecoveryRung {
  return ENTRY_RUNG[kind as ActionableAlertKind];
}
