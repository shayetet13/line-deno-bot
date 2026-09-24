import type { Client } from '@evex/linejs';
import { compileRules } from '../core/rules/compile.ts';
import { AppError, ValidationError } from '../errors/base.ts';
import type { Logger } from '../logging/logger.ts';
import { NO_STORE_HEADERS } from '../observability/theme.ts';
import type { Worker } from '../worker/worker.ts';
import { ACCOUNT_LOGIN_HTML } from './account-login-page.ts';
import { APP_HTML } from './app-page.ts';
import type { LoginFlow, LoginFlowState } from './login-flow.ts';
import { LOGIN_HTML } from './login-page.ts';
import { GROUPS_HTML } from './groups-page.ts';
import { verifyPassword } from './passwords.ts';
import { renderQrSvg } from './qr.ts';
import type { RuleInput } from './rules-store.ts';
import { RuleConflictError, RulesStore } from './rules-store.ts';
import { RULES_HTML } from './rules-page.ts';
import {
  clearSessionCookieHeader,
  readSessionCookie,
  SESSION_TTL_MS,
  sessionCookieHeader,
  type SessionPayload,
  signSession,
  verifySession,
} from './session-cookie.ts';
import {
  UsernameTakenError,
  UserNotFoundError,
  type UserRecord,
  UsersStore,
} from './users-store.ts';
import { USERS_HTML } from './users-page.ts';
import type { SessionStore } from '../session/store.ts';

/**
 * Mutating admin surface: edit rules, re-authenticate.
 *
 * Kept as its own module rather than folded into `observability/server.ts`
 * on purpose — that handler is read-only by construction (Playbook §13.3,
 * enforced by its own tests never touching anything but a snapshot). Giving
 * mutation its own file means a reviewer can see "this file can change state"
 * from the file list alone.
 *
 * Human login is a console account (`users-store.ts`); it is not a LINE bot login.
 * An `admin` account sees everything below exactly as before; a `user` account
 * an admin creates is confined to `/app`, a mobile-first page that only adds
 * rules and picks rooms. See
 * `createCombinedHandler`'s auth gate for the actual enforcement — this
 * file's own routes trust that gate ran first.
 */

export interface AdminServerOptions {
  /** Absent while the bot has never connected (or its session was rejected)
   * — see `cli/serve.ts`. Rules can still be edited from the file in that
   * state; there is just no live worker to push `setRules` into yet. */
  worker: Worker | undefined;
  botId: string;
  configPath: string;
  sessions: SessionStore;
  logger: Logger;
  loginFlow: LoginFlow;
  /** The live LINEJS client, when connected — lets `/api/login/logout` tell
   * LINE the session is over instead of only forgetting it locally. Absent
   * in disconnected mode, when there is nothing live to log out of. */
  client?: Client | undefined;
  /** LINEJS's own on-disk storage for this bot (refresh token, reqseq, …),
   * separate from `sessions` — logout clears both so no stale credential
   * survives to confuse a future resume. */
  linejsStoragePath: string;
  /** Defaults to a delayed `Deno.exit(0)` so the HTTP response reaches the
   * client before the process actually dies; systemd's `Restart=always`
   * brings it back. Injectable so a test never actually exits the runner. */
  restart?: () => void;
  /** Console accounts; never a source of LINE bot credentials. Absent inside a
   * bot shard: account routes are served by the console thread, which owns
   * the only writer of the account file. */
  users?: UsersStore | undefined;
  /** Mark the session cookie `Secure`. False by default — this console is
   * commonly reached over plain HTTP via an SSH tunnel or a loopback bind. */
  secureCookies?: boolean;
  /** Applies a new dedicated-poll room list to the live inbound race
   * (`adapters/linejs/racing-inbound.ts`'s `setRooms`) instead of a restart —
   * item 4 of the request. Absent in disconnected mode, same as `client`;
   * `/api/groups` falls back to `restart()` whenever this or `worker` is
   * missing, or the talk/square surface itself changes. */
  setPolledRooms?: ((rooms: readonly string[]) => Promise<void>) | undefined;
  /** See {@link AccountRoutesOptions.onUserRemoved}. */
  onUserRemoved?: ((user: UserRecord) => Promise<void>) | undefined;
}

