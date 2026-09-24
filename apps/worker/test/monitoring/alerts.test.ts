import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { StatusSnapshot } from '../../src/observability/snapshot.ts';
import { AlertEvaluator, type AlertKind } from '../../src/monitoring/alerts.ts';

const T0 = 1_700_000_000_000;

const snap = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  workerId: 'w1',
  origin: 'https://legy.line-apps.com/',
  generatedAtMs: T0,
  uptimeMs: 1_000,
  readiness: {
    state: 'armed',
    checks: {
      sessionValid: true,
      receiverSubscribed: true,
      rulesLoaded: true,
      senderReady: true,
      backlogDrained: true,
    },
    reason: undefined,
    since: 0,
  },
  lanes: [],
  metrics: { spans: {}, counters: {} },
  race: undefined,
  warm: undefined,
  ...over,
});

const spans = (p95: number, window = 100) => ({
  send: { count: window, window, min: 1, p50: p95 / 2, p95, p99: p95, max: p95, mean: p95 / 2 },
});

const kinds = (alerts: readonly { kind: AlertKind }[]): AlertKind[] => alerts.map((a) => a.kind);

describe('AlertEvaluator — readiness loss', () => {
  test('a brief loss of ARMED is not an alert', () => {
    const e = new AlertEvaluator();
    const degraded = { state: 'syncing' as const, reason: undefined };
    e.evaluate(snap({ readiness: { ...snap().readiness!, ...degraded } }));
    const later = e.evaluate(
      snap({ generatedAtMs: T0 + 5_000, readiness: { ...snap().readiness!, ...degraded } }),
    );
    expect(later).toEqual([]);
  });

  test('a sustained loss of ARMED fires, and names the reason', () => {
    const e = new AlertEvaluator();
    const bad = { ...snap().readiness!, state: 'degraded' as const, reason: 'session rejected' };
    e.evaluate(snap({ readiness: bad }));
    const fired = e.evaluate(snap({ generatedAtMs: T0 + 31_000, readiness: bad }));
    expect(kinds(fired)).toEqual(['readiness-loss']);
    expect(fired[0]?.severity).toBe('critical');
    expect(fired[0]?.message).toContain('session rejected');
  });

  test('coming back ARMED clears the timer, so the next blip starts fresh', () => {
    const e = new AlertEvaluator();
    const bad = { ...snap().readiness!, state: 'syncing' as const };
    e.evaluate(snap({ readiness: bad }));
    e.evaluate(snap({ generatedAtMs: T0 + 20_000 }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 40_000, readiness: bad }))).toEqual([]);
  });
});

describe('AlertEvaluator — first-response regression', () => {
  test('nothing fires without a baseline to compare against', () => {
    const e = new AlertEvaluator();
    e.evaluate(snap({ metrics: { spans: spans(500), counters: {} } }));
    expect(
      e.evaluate(
        snap({ generatedAtMs: T0 + 200_000, metrics: { spans: spans(500), counters: {} } }),
      ),
    )
      .toEqual([]);
  });

  test('a sustained p95 above the baseline factor fires', () => {
    const e = new AlertEvaluator({}, { sendP95Ms: 30, releaseLabel: '0.1.0+aaa/bbb' });
    e.evaluate(snap({ metrics: { spans: spans(60), counters: {} } }));
    const fired = e.evaluate(
      snap({ generatedAtMs: T0 + 61_000, metrics: { spans: spans(60), counters: {} } }),
    );
    expect(kinds(fired)).toEqual(['first-response-regression']);
    expect(fired[0]?.message).toContain('0.1.0+aaa/bbb');
  });

  test('a spike that resolves inside the window never fires', () => {
    const e = new AlertEvaluator({}, { sendP95Ms: 30, releaseLabel: 'r' });
    e.evaluate(snap({ metrics: { spans: spans(90), counters: {} } }));
    e.evaluate(snap({ generatedAtMs: T0 + 10_000, metrics: { spans: spans(31), counters: {} } }));
    expect(
      e.evaluate(
        snap({ generatedAtMs: T0 + 120_000, metrics: { spans: spans(31), counters: {} } }),
      ),
    )
      .toEqual([]);
  });

  test('too few samples stays quiet — p95 over 3 sends means nothing', () => {
    const e = new AlertEvaluator({}, { sendP95Ms: 30, releaseLabel: 'r' });
    e.evaluate(snap({ metrics: { spans: spans(500, 3), counters: {} } }));
    expect(
      e.evaluate(
        snap({ generatedAtMs: T0 + 200_000, metrics: { spans: spans(500, 3), counters: {} } }),
      ),
    )
      .toEqual([]);
  });

  test('resetting the baseline clears a pending regression', () => {
    const e = new AlertEvaluator({}, { sendP95Ms: 30, releaseLabel: 'old' });
    e.evaluate(snap({ metrics: { spans: spans(60), counters: {} } }));
    e.setBaseline({ sendP95Ms: 60, releaseLabel: 'new' });
    expect(
      e.evaluate(
        snap({ generatedAtMs: T0 + 200_000, metrics: { spans: spans(60), counters: {} } }),
      ),
    )
      .toEqual([]);
    expect(e.baseline?.releaseLabel).toBe('new');
  });
});

