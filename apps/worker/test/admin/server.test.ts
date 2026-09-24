import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Client } from '@evex/linejs';
import { MockInboundAdapter, MockSender } from '../../src/adapters/mock.ts';
import type { LineLoginOptions } from '../../src/adapters/linejs/login.ts';
import { createAdminHandler, createCombinedHandler, isAdminPath } from '../../src/admin/server.ts';
import { LoginFlow } from '../../src/admin/login-flow.ts';
import { UsersStore } from '../../src/admin/users-store.ts';
import { TEST_ADMIN_PASSWORD } from '../bots/fixture.ts';
import { parseBotConfig } from '../../src/config/bot-config.ts';
import { loadConfig } from '../../src/config/env.ts';
import { createStatusHandler } from '../../src/observability/server.ts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger } from '../../src/logging/logger.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { Worker } from '../../src/worker/worker.ts';

const CONFIG_BODY = {
  botId: 'bot-1',
  ownerId: 'owner-1',
  square: true,
  rules: [{ id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' }],
  dryRun: false,
};

interface Harness {
  handler: (req: Request) => Promise<Response>;
  worker: Worker;
  sessions: MemorySessionStore;
  users: UsersStore;
  loginFlow: LoginFlow;
  clock: FakeClock;
  restarted: boolean;
  setPolledRoomsCalls: readonly (readonly string[])[];
  loginGate: () => LoginGate | undefined;
  configPath: string;
  linejsStoragePath: string;
}

interface LoginGate {
  resolve: (c: Client) => void;
  reject: (e: unknown) => void;
  opts: LineLoginOptions;
}

let dir: string;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-admin-' });
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

async function make(
  opts: { client?: Client; liveRoomApply?: boolean } = {},
): Promise<Harness> {
  const configPath = `${dir}/bot.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(CONFIG_BODY));
  const users = new UsersStore(`${dir}/.control/users.json`, {
    initialAdminPassword: TEST_ADMIN_PASSWORD,
  });

  const clock = new FakeClock(1_700_000_000_000);
  const logger = new Logger({ level: 'error', sink: () => {} });
  const worker = new Worker({
    bot: parseBotConfig(CONFIG_BODY),
    env: loadConfig({}),
    adapter: new MockInboundAdapter(),
    sender: new MockSender(),
    clock,
    logger,
    timer: { set: () => 0, clear: () => {} },
  });
  void worker.run(new AbortController().signal);

  const sessions = new MemorySessionStore();
  let gate: LoginGate | undefined;
  const loginFn = (opts: LineLoginOptions): Promise<Client> =>
    new Promise<Client>((resolve, reject) => {
      gate = { resolve, reject, opts };
    });
  const loginFlow = new LoginFlow({
    botId: 'bot-1',
    device: 'DESKTOPWIN',
    storagePath: `${dir}/bot.linejs.json`,
    sessions,
    logger,
    clock,
    loginFn: loginFn as unknown as typeof import('../../src/adapters/linejs/login.ts').loginToLine,
  });

  let restarted = false;
  const setPolledRoomsCalls: (readonly string[])[] = [];
  const linejsStoragePath = `${dir}/bot.linejs.json`;
  const handler = createAdminHandler({
    worker,
    botId: 'bot-1',
    configPath,
    sessions,
    users,
    logger,
    loginFlow,
    linejsStoragePath,
    client: opts.client,
    restart: () => {
      restarted = true;
    },
    ...(opts.liveRoomApply
      ? {
        setPolledRooms: (rooms: readonly string[]): Promise<void> => {
          setPolledRoomsCalls.push(rooms);
          return Promise.resolve();
        },
      }
      : {}),
  });

  return {
    handler,
    worker,
    sessions,
    users,
    loginFlow,
    clock,
    get restarted(): boolean {
      return restarted;
    },
    setPolledRoomsCalls,
    loginGate: () => gate,
    configPath,
    linejsStoragePath,
  } as Harness;
}

const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const clientWithGroups = (groups: Array<{ id: string; name: string }>): Client =>
  ({
    base: {
      square: {
        getJoinedSquares: () =>
          Promise.resolve({
            squares: [{ mid: 's-1', name: 'Square' }],
            continuationToken: '',
          }),
        getJoinableSquareChats: () =>
          Promise.resolve({
            squareChats: groups.map((group) => ({ squareChatMid: group.id, name: group.name })),
            continuationToken: '',
          }),
      },
      talk: {
        getAllChatMids: () => Promise.resolve({ memberChatMids: [] }),
        getChats: () => Promise.resolve({ chats: [] }),
        getAllContactIds: () => Promise.resolve([]),
        getContactsV2: () => Promise.resolve({ contacts: {} }),
      },
    },
  }) as unknown as Client;

describe('admin pages', () => {
  test('GET /rules, /groups and /login render html', async () => {
    const h = await make();
    for (const path of ['/rules', '/groups', '/login']) {
      const res = await h.handler(req(path));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('line-first-response');
    }
  });

  test('an unknown path is a 404, not a crash', async () => {
    const h = await make();
    const res = await h.handler(req('/nope'));
    expect(res.status).toBe(404);
  });
});

describe('group selection', () => {
  test('lists joined groups and marks the configured room', async () => {
    const client = clientWithGroups([
      { id: 'm-room-1', name: 'Alpha' },
      { id: 'm-room-2', name: 'Beta' },
    ]);
    const h = await make({ client });
    await Deno.writeTextFile(
      h.configPath,
      JSON.stringify({ ...CONFIG_BODY, dedicatedRooms: ['m-room-2'], slotBudget: 2 }),
    );

    const res = await h.handler(req('/api/groups'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connected: true,
      pollLimit: 2,
      selectionMode: 'all',
      groups: [
        { id: 'm-room-1', name: 'Alpha', kind: 'openchat', selected: false },
        { id: 'm-room-2', name: 'Beta', kind: 'openchat', selected: true },
      ],
    });
  });

  test('saves only joined groups and restarts so poll slots are rebuilt', async () => {
    const h = await make({
      client: clientWithGroups([
        { id: 'm-room-1', name: 'Alpha' },
        { id: 'm-room-2', name: 'Beta' },
      ]),
    });
    const res = await h.handler(req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ roomIds: ['m-room-2'] }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      roomIds: ['m-room-2'],
      dedicatedRooms: ['m-room-2'],
    });
    expect(h.restarted).toBe(true);
    const onDisk = JSON.parse(await Deno.readTextFile(h.configPath));
    expect(onDisk.dedicatedRooms).toEqual(['m-room-2']);
    expect(onDisk.selectedRooms).toEqual(['m-room-2']);
  });

  test('rejects a group the account has not joined', async () => {
    const h = await make({ client: clientWithGroups([{ id: 'm-room-1', name: 'Alpha' }]) });
    const res = await h.handler(req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ roomIds: ['m-not-joined'] }),
    }));

    expect(res.status).toBe(400);
    expect(h.restarted).toBe(false);
  });
});

describe('GET /api/rules', () => {
  test('lists the rules currently on disk', async () => {
    const h = await make();
    const body = await (await h.handler(req('/api/rules'))).json();
    expect(body.rules).toEqual(CONFIG_BODY.rules);
  });
});

describe('POST /api/rules', () => {
  test('adds a rule, persists it, and hot-reloads the live worker', async () => {
    const h = await make();
    expect(h.worker.ruleCount).toBe(1);
    const res = await h.handler(req('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ping',
        priority: 1,
        kind: 'exact',
        pattern: 'ping',
        reply: 'pong',
      }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rules).toHaveLength(2);
    expect(h.worker.ruleCount).toBe(2);
  });

  test('a duplicate id is a 400 naming the problem, and does not touch the worker', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules', {
      method: 'POST',
      body: JSON.stringify({ id: 'go', priority: 1, kind: 'exact', pattern: 'go', reply: 'x' }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('go');
    expect(h.worker.ruleCount).toBe(1);
  });

  test('a malformed JSON body is a 400, not a 500', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules', { method: 'POST', body: '{not json' }));
    expect(res.status).toBe(400);
  });

  test('an invalid rule shape (empty pattern) is a 400', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules', {
      method: 'POST',
      body: JSON.stringify({ id: 'x', priority: 1, kind: 'exact', pattern: '', reply: 'y' }),
    }));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/rules/:id', () => {
  test('edits a rule and applies it live', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules/go', {
      method: 'PUT',
      body: JSON.stringify({ priority: 10, kind: 'exact', pattern: 'go', reply: 'changed' }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).rules[0].reply).toBe('changed');
  });

  test('editing a missing id is a 404', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules/nope', {
      method: 'PUT',
      body: JSON.stringify({ priority: 1, kind: 'exact', pattern: 'x', reply: 'y' }),
    }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/rules/:id', () => {
  test('removes a rule and updates the live worker', async () => {
    const h = await make();
    await h.handler(req('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ping',
        priority: 1,
        kind: 'exact',
        pattern: 'ping',
        reply: 'pong',
      }),
    }));
    const res = await h.handler(req('/api/rules/go', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(h.worker.ruleCount).toBe(1);
  });

  test('deleting the last rule is refused, not silently emptied', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules/go', { method: 'DELETE' }));
    expect(res.status).toBe(400);
    expect(h.worker.ruleCount).toBe(1);
  });

  test('deleting a missing id is a 404', async () => {
    const h = await make();
    const res = await h.handler(req('/api/rules/nope', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });
});

describe('login endpoints', () => {
  test('GET /api/login/status with no stored session and idle flow', async () => {
    const h = await make();
    const body = await (await h.handler(req('/api/login/status'))).json();
    expect(body.botSession).toBeNull();
    expect(body.flow).toEqual({ status: 'idle' });
  });

  test('reports a stored session when one exists', async () => {
    const h = await make();
    await h.sessions.save({
      botId: 'bot-1',
      authToken: 'secret-token-should-never-appear',
      refreshToken: undefined,
      expireSec: undefined,
      savedAtMs: 1_700_000_000_000,
      extra: {},
    });
    const body = await (await h.handler(req('/api/login/status'))).json();
    expect(body.botSession).toEqual({ savedAtMs: 1_700_000_000_000, expireSec: undefined });
    expect(JSON.stringify(body)).not.toContain('secret-token-should-never-appear');
  });

  test('start then status returns a rendered QR once one arrives', async () => {
    const h = await make();
    const startRes = await h.handler(req('/api/login/start', { method: 'POST' }));
    expect(startRes.status).toBe(200);

    const before = await (await h.handler(req('/api/login/status'))).json();
    expect(before.flow.status).toBe('running');
    expect(before.flow.qrSvg).toBeUndefined();
    expect(before.flow.elapsedMs).toBe(0);

    // The underlying login calls this back once LINEJS produces a QR url —
    // drive it the same way a real pairing attempt would.
    h.loginGate()?.opts.onQrUrl?.('https://line.me/R/ti/p/abc123');
    h.clock.advance(4_200);

    const after = await (await h.handler(req('/api/login/status'))).json();
    expect(after.flow.status).toBe('running');
    expect(after.flow.qrUrl).toBe('https://line.me/R/ti/p/abc123');
    expect(typeof after.flow.qrSvg).toBe('string');
    expect(after.flow.qrSvg).toContain('<svg');
    // This is the field the /login page's "ผ่านมา N วินาที" line reads; its
    // absence from the response (rather than a client-side bug) is exactly
    // what shipped the first time this page went out.
    expect(after.flow.elapsedMs).toBe(4_200);
  });

  test('a second start while running is a 400, not a crash', async () => {
    const h = await make();
    await h.handler(req('/api/login/start', { method: 'POST' }));
    const res = await h.handler(req('/api/login/start', { method: 'POST' }));
    expect(res.status).toBe(400);
  });

  test('reset while idle is a no-op 200', async () => {
    const h = await make();
    const res = await h.handler(req('/api/login/reset', { method: 'POST' }));
    expect(res.status).toBe(200);
  });

  test('reset while running is refused (400), not silently accepted', async () => {
    const h = await make();
    await h.handler(req('/api/login/start', { method: 'POST' }));
    const res = await h.handler(req('/api/login/reset', { method: 'POST' }));
    expect(res.status).toBe(400);
  });

  test('a completed login is reflected once the underlying promise resolves', async () => {
    const h = await make();
    await h.handler(req('/api/login/start', { method: 'POST' }));
    h.loginGate()?.resolve({ authToken: 'tok' } as unknown as Client);
    await settle();
    const body = await (await h.handler(req('/api/login/status'))).json();
    expect(body.flow.status).toBe('success');
  });
});

describe('POST /api/login/logout', () => {
  test('clears the stored session and restarts, even with no live client', async () => {
    const h = await make();
    await h.sessions.save({
      botId: 'bot-1',
      authToken: 'secret-token-should-never-appear',
      refreshToken: undefined,
      expireSec: undefined,
      savedAtMs: 1_700_000_000_000,
      extra: {},
    });
    const res = await h.handler(req('/api/login/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await h.sessions.load('bot-1')).toBeNull();
    expect(h.restarted).toBe(true);
  });

  test('calls LINE logoutZ on the live client before clearing the local session', async () => {
    let called = false;
    const client = {
      base: {
        auth: {
          logoutZ: () => {
            called = true;
            return Promise.resolve(true);
          },
        },
      },
    } as unknown as Client;
    const h = await make({ client });
    await h.sessions.save({
      botId: 'bot-1',
      authToken: 'tok',
      refreshToken: undefined,
      expireSec: undefined,
      savedAtMs: 1_700_000_000_000,
      extra: {},
    });
    const res = await h.handler(req('/api/login/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    expect(await h.sessions.load('bot-1')).toBeNull();
  });

  test('a LINE-side logoutZ failure still clears the local session and restarts', async () => {
    const client = {
      base: { auth: { logoutZ: () => Promise.reject(new Error('already logged out')) } },
    } as unknown as Client;
    const h = await make({ client });
    await h.sessions.save({
      botId: 'bot-1',
      authToken: 'tok',
      refreshToken: undefined,
      expireSec: undefined,
      savedAtMs: 1_700_000_000_000,
      extra: {},
    });
    const res = await h.handler(req('/api/login/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await h.sessions.load('bot-1')).toBeNull();
    expect(h.restarted).toBe(true);
  });

  test("also removes LINEJS's own storage file, when one exists", async () => {
    const h = await make();
    await Deno.writeTextFile(h.linejsStoragePath, '{}');
    const res = await h.handler(req('/api/login/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    await expect(Deno.stat(h.linejsStoragePath)).rejects.toThrow(Deno.errors.NotFound);
  });

  test('logging out with no stored session at all is still a clean 200', async () => {
    const h = await make();
    const res = await h.handler(req('/api/login/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(h.restarted).toBe(true);
  });
});

describe('POST /api/admin/restart', () => {
  test('invokes the injected restart hook and answers before doing so', async () => {
    const h = await make();
    const res = await h.handler(req('/api/admin/restart', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(h.restarted).toBe(true);
  });
});

describe('isAdminPath / createCombinedHandler', () => {
  test('names every route this module owns', () => {
    expect(isAdminPath('/rules')).toBe(true);
    expect(isAdminPath('/groups')).toBe(true);
    expect(isAdminPath('/api/groups')).toBe(true);
    expect(isAdminPath('/login')).toBe(true);
    expect(isAdminPath('/api/rules')).toBe(true);
    expect(isAdminPath('/api/rules/go')).toBe(true);
    expect(isAdminPath('/api/login/start')).toBe(true);
    expect(isAdminPath('/api/admin/restart')).toBe(true);
    expect(isAdminPath('/account/login')).toBe(true);
    expect(isAdminPath('/account/logout')).toBe(true);
    expect(isAdminPath('/api/account/login')).toBe(true);
    expect(isAdminPath('/users')).toBe(true);
    expect(isAdminPath('/api/users')).toBe(true);
    expect(isAdminPath('/api/users/u-1')).toBe(true);
    expect(isAdminPath('/app')).toBe(true);
    expect(isAdminPath('/')).toBe(false);
    expect(isAdminPath('/api/status')).toBe(false);
    expect(isAdminPath('/api/health')).toBe(false);
  });

  async function loginCookie(
    h: Harness,
    username: string,
    password: string,
  ): Promise<string> {
    const res = await h.handler(req('/api/account/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    return setCookie.split(';')[0] ?? '';
  }

  test('an unauthenticated GET for an HTML page redirects to the login page', async () => {
    const h = await make();
    const status = createStatusHandler(h.worker.status);
    const combined = createCombinedHandler(h.handler, status, { users: h.users });

    for (const path of ['/', '/rules', '/groups', '/app']) {
      const res = await combined(req(path));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/account/login');
    }
  });

  test('an unauthenticated API call is a 401, not a redirect', async () => {
    const h = await make();
    const status = createStatusHandler(h.worker.status);
    const combined = createCombinedHandler(h.handler, status, { users: h.users });
    const res = await combined(req('/api/rules'));
    expect(res.status).toBe(401);
  });

  test('/api/health passes through with no login required', async () => {
    const h = await make();
    const status = createStatusHandler(h.worker.status);
    const combined = createCombinedHandler(h.handler, status, { users: h.users });
    const res = await combined(req('/api/health'));
    expect(res.status === 200 || res.status === 503).toBe(true);
  });

  test('the first admin account reaches the dashboard and rules pages', async () => {
    const h = await make();
    const status = createStatusHandler(h.worker.status);
    const combined = createCombinedHandler(h.handler, status, { users: h.users });
    const cookie = await loginCookie(h, 'admin', TEST_ADMIN_PASSWORD);

    const dashboard = await combined(req('/', { headers: { cookie } }));
    expect(await dashboard.text()).toContain('dashboard');

    const rules = await combined(req('/rules', { headers: { cookie } }));
    expect(await rules.text()).toContain('line-first-response');
  });

  test('a wrong password is a 401', async () => {
    const h = await make();
    const res = await h.handler(req('/api/account/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    }));
    expect(res.status).toBe(401);
  });

  test('a "user" account is confined to /app — admin pages redirect, admin-only APIs 403', async () => {
    const h = await make();
    const status = createStatusHandler(h.worker.status);
    const combined = createCombinedHandler(h.handler, status, { users: h.users });
    await h.users.create({ username: 'staff', password: 'staffpass' });
    const cookie = await loginCookie(h, 'staff', 'staffpass');

    const app = await combined(req('/app', { headers: { cookie } }));
    expect(await app.text()).toContain('line-first-response');

    const dashboard = await combined(req('/', { headers: { cookie } }));
    expect(dashboard.status).toBe(302);
    expect(dashboard.headers.get('location')).toContain('/app');

    const users = await combined(req('/api/users', { headers: { cookie } }));
    expect(users.status).toBe(403);

    // A `user` account is the one actually operating this bot day to day —
    // /api/rules, /api/groups, /api/login/* and /api/admin/restart (the
    // "apply my new QR login" step) all stay open to it.
    const rules = await combined(req('/api/rules', { headers: { cookie } }));
    expect(rules.status).toBe(200);
    const loginStatus = await combined(req('/api/login/status', { headers: { cookie } }));
    expect(loginStatus.status).toBe(200);
    const restart = await combined(
      req('/api/admin/restart', { method: 'POST', headers: { cookie } }),
    );
    expect(restart.status).toBe(200);

    // /app's live speed panel reads /api/status; it always resolves to the
    // signed-in person's own bot, so a `user` account must not get 403 here.
    const apiStatus = await combined(req('/api/status', { headers: { cookie } }));
    expect(apiStatus.status).toBe(200);
    const alerts = await combined(req('/api/alerts', { headers: { cookie } }));
    expect(alerts.status).toBe(403);
  });

  test('/account/logout clears the cookie and redirects to the login page', async () => {
    const h = await make();
    const res = await h.handler(req('/account/logout'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('/api/users', () => {
  test('an admin can create, list, and remove a user', async () => {
    const h = await make();
    const created = await h.handler(req('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'staff', password: 'staffpass', role: 'user' }),
    }));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.user.username).toBe('staff');
    expect(createdBody.user.passwordHash).toBeUndefined();

    const list = await (await h.handler(req('/api/users'))).json();
    expect(list.users.map((u: { username: string }) => u.username)).toEqual(['admin', 'staff']);

    const del = await h.handler(
      req(`/api/users/${createdBody.user.userId}`, { method: 'DELETE' }),
    );
    expect(del.status).toBe(200);
  });

  test('a duplicate username is a 409', async () => {
    const h = await make();
    const res = await h.handler(req('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'whatever1' }),
    }));
    expect(res.status).toBe(409);
  });

  test('removing the only admin account is refused', async () => {
    const h = await make();
    const admin = (await (await h.handler(req('/api/users'))).json()).users[0];
    const res = await h.handler(req(`/api/users/${admin.userId}`, { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  test('PUT resets a password and can change role', async () => {
    const h = await make();
    const created = await (await h.handler(req('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'staff', password: 'staffpass' }),
    }))).json();
    const res = await h.handler(req(`/api/users/${created.user.userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role: 'admin' }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('admin');
  });
});

