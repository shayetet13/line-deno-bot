import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import type { LaneTransport } from '../../src/transport/lane.ts';
import { LANE_FORCE_HEADER, LanePool } from '../../src/transport/lane-pool.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });
const req = (): Request => new Request('https://legy.line-apps.com/enc', { method: 'POST' });
const roleReq = (role: 'send' | 'poll'): Request =>
  new Request('https://legy.line-apps.com/SQ1', {
    method: 'POST',
    headers: { 'x-line-first-lane-role': role },
  });
const forcedSendReq = (laneId: number): Request => {
  const request = roleReq('send');
  request.headers.set(LANE_FORCE_HEADER, String(laneId));
  return request;
};

/** One transport per lane; each lane's RTT (or GOAWAY) is set by lane id. */
class Fabric {
  readonly rtt = new Map<number, number>();
  readonly goaway = new Set<number>();
  readonly failures = new Map<number, Error>();
  readonly sends = new Map<number, number>();
  readonly closed = new Set<number>();
  readonly remoteOrigins = new Map<number, string>();
  readonly urls = new Map<number, string[]>();
  #nextId = 0;

  make(clock: FakeClock): (laneId: number) => LaneTransport {
    const remoteOrigins = this.remoteOrigins;
    const urlsByLane = this.urls;
    return (laneId) => {
      this.#nextId++;
      const owner = laneId;
      return {
        get remoteOrigin(): string | undefined {
          return remoteOrigins.get(owner);
        },
        fetch: (info): Promise<Response> => {
          const request = info instanceof Request ? info : new Request(info);
          const urls = urlsByLane.get(owner) ?? [];
          urls.push(request.url);
          urlsByLane.set(owner, urls);
          const failure = this.failures.get(owner);
          if (failure !== undefined) return Promise.reject(failure);
          if (this.goaway.has(owner)) {
            return Promise.reject(new Error('http2: server sent GOAWAY; LastStreamID=3'));
          }
          this.sends.set(owner, (this.sends.get(owner) ?? 0) + 1);
          clock.advance(this.rtt.get(owner) ?? 10);
          return Promise.resolve(new Response(null, { status: 200 }));
        },
        close: (): void => void this.closed.add(owner),
      };
    };
  }
  laneCount = 3;
}

const makePool = (
  clock: FakeClock,
  fabric: Fabric,
  over: Record<string, number> = {},
): LanePool =>
  new LanePool({
    clock,
    logger: silent(),
    makeTransport: fabric.make(clock),
    lanes: fabric.laneCount,
    switchMarginMs: 0.1,
    slowThresholdMs: 23,
    slowCooldownMs: 15_000,
    maxAgeMs: 900_000,
    recycleGapMs: 60_000,
    ...over,
  });