describe('AlertEvaluator — LINE trigger-to-reply budget', () => {
  const lineRoundTrip = (p95: number, window = 100) => ({
    line_round_trip: {
      count: window,
      window,
      min: 1,
      p50: p95 / 2,
      p95,
      p99: p95,
      max: p95,
      mean: p95 / 2,
    },
  });

  test("fires when LINE's p95 stays above the 30ms outcome target", () => {
    const e = new AlertEvaluator({ minDurationMs: 1 });
    const metrics = { spans: {}, crossHost: lineRoundTrip(31), counters: {} };
    e.evaluate(snap({ metrics }));
    const fired = e.evaluate(snap({ generatedAtMs: T0 + 1, metrics }));

    expect(kinds(fired)).toEqual(['line-trigger-reply-budget']);
    expect(fired[0]).toMatchObject({ observed: 31, threshold: 30, severity: 'warning' });
  });

  test('keeps a compliant p95 quiet', () => {
    const e = new AlertEvaluator({ minDurationMs: 1 });
    const metrics = { spans: {}, crossHost: lineRoundTrip(30), counters: {} };
    e.evaluate(snap({ metrics }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 1, metrics }))).toEqual([]);
  });
});

describe('AlertEvaluator — failure rate', () => {
  const counters = (dispatched: number, failed: number) => ({
    'outcome.dispatched': dispatched,
    'outcome.send-failed': failed,
  });

  test('a sustained failure rate fires', () => {
    const e = new AlertEvaluator();
    const m = { spans: {}, counters: counters(70, 30) };
    e.evaluate(snap({ metrics: m }));
    const fired = e.evaluate(snap({ generatedAtMs: T0 + 61_000, metrics: m }));
    expect(kinds(fired)).toEqual(['failure-rate']);
    // 30% is more than four times the 5% threshold: page, do not just warn.
    expect(fired[0]?.severity).toBe('critical');
  });

  test('a modest failure rate is a warning, not a page', () => {
    const e = new AlertEvaluator();
    const m = { spans: {}, counters: counters(92, 8) };
    e.evaluate(snap({ metrics: m }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 61_000, metrics: m }))[0]?.severity)
      .toBe('warning');
  });

  test('two failures out of three is noise, not an alert', () => {
    const e = new AlertEvaluator();
    const m = { spans: {}, counters: counters(1, 2) };
    e.evaluate(snap({ metrics: m }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, metrics: m }))).toEqual([]);
  });
});

