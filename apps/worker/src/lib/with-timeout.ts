import { OperationAbortedError, OperationTimeoutError } from '../errors/base.ts';

export interface WithTimeoutOptions {
  timeoutMs: number;
  /** Parent abort signal. When it fires, the child operation is aborted too. */
  signal?: AbortSignal | undefined;
  /** Label carried into the resulting error's context. */
  label?: string | undefined;
}

type TripError = OperationAbortedError | OperationTimeoutError;

/** Links a timeout and an optional parent signal into one child AbortSignal.
 * First trip wins; `dispose()` always releases the timer and listener. */
class Deadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #parent: AbortSignal | undefined;
  readonly #onParentAbort = (): void => {
    this.#trip(new OperationAbortedError('parent signal aborted', this.#ctx));
  };
  #reason: TripError | undefined;

  constructor(
    timeoutMs: number,
    parent: AbortSignal | undefined,
    readonly ctxLabel: string | undefined,
  ) {
    this.#parent = parent;
    this.#timer = setTimeout(() => {
      this.#trip(new OperationTimeoutError('operation timed out', this.#ctx));
    }, timeoutMs);
    parent?.addEventListener('abort', this.#onParentAbort, { once: true });
    if (parent?.aborted) this.#onParentAbort();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get reason(): TripError | undefined {
    return this.#reason;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener('abort', this.#onParentAbort);
  }

  get #ctx(): Record<string, unknown> {
    return { label: this.ctxLabel };
  }

  #trip(err: TripError): void {
    this.#reason ??= err;
    this.#controller.abort(this.#reason);
  }
}

/**
 * Runs `fn` with a hard deadline and an abort signal it MUST honour for real
 * I/O cancellation (Playbook §5.5, §10.3). On timeout or parent abort the child
 * signal is aborted and a typed error is thrown.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WithTimeoutOptions,
): Promise<T> {
  if (options.timeoutMs <= 0) {
    throw new OperationTimeoutError('timeoutMs must be > 0', { label: options.label });
  }
  const deadline = new Deadline(options.timeoutMs, options.signal, options.label);
  try {
    return await Promise.race([fn(deadline.signal), rejectOnAbort(deadline.signal)]);
  } catch (err: unknown) {
    throw deadline.reason ?? err;
  } finally {
    deadline.dispose();
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}
