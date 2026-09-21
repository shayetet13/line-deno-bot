import { ConfigError } from '../errors/base.ts';
import { DEFAULTS, LOG_LEVELS, type LogLevel } from './constants.ts';

export type NodeEnv = 'development' | 'test' | 'production';

interface StoreConfig {
  ttlMs: number;
  maxEntries: number;
}

export interface WorkerConfig {
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  claims: { incoming: StoreConfig; reply: StoreConfig; roomAnswer: StoreConfig };
  rateLimit: { capacity: number; refillPerSec: number };
  jobRegistry: StoreConfig;
  defaultOpTimeoutMs: number;
  /** Process-wide cap for connect/reconnect lane warm-up work. Live replies
   * never enter this gate. */
  connectionWarmupConcurrency: number;
}

type EnvSource = Record<string, string | undefined>;

class Reader {
  readonly errors: string[] = [];
  constructor(private readonly source: EnvSource) {}

  int(key: string, fallback: number, min = 1): number {
    const raw = this.source[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      this.errors.push(`${key}: expected integer >= ${String(min)}, got "${raw}"`);
      return fallback;
    }
    return value;
  }

  num(key: string, fallback: number): number {
    const raw = this.source[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      this.errors.push(`${key}: expected number > 0, got "${raw}"`);
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const raw = this.source[key];
    if (raw === undefined || raw === '') return fallback;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    this.errors.push(`${key}: expected one of ${allowed.join('|')}, got "${raw}"`);
    return fallback;
  }
}

const readStore = (r: Reader, prefix: string, d: StoreConfig): StoreConfig => ({
  ttlMs: r.int(`${prefix}_TTL_MS`, d.ttlMs),
  maxEntries: r.int(`${prefix}_MAX_ENTRIES`, d.maxEntries),
});

const readClaims = (r: Reader): WorkerConfig['claims'] => ({
  incoming: readStore(r, 'CLAIM_INCOMING', DEFAULTS.claimIncoming),
  reply: readStore(r, 'CLAIM_REPLY', DEFAULTS.claimReply),
  roomAnswer: readStore(r, 'CLAIM_ROOM_ANSWER', DEFAULTS.claimRoomAnswer),
});

const readJobRegistry = (r: Reader): StoreConfig => ({
  ttlMs: r.int('JOB_KEY_TTL_MS', DEFAULTS.jobRegistry.ttlMs),
  maxEntries: r.int('JOB_REGISTRY_MAX_ENTRIES', DEFAULTS.jobRegistry.maxEntries),
});

/** Parses and validates worker configuration. Fails fast, reporting every bad
 * value at once (`CLAUDE .md` §4: validate config at startup). */
export function loadConfig(source: EnvSource = Deno.env.toObject()): WorkerConfig {
  const r = new Reader(source);
  const config: WorkerConfig = {
    nodeEnv: r.oneOf<NodeEnv>('NODE_ENV', ['development', 'test', 'production'], 'development'),
    logLevel: r.oneOf<LogLevel>('LOG_LEVEL', LOG_LEVELS, 'info'),
    claims: readClaims(r),
    rateLimit: {
      capacity: r.int('RATE_LIMIT_CAPACITY', DEFAULTS.rateLimit.capacity),
      refillPerSec: r.num('RATE_LIMIT_REFILL_PER_SEC', DEFAULTS.rateLimit.refillPerSec),
    },
    jobRegistry: readJobRegistry(r),
    defaultOpTimeoutMs: r.int('DEFAULT_OP_TIMEOUT_MS', DEFAULTS.opTimeoutMs),
    connectionWarmupConcurrency: r.int(
      'CONNECTION_WARMUP_CONCURRENCY',
      DEFAULTS.connectionWarmupConcurrency,
    ),
  };
  if (r.errors.length > 0) {
    throw new ConfigError(`invalid worker config:\n- ${r.errors.join('\n- ')}`, {
      errors: r.errors,
    });
  }
  return config;
}
