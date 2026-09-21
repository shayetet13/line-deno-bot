import type { Clock } from '../lib/clock.ts';

/**
 * The points one message passes through, in order (Phases §5).
 *
 * Every mark is taken on the MONOTONIC clock, so any span between two of them
 * is exact and immune to wall-clock drift. The one cross-host value —
 * `sourceEventTimeMs`, stamped by LINE — is kept apart deliberately: comparing
 * it against our clock costs the accuracy of our NTP sync, so spans that use it
 * are reported separately and never mixed into the local totals.
 */
export const TRACE_POINTS = [
  /** Push notification observed. */
  'notice_rx',
  /** Started fetching the body, when the notification did not carry it. */
  'fetch_submit',
  /** Full payload in hand, before our own decoding. */
  'message_bytes_ready',
  /** Decoded/decrypted and the sender identified. */
  'decoded',
  /** Rule matching started (gates before it are not separately instrumented). */
  'rule_match_start',
  /** A rule selected the reply. */
  'matched',
  /** Rate-limiter admission check started. */
  'limiter_check_start',
  /** Rate-limiter admission check returned, admitted or not. */
  'limiter_check_done',
  /** Request sequence allocated. */
  'sequence_ready',
  /** Request handed to the transport. */
  'transport_submit',
  /** Socket write, where the runtime exposes it. */
  'write_observed',
  /** Response read and validated. */
  'ack_complete',
  /** An observer saw the message land, when one exists. */
  'observer_seen',
  /** The game confirmed the winner, when it reports one. */
  'winner_confirmed',
] as const;

export type TracePoint = (typeof TRACE_POINTS)[number];

const INDEX: Readonly<Record<TracePoint, number>> = Object.freeze(
  Object.fromEntries(TRACE_POINTS.map((p, i) => [p, i])) as Record<TracePoint, number>,
);

/** Spans worth reporting. `crossHost` ones inherit the clock-sync error. */
export const SPANS = {
  /** LINE stamped it → we had the bytes. Cross-host: only as good as NTP. */
  inbound: { from: 'message_bytes_ready', crossHost: true },
  /** Everything we control before the request leaves. */
  code: { from: 'message_bytes_ready', to: 'transport_submit', crossHost: false },
  /** Request out → response validated. The number that decides races. */
  send: { from: 'transport_submit', to: 'ack_complete', crossHost: false },
  /** Notification seen → response validated, all on our clock. */
  local_total: { from: 'notice_rx', to: 'ack_complete', crossHost: false },
  /** Time spent inside `rules.match()` alone. */
  match: { from: 'rule_match_start', to: 'matched', crossHost: false },
  /** Time spent inside the rate limiter's admission check alone. */
  limiter: { from: 'limiter_check_start', to: 'limiter_check_done', crossHost: false },
} as const;

/**
 * `pre_dispatch` is not measured directly — it is `code` minus the two gates
 * we do instrument individually (`match`, `limiter`), i.e. everything else
 * on the code path (allowlist, dedupe claims, job bookkeeping, cmd build)
 * that isn't worth a mark of its own yet.
 *
 * `protocol_prep` is not a mark at all, and not attached to one message
 * either: it is the real `writeThrift` cost, filed by the listener in
 * adapters/linejs/thrift-timing.ts the moment each encode happens. LINEJS
 * awaits `getReqseq()` before encoding, so a second room's send can reach
 * the encoder between one send starting and finishing — which makes a
 * rolling sample across recent sends the only honest shape for it, rather
 * than a per-call span this `Trace` could carry.
 */
export type SpanName = keyof typeof SPANS | 'pre_dispatch' | 'protocol_prep' | 'sequence_prep';

export interface TraceRecord {
  marks: Partial<Record<TracePoint, number>>;
  spans: Partial<Record<SpanName, number>>;
  sourceEventTimeMs: number | undefined;
}

export interface TraceLike {
  readonly sourceEventTimeMs: number | undefined;
  mark(point: TracePoint): void;
  markAt(point: TracePoint, monotonicMs: number): void;
  at(point: TracePoint): number | undefined;
  span(from: TracePoint, to: TracePoint): number | undefined;
  inboundMs(point?: TracePoint, nowMs?: number): number | undefined;
  toRecord(): TraceRecord;
}

