import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeBotId, unsafeOwnerId } from '@line-first/contracts';
import {
  type NormalizeContext,
  normalizeMessage,
  type RawLineMessage,
  toEpochMs,
} from '../../src/adapters/linejs/normalize.ts';

const CTX: NormalizeContext = {
  botId: unsafeBotId('bot-1'),
  ownerId: unsafeOwnerId('owner-1'),
  surface: 'square',
  source: 'push',
  observedAtMono: 12.5,
  observedAtWallMs: 1_700_000_000_020,
};

const raw = (over: Partial<RawLineMessage> = {}): RawLineMessage => ({
  to: { id: 'room-mid' },
  from: { id: 'sender-mid' },
  text: 'go',
  raw: { message: { id: 'msg-1', createdTime: 1_700_000_000_000 } },
  ...over,
});

describe('toEpochMs', () => {
  test('reads numbers, numeric strings and bigints', () => {
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs('1700000000000')).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000_000n)).toBe(1_700_000_000_000);
  });

  test('reads a thrift Int64-style wrapper', () => {
    expect(toEpochMs({ toNumber: () => 42 })).toBe(42);
  });

  test('returns undefined rather than 0 for anything unreadable', () => {
    expect(toEpochMs(undefined)).toBeUndefined();
    expect(toEpochMs(null)).toBeUndefined();
    expect(toEpochMs('not a number')).toBeUndefined();
    expect(toEpochMs(Number.NaN)).toBeUndefined();
    expect(toEpochMs({})).toBeUndefined();
    expect(toEpochMs({ toNumber: 'nope' })).toBeUndefined();
  });
});

describe('normalizeMessage', () => {
  test('maps a LINEJS message onto the connector-agnostic event', () => {
    expect(normalizeMessage(raw(), CTX)).toEqual({
      surface: 'square',
      source: 'push',
      botId: 'bot-1',
      ownerId: 'owner-1',
      roomId: 'room-mid',
      senderId: 'sender-mid',
      messageId: 'msg-1',
      text: 'go',
      serviceEventTimeMs: 1_700_000_000_000,
      observedAtMono: 12.5,
      observedAtWallMs: 1_700_000_000_020,
    });
  });

  test('an omitted observedAtWallMs stays undefined, not fabricated', () => {
    const { observedAtWallMs: _observedAtWallMs, ...ctxWithoutWall } = CTX;
    const event = normalizeMessage(raw(), ctxWithoutWall);
    expect(event.observedAtWallMs).toBeUndefined();
  });

  test('an unreadable createdTime leaves serviceEventTimeMs undefined', () => {
    const event = normalizeMessage(
      raw({ raw: { message: { id: 'm', createdTime: {} } } }),
      CTX,
    );
    expect(event.serviceEventTimeMs).toBeUndefined();
  });

  test('a non-string body becomes an empty string, not a crash', () => {
    const event = normalizeMessage(
      raw({ text: undefined as unknown as string }),
      CTX,
    );
    expect(event.text).toBe('');
  });

  test('carries the surface and source it was told', () => {
    const event = normalizeMessage(raw(), { ...CTX, surface: 'talk', source: 'dedicated-poll' });
    expect(event.surface).toBe('talk');
    expect(event.source).toBe('dedicated-poll');
  });
});
