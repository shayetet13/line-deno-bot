import type { Brand } from './brand.ts';

/**
 * Identity of a single job (one race for one first-response win).
 *
 * Derived per decision doc §5 / Phases §8:
 *   - explicit id present  → `id:<jobId>`
 *   - otherwise            → hash(sourceMessageId + senderId + roomId + ruleId)
 *
 * NEVER `hash(keyword)` alone — the same keyword in a later round is a NEW job.
 */
export type JobKey = Brand<string, 'JobKey'>;

export const unsafeJobKey = (value: string): JobKey => value as JobKey;

/** Per-job lifecycle. `UNKNOWN` is terminal-but-unresolved (e.g. ACK timeout). */
export const JOB_STATES = [
  'waiting',
  'eligible-trigger',
  'first-response-dispatched',
  'won',
  'lost',
  'unknown',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export type JobOutcome = Extract<JobState, 'won' | 'lost' | 'unknown'>;

export const isTerminalJobState = (state: JobState): state is JobOutcome =>
  state === 'won' || state === 'lost' || state === 'unknown';
