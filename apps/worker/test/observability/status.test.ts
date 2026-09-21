import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import type { LaneStat } from '../../src/transport/lane-pool.ts';
import { classifyLanes } from '../../src/observability/status.ts';

const lane = (over: Partial<LaneStat> & { id: number }): LaneStat => ({
  state: 'ready',
  inFlight: 0,
  medianRttMs: undefined,
  lastSampleMono: undefined,
  ageMs: 0,
  consecutiveFailures: 0,
  role: 'shared',
  available: true,
  ...over,
});

const classify = (stats: LaneStat[], clock = new FakeClock(), maxAge = 30_000) =>
  classifyLanes(stats, {
    clock,
    workerId: 'w1',
    origin: 'https://legy.line-apps.com/',
    sampleMaxAgeMs: maxAge,
  });

const badges = (stats: LaneStat[], clock?: FakeClock, maxAge?: number): string[] =>
  classify(stats, clock, maxAge).map((v) => v.badge);

describe('classifyLanes', () => {
  test('the lowest fresh application RTT is the only HOT lane', () => {
    const clock = new FakeClock();
    expect(badges([
      lane({ id: 0, medianRttMs: 26.8, lastSampleMono: 0 }),
      lane({ id: 1, medianRttMs: 16.3, lastSampleMono: 0 }),
      lane({ id: 2, medianRttMs: 40.0, lastSampleMono: 0 }),
    ], clock)).toEqual(['standby', 'hot', 'standby']);
  });

  test('HOT follows the tail-aware routing estimate, not p50 alone', () => {
    expect(badges([
      lane({
        id: 0,
        medianRttMs: 15,
        predictedRttMs: 24,
        lastSampleMono: 0,
      }),
      lane({
        id: 1,
        medianRttMs: 18,
        predictedRttMs: 19,
        lastSampleMono: 0,
      }),
    ])).toEqual(['standby', 'hot']);
  });

  test('a lane rejected by the router is WAIT even when its p50 is lower', () => {
    expect(badges([
      lane({ id: 0, medianRttMs: 10, predictedRttMs: 10, lastSampleMono: 0, routeEligible: false }),
      lane({ id: 1, medianRttMs: 18, predictedRttMs: 18, lastSampleMono: 0 }),
    ])).toEqual(['wait', 'hot']);
  });

  test('an unmeasured lane is WAIT, never ranked ahead of a measured one', () => {
    expect(badges([
      lane({ id: 0, medianRttMs: 30, lastSampleMono: 0 }),
      lane({ id: 1 }),
    ])).toEqual(['hot', 'wait']);
  });

  test('selects a HOT lane independently for send and poll roles', () => {
    expect(badges([
      lane({ id: 0, role: 'send', medianRttMs: 20, lastSampleMono: 0 }),
      lane({ id: 1, role: 'poll', medianRttMs: 12, lastSampleMono: 0 }),
      lane({ id: 2, role: 'poll', medianRttMs: 18, lastSampleMono: 0 }),
    ])).toEqual(['hot', 'hot', 'standby']);
  });

  test('a parked lane is WAIT even when it has the lowest fresh RTT', () => {
    expect(badges([
      lane({ id: 0, medianRttMs: 10, lastSampleMono: 0, available: false }),
      lane({ id: 1, medianRttMs: 20, lastSampleMono: 0 }),
    ])).toEqual(['wait', 'hot']);
  });

  test('does not compare send application RTT with poll application RTT', () => {
    expect(badges([
      lane({ id: 0, role: 'send', medianRttMs: 86, lastSampleMono: 0 }),
      lane({ id: 1, role: 'poll', medianRttMs: 11.5, lastSampleMono: 0 }),
    ])).toEqual(['hot', 'hot']);
  });

  test('a stale sample becomes WAIT and its rtt is withheld', () => {
    const clock = new FakeClock();
    const stats = [lane({ id: 0, medianRttMs: 16, lastSampleMono: 0 })];
    expect(badges(stats, clock)).toEqual(['hot']);

    clock.advance(30_001);
    const stale = classify(stats, clock);
    expect(stale[0]?.badge).toBe('wait');
    // The number is withheld rather than shown as if it were live.
    expect(stale[0]?.applicationRttMs).toBeUndefined();
    expect(stale[0]?.sampleAgeMs).toBe(30_001);
  });

  test('a draining lane is WAIT and a dead lane is DOWN', () => {
    expect(badges([
      lane({ id: 0, state: 'draining', medianRttMs: 10, lastSampleMono: 0 }),
      lane({ id: 1, state: 'dead', medianRttMs: 10, lastSampleMono: 0 }),
      lane({ id: 2, medianRttMs: 20, lastSampleMono: 0 }),
    ])).toEqual(['wait', 'down', 'hot']);
  });

  test('a non-ready lane never wins even with the lowest number', () => {
    const views = classify([
      lane({ id: 0, state: 'draining', medianRttMs: 5, lastSampleMono: 0 }),
      lane({ id: 1, medianRttMs: 50, lastSampleMono: 0 }),
    ]);
    expect(views[0]?.badge).toBe('wait');
    expect(views[1]?.badge).toBe('hot');
  });

  test('carries worker id, origin, in-flight and failures through', () => {
    const view = classify([lane({ id: 3, inFlight: 2, consecutiveFailures: 1, ageMs: 900 })])[0];
    expect(view).toMatchObject({
      laneId: 3,
      workerId: 'w1',
      origin: 'https://legy.line-apps.com/',
      inFlight: 2,
      consecutiveFailures: 1,
      ageMs: 900,
    });
  });

  test('an empty pool classifies to nothing', () => {
    expect(classify([])).toEqual([]);
  });
});