const json = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });

const html = (body: string): Response =>
  new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...NO_STORE_HEADERS,
    },
  });

const errorStatus = (err: unknown): number => {
  if (err instanceof RuleConflictError || err instanceof UserNotFoundError) return 404;
  if (err instanceof UsernameTakenError) return 409;
  // Any other permanent AppError (ValidationError, ConfigError, ...) means
  // the request itself was bad — a 400, not a 500. Read errorClass rather
  // than enumerating subclasses so a new validation-shaped error type is
  // handled correctly here without this file needing to know about it.
  if (err instanceof AppError && err.errorClass === 'permanent') return 400;
  return 500;
};

const errorMessage = (err: unknown): string =>
  err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError('request body must be JSON');
  }
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

async function readLoginBody(req: Request): Promise<{ username: string; password: string }> {
  const b = await readJsonObject(req);
  const username = typeof b['username'] === 'string' ? b['username'] : '';
  const password = typeof b['password'] === 'string' ? b['password'] : '';
  if (username.length === 0 || password.length === 0) {
    throw new ValidationError('username and password are required');
  }
  return { username, password };
}

/** Never let a `passwordHash` leave this process. */
const sanitizeUser = (
  user: UserRecord,
): Omit<UserRecord, 'passwordHash'> => {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
};

async function readRuleInput(req: Request): Promise<RuleInput> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError('request body must be JSON');
  }
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const str = (k: string): string => (typeof b[k] === 'string' ? b[k] as string : '');
  return {
    id: str('id'),
    priority: typeof b['priority'] === 'number' ? b['priority'] : Number(b['priority']),
    kind: str('kind'),
    pattern: str('pattern'),
    reply: str('reply'),
  };
}

async function readGroupSelection(req: Request): Promise<string[]> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError('request body must be JSON');
  }
  if (
    typeof body !== 'object' || body === null ||
    !Array.isArray((body as { roomIds?: unknown }).roomIds)
  ) {
    throw new ValidationError('roomIds must be an array of group ids');
  }
  const roomIds = (body as { roomIds: unknown[] }).roomIds;
  if (!roomIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new ValidationError('every roomIds entry must be a non-empty string');
  }
  return [...new Set(roomIds as string[])];
}

interface JoinedGroup {
  id: string;
  name: string;
  kind: 'openchat' | 'talk' | 'oa';
}

interface GroupDirectory {
  groups: JoinedGroup[];
  warnings: string[];
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function loadOpenChats(client: Client): Promise<JoinedGroup[]> {
  const groups = new Map<string, JoinedGroup>();
  const recentChatIds = new Set<string>();
  const remember = (id: unknown, name: unknown): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    groups.set(id, {
      id,
      name: typeof name === 'string' && name.length > 0 ? name : id,
      kind: 'openchat',
    });
  };
  const seenTokens = new Set<string>();
  let continuationToken = '';
  const squares: Array<{ mid: string; name?: string }> = [];
  for (let page = 0; page < 10; page += 1) {
    const response = await client.base.square.getJoinedSquares({ continuationToken, limit: 100 });
    for (const square of response.squares ?? []) squares.push(square);
    const next = response.continuationToken ?? '';
    if (next === '' || seenTokens.has(next)) break;
    seenTokens.add(next);
    continuationToken = next;
  }

  // getJoinedSquareChats is not implemented by some current LINE clusters.
  // Enumerating chats from each joined Square works on those accounts and is
  // an admin-only operation, never part of the receive/reply hot path.
  for (const square of squares) {
    const tokens = new Set<string>();
    let token = '';
    for (let page = 0; page < 10; page += 1) {
      const response = await client.base.square.getJoinableSquareChats({
        request: { squareMid: square.mid, continuationToken: token, limit: 100 },
      });
      for (const chat of response.squareChats ?? []) {
        if (typeof chat.squareChatMid !== 'string' || chat.squareChatMid.length === 0) continue;
        const chatName = typeof chat.name === 'string' && chat.name.length > 0 ? chat.name : '';
        const squareName = typeof square.name === 'string' ? square.name : '';
        remember(chat.squareChatMid, chatName || squareName);
      }
      const next = response.continuationToken ?? '';
      if (next === '' || tokens.has(next)) break;
      tokens.add(next);
      token = next;
    }
  }

