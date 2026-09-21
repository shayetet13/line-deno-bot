import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Client } from '@evex/linejs';
import {
  installReqseqTimer,
  installThriftEncodeTimer,
  type ThriftEncodeSample,
} from '../../../src/adapters/linejs/thrift-timing.ts';
import { FakeClock } from '../../../src/lib/clock.ts';

/**
 * A stand-in for the parts of LINEJS this timer touches, shaped like the
 * real call chain rather than a convenient one — that shape is the whole
 * point. The previous implementation passed a test that called `writeThrift`
 * directly and still measured nothing in production, because the real
 * `sendMessage` awaits `getReqseq()` before it ever reaches the encoder.
 */
interface Harness {
  client: Client;
  /** The real chain: sendMessage → await getReqseq() → request() → writeThrift. */
  sendMessage(text: string): Promise<string>;
  /** What the dedicated poll does — same `request()`, different RPC. */
  fetchMyEvents(): Promise<string>;
  samples: ThriftEncodeSample[];
  clock: FakeClock;
  /** Resolves the pending getReqseq for the given text, in any order. */
  releaseReqseq(text: string): void;
}

const harness = (encodeCostMs: (methodName: string) => number): Harness => {
  const clock = new FakeClock();
  const samples: ThriftEncodeSample[] = [];
  const pending = new Map<string, () => void>();

  const writeThrift = (_value: unknown, methodName: string): string => {
    clock.advance(encodeCostMs(methodName));
    return `encoded:${methodName}`;
  };

  // Mirrors RequestClient.request → requestCore: writeThrift runs
  // synchronously, before this function's own first await.
  const request = (_value: unknown, methodName: string): Promise<string> => {
    const encoded = (client.base.thrift.writeThrift as unknown as typeof writeThrift)(
      undefined,
      methodName,
    );
    return Promise.resolve(encoded);
  };

  const client = {
    base: { thrift: { writeThrift }, request: { request } },
  } as unknown as Client;

  installThriftEncodeTimer(client, clock, (s) => samples.push(s));

  const callRequest = (methodName: string): Promise<string> =>
    (client.base.request.request as unknown as typeof request)(undefined, methodName);

  return {
    client,
    samples,
    clock,
    sendMessage: async (text: string): Promise<string> => {
      // The getReqseq await that broke the old design: a real storage round
      // trip, resolved here on the test's schedule so two sends can be
      // interleaved deliberately.
      await new Promise<void>((resolve) => pending.set(text, resolve));
      return await callRequest('sendMessage');
    },
    fetchMyEvents: (): Promise<string> => callRequest('fetchMyEvents'),
    releaseReqseq: (text: string): void => {
      pending.get(text)?.();
      pending.delete(text);
    },
  };
};

describe('installThriftEncodeTimer', () => {
  test('reports the real writeThrift cost of a send, across the getReqseq await', async () => {
    const h = harness(() => 7);
    const sending = h.sendMessage('a');
    // Nothing encoded yet: sendMessage is still parked on getReqseq. This is
    // exactly the moment the old implementation read its timing and got
    // undefined, every time.
    expect(h.samples).toHaveLength(0);

    h.releaseReqseq('a');
    await sending;

    expect(h.samples).toEqual([{ methodName: 'sendMessage', encodeMs: 7 }]);
  });

  test('two sends racing across their getReqseq awaits each get their own timing', async () => {
    // Room A encodes slowly, room B quickly. If the timer attributed one to
    // the other, these numbers would swap or duplicate.
    const cost = new Map([['a', 11], ['b', 3]]);
    let current = 0;
    const h = harness(() => current);

    const a = h.sendMessage('a');
    const b = h.sendMessage('b');

    // B's storage write lands first — the interleaving the old design could
    // not survive.
    current = cost.get('b')!;
    h.releaseReqseq('b');
    await b;

    current = cost.get('a')!;
    h.releaseReqseq('a');
    await a;

    expect(h.samples).toEqual([
      { methodName: 'sendMessage', encodeMs: 3 },
      { methodName: 'sendMessage', encodeMs: 11 },
    ]);
  });

  test('the dedicated poll encoding in parallel is reported separately, not folded in', async () => {
    const h = harness((methodName) => (methodName === 'sendMessage' ? 9 : 2));
    const sending = h.sendMessage('a');
    // A poll round completes entirely while the send is parked on getReqseq.
    await h.fetchMyEvents();
    h.releaseReqseq('a');
    await sending;

    expect(h.samples).toEqual([
      { methodName: 'fetchMyEvents', encodeMs: 2 },
      { methodName: 'sendMessage', encodeMs: 9 },
    ]);
  });

  test('a writeThrift call outside request() is ignored, not misattributed', () => {
    const h = harness(() => 5);
    // What push/connManager.ts does: encodes directly, never through
    // request(). Crediting that to a send would be a wrong number.
    (h.client.base.thrift.writeThrift as unknown as (v: unknown, m: string) => string)(
      undefined,
      'fetchOps',
    );
    expect(h.samples).toHaveLength(0);
  });

  test('leaves request() behaviour intact — same arguments, same result', async () => {
    const h = harness(() => 1);
    await expect(h.fetchMyEvents()).resolves.toBe('encoded:fetchMyEvents');
  });

  test('a throwing request still propagates, and reports no encode for it', () => {
    const clock = new FakeClock();
    const samples: ThriftEncodeSample[] = [];
    const client = {
      base: {
        thrift: { writeThrift: () => 'unused' },
        request: {
          request: () => {
            throw new Error('client disabled');
          },
        },
      },
    } as unknown as Client;
    installThriftEncodeTimer(client, clock, (s) => samples.push(s));

    expect(() =>
      (client.base.request.request as unknown as (v: unknown, m: string) => unknown)(
        undefined,
        'sendMessage',
      )
    ).toThrow('client disabled');
    expect(samples).toEqual([{ methodName: 'sendMessage', encodeMs: undefined }]);
  });
});

describe('installReqseqTimer', () => {
  test('measures the complete allocation await and preserves its result', async () => {
    const clock = new FakeClock();
    const samples: Array<{ name: string; durationMs: number }> = [];
    const client = {
      base: {
        getReqseq: (name = 'talk'): Promise<number> => {
          expect(name).toBe('sq');
          clock.advance(1.25);
          return Promise.resolve(42);
        },
      },
    } as unknown as Client;
    installReqseqTimer(client, clock, (sample) => samples.push(sample));

    await expect(client.base.getReqseq('sq')).resolves.toBe(42);
    expect(samples).toEqual([{ name: 'sq', durationMs: 1.25 }]);
  });
});
