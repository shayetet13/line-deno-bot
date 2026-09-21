import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError, ValidationError } from '../../src/errors/base.ts';
import { ExperimentRegistry } from '../../src/experiments/registry.ts';
import type { ExperimentDefinition } from '../../src/experiments/types.ts';
import { EXPERIMENT_IDS, EXPERIMENTS } from '../../src/experiments/definitions.ts';

const def = (over: Partial<ExperimentDefinition> & { id: string }): ExperimentDefinition => ({
  title: over.id,
  hypothesis: 'it is faster',
  metric: 'send',
  minSamples: 10,
  failureImpact: 'none worth naming',
  rollback: 'turn it off',
  ...over,
});

describe('ExperimentRegistry', () => {
  test('a definition without a rollback is refused at construction', () => {
    expect(() => new ExperimentRegistry([def({ id: 'a', rollback: '  ' })]))
      .toThrow(ConfigError);
  });

  test('duplicate ids are refused', () => {
    expect(() => new ExperimentRegistry([def({ id: 'a' }), def({ id: 'a' })]))
      .toThrow(ConfigError);
  });

  test('a conflictsWith pointing at an unknown id is a typo, not a silent no-op', () => {
    expect(() => new ExperimentRegistry([def({ id: 'a', conflictsWith: ['tpyo'] })]))
      .toThrow(ConfigError);
  });

  test('only one experiment runs at a time', () => {
    const r = new ExperimentRegistry([def({ id: 'a' }), def({ id: 'b' })]);
    r.start('a');
    expect(() => r.start('b')).toThrow(ValidationError);
    expect(r.active.map((e) => e.id)).toEqual(['a']);
  });

  test('conflict is symmetric even when only one side declares it', () => {
    const r = new ExperimentRegistry(
      [def({ id: 'a', conflictsWith: ['b'] }), def({ id: 'b' })],
      { maxConcurrent: 5 },
    );
    r.start('b');
    expect(() => r.start('a')).toThrow(ValidationError);
  });

  test('an experiment needing host control starts blocked and needs confirmation', () => {
    const r = new ExperimentRegistry([def({ id: 'a', requiresHostControl: true })]);
    expect(r.get('a')?.state).toBe('blocked');
    expect(() => r.start('a')).toThrow(ValidationError);
    expect(r.start('a', { hostControlConfirmed: true }).state).toBe('running');
  });

  test('adopting needs evidence and enough samples', () => {
    const r = new ExperimentRegistry([def({ id: 'a', minSamples: 200 })]);
    r.start('a');
    expect(() => r.conclude('a', 'adopt', { note: 'looks good', evidence: 'none', samples: 500 }))
      .toThrow(ValidationError);
    expect(() =>
      r.conclude('a', 'adopt', { note: 'one great run', evidence: 'live-paired', samples: 3 })
    ).toThrow(ValidationError);

    const adopted = r.conclude('a', 'adopt', {
      note: '4ms faster, CI below zero',
      evidence: 'live-paired',
      samples: 400,
    });
    expect(adopted.state).toBe('adopted');
    expect(r.isOn('a')).toBe(true);
  });

  test('rejecting needs neither, so a bad result is never stuck on', () => {
    const r = new ExperimentRegistry([def({ id: 'a', minSamples: 200 })]);
    r.start('a');
    expect(r.conclude('a', 'reject', { note: 'slower', evidence: 'local-replay' }).state)
      .toBe('rejected');
    expect(r.isOn('a')).toBe(false);
  });

  test('rollback turns an adopted experiment off and never throws', () => {
    const r = new ExperimentRegistry([def({ id: 'a', minSamples: 1 })]);
    r.start('a');
    r.conclude('a', 'adopt', { note: 'good', evidence: 'live-paired', samples: 10 });
    expect(r.rollback('a', 'regression in prod')?.state).toBe('rejected');
    expect(r.isOn('a')).toBe(false);
    expect(r.rollback('nope', 'x')).toBeUndefined();
  });

  test('unknown ids are rejected rather than quietly ignored', () => {
    const r = new ExperimentRegistry([def({ id: 'a' })]);
    expect(() => r.start('nope')).toThrow(ValidationError);
    expect(r.get('nope')).toBeUndefined();
    expect(r.isOn('nope')).toBe(false);
  });

  test('freeing the slot lets the next experiment run', () => {
    const r = new ExperimentRegistry([def({ id: 'a' }), def({ id: 'b' })]);
    r.start('a');
    r.conclude('a', 'reject', { note: 'no effect', evidence: 'live-paired' });
    expect(r.start('b').state).toBe('running');
  });
});

describe('the shipped experiment set', () => {
  test('loads, and every entry carries a hypothesis and a rollback', () => {
    const r = new ExperimentRegistry(EXPERIMENTS);
    expect(r.all.length).toBe(EXPERIMENTS.length);
    for (const e of r.all) {
      expect(e.hypothesis.length).toBeGreaterThan(20);
      expect(e.rollback.length).toBeGreaterThan(10);
      expect(e.failureImpact.length).toBeGreaterThan(10);
      expect(e.minSamples).toBeGreaterThanOrEqual(200);
    }
  });

  test('nothing is on until it has been measured', () => {
    expect(new ExperimentRegistry(EXPERIMENTS).active).toEqual([]);
  });

  test('the two inbound techniques cannot both be on', () => {
    const r = new ExperimentRegistry(EXPERIMENTS, { maxConcurrent: 5 });
    r.start(EXPERIMENT_IDS.fetchRace);
    expect(() => r.start(EXPERIMENT_IDS.receiverDiversity)).toThrow(ValidationError);
  });

  test('the kernel-level techniques are blocked until the host is profiled', () => {
    const r = new ExperimentRegistry(EXPERIMENTS);
    expect(r.get(EXPERIMENT_IDS.cpuAffinity)?.state).toBe('blocked');
    expect(r.get(EXPERIMENT_IDS.socketTuning)?.state).toBe('blocked');
  });
});
