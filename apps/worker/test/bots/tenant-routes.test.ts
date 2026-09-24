import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createCombinedHandler } from '../../src/admin/server.ts';
import { createTenantRoutes } from '../../src/bots/tenant-routes.ts';
import {
  fakeRuntime,
  type Harness,
  makeHarness,
  silentLogger,
  TEST_ADMIN_PASSWORD,
} from './fixture.ts';

/**
 * The whole point of the multi-login work, exercised end to end: several
 * people sign in at once, each from their own browser (cookie), and none of
 * them can see or change anyone else's bot.
 */

let dir: string;
let h: Harness;
let handler: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-tenant-' });
  h = await makeHarness(dir);
  const tenant = createTenantRoutes({
    registry: h.registry,
    users: h.users,
    sessions: h.sessions,
    logger: silentLogger(),
  });
  handler = createCombinedHandler(tenant.admin, tenant.status, { users: h.users });
});

afterEach(async () => {
  await h.registry.closeAll();
  await Deno.remove(dir, { recursive: true });
});

const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

/** A separate "browser": returns its own cookie jar value. */
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

const send = (
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  handler(req(path, {
    method,
    headers: { cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

const ruleIds = async (cookie: string): Promise<string[]> => {
  const body = await (await get('/api/rules', cookie)).json();
  return body.rules.map((r: { id: string }) => r.id);
};

async function addUser(username: string, role: 'admin' | 'user' = 'user'): Promise<string> {
  await h.users.create({ username, password: `${username}-pass`, role });
  return await signIn(username, `${username}-pass`);
}

describe('several people signed in at the same time', () => {
  test('each sees their own rules, not the shared bot’s', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    const bob = await addUser('bob');

    expect(await ruleIds(admin)).toEqual(['go']);
    expect(await ruleIds(alice)).toEqual(['example-ping']);
    expect(await ruleIds(bob)).toEqual(['example-ping']);
  });

  test('a rule one person adds appears for nobody else', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    const bob = await addUser('bob');

    const added = await send('POST', '/api/rules', alice, {
      id: 'alice-only',
      priority: 5,
      kind: 'exact',
      pattern: 'hi',
      reply: 'hello from alice',
    });
    expect(added.status).toBe(201);

    expect(await ruleIds(alice)).toContain('alice-only');
    expect(await ruleIds(bob)).not.toContain('alice-only');
    expect(await ruleIds(admin)).toEqual(['go']);
  });

  test('deleting a rule on one bot leaves another bot’s rule of the same id alone', async () => {
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    expect((await send('DELETE', '/api/rules/example-ping', alice)).status).toBe(400);

    await send('POST', '/api/rules', alice, {
      id: 'extra',
      priority: 1,
      kind: 'exact',
      pattern: 'x',
      reply: 'y',
    });
    expect((await send('DELETE', '/api/rules/example-ping', alice)).status).toBe(200);

    expect(await ruleIds(alice)).toEqual(['extra']);
    expect(await ruleIds(bob)).toEqual(['example-ping']);
  });

  test('each has their own LINE login state', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    const bob = await addUser('bob');

    await get('/api/rules', admin);
    const aliceHost = await h.registry.hostFor((await h.users.findByUsername('alice'))!);
    await h.sessions.save({
      botId: aliceHost.botId,
      authToken: 'alice-token',
      refreshToken: undefined,
      expireSec: undefined,
      savedAtMs: 1_700_000_000_000,
      extra: {},
    });

    const status = async (
      cookie: string,
    ) => (await (await get('/api/login/status', cookie)).json());
    expect((await status(alice)).botSession).toMatchObject({ savedAtMs: 1_700_000_000_000 });
    expect((await status(bob)).botSession).toBeNull();
    expect((await status(admin)).botSession).toBeNull();
  });

  test('one person’s login flow is independent of another’s', async () => {
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    const aliceHost = await h.registry.hostFor((await h.users.findByUsername('alice'))!);
    const bobHost = await h.registry.hostFor((await h.users.findByUsername('bob'))!);

    expect(aliceHost.loginFlow).not.toBe(bobHost.loginFlow);
    expect((await (await get('/api/login/status', alice)).json()).flow.status).toBe('idle');
    expect((await (await get('/api/login/status', bob)).json()).flow.status).toBe('idle');
  });

  test('the same person signed in from two browsers sees the same bot', async () => {
    const first = await addUser('alice');
    const second = await signIn('alice', 'alice-pass');
    await send('POST', '/api/rules', first, {
      id: 'shared-by-alice',
      priority: 1,
      kind: 'exact',
      pattern: 'a',
      reply: 'b',
    });
    expect(await ruleIds(second)).toContain('shared-by-alice');
  });

  test('a non-admin cannot reach admin pages, even after the admin’s browser is open', async () => {
    await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    expect((await get('/', alice)).status).toBe(302);
    expect((await get('/api/users', alice)).status).toBe(403);
  });
});

describe('restarting and logging out', () => {
  test('one person’s restart reconnects only their bot', async () => {
    const log: string[] = [];
    const isolated = await makeHarness(await Deno.makeTempDir({ prefix: 'lfr-tenant2-' }), {
      connect: () => Promise.resolve(fakeRuntime(log, `#${log.length} `).runtime),
    });
    try {
      const tenant = createTenantRoutes({
        registry: isolated.registry,
        users: isolated.users,
        sessions: isolated.sessions,
        logger: silentLogger(),
      });
      const local = createCombinedHandler(tenant.admin, tenant.status, { users: isolated.users });
      await isolated.users.create({ username: 'alice', password: 'alicepass' });
      await isolated.users.create({ username: 'bob', password: 'bobpass1' });
      const cookieFor = async (u: string, p: string): Promise<string> =>
        ((await local(req('/api/account/login', {
          method: 'POST',
          body: JSON.stringify({ username: u, password: p }),
        }))).headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const alice = await cookieFor('alice', 'alicepass');
      const bob = await cookieFor('bob', 'bobpass1');
      await local(req('/api/rules', { headers: { cookie: alice } }));
      await local(req('/api/rules', { headers: { cookie: bob } }));

      const before = new Map(
        [...isolated.hosts].map(([id, host]) => [id, host.runtime] as const),
      );
      const aliceBot = (await isolated.users.findByUsername('alice'))!.botId!;
      const restart = await local(
        req('/api/admin/restart', { method: 'POST', headers: { cookie: alice } }),
      );
      expect(restart.status).toBe(200);
      await isolated.hosts.get(aliceBot)!.ready;

      for (const [id, host] of isolated.hosts) {
        if (id === aliceBot) expect(host.runtime).not.toBe(before.get(id));
        else expect(host.runtime).toBe(before.get(id));
      }
    } finally {
      await isolated.registry.closeAll();
      await Deno.remove(isolated.dir, { recursive: true });
    }
  });
});

describe('an account is checked on every request, not only at sign-in', () => {
  test('a deleted person’s cookie stops working immediately', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    expect((await get('/api/rules', alice)).status).toBe(200);

    const aliceId = (await h.users.findByUsername('alice'))!.userId;
    expect((await send('DELETE', `/api/users/${aliceId}`, admin)).status).toBe(200);

    expect((await get('/api/rules', alice)).status).toBe(401);
    expect((await get('/app', alice)).status).toBe(302);
  });

  test('deleting a person shuts their bot down and leaves others running', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    await get('/api/rules', alice);
    await get('/api/rules', bob);
    const aliceBot = (await h.users.findByUsername('alice'))!.botId!;
    const bobBot = (await h.users.findByUsername('bob'))!.botId!;
    const aliceHost = h.hosts.get(aliceBot)!;

    const aliceId = (await h.users.findByUsername('alice'))!.userId;
    await send('DELETE', `/api/users/${aliceId}`, admin);

    // A closed host ignores restart(); bob's still works.
    let reconnects = 0;
    const before = h.connects.length;
    await aliceHost.restart();
    reconnects += h.connects.length - before;
    expect(reconnects).toBe(0);
    expect((await get('/api/rules', bob)).status).toBe(200);
    expect(h.hosts.get(bobBot)).toBeDefined();
  });

  test('a demoted admin loses admin pages at once, not when the cookie expires', async () => {
    const admin = await signIn('admin', TEST_ADMIN_PASSWORD);
    await h.users.create({ username: 'boss2', password: 'boss2-pass', role: 'admin' });
    const boss2 = await signIn('boss2', 'boss2-pass');
    expect((await get('/api/users', boss2)).status).toBe(200);

    const boss2Id = (await h.users.findByUsername('boss2'))!.userId;
    expect((await send('PUT', `/api/users/${boss2Id}`, admin, { role: 'user' })).status).toBe(200);

    expect((await get('/api/users', boss2)).status).toBe(403);
  });
});

describe('/api/health', () => {
  test('stays public and describes the bot the process was started with', async () => {
    const res = await handler(req('/api/health'));
    expect([200, 503]).toContain(res.status);
    expect((await res.json()).workerId).toBe('bot-1');
  });
});
