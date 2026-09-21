import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { WriteBehindQueue } from '../../src/persistence/write-behind.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

class ManualTimer {
  #cb: (() => void) | undefined;
  set(callback: () => void): unknown {
    this.#cb = callback;
    return 1;
  }
  clear(): void {
    this.#cb = undefined;
  }
  async fire(): Promise<void> {
    const cb = this.#cb;
    this.#cb = undefined;
    cb?.();
    await Promise.resolve();
    await Promise.resolve();
  }
  get armed(): boolean {
    return this.#cb !== undefined;
  }
}

interface Harness {
  queue: WriteBehindQueue<number>;
  written: number[];
  timer: ManualTimer;
}

const make = (over: { batchSize?: number; maxQueued?: number; fail?: boolean } = {}): Harness => {
  const written: number[] = [];
  const timer = new ManualTimer();
  const queue = new WriteBehindQueue<number>({
    clock: new FakeClock(),
    logger: silent(),
    timer,
    batchSize: over.batchSize ?? 3,
    maxQueued: over.maxQueued ?? Math.max(10, over.batchSize ?? 3),
    flushIntervalMs: 1_000,
    flush: (batch) => {
      if (over.fail === true) throw new Error('disk on fire');
      written.push(...batch);
    },
  });
  return { queue, written, timer };
};

describe('WriteBehindQueue', () => {
  test('enqueue does not write until a batch fills', async () => {
    const { queue, written } = make({ batchSize: 3 });
    queue.enqueue(1);
    queue.enqueue(2);
    expect(written).toEqual([]);
    queue.enqueue(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(written).toEqual([1, 2, 3]);
  });

  test('a partial batch is flushed by the timer', async () => {
    const { queue, written, timer } = make({ batchSize: 10 });
    queue.enqueue(7);
    expect(timer.armed).toBe(true);
    await timer.fire();
    expect(written).toEqual([7]);
  });

  test('drops the oldest past maxQueued while a flush is still in flight', () => {
    // A flush that never settles is the realistic backpressure case: writes keep
    // arriving with nothing draining, and the queue must stay bounded.
    let release: (() => void) | undefined;
    const queue = new WriteBehindQueue<number>({
      clock: new FakeClock(),
      logger: silent(),
      timer: new ManualTimer(),
      batchSize: 10,
      maxQueued: 10,
      flushIntervalMs: 1_000,
      flush: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    for (let i = 0; i < 25; i += 1) queue.enqueue(i);
    expect(queue.stats.queued).toBe(10);
    expect(queue.stats.dropped).toBe(5);
    release?.();
  });

  test('a failing flush is counted and never thrown at the caller', async () => {
    const { queue } = make({ batchSize: 1, fail: true });
    queue.enqueue(1); // must not throw
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.stats.failures).toBeGreaterThan(0);
    expect(queue.stats.written).toBe(0);
  });

  test('close flushes what is left and stops accepting writes', async () => {
    const { queue, written } = make({ batchSize: 100 });
    queue.enqueue(1);
    queue.enqueue(2);
    await queue.close();
    expect(written).toEqual([1, 2]);
    queue.enqueue(3);
    expect(queue.stats.queued).toBe(0);
  });

  test('close gives up rather than spinning when the flush keeps failing', async () => {
    const { queue } = make({ batchSize: 100, fail: true });
    queue.enqueue(1);
    await queue.close();
    expect(queue.stats.failures).toBeGreaterThan(0);
  });

  test('rejects an inconsistent config', () => {
    const base = { clock: new FakeClock(), logger: silent(), flush: () => {} };
    expect(() => new WriteBehindQueue({ ...base, batchSize: 0 })).toThrow(ConfigError);
    expect(() => new WriteBehindQueue({ ...base, batchSize: 50, maxQueued: 10 })).toThrow(
      ConfigError,
    );
  });
});
