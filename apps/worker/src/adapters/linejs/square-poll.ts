import type { BotId, OwnerId } from '@line-first/contracts';
import { AsyncQueue } from '../../lib/async-queue.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../logging/logger.ts';
import { withTimeout } from '../../lib/with-timeout.ts';
import type { InboundEvent, SynchronousInboundAdapter } from '../types.ts';
import { normalizeMessage, type RawLineMessage } from './normalize.ts';

/** One page from a square-chat event poll. `syncToken` advances the cursor;
 * `pageWasEmpty` marks the end of the startup backlog (Playbook §5.3). */
export interface SquareEventPage {
  messages: readonly RawLineMessage[];
  syncToken: string | undefined;
  pageWasEmpty?: boolean;
}

/** Fetches one page for `syncToken`. Injected so the loop is testable without
 * a live client; {@link makeLinejsSquareFetcher} builds the real one. */
export type SquareEventFetcher = (
  syncToken: string | undefined,
  signal: AbortSignal,
) => Promise<SquareEventPage>;

export interface SquarePollOptions {
  fetcher: SquareEventFetcher;
  botId: BotId;
  ownerId: OwnerId;
  clock: Clock;
  logger: Logger;
  /** Gap after a completed round. 0 = poll again immediately (Playbook §5.4). */
  intervalMs?: number;
  fetchTimeoutMs?: number;
  /** Error backoff runs between these bounds (Playbook §5.5). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Remaining time to keep this room's next poll off a reply already in
   * flight. Read only after a page has delivered live messages. */
  quietBeforeNextFetchMs?: () => number;
  /** How many fetches to race per round, all against the same syncToken —
   * whichever settles first with a page wins the round; the rest are aborted
   * and drained before the next round starts. 1 (default) is the original
   * single-cursor behaviour. Widening this trades extra concurrent requests
   * for a shorter "blind window" between a message landing at LINE and this
   * poll noticing it — measured at ~16-20ms with width 1, since a message
   * that lands mid-flight is invisible until the in-flight fetch returns and
   * a new one is sent (Playbook §5.4, §16). */
  pollRaceWidth?: number;
}

const DEFAULTS = {
  intervalMs: 100,
  fetchTimeoutMs: 15_000,
  minBackoffMs: 50,
  maxBackoffMs: 1_000,
  pollRaceWidth: 1,
} as const;

/** First fulfillment among racers sharing one syncToken, unwrapped from the
 * `AggregateError` `Promise.any` throws when every one of them rejects —
 * that error carries no more information than the first underlying reason,
 * and the caller (and its "square poll round failed" log) wants that reason
 * in the same shape a single non-raced attempt would have thrown it in. */
