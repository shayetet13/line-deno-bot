import { MS_PER_SECOND } from '../config/constants.ts';
import { ConfigError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import type { ReplyLaneView } from './lane-pool.ts';

/** The slice of {@link LanePool} the scout drives. */
export interface ScoutedPool {
  readonly sendsInFlight: number;
  readonly lastSendStartMono: number;
  readonly currentSendLaneId: number | undefined;
  replyLaneViews(): ReplyLaneView[];
  promoteSendLane(laneId: number, detail?: Record<string, unknown>): boolean;
  rerollLane(laneId: number, origin: string): Promise<boolean>;
  revealLane(laneId: number): void;
}

export interface ReplyScoutOptions {
  pool: ScoutedPool;
  /** One harmless read-only RPC forced onto exactly this reply lane. */
  probe: (laneId: number) => Promise<void>;
  clock: Clock;
  logger: Logger;
  /** Gap between probes. Each probe measures one lane, so a lane is
   * re-measured every `intervalMs × reply lanes`. */
  intervalMs?: number;
  /** No probe starts this soon after a real reply started. */
  quietAfterSendMs?: number;
  /** A challenger must beat the pinned lane by at least this much… */
  switchMarginMs?: number;
  /** …on this many consecutive evaluations before the pin moves. */
  switchConfirmations?: number;
  /** A lane is ranked only once its window holds this many probes. */
  minSamples?: number;
  /** An unpinned lane this much slower than the best is re-rolled onto a new
   * connection. */
  rerollGapMs?: number;
  /** At most one re-roll per this interval. */
  rerollIntervalMs?: number;
  /** Probes taken on a re-rolled lane before replies may use it. */
  rerollProbes?: number;
  /** HEAD target that opens a re-rolled lane's TCP/TLS before it is probed. */
  warmOrigin: string;
  timer?: ScoutTimer;
}

export interface ScoutTimer {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ScoutStatus {
  running: boolean;
  probes: number;
  probeFailures: number;
  switches: number;
  rerolls: number;
  skippedForReplies: number;
}

const DEFAULTS = {
  intervalMs: MS_PER_SECOND,
  quietAfterSendMs: 300,
  switchMarginMs: 0.5,
  switchConfirmations: 2,
  minSamples: 3,
  rerollGapMs: 2,
  rerollIntervalMs: 30 * MS_PER_SECOND,
  rerollProbes: 3,
} as const;

const REAL_TIMER: ScoutTimer = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => clearTimeout(handle as number),
};

const round2 = (ms: number | undefined): number | undefined =>
  ms === undefined ? undefined : Math.round(ms * 100) / 100;

type Ranked = ReplyLaneView & { preflightPredictedMs: number };

/**
 * Keeps the reply pin on the fastest route LINE is giving this bot right now.
 *
 * The router alone only learns from real replies, and a bot answers a handful
 * of keys a minute — so its ranking goes stale, and a lane that was fastest at
 * startup stays pinned long after another became faster. The scout closes that
 * gap entirely off the reply path:
 *
 *  1. **Measure** — one read-only probe at a time, on the reply lane whose
 *     evidence is oldest, never while a reply is on the wire or just after
 *     one started. Probing also keeps every reply connection warm.
 *  2. **Hold, then switch** — the pin stays where it is until a challenger is
 *     faster by `switchMarginMs` on `switchConfirmations` evaluations in a
 *     row. Noise cannot flap it; a genuinely faster route always wins.
 *  3. **Search** — an unpinned lane that sits `rerollGapMs` behind the best is
 *     replaced by a new connection (LINE's edge maps each connection to a
 *     backend), measured while hidden, and only then offered to replies.
 */
export class ReplyRouteScout {
  readonly #o: Required<Omit<ReplyScoutOptions, 'timer'>> & { timer: ScoutTimer };
  #handle: unknown;
  #running = false;
  #challenger: number | undefined;
  #challengerStreak = 0;
  /** Set on the first tick: a re-roll needs a full interval of evidence. */
  #lastRerollMono: number | undefined;
  readonly #status: ScoutStatus = {
    running: false,
    probes: 0,
    probeFailures: 0,
    switches: 0,
    rerolls: 0,
    skippedForReplies: 0,
  };

  constructor(options: ReplyScoutOptions) {
    this.#o = {
      intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
      quietAfterSendMs: options.quietAfterSendMs ?? DEFAULTS.quietAfterSendMs,
      switchMarginMs: options.switchMarginMs ?? DEFAULTS.switchMarginMs,
      switchConfirmations: options.switchConfirmations ?? DEFAULTS.switchConfirmations,
      minSamples: options.minSamples ?? DEFAULTS.minSamples,
      rerollGapMs: options.rerollGapMs ?? DEFAULTS.rerollGapMs,
      rerollIntervalMs: options.rerollIntervalMs ?? DEFAULTS.rerollIntervalMs,
      rerollProbes: options.rerollProbes ?? DEFAULTS.rerollProbes,
      pool: options.pool,
      probe: options.probe,
      clock: options.clock,
      logger: options.logger,
      warmOrigin: options.warmOrigin,
      timer: options.timer ?? REAL_TIMER,
    };
    if (!(this.#o.intervalMs > 0)) {
      throw new ConfigError('ReplyRouteScout: intervalMs must be > 0', {
        intervalMs: this.#o.intervalMs,
      });
    }
    if (!Number.isInteger(this.#o.switchConfirmations) || this.#o.switchConfirmations < 1) {
      throw new ConfigError('ReplyRouteScout: switchConfirmations must be an integer >= 1', {
        switchConfirmations: this.#o.switchConfirmations,
      });
    }
  }

  get status(): ScoutStatus {
    return { ...this.#status, running: this.#running };
  }

  start(signal?: AbortSignal): void {
    if (this.#running) return;
    this.#running = true;
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    if (this.#handle !== undefined) this.#o.timer.clear(this.#handle);
    this.#handle = undefined;
  }

  /** One scouting step. Public so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.#replyActive()) {
      this.#status.skippedForReplies += 1;
      return;
    }
    const target = this.#nextProbeTarget();
    if (target !== undefined) await this.#probe(target.id);
    this.evaluate();
    await this.#maybeReroll();
  }

  /** Moves the pin when the evidence says so. Returns the lane now pinned. */
  evaluate(): number | undefined {
    const pool = this.#o.pool;
    const ranked = this.#ranked();
    const best = ranked[0];
    if (best === undefined) return pool.currentSendLaneId;
    const current = ranked.find((lane) => lane.pinned);
    if (current === undefined) {
      // No usable pin. Pick only once every usable lane has been ranked: a
      // pin chosen from a partial ranking would name whichever lane happened
      // to be probed first. Until then the router's own choice stands.
      this.#resetChallenger();
      if (this.#fullyRanked(ranked)) this.#promote(best, undefined, 'no usable pin');
      return pool.currentSendLaneId;
    }
    if (best.id === current.id) {
      this.#resetChallenger();
      return current.id;
    }
    const gain = current.preflightPredictedMs - best.preflightPredictedMs;
    if (gain < this.#o.switchMarginMs) {
      this.#resetChallenger();
      return current.id;
    }
    this.#challengerStreak = this.#challenger === best.id ? this.#challengerStreak + 1 : 1;
    this.#challenger = best.id;
    if (this.#challengerStreak < this.#o.switchConfirmations) return current.id;
    this.#resetChallenger();
    this.#promote(best, current, 'faster route');
    return pool.currentSendLaneId;
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#handle = this.#o.timer.set(() => {
      void this.tick().catch((error: unknown) => {
        this.#o.logger.warn('reply scout tick failed', { reason: reasonOf(error) });
      }).finally(() => this.#schedule());
    }, this.#o.intervalMs);
  }

  #replyActive(): boolean {
    const pool = this.#o.pool;
    if (pool.sendsInFlight > 0) return true;
    return this.#o.clock.monotonic() - pool.lastSendStartMono < this.#o.quietAfterSendMs;
  }

  /** The usable lane whose probe evidence is oldest; never one already being
   * probed or carrying other traffic. */
  #nextProbeTarget(): ReplyLaneView | undefined {
    const idle = this.#o.pool.replyLaneViews().filter((lane) =>
      lane.usable && !lane.probing && lane.inFlight === 0
    );
    return idle.reduce<ReplyLaneView | undefined>((oldest, lane) => {
      if (oldest === undefined) return lane;
      const at = lane.preflightLastMono ?? Number.NEGATIVE_INFINITY;
      const oldestAt = oldest.preflightLastMono ?? Number.NEGATIVE_INFINITY;
      return at < oldestAt ? lane : oldest;
    }, undefined);
  }

  async #probe(laneId: number): Promise<boolean> {
    this.#status.probes += 1;
    try {
      await this.#o.probe(laneId);
      return true;
    } catch (error: unknown) {
      this.#status.probeFailures += 1;
      this.#o.logger.debug('reply lane probe failed', { lane: laneId, reason: reasonOf(error) });
      return false;
    }
  }

  /** Whether every usable lane is in `ranked` (eligibility aside). */
  #fullyRanked(ranked: readonly Ranked[]): boolean {
    const usable = this.#o.pool.replyLaneViews().filter((lane) => lane.usable && lane.eligible);
    return usable.every((lane) => ranked.some((r) => r.id === lane.id));
  }

  /** Usable, eligible lanes with enough evidence, fastest first. */
  #ranked(): Ranked[] {
    return this.#o.pool.replyLaneViews()
      .filter((lane): lane is Ranked =>
        lane.usable && lane.eligible && lane.preflightPredictedMs !== undefined &&
        lane.preflightSamples >= this.#o.minSamples
      )
      .sort((a, b) => a.preflightPredictedMs - b.preflightPredictedMs);
  }

  #promote(to: Ranked, from: Ranked | undefined, reason: string): void {
    const moved = this.#o.pool.promoteSendLane(to.id, {
      reason,
      toPredictedMs: round2(to.preflightPredictedMs),
      fromPredictedMs: round2(from?.preflightPredictedMs),
    });
    if (moved && from !== undefined) this.#status.switches += 1;
  }

  #resetChallenger(): void {
    this.#challenger = undefined;
    this.#challengerStreak = 0;
  }

  /** Replaces the slowest unpinned lane when it trails the best by enough to
   * matter. Rate-limited: a new connection is cheap but not free for LINE. */
  async #maybeReroll(): Promise<void> {
    const now = this.#o.clock.monotonic();
    this.#lastRerollMono ??= now;
    if (now - this.#lastRerollMono < this.#o.rerollIntervalMs) return;
    const ranked = this.#ranked();
    if (!this.#fullyRanked(ranked)) return;
    const best = ranked[0];
    const worst = ranked.at(-1);
    if (best === undefined || worst === undefined || worst.id === best.id || worst.pinned) return;
    if (worst.preflightPredictedMs - best.preflightPredictedMs < this.#o.rerollGapMs) return;
    if (worst.inFlight > 0 || this.#replyActive()) return;
    this.#lastRerollMono = now;
    const before = worst.preflightPredictedMs;
    const opened = await this.#o.pool.rerollLane(worst.id, this.#o.warmOrigin);
    if (!opened) return;
    try {
      for (let i = 0; i < this.#o.rerollProbes; i += 1) await this.#probe(worst.id);
    } finally {
      this.#o.pool.revealLane(worst.id);
    }
    this.#status.rerolls += 1;
    const after = this.#o.pool.replyLaneViews().find((lane) => lane.id === worst.id);
    this.#o.logger.info('reply lane re-rolled onto a new connection', {
      lane: worst.id,
      beforeMs: round2(before),
      afterMs: round2(after?.preflightPredictedMs),
      bestMs: round2(best.preflightPredictedMs),
    });
    this.evaluate();
  }
}

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
