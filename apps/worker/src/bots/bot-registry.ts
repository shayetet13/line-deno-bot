import type { UserRecord, UsersStore } from '../admin/users-store.ts';
import { ConfigError } from '../errors/base.ts';
import type { Logger } from '../logging/logger.ts';
import type { BotHost } from './bot-host.ts';

/**
 * Who owns which bot, and the live `BotHost` behind each.
 *
 * The rule this enforces is the one the console was missing: a signed-in
 * person only ever reaches THEIR bot — their LINE account, rules, rooms and QR
 * login — and never another person's. Every request resolves its bot through
 * {@link hostFor} from the authenticated user, so no route can be handed
 * someone else's by accident.
 *
 * The bot the process was started with (`serve --config`) is the "primary":
 * it predates per-user ownership, keeps backing `/api/health`, and is handed
 * to the first admin who signs in, so an existing deployment keeps its LINE
 * session, rules and rooms instead of silently starting over.
 */

export interface BotRegistryOptions {
  users: UsersStore;
  logger: Logger;
  primary: BotHost;
  /** Builds the host for another bot id. The config file for `botId` exists
   * (or is about to) at `configPathFor(botId)`. */
  createHost: (botId: string, configPath: string) => BotHost;
  /** Directory holding every bot's config JSON (the primary's own directory). */
  botsDir: string;
  /** Raw JSON of the primary's config, used as the tuning template (lanes,
   * poll cadence, dry run …) for a new person's bot. */
  templatePath: string;
  /** Username that should receive the primary bot. Without it the first admin
   * to sign in does — right for a fresh install, wrong when a non-admin
   * already operates the existing bot day to day. */
  primaryOwner?: string | undefined;
  /** Maximum simultaneous account restores.  This must match the shared
   * connection warm-up gate so a process restart cannot create a handshake
   * burst before live traffic begins. */
  ownedStartConcurrency?: number | undefined;
}

/** A new bot must load (the validator insists on at least one rule), and a
 * starter rule is friendlier than an empty page. */
const STARTER_RULE = {
  id: 'example-ping',
  priority: 100,
  kind: 'exact',
  pattern: 'ping',
  reply: 'pong',
};

/**
 * Connection recovery is intentionally throttled independently from CPU. Each
 * bot opens its PUSH session and primes its own authenticated reply lanes;
 * bringing every stored account up at once creates a burst of TCP/TLS/H2
 * handshakes that can make otherwise fast routes look like 40–100ms routes.
 * Two concurrent restores keep a 20-bot restart bounded without turning a
 * process restart into a connection storm.
 */
const DEFAULT_OWNED_START_CONCURRENCY = 2;

/** Keys that describe the primary's own deployment, not tuning. A new bot
 * starts empty of them: no rooms, no sender allowlist, someone else's rules. */
const PER_BOT_KEYS = ['dedicatedRooms', 'selectedRooms', 'allowedSenders', 'rules'] as const;

const botIdForUser = (userId: string): string => `u-${userId.replaceAll('-', '').slice(0, 12)}`;

export class BotRegistry {
  readonly #o: BotRegistryOptions;
  readonly #ownedStartConcurrency: number;
  readonly #hosts = new Map<string, BotHost>();
  /** Serialises assignment: two first requests must not both claim the primary
   * bot, or both mint a bot for the same person. */
  #assigning: Promise<unknown> = Promise.resolve();

