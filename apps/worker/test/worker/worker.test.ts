import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  unsafeMessageId,
  unsafeOwnerId,
  unsafeRoomId,
  unsafeSenderId,
} from '@line-first/contracts';
import { MockInboundAdapter, MockSender } from '../../src/adapters/mock.ts';
import { DryRunSender } from '../../src/adapters/dry-run.ts';
import type { InboundEvent, SynchronousInboundAdapter } from '../../src/adapters/types.ts';
import { type BotConfig, parseBotConfig } from '../../src/config/bot-config.ts';
import { compileRules } from '../../src/core/rules/compile.ts';
import { loadConfig } from '../../src/config/env.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { AsyncQueue } from '../../src/lib/async-queue.ts';
import { Logger, type LogRecord } from '../../src/logging/logger.ts';
import type { RecoveryAction } from '../../src/monitoring/recovery.ts';
import type { RecoveryExecutor } from '../../src/worker/recovery-executor.ts';
import { LanePool } from '../../src/transport/lane-pool.ts';
import { Worker } from '../../src/worker/worker.ts';
import { anEvent } from '../support/events.ts';

const botConfig = (over: Record<string, unknown> = {}): BotConfig =>
  parseBotConfig({
    botId: 'bot-1',
    ownerId: 'owner-1',
    rules: [
      { id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' },
      { id: 'slow', priority: 1, kind: 'exact', pattern: 'go', reply: 'second' },
    ],
    dryRun: false,
    ...over,
  });

interface Harness {
  worker: Worker;
  adapter: MockInboundAdapter;
  sender: MockSender;
  clock: FakeClock;
  logs: LogRecord[];
  run: Promise<void>;
  controller: AbortController;
}

const start = (over: Record<string, unknown> = {}): Harness => {
  const clock = new FakeClock(1_700_000_000_000);
  const adapter = new MockInboundAdapter();
  const sender = new MockSender();
  const logs: LogRecord[] = [];
  const logger = new Logger({ level: 'debug', sink: (r) => logs.push(r), clock });
  const controller = new AbortController();
  const worker = new Worker({
    bot: botConfig(over),
    env: loadConfig({}),
    adapter,
    sender,
    clock,
    logger,
    // No timer: the tests call monitorTick() directly so nothing is left running.
    timer: { set: () => 0, clear: () => {} },
  });
  return { worker, adapter, sender, clock, logs, controller, run: worker.run(controller.signal) };
};

const finish = async (h: Harness): Promise<void> => {
  h.adapter.end();
  await h.run;
};

class DirectInbound implements SynchronousInboundAdapter {
  readonly #queue = new AsyncQueue<InboundEvent>();
  #sink: ((event: InboundEvent) => void) | undefined;
  start(): Promise<void> {
    return Promise.resolve();
  }
  events(): AsyncIterable<InboundEvent> {
    return this.#queue;
  }
  setSynchronousSink(sink: ((event: InboundEvent) => void) | undefined): void {
    this.#sink = sink;
  }
  deliver(event: InboundEvent): void {
    if (this.#sink !== undefined) this.#sink(event);
    else this.#queue.push(event);
  }
  stop(): Promise<void> {
    this.end();
    return Promise.resolve();
  }
  end(): void {
    this.#queue.close();
  }
}

describe('Worker', () => {
  test('answers a matching event and counts it', async () => {
    const h = start();
    h.adapter.push(anEvent({ text: 'go' }));
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0]?.text).toBe('first!');
    expect(h.worker.stats).toMatchObject({ received: 1, dispatched: 1, failed: 0 });
  });

  test('is ARMED only once the adapter has started and drained', async () => {
    const h = start();
    // Not armed synchronously — run() has not reached adapter.start() yet.
    expect(h.worker.readiness.isArmed).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.worker.readiness.isArmed).toBe(true);
    await finish(h);
    // Once the stream ends the receiver is no longer subscribed, so it must
    // stop claiming it can answer.
    expect(h.worker.readiness.isArmed).toBe(false);
  });

  test('does not report ARMED while the H2 PUSH response is absent, then arms once it opens', async () => {
    const clock = new FakeClock();
    const adapter = new MockInboundAdapter();
    let pushReady = false;
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter,
      sender: new MockSender(),
      clock,
      logger: new Logger({ level: 'error', sink: () => {} }),
      pushHealth: {
        get pushHealth() {
          return pushReady ? { ready: true } : { ready: false, reason: 'no PUSH response' };
        },
      },
      timer: { set: () => 0, clear: () => {} },
    });
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.readiness.isArmed).toBe(false);
    expect(worker.readiness.snapshot().checks.receiverSubscribed).toBe(false);

    pushReady = true;
    worker.monitorTick();
    expect(worker.readiness.isArmed).toBe(true);

    adapter.end();
    await run;
  });

  test('uses the bot and owner identity already bound by the adapter', async () => {
    const h = start({ ownerId: 'owner-9' });
    h.adapter.push(anEvent({ text: 'go', ownerId: unsafeOwnerId('owner-9') }));
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
  });

  test('a second event is not queued behind the first one’s network call', async () => {
    const clock = new FakeClock();
    const adapter = new MockInboundAdapter();
    const logs: LogRecord[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter,
      sender: {
        send: async () => {
          started += 1;
          await gate;
          return { ok: true, sentMessageId: unsafeMessageId('x'), ackAtMono: 0 };
        },
      },
      clock,
      logger: new Logger({ level: 'error', sink: (r) => logs.push(r) }),
      timer: { set: () => 0, clear: () => {} },
    });
    const run = worker.run(new AbortController().signal);

    adapter.push(anEvent({ messageId: unsafeMessageId('m-1') }));
    adapter.push(anEvent({ messageId: unsafeMessageId('m-2') }));
    await new Promise((r) => setTimeout(r, 0));
    // Both sends are in flight; the second did not wait for the first.
    expect(started).toBe(2);
    expect(worker.stats.inFlight).toBe(2);

    release();
    adapter.end();
    await run;
    expect(worker.stats.dispatched).toBe(2);
  });

  test('a direct inbound event starts Sender.send before deliver returns', async () => {
    const adapter = new DirectInbound();
    const sender = new MockSender();
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter,
      sender,
      clock: new FakeClock(),
      logger: new Logger({ level: 'error', sink: () => {} }),
      timer: { set: () => 0, clear: () => {} },
    });
    const run = worker.run(new AbortController().signal);
    await Promise.resolve();

    adapter.deliver(anEvent());
    expect(sender.sent).toHaveLength(1);

    adapter.end();
    await run;
  });

  test('a send failure is counted, and the loop keeps receiving', async () => {
    const h = start();
    h.sender.failNextSend();
    h.adapter.push(anEvent({ messageId: unsafeMessageId('m-1') }));
    await new Promise((r) => setTimeout(r, 0));
    h.adapter.push(anEvent({ messageId: unsafeMessageId('m-2') }));
    await finish(h);
    expect(h.worker.stats).toMatchObject({ received: 2, dispatched: 1, failed: 1 });
  });

  test('a suppressed event is counted separately from a failure', async () => {
    const h = start();
    h.adapter.push(anEvent({ text: 'unrelated' }));
    await finish(h);
    expect(h.worker.stats).toMatchObject({ suppressed: 1, dispatched: 0, failed: 0 });
    expect(h.sender.sent).toHaveLength(0);
  });

  test('the allowlist from the config is enforced', async () => {
    const h = start({ allowedSenders: ['admin-1'] });
    h.adapter.push(
      anEvent({ senderId: unsafeSenderId('stranger'), messageId: unsafeMessageId('m-1') }),
    );
    h.adapter.push(
      anEvent({ senderId: unsafeSenderId('admin-1'), messageId: unsafeMessageId('m-2') }),
    );
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
  });

  test('a saved room selection suppresses every unselected room before rule matching', async () => {
    const allowed = unsafeRoomId('c-selected');
    const h = start({ selectedRooms: [allowed] });
    h.adapter.push(anEvent({ roomId: unsafeRoomId('c-other'), messageId: unsafeMessageId('m-1') }));
    h.adapter.push(anEvent({ roomId: allowed, messageId: unsafeMessageId('m-2') }));
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
    expect(h.worker.stats).toMatchObject({ received: 2, suppressed: 1, dispatched: 1 });
    expect(h.worker.metrics.snapshot().counters['outcome.room-not-selected']).toBe(1);
  });

  test('setSelectedRooms swaps the live room filter with no restart and no gap', async () => {
    const selected = unsafeRoomId('c-selected');
    const other = unsafeRoomId('c-other');
    const h = start({ selectedRooms: [selected] });
    h.adapter.push(anEvent({ roomId: other, messageId: unsafeMessageId('m-1') }));
    await new Promise((r) => setTimeout(r, 0));
    // Swap live, mid-stream — mirrors what admin/server.ts's /api/groups does
    // instead of restarting when only the room selection changed.
    h.worker.setSelectedRooms([other]);
    h.adapter.push(anEvent({ roomId: other, messageId: unsafeMessageId('m-2') }));
    h.adapter.push(anEvent({ roomId: selected, messageId: unsafeMessageId('m-3') }));
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
    expect(h.worker.stats).toMatchObject({ received: 3, suppressed: 2, dispatched: 1 });
  });

  test('setSelectedRooms(undefined) reopens the worker to every room', async () => {
    const h = start({ selectedRooms: [unsafeRoomId('c-selected')] });
    h.worker.setSelectedRooms(undefined);
    h.adapter.push(
      anEvent({ roomId: unsafeRoomId('c-anything'), messageId: unsafeMessageId('m-1') }),
    );
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
  });

  test('rule priority from the config decides the reply', async () => {
    const h = start();
    h.adapter.push(anEvent({ text: 'go' }));
    await finish(h);
    expect(h.sender.sent[0]?.text).toBe('first!');
  });

  test('run resolves only after in-flight replies settle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = new MockInboundAdapter();
    let settled = false;
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter,
      sender: {
        send: async () => {
          await gate;
          settled = true;
          return { ok: true, sentMessageId: unsafeMessageId('x'), ackAtMono: 0 };
        },
      },
      clock: new FakeClock(),
      logger: new Logger({ level: 'error', sink: () => {} }),
      timer: { set: () => 0, clear: () => {} },
    });
    const run = worker.run(new AbortController().signal);
    adapter.push(anEvent());
    await new Promise((r) => setTimeout(r, 0));
    adapter.end();

    let finished = false;
    void run.then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(finished).toBe(false);

    release();
    await run;
    expect(settled).toBe(true);
  });

  test('monitorTick evaluates alerts without touching the reply path', async () => {
    const h = start();
    h.worker.readiness.degrade('connection lost');
    h.worker.monitorTick();
    h.clock.advance(31_000);
    h.worker.monitorTick();
    const alerts = h.logs.filter((r) => r.msg === 'alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(String(alerts[0]?.['detail'])).toContain('connection lost');
    await finish(h);
  });

  test('a recovery action is applied when the ladder moves', async () => {
    const h = start();
    const applied: string[] = [];
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter: h.adapter,
      sender: h.sender,
      clock: h.clock,
      logger: new Logger({ level: 'error', sink: () => {} }),
      recovery: {
        apply: (action: RecoveryAction): Promise<void> => {
          applied.push(action.rung);
          return Promise.resolve();
        },
      } as unknown as RecoveryExecutor,
      timer: { set: () => 0, clear: () => {} },
    });
    worker.readiness.degrade('gone');
    worker.monitorTick();
    h.clock.advance(31_000);
    worker.monitorTick();
    expect(applied).toEqual(['reconnect-session']);
    await finish(h);
  });

  test('the missed-events rule is off when only one receive path is configured', async () => {
    const h = start({ dedicatedRooms: [] });
    h.worker.monitorTick();
    await finish(h);
    // No race means no lopsided-source alert can ever be raised.
    expect(h.logs.filter((r) => r.msg === 'alert')).toHaveLength(0);
  });
});

