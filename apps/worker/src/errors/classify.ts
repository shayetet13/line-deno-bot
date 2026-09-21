import { AppError, type ErrorClass } from './base.ts';

/** Node/undici error codes treated as transient transport failures (Playbook §10.1). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Matches GOAWAY and HTTP 502/503/504 as whole tokens — NOT a bare `502`
 * inside a number like `50234` (Playbook §10.1 regression). */
const TRANSIENT_MESSAGE = /\bGOAWAY\b|\bHTTP\/?2\b|(?:HTTP[/ ]|status[ =:]+)(?:502|503|504)\b/i;

const readCode = (err: object): string | undefined => {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Best-effort classification for errors that are not `AppError`s (e.g. raw
 * transport rejections from fetch/undici). `AppError`s answer for themselves.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof AppError) return err.errorClass;
  if (typeof err !== 'object' || err === null) return 'unknown';

  const code = readCode(err);
  // Node uses a family of ERR_HTTP2_* codes for an edge closing an idle H2
  // session (ERR_HTTP2_INVALID_SESSION, ERR_HTTP2_GOAWAY_SESSION, ...). They
  // are connection-lifecycle failures, not bad requests, and the lane must be
  // rebuilt instead of retaining its old low RTT and being selected forever.
  if (code !== undefined && (TRANSIENT_CODES.has(code) || code.startsWith('ERR_HTTP2_'))) {
    return 'transient';
  }

  const message = err instanceof Error ? err.message : '';
  if (TRANSIENT_MESSAGE.test(message)) return 'transient';

  return 'unknown';
}