  // The joined-Square directory is occasionally incomplete. Recent Square
  // events contain the room MID for chats the account has actually seen, so
  // use them as a second discovery source. This is intentionally read-only
  // and happens only when the operator opens/refreshes this admin page.
  const directoryIds = new Set(groups.keys());
  try {
    const response = await client.base.square.fetchMyEvents({ limit: 200 });
    for (const event of response.events ?? []) {
      const payload = event.payload;
      const created = payload?.notifiedCreateSquareChatMember?.chat;
      if (created !== undefined) {
        recentChatIds.add(created.squareChatMid);
        remember(created.squareChatMid, created.name);
      }
      const message = payload?.notificationMessage;
      if (message !== undefined) {
        recentChatIds.add(message.squareChatMid);
        remember(message.squareChatMid, undefined);
      }
      const joined = payload?.notificationNewChatMember;
      if (joined !== undefined) {
        recentChatIds.add(joined.squareChatMid);
        remember(joined.squareChatMid, joined.squareChatName);
      }
      const reaction = payload?.notificationMessageReaction;
      if (reaction !== undefined) {
        recentChatIds.add(reaction.squareChatMid);
        remember(reaction.squareChatMid, reaction.squareChatName);
      }
    }
    // Verify candidates and replace placeholder names with the chat's own
    // name. Cap this extra admin-only lookup to bound a very old account.
    for (const id of [...recentChatIds].slice(0, 100)) {
      try {
        const chat = (await client.base.square.getSquareChat({ squareChatMid: id })).squareChat;
        remember(chat.squareChatMid, chat.name);
      } catch {
        // A historical room may have been left/deleted; keep only the
        // directory result when LINE no longer permits direct access.
        if (!directoryIds.has(id)) groups.delete(id);
      }
    }
  } catch {
    // The authoritative directory above still provides whatever this LINE
    // cluster supports; a history failure must not blank the entire page.
  }
  return [...groups.values()];
}

async function loadTalkChats(client: Client): Promise<JoinedGroup[]> {
  const mids = await client.base.talk.getAllChatMids({
    request: { withMemberChats: true, withInvitedChats: false },
    syncReason: 'INTERNAL',
  });
  const groups: JoinedGroup[] = [];
  for (const batch of chunks(mids.memberChatMids ?? [], 100)) {
    const response = await client.base.talk.getChats({
      chatMids: batch,
      withInvitees: false,
      withMembers: false,
    });
    for (const chat of response.chats ?? []) {
      if (typeof chat.chatMid !== 'string' || !/^[cr]/.test(chat.chatMid)) continue;
      groups.push({
        id: chat.chatMid,
        name: typeof chat.chatName === 'string' && chat.chatName.length > 0
          ? chat.chatName
          : chat.chatMid,
        kind: 'talk',
      });
    }
  }
  return groups;
}

async function loadOfficialAccounts(client: Client): Promise<JoinedGroup[]> {
  const mids = await client.base.talk.getAllContactIds({ syncReason: 'INTERNAL' });
  const groups: JoinedGroup[] = [];
  for (const batch of chunks(mids.filter((mid) => mid.startsWith('u')), 100)) {
    const response = await client.base.talk.getContactsV2({ mids: batch });
    for (const [mid, entry] of Object.entries(response.contacts ?? {})) {
      const contact = entry.contact;
      if (contact?.capableBuddy !== true) continue;
      groups.push({
        id: mid,
        name: typeof contact.displayName === 'string' && contact.displayName.length > 0
          ? contact.displayName
          : mid,
        kind: 'oa',
      });
    }
  }
  return groups;
}

