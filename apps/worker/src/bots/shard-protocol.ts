import type { LogLevel } from '../config/constants.ts';
import type { ReleaseManifest } from '../release/manifest.ts';

/**
 * Messages between the console thread and a bot shard (a Worker thread that
 * runs some bots' LINE connections).
 *
 * The shard owns everything about its bots — LINE session, lanes, polls,
 * rules, QR login — and serves their console routes itself; the console
 * thread authenticates people, owns the account registry, and forwards each
 * signed-in request to the one shard that runs that person's bot. Nothing but
 * these plain, structured-cloneable messages crosses the boundary.
 */

export interface ShardInit {
  shardId: string;
  sessionsDir: string;
  forceDryRun: boolean;
  showText: boolean;
  release: ReleaseManifest | undefined;
  /** Concurrent connection establishments allowed inside this shard. */
  warmupConcurrency: number;
  logLevel: LogLevel;
}

export interface WireRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export interface WireResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

export type ShardCommand =
  | { op: 'init'; init: ShardInit }
  | { op: 'start'; botId: string; configPath: string }
  | { op: 'restart'; botId: string }
  | { op: 'close'; botId: string }
  | { op: 'http'; botId: string; request: WireRequest };

export type ShardCall = ShardCommand & { id: number };

export type ShardReply =
  | { id: number; ok: true; value?: WireResponse | undefined }
  | { id: number; ok: false; error: string };

/** Serialises a request for the other thread. Bodies are small (JSON rule
 * edits, room selections), so reading one whole is fine. */
export async function toWireRequest(req: Request): Promise<WireRequest> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return {
    method: req.method,
    url: req.url,
    headers: [...req.headers],
    body: hasBody ? await req.arrayBuffer() : null,
  };
}

export function fromWireRequest(wire: WireRequest): Request {
  return new Request(wire.url, {
    method: wire.method,
    headers: wire.headers,
    ...(wire.body === null ? {} : { body: wire.body }),
  });
}

export async function toWireResponse(res: Response): Promise<WireResponse> {
  return {
    status: res.status,
    headers: [...res.headers],
    body: await res.arrayBuffer(),
  };
}

/** Rebuilds the shard's response. Status codes without a body (redirects
 * carry `location` in headers) must not be given one. */
export function fromWireResponse(wire: WireResponse): Response {
  const nullBody = wire.status === 204 || wire.status === 304 ||
    (wire.status >= 300 && wire.status < 400 && wire.body.byteLength === 0);
  return new Response(nullBody ? null : wire.body, {
    status: wire.status,
    headers: wire.headers,
  });
}