const EMPTY_RECORD: TraceRecord = Object.freeze({
  marks: {},
  spans: {},
  sourceEventTimeMs: undefined,
});

/** Tracing turned off. Lets the pipeline run the same code path with the
 * instrumentation removed, which is how its overhead gets measured
 * (Phases Phase 2: "วัด instrumentation overhead เปิด/ปิดและรายงานแยก"). */
export const NULL_TRACE: TraceLike = Object.freeze({
  sourceEventTimeMs: undefined,
  mark: (): void => {},
  markAt: (): void => {},
  at: (): undefined => undefined,
  span: (): undefined => undefined,
  inboundMs: (): undefined => undefined,
  toRecord: (): TraceRecord => EMPTY_RECORD,
});

/**
 * Records timing marks for one message.
 *
 * Marks live in a fixed `Float64Array` rather than a Map: one allocation, no
 * rehashing, and `mark()` is an array write plus a clock read — cheap enough to
 * sit on the hot path. Turning marks into percentiles happens later, off it
 * (Playbook §6.2, §13.3).
 */
export class Trace implements TraceLike {
  readonly #at = new Float64Array(TRACE_POINTS.length).fill(Number.NaN);
  readonly #clock: Clock;

  constructor(clock: Clock, readonly sourceEventTimeMs: number | undefined = undefined) {
    this.#clock = clock;
  }

  /** Stamps `point`. The first mark for a point wins; repeats are ignored so a
   * retry cannot rewrite history. */
  mark(point: TracePoint): void {
    this.markAt(point, this.#clock.monotonic());
  }

  /** Records a mark taken earlier elsewhere — e.g. the moment the receiver
   * first saw the event, captured before the pipeline was entered. */
  markAt(point: TracePoint, monotonicMs: number): void {
    const i = INDEX[point];
    if (Number.isNaN(this.#at[i])) this.#at[i] = monotonicMs;
  }

  at(point: TracePoint): number | undefined {
    const value = this.#at[INDEX[point]];
    return value === undefined || Number.isNaN(value) ? undefined : value;
  }

  /** Milliseconds between two marks, or `undefined` if either is missing. */
  span(from: TracePoint, to: TracePoint): number | undefined {
    const a = this.at(from);
    const b = this.at(to);
    return a === undefined || b === undefined ? undefined : b - a;
  }

  /** Wall-clock estimate of `sourceEventTimeMs → point`. Carries the host's
   * clock offset — report it with that offset, never as a bare latency. */
  inboundMs(point: TracePoint = 'message_bytes_ready', nowMs = Date.now()): number | undefined {
    if (this.sourceEventTimeMs === undefined || this.at(point) === undefined) return undefined;
    return nowMs - this.sourceEventTimeMs;
  }

  toRecord(): TraceRecord {
    const marks: Partial<Record<TracePoint, number>> = {};
    for (const point of TRACE_POINTS) {
      const value = this.at(point);
      if (value !== undefined) marks[point] = value;
    }
    return { marks, spans: this.#spans(), sourceEventTimeMs: this.sourceEventTimeMs };
  }

  #spans(): Partial<Record<SpanName, number>> {
    const spans: Partial<Record<SpanName, number>> = {};
    for (
      const [name, def] of Object.entries(SPANS) as [
        keyof typeof SPANS,
        typeof SPANS[keyof typeof SPANS],
      ][]
    ) {
      if (def.crossHost) continue;
      const value = this.span(def.from, (def as { to: TracePoint }).to);
      if (value !== undefined) spans[name] = value;
    }
    // Floored at 0: clock jitter between adjacent marks could otherwise make
    // "everything else" read as a small negative number, which is nonsense
    // for a duration nobody would read as anything but a rounding artifact.
    if (spans.code !== undefined && spans.match !== undefined && spans.limiter !== undefined) {
      spans.pre_dispatch = Math.max(0, spans.code - spans.match - spans.limiter);
    }
    return spans;
  }
}
