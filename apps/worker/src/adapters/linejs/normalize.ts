import {
  type BotId,
  type InboundSource,
  type OwnerId,
  type Surface,
  unsafeMessageId,
  unsafeRoomId,
  unsafeSenderId,
} from '@line-first/contracts';
import type { InboundEvent } from '../types.ts';

/**
 * The slice of a LINEJS `TalkMessage` / `SquareMessage` we actually read.
 * Declaring it structurally keeps {@link normalizeMessage} a pure function that
 * unit tests can drive without a live client.
 */
export interface RawLineMessage {
  to: { id: string };
  from: { id: string };
  text: string;
  raw: { message: { id: string; createdTime: unknown } };
}

export interface NormalizeContext {
  botId: BotId;
  ownerId: OwnerId;
  surface: Surface;
  source: InboundSource;
  observedAtMono: number;
  observedAtWallMs?: number | undefined;
}

/**
 * `createdTime` arrives as a thrift Int64, which shows up as a number, a string
 * or a `{ toNumber() }` wrapper depending on the codec. Anything we cannot read
 * becomes `undefined` — never 0 (Phases §5: an unknown timestamp must stay
 * unknown so inbound delay is not silently understated).
 */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const fn = (value as { toNumber: unknown }).toNumber;
    if (typeof fn === 'function') {
      const parsed = Number((fn as () => unknown).call(value));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

/** Maps a LINEJS message onto our connector-agnostic {@link InboundEvent}. */
export function normalizeMessage(msg: RawLineMessage, ctx: NormalizeContext): InboundEvent {
  return {
    surface: ctx.surface,
    source: ctx.source,
    botId: ctx.botId,
    ownerId: ctx.ownerId,
    roomId: unsafeRoomId(msg.to.id),
    senderId: unsafeSenderId(msg.from.id),
    messageId: unsafeMessageId(msg.raw.message.id),
    text: typeof msg.text === 'string' ? msg.text : '',
    serviceEventTimeMs: toEpochMs(msg.raw.message.createdTime),
    observedAtMono: ctx.observedAtMono,
    observedAtWallMs: ctx.observedAtWallMs,
  };
}
