import { MS_PER_SECOND } from '../config/constants.ts';
import { ConfigError, TransientTransportError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { classifyError } from '../errors/classify.ts';
import {
  DEFAULT_FAST_ROUTE_THRESHOLD_MS,
  Lane,
  type LaneMeasurement,
  type LaneSample,
  type LaneScore,
  type LaneTransport,
} from './lane.ts';

export type LaneRole = 'send' | 'poll' | 'general';

/** Private hop-by-hop hint consumed by LanePool and removed before LINE sees it. */
export const LANE_ROLE_HEADER = 'x-line-first-lane-role';
/** Startup-only private hint: send one harmless encrypted preflight to this
 * exact owned lane. It is consumed before the request leaves this process. */
export const LANE_FORCE_HEADER = 'x-line-first-lane-force';

export interface LanePoolOptions {
  clock: Clock;
  logger: Logger;
  makeTransport: (laneId: number) => LaneTransport;
  /** How many lanes to keep open to the origin (Playbook §7.2: 6 by default). */
  lanes?: number;
  sampleWindow?: number;
  /** Low-numbered lanes reserved for replies. Poll traffic uses the rest, with
   * a full-pool fallback when one side has no routable lane. */
  sendReservedLanes?: number;
  /** How many of the reply lanes are held back as spares. Ordinary replies
   * never touch them; they answer only when every primary reply lane is busy.
   * Carved out of `sendReservedLanes`, so
   * `sendReservedLanes: 8, sendSpareLanes: 4` means four primary and four
   * spare. */
  sendSpareLanes?: number;
  /** An older RTT is calibration work, not evidence for routing. */
  sampleMaxAgeMs?: number;
  /** Switch lanes only when the candidate is at least this much faster, to stop
   * churn on noise (Playbook §7.5: 0.10ms). */
  switchMarginMs?: number;
  /** A send at or under this keeps the current reply lane; over it (with the
   * lane to itself) the next send re-picks. Also the rabbit/turtle line. */
  fastRouteThresholdMs?: number;
  /** A route whose observed send p95 exceeds this is not allowed back into
   * first-response selection. Unlike a single 21ms reply, this is evidence
   * of the tail that actually loses one-shot races. */
  maxSendTailMs?: number;
  /** Consecutive real send RTTs over this park that lane briefly while
   * alternatives exist. Poll duration is never route-health evidence. */
  slowThresholdMs?: number;
  slowSamplesBeforeCooldown?: number;
  slowCooldownMs?: number;
  /** Open a fresh physical route per lane past this age (Playbook §7.11). */
  maxAgeMs?: number;
  recycleGapMs?: number;
  /** Preferred ceiling for active receive RPCs on one route.  Reaching it
   * makes the picker spread work to another receive lane first; if every
   * receive lane is full, one is reused as an HTTP/2 multiplexing fallback.
   * Reply lanes remain excluded from that fallback. */
  maxPollInFlightPerLane?: number;
}

const DEFAULTS = {
  lanes: 6,
  sendSpareLanes: 0,
  sampleWindow: 7,
  // Samples cannot outlive their physical route because lanes are recycled at
  // 15 minutes. A 30s window was shorter than one 4-lane warm cycle (45s), so
  // the first sample expired before the last lane could be ranked.
  sampleMaxAgeMs: 15 * 60 * MS_PER_SECOND,
  switchMarginMs: 0.1,
  fastRouteThresholdMs: DEFAULT_FAST_ROUTE_THRESHOLD_MS,
  // The production comparison shows that P95 above 27ms loses the first
  // response race. Leave a little room above the 20ms fast line so normal
  // 21–22ms jitter does not cause route churn.
  maxSendTailMs: 27,
  slowThresholdMs: 23,
  slowSamplesBeforeCooldown: 2,
  slowCooldownMs: 15 * MS_PER_SECOND,
  maxAgeMs: 15 * 60 * MS_PER_SECOND,
  recycleGapMs: 60 * MS_PER_SECOND,
  maxPollInFlightPerLane: 1,
} as const;

export interface LaneStat {
  id: number;
  remoteAddress?: string | undefined;
  remoteOrigin?: string | undefined;
  state: string;
  inFlight: number;
  medianRttMs: number | undefined;
  /** Nearest-rank p95 over the same application samples. */
  tailRttMs?: number | undefined;
  /** Tail-aware number the selector actually compares. */
  predictedRttMs?: number | undefined;
  /** Monotonic time of the last application measurement. The dashboard needs
   * it to show sample age — a stale RTT must not look live (Playbook §13.2). */
  lastSampleMono: number | undefined;
  /** Connection-warmup RTT is only a cold-start routing hint. It is kept
   * separate so a cheap HEAD cannot masquerade as a real LINE RPC. */
  warmRttMs?: number | undefined;
  warmLastSampleMono?: number | undefined;
  /** Read-only Square RPC measured on this exact lane before ARMED. It is used
   * only to order lanes that have never carried a real reply. */
  preflightRttMs?: number | undefined;
  preflightLastSampleMono?: number | undefined;
  ageMs: number;
  consecutiveFailures: number;
  role: 'send' | 'poll' | 'shared';
  /** False while the lane is parked in a slow/failure cooldown. */
  available?: boolean;
  /** False when routing deliberately excludes this lane. */
  routeEligible?: boolean;
  /** Accumulated rabbits/turtles for this route. Send lanes only — nothing
   * else produces evidence a reply route can be judged on. */
  score?: LaneScore;
  /** True for the lane replies are currently pinned to, which only changes
   * when that lane breaches the fast-route threshold on its own. */
  currentSend?: boolean;
  /** True for a reply lane held back as a congestion spare. */
  spare?: boolean;
}

/** Detects the connection-lifecycle close LINE/edge sends routinely
 * (Playbook §7.12). `NO_ERROR` still means the request did not complete. */
const isGoAway = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /GOAWAY|HTTP\/?2|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg);
};

