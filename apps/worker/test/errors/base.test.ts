import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  AppError,
  ConfigError,
  type ErrorClass,
  IllegalStateTransitionError,
  OperationAbortedError,
  OperationTimeoutError,
  PermanentAuthError,
  TransientTransportError,
  ValidationError,
} from '../../src/errors/base.ts';

const CASES: readonly [new (m: string) => AppError, string, ErrorClass][] = [
  [ValidationError, 'validation_failed', 'permanent'],
  [ConfigError, 'config_invalid', 'permanent'],
  [TransientTransportError, 'transient_transport', 'transient'],
  [PermanentAuthError, 'permanent_auth', 'permanent'],
  [OperationTimeoutError, 'operation_timeout', 'transient'],
  [OperationAbortedError, 'operation_aborted', 'transient'],
  [IllegalStateTransitionError, 'illegal_state_transition', 'permanent'],
];

describe('AppError hierarchy', () => {
  for (const [Ctor, code, errorClass] of CASES) {
    test(`${Ctor.name} has a stable code and error class`, () => {
      const err = new Ctor('boom');
      expect(err instanceof AppError).toBe(true);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.errorClass).toBe(errorClass);
      expect(err.name).toBe(Ctor.name);
      expect(err.message).toBe('boom');
    });
  }

  test('context is frozen and defaults to an empty object', () => {
    const withCtx = new ValidationError('x', { field: 'email' });
    expect(withCtx.context).toEqual({ field: 'email' });
    expect(Object.isFrozen(withCtx.context)).toBe(true);
    expect(new ConfigError('y').context).toEqual({});
  });
});