async function loadJoinedGroups(
  client: Client,
  knownOpenChatIds: readonly string[] = [],
): Promise<GroupDirectory> {
  const loaders = [
    ['OpenChat', loadOpenChats(client)],
    ['Talk', loadTalkChats(client)],
    ['LINE OA', loadOfficialAccounts(client)],
  ] as const;
  const settled = await Promise.allSettled(loaders.map(([, pending]) => pending));
  const groups = new Map<string, JoinedGroup>();
  const warnings: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      for (const group of result.value) groups.set(group.id, group);
      return;
    }
    warnings.push(`${loaders[index]?.[0] ?? 'LINE'}: ${errorMessage(result.reason)}`);
  });
  // Some LINE clusters return no joined-chat directory even though direct
  // access to an already configured OpenChat works. Resolve those known IDs
  // explicitly so they remain selectable, named, and valid on the next save.
  for (const id of new Set(knownOpenChatIds.filter((mid) => mid.startsWith('m')))) {
    if (groups.has(id)) continue;
    try {
      const response = await client.base.square.getSquareChat({ squareChatMid: id });
      const chat = response.squareChat;
      groups.set(id, {
        id,
        name: typeof chat?.name === 'string' && chat.name.length > 0 ? chat.name : id,
        kind: 'openchat',
      });
    } catch (err: unknown) {
      warnings.push(`OpenChat ${id}: ${errorMessage(err)}`);
    }
  }
  return {
    groups: [...groups.values()].sort((a, b) =>
      a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    ),
    warnings,
  };
}

async function loginStatusPayload(opts: AdminServerOptions): Promise<Record<string, unknown>> {
  const stored = await opts.sessions.load(opts.botId).catch(() => null);
  const flow = await withQr(opts.loginFlow);
  return {
    botSession: stored === null
      ? null
      : { savedAtMs: stored.savedAtMs, expireSec: stored.expireSec },
    flow,
  };
}

/** Adds the rendered QR SVG and elapsed time to a `running` flow state for the
 * JSON response. Kept out of `LoginFlow` itself so that class stays free of
 * rendering concerns — it only ever holds the raw URL string LINEJS handed
 * it; `elapsedMs` it computes itself, since it already owns the clock. */
async function withQr(flow: LoginFlow): Promise<Record<string, unknown>> {
  const state: LoginFlowState = flow.state;
  if (state.status !== 'running') return state;
  const qrSvg = state.qrUrl === undefined ? undefined : await renderQrSvg(state.qrUrl);
  return { ...state, qrSvg, elapsedMs: flow.elapsedMs };
}

/** Every path this module owns. Exported so the caller wiring routes
 * together (`cli/serve.ts`) does not have to duplicate or guess the list. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/rules' || pathname === '/groups' || pathname === '/login' ||
    pathname.startsWith('/api/rules') || pathname === '/api/groups' ||
    pathname.startsWith('/api/login/') || pathname === '/api/admin/restart' ||
    pathname === '/account/login' || pathname === '/account/logout' ||
    pathname.startsWith('/api/account/') || pathname === '/users' ||
    pathname === '/api/users' || pathname.startsWith('/api/users/') || pathname === '/app';
}

/** Paths only an `admin` account may reach — everything that isn't the new
 * per-user `/app` page or an account-management endpoint any signed-in role
 * may use. This is item 6 of the request: logging in as admin still shows
 * the dashboard, rules and groups pages exactly as before; a `user` account
 * is confined to `/app`.
 *
 * `/api/login/*` and `/api/admin/restart` are deliberately NOT admin-only: a
 * `user` account is the one actually operating this bot day to day, and
 * connecting/reconnecting it to LINE — including the restart that picks up
 * a freshly scanned session, same as `LoginFlow`'s own docs describe — is
 * part of that. `/app` embeds the same QR flow `/login` (the admin-only
 * page) shows, against these same endpoints. Only the `/login` *page*
 * itself stays admin-only; `/app` is where a `user` account does it. */
function isAdminOnlyPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/rules' || pathname === '/groups') return true;
  if (pathname === '/login') return true;
  if (pathname === '/users' || pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    return true;
  }
  // /api/status stays open to a `user` account too: `status` above always
  // resolves it to the signed-in person's OWN bot (`registry.hostFor(ctx.user)`
  // in the multi-user router, the single bot otherwise), so there is no
  // cross-tenant data to protect — and it is what `/app`'s live speed panel
  // reads. /api/alerts is a separate, admin-only concern (paging/alerting
  // config), so it stays gated.
  return pathname === '/api/alerts';
}

const PUBLIC_PATHS = new Set(['/account/login', '/api/account/login']);

