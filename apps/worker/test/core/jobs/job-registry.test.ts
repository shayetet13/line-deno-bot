import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeJobKey } from '@line-first/contracts';
import { JobRegistry } from '../../../src/core/jobs/job-registry.ts';
import { IllegalStateTransitionError } from '../../../src/errors/base.ts';
import { FakeClock } from '../../../src/lib/clock.ts';

const key = unsafeJobKey('job-1');
const opts = { ttlMs: 1_000, maxEntries: 100 };

describe('JobRegistry', () => {
  test('ensure creates a waiting record and is idempotent', () => {
    const reg = new JobRegistry(new FakeClock(), opts);
    const first = reg.ensure(key);
    expect(first.state).toBe('waiting');
    expect(reg.ensure(key)).toBe(first);
  });

  test('walks the legal lifecycle to a settled outcome', () => {
    const reg = new JobRegistry(new FakeClock(), opts);
    reg.markEligible(key);
    reg.markDispatched(key);
    const settled = reg.settle(key, 'won');
    expect(settled.state).toBe('won');
    expect(reg.isTerminal(key)).toBe(true);
  });

  test('a redelivered trigger (push + poll) is a no-op once eligible', () => {
    const reg = new JobRegistry(new FakeClock(), opts);
    const a = reg.markEligible(key);
    const b = reg.markEligible(key);
    expect(b).toBe(a);
  });

  test('rejects an illegal transition', () => {
    const reg = new JobRegistry(new FakeClock(), opts);
    expect(() => reg.settle(key, 'won')).toThrow(IllegalStateTransitionError);
    reg.markEligible(key);
    expect(() => reg.markEligible(unsafeJobKey('job-1'))).not.toThrow();
    expect(() => reg.settle(key, 'lost')).toThrow(IllegalStateTransitionError);
  });

  test('an ACK timeout settles as unknown, not lost', () => {
    const reg = new JobRegistry(new FakeClock(), opts);
    reg.markEligible(key);
    reg.markDispatched(key);
    expect(reg.settle(key, 'unknown').state).toBe('unknown');
  });

  test('records expire so the same keyword next round starts fresh', () => {
    const clock = new FakeClock();
    const reg = new JobRegistry(clock, opts);
    reg.markEligible(key);
    clock.advance(1_001);
    expect(reg.get(key)).toBeUndefined();
    expect(reg.ensure(key).state).toBe('waiting');
    expect(reg.size).toBe(1);
  });
});