describe('LanePool — routing', () => {
  test('uses the startup preflight lane hint only for the exact requested send lane', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 10);
    fabric.rtt.set(1, 80);
    const pool = makePool(clock, fabric, { sendReservedLanes: 2 });

    await pool.fetch(forcedSendReq(1));

    expect(fabric.sends.get(0)).toBeUndefined();
    expect(fabric.sends.get(1)).toBe(1);
  });

  test('uses a passing encrypted preflight before spending a live reply on a lane', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 4;
    fabric.rtt.set(0, 80);
    fabric.rtt.set(1, 22);
    fabric.rtt.set(2, 18);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 3,
      fastRouteThresholdMs: 23,
      maxSendTailMs: 23,
    });

    await pool.fetch(forcedSendReq(0));
    await pool.fetch(forcedSendReq(1));
    await pool.fetch(forcedSendReq(2));
    fabric.sends.clear();

    // Preflight orders the first real attempt but must not contaminate the
    // send profile or score: these are different RPCs.
    expect(pool.stats.every((lane) => lane.score?.rabbits === 0)).toBe(true);
    expect(pool.stats.slice(0, 3).every((lane) => lane.medianRttMs === undefined)).toBe(true);
    expect(pool.stats[2]?.preflightRttMs).toBe(18);

    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBeUndefined();
    expect(fabric.sends.get(1)).toBeUndefined();
    expect(fabric.sends.get(2)).toBe(2);
    expect(pool.stats[2]?.score?.rabbits).toBe(2);
    expect(pool.stats[2]?.medianRttMs).toBe(18);
  });

  test('retains preflight ranking across an idle interval on the same reply transport', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 4;
    fabric.rtt.set(0, 30);
    fabric.rtt.set(1, 18);
    fabric.rtt.set(2, 12);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 3,
      sampleMaxAgeMs: 100,
    });

    for (let lane = 0; lane < 3; lane += 1) await pool.fetch(forcedSendReq(lane));
    clock.advance(101);
    fabric.sends.clear();

    // A reserved send transport is still the same warmed physical route. Its
    // read-only Square preflight must therefore continue to rank the very
    // first reply instead of falling back to lane-id/warm-HEAD ordering.
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(2)).toBe(1);
    expect(fabric.sends.get(0)).toBeUndefined();
    expect(fabric.sends.get(1)).toBeUndefined();
  });

  test('does not spend a second live reply exploring after a usable 24ms reply', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 4;
    fabric.rtt.set(0, 24);
    fabric.rtt.set(1, 25);
    fabric.rtt.set(2, 26);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 3,
      fastRouteThresholdMs: 23,
      maxSendTailMs: 27,
    });

    // A harmless preflight picks the lane for only the first live reply.
    await pool.fetch(forcedSendReq(0));
    fabric.sends.clear();

    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('send'));

    // 24ms is above the desired switch point but remains below the hard p95
    // ceiling. The second live response must retain its real measured route,
    // not gamble on a cold sibling just to search for <23ms.
    expect(fabric.sends.get(0)).toBe(2);
    expect(fabric.sends.get(1)).toBeUndefined();
    expect(fabric.sends.get(2)).toBeUndefined();
  });

  test('opens the configured number of lanes', () => {
    const fabric = new Fabric();
    const pool = makePool(new FakeClock(), fabric);
    expect(pool.stats).toHaveLength(3);
    expect(pool.stats.every((s) => s.state === 'ready')).toBe(true);
  });

  test('after measuring, routes to the lowest-RTT lane', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 30);
    fabric.rtt.set(1, 12);
    fabric.rtt.set(2, 20);
    const pool = makePool(clock, fabric);

    // First pass: unmeasured lanes are taken in order to get a sample each.
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    fabric.sends.clear();
    for (let i = 0; i < 5; i += 1) await pool.fetch(req());

    expect(fabric.sends.get(1)).toBe(5);
    expect(fabric.sends.get(0) ?? 0).toBe(0);
  });

  test('calibrates every eligible lane before choosing the fastest', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    const pool = makePool(clock, fabric, { sendReservedLanes: 0 });
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    expect([...fabric.sends.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 1]]);
  });

  test('keeps continuous poll traffic off reserved send lanes and strips the hint', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    const seenHeaders: Array<string | null> = [];
    let id = 0;
    const pool = new LanePool({
      clock,
      logger: silent(),
      lanes: 3,
      sendReservedLanes: 1,
      makeTransport: () => {
        const owner = id++;
        return {
          fetch: (request): Promise<Response> => {
            seenHeaders.push(new Request(request).headers.get('x-line-first-lane-role'));
            fabric.sends.set(owner, (fabric.sends.get(owner) ?? 0) + 1);
            clock.advance(10);
            return Promise.resolve(new Response());
          },
          close: () => {},
        };
      },
    });

    await pool.fetch(roleReq('poll'));
    await pool.fetch(roleReq('poll'));
    await pool.fetch(roleReq('send'));
    expect(fabric.sends.get(0)).toBe(1);
    expect(fabric.sends.get(1)).toBe(1);
    expect(fabric.sends.get(2)).toBe(1);
    expect(seenHeaders).toEqual([null, null, null]);
    expect(pool.stats.map((s) => s.role)).toEqual(['send', 'poll', 'poll']);
  });

  test('keeps concurrent untagged background RPCs off reply lanes and spreads their load', async () => {
    const clock = new FakeClock();
    const started: number[] = [];
    const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
    const pool = new LanePool({
      clock,
      logger: silent(),
      lanes: 4,
      sendReservedLanes: 2,
      makeTransport: (laneId) => ({
        fetch: () => {
          started.push(laneId);
          const request = Promise.withResolvers<Response>();
          pending.push(request);
          return request.promise;
        },
        close: () => {},
      }),
    });

    const first = pool.fetch(req());
    const second = pool.fetch(req());
    expect(started).toEqual([2, 3]);
    expect(pool.stats.slice(0, 2).map((lane) => lane.inFlight)).toEqual([0, 0]);

    pending.forEach(({ resolve }) => resolve(new Response()));
    await Promise.all([first, second]);
  });

  test('keeps a saturated poll from crashing the worker or borrowing a reply lane', async () => {
    const clock = new FakeClock();
    const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
    const pool = new LanePool({
      clock,
      logger: silent(),
      lanes: 3,
      sendReservedLanes: 1,
      maxPollInFlightPerLane: 1,
      makeTransport: () => ({
        fetch: () => {
          const request = Promise.withResolvers<Response>();
          pending.push(request);
          return request.promise;
        },
        close: () => {},
      }),
    });

    const first = pool.fetch(roleReq('poll'));
    const second = pool.fetch(roleReq('poll'));
    const third = pool.fetch(roleReq('poll'));
    expect(pool.stats[0]?.inFlight).toBe(0);
    expect(pool.stats.slice(1).reduce((total, lane) => total + lane.inFlight, 0)).toBe(3);
    expect(pool.stats.slice(1).every((lane) => lane.inFlight <= 2)).toBe(true);

    pending.forEach(({ resolve }) => resolve(new Response()));
    await Promise.all([first, second, third]);
  });

  test('sets HTTP priority while consuming the private lane hint in place', async () => {
    const clock = new FakeClock();
    const seen: Array<{ privateHint: string | null; priority: string | null }> = [];
    const pool = new LanePool({
      clock,
      logger: silent(),
      lanes: 2,
      sendReservedLanes: 1,
      makeTransport: () => ({
        fetch: (request): Promise<Response> => {
          const headers = new Request(request).headers;
          seen.push({
            privateHint: headers.get('x-line-first-lane-role'),
            priority: headers.get('priority'),
          });
          clock.advance(10);
          return Promise.resolve(new Response());
        },
        close: () => {},
      }),
    });

    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('poll'));

    expect(seen).toEqual([
      { privateHint: null, priority: 'u=0' },
      { privateHint: null, priority: 'u=7, i' },
    ]);
  });

  test('falls back to another role while the reserved set is parked', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 50);
    const pool = makePool(clock, fabric, { sendReservedLanes: 1 });

    // The poll partition has two proven-fast routes before the send route
    // demonstrates that it is slow.
    await pool.fetch(roleReq('poll'));
    await pool.fetch(roleReq('poll'));
    fabric.sends.clear();
    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(2);
    expect((fabric.sends.get(1) ?? 0) + (fabric.sends.get(2) ?? 0)).toBe(1);
  });

  test('does not use poll RTT as evidence for a real send', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 21);
    fabric.rtt.set(1, 16);
    fabric.rtt.set(2, 17);
    const pool = makePool(clock, fabric, { sendReservedLanes: 1 });

    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('poll'));
    await pool.fetch(roleReq('poll'));
    fabric.sends.clear();
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(1);
    expect(fabric.sends.get(1) ?? 0).toBe(0);
  });

  test('warms every reply lane without contaminating real send RTT', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 5;
    fabric.rtt.set(0, 18);
    fabric.rtt.set(1, 11);
    fabric.rtt.set(2, 14);
    fabric.rtt.set(3, 16);
    const pool = makePool(clock, fabric, { lanes: 5, sendReservedLanes: 4 });
    const warm = pool.fetchFor('send');

    for (let i = 0; i < 4; i += 1) await warm('https://legy.line-apps.com/');
    expect([...fabric.sends.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]]);
    expect(pool.stats.slice(0, 4).every((stat) => stat.medianRttMs === undefined)).toBe(true);
    expect(pool.stats.slice(0, 4).map((stat) => stat.warmRttMs)).toEqual([18, 11, 14, 16]);

    // Once all lanes have a sample, keep rotating by oldest warm timestamp;
    // do not settle forever on the lowest HEAD RTT and let the rest go cold.
    fabric.sends.clear();
    await warm('https://legy.line-apps.com/');
    expect(fabric.sends.get(0)).toBe(1);

    fabric.sends.clear();
    await pool.fetch(roleReq('send'));
    expect(fabric.sends.get(1)).toBe(1);
    expect(pool.stats[1]?.medianRttMs).toBe(11);
  });

  test('warms the origin each reply lane actually used instead of a fixed gateway', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 3;
    fabric.remoteOrigins.set(0, 'https://legy.line-apps.com');
    fabric.remoteOrigins.set(1, 'https://gf.line.naver.jp');
    const pool = makePool(clock, fabric, { lanes: 3, sendReservedLanes: 2 });
    const warm = pool.fetchFor('send');

    await warm('https://gf.line.naver.jp/enc', { method: 'HEAD' });
    await warm('https://gf.line.naver.jp/enc', { method: 'HEAD' });

    expect(fabric.urls.get(0)).toEqual(['https://legy.line-apps.com/SQ1']);
    expect(fabric.urls.get(1)).toEqual(['https://gf.line.naver.jp/enc']);
  });

  test('recalibrates stale lanes instead of routing forever on old evidence', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    const pool = makePool(clock, fabric, { sendReservedLanes: 0, sampleMaxAgeMs: 100 });
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    fabric.sends.clear();
    clock.advance(101);
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    expect([...fabric.sends.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 1]]);
  });

  test('does not switch away from the current lane on sub-margin noise', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 15);
    fabric.rtt.set(1, 15.05); // within the 0.1ms switch margin
    fabric.rtt.set(2, 40);
    const pool = makePool(clock, fabric);
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    fabric.sends.clear();
    for (let i = 0; i < 4; i += 1) await pool.fetch(req());
    // Whichever of 0/1 got picked first keeps it — no ping-pong.
    const picked = (fabric.sends.get(0) ?? 0) + (fabric.sends.get(1) ?? 0);
    expect(picked).toBe(4);
    expect(Math.max(fabric.sends.get(0) ?? 0, fabric.sends.get(1) ?? 0)).toBe(4);
  });
});