/** A GET for an HTML page gets a redirect on an auth failure; anything else
 * (an API call, however it was made) gets a JSON error status instead. */
const wantsHtmlRedirect = (req: Request, pathname: string): boolean =>
  req.method === 'GET' && !pathname.startsWith('/api/');

export interface AuthGateOptions {
  users: UsersStore;
  /** Injectable so a test can pin "now" instead of depending on the clock. */
  now?: () => number;
}

/** Who a gated request belongs to. Handed to the routes so they can pick THAT
 * person's bot instead of a single process-wide one. Absent on the few public
 * paths (health, the login page, logout). */
export interface AuthContext {
  user: UserRecord;
}

export type AdminRoute = (req: Request, ctx?: AuthContext) => Promise<Response>;
export type StatusRoute = (req: Request, ctx?: AuthContext) => Response | Promise<Response>;

/**
 * Combines this module's routes with the read-only status handler, behind
 * one login gate: `/api/health` and the explicitly public account-login
 * paths pass straight through; everything else needs a valid session
 * cookie, and an admin-only path needs an admin session. `status` stays a
 * plain synchronous function throughout the codebase (probe/bench build one
 * with no admin surface and no auth at all) — only this composition knows
 * about logins.
 *
 * A cookie is only a claim of who the caller is: it is signed, but it lives
 * for weeks. So the account is looked up again on every request — a deleted
 * person's cookie stops working at once, and a demoted admin loses admin
 * pages at once instead of when the cookie happens to expire.
 */
export function createCombinedHandler(
  admin: AdminRoute,
  status: StatusRoute,
  auth: AuthGateOptions,
): (req: Request) => Promise<Response> {
  const route = (req: Request, ctx?: AuthContext): Promise<Response> | Response =>
    isAdminPath(new URL(req.url).pathname) ? admin(req, ctx) : status(req, ctx);

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/health' || PUBLIC_PATHS.has(pathname)) return await route(req);
    if (pathname === '/account/logout') return await admin(req);

    const token = readSessionCookie(req);
    const now = auth.now?.() ?? Date.now();
    const session = token === undefined
      ? undefined
      : await verifySession(token, await auth.users.secret(), now);
    const user = session === undefined ? undefined : await auth.users.findById(session.userId);
    if (user === undefined) {
      return wantsHtmlRedirect(req, pathname)
        ? Response.redirect(new URL('/account/login', req.url), 302)
        : json({ error: 'unauthorized — log in first' }, 401);
    }
    if (isAdminOnlyPath(pathname) && user.role !== 'admin') {
      return wantsHtmlRedirect(req, pathname)
        ? Response.redirect(new URL('/app', req.url), 302)
        : json({ error: 'forbidden — admin only' }, 403);
    }
    return await route(req, { user });
  };
}

export interface AccountRoutesOptions {
  users: UsersStore;
  secureCookies?: boolean;
  /** Runs after a user is deleted, so whatever they owned (their bot) can be
   * shut down with them. */
  onUserRemoved?: (user: UserRecord) => Promise<void>;
}

/**
 * Everything about who a person IS — login, logout, their own password, and
 * an admin managing other people — and nothing about any bot. Split from the
 * bot routes so the login gate can serve them before it knows whose bot to
 * load, and so no route in here can reach a bot by accident.
 *
 * Returns `undefined` for a path it does not own; errors propagate to the
 * caller's handler.
 */
