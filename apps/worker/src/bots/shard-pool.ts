import { ConfigError } from '../errors/base.ts';
import type { Logger } from '../logging/logger.ts';
import type { ManagedBot } from './bot-registry.ts';
import {
  fromWireResponse,
  type ShardCommand,
  type ShardInit,
  type ShardReply,
  toWireRequest,
  type WireResponse,
} from './shard-protocol.ts';

export interface ShardPoolOptions {
  /** Worker threads to run bots on. */
  shards: number;
  /** Everything a shard needs except its own id. */
  init: Omit<ShardInit, 'shardId'>;
  logger: Logger;
  /** The shard entry module. Injectable so a test can run a fake shard. */
  workerUrl?: URL;
  /** Delay before a crashed shard is started again. */
  respawnDelayMs?: number;
}

const DEFAULT_WORKER_URL = new URL('./shard-worker.ts', import.meta.url);
const DEFAULT_RESPAWN_DELAY_MS = 1_000;

interface Pending {
  resolve: (value: WireResponse | undefined) => void;
  reject: (error: Error) => void;
}

/**
 * One Worker thread and the bots assigned to it. A shard that dies (an
 * uncaught error inside it) is started again and its bots are restarted in
 * it: those bots reconnect, every other shard's bots never notice.
 */
class Shard {
  readonly id: string;
  /** botId → configPath, so a respawned shard can bring its bots back. */
  readonly bots = new Map<string, string>();
  readonly #o: ShardPoolOptions;
  readonly #pending = new Map<number, Pending>();
  #worker!: Worker;
  #nextId = 1;
  #closed = false;

  constructor(id: string, options: ShardPoolOptions) {
    this.id = id;
    this.#o = options;
    this.#spawn();
  }

