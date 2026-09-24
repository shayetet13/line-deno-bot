import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { ShardPool } from '../../src/bots/shard-pool.ts';
import {
  fromWireRequest,
  fromWireResponse,
  toWireRequest,
  toWireResponse,
} from '../../src/bots/shard-protocol.ts';
import { silentLogger } from './fixture.ts';

/**
 * Real shard threads running the real `shard-worker.ts`. With no stored LINE
 * session each bot falls back to disconnected mode before any network I/O,
 * so these exercise the whole bridge — thread start, bot start, request and
 * response across the boundary — offline.
 */
const botConfig = (botId: string) => ({
  botId,
  ownerId: `owner-${botId}`,
  rules: [{ id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' }],
  dryRun: true,
});

describe('ShardPool — bots in worker threads', () => {
  let dir: string;
  let pool: ShardPool | undefined;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: 'lfr-shard-' });
    await Deno.mkdir(`${dir}/sessions`);
    for (const id of ['bot-a', 'bot-b', 'bot-c']) {
      await Deno.writeTextFile(`${dir}/${id}.json`, JSON.stringify(botConfig(id)));
    }
  });

  afterEach(async () => {
    pool?.close();
    pool = undefined;
    await Deno.remove(dir, { recursive: true });
  });

  const makePool = (shards: number): ShardPool =>
    new ShardPool({
      shards,
      logger: silentLogger(),
      init: {
        sessionsDir: `${dir}/sessions`,
        forceDryRun: true,
        showText: false,
        release: undefined,
        warmupConcurrency: 1,
        logLevel: 'error',
      },
    });

  test('spreads bots over the shards and serves each bot from its own thread', async () => {
    pool = makePool(2);
    const hosts = ['bot-a', 'bot-b', 'bot-c'].map((id) => pool!.hostFor(id, `${dir}/${id}.json`));
    await Promise.all(hosts.map((host) => host.start()));

    expect(Object.values(pool.layout()).sort()).toEqual([1, 2]);
    expect(hosts[0]?.shardId).not.toBe(hosts[1]?.shardId);

    const res = await hosts[2]!.fetch(new Request('http://console/api/status'));
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.workerId).toBe('bot-c');
    expect(status.readiness).toBeUndefined(); // disconnected: no live worker
    expect(status.host.shard).toBe(hosts[2]!.shardId); // still says where it runs

    await Promise.all(hosts.map((host) => host.close()));
  });

  test('carries a request body across and returns the bot’s own answer', async () => {
    pool = makePool(1);
    const host = pool.hostFor('bot-a', `${dir}/bot-a.json`);
    await host.start();

    const added = await host.fetch(
      new Request('http://console/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'hi',
          priority: 5,
          pattern: 'hello',
          reply: 'world',
          kind: 'exact',
        }),
      }),
    );
    expect(added.status).toBe(201);
    const onDisk = JSON.parse(await Deno.readTextFile(`${dir}/bot-a.json`));
    expect(onDisk.rules.map((r: { pattern: string }) => r.pattern)).toContain('hello');

    await host.close();
  });

  test('never serves account routes from a shard — the console thread owns accounts', async () => {
    pool = makePool(1);
    const host = pool.hostFor('bot-a', `${dir}/bot-a.json`);
    await host.start();

    const res = await host.fetch(new Request('http://console/api/users'));
    expect(res.status).toBe(404);
    await res.body?.cancel();
    await host.close();
  });

  test('a request for a bot the shard does not run is an error, not another bot', async () => {
    pool = makePool(1);
    const host = pool.hostFor('bot-a', `${dir}/bot-a.json`);
    // Never started: the shard has no such bot.
    await expect(host.fetch(new Request('http://console/api/status'))).rejects.toThrow(
      'not running in this shard',
    );
  });

  test('rejects a shard count below one', () => {
    expect(() => makePool(0)).toThrow(ConfigError);
  });
});

describe('ShardPool — a crashed shard', () => {
  test('fails the calls in flight, comes back, and restarts its bots', async () => {
    const pool = new ShardPool({
      shards: 1,
      logger: silentLogger(),
      respawnDelayMs: 0,
      workerUrl: new URL('./support/crashy-shard.ts', import.meta.url),
      init: {
        sessionsDir: '/nonexistent',
        forceDryRun: true,
        showText: false,
        release: undefined,
        warmupConcurrency: 1,
        logLevel: 'error',
      },
    });
    try {
      const host = pool.hostFor('bot-a', '/nonexistent/bot-a.json');
      await host.start();

      await expect(host.fetch(new Request('http://console/crash'))).rejects.toThrow('crashed');

      // The replacement thread has had bot-a started again, without being asked.
      let body: { started: string[] } | undefined;
      for (let i = 0; i < 50 && body === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        body = await host.fetch(new Request('http://console/api/status'))
          .then((res) => res.json())
          .catch(() => undefined);
      }
      expect(body?.started).toEqual(['bot-a']);
    } finally {
      pool.close();
    }
  });
});

describe('shard protocol', () => {
  test('round-trips a request with its body and headers', async () => {
    const wire = await toWireRequest(
      new Request('http://x/api/rules', {
        method: 'PUT',
        headers: { cookie: 'lfr_session=abc' },
        body: '{"a":1}',
      }),
    );
    const back = fromWireRequest(wire);
    expect(back.method).toBe('PUT');
    expect(back.headers.get('cookie')).toBe('lfr_session=abc');
    expect(await back.text()).toBe('{"a":1}');
  });

  test('a GET carries no body', async () => {
    expect((await toWireRequest(new Request('http://x/'))).body).toBeNull();
  });

  test('a redirect crosses without inventing a body', async () => {
    const wire = await toWireResponse(
      new Response(null, { status: 302, headers: { location: '/account/login' } }),
    );
    const back = fromWireResponse(wire);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/account/login');
    expect(back.body).toBeNull();
  });
});
