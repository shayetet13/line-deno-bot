import { UsersStore } from '../../src/admin/users-store.ts';
import { BotHost } from '../../src/bots/bot-host.ts';
import { BotRegistry } from '../../src/bots/bot-registry.ts';
import type { connectToLine, LineRuntime } from '../../src/bots/connect.ts';
import { loadConfig } from '../../src/config/env.ts';
import { Logger } from '../../src/logging/logger.ts';
import { MemorySessionStore } from '../../src/session/store.ts';

export const PRIMARY_CONFIG = {
  botId: 'bot-1',
  ownerId: 'owner-1',
  square: true,
  talk: false,
  dedicatedRooms: ['m-primary-room'],
  selectedRooms: ['m-primary-room'],
  allowedSenders: ['u-someone'],
  rules: [{ id: 'go', priority: 10, kind: 'exact', pattern: 'go', reply: 'first!' }],
  dryRun: false,
  lanes: 6,
  sendReservedLanes: 1,
  pollIntervalMs: 0,
};

export const silentLogger = (): Logger => new Logger({ level: 'error', sink: () => {} });

export const noSession: typeof connectToLine = () =>
  Promise.reject(new Error('no stored session for this bot'));

/** A stand-in for a live LINE connection that records how it was torn down. */
export function fakeRuntime(log: string[], label = ''): {
  runtime: LineRuntime;
  endRun: () => void;
} {
  let endRun = (): void => {};
  const runtime = {
    worker: {
      status: { label },
      alerts: undefined,
      run: (signal: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
          endRun = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    },
    adapter: {
      stop: (): Promise<void> => {
        log.push(`${label}adapter.stop`);
        return Promise.resolve();
      },
    },
    warmer: {
      start: (): void => {
        log.push(`${label}warmer.start`);
      },
      stop: (): void => {
        log.push(`${label}warmer.stop`);
      },
    },
    lanePool: undefined,
    warmClient: undefined,
    pushClient: {
      close: (): void => {
        log.push(`${label}push.close`);
      },
    },
    client: { base: { storage: {} } },
    polledRooms: [],
    setRooms: (): Promise<void> => Promise.resolve(),
  } as unknown as LineRuntime;
  return { runtime, endRun: () => endRun() };
}

export interface Harness {
  dir: string;
  users: UsersStore;
  sessions: MemorySessionStore;
  registry: BotRegistry;
  primary: BotHost;
  hosts: Map<string, BotHost>;
  /** botIds in the order their connection was attempted. */
  connects: string[];
}

/** A temp deployment: `config/bots/bot-1.json` plus an empty users file. */
export async function makeHarness(
  dir: string,
  opts: { connect?: typeof connectToLine; primaryOwner?: string } = {},
): Promise<Harness> {
  await Deno.mkdir(`${dir}/config/bots`, { recursive: true });
  const configPath = `${dir}/config/bots/bot-1.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(PRIMARY_CONFIG));

  const users = new UsersStore(`${dir}/.control/users.json`);
  const sessions = new MemorySessionStore();
  const logger = silentLogger();
  const hosts = new Map<string, BotHost>();
  const connects: string[] = [];

  const makeHost = (botId: string, path: string): BotHost => {
    const host = new BotHost({
      botId,
      configPath: path,
      sessionsDir: `${dir}/.sessions`,
      env: loadConfig({}),
      sessions,
      logger,
      respawnDelayMs: 0,
      connect: (connectOpts) => {
        connects.push(botId);
        return (opts.connect ?? noSession)(connectOpts);
      },
    });
    hosts.set(botId, host);
    return host;
  };

  const primary = makeHost('bot-1', configPath);
  await primary.start();
  const registry = new BotRegistry({
    users,
    logger,
    primary,
    createHost: makeHost,
    botsDir: `${dir}/config/bots`,
    templatePath: configPath,
    primaryOwner: opts.primaryOwner,
  });
  return { dir, users, sessions, registry, primary, hosts, connects };
}
