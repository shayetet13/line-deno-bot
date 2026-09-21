import { createWarmHttpClient, type WarmFetch } from '../warm/http-client.ts';
import type { PushHealth } from '../adapters/types.ts';
import type { LaneTransport } from './lane.ts';
import { fileURLToPath } from 'node:url';

export interface RouteAddress {
  address: string;
  family: 4 | 6;
}

/** Reads every address made available for the LINE origin in /etc/hosts.
 * The native Deno client resolves this list itself; this helper remains useful
 * for deployment validation and diagnostics. */
export function readPinnedAddresses(
  hostname: string,
  hostsText?: string,
): RouteAddress[] {
  let source = hostsText;
  if (source === undefined) {
    try {
      source = Deno.readTextFileSync('/etc/hosts');
    } catch {
      return [];
    }
  }
  const out: RouteAddress[] = [];
  const seen = new Set<string>();
  for (const raw of source.split(/\r?\n/u)) {
    const fields = raw.split('#', 1)[0]?.trim().split(/\s+/u) ?? [];
    const address = fields[0];
    if (address === undefined || !fields.slice(1).includes(hostname) || seen.has(address)) continue;
    const family = address.includes(':') ? 6 : 4;
    seen.add(address);
    out.push({ address, family });
  }
  return out;
}

/** Smallest stride that visits every address before repeating. Kept for the
 * deployment route checker, which probes the complete pinned address set. */
export function laneAddressStride(count: number): number {
  if (count <= 2) return 1;
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  for (let stride = 2; stride < count; stride += 1) {
    if (gcd(stride, count) === 1) return stride;
  }
  return 1;
}

export interface PooledH2FactoryOptions {
  /** Initial origin shown before the lane has made its first request. */
  origin: string;
  /** Injectable only for deterministic transport tests. */
  makeClient?: () => WarmFetch;
}

/** Streaming H2 transport for LINE's account-wide `/PUSH` session. It has a
 * separate sidecar from reply lanes: a permanent read stream must never share
 * a reply session or force the one-shot RPC path to buffer its body. */
export interface H2PushFetch extends WarmFetch {
  /** False until LINE has accepted the long-lived H2 response, and again as
   * soon as that stream ends or errors. */
  readonly pushHealth: PushHealth;
}

export function createH2PushFetch(options: { origin: string }): H2PushFetch {
  const sidecar = new NodeH2Sidecar();
  sidecar.retain();
  const laneId = -1;
  const push = ((info: Request | URL | string, init?: RequestInit) => {
    const request = info instanceof Request ? info : new Request(info, init);
    return sidecar.fetchPush(laneId, request);
  }) as H2PushFetch;
  Object.defineProperty(push, 'pushHealth', { get: () => sidecar.pushHealth });
  push.close = (): void => sidecar.release();
  // Keep the origin explicit at construction so callers cannot accidentally
  // couple this long-lived path to an arbitrary reply lane.
  void options.origin;
  return push;
}

/**
 * Creates one native Deno connection pool per lane.
 *
 * We previously built these lanes with `node:http2`. When LINE sent GOAWAY,
 * Deno's Node-compat nghttp2 binding could abort the whole process inside
 * `find_stream_on_goaway_func` before JavaScript received an error. That lost
 * every warm connection and made the next one-shot reply cold. Deno.HttpClient
 * uses Deno's native HTTP stack, still negotiates/reuses H2, and isolates one
 * pool per lane without that process-fatal compatibility layer.
 *
 * Also measured against the Node H2 sidecar used for `/PUSH` below: routing
 * the encrypted gf/enc envelope through it added 26-32ms per lane versus
 * Deno's native client on this host — a regression that briefly lived here
 * as the unnamed default (nothing constructed this factory without
 * `makeClient`) before being caught. `makeClient` stays injectable for tests
 * only; production must never pass anything else.
 */
export function createPooledH2TransportFactory(
  options: PooledH2FactoryOptions,
): (_laneId: number) => LaneTransport {
  const initialOrigin = new URL(options.origin).origin;
  const makeClient = options.makeClient ?? (() => createWarmHttpClient());
  return () => new PooledH2Transport(initialOrigin, makeClient());
}

interface SidecarPushHeaders {
  type: 'push-headers';
  id: number;
  status: number;
  headers: [string, string][];
  remoteAddress?: string;
  remoteOrigin?: string;
}

interface SidecarPushChunk {
  type: 'push-data';
  id: number;
  body: string;
}

interface SidecarPushEnd {
  type: 'push-end';
  id: number;
}

interface SidecarPushError {
  type: 'push-error';
  id: number;
  error: string;
}

