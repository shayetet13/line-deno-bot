import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger, type LogRecord } from '../../src/logging/logger.ts';
import type { LaneTransport } from '../../src/transport/lane.ts';
import { LANE_FORCE_HEADER, LANE_ROLE_HEADER, LanePool } from '../../src/transport/lane-pool.ts';
import { ReplyRouteScout, type ReplyScoutOptions } from '../../src/transport/reply-scout.ts';

const ORIGIN = 'https://legy.line-apps.com/SQ1';

const sendReq = (): Request =>
  new Request(ORIGIN, { method: 'POST', headers: { [LANE_ROLE_HEADER]: 'send' } });

const probeReq = (laneId: number): Request =>
  new Request(ORIGIN, {
    method: 'POST',
    headers: { [LANE_ROLE_HEADER]: 'send', [LANE_FORCE_HEADER]: String(laneId) },
  });

/**
 * Each physical connection gets its RTT from `rttFor(lane, generation)`, so a
 * re-rolled lane can land on a faster (or slower) backend than before. A
 * request can also be held open with `hold` to simulate one in flight.
 */
class Edge {
  readonly generation = new Map<number, number>();
  readonly sends = new Map<number, number>();
  readonly heads = new Map<number, number>();
  readonly closed: Array<{ lane: number; generation: number }> = [];
  rttFor: (lane: number, generation: number) => number = () => 10;
  hold: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
  holdLane: number | undefined;

  make(clock: FakeClock): (laneId: number) => LaneTransport {
    return (laneId) => {
      const generation = (this.generation.get(laneId) ?? -1) + 1;
      this.generation.set(laneId, generation);
      return {
        fetch: (info): Promise<Response> => {
          const request = info instanceof Request ? info : new Request(info);
          const counter = request.method === 'HEAD' ? this.heads : this.sends;
          counter.set(laneId, (counter.get(laneId) ?? 0) + 1);
          if (this.hold !== undefined && this.holdLane === laneId && request.method !== 'HEAD') {
            return this.hold.promise;
          }
          clock.advance(this.rttFor(laneId, generation));
          return Promise.resolve(new Response(null, { status: 200 }));
        },
        close: (): void => void this.closed.push({ lane: laneId, generation }),
      };
    };
  }
}

const records: LogRecord[] = [];
const logger = (): Logger => new Logger({ level: 'debug', sink: (r) => void records.push(r) });

const setup = (
  rtt: (lane: number, generation: number) => number,
  over: Partial<ReplyScoutOptions> = {},
  pool: { sendReservedLanes?: number; sendSpareLanes?: number; lanes?: number } = {},
) => {
  const clock = new FakeClock();
  const edge = new Edge();
  edge.rttFor = rtt;
  const lanePool = new LanePool({
    clock,
    logger: logger(),
    makeTransport: edge.make(clock),
    lanes: pool.lanes ?? 5,
    sendReservedLanes: pool.sendReservedLanes ?? 3,
    sendSpareLanes: pool.sendSpareLanes ?? 1,
    fastRouteThresholdMs: 20,
  });
  const probes: number[] = [];
  const scout = new ReplyRouteScout({
    pool: lanePool,
    probe: async (laneId) => {
      probes.push(laneId);
      const response = await lanePool.fetch(probeReq(laneId));
      await response.body?.cancel();
    },
    clock,
    logger: logger(),
    warmOrigin: ORIGIN,
    quietAfterSendMs: 300,
    rerollIntervalMs: 30_000,
    ...over,
  });
  /** Probes every reply lane `rounds` times, as the startup preflight does. */
  const calibrate = async (rounds = 3): Promise<void> => {
    for (let i = 0; i < rounds * 3; i += 1) {
      await scout.tick();
      clock.advance(1_000);
    }
  };
  return { clock, edge, pool: lanePool, scout, probes, calibrate };
};

