import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { InboundSource } from '@line-first/contracts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { AsyncQueue } from '../../src/lib/async-queue.ts';
import { RacingInboundAdapter } from '../../src/adapters/racing.ts';
import type {
  InboundAdapter,
  InboundEvent,
  SynchronousInboundAdapter,
} from '../../src/adapters/types.ts';
import { anEvent } from '../support/events.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

/** A source fed by hand, tagging every event with `source`. */
class ManualSource implements InboundAdapter {
  readonly #q = new AsyncQueue<InboundEvent>();
  started = 0;
  stopped = 0;
  constructor(private readonly source: InboundSource) {}
  start(): Promise<void> {
    this.started += 1;
    return Promise.resolve();
  }
  events(): AsyncIterable<InboundEvent> {
    return this.#q;
  }
  stop(): Promise<void> {
    this.stopped += 1;
    this.#q.close();
    return Promise.resolve();
  }
  deliver(messageId: string): void {
    this.#q.push(
      anEvent({ messageId: messageId as InboundEvent['messageId'], source: this.source }),
    );
  }
  end(): void {
    this.#q.close();
  }
}

class DirectSource implements SynchronousInboundAdapter {
  readonly #q = new AsyncQueue<InboundEvent>();
  #sink: ((event: InboundEvent) => void) | undefined;
  constructor(private readonly source: InboundSource) {}
  start(): Promise<void> {
    return Promise.resolve();
  }
  events(): AsyncIterable<InboundEvent> {
    return this.#q;
  }
  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void {
    this.#sink = sink;
  }
  deliver(messageId: string): void {
    const event = anEvent({
      messageId: messageId as InboundEvent['messageId'],
      source: this.source,
    });
    if (this.#sink !== undefined) this.#sink(event);
    else this.#q.push(event);
  }
  stop(): Promise<void> {
    this.#q.close();
    return Promise.resolve();
  }
}

const collect = async (adapter: RacingInboundAdapter): Promise<InboundEvent[]> => {
  const seen: InboundEvent[] = [];
  for await (const event of adapter.events()) seen.push(event);
  return seen;
};

const makeRacer = (children: InboundAdapter[]): RacingInboundAdapter =>
  new RacingInboundAdapter(children, {
    clock: new FakeClock(),
    logger: silent(),
    dedupeTtlMs: 60_000,
    maxDedupeEntries: 100,
  });

describe('RacingInboundAdapter', () => {
  test('starts and stops every child', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);
    expect([push.started, poll.started]).toEqual([1, 1]);
    await racer.stop();
    expect([push.stopped, poll.stopped]).toEqual([1, 1]);
  });

  test('forwards each distinct message once, tagged with its source', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);

    push.deliver('m-1');
    push.deliver('m-2');
    poll.deliver('m-3');
    push.end();
    poll.end();