describe('AlertEvaluator — missed events', () => {
  // `seen` is what the alert reads (Playbook §16 / 2026-09-12 false alarm) —
  // `wins` alone cannot tell "always a moment late" from "actually dead".
  const race = (pushSeen: number, pollSeen: number, pushWins = pushSeen) => ({
    wins: { push: pushWins, 'normal-poll': 0, 'dedicated-poll': pushSeen + pollSeen - pushWins },
    seen: { push: pushSeen, 'normal-poll': 0, 'dedicated-poll': pollSeen },
    duplicatesSuppressed: 0,
    delivered: pushSeen + pollSeen,
  });

  test('with one configured source, one path winning everything is correct', () => {
    const e = new AlertEvaluator({ racedSources: 1 });
    e.evaluate(snap({ race: race(100, 0) }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, race: race(100, 0) }))).toEqual([]);
  });

  test('with two racing, one path never even seeing traffic means the other is dead', () => {
    const e = new AlertEvaluator({ racedSources: 2 });
    e.evaluate(snap({ race: race(100, 0) }));
    const fired = e.evaluate(snap({ generatedAtMs: T0 + 61_000, race: race(100, 0) }));
    expect(kinds(fired)).toEqual(['missed-events']);
    expect(fired[0]?.message).toContain('may be dead');
  });

  test('a healthy split does not fire', () => {
    const e = new AlertEvaluator({ racedSources: 2 });
    e.evaluate(snap({ race: race(60, 40) }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, race: race(60, 40) }))).toEqual([]);
  });

  test('a fast dedicated poll winning every race does not fire, as long as push still SEES traffic', () => {
    // pollIntervalMs: 0 made this fire in production on 2026-09-12: poll won
    // 100% of races, so push's win share was 0% forever, even though push
    // was still observing every message — just a moment too late every time.
    const e = new AlertEvaluator({ racedSources: 2 });
    const stillHealthy = race(/* pushSeen */ 100, /* pollSeen */ 100, /* pushWins */ 0);
    e.evaluate(snap({ race: stillHealthy }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, race: stillHealthy }))).toEqual([]);
  });
});

describe('AlertEvaluator — lanes', () => {
  const lane = (badge: 'hot' | 'standby' | 'wait' | 'down') => ({
    laneId: 0,
    workerId: 'w1',
    origin: 'o',
    badge,
    state: 'ready',
    inFlight: 0,
    applicationRttMs: undefined,
    sampleAgeMs: undefined,
    ageMs: 0,
    consecutiveFailures: 0,
  });

  test('every lane unusable is critical', () => {
    const e = new AlertEvaluator();
    const lanes = [lane('down'), lane('wait')];
    e.evaluate(snap({ lanes }));
    const fired = e.evaluate(snap({ generatedAtMs: T0 + 61_000, lanes }));
    expect(kinds(fired)).toEqual(['no-lane-available']);
    expect(fired[0]?.severity).toBe('critical');
  });

  test('one usable lane is enough to stay quiet', () => {
    const e = new AlertEvaluator();
    const lanes = [lane('down'), lane('standby')];
    e.evaluate(snap({ lanes }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, lanes }))).toEqual([]);
  });

  test('an empty pool is not an alert — nothing is configured yet', () => {
    const e = new AlertEvaluator();
    e.evaluate(snap({ lanes: [] }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 200_000, lanes: [] }))).toEqual([]);
  });
});

describe('AlertEvaluator — pending', () => {
  test('a condition being watched is visible before it fires', () => {
    const e = new AlertEvaluator();
    const m = { spans: {}, counters: { 'outcome.dispatched': 80, 'outcome.send-failed': 20 } };
    e.evaluate(snap({ metrics: m }));
    expect(e.pending.map((p) => p.kind)).toContain('failure-rate');
  });
});

describe('AlertEvaluator — CPU-starved host', () => {
  const lag = (p99: number, window = 100) => ({
    shard: 'shard-1',
    loopLagMs: { count: window, window, min: 0, p50: 1, p95: p99, p99, max: p99, mean: 1 },
  });

  test('sustained event-loop lag fires, and says what fixes it', () => {
    const e = new AlertEvaluator();
    e.evaluate(snap({ host: lag(25) }));
    const alerts = e.evaluate(snap({ generatedAtMs: T0 + 61_000, host: lag(25) }));
    expect(kinds(alerts)).toEqual(['host-cpu-starved']);
    expect(alerts[0]?.severity).toBe('warning');
    expect(alerts[0]?.message).toContain('BOT_SHARDS');
  });

  test('a healthy loop, or too few samples, stays quiet', () => {
    const e = new AlertEvaluator();
    e.evaluate(snap({ host: lag(3) }));
    expect(e.evaluate(snap({ generatedAtMs: T0 + 61_000, host: lag(3) }))).toEqual([]);
    const f = new AlertEvaluator();
    f.evaluate(snap({ host: lag(80, 5) }));
    expect(f.evaluate(snap({ generatedAtMs: T0 + 61_000, host: lag(80, 5) }))).toEqual([]);
  });
});
