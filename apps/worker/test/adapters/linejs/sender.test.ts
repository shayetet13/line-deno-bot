import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Client } from '@evex/linejs';
import { unsafeRoomId } from '@line-first/contracts';
import { LinejsSender } from '../../../src/adapters/linejs/sender.ts';
import { FakeClock } from '../../../src/lib/clock.ts';
import type { SendCommand } from '../../../src/adapters/types.ts';

const CMD = (over: Partial<SendCommand> = {}): SendCommand => ({
  surface: 'square',
  roomId: unsafeRoomId('room-1'),
  text: 'hi',
  ...over,
});

describe('LinejsSender', () => {
  test('square: sends plain text without reply metadata and reads the result', async () => {
    let sent: unknown;
    const client = {
      base: {
        square: {
          sendMessage: (args: unknown) => {
            sent = args;
            return Promise.resolve({
              createdSquareMessage: { message: { id: 'sq-1', createdTime: 1_700_000_000_050 } },
            });
          },
        },
      },
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD(), new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      sentMessageId: 'sq-1',
      sentServiceEventTimeMs: 1_700_000_000_050,
    });
    expect(sent).toEqual({ squareChatMid: 'room-1', text: 'hi' });
  });

  test('talk: reads the flat compact-message response shape', async () => {
    const client = {
      sendCompactMessage: () =>
        Promise.resolve({ sequenceId: 1, messageId: 123n, createdTime: 1_700_000_000_060 }),
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD({ surface: 'talk' }), new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      sentMessageId: '123',
      sentServiceEventTimeMs: 1_700_000_000_060,
    });
  });

  test('talk: a string messageId is accepted the same as a bigint one', async () => {
    const client = {
      sendCompactMessage: () =>
        Promise.resolve({ sequenceId: 1, messageId: '123', createdTime: 1_700_000_000_060 }),
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD({ surface: 'talk' }), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, sentMessageId: '123' });
  });

  test('a response with neither shape of id leaves sentMessageId undefined', async () => {
    const client = {
      base: { square: { sendMessage: () => Promise.resolve({}) } },
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD(), new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      sentMessageId: undefined,
      sentServiceEventTimeMs: undefined,
    });
  });

  test('an unreadable createdTime leaves sentServiceEventTimeMs undefined, never 0', async () => {
    const client = {
      base: {
        square: {
          sendMessage: () => Promise.resolve({ createdSquareMessage: { message: { id: 'sq-1' } } }),
        },
      },
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sentServiceEventTimeMs).toBeUndefined();
  });

  test('a rejected send is reported as ok: false with the error attached', async () => {
    const client = {
      base: { square: { sendMessage: () => Promise.reject(new Error('boom')) } },
    } as unknown as Client;
    const sender = new LinejsSender(client, new FakeClock());
    const result = await sender.send(CMD(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.sentMessageId).toBeUndefined();
  });

  test('an unsupported surface rejects rather than silently dropping the send', async () => {
    const sender = new LinejsSender({} as unknown as Client, new FakeClock());
    const result = await sender.send(
      CMD({ surface: 'unsupported' as SendCommand['surface'] }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });
});
