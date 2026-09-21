import {
  type AdminRoute,
  createAccountHandler,
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
