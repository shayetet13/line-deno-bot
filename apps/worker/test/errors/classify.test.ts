import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  PermanentAuthError,
  TransientTransportError,
  ValidationError,
} from '../../src/errors/base.ts';
import { classifyError } from '../../src/errors/classify.ts';

describe('classifyError', () => {
  test('an AppError answers with its own class', () => {
    expect(classifyError(new TransientTransportError('x'))).toBe('transient');
    expect(classifyError(new PermanentAuthError('x'))).toBe('permanent');
    expect(classifyError(new ValidationError('x'))).toBe('permanent');
  });

  test('known socket error codes are transient', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET']) {
      expect(classifyError(Object.assign(new Error('io'), { code }))).toBe('transient');
    }
  });

  test('GOAWAY / http2 / HTTP 5xx messages are transient', () => {
    expect(classifyError(new Error('http2: server sent GOAWAY'))).toBe('transient');
    expect(classifyError(new Error('HTTP/2 lane to 2400:dcc0::2 is closed'))).toBe('transient');
    expect(classifyError(new Error('relay error: HTTP 502 upstream'))).toBe('transient');
    expect(classifyError(new Error('status=503 from edge'))).toBe('transient');
  });

  test('Node HTTP/2 lifecycle codes are transient', () => {
    const err = Object.assign(new Error('The session has been destroyed'), {
      code: 'ERR_HTTP2_INVALID_SESSION',
    });
    expect(classifyError(err)).toBe('transient');
  });

  test('a bare number that merely contains 502 is NOT transient (Playbook §10.1)', () => {
    expect(classifyError(new Error('sequence 50234 rejected'))).toBe('unknown');
    expect(classifyError(new Error('code 5023'))).toBe('unknown');
  });

  test('plain values are unknown', () => {
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError('nope')).toBe('unknown');
    expect(classifyError(new Error('something else'))).toBe('unknown');
  });
});
