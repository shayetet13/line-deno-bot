import { MS_PER_SECOND } from '../config/constants.ts';
import type { Clock } from '../lib/clock.ts';
import type { LaneStat } from '../transport/lane-pool.ts';

/**
 * What the dashboard shows for a lane.
 *
 * `hot` is the lane routing would actually pick right now. It is computed HERE,
 * from the same numbers the router uses — never re-derived in the UI from
 * history or star scores, which is exactly how a 26.8ms lane once displayed as
 * HOT while a 16.3ms one displayed as COOL (Playbook §10.9).
 */
export type LaneBadge = 'hot' | 'standby' | 'wait' | 'down';

/** A measurement older than this is not evidence about the lane now: "16ms as
 * of ten minutes ago" tells you nothing (Playbook §13.2). */
export const DEFAULT_SAMPLE_MAX_AGE_MS = 15 * 60 * MS_PER_SECOND;

export interface LaneView {
  laneId: number;
  workerId: string;
  origin: string;
  remoteAddress?: string | undefined;
  remoteOrigin?: string | undefined;
  badge: LaneBadge;
  state: string;
  inFlight: number;
  /** Application RTT — a real request to LINE, never a PING (Playbook §2). */
  applicationRttMs: number | undefined;
  /** P95 over the same real RPC samples. */
  tailRttMs?: number | undefined;
  /** Tail-aware completion estimate used by routing. */
  predictedRttMs?: number | undefined;
  /** Warm HEAD RTT is diagnostic only and is never presented as application
   * RTT or used to compare a real send against a poll. */
  warmRttMs?: number | undefined;
  /** Read-only Square startup calibration; never mixed into send p50/p95. */
  preflightRttMs?: number | undefined;
  preflightSampleAgeMs?: number | undefined;
  /** How old that measurement is. Shown so a stale number cannot masquerade
   * as a live one. */
  sampleAgeMs: number | undefined;
  ageMs: number;
  consecutiveFailures: number;
  /** Traffic role; optional for compatibility with older snapshots. */
  role?: LaneStat['role'];
  /** Accumulated rabbits/turtles for this route, passed through untouched —
   * the router owns this number, the dashboard only renders it. */
  score?: LaneStat['score'];
  /** True for the lane replies are pinned to right now. */
  currentSend?: boolean;
  /** True for a reply lane held back as a spare. */
  spare?: boolean;
  /** Whether ordinary routing currently considers the lane. */
  routeEligible?: boolean;
}

export interface ClassifyOptions {
  clock: Clock;
  workerId: string;
  origin: string;
  sampleMaxAgeMs?: number;
}

/**
 * Turns raw lane stats into what the dashboard renders, deciding the badge on
 * the backend so UI and router can never disagree.
 */
export function classifyLanes(
  stats: readonly LaneStat[],
  options: ClassifyOptions,
): LaneView[] {
  const maxAge = options.sampleMaxAgeMs ?? DEFAULT_SAMPLE_MAX_AGE_MS;
  const now = options.clock.monotonic();

  const withFreshness = stats.map((stat) => {
    const sampleAgeMs = stat.lastSampleMono === undefined ? undefined : now - stat.lastSampleMono;
    // SEND evidence is tied to the physical lane and Lane.recycle() clears it.
    // Keeping the same warmed transport across an idle period must not make
    // the dashboard disagree with the router and hide the lane it still pins.
    const fresh = stat.medianRttMs !== undefined &&
      (stat.role === 'send' || sampleAgeMs === undefined || sampleAgeMs <= maxAge);
    return { stat, sampleAgeMs, fresh };
  });

  // Reservation creates independent send and poll candidate sets. Select the
  // best fresh available measurement inside each set, matching pool routing.
  const bestByRole = new Map<LaneStat['role'], number>();
  for (const { stat, fresh } of withFreshness) {
    if (
      !fresh || stat.state !== 'ready' || stat.available === false ||
      stat.routeEligible === false || stat.medianRttMs === undefined
    ) continue;
    const routingRtt = stat.predictedRttMs ?? stat.medianRttMs;
    const best = bestByRole.get(stat.role);
    if (best === undefined || routingRtt < best) {
      bestByRole.set(stat.role, routingRtt);
    }
  }

  return withFreshness.map(({ stat, sampleAgeMs, fresh }) => {
    const roleBest = bestByRole.get(stat.role);
    return {
      laneId: stat.id,
      workerId: options.workerId,
      origin: options.origin,
      remoteAddress: stat.remoteAddress,
      remoteOrigin: stat.remoteOrigin,
      badge: badgeFor(stat, fresh, roleBest),
      state: stat.state,
      inFlight: stat.inFlight,
      applicationRttMs: fresh ? stat.medianRttMs : undefined,
      tailRttMs: fresh ? stat.tailRttMs : undefined,
      predictedRttMs: fresh ? stat.predictedRttMs : undefined,
      warmRttMs: stat.warmRttMs,
      preflightRttMs: stat.preflightRttMs,
      preflightSampleAgeMs: stat.preflightLastSampleMono === undefined
        ? undefined
        : now - stat.preflightLastSampleMono,
      sampleAgeMs,
      ageMs: stat.ageMs,
      consecutiveFailures: stat.consecutiveFailures,
      role: stat.role,
      score: stat.score,
      currentSend: stat.currentSend,
      spare: stat.spare,
      routeEligible: stat.routeEligible,
    };
  });
}

function badgeFor(stat: LaneStat, fresh: boolean, best: number | undefined): LaneBadge {
  if (stat.state === 'dead') return 'down';
  if (stat.state !== 'ready' || stat.available === false || stat.routeEligible === false) {
    return 'wait';
  }
  if (!fresh || stat.medianRttMs === undefined) return 'wait';
  return best !== undefined && (stat.predictedRttMs ?? stat.medianRttMs) === best
    ? 'hot'
    : 'standby';
}
