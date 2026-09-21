import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  unsafeBotId,
  unsafeMessageId,
  unsafeOwnerId,
  unsafeRoomId,
  unsafeRuleId,
} from '@line-first/contracts';
import { Claims, type ClaimsConfig } from '../../../src/core/dedupe/claims.ts';
import { FakeClock } from '../../../src/lib/clock.ts';

const CONFIG: ClaimsConfig = {
  incoming: { ttlMs: 1_000, maxEntries: 100 },
  reply: { ttlMs: 1_000, maxEntries: 100 },
  roomAnswer: { ttlMs: 1_000, maxEntries: 100 },
};

const bot = unsafeBotId('bot-1');
const owner = unsafeOwnerId('owner-1');
const room = unsafeRoomId('room-1');
const rule = unsafeRuleId('rule-1');
const msg = unsafeMessageId('m-1');

describe('Claims.incomingMessage', () => {
  test('first caller wins, repeats lose until ttl expiry', () => {
    const clock = new FakeClock();
    const claims = new Claims(clock, CONFIG);
    expect(claims.incomingMessage(bot, 'square', msg)).toBe(true);
    expect(claims.incomingMessage(bot, 'square', msg)).toBe(false);
    clock.advance(1_000);
    expect(claims.incomingMessage(bot, 'square', msg)).toBe(true);
  });

  test('a duplicate from push + poll only processes once', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    const fromPush = claims.incomingMessage(bot, 'square', msg);
    const fromPoll = claims.incomingMessage(bot, 'square', msg);
    expect([fromPush, fromPoll]).toEqual([true, false]);
  });

  test('different bot or surface are independent claims', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    expect(claims.incomingMessage(bot, 'square', msg)).toBe(true);
    expect(claims.incomingMessage(unsafeBotId('bot-2'), 'square', msg)).toBe(true);
    expect(claims.incomingMessage(bot, 'talk', msg)).toBe(true);
  });

  test('release lets the same event be claimed again', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    claims.incomingMessage(bot, 'square', msg);
    claims.releaseIncoming(bot, 'square', msg);
    expect(claims.incomingMessage(bot, 'square', msg)).toBe(true);
  });
});

describe('Claims.reply / roomAnswer', () => {
  test('reply gate is keyed by (bot, room, rule, message)', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    expect(claims.reply(bot, room, rule, msg)).toBe(true);
    expect(claims.reply(bot, room, rule, msg)).toBe(false);
    expect(claims.reply(bot, room, unsafeRuleId('rule-2'), msg)).toBe(true);
  });

  test('roomAnswer stops sibling bots of one owner double-answering', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    expect(claims.roomAnswer(owner, room, msg)).toBe(true);
    expect(claims.roomAnswer(owner, room, msg)).toBe(false);
    expect(claims.roomAnswer(unsafeOwnerId('owner-2'), room, msg)).toBe(true);
  });

  test('sizes reports per-store entry counts', () => {
    const claims = new Claims(new FakeClock(), CONFIG);
    claims.incomingMessage(bot, 'square', msg);
    claims.reply(bot, room, rule, msg);
    expect(claims.sizes).toEqual({ incoming: 1, reply: 1, roomAnswer: 0 });
  });
});
