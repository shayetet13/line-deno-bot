import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { type BotConfig, parseBotConfig } from '../../src/config/bot-config.ts';

const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  botId: 'bot-1',
  ownerId: 'owner-1',
  rules: [{ id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' }],
  ...over,
});

const parse = (over: Record<string, unknown> = {}): BotConfig => parseBotConfig(minimal(over));

const errorsOf = (raw: unknown): string[] => {
  try {
    parseBotConfig(raw);
  } catch (err: unknown) {
    if (err instanceof ConfigError) return err.context['errors'] as string[];
  }
  throw new Error('expected a ConfigError');
};

describe('parseBotConfig', () => {
  test('a minimal config parses with safe defaults', () => {
    const c = parse();
    expect(c.botId).toBe('bot-1');
    expect(c.square).toBe(true);
    expect(c.talk).toBe(false);
    expect(c.slotBudget).toBe(4);
    expect(c.lanes).toBe(0);
    expect(c.sendReservedLanes).toBe(0);
    expect(c.pollIntervalMs).toBe(100);
    expect(c.pollQuietMs).toBe(0);
    expect(c.allowedSenders).toBeUndefined();
    expect(c.selectedRooms).toBeUndefined();
  });

  test('dryRun defaults to TRUE — a forgotten flag must not post into a real room', () => {
    expect(parse().dryRun).toBe(true);
    expect(parse({ dryRun: true }).dryRun).toBe(true);
    expect(parse({ dryRun: false }).dryRun).toBe(false);
  });

  test('an omitted allowlist means anyone; an empty one closes the bot', () => {
    expect(parse().allowedSenders).toBeUndefined();
    expect(parse({ allowedSenders: [] }).allowedSenders).toEqual([]);
    expect(parse({ allowedSenders: ['p1', 'p2'] }).allowedSenders).toEqual(['p1', 'p2']);
  });

  test('rules are required — a bot with none answers nothing', () => {
    expect(errorsOf(minimal({ rules: [] }))[0]).toContain('at least one rule');
  });

  test('duplicate rule ids are rejected', () => {
    const rule = { id: 'go', priority: 1, kind: 'exact', pattern: 'a', reply: 'b' };
    expect(errorsOf(minimal({ rules: [rule, { ...rule, pattern: 'c' }] })).join())
      .toContain('duplicate rule id');
  });

  test('an unknown match kind is named, not silently dropped', () => {
    expect(
      errorsOf(
        minimal({ rules: [{ id: 'x', priority: 1, kind: 'fuzzy', pattern: 'a', reply: 'b' }] }),
      ).join(),
    )
      .toContain('kind');
  });

  test('every problem is reported at once, not one restart at a time', () => {
    const errors = errorsOf({
      botId: '',
      ownerId: 42,
      slotBudget: -1,
      rules: [{ id: 'x', priority: 1, kind: 'exact', pattern: '', reply: '' }],
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  test('turning off both surfaces is refused — nothing would arrive', () => {
    expect(errorsOf(minimal({ talk: false, square: false })).join())
      .toContain('nothing would be received');
  });

  test('a non-object top level is refused outright', () => {
    expect(() => parseBotConfig([])).toThrow(ConfigError);
    expect(() => parseBotConfig('nope')).toThrow(ConfigError);
    expect(() => parseBotConfig(null)).toThrow(ConfigError);
  });

  test('refuses legacy regex rules and flags so they cannot stall the shared event loop', () => {
    expect(
      errorsOf(minimal({
        rules: [{ id: 'r', priority: 1, kind: 'regex', pattern: 'a+', reply: 'x' }],
      })).join(),
    ).toContain('kind');
    expect(
      errorsOf(minimal({
        rules: [{ id: 'r', priority: 1, kind: 'exact', pattern: 'a+', reply: 'x', flags: 'i' }],
      })).join(),
    ).toContain('flags');
  });

  test('dedicatedRooms and slotBudget carry through', () => {
    const c = parse({
      dedicatedRooms: ['m1', 'm2'],
      selectedRooms: ['m1', 'c1', 'u1'],
      slotBudget: 1,
    });
    expect(c.dedicatedRooms).toEqual(['m1', 'm2']);
    expect(c.selectedRooms).toEqual(['m1', 'c1', 'u1']);
    expect(c.slotBudget).toBe(1);
  });

  test('pollIntervalMs carries through, including 0 — the intended "poll again immediately" mode', () => {
    expect(parse({ pollIntervalMs: 30 }).pollIntervalMs).toBe(30);
    expect(parse({ pollIntervalMs: 0 }).pollIntervalMs).toBe(0);
    expect(errorsOf(minimal({ pollIntervalMs: -1 })).join()).toContain('pollIntervalMs');
  });

  test('pollQuietMs is bounded to the measured 0-40ms window', () => {
    expect(parse({ pollQuietMs: 0 }).pollQuietMs).toBe(0);
    expect(parse({ pollQuietMs: 30 }).pollQuietMs).toBe(30);
    expect(errorsOf(minimal({ pollQuietMs: -1 })).join()).toContain('pollQuietMs');
    expect(errorsOf(minimal({ pollQuietMs: 41 })).join()).toContain('pollQuietMs');
  });

  test('squarePollRaceWidth defaults to 1 and is capped so a typo cannot flood LINE', () => {
    expect(parse({}).squarePollRaceWidth).toBe(1);
    expect(parse({ squarePollRaceWidth: 4 }).squarePollRaceWidth).toBe(4);
    expect(errorsOf(minimal({ squarePollRaceWidth: 0 })).join()).toContain('squarePollRaceWidth');
    expect(errorsOf(minimal({ squarePollRaceWidth: 50 })).join()).toContain('squarePollRaceWidth');
  });

  test('squarePollStagger defaults to 1, is capped, and excludes squarePollRaceWidth', () => {
    expect(parse({}).squarePollStagger).toBe(1);
    expect(parse({ squarePollStagger: 3 }).squarePollStagger).toBe(3);
    expect(errorsOf(minimal({ squarePollStagger: 0 })).join()).toContain('squarePollStagger');
    expect(errorsOf(minimal({ squarePollStagger: 5 })).join()).toContain('squarePollStagger');
    expect(errorsOf(minimal({ squarePollStagger: 2, squarePollRaceWidth: 2 })).join()).toContain(
      'squarePollStagger',
    );
  });

  test('reserves one send lane by default and validates the poll fallback', () => {
    expect(parse({ lanes: 6 }).sendReservedLanes).toBe(1);
    expect(parse({ lanes: 6, sendReservedLanes: 2 }).sendReservedLanes).toBe(2);
    expect(errorsOf(minimal({ lanes: 2, sendReservedLanes: 2 })).join()).toContain(
      'sendReservedLanes',
    );
  });

  test('the source name appears in the error so the operator knows which file', () => {
    try {
      parseBotConfig({ botId: '' }, 'config/bots/bot-9.json');
    } catch (err: unknown) {
      expect((err as ConfigError).message).toContain('config/bots/bot-9.json');
    }
  });
});

describe('allowedSenders null handling', () => {
  test('null reads as "no allowlist" so the key can stay visible in the file', () => {
    expect(parse({ allowedSenders: null }).allowedSenders).toBeUndefined();
  });

  test('a non-array value is still an error', () => {
    expect(errorsOf(minimal({ allowedSenders: 'p1' })).join()).toContain('allowedSenders');
  });
});
