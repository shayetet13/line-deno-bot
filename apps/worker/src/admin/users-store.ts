import { randomBytes } from 'node:crypto';
import { AppError, ValidationError } from '../errors/base.ts';
import { hashPassword } from './passwords.ts';

/**
 * Human login accounts stored in the JSON file supplied to this store. The
 * The VPS multi-user deployment uses one shared account file. `botId` maps
 * every signed-in person to a different BotHost, so their LINE session,
 * rules and rooms remain separate while authentication stays at one URL.
 *
 * This store never holds a LINE credential. Those remain exclusively in
 * `session/store.ts` under `<sessions-dir>/<botId>.json` and LINEJS's
 * `<botId>.linejs.json`.
 */

export type UserRole = 'admin' | 'user';

export interface UserRecord {
  userId: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  displayName: string | undefined;
  /** Maps a person to the BotHost that exclusively owns their LINE session,
   * rules and rooms. */
  botId?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

/** Distinct from {@link ValidationError}: well-formed request, the username
 * is just already taken — a 409 shape, not a 400 one. */
export class UsernameTakenError extends AppError {
  readonly code = 'username_taken';
  readonly errorClass = 'permanent' as const;
}

/** Distinct from {@link ValidationError}: well-formed request, this user id
 * just is not there — a 404 shape, not a 400 one. */
export class UserNotFoundError extends AppError {
  readonly code = 'user_not_found';
  readonly errorClass = 'permanent' as const;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: UserRole;
  displayName?: string;
}

interface UsersFile {
  /** HMAC key for `session-cookie.ts`. Generated once, at first read. */
  secret: string;
  users: UserRecord[];
}

const DEFAULT_ADMIN_USERNAME = 'admin';
/** Safe bootstrap credential; operators should change it after first login. */
const DEFAULT_ADMIN_PASSWORD = 'Root@77#';
const MIN_PASSWORD_LENGTH = 6;

const sameUsername = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface UsersStoreOptions {
  /** Password for the `admin` account created when the file does not exist
   * yet. A deployment that faces the internet must set this: the fallback
   * is written in this repository. Ignored once the file exists. */
  initialAdminPassword?: string | undefined;
}

export class UsersStore {
  #tail: Promise<void> = Promise.resolve();
  readonly #initialAdminPassword: string;

