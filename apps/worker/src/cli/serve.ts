import { dirname } from 'node:path';
import { parseArgs } from '@std/cli/parse-args';
import { createCombinedHandler } from '../admin/server.ts';
import { UsersStore } from '../admin/users-store.ts';
import { BotHost } from '../bots/bot-host.ts';
import { BotRegistry } from '../bots/bot-registry.ts';
import type { LineRuntime } from '../bots/connect.ts';
import { BoundedConnectionWarmupGate } from '../bots/connection-warmup-gate.ts';
import { createIsolatedHandler } from '../bots/isolated-routes.ts';
import { type ShardedBotHost, ShardPool } from '../bots/shard-pool.ts';
import { createShardedTenantRoutes, createTenantRoutes } from '../bots/tenant-routes.ts';
import { type BotConfig, loadBotConfig } from '../config/bot-config.ts';
import { loadConfig, resolveBotShards, type WorkerConfig } from '../config/env.ts';
import { ConfigError } from '../errors/base.ts';
import { systemClock } from '../lib/clock.ts';
import { Logger } from '../logging/logger.ts';
import { startThreadLoopLag } from '../metrics/loop-lag.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import type { AlertEvaluator } from '../monitoring/alerts.ts';
import { type RunningStatusServer, startStatusServer } from '../observability/server.ts';
import { StatusSource } from '../observability/snapshot.ts';
import { describeRelease } from '../release/describe.ts';
import type { ReleaseManifest } from '../release/manifest.ts';
import { FileSessionStore } from '../session/store.ts';
import { writeErr, writeLine } from './console.ts';

const USAGE = `
Runs the worker: receives, matches, and answers — the production entry point.

  deno task serve --config config/bots/<bot>.json [options]

The bot config says which rooms, which senders and which rules. It also holds
\`dryRun\`, which defaults to TRUE when absent: the full pipeline runs and the
reply is logged instead of posted. Set "dryRun": false to actually answer.

By default this command is one isolated process for exactly the bot in
--config. It never starts another bot. Run one service instance per bot.

Options
  --config <path>      Required. Bot config JSON.
  --sessions-dir <p>   Default .sessions
  --users-file <p>     Human accounts file (default .control/users.json).
  --primary-owner <u>  Username that owns the bot given by --config. Default:
                       the first admin to sign in.
  --multi-bot          Multi-user console mode. Starts every owned bot and
                       routes each signed-in person to their own bot. Bots
                       run in BOT_SHARDS worker threads (default: one per
                       core, minus one); BOT_SHARDS=0 keeps them all on the
                       console thread.
  --port <n>           Operator console port (default 8791).
  --host <addr>        Address the console binds (default 127.0.0.1). Use
                       0.0.0.0 only behind a firewall or in a container that
                       publishes it deliberately; every page but the login
                       page and /api/health needs a signed-in account.
  --no-serve           Do not start the console.
  --dry-run            Force dry run regardless of the config file.
  --show-text          Log reply bodies in dry run. OFF by default.
  --seconds <n>        Stop after n seconds. Default: run until SIGINT/SIGTERM.
`.trim();

interface Flags {
  config: string;
  dir: string;
  usersFile: string;
  primaryOwner: string | undefined;
  host: string;
  port: number;
  serve: boolean;
  forceDryRun: boolean;
  showText: boolean;
  multiBot: boolean;
  seconds: number | undefined;
}

