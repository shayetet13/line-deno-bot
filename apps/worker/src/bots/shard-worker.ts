/**
 * Entry point of one bot shard: a Worker thread that runs some bots' LINE
 * connections on its own event loop and its own CPU core.
 *
 * Why this exists: with every bot on the console's single JavaScript thread,
 * twenty bots polling at `pollIntervalMs: 0` queue behind one another — a key
 * that arrives while another bot's poll page is being decoded waits for it, on
 * one core, however many the machine has. Here each shard is a separate loop
 * the kernel schedules on its own core, and a busy bot only slows the few
 * that share its shard.
 *
 * Inside, a bot is exactly the ordinary `BotHost` and its console routes are
 * the ordinary handlers; this file only adds the message bridge.
 */
import { createAdminHandler, isAdminPath } from '../admin/server.ts';
import { loadConfig, type WorkerConfig } from '../config/env.ts';
import { systemClock } from '../lib/clock.ts';
import { setThreadLabel } from '../lib/thread.ts';
import { Logger } from '../logging/logger.ts';
import { startThreadLoopLag } from '../metrics/loop-lag.ts';
import { createStatusHandler } from '../observability/server.ts';
import { FileSessionStore } from '../session/store.ts';
import { BotHost } from './bot-host.ts';
import { BoundedConnectionWarmupGate } from './connection-warmup-gate.ts';
import {
  fromWireRequest,
  type ShardCall,
  type ShardInit,
  type ShardReply,
  toWireResponse,
  type WireResponse,
} from './shard-protocol.ts';

interface ShardState {
  init: ShardInit;
  env: WorkerConfig;
  logger: Logger;
  sessions: FileSessionStore;
  gate: BoundedConnectionWarmupGate;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ShardCall>) => void) | null;
  postMessage(message: ShardReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const hosts = new Map<string, BotHost>();
let state: ShardState | undefined;

function setup(init: ShardInit): void {
  setThreadLabel(init.shardId);
  startThreadLoopLag(systemClock);
  state = {
    init,
    env: loadConfig(),
    logger: new Logger({ level: init.logLevel, base: { shard: init.shardId } }),
    sessions: new FileSessionStore(init.sessionsDir),
    gate: new BoundedConnectionWarmupGate(init.warmupConcurrency),
  };
}

function ready(): ShardState {
  if (state === undefined) throw new Error('bot shard used before init');
  return state;
}

function hostOf(botId: string): BotHost {
  const host = hosts.get(botId);
  if (host === undefined) throw new Error(`bot "${botId}" is not running in this shard`);
  return host;
}

function startHost(botId: string, configPath: string): Promise<void> {
  const s = ready();
  let host = hosts.get(botId);
  if (host === undefined) {
    host = new BotHost({
      botId,
      configPath,
      sessionsDir: s.init.sessionsDir,
      env: s.env,
      sessions: s.sessions,
      logger: s.logger.child({ bot: botId }),
      forceDryRun: s.init.forceDryRun,
      showText: s.init.showText,
      connectionWarmupGate: s.gate,
    });
    hosts.set(botId, host);
  }
  return host.start();
}

/** The same routes `isolated-routes.ts` serves for a one-bot process, minus
 * the account routes (the console thread answers those). Rebuilt per request
 * because a reconnect replaces the runtime objects. */
async function serve(host: BotHost, req: Request): Promise<Response> {
  const s = ready();
  await host.ready;
  if (isAdminPath(new URL(req.url).pathname)) {
    return await createAdminHandler({
      worker: host.runtime?.worker,
      botId: host.botId,
      configPath: host.configPath,
      sessions: s.sessions,
      logger: host.logger,
      loginFlow: host.loginFlow,
      client: host.runtime?.client,
      linejsStoragePath: host.linejsStoragePath,
      setPolledRooms: host.runtime?.setRooms,
      restart: () => void host.restart(),
    })(req);
  }
  return createStatusHandler(host.status, { alerts: host.alerts, release: s.init.release })(req);
}

async function handle(call: ShardCall): Promise<WireResponse | undefined> {
  switch (call.op) {
    case 'init':
      setup(call.init);
      return undefined;
    case 'start':
      await startHost(call.botId, call.configPath);
      return undefined;
    case 'restart':
      await hostOf(call.botId).restart();
      return undefined;
    case 'close': {
      const host = hosts.get(call.botId);
      hosts.delete(call.botId);
      await host?.close();
      return undefined;
    }
    case 'http':
      return await toWireResponse(await serve(hostOf(call.botId), fromWireRequest(call.request)));
  }
}

scope.onmessage = (event: MessageEvent<ShardCall>): void => {
  const call = event.data;
  void handle(call).then(
    (value) => scope.postMessage({ id: call.id, ok: true, value }, value ? [value.body] : []),
    (error: unknown) =>
      scope.postMessage({
        id: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
};
