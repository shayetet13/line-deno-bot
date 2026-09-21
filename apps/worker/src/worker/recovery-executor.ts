import type { Logger } from '../logging/logger.ts';
import type { RecoveryAction, RecoveryRung } from '../monitoring/recovery.ts';
import type { LanePool } from '../transport/lane-pool.ts';

/**
 * Turns a recovery decision into an action.
 *
 * Split from {@link ../monitoring/recovery.ts} deliberately: the planner is
 * pure and exhaustively tested, this part touches live connections and can
 * only be smoke-tested. Keeping them apart means a bug here cannot make the
 * ladder itself misbehave.
 *
 * `restart-worker` exits the process rather than trying to rebuild state
 * in place. systemd restarts it, and a fresh process is the only way to be
 * sure the internal state that triggered the ladder is actually gone.
 */

export interface RecoveryHooks {
  /** Park the slowest lane so the router stops choosing it. */
  avoidLane?: () => void | Promise<void>;
  /** Recycle one lane's connection. */
  reconnectLane?: () => void | Promise<void>;
  /** Restart the dedicated room polls. */
  rearmPoll?: () => void | Promise<void>;
  /** Re-establish this bot's LINE session. */
  reconnectSession?: () => void | Promise<void>;
  /** Stop the process so the supervisor starts a clean one. */
  restartWorker?: () => void | Promise<void>;
}

export interface RecoveryExecutorOptions {
  logger: Logger;
  hooks?: RecoveryHooks;
  lanePool?: LanePool | undefined;
}

export class RecoveryExecutor {
  readonly #logger: Logger;
  readonly #hooks: RecoveryHooks;
  readonly #lanePool: LanePool | undefined;

  constructor(options: RecoveryExecutorOptions) {
    this.#logger = options.logger;
    this.#hooks = options.hooks ?? {};
    this.#lanePool = options.lanePool;
  }

  async apply(action: RecoveryAction): Promise<void> {
    this.#logger.warn('recovery action', {
      rung: action.rung,
      step: action.step,
      reason: action.reason,
    });
    const run = this.#handlerFor(action.rung);
    if (run === undefined) return;
    await run();
  }

  #handlerFor(rung: RecoveryRung): (() => void | Promise<void>) | undefined {
    switch (rung) {
      case 'none':
        return undefined;
      case 'avoid-lane':
        return this.#hooks.avoidLane ?? (() => this.#parkSlowestLane());
      case 'reconnect-lane':
        return this.#hooks.reconnectLane ?? (() => this.#recycleWorstLane());
      case 'rearm-poll':
        return this.#hooks.rearmPoll ?? (() => this.#unhandled('rearm-poll'));
      case 'reconnect-session':
        return this.#hooks.reconnectSession ?? (() => this.#unhandled('reconnect-session'));
      case 'restart-worker':
        return this.#hooks.restartWorker ?? (() => this.#unhandled('restart-worker'));
    }
  }

  /** With no pool there is nothing to park, and saying so beats pretending
   * the step succeeded. */
  #parkSlowestLane(): void {
    const stats = this.#lanePool?.stats;
    if (stats === undefined || stats.length < 2) {
      this.#unhandled('avoid-lane');
      return;
    }
    const measured = stats.filter((s) => s.medianRttMs !== undefined);
    const slowest = measured.sort((a, b) => (b.medianRttMs ?? 0) - (a.medianRttMs ?? 0))[0];
    this.#logger.warn('recovery: would park slowest lane', {
      laneId: slowest?.id,
      medianRttMs: slowest?.medianRttMs,
      note: 'the pool already parks lanes over its own threshold; no manual park needed',
    });
  }

  #recycleWorstLane(): void {
    this.#unhandled('reconnect-lane');
  }

  #unhandled(rung: string): void {
    this.#logger.error('recovery rung has no handler wired', {
      rung,
      note: 'decision recorded; an operator must act — see docs/runbook.md §5',
    });
  }
}
