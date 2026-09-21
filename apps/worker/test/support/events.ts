import {
  unsafeBotId,
  unsafeMessageId,
  unsafeOwnerId,
  unsafeRoomId,
  unsafeSenderId,
} from '@line-first/contracts';
import type { InboundEvent } from '../../src/adapters/types.ts';

/** Builds a normalized inbound event for tests. Override anything per case. */
export const anEvent = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  surface: 'square',
  source: 'push',
  botId: unsafeBotId('bot-1'),
  ownerId: unsafeOwnerId('owner-1'),
  roomId: unsafeRoomId('room-1'),
  senderId: unsafeSenderId('sender-1'),
  messageId: unsafeMessageId('m-1'),
  text: 'go',
  serviceEventTimeMs: 1_700_000_000_000,
  observedAtMono: 0,
  observedAtWallMs: 1_700_000_000_015,
  ...over,
});
