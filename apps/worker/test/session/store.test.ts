import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  FileSessionStore,
  MemorySessionStore,
  type SessionStore,
  type StoredSession,
} from '../../src/session/store.ts';
import { ValidationError } from '../../src/errors/base.ts';

const aSession = (over: Partial<StoredSession> = {}): StoredSession => ({
  botId: 'bot-1',
  authToken: 'tok',
  refreshToken: 'refresh',
  expireSec: 1_700_000_000,
  savedAtMs: 1,
  extra: { deviceId: 'dev-1' },
  ...over,
});

const behavesLikeAStore = (name: string, make: () => Promise<SessionStore>): void => {
  describe(name, () => {
    test('round-trips a session', async () => {
      const store = await make();
      await store.save(aSession());
      expect(await store.load('bot-1')).toEqual(aSession());
    });

    test('returns null for an unknown bot', async () => {
      expect(await (await make()).load('nobody')).toBeNull();
    });

    test('overwrites on re-save', async () => {
      const store = await make();
      await store.save(aSession());
      await store.save(aSession({ authToken: 'tok2' }));
      expect((await store.load('bot-1'))?.authToken).toBe('tok2');
    });

    test('remove deletes and is idempotent', async () => {
      const store = await make();
      await store.save(aSession());
      await store.remove('bot-1');
      await store.remove('bot-1');
      expect(await store.load('bot-1')).toBeNull();
    });

    test('rejects an empty botId', async () => {
      const store = await make();
      await expect(store.load('')).rejects.toBeInstanceOf(ValidationError);
    });
  });
};

behavesLikeAStore('MemorySessionStore', () => Promise.resolve(new MemorySessionStore()));

behavesLikeAStore('FileSessionStore', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'lfr-session-' });
  return new FileSessionStore(dir);
});

describe('MemorySessionStore', () => {
  test('stores a copy so later mutation of the input does not leak in', async () => {
    const store = new MemorySessionStore();
    const session = aSession();
    await store.save(session);
    session.authToken = 'mutated';
    expect((await store.load('bot-1'))?.authToken).toBe('tok');
  });
});

describe('FileSessionStore bot isolation', () => {
  test('keeps credentials for different bots in separate records', async () => {
    const dir = await Deno.makeTempDir({ prefix: 'lfr-bot-isolation-' });
    try {
      const store = new FileSessionStore(dir);
      await store.save({ ...aSession(), botId: 'bot-1', authToken: 'token-1' });
      await store.save({ ...aSession(), botId: 'bot-2', authToken: 'token-2' });

      expect((await store.load('bot-1'))?.authToken).toBe('token-1');
      expect((await store.load('bot-2'))?.authToken).toBe('token-2');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