function parse(args: string[]): Flags {
  const f = parseArgs(args, {
    string: ['config', 'sessions-dir', 'users-file', 'primary-owner', 'host', 'port', 'seconds'],
    boolean: ['help', 'serve', 'dry-run', 'show-text', 'multi-bot'],
    default: {
      'sessions-dir': '.sessions',
      'users-file': '.control/users.json',
      host: '127.0.0.1',
      port: '8791',
      serve: true,
    },
  });
  if (f.help) {
    writeLine(USAGE);
    Deno.exit(0);
  }
  if (typeof f.config !== 'string' || f.config === '') {
    throw new ConfigError('--config is required (see --help)');
  }
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1) throw new ConfigError('--port must be a port number');
  if (typeof f.host !== 'string' || !/^[0-9A-Za-z.:[\]-]+$/.test(f.host)) {
    throw new ConfigError('--host must be an address such as 127.0.0.1 or 0.0.0.0');
  }
  const seconds = f.seconds === undefined ? undefined : Number(f.seconds);
  if (seconds !== undefined && !Number.isFinite(seconds)) {
    throw new ConfigError('--seconds must be a number');
  }
  return {
    config: f.config,
    dir: f['sessions-dir'],
    usersFile: f['users-file'],
    primaryOwner: f['primary-owner'],
    host: f.host,
    port,
    serve: f.serve,
    forceDryRun: f['dry-run'],
    showText: f['show-text'],
    multiBot: f['multi-bot'],
    seconds,
  };
}

/** What the rest of `main` needs from whichever topology is running. */
interface Topology {
  handler: (req: Request) => Promise<Response>;
  /** The primary bot's status source, or a placeholder when it runs in a shard. */
  status: StatusSource;
  alerts: AlertEvaluator | undefined;
  /** The primary bot's live runtime; undefined when disconnected or sharded. */
  runtime: LineRuntime | undefined;
  isolation: string;
  close(): Promise<void>;
}

interface TopologyDeps {
  flags: Flags;
  env: WorkerConfig;
  bot: BotConfig;
  logger: Logger;
  users: UsersStore;
  release: ReleaseManifest;
}

/** Every bot on this thread: `--multi-bot` with `BOT_SHARDS=0`, or the
 * one-bot isolated process. */
async function startInProcess(d: TopologyDeps): Promise<Topology> {
  const { flags, env, logger, users, release } = d;
  const sessions = new FileSessionStore(flags.dir);
  // One gate for every account in this process. It is used only while a
  // connection is built or rebuilt; replies continue to submit concurrently.
  const connectionWarmupGate = new BoundedConnectionWarmupGate(env.connectionWarmupConcurrency);
  const makeHost = (botId: string, configPath: string): BotHost =>
    new BotHost({
      botId,
      configPath,
      sessionsDir: flags.dir,
      env,
      sessions,
      logger: logger.child({ bot: botId }),
      forceDryRun: flags.forceDryRun,
      showText: flags.showText,
      connectionWarmupGate,
    });

  // A missing or rejected session must not take the whole process down: the
  // /app page is how an operator fixes that, and it cannot help anyone if the
  // process that would serve it already exited (this is the 2026-09-11
  // "dashboard is 502 because the bot won't log in" report). `BotHost.start`
  // therefore never rejects — it falls back to disconnected mode.
  const primary = makeHost(d.bot.botId, flags.config);
  await primary.start();

  const registry = flags.multiBot
    ? new BotRegistry({ ...registryOptions(d), primary, createHost: makeHost })
    : undefined;
  if (registry !== undefined) restoreOwned(registry, logger);
  const handler = registry === undefined
    ? createIsolatedHandler({ host: primary, users, sessions, release })
    : (() => {
      const tenant = createTenantRoutes({ registry, users, sessions, logger, release });
      return createCombinedHandler(tenant.admin, tenant.status, { users });
    })();
  return {
    handler,
    status: primary.status,
    alerts: primary.alerts,
    runtime: primary.runtime,
    isolation: registry === undefined
      ? 'this process owns this bot only'
      : 'multi-user bot routing enabled (all bots on one thread — BOT_SHARDS=0)',
    close: () => registry === undefined ? primary.close() : registry.closeAll(),
  };
}

/** `--multi-bot` with bot shards: this thread serves the console and the
 * account registry; every bot's LINE connection runs in a shard thread. */
