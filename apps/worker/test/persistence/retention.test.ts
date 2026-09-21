import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ValidationError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import {
  DEFAULT_RETENTION,
  HOUR_MS,
  prune,
  type RawEventRow,
  rollup,
} from '../../src/persistence/retention.ts';

const T0 = 1_700_000_000_000;
const hour = Math.floor(T0 / HOUR_MS) * HOUR_MS;

const row = (over: Partial<RawEventRow> = {}): RawEventRow => ({
  atMs: T0,
  outcome: 'dispatched',
  sendMs: 30,
  releaseLabel: 'r1',
  ...over,
});

describe('rollup', () => {
  test('groups by hour', () => {
    const buckets = rollup([
      row({ atMs: hour + 60_000 }),
      row({ atMs: hour + 120_000 }),
      row({ atMs: hour + HOUR_MS + 1 }),
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.count).toBe(2);
    expect(buckets[1]?.count).toBe(1);
  });

  test('never mixes releases into one bucket — that is the whole point', () => {
    const buckets = rollup([
      row({ atMs: hour, releaseLabel: 'old', sendMs: 30 }),
      row({ atMs: hour, releaseLabel: 'new', sendMs: 12 }),
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.releaseLabel).sort()).toEqual(['new', 'old']);
    expect(buckets.find((b) => b.releaseLabel === 'new')?.p50Ms).toBe(12);
  });

  test('counts outcomes and computes percentiles over send times', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => row({ sendMs: 10 + i })),
      row({ outcome: 'send-failed', sendMs: 500 }),
    ];
    const b = rollup(rows)[0];
    expect(b?.count).toBe(10);
    expect(b?.dispatched).toBe(9);
    expect(b?.failed).toBe(1);
    expect(b?.p50Ms).toBe(14);
    expect(b?.maxMs).toBe(500);
  });

  test('an event with no send time is counted but not measured', () => {
    const b = rollup([row({ outcome: 'no-rule', sendMs: undefined })])[0];
    expect(b?.count).toBe(1);
    expect(b?.p50Ms).toBeUndefined();
    expect(b?.maxMs).toBeUndefined();
  });

  test('output is sorted by hour then release, so a report is stable', () => {
    const buckets = rollup([
      row({ atMs: hour + HOUR_MS, releaseLabel: 'b' }),
      row({ atMs: hour, releaseLabel: 'z' }),
      row({ atMs: hour, releaseLabel: 'a' }),
    ]);
    expect(buckets.map((b) => `${String(b.hourStartMs - hour)}/${b.releaseLabel}`))
      .toEqual(['0/a', '0/z', `${String(HOUR_MS)}/b`]);
  });

  test('nothing in, nothing out', () => {
    expect(rollup([])).toEqual([]);
  });
});

describe('prune', () => {
  const clock = () => new FakeClock(T0);

  test('rows inside the window are kept', () => {
    const rows = [row({ atMs: T0 - HOUR_MS })];
    expect(prune(rows, [], clock()).keptRaw).toHaveLength(1);
  });

  test('an old row is dropped once a rollup covers it', () => {
    const old = row({ atMs: T0 - 30 * 24 * HOUR_MS });
    const result = prune([old], rollup([old]), clock());
    expect(result.keptRaw).toHaveLength(0);
    expect(result.droppedRaw).toBe(1);
  });

  test('an old row with no rollup is KEPT — pruning compresses, it does not destroy', () => {
    const old = row({ atMs: T0 - 30 * 24 * HOUR_MS });
    expect(prune([old], [], clock()).keptRaw).toHaveLength(1);
  });

  test('a rollup for a different release does not license dropping the row', () => {
    const old = row({ atMs: T0 - 30 * 24 * HOUR_MS, releaseLabel: 'r1' });
    const other = rollup([{ ...old, releaseLabel: 'r2' }]);
    expect(prune([old], other, clock()).keptRaw).toHaveLength(1);
  });

  test('rollups are kept forever by default', () => {
    const ancient = rollup([row({ atMs: T0 - 400 * 24 * HOUR_MS })]);
    const result = prune([], ancient, clock(), DEFAULT_RETENTION);
    expect(result.keptRollups).toHaveLength(1);
    expect(result.droppedRollups).toBe(0);
  });

  test('a finite rollup window drops the oldest buckets', () => {
    const ancient = rollup([row({ atMs: T0 - 400 * 24 * HOUR_MS })]);
    const recent = rollup([row({ atMs: T0 - HOUR_MS })]);
    const result = prune([], [...ancient, ...recent], clock(), {
      rawRetentionMs: HOUR_MS,
      rollupRetentionMs: 30 * 24 * HOUR_MS,
    });
    expect(result.keptRollups).toHaveLength(1);
    expect(result.droppedRollups).toBe(1);
  });

  test('a negative window is a configuration error, not a silent no-op', () => {
    expect(() => prune([], [], clock(), { rawRetentionMs: -1, rollupRetentionMs: 0 }))
      .toThrow(ValidationError);
  });
});
