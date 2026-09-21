import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { Lane, type LaneTransport } from '../../src/transport/lane.ts';

/** A transport whose reply latency is whatever the clock is told to advance. */
class FakeTransport implements LaneTransport {
  closed = 0;
  #rttMs: number;
  #fail = false;
  constructor(private readonly clock: FakeClock, rttMs = 10) {
    this.#rttMs = rttMs;
  }
  setRtt(ms: number): void {
    this.#rttMs = ms;
  }
  failNext(): void {
    this.#fail = true;
  }
  fetch(): Promise<Response> {
    if (this.#fail) {
      this.#fail = false;
      return Promise.reject(new Error('http2: server sent GOAWAY'));
    }
    this.clock.advance(this.#rttMs);
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  close(): void {
    this.closed += 1;
  }
}

const makeLane = (clock: FakeClock, transport: FakeTransport, id = 0): Lane =>
  new Lane({ id, clock, makeTransport: () => transport, sampleWindow: 3 });

const req = (): Request => new Request('https://legy.line-apps.com/enc', { method: 'POST' });

describe('Lane', () => {
  test('opens ready and reports its own id', () => {
    const lane = makeLane(new FakeClock(), new FakeTransport(new FakeClock()));
    expect(lane.state).toBe('ready');
    expect(lane.isRoutable()).toBe(true);
    expect(lane.id).toBe(0);
  });

  test('records the application RTT of a send from the clock', async () => {
    const clock = new FakeClock();
    const lane = makeLane(clock, new FakeTransport(clock, 17));
    expect(lane.medianRttMs).toBeUndefined();
    await lane.send(req());
    expect(lane.medianRttMs).toBe(17);
    expect(lane.lastRttAtMono).toBe(17);
  });

  test('keeps only the last N RTT samples', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport(clock, 10);
    const lane = makeLane(clock, transport);
    for (const ms of [10, 20, 30, 999]) {
      transport.setRtt(ms);
      await lane.send(req());
    }
    // window is 3, so the median is over [20, 30, 999].
    expect(lane.medianRttMs).toBe(30);
  });

  test('prediction charges a fraction of p95 tail spread above the median', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport(clock, 10);
    const lane = new Lane({ id: 0, clock, makeTransport: () => transport, sampleWindow: 7 });
    for (const ms of [10, 10, 10, 10, 10, 10, 30]) {
      transport.setRtt(ms);
      await lane.send(req(), 'send');
    }

    expect(lane.medianRttFor('send')).toBe(10);
    expect(lane.predictedRttFor('send')).toBe(17);
  });

  test('keeps warm and real send RTT profiles separate', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport(clock, 8);
    const lane = makeLane(clock, transport);
    await lane.send(req(), 'warm');
    transport.setRtt(21);
    await lane.send(req(), 'send');

    expect(lane.medianRttFor('warm')).toBe(8);
    expect(lane.medianRttFor('send')).toBe(21);
    expect(lane.medianRttMs).toBeUndefined();
  });

  test('a failed send increments consecutiveFailures and rethrows', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport(clock, 10);
    const lane = makeLane(clock, transport);
    transport.failNext();
    await expect(lane.send(req())).rejects.toThrow(/GOAWAY/);
    expect(lane.consecutiveFailures).toBe(1);
  });

  test('drain stops it being routable without killing it', () => {
    const lane = makeLane(new FakeClock(), new FakeTransport(new FakeClock()));
    lane.drain();
    expect(lane.state).toBe('draining');
    expect(lane.isRoutable()).toBe(false);
  });

  test('recycle swaps the transport, clears samples and resets age', async () => {
    const clock = new FakeClock();
    const first = new FakeTransport(clock, 40);
    let made = 0;
    const lane = new Lane({
      id: 1,
      clock,
      makeTransport: () => {
        made += 1;
        return made === 1 ? first : new FakeTransport(clock, 5);
      },
    });
    await lane.send(req());
    expect(lane.medianRttMs).toBe(40);
    clock.advance(1_000);

    lane.recycle();
    expect(first.closed).toBe(1);
    expect(lane.medianRttMs).toBeUndefined();
    expect(lane.state).toBe('ready');
    expect(lane.ageMs()).toBe(0);
  });

  test('close marks the lane dead and closes the transport', () => {
    const transport = new FakeTransport(new FakeClock());
    const lane = makeLane(new FakeClock(), transport);
    lane.close();
    expect(lane.state).toBe('dead');
    expect(lane.isRoutable()).toBe(false);
    expect(transport.closed).toBe(1);
  });
});

/**
 * With several replies on one HTTP/2 lane, every one after the first measures
 * the queue as well as the route. Counting those as evidence the route is slow
 * would blame the lane for its own popularity, so a slow sample that had
 * company is set aside instead — while a fast one still counts, because being
 * fast despite company is the stronger signal, not the weaker one.
 */
class GatedTransport implements LaneTransport {
  closed = 0;
  readonly #gates: (() => void)[] = [];
  constructor(private readonly clock: FakeClock, private readonly rttMs: number) {}
  fetch(): Promise<Response> {
    return new Promise((resolve) => {
      this.#gates.push(() => {
        this.clock.advance(this.rttMs);
        resolve(new Response(null, { status: 200 }));
      });
    });
  }
  /** Lets every request currently waiting finish, newest first, so they all
   * observe each other as in-flight. */
  releaseAll(): void {
    const gates = this.#gates.splice(0);
    for (const gate of gates) gate();
  }
  close(): void {
    this.closed += 1;
  }
}

describe('Lane — scoring under contention', () => {
  test('a slow reply that shared the lane is not counted as a turtle', async () => {
    const clock = new FakeClock();
    const transport = new GatedTransport(clock, 30);
    const lane = new Lane({
      id: 0,
      clock,
      makeTransport: () => transport,
      fastRouteThresholdMs: 12,
    });

    const first = lane.send(req(), 'send');
    const second = lane.send(req(), 'send');
    transport.releaseAll();
    await Promise.all([first, second]);

    const score = lane.score;
    expect(score.turtles + score.contendedSlow).toBe(2);
    // Both saw each other in flight, so neither slow result is the route's fault.
    expect(score.contendedSlow).toBe(2);
    expect(score.turtles).toBe(0);
  });

  test('a fast reply still earns its rabbit even when the lane was shared', async () => {
    const clock = new FakeClock();
    const transport = new GatedTransport(clock, 5);
    const lane = new Lane({
      id: 0,
      clock,
      makeTransport: () => transport,
      fastRouteThresholdMs: 12,
    });

    const first = lane.send(req(), 'send');
    const second = lane.send(req(), 'send');
    transport.releaseAll();
    await Promise.all([first, second]);

    expect(lane.score.rabbits).toBe(2);
    expect(lane.score.contendedSlow).toBe(0);
  });

  test('the same lane alone earns a turtle for the same slow RTT', async () => {
    const clock = new FakeClock();
    const transport = new GatedTransport(clock, 30);
    const lane = new Lane({
      id: 0,
      clock,
      makeTransport: () => transport,
      fastRouteThresholdMs: 12,
    });

    const only = lane.send(req(), 'send');
    transport.releaseAll();
    await only;

    expect(lane.score).toEqual({ rabbits: 0, turtles: 1, contendedSlow: 0 });
    expect(lane.lastContendedFor('send')).toBe(false);
  });
});
