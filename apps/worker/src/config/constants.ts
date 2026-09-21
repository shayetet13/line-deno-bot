/**
 * Named constants. No magic numbers anywhere else in the worker
 * (`CLAUDE .md` §4: `setTimeout(5000)` → `RETRY_DELAY_MS`).
 */

/** One second in milliseconds. */
export const MS_PER_SECOND = 1_000;

/** Defaults for the correctness-core stores. Overridable via env. */
export const DEFAULTS = {
  claimIncoming: { ttlMs: 120_000, maxEntries: 50_000 },
  claimReply: { ttlMs: 120_000, maxEntries: 50_000 },
  claimRoomAnswer: { ttlMs: 120_000, maxEntries: 50_000 },
  jobRegistry: { ttlMs: 900_000, maxEntries: 10_000 },
  rateLimit: { capacity: 5, refillPerSec: 2 },
  opTimeoutMs: 15_000,
  connectionWarmupConcurrency: 2,
} as const;

/** Log levels, ordered by severity. Index = numeric severity. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
