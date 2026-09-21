import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { connectToLine } from '../../src/bots/connect.ts';
import { parseBotConfig } from '../../src/config/bot-config.ts';
import { fakeRuntime, type Harness, makeHarness, noSession, PRIMARY_CONFIG } from './fixture.ts';

let dir: string;
let h: Harness;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-registry-' });
  h = await makeHarness(dir);
});

afterEach(async () => {
  await h.registry.closeAll();
  await Deno.remove(dir, { recursive: true });
});

const readConfig = async (botId: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(`${dir}/config/bots/${botId}.json`));

const waitFor = async (predicate: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

describe('BotRegistry — who owns which bot', () => {
  test('the first admin keeps the bot the process was started with', async () => {
    const [admin] = await h.users.list();
    const host = await h.registry.hostFor(admin!);
    expect(host).toBe(h.primary);
    expect((await h.users.findById(admin!.userId))?.botId).toBe('bot-1');
  });

  test('every other person gets a bot of their own, never the primary', async () => {
    const [admin] = await h.users.list();
    await h.registry.hostFor(admin!);
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const bob = await h.users.create({ username: 'bob', password: 'bobpass1' });

    const aliceHost = await h.registry.hostFor(alice);
    const bobHost = await h.registry.hostFor(bob);

    const ids = new Set([h.primary.botId, aliceHost.botId, bobHost.botId]);
    expect(ids.size).toBe(3);
    expect(aliceHost.configPath).not.toBe(bobHost.configPath);
    expect(aliceHost.loginFlow).not.toBe(bobHost.loginFlow);
  });

  test('the assignment is remembered, so the same person always gets the same bot', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const first = await h.registry.hostFor(alice);
    const again = await h.registry.hostFor(alice);
    expect(again).toBe(first);
    expect((await h.users.findById(alice.userId))?.botId).toBe(first.botId);
  });

  test('two people arriving at the same moment cannot both take the primary bot', async () => {
    const second = await h.users.create({
      username: 'boss2',
      password: 'bosspass2',
      role: 'admin',
    });
    const [admin] = await h.users.list();
    const [a, b] = await Promise.all([
      h.registry.hostFor(admin!),
      h.registry.hostFor(second),
    ]);
    expect(a).not.toBe(b);
    expect([a, b].filter((host) => host === h.primary)).toHaveLength(1);
  });

  test('--primary-owner hands the existing bot to that person instead of the admin', async () => {
    const owned = await makeHarness(await Deno.makeTempDir({ prefix: 'lfr-owner-' }), {
      primaryOwner: 'Staff',
    });
    try {
      const staff = await owned.users.create({ username: 'staff', password: 'staffpass' });
      const [admin] = await owned.users.list();
      expect(await owned.registry.hostFor(admin!)).not.toBe(owned.primary);
      expect(await owned.registry.hostFor(staff)).toBe(owned.primary);
    } finally {
      await owned.registry.closeAll();
      await Deno.remove(owned.dir, { recursive: true });
    }
  });

  test('a bot is never shared: setBotId refuses one that belongs to someone else', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const bob = await h.users.create({ username: 'bob', password: 'bobpass1' });
    await h.users.setBotId(alice.userId, 'u-shared');
    await expect(h.users.setBotId(bob.userId, 'u-shared')).rejects.toThrow(/already belongs/);
  });
});

describe('BotRegistry — a new person’s bot config', () => {
  test('loads, and starts with nothing of the primary’s rooms, senders or rules', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const host = await h.registry.hostFor(alice);
    const raw = await readConfig(host.botId);

    expect(() => parseBotConfig(raw)).not.toThrow();
    expect(raw['botId']).toBe(host.botId);
    expect(raw['ownerId']).toBe(`owner-${host.botId}`);
    expect(raw['dedicatedRooms']).toEqual([]);
    expect(raw['allowedSenders']).toBeUndefined();
    expect(JSON.stringify(raw['rules'])).not.toContain('first!');
    // Answers no room until its owner picks some — nothing posts on connect.
    expect(raw['selectedRooms']).toEqual([]);
  });

  test('inherits tuning (lanes, cadence, dry run) from the primary', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const raw = await readConfig((await h.registry.hostFor(alice)).botId);
    expect(raw['lanes']).toBe(PRIMARY_CONFIG.lanes);
    expect(raw['pollIntervalMs']).toBe(PRIMARY_CONFIG.pollIntervalMs);
    expect(raw['dryRun']).toBe(PRIMARY_CONFIG.dryRun);
  });

  test('does not touch the primary’s own config file', async () => {
    const before = await Deno.readTextFile(`${dir}/config/bots/bot-1.json`);
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    await h.registry.hostFor(alice);
    expect(await Deno.readTextFile(`${dir}/config/bots/bot-1.json`)).toBe(before);
  });

  test('an existing config is reused, not overwritten, after a process restart', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const host = await h.registry.hostFor(alice);
    const path = `${dir}/config/bots/${host.botId}.json`;
    const edited = { ...(await readConfig(host.botId)), rules: PRIMARY_CONFIG.rules };
    await Deno.writeTextFile(path, JSON.stringify(edited));

    const restarted = await makeHarness(dir);
    const again = await restarted.registry.hostFor((await restarted.users.findById(alice.userId))!);
    expect(again.botId).toBe(host.botId);
    expect(JSON.parse(await Deno.readTextFile(path))['rules']).toEqual(PRIMARY_CONFIG.rules);
    await restarted.registry.closeAll();
  });
});

describe('BotRegistry — lifecycle', () => {
  test('startOwned reconnects every person who already has a bot', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    await h.registry.hostFor(alice);
    const restarted = await makeHarness(dir);
    await restarted.registry.startOwned();
    expect(restarted.hosts.size).toBe(2);
    expect(restarted.connects).toContain((await h.users.findById(alice.userId))!.botId);
    await restarted.registry.closeAll();
  });

  test('startOwned limits simultaneous connection warm-ups', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const bob = await h.users.create({ username: 'bob', password: 'bobpass1' });
    const carol = await h.users.create({ username: 'carol', password: 'carolpass' });
    await Promise.all([
      h.registry.hostFor(alice),
      h.registry.hostFor(bob),
      h.registry.hostFor(carol),
    ]);

    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const connect: typeof connectToLine = (options) => {
      if (options.bot.botId === 'bot-1') return noSession(options);
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        release.push(() => {
          active -= 1;
          resolve(fakeRuntime([], `${options.bot.botId} `).runtime);
        });
      });
    };
    const restarted = await makeHarness(dir, { connect });
    const starting = restarted.registry.startOwned();

    try {
      expect(await waitFor(() => release.length === 2)).toBe(true);
      release.shift()?.();
      expect(await waitFor(() => release.length === 2)).toBe(true);
      release.shift()?.();
      release.shift()?.();
      await starting;
      expect(peak).toBe(2);
    } finally {
      for (const resolve of release.splice(0)) resolve();
      await starting;
      await restarted.registry.closeAll();
    }
  });

  test('releasing a person stops their bot and leaves the primary running', async () => {
    const alice = await h.users.create({ username: 'alice', password: 'alicepass' });
    const host = await h.registry.hostFor(alice);
    const owner = (await h.users.findById(alice.userId))!;

    await h.registry.release(owner);
    await expect(host.restart()).resolves.toBeUndefined(); // closed hosts ignore restarts

    const [admin] = await h.users.list();
    await h.registry.hostFor(admin!);
    await h.registry.release((await h.users.findById(admin!.userId))!);
    expect(await h.registry.hostFor((await h.users.findById(admin!.userId))!)).toBe(h.primary);
  });
});
