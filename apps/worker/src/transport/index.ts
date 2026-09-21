import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { LanePool, type LanePoolOptions } from './lane-pool.ts';
import type { LaneTransport } from './lane.ts';
import { createPooledH2TransportFactory } from './h2-transport.ts';

export { Lane, type LaneState, type LaneTransport } from './lane.ts';
export {
  createH2PushFetch,
  createPooledH2TransportFactory,
  laneAddressStride,
  readPinnedAddresses,
  type RouteAddress,
} from './h2-transport.ts';
export {
  LANE_ROLE_HEADER,
  LanePool,
  type LanePoolOptions,
  type LaneRole,
  type LaneStat,
} from './lane-pool.ts';

export interface OwnedLanePoolOptions extends Omit<LanePoolOptions, 'makeTransport'> {
  makeTransport?: (laneId: number) => LaneTransport;
}

/** A {@link LanePool} wired to real Deno HTTP clients. Pass its `.fetch` as
 * LINEJS's transport and call `.close()` on shutdown. */
export function createOwnedLanePool(
  options: { clock: Clock; logger: Logger } & Partial<OwnedLanePoolOptions>,
): LanePool {
  const laneCount = options.lanes ?? 6;
  const makeTransport = options.makeTransport ?? createPooledH2TransportFactory({
    // The encrypted JWT envelope goes to gf/enc. On this host, forcing that
    // envelope through Node's manual HTTP/2 implementation measured 26–32ms
    // on every lane; Deno's native pooled client was materially faster. Keep
    // one native H2 pool per lane for both the plain LEGY family and gf/enc.
    // This avoids Deno's process-fatal node:http2 GOAWAY compatibility bug.
    origin: 'https://legy.line-apps.com',
  });
  return new LanePool({
    ...options,
    lanes: laneCount,
    makeTransport,
  });
}
