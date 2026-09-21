/**
 * A fetch backed by a connection pool that never drops idle connections, so a
 * warmed TCP + TLS handshake survives a quiet stretch between jobs
 * (Playbook §7.13 "keep TLS session ticket", §8.1 "reuse connection").
 *
 * On Deno, `fetch` already pools per origin; this only pins the pool open and
 * lets the warmer and the sender share it. LINEJS calls a custom fetch as
 * `fetchFn(request)` with no `init`, so the client goes in the second argument
 * we add here.
 */

export interface WarmFetch {
  (info: Request | URL | string, init?: RequestInit): Promise<Response>;
  /** Releases the underlying pool. After this the fetch still works but is cold. */
  close(): void;
}

export interface WarmHttpClientOptions {
  /** Milliseconds an idle pooled connection is kept. Default: keep forever. */
  poolIdleTimeoutMs?: number | false;
  poolMaxIdlePerHost?: number;
}

interface DenoHttpClientFactory {
  createHttpClient(options: {
    poolIdleTimeout?: number | false;
    poolMaxIdlePerHost?: number;
  }): Disposable & Record<never, never>;
}

const hasDenoHttpClient = (
  value: typeof Deno,
): value is typeof Deno & DenoHttpClientFactory => 'createHttpClient' in value;

/** Builds a {@link WarmFetch}. Falls back to plain `fetch` where
 * `Deno.createHttpClient` is unavailable (older runtimes, restricted perms). */
export function createWarmHttpClient(options: WarmHttpClientOptions = {}): WarmFetch {
  if (!hasDenoHttpClient(Deno)) {
    const plain: WarmFetch = (info, init) => fetch(info, init);
    plain.close = (): void => {};
    return plain;
  }

  const client = Deno.createHttpClient({
    poolIdleTimeout: options.poolIdleTimeoutMs ?? false,
    ...(options.poolMaxIdlePerHost === undefined
      ? {}
      : { poolMaxIdlePerHost: options.poolMaxIdlePerHost }),
  });

  const warmFetch: WarmFetch = (info, init) => fetch(info, { ...init, client } as RequestInit);
  warmFetch.close = (): void => {
    (client as Disposable)[Symbol.dispose]();
  };
  return warmFetch;
}