  call(command: ShardCommand, transfer: Transferable[] = []): Promise<WireResponse | undefined> {
    if (this.#closed) return Promise.reject(new Error(`bot shard ${this.id} is closed`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...command, id }, transfer);
    });
  }

  terminate(): void {
    this.#closed = true;
    this.#worker.terminate();
    this.#failAll(new Error(`bot shard ${this.id} was terminated`));
  }

  #spawn(): void {
    const worker = new Worker(this.#o.workerUrl ?? DEFAULT_WORKER_URL, {
      type: 'module',
      name: this.id,
    });
    worker.onmessage = (event: MessageEvent<ShardReply>): void => this.#settle(event.data);
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      this.#crashed(worker, event.message);
    };
    worker.onmessageerror = (): void => this.#crashed(worker, 'unreadable message');
    this.#worker = worker;
    worker.postMessage({ op: 'init', id: 0, init: { ...this.#o.init, shardId: this.id } });
  }

  #settle(reply: ShardReply): void {
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    this.#pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new Error(reply.error));
  }

  #crashed(worker: Worker, reason: string): void {
    if (this.#closed || worker !== this.#worker) return;
    this.#o.logger.error('bot shard crashed — restarting it and its bots', {
      shard: this.id,
      bots: this.bots.size,
      reason,
    });
    worker.terminate();
    this.#failAll(new Error(`bot shard ${this.id} crashed: ${reason}`));
    setTimeout(() => {
      if (this.#closed) return;
      this.#spawn();
      for (const [botId, configPath] of this.bots) {
        void this.call({ op: 'start', botId, configPath }).catch((error: unknown) => {
          this.#o.logger.error('bot restart after shard crash failed', {
            shard: this.id,
            botId,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, this.#o.respawnDelayMs ?? DEFAULT_RESPAWN_DELAY_MS);
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of pending) reject(error);
  }
}

/**
 * A bot running in a shard, seen from the console thread: the registry
 * starts and stops it, and the tenant routes forward its owner's requests to
 * it. It never touches LINE itself.
 */
export class ShardedBotHost implements ManagedBot {
  readonly botId: string;
  readonly configPath: string;
  readonly #shard: Shard;
  readonly #logger: Logger;
  readonly #onClose: () => void;
  #ready: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(
    botId: string,
    configPath: string,
    shard: Shard,
    logger: Logger,
    onClose: () => void = () => {},
  ) {
    this.botId = botId;
    this.configPath = configPath;
    this.#shard = shard;
    this.#logger = logger;
    this.#onClose = onClose;
  }

  get shardId(): string {
    return this.#shard.id;
  }

  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Never rejects, like `BotHost.start`: a bot that cannot connect still
   * serves its console so its owner can fix it. */
  start(): Promise<void> {
    if (this.#closed || this.#started) return this.#ready;
    this.#started = true;
    this.#shard.bots.set(this.botId, this.configPath);
    this.#ready = this.#settled(
      this.#shard.call({ op: 'start', botId: this.botId, configPath: this.configPath }),
      'start',
    );
    return this.#ready;
  }

  restart(): Promise<void> {
    if (this.#closed) return this.#ready;
    const previous = this.#ready;
    this.#ready = previous.then(() =>
      this.#settled(this.#shard.call({ op: 'restart', botId: this.botId }), 'restart')
    );
    return this.#ready;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shard.bots.delete(this.botId);
    this.#onClose();
    await this.#ready;
    await this.#shard.call({ op: 'close', botId: this.botId }).catch(() => {});
  }

  /** Serves one console request for this bot, inside its shard. */
  async fetch(req: Request): Promise<Response> {
    const request = await toWireRequest(req);
    const response = await this.#shard.call(
      { op: 'http', botId: this.botId, request },
      request.body === null ? [] : [request.body],
    );
    if (response === undefined) throw new Error('bot shard returned no response');
    return fromWireResponse(response);
  }

  async #settled(pending: Promise<unknown>, what: string): Promise<void> {
    try {
      await pending;
    } catch (error: unknown) {
      this.#logger.error(`bot ${what} in shard failed`, {
        botId: this.botId,
        shard: this.#shard.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The shards, and which bot runs where. A bot keeps its shard for the life
 * of the process; a new one goes to the shard running the fewest. */
export class ShardPool {
  readonly #shards: Shard[];
  readonly #logger: Logger;
  /** Sticky: a bot that comes back returns to the shard it had. */
  readonly #assigned = new Map<string, Shard>();
  /** Bots assigned and not yet closed — the load a new bot is balanced on. */
  readonly #live = new Map<string, Shard>();

  constructor(options: ShardPoolOptions) {
    if (!Number.isInteger(options.shards) || options.shards < 1) {
      throw new ConfigError('ShardPool: shards must be an integer >= 1', {
        shards: options.shards,
      });
    }
    this.#logger = options.logger;
    this.#shards = Array.from(
      { length: options.shards },
      (_, i) => new Shard(`shard-${String(i + 1)}`, options),
    );
  }

  get size(): number {
    return this.#shards.length;
  }

  hostFor(botId: string, configPath: string): ShardedBotHost {
    const shard = this.#assigned.get(botId) ?? this.#leastLoaded();
    this.#assigned.set(botId, shard);
    this.#live.set(botId, shard);
    return new ShardedBotHost(
      botId,
      configPath,
      shard,
      this.#logger.child({ bot: botId }),
      () => this.#live.delete(botId),
    );
  }

  /** Bots per shard, for the startup banner and the runbook. */
  layout(): Record<string, number> {
    return Object.fromEntries(this.#shards.map((shard) => [shard.id, shard.bots.size]));
  }

  close(): void {
    for (const shard of this.#shards) shard.terminate();
  }

  /** By live bots: a released bot no longer counts against its shard. */
  #leastLoaded(): Shard {
    const load = (shard: Shard): number =>
      [...this.#live.values()].filter((live) => live === shard).length;
    return this.#shards.reduce((best, shard) => load(shard) < load(best) ? shard : best);
  }
}
