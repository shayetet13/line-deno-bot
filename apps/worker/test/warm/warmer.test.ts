import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { HOT_SEND_ORIGIN, TransportWarmer } from '../../src/warm/warmer.ts';

const silentLogger = (): Logger => new Logger({ level: 'error', sink: () => {} });

/** A fetch stub that resolves or rejects on command and counts calls. */
class FetchStub {
  calls = 0;
  #mode: 'ok' | 'fail' = 'ok';

  fail(): void {
    this.#mode = 'fail';
  }

  ok(): void {
    this.#mode = 'ok';
  }

  readonly fn = (_info: string, _init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    return this.#mode === 'ok'
      ? Promise.resolve(new Response(null, { status: 200 }))
      : Promise.reject(new Error('unreachable'));
  };
}

const makeWarmer = (
  stub: FetchStub,
  clock: FakeClock,
  over: Record<string, number> = {},
): TransportWarmer =>
  new TransportWarmer({
    clock,
    logger: silentLogger(),
    fetchFn: stub.fn,
    origin: 'https://example.test/',
    intervalMs: 25_000,
    probeTimeoutMs: 5_000,
    freshnessMs: 60_000,
    ...over,
  });

describe('TransportWarmer', () => {
  test('warms the encrypted Square gateway used by JWT sessions', () => {
    expect(HOT_SEND_ORIGIN).toBe('https://gf.line.naver.jp/enc');
  });

  test('is not ready until a probe succeeds', async () => {
    const stub = new FetchStub();
    const clock = new FakeClock();
    const warmer = makeWarmer(stub, clock);
    expect(warmer.ready).toBe(false);

    expect(await warmer.probeOnce()).toBe(true);
    expect(stub.calls).toBe(1);
    expect(warmer.ready).toBe(true);
  });

  test('goes stale once the last success is older than the freshness window', async () => {
    const stub = new FetchStub();
    const clock = new FakeClock();
    const warmer = makeWarmer(stub, clock);
    await warmer.probeOnce();
    clock.advance(60_000);
    expect(warmer.ready).toBe(true);
    clock.advance(1);
    expect(warmer.ready).toBe(false);
  });

  test('counts consecutive failures and clears them on the next success', async () => {
    const stub = new FetchStub();
    const warmer = makeWarmer(stub, new FakeClock());
    stub.fail();
    await warmer.probeOnce();
    await warmer.probeOnce();
    expect(warmer.status.consecutiveFailures).toBe(2);
    stub.ok();
    await warmer.probeOnce();
    expect(warmer.status.consecutiveFailures).toBe(0);
  });

  test('records the probe round trip from the injected clock', async () => {
    const clock = new FakeClock();
    const warmer = new TransportWarmer({
      clock,
      logger: silentLogger(),
      // Advance the clock inside the probe so an RTT can be observed.
      fetchFn: (_info, _init) => {
        clock.advance(4);
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      origin: 'https://example.test/',
    });
    await warmer.probeOnce();
    expect(warmer.status.lastRttMs).toBe(4);
  });

  test('start fires one probe immediately and stop halts the loop', async () => {
    const stub = new FetchStub();
    const controller = new AbortController();
    const warmer = makeWarmer(stub, new FakeClock());
    await warmer.start(controller.signal);
    expect(stub.calls).toBe(1);
    expect(warmer.status.running).toBe(true);
    controller.abort();
    expect(warmer.status.running).toBe(false);
  });

  test('rejects a non-positive interval', () => {
    expect(() => makeWarmer(new FetchStub(), new FakeClock(), { intervalMs: 0 })).toThrow(
      ConfigError,
    );
  });
});
