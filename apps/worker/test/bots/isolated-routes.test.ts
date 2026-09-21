import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { UsersStore } from '../../src/admin/users-store.ts';
import { BotHost } from '../../src/bots/bot-host.ts';
import { createIsolatedHandler } from '../../src/bots/isolated-routes.ts';
import { loadConfig } from '../../src/config/env.ts';
import { Logger } from '../../src/logging/logger.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { noSession, PRIMARY_CONFIG } from './fixture.ts';

let dir: string;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-isolated-' });
  await Deno.mkdir(`${dir}/config/bots`, { recursive: true });
  await Deno.writeTextFile(`${dir}/config/bots/bot-1.json`, JSON.stringify(PRIMARY_CONFIG));
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

const req = (path: string, init?: RequestInit): Request =>
  new Request(`http://localhost${path}`, init);

describe('isolated routes', () => {
  test('serves only its primary host and needs no BotRegistry', async () => {
    const logger = new Logger({ level: 'error', sink: () => {} });
    const sessions = new MemorySessionStore();
    const users = new UsersStore(`${dir}/.control/bot-users/bot-1.json`);
    const host = new BotHost({
      botId: 'bot-1',
      configPath: `${dir}/config/bots/bot-1.json`,
      sessionsDir: `${dir}/.sessions`,
      env: loadConfig({}),
      sessions,
      logger,
      connect: noSession,
    });
    await host.start();
    const handler = createIsolatedHandler({ host, users, sessions });

    expect((await handler(req('/api/health'))).status).toBe(503);
    const login = await handler(req('/api/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Root@77#' }),
    }));
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const rules = await handler(req('/api/rules', { headers: { cookie: cookie! } }));
    expect(rules.status).toBe(200);
    expect((await rules.json()).rules[0].id).toBe('go');
    await host.close();
  });
});
