import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { MetricsRecorder } from '../../src/metrics/recorder.ts';
import { ReadinessFsm } from '../../src/readiness/state.ts';
import { type StatusSnapshot, StatusSource } from '../../src/observability/snapshot.ts';
import { createStatusHandler } from '../../src/observability/server.ts';
import { AlertEvaluator } from '../../src/monitoring/alerts.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

interface Harness {
  handler: (req: Request) => Response;
  readiness: ReadinessFsm;
  metrics: MetricsRecorder;
  clock: FakeClock;
}

const make = (): Harness => {
  const clock = new FakeClock(1_700_000_000_000);
  const metrics = new MetricsRecorder();
  const readiness = new ReadinessFsm(clock, silent());
  const source = new StatusSource({
    workerId: 'w-test',
    origin: 'https://legy.line-apps.com/',
    clock,
    metrics,
    readiness,
  });
  return { handler: createStatusHandler(source), readiness, metrics, clock };
};

const get = (h: Harness, path: string): Response =>
  h.handler(new Request(`http://localhost${path}`));

describe('status handler', () => {
  test('/api/status returns the assembled snapshot', async () => {
    const h = make();
    h.metrics.recordSpan('send', 21);
    h.metrics.count('outcome.dispatched');
    const res = get(h, '/api/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json() as StatusSnapshot;
    expect(body.workerId).toBe('w-test');
    expect(body.generatedAtMs).toBe(1_700_000_000_000);
    expect(body.metrics.spans.send?.p50).toBe(21);
    expect(body.metrics.counters['outcome.dispatched']).toBe(1);
    expect(body.lanes).toEqual([]);
  });

  test('/api/health is 503 until readiness is armed, then 200', async () => {
    const h = make();
    expect(get(h, '/api/health').status).toBe(503);

    h.readiness.set({
      sessionValid: true,
      receiverSubscribed: true,
      rulesLoaded: true,
      senderReady: true,
      backlogDrained: true,
    });
    const ok = get(h, '/api/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, ready: true, workerId: 'w-test' });
  });

  test('/ serves the dashboard as html', async () => {
    const res = get(make(), '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('line-first-response');
  });

  test('unknown paths 404 and non-GET is rejected', async () => {
    const h = make();
    expect(get(h, '/nope').status).toBe(404);
    const post = h.handler(new Request('http://localhost/api/status', { method: 'POST' }));
    expect(post.status).toBe(405);
    await post.body?.cancel();
  });

  test('responses are marked no-store so a console never shows stale data', () => {
    const h = make();
    expect(get(h, '/api/status').headers.get('cache-control')).toBe('no-store');
    expect(get(h, '/').headers.get('cache-control')).toBe('no-store');
  });

  test('uptime advances with the clock', async () => {
    const h = make();
    h.clock.advance(4_500);
    const body = await get(h, '/api/status').json() as StatusSnapshot;
    expect(body.uptimeMs).toBe(4_500);
  });
});

describe('status handler — Phase 11 additions', () => {
  const release = {
    version: '0.1.0',
    commit: 'ef6c3d9f70dd41fa51053615d47f071f58cf8db3',
    dirty: false,
    runtime: 'deno 2.9.6',
    dependencies: { linejs: 'ef6c3d9' },
    buildHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    builtAtMs: 1_700_000_000_000,
  };

  test('/api/alerts reports that alerting is off when no evaluator is wired', async () => {
    const source = new StatusSource({
      workerId: 'w-test',
      origin: 'o',
      clock: new FakeClock(),
      metrics: new MetricsRecorder(),
    });
    const res = createStatusHandler(source)(new Request('http://localhost/api/alerts'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, firing: [] });
  });

  test('/api/alerts evaluates the live snapshot when one is wired', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const metrics = new MetricsRecorder();
    const readiness = new ReadinessFsm(clock, silent());
    readiness.degrade('session rejected');
    const source = new StatusSource({ workerId: 'w-test', origin: 'o', clock, metrics, readiness });
    const evaluator = new AlertEvaluator();
    const handler = createStatusHandler(source, { alerts: evaluator });

    handler(new Request('http://localhost/api/alerts'));
    clock.advance(31_000);
    const body = await handler(new Request('http://localhost/api/alerts')).json() as {
      firing: { kind: string }[];
    };
    expect(body.firing.map((a) => a.kind)).toEqual(['readiness-loss']);
  });

  test('health and status name the running release so a rollout can be told apart', async () => {
    const source = new StatusSource({
      workerId: 'w-test',
      origin: 'o',
      clock: new FakeClock(),
      metrics: new MetricsRecorder(),
    });
    const handler = createStatusHandler(source, { release });
    const health = await handler(new Request('http://localhost/api/health')).json() as {
      release: string;
    };
    expect(health.release).toBe('0.1.0+aaaaaaaaaaaa/bbbbbbbbbbbb');
    const status = await handler(new Request('http://localhost/api/status')).json() as {
      release: { commit: string };
    };
    expect(status.release.commit).toBe(release.commit);
  });
});
