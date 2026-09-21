import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeBotId, unsafeRoomId } from '@line-first/contracts';
import { RateLimiter } from '../../../src/core/ratelimit/limiter.ts';
import { ConfigError } from '../../../src/errors/base.ts';
import { FakeClock } from '../../../src/lib/clock.ts';

const bot = unsafeBotId('bot-1');
const room = unsafeRoomId('room-1');

describe('RateLimiter', () => {
  test('admits up to capacity, then drops', () => {
    const limiter = new RateLimiter(new FakeClock(), { capacity: 3, refillPerSec: 1 });
    expect([1, 2, 3, 4, 5].map(() => limiter.tryAdmit(bot, room))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test('refills over time up to capacity', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock, { capacity: 2, refillPerSec: 1 });
    limiter.tryAdmit(bot, room);
    limiter.tryAdmit(bot, room);
    expect(limiter.tryAdmit(bot, room)).toBe(false);
    clock.advance(1_000);
    expect(limiter.tryAdmit(bot, room)).toBe(true);
    expect(limiter.tryAdmit(bot, room)).toBe(false);
    clock.advance(10_000);
    expect(limiter.tryAdmit(bot, room)).toBe(true);
    expect(limiter.tryAdmit(bot, room)).toBe(true);
    expect(limiter.tryAdmit(bot, room)).toBe(false);
  });

  test('buckets are isolated per (bot, room)', () => {
    const limiter = new RateLimiter(new FakeClock(), { capacity: 1, refillPerSec: 1 });
    expect(limiter.tryAdmit(bot, room)).toBe(true);
    expect(limiter.tryAdmit(bot, room)).toBe(false);
    expect(limiter.tryAdmit(unsafeBotId('bot-2'), room)).toBe(true);
    expect(limiter.tryAdmit(bot, unsafeRoomId('room-2'))).toBe(true);
    expect(limiter.trackedRooms).toBe(3);
  });

  test('rejects invalid options', () => {
    const clock = new FakeClock();
    expect(() => new RateLimiter(clock, { capacity: 0, refillPerSec: 1 })).toThrow(ConfigError);
    expect(() => new RateLimiter(clock, { capacity: 1.5, refillPerSec: 1 })).toThrow(ConfigError);
    expect(() => new RateLimiter(clock, { capacity: 1, refillPerSec: 0 })).toThrow(ConfigError);
  });
});
