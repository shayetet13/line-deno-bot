import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { installLaneRoleHints } from '../../../src/adapters/linejs/lane-role.ts';
import { LANE_FORCE_HEADER, LANE_ROLE_HEADER } from '../../../src/transport/lane-pool.ts';

describe('installLaneRoleHints', () => {
  test('separates sends and receive fetches without tagging unrelated RPCs', async () => {
    const seen: Array<{ method: string; headers: Record<string, string | undefined> }> = [];
    const request = (...args: unknown[]): Promise<string> => {
      seen.push({
        method: String(args[1]),
        headers: (args[5] ?? {}) as Record<string, string | undefined>,
      });
      return Promise.resolve('ok');
    };
    const client = { base: { request: { request } } } as never;
    installLaneRoleHints(client);

    await (client as { base: { request: { request: typeof request } } }).base.request.request(
      [],
      'sendMessage',
    );
    await (client as { base: { request: { request: typeof request } } }).base.request.request(
      [],
      'fetchSquareChatEvents',
    );
    await (client as { base: { request: { request: typeof request } } }).base.request.request(
      [],
      'getSquare',
    );

    expect(seen[0]?.headers[LANE_ROLE_HEADER]).toBe('send');
    expect(seen[1]?.headers[LANE_ROLE_HEADER]).toBe('poll');
    expect(seen[2]?.headers[LANE_ROLE_HEADER]).toBeUndefined();
  });

  test('preflights each requested lane with a read-only Square RPC, not sendMessage', async () => {
    const seen: Array<{ method: string; headers: Record<string, string | undefined> }> = [];
    const request = (...args: unknown[]): Promise<void> => {
      seen.push({
        method: String(args[1]),
        headers: (args[5] ?? {}) as Record<string, string | undefined>,
      });
      return Promise.resolve();
    };
    const fake = {
      base: {
        request: { request },
        square: undefined as unknown as {
          getSquareChatStatus: (args: unknown) => Promise<void>;
        },
      },
    };
    fake.base.square = {
      getSquareChatStatus: () => fake.base.request.request([], 'getSquareChatStatus'),
    };
    const client = fake as never;
    const hints = installLaneRoleHints(client);

    await hints.preflightSendLanes(2, 'm-room');

    expect(seen).toEqual([
      {
        method: 'getSquareChatStatus',
        headers: { [LANE_ROLE_HEADER]: 'send', [LANE_FORCE_HEADER]: '0' },
      },
      {
        method: 'getSquareChatStatus',
        headers: { [LANE_ROLE_HEADER]: 'send', [LANE_FORCE_HEADER]: '1' },
      },
    ]);
  });

  test('a probe forces only its own RPC, even while it is still in flight', async () => {
    const seen: Array<{ method: string; headers: Record<string, string | undefined> }> = [];
    const gate = Promise.withResolvers<void>();
    const request = (...args: unknown[]): Promise<void> => {
      seen.push({
        method: String(args[1]),
        headers: (args[5] ?? {}) as Record<string, string | undefined>,
      });
      return String(args[1]) === 'getSquareChatStatus' ? gate.promise : Promise.resolve();
    };
    const fake = {
      base: {
        request: { request },
        square: undefined as unknown as {
          getSquareChatStatus: (args: unknown) => Promise<void>;
        },
      },
    };
    fake.base.square = {
      getSquareChatStatus: () => fake.base.request.request([], 'getSquareChatStatus'),
    };
    const hints = installLaneRoleHints(fake as never);

    const probe = hints.probeSendLane(2, 'm-room');
    // An unrelated RPC issued while the probe is outstanding is not forced.
    const unrelated = fake.base.request.request([], 'getSquareChatStatus');
    gate.resolve();
    await Promise.all([probe, unrelated]);

    expect(seen[0]?.headers[LANE_FORCE_HEADER]).toBe('2');
    expect(seen[1]?.headers[LANE_FORCE_HEADER]).toBeUndefined();
  });
});
