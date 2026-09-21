import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeBotId, unsafeMessageId } from '@line-first/contracts';
import { MockSender } from '../../src/adapters/mock.ts';
import { loadConfig } from '../../src/config/env.ts';
import { createCore } from '../../src/core/core.ts';
import { compileRules } from '../../src/core/rules/compile.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger, type LogRecord } from '../../src/logging/logger.ts';
import { MetricsRecorder } from '../../src/metrics/recorder.ts';
import { type PipelineDeps, processInbound } from '../../src/pipeline/process-inbound.ts';
import { anEvent } from '../support/events.ts';

const RULES = compileRules([
  { id: 'start', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' },
]);

const makeDeps = (env: Record<string, string> = {}): PipelineDeps & { sender: MockSender } => {
  const clock = new FakeClock();
  return {
    core: createCore(loadConfig(env), clock),
    rules: RULES,
    sender: new MockSender(),
    clock,
    logger: new Logger({ level: 'error', sink: () => {} }),
    opTimeoutMs: 1_000,
  };
};

const run = (deps: PipelineDeps, over = {}) =>
  processInbound(anEvent(over), deps, new AbortController().signal);

describe('processInbound', () => {
  test('dispatches the matching reply and records the job', async () => {
    const deps = makeDeps();
    const res = await run(deps);
    expect(res.outcome).toBe('dispatched');
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]?.text).toBe('first!');
    expect(deps.sender.sent[0]).toEqual({
      surface: 'square',
      roomId: anEvent().roomId,
      text: 'first!',
    });
    expect(deps.core.jobs.size).toBe(1);
  });

  test('logs a per-reply timing line — codeMs + sendMs = totalMs (the "Σ actual" total)', async () => {
    const records: LogRecord[] = [];
    const deps = {
      ...makeDeps(),
      logger: new Logger({ level: 'debug', sink: (r) => records.push(r) }),
    };
    const res = await run(deps);
    expect(res.outcome).toBe('dispatched');

    const timing = records.find((r) => r.msg === 'reply timing');
    // event.surface defaults to 'square' — LINE's own protocol name for what
    // the admin pages call "openchat"; the log uses that vocabulary too.
    expect(timing).toMatchObject({
      ruleId: 'start',
      roomId: anEvent().roomId,
      roomKind: 'openchat',
    });
    expect(timing?.['totalMs']).toBe(
      (timing?.['codeMs'] as number) + (timing?.['sendMs'] as number),
    );
  });

  test('reply timing keeps "talk" and "oa" as-is (only "square" is renamed)', async () => {
    const records: LogRecord[] = [];
    const deps = {
      ...makeDeps(),
      logger: new Logger({ level: 'debug', sink: (r) => records.push(r) }),
    };
    await run(deps, { surface: 'talk', messageId: unsafeMessageId('m-talk') });
    await run(deps, { surface: 'oa', messageId: unsafeMessageId('m-oa') });

    const kinds = records.filter((r) => r.msg === 'reply timing').map((r) => r['roomKind']);
    expect(kinds).toEqual(['talk', 'oa']);
  });

  test('a duplicate delivery (push then poll) is dropped at the first gate', async () => {
    const deps = makeDeps();
    expect((await run(deps)).outcome).toBe('dispatched');
    const second = await run(deps, { source: 'dedicated-poll' });
    expect(second.outcome).toBe('deduped-incoming');
    expect(deps.sender.sent).toHaveLength(1);
  });

  test('non-matching text never reaches the sender', async () => {
    const deps = makeDeps();
    const res = await run(deps, { text: 'unrelated chatter' });
    expect(res.outcome).toBe('no-rule');
    expect(deps.sender.sent).toHaveLength(0);
    expect(deps.core.jobs.size).toBe(0);
  });

  test('the same keyword in a later round is a new job and is answered again', async () => {
    const deps = makeDeps();
    await run(deps);
    const res = await run(deps, { messageId: unsafeMessageId('m-2') });
    expect(res.outcome).toBe('dispatched');
    expect(deps.sender.sent).toHaveLength(2);
    expect(deps.core.jobs.size).toBe(2);
  });

  test('a sibling bot of the same owner does not double-answer the room', async () => {
    const deps = makeDeps();
    await run(deps);
    const sibling = await run(deps, { botId: unsafeBotId('bot-2') });
    expect(sibling.outcome).toBe('deduped-room');
    expect(deps.sender.sent).toHaveLength(1);
  });

  test('rate limit drops instead of queueing', async () => {
    const deps = makeDeps({ RATE_LIMIT_CAPACITY: '1', RATE_LIMIT_REFILL_PER_SEC: '1' });
    expect((await run(deps)).outcome).toBe('dispatched');
    const res = await run(deps, { messageId: unsafeMessageId('m-2') });
    expect(res.outcome).toBe('rate-limited');
    expect(deps.sender.sent).toHaveLength(1);
  });

  test('a failed send is reported, not thrown, and keeps the job dispatched', async () => {
    const deps = makeDeps();
    deps.sender.failNextSend();
    const res = await run(deps);
    expect(res.outcome).toBe('send-failed');
    expect(res.sendResult?.ok).toBe(false);
    const key = res.jobKey;
    expect(key).toBeDefined();
    if (key) expect(deps.core.jobs.get(key)?.state).toBe('first-response-dispatched');
  });

  test('records send RTT and the outcome when metrics are attached', async () => {
    const metrics = new MetricsRecorder();
    const deps = { ...makeDeps(), metrics };
    const res = await run(deps);
    expect(res.outcome).toBe('dispatched');

    const snap = metrics.snapshot();
    expect(snap.counters['outcome.dispatched']).toBe(1);
    expect(snap.counters['surface.square']).toBe(1);
    expect(snap.counters['source.push']).toBe(1);
    expect(snap.counters['line_calls']).toBe(1);
    // FakeClock does not advance during a mock send, so the span is 0 — the
    // point is that it was captured at all, on the monotonic clock.
    expect(snap.spans.send?.count).toBe(1);
    expect(snap.spans.code?.count).toBe(1);
    expect(snap.spans.local_total?.count).toBe(1);
    expect(snap.spans.match).toBeUndefined();
    expect(snap.spans.limiter).toBeUndefined();
    expect(res.trace.toRecord()).toEqual({ marks: {}, spans: {}, sourceEventTimeMs: undefined });

    // anEvent() defaults serviceEventTimeMs=...000, observedAtWallMs=...015,
    // and MockSender always replies with sentServiceEventTimeMs=...050 — both
    // cross-host readings on LINE's own clock, computed with no host skew.
    expect(snap.crossHost?.inbound?.p50).toBe(15);
    expect(snap.crossHost?.line_round_trip?.p50).toBe(50);
  });

  // Fine-grained encoder timing is deliberately absent from production: its
  // wrapper ran before every send. Post-ACK code/send totals are sufficient.
  test('the pipeline records no protocol_prep of its own', async () => {
    const metrics = new MetricsRecorder();
    const deps = { ...makeDeps(), metrics };
    await run(deps);
    expect(metrics.snapshot().spans.protocol_prep).toBeUndefined();
  });

  test('a gated event still records its outcome but never a send span', async () => {
    const metrics = new MetricsRecorder();
    const deps = { ...makeDeps(), metrics };
    await run(deps, { text: 'unrelated chatter' });
    const snap = metrics.snapshot();
    expect(snap.counters['outcome.no-rule']).toBe(1);
    expect(snap.counters['line_calls']).toBeUndefined();
    expect(snap.spans.send).toBeUndefined();
    expect(snap.spans.match).toBeUndefined();
    // Inbound only needs the event's own timestamps, so it is still filed
    // even when no rule matched and nothing was ever sent.
    expect(snap.crossHost?.inbound?.p50).toBe(15);
    expect(snap.crossHost?.line_round_trip).toBeUndefined();
  });

  test('rate-limited work does not create synthetic detailed spans', async () => {
    const metrics = new MetricsRecorder();
    const deps = {
      ...makeDeps({ RATE_LIMIT_CAPACITY: '1', RATE_LIMIT_REFILL_PER_SEC: '1' }),
      metrics,
    };
    await run(deps);
    const res = await run(deps, { messageId: unsafeMessageId('m-2') });
    expect(res.outcome).toBe('rate-limited');
    const snap = metrics.snapshot();
    expect(snap.spans.limiter).toBeUndefined();
    expect(snap.spans.match).toBeUndefined();
    expect(snap.spans.send?.count).toBe(1);
  });

  test('a failed send still records the round trip as undefined, not a bad number', async () => {
    const metrics = new MetricsRecorder();
    const deps = { ...makeDeps(), metrics };
    deps.sender.failNextSend();
    const res = await run(deps);
    expect(res.outcome).toBe('send-failed');
    const snap = metrics.snapshot();
    expect(snap.counters['line_calls']).toBe(1);
    expect(snap.crossHost?.inbound?.p50).toBe(15);
    expect(snap.crossHost?.line_round_trip).toBeUndefined();
  });

  test('without metrics the pipeline carries a null trace and records nothing', async () => {
    const res = await run(makeDeps());
    expect(res.trace.toRecord()).toEqual({ marks: {}, spans: {}, sourceEventTimeMs: undefined });
  });

  test('a settled job is not re-dispatched when its event is redelivered', async () => {
    const deps = makeDeps();
    const first = await run(deps);
    const key = first.jobKey;
    expect(key).toBeDefined();
    if (!key) return;
    deps.core.jobs.settle(key, 'lost');
    // Same message arriving on the other surface clears the incoming gate but
    // resolves to the same job key, which is now terminal.
    const replay = await run(deps, { surface: 'talk' });
    expect(replay.outcome).toBe('job-terminal');
    expect(deps.sender.sent).toHaveLength(1);
  });
});
