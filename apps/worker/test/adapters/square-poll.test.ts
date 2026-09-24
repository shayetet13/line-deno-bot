import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeBotId, unsafeOwnerId } from '@line-first/contracts';
import { FakeClock, systemClock } from '../../src/lib/clock.ts';
import { type LogFields, Logger } from '../../src/logging/logger.ts';
import type { RawLineMessage } from '../../src/adapters/linejs/normalize.ts';
import { type SquareEventPage, SquarePollAdapter } from '../../src/adapters/linejs/square-poll.ts';
import type { InboundEvent } from '../../src/adapters/types.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

const msg = (id: string): RawLineMessage => ({
  to: { id: 'room-1' },
  from: { id: 'sender-1' },
  text: 'go',
  raw: { message: { id, createdTime: 1_700_000_000_000 } },
});

/** A scripted fetcher: each call shifts the next page off `pages`, and records
 * the syncToken it was called with so cursor discipline can be checked. */
class ScriptedFetcher {
  readonly calledWith: (string | undefined)[] = [];
  #pages: SquareEventPage[];
  #concurrent = 0;
  maxConcurrent = 0;
  constructor(pages: SquareEventPage[]) {
    this.#pages = pages;
  }
  readonly fn = async (
    syncToken: string | undefined,
    _signal: AbortSignal,
  ): Promise<SquareEventPage> => {
    this.calledWith.push(syncToken);
    this.#concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#concurrent);
    await Promise.resolve();
    this.#concurrent -= 1;
    return this.#pages.shift() ?? { messages: [], syncToken };
  };
}

const makeAdapter = (fetcher: ScriptedFetcher): SquarePollAdapter =>
  new SquarePollAdapter({
    fetcher: fetcher.fn,
    botId: unsafeBotId('bot-1'),
    ownerId: unsafeOwnerId('owner-1'),
    clock: new FakeClock(),
    logger: silent(),
    intervalMs: 0,
    fetchTimeoutMs: 1_000,
  });

const take = async (adapter: SquarePollAdapter, n: number): Promise<InboundEvent[]> => {
  const out: InboundEvent[] = [];
  for await (const event of adapter.events()) {
    out.push(event);
    if (out.length >= n) break;
  }
  return out;
};

