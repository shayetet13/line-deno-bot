import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock, systemClock } from '../../src/lib/clock.ts';

describe('FakeClock', () => {
  test('starts at the given epoch and advances both timelines together', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.monotonic()).toBe(0);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
    expect(clock.monotonic()).toBe(250);
  });

  test('defaults to epoch 0', () => {
    expect(new FakeClock().now()).toBe(0);
  });

  test('rejects a negative advance', () => {
    expect(() => new FakeClock().advance(-1)).toThrow(RangeError);
  });
});

describe('systemClock', () => {
  test('now is a plausible wall-clock epoch and monotonic never goes backwards', () => {
    expect(systemClock.now()).toBeGreaterThan(1_700_000_000_000);
    const a = systemClock.monotonic();
    const b = systemClock.monotonic();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
