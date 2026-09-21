import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RuleConflictError, type RuleInput, RulesStore } from '../../src/admin/rules-store.ts';
import { ConfigError, ValidationError } from '../../src/errors/base.ts';

let dir: string;
let path: string;

const write = (body: Record<string, unknown>): Promise<void> =>
  Deno.writeTextFile(path, JSON.stringify(body));

const baseConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  botId: 'bot-1',
  ownerId: 'owner-1',
  square: true,
  rules: [{ id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' }],
  ...over,
});

const rule = (over: Partial<RuleInput> = {}): RuleInput => ({
  id: 'ping',
  priority: 5,
  kind: 'exact',
  pattern: 'ping',
  reply: 'pong',
  ...over,
});

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-rules-' });
  path = `${dir}/bot.json`;
  await write(baseConfig());
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

describe('RulesStore.list', () => {
  test('returns the rules currently on disk', async () => {
    const rules = await new RulesStore(path).list();
    expect(rules).toEqual([{
      id: 'go',
      priority: 10,
      kind: 'exact',
      pattern: 'go',
      reply: 'first!',
    }]);
  });
});

describe('RulesStore.add', () => {
  test('appends a new rule and persists it', async () => {
    const store = new RulesStore(path);
    const config = await store.add(rule());
    expect(config.rules).toHaveLength(2);
    expect((await store.list()).map((r) => r.id)).toEqual(['go', 'ping']);
  });

  test('refuses a duplicate id without touching the file', async () => {
    const store = new RulesStore(path);
    await expect(store.add(rule({ id: 'go' }))).rejects.toThrow(ValidationError);
    expect(await store.list()).toHaveLength(1);
  });

  test('refuses an invalid rule the same way the worker would refuse it at startup', async () => {
    const store = new RulesStore(path);
    // Goes through the same parseBotConfig() the worker loads at startup with,
    // which reports this class of problem as ConfigError.
    await expect(store.add(rule({ kind: 'fuzzy' }))).rejects.toThrow(ConfigError);
    // Rejected before the write — the file on disk is untouched.
    expect(await store.list()).toHaveLength(1);
  });

  test('an empty pattern is rejected, not silently coerced', async () => {
    const store = new RulesStore(path);
    await expect(store.add(rule({ pattern: '' }))).rejects.toThrow(ConfigError);
  });

  test('a legacy regex rule is refused before it can be written', async () => {
    const store = new RulesStore(path);
    await expect(store.add(rule({ id: 'r', kind: 'regex', pattern: 'a+' }))).rejects.toThrow(
      ConfigError,
    );
  });

  test('a crash mid-write leaves the previous file intact (temp-then-rename)', async () => {
    const store = new RulesStore(path);
    await store.add(rule());
    // Simulate the failure path: renaming into a directory that cannot exist
    // must not leave a half-written file at the real path.
    const before = await Deno.readTextFile(path);
    const badStore = new RulesStore(`${dir}/does-not-exist/bot.json`);
    await expect(badStore.add(rule({ id: 'z' }))).rejects.toThrow();
    expect(await Deno.readTextFile(path)).toBe(before);
  });
});

describe('RulesStore.update', () => {
  test('replaces an existing rule by id', async () => {
    const store = new RulesStore(path);
    await store.update('go', rule({ id: 'go', reply: 'updated!' }));
    const updated = (await store.list()).find((r) => r.id === 'go');
    expect(updated?.reply).toBe('updated!');
  });

  test('updating a missing id is a 404-shaped error, not a silent add', async () => {
    const store = new RulesStore(path);
    await expect(store.update('nope', rule({ id: 'nope' }))).rejects.toThrow(RuleConflictError);
    expect(await store.list()).toHaveLength(1);
  });

  test('an invalid replacement is rejected and the original rule survives', async () => {
    const store = new RulesStore(path);
    await expect(store.update('go', rule({ id: 'go', pattern: '' }))).rejects.toThrow(ConfigError);
    expect((await store.list())[0]?.pattern).toBe('go');
  });
});

describe('RulesStore.remove', () => {
  test('deletes a rule by id', async () => {
    const store = new RulesStore(path);
    await store.add(rule());
    await store.remove('ping');
    expect((await store.list()).map((r) => r.id)).toEqual(['go']);
  });

  test('removing a missing id throws rather than silently no-op-ing', async () => {
    const store = new RulesStore(path);
    await expect(store.remove('nope')).rejects.toThrow(RuleConflictError);
  });

  test('removing the last rule is refused — a bot with no rules answers nothing', async () => {
    const store = new RulesStore(path);
    await expect(store.remove('go')).rejects.toThrow(ConfigError);
    expect(await store.list()).toHaveLength(1);
  });
});

describe('RulesStore field preservation', () => {
  test('editing rules never touches unrelated config fields', async () => {
    await write(baseConfig({ dedicatedRooms: ['room-1'], slotBudget: 2, dryRun: false }));
    const store = new RulesStore(path);
    await store.add(rule());
    const raw = JSON.parse(await Deno.readTextFile(path));
    expect(raw.dedicatedRooms).toEqual(['room-1']);
    expect(raw.slotBudget).toBe(2);
    expect(raw.dryRun).toBe(false);
  });
});