describe('SquarePollAdapter', () => {
  test('drains backlog until an empty page, then goes live', async () => {
    const fetcher = new ScriptedFetcher([
      { messages: [msg('old-1'), msg('old-2')], syncToken: 'tok-1' },
      { messages: [msg('old-3')], syncToken: 'tok-2' },
      { messages: [], syncToken: 'tok-3' }, // end of backlog
      { messages: [msg('new-1')], syncToken: 'tok-4' },
    ]);
    const adapter = makeAdapter(fetcher);
    adapter.start(new AbortController().signal);

    const events = await take(adapter, 1);
    expect(events[0]?.messageId).toBe('new-1');
    expect(events[0]?.source).toBe('dedicated-poll');
    expect(adapter.drainedBacklog).toBe(3);
    expect(fetcher.calledWith[0]).toBeUndefined();
    expect(fetcher.calledWith[1]).toBe('tok-1'); // cursor advanced over history
    expect(fetcher.calledWith[2]).toBe('tok-2');
    await adapter.stop();
  });

  test('never runs two fetches at once (single cursor)', async () => {
    const fetcher = new ScriptedFetcher([
      { messages: [], syncToken: 'a' },
      { messages: [msg('x')], syncToken: 'b' },
      { messages: [msg('y')], syncToken: 'c' },
    ]);
    const adapter = makeAdapter(fetcher);
    adapter.start(new AbortController().signal);
    await take(adapter, 2);
    expect(fetcher.maxConcurrent).toBe(1);
    await adapter.stop();
  });

  test('delivers live events through the synchronous sink without queueing them', async () => {
    const fetcher = new ScriptedFetcher([
      { messages: [], syncToken: 'drained' },
      { messages: [msg('direct-1')], syncToken: 'live' },
    ]);
    const adapter = makeAdapter(fetcher);
    const delivered: InboundEvent[] = [];
    adapter.setSynchronousSink((event) => delivered.push(event));
    adapter.start(new AbortController().signal);

    while (delivered.length === 0) await Promise.resolve();
    expect(delivered[0]?.messageId).toBe('direct-1');

    await adapter.stop();
    const queued: InboundEvent[] = [];
    for await (const event of adapter.events()) queued.push(event);
    expect(queued).toEqual([]);
  });

  test('consults the reply quiet gate before the next zero-delay poll', async () => {
    const fetcher = new ScriptedFetcher([
      { messages: [], syncToken: 'drained' },
      { messages: [msg('reply-trigger')], syncToken: 'live' },
    ]);
    const controller = new AbortController();
    let quietChecks = 0;
    const adapter = new SquarePollAdapter({
      fetcher: fetcher.fn,
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: new FakeClock(),
      logger: silent(),
      intervalMs: 0,
      quietBeforeNextFetchMs: () => {
        quietChecks += 1;
        controller.abort();
        return 30;
      },
    });
    adapter.setSynchronousSink(() => {});
    await adapter.start(controller.signal);

    while (quietChecks === 0) await Promise.resolve();
    expect(fetcher.calledWith).toEqual([undefined, 'drained']);
    await adapter.stop();
  });

  test('a timed-out fetch settles before the same cursor can be requested again', async () => {
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const fetcher = async (syncToken: string | undefined): Promise<SquareEventPage> => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls === 1) {
        concurrent -= 1;
        return { messages: [], syncToken: 'drained' };
      }
      if (calls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        throw new Error('underlying request finally settled');
      }
      concurrent -= 1;
      return { messages: [msg('after-timeout')], syncToken };
    };
    const adapter = new SquarePollAdapter({
      fetcher,
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: new FakeClock(),
      logger: silent(),
      intervalMs: 0,
      fetchTimeoutMs: 2,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    await adapter.start(new AbortController().signal);

    const events = await take(adapter, 1);
    expect(events[0]?.messageId).toBe('after-timeout');
    expect(maxConcurrent).toBe(1);
    await adapter.stop();
  });

  test('keeps polling with the last good token after an error', async () => {
    const fetcher = new ScriptedFetcher([]);
    const script: SquareEventPage[] = [
      { messages: [], syncToken: 'tok-1' },
    ];
    let round = 0;
    const flaky = new SquarePollAdapter({
      fetcher: (syncToken) => {
        round += 1;
        if (round === 2) return Promise.reject(new Error('truncated LEGY response'));
        if (round === 3) return Promise.resolve({ messages: [msg('after-error')], syncToken });
        return Promise.resolve(script.shift() ?? { messages: [], syncToken });
      },
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: new FakeClock(),
      logger: silent(),
      intervalMs: 0,
      minBackoffMs: 1,
      maxBackoffMs: 4,
    });
    flaky.start(new AbortController().signal);
    const events = await take(flaky, 1);
    expect(events[0]?.messageId).toBe('after-error');
    await flaky.stop();
    void fetcher;
  });

  test('stop ends the stream', async () => {
    const adapter = makeAdapter(new ScriptedFetcher([{ messages: [], syncToken: 't' }]));
    adapter.start(new AbortController().signal);
    await adapter.stop();
    const rest: InboundEvent[] = [];
    for await (const e of adapter.events()) rest.push(e);
    expect(rest).toEqual([]);
  });
});

/** Fetcher for `pollRaceWidth` tests: each call takes the next step off a
 * shared script (by call order, which is deterministic — `#round` launches
 * racers synchronously, in index order) and resolves or rejects after that
 * step's delay. Real timers, matching the existing timed-out-fetch test. */
class RacedFetcher {
  readonly calledWith: (string | undefined)[] = [];
  readonly startedAtMs: number[] = [];
  #script: { delayMs: number; result: SquareEventPage | Error }[];
  #concurrent = 0;
  maxConcurrent = 0;
  constructor(script: { delayMs: number; result: SquareEventPage | Error }[]) {
    this.#script = script;
  }
  readonly fn = async (
    syncToken: string | undefined,
    _signal: AbortSignal,
  ): Promise<SquareEventPage> => {
    this.calledWith.push(syncToken);
    this.startedAtMs.push(Date.now());
    this.#concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#concurrent);
    const step = this.#script.shift();
    try {
      // A real fetch always costs at least one real tick — unlike a genuine
      // network call, an unscripted resolve here would otherwise settle with
      // zero delay, and with `intervalMs: 0` that turns "poll again
      // immediately" into a tight microtask-only loop with no macrotask
      // boundary ever, starving the timer queue (and this test) forever.
      if (step === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { messages: [], syncToken };
      }
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.result instanceof Error) throw step.result;
      return step.result;
    } finally {
      this.#concurrent -= 1;
    }
  };
}