  constructor(private readonly path: string, options: UsersStoreOptions = {}) {
    const initial = options.initialAdminPassword;
    if (initial !== undefined && initial.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `initial admin password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    this.#initialAdminPassword = initial ?? DEFAULT_ADMIN_PASSWORD;
  }

  async secret(): Promise<string> {
    return await this.#exclusive(async () => (await this.#read()).secret);
  }

  async list(): Promise<readonly UserRecord[]> {
    return await this.#exclusive(async () => (await this.#read()).users);
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    return await this.#exclusive(async () =>
      (await this.#read()).users.find((u) => sameUsername(u.username, username))
    );
  }

  async findById(userId: string): Promise<UserRecord | undefined> {
    return await this.#exclusive(async () =>
      (await this.#read()).users.find((u) => u.userId === userId)
    );
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    return await this.#mutate(async (file) => {
      const username = input.username.trim();
      if (username.length === 0) throw new ValidationError('username is required');
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      if (file.users.some((u) => sameUsername(u.username, username))) {
        throw new UsernameTakenError(`username "${username}" is already taken`, { username });
      }
      const now = Date.now();
      const record: UserRecord = {
        userId: crypto.randomUUID(),
        username,
        passwordHash: await hashPassword(input.password),
        role: input.role ?? 'user',
        displayName: input.displayName,
        createdAt: now,
        updatedAt: now,
      };
      return { file: { ...file, users: [...file.users, record] }, result: record };
    });
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.#mutate(async (file) => {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const index = file.users.findIndex((u) => u.userId === userId);
      const current = index === -1 ? undefined : file.users[index];
      if (current === undefined) {
        throw new UserNotFoundError(`no user with id "${userId}"`, { userId });
      }
      const users = [...file.users];
      users[index] = {
        ...current,
        passwordHash: await hashPassword(password),
        updatedAt: Date.now(),
      };
      return { file: { ...file, users }, result: undefined };
    });
  }

  async setRole(userId: string, role: UserRole): Promise<void> {
    await this.#mutate((file) => {
      const index = file.users.findIndex((u) => u.userId === userId);
      const current = index === -1 ? undefined : file.users[index];
      if (current === undefined) {
        throw new UserNotFoundError(`no user with id "${userId}"`, { userId });
      }
      if (current.role === 'admin' && role !== 'admin') {
        this.#assertAnotherAdminExists(file.users, userId);
      }
      const users = [...file.users];
      users[index] = { ...current, role, updatedAt: Date.now() };
      return { file: { ...file, users }, result: undefined };
    });
  }

  /** Records which bot `userId` owns. Ownership is one-to-one: refusing a
   * bot that already belongs to someone else is what keeps two people's
   * rules, rooms and LINE sessions from ever being the same thing. */
  async setBotId(userId: string, botId: string): Promise<void> {
    await this.#mutate((file) => {
      const index = file.users.findIndex((u) => u.userId === userId);
      const current = index === -1 ? undefined : file.users[index];
      if (current === undefined) {
        throw new UserNotFoundError(`no user with id "${userId}"`, { userId });
      }
      const owner = file.users.find((u) => u.botId === botId && u.userId !== userId);
      if (owner !== undefined) {
        throw new ValidationError(`bot "${botId}" already belongs to "${owner.username}"`, {
          botId,
        });
      }
      const users = [...file.users];
      users[index] = { ...current, botId, updatedAt: Date.now() };
      return { file: { ...file, users }, result: undefined };
    });
  }

  async remove(userId: string): Promise<void> {
    await this.#mutate((file) => {
      const target = file.users.find((u) => u.userId === userId);
      if (target === undefined) {
        throw new UserNotFoundError(`no user with id "${userId}"`, { userId });
      }
      if (target.role === 'admin') this.#assertAnotherAdminExists(file.users, userId);
      return {
        file: { ...file, users: file.users.filter((u) => u.userId !== userId) },
        result: undefined,
      };
    });
  }

  /** Refuses to leave the system with zero admin accounts — the one invariant
   * this store enforces on its own, since there would otherwise be no way
   * back in short of editing this file by hand. */
  #assertAnotherAdminExists(users: readonly UserRecord[], excludingUserId: string): void {
    const stillHasAdmin = users.some((u) => u.role === 'admin' && u.userId !== excludingUserId);
    if (!stillHasAdmin) {
      throw new ValidationError('cannot remove or demote the last admin account');
    }
  }

  /** Console requests may arrive together. Serialize the whole read-modify-
   * write transaction so a later request cannot overwrite a user added by an
   * earlier one. This never runs on the message receive/send path. */
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release!();
    }
  }

  async #mutate<T>(
    work: (
      file: UsersFile,
    ) => Promise<{ file: UsersFile; result: T }> | { file: UsersFile; result: T },
  ): Promise<T> {
    return await this.#exclusive(async () => {
      const { file, result } = await work(await this.#read());
      await this.#write(file);
      return result;
    });
  }

  async #read(): Promise<UsersFile> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (err: unknown) {
      if (err instanceof Deno.errors.NotFound) return await this.#seed();
      throw err;
    }
    return JSON.parse(text) as UsersFile;
  }

  async #seed(): Promise<UsersFile> {
    const now = Date.now();
    const file: UsersFile = {
      secret: randomBytes(32).toString('hex'),
      users: [{
        userId: crypto.randomUUID(),
        username: DEFAULT_ADMIN_USERNAME,
        passwordHash: await hashPassword(this.#initialAdminPassword),
        role: 'admin',
        displayName: undefined,
        createdAt: now,
        updatedAt: now,
      }],
    };
    await this.#write(file);
    return file;
  }

  async #write(file: UsersFile): Promise<void> {
    // Same as `session/store.ts`'s `FileSessionStore.save` — the sessions
    // directory this file lives in may not exist yet on a bot's very first
    // run (that first run is exactly when the seed write below happens).
    const lastSlash = Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\'));
    if (lastSlash > 0) await Deno.mkdir(this.path.slice(0, lastSlash), { recursive: true });

    const tmp = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
      if (Deno.build.os !== 'windows') await Deno.chmod(tmp, 0o600);
      await Deno.rename(tmp, this.path);
    } catch (err: unknown) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
  }
}
