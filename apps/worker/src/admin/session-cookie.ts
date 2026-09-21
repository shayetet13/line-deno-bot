import { Buffer } from 'node:buffer';
import type { UserRole } from './users-store.ts';

/**
 * Stateless, signed session cookie — no server-side session table.
 *
 * This is what makes item 4 of the request ("switching rooms must not log
 * the operator off") trivially true on the web-session side: verification
 * only ever needs the HMAC secret in the system `users.json`, so a worker restart (the
 * `/api/groups` surface-change fallback) never invalidates a cookie the way
 * an in-memory or on-disk session table tied to process lifetime would.
 */

export interface SessionPayload {
  userId: string;
  username: string;
  role: UserRole;
  /** Epoch ms. */
  exp: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_NAME = 'lfr_session';

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Buffer.from(signature).toString('base64url');
}

/** Constant-time string compare (signatures are fixed-length base64url). */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now: number,
): Promise<SessionPayload | undefined> {
  const dot = token.indexOf('.');
  if (dot === -1) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!timingSafeStringEqual(expected, sig)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p['userId'] !== 'string' || typeof p['username'] !== 'string') return undefined;
  if (p['role'] !== 'admin' && p['role'] !== 'user') return undefined;
  if (typeof p['exp'] !== 'number' || p['exp'] < now) return undefined;
  return { userId: p['userId'], username: p['username'], role: p['role'], exp: p['exp'] };
}

export function sessionCookieHeader(token: string, opts: { secure: boolean }): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${String(SESSION_TTL_MS / 1000)}`];
  if (opts.secure) attrs.push('Secure');
  return `${COOKIE_NAME}=${token}; ${attrs.join('; ')}`;
}

export function clearSessionCookieHeader(opts: { secure: boolean }): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (opts.secure) attrs.push('Secure');
  return `${COOKIE_NAME}=; ${attrs.join('; ')}`;
}

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}
