import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeBotId, unsafeOwnerId } from '@line-first/contracts';
import { FakeClock } from '../../src/lib/clock.ts';
import { Logger, type LogRecord } from '../../src/logging/logger.ts';
import { createRacingInbound } from '../../src/adapters/linejs/racing-inbound.ts';

const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

const captureLogger = (): { logger: Logger; records: LogRecord[] } => {
  const records: LogRecord[] = [];
  return { logger: new Logger({ level: 'debug', sink: (r) => records.push(r) }), records };
};

/** `createRacingInbound` only touches `client` lazily (per-room fetchers close
 * over it), so a bare stub is enough to exercise slot selection. */
const fakeClient = {} as unknown as Parameters<typeof createRacingInbound>[0]['client'];

const build = (over: Partial<Parameters<typeof createRacingInbound>[0]> = {}) =>
  createRacingInbound({
    client: fakeClient,
    botId: unsafeBotId('bot-1'),
    ownerId: unsafeOwnerId('owner-1'),
    clock: new FakeClock(),
    logger: silent(),
    ...over,
  });

const rooms = ['room-a', 'room-b', 'room-c', 'room-d', 'room-e'];

describe('createRacingInbound — slot budget', () => {
  test('gives a dedicated poll to at most `slotBudget` rooms, in order', () => {
    const { polledRooms } = build({ dedicatedRooms: rooms, slotBudget: 2 });
    expect(polledRooms).toEqual(['room-a', 'room-b']);
  });

  test('a zero budget means push only — no dedicated polls', () => {
    const { polledRooms } = build({ dedicatedRooms: rooms, slotBudget: 0 });
    expect(polledRooms).toEqual([]);
  });

  test('a budget at or above the room count polls them all', () => {
    const { polledRooms } = build({ dedicatedRooms: rooms.slice(0, 3), slotBudget: 10 });
    expect(polledRooms).toEqual(['room-a', 'room-b', 'room-c']);
  });

  test('no dedicated rooms is fine — returns a racer wrapping just push', () => {
    const { adapter, polledRooms } = build({ slotBudget: 4 });
    expect(polledRooms).toEqual([]);
    expect(adapter.stats).toEqual({
      wins: { push: 0, 'normal-poll': 0, 'dedicated-poll': 0 },
      seen: { push: 0, 'normal-poll': 0, 'dedicated-poll': 0 },
      duplicatesSuppressed: 0,
      delivered: 0,
    });
  });

  test('a negative budget is clamped to zero', () => {
    const { polledRooms } = build({ dedicatedRooms: rooms, slotBudget: -3 });
    expect(polledRooms).toEqual([]);
  });
});

// The room-switch-without-restart requirement: admin/server.ts's /api/groups
// calls `setRooms` on a live racer instead of restarting. `addChild`'s
// "not started yet" branch and `removeChild`'s unconditional `stop()` are
// both safe against the fake client these tests use (they never actually
// start a fetch loop), so the diff/cap bookkeeping is exercised here through
// its `logger.info('dedicated poll slots updated', …)` side effect.
describe('createRacingInbound — setRooms (live room switch)', () => {
  test('adds newly selected rooms and removes deselected ones', async () => {
    const { logger, records } = captureLogger();
    const { setRooms } = build({ dedicatedRooms: ['room-a', 'room-b'], slotBudget: 3, logger });

    await setRooms(['room-b', 'room-c']);

    const last = records.find((r) => r.msg === 'dedicated poll slots updated');
    expect(last).toMatchObject({ budget: 3, polling: 2, added: 1, removed: 1 });
  });

  test('still caps the new selection at the configured slot budget', async () => {
    const { logger, records } = captureLogger();
    const { setRooms } = build({ slotBudget: 2, logger });

    await setRooms(['room-a', 'room-b', 'room-c']);

    const last = records.find((r) => r.msg === 'dedicated poll slots updated');
    expect(last).toMatchObject({ polling: 2, added: 2, removed: 0 });
  });

  test('re-selecting the exact same rooms logs nothing — a true no-op', async () => {
    const { logger, records } = captureLogger();
    const { setRooms } = build({ dedicatedRooms: ['room-a'], slotBudget: 2, logger });

    await setRooms(['room-a']);

    expect(records.some((r) => r.msg === 'dedicated poll slots updated')).toBe(false);
  });

  test('deselecting every room drops them all', async () => {
    const { logger, records } = captureLogger();
    const { setRooms } = build({ dedicatedRooms: ['room-a', 'room-b'], slotBudget: 2, logger });

    await setRooms([]);

    const last = records.find((r) => r.msg === 'dedicated poll slots updated');
    expect(last).toMatchObject({ polling: 0, added: 0, removed: 2 });
  });
});
