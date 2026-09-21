import type { BotId, MessageId, OwnerId, RoomId, RuleId, Surface } from '@line-first/contracts';
import type { Clock } from '../../lib/clock.ts';
import { claimKey, ClaimStore } from './claim-store.ts';

export interface ClaimsConfig {
  incoming: { ttlMs: number; maxEntries: number };
  reply: { ttlMs: number; maxEntries: number };
  roomAnswer: { ttlMs: number; maxEntries: number };
}

/**
 * The three dedupe gates from Playbook §5.2, in the order they run:
 *
 *  1. {@link incomingMessage} — one event drives rule/log/UI once, even when
 *     push and poll both deliver it (§10.4).
 *  2. {@link reply} — one rule answers one message once.
 *  3. {@link roomAnswer} — sibling bots of the same owner do not double-answer.
 *
 * Every method returns `true` only for the caller that acquired the gate.
 */
export class Claims {
  readonly #incoming: ClaimStore;
  readonly #reply: ClaimStore;
  readonly #roomAnswer: ClaimStore;

  constructor(clock: Clock, config: ClaimsConfig) {
    this.#incoming = new ClaimStore(clock, config.incoming);
    this.#reply = new ClaimStore(clock, config.reply);
    this.#roomAnswer = new ClaimStore(clock, config.roomAnswer);
  }

  incomingMessage(botId: BotId, surface: Surface, messageId: MessageId): boolean {
    return this.#incoming.tryClaim(claimKey(botId, surface, messageId));
  }

  reply(botId: BotId, room: RoomId, ruleId: RuleId, messageId: MessageId): boolean {
    return this.#reply.tryClaim(claimKey(botId, room, ruleId, messageId));
  }

  roomAnswer(ownerId: OwnerId, room: RoomId, messageId: MessageId): boolean {
    return this.#roomAnswer.tryClaim(claimKey(ownerId, room, messageId));
  }

  /** Drop every claim owned by a bot that has stopped (Playbook §10.5 cleanup). */
  releaseIncoming(botId: BotId, surface: Surface, messageId: MessageId): void {
    this.#incoming.release(claimKey(botId, surface, messageId));
  }

  get sizes(): { incoming: number; reply: number; roomAnswer: number } {
    return {
      incoming: this.#incoming.size,
      reply: this.#reply.size,
      roomAnswer: this.#roomAnswer.size,
    };
  }
}
