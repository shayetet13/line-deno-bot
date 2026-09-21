import type { StatusSnapshot } from '../observability/snapshot.ts';

/**
 * Alerting for the four things Phases §19 names: missed events, first-response
 * regression, readiness loss, failure rate.
 *
 * Two rules shape every threshold here:
 *
 *  1. It reads a snapshot. Nothing in this file runs on the reply path.
 *  2. A single bad sample is not an alert. A latency spike is normal; a spike
 *     that persists is a problem. Playbook §16 is explicit that restarting a
 *     worker must not be triggered by one slow send, so the detectors need
 *     both a threshold and a duration before they fire.
 */

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_KINDS = [
  'readiness-loss',
  'missed-events',
  'first-response-regression',
  'line-trigger-reply-budget',
  'failure-rate',
  'no-lane-available',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** One line naming the number that tripped it. */
  message: string;
  /** How long the condition has held, ms. */
  forMs: number;
  observed: number;
  threshold: number;
}

export interface AlertThresholds {
  /** ARMED must come back within this long, or readiness loss is an alert. */
  readinessLossMs: number;
  /** Minimum share of wins the weakest configured receive path must hold.
   * Below it we suspect that path is silently dead. */
  missedEventRate: number;
  /** How many receive paths are actually configured. The missed-event rule is
   * off below two, because a single path winning everything is correct then. */
  racedSources: number;
  /** How much worse than the recorded baseline p95 send is a regression. */
  regressionFactor: number;
  /** Hard p95 budget on LINE's own trigger-to-reply timestamps. */
  lineTriggerReplyP95Ms: number;
  /** Fraction of sends that failed. */
  failureRate: number;
  /** A condition must hold this long before it is an alert rather than a blip. */
  minDurationMs: number;
  /** Below this many samples, latency and rate rules stay quiet — a 100% failure
   * rate over two sends is noise. */
  minSamples: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  readinessLossMs: 30_000,
  missedEventRate: 0.2,
  racedSources: 1,
  regressionFactor: 1.5,
  // 2026-09-21: raised from 30 — real production p95 on Tokyo 3 sits ~42ms
  // (LINE-side processing, confirmed non-reducible; see dashboard.ts BUDGET
  // comment and docs/experiments.md `native-encode-relay`). 46 gives headroom
  // above the observed floor instead of alerting on expected behavior.
  lineTriggerReplyP95Ms: 46,
  failureRate: 0.05,
  minDurationMs: 60_000,
  minSamples: 20,
};

export interface AlertBaseline {
  /** p95 send RTT this release is expected to hold, from the last good run. */
  sendP95Ms: number;
  /** The release the baseline was measured on. Comparing across releases is
   * the point (Phases §19: "แยก metrics version เก่า/ใหม่"). */
  releaseLabel: string;
}

interface Pending {
  sinceMs: number;
  observed: number;
}

/**
 * Stateful because duration matters. Feed it snapshots; it returns the alerts
 * that are currently firing.
 */
export class AlertEvaluator {
  readonly #thresholds: AlertThresholds;
  readonly #pending = new Map<AlertKind, Pending>();
  #baseline: AlertBaseline | undefined;

  constructor(thresholds: Partial<AlertThresholds> = {}, baseline?: AlertBaseline) {
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.#baseline = baseline;
  }

  /** Adopt the current numbers as the expected ones. Call after a release has
   * been observed healthy, so the next release is compared against it. */
  setBaseline(baseline: AlertBaseline): void {
    this.#baseline = baseline;
    this.#pending.delete('first-response-regression');
  }

  get baseline(): AlertBaseline | undefined {
    return this.#baseline;
  }