describe('LanePool — health', () => {
  test('does not park a send lane after one slow spike', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 50);
    const pool = makePool(clock, fabric, { sendReservedLanes: 1 });

    await pool.fetch(roleReq('send'));
    expect(pool.stats[0]?.available).toBe(true);
    fabric.rtt.set(0, 10);
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(2);
    expect(pool.stats[0]?.available).toBe(true);
  });

  test('parks after consecutive slow sends even while the rolling median is fast', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 2;
    fabric.rtt.set(0, 10);
    fabric.rtt.set(1, 20);
    const pool = makePool(clock, fabric, { lanes: 2, sendReservedLanes: 1 });

    for (let i = 0; i < 3; i += 1) await pool.fetch(roleReq('send'));
    fabric.rtt.set(0, 50);
    await pool.fetch(roleReq('send'));
    expect(pool.stats[0]?.available).toBe(true);
    await pool.fetch(roleReq('send'));
    expect(pool.stats[0]?.medianRttMs).toBe(10);
    expect(pool.stats[0]?.available).toBe(false);
    fabric.sends.clear();
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0) ?? 0).toBe(0);
    expect(fabric.sends.get(1)).toBe(1);
  });

  test('never parks poll lanes based on response duration', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(1, 50);
    fabric.rtt.set(2, 50);
    const pool = makePool(clock, fabric, { sendReservedLanes: 1 });

    for (let i = 0; i < 6; i += 1) await pool.fetch(roleReq('poll'));

    expect(pool.stats.slice(1).every((stat) => stat.available)).toBe(true);
    expect(fabric.sends.get(0) ?? 0).toBe(0);
  });

  test('never parks the last routable lane', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 1;
    fabric.rtt.set(0, 80);
    const pool = makePool(clock, fabric, { lanes: 1 });
    for (let i = 0; i < 3; i += 1) await pool.fetch(roleReq('send'));
    expect(fabric.sends.get(0)).toBe(3); // still used despite being slow
  });

  test('a GOAWAY drains and recycles the lane', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    // Untagged/control traffic lives in the non-reply band when replies are
    // reserved, so lane 1 is the first eligible route here.
    fabric.goaway.add(1);
    fabric.rtt.set(1, 10);
    fabric.rtt.set(2, 10);
    const pool = makePool(clock, fabric);
    await expect(pool.fetch(req())).rejects.toThrow(/GOAWAY/);
    fabric.goaway.delete(1);
    for (let i = 0; i < 3; i += 1) await pool.fetch(req());
    expect(pool.stats.every((s) => s.state === 'ready')).toBe(true);
    expect(fabric.closed.has(1)).toBe(true); // old transport was closed on recycle
  });

  test('a peer-closed HTTP/2 session is recycled instead of retried forever', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.failures.set(1, new Error('HTTP/2 lane to 2400:dcc0::2 is closed'));
    const pool = makePool(clock, fabric);

    await expect(pool.fetch(roleReq('poll'))).rejects.toThrow(/is closed/);
    expect(fabric.closed.has(1)).toBe(true);
    expect(pool.stats[1]?.consecutiveFailures).toBe(0);

    // The replacement is usable and no longer inherits the dead route's
    // failure count or stale timing evidence.
    fabric.failures.delete(1);
    await pool.fetch(roleReq('poll'));
    expect(pool.stats[1]?.state).toBe('ready');
    expect(pool.stats[1]?.consecutiveFailures).toBe(0);
  });

  test('recycles the oldest lane once it passes maxAge, then waits recycleGap', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    for (const id of [0, 1, 2]) fabric.rtt.set(id, 10);
    const pool = makePool(clock, fabric, { maxAgeMs: 1_000, recycleGapMs: 5_000 });
    await pool.fetch(req());
    fabric.closed.clear();
    clock.advance(2_000); // every lane is now past maxAge

    await pool.maintain('https://legy.line-apps.com/SQ1');
    expect(fabric.closed.size).toBe(1); // exactly one recycled
    clock.advance(1_000); // still inside recycleGap
    await pool.maintain('https://legy.line-apps.com/SQ1');
    expect(fabric.closed.size).toBe(1);
    clock.advance(5_000); // gap elapsed
    await pool.maintain('https://legy.line-apps.com/SQ1');
    expect(fabric.closed.size).toBe(2);
  });

  test('keeps reserved reply lanes warm during age refresh', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      maxAgeMs: 1_000,
      recycleGapMs: 0,
    });

    await pool.fetch(roleReq('send'));
    fabric.closed.clear();
    clock.advance(2_000);

    // The aged poll lane may be refreshed, but a reserved SEND lane must not
    // be replaced underneath the next one-shot reply.
    await pool.maintain('https://legy.line-apps.com/SQ1');
    expect(fabric.closed).toEqual(new Set([2]));
  });
});

