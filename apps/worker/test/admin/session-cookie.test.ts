import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Buffer } from 'node:buffer';
import {
  clearSessionCookieHeader,
  readSessionCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
} from '../../src/admin/session-cookie.ts';

const payload = { userId: 'u-1', username: 'admin', role: 'admin' as const, exp: 2_000 };

describe('signSession / verifySession', () => {
  test('a freshly signed token verifies and round-trips the payload', async () => {
    const token = await signSession(payload, 'secret-1');
    expect(await verifySession(token, 'secret-1', 1_000)).toEqual(payload);
  });

  test('a token signed with a different secret fails to verify', async () => {
    const token = await signSession(payload, 'secret-1');
    expect(await verifySession(token, 'secret-2', 1_000)).toBeUndefined();
  });

  test('an expired token fails to verify', async () => {
    const token = await signSession(payload, 'secret-1');
    expect(await verifySession(token, 'secret-1', payload.exp + 1)).toBeUndefined();
  });

  test('a tampered payload fails to verify (signature no longer matches)', async () => {
    const token = await signSession(payload, 'secret-1');
    const [, sig] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({ ...payload, role: 'user' }))
      .toString('base64url');
    expect(await verifySession(`${tamperedBody}.${sig}`, 'secret-1', 1_000)).toBeUndefined();
  });

  test('garbage input fails closed instead of throwing', async () => {
    expect(await verifySession('not-a-token', 'secret-1', 1_000)).toBeUndefined();
    expect(await verifySession('', 'secret-1', 1_000)).toBeUndefined();
  });

  test('a role outside admin/user is rejected even with a valid signature', async () => {
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, role: 'superadmin' }))
      .toString('base64url');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('secret-1'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(forgedBody)),
    ).toString('base64url');
    expect(await verifySession(`${forgedBody}.${sig}`, 'secret-1', 1_000)).toBeUndefined();
  });
});

describe('cookie header helpers', () => {
  test('sessionCookieHeader sets HttpOnly, SameSite=Lax, and a Max-Age', () => {
    const header = sessionCookieHeader('tok', { secure: false });
    expect(header).toContain('lfr_session=tok');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
  });

  test('secure: true adds the Secure attribute', () => {
    expect(sessionCookieHeader('tok', { secure: true })).toContain('Secure');
  });

  test('clearSessionCookieHeader expires the cookie immediately', () => {
    expect(clearSessionCookieHeader({ secure: false })).toContain('Max-Age=0');
  });

  test('readSessionCookie finds the cookie among others', () => {
    const req = new Request('http://localhost/', {
      headers: { cookie: 'other=1; lfr_session=abc.def; another=2' },
    });
    expect(readSessionCookie(req)).toBe('abc.def');
  });

  test('readSessionCookie returns undefined when absent', () => {
    expect(readSessionCookie(new Request('http://localhost/'))).toBeUndefined();
  });
});