describe('/api/groups POST — live apply vs restart', () => {
  test('with no setPolledRooms wired, a room-only change still restarts (existing behaviour)', async () => {
    const h = await make({
      client: clientWithGroups([
        { id: 'm-room-1', name: 'Alpha' },
        { id: 'm-room-2', name: 'Beta' },
      ]),
    });
    const res = await h.handler(req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ roomIds: ['m-room-2'] }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).restarted).toBe(true);
    expect(h.restarted).toBe(true);
  });

  test('with setPolledRooms wired, a room-only change applies live with no restart', async () => {
    const h = await make({
      liveRoomApply: true,
      client: clientWithGroups([
        { id: 'm-room-1', name: 'Alpha' },
        { id: 'm-room-2', name: 'Beta' },
      ]),
    });
    const res = await h.handler(req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ roomIds: ['m-room-2'] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.restarted).toBe(false);
    expect(h.restarted).toBe(false);
    expect(h.setPolledRoomsCalls).toEqual([['m-room-2']]);
  });

  test('a talk/square surface change still restarts even with setPolledRooms wired', async () => {
    // CONFIG_BODY has square: true, talk unset (false) — selecting a
    // Talk-only room flips `talk` on, which is a surface change fixed at
    // PUSH-connect time and must still restart.
    const clientWithTalkRoom: Client = {
      base: {
        square: {
          getJoinedSquares: () => Promise.resolve({ squares: [], continuationToken: '' }),
          getJoinableSquareChats: () => Promise.resolve({ squareChats: [], continuationToken: '' }),
        },
        talk: {
          getAllChatMids: () => Promise.resolve({ memberChatMids: ['c-room-1'] }),
          getChats: () =>
            Promise.resolve({ chats: [{ chatMid: 'c-room-1', chatName: 'Talk Room' }] }),
          getAllContactIds: () => Promise.resolve([]),
          getContactsV2: () => Promise.resolve({ contacts: {} }),
        },
      },
    } as unknown as Client;
    const h = await make({ liveRoomApply: true, client: clientWithTalkRoom });
    const res = await h.handler(req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ roomIds: ['c-room-1'] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restarted).toBe(true);
    expect(h.restarted).toBe(true);
    expect(h.setPolledRoomsCalls).toEqual([]);
  });
});