  constructor(options: BotRegistryOptions) {
    this.#o = options;
    const concurrency = options.ownedStartConcurrency ?? DEFAULT_OWNED_START_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ConfigError('ownedStartConcurrency must be an integer >= 1');
    }
    this.#ownedStartConcurrency = concurrency;
    this.#hosts.set(options.primary.botId, options.primary);
  }

  get primary(): BotHost {
    return this.#o.primary;
  }

  /** The bot this user owns, assigned and started on first use. Waits for any
   * start or restart in flight, so the caller never sees a half-built one. */
  async hostFor(user: UserRecord): Promise<BotHost> {
    const host = await this.#serialised(() => this.#resolve(user));
    await host.ready;
    return host;
  }

  /** Starts every bot that already has an owner, so a restart of the process
   * brings everyone's connection back rather than only the first to sign in. */
  async startOwned(): Promise<void> {
    const users = await this.#o.users.list();
    const owned = users.filter((user) => user.botId !== undefined);
    let next = 0;
    const restoreOne = async (): Promise<void> => {
      while (next < owned.length) {
        const user = owned[next++];
        if (user === undefined) return;
        const host = await this.#serialised(() => this.#resolve(user));
        await host.ready;
      }
    };
    const workers = Array.from(
      { length: Math.min(this.#ownedStartConcurrency, owned.length) },
      () => restoreOne(),
    );
    await Promise.all(workers);
  }

  /** Stops a removed person's bot. The primary keeps running: it backs the
   * health check and simply waits for the next admin to claim it. Files stay
   * on disk — deleting someone's LINE credentials is not a side effect of
   * deleting a login. */
  async release(user: UserRecord): Promise<void> {
    const botId = user.botId;
    if (botId === undefined || botId === this.#o.primary.botId) return;
    const host = this.#hosts.get(botId);
    if (host === undefined) return;
    this.#hosts.delete(botId);
    await host.close();
  }

  async closeAll(): Promise<void> {
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((host) => host.close()));
  }

  #serialised<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#assigning.then(fn, fn);
    this.#assigning = run.catch(() => {});
    return run;
  }

  async #resolve(user: UserRecord): Promise<BotHost> {
    // Re-read: the record the caller holds may predate an assignment made
    // while this call waited its turn.
    const current = await this.#o.users.findById(user.userId) ?? user;
    const botId = current.botId ?? await this.#assign(current);
    const known = this.#hosts.get(botId);
    if (known !== undefined) return known;

    await this.#ensureConfig(botId);
    const host = this.#o.createHost(botId, this.#configPathFor(botId));
    this.#hosts.set(botId, host);
    // Fire and forget: `hostFor` awaits `host.ready` outside the assignment
    // lock, so a slow LINE connect never blocks other people from signing in.
    void host.start();
    return host;
  }

  async #assign(user: UserRecord): Promise<string> {
    const primaryId = this.#o.primary.botId;
    const owners = await this.#o.users.list();
    const primaryTaken = owners.some((u) => u.botId === primaryId);
    const claimsPrimary = !primaryTaken && this.#mayClaimPrimary(user);
    const botId = claimsPrimary ? primaryId : botIdForUser(user.userId);
    await this.#o.users.setBotId(user.userId, botId);
    this.#o.logger.info('bot assigned to user', {
      userId: user.userId,
      username: user.username,
      botId,
      primary: botId === primaryId,
    });
    return botId;
  }

  #mayClaimPrimary(user: UserRecord): boolean {
    const owner = this.#o.primaryOwner;
    if (owner === undefined || owner === '') return user.role === 'admin';
    return user.username.toLowerCase() === owner.toLowerCase();
  }

  #configPathFor(botId: string): string {
    return botId === this.#o.primary.botId
      ? this.#o.primary.configPath
      : `${this.#o.botsDir}/${botId}.json`;
  }

  /** Writes a fresh config for a new person's bot unless one is already there
   * (a process restart, or a bot provisioned by hand). It is deliberately safe
   * to leave connected: no rooms are selected, so it answers nothing until its
   * owner picks some. */
  async #ensureConfig(botId: string): Promise<void> {
    const path = this.#configPathFor(botId);
    const exists = await Deno.stat(path).then(() => true).catch((err: unknown) => {
      if (err instanceof Deno.errors.NotFound) return false;
      throw err;
    });
    if (exists) return;

    const template = await Deno.readTextFile(this.#o.templatePath).catch((err: unknown) => {
      throw new ConfigError(
        `cannot read bot template ${this.#o.templatePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { path: this.#o.templatePath },
      );
    });
    const raw = JSON.parse(template) as Record<string, unknown>;
    for (const key of PER_BOT_KEYS) delete raw[key];
    const next = {
      ...raw,
      botId,
      ownerId: `owner-${botId}`,
      dedicatedRooms: [],
      selectedRooms: [],
      rules: [STARTER_RULE],
    };

    await Deno.mkdir(this.#o.botsDir, { recursive: true });
    const tmp = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await Deno.rename(tmp, path);
    } catch (err: unknown) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
  }
}
