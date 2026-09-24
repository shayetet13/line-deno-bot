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
  /** One read-only probe forced onto exactly `laneId`. Rejects when the RPC
   * fails; the owned pool has already recorded the lane's RTT by then. */
  probeSendLane(laneId: number, squareChatMid: string): Promise<void>;
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

  // `getSquareChatStatus` reaches `request()` synchronously, so the forced
  // lane is attached before this returns and the marker can be cleared at
  // once — a later unrelated call can never inherit it, and probes from the
  // background scout may overlap an in-flight one safely.
  const probeSendLane = async (laneId: number, squareChatMid: string): Promise<void> => {
    preflightLaneId = laneId;
    let pending: Promise<unknown>;
    try {
      pending = client.base.square.getSquareChatStatus({ request: { squareChatMid } });
    } finally {
      preflightLaneId = undefined;
    }
    await pending;
  };

  return {
    probeSendLane,
    async preflightSendLanes(
      lanes: number,
      squareChatMid: string,
    ): Promise<SendPreflightResult[]> {
      const results: SendPreflightResult[] = [];
      for (let laneId = 0; laneId < lanes; laneId += 1) {
        try {
          await probeSendLane(laneId, squareChatMid);
          results.push({ laneId, ok: true });
        } catch (error: unknown) {
          results.push({
            laneId,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },
  };
}
