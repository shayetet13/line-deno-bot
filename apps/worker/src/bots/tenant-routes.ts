import {
  type AdminRoute,
  createAccountHandler,
  createAccountRouter,
  createAdminHandler,
  type StatusRoute,
} from '../admin/server.ts';
import type { UsersStore } from '../admin/users-store.ts';
import type { Logger } from '../logging/logger.ts';
import { createStatusHandler } from '../observability/server.ts';
import type { ReleaseManifest } from '../release/manifest.ts';
import type { SessionStore } from '../session/store.ts';
import type { BotHost } from './bot-host.ts';
import type { BotRegistry } from './bot-registry.ts';
import type { ShardedBotHost } from './shard-pool.ts';

/**
 * Turns "one console, one bot" into "one console, everyone's own bot".
 *
 * `createCombinedHandler` authenticates a request and passes the signed-in
 * user here; this picks that user's `BotHost` and builds the ordinary
 * single-bot admin/status handlers over it. Those handlers are unchanged and
 * still know nothing about other people — isolation comes from the fact that
 * they are only ever built over the caller's own host.
 */

export interface TenantRoutesOptions {
  registry: BotRegistry;
  users: UsersStore;
  sessions: SessionStore;
  logger: Logger;
  release?: ReleaseManifest | undefined;
  secureCookies?: boolean;
}

export interface TenantRoutes {
  admin: AdminRoute;
  status: StatusRoute;
}

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

export function createTenantRoutes(options: TenantRoutesOptions): TenantRoutes {
  const { registry, users, sessions, logger, release } = options;
  const secureCookies = options.secureCookies ?? false;

  const account = createAccountHandler({
    users,
    logger,
    secureCookies,
    onUserRemoved: (user) => registry.release(user),
  });

  // Rebuilt per request on purpose: a host's worker, client and room-apply
  // hook are replaced whenever its owner restarts it, and a handler built
  // once would keep pointing at the connection that was torn down.
  const adminFor = (host: BotHost): AdminRoute =>
    createAdminHandler({
      worker: host.runtime?.worker,
      botId: host.botId,
      configPath: host.configPath,
      sessions,
      logger: host.logger,
      loginFlow: host.loginFlow,
      client: host.runtime?.client,
      linejsStoragePath: host.linejsStoragePath,
      users,
      secureCookies,
      setPolledRooms: host.runtime?.setRooms,
      restart: () => {
        void host.restart();
      },
      onUserRemoved: (user) => registry.release(user),
    });

  const admin: AdminRoute = async (req, ctx) => {
    if (ctx === undefined) return await account(req);
    try {
      return await adminFor(await registry.hostFor(ctx.user))(req);
    } catch (err: unknown) {
      logger.error('could not load the signed-in user’s bot', {
        userId: ctx.user.userId,
        error: errorMessage(err),
      });
      return new Response(JSON.stringify({ error: errorMessage(err) }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  };

  // Only `/api/health` arrives without a user; it describes the bot the
  // process was started with, which is what the deploy health check is about.
  const status: StatusRoute = async (req, ctx) => {
    const host = ctx === undefined ? registry.primary : await registry.hostFor(ctx.user);
    return createStatusHandler(host.status, { alerts: host.alerts, release })(req);
  };

  return { admin, status };
}

export interface ShardedTenantRoutesOptions {
  registry: BotRegistry<ShardedBotHost>;
  users: UsersStore;
  logger: Logger;
  secureCookies?: boolean;
}

/**
 * The same tenancy as {@link createTenantRoutes}, with each bot running in a
 * bot shard. Accounts stay here — this thread is the only writer of the
 * account file — and every other request is forwarded to the one shard that
 * runs the signed-in person's own bot, which answers it with the ordinary
 * single-bot handlers. Ownership is decided here, before forwarding, exactly
 * as before: a shard is only ever asked about the bot the caller owns.
 */
export function createShardedTenantRoutes(options: ShardedTenantRoutesOptions): TenantRoutes {
  const { registry, users, logger } = options;
  const secureCookies = options.secureCookies ?? false;
  const accountOptions = {
    users,
    logger,
    secureCookies,
    onUserRemoved: (user: Parameters<typeof registry.release>[0]) => registry.release(user),
  };
  const account = createAccountHandler(accountOptions);
  const accountRouter = createAccountRouter(accountOptions);

  const forward = async (host: ShardedBotHost, req: Request): Promise<Response> => {
    try {
      return await host.fetch(req);
    } catch (err: unknown) {
      logger.error('bot shard could not answer', {
        botId: host.botId,
        shard: host.shardId,
        error: errorMessage(err),
      });
      return new Response(JSON.stringify({ error: errorMessage(err) }), {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  };

  const admin: AdminRoute = async (req, ctx) => {
    if (ctx === undefined) return await account(req);
    const own = await accountRouter(req);
    if (own !== undefined) return own;
    return await forward(await registry.hostFor(ctx.user), req);
  };

  const status: StatusRoute = async (req, ctx) =>
    await forward(ctx === undefined ? registry.primary : await registry.hostFor(ctx.user), req);

  return { admin, status };
}
