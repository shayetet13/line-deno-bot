import { expect } from '@std/expect';
import { describe, it as test } from '@std/testing/bdd';
import {
  createPooledH2TransportFactory,
  laneAddressStride,
  readPinnedAddresses,
} from '../../src/transport/h2-transport.ts';
import type { WarmFetch } from '../../src/warm/http-client.ts';

describe('pinned HTTP/2 route selection', () => {
  test('reads every address pinned to the origin and ignores comments/duplicates', () => {
    const addresses = readPinnedAddresses(
      'legy.line-apps.com',
      `
        147.92.185.1 legy.line-apps.com
        2400:dcc0:a3a1:1000::1 legy.line-apps.com gf.line.naver.jp
        147.92.185.1 legy.line-apps.com # duplicate
        127.0.0.1 localhost
      `,
    );
    expect(addresses).toEqual([
      { address: '147.92.185.1', family: 4 },
      { address: '2400:dcc0:a3a1:1000::1', family: 6 },
    ]);
  });

  test('reads the same pinned gateway addresses for the encrypted Square origin', () => {
    const addresses = readPinnedAddresses(
      'gf.line.naver.jp',
      `
        147.92.185.1 legy.line-apps.com gf.line.naver.jp
        2400:dcc0:a3a1:1000::1 gf.line.naver.jp
      `,
    );
    expect(addresses).toEqual([
      { address: '147.92.185.1', family: 4 },
      { address: '2400:dcc0:a3a1:1000::1', family: 6 },
    ]);
  });

  test('the lane stride visits every pinned address before repeating', () => {
    const count = 8;
    const stride = laneAddressStride(count);
    const selected = Array.from({ length: count }, (_, lane) => (lane * stride) % count);
    expect(new Set(selected).size).toBe(count);
  });

  test('native pools are isolated per lane and report the latest real origin', async () => {
    const calls: string[][] = [];
    let closes = 0;
    const makeClient = (): WarmFetch => {
      const ownCalls: string[] = [];
      calls.push(ownCalls);
      const client: WarmFetch = (info, init) => {
        const request = info instanceof Request ? info : new Request(info, init);
        ownCalls.push(request.url);
        return Promise.resolve(new Response(null, { status: 204 }));
      };
      client.close = () => closes += 1;
      return client;
    };
    const factory = createPooledH2TransportFactory({
      origin: 'https://legy.line-apps.com',
      makeClient,
    });
    const first = factory(0);
    const second = factory(1);

    await first.fetch('https://gf.line.naver.jp/enc', { method: 'HEAD' });
    await second.fetch('https://legy.line-apps.com/P4', { method: 'POST' });

    expect(calls).toEqual([
      ['https://gf.line.naver.jp/enc'],
      ['https://legy.line-apps.com/P4'],
    ]);
    expect(first.remoteOrigin).toBe('https://gf.line.naver.jp');
    expect(second.remoteOrigin).toBe('https://legy.line-apps.com');
    first.close();
    first.close();
    second.close();
    expect(closes).toBe(2);
  });
});
