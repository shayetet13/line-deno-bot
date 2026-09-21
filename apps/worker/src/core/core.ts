import type { WorkerConfig } from '../config/env.ts';
import { type Clock, systemClock } from '../lib/clock.ts';
import { Claims } from './dedupe/claims.ts';
import { JobRegistry } from './jobs/job-registry.ts';
import { RateLimiter } from './ratelimit/limiter.ts';

/**
 * Phase 1 correctness core, wired together. The order a message flows through
 * these (decision doc §8 step 1):
 *
 *   claims.incomingMessage → rules.match → claims.reply → claims.roomAnswer
 *   → rateLimiter.tryAdmit → jobs.markDispatched
 *
 * Every piece is deterministic and clock-injected so the whole core can be
 * driven by a {@link FakeClock} in tests and replay benches.
 */
export interface CorrectnessCore {
  readonly claims: Claims;
  readonly rateLimiter: RateLimiter;
  readonly jobs: JobRegistry;
}

export function createCore(config: WorkerConfig, clock: Clock = systemClock): CorrectnessCore {
  return {
    claims: new Claims(clock, config.claims),
    rateLimiter: new RateLimiter(clock, config.rateLimit),
    jobs: new JobRegistry(clock, config.jobRegistry),
  };
}
