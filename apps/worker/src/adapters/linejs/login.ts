import { Client, loginWithAuthToken, loginWithPassword } from '@evex/linejs';
import { BaseClient, type Device } from '@evex/linejs/base';
import { PermanentAuthError } from '../../errors/base.ts';
import type { Logger } from '../../logging/logger.ts';
import type { SessionStore, StoredSession } from '../../session/store.ts';
import { BufferedFileStorage } from './buffered-storage.ts';
/** Minimal transport shape: a warm pooled fetch or a lane pool both fit. */
export type HttpFetch = (info: Request | URL | string, init?: RequestInit) => Promise<Response>;

export type { Device };

/** How to obtain a session when none is stored yet. */
export type LoginMethod =
  | { kind: 'qr' }
  | { kind: 'password'; email: string; password: string; pincode?: string | undefined }
  | { kind: 'authToken'; authToken: string };

export interface LineLoginOptions {
  botId: string;
  device: Device;
  method: LoginMethod;
  /** LINEJS key/value file — holds refreshToken, expire and the request sequence.
   * Keeping this on disk is what stops `getReqseq()` restarting from zero
   * (Phases §3.3 / §7.2). */
  storagePath: string;
  sessions: SessionStore;
  logger: Logger;
  onQrUrl?: ((url: string) => void | Promise<void>) | undefined;
  onPincode?: ((pin: string) => void | Promise<void>) | undefined;
  /** Custom transport for the session: a warm pooled fetch (Phase 3) or an
   * owned lane pool (Phase 4). */
  httpFetch?: HttpFetch | undefined;
  /** Streaming transport for LINE's long-lived `/PUSH` request. Keep this
   * separate when `httpFetch` buffers request or response bodies. */
  httpPushFetch?: HttpFetch | undefined;
  /** What this session announces itself as in LINE's own "manage devices"
   * list. Defaults to a plausible name for `device` (see {@link DEVICE_DISPLAY}) —
   * override either field to use something more specific. */
  deviceModelName?: string | undefined;
  deviceSystemName?: string | undefined;
}

/**
 * A believable (model, system) pair per {@link Device}. LINEJS's own QR-login
 * default announces the session as model "evex-device" running "linejs-v2" —
 * accurate, but it names the library to anyone who checks their account's
 * device list. This is cosmetic, not a protocol change: LINE is told a
 * different device NAME, nothing about how the client behaves.
 */
export const DEVICE_DISPLAY: Readonly<Record<Device, { model: string; systemName: string }>> = {
  DESKTOPWIN: { model: 'Windows', systemName: 'Windows 11' },
  DESKTOPMAC: { model: 'Mac', systemName: 'macOS' },
  ANDROID: { model: 'Android', systemName: 'Android OS' },
  ANDROIDSECONDARY: { model: 'Android', systemName: 'Android OS' },
  IOS: { model: 'iPhone', systemName: 'iOS' },
  IOSIPAD: { model: 'iPad', systemName: 'iPadOS' },
  WATCHOS: { model: 'Apple Watch', systemName: 'watchOS' },
  WEAROS: { model: 'Wear OS', systemName: 'Wear OS' },
};

/** Adapts our `(info, init)` fetch to LINEJS's `(req: Request)` FetchLike. */
const toLineFetch = (send: HttpFetch) => (req: Request): Promise<Response> => send(req);

/** Builds the InitOptions LINEJS's login functions take. Takes only the
 * fields it uses (not the whole `LineLoginOptions`) so both `loginToLine`'s
 * options and `resumeStoredSession`'s narrower ones satisfy it. */
function initOptions(
  opts: Pick<LineLoginOptions, 'device' | 'storagePath' | 'httpFetch' | 'httpPushFetch'>,
): {
  device: Device;
  storage: BufferedFileStorage;
  fetch?: (req: Request) => Promise<Response>;
  pushFetch?: (req: Request) => Promise<Response>;
} {
  const base = { device: opts.device, storage: new BufferedFileStorage(opts.storagePath) };
  return {
    ...base,
    ...(opts.httpFetch === undefined ? {} : { fetch: toLineFetch(opts.httpFetch) }),
    ...(opts.httpPushFetch === undefined ? {} : { pushFetch: toLineFetch(opts.httpPushFetch) }),
  };
}

const noop = (): void => {};

/**
 * Logs in with the chosen method and persists the resulting credentials.
 * Prefer {@link resumeOrLogin} — a stored token avoids the interactive flow.
 */
