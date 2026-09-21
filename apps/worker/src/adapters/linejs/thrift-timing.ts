import type { Client } from '@evex/linejs';
import type { Clock } from '../../lib/clock.ts';

/** One request's real `writeThrift` cost, reported as it happens. */
export interface ThriftEncodeSample {
  /** The LINE RPC this encode belonged to, e.g. `sendMessage`. */
  methodName: string;
  /** `undefined` if the request never reached `writeThrift` (it threw first). */
  encodeMs: number | undefined;
}

export interface ReqseqSample {
  name: string;
  durationMs: number;
}

/** Measures the serialized sequence-allocation await separately from network
 * time. Buffered storage removes disk I/O, but the promise queue, JSON update
 * and any contention still belong in this number rather than "transport". */
export function installReqseqTimer(
  client: Client,
  clock: Clock,
  onSample: (sample: ReqseqSample) => void,
): void {
  const base = client.base;
  const original = base.getReqseq.bind(base);
  base.getReqseq = (async (...args: Parameters<typeof original>) => {
    const started = clock.monotonic();
    try {
      return await original(...args);
    } finally {
      onSample({ name: String(args[0] ?? 'talk'), durationMs: clock.monotonic() - started });
    }
  }) as typeof base.getReqseq;
}

/**
 * Times `writeThrift` — the request-serialization step docs/experiments.md
 * attributes ~22ms of a (then) ~30ms send to, almost entirely in TypeScript
 * rather than on the network. That figure has only ever been a subtraction
 * (full send RTT minus lane RTT), never a direct measurement; this is what
 * makes it measurable.
 *
 * Anchored on `RequestClient.request`, NOT on the service method that calls
 * it. That distinction is the whole correctness argument:
 *
 *   - `SquareService.sendMessage` awaits `getReqseq()` — a real storage
 *     round trip — while building its arguments, BEFORE it ever calls
 *     `request()`. So `writeThrift` is NOT the first synchronous side effect
 *     of `sendMessage`, and anything that reads a captured timing straight
 *     after invoking `sendMessage` reads it too early, every single time.
 *     (That was the previous implementation; it silently reported
 *     `undefined` for every send ever made.)
 *   - `request()` on the other hand reaches `writeThrift` synchronously:
 *     `request` → `requestCore` → `writeThrift`, with no `await` in between.
 *
 * Race-free by construction, not by locking: the wrapper below is a plain
 * synchronous function. From the moment it is entered to the moment it hands
 * back `originalRequest`'s promise, it never awaits, so on a single-threaded
 * event loop nothing else — no concurrent send from another room, no
 * dedicated-poll fetch — can interleave and overwrite `box`. `capturing` is
 * saved and restored around the call rather than simply cleared, so a nested
 * `request()` (if one ever appears) unwinds correctly instead of blanking
 * its caller's slot.
 *
 * `writeThrift` calls that do NOT come through `request()` — the push
 * connection manager makes two — land while `capturing` is undefined and are
 * ignored rather than misattributed.
 */
export function installThriftEncodeTimer(
  client: Client,
  clock: Clock,
  onEncode: (sample: ThriftEncodeSample) => void,
): void {
  let capturing: { encodeMs: number | undefined } | undefined;

  const thrift = client.base.thrift;
  const originalWriteThrift = thrift.writeThrift.bind(thrift);
  thrift.writeThrift = ((...args: Parameters<typeof originalWriteThrift>) => {
    const start = clock.monotonic();
    try {
      return originalWriteThrift(...args);
    } finally {
      if (capturing !== undefined) capturing.encodeMs = clock.monotonic() - start;
    }
  }) as typeof thrift.writeThrift;

  const requestClient = client.base.request;
  const originalRequest = requestClient.request.bind(requestClient);
  requestClient.request = ((...args: Parameters<typeof originalRequest>) => {
    const box: { encodeMs: number | undefined } = { encodeMs: undefined };
    const outer = capturing;
    capturing = box;
    try {
      // Synchronous up to `requestCore`'s first await, which is where
      // `writeThrift` has already run and filled `box`.
      return originalRequest(...args);
    } finally {
      capturing = outer;
      onEncode({ methodName: String(args[1]), encodeMs: box.encodeMs });
    }
  }) as typeof requestClient.request;
}
