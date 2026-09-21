import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ValidationError } from '../../src/errors/base.ts';
import {
  buildAuthorizeUrl,
  createNonce,
  createPkcePair,
  createState,
  deriveChallenge,
  safeEqual,
} from '../../src/auth/pkce.ts';

const BASE64URL = /^[A-Za-z0-9\-_]+$/;

describe('createPkcePair', () => {
  test('produces a spec-length base64url verifier and its S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(BASE64URL);
    expect(pair.challenge).toMatch(BASE64URL);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  test('is different every call', async () => {
    const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);
    expect(a.verifier).not.toBe(b.verifier);
  });

  test('the challenge is reproducible from the verifier', async () => {
    const pair = await createPkcePair();
    expect(await deriveChallenge(pair.verifier)).toBe(pair.challenge);
  });

  test('matches the RFC 7636 worked example', async () => {
    // Appendix B: verifier -> challenge
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await deriveChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('rejects a verifier outside the allowed length', async () => {
    await expect(deriveChallenge('too-short')).rejects.toBeInstanceOf(ValidationError);
    await expect(deriveChallenge('a'.repeat(129))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('state and nonce', () => {
  test('are random base64url strings', () => {
    expect(createState()).toMatch(BASE64URL);
    expect(createNonce()).toMatch(BASE64URL);
    expect(createState()).not.toBe(createState());
  });

  test('safeEqual compares without leaking length-independent early exit', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('buildAuthorizeUrl', () => {
  test('carries code+PKCE, state and nonce', async () => {
    const pair = await createPkcePair();
    const url = new URL(buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://example.test/cb',
      state: 'st',
      nonce: 'no',
      challenge: pair.challenge,
    }));
    expect(url.origin + url.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge')).toBe(pair.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });

  test('honours custom scopes', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'https://e.test/cb',
      state: 's',
      nonce: 'n',
      challenge: 'ch',
      scopes: ['openid'],
    }));
    expect(url.searchParams.get('scope')).toBe('openid');
  });

  test('requires clientId and redirectUri', () => {
    const base = {
      clientId: 'c',
      redirectUri: 'https://e.test/cb',
      state: 's',
      nonce: 'n',
      challenge: 'ch',
    };
    expect(() => buildAuthorizeUrl({ ...base, clientId: '' })).toThrow(ValidationError);
    expect(() => buildAuthorizeUrl({ ...base, redirectUri: '' })).toThrow(ValidationError);
  });
});
