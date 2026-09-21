import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import {
  nextFreePort,
  provisionBot,
  sanitizeSlug,
  usedPorts,
} from '../../src/cli/provision-bot.ts';

const EXAMPLE_CONFIG = {
  botId: 'bot-1',
  ownerId: 'owner-1',
  talk: false,
  square: true,
  dedicatedRooms: ['m-some-real-room'],
  slotBudget: 4,
  allowedSenders: null,
  rules: [{ id: 'example-exact', priority: 100, kind: 'exact', pattern: 'ping', reply: 'pong' }],
  dryRun: true,
};

let root: string;

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'lfr-provision-' });
  await Deno.mkdir(`${root}/config/bots`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/config/bots/bot-1.example.json`,
    JSON.stringify(EXAMPLE_CONFIG, null, 2),
  );
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true });
});

describe('sanitizeSlug', () => {
  test('lowercases and keeps a-z 0-9 -', () => {
    expect(sanitizeSlug('Shop-B')).toBe('shop-b');
  });

  test('collapses a run of disallowed characters to one -', () => {
    expect(sanitizeSlug('shop  ร้าน  b')).toBe('shop-b');
  });

  test('input that is entirely disallowed characters is refused, not "-"', () => {
    expect(() => sanitizeSlug('ร้าน หนึ่ง!!')).toThrow(ConfigError);
  });

  test('trims leading/trailing -', () => {
    expect(sanitizeSlug('  shop b  ')).toBe('shop-b');
  });

  test('a name with no usable characters at all is refused', () => {
    expect(() => sanitizeSlug('!!!')).toThrow(ConfigError);
  });
});

describe('usedPorts / nextFreePort', () => {
  test('8791 (start.bat itself) is always reserved', async () => {
    const used = await usedPorts(root);
    expect(used.has(8791)).toBe(true);
    expect(nextFreePort(used)).toBe(8792);
  });

  test('picks up ports already claimed by generated start-*.bat files', async () => {
    await Deno.writeTextFile(`${root}/start-shop-a.bat`, 'set CONFIG=x\nset PORT=8792\n');
    const used = await usedPorts(root);
    expect(used.has(8792)).toBe(true);
    expect(nextFreePort(used)).toBe(8793);
  });

  test('ignores files that are not start-*.bat', async () => {
    await Deno.writeTextFile(`${root}/notes.bat`, 'set PORT=9999\n');
    const used = await usedPorts(root);
    expect(used.has(9999)).toBe(false);
  });
});

describe('provisionBot', () => {
  test('writes a fresh config with a new botId/ownerId and no pre-picked rooms', async () => {
    const result = await provisionBot({ name: 'Shop B', root });
    expect(result).toMatchObject({ slug: 'shop-b', port: 8792 });

    const config = JSON.parse(await Deno.readTextFile(`${root}/${result.configPath}`));
    expect(config.botId).toBe('shop-b');
    expect(config.ownerId).toBe('owner-shop-b');
    expect(config.dedicatedRooms).toEqual([]);
    // Everything else carries over from the example untouched.
    expect(config.rules).toEqual(EXAMPLE_CONFIG.rules);
    expect(config.dryRun).toBe(true);
  });

  test('writes a launcher .bat pointed at the new config and port', async () => {
    const result = await provisionBot({ name: 'shop-b', root });
    const bat = await Deno.readTextFile(`${root}/${result.batPath}`);
    expect(bat).toContain(`set CONFIG=${result.configPath}`);
    expect(bat).toContain('set PORT=8792');
    expect(bat).toContain('set SESSIONS_DIR=.sessions');
  });

  test('a second bot gets the next free port, not a collision', async () => {
    const first = await provisionBot({ name: 'shop-a', root });
    const second = await provisionBot({ name: 'shop-b', root });
    expect(first.port).toBe(8792);
    expect(second.port).toBe(8793);
  });

  test('refuses to overwrite an existing bot, and touches nothing', async () => {
    const first = await provisionBot({ name: 'shop-a', root });
    const before = await Deno.readTextFile(`${root}/${first.configPath}`);

    await expect(provisionBot({ name: 'shop-a', root })).rejects.toThrow(ConfigError);

    const after = await Deno.readTextFile(`${root}/${first.configPath}`);
    expect(after).toBe(before);
  });

  test('never touches an unrelated existing bot-1 config', async () => {
    await Deno.writeTextFile(
      `${root}/config/bots/bot-1.json`,
      JSON.stringify({ ...EXAMPLE_CONFIG, dryRun: false }, null, 2),
    );
    const before = await Deno.readTextFile(`${root}/config/bots/bot-1.json`);

    await provisionBot({ name: 'shop-a', root });

    const after = await Deno.readTextFile(`${root}/config/bots/bot-1.json`);
    expect(after).toBe(before);
  });
});
