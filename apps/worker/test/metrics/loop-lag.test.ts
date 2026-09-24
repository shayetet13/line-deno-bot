import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { LoopLagMonitor } from '../../src/metrics/loop-lag.ts';
import { MetricsRecorder } from '../../src/metrics/recorder.ts';
import { StatusSource } from '../../src/observability/snapshot.ts';

const manualTimer = () => {
  const cleared: unknown[] = [];
  return {
    cleared,
    timer: { set: () => 'handle', clear: (h: unknown) => void cleared.push(h) },
  };
};

describe('LoopLagMonitor', () => {
  test('records how late each tick ran, never a negative lateness', () => {
    const clock = new FakeClock();
    const { timer } = manualTimer();
    const monitor = new LoopLagMonitor({ clock, intervalMs: 20, timer });
    monitor.start();

    clock.advance(20); // on time
    monitor.observe();
    clock.advance(35); // 15ms late: the loop was busy
    monitor.observe();
    clock.advance(10); // early (timer coalescing) counts as zero
    monitor.observe();

    const snap = monitor.snapshot();
    expect(snap?.count).toBe(3);
    expect(snap?.max).toBe(15);
    expect(snap?.min).toBe(0);
  });

  test('start is idempotent and stop clears the timer', () => {
    const { timer, cleared } = manualTimer();
    const monitor = new LoopLagMonitor({ clock: new FakeClock(), timer });
    monitor.start();
    monitor.start();
    expect(monitor.running).toBe(true);
    monitor.stop();
    monitor.stop();
    expect(monitor.running).toBe(false);
    expect(cleared).toEqual(['handle']);
  });

  test('rejects a non-positive interval', () => {
    expect(() => new LoopLagMonitor({ clock: new FakeClock(), intervalMs: 0 })).toThrow(
      ConfigError,
    );
  });

  test('the status snapshot reports the thread’s shard and loop lag', () => {
    const clock = new FakeClock();
    const { timer } = manualTimer();
    const monitor = new LoopLagMonitor({ clock, intervalMs: 20, timer });
    monitor.start();
    clock.advance(30);
    monitor.observe();
    const source = new StatusSource({
      workerId: 'bot-1',
      origin: 'o',
      clock,
      metrics: new MetricsRecorder(),
      loopLag: monitor,
      shard: 'shard-2',
    });

    const host = source.snapshot().host;
    expect(host?.shard).toBe('shard-2');
    expect(host?.loopLagMs?.max).toBe(10);
  });

  test('a snapshot without either leaves `host` out, as older payloads did', () => {
    const source = new StatusSource({
      workerId: 'bot-1',
      origin: 'o',
      clock: new FakeClock(),
      metrics: new MetricsRecorder(),
    });
    expect('host' in source.snapshot()).toBe(false);
  });
});