describe('LanePool — lifecycle', () => {
  test('close shuts every lane', () => {
    const fabric = new Fabric();
    const pool = makePool(new FakeClock(), fabric);
    pool.close();
    expect(fabric.closed.size).toBe(3);
    expect(pool.stats.every((s) => s.state === 'dead')).toBe(true);
  });

  test('rejects an invalid lane count', () => {
    expect(() =>
      new LanePool({
        clock: new FakeClock(),
        logger: silent(),
        makeTransport: () => ({ fetch: () => Promise.resolve(new Response()), close: () => {} }),
        lanes: 0,
      })
    ).toThrow(ConfigError);
  });

  test('rejects an invalid consecutive-slow sample count', () => {
    expect(() =>
      new LanePool({
        clock: new FakeClock(),
        logger: silent(),
        makeTransport: () => ({ fetch: () => Promise.resolve(new Response()), close: () => {} }),
        lanes: 2,
        slowSamplesBeforeCooldown: 0,
      })
    ).toThrow(ConfigError);
  });
});

/**
 * Lanes keep a running record in rabbits (a reply that came back inside the
 * fast-route threshold) and turtles (one that did not, on a lane it had to
 * itself). The record is what separates two lanes whose measured RTTs are too
 * close to call, and the threshold is what decides when replies stop using a
 * lane at all.
 */
