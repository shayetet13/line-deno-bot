import type { Clock } from '../lib/clock.ts';

export type LaneState = 'connecting' | 'ready' | 'draining' | 'dead';
export type LaneMeasurement = 'send' | 'preflight' | 'poll' | 'general' | 'warm';

interface RttProfile {
  samples: number[];
  medianRttMs: number | undefined;
  tailRttMs: number | undefined;
  lastRttMs: number | undefined;
  lastRttAtMono: number | undefined;
  /** Whether the latest sample shared the lane with another in-flight request.
   * A slow contended sample is queueing, not a slow route, so routing must not
   * act on it (see {@link LaneScore}). */
  lastContended: boolean;
}

/**
 * A lane's running record, in rabbits and turtles.
 *
 * Only real `send` RTTs score. A poll legitimately waits at LINE before
 * returning and a warm HEAD is a cheap probe — counting either would bury the
 * reply route's own record under numbers that say nothing about it.
 *
 * Contention is why `turtles` is not simply "samples over the threshold": with
 * several requests on one HTTP/2 lane, all but the first wait for the ones
 * ahead, so their RTT measures the queue rather than the route. A slow sample
 * that had company is counted in `contendedSlow` and left out of `turtles`,
 * while a fast one still earns its rabbit — being fast *despite* company is
 * stronger evidence, not weaker.
 */
export interface LaneScore {
  /** Sends that came back within the fast-route threshold. */
  rabbits: number;
  /** Sends over the threshold that had the lane to themselves. */
  turtles: number;
  /** Sends over the threshold that shared the lane — attributed to load. */
  contendedSlow: number;
}

/** One request's own result, handed to {@link LaneOptions} callers as it is
 * recorded. Passed rather than read back off the lane afterwards: with two
 * replies in flight, "the lane's latest sample" is not reliably this call's,
 * and routing decisions made on the wrong one are silently wrong. */
export interface LaneSample {
  rttMs: number;
  /** Whether this request shared the lane with another at any point. */
  contended: boolean;
}

/** The transport a lane owns. One `Deno.HttpClient` per lane in production; a
 * fake in tests. Only `fetch` and `close` are needed. */
export interface LaneTransport {
  fetch(info: Request | URL | string, init?: RequestInit): Promise<Response>;
  close(): void;
  /** Physical destination when the transport pins one explicitly. */
  readonly remoteAddress?: string;
  /** HTTPS origin this transport actually owns. The dashboard must not label a
   * fallback/other gateway as though it were the reply route. */
  readonly remoteOrigin?: string;
}

export interface LaneOptions {
  id: number;
  clock: Clock;
  makeTransport: (laneId: number) => LaneTransport;
  /** Window of recent application-RTT samples kept for routing (Playbook §7.4). */
  sampleWindow?: number;
  /** A send at or under this earns a rabbit; over it, a turtle. */
  fastRouteThresholdMs?: number;
}

const DEFAULT_SAMPLE_WINDOW = 7;
/**
 * Measured floor for a real `sendMessage` on this route is 18.8ms over 34
 * live replies (2026-09-12), with the best lanes sitting at 20.3–21.0ms and
 * the rest at 23–25ms. 20 is set just above that floor deliberately: a lane
 * has to be within about a millisecond of the best the route can do to hold
 * reply traffic, so a 24ms lane is never allowed to look acceptable and keep
 * the pin while a 20ms one is available.
 *
 * The earlier 12 was below the floor, so nothing ever qualified and the pin
 * could never engage at all.
 */
export const DEFAULT_FAST_ROUTE_THRESHOLD_MS = 20;

const makeProfile = (): RttProfile => ({
  samples: [],
  medianRttMs: undefined,
  tailRttMs: undefined,
  lastRttMs: undefined,
  lastRttAtMono: undefined,
  lastContended: false,
});

const makeScore = (): LaneScore => ({ rabbits: 0, turtles: 0, contendedSlow: 0 });

/**
 * One HTTP/2 session to the origin, plus the measurements that decide whether to
 * route through it.
 *
 * RTT here is the APPLICATION round trip of a real request, never a PING — a
 * PING reaching the edge fast says nothing about how long LINE takes to answer
 * (Playbook §2, §7.9).
 */
