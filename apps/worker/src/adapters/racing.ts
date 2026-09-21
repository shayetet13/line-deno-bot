import { INBOUND_SOURCES, type InboundSource } from '@line-first/contracts';
import { BoundedTtlMap } from '../lib/bounded-ttl-map.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { AsyncQueue } from '../lib/async-queue.ts';
import {
  hasPushHealth,
  hasSynchronousInbound,
  type InboundAdapter,
  type InboundEvent,
  type PushHealth,
  type SynchronousInboundAdapter,
} from './types.ts';

export interface RacingOptions {
  clock: Clock;
  logger: Logger;
  /** How long a message-id is remembered so a later copy from another source is
   * suppressed (Playbook §5.2). */
  dedupeTtlMs?: number;
  maxDedupeEntries?: number;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_ENTRIES = 50_000;

export type SourceWins = Record<InboundSource, number>;

export interface RaceStats {
  /** Per source: how many messages that source delivered first. */
  wins: SourceWins;
  /** Per source: every message that source ever offered, whether it won or
   * arrived after another source already had (Playbook §16 — the
   * missed-events alert reads this, not `wins`: once one source is
   * consistently faster by design, the slower one winning 0% of races is
   * correct behaviour, not a dead path. A source that has stopped SEEING
   * traffic at all is the thing worth alerting on.). */
  seen: SourceWins;
  /** Copies suppressed because another source got there first. */
  duplicatesSuppressed: number;
  delivered: number;
}

const zeroWins = (): SourceWins =>
  Object.fromEntries(INBOUND_SOURCES.map((s) => [s, 0])) as SourceWins;

/**
 * Runs several inbound sources at once and forwards whichever copy of a message
 * arrives first, tagged with the source that won (Playbook §5.1: "ใครเห็น
 * message-id ก่อนให้เริ่มตอบทันที ... เพราะผู้ชนะเปลี่ยนได้ทุกข้อความ").
 *
 * The point is not that one source is reliably faster — it is that on any given
 * message a different one might be, and the 25ms of inbound jitter measured in
 * Phase 1b is the gap this can close.
 */
export class RacingInboundAdapter implements SynchronousInboundAdapter {
  #children: InboundAdapter[];
  readonly #out = new AsyncQueue<InboundEvent>();
  readonly #seenIds: BoundedTtlMap<InboundSource>;
  readonly #logger: Logger;
  readonly #wins = zeroWins();
  readonly #seenCounts = zeroWins();
  #duplicates = 0;
  #delivered = 0;
  #liveChildren = 0;
  #started = false;
  /** Saved from `start()` so a child added later (`addChild`) can still be
   * started correctly — see the room-switch-without-restart requirement. */
  #signal: AbortSignal | undefined;
  #synchronousSink: ((event: InboundEvent) => void) | undefined;

  constructor(children: readonly InboundAdapter[], options: RacingOptions) {
    this.#children = [...children];
    this.#logger = options.logger;
    this.#seenIds = new BoundedTtlMap<InboundSource>(options.clock, {
      ttlMs: options.dedupeTtlMs ?? DEFAULT_TTL_MS,
      maxEntries: options.maxDedupeEntries ?? DEFAULT_MAX_ENTRIES,
    });
  }

  get stats(): RaceStats {
    return {
      wins: { ...this.#wins },
      seen: { ...this.#seenCounts },
      duplicatesSuppressed: this.#duplicates,
      delivered: this.#delivered,
    };
  }

  /** The race remains able to poll when PUSH reconnects, but readiness must
   * not claim that the account-wide subscription itself is alive until the
   * PUSH transport confirms it. */
  get pushHealth(): PushHealth {
    const push = this.#children.find(hasPushHealth);
    return push?.pushHealth ?? { ready: true };
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#signal = signal;
    this.#liveChildren = this.#children.length;
    // Wire the direct path before starting a child: a zero-interval poll may
    // complete immediately, and its first live message must not slip through
    // an output queue just because startup was still unwinding.
    for (const child of this.#children) {
      if (hasSynchronousInbound(child)) child.setSynchronousSink((event) => this.#offer(event));
    }
    await Promise.all(this.#children.map((child) => child.start(signal)));
    for (const child of this.#children) void this.#pump(child);
  }

  /**
   * Adds one more source mid-stream — e.g. a newly dedicated-polled room
   * (the room-switch-without-restart requirement). Joining before `start()`
   * runs is a no-op beyond bookkeeping: the next `start()` picks it up with
   * every other child. Joining after `start()` wires and starts it the same
   * way `start()` would have, then folds its stream into the same output.
   */
  async addChild(child: InboundAdapter): Promise<void> {
    this.#children.push(child);
    if (!this.#started || this.#signal === undefined) return;
    if (hasSynchronousInbound(child)) child.setSynchronousSink((event) => this.#offer(event));
    this.#liveChildren += 1;
    await child.start(this.#signal);
    void this.#pump(child);
  }

  /**
   * Stops and removes one source mid-stream. `child.stop()` ends its event
   * stream, which runs `#pump`'s own `finally` — the exact same accounting a
   * natural end gets. `#liveChildren` only reaches zero (closing `#out`) once
   * every remaining child has also ended, so removing one room poll among
   * several never stops the racer as a whole.
   */
  async removeChild(child: InboundAdapter): Promise<void> {
    this.#children = this.#children.filter((c) => c !== child);
    await child.stop();
  }

  events(): AsyncIterable<InboundEvent> {
    return this.#out;
  }

  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void {
    this.#synchronousSink = sink;
  }

  async stop(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.stop()));
    this.#out.close();
  }

  async #pump(child: InboundAdapter): Promise<void> {
    try {
      for await (const event of child.events()) this.#offer(event);
    } catch (error: unknown) {
      this.#logger.warn('racing child stream failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.#liveChildren -= 1;
      if (this.#liveChildren <= 0) this.#out.close();
    }
  }

  #offer(event: InboundEvent): void {
    if (this.#seenIds.has(event.messageId)) {
      // A duplicate has no reply to race, so its accounting can happen here.
      this.#seenCounts[event.source] += 1;
      this.#duplicates += 1;
      return;
    }
    this.#seenIds.set(event.messageId, event.source);
    if (this.#synchronousSink !== undefined) {
      this.#synchronousSink(event);
    } else if (!this.#out.push(event)) {
      this.#logger.warn('racing output queue full; event dropped', { messageId: event.messageId });
    }
    // The synchronous sink has already started Sender.send before it returns.
    // Dashboard counters therefore stay behind the request, never in front.
    this.#seenCounts[event.source] += 1;
    this.#wins[event.source] += 1;
    this.#delivered += 1;
  }
}
