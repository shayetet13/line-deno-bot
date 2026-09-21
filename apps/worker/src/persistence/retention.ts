import { ValidationError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';

/**
 * Retention and rollups (Phases §19: "จำกัด retention ของ raw events; เก็บ
 * rollups ระยะยาว; ไม่บันทึก token/QR secrets ใน trace").
 *
 * Raw per-event rows are what makes a bad week diagnosable and what makes the
 * database grow without bound. The compromise is to keep raw rows for days and
 * hourly rollups forever: a regression weeks later is still visible in the
 * rollup, and no message text or credential survives the window.
 */

export interface RawEventRow {
  /** Epoch ms the event was recorded. */
  atMs: number;
  /** Pipeline outcome, e.g. `dispatched`. */
  outcome: string;
  /** Send RTT for this event, ms, or undefined when it never reached the wire. */
  sendMs: number | undefined;
  releaseLabel: string;
}

export interface RollupBucket {
  /** Epoch ms of the start of the hour. */
  hourStartMs: number;
  releaseLabel: string;
  count: number;
  dispatched: number;
  failed: number;
  /** Percentiles over the events in this hour. */
  p50Ms: number | undefined;
  p95Ms: number | undefined;
  maxMs: number | undefined;
}

export const HOUR_MS = 3_600_000;

export interface RetentionPolicy {
  /** Raw rows older than this are deleted once rolled up. */
  rawRetentionMs: number;
  /** Rollups older than this are deleted. 0 means keep forever. */
  rollupRetentionMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  rawRetentionMs: 7 * 24 * HOUR_MS,
  rollupRetentionMs: 0,
};

/**
 * Groups raw rows into hourly buckets, split by release.
 *
 * Splitting by release is the whole reason this exists rather than a single
 * time series: comparing first response across versions is a Phase 11 pass
 * criterion, and a mixed bucket cannot answer it.
 */
export function rollup(rows: readonly RawEventRow[]): RollupBucket[] {
  const buckets = new Map<string, { bucket: RollupBucket; samples: number[] }>();

  for (const row of rows) {
    const hourStartMs = Math.floor(row.atMs / HOUR_MS) * HOUR_MS;
    const key = `${String(hourStartMs)}|${row.releaseLabel}`;
    let entry = buckets.get(key);
    if (entry === undefined) {
      entry = {
        bucket: {
          hourStartMs,
          releaseLabel: row.releaseLabel,
          count: 0,
          dispatched: 0,
          failed: 0,
          p50Ms: undefined,
          p95Ms: undefined,
          maxMs: undefined,
        },
        samples: [],
      };
      buckets.set(key, entry);
    }
    entry.bucket.count += 1;
    if (row.outcome === 'dispatched') entry.bucket.dispatched += 1;
    if (row.outcome === 'send-failed') entry.bucket.failed += 1;
    if (row.sendMs !== undefined) entry.samples.push(row.sendMs);
  }

  const out: RollupBucket[] = [];
  for (const { bucket, samples } of buckets.values()) {
    samples.sort((a, b) => a - b);
    out.push({
      ...bucket,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      maxMs: samples.at(-1),
    });
  }
  return out.sort((a, b) =>
    a.hourStartMs - b.hourStartMs ||
    (a.releaseLabel < b.releaseLabel ? -1 : a.releaseLabel > b.releaseLabel ? 1 : 0)
  );
}

export interface PruneResult {
  keptRaw: RawEventRow[];
  keptRollups: RollupBucket[];
  droppedRaw: number;
  droppedRollups: number;
}

/**
 * Applies the policy. Raw rows are only dropped once an equivalent rollup
 * exists — otherwise pruning silently destroys the record instead of
 * compressing it.
 */
export function prune(
  raw: readonly RawEventRow[],
  rollups: readonly RollupBucket[],
  clock: Clock,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): PruneResult {
  if (policy.rawRetentionMs < 0 || policy.rollupRetentionMs < 0) {
    throw new ValidationError('retention windows must not be negative', { policy });
  }
  const now = clock.now();
  const rawCutoff = now - policy.rawRetentionMs;
  const covered = new Set(rollups.map((r) => `${String(r.hourStartMs)}|${r.releaseLabel}`));

  const keptRaw = raw.filter((row) => {
    if (row.atMs >= rawCutoff) return true;
    const hourStartMs = Math.floor(row.atMs / HOUR_MS) * HOUR_MS;
    // Past the window but not rolled up yet: keep it rather than lose it.
    return !covered.has(`${String(hourStartMs)}|${row.releaseLabel}`);
  });

  const keptRollups = policy.rollupRetentionMs === 0
    ? [...rollups]
    : rollups.filter((r) => r.hourStartMs >= now - policy.rollupRetentionMs);

  return {
    keptRaw,
    keptRollups,
    droppedRaw: raw.length - keptRaw.length,
    droppedRollups: rollups.length - keptRollups.length,
  };
}

/** Nearest-rank, matching the metrics ring so numbers agree across the system. */
function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
