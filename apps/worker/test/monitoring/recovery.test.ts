import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import type { Alert, AlertKind } from '../../src/monitoring/alerts.ts';
import { RecoveryPlanner, type RecoveryRung } from '../../src/monitoring/recovery.ts';

const alert = (kind: AlertKind): Alert => ({
  kind,
  severity: 'warning',
  message: `${kind} is firing`,
  forMs: 90_000,
  observed: 1,
  threshold: 0,
});

const make = (over: { cooldownMs?: number; ceiling?: RecoveryRung } = {}) => {
  const clock = new FakeClock();
  const planner = new RecoveryPlanner({
    clock,
    logger: new Logger({ level: 'error', sink: () => {} }),
    cooldownMs: over.cooldownMs ?? 120_000,
    ...(over.ceiling === undefined ? {} : { ceiling: over.ceiling }),
  });
  return { clock, planner };
};

describe('RecoveryPlanner', () => {
  test('no alerts means no action', () => {
    const { planner } = make();
    expect(planner.next([])).toBeUndefined();
    expect(planner.rung).toBe('none');
  });

  test('a latency regression enters at the gentlest rung, never at restart', () => {
    const { planner } = make();
    const action = planner.next([alert('first-response-regression')]);
    expect(action?.rung).toBe('avoid-lane');
    expect(action?.step).toBe(1);
  });

  test('a LINE trigger-to-reply breach is observed but does not restart a healthy lane', () => {
    const { planner } = make();
    expect(planner.next([alert('line-trigger-reply-budget')])).toBeUndefined();
    expect(planner.rung).toBe('none');
  });

  test('a CPU-starved host is observed but never reconnects anything', () => {
    const { planner } = make();
    expect(planner.next([alert('host-cpu-starved')])).toBeUndefined();
    expect(planner.rung).toBe('none');
  });

  test('a single spike cannot reach restart, however many times it is seen', () => {
    const { planner } = make();
    for (let i = 0; i < 20; i += 1) planner.next([alert('first-response-regression')]);
    // No clock movement: every rung is still inside its cooldown.
    expect(planner.rung).toBe('avoid-lane');
  });

  test('a rung gets its cooldown before the ladder climbs', () => {
    const { clock, planner } = make({ cooldownMs: 120_000 });
    planner.next([alert('first-response-regression')]);
    clock.advance(119_000);
    expect(planner.next([alert('first-response-regression')])).toBeUndefined();
    clock.advance(2_000);
    expect(planner.next([alert('first-response-regression')])?.rung).toBe('reconnect-lane');
  });

  test('a persistent problem climbs one rung at a time to restart', () => {
    const { clock, planner } = make({ cooldownMs: 1_000 });
    const climbed: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const action = planner.next([alert('first-response-regression')]);
      if (action !== undefined) climbed.push(action.rung);
      clock.advance(1_500);
    }
    expect(climbed).toEqual([
      'avoid-lane',
      'reconnect-lane',
      'rearm-poll',
      'reconnect-session',
      'restart-worker',
    ]);
    // The bottom rung is the last one; it does not loop round.
    expect(planner.next([alert('first-response-regression')])).toBeUndefined();
  });

  test('a more serious alert jumps straight to its own entry rung', () => {
    const { clock, planner } = make({ cooldownMs: 1_000 });
    expect(planner.next([alert('first-response-regression')])?.rung).toBe('avoid-lane');
    clock.advance(1_500);
    expect(planner.next([alert('readiness-loss')])?.rung).toBe('reconnect-session');
  });

  test('the worst alert in a batch sets the rung', () => {
    const { planner } = make();
    const action = planner.next([alert('first-response-regression'), alert('readiness-loss')]);
    expect(action?.rung).toBe('reconnect-session');
  });

  test('a ceiling stops the ladder short so a human decides the last step', () => {
    const { clock, planner } = make({ cooldownMs: 1_000, ceiling: 'rearm-poll' });
    for (let i = 0; i < 8; i += 1) {
      planner.next([alert('first-response-regression')]);
      clock.advance(1_500);
    }
    expect(planner.rung).toBe('rearm-poll');
  });

  test('one clean check is not recovery', () => {
    const { planner } = make();
    planner.next([alert('readiness-loss')]);
    expect(planner.next([])).toBeUndefined();
    expect(planner.rung).toBe('reconnect-session');
  });

  test('enough consecutive clean checks walk the ladder back down', () => {
    const { planner } = make();
    planner.next([alert('readiness-loss')]);
    planner.next([]);
    planner.next([]);
    const cleared = planner.next([]);
    expect(cleared?.rung).toBe('none');
    expect(planner.rung).toBe('none');
  });

  test('a relapse restarts the clean count', () => {
    const { clock, planner } = make({ cooldownMs: 1_000 });
    planner.next([alert('readiness-loss')]);
    planner.next([]);
    planner.next([]);
    clock.advance(1_500);
    planner.next([alert('readiness-loss')]);
    planner.next([]);
    expect(planner.rung).not.toBe('none');
  });

  test('reset drops to the bottom immediately, for a confirmed manual fix', () => {
    const { planner } = make();
    planner.next([alert('readiness-loss')]);
    planner.reset();
    expect(planner.rung).toBe('none');
    expect(planner.onRungMs).toBe(0);
  });

  test('time on the current rung is reported', () => {
    const { clock, planner } = make();
    planner.next([alert('readiness-loss')]);
    clock.advance(4_000);
    expect(planner.onRungMs).toBe(4_000);
  });
});