async function startSharded(d: TopologyDeps, shards: number): Promise<Topology> {
  const { flags, env, logger, users, release } = d;
  const pool = new ShardPool({
    shards,
    logger,
    init: {
      sessionsDir: flags.dir,
      forceDryRun: flags.forceDryRun,
      showText: flags.showText,
      release,
      // The process-wide warm-up budget, split across the shards.
      warmupConcurrency: Math.max(1, Math.floor(env.connectionWarmupConcurrency / shards)),
      logLevel: env.logLevel,
    },
  });
  const primary = pool.hostFor(d.bot.botId, flags.config);
  await primary.start();
  const registry = new BotRegistry<ShardedBotHost>({
    ...registryOptions(d),
    primary,
    createHost: (botId, configPath) => pool.hostFor(botId, configPath),
  });
  restoreOwned(registry, logger);
  const tenant = createShardedTenantRoutes({ registry, users, logger });
  return {
    handler: createCombinedHandler(tenant.admin, tenant.status, { users }),
    // The console thread has no bot of its own; /api/health and /api/status
    // are forwarded to the primary's shard by the tenant routes.
    status: new StatusSource({
      workerId: 'console',
      origin: 'sharded',
      clock: systemClock,
      metrics: new MetricsRecorder(),
    }),
    alerts: undefined,
    runtime: undefined,
    isolation: `multi-user bot routing across ${String(pool.size)} bot shard thread(s)`,
    close: async () => {
      await registry.closeAll();
      pool.close();
    },
  };
}

function registryOptions(d: TopologyDeps) {
  return {
    users: d.users,
    logger: d.logger,
    botsDir: dirname(d.flags.config),
    templatePath: d.flags.config,
    primaryOwner: d.flags.primaryOwner,
    ownedStartConcurrency: d.env.connectionWarmupConcurrency,
  };
}

/** Multi-user console mode: restore every owned bot after a VPS restart. */
function restoreOwned(registry: { startOwned(): Promise<void> }, logger: Logger): void {
  void registry.startOwned().catch((err: unknown) => {
    logger.error('starting other users’ bots failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  });
}

async function main(): Promise<number> {
  const flags = parse(Deno.args);
  const env = loadConfig();
  // Loaded up front only to fail fast on a broken file and to learn the
  // primary bot's id; the host re-reads it on every (re)connect.
  const bot = await loadBotConfig(flags.config);
  const dryRun = bot.dryRun || flags.forceDryRun;
  const logger = new Logger({ level: env.logLevel, base: { bot: bot.botId } });
  startThreadLoopLag(systemClock);

  // Credentials remain per bot. Isolated service instances should use a
  // separate users file too, so their consoles cannot route to another bot.
  // A brand-new accounts file gets its `admin` password from
  // LFR_ADMIN_PASSWORD, or a generated one written beside the file (mode
  // 600). Only the path is logged, never the password.
  const users = new UsersStore(flags.usersFile, {
    initialAdminPassword: Deno.env.get('LFR_ADMIN_PASSWORD') || undefined,
    onGeneratedPassword: (file) =>
      logger.warn('first admin password generated — read it from this file, then change it', {
        file,
      }),
  });
  const release = await describeRelease(env);
  const deps: TopologyDeps = { flags, env, bot, logger, users, release };
  const shards = flags.multiBot
    ? resolveBotShards(env.botShards, navigator.hardwareConcurrency)
    : 0;
  const topology = shards > 0 ? await startSharded(deps, shards) : await startInProcess(deps);
  const server = flags.serve
    ? startStatusServer({
      logger,
      hostname: flags.host,
      port: flags.port,
      source: topology.status,
      alerts: topology.alerts,
      release,
      wrapHandler: () => topology.handler,
    })
    : undefined;

  const controller = new AbortController();
  const stop = (why: string): void => {
    if (controller.signal.aborted) return;
    logger.info('shutting down', { why });
    controller.abort();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        stop(signal);
      });
    } catch {
      // Not every platform exposes both; --seconds still bounds a test run.
    }
  }
  if (flags.seconds !== undefined) {
    setTimeout(() => {
      stop('--seconds elapsed');
    }, flags.seconds * 1_000);
  }

  printBanner({ bot, release, runtime: topology.runtime, server, dryRun, topology });

  // Every bot's connection runs in the background inside its own host; this
  // process only has to stay up until it is asked to stop.
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  // Read before shutdown, which discards the runtime.
  const worker = topology.runtime?.worker;
  const stats = worker?.stats;
  const send = worker?.metrics.snapshot().spans.send;
  await topology.close();
  await server?.shutdown();
  if (stats !== undefined) printSummary(stats, send);
  return 0;
}

