import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BoundedTtlMap } from '../../src/lib/bounded-ttl-map.ts';
import { FakeClock } from '../../src/lib/clock.ts';

const make = <V>(clock: FakeClock, ttlMs = 1_000, maxEntries = 3): BoundedTtlMap<V> =>
  new BoundedTtlMap<V>(clock, { ttlMs, maxEntries });

describe('BoundedTtlMap', () => {
  test('stores and reads a value before it expires', () => {
    const clock = new FakeClock();
    const map = make<number>(clock);
    map.set('a', 42);
    expect(map.get('a')).toBe(42);
    expect(map.has('a')).toBe(true);
    expect(map.size).toBe(1);
  });

  test('lazily expires an entry once its ttl passes', () => {
    const clock = new FakeClock();
    const map = make<number>(clock, 1_000);
    map.set('a', 1);
    clock.advance(999);
    expect(map.get('a')).toBe(1);
    clock.advance(1);
    expect(map.get('a')).toBeUndefined();
    expect(map.has('a')).toBe(false);
    expect(map.size).toBe(0);
  });

  test('set refreshes ttl and recency for an existing key', () => {
    const clock = new FakeClock();
    const map = make<string>(clock, 1_000);
    map.set('a', 'first');
    clock.advance(600);
    map.set('a', 'second');
    clock.advance(600);
    expect(map.get('a')).toBe('second');
  });

  test('evicts the oldest key when capacity is exceeded (O(1))', () => {
    const clock = new FakeClock();
    const map = make<number>(clock, 10_000, 3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4);
    expect(map.has('a')).toBe(false);
    expect(map.has('d')).toBe(true);
    expect(map.size).toBe(3);
  });

  test('re-setting a key updates its recency so it is not the eviction victim', () => {
    const clock = new FakeClock();
    const map = make<number>(clock, 10_000, 3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('a', 11);
    map.set('d', 4);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
  });

  test('prune drops only expired entries and reports the count', () => {
    const clock = new FakeClock();
    const map = make<number>(clock, 1_000, 10);
    map.set('a', 1);
    clock.advance(500);
    map.set('b', 2);
    clock.advance(600);
    expect(map.prune()).toBe(1);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
  });

  test('delete and clear', () => {
    const clock = new FakeClock();
    const map = make<number>(clock);
    map.set('a', 1).set('b', 2);
    expect(map.delete('a')).toBe(true);
    expect(map.delete('a')).toBe(false);
    map.clear();
    expect(map.size).toBe(0);
  });

  test('rejects non-positive options', () => {
    const clock = new FakeClock();
    expect(() => new BoundedTtlMap(clock, { ttlMs: 0, maxEntries: 1 })).toThrow(RangeError);
    expect(() => new BoundedTtlMap(clock, { ttlMs: 1, maxEntries: 0 })).toThrow(RangeError);
  });
});
