import type { Device } from '../adapters/linejs/login.ts';
import { LoginFlow } from '../admin/login-flow.ts';
import type { ConnectionWarmupGate } from './connection-warmup-gate.ts';
import { loadBotConfig } from '../config/bot-config.ts';
import type { WorkerConfig } from '../config/env.ts';
import { systemClock } from '../lib/clock.ts';
import type { Logger } from '../logging/logger.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import { StatusSource } from '../observability/snapshot.ts';
import type { AlertEvaluator } from '../monitoring/alerts.ts';
import type { SessionStore } from '../session/store.ts';
import { connectToLine, flushSessionStorage, type LineRuntime } from './connect.ts';

/**
 * One person's bot: its LINE connection, its login flow, its status.
 *
 * Before this existed a process was exactly one bot, so "restart" meant
 * `Deno.exit` and every signed-in person shared it. Several people now share
 * one process, and one person's QR scan, logout or recovery must never touch
 * anyone else's connection — so the connect → run → teardown cycle that
 * `cli/serve.ts` used to run once for the whole process lives here, once per
 * bot, and can be repeated without leaving the process.
 */

export interface BotHostOptions {
  botId: string;
  configPath: string;
  sessionsDir: string;
  env: WorkerConfig;
  sessions: SessionStore;
  logger: Logger;
  /** Force dry run regardless of the bot's own config (`serve --dry-run`). */
  forceDryRun?: boolean;
  showText?: boolean;
  /** Injectable so a test never opens a real LINE connection. */
  connect?: typeof connectToLine;
  /** Delay before a bot whose run loop ended on its own is brought back. */
  respawnDelayMs?: number;
  /** Shared by every host in one process. It limits only network-heavy
   * connection establishment; a live reply never waits on it. */
  connectionWarmupGate?: ConnectionWarmupGate;
}

const DEFAULT_DEVICE: Device = 'DESKTOPWIN';
const DEFAULT_RESPAWN_DELAY_MS = 5_000;
/** Lets the HTTP response that asked for a restart leave before teardown. */
const RESTART_SETTLE_MS = 250;

const reasonOf = (err: unknown): string => err instanceof Error ? err.message : String(err);

export class BotHost {
  readonly botId: string;
  readonly configPath: string;
  readonly linejsStoragePath: string;
  readonly logger: Logger;

  readonly #o: BotHostOptions;
  readonly #disconnectedStatus: StatusSource;
  #loginFlow: LoginFlow | undefined;
  #runtime: LineRuntime | undefined;
  #controller: AbortController | undefined;
  #running: Promise<void> = Promise.resolve();
  #ready: Promise<void> = Promise.resolve();
  #started = false;
  #restartInFlight: Promise<void> | undefined;
  #closed = false;