/**
 * Regression coverage for the 2026-09-11 "dashboard is 502 because the bot
 * won't log in" report: `cli/serve.ts` now builds this handler with
 * `worker: undefined` whenever there is no session to connect with yet (or
 * LINE rejected it), instead of the whole process refusing to start. Rules
 * must stay editable and the login page must stay servable in that state —
 * that's the entire point of splitting the two apart.
 */
describe('with no worker (never connected, or session rejected)', () => {
  async function makeDisconnected(): Promise<{
    handler: (req: Request) => Promise<Response>;
    configPath: string;
  }> {
    const configPath = `${dir}/bot.json`;
    await Deno.writeTextFile(configPath, JSON.stringify(CONFIG_BODY));
    const sessions = new MemorySessionStore();
    const logger = new Logger({ level: 'error', sink: () => {} });
    const loginFlow = new LoginFlow({
      botId: 'bot-1',
      device: 'DESKTOPWIN',
      storagePath: `${dir}/bot.linejs.json`,
      sessions,
      logger,
      clock: new FakeClock(1_700_000_000_000),
    });
    const handler = createAdminHandler({
      worker: undefined,
      botId: 'bot-1',
      configPath,
      sessions,
      users: new UsersStore(`${dir}/.control/users.json`, {
        initialAdminPassword: TEST_ADMIN_PASSWORD,
      }),
      logger,
      loginFlow,
      linejsStoragePath: `${dir}/bot.linejs.json`,
    });
    return { handler, configPath };
  }

  test('/rules, /groups and /login still render', async () => {
    const { handler } = await makeDisconnected();
    for (const path of ['/rules', '/groups', '/login']) {
      const res = await handler(req(path));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('line-first-response');
    }
  });

  test('a rule can still be added — it persists to disk without touching a worker', async () => {
    const { handler, configPath } = await makeDisconnected();
    const res = await handler(req('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ping',
        priority: 1,
        kind: 'exact',
        pattern: 'ping',
        reply: 'pong',
      }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rules).toHaveLength(2);
    const onDisk = JSON.parse(await Deno.readTextFile(configPath));
    expect(onDisk.rules).toHaveLength(2);
  });

  test('/api/login/status and /api/login/start still work with no worker involved', async () => {
    const { handler } = await makeDisconnected();
    const status = await handler(req('/api/login/status'));
    expect(status.status).toBe(200);
    expect((await status.json()).botSession).toBeNull();

    const start = await handler(req('/api/login/start', { method: 'POST' }));
    expect(start.status).toBe(200);
  });
});
