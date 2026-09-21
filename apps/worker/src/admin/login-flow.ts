import { type Device, type HttpFetch, loginToLine } from '../adapters/linejs/login.ts';
import { ValidationError } from '../errors/base.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import type { SessionStore } from '../session/store.ts';

/**
 * Drives a LINE bot QR re-authentication from a browser instead of a terminal.
 *
 * This exists for one job: recovering (or, since `cli/serve.ts` splits the
 * HTTP admin server from the LINE connection, also making a first-ever)
 * bot login without needing an SSH session and a real terminal — the QR pairing
 * window is short (LINE gives about 150s) and the terminal path had its own
 * timing trap: see the project's login CLI notes.
 *
 * A fresh login here writes a new session file; it does not touch the
 * `Client` already driving the live worker. Picking the new session up is a
 * restart, same as the recovery ladder's `reconnect-session` rung — this
 * class does not attempt to hot-swap a live LINEJS connection.
 */

export type LoginFlowState =
  | { status: 'idle' }
  | { status: 'running'; startedAtMono: number; qrUrl: string | undefined; pin: string | undefined }
  | { status: 'success'; savedAtMs: number }
  | { status: 'error'; message: string };

export interface LoginFlowOptions {
  botId: string;
  device: Device;
  storagePath: string;
  sessions: SessionStore;
  logger: Logger;
  clock: Clock;
  httpFetch?: HttpFetch | undefined;
  /** Injectable so a test can drive this without a real LINE account. */
  loginFn?: typeof loginToLine;
  /** Called after a freshly authenticated session has been saved. The caller
   * can connect it without requiring an operator to restart the worker. */
  onSuccess?: (() => void | Promise<void>) | undefined;
}

export class LoginFlow {
  #state: LoginFlowState = { status: 'idle' };
  #inFlight = false;

  constructor(private readonly options: LoginFlowOptions) {}

  get state(): LoginFlowState {
    return this.#state;
  }

  /** ms since `start()` was called, while running; `undefined` otherwise.
   * `LoginFlow` already holds the clock it stamped `startedAtMono` with, so
   * the elapsed time is computed here rather than asking a caller to redo it
   * from a raw monotonic value it has no other use for. */
  get elapsedMs(): number | undefined {
    return this.#state.status === 'running'
      ? this.options.clock.monotonic() - this.#state.startedAtMono
      : undefined;
  }

  /**
   * Kicks off one login attempt. Single-flight: a second call while one is
   * already running is refused rather than starting a competing LINEJS login
   * against the same account.
   */
  start(): void {
    if (this.#inFlight) {
      throw new ValidationError('a login attempt is already running for this bot');
    }
    this.#inFlight = true;
    this.#state = {
      status: 'running',
      startedAtMono: this.options.clock.monotonic(),
      qrUrl: undefined,
      pin: undefined,
    };

    const login = this.options.loginFn ?? loginToLine;
    login({
      botId: this.options.botId,
      device: this.options.device,
      method: { kind: 'qr' },
      storagePath: this.options.storagePath,
      sessions: this.options.sessions,
      logger: this.options.logger,
      ...(this.options.httpFetch === undefined ? {} : { httpFetch: this.options.httpFetch }),
      onQrUrl: (url: string) => {
        if (this.#state.status === 'running') this.#state = { ...this.#state, qrUrl: url };
      },
      onPincode: (pin: string) => {
        if (this.#state.status === 'running') this.#state = { ...this.#state, pin };
      },
    })
      .then(() => {
        this.#state = { status: 'success', savedAtMs: this.options.clock.now() };
        return this.options.onSuccess?.();
      })
      .catch((err: unknown) => {
        this.#state = {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.#inFlight = false;
      });
  }

  /** Back to idle so the page can offer "start again". Refused mid-flight —
   * resetting while a real LINEJS login is in progress would orphan it. */
  reset(): void {
    if (this.#inFlight) {
      throw new ValidationError('cannot reset while a login attempt is running');
    }
    this.#state = { status: 'idle' };
  }
}
