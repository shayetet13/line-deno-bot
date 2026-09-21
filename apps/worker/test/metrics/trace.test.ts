import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { NULL_TRACE, Trace, TRACE_POINTS } from '../../src/metrics/trace.ts';

describe('Trace', () => {
  test('spans between marks use the monotonic clock', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock);
    trace.mark('transport_submit');
    clock.advance(17);
    trace.mark('ack_complete');
    expect(trace.span('transport_submit', 'ack_complete')).toBe(17);
  });

  test('an unset mark yields undefined rather than zero', () => {
    const trace = new Trace(new FakeClock());
    trace.mark('transport_submit');
    expect(trace.at('ack_complete')).toBeUndefined();
    expect(trace.span('transport_submit', 'ack_complete')).toBeUndefined();
  });

  test('the first mark wins so a retry cannot rewrite history', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock);
    trace.mark('matched');
    clock.advance(100);
    trace.mark('matched');
    expect(trace.at('matched')).toBe(0);
  });

  test('markAt records a mark taken elsewhere', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock);
    trace.markAt('notice_rx', 5);
    clock.advance(12);
    trace.mark('ack_complete');
    expect(trace.span('notice_rx', 'ack_complete')).toBe(7);
  });

  test('toRecord reports only local spans, never the cross-host one', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock, 1_700_000_000_000);
    trace.markAt('notice_rx', 0);
    trace.mark('message_bytes_ready');
    clock.advance(2);
    trace.mark('transport_submit');
    clock.advance(19);
    trace.mark('ack_complete');

    const record = trace.toRecord();
    expect(record.spans.code).toBe(2);
    expect(record.spans.send).toBe(19);
    expect(record.spans.local_total).toBe(21);
    expect(record.spans).not.toHaveProperty('inbound');
    expect(record.sourceEventTimeMs).toBe(1_700_000_000_000);
    expect(record.marks.ack_complete).toBe(21);
  });

  test('match and limiter are timed independently of the rest of the code path', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock);
    trace.mark('message_bytes_ready');
    clock.advance(1);
    trace.mark('rule_match_start');
    clock.advance(3);
    trace.mark('matched');
    clock.advance(1);
    trace.mark('limiter_check_start');
    clock.advance(2);
    trace.mark('limiter_check_done');
    clock.advance(1);
    trace.mark('transport_submit');

    const record = trace.toRecord();
    expect(record.spans.match).toBe(3);
    expect(record.spans.limiter).toBe(2);
    // code = 1 + 3 + 1 + 2 + 1 = 8; pre_dispatch = code - match - limiter = 3.
    expect(record.spans.code).toBe(8);
    expect(record.spans.pre_dispatch).toBe(3);
  });

  test('pre_dispatch is withheld when match or limiter never fired (a gated event)', () => {
    const clock = new FakeClock();
    const trace = new Trace(clock);
    trace.mark('message_bytes_ready');
    clock.advance(1);
    trace.mark('transport_submit');

    const record = trace.toRecord();
    expect(record.spans.code).toBe(1);
    expect(record.spans.match).toBeUndefined();
    expect(record.spans.pre_dispatch).toBeUndefined();
  });

  test('inboundMs needs both a service timestamp and the mark', () => {
    const withTime = new Trace(new FakeClock(), 1_000);
    expect(withTime.inboundMs('message_bytes_ready', 1_120)).toBeUndefined();
    withTime.mark('message_bytes_ready');
    expect(withTime.inboundMs('message_bytes_ready', 1_120)).toBe(120);

    const withoutTime = new Trace(new FakeClock());
    withoutTime.mark('message_bytes_ready');
    expect(withoutTime.inboundMs()).toBeUndefined();
  });
});

describe('NULL_TRACE', () => {
  test('accepts every call and records nothing', () => {
    for (const point of TRACE_POINTS) {
      NULL_TRACE.mark(point);
      NULL_TRACE.markAt(point, 1);
      expect(NULL_TRACE.at(point)).toBeUndefined();
    }
    expect(NULL_TRACE.span('notice_rx', 'ack_complete')).toBeUndefined();
    expect(NULL_TRACE.inboundMs()).toBeUndefined();
    expect(NULL_TRACE.toRecord()).toEqual({
      marks: {},
      spans: {},
      sourceEventTimeMs: undefined,
    });
  });
});
