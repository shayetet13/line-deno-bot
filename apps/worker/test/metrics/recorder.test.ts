import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { MetricsRecorder } from '../../src/metrics/recorder.ts';
import { Trace } from '../../src/metrics/trace.ts';

const tracedSend = (sendMs: number, codeMs = 1): Trace => {
  const clock = new FakeClock();
  const trace = new Trace(clock, 1_700_000_000_000);
  trace.markAt('notice_rx', 0);
  trace.mark('message_bytes_ready');
  clock.advance(codeMs);
  trace.mark('transport_submit');
  clock.advance(sendMs);
  trace.mark('ack_complete');
  return trace;
};

describe('MetricsRecorder', () => {
  test('files every local span from a trace', () => {
    const metrics = new MetricsRecorder();
    metrics.recordTrace(tracedSend(20, 2));
    const { spans } = metrics.snapshot();
    expect(spans.send?.p50).toBe(20);
    expect(spans.code?.p50).toBe(2);
    expect(spans.local_total?.p50).toBe(22);
    expect(spans).not.toHaveProperty('inbound');
  });

  test('aggregates percentiles across traces', () => {
    const metrics = new MetricsRecorder();
    for (const ms of [10, 20, 30, 40]) metrics.recordTrace(tracedSend(ms));
    const snap = metrics.snapshot().spans.send;
    expect(snap?.count).toBe(4);
    expect(snap?.min).toBe(10);
    expect(snap?.max).toBe(40);
  });

  test('counters tally outcomes', () => {
    const metrics = new MetricsRecorder();
    metrics.count('outcome.dispatched');
    metrics.count('outcome.dispatched');
    metrics.count('outcome.no-rule');
    expect(metrics.snapshot().counters).toEqual({
      'outcome.dispatched': 2,
      'outcome.no-rule': 1,
    });
  });

  test('an undefined span is skipped, not recorded as zero', () => {
    const metrics = new MetricsRecorder();
    metrics.recordSpan('send', undefined);
    expect(metrics.snapshot().spans.send).toBeUndefined();
  });

  test('disabled records nothing', () => {
    const metrics = new MetricsRecorder({ enabled: false });
    metrics.recordTrace(tracedSend(20));
    metrics.count('outcome.dispatched');
    expect(metrics.snapshot()).toEqual({ spans: {}, crossHost: {}, counters: {} });
  });

  test('window bounds how many samples inform the percentiles', () => {
    const metrics = new MetricsRecorder({ window: 2 });
    for (const ms of [10, 20, 30]) metrics.recordSpan('send', ms);
    const snap = metrics.snapshot().spans.send;
    expect(snap?.count).toBe(3);
    expect(snap?.window).toBe(2);
    expect(snap?.min).toBe(20);
  });

  test('reset clears spans and counters', () => {
    const metrics = new MetricsRecorder();
    metrics.recordSpan('send', 5);
    metrics.count('x');
    metrics.reset();
    expect(metrics.snapshot()).toEqual({ spans: {}, crossHost: {}, counters: {} });
  });

  test('cross-host readings file into their own pool, separate from spans', () => {
    const metrics = new MetricsRecorder();
    metrics.recordCrossHost('inbound', 15);
    metrics.recordCrossHost('line_round_trip', 27);
    const snap = metrics.snapshot();
    expect(snap.crossHost?.inbound?.p50).toBe(15);
    expect(snap.crossHost?.line_round_trip?.p50).toBe(27);
    expect(snap.spans).toEqual({});
  });

  test('an undefined cross-host reading is skipped, not recorded as zero', () => {
    const metrics = new MetricsRecorder();
    metrics.recordCrossHost('inbound', undefined);
    expect(metrics.snapshot().crossHost?.inbound).toBeUndefined();
  });

  test('disabled skips cross-host readings too', () => {
    const metrics = new MetricsRecorder({ enabled: false });
    metrics.recordCrossHost('inbound', 15);
    expect(metrics.snapshot().crossHost).toEqual({});
  });
});
