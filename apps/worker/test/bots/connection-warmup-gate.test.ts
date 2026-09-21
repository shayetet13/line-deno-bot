import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BoundedConnectionWarmupGate } from '../../src/bots/connection-warmup-gate.ts';

describe('BoundedConnectionWarmupGate', () => {
  test('limits connection warm-up work without serialising the caller', async () => {
    const gate = new BoundedConnectionWarmupGate(2);
    const release: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const connect = () =>
      gate.run(() =>
        new Promise<number>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          release.push(() => {
            active -= 1;
            resolve(active);
          });
        })
      );

    const work = [connect(), connect(), connect()];
    expect(active).toBe(2);
    release.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve));
    expect(active).toBe(2);
    release.shift()?.();
    release.shift()?.();
    await Promise.all(work);

    expect(peak).toBe(2);
  });

  test('releases the next connection after a failed warm-up', async () => {
    const gate = new BoundedConnectionWarmupGate(1);
    const failure = gate.run(() => Promise.reject(new Error('session rejected')));
    const next = gate.run(() => Promise.resolve('armed'));

    await expect(failure).rejects.toThrow('session rejected');
    await expect(next).resolves.toBe('armed');
  });
});
