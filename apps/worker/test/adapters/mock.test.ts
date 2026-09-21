import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { unsafeMessageId, unsafeRoomId } from '@line-first/contracts';
import { MockInboundAdapter, MockSender } from '../../src/adapters/mock.ts';
import type { InboundEvent } from '../../src/adapters/types.ts';
import { anEvent } from '../support/events.ts';

const drain = async (adapter: MockInboundAdapter): Promise<InboundEvent[]> => {
  const seen: InboundEvent[] = [];
  for await (const event of adapter.events()) seen.push(event);
  return seen;
};

describe('MockInboundAdapter', () => {
  test('yields events pushed before iteration starts', async () => {
    const adapter = new MockInboundAdapter();
    adapter.push(anEvent({ messageId: unsafeMessageId('a') }));
    adapter.push(anEvent({ messageId: unsafeMessageId('b') }));
    adapter.end();
    const seen = await drain(adapter);
    expect(seen.map((e) => e.messageId)).toEqual(['a', 'b']);
  });

  test('yields events pushed while the consumer is waiting', async () => {
    const adapter = new MockInboundAdapter();
    const pending = drain(adapter);
    adapter.push(anEvent({ messageId: unsafeMessageId('late') }));
    adapter.end();
    expect((await pending).map((e) => e.messageId)).toEqual(['late']);
  });

  test('stop() closes the stream', async () => {
    const adapter = new MockInboundAdapter();
    const pending = drain(adapter);
    await adapter.stop();
    expect(await pending).toEqual([]);
  });
});

describe('MockSender', () => {
  test('records commands and returns an ok result with an id', async () => {
    const sender = new MockSender();
    const cmd = {
      surface: 'square' as const,
      roomId: unsafeRoomId('r'),
      text: 'hi',
    };
    const res = await sender.send(cmd, new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.sentMessageId).toBe(unsafeMessageId('sent-1'));
    expect(sender.sent).toEqual([cmd]);
  });

  test('failNextSend affects exactly one send', async () => {
    const sender = new MockSender();
    const cmd = {
      surface: 'talk' as const,
      roomId: unsafeRoomId('r'),
      text: 'hi',
    };
    const signal = new AbortController().signal;
    sender.failNextSend();
    expect((await sender.send(cmd, signal)).ok).toBe(false);
    expect((await sender.send(cmd, signal)).ok).toBe(true);
  });
});