/**
 * A pool of owned HTTP/2 lanes to one origin.
 *
 * Used as LINEJS's custom `fetch`: every send is routed to the lane with the
 * lowest measured application RTT, not left to the runtime's socket picker
 * which cannot know a lane just went slow or got a GOAWAY (Playbook §7.1).
 *
 * Consecutive slow reply sends park that lane; poll and warm durations never
 * do. A GOAWAY drains it and a replacement is opened; lanes past `maxAgeMs`
 * are recycled one at a time so a decayed Akamai route does not linger
 * (Playbook §7.11).
 */
export class LanePool {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #opts: Required<Omit<LanePoolOptions, 'clock' | 'logger' | 'makeTransport'>>;
  readonly #lanes: Lane[] = [];
  readonly #cooldownUntil = new Map<number, number>();
  /** A raw, uncontended send over the fast line bypasses this route briefly.
   * This must expire: a permanently excluded lane cannot produce the fast
   * sample that the old Set-based policy required to admit it again. */
  readonly #fastBypassUntil = new Map<number, number>();
  readonly #slowSendStreak: Uint8Array;
  #lastRecycleMono = Number.NEGATIVE_INFINITY;
  #closed = false;
  /** The lane replies stay pinned to while it keeps coming back fast. */
  #currentSendLaneId: number | undefined;
  /** The breach that cleared the pin, held until the next pick so the switch
   * can be reported as one line naming both lanes. */
  #lastUnpin: { lane: number; rttMs: number } | undefined;

