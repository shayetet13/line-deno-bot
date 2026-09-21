import { MS_PER_SECOND } from '../config/constants.ts';
import { ConfigError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { withTimeout } from '../lib/with-timeout.ts';

/** JWT-backed Square sessions use LINEJS's encrypted outer gateway. A non-2xx
 * HEAD is sufficient: it opens the exact TCP/TLS/H2 route the real encrypted
 * send will reuse, without creating a message or a Thrift request. */
export const HOT_SEND_ORIGIN = 'https://gf.line.naver.jp/enc';

const DEFAULTS = {
  origin: HOT_SEND_ORIGIN,
  intervalMs: 25 * MS_PER_SECOND,
  probeTimeoutMs: 5 * MS_PER_SECOND,
  /** A probe older than this means "not warm" regardless of past successes. */
  freshnessMs: 60 * MS_PER_SECOND,
} as const;

type FetchFn = (info: string, init?: RequestInit) => Promise<Response>;

export interface WarmerOptions {
  clock: Clock;
  logger: Logger;
  fetchFn?: FetchFn;
  origin?: string;
  intervalMs?: number;
  probeTimeoutMs?: number;
  freshnessMs?: number;
}

export interface WarmerStatus {
  running: boolean;
  lastOkMonotonic: number | undefined;
  lastRttMs: number | undefined;
  consecutiveFailures: number;
  probes: number;
}

/**
 * Keeps the connection to the hot send origin alive by probing it on an
 * interval, so the first real send after a quiet stretch reuses a warm TCP +
 * TLS path instead of paying a cold handshake (Playbook §8.1).
 *
 * `start()` fires one probe immediately, then every `intervalMs`. The loop
 * stops on `stop()` or when its `AbortSignal` fires.
 */
export class TransportWarmer {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #fetch: FetchFn;
  readonly #origin: string;
  readonly #intervalMs: number;
  readonly #probeTimeoutMs: number;
  readonly #freshnessMs: number;

  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastOkMonotonic: number | undefined;
  #lastRttMs: number | undefined;
  #consecutiveFailures = 0;
  #probes = 0;

  constructor(options: WarmerOptions) {
    assertPositive('intervalMs', options.intervalMs ?? DEFAULTS.intervalMs);
    assertPositive('probeTimeoutMs', options.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs);
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#fetch = options.fetchFn ?? ((info, init) => fetch(info, init));
    this.#origin = options.origin ?? DEFAULTS.origin;
    this.#intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs;
    this.#freshnessMs = options.freshnessMs ?? DEFAULTS.freshnessMs;
  }

  /** `true` once a probe has succeeded and that success is still fresh. */
  get ready(): boolean {
    if (this.#lastOkMonotonic === undefined) return false;
    return this.#clock.monotonic() - this.#lastOkMonotonic <= this.#freshnessMs;
  }

  get status(): WarmerStatus {
    return {
      running: this.#running,
      lastOkMonotonic: this.#lastOkMonotonic,
      lastRttMs: this.#lastRttMs,
      consecutiveFailures: this.#consecutiveFailures,
      probes: this.#probes,
    };
  }

  /** Begins the probe loop. Resolves after the first probe settles, so a caller
   * can `await warmer.start(signal)` and then check `warmer.ready`. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    await this.#probe();
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One probe now. Also used by the readiness gate before the loop starts. */
  probeOnce(): Promise<boolean> {
    return this.#probe();
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.#probe().finally(() => this.#schedule());
    }, this.#intervalMs);
  }

  async #probe(): Promise<boolean> {
    const started = this.#clock.monotonic();
    this.#probes += 1;
    try {
      const response = await withTimeout(
        (sig) => this.#fetch(this.#origin, { method: 'HEAD', signal: sig }),
        { timeoutMs: this.#probeTimeoutMs, label: 'warm-probe' },
      );
      await response.body?.cancel();
      this.#lastRttMs = this.#clock.monotonic() - started;
      this.#lastOkMonotonic = this.#clock.monotonic();
      this.#consecutiveFailures = 0;
      return true;
    } catch (error: unknown) {
      this.#consecutiveFailures += 1;
      this.#logger.warn('warm probe failed', {
        origin: this.#origin,
        consecutiveFailures: this.#consecutiveFailures,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }
  }
}

function assertPositive(name: string, value: number): void {
  if (!(value > 0)) {
    throw new ConfigError(`TransportWarmer: ${name} must be > 0`, { [name]: value });
  }
}
