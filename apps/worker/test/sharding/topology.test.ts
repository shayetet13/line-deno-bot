import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { type ShardSpec, ShardTopology, validateTopology } from '../../src/sharding/topology.ts';

const shard = (workerId: string, owners: string[], extra: Partial<ShardSpec> = {}): ShardSpec => ({
  workerId,
  owners,
  ...extra,
});

const errors = (shards: ShardSpec[]): string[] =>
  validateTopology(shards).filter((p) => p.severity === 'error').map((p) => p.message);

describe('validateTopology', () => {
  test('accepts a disjoint set of shards', () => {
    expect(errors([shard('w1', ['o1', 'o2']), shard('w2', ['o3'])])).toEqual([]);
  });

  test('rejects an owner served by two workers', () => {
    const problems = errors([shard('w1', ['o1']), shard('w2', ['o1'])]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/more than one worker/);
  });

  test('rejects duplicate worker ids', () => {
    expect(errors([shard('w1', ['o1']), shard('w1', ['o2'])])).toContain('duplicate workerId');
  });

  test('rejects more than one default shard', () => {
    const problems = errors([
      shard('w1', [], { isDefault: true }),
      shard('w2', [], { isDefault: true }),
    ]);
    expect(problems).toContain('more than one default shard');
  });

  test('rejects an empty topology', () => {
    expect(errors([])).toContain('topology has no shards');
  });

  test('warns about a shard that serves nobody', () => {
    const problems = validateTopology([shard('w1', ['o1']), shard('w2', [])]);
    expect(problems.filter((p) => p.severity === 'warning')).toHaveLength(1);
    expect(errors([shard('w1', ['o1']), shard('w2', [])])).toEqual([]);
  });
});

describe('ShardTopology', () => {
  test('resolves an owner to its worker', () => {
    const t = ShardTopology.create([shard('w1', ['o1', 'o2']), shard('w2', ['o3'])]);
    expect(t.workerFor('o2')?.workerId).toBe('w1');
    expect(t.workerFor('o3')?.workerId).toBe('w2');
  });

  test('falls back to the default shard for an unlisted owner', () => {
    const t = ShardTopology.create([
      shard('primary', [], { isDefault: true }),
      shard('shard-b', ['o9']),
    ]);
    expect(t.workerFor('someone-new')?.workerId).toBe('primary');
    expect(t.workerFor('o9')?.workerId).toBe('shard-b');
  });

  test('unlisted owner with no default resolves to nothing', () => {
    const t = ShardTopology.create([shard('w1', ['o1'])]);
    expect(t.workerFor('o404')).toBeUndefined();
  });

  test('belongsTo is the guard a worker uses to drop foreign work', () => {
    const t = ShardTopology.create([shard('w1', ['o1']), shard('w2', ['o2'])]);
    expect(t.belongsTo('o1', 'w1')).toBe(true);
    expect(t.belongsTo('o1', 'w2')).toBe(false);
    expect(t.belongsTo('unknown', 'w1')).toBe(false);
  });

  test('ownersOf lists a worker s owners', () => {
    const t = ShardTopology.create([shard('w1', ['o1', 'o2'])]);
    expect(t.ownersOf('w1')).toEqual(['o1', 'o2']);
    expect(t.ownersOf('nope')).toEqual([]);
  });

  test('create throws on an invalid topology', () => {
    expect(() => ShardTopology.create([shard('w1', ['o1']), shard('w2', ['o1'])])).toThrow(
      ConfigError,
    );
  });
});
