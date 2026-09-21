import * as fs from 'node:fs';
import { BaseStorage, type Storage } from '@evex/linejs/storage';

const DEFAULT_FLUSH_DEBOUNCE_MS = 250;

/**
 * A `BaseStorage` that answers `get`/`set` from an in-memory cache and writes
 * to disk on a debounced timer, instead of LINEJS's own `FileStorage` (which
 * does a full read-parse-stringify-write of the whole file on every `set`,
 * synchronously in the caller's await chain).
 *
 * The reason this exists: `getReqseq()` (base/core/mod.ts) calls
 * `storage.set("reqseq", ...)` on every single send AND every dedicated-poll
 * round — with `FileStorage` that put real disk I/O inside `send`'s own span
 * on the reply path, and once `pollIntervalMs: 0` raised poll rounds from
 * ~8/s to ~50/s, every one of those was queued behind the file's single
 * write lock, adding real latency to actual sends (see 2026-09-11 latency
 * investigation).
 *
 * `set`/`delete`/`clear` return synchronously (an already-resolved promise)
 * — the whole point — so the vendor's `await storage.set(...)` no longer
 * waits on disk at all. Correctness is entirely the cache: it is loaded once
 * at construction and never re-read from disk afterward, and every write
 * updates it before scheduling anything, so `get()` always answers the
 * latest value even if nothing has hit disk yet.
 *
 * Debounced, not immediate-async, because a run of poll rounds a few
 * milliseconds apart would otherwise queue a fresh disk write per round —
 * exactly the cost this exists to remove, just moved off the await chain
 * instead of actually reduced. Coalescing into one write per debounce
 * window is the fix; `flushNow()` exists so a graceful shutdown does not
 * have to wait out that window to persist the last few changes.
 *
 * What this trades away: an actual crash (not a graceful `SIGTERM`/`SIGINT`,
 * which flushes) between a `set` and its debounced flush loses that write —
 * for `reqseq` specifically, LINE seeing a reused sequence number on the
 * next process start. `FileStorage` did not have this window. Restarts in
 * this project's own deploy path (`release.sh`, `systemctl restart`) are
 * always graceful, so this only bites on an unclean kill.
 */
export class BufferedFileStorage extends BaseStorage {
  #cache: Record<Storage['Key'], Storage['Value']>;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writeSettled: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly flushDebounceMs: number = DEFAULT_FLUSH_DEBOUNCE_MS,
  ) {
    super();
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch {
      // No file yet — genuinely empty, not corrupt. Only this case gets a
      // silent `{}`; a file that exists but fails to parse below throws,
      // rather than quietly discarding whatever session state was in it.
      raw = '{}';
      fs.writeFileSync(this.path, raw, 'utf-8');
    }
    this.#cache = (raw.trim() === '' ? {} : JSON.parse(raw)) as Record<
      Storage['Key'],
      Storage['Value']
    >;
  }

  set(key: Storage['Key'], value: Storage['Value']): Promise<void> {
    this.#cache[key] = value;
    this.#scheduleFlush();
    return Promise.resolve();
  }

  get(key: Storage['Key']): Promise<Storage['Value'] | undefined> {
    return Promise.resolve(this.#cache[key]);
  }

  delete(key: Storage['Key']): Promise<void> {
    delete this.#cache[key];
    this.#scheduleFlush();
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#cache = {};
    this.#scheduleFlush();
    return Promise.resolve();
  }

  getAll(): Promise<Record<Storage['Key'], Storage['Value']>> {
    return Promise.resolve({ ...this.#cache });
  }

  async migrate(storage: BaseStorage): Promise<void> {
    for (const [key, value] of Object.entries(this.#cache)) {
      await storage.set(key, value);
    }
  }

  /** Cancels the pending debounce and writes now. Awaiting this guarantees
   * every change made so far is on disk — call it while shutting down
   * gracefully, before the process that would otherwise flush on its own
   * timer stops existing. */
  flushNow(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#writeNow();
    }
    return this.#writeSettled;
  }

  #scheduleFlush(): void {
    this.#dirty = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#writeNow();
    }, this.flushDebounceMs);
  }

  /** Starts (or, if one is already in flight, chains behind) the actual
   * write. Chaining rather than firing a second concurrent `fs.writeFile` at
   * the same path is what keeps overlapping flushes from ever interleaving
   * two partial writes into one corrupt file. */
  #writeNow(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const snapshot = JSON.stringify(this.#cache);
    this.#writeSettled = this.#writeSettled
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            fs.writeFile(this.path, snapshot, 'utf-8', (err) => (err ? reject(err) : resolve()));
          }),
      )
      .then(() => {
        // More writes queued while this one was on the wire: their debounce
        // timer may already have fired and found #dirty already false-ing
        // itself out from under them — catch that here instead.
        if (this.#dirty && this.#timer === undefined) this.#writeNow();
      });
  }
}
