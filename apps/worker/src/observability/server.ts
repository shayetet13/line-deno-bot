import type { Logger } from '../logging/logger.ts';
import type { AlertEvaluator } from '../monitoring/alerts.ts';
import type { ReleaseManifest } from '../release/manifest.ts';
import { releaseLabel } from '../release/manifest.ts';
import { DASHBOARD_HTML } from './dashboard.ts';
import type { StatusSource } from './snapshot.ts';

export interface StatusServerOptions {
  source: StatusSource;
  logger: Logger;
  /** When present, `/api/alerts` reports what is currently firing. */
  alerts?: AlertEvaluator | undefined;
  /** When present, every response names the running release. */
  release?: ReleaseManifest | undefined;
  port?: number;
  /** Bind to loopback by default: this exposes lane health and room counters,
   * and a shard port must never face the public internet (Playbook §14.3). */
  hostname?: string;
  /**
   * Lets a caller compose extra routes in front of this read-only handler
   * (the admin surface's rules/login pages), without this module knowing
   * anything about mutation. Receives the plain status handler, returns the
   * handler actually served. Omit to serve status-only, as `cli/probe.ts` and
   * `cli/bench.ts` do.
   */
  wrapHandler?: (
    status: (req: Request) => Response,
  ) => (req: Request) => Response | Promise<Response>;
}

export const DEFAULT_PORT = 8791;
export const DEFAULT_HOSTNAME = '127.0.0.1';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/**
 * Read-only observability endpoint, served beside the worker.
 *
 * It only ever reads an already-assembled snapshot, so a dashboard left open
 * cannot add work to the reply path (Playbook §13.3: "dashboard query ห้ามถูก
 * เรียกจาก lane selector").
 */
export interface StatusHandlerOptions {
  alerts?: AlertEvaluator | undefined;
  release?: ReleaseManifest | undefined;
}

export function createStatusHandler(
  source: StatusSource,
  options: StatusHandlerOptions = {},
): (req: Request) => Response {
  const release = options.release;
  return (req: Request): Response => {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405);
    }
    if (pathname === '/api/health') {
      const snap = source.snapshot();
      const ready = snap.readiness?.state === 'armed';
      return json({
        ok: true,
        ready,
        workerId: snap.workerId,
        ...(release === undefined ? {} : { release: releaseLabel(release) }),
      }, ready ? 200 : 503);
    }
    if (pathname === '/api/status') {
      const snap = source.snapshot();
      return json(release === undefined ? snap : { ...snap, release });
    }
    if (pathname === '/api/alerts') {
      const evaluator = options.alerts;
      if (evaluator === undefined) return json({ enabled: false, firing: [], pending: [] });
      // Evaluating here, on request, keeps alerting off the reply path exactly
      // as the metrics snapshot is (Playbook §13.3).
      return json({
        enabled: true,
        firing: evaluator.evaluate(source.snapshot()),
        pending: evaluator.pending,
        baseline: evaluator.baseline,
      });
    }
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(DASHBOARD_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin',
        },
      });
    }
    return json({ error: 'not found' }, 404);
  };
}

export interface RunningStatusServer {
  port: number;
  hostname: string;
  shutdown(): Promise<void>;
}

/** Starts the console. Loopback-only unless a hostname is passed explicitly. */
export function startStatusServer(options: StatusServerOptions): RunningStatusServer {
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const statusHandler = createStatusHandler(options.source, {
    alerts: options.alerts,
    release: options.release,
  });
  const handler = options.wrapHandler === undefined
    ? statusHandler
    : options.wrapHandler(statusHandler);
  const server = Deno.serve({
    port,
    hostname,
    onListen: () => options.logger.info('status server listening', { hostname, port }),
  }, handler);

  return {
    port,
    hostname,
    shutdown: async (): Promise<void> => {
      await server.shutdown();
    },
  };
}