    const seen = await collect(racer);
    const bySource = new Map(seen.map((e) => [e.messageId, e.source]));
    expect(bySource).toEqual(
      new Map([['m-1', 'push'], ['m-2', 'push'], ['m-3', 'dedicated-poll']]),
    );
    expect(racer.stats).toMatchObject({
      wins: { push: 2, 'dedicated-poll': 1, 'normal-poll': 0 },
      seen: { push: 2, 'dedicated-poll': 1, 'normal-poll': 0 },
      duplicatesSuppressed: 0,
      delivered: 3,
    });
  });

  test('a message seen from a second source is suppressed and counted', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);

    push.deliver('dup');
    poll.deliver('dup');
    poll.deliver('dup');
    push.end();
    poll.end();

    const seen = await collect(racer);
    expect(seen.filter((e) => e.messageId === 'dup')).toHaveLength(1);
    expect(racer.stats.duplicatesSuppressed).toBe(2);
    expect(racer.stats.delivered).toBe(1);
  });

  // Regression coverage for the 2026-09-12 false alarm: with a dedicated poll
  // fast enough to win essentially every race, push's WIN share can sit at 0%
  // forever while push is completely healthy — it is still offering every
  // message, just consistently a moment too late. `seen` is what tells the
  // two apart; `wins` alone cannot.
  test('a source that always loses the race still shows up as seen', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);

    for (const id of ['m-1', 'm-2', 'm-3']) {
      poll.deliver(id); // always arrives first
      push.deliver(id); // always a moment too late
    }
    push.end();
    poll.end();
    await collect(racer);

    expect(racer.stats).toMatchObject({
      wins: { push: 0, 'dedicated-poll': 3, 'normal-poll': 0 },
      seen: { push: 3, 'dedicated-poll': 3, 'normal-poll': 0 },
    });
  });

  test('forwards a direct child in the same call stack and still dedupes the race', async () => {
    const first = new DirectSource('dedicated-poll');
    const second = new DirectSource('push');
    const racer = makeRacer([first, second]);
    const delivered: string[] = [];
    racer.setSynchronousSink((event) => delivered.push(event.messageId));
    await racer.start(new AbortController().signal);

    first.deliver('direct');
    expect(delivered).toEqual(['direct']);
    second.deliver('direct');
    expect(delivered).toEqual(['direct']);
    expect(racer.stats.duplicatesSuppressed).toBe(1);
    await racer.stop();
  });

  test('the stream ends only after every child has ended', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);
    const pending = collect(racer);
    push.deliver('a');
    push.end();
    poll.deliver('b');
    poll.end();
    const seen = await pending;
    expect(seen.map((e) => e.messageId).sort()).toEqual(['a', 'b']);
  });
});

// Room-switch-without-restart: a dedicated room poll is added or dropped on
// a racer that is already running, with no restart of the racer itself.
describe('RacingInboundAdapter — live add/remove', () => {
  test('addChild before start just joins the initial batch', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push]);
    await racer.addChild(poll);
    await racer.start(new AbortController().signal);
    expect([push.started, poll.started]).toEqual([1, 1]);
  });

  test('addChild mid-stream starts the new child and folds its events in', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push]);
    await racer.start(new AbortController().signal);
    const pending = collect(racer);

    await racer.addChild(poll);
    expect(poll.started).toBe(1);

    push.deliver('a');
    poll.deliver('b');
    push.end();
    poll.end();

    const seen = await pending;
    expect(seen.map((e) => e.messageId).sort()).toEqual(['a', 'b']);
  });

  test('removeChild stops and drops one source without ending the racer', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);
    const pending = collect(racer);

    await racer.removeChild(poll);
    expect(poll.stopped).toBe(1);

    // The racer must still be alive — push is the only child left, and it
    // has not ended yet.
    push.deliver('still-alive');
    push.end();

    const seen = await pending;
    expect(seen.map((e) => e.messageId)).toEqual(['still-alive']);
  });

  test('a message from a room removed mid-stream is not delivered', async () => {
    const push = new ManualSource('push');
    const poll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, poll]);
    await racer.start(new AbortController().signal);
    const pending = collect(racer);

    await racer.removeChild(poll);
    poll.deliver('too-late'); // the removed source's own queue is closed by now
    push.deliver('kept');
    push.end();

    const seen = await pending;
    expect(seen.map((e) => e.messageId)).toEqual(['kept']);
  });

  test('stop() still stops every remaining child after a live add/remove', async () => {
    const push = new ManualSource('push');
    const oldPoll = new ManualSource('dedicated-poll');
    const newPoll = new ManualSource('dedicated-poll');
    const racer = makeRacer([push, oldPoll]);
    await racer.start(new AbortController().signal);

    await racer.removeChild(oldPoll);
    await racer.addChild(newPoll);
    await racer.stop();

    expect(push.stopped).toBe(1);
    expect(oldPoll.stopped).toBe(1); // already stopped by removeChild, not double-stopped again
    expect(newPoll.stopped).toBe(1);
  });
});