  constructor(options: BotHostOptions) {
    this.#o = options;
    this.botId = options.botId;
    this.configPath = options.configPath;
    this.logger = options.logger;
    this.linejsStoragePath = `${options.sessionsDir}/${
      encodeURIComponent(options.botId)
    }.linejs.json`;
    // A real StatusSource over an empty recorder, so the dashboard renders
    // zeros and "not armed" while disconnected instead of every reader
    // needing a special case for "no worker yet".
    this.#disconnectedStatus = new StatusSource({
      workerId: options.botId,
      origin: 'disconnected',
      clock: systemClock,
      metrics: new MetricsRecorder(),
    });
  }

  /** Undefined while disconnected (never logged in, session rejected, or a
   * restart is in progress). */
  get runtime(): LineRuntime | undefined {
    return this.#runtime;
  }

  get status(): StatusSource {
    return this.#runtime?.worker.status ?? this.#disconnectedStatus;
  }

  get alerts(): AlertEvaluator | undefined {
    return this.#runtime?.worker.alerts;
  }

  /** The QR flow of the current connection attempt. Replaced on every start,
   * exactly as a process restart used to discard it. */
  get loginFlow(): LoginFlow {
    if (this.#loginFlow === undefined) throw new Error(`bot "${this.botId}" was never started`);
    return this.#loginFlow;
  }

  /** Settles once the start or restart in flight has finished. A request that
   * awaits this never sees a half-built runtime. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** First start. Never rejects: a bot that cannot connect serves in
   * disconnected mode so its owner can still fix the session. */
  start(): Promise<void> {
    if (this.#closed || this.#started) return this.#ready;
    this.#started = true;
    this.#ready = this.#connect();
    return this.#ready;
  }

  /** Tears the connection down and reconnects with whatever session is now
   * stored. Returns at once; await {@link ready} for completion. */
  restart(): Promise<void> {
    if (this.#closed) return this.#ready;
    if (this.#restartInFlight !== undefined) return this.#restartInFlight;
    const previous = this.#ready;
    const restart = (async () => {
      await previous;
      await new Promise<void>((resolve) => setTimeout(resolve, RESTART_SETTLE_MS));
      await this.#teardown();
      if (this.#closed) return;
      await this.#connect();
    })();
    this.#restartInFlight = restart;
    this.#ready = restart.finally(() => {
      if (this.#restartInFlight === restart) this.#restartInFlight = undefined;
    });
    return this.#ready;
  }

  /** Permanent: the host is not usable afterwards. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#ready;
    await this.#teardown();
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    const o = this.#o;
    try {
      const bot = await loadBotConfig(o.configPath);
      const stored = await o.sessions.load(o.botId).catch(() => null);
      const device: Device = (stored?.extra['device'] as Device | undefined) ?? DEFAULT_DEVICE;
      this.#loginFlow = new LoginFlow({
        botId: o.botId,
        device,
        storagePath: this.linejsStoragePath,
        sessions: o.sessions,
        logger: o.logger,
        clock: systemClock,
        onSuccess: () => this.restart(),
      });

      const connect = o.connect ?? connectToLine;
      const startRuntime = async (): Promise<
        { runtime: LineRuntime; controller: AbortController }
      > => {
        const runtime = await connect({
          bot,
          env: o.env,
          dryRun: bot.dryRun || (o.forceDryRun ?? false),
          showText: o.showText ?? false,
          device,
          linejsStoragePath: this.linejsStoragePath,
          sessions: o.sessions,
          logger: o.logger,
          onRecoveryRestart: () => {
            void this.restart();
          },
        });
        const controller = new AbortController();
        // The initial probe is part of connection establishment. Awaiting it
        // keeps its first network request inside the shared gate; later
        // keep-alives are cheap reuse probes and stay independent.
        await runtime.warmer.start(controller.signal);
        return { runtime, controller };
      };
      const connected = await (o.connectionWarmupGate === undefined
        ? startRuntime()
        : o.connectionWarmupGate.run(startRuntime));
      this.#runtime = connected.runtime;
      this.#controller = connected.controller;
      this.#running = this.#run(connected.runtime, connected.controller);
    } catch (err: unknown) {
      this.#runtime = undefined;
      this.#loginFlow ??= this.#fallbackLoginFlow();
      o.logger.error('not connected to LINE — serving in disconnected mode', {
        botId: o.botId,
        reason: reasonOf(err),
      });
    }
  }

  #fallbackLoginFlow(): LoginFlow {
    return new LoginFlow({
      botId: this.botId,
      device: DEFAULT_DEVICE,
      storagePath: this.linejsStoragePath,
      sessions: this.#o.sessions,
      logger: this.#o.logger,
      clock: systemClock,
      onSuccess: () => this.restart(),
    });
  }

  async #run(runtime: LineRuntime, controller: AbortController): Promise<void> {
    try {
      await runtime.worker.run(controller.signal);
    } catch (err: unknown) {
      this.logger.error('worker run loop failed', { botId: this.botId, reason: reasonOf(err) });
    }
    if (controller.signal.aborted || this.#closed) return;
    // The loop ended on its own: the process used to exit here and let its
    // supervisor start it again. Do the equivalent for this bot alone.
    this.logger.warn('worker stopped unexpectedly — reconnecting', { botId: this.botId });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.#o.respawnDelayMs ?? DEFAULT_RESPAWN_DELAY_MS);
    });
    if (this.#controller === controller && !this.#closed) void this.restart();
  }

  /** Same shutdown order `cli/serve.ts` always used, including the debounced
   * session write that must not outlive the connection: the next start would
   * otherwise reuse a request sequence number LINE has already seen. */
  async #teardown(): Promise<void> {
    const runtime = this.#runtime;
    const controller = this.#controller;
    this.#runtime = undefined;
    this.#controller = undefined;
    if (runtime === undefined || controller === undefined) return;
    controller.abort();
    await runtime.adapter.stop().catch(() => {});
    await this.#running;
    runtime.warmer.stop();
    runtime.lanePool?.close();
    runtime.warmClient?.close();
    runtime.pushClient.close();
    await flushSessionStorage(runtime.client).catch((err: unknown) => {
      this.logger.warn('flushing LINE session storage failed', {
        botId: this.botId,
        reason: reasonOf(err),
      });
    });
    await this.#discardStorageIfLoggedOut();
  }

  /** The flush above writes the old client's cache back to disk. After a
   * logout the admin route has already removed the session and LINEJS's own
   * file, and that write would resurrect the very token it just removed. */
  async #discardStorageIfLoggedOut(): Promise<void> {
    const stored = await this.#o.sessions.load(this.botId).catch(() => undefined);
    if (stored !== null) return;
    await Deno.remove(this.linejsStoragePath).catch((err: unknown) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
  }
}
