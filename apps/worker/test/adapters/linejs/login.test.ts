import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Client } from '@evex/linejs';
import {
  type AuthTokenLoginFn,
  DEVICE_DISPLAY,
  resumeOrLogin,
  resumeStoredSession,
} from '../../../src/adapters/linejs/login.ts';
import { DEVICES } from '../../../src/cli/login.ts';
import { PermanentAuthError } from '../../../src/errors/base.ts';
import { Logger } from '../../../src/logging/logger.ts';
import { MemorySessionStore, type StoredSession } from '../../../src/session/store.ts';

/**
 * `loginToLine` itself needs a real LINE account to exercise end to end, so
 * it stays untested here (same as the rest of this module always has been).
 * `DEVICE_DISPLAY` is a pure lookup table with no such dependency, and it is
 * exactly the piece a regression would slip back through: this guards the
 * actual bug that shipped (LINEJS's own defaults name the library) from
 * quietly coming back.
 */
describe('DEVICE_DISPLAY', () => {
  test('covers every Device the login CLI offers', () => {
    for (const device of DEVICES) {
      expect(DEVICE_DISPLAY[device]).toBeDefined();
    }
  });

  test('never announces the library or its author to LINE', () => {
    for (const { model, systemName } of Object.values(DEVICE_DISPLAY)) {
      for (const value of [model, systemName]) {
        expect(value.toLowerCase()).not.toContain('linejs');
        expect(value.toLowerCase()).not.toContain('evex');
      }
    }
  });

  test('every entry is a non-empty, human-plausible name', () => {
    for (const { model, systemName } of Object.values(DEVICE_DISPLAY)) {
      expect(model.length).toBeGreaterThan(0);
      expect(systemName.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Regression coverage for the 2026-09-11 outage: `cli/serve.ts` used to call
 * `resumeOrLogin` with its own already-loaded token as the "fallback"
 * method. When LINE rejected that token, the old code discarded the session
 * file and then retried the SAME rejected token — guaranteed to fail again,
 * every restart, forever, with the session file gone and no way back short
 * of an operator running an interactive login by hand.
 *
 * `loginToLine`'s own real network calls make it untestable here, so these
 * tests inject `authTokenLogin` — the one call both functions make that can
 * actually succeed or fail — and never let a genuinely successful case reach
 * the untestable QR/password code paths at all.
 */
const silent = (): Logger => new Logger({ level: 'error', sink: () => {} });

const session = (over: Partial<StoredSession> = {}): StoredSession => ({
  botId: 'bot-1',
  authToken: 'tok-abc',
  refreshToken: undefined,
  expireSec: undefined,
  savedAtMs: 1_700_000_000_000,
  extra: {},
  ...over,
});

const accepts: AuthTokenLoginFn =
  (() => Promise.resolve({ authToken: 'tok-abc' } as unknown as Client)) as AuthTokenLoginFn;

const rejects: AuthTokenLoginFn =
  (() => Promise.reject(new Error('AUTHENTICATION_FAILED'))) as AuthTokenLoginFn;

describe('resumeStoredSession', () => {
  test('forwards a dedicated streaming PUSH transport to LINEJS', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    const rpcFetch = () => Promise.resolve(new Response('rpc'));
    const pushFetch = () => Promise.resolve(new Response('push'));
    let seenInit: Parameters<AuthTokenLoginFn>[1] | undefined;
    const capture = ((_token: unknown, init: Parameters<AuthTokenLoginFn>[1]) => {
      seenInit = init;
      return Promise.resolve({ authToken: 'tok-abc' } as unknown as Client);
    }) as AuthTokenLoginFn;

    await resumeStoredSession({
      botId: 'bot-1',
      device: 'DESKTOPWIN',
      storagePath: '/tmp/x.json',
      sessions,
      logger: silent(),
      httpFetch: rpcFetch,
      httpPushFetch: pushFetch,
    }, capture);

    expect(seenInit?.fetch).toBeDefined();
    expect(seenInit?.pushFetch).toBeDefined();
    expect(await (await seenInit!.fetch!(new Request('https://example.invalid/rpc'))).text()).toBe(
      'rpc',
    );
    expect(
      await (await seenInit!.pushFetch!(new Request('https://example.invalid/push'))).text(),
    ).toBe('push');
  });

  test('returns the client when the stored token is accepted', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    const client = await resumeStoredSession(
      {
        botId: 'bot-1',
        device: 'DESKTOPWIN',
        storagePath: '/tmp/x.json',
        sessions,
        logger: silent(),
      },
      accepts,
    );
    expect(client).toBeDefined();
  });

  test('throws a clear error when there is no stored session at all', async () => {
    const sessions = new MemorySessionStore();
    await expect(
      resumeStoredSession(
        {
          botId: 'bot-1',
          device: 'DESKTOPWIN',
          storagePath: '/tmp/x.json',
          sessions,
          logger: silent(),
        },
        accepts,
      ),
    ).rejects.toThrow(PermanentAuthError);
  });

  test('a rejected token throws WITHOUT deleting the session file', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    await expect(
      resumeStoredSession(
        {
          botId: 'bot-1',
          device: 'DESKTOPWIN',
          storagePath: '/tmp/x.json',
          sessions,
          logger: silent(),
        },
        rejects,
      ),
    ).rejects.toThrow(PermanentAuthError);
    // This is the whole point of the fix: the file survives a rejection, so
    // an operator (or /api/login/status) can still see what was there.
    expect(await sessions.load('bot-1')).not.toBeNull();
  });

  test('the thrown error names how to actually recover', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    try {
      await resumeStoredSession(
        {
          botId: 'bot-1',
          device: 'DESKTOPWIN',
          storagePath: '/tmp/x.json',
          sessions,
          logger: silent(),
        },
        rejects,
      );
      throw new Error('expected a throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PermanentAuthError);
      expect((err as Error).message).toContain('/login');
      expect((err as Error).message).toContain('--force');
    }
  });
});

describe('resumeOrLogin — the same-token fallback guard', () => {
  test('an accepted token resumes normally regardless of what method is configured', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    const client = await resumeOrLogin(
      {
        botId: 'bot-1',
        device: 'DESKTOPWIN',
        method: { kind: 'authToken', authToken: 'tok-abc' },
        storagePath: '/tmp/x.json',
        sessions,
        logger: silent(),
      },
      accepts,
    );
    expect(client).toBeDefined();
    expect(await sessions.load('bot-1')).not.toBeNull();
  });

  test('a rejected token, with the fallback method carrying that SAME token, throws instead of retrying it', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    await expect(
      resumeOrLogin(
        {
          botId: 'bot-1',
          device: 'DESKTOPWIN',
          // The exact shape that took the account offline: "fall back" to
          // the identical credential that was just rejected.
          method: { kind: 'authToken', authToken: 'tok-abc' },
          storagePath: '/tmp/x.json',
          sessions,
          logger: silent(),
        },
        rejects,
      ),
    ).rejects.toThrow(PermanentAuthError);
  });

  test('...and, unlike the old behavior, never deletes the session file in that case', async () => {
    const sessions = new MemorySessionStore();
    await sessions.save(session());
    await resumeOrLogin(
      {
        botId: 'bot-1',
        device: 'DESKTOPWIN',
        method: { kind: 'authToken', authToken: 'tok-abc' },
        storagePath: '/tmp/x.json',
        sessions,
        logger: silent(),
      },
      rejects,
    ).catch(() => {});
    expect(await sessions.load('bot-1')).not.toBeNull();
  });

  // A rejected token whose fallback method is genuinely different (a real
  // --method qr/password, or even a different authToken) still discards and
  // falls back to loginToLine — unchanged, pre-existing behavior. Verifying
  // that would mean actually reaching loginToLine's real network calls, so
  // — consistent with the rest of this module, which has never had a test
  // that talks to LINE — it stays unverified here. The guard this fix adds
  // only narrows the ONE case that was actively harmful: falling back to the
  // exact credential that was just rejected.
});
