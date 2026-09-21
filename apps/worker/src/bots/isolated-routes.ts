import {
  type AdminRoute,
  createAdminHandler,
  createCombinedHandler,
  type StatusRoute,
} from '../admin/server.ts';
import type { UsersStore } from '../admin/users-store.ts';
import { createStatusHandler } from '../observability/server.ts';
import type { ReleaseManifest } from '../release/manifest.ts';
import type { SessionStore } from '../session/store.ts';
import type { BotHost } from './bot-host.ts';

/**
 * Console routes for exactly one bot process. Unlike tenant-routes, this
 * module never consults a registry and can never start or route to another
 * bot. Handlers are rebuilt per request because a reconnect replaces runtime
 * objects.
 */
export function createIsolatedHandler(options: {
  host: BotHost;
  users: UsersStore;
  sessions: SessionStore;
  release?: ReleaseManifest | undefined;
}): (req: Request) => Promise<Response> {
  const { host, users, sessions, release } = options;
  const admin: AdminRoute = async (req) => {
    const handler = createAdminHandler({
      worker: host.runtime?.worker,
      botId: host.botId,
      configPath: host.configPath,
      sessions,
      logger: host.logger,
      loginFlow: host.loginFlow,
      client: host.runtime?.client,
      linejsStoragePath: host.linejsStoragePath,
      users,
      setPolledRooms: host.runtime?.setRooms,
      restart: () => void host.restart(),
    });
    return await handler(req);
  };
  const status: StatusRoute = (req) =>
    createStatusHandler(host.status, { alerts: host.alerts, release })(req);
  return createCombinedHandler(admin, status, { users });
}
