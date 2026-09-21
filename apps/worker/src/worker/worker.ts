import {
  hasSynchronousInbound,
  type InboundAdapter,
  type InboundEvent,
  type PushHealthSource,
  type Sender,
} from '../adapters/types.ts';
import type { RacingInboundAdapter } from '../adapters/racing.ts';
import { ALLOW_ANY_SENDER, IdSenderAllowlist, type SenderAllowlist } from '../core/allowlist.ts';
import type { BotConfig } from '../config/bot-config.ts';
import type { WorkerConfig } from '../config/env.ts';
import { createCore } from '../core/core.ts';
import { compileRules } from '../core/rules/compile.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import { AlertEvaluator, type AlertThresholds } from '../monitoring/alerts.ts';
import { RecoveryPlanner } from '../monitoring/recovery.ts';
import type { RecoveryExecutor } from './recovery-executor.ts';
import { StatusSource } from '../observability/snapshot.ts';
import { type PipelineDeps, processInbound } from '../pipeline/process-inbound.ts';
import { ReadinessFsm } from '../readiness/state.ts';
import type { LanePool } from '../transport/lane-pool.ts';
import { HOT_SEND_ORIGIN, type TransportWarmer } from '../warm/warmer.ts';

/**
 * The worker main loop: the thing that was missing while every phase built a
 * piece of it.
 *
 * Responsibilities, and the order they matter in:
 *
 *  1. Pull events off the inbound adapter and answer them. Nothing else may
 *     ever sit between an event and its reply.
 *  2. Keep readiness honest, so `/api/health` means "can answer right now".
 *  3. Run the monitor tick — alerts and the recovery ladder — on a timer,
 *     never inline with a reply.
 *
 * Dispatch is deliberately NOT awaited in the read loop. Awaiting would make
 * the next event wait for this one's network round trip, which is precisely
 * the "งานใหม่ติด queue ของงานเก่า" failure the acceptance table checks for.
 */

export interface WorkerOptions {
  bot: BotConfig;
  env: WorkerConfig;
  adapter: InboundAdapter;
  sender: Sender;
  clock: Clock;
  logger: Logger;
  metrics?: MetricsRecorder;
  /** Present when the receive path is raced; feeds the dashboard and the
   * missed-events alert. */
  racer?: RacingInboundAdapter | undefined;
  warmer?: TransportWarmer | undefined;
  /** Present when `bot.lanes > 0`; feeds the dashboard's lanes table. Without
   * this, owned lanes still run the actual sends but the dashboard has no
   * way to show their per-lane RTT/state — it silently renders "ไม่ได้เปิด
   * owned lanes" regardless of whether they are. */
  lanePool?: LanePool | undefined;
  /** Performs recovery actions. Omitted = decide and log only. */
  recovery?: RecoveryExecutor | undefined;
  /** Optional account-wide PUSH health. Dedicated polling may keep receiving
   * while it reconnects, but ARMED must not falsely claim PUSH is alive. */
  pushHealth?: PushHealthSource | undefined;
  alertThresholds?: Partial<AlertThresholds>;
  /** How often to evaluate alerts. Off the hot path by construction. */
  monitorIntervalMs?: number;
  timer?: TimerLike;
}

