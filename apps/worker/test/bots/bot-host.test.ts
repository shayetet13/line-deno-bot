import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BotHost } from '../../src/bots/bot-host.ts';
import type { connectToLine } from '../../src/bots/connect.ts';
import { loadConfig } from '../../src/config/env.ts';
import { MemorySessionStore } from '../../src/session/store.ts';
import { fakeRuntime, PRIMARY_CONFIG, silentLogger } from './fixture.ts';

let dir: string;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-host-' });
  await Deno.writeTextFile(`${dir}/bot.json`, JSON.stringify(PRIMARY_CONFIG));
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

function makeHost(
  connect: typeof connectToLine,
  respawnDelayMs = 0,
  sessions = new MemorySessionStore(),
): BotHost {
  return new BotHost({
    botId: 'bot-1',
    configPath: `${dir}/bot.json`,
    sessionsDir: `${dir}/.sessions`,
    env: loadConfig({}),
    sessions,
    logger: silentLogger(),
    connect,
    respawnDelayMs,
  });
}

describe('BotHost', () => {
  test('a bot with no usable session still comes up, disconnected, with a login flow', async () => {
    const host = makeHost(() => Promise.reject(new Error('no stored session')));
    await host.start();

    expect(host.runtime).toBeUndefined();
    expect(host.loginFlow.state.status).toBe('idle');
    expect(host.status.snapshot().workerId).toBe('bot-1');
  });

  test('a broken config file is reported as disconnected, not thrown out of start()', async () => {
    await Deno.writeTextFile(`${dir}/bot.json`, '{ not json');
    const host = makeHost(() => Promise.reject(new Error('unreachable')));
    await expect(host.start()).resolves.toBeUndefined();
    expect(host.runtime).toBeUndefined();
    expect(host.loginFlow).toBeDefined();
  });

  test('a successful connect exposes the runtime and starts its warmer', async () => {
    const log: string[] = [];
    const { runtime } = fakeRuntime(log);
    const host = makeHost(() => Promise.resolve(runtime));
    await host.start();

    expect(host.runtime).toBe(runtime);
    expect(host.status).toBe(runtime.worker.status);
    expect(log).toEqual(['warmer.start']);
    await host.close();
  });

  test('restart tears the old connection down completely, then connects again', async () => {
    const log: string[] = [];
    let n = 0;
    const host = makeHost(() => {
      n += 1;
      return Promise.resolve(fakeRuntime(log, `#${String(n)} `).runtime);
    });
    await host.start();
    const first = host.runtime;

    await host.restart();

    expect(host.runtime).not.toBe(first);
    expect(log).toEqual([
      '#1 warmer.start',
      '#1 adapter.stop',
      '#1 warmer.stop',
      '#1 push.close',
      '#2 warmer.start',
    ]);
    await host.close();
  });

  test('coalesces overlapping restart requests into one reconnect', async () => {
    const log: string[] = [];
    let connects = 0;
    const host = makeHost(() => {
      connects += 1;
      return Promise.resolve(fakeRuntime(log, `#${String(connects)} `).runtime);
    });
    await host.start();

    await Promise.all([host.restart(), host.restart()]);

    expect(connects).toBe(2);
    expect(log).toEqual([
      '#1 warmer.start',
      '#1 adapter.stop',
      '#1 warmer.stop',
      '#1 push.close',
      '#2 warmer.start',
    ]);
    await host.close();
  });

  test('a restart after the session was removed leaves the bot disconnected', async () => {
    const log: string[] = [];
    let available = true;
    const host = makeHost(() =>
      available
        ? Promise.resolve(fakeRuntime(log).runtime)
        : Promise.reject(new Error('no stored session'))
    );
    await host.start();
    available = false;
    await host.restart();
    expect(host.runtime).toBeUndefined();
    expect(log).toContain('push.close');
  });

  test('a run loop that ends on its own is reconnected, as the old supervisor did', async () => {
    const log: string[] = [];
    const runs: Array<() => void> = [];
    const host = makeHost(() => {
      const fake = fakeRuntime(log, `#${String(runs.length + 1)} `);
      runs.push(fake.endRun);
      return Promise.resolve(fake.runtime);
    });
    await host.start();
    const first = host.runtime;

    runs[0]!(); // the loop dies without anyone asking it to
    for (let i = 0; i < 50 && host.runtime === first; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await host.ready;
    }
    await host.ready;

    expect(runs).toHaveLength(2);
    expect(host.runtime).not.toBe(first);
    await host.close();
  });

  test('close is final: a later restart does not reconnect', async () => {
    let connects = 0;
    const host = makeHost(() => {
      connects += 1;
      return Promise.resolve(fakeRuntime([]).runtime);
    });
    await host.start();
    await host.close();
    await host.restart();
    expect(connects).toBe(1);
    expect(host.runtime).toBeUndefined();
  });

  describe('after a logout', () => {
    const storagePath = (): string => `${dir}/.sessions/bot-1.linejs.json`;

    async function restartWith(stored: boolean): Promise<boolean> {
      const sessions = new MemorySessionStore();
      if (stored) {
        await sessions.save({
          botId: 'bot-1',
          authToken: 't',
          refreshToken: undefined,
          expireSec: undefined,
          savedAtMs: 1,
          extra: {},
        });
      }
      const host = makeHost(() => Promise.resolve(fakeRuntime([]).runtime), 0, sessions);
      await host.start();
      await Deno.mkdir(`${dir}/.sessions`, { recursive: true });
      // Stands in for the old client's debounced write landing during teardown.
      await Deno.writeTextFile(storagePath(), '{"authToken":"stale"}');
      await host.restart();
      await host.close();
      return await Deno.stat(storagePath()).then(() => true, () => false);
    }

    test('the old client’s flush cannot bring back the LINEJS credential file', async () => {
      expect(await restartWith(false)).toBe(false);
    });

    test('while the session still exists, that file is left alone', async () => {
      expect(await restartWith(true)).toBe(true);
    });
  });
});
