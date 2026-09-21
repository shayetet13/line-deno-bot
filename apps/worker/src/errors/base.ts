/**
 * Typed error hierarchy. Raw `throw new Error(...)` is banned by lint
 * (`CLAUDE .md` §4). Every error carries a stable `code` and an `errorClass`
 * that drives retry policy (Playbook §5.5, §10.1).
 */

export type ErrorClass = 'transient' | 'permanent' | 'unknown';

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly errorClass: ErrorClass;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
  }
}

/** Input failed validation at a system boundary. Never retry. */
export class ValidationError extends AppError {
  readonly code = 'validation_failed';
  readonly errorClass = 'permanent' as const;
}

/** Startup configuration invalid. Fail fast. */
export class ConfigError extends AppError {
  readonly code = 'config_invalid';
  readonly errorClass = 'permanent' as const;
}

/** Transport hiccup (GOAWAY / 502-504 / reset). Read-only ops may retry. */
export class TransientTransportError extends AppError {
  readonly code = 'transient_transport';
  readonly errorClass = 'transient' as const;
}

/** Auth or permission denied. Stop the chain; do not retry blindly. */
export class PermanentAuthError extends AppError {
  readonly code = 'permanent_auth';
  readonly errorClass = 'permanent' as const;
}

/** An awaited operation exceeded its deadline. */
export class OperationTimeoutError extends AppError {
  readonly code = 'operation_timeout';
  readonly errorClass = 'transient' as const;
}

/** An awaited operation was aborted via its parent AbortSignal. */
export class OperationAbortedError extends AppError {
  readonly code = 'operation_aborted';
  readonly errorClass = 'transient' as const;
}

/** A state machine was asked for a transition its current state does not allow. */
export class IllegalStateTransitionError extends AppError {
  readonly code = 'illegal_state_transition';
  readonly errorClass = 'permanent' as const;
}