describe('ReplyRouteScout — ranking and pinning', () => {
  test('pins the fastest reply lane before any reply, even when it is the spare', async () => {
    const { pool, edge, calibrate } = setup((lane) => [22, 24, 18][lane] ?? 30);

    await calibrate();
    edge.sends.clear();
    await pool.fetch(sendReq());

    expect(pool.currentSendLaneId).toBe(2);
    expect(edge.sends.get(2)).toBe(1);
    expect(pool.stats[2]?.pinnedBy).toBe('scout');
  });

  test('probes the lane with the oldest evidence, so every reply lane stays measured', async () => {
    const { probes, calibrate } = setup(() => 10);

    await calibrate(2);

    expect(probes).toEqual([0, 1, 2, 0, 1, 2]);
  });

  test('holds the pin against a challenger inside the switch margin', async () => {
    let lane1 = 12;
    const { pool, calibrate, scout, clock } = setup((lane) => lane === 1 ? lane1 : 10, {
      switchMarginMs: 0.5,
    });
    await calibrate();
    expect(pool.currentSendLaneId).toBe(0);

    lane1 = 9.8; // 0.2ms faster: noise, not a better route
    for (let i = 0; i < 12; i += 1) {
      await scout.tick();
      clock.advance(1_000);
    }

    expect(pool.currentSendLaneId).toBe(0);
    expect(scout.status.switches).toBe(0);
  });

  test('moves to a clearly faster lane only after consecutive confirmations', async () => {
    let lane1 = 14;
    const { pool, calibrate, scout, clock } = setup((lane) => lane === 1 ? lane1 : 12, {
      switchConfirmations: 3,
    });
    await calibrate();
    expect(pool.currentSendLaneId).toBe(0);

    lane1 = 8;
    // Until lane 1's window is majority-fast its predicted RTT does not beat
    // lane 0; then three evaluations in a row must agree.
    const seen: Array<number | undefined> = [];
    for (let i = 0; i < 15; i += 1) {
      await scout.tick();
      seen.push(pool.currentSendLaneId);
      clock.advance(1_000);
    }

    const firstMove = seen.indexOf(1);
    expect(firstMove).toBeGreaterThan(0);
    expect(scout.status.switches).toBe(1);
    expect(seen.slice(firstMove).every((lane) => lane === 1)).toBe(true);
  });

  test('never overrules the router: a lane over the tail ceiling cannot be pinned', async () => {
    const { pool, calibrate, edge } = setup((lane) => lane === 2 ? 5 : 15);
    // Lane 2 answers a real reply badly: the tail ceiling now excludes it.
    await calibrate();
    edge.rttFor = (lane) => lane === 2 ? 60 : 15;
    await pool.fetch(sendReq()); // lands on the pinned lane 2, breaches
    expect(pool.promoteSendLane(2)).toBe(false);
    edge.rttFor = (lane) => lane === 2 ? 5 : 15;

    expect(pool.replyLaneViews()[2]?.eligible).toBe(false);
  });
});

describe('ReplyRouteScout — staying off the reply path', () => {
  test('does not probe while a reply is on the wire or just after one started', async () => {
    const { pool, scout, clock, probes, edge, calibrate } = setup(() => 10);
    await calibrate(1);
    probes.length = 0;

    edge.hold = Promise.withResolvers<Response>();
    edge.holdLane = pool.currentSendLaneId ?? 0;
    const reply = pool.fetch(sendReq());
    await scout.tick();
    expect(probes).toEqual([]);

    edge.hold.resolve(new Response(null));
    await reply;
    edge.hold = undefined;
    clock.advance(100); // still inside quietAfterSendMs
    await scout.tick();
    expect(probes).toEqual([]);
    expect(scout.status.skippedForReplies).toBe(2);

    clock.advance(300);
    await scout.tick();
    expect(probes.length).toBe(1);
  });

  test('a probe in flight on the pinned lane does not push a reply onto a slower lane', async () => {
    const { pool, edge, calibrate } = setup((lane) => [10, 20, 25][lane] ?? 30);
    await calibrate();
    expect(pool.currentSendLaneId).toBe(0);

    edge.hold = Promise.withResolvers<Response>();
    edge.holdLane = 0;
    const probe = pool.fetch(probeReq(0));
    const reply = pool.fetch(sendReq());
    edge.hold.resolve(new Response(null));
    await Promise.all([probe, reply]);

    // Both requests went to lane 0 — the reply multiplexed beside the probe.
    expect(edge.sends.get(0)).toBe(3 + 2);
    expect(edge.sends.get(1)).toBe(3);
  });
});

