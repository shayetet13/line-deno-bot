import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { OperationAbortedError, OperationTimeoutError } from '../../src/errors/base.ts';
import { withTimeout } from '../../src/lib/with-timeout.ts';

const never = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

describe('withTimeout', () => {
  test('returns the operation result when it settles in time', async () => {
    const result = await withTimeout(() => Promise.resolve('ok'), { timeoutMs: 50 });
    expect(result).toBe('ok');
  });

  test('throws OperationTimeoutError and aborts the child signal on deadline', async () => {
    let childAborted = false;
    const promise = withTimeout(
      (signal) => {
        signal.addEventListener('abort', () => {
          childAborted = true;
        });
        return never(signal);
      },
      { timeoutMs: 10, label: 'unit' },
    );
    await expect(promise).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(childAborted).toBe(true);
  });

  test('propagates a parent abort as OperationAbortedError', async () => {
    const parent = new AbortController();
    const promise = withTimeout((signal) => never(signal), {
      timeoutMs: 1_000,
      signal: parent.signal,
    });
    parent.abort();
    await expect(promise).rejects.toBeInstanceOf(OperationAbortedError);
  });

  test('handles a parent that is already aborted', async () => {
    const promise = withTimeout((signal) => never(signal), {
      timeoutMs: 1_000,
      signal: AbortSignal.abort(),
    });
    await expect(promise).rejects.toBeInstanceOf(OperationAbortedError);
  });

  test('rejects a non-positive timeout', async () => {
    await expect(withTimeout(() => Promise.resolve(1), { timeoutMs: 0 })).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );
  });

  test('a rejecting operation surfaces its own error when no deadline tripped', async () => {
    const boom = new TypeError('boom');
    await expect(withTimeout(() => Promise.reject(boom), { timeoutMs: 100 })).rejects.toBe(boom);
  });
});