export class Lane {
  readonly id: number;
  readonly #clock: Clock;
  readonly #makeTransport: (laneId: number) => LaneTransport;
  readonly #window: number;
  readonly #fastThresholdMs: number;
  readonly #profiles: Record<LaneMeasurement, RttProfile> = {
    send: makeProfile(),
    preflight: makeProfile(),
    poll: makeProfile(),
    general: makeProfile(),
    warm: makeProfile(),
  };
  #score: LaneScore = makeScore();

  #transport: LaneTransport;
  #state: LaneState = 'connecting';
  #inFlight = 0;
  #openedAtMono: number;
  #consecutiveFailures = 0;
  #connected = false;

  constructor(options: LaneOptions) {
    this.id = options.id;
    this.#clock = options.clock;
    this.#makeTransport = options.makeTransport;
    this.#window = options.sampleWindow ?? DEFAULT_SAMPLE_WINDOW;
    this.#fastThresholdMs = options.fastRouteThresholdMs ?? DEFAULT_FAST_ROUTE_THRESHOLD_MS;
    this.#transport = options.makeTransport(this.id);
    this.#openedAtMono = options.clock.monotonic();
    this.#state = 'ready';
  }

  get state(): LaneState {
    return this.#state;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get openedAtMono(): number {
    return this.#openedAtMono;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get remoteAddress(): string | undefined {
    return this.#transport.remoteAddress;
  }

  get remoteOrigin(): string | undefined {
    return this.#transport.remoteOrigin;
  }

  /** True after this physical transport has completed any request. A freshly
   * created/recycled Deno client is only an object; its TCP/TLS path is still
   * cold until a request has reached it. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Median of the recent application RTTs, or `undefined` until one is measured
   * — an unmeasured lane must not be preferred on a guess (Playbook §7.9). */
  get medianRttMs(): number | undefined {
    return this.medianRttFor('general');
  }

  get lastRttAtMono(): number | undefined {
    return this.lastRttAtFor('general');
  }

  /** Raw duration of the latest completed request. Slow-lane cooldown must
   * react to this result immediately instead of waiting for its median to move. */
  get lastRttMs(): number | undefined {
    return this.lastRttFor('general');
  }

  /** Accumulated rabbits and turtles for this physical route. Cleared by
   * {@link recycle} — a fresh route has not earned the old one's record. */
  get score(): LaneScore {
    return { ...this.#score };
  }

  /** Rabbits minus turtles. Used to break ties between lanes whose measured
   * RTTs are too close to separate on speed alone. */
  get netScore(): number {
    return this.#score.rabbits - this.#score.turtles;
  }

  medianRttFor(measurement: LaneMeasurement): number | undefined {
    return this.#profiles[measurement].medianRttMs;
  }

  tailRttFor(measurement: LaneMeasurement): number | undefined {
    return this.#profiles[measurement].tailRttMs;
  }

  /** Conservative completion estimate copied from the proven VPS1 selector:
   * p50 plus 35% of the observed p95-p50 spread. It reacts to tail jitter
   * without letting one spike count as the whole route forever. */
  predictedRttFor(measurement: LaneMeasurement): number | undefined {
    const profile = this.#profiles[measurement];
    const p50 = profile.medianRttMs;
    const p95 = profile.tailRttMs;
    return p50 === undefined || p95 === undefined ? undefined : p50 + (p95 - p50) * 0.35;
  }

  /** Whether the latest sample of this kind shared the lane. A slow sample
   * that did must not be read as a slow route. */
  lastContendedFor(measurement: LaneMeasurement): boolean {
    return this.#profiles[measurement].lastContended;
  }

  lastRttFor(measurement: LaneMeasurement): number | undefined {
    return this.#profiles[measurement].lastRttMs;
  }

  lastRttAtFor(measurement: LaneMeasurement): number | undefined {
    return this.#profiles[measurement].lastRttAtMono;
  }

  ageMs(): number {
    return this.#clock.monotonic() - this.#openedAtMono;
  }

  isRoutable(): boolean {
    return this.#state === 'ready';
  }

  /** Sends one request through this lane and records its application RTT.
   * `onSample` is invoked synchronously with this call's own measurement,
   * before any further await can interleave another request's. */
  async send(
    req: Request,
    measurement: LaneMeasurement = 'general',
    onSample?: (sample: LaneSample) => void,
  ): Promise<Response> {
    // Company at either end means this request queued behind, or was queued
    // behind by, another on the same HTTP/2 lane. Checked at both ends because
    // a request can start alone and still be overtaken before it returns.
    const sharedAtStart = this.#inFlight > 0;
    this.#inFlight += 1;
    const started = this.#clock.monotonic();
    try {
      const response = await this.#transport.fetch(req);
      const sample: LaneSample = {
        rttMs: this.#clock.monotonic() - started,
        contended: sharedAtStart || this.#inFlight > 1,
      };
      this.#record(measurement, sample);
      onSample?.(sample);
      return response;
    } catch (error: unknown) {
      this.#consecutiveFailures += 1;
      throw error;
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** Marks the lane draining — chosen for no new request, destroyed once idle
   * (Playbook §7.12). */
  drain(): void {
    if (this.#state === 'dead') return;
    this.#state = 'draining';
  }

  /** Replaces the underlying transport with a fresh one and clears stale RTTs,
   * because a new physical route must be re-measured (Playbook §7.11, §7.12). */
  recycle(): void {
    this.#transport.close();
    this.#transport = this.#makeTransport(this.id);
    for (const profile of Object.values(this.#profiles)) {
      profile.samples.length = 0;
      profile.medianRttMs = undefined;
      profile.tailRttMs = undefined;
      profile.lastRttMs = undefined;
      profile.lastRttAtMono = undefined;
      profile.lastContended = false;
    }
    this.#score = makeScore();
    this.#consecutiveFailures = 0;
    this.#connected = false;
    this.#openedAtMono = this.#clock.monotonic();
    this.#state = 'ready';
  }

  close(): void {
    this.#state = 'dead';
    this.#transport.close();
  }

  #record(measurement: LaneMeasurement, { rttMs, contended }: LaneSample): void {
    this.#consecutiveFailures = 0;
    this.#connected = true;
    if (measurement === 'send') this.#scoreSend(rttMs, contended);
    const profile = this.#profiles[measurement];
    profile.lastContended = contended;
    profile.lastRttAtMono = this.#clock.monotonic();
    profile.lastRttMs = rttMs;
    profile.samples.push(rttMs);
    if (profile.samples.length > this.#window) profile.samples.shift();
    const sorted = profile.samples.toSorted((a, b) => a - b);
    profile.medianRttMs = sorted[Math.floor(sorted.length / 2)];
    profile.tailRttMs = sorted[Math.ceil(sorted.length * 0.95) - 1];
  }

  #scoreSend(rttMs: number, contended: boolean): void {
    if (rttMs <= this.#fastThresholdMs) this.#score.rabbits += 1;
    else if (contended) this.#score.contendedSlow += 1;
    else this.#score.turtles += 1;
  }
}
