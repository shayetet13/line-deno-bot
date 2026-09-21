import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SquarePollQuietGate } from '../../../src/adapters/linejs/poll-quiet.ts';
import { FakeClock } from '../../../src/lib/clock.ts';

describe('SquarePollQuietGate', () => {
  test('holds only configured rooms for the remaining part of the send window', () => {
    const clock = new FakeClock();
    const gate = new SquarePollQuietGate(clock, ['watched'], 30);

    gate.markReplyStarted('other');
    expect(gate.remainingMs('other')).toBe(0);

    gate.markReplyStarted('watched');
    expect(gate.remainingMs('watched')).toBe(30);
    clock.advance(18);
    expect(gate.remainingMs('watched')).toBe(12);
    clock.advance(12);
    expect(gate.remainingMs('watched')).toBe(0);
  });
});