describe('LanePool — lane scoring', () => {
  const scoringPool = (clock: FakeClock, fabric: Fabric, over: Record<string, number> = {}) =>
    makePool(clock, fabric, { sendReservedLanes: 2, fastRouteThresholdMs: 12, ...over });

  test('a fast reply earns the lane a rabbit', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 8);
    const pool = scoringPool(clock, fabric);

    await pool.fetch(roleReq('send'));

    expect(pool.stats[0]?.score).toEqual({ rabbits: 1, turtles: 0, contendedSlow: 0 });
  });

  test('a slow reply on an idle lane earns it a turtle', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 20);
    const pool = scoringPool(clock, fabric);

    await pool.fetch(roleReq('send'));

    expect(pool.stats[0]?.score).toEqual({ rabbits: 0, turtles: 1, contendedSlow: 0 });
  });

  test('poll and warm traffic never score — neither says anything about a reply route', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(2, 300); // a long-poll legitimately waiting at LINE
    const pool = scoringPool(clock, fabric);

    await pool.fetch(roleReq('poll'));
    await pool.fetchFor('send')('https://legy.line-apps.com/');

    expect(pool.stats.every((s) => s.score?.turtles === 0)).toBe(true);
    expect(pool.stats.every((s) => s.score?.rabbits === 0)).toBe(true);
  });

  test('recycling a lane clears its record — a fresh route has not earned it', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 8);
    const pool = scoringPool(clock, fabric);

    await pool.fetch(roleReq('send'));
    expect(pool.stats[0]?.score?.rabbits).toBe(1);

    fabric.goaway.add(0);
    await expect(pool.fetch(roleReq('send'))).rejects.toThrow(/GOAWAY/);

    expect(pool.stats[0]?.score).toEqual({ rabbits: 0, turtles: 0, contendedSlow: 0 });
    expect(pool.stats[0]?.currentSend).toBe(false);
  });
});