describe('DryRunSender', () => {
  test('reports success without sending, and logs what it would have sent', async () => {
    const logs: LogRecord[] = [];
    const clock = new FakeClock();
    const adapter = new MockInboundAdapter();
    const dry = new DryRunSender(clock, new Logger({ level: 'info', sink: (r) => logs.push(r) }));
    const worker = new Worker({
      bot: botConfig({ dryRun: true }),
      env: loadConfig({}),
      adapter,
      sender: dry,
      clock,
      logger: new Logger({ level: 'error', sink: () => {} }),
      timer: { set: () => 0, clear: () => {} },
    });
    const run = worker.run(new AbortController().signal);
    adapter.push(
      anEvent({ text: 'go', roomId: unsafeRoomId('mbfdcf56614216f79bb1a94f0c7458846') }),
    );
    await new Promise((r) => setTimeout(r, 0));
    adapter.end();
    await run;

    expect(dry.count).toBe(1);
    expect(worker.stats.dispatched).toBe(1);
    const line = logs.find((r) => r.msg === 'DRY RUN — would send');
    expect(line).toBeDefined();
    // Room ids are masked and the body is withheld unless asked for.
    expect(String(line?.['roomId'])).toContain('…');
    expect(line?.['text']).toBeUndefined();
  });

  test('--show-text opts in to the body', async () => {
    const logs: LogRecord[] = [];
    const dry = new DryRunSender(
      new FakeClock(),
      new Logger({ level: 'info', sink: (r) => logs.push(r) }),
      true,
    );
    await dry.send(
      {
        surface: 'square',
        roomId: anEvent().roomId,
        text: 'hello',
      },
      new AbortController().signal,
    );
    expect(logs[0]?.['text']).toBe('hello');
  });
});

