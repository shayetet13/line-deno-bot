import type { Client } from '@evex/linejs';
import type { BotId, OwnerId } from '@line-first/contracts';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../logging/logger.ts';
import { RacingInboundAdapter } from '../racing.ts';
import { LinejsInboundAdapter } from './inbound.ts';
import { makeLinejsSquareFetcher } from './square-fetcher.ts';
import { SquarePollAdapter } from './square-poll.ts';
import type { SquarePollQuietGate } from './poll-quiet.ts';
import type { PushHealth } from '../types.ts';

export interface RacingInboundConfig {
  client: Client;
  botId: BotId;
  ownerId: OwnerId;
  clock: Clock;
  logger: Logger;
  /** Rooms to give a dedicated poll, most important first. Only the first
   * `slotBudget` of them get one — the rest are covered by push alone. */
  dedicatedRooms?: readonly string[];
  /** Max concurrent dedicated polls. A poll costs ~1 request / `pollIntervalMs`
   * per room, so this bounds the request rate (Playbook §5.4). 0 = push only. */
  slotBudget?: number;
  pollIntervalMs?: number;
  /** How many fetches each dedicated poll races per round — see
   * {@link SquarePollAdapter}'s `pollRaceWidth`. */
  pollRaceWidth?: number;
  /** Staggered in-flight fetches per dedicated poll — see
   * {@link SquarePollAdapter}'s `pollStagger`. */
  pollStagger?: number;
  talk?: boolean;
  square?: boolean;
  pollQuiet?: SquarePollQuietGate;
  pushStatus?: () => PushHealth;
}

export interface RacingInboundResult {
  adapter: RacingInboundAdapter;
  /** Rooms that were given a dedicated-poll slot at startup. */
  polledRooms: readonly string[];
  /**
   * Diffs `rooms` (capped at the same slot budget `createRacingInbound` was
   * given) against whichever rooms currently have a dedicated poll, and
   * adds/removes live pollers on the running racer accordingly — no
   * restart, no gap in push coverage. This is the mechanism behind the
   * room-switch-without-restart requirement; `admin/server.ts`'s
   * `/api/groups` calls it instead of restarting whenever only the room
   * selection changed (not the talk/square surface itself).
   */
  setRooms: (rooms: readonly string[]) => Promise<void>;
}

const DEFAULT_SLOT_BUDGET = 4;
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Builds the inbound stack for Phase 5: the account-wide push stream (covers
 * every room) raced against a bounded number of dedicated per-room polls.
 *
 * The slot budget is the whole point — a dedicated poll wins ~40-100ms of
 * inbound on a watched room (measured), but one request per 100ms per room does
 * not scale to every room, so only the rooms the game actually uses get one.
 */
export function createRacingInbound(config: RacingInboundConfig): RacingInboundResult {
  const budget = Math.max(0, config.slotBudget ?? DEFAULT_SLOT_BUDGET);
  const polledRooms = (config.dedicatedRooms ?? []).slice(0, budget);

  const push = new LinejsInboundAdapter({
    client: config.client,
    botId: config.botId,
    ownerId: config.ownerId,
    clock: config.clock,
    logger: config.logger,
    ...(config.pushStatus === undefined ? {} : { pushStatus: config.pushStatus }),
    talk: config.talk ?? true,
    square: config.square ?? true,
  });

  const makePoll = (room: string): SquarePollAdapter =>
    new SquarePollAdapter({
      fetcher: makeLinejsSquareFetcher(config.client, room),
      botId: config.botId,
      ownerId: config.ownerId,
      clock: config.clock,
      logger: config.logger,
      intervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      ...(config.pollRaceWidth === undefined ? {} : { pollRaceWidth: config.pollRaceWidth }),
      ...(config.pollStagger === undefined ? {} : { pollStagger: config.pollStagger }),
      quietBeforeNextFetchMs: () => config.pollQuiet?.remainingMs(room) ?? 0,
    });

  // Tracked by room id so `setRooms` can diff against it and stop exactly
  // the polls that fell out of the new selection.
  const polls = new Map<string, SquarePollAdapter>(
    polledRooms.map((room) => [room, makePoll(room)] as const),
  );

  if (polledRooms.length > 0) {
    config.logger.info('dedicated poll slots assigned', {
      budget,
      requested: config.dedicatedRooms?.length ?? 0,
      polling: polledRooms.length,
    });
  }

  const adapter = new RacingInboundAdapter([push, ...polls.values()], {
    clock: config.clock,
    logger: config.logger,
  });

  const setRooms = async (rooms: readonly string[]): Promise<void> => {
    const next = new Set([...rooms].slice(0, budget));
    const toRemove = [...polls.keys()].filter((room) => !next.has(room));
    const toAdd = [...next].filter((room) => !polls.has(room));

    for (const room of toRemove) {
      const poll = polls.get(room);
      polls.delete(room);
      if (poll !== undefined) await adapter.removeChild(poll);
    }
    for (const room of toAdd) {
      const poll = makePoll(room);
      polls.set(room, poll);
      await adapter.addChild(poll);
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      config.logger.info('dedicated poll slots updated', {
        budget,
        polling: polls.size,
        added: toAdd.length,
        removed: toRemove.length,
      });
    }
  };

  return { adapter, polledRooms, setRooms };
}