describe('LanePool — reply lane stickiness', () => {
  const scoringPool = (clock: FakeClock, fabric: Fabric, over: Record<string, number> = {}) =>
    makePool(clock, fabric, { sendReservedLanes: 2, fastRouteThresholdMs: 12, ...over });

  test('stays on a lane that keeps coming back fast, even when another is faster', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 10); // fast enough
    fabric.rtt.set(1, 4); // faster, but switching costs a cold connection
    const pool = scoringPool(clock, fabric);

    for (let i = 0; i < 4; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(4);
    expect(fabric.sends.get(1)).toBeUndefined();
    expect(pool.stats[0]?.currentSend).toBe(true);
  });

  test('a reply over the threshold unpins the lane, and the next one moves', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 20); // over the threshold from the start
    fabric.rtt.set(1, 5);
    const pool = scoringPool(clock, fabric);

    await pool.fetch(roleReq('send')); // lane 0, slow: turtle + unpin
    expect(pool.stats[0]?.score?.turtles).toBe(1);
    expect(pool.stats[0]?.currentSend).toBe(false);

    await pool.fetch(roleReq('send')); // lane 0 is measured and too slow, so try lane 1

    expect(fabric.sends.get(1)).toBe(1);
    expect(pool.stats[1]?.currentSend).toBe(true);
    expect(pool.stats[1]?.score?.rabbits).toBe(1);
  });

  test('a raw breach moves even when the old lane median still looks fast', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 10);
    fabric.rtt.set(1, 8);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      fastRouteThresholdMs: 20,
    });

    for (let i = 0; i < 4; i += 1) await pool.fetch(roleReq('send'));
    // A 21–22ms sample is ordinary jitter around the 20ms target.  It must
    // not evict a route; use a material raw breach here.
    fabric.rtt.set(0, 24);
    await pool.fetch(roleReq('send'));
    expect(pool.stats[0]?.medianRttMs).toBe(10);
    expect(pool.stats[0]?.routeEligible).toBe(false);

    await pool.fetch(roleReq('send'));
    expect(fabric.sends.get(1)).toBe(1);
    expect(pool.stats.find((lane) => lane.currentSend)?.id).toBe(1);

    clock.advance(15_001);
    expect(pool.stats[0]?.routeEligible).toBe(true);
  });

  test('normal 21ms jitter does not bypass a route whose p50 and p95 are still fast', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 18);
    fabric.rtt.set(1, 19);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      fastRouteThresholdMs: 20,
      maxSendTailMs: 27,
    });

    for (let i = 0; i < 4; i += 1) await pool.fetch(roleReq('send'));
    fabric.rtt.set(0, 21);
    await pool.fetch(roleReq('send'));
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(6);
    expect(fabric.sends.get(1)).toBeUndefined();
    expect(pool.stats[0]?.routeEligible).toBe(true);
  });

  test('keeps the 27ms tail ceiling separate from a 23ms switch line', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 24);
    fabric.rtt.set(1, 18);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      fastRouteThresholdMs: 23,
      // Deliberately omit maxSendTailMs: production must retain its 27ms
      // tail ceiling instead of silently using the 23ms switch line.
    });

    await pool.fetch(roleReq('send'));

    expect(pool.stats[0]?.tailRttMs).toBe(24);
    expect(pool.stats[0]?.routeEligible).toBe(true);
  });

  test('reserved reply evidence stays valid for the lifetime of its physical route', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 4;
    for (const id of [0, 1, 2, 3]) fabric.rtt.set(id, 10);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      fastRouteThresholdMs: 20,
      sampleMaxAgeMs: 100,
      maxAgeMs: 1,
      recycleGapMs: 0,
    });

    await pool.fetch(roleReq('send')); // lane 0 becomes the proven reply route
    expect(pool.stats[0]?.score?.rabbits).toBe(1);
    expect(pool.stats[0]?.currentSend).toBe(true);

    // Give lane 1 the lower HEAD number. The first reply after a long idle
    // must still use lane 0: HEAD is not evidence that lane 1 sends faster.
    fabric.rtt.set(0, 10);
    fabric.rtt.set(1, 1);
    const warm = pool.fetchFor('send');
    await warm('https://legy.line-apps.com/SQ1', { method: 'HEAD' });
    await warm('https://legy.line-apps.com/SQ1', { method: 'HEAD' });
    clock.advance(101);
    fabric.sends.clear();
    await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(1);
    expect(fabric.sends.get(1) ?? 0).toBe(0);
    expect(pool.stats[0]?.score?.rabbits).toBe(2);
    expect(pool.stats[0]?.currentSend).toBe(true);
    expect(fabric.closed.has(0)).toBe(false);
  });

  test('once a fast lane is found it is kept, and the slow one is left alone', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 20);
    fabric.rtt.set(1, 5);
    const pool = scoringPool(clock, fabric);

    for (let i = 0; i < 5; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(1); // tried once, ruled out
    expect(fabric.sends.get(1)).toBe(4);
  });

  test('permanently rejects a proven losing tail instead of retrying it after cooldown', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 3;
    fabric.rtt.set(0, 80);
    fabric.rtt.set(1, 18);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      fastRouteThresholdMs: 20,
      maxSendTailMs: 27,
    });

    await pool.fetch(roleReq('send')); // lane 0: severe tail
    await pool.fetch(roleReq('send')); // lane 1: the safe route
    clock.advance(30_000); // longer than the temporary raw-breach cooldown
    for (let i = 0; i < 4; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(1);
    expect(fabric.sends.get(1)).toBe(5);
    expect(pool.stats[0]?.routeEligible).toBe(false);
  });

  test('when no lane can clear the threshold it settles on the least-bad one', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.rtt.set(0, 20);
    fabric.rtt.set(1, 16);
    const pool = scoringPool(clock, fabric);

    for (let i = 0; i < 6; i += 1) await pool.fetch(roleReq('send'));

    // Both explored, neither qualifies, so the faster of the two takes the
    // traffic rather than the pool flapping between them forever.
    expect(fabric.sends.get(1)).toBeGreaterThan(fabric.sends.get(0) ?? 0);
  });
});

