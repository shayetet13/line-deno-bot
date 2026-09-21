import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { LatencyRing } from '../../src/metrics/ring.ts';

const fill = (ring: LatencyRing, values: readonly number[]): LatencyRing => {
  for (const v of values) ring.add(v);
  return ring;
};

describe('LatencyRing', () => {
  test('is empty until something is added', () => {
    expect(new LatencyRing(4).snapshot()).toBeUndefined();
  });

  test('reports percentiles over the samples it holds', () => {
    const ring = fill(new LatencyRing(100), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const snap = ring.snapshot();
    expect(snap?.count).toBe(10);
    expect(snap?.window).toBe(10);
    expect(snap?.min).toBe(1);
    expect(snap?.max).toBe(10);
    expect(snap?.p50).toBe(5);
    expect(snap?.p95).toBe(10);
    expect(snap?.mean).toBe(5.5);
    expect(snap?.last).toBe(10);
  });

  test('a tail spike moves p99 but barely moves p50', () => {
    const ring = fill(new LatencyRing(100), [...Array(99).fill(10), 900]);
    const snap = ring.snapshot();
    expect(snap?.p50).toBe(10);
    expect(snap?.p99).toBe(10);
    expect(snap?.max).toBe(900);
  });

  test('overwrites oldest samples but keeps the lifetime count', () => {
    const ring = fill(new LatencyRing(3), [1, 2, 3, 4, 5]);
    const snap = ring.snapshot();
    expect(snap?.count).toBe(5);
    expect(snap?.window).toBe(3);
    expect(snap?.min).toBe(3);
    expect(snap?.max).toBe(5);
    expect(snap?.last).toBe(5);
  });

  test('ignores non-finite samples', () => {
    const ring = new LatencyRing(4);
    ring.add(Number.NaN);
    ring.add(Number.POSITIVE_INFINITY);
    expect(ring.snapshot()).toBeUndefined();
    expect(ring.count).toBe(0);
  });

  test('a single sample reports the same value everywhere', () => {
    const snap = fill(new LatencyRing(8), [42]).snapshot();
    expect(snap).toMatchObject({ count: 1, min: 42, p50: 42, p95: 42, p99: 42, max: 42 });
  });

  test('rejects an invalid capacity', () => {
    expect(() => new LatencyRing(0)).toThrow(ConfigError);
    expect(() => new LatencyRing(1.5)).toThrow(ConfigError);
  });
});