export async function loginToLine(opts: LineLoginOptions): Promise<Client> {
  const client = await runMethod(opts, initOptions(opts)).catch(explainLoginFailure);
  await persist(client, opts);
  opts.logger.info('line login complete', { botId: opts.botId, method: opts.method.kind });
  return client;
}

/**
 * Turns LINE's terse transport errors into something a human can act on.
 * The QR/PIN pairing window is short — LINE announces it as `intervalSec` and
 * answers the pairing poll with HTTP 410 once it lapses.
 */
function explainLoginFailure(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('status=410')) {
    throw new PermanentAuthError(
      'การยืนยันหมดอายุก่อนถูกอนุมัติ (LINE ตอบ 410) — รันใหม่แล้วสแกน/ใส่ PIN ภายในราว 2 นาที',
      { reason: 'pairing_expired' },
    );
  }
  if (/NOT_AUTHORIZED_DEVICE|V3_TOKEN_CLIENT_LOGGED_OUT/.test(message)) {
    throw new PermanentAuthError(
      'LINE ปฏิเสธอุปกรณ์/เซสชันนี้ — ลอง --force เพื่อล้าง session เดิม หรือเปลี่ยน --device',
      { reason: 'device_rejected' },
    );
  }
  throw err;
}

/** Injectable so tests can simulate LINE accepting or rejecting a stored
 * token without a real account — defaults to the genuine LINEJS call. */
export type AuthTokenLoginFn = typeof loginWithAuthToken;

/**
 * Reuses a stored auth token when one exists, falling back to `opts.method`.
 * A stored token that LINE rejects is discarded so the next call re-authenticates
 * rather than looping on a dead credential (Playbook §9.2).
 *
 * That fallback assumes `opts.method` is a genuinely different, potentially
 * successful way in — an operator's `--method qr`/`password`, say. If
 * `opts.method` turns out to be an `authToken` method carrying the SAME token
 * that was just rejected, retrying it cannot succeed by construction, and
 * discarding the file first only destroys a still-informative record for no
 * benefit — a caller in that shape gets a clear, non-destructive error
 * instead (this exact combination took the live worker offline on
 * 2026-09-11: `cli/serve.ts` used to call this with its own already-rejected
 * token as the "fallback" method, so every restart deleted the session and
 * then failed anyway, converging on `StartLimitBurst` with no way to
 * recover short of an operator running a real interactive login).
 *
 * An unattended, non-interactive caller (the systemd-managed worker) should
 * prefer {@link resumeStoredSession} instead, which never has a fallback
 * method to misuse in the first place.
 */
export async function resumeOrLogin(
  opts: LineLoginOptions,
  authTokenLogin: AuthTokenLoginFn = loginWithAuthToken,
): Promise<Client> {
  const stored = await opts.sessions.load(opts.botId);
  if (stored === null) return loginToLine(opts);
  try {
    const client = await authTokenLogin(stored.authToken, initOptions(opts));
    opts.logger.info('line session resumed', { botId: opts.botId });
    return client;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : 'unknown';
    if (opts.method.kind === 'authToken' && opts.method.authToken === stored.authToken) {
      opts.logger.error(
        'stored session rejected and the configured method is the same token — leaving it in place',
        { botId: opts.botId, reason },
      );
      throw new PermanentAuthError(
        `stored session for "${opts.botId}" was rejected by LINE and no other login method was ` +
          `configured to fall back to — re-authenticate via the /login page or ` +
          `\`deno task login --bot-id ${opts.botId} --force\``,
        { botId: opts.botId, reason },
      );
    }
    opts.logger.warn('stored session rejected; re-authenticating', { botId: opts.botId, reason });
    await opts.sessions.remove(opts.botId);
    return loginToLine(opts);
  }
}

/** What {@link resumeStoredSession} needs — notably not `method`, since it
 * never tries anything other than what is already on disk. */
export type ResumeOptions = Omit<LineLoginOptions, 'method' | 'onQrUrl' | 'onPincode'>;

/**
 * Tries only the stored session. No fallback, and no side effect on failure —
 * the file is left exactly as it was, whether that means "worked" or
 * "rejected". For unattended callers where there is no interactive method to
 * fall back to (a systemd-managed worker cannot show a QR code), so the only
 * thing a fallback attempt could do is retry the identical rejected
 * credential and then destroy the record of what happened.
 *
 * The caller decides what "no usable session" means for it. `cli/serve.ts`
 * lets this throw and exits; a future control-plane could catch it and mark
 * the bot DEGRADED instead. Either way, `/api/login/status` and the
 * `docs/runbook.md` §6 steps still have a session file to show and reason
 * about, which is the whole point of not deleting it.
 */