/** A lane shared by two replies at once measures the queue, not the route.
 * Unpinning on that would send the pool hunting for a new lane every time two
 * replies happened to overlap — which is exactly when moving is most costly. */
describe('LanePool — contention does not unpin', () => {
  class GatedFabric {
    laneCount = 2;
    readonly #gates: (() => void)[] = [];
    readonly sends = new Map<number, number>();
    #nextId = 0;
    constructor(private readonly clock: FakeClock, private readonly rttMs: number) {}
    make(): () => LaneTransport {
      return () => {
        const owner = this.#nextId++ % this.laneCount;
        return {
          fetch: (): Promise<Response> =>
            new Promise((resolve) => {
              this.sends.set(owner, (this.sends.get(owner) ?? 0) + 1);
              this.#gates.push(() => {
                this.clock.advance(this.rttMs);
                resolve(new Response(null, { status: 200 }));
              });
            }),
          close: (): void => {},
        };
      };
    }
    releaseAll(): void {
      for (const gate of this.#gates.splice(0)) gate();
    }
  }

  test('two slow replies sharing one lane leave it pinned and turtle-free', async () => {
    const clock = new FakeClock();
    const fabric = new GatedFabric(clock, 30); // well over the threshold
    const pool = new LanePool({
      clock,
      logger: silent(),
      makeTransport: fabric.make(),
      lanes: 2,
      sendReservedLanes: 1,
      fastRouteThresholdMs: 12,
      slowThresholdMs: 23,
      slowSamplesBeforeCooldown: 2,
    });

    const first = pool.fetch(roleReq('send'));
    const second = pool.fetch(roleReq('send'));
    fabric.releaseAll();
    await Promise.all([first, second]);

    const lane0 = pool.stats[0];
    expect(lane0?.score).toEqual({ rabbits: 0, turtles: 0, contendedSlow: 2 });
    expect(lane0?.currentSend).toBe(true);
    // And nothing was parked either: a queue is not a failing route.
    expect(lane0?.available).toBe(true);
  });
});

/**
 * Spares are reply lanes held back on purpose. Ordinary replies must never
 * touch them — concentrating traffic on one primary lane is what keeps that
 * connection hot — but a reply must never queue behind another when an idle
 * lane exists, which is the case several bots answering at once produces.
 */
