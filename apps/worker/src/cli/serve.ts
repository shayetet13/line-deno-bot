import { dirname } from 'node:path';
import { parseArgs } from '@std/cli/parse-args';
import { createCombinedHandler } from '../admin/server.ts';
import { UsersStore } from '../admin/users-store.ts';
import { BotHost } from '../bots/bot-host.ts';
import { BoundedConnectionWarmupGate } from '../bots/connection-warmup-gate.ts';
import { BotRegistry } from '../bots/bot-registry.ts';
import { createIsolatedHandler } from '../bots/isolated-routes.ts';
import { createTenantRoutes } from '../bots/tenant-routes.ts';
import { loadBotConfig } from '../config/bot-config.ts';
import { loadConfig } from '../config/env.ts';
import { ConfigError } from '../errors/base.ts';
import { Logger } from '../logging/logger.ts';
import { startStatusServer } from '../observability/server.ts';
import { describeRelease } from '../release/describe.ts';
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
  --multi-bot          Legacy shared-process mode. Starts every owned bot;
                       do not use for latency-sensitive workers.
  --port <n>           Operator console port (default 8791, loopback only).
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
  port: number;
  serve: boolean;
  forceDryRun: boolean;
  showText: boolean;
  multiBot: boolean;
  seconds: number | undefined;
}

function parse(args: string[]): Flags {
  const f = parseArgs(args, {
    string: ['config', 'sessions-dir', 'users-file', 'primary-owner', 'port', 'seconds'],
    boolean: ['help', 'serve', 'dry-run', 'show-text', 'multi-bot'],
    default: {
      'sessions-dir': '.sessions',
      'users-file': '.control/users.json',
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
  const seconds = f.seconds === undefined ? undefined : Number(f.seconds);
  if (seconds !== undefined && !Number.isFinite(seconds)) {
    throw new ConfigError('--seconds must be a number');
  }
  return {
    config: f.config,
    dir: f['sessions-dir'],
    usersFile: f['users-file'],
    primaryOwner: f['primary-owner'],
    port,
    serve: f.serve,
    forceDryRun: f['dry-run'],
    showText: f['show-text'],
    multiBot: f['multi-bot'],
    seconds,
  };
}

async function main(): Promise<number> {
  const flags = parse(Deno.args);
  const env = loadConfig();
  // Loaded up front only to fail fast on a broken file and to learn the
  // primary bot's id; the host re-reads it on every (re)connect.
  const bot = await loadBotConfig(flags.config);
  const dryRun = bot.dryRun || flags.forceDryRun;
  const logger = new Logger({ level: env.logLevel, base: { bot: bot.botId } });

  const sessions = new FileSessionStore(flags.dir);
  // One gate for every account in this process. It is used only while a
  // connection is built or rebuilt; replies continue to submit concurrently.
  const connectionWarmupGate = new BoundedConnectionWarmupGate(env.connectionWarmupConcurrency);
  // Credentials remain per bot. Isolated service instances should use a
  // separate users file too, so their consoles cannot route to another bot.
  const users = new UsersStore(flags.usersFile);
  const release = await describeRelease(env);

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
  const primary = makeHost(bot.botId, flags.config);
  await primary.start();

  const registry = flags.multiBot
    ? new BotRegistry({
      users,
      logger,
      primary,
      createHost: makeHost,
      botsDir: dirname(flags.config),
      templatePath: flags.config,
      primaryOwner: flags.primaryOwner,
      ownedStartConcurrency: env.connectionWarmupConcurrency,
    })
    : undefined;
  if (registry !== undefined) {
    // Legacy mode only. The isolated default never creates, warms, or routes
    // another bot in this process.
    void registry.startOwned().catch((err: unknown) => {
      logger.error('starting other users’ bots failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  }
  const handler = registry === undefined
    ? createIsolatedHandler({ host: primary, users, sessions, release })
    : (() => {
      const tenant = createTenantRoutes({ registry, users, sessions, logger, release });
      return createCombinedHandler(tenant.admin, tenant.status, { users });
    })();
  const server = flags.serve
    ? startStatusServer({
      logger,
      port: flags.port,
      source: primary.status,
      alerts: primary.alerts,
      release,
      wrapHandler: () => handler,
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

  const runtime = primary.runtime;
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
    runtime === undefined
      ? 'status       : NOT CONNECTED to LINE — sign in and open /app to scan a fresh QR'
      : dryRun
      ? 'mode         : DRY RUN — replies are logged, nothing is posted'
      : 'mode         : LIVE — this bot WILL post into real rooms',
  );
  writeLine(
    registry === undefined
      ? 'isolation    : this process owns this bot only'
      : 'isolation    : LEGACY shared-process multi-bot mode',
  );
  writeLine('');

  // Every bot's connection runs in the background inside its own host; this
  // process only has to stay up until it is asked to stop.
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  // Read before shutdown, which discards the runtime.
  const worker = primary.runtime?.worker;
  const stats = worker?.stats;
  const send = worker?.metrics.snapshot().spans.send;
  if (registry === undefined) await primary.close();
  else await registry.closeAll();
  await server?.shutdown();

  if (stats !== undefined) {
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
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err: unknown) {
    writeErr(`worker failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