class NodeH2Sidecar {
  readonly #encoder = new TextEncoder();
  readonly #pushes = new Map<number, {
    resolve: (response: SidecarPushHeaders) => void;
    reject: (error: Error) => void;
    controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  }>();
  #process: Deno.ChildProcess | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #starting: Promise<void> | undefined;
  #nextId = 1;
  #users = 0;
  #pushHealth: PushHealth = { ready: false, reason: 'PUSH has not opened yet' };

  get pushHealth(): PushHealth {
    return { ...this.#pushHealth };
  }

  retain(): void {
    this.#users += 1;
  }

  release(): void {
    this.#users = Math.max(0, this.#users - 1);
    if (this.#users > 0) return;
    this.#writer?.close().catch(() => {});
    this.#process?.kill('SIGTERM');
    this.#failAll(new Error('HTTP/2 sidecar closed'));
    this.#process = undefined;
    this.#writer = undefined;
    this.#starting = undefined;
  }

  async fetchPush(laneId: number, request: Request): Promise<Response> {
    await this.#ensureStarted();
    this.#pushHealth = { ready: false, reason: 'waiting for LINE PUSH response' };
    const id = this.#nextId++;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const responseBody = new ReadableStream<Uint8Array>({
      start(next): void {
        controller = next;
      },
      cancel: (): void => {
        void this.#write({ type: 'cancel', id });
        this.#pushes.delete(id);
        this.#pushHealth = { ready: false, reason: 'LINE PUSH response was cancelled' };
      },
    });
    const headers = new Promise<SidecarPushHeaders>((resolve, reject) => {
      this.#pushes.set(id, { resolve, reject, controller });
    });
    const onAbort = (): void => {
      void this.#write({ type: 'cancel', id });
      this.#finishPushError(
        id,
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error('push request aborted'),
      );
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.#write({
        type: 'push-start',
        id,
        laneId,
        url: request.url,
        method: request.method,
        headers: [...request.headers],
      });
      void this.#pumpPushBody(id, request.body);
      const response = await headers;
      return new Response(responseBody, { status: response.status, headers: response.headers });
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  async #pumpPushBody(id: number, body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body === null) {
      await this.#write({ type: 'push-end', id });
      return;
    }
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await this.#write({ type: 'push-data', id, body: encodeBase64(value) });
      }
      await this.#write({ type: 'push-end', id });
    } catch (error: unknown) {
      await this.#write({ type: 'cancel', id }).catch(() => {});
      this.#finishPushError(id, error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#writer !== undefined) return;
    if (this.#starting !== undefined) return await this.#starting;
    this.#starting = Promise.resolve().then(() => {
      const command = new Deno.Command('node', {
        args: [fileURLToPath(new URL('./node-h2-sidecar.mjs', import.meta.url))],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'inherit',
      });
      const child = command.spawn();
      this.#process = child;
      this.#writer = child.stdin.getWriter();
      void this.#read(child.stdout);
      void child.status.then((status) => {
        if (this.#process !== child) return;
        this.#process = undefined;
        this.#writer = undefined;
        this.#starting = undefined;
        this.#failAll(new Error(`HTTP/2 sidecar exited (${status.code})`));
      });
    });
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #write(message: unknown): Promise<void> {
    const writer = this.#writer;
    if (writer === undefined) throw new Error('HTTP/2 sidecar is not running');
    await writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async #read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.length === 0) continue;
          const response = JSON.parse(line) as
            | SidecarPushHeaders
            | SidecarPushChunk
            | SidecarPushEnd
            | SidecarPushError;
          if (response.type === 'push-headers') {
            const pendingPush = this.#pushes.get(response.id);
            if (pendingPush === undefined) continue;
            if (response.status < 200 || response.status >= 300) {
              this.#finishPushError(
                response.id,
                new Error(`LINE PUSH returned HTTP ${String(response.status)}`),
              );
              continue;
            }
            this.#pushHealth = { ready: true };
            pendingPush.resolve(response);
            continue;
          }
          if (response.type === 'push-data') {
            this.#pushes.get(response.id)?.controller?.enqueue(decodeBase64(response.body));
            continue;
          }
          if (response.type === 'push-end') {
            const pendingPush = this.#pushes.get(response.id);
            pendingPush?.controller?.close();
            this.#pushes.delete(response.id);
            if (pendingPush !== undefined) {
              this.#pushHealth = { ready: false, reason: 'LINE PUSH stream ended' };
            }
            continue;
          }
          this.#finishPushError(response.id, new Error(response.error));
        }
      }
    } catch (error: unknown) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }

  #failAll(error: Error): void {
    for (const id of this.#pushes.keys()) this.#finishPushError(id, error);
  }

  #finishPushError(id: number, error: Error): void {
    const pending = this.#pushes.get(id);
    this.#pushHealth = { ready: false, reason: error.message };
    if (pending === undefined) return;
    this.#pushes.delete(id);
    pending.controller?.error(error);
    pending.reject(error);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

class PooledH2Transport implements LaneTransport {
  readonly #client: WarmFetch;
  #remoteOrigin: string;
  #closed = false;

  constructor(initialOrigin: string, client: WarmFetch) {
    this.#remoteOrigin = initialOrigin;
    this.#client = client;
  }

  get remoteOrigin(): string {
    return this.#remoteOrigin;
  }

  async fetch(info: Request | URL | string, init?: RequestInit): Promise<Response> {
    if (this.#closed) throw new Error('HTTP/2 lane is closed');
    const request = info instanceof Request ? info : new Request(info, init);
    // Report the route of this request, not a construction-time guess. This is
    // especially important because Square SEND uses gf/enc while polling uses
    // LEGY and both pass through the same lane abstraction.
    this.#remoteOrigin = new URL(request.url).origin;
    return await this.#client(request);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.close();
  }
}