function createAccountRoutes(
  opts: AccountRoutesOptions,
): (req: Request) => Promise<Response | undefined> {
  const { users, onUserRemoved } = opts;
  const secureCookies = opts.secureCookies ?? false;

  /** Re-derives the caller's session — the gate already checked one exists
   * before routing here, but does not pass it through, so endpoints that need
   * to know *who* look it up again the same way. */
  const currentSession = async (req: Request): Promise<SessionPayload | undefined> => {
    const token = readSessionCookie(req);
    if (token === undefined) return undefined;
    return await verifySession(token, await users.secret(), Date.now());
  };

  return async (req: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(req.url);
    const method = req.method;
    if (pathname === '/users' && method === 'GET') return html(USERS_HTML);
    if (pathname === '/account/login' && method === 'GET') return html(ACCOUNT_LOGIN_HTML);
    if (pathname === '/account/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/account/login',
          'set-cookie': clearSessionCookieHeader({ secure: secureCookies }),
        },
      });
    }
    if (pathname === '/api/account/login' && method === 'POST') {
      const { username, password } = await readLoginBody(req);
      const user = await users.findByUsername(username);
      const ok = user !== undefined && await verifyPassword(password, user.passwordHash);
      if (!ok || user === undefined) {
        return json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, 401);
      }
      const token = await signSession(
        {
          userId: user.userId,
          username: user.username,
          role: user.role,
          exp: Date.now() + SESSION_TTL_MS,
        },
        await users.secret(),
      );
      return json({ ok: true, role: user.role }, 200, {
        'set-cookie': sessionCookieHeader(token, { secure: secureCookies }),
      });
    }
    if (pathname === '/api/account/me' && method === 'GET') {
      const session = await currentSession(req);
      if (session === undefined) return json({ error: 'unauthorized' }, 401);
      return json({ username: session.username, role: session.role });
    }
    if (pathname === '/api/account/password' && method === 'PUT') {
      const session = await currentSession(req);
      if (session === undefined) return json({ error: 'unauthorized' }, 401);
      const b = await readJsonObject(req);
      const password = typeof b['password'] === 'string' ? b['password'] : '';
      await users.setPassword(session.userId, password);
      return json({ ok: true });
    }

    if (pathname === '/api/users' && method === 'GET') {
      return json({ users: (await users.list()).map(sanitizeUser) });
    }
    if (pathname === '/api/users' && method === 'POST') {
      const b = await readJsonObject(req);
      const username = b['username'];
      const password = b['password'];
      const displayName = b['displayName'];
      const user = await users.create({
        username: typeof username === 'string' ? username : '',
        password: typeof password === 'string' ? password : '',
        role: b['role'] === 'admin' ? 'admin' : 'user',
        ...(typeof displayName === 'string' ? { displayName } : {}),
      });
      return json({ user: sanitizeUser(user) }, 201);
    }
    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === 'PUT') {
      const userId = decodeURIComponent(userMatch[1] ?? '');
      const b = await readJsonObject(req);
      const newPassword = b['password'];
      if (typeof newPassword === 'string' && newPassword.length > 0) {
        await users.setPassword(userId, newPassword);
      }
      const role = b['role'];
      if (role === 'admin' || role === 'user') {
        await users.setRole(userId, role);
      }
      const updated = await users.findById(userId);
      if (updated === undefined) {
        throw new UserNotFoundError(`no user with id "${userId}"`, { userId });
      }
      return json({ user: sanitizeUser(updated) });
    }
    if (userMatch && method === 'DELETE') {
      const userId = decodeURIComponent(userMatch[1] ?? '');
      const target = await users.findById(userId);
      await users.remove(userId);
      if (target !== undefined) await onUserRemoved?.(target);
      return json({ ok: true });
    }

    return undefined;
  };
}

/** Account routes for a signed-in request, answered on the console thread
 * before anything is forwarded to a bot shard. `undefined` means "not an
 * account path — forward it"; a failure is answered here, as JSON. */
export function createAccountRouter(
  opts: AccountRoutesOptions & { logger: Logger },
): (req: Request) => Promise<Response | undefined> {
  const routes = createAccountRoutes(opts);
  return async (req: Request): Promise<Response | undefined> => {
    try {
      return await routes(req);
    } catch (err: unknown) {
      opts.logger.error('account request failed', {
        path: new URL(req.url).pathname,
        method: req.method,
        error: errorMessage(err),
      });
      return json({ error: errorMessage(err) }, errorStatus(err));
    }
  };
}

/** Standalone account handler for requests that have no signed-in user (and so
 * no bot): the login page, the login POST and logout. */
export function createAccountHandler(
  opts: AccountRoutesOptions & { logger: Logger },
): (req: Request) => Promise<Response> {
  const routes = createAccountRoutes(opts);
  return async (req: Request): Promise<Response> => {
    try {
      return await routes(req) ?? json({ error: 'not found' }, 404);
    } catch (err: unknown) {
      opts.logger.error('account request failed', {
        path: new URL(req.url).pathname,
        method: req.method,
        error: errorMessage(err),
      });
      return json({ error: errorMessage(err) }, errorStatus(err));
    }
  };
}

