import type { BotId, OwnerId } from '@line-first/contracts';
import { ConfigError } from '../../errors/base.ts';
import { AsyncQueue } from '../../lib/async-queue.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../logging/logger.ts';
import { withTimeout } from '../../lib/with-timeout.ts';
import type { InboundEvent, SynchronousInboundAdapter } from '../types.ts';
import { normalizeMessage, type RawLineMessage, toEpochMs } from './normalize.ts';

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
  /** How many fetches to keep in flight at evenly spaced offsets once the
   * backlog is drained. Unlike `pollRaceWidth`, whose racers all start at the
   * same instant and therefore sample LINE at the same moment, staggered
   * fetches start `RTT / pollStagger` apart, so a message that lands while one
   * fetch is in flight is picked up by the next one instead of waiting a full
   * round trip. 1 (default) keeps the single-cursor loop. Mutually exclusive
   * with `pollRaceWidth > 1`. */
  pollStagger?: number;
}

const DEFAULTS = {
  intervalMs: 100,
  fetchTimeoutMs: 15_000,
  minBackoffMs: 50,
  maxBackoffMs: 1_000,
  pollRaceWidth: 1,
  pollStagger: 1,
} as const;

/** Weight of the newest fetch duration in the stagger-spacing estimate. */
const RTT_EWMA_ALPHA = 0.2;
/** Message ids remembered so overlapping staggered fetches emit each once. */
const SEEN_MESSAGE_IDS_MAX = 512;
/** Completed staggered fetches kept to count how many missed a message. */
const RECENT_FETCHES_MAX = 16;

/** A completed staggered fetch, on the wall clock LINE's timestamps use. */
interface FetchRecord {
  startWall: number;
  endWall: number;
  ids: readonly RawLineMessage[];
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

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
    // The signal outlives every sleep, so the listener must go when the timer
    // fires — `once` alone would leak one listener per sleep until shutdown.
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
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
  /** Smoothed fetch duration; spaces staggered launches evenly across it. */
  #rttEwmaMs: number | undefined;
  /** Launch time of the fetch whose syncToken the cursor currently holds. A
   * response from a fetch that started earlier describes an older moment and
   * must not move the cursor backwards. */
  #adoptedStartMono = Number.NEGATIVE_INFINITY;
  readonly #seenIds = new Set<string>();
  readonly #seenOrder: string[] = [];
  readonly #recentFetches: FetchRecord[] = [];

  constructor(options: SquarePollOptions) {
    this.#opts = {
      intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
      fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs,
      minBackoffMs: options.minBackoffMs ?? DEFAULTS.minBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      pollRaceWidth: Math.max(1, options.pollRaceWidth ?? DEFAULTS.pollRaceWidth),
      pollStagger: Math.max(1, options.pollStagger ?? DEFAULTS.pollStagger),
      fetcher: options.fetcher,
      botId: options.botId,
      ownerId: options.ownerId,
      clock: options.clock,
      logger: options.logger,
      quietBeforeNextFetchMs: options.quietBeforeNextFetchMs,
    };
    if (this.#opts.pollStagger > 1 && this.#opts.pollRaceWidth > 1) {
      throw new ConfigError(
        'SquarePollAdapter: pollStagger and pollRaceWidth cannot both exceed 1',
        {
          pollStagger: this.#opts.pollStagger,
          pollRaceWidth: this.#opts.pollRaceWidth,
        },
      );
    }
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
      // History is always drained by the single-cursor round below; only live
      // traffic is worth the extra staggered requests.
      if (this.#drained && this.#opts.pollStagger > 1) {
        await this.#staggeredLoop(signal);
        return;
      }
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
    const startedAt = this.#opts.clock.monotonic();
    try {
      // Every racer shares `syncToken`, so whichever settles first with a
      // page answers the exact same question the others were asked — the
      // rest are redundant, not a second opinion, and are simply discarded.
      page = await firstFulfilled(attempts);
    } catch (error: unknown) {
      await settleStragglers();
      throw error;
    }
    this.#observeRtt(this.#opts.clock.monotonic() - startedAt);
    this.#syncToken = page.syncToken ?? this.#syncToken;
    this.#adoptedStartMono = startedAt;

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

  /**
   * Live polling with `pollStagger` fetches in flight, launched evenly across
   * one round trip. With one fetch at a time a message is invisible for up to
   * a full RTT (it landed after LINE sampled the in-flight request); with N
   * staggered fetches that blind window shrinks to about RTT / N.
   *
   * Discipline kept from the single-cursor loop: in-flight count is bounded
   * (a timed-out fetch keeps its slot until the real call settles), errors
   * back off, and a delivered page honours the reply quiet window.
   */
  async #staggeredLoop(signal: AbortSignal): Promise<void> {
    const depth = this.#opts.pollStagger;
    const clock = this.#opts.clock;
    const inFlight = new Set<Promise<void>>();
    let lastLaunch = Number.NEGATIVE_INFINITY;
    let holdUntil = Number.NEGATIVE_INFINITY;
    let backoff = this.#opts.minBackoffMs;

