import { ValidationError } from '../errors/base.ts';

/** Persisted credential material for one bot account. Never logged. */
export interface StoredSession {
  botId: string;
  authToken: string;
  refreshToken: string | undefined;
  /** Epoch seconds the access token expires, if known. */
  expireSec: number | undefined;
  savedAtMs: number;
  /** Opaque per-connector blob (device id, reqseq high-watermark, …). */
  extra: Record<string, unknown>;
}

export interface SessionStore {
  load(botId: string): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  remove(botId: string): Promise<void>;
}

/**
 * Validates `botId` and normalises every failure into a rejected promise, so
 * both implementations behave identically whether their body is sync or async.
 */
function guard<T>(botId: string, run: () => T | Promise<T>): Promise<T> {
  try {
    if (botId.length === 0) {
      throw new ValidationError('session: botId must be non-empty');
    }
    return Promise.resolve(run());
  } catch (err: unknown) {
    return Promise.reject(err);
  }
}

/** In-process store. Use for tests and short-lived probes. */
export class MemorySessionStore implements SessionStore {
  readonly #byBot = new Map<string, StoredSession>();

  load(botId: string): Promise<StoredSession | null> {
    return guard(botId, () => this.#byBot.get(botId) ?? null);
  }

  save(session: StoredSession): Promise<void> {
    return guard(session.botId, () => {
      this.#byBot.set(session.botId, structuredClone(session));
    });
  }

  remove(botId: string): Promise<void> {
    return guard(botId, () => {
      this.#byBot.delete(botId);
    });
  }
}

/** One JSON file per bot under `dir`. On POSIX the file is chmod 600. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  load(botId: string): Promise<StoredSession | null> {
    return guard(botId, async () => {
      try {
        return JSON.parse(await Deno.readTextFile(this.#path(botId))) as StoredSession;
      } catch (err: unknown) {
        if (err instanceof Deno.errors.NotFound) return null;
        throw err;
      }
    });
  }

  save(session: StoredSession): Promise<void> {
    return guard(session.botId, async () => {
      await Deno.mkdir(this.dir, { recursive: true });
      const path = this.#path(session.botId);
      await Deno.writeTextFile(path, JSON.stringify(session, null, 2));
      if (Deno.build.os !== 'windows') await Deno.chmod(path, 0o600);
    });
  }

  remove(botId: string): Promise<void> {
    return guard(botId, async () => {
      try {
        await Deno.remove(this.#path(botId));
      } catch (err: unknown) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    });
  }

  #path(botId: string): string {
    return `${this.dir}/${encodeURIComponent(botId)}.json`;
  }
}