function printBanner(o: {
  bot: BotConfig;
  release: ReleaseManifest;
  runtime: LineRuntime | undefined;
  server: RunningStatusServer | undefined;
  dryRun: boolean;
  topology: Topology;
}): void {
  const { bot, release, runtime, server, dryRun } = o;
  writeLine('');
  writeLine(`bot          : ${bot.botId}  (owner ${bot.ownerId})`);
  writeLine(
    `release      : ${release.version} ${release.commit.slice(0, 12)}${
      release.dirty ? ' (DIRTY)' : ''
    }`,
  );
  writeLine(`rules        : ${String(bot.rules.length)}`);
  writeLine(
    `senders      : ${
      bot.allowedSenders === undefined
        ? 'anyone (no allowlist configured)'
        : `${String(bot.allowedSenders.length)} allowed`
    }`,
  );
  writeLine(
    `surfaces     : ${
      [bot.talk ? 'talk' : '', bot.square ? 'square' : ''].filter(Boolean).join('+')
    }`,
  );
  if (runtime !== undefined) {
    writeLine(
      `poll slots   : ${String(runtime.polledRooms.length)}/${String(bot.dedicatedRooms.length)}`,
    );
  }
  writeLine(`lanes        : ${bot.lanes === 0 ? 'runtime-pooled' : String(bot.lanes)}`);
  if (bot.lanes > 0) writeLine(`send lanes   : ${String(bot.sendReservedLanes)} reserved`);
  if (server !== undefined) {
    writeLine(
      `console      : http://${server.hostname}:${String(server.port)}/account/login (เข้าสู่ระบบ)`,
    );
    writeLine(`             : ${server.hostname}:${String(server.port)}/rules  (แก้กฎ — admin)`);
    writeLine(
      `             : ${server.hostname}:${String(server.port)}/app    (แก้กฎ + เลือกห้อง — user)`,
    );
    writeLine(
      `             : ${server.hostname}:${String(server.port)}/login  (re-auth session — admin)`,
    );
  }
  writeLine(
    runtime === undefined && o.topology.status.snapshot().origin !== 'sharded'
      ? 'status       : NOT CONNECTED to LINE — sign in and open /app to scan a fresh QR'
      : dryRun
      ? 'mode         : DRY RUN — replies are logged, nothing is posted'
      : 'mode         : LIVE — this bot WILL post into real rooms',
  );
  writeLine(`isolation    : ${o.topology.isolation}`);
  writeLine('');
}

function printSummary(
  stats: { received: number; dispatched: number; suppressed: number; failed: number },
  send: { min: number; p50: number; p95: number; count: number } | undefined,
): void {
  writeLine('');
  writeLine('── worker summary ─────────────────────────────');
  writeLine(`received   : ${String(stats.received)}`);
  writeLine(`dispatched : ${String(stats.dispatched)}`);
  writeLine(
    `suppressed : ${String(stats.suppressed)}  (dedupe / no rule / not allowed / rate limit)`,
  );
  writeLine(`failed     : ${String(stats.failed)}`);
  if (send !== undefined) {
    writeLine(
      `send RTT   : min ${send.min.toFixed(1)} / p50 ${send.p50.toFixed(1)} / p95 ${
        send.p95.toFixed(1)
      } ms  (n=${String(send.count)})`,
    );
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err: unknown) {
    writeErr(`worker failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