/** The handle type differs between runtimes, so it stays opaque here. */
export interface TimerLike {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_MONITOR_INTERVAL_MS = 15_000;

const REAL_TIMER: TimerLike = {
  set: (cb: () => void, ms: number): unknown => setInterval(cb, ms),
  clear: (handle: unknown): void => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface WorkerStats {
  received: number;
  dispatched: number;
  suppressed: number;
  failed: number;
  inFlight: number;
}

export class Worker {
  readonly readiness: ReadinessFsm;
  readonly metrics: MetricsRecorder;
  readonly alerts: AlertEvaluator;
  readonly recoveryPlanner: RecoveryPlanner;
  readonly status: StatusSource;

  readonly #o: WorkerOptions;
  readonly #deps: PipelineDeps;
  #selectedRooms: ReadonlySet<string> | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  #monitorHandle: unknown;
  #stats = { received: 0, dispatched: 0, suppressed: 0, failed: 0 };

  constructor(options: WorkerOptions) {
    this.#o = options;
    this.metrics = options.metrics ?? new MetricsRecorder();
    this.readiness = new ReadinessFsm(options.clock, options.logger);
    this.#deps = {
      core: createCore(options.env, options.clock),
      rules: compileRules(options.bot.rules),
      sender: options.sender,
      allowlist: buildAllowlist(options.bot),
      clock: options.clock,
      logger: options.logger,
      opTimeoutMs: options.env.defaultOpTimeoutMs,
      metrics: this.metrics,
    };
    this.#selectedRooms = options.bot.selectedRooms === undefined
      ? undefined
      : new Set(options.bot.selectedRooms);

    this.alerts = new AlertEvaluator({
      // Race accounting groups all dedicated room polls under the single
      // `dedicated-poll` source.  It is therefore two sources (push and that
      // poll source), not one source per room.  Counting each room here made
      // the permanently-unused `normal-poll` bucket look dead, repeatedly
      // scheduling pointless recovery work while zero-interval dedicated
      // polling was healthy.
      racedSources: options.bot.dedicatedRooms.length > 0 && options.bot.slotBudget > 0 ? 2 : 1,
      ...options.alertThresholds,
    });
    this.recoveryPlanner = new RecoveryPlanner({
      clock: options.clock,
      logger: options.logger,
    });
    this.status = new StatusSource({
      workerId: options.bot.botId,
      origin: HOT_SEND_ORIGIN,
      clock: options.clock,
      metrics: this.metrics,
      readiness: this.readiness,
      ...(options.racer === undefined ? {} : { race: options.racer }),
      ...(options.warmer === undefined ? {} : { warmer: options.warmer }),
      ...(options.lanePool === undefined ? {} : { lanePool: options.lanePool }),
    });

    // Rules come from a file that is already parsed, and the sender is
    // constructed before we get here; both are ready by definition.
    this.readiness.set({ rulesLoaded: true, senderReady: true });
  }

  get stats(): WorkerStats {
    return { ...this.#stats, inFlight: this.#inFlight.size };
  }

  get ruleCount(): number {
    return this.#deps.rules.size;
  }

  /**
   * Swaps the compiled rule set an in-flight `Worker` uses, with no restart
   * and no gap where an event is matched against neither set. `PipelineDeps`
   * is read fresh on every `processInbound` call, so the very next event
   * after this returns sees the new rules; anything already dispatched keeps
   * running against whichever rules it started with — reversing history is
   * not on the table (Playbook: a rule edit is not a reason to touch the
   * receiver, session or any in-flight reply).
   */
  setRules(rules: PipelineDeps['rules']): void {
    const before = this.#deps.rules.size;
    this.#deps.rules = rules;
    this.#o.logger.info('rules reloaded', { before, after: rules.size });
  }

  /**
   * Swaps which rooms this worker answers, with no restart — the room-switch
   * half of the request, mirroring {@link setRules}. `#handle` reads
   * `#selectedRooms` fresh on every event, so the very next event after this
   * returns is filtered against the new selection; nothing already
   * dispatched is affected. `undefined` means "answer every room" (the
   * historical default before any selection is saved); an empty array means
   * "answer none".
   */
  setSelectedRooms(rooms: readonly string[] | undefined): void {
    const before = this.#selectedRooms === undefined ? 'all' : this.#selectedRooms.size;
    this.#selectedRooms = rooms === undefined ? undefined : new Set(rooms);
    const after = this.#selectedRooms === undefined ? 'all' : this.#selectedRooms.size;
    this.#o.logger.info('selected rooms updated', { before, after });
  }

  /**
   * Runs until `signal` aborts or the adapter's stream ends. Resolves once
   * every reply already in flight has settled.
   */
  async run(signal: AbortSignal): Promise<void> {
    this.readiness.set({ sessionValid: true });
    const synchronous = hasSynchronousInbound(this.#o.adapter) ? this.#o.adapter : undefined;
    if (synchronous !== undefined) {
      // processInbound reaches Sender.send synchronously. Installing this
      // before adapter.start removes both receive queues from the winning
      // dedicated-poll path.
      synchronous.setSynchronousSink((event) => {
        if (!signal.aborted) this.#handle(event, signal);
      });
    }
    await this.#o.adapter.start(signal);
    // `start` resolves only after the startup backlog is drained, which is
    // exactly the condition ARMED needs — old keywords must not be answered as
    // new jobs (Playbook §5.3).
    this.readiness.set({
      receiverSubscribed: this.#pushReady(),
      backlogDrained: true,
    });
    this.#o.logger.info('worker armed', {
      botId: this.#o.bot.botId,
      rules: this.#deps.rules.size,
      dryRun: this.#o.bot.dryRun,
    });

    this.#startMonitor();
    try {
      for await (const event of this.#o.adapter.events()) {
        if (signal.aborted) break;
        this.#handle(event, signal);
      }
    } finally {
      synchronous?.setSynchronousSink(undefined);
      this.#stopMonitor();
      await this.drain();
      this.readiness.set({ receiverSubscribed: false });
    }
  }

  /** Waits for in-flight replies. Safe to call more than once. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** One monitoring pass. Public so a test can drive it without a timer. */
  monitorTick(): void {
    this.readiness.set({ receiverSubscribed: this.#pushReady() });
    const firing = this.alerts.evaluate(this.status.snapshot());
    for (const alert of firing) {
      this.#o.logger.warn('alert', {
        kind: alert.kind,
        severity: alert.severity,
        detail: alert.message,
      });
    }
    const action = this.recoveryPlanner.next(firing);
    if (action === undefined) return;
    void this.#o.recovery?.apply(action).catch((err: unknown) => {
      this.#o.logger.error('recovery action failed', {
        rung: action.rung,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Fire-and-forget dispatch. Errors are recorded, never rethrown into the
   * read loop — one bad event must not stop the worker receiving the next.
   */
  #handle(event: InboundEvent, signal: AbortSignal): void {
    if (this.#selectedRooms !== undefined && !this.#selectedRooms.has(event.roomId)) {
      this.#stats.received += 1;
      this.#stats.suppressed += 1;
      this.metrics.count('outcome.room-not-selected');
      this.metrics.count(`surface.${event.surface}`);
      this.metrics.count(`source.${event.source}`);
      return;
    }
    // Adapter construction binds bot/owner identity once. Do not clone or
    // re-check the event in the per-message path.
    const task = processInbound(event, this.#deps, signal)
      .then((result) => {
        if (result.outcome === 'dispatched') this.#stats.dispatched += 1;
        else if (result.outcome === 'send-failed') this.#stats.failed += 1;
        else this.#stats.suppressed += 1;
      })
      .catch((err: unknown) => {
        this.#stats.failed += 1;
        this.#o.logger.error('pipeline error', {
          messageId: event.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.#inFlight.delete(task);
      });
    // processInbound is intentionally synchronous until Sender.send has been
    // invoked. Accounting starts only after that point, outside the race.
    this.#stats.received += 1;
    this.#inFlight.add(task);
  }

  #pushReady(): boolean {
    return this.#o.pushHealth?.pushHealth.ready ?? true;
  }

  #startMonitor(): void {
    const timer = this.#o.timer ?? REAL_TIMER;
    const every = this.#o.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    this.#monitorHandle = timer.set(() => {
      this.monitorTick();
    }, every);
  }

  #stopMonitor(): void {
    if (this.#monitorHandle === undefined) return;
    (this.#o.timer ?? REAL_TIMER).clear(this.#monitorHandle);
    this.#monitorHandle = undefined;
  }
}

function buildAllowlist(bot: BotConfig): SenderAllowlist {
  if (bot.allowedSenders === undefined) return ALLOW_ANY_SENDER;
  return new IdSenderAllowlist({ [bot.ownerId]: bot.allowedSenders });
}
