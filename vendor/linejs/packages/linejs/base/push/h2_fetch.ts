import { createNodeFetch } from "../core/node_fetch.ts";

/** Legacy helper. BaseClient uses per-client pools for RPC and PUSH. */
const getFetch = createNodeFetch(true);

/** Returns null on Deno/Bun/browser; Node uses an HTTP/2-capable dispatcher. */
export function getH2EnabledFetchForNode(timeout = 30_000) {
	return getFetch(timeout);
}