  evaluate(snapshot: StatusSnapshot): readonly Alert[] {
    const t = this.#thresholds;
    const now = snapshot.generatedAtMs;
    const alerts: Alert[] = [];

    const push = (
      kind: AlertKind,
      firing: boolean,
      severity: AlertSeverity,
      observed: number,
      threshold: number,
      message: (forMs: number) => string,
    ): void => {
      if (!firing) {
        this.#pending.delete(kind);
        return;
      }
      const pending = this.#pending.get(kind) ?? { sinceMs: now, observed };
      pending.observed = observed;
      this.#pending.set(kind, pending);
      const forMs = now - pending.sinceMs;
      if (forMs < t.minDurationMs) return;
      alerts.push({ kind, severity, observed, threshold, forMs, message: message(forMs) });
    };

    // 1. Readiness loss. The worker says it is not able to answer; that is the
    //    most actionable signal there is, so it gets the shortest fuse.
    const readiness = snapshot.readiness;
    if (readiness !== undefined && readiness.state !== 'armed') {
      const pending = this.#pending.get('readiness-loss') ?? { sinceMs: now, observed: 0 };
      this.#pending.set('readiness-loss', pending);
      const forMs = now - pending.sinceMs;
      if (forMs >= t.readinessLossMs) {
        alerts.push({
          kind: 'readiness-loss',
          severity: readiness.state === 'degraded' ? 'critical' : 'warning',
          message: `not ARMED for ${fmtMs(forMs)} (state ${readiness.state}${
            readiness.reason === undefined ? '' : `: ${readiness.reason}`
          })`,
          forMs,
          observed: forMs,
          threshold: t.readinessLossMs,
        });
      }
    } else {
      this.#pending.delete('readiness-loss');
    }

    // 2. Missed events. Keyed on `seen`, not `wins`: once one receive path is
    //    consistently faster by design (a dedicated poll with no gap between
    //    rounds beats push on essentially every message), the slower path
    //    winning 0% of races is correct behaviour, not a dead path — a fast
    //    poll interval is precisely what should make this NOT fire on win
    //    share alone. `seen` counts every message a source offered, win or
    //    duplicate, so a path that is merely losing still shows up here; only
    //    a path that has actually stopped observing traffic reads as zero.
    const race = snapshot.race;
    if (race !== undefined && t.racedSources >= 2) {
      const seen = Object.values(race.seen);
      const total = seen.reduce((sum, w) => sum + w, 0);
      // Only the configured paths count: an unused source is not a dead one.
      const weakest = seen.sort((a, b) => b - a).slice(0, t.racedSources).at(-1) ?? 0;
      const share = total === 0 ? 0 : weakest / total;
      push(
        'missed-events',
        total >= t.minSamples && share < t.missedEventRate,
        'warning',
        round(share),
        t.missedEventRate,
        (forMs) =>
          `weakest receive path observed only ${fmtPct(share)} of ${String(total)} events for ${
            fmtMs(forMs)
          } — it may be dead`,
      );
    }

    // 3. First-response regression, against this release's own baseline.
    const send = snapshot.metrics.spans.send;
    const baseline = this.#baseline;
    if (send !== undefined && baseline !== undefined) {
      const limit = baseline.sendP95Ms * t.regressionFactor;
      push(
        'first-response-regression',
        send.window >= t.minSamples && send.p95 > limit,
        'warning',
        round(send.p95),
        round(limit),
        (forMs) =>
          `send p95 ${send.p95.toFixed(1)}ms vs baseline ${baseline.sendP95Ms.toFixed(1)}ms ` +
          `(${baseline.releaseLabel}) for ${fmtMs(forMs)}`,
      );
    }

    // 4. The outcome budget is evaluated on LINE's own trigger and reply
    // timestamps. Unlike an ACK-only number, this includes the path we are
    // actually trying to win and has no host clock-skew term.
    const lineRoundTrip = snapshot.metrics.crossHost?.line_round_trip;
    if (lineRoundTrip !== undefined) {
      push(
        'line-trigger-reply-budget',
        lineRoundTrip.window >= t.minSamples && lineRoundTrip.p95 > t.lineTriggerReplyP95Ms,
        lineRoundTrip.p95 > t.lineTriggerReplyP95Ms * 1.5 ? 'critical' : 'warning',
        round(lineRoundTrip.p95),
        t.lineTriggerReplyP95Ms,
        (forMs) =>
          `LINE trigger→reply p95 ${
            lineRoundTrip.p95.toFixed(1)
          }ms exceeds ${t.lineTriggerReplyP95Ms}ms for ${fmtMs(forMs)}`,
      );
    }

    // 5. Failure rate across everything that reached the sender.
    const counters = snapshot.metrics.counters;
    const dispatched = counters['outcome.dispatched'] ?? 0;
    const failed = counters['outcome.send-failed'] ?? 0;
    const attempted = dispatched + failed;
    const failureRate = attempted === 0 ? 0 : failed / attempted;
    push(
      'failure-rate',
      attempted >= t.minSamples && failureRate > t.failureRate,
      failureRate > t.failureRate * 4 ? 'critical' : 'warning',
      round(failureRate),
      t.failureRate,
      (forMs) => `${fmtPct(failureRate)} of ${String(attempted)} sends failed for ${fmtMs(forMs)}`,
    );

    // 6. No usable lane. Distinct from a slow lane: there is nothing to route to.
    const lanes = snapshot.lanes;
    const usable = lanes.filter((l) => l.badge === 'hot' || l.badge === 'standby').length;
    push(
      'no-lane-available',
      lanes.length > 0 && usable === 0,
      'critical',
      usable,
      1,
      (forMs) => `all ${String(lanes.length)} lanes unusable for ${fmtMs(forMs)}`,
    );

    return alerts;
  }

  /** Conditions being watched that have not yet fired. Useful on a dashboard:
   * "this has been true for 20s, it alerts at 60s". */
  get pending(): readonly { kind: AlertKind; sinceMs: number; observed: number }[] {
    return [...this.#pending].map(([kind, p]) => ({ kind, ...p }));
  }
}

const round = (v: number): number => Math.round(v * 1000) / 1000;
const fmtMs = (ms: number): string => ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
const fmtPct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
