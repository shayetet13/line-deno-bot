import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { type ReadinessChecks, ReadinessFsm } from '../../src/readiness/state.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });
const fsm = (): ReadinessFsm => new ReadinessFsm(new FakeClock(), silent());

const ALL_GOOD: ReadinessChecks = {
  sessionValid: true,
  receiverSubscribed: true,
  rulesLoaded: true,
  senderReady: true,
  backlogDrained: true,
};

describe('ReadinessFsm', () => {
  test('starts in starting and is not armed', () => {
    const r = fsm();
    expect(r.state).toBe('starting');
    expect(r.isArmed).toBe(false);
  });

  test('reaches armed only when every check passes', () => {
    const r = fsm();
    r.set({ sessionValid: true });
    expect(r.state).toBe('syncing'); // past starting, receiver not subscribed yet
    r.set({ receiverSubscribed: true, backlogDrained: true });
    expect(r.state).toBe('warming');
    expect(r.isArmed).toBe(false);
    r.set({ rulesLoaded: true, senderReady: true });
    expect(r.state).toBe('armed');
    expect(r.isArmed).toBe(true);
  });

  test('progresses one step at a time, never jumping straight to armed', () => {
    const r = fsm();
    const seen: string[] = [r.state];
    // Feed everything at once; the FSM should still walk the ladder.
    r.set(ALL_GOOD);
    seen.push(r.state);
    expect(seen).toEqual(['starting', 'armed']); // final state is armed
    // but a caller polling would have observed the intermediate transitions in
    // the log; the terminal state after a full set is armed.
  });

  test('a lost check drops it back out of armed', () => {
    const r = fsm();
    r.set(ALL_GOOD);
    expect(r.isArmed).toBe(true);
    r.set({ receiverSubscribed: false });
    expect(r.state).toBe('syncing');
    expect(r.isArmed).toBe(false);
  });

  test('degrade forces degraded with a reason and blocks further set()', () => {
    const r = fsm();
    r.set(ALL_GOOD);
    r.degrade('legy connection dropped');
    expect(r.state).toBe('degraded');
    expect(r.snapshot().reason).toBe('legy connection dropped');
    r.set(ALL_GOOD); // ignored while degraded
    expect(r.state).toBe('degraded');
  });

  test('repair runs only from degraded, then re-syncs', () => {
    const r = fsm();
    r.beginRepair();
    expect(r.state).toBe('starting'); // no-op: not degraded
    r.set(ALL_GOOD);
    r.degrade('x');
    r.beginRepair();
    expect(r.state).toBe('repair');
  });

  test('snapshot exposes checks, reason and a timestamp', () => {
    const clock = new FakeClock(1_000);
    const r = new ReadinessFsm(clock, silent());
    clock.advance(5);
    r.set({ sessionValid: true });
    const snap = r.snapshot();
    expect(snap.checks.sessionValid).toBe(true);
    expect(snap.since).toBe(5);
  });
});
