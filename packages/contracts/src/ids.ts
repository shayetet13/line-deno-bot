import type { Brand } from './brand.ts';

/**
 * Branded string IDs. Prevents accidentally passing a RoomId where a BotId is
 * expected — a class of bug the decision doc calls out (owner/room/bot claims
 * must not be mixed up).
 *
 * Values originate from LINE events and MUST be validated at the adapter
 * boundary (Phase 1b) before being branded. `unsafe*` constructors only assert
 * the brand; they do not validate.
 */

/** LINE self-bot account identity (stable per account). */
export type BotId = Brand<string, 'BotId'>;

/** Account owner (a user of our platform who may run several sibling bots). */
export type OwnerId = Brand<string, 'OwnerId'>;

/** Room / chat / square-chat identity. */
export type RoomId = Brand<string, 'RoomId'>;

/** Sender identity — always an immutable LINE ID, never a display name. */
export type SenderId = Brand<string, 'SenderId'>;

/** LINE message identity, used as the primary dedupe key. */
export type MessageId = Brand<string, 'MessageId'>;

/** Compiled rule identity within a bot's rule set. */
export type RuleId = Brand<string, 'RuleId'>;

export const unsafeBotId = (value: string): BotId => value as BotId;
export const unsafeOwnerId = (value: string): OwnerId => value as OwnerId;
export const unsafeRoomId = (value: string): RoomId => value as RoomId;
export const unsafeSenderId = (value: string): SenderId => value as SenderId;
export const unsafeMessageId = (value: string): MessageId => value as MessageId;
export const unsafeRuleId = (value: string): RuleId => value as RuleId;
