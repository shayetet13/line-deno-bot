import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createCombinedHandler } from '../../src/admin/server.ts';
import { UsersStore } from '../../src/admin/users-store.ts';
import { BotRegistry } from '../../src/bots/bot-registry.ts';
import { type ShardedBotHost, ShardPool } from '../../src/bots/shard-pool.ts';
import { createShardedTenantRoutes } from '../../src/bots/tenant-routes.ts';
import { PRIMARY_CONFIG, silentLogger } from './fixture.ts';

/**
 * The multi-user console with every bot in a shard thread: accounts are
 * answered on the console thread, everything else by the signed-in person's
 * own bot in its shard — and nobody reaches anyone else's.
 */

let dir: string;
let pool: ShardPool;
let registry: BotRegistry<ShardedBotHost>;
let users: UsersStore;
let handler: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-sharded-' });
  await Deno.mkdir(`${dir}/config/bots`, { recursive: true });
  await Deno.mkdir(`${dir}/.sessions`, { recursive: true });
  const configPath = `${dir}/config/bots/bot-1.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ ...PRIMARY_CONFIG, dryRun: true }));
  users = new UsersStore(`${dir}/.control/users.json`);
  pool = new ShardPool({
    shards: 2,
    logger: silentLogger(),
    init: {
      sessionsDir: `${dir}/.sessions`,
      forceDryRun: true,
      showText: false,
      release: undefined,
      warmupConcurrency: 1,
      logLevel: 'error',
    },
  });
  const primary = pool.hostFor('bot-1', configPath);
  await primary.start();
  registry = new BotRegistry<ShardedBotHost>({
    users,
    logger: silentLogger(),
    primary,
    createHost: (botId, path) => pool.hostFor(botId, path),
    botsDir: `${dir}/config/bots`,
    templatePath: configPath,
  });
  const tenant = createShardedTenantRoutes({ registry, users, logger: silentLogger() });
  handler = createCombinedHandler(tenant.admin, tenant.status, { users });
});

afterEach(async () => {
  await registry.closeAll();
  pool.close();
  await Deno.remove(dir, { recursive: true });
});

const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

async function signIn(username: string, password: string): Promise<string> {
  const res = await handler(req('/api/account/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }));
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const get = (path: string, cookie: string): Promise<Response> =>
  handler(req(path, { headers: { cookie } }));

const ruleIds = async (cookie: string): Promise<string[]> => {
  const body = await (await get('/api/rules', cookie)).json();
  return body.rules.map((r: { id: string }) => r.id);
};

describe('sharded multi-user console', () => {
  test('each person reaches only their own bot, each running in a shard', async () => {
    const admin = await signIn('admin', 'Root@77#');
    await users.create({ username: 'alice', password: 'alice-pass', role: 'user' });
    const alice = await signIn('alice', 'alice-pass');

    expect(await ruleIds(admin)).toEqual(['go']);
    expect(await ruleIds(alice)).toEqual(['example-ping']);

    const status = await (await get('/api/status', alice)).json();
    expect(status.workerId).toMatch(/^u-/);
    expect(Object.values(pool.layout()).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test('account routes are answered on the console thread, not forwarded', async () => {
    const admin = await signIn('admin', 'Root@77#');

    const me = await get('/api/account/me', admin);
    expect(me.status).toBe(200);
    expect((await me.json()).username).toBe('admin');

    const list = await get('/api/users', admin);
    expect(list.status).toBe(200);
    expect((await list.json()).users.length).toBeGreaterThan(0);
  });

  test('removing a person stops their bot in its shard', async () => {
    const admin = await signIn('admin', 'Root@77#');
    const bob = await users.create({ username: 'bob', password: 'bob-pass', role: 'user' });
    const bobCookie = await signIn('bob', 'bob-pass');
    await get('/api/rules', bobCookie); // assigns and starts bob's bot
    expect(Object.values(pool.layout()).reduce((a, b) => a + b, 0)).toBe(2);

    const removed = await handler(req(`/api/users/${bob.userId}`, {
      method: 'DELETE',
      headers: { cookie: admin },
    }));
    expect(removed.status).toBe(200);
    expect(Object.values(pool.layout()).reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('an unauthenticated health check is answered by the primary bot’s shard', async () => {
    const res = await handler(req('/api/health'));
    // Disconnected (no LINE session in the test): not ready, but answered.
    expect(res.status).toBe(503);
    expect((await res.json()).workerId).toBe('bot-1');
  });
});