async function firstFulfilled<T>(attempts: readonly Promise<T>[]): Promise<T> {
  try {
    return await Promise.any(attempts);
  } catch (error: unknown) {
    if (error instanceof AggregateError && error.errors.length > 0) throw error.errors[0];
    throw error;
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * A dedicated per-room poll — one of the sources {@link RacingInboundAdapter}
 * races against push (Playbook §5.1, §5.3).
 *
 * Discipline that keeps it from making things worse:
 *  - one round at a time: the next round starts only after every fetch from
 *    the current one has settled (winner and losers alike), so rounds never
 *    overlap and fight the connection pool. Within one round, `pollRaceWidth`
 *    fetches may run concurrently against the same syncToken — see below.
 *  - startup drain: the first page is history; its events are discarded and only
 *    the syncToken is kept, so old keywords are not answered.
 *  - every fetch has a timeout and is abortable.
 */
export class SquarePollAdapter implements SynchronousInboundAdapter {
  readonly #opts:
    & Required<
      Omit<
        SquarePollOptions,
        'fetcher' | 'botId' | 'ownerId' | 'clock' | 'logger' | 'quietBeforeNextFetchMs'
      >
    >
    & Pick<
      SquarePollOptions,
      'fetcher' | 'botId' | 'ownerId' | 'clock' | 'logger' | 'quietBeforeNextFetchMs'
    >;
  readonly #out = new AsyncQueue<InboundEvent>();
  #syncToken: string | undefined;
  #drained = false;
  #drainedCount = 0;
  #rounds = 0;
  #controller: AbortController | undefined;
  #synchronousSink: ((event: InboundEvent) => void) | undefined;

  constructor(options: SquarePollOptions) {
    this.#opts = {
      intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
      fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs,
      minBackoffMs: options.minBackoffMs ?? DEFAULTS.minBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      pollRaceWidth: Math.max(1, options.pollRaceWidth ?? DEFAULTS.pollRaceWidth),
      fetcher: options.fetcher,
      botId: options.botId,
      ownerId: options.ownerId,
      clock: options.clock,
      logger: options.logger,
      quietBeforeNextFetchMs: options.quietBeforeNextFetchMs,
    };
  }

  get drainedBacklog(): number {
    return this.#drainedCount;
  }

  get rounds(): number {
    return this.#rounds;
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#controller !== undefined) return Promise.resolve();
    this.#controller = new AbortController();
    signal.addEventListener('abort', () => void this.stop(), { once: true });
    void this.#loop(this.#controller.signal);
    return Promise.resolve();
  }

  events(): AsyncIterable<InboundEvent> {
    return this.#out;
  }

  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void {
    this.#synchronousSink = sink;
  }

  stop(): Promise<void> {
    this.#controller?.abort();
    this.#out.close();
    return Promise.resolve();
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let backoff = this.#opts.minBackoffMs;
    while (!signal.aborted) {
      try {
        const delivered = await this.#round(signal);
        backoff = this.#opts.minBackoffMs;
        const quietMs = delivered ? (this.#opts.quietBeforeNextFetchMs?.() ?? 0) : 0;
        await sleep(Math.max(this.#opts.intervalMs, quietMs), signal);
      } catch (error: unknown) {
        this.#opts.logger.warn('square poll round failed', {
          reason: error instanceof Error ? error.message : 'unknown',
          backoffMs: backoff,
        });
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, this.#opts.maxBackoffMs);
      }
    }
  }

  async #round(signal: AbortSignal): Promise<boolean> {
    this.#rounds += 1;
    const syncToken = this.#syncToken;
    const controllers: AbortController[] = [];
    // Some LINEJS service methods currently replace a caller's AbortSignal
    // with their own timeout, so aborting a racer does not guarantee its
    // fetcher call actually stops. `rawPending` keeps the real fetcher
    // promise (not the timeout-wrapped one below) so the round can wait for
    // every abandoned call to truly settle before the next round starts —
    // otherwise a timeout could silently pile up overlapping poll streams.
    const rawPending: Promise<SquareEventPage>[] = [];
    // Each racer listens on the caller's own long-lived `signal` to abort
    // early if the adapter stops mid-round. That signal outlives every round,
    // so the listener must be removed once this round settles — `once: true`
    // alone only cleans up if `signal` actually fires, which for a healthy
    // adapter may never happen before the process exits, leaking one listener
    // per racer per round for as long as it runs.
    const onParentAborts: (() => void)[] = [];
    const attempts = Array.from({ length: this.#opts.pollRaceWidth }, (_, i) => {
      const controller = new AbortController();
      controllers.push(controller);
      const onParentAbort = (): void => controller.abort();
      onParentAborts.push(onParentAbort);
      signal.addEventListener('abort', onParentAbort, { once: true });
      if (signal.aborted) controller.abort();
      return withTimeout((s) => {
        const raw = this.#opts.fetcher(syncToken, s);
        rawPending[i] = raw;
        return raw;
      }, {
        timeoutMs: this.#opts.fetchTimeoutMs,
        signal: controller.signal,
        label: 'square-poll',
      });
    });
    const settleStragglers = async (): Promise<void> => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(rawPending.map((raw) => raw.catch(() => {})));
      for (let i = 0; i < onParentAborts.length; i += 1) {
        signal.removeEventListener('abort', onParentAborts[i]!);
      }
    };

    let page: SquareEventPage;
    try {
      // Every racer shares `syncToken`, so whichever settles first with a
      // page answers the exact same question the others were asked — the
      // rest are redundant, not a second opinion, and are simply discarded.
      page = await firstFulfilled(attempts);
    } catch (error: unknown) {
      await settleStragglers();
      throw error;
    }
    this.#syncToken = page.syncToken ?? this.#syncToken;

    let delivered = false;
    if (!this.#drained) {
      // Keep advancing the cursor over history until a page comes back empty,
      // matching LINEJS's own drain loop.
      this.#drainedCount += page.messages.length;
      if (page.pageWasEmpty === true || page.messages.length === 0) this.#drained = true;
    } else {
      for (const raw of page.messages) this.#emit(raw);
      delivered = page.messages.length > 0;
    }
    // Draining the losers happens last, after the winner's message is already
    // emitted (and, via the synchronous sink, its reply already started) — a
    // losing racer's abort/drain must never delay the reply this round exists
    // to win. It still has to happen before the function returns, though:
    // `#loop` starts the next round right after, and that round must not add
    // its own fetches on top of stragglers still settling from this one.
    await settleStragglers();
    return delivered;
  }

  #emit(raw: RawLineMessage): void {
    const event = normalizeMessage(raw, {
      botId: this.#opts.botId,
      ownerId: this.#opts.ownerId,
      surface: 'square',
      source: 'dedicated-poll',
      observedAtMono: this.#opts.clock.monotonic(),
      observedAtWallMs: this.#opts.clock.now(),
    });
    if (this.#synchronousSink !== undefined) {
      // Deliberately synchronous: start the reply while this completed poll is
      // still the current stack, before loop bookkeeping or the next fetch.
      this.#synchronousSink(event);
    } else if (!this.#out.push(event)) {
      this.#opts.logger.warn('square poll queue full; event dropped', {
        messageId: event.messageId,
      });
    }
  }
}
