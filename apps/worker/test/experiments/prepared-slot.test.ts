import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { PreparedSlot } from '../../src/experiments/prepared-slot.ts';

const make = (maxAgeMs = 60_000) => {
  const clock = new FakeClock();
  return { clock, slot: new PreparedSlot<string>({ clock, maxAgeMs }) };
};

describe('PreparedSlot', () => {
  test('an empty slot yields nothing and counts a miss', () => {
    const { slot } = make();
    expect(slot.take('r1', 1)).toBeUndefined();
    expect(slot.status).toMatchObject({ state: 'empty', hits: 0, misses: 1 });
  });

  test('a matching take returns the payload exactly once', () => {
    const { slot } = make();
    slot.prepare('r1', 7, () => 'bytes');
    expect(slot.take('r1', 7)).toBe('bytes');
    // Single-use: the second take must not resend.
    expect(slot.take('r1', 7)).toBeUndefined();
    expect(slot.status).toMatchObject({ state: 'consumed', hits: 1, misses: 1 });
  });

  test('the payload is built once at prepare time, not at take time', () => {
    const { slot } = make();
    let built = 0;
    slot.prepare('r1', 1, () => {
      built += 1;
      return 'bytes';
    });
    expect(built).toBe(1);
    slot.take('r1', 1);
    expect(built).toBe(1);
  });

  test('a wrong route key is refused AND drops the payload', () => {
    const { slot } = make();
    slot.prepare('r1', 1, () => 'bytes');
    expect(slot.take('r2', 1)).toBeUndefined();
    // The world moved; the bytes are garbage, so the right key gets nothing either.
    expect(slot.take('r1', 1)).toBeUndefined();
    expect(slot.status.state).toBe('invalidated');
  });

  test('a stale sequence is refused — this is the replay guard', () => {
    const { slot } = make();
    slot.prepare('r1', 4, () => 'bytes');
    expect(slot.take('r1', 5)).toBeUndefined();
    expect(slot.status.reason).toContain('sequence');
  });

  test('a payload older than maxAgeMs is discarded rather than sent', () => {
    const { clock, slot } = make(5_000);
    slot.prepare('r1', 1, () => 'bytes');
    clock.advance(4_999);
    expect(slot.status.ageMs).toBe(4_999);

    slot.prepare('r1', 1, () => 'bytes');
    clock.advance(5_001);
    expect(slot.take('r1', 1)).toBeUndefined();
    expect(slot.status.reason).toContain('maxAgeMs');
  });

  test('invalidate drops a ready payload with a reason', () => {
    const { slot } = make();
    slot.prepare('r1', 1, () => 'bytes');
    slot.invalidate('session rotated');
    expect(slot.take('r1', 1)).toBeUndefined();
    expect(slot.status).toMatchObject({ state: 'invalidated', reason: 'session rotated' });
  });

  test('invalidateSequence keeps a payload the sequence has not passed', () => {
    const { slot } = make();
    slot.prepare('r1', 3, () => 'bytes');
    slot.invalidateSequence('r1', 3);
    expect(slot.status.state).toBe('ready');
    slot.invalidateSequence('r1', 4);
    expect(slot.status.state).toBe('invalidated');
  });

  test('preparing over a ready slot replaces the binding', () => {
    const { slot } = make();
    slot.prepare('r1', 1, () => 'old');
    slot.prepare('r2', 2, () => 'new');
    expect(slot.take('r1', 1)).toBeUndefined();
    const again = make();
    again.slot.prepare('r1', 1, () => 'old');
    again.slot.prepare('r2', 2, () => 'new');
    expect(again.slot.take('r2', 2)).toBe('new');
    expect(slot.status.prepared).toBe(2);
  });

  test('age is reported only while a payload is held', () => {
    const { clock, slot } = make();
    expect(slot.status.ageMs).toBeUndefined();
    slot.prepare('r1', 1, () => 'bytes');
    clock.advance(120);
    expect(slot.status.ageMs).toBe(120);
    slot.take('r1', 1);
    expect(slot.status.ageMs).toBeUndefined();
  });
});