describe('SquarePollAdapter — pollRaceWidth', () => {
  test('races N fetches against the same cursor and keeps the fastest', async () => {
    const fetcher = new RacedFetcher([
      // Round 1 (backlog drain): both racers settle empty immediately.
      { delayMs: 0, result: { messages: [], syncToken: 'drained' } },
      { delayMs: 0, result: { messages: [], syncToken: 'drained' } },
      // Round 2: racer 0 wins; racer 1 is slower and must be discarded.
      { delayMs: 5, result: { messages: [msg('fast-win')], syncToken: 'r2-fast' } },
      { delayMs: 50, result: { messages: [msg('slow-lose')], syncToken: 'r2-slow' } },
    ]);
    const adapter = new SquarePollAdapter({
      fetcher: fetcher.fn,
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: new FakeClock(),
      logger: silent(),
      intervalMs: 0,
      pollRaceWidth: 2,
    });
    try {
      adapter.start(new AbortController().signal);

      const events = await take(adapter, 1);
      expect(events[0]?.messageId).toBe('fast-win');
      expect(fetcher.maxConcurrent).toBe(2);
      // Both round-2 racers were asked the same question.
      expect(fetcher.calledWith.slice(2, 4)).toEqual(['drained', 'drained']);

      // The event above was queued as soon as round 2's winner was emitted —
      // before that round's cleanup (draining the slow loser) returns and
      // round 3 gets to start. Wait for round 3's own calls to land before
      // inspecting them.
      const deadline = Date.now() + 500;
      while (fetcher.calledWith.length < 6) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting; calledWith=${JSON.stringify(fetcher.calledWith)}`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }

      // Round 3 must not have started until round 2's slow loser had
      // actually settled (~50ms), and must carry the winner's token
      // forward, not the discarded loser's.
      const round2SlowStartedAt = fetcher.startedAtMs[3] ?? 0;
      const round3StartedAt = fetcher.startedAtMs[4] ?? 0;
      expect(round3StartedAt - round2SlowStartedAt).toBeGreaterThanOrEqual(45);
      expect(fetcher.calledWith[4]).toBe('r2-fast');
      expect(fetcher.calledWith[5]).toBe('r2-fast');
    } finally {
      await adapter.stop();
    }
  });

  test('backs off when every racer in a round fails', async () => {
    const warnings: LogFields[] = [];
    const logger = new Logger({
      level: 'warn',
      sink: (entry) => warnings.push(entry),
    });
    const fetcher = new RacedFetcher([
      { delayMs: 0, result: { messages: [], syncToken: 'drained' } },
      { delayMs: 0, result: { messages: [], syncToken: 'drained' } },
      { delayMs: 1, result: new Error('primary failed') },
      { delayMs: 5, result: new Error('secondary failed') },
    ]);
    const adapter = new SquarePollAdapter({
      fetcher: fetcher.fn,
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: new FakeClock(),
      logger,
      intervalMs: 0,
      minBackoffMs: 1,
      maxBackoffMs: 4,
      pollRaceWidth: 2,
    });
    adapter.setSynchronousSink(() => {});
    try {
      adapter.start(new AbortController().signal);

      while (warnings.length === 0) await new Promise((r) => setTimeout(r, 1));
      expect(warnings[0]?.['reason']).toBe('primary failed');
      // Both racers must have settled before backoff retried — never more
      // than `pollRaceWidth` requests in flight across the retry boundary.
      expect(fetcher.maxConcurrent).toBe(2);
    } finally {
      await adapter.stop();
    }
  });
});

/** Fetcher for `pollStagger` tests: call `i` resolves after `script(i).delayMs`
 * with `script(i).page`. Real timers and a real clock, because stagger
 * spacing is derived from measured fetch durations. */
class StaggerFetcher {
  readonly calledWith: (string | undefined)[] = [];
  readonly startedAtMs: number[] = [];
  #concurrent = 0;
  maxConcurrent = 0;
  constructor(
    private readonly script: (
      call: number,
      syncToken: string | undefined,
    ) => { delayMs: number; page: SquareEventPage },
  ) {}
  readonly fn = async (
    syncToken: string | undefined,
    _signal: AbortSignal,
  ): Promise<SquareEventPage> => {
    const call = this.calledWith.length;
    this.calledWith.push(syncToken);
    this.startedAtMs.push(performance.now());
    this.#concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#concurrent);
    const { delayMs, page } = this.script(call, syncToken);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return page;
    } finally {
      this.#concurrent -= 1;
    }
  };
}

const staggered = (fetcher: StaggerFetcher, pollStagger: number): SquarePollAdapter =>
  new SquarePollAdapter({
    fetcher: fetcher.fn,
    botId: unsafeBotId('bot-1'),
    ownerId: unsafeOwnerId('owner-1'),
    clock: systemClock,
    logger: silent(),
    intervalMs: 0,
    fetchTimeoutMs: 1_000,
    pollStagger,
  });

const waitFor = async (done: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('SquarePollAdapter — pollStagger', () => {
  test('keeps N fetches in flight, launched apart rather than together', async () => {
    const fetcher = new StaggerFetcher((_call, token) => ({
      delayMs: 20,
      page: { messages: [], syncToken: token ?? 'drained' },
    }));
    const adapter = staggered(fetcher, 2);
    try {
      adapter.start(new AbortController().signal);
      await waitFor(() => fetcher.calledWith.length >= 8, 'live fetches');
      expect(fetcher.maxConcurrent).toBe(2);
      // Call 0 drains alone; live calls start ~RTT/2 (~10ms) apart. A
      // simultaneous launch (the pollRaceWidth shape) would show ~0ms gaps.
      const gaps = fetcher.startedAtMs.slice(2, 8).map((t, i) =>
        t - (fetcher.startedAtMs[i + 1] ?? t)
      );
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(4);
    } finally {
      await adapter.stop();
    }
  });

  test('emits a message seen by two overlapping fetches exactly once', async () => {
    const fetcher = new StaggerFetcher((call) => ({
      delayMs: call === 0 ? 1 : 15,
      page: call === 0
        ? { messages: [], syncToken: 'drained' }
        : { messages: [msg('dup-1')], syncToken: 'drained' },
    }));
    const adapter = staggered(fetcher, 2);
    const seen: string[] = [];
    adapter.setSynchronousSink((event) => seen.push(event.messageId));
    try {
      adapter.start(new AbortController().signal);
      await waitFor(() => fetcher.calledWith.length >= 6, 'overlapping fetches');
      expect(seen).toEqual(['dup-1']);
    } finally {
      await adapter.stop();
    }
  });

  test('keeps the cursor of the latest-started fetch, even when it returns first', async () => {
    const fetcher = new StaggerFetcher((call, token) => {
      if (call === 0) return { delayMs: 10, page: { messages: [], syncToken: 'drained' } };
      // Call 1 starts first but answers last, describing an older moment.
      if (call === 1) return { delayMs: 60, page: { messages: [], syncToken: 'older' } };
      if (call === 2) return { delayMs: 5, page: { messages: [], syncToken: 'newer' } };
      return { delayMs: 10, page: { messages: [], syncToken: token } };
    });
    const adapter = staggered(fetcher, 2);
    try {
      adapter.start(new AbortController().signal);
      // Wait until well after call 1 (the slow, older one) has returned.
      await waitFor(
        () => performance.now() - (fetcher.startedAtMs[1] ?? performance.now()) > 90,
        'the stale response',
      );
      const later = fetcher.calledWith.slice(3);
      expect(later.length).toBeGreaterThan(0);
      expect(later).not.toContain('older');
      expect(later.every((token) => token === 'newer')).toBe(true);
    } finally {
      await adapter.stop();
    }
  });

  test('refuses to combine with pollRaceWidth', () => {
    expect(() =>
      new SquarePollAdapter({
        fetcher: () => Promise.resolve({ messages: [], syncToken: undefined }),
        botId: unsafeBotId('bot-1'),
        ownerId: unsafeOwnerId('owner-1'),
        clock: systemClock,
        logger: silent(),
        pollStagger: 2,
        pollRaceWidth: 2,
      })
    ).toThrow('pollStagger');
  });
});

describe('SquarePollAdapter — poll hit diagnostics', () => {
  test('splits inbound into wait, fetch and fetches LINE answered without it', async () => {
    const logs: LogFields[] = [];
    const created = Date.now() + 30;
    const withCreated = (id: string): RawLineMessage => ({
      ...msg(id),
      raw: { message: { id, createdTime: created } },
    });
    const fetcher = new StaggerFetcher((call, token) => ({
      delayMs: 10,
      // Every fetch sent after `created` stays empty until call 8.
      page: call >= 8
        ? { messages: [withCreated('late-1')], syncToken: 'drained' }
        : { messages: [], syncToken: token ?? 'drained' },
    }));
    const adapter = new SquarePollAdapter({
      fetcher: fetcher.fn,
      botId: unsafeBotId('bot-1'),
      ownerId: unsafeOwnerId('owner-1'),
      clock: systemClock,
      logger: new Logger({ level: 'info', sink: (entry) => logs.push(entry) }),
      intervalMs: 0,
      fetchTimeoutMs: 1_000,
      pollStagger: 2,
    });
    try {
      adapter.start(new AbortController().signal);
      await waitFor(() => logs.some((l) => l['msg'] === 'poll hit'), 'poll hit log');
      const hit = logs.find((l) => l['msg'] === 'poll hit');
      expect(hit?.['messageId']).toBe('late-1');
      expect(hit?.['stagger']).toBe(2);
      expect(hit?.['fetchMs'] as number).toBeGreaterThanOrEqual(5);
      expect(hit?.['inboundMs'] as number).toBeGreaterThanOrEqual(hit?.['fetchMs'] as number);
      expect(hit?.['missed'] as number).toBeGreaterThan(0);
    } finally {
      await adapter.stop();
    }
  });
});