  constructor(options: LanePoolOptions) {
    const lanes = options.lanes ?? DEFAULTS.lanes;
    if (!Number.isInteger(lanes) || lanes < 1) {
      throw new ConfigError('LanePool: lanes must be an integer >= 1', { lanes });
    }
    const sendReservedLanes = options.sendReservedLanes ?? (lanes > 1 ? 1 : 0);
    if (
      !Number.isInteger(sendReservedLanes) || sendReservedLanes < 0 ||
      sendReservedLanes >= lanes
    ) {
      throw new ConfigError('LanePool: sendReservedLanes must be an integer from 0 to lanes - 1', {
        lanes,
        sendReservedLanes,
      });
    }
    const sendSpareLanes = options.sendSpareLanes ?? DEFAULTS.sendSpareLanes;
    // Spares come out of the reply band, so at least one primary reply lane
    // has to be left over — a band that is all spares has nothing to spare for.
    if (
      !Number.isInteger(sendSpareLanes) || sendSpareLanes < 0 ||
      sendSpareLanes >= Math.max(1, sendReservedLanes)
    ) {
      throw new ConfigError(
        'LanePool: sendSpareLanes must be an integer from 0 to sendReservedLanes - 1',
        { sendReservedLanes, sendSpareLanes },
      );
    }
    const slowSamplesBeforeCooldown = options.slowSamplesBeforeCooldown ??
      DEFAULTS.slowSamplesBeforeCooldown;
    if (!Number.isInteger(slowSamplesBeforeCooldown) || slowSamplesBeforeCooldown < 1) {
      throw new ConfigError('LanePool: slowSamplesBeforeCooldown must be an integer >= 1', {
        slowSamplesBeforeCooldown,
      });
    }
    const maxPollInFlightPerLane = options.maxPollInFlightPerLane ??
      DEFAULTS.maxPollInFlightPerLane;
    if (!Number.isInteger(maxPollInFlightPerLane) || maxPollInFlightPerLane < 1) {
      throw new ConfigError('LanePool: maxPollInFlightPerLane must be an integer >= 1', {
        maxPollInFlightPerLane,
      });
    }
    const maxSendTailMs = options.maxSendTailMs ?? DEFAULTS.maxSendTailMs;
    if (!Number.isFinite(maxSendTailMs) || maxSendTailMs <= 0) {
      throw new ConfigError('LanePool: maxSendTailMs must be a finite number > 0', {
        maxSendTailMs,
      });
    }
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#slowSendStreak = new Uint8Array(lanes);
    this.#opts = {
      lanes,
      sampleWindow: options.sampleWindow ?? DEFAULTS.sampleWindow,
      sendReservedLanes,
      sendSpareLanes,
      sampleMaxAgeMs: options.sampleMaxAgeMs ?? DEFAULTS.sampleMaxAgeMs,
      switchMarginMs: options.switchMarginMs ?? DEFAULTS.switchMarginMs,
      fastRouteThresholdMs: options.fastRouteThresholdMs ?? DEFAULTS.fastRouteThresholdMs,
      maxSendTailMs,
      slowThresholdMs: options.slowThresholdMs ?? DEFAULTS.slowThresholdMs,
      slowSamplesBeforeCooldown,
      slowCooldownMs: options.slowCooldownMs ?? DEFAULTS.slowCooldownMs,
      maxAgeMs: options.maxAgeMs ?? DEFAULTS.maxAgeMs,
      recycleGapMs: options.recycleGapMs ?? DEFAULTS.recycleGapMs,
      maxPollInFlightPerLane,
    };
    for (let id = 0; id < lanes; id += 1) {
      this.#lanes.push(
        new Lane({
          id,
          clock: options.clock,
          makeTransport: options.makeTransport,
          sampleWindow: this.#opts.sampleWindow,
          fastRouteThresholdMs: this.#opts.fastRouteThresholdMs,
        }),
      );
    }
  }

  /** Fetch shaped for LINEJS's `FetchLike` — it calls `fetch(request)`. */
  readonly fetch = async (info: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const incoming = info instanceof Request ? info : new Request(info, init);
    const role = readRole(incoming.headers);
    const forcedLaneId = readForcedLane(incoming.headers);
    // LINEJS has already made the one Request the transport needs. Its headers
    // are mutable here, so consume the private routing hint in place instead of
    // copying Headers and constructing a second Request on every hot RPC.
    incoming.headers.delete(LANE_ROLE_HEADER);
    incoming.headers.delete(LANE_FORCE_HEADER);
    if (role === 'send') incoming.headers.set('priority', 'u=0');
    else if (role === 'poll') incoming.headers.set('priority', 'u=7, i');
    // A forced request is startup calibration, not a reply. Keeping it in its
    // own profile is essential: the old Talk noop samples (8-10ms) polluted
    // send p50/p95 even though real Square sendMessage calls took 19-23ms,
    // causing the first reply to rank lanes using the wrong RPC.
    const measurement: LaneMeasurement = forcedLaneId === undefined ? role : 'preflight';
    return await this.#send(incoming, role, measurement, forcedLaneId);
  };

  /** Used by the warmer without placing the private role header on the wire.
   * Warm HEAD timings are a separate cold-start hint and never alter real send
   * medians or park a lane. */
  fetchFor(role: LaneRole): (info: string, init?: RequestInit) => Promise<Response> {
    return async (info, init) => {
      const lane = this.#pick(role, 'warm');
      const requested = new Request(info, init);
      // The account's credential decides whether Square RPCs use plain LEGY
      // or the encrypted gf gateway. A fixed gf HEAD warmed the wrong socket
      // on the current account: real sends went to LEGY, then paid a cold
      // handshake after idle and jumped to 76-83ms. Follow the latest origin
      // actually observed on this exact lane instead.
      const request = role === 'send'
        ? warmRequestForObservedOrigin(requested, lane.remoteOrigin)
        : requested;
      return await this.#sendOnLane(lane, request, 'warm');
    };
  }

  /** Pays connection setup for every reserved reply lane before ARMED. This is
   * startup work, never reply work, and makes threshold-driven lane changes
   * safe from the 80-125ms cold-handshake spikes seen in production. */
  async primeSendLanes(origin: string): Promise<void> {
    for (let i = 0; i < this.#opts.sendReservedLanes; i += 1) {
      const lane = this.#lanes[i];
      if (lane === undefined) continue;
      try {
        const response = await lane.send(new Request(origin, { method: 'HEAD' }), 'warm');
        await response.body?.cancel();
      } catch (error: unknown) {
        this.#afterFailure(lane, error);
        this.#logger.warn('reply lane prime failed', {
          lane: lane.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  async #send(
    req: Request,
    role: LaneRole,
    measurement: LaneMeasurement,
    forcedLaneId?: number,
  ): Promise<Response> {
    const lane = this.#pick(role, measurement, forcedLaneId);
    return await this.#sendOnLane(lane, req, measurement);
  }

  async #sendOnLane(
    lane: Lane,
    req: Request,
    measurement: LaneMeasurement,
  ): Promise<Response> {
    try {
      // Only a real reply send says whether a reply route is slow. A poll can
      // legitimately wait at LINE before returning, while warm HEAD is a
      // cheap connection probe; parking on either caused the production churn.
      // The sample arrives through the callback rather than being read back
      // off the lane afterwards, so two overlapping replies cannot be judged
      // on each other's numbers.
      const response = await lane.send(
        req,
        measurement,
        measurement === 'send' ? (sample) => this.#afterSend(lane, sample) : undefined,
      );
      return response;
    } catch (error: unknown) {
      this.#afterFailure(lane, error);
      throw error;
    }
  }

  get stats(): LaneStat[] {
    const now = this.#clock.monotonic();
    const firstSpareId = this.#opts.sendReservedLanes - this.#opts.sendSpareLanes;
    const hasAvailablePrimary = this.#lanes.some((lane) =>
      lane.id < firstSpareId && lane.isRoutable() &&
      (this.#cooldownUntil.get(lane.id) ?? 0) <= now &&
      !this.#isFastBypassed(lane.id, now) && this.#isSendTailEligible(lane)
    );
    return this.#lanes.map((lane) => {
      const role = this.#roleFor(lane.id);
      const measurement: LaneMeasurement = role === 'shared' ? 'general' : role;
      const spare = this.#isSpare(lane.id);
      return {
        id: lane.id,
        remoteAddress: lane.remoteAddress,
        remoteOrigin: lane.remoteOrigin,
        state: lane.state,
        inFlight: lane.inFlight,
        medianRttMs: lane.medianRttFor(measurement),
        tailRttMs: lane.tailRttFor(measurement),
        predictedRttMs: lane.predictedRttFor(measurement),
        lastSampleMono: lane.lastRttAtFor(measurement),
        warmRttMs: lane.medianRttFor('warm'),
        warmLastSampleMono: lane.lastRttAtFor('warm'),
        preflightRttMs: lane.medianRttFor('preflight'),
        preflightLastSampleMono: lane.lastRttAtFor('preflight'),
        ageMs: lane.ageMs(),
        consecutiveFailures: lane.consecutiveFailures,
        role,
        available: (this.#cooldownUntil.get(lane.id) ?? 0) <= now,
        routeEligible: !spare &&
          (role !== 'send' || !hasAvailablePrimary ||
            (!this.#isFastBypassed(lane.id, now) && this.#isSendTailEligible(lane))),
        score: lane.score,
        currentSend: lane.id === this.#currentSendLaneId,
        spare,
      };
    });
  }

  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes) lane.close();
  }

  #pick(role: LaneRole, measurement: LaneMeasurement, forcedLaneId?: number): Lane {
    const now = this.#clock.monotonic();
    const usable = this.#lanes.filter(
      (lane) => lane.isRoutable() && (this.#cooldownUntil.get(lane.id) ?? 0) <= now,
    );
    const routable = usable.length > 0 ? usable : this.#lanes.filter((l) => l.isRoutable());
    const preferred = this.#candidates(routable, role);
    const pool = preferred.length > 0 ? preferred : routable;
    if (pool.length === 0) {
      throw new TransientTransportError('lane pool: no routable lane', {
        lanes: this.#lanes.length,
      });
    }
    if (forcedLaneId !== undefined) {
      if (role !== 'send') {
        throw new TransientTransportError(
          'lane pool: forced lane is only valid for send preflight',
          {
            role,
            forcedLaneId,
          },
        );
      }
      const forced = pool.find((lane) => lane.id === forcedLaneId);
      if (forced === undefined) {
        throw new TransientTransportError('lane pool: forced send lane is not routable', {
          forcedLaneId,
          candidates: pool.map((lane) => lane.id),
        });
      }
      return forced;
    }
    // Prefer an uncontended receive lane.  This is deliberately a soft cap:
    // LINEJS can issue a background fetch outside the dedicated poll loop, and
    // rejecting that fetch when every receive lane has one stream made the
    // rejection uncaught and restarted the whole worker.  HTTP/2 supports a
    // small overflow stream; use the least-loaded receive lane as a last
    // resort, while preserving the reply-lane reservation.
    const underCap = role === 'send'
      ? pool
      : pool.filter((lane) => lane.inFlight < this.#opts.maxPollInFlightPerLane);
    const saturated = role !== 'send' && underCap.length === 0;
    const bounded = saturated ? pool : underCap;
    if (saturated) {
      this.#logger.warn('receive lanes saturated; multiplexing least-loaded lane', {
        role,
        lanes: pool.length,
        maxPollInFlightPerLane: this.#opts.maxPollInFlightPerLane,
      });
    }
    if (measurement === 'warm') {
      // Refresh the least-recently warmed idle lane forever, not merely until
      // every lane has one sample. Settling on the lowest HEAD RTT left every
      // other reply connection idle long enough for LINE to close it, so a
      // threshold-driven switch could still pay a cold TLS handshake. This is
      // background-only work; avoiding an in-flight lane also keeps the probe
      // from contending with a real reply.
      const idle = bounded.filter((lane) => lane.inFlight === 0);
      const candidates = idle.length > 0 ? idle : bounded;
      return candidates.reduce((oldest, lane) => {
        const laneAt = lane.lastRttAtFor('warm') ?? Number.NEGATIVE_INFINITY;
        const oldestAt = oldest.lastRttAtFor('warm') ?? Number.NEGATIVE_INFINITY;
        return laneAt < oldestAt ? lane : oldest;
      });
    }

    // A send has no safe spare request with which to benchmark every route.
    // Use separately measured warm RTT only for the very first real send; once
    // a lane has real send evidence, only real send evidence can beat it.
    if (role === 'send') return this.#pickSend(bounded, now);

    // Poll/general traffic is continuous and can calibrate each eligible route
    // naturally before settling on its fastest real application RTT.
    const unmeasured = bounded.filter((lane) => !this.#hasFreshSample(lane, measurement, now));
    if (unmeasured.length > 0) {
      // Several LINEJS background RPCs can begin in the same turn. Before any
      // of them has produced a timing sample, routing every call to the first
      // unmeasured lane piles long-lived work onto one H2 session (and used to
      // pile it onto a reserved reply lane). Spread those calls by live load;
      // when load ties, refresh the lane whose evidence is oldest.
      return unmeasured.reduce((best, lane) => {
        if (lane.inFlight !== best.inFlight) return lane.inFlight < best.inFlight ? lane : best;
        const laneAt = lane.lastRttAtFor(measurement) ?? Number.NEGATIVE_INFINITY;
        const bestAt = best.lastRttAtFor(measurement) ?? Number.NEGATIVE_INFINITY;
        return laneAt < bestAt ? lane : best;
      });
    }
    return bounded.reduce((best, lane) => this.#beats(lane, best, measurement) ? lane : best);
  }

  /**
   * Reply routing, in the order asked for:
   *
   *  1. the lane replies are already pinned to, while it is still fast and
   *     idle — staying put is the whole point, and it is what keeps one
   *     connection hot instead of spreading replies over lanes that then go
   *     cold between them
   *  2. any other fast, idle primary lane
   *  3. an idle spare — reached only when a primary lane is fast but every
   *     one of them is busy, i.e. replies are overlapping (several bots, or
   *     several rooms at once). Answering on a free spare beats queueing
   *     behind a reply already in flight, and the pin deliberately stays
   *     where it is: this is overflow, not a change of preference
   *  4. a fast primary that happens to be busy — still better than a slow lane
   *  5. nothing is fast anywhere: keep the best lane with a real reply
   *     measurement.  An untried lane is used only while no real reply lane
   *     is viable — a live first-response must never be spent exploring just
   *     because an otherwise healthy lane is 24–26ms.
   */
  #pickSend(pool: Lane[], now: number): Lane {
    const { primary: allPrimary, spare } = this.#splitSendBand(pool);
    const outsideFastBypass = allPrimary.filter((lane) => !this.#isFastBypassed(lane.id, now));
    // Fail open when every primary is in the short bypass. Delivery still
    // matters, but one noisy sample can no longer exile a healthy lane forever.
    const unbypassed = outsideFastBypass.length > 0 ? outsideFastBypass : allPrimary;
    // A p95 above 27ms is not harmless jitter: it is exactly the tail that
    // loses a first-response round. Do not resurrect that route simply because
    // its short raw-breach cooldown expired. Fail open only if every route is
    // bad, so delivery is never blocked by an over-strict selector.
    const tailSafe = unbypassed.filter((lane) => this.#isSendTailEligible(lane));
    const primary = tailSafe.length > 0 ? tailSafe : unbypassed;
    const idle = (lane: Lane): boolean => lane.inFlight === 0;
    const timed = (lane: Lane): boolean => this.#hasFreshSample(lane, 'send', now);
    const idlePrimary = primary.filter(idle);
    const fastPrimary = primary.filter((lane) => this.#isFastLane(lane));

    // 1. Stay on the pinned lane while it is still fast and free.
    const pinned = this.#pinnedSendLane(fastPrimary.filter(idle), now);
    if (pinned !== undefined) return pinned;

    // If the pin still names a fast lane and it is merely busy, every choice
    // below is congestion routing and must leave the pin where it is —
    // working around a queue is not a change of preference.
    const busyPin = this.#pinnedSendLane(fastPrimary, now) !== undefined;
    const take = (lane: Lane): Lane => busyPin ? lane : this.#pinSend(lane);

    // 2. Another fast, free primary lane.
    const fastIdle = fastPrimary.filter(idle);
    if (fastIdle.length > 0) return take(this.#bestSend(fastIdle));

    // 3. Overflow. The only thing spares are for: every primary lane is
    //    genuinely busy, so answering on a spare beats queueing behind a
    //    reply already in flight.
    if (primary.length > 0 && idlePrimary.length === 0) {
      const idleSpare = spare.filter(idle);
      if (idleSpare.length > 0) {
        const known = idleSpare.filter(timed);
        return known.length > 0 ? this.#bestSend(known) : this.#bestUntried(idleSpare, now);
      }
    }

    // 4. No primary is below the desired threshold.  A real send measurement
    //    outranks every probe and every untried lane: 23ms is the switch
    //    trigger, not permission to sacrifice the next user message searching
    //    for a hypothetical faster route. A real p95 above the hard ceiling
    //    has already been removed by `tailSafe` above, so this retains only
    //    the least-bad live route.
    const timedIdle = idlePrimary.filter(timed);
    if (timedIdle.length > 0) return take(this.#bestSend(timedIdle));

    // 5. There is no viable real-send evidence (initial startup, or every
    //    measured route breached the hard p95 ceiling). One bounded primary
    //    may then be tried. Its read-only preflight/warm samples only order
    //    these equally untried candidates; they can never outrank a live send.
    const untried = idlePrimary.filter((lane) => !timed(lane));
    if (untried.length > 0) return take(this.#bestUntried(untried, now));

    // All primary routes are busy. This is the final fail-open path after the
    // overflow branch above: retain the best measured primary rather than
    // block a reply if every spare is also busy.
    const timedPrimary = primary.filter(timed);
    if (timedPrimary.length > 0) return take(this.#bestSend(timedPrimary));
    return take(this.#bestUntried(primary.length > 0 ? primary : pool, now));
  }

  /** Splits the reply band into the lanes replies normally use and the spares
   * held back for overflow. Falling back to "all of it is primary" when the
   * primary side is empty covers the case where the pool already had to look
   * past the reservation because every primary lane was parked or drained. */
  #splitSendBand(pool: Lane[]): { primary: Lane[]; spare: Lane[] } {
    const spares = this.#opts.sendSpareLanes;
    if (spares === 0) return { primary: pool, spare: [] };
    const firstSpareId = this.#opts.sendReservedLanes - spares;
    const primary = pool.filter((lane) => lane.id < firstSpareId);
    if (primary.length === 0) return { primary: pool, spare: [] };
    return { primary, spare: pool.filter((lane) => lane.id >= firstSpareId) };
  }

  #bestSend(lanes: Lane[]): Lane {
    return lanes.reduce((best, lane) => this.#beatsForSend(lane, best) ? lane : best);
  }

  /** The pinned reply lane, if it is among the candidates the caller already
   * qualified and its evidence is still current. `undefined` means the next
   * reply re-picks. */
  #pinnedSendLane(candidates: Lane[], now: number): Lane | undefined {
    const id = this.#currentSendLaneId;
    if (id === undefined) return undefined;
    const lane = candidates.find((candidate) => candidate.id === id);
    if (lane === undefined || !this.#hasFreshSample(lane, 'send', now)) return undefined;
    return lane;
  }

  #pinSend(lane: Lane): Lane {
    const unpin = this.#lastUnpin;
    if (unpin !== undefined && unpin.lane !== lane.id) {
      this.#logger.info('reply lane switched', {
        from: unpin.lane,
        to: lane.id,
        rttMs: unpin.rttMs,
        thresholdMs: this.#opts.fastRouteThresholdMs,
      });
    }
    this.#lastUnpin = undefined;
    this.#currentSendLaneId = lane.id;
    return lane;
  }

  /** Best guess among lanes with no real send evidence: the read-only Square
   * preflight first, then warm RTT, otherwise live load. Neither probe is ever
   * compared with a real send; both only order equally untried lanes. */
  #bestUntried(lanes: Lane[], now: number): Lane {
    const preflight = lanes.filter((lane) => this.#hasFreshSample(lane, 'preflight', now));
    if (preflight.length > 0) {
      return preflight.reduce((best, lane) => this.#beats(lane, best, 'preflight') ? lane : best);
    }
    const warm = lanes.filter((lane) => this.#hasFreshSample(lane, 'warm', now));
    if (warm.length > 0) {
      return warm.reduce((best, lane) => this.#beats(lane, best, 'warm') ? lane : best);
    }
    return lanes.reduce((best, lane) => lane.inFlight < best.inFlight ? lane : best);
  }

  /** Judged on the median rather than the latest sample: one slow reply
   * breaking the pin is `#afterSend`'s job, while staying pinned has to mean
   * the lane is fast in general, not that its last sample happened to be. */
  #isFastLane(lane: Lane): boolean {
    const predicted = lane.predictedRttFor('send');
    return predicted !== undefined && predicted <= this.#opts.fastRouteThresholdMs &&
      this.#isSendTailEligible(lane) && !this.#isFastBypassed(lane.id, this.#clock.monotonic());
  }

  #isSendTailEligible(lane: Lane): boolean {
    const tail = lane.tailRttFor('send');
    return tail === undefined || tail <= this.#opts.maxSendTailMs;
  }

  #isFastBypassed(laneId: number, now: number): boolean {
    const until = this.#fastBypassUntil.get(laneId);
    if (until === undefined) return false;
    if (until > now) return true;
    this.#fastBypassUntil.delete(laneId);
    return false;
  }

  /** Speed first, accumulated record second. Two lanes whose medians sit
   * inside the switch margin are indistinguishable on this window's evidence,
   * so the longer record of being fast decides — and failing that, load. */
  #beatsForSend(candidate: Lane, current: Lane): boolean {
    const a = candidate.predictedRttFor('send');
    const b = current.predictedRttFor('send');
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (b - a >= this.#opts.switchMarginMs) return true;
    if (Math.abs(a - b) >= this.#opts.switchMarginMs) return false;
    if (candidate.netScore !== current.netScore) return candidate.netScore > current.netScore;
    return candidate.inFlight < current.inFlight;
  }

  /** Lower measured RTT wins by at least the switch margin; an unmeasured lane
   * loses to a measured one; ties break on fewer in-flight (Playbook §7.5, §7.8). */
  #beats(candidate: Lane, current: Lane, measurement: LaneMeasurement): boolean {
    const tailAware = measurement === 'send' || measurement === 'poll';
    const a = tailAware
      ? candidate.predictedRttFor(measurement)
      : candidate.medianRttFor(measurement);
    const b = tailAware ? current.predictedRttFor(measurement) : current.medianRttFor(measurement);
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (b - a >= this.#opts.switchMarginMs) return true;
    if (Math.abs(a - b) < this.#opts.switchMarginMs) return candidate.inFlight < current.inFlight;
    return false;
  }

  #hasFreshSample(lane: Lane, measurement: LaneMeasurement, now: number): boolean {
    const last = lane.lastRttAtFor(measurement);
    if (lane.medianRttFor(measurement) === undefined || last === undefined) return false;
    // Reply evidence belongs to this exact physical transport. Reserved reply
    // transports are kept warm and are replaced on an actual error, so an
    // arbitrary wall-clock expiry must not turn the first reply after an idle
    // period into a live calibration request. This applies to the startup
    // Square preflight as well: it is the only safe ranking evidence before a
    // lane has sent a real reply. A new transport clears both profiles in
    // Lane.recycle(), which is the correct invalidation boundary.
    if (measurement === 'send' || measurement === 'preflight') return true;
    return now - last <= this.#opts.sampleMaxAgeMs;
  }

  #candidates(lanes: Lane[], role: LaneRole): Lane[] {
    const reserved = this.#opts.sendReservedLanes;
    if (reserved === 0) return lanes;
    // Untagged LINEJS work is control/background traffic, not a reply. Keep it
    // in the receive band as well so a long-lived generic RPC cannot make the
    // fastest send lane look busy and force the one-shot reply onto a slower
    // route. If that band is unavailable #pick() still fails open to all
    // routable lanes through its existing preferred/pool fallback.
    return lanes.filter((lane) => role === 'send' ? lane.id < reserved : lane.id >= reserved);
  }

  #roleFor(id: number): 'send' | 'poll' | 'shared' {
    if (this.#opts.sendReservedLanes === 0) return 'shared';
    return id < this.#opts.sendReservedLanes ? 'send' : 'poll';
  }

  /** Spares keep the `send` role — they carry replies and are measured and
   * badged as reply lanes — and are only marked separately so an operator can
   * see which ones are being held back. */
  #isSpare(id: number): boolean {
    const spares = this.#opts.sendSpareLanes;
    return spares > 0 && id >= this.#opts.sendReservedLanes - spares &&
      id < this.#opts.sendReservedLanes;
  }

  #afterSend(lane: Lane, { rttMs: rtt, contended }: LaneSample): void {
    // The fast-route rule, reacting to this one reply rather than waiting for
    // the median to catch up: over the threshold on a lane it had to itself,
    // and the pin drops so the next reply re-picks. Sharing the lane exempts
    // it — that RTT measured the queue, and dropping the pin on it would send
    // the pool chasing lanes every time two replies overlapped.
    // A reply over the target lets the next selection reconsider the pin, but
    // 21–22ms is ordinary jitter around a 20ms target.  That small breach must
    // not put an otherwise proven route in the bypass set: #pickSend can pick
    // it again immediately if its p50/p95 still make it the best route.  Only
    // a material breach (target + 3ms), or an observed losing tail, earns the
    // short bypass.  The tail remains excluded after that bypass expires.
    const rawBreach = rtt > this.#opts.fastRouteThresholdMs;
    const materialRawBreach = rtt > this.#opts.fastRouteThresholdMs + 3;
    const tailBreach = !this.#isSendTailEligible(lane);
    if (!materialRawBreach && !tailBreach) this.#fastBypassUntil.delete(lane.id);
    else if (!contended) {
      this.#fastBypassUntil.set(
        lane.id,
        this.#clock.monotonic() + this.#opts.slowCooldownMs,
      );
    }

    if (
      (rawBreach || tailBreach) && !contended &&
      this.#currentSendLaneId === lane.id
    ) {
      // Cleared silently: the next pick decides whether this actually means a
      // different lane. Logging here fired once per reply whenever no lane
      // could hold the threshold, which said nothing an operator could use —
      // `#pinSend` reports the switches that really happen instead.
      this.#currentSendLaneId = undefined;
      this.#lastUnpin = { lane: lane.id, rttMs: Math.round(rtt * 100) / 100 };
    }

    // Contended samples are excluded here too: parking a lane for being busy
    // removes the very capacity that was absorbing the load.
    if (contended) return;

    if (rtt <= this.#opts.slowThresholdMs) {
      this.#slowSendStreak[lane.id] = 0;
      return;
    }
    const streak = Math.min(255, (this.#slowSendStreak[lane.id] ?? 0) + 1);
    this.#slowSendStreak[lane.id] = streak;
    if (streak < this.#opts.slowSamplesBeforeCooldown) return;
    if (this.#routableCount() <= 1) return; // never park the last lane
    this.#slowSendStreak[lane.id] = 0;
    this.#cooldownUntil.set(lane.id, this.#clock.monotonic() + this.#opts.slowCooldownMs);
    if (this.#currentSendLaneId === lane.id) this.#currentSendLaneId = undefined;
    this.#logger.warn('send lane parked (consecutively slow)', {
      lane: lane.id,
      rttMs: rtt,
      samples: this.#opts.slowSamplesBeforeCooldown,
    });
  }

  #afterFailure(lane: Lane, error: unknown): void {
    if (!isGoAway(error) && classifyError(error) !== 'transient') return;
    // The pin names a physical route, and this one is being replaced.
    if (this.#currentSendLaneId === lane.id) this.#currentSendLaneId = undefined;
    lane.drain();
    this.#logger.warn('lane drained', { lane: lane.id, reason: 'goaway/transient' });
    if (!this.#closed) {
      lane.recycle(); // fresh physical route; re-measured on next use
      this.#fastBypassUntil.delete(lane.id);
      this.#cooldownUntil.delete(lane.id);
      this.#slowSendStreak[lane.id] = 0;
    }
  }

  /** Runs only from the background warmer. The old implementation called this
   * from #pick(), then selected the newly-created cold poll transport for that
   * same live request. Here the replacement completes a HEAD/TLS round trip
   * before it is exposed to normal poll selection. */
  async maintain(origin: string): Promise<void> {
    const victim = this.#recycleOldest();
    if (victim === undefined) return;
    this.#cooldownUntil.set(victim.id, Number.POSITIVE_INFINITY);
    try {
      const response = await victim.send(new Request(origin, { method: 'HEAD' }), 'warm');
      await response.body?.cancel();
    } catch (error: unknown) {
      this.#afterFailure(victim, error);
      this.#logger.warn('lane background prime failed', {
        lane: victim.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.#cooldownUntil.delete(victim.id);
    }
  }

  #recycleOldest(): Lane | undefined {
    const now = this.#clock.monotonic();
    if (now - this.#lastRecycleMono < this.#opts.recycleGapMs) return undefined;
    const stale = this.#lanes
      .filter((l) =>
        l.isRoutable() && l.inFlight === 0 && l.ageMs() >= this.#opts.maxAgeMs &&
        // Never age-recycle a reserved reply lane. A fresh Deno client has to
        // pay TCP/TLS setup on its first real SEND; doing that to a reply lane
        // during steady state created the 80ms+ spikes that lose a one-shot
        // race. Reply routes are still replaced immediately on GOAWAY/error,
        // and slow-route selection can move away from a bad lane without
        // manufacturing a cold handshake on an otherwise healthy one.
        l.id >= this.#opts.sendReservedLanes &&
        // This guard remains relevant when the pool is configured without a
        // dedicated send reservation: a fresh fast pin still gets priority.
        !(l.id === this.#currentSendLaneId && this.#hasFreshSample(l, 'send', now) &&
          this.#isFastLane(l))
      )
      .sort((a, b) => b.ageMs() - a.ageMs());
    const victim = stale[0];
    if (victim === undefined || this.#routableCount() <= 1) return undefined;
    if (this.#currentSendLaneId === victim.id) this.#currentSendLaneId = undefined;
    victim.recycle();
    this.#fastBypassUntil.delete(victim.id);
    this.#lastRecycleMono = now;
    this.#logger.info('lane recycled (age)', { lane: victim.id });
    return victim;
  }

  #routableCount(): number {
    return this.#lanes.filter((lane) => lane.isRoutable()).length;
  }
}

function warmRequestForObservedOrigin(
  request: Request,
  observedOrigin: string | undefined,
): Request {
  if (observedOrigin === undefined) return request;
  const requestedOrigin = new URL(request.url).origin;
  let url: string;
  if (observedOrigin === 'https://legy.line-apps.com') url = `${observedOrigin}/SQ1`;
  else if (observedOrigin === 'https://gf.line.naver.jp') url = `${observedOrigin}/enc`;
  else if (observedOrigin === requestedOrigin) return request;
  else return request;
  if (url === request.url) return request;
  return new Request(url, {
    method: 'HEAD',
    headers: request.headers,
    signal: request.signal,
  });
}

function readRole(headers: Headers): LaneRole {
  const value = headers.get(LANE_ROLE_HEADER);
  return value === 'send' || value === 'poll' ? value : 'general';
}

function readForcedLane(headers: Headers): number | undefined {
  const raw = headers.get(LANE_FORCE_HEADER);
  if (raw === null || raw === '') return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}
