import type { Client } from '@evex/linejs';
import type { BotId, OwnerId } from '@line-first/contracts';
import { AsyncQueue } from '../../lib/async-queue.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../logging/logger.ts';
import type { InboundEvent, PushHealth, SynchronousInboundAdapter } from '../types.ts';
import { normalizeMessage, type RawLineMessage } from './normalize.ts';

const DEFAULT_DRAIN_MS = 1_500;

export interface LinejsInboundOptions {
  client: Client;
  botId: BotId;
  ownerId: OwnerId;
  clock: Clock;
  logger: Logger;
  talk?: boolean;
  square?: boolean;
  /** Reports whether LINE accepted the actual H2 `/PUSH` response. */
  pushStatus?: () => PushHealth;
  /** Events seen in this window after `start()` are discarded as backlog
   * (Playbook §5.3 — never answer a keyword from before we came up). */
  drainMs?: number;
}

/**
 * Bridges LINEJS's event emitter onto {@link InboundAdapter}.
 *
 * `client.listen()` runs detached loops with their own error handling, so the
 * only failure mode we own is the queue: it is bounded, and a full queue counts
 * drops instead of growing without limit.
 */
export class LinejsInboundAdapter implements SynchronousInboundAdapter {
  readonly #queue = new AsyncQueue<InboundEvent>();
  readonly #opts: LinejsInboundOptions;
  #draining = true;
  #drained = 0;
  #stopped = false;
  #synchronousSink: ((event: InboundEvent) => void) | undefined;

  constructor(opts: LinejsInboundOptions) {
    this.#opts = opts;
  }

  /** Backlog discarded during the startup drain window. */
  get drainedCount(): number {
    return this.#drained;
  }

  get droppedCount(): number {
    return this.#queue.dropped;
  }

  /** Do not equate `listen()` having been called with a usable PUSH stream.
   * The sidecar only reports ready after LINE returned H2 response headers. */
  get pushHealth(): PushHealth {
    return this.#opts.pushStatus?.() ?? { ready: true };
  }

  async start(signal: AbortSignal): Promise<void> {
    const { client, logger, talk = true, square = true } = this.#opts;
    client.on('message', (m) => this.#ingest(m as unknown as RawLineMessage, 'talk'));
    client.on('square:message', (m) => this.#ingest(m as unknown as RawLineMessage, 'square'));
    signal.addEventListener('abort', () => void this.stop(), { once: true });
    client.listen({ talk, square, signal });

    const drainMs = this.#opts.drainMs ?? DEFAULT_DRAIN_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
    this.#draining = false;
    logger.info('inbound ready', { drainedBacklog: this.#drained, drainMs });
  }

  events(): AsyncIterable<InboundEvent> {
    return this.#queue;
  }

  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void {
    this.#synchronousSink = sink;
  }

  stop(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#stopped = true;
    this.#queue.close();
    return Promise.resolve();
  }

  #ingest(msg: RawLineMessage, surface: 'talk' | 'square'): void {
    if (this.#stopped) return;
    if (this.#draining) {
      this.#drained += 1;
      return;
    }
    const event = normalizeMessage(msg, {
      botId: this.#opts.botId,
      ownerId: this.#opts.ownerId,
      surface,
      // `listen()` does not tell us which transport won; Phase 5 adds the race.
      source: 'push',
      observedAtMono: this.#opts.clock.monotonic(),
      observedAtWallMs: this.#opts.clock.now(),
    });
    if (this.#synchronousSink !== undefined) {
      // Keep LINEJS emitter delivery in the same stack through dispatch. Push
      // is a fallback race source, but it should not pay for a queue when it
      // happens to beat the dedicated poll.
      this.#synchronousSink(event);
    } else if (!this.#queue.push(event)) {
      this.#opts.logger.warn('inbound queue full; event dropped', {
        messageId: event.messageId,
      });
    }
  }
}