describe('LanePool — spare reply lanes', () => {
  /** 2 primary reply lanes (#0,#1), 2 spares (#2,#3), rest poll. */
  const sparePool = (clock: FakeClock, fabric: Fabric, over: Record<string, number> = {}) =>
    makePool(clock, fabric, {
      sendReservedLanes: 4,
      sendSpareLanes: 2,
      fastRouteThresholdMs: 20,
      ...over,
    });

  test('ordinary replies stay on the primary lanes and never touch a spare', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 6;
    for (const id of [0, 1, 2, 3, 4, 5]) fabric.rtt.set(id, 10);
    const pool = sparePool(clock, fabric);

    for (let i = 0; i < 6; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(2)).toBeUndefined();
    expect(fabric.sends.get(3)).toBeUndefined();
    expect((fabric.sends.get(0) ?? 0) + (fabric.sends.get(1) ?? 0)).toBe(6);
  });

  test('marks which lanes are spares without changing their role', () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 6;
    const pool = sparePool(clock, fabric);

    const spares = pool.stats.filter((s) => s.spare === true).map((s) => s.id);
    expect(spares).toEqual([2, 3]);
    // Still reply lanes: measured and badged as send, just held back.
    expect(pool.stats.filter((s) => s.spare === true).every((s) => s.role === 'send')).toBe(true);
  });

  test('a spare answers when every primary lane is already busy', async () => {
    const clock = new FakeClock();
    // Gated so the first two replies are still in flight when the third lands.
    const gates: (() => void)[] = [];
    let nextId = 0;
    const laneCount = 6;
    const sends = new Map<number, number>();
    const pool = new LanePool({
      clock,
      logger: silent(),
      makeTransport: () => {
        const owner = nextId++ % laneCount;
        return {
          fetch: (request): Promise<Response> => {
            if (new Request(request).method === 'HEAD') {
              clock.advance(1);
              return Promise.resolve(new Response(null, { status: 404 }));
            }
            return new Promise((resolve) => {
              sends.set(owner, (sends.get(owner) ?? 0) + 1);
              gates.push(() => {
                clock.advance(10);
                resolve(new Response(null, { status: 200 }));
              });
            });
          },
          close: (): void => {},
        };
      },
      lanes: laneCount,
      sendReservedLanes: 4,
      sendSpareLanes: 2,
      fastRouteThresholdMs: 20,
    });

    // Startup primes the whole reply band so a burst never uses a real reply
    // to pay a cold connection handshake.
    await pool.primeSendLanes('https://legy.line-apps.com/SQ1');

    // Prime lane #0 with one real RPC so a fast primary lane exists, which is
    // what makes the overflow branch reachable at all.
    const first = pool.fetch(roleReq('send'));
    gates.splice(0).forEach((g) => g());
    await first;
    expect(sends.get(0)).toBe(1);

    // Three overlapping replies: #0 then #1 (both primary), then a spare.
    const a = pool.fetch(roleReq('send'));
    const b = pool.fetch(roleReq('send'));
    const c = pool.fetch(roleReq('send'));

    // Asserted while all three are still in flight, which is the only moment
    // the overflow decision is observable: releasing the gates first would
    // advance the fake clock once per gate, so every reply would measure the
    // whole burst's duration and break the pin on its own merits.
    expect((sends.get(2) ?? 0) + (sends.get(3) ?? 0)).toBe(1);
    expect(sends.get(0)).toBe(2); // one from priming, one from this burst
    expect(sends.get(1)).toBe(1); // the idle primary lane came before any spare
    // The pin stayed on the primary lane — overflow is not a change of choice.
    expect(pool.stats.find((s) => s.currentSend)?.id).toBe(0);

    gates.splice(0).forEach((g) => g());
    await Promise.all([a, b, c]);
  });

  // Regression for the 2026-09-12 production behaviour: with no primary lane
  // able to clear the threshold, the pool walked live replies onto spare after
  // spare looking for one that could, and two of them answered in ~80ms. A
  // reply is not a probe. Spares stay out of it, and the pool settles on the
  // least-bad primary instead of shopping around.
  test('a slow primary band never spends replies probing spares', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 6;
    // Over the 20ms fast line but under the 23ms parking line, so the lanes
    // stay in play: this is about routing, not about the cooldown.
    fabric.rtt.set(0, 22);
    fabric.rtt.set(1, 21);
    fabric.rtt.set(2, 8); // a spare that would look better, if anyone asked
    fabric.rtt.set(3, 8);
    const pool = sparePool(clock, fabric);

    for (let i = 0; i < 8; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(2)).toBeUndefined();
    expect(fabric.sends.get(3)).toBeUndefined();
    // There is no safe way to discover that lane #1 is 1ms faster without
    // spending a real response on it. A measured, tail-safe #0 therefore wins
    // every later response instead of turning user messages into probes.
    expect(fabric.sends.get(0)).toBe(8);
    expect(fabric.sends.get(1)).toBeUndefined();
  });

  test('a lane that answered slowly is not picked again while a faster one exists', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 6;
    fabric.rtt.set(0, 80); // the 80ms lane production kept coming back to
    fabric.rtt.set(1, 21);
    const pool = sparePool(clock, fabric);

    for (let i = 0; i < 10; i += 1) await pool.fetch(roleReq('send'));

    expect(fabric.sends.get(0)).toBe(1); // timed once, then never again
    expect(fabric.sends.get(1)).toBe(9);
  });

  test('zero spares keeps the previous behaviour exactly', async () => {
    const clock = new FakeClock();
    const fabric = new Fabric();
    fabric.laneCount = 4;
    for (const id of [0, 1, 2, 3]) fabric.rtt.set(id, 10);
    const pool = makePool(clock, fabric, {
      sendReservedLanes: 2,
      sendSpareLanes: 0,
      fastRouteThresholdMs: 20,
    });

    for (let i = 0; i < 4; i += 1) await pool.fetch(roleReq('send'));

    expect(pool.stats.every((s) => s.spare === false)).toBe(true);
    expect(fabric.sends.get(0)).toBe(4); // pinned, as before
  });

  test('rejects spares that would leave no primary reply lane', () => {
    expect(() =>
      new LanePool({
        clock: new FakeClock(),
        logger: silent(),
        makeTransport: () => ({ fetch: () => Promise.resolve(new Response()), close: () => {} }),
        lanes: 6,
        sendReservedLanes: 2,
        sendSpareLanes: 2,
      })
    ).toThrow(ConfigError);
  });
});