export function createAdminHandler(
  options: AdminServerOptions,
): (req: Request) => Promise<Response> {
  const rulesStore = new RulesStore(options.configPath);
  const restart = options.restart ?? (() => {
    setTimeout(() => Deno.exit(0), 250);
  });
  const account = options.users === undefined ? undefined : createAccountRoutes({
    users: options.users,
    ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    ...(options.onUserRemoved === undefined ? {} : { onUserRemoved: options.onUserRemoved }),
  });

  const applyRules = async (): Promise<unknown[]> => {
    const config = await rulesStore.list();
    // No worker yet (not connected to LINE) — the edit still saves to disk
    // and takes effect the moment a connection is established.
    options.worker?.setRules(compileRules(config));
    return config as unknown[];
  };

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const method = req.method;

    try {
      const accountResponse = await account?.(req);
      if (accountResponse !== undefined) return accountResponse;

      if (pathname === '/rules' && method === 'GET') return html(RULES_HTML);
      if (pathname === '/groups' && method === 'GET') return html(GROUPS_HTML);
      if (pathname === '/login' && method === 'GET') return html(LOGIN_HTML);
      if (pathname === '/app' && method === 'GET') return html(APP_HTML);

      if (pathname === '/api/groups' && method === 'GET') {
        const config = await rulesStore.config();
        const selected = new Set(config.selectedRooms ?? config.dedicatedRooms);
        const directory = options.client === undefined
          ? { groups: [], warnings: [] }
          : await loadJoinedGroups(options.client, [...selected, ...config.dedicatedRooms]);
        const groups = directory.groups.map((group) => ({
          ...group,
          selected: selected.has(group.id),
          fastPoll: config.dedicatedRooms.includes(group.id),
        }));
        for (const id of selected) {
          if (!groups.some((group) => group.id === id)) {
            groups.push({
              id,
              name: `${id} (ตั้งค่าไว้ แต่ LINE ไม่ส่งกลับมา)`,
              kind: id.startsWith('m') ? 'openchat' : id.startsWith('u') ? 'oa' : 'talk',
              selected: true,
              fastPoll: config.dedicatedRooms.includes(id),
            });
          }
        }
        return json({
          connected: options.client !== undefined,
          pollLimit: config.slotBudget,
          selectionMode: config.selectedRooms === undefined ? 'all' : 'selected',
          groups,
          warnings: directory.warnings,
        });
      }
      if (pathname === '/api/groups' && method === 'POST') {
        if (options.client === undefined) {
          throw new ValidationError('LINE is not connected — cannot validate group selection');
        }
        const roomIds = await readGroupSelection(req);
        if (roomIds.length === 0) {
          throw new ValidationError('select at least one LINE OA, OpenChat, or Talk group');
        }
        const config = await rulesStore.config();
        const directory = await loadJoinedGroups(options.client, [
          ...(config.selectedRooms ?? []),
          ...config.dedicatedRooms,
        ]);
        const joinedIds = new Set(directory.groups.map((group) => group.id));
        const unknown = roomIds.filter((id) => !joinedIds.has(id));
        if (unknown.length > 0) {
          throw new ValidationError(`groups are not joined by this account: ${unknown.join(', ')}`);
        }
        const kinds = new Map(directory.groups.map((group) => [group.id, group.kind]));
        const dedicatedRooms = roomIds
          .filter((id) => kinds.get(id) === 'openchat')
          .slice(0, config.slotBudget);
        const surfaces = {
          talk: roomIds.some((id) => kinds.get(id) === 'talk' || kinds.get(id) === 'oa'),
          square: roomIds.some((id) => kinds.get(id) === 'openchat'),
        };
        const before = config.selectedRooms;
        const changed = before === undefined || roomIds.length !== before.length ||
          roomIds.some((id, index) => id !== before[index]) ||
          dedicatedRooms.length !== config.dedicatedRooms.length ||
          dedicatedRooms.some((id, index) => id !== config.dedicatedRooms[index]) ||
          config.talk !== surfaces.talk || config.square !== surfaces.square;
        // Which surfaces PUSH subscribes to is fixed at connect time — a
        // change there still needs a fresh connection. Which rooms are
        // selected, and which of those get a dedicated poll, can apply to
        // the live worker directly (item 4 of the request: switching rooms
        // must not restart the bot or drop the login session).
        const surfacesChanged = config.talk !== surfaces.talk || config.square !== surfaces.square;
        const canApplyLive = options.worker !== undefined && options.setPolledRooms !== undefined;
        let restarted = false;
        if (changed) {
          await rulesStore.setSelectedRooms(roomIds, dedicatedRooms, surfaces);
          options.logger.warn('admin changed selected groups', {
            groups: roomIds.length,
            fastPoll: dedicatedRooms.length,
            surfacesChanged,
            appliedLive: !surfacesChanged && canApplyLive,
          });
          if (surfacesChanged || !canApplyLive) {
            restarted = true;
            restart();
          } else {
            // Widen (or narrow) what the worker will answer FIRST: a newly
            // selected room is answerable via push the instant this line
            // runs, and a deselected one stops being answered immediately —
            // neither depends on the dedicated-poll churn below. Doing this
            // after would leave a window where a dedicated poll could
            // deliver a message for a room the worker no longer considers
            // selected.
            options.worker?.setSelectedRooms(roomIds);
            await options.setPolledRooms?.(dedicatedRooms);
          }
        }
        return json({ ok: true, changed, restarted, roomIds, dedicatedRooms, surfaces });
      }

      if (pathname === '/api/rules' && method === 'GET') {
        return json({ rules: await rulesStore.list() });
      }
      if (pathname === '/api/rules' && method === 'POST') {
        const input = await readRuleInput(req);
        await rulesStore.add(input);
        return json({ rules: await applyRules() }, 201);
      }
      const ruleMatch = pathname.match(/^\/api\/rules\/([^/]+)$/);
      if (ruleMatch && method === 'PUT') {
        const id = decodeURIComponent(ruleMatch[1] ?? '');
        const input = await readRuleInput(req);
        await rulesStore.update(id, { ...input, id });
        return json({ rules: await applyRules() });
      }
      if (ruleMatch && method === 'DELETE') {
        const id = decodeURIComponent(ruleMatch[1] ?? '');
        await rulesStore.remove(id);
        return json({ rules: await applyRules() });
      }

      if (pathname === '/api/login/status' && method === 'GET') {
        return json(await loginStatusPayload(options));
      }
      if (pathname === '/api/login/start' && method === 'POST') {
        options.loginFlow.start();
        return json({ ok: true });
      }
      if (pathname === '/api/login/reset' && method === 'POST') {
        options.loginFlow.reset();
        return json({ ok: true });
      }
      if (pathname === '/api/login/logout' && method === 'POST') {
        options.logger.warn('admin-triggered logout', { botId: options.botId });
        // Tell LINE first, best-effort: a token already dead on LINE's side (or
        // no live client at all, in disconnected mode) must not stop the local
        // session from being cleared — that half is what actually lets a fresh
        // QR login work again.
        if (options.client !== undefined) {
          await options.client.base.auth.logoutZ().catch((err: unknown) => {
            options.logger.warn('LINE logoutZ failed — clearing the local session anyway', {
              botId: options.botId,
              reason: errorMessage(err),
            });
          });
        }
        await options.sessions.remove(options.botId);
        await Deno.remove(options.linejsStoragePath).catch((err: unknown) => {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        });
        // The live client (if any) is now disabled/token-less either way, so
        // there is nothing left for this process to usefully keep running —
        // restart into disconnected mode, same as a rejected session does.
        restart();
        return json({ ok: true, note: 'logged out — restarting into disconnected mode' });
      }
      if (pathname === '/api/admin/restart' && method === 'POST') {
        options.logger.warn('admin-triggered restart', { botId: options.botId });
        restart();
        return json({ ok: true, note: 'restarting — systemd will bring the worker back' });
      }

      return json({ error: 'not found' }, 404);
    } catch (err: unknown) {
      options.logger.error('admin request failed', {
        path: pathname,
        method,
        error: errorMessage(err),
      });
      return json({ error: errorMessage(err) }, errorStatus(err));
    }
  };
}
