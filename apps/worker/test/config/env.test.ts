import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unreachable } from '@std/assert';
import { loadConfig } from '../../src/config/env.ts';
import { DEFAULTS } from '../../src/config/constants.ts';
import { ConfigError } from '../../src/errors/base.ts';

describe('loadConfig', () => {
  test('returns defaults for an empty source', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.claims.incoming.ttlMs).toBe(DEFAULTS.claimIncoming.ttlMs);
    expect(config.rateLimit.capacity).toBe(DEFAULTS.rateLimit.capacity);
    expect(config.jobRegistry.maxEntries).toBe(DEFAULTS.jobRegistry.maxEntries);
    expect(config.defaultOpTimeoutMs).toBe(DEFAULTS.opTimeoutMs);
    expect(config.connectionWarmupConcurrency).toBe(DEFAULTS.connectionWarmupConcurrency);
  });

  test('applies valid overrides', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      CLAIM_INCOMING_TTL_MS: '5000',
      RATE_LIMIT_CAPACITY: '9',
      RATE_LIMIT_REFILL_PER_SEC: '2.5',
      JOB_KEY_TTL_MS: '60000',
      CONNECTION_WARMUP_CONCURRENCY: '4',
    });
    expect(config.nodeEnv).toBe('production');
    expect(config.logLevel).toBe('warn');
    expect(config.claims.incoming.ttlMs).toBe(5_000);
    expect(config.rateLimit.capacity).toBe(9);
    expect(config.rateLimit.refillPerSec).toBe(2.5);
    expect(config.jobRegistry.ttlMs).toBe(60_000);
    expect(config.connectionWarmupConcurrency).toBe(4);
  });

  test('aggregates every bad value into one ConfigError', () => {
    try {
      loadConfig({
        LOG_LEVEL: 'chatty',
        CLAIM_REPLY_MAX_ENTRIES: '-4',
        RATE_LIMIT_REFILL_PER_SEC: '0',
        DEFAULT_OP_TIMEOUT_MS: 'abc',
      });
      unreachable('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      const errors = (err as ConfigError).context.errors as string[];
      expect(errors).toHaveLength(4);
      expect(errors.join('\n')).toContain('LOG_LEVEL');
      expect(errors.join('\n')).toContain('RATE_LIMIT_REFILL_PER_SEC');
    }
  });

  test('empty string is treated as unset', () => {
    expect(loadConfig({ RATE_LIMIT_CAPACITY: '' }).rateLimit.capacity).toBe(
      DEFAULTS.rateLimit.capacity,
    );
  });
});