export async function resumeStoredSession(
  opts: ResumeOptions,
  authTokenLogin: AuthTokenLoginFn = loginWithAuthToken,
): Promise<Client> {
  const stored = await opts.sessions.load(opts.botId);
  if (stored === null) {
    throw new PermanentAuthError(
      `no stored session for "${opts.botId}" — run \`deno task login --bot-id ${opts.botId}\` first`,
      { botId: opts.botId },
    );
  }
  try {
    const client = await authTokenLogin(stored.authToken, initOptions(opts));
    opts.logger.info('line session resumed', { botId: opts.botId });
    return client;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger.error('stored session rejected by LINE — leaving the file in place', {
      botId: opts.botId,
      reason,
    });
    throw new PermanentAuthError(
      `stored session for "${opts.botId}" was rejected by LINE — re-authenticate via the ` +
        `/login page or \`deno task login --bot-id ${opts.botId} --force\``,
      { botId: opts.botId, reason },
    );
  }
}

type Init = ReturnType<typeof initOptions>;

function runMethod(opts: LineLoginOptions, init: Init): Promise<Client> {
  const { method } = opts;
  if (method.kind === 'authToken') return loginWithAuthToken(method.authToken, init);
  if (method.kind === 'password') {
    return loginWithPassword({
      email: method.email,
      password: method.password,
      ...(method.pincode === undefined ? {} : { pincode: method.pincode }),
      onPincodeRequest: opts.onPincode ?? noop,
    }, init);
  }
  return loginWithQrCustomDeviceName(opts, init);
}

/**
 * Same three calls as LINEJS's own `loginWithQR` (construct the client,
 * run the QR pairing flow, wrap the result) — replicated here rather than
 * imported so the device name LINE is told can be overridden first. LINEJS
 * exposes no option for this on the public `loginWithQR` entry point; the
 * values are hardcoded defaults three calls deep inside the QR v2 RPC.
 *
 * The device name is only ever announced by the "v3-support" device types
 * (DESKTOPWIN, DESKTOPMAC, IOS, ANDROID, ANDROIDSECONDARY) — the others use
 * an older RPC that sends the device *type* enum, not a free-text name, so
 * there is nothing to override for them and this override is inert.
 */
async function loginWithQrCustomDeviceName(opts: LineLoginOptions, init: Init): Promise<Client> {
  const base = new BaseClient({
    device: init.device,
    storage: init.storage,
    ...(init.fetch === undefined ? {} : { fetch: init.fetch }),
    ...(init.pushFetch === undefined ? {} : { pushFetch: init.pushFetch }),
  });
  base.on('qrcall', opts.onQrUrl ?? noop);
  base.on('pincall', opts.onPincode ?? noop);

  const display = {
    model: opts.deviceModelName ?? DEVICE_DISPLAY[opts.device].model,
    systemName: opts.deviceSystemName ?? DEVICE_DISPLAY[opts.device].systemName,
  };
  // deno-lint-ignore no-explicit-any
  const loginProcess = base.loginProcess as any;
  if (typeof loginProcess.qrCodeLoginV2ForSecure === 'function') {
    const original = loginProcess.qrCodeLoginV2ForSecure.bind(loginProcess);
    loginProcess.qrCodeLoginV2ForSecure = (authSessionId: string, nonce: string) =>
      original(authSessionId, nonce, display.model, display.systemName);
  }

  await base.loginProcess.withQrCode({});
  await base.loginProcess.ready();
  return new Client(base);
}

async function persist(client: Client, opts: LineLoginOptions): Promise<void> {
  const authToken = client.authToken;
  if (typeof authToken !== 'string' || authToken.length === 0) {
    throw new PermanentAuthError('login produced no auth token', { botId: opts.botId });
  }
  const session: StoredSession = {
    botId: opts.botId,
    authToken,
    refreshToken: asString(await client.base.storage.get('refreshToken')),
    expireSec: asNumber(await client.base.storage.get('expire')),
    savedAtMs: Date.now(),
    extra: { device: opts.device },
  };
  await opts.sessions.save(session);
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