    while (!signal.aborted) {
      if (inFlight.size >= depth) {
        await Promise.race(inFlight);
        continue;
      }
      const now = clock.monotonic();
      const spacing = ((this.#rttEwmaMs ?? 0) + this.#opts.intervalMs) / depth;
      const waitMs = Math.max(lastLaunch + spacing - now, holdUntil - now);
      if (waitMs > 0) {
        await sleep(waitMs, signal);
        continue;
      }
      lastLaunch = now;
      const pending: Promise<void> = this.#staggeredFetch(signal, now).then(
        (delivered) => {
          backoff = this.#opts.minBackoffMs;
          const quietMs = delivered ? (this.#opts.quietBeforeNextFetchMs?.() ?? 0) : 0;
          if (quietMs > 0) holdUntil = Math.max(holdUntil, clock.monotonic() + quietMs);
        },
        (error: unknown) => {
          if (signal.aborted) return;
          this.#opts.logger.warn('square poll round failed', {
            reason: error instanceof Error ? error.message : 'unknown',
            backoffMs: backoff,
          });
          holdUntil = Math.max(holdUntil, clock.monotonic() + backoff);
          backoff = Math.min(backoff * 2, this.#opts.maxBackoffMs);
        },
      ).finally(() => inFlight.delete(pending));
      inFlight.add(pending);
    }
    await Promise.allSettled([...inFlight]);
  }

  async #staggeredFetch(signal: AbortSignal, startedAt: number): Promise<boolean> {
    this.#rounds += 1;
    const syncToken = this.#syncToken;
    let raw: Promise<SquareEventPage> | undefined;
    try {
      const page = await withTimeout((s) => {
        raw = this.#opts.fetcher(syncToken, s);
        return raw;
      }, {
        timeoutMs: this.#opts.fetchTimeoutMs,
        signal,
        label: 'square-poll',
      });
      const fetchMs = this.#opts.clock.monotonic() - startedAt;
      this.#observeRtt(fetchMs);
      if (startedAt > this.#adoptedStartMono) {
        this.#adoptedStartMono = startedAt;
        this.#syncToken = page.syncToken ?? this.#syncToken;
      }
      let hits: RawLineMessage[] | undefined;
      for (const message of page.messages) {
        if (!this.#firstSighting(message.raw.message.id)) continue;
        this.#emit(message);
        (hits ??= []).push(message);
      }
      // Diagnostics only after every reply above has already started.
      const endWall = this.#opts.clock.now();
      const fetch: FetchRecord = { startWall: endWall - fetchMs, endWall, ids: page.messages };
      if (hits !== undefined) this.#logHits(hits, fetch);
      this.#recentFetches.push(fetch);
      if (this.#recentFetches.length > RECENT_FETCHES_MAX) this.#recentFetches.shift();
      return hits !== undefined;
    } finally {
      // Some LINEJS calls ignore the abort signal; keep the slot occupied
      // until the real request settles so fetches can never pile up.
      await raw?.catch(() => {});
    }
  }

  /**
   * One line per newly seen message, splitting inbound delay into the part
   * polling controls and the part LINE does:
   *  - `waitMs`: message created → the fetch that returned it was sent. Only
   *    this shrinks with `pollStagger`.
   *  - `fetchMs`: that fetch's own round trip.
   *  - `missed`: fetches sent AFTER the message was created that came back
   *    without it — each one is LINE not yet exposing the message.
   */
  #logHits(hits: readonly RawLineMessage[], fetch: FetchRecord): void {
    for (const message of hits) {
      const createdMs = toEpochMs(message.raw.message.createdTime);
      if (createdMs === undefined) continue;
      const id = message.raw.message.id;
      const missed = this.#recentFetches.filter((f) =>
        f.startWall >= createdMs && !f.ids.some((m) =>
          m.raw.message.id === id
        )
      ).length;
      this.#opts.logger.info('poll hit', {
        messageId: id,
        inboundMs: round1(fetch.endWall - createdMs),
        waitMs: round1(fetch.startWall - createdMs),
        fetchMs: round1(fetch.endWall - fetch.startWall),
        missed,
        stagger: this.#opts.pollStagger,
      });
    }
  }

  /** True the first time an id is seen. Overlapping fetches return the same
   * message; only the first sighting may reach the reply path. */
  #firstSighting(id: string): boolean {
    if (this.#seenIds.has(id)) return false;
    this.#seenIds.add(id);
    this.#seenOrder.push(id);
    if (this.#seenOrder.length > SEEN_MESSAGE_IDS_MAX) {
      const evicted = this.#seenOrder.shift();
      if (evicted !== undefined) this.#seenIds.delete(evicted);
    }
    return true;
  }

  #observeRtt(ms: number): void {
    this.#rttEwmaMs = this.#rttEwmaMs === undefined
      ? ms
      : this.#rttEwmaMs + (ms - this.#rttEwmaMs) * RTT_EWMA_ALPHA;
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