describe('ReplyRouteScout — searching for a faster connection', () => {
  test('re-rolls the slowest unpinned lane onto a new connection and adopts it when faster', async () => {
    // Lane 1's first connection is slow; its second lands on a fast backend.
    const { pool, edge, scout, clock, calibrate } = setup(
      (lane, generation) => lane === 1 ? (generation === 0 ? 30 : 6) : lane === 0 ? 12 : 13,
      { switchConfirmations: 1, rerollGapMs: 2 },
    );
    await calibrate();
    expect(pool.currentSendLaneId).toBe(0);

    clock.advance(30_000);
    await scout.tick();

    expect(edge.closed).toContainEqual({ lane: 1, generation: 0 });
    expect(edge.generation.get(1)).toBe(1);
    expect(edge.heads.get(1)).toBe(1); // TCP/TLS paid before any probe
    expect(scout.status.rerolls).toBe(1);
    expect(pool.currentSendLaneId).toBe(1);
    expect(pool.replyLaneViews()[1]?.usable).toBe(true);
  });

  test('keeps a re-rolled lane hidden from replies until it has been measured', async () => {
    const { pool, edge, scout, clock, calibrate } = setup(
      (lane) => lane === 1 ? 30 : lane === 0 ? 12 : 13,
      { rerollProbes: 2 },
    );
    await calibrate();
    let hiddenDuringProbe: boolean | undefined;
    const originalRtt = edge.rttFor;
    edge.rttFor = (lane, generation) => {
      if (lane === 1 && generation === 1) {
        hiddenDuringProbe ??= pool.replyLaneViews()[1]?.usable === false;
      }
      return originalRtt(lane, generation);
    };

    clock.advance(30_000);
    await scout.tick();

    expect(hiddenDuringProbe).toBe(true);
    expect(pool.replyLaneViews()[1]?.usable).toBe(true);
  });

  test('never re-rolls the pinned lane, and waits out the re-roll interval', async () => {
    const { edge, scout, clock, calibrate } = setup(
      (lane) => lane === 1 ? 30 : lane === 0 ? 12 : 13,
      { rerollIntervalMs: 30_000 },
    );
    await calibrate();
    clock.advance(30_000);
    await scout.tick(); // re-rolls lane 1 (still slow on its new connection)
    await scout.tick();
    clock.advance(10_000);
    await scout.tick();

    expect(scout.status.rerolls).toBe(1);
    expect(edge.closed.some((c) => c.lane === 0)).toBe(false);
  });

  test('does not re-roll when every lane is within the gap', async () => {
    const { scout, clock, calibrate } = setup((lane) => 12 + lane * 0.5, { rerollGapMs: 2 });
    await calibrate();
    clock.advance(30_000);
    await scout.tick();

    expect(scout.status.rerolls).toBe(0);
  });
});

describe('ReplyRouteScout — lifecycle', () => {
  test('runs on its timer and stops cleanly', () => {
    const { pool } = setup(() => 10);
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    const scout = new ReplyRouteScout({
      pool,
      probe: () => Promise.resolve(),
      clock: new FakeClock(),
      logger: logger(),
      warmOrigin: ORIGIN,
      timer: {
        set: (cb) => timers.push(cb),
        clear: (handle) => void cleared.push(handle),
      },
    });
    const controller = new AbortController();
    scout.start(controller.signal);
    expect(timers.length).toBe(1);
    expect(scout.status.running).toBe(true);
    controller.abort();
    expect(scout.status.running).toBe(false);
    expect(cleared.length).toBe(1);
  });

  test('rejects nonsensical configuration', () => {
    const { pool } = setup(() => 10);
    const base = {
      pool,
      probe: () => Promise.resolve(),
      clock: new FakeClock(),
      logger: logger(),
      warmOrigin: ORIGIN,
    };
    expect(() => new ReplyRouteScout({ ...base, intervalMs: 0 })).toThrow(ConfigError);
    expect(() => new ReplyRouteScout({ ...base, switchConfirmations: 0 })).toThrow(ConfigError);
  });

  test('a failed probe is counted, not thrown', async () => {
    const { pool } = setup(() => 10);
    const scout = new ReplyRouteScout({
      pool,
      probe: () => Promise.reject(new Error('boom')),
      clock: new FakeClock(),
      logger: logger(),
      warmOrigin: ORIGIN,
    });
    await scout.tick();
    expect(scout.status.probeFailures).toBe(1);
  });
});

describe('LanePool — saturation warning', () => {
  test('warns once per interval instead of once per multiplexed poll', async () => {
    const clock = new FakeClock();
    const warnings: LogRecord[] = [];
    const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
    const pool = new LanePool({
      clock,
      logger: new Logger({ level: 'warn', sink: (r) => void warnings.push(r) }),
      lanes: 2,
      sendReservedLanes: 1,
      makeTransport: () => ({
        fetch: () => {
          const request = Promise.withResolvers<Response>();
          pending.push(request);
          return request.promise;
        },
        close: () => {},
      }),
    });
    const pollReq = (): Request =>
      new Request(ORIGIN, { method: 'POST', headers: { [LANE_ROLE_HEADER]: 'poll' } });

    const inFlight = [pool.fetch(pollReq())];
    for (let i = 0; i < 5; i += 1) inFlight.push(pool.fetch(pollReq()));
    clock.advance(60_000);
    inFlight.push(pool.fetch(pollReq()));

    const saturation = warnings.filter((r) => r.msg.includes('saturated'));
    expect(saturation.length).toBe(2);
    expect(saturation[1]?.['suppressedSinceLastWarning']).toBe(4);
    pending.forEach(({ resolve }) => resolve(new Response()));
    await Promise.all(inFlight);
  });
});
