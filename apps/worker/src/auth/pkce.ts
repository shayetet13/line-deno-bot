import { ValidationError } from '../errors/base.ts';

/**
 * PKCE + state/nonce for LINE Login (authorization code flow).
 *
 * This is the WEBSITE login — proving who a human is so they can configure
 * their bots. It is unrelated to the self-bot session: a LINE Login token does
 * not grant access to read anyone's messages, and the two must never be
 * conflated (Phases §15, `[S16]`).
 */

const VERIFIER_BYTES = 64; // -> 86 base64url chars, inside the 43..128 range
const STATE_BYTES = 32;

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Fresh verifier + its S256 challenge. Keep the verifier server-side, bound to
 * the session; send only the challenge to LINE. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  return { verifier, challenge: await deriveChallenge(verifier), method: 'S256' };
}

/** S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function deriveChallenge(verifier: string): Promise<string> {
  assertVerifier(verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** CSRF token for the authorize round trip. Compare on callback. */
export const createState = (): string => base64Url(randomBytes(STATE_BYTES));

/** Replay guard echoed inside the id_token. Compare on callback. */
export const createNonce = (): string => base64Url(randomBytes(STATE_BYTES));

/** Constant-time string compare, for `state` and `nonce` checks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const AUTHORIZE_ENDPOINT = 'https://access.line.me/oauth2/v2.1/authorize';

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  /** `openid` is required to receive an id_token. */
  scopes?: readonly string[];
}

/** Builds the LINE Login authorize URL for the code + PKCE flow. */
export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  if (request.clientId.length === 0) throw new ValidationError('pkce: clientId is required');
  if (request.redirectUri.length === 0) throw new ValidationError('pkce: redirectUri is required');
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('scope', (request.scopes ?? ['openid', 'profile']).join(' '));
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function assertVerifier(verifier: string): void {
  if (verifier.length < 43 || verifier.length > 128) {
    throw new ValidationError('pkce: verifier must be 43..128 characters', {
      length: verifier.length,
    });
  }
}