describe('Worker.setRules', () => {
  test('a hot-swapped rule set answers the very next event, no restart', async () => {
    const h = start();
    // "go" matches nothing until the swap.
    h.adapter.push(anEvent({ text: 'newword', messageId: unsafeMessageId('m-1') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sender.sent).toHaveLength(0);

    expect(h.worker.ruleCount).toBe(2);
    h.worker.setRules(
      compileRules([{ id: 'new', priority: 1, kind: 'exact', pattern: 'newword', reply: 'ok!' }]),
    );
    expect(h.worker.ruleCount).toBe(1);

    h.adapter.push(anEvent({ text: 'newword', messageId: unsafeMessageId('m-2') }));
    await finish(h);
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0]?.text).toBe('ok!');
  });

  test('logs the before/after rule count', async () => {
    const h = start();
    h.worker.setRules(
      compileRules([{ id: 'a', priority: 1, kind: 'exact', pattern: 'a', reply: 'b' }]),
    );
    await finish(h);
    const line = h.logs.find((r) => r.msg === 'rules reloaded');
    expect(line).toMatchObject({ before: 2, after: 1 });
  });
});

describe('Worker — lanePool wiring', () => {
  // Regression coverage: a lane pool built by the caller (serve.ts, when
  // bot.lanes > 0) used to be constructed and used for real sends, but never
  // reached `Worker`, so `/api/status`'s lanes table stayed empty ("ไม่ได้
  // เปิด owned lanes") even with lanes genuinely running.
  test('a lanePool passed to Worker reaches the status snapshot', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const logger = new Logger({ level: 'error', sink: () => {} });
    const lanePool = new LanePool({
      clock,
      logger,
      lanes: 2,
      makeTransport: () => ({ fetch: () => Promise.resolve(new Response()), close: () => {} }),
    });
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter: new MockInboundAdapter(),
      sender: new MockSender(),
      clock,
      logger,
      lanePool,
      timer: { set: () => 0, clear: () => {} },
    });

    expect(worker.status.snapshot().lanes).toHaveLength(2);
  });

  test('no lanePool means the status snapshot reports no lanes, not an error', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const logger = new Logger({ level: 'error', sink: () => {} });
    const worker = new Worker({
      bot: botConfig(),
      env: loadConfig({}),
      adapter: new MockInboundAdapter(),
      sender: new MockSender(),
      clock,
      logger,
      timer: { set: () => 0, clear: () => {} },
    });

    expect(worker.status.snapshot().lanes).toEqual([]);
  });
});
