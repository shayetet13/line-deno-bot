import type { Client } from '@evex/linejs';
import { LANE_FORCE_HEADER, LANE_ROLE_HEADER, type LaneRole } from '../../transport/lane-pool.ts';

const roleFor = (methodName: string): LaneRole | undefined => {
  if (methodName === 'sendMessage') return 'send';
  if (methodName === 'fetchSquareChatEvents' || methodName === 'fetchMyEvents') return 'poll';
  return undefined;
};

export interface SendPreflightResult {
  laneId: number;
  ok: boolean;
  reason?: string;
}

export interface LaneRoleHints {
  /**
   * Measures every reserved reply lane with a harmless read-only Square RPC
   * for the actual room. Unlike Talk noop, it traverses the same Square
   * service and encrypted gateway family as sendMessage without creating a
   * chat message. It is startup work only, before inbound handling starts.
   */
  preflightSendLanes(lanes: number, squareChatMid: string): Promise<SendPreflightResult[]>;
}

/**
 * Tags only latency-sensitive Square RPCs so the owned pool can keep continuous
 * receive traffic away from reply lanes. LanePool strips this private header
 * before the request reaches LINE. Other RPCs retain the pool's general policy.
 */
export function installLaneRoleHints(client: Client): LaneRoleHints {
  const requestClient = client.base.request;
  const originalRequest = requestClient.request.bind(requestClient);
  let preflightLaneId: number | undefined;
  requestClient.request = ((...args: Parameters<typeof originalRequest>) => {
    const methodName = String(args[1]);
    const isPreflight = methodName === 'getSquareChatStatus' && preflightLaneId !== undefined;
    const role = isPreflight ? 'send' : roleFor(methodName);
    if (role !== undefined) {
      args[5] = {
        ...(args[5] ?? {}),
        [LANE_ROLE_HEADER]: role,
        ...(isPreflight ? { [LANE_FORCE_HEADER]: String(preflightLaneId) } : {}),
      };
    }
    return originalRequest(...args);
  }) as typeof requestClient.request;

  return {
    async preflightSendLanes(
      lanes: number,
      squareChatMid: string,
    ): Promise<SendPreflightResult[]> {
      const results: SendPreflightResult[] = [];
      for (let laneId = 0; laneId < lanes; laneId += 1) {
        if (preflightLaneId !== undefined) {
          throw new Error('send preflight is already in progress');
        }
        preflightLaneId = laneId;
        try {
          await client.base.square.getSquareChatStatus({ request: { squareChatMid } });
          results.push({ laneId, ok: true });
        } catch (error: unknown) {
          results.push({
            laneId,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          preflightLaneId = undefined;
        }
      }
      return results;
    },
  };
}
