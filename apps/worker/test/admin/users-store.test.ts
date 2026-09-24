import { afterEach, beforeEach, describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { verifyPassword } from '../../src/admin/passwords.ts';
import {
  INITIAL_ADMIN_PASSWORD_FILE,
  UsernameTakenError,
  UserNotFoundError,
  UsersStore,
} from '../../src/admin/users-store.ts';
import { ValidationError } from '../../src/errors/base.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: 'lfr-users-' });
  path = `${dir}/.control/users.json`;
});

afterEach(async () => {
  await Deno.remove(dir, { recursive: true });
});

describe('UsersStore — first read seeds the default admin', () => {
  test('creates the control directory itself when it does not exist yet', async () => {
    // Regression: a brand-new installation's --users-file parent may not
    // exist at all on its very first run, which is exactly when this seed
    // write happens.
    const store = new UsersStore(`${dir}/not-yet-created/users.json`);
    const users = await store.list();
    expect(users).toHaveLength(1);
  });

  test('with no password configured, generates one and writes it only to an owner-only file', async () => {
    const reported: string[] = [];
    const store = new UsersStore(path, { onGeneratedPassword: (file) => void reported.push(file) });
    const users = await store.list();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: 'admin', role: 'admin' });

    const file = `${dir}/.control/${INITIAL_ADMIN_PASSWORD_FILE}`;
    expect(reported).toEqual([file]);
    const password = (await Deno.readTextFile(file)).trim();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(await verifyPassword(password, users[0]!.passwordHash)).toBe(true);
    if (Deno.build.os !== 'windows') expect((await Deno.stat(file)).mode! & 0o777).toBe(0o600);
  });

  test('two installs never share a first admin password', async () => {
    await new UsersStore(path).list();
    const other = `${dir}/other/users.json`;
    await new UsersStore(other).list();
    const a = await Deno.readTextFile(`${dir}/.control/${INITIAL_ADMIN_PASSWORD_FILE}`);
    const b = await Deno.readTextFile(`${dir}/other/${INITIAL_ADMIN_PASSWORD_FILE}`);
    expect(a).not.toBe(b);
  });

  test('a second store pointed at the same file does not re-seed', async () => {
    const first = new UsersStore(path);
    const [seeded] = await first.list();
    const generated = (await Deno.readTextFile(`${dir}/.control/${INITIAL_ADMIN_PASSWORD_FILE}`))
      .trim();
    await first.setPassword(seeded!.userId, 'changed-password');

    const second = new UsersStore(path);
    const [reloaded] = await second.list();
    expect(await verifyPassword('changed-password', reloaded!.passwordHash)).toBe(true);
    expect(await verifyPassword(generated, reloaded!.passwordHash)).toBe(false);
  });

  test('every store instance shares one secret, written once', async () => {
    const first = new UsersStore(path);
    const secret = await first.secret();
    const second = new UsersStore(path);
    expect(await second.secret()).toBe(secret);
  });

  test('the same store can be read through another view', async () => {
    const botOneView = new UsersStore(path);
    const botTwoView = new UsersStore(path);
    const user = await botOneView.create({ username: 'operator', password: 'longenough' });

    expect(await botTwoView.findByUsername('operator')).toMatchObject({ userId: user.userId });
    expect(await botTwoView.secret()).toBe(await botOneView.secret());
  });
});

describe('UsersStore — a configured first admin password', () => {
  test('seeds the admin with it instead of the repository default', async () => {
    const store = new UsersStore(path, { initialAdminPassword: 'x7-long-secret' });
    const [admin] = await store.list();
    expect(await verifyPassword('x7-long-secret', admin!.passwordHash)).toBe(true);
    // Configured means nothing was generated, so no password file either.
    await expect(Deno.stat(`${dir}/.control/${INITIAL_ADMIN_PASSWORD_FILE}`)).rejects.toThrow();
  });

  test('is ignored once the file exists — it only ever seeds', async () => {
    await new UsersStore(path, { initialAdminPassword: 'first-secret' }).list();
    const reopened = new UsersStore(path, { initialAdminPassword: 'x7-long-secret' });
    const [admin] = await reopened.list();
    expect(await verifyPassword('first-secret', admin!.passwordHash)).toBe(true);
  });

  test('refuses one too short to be a password', () => {
    expect(() => new UsersStore(path, { initialAdminPassword: '123' })).toThrow(ValidationError);
  });
});

describe('UsersStore.create', () => {
  test('keeps every concurrent create instead of losing an update', async () => {
    const store = new UsersStore(path);
    await Promise.all([
      store.create({ username: 'alice', password: 'alicepass' }),
      store.create({ username: 'bob', password: 'bobpass1' }),
    ]);
    expect((await store.list()).map((user) => user.username).sort()).toEqual([
      'admin',
      'alice',
      'bob',
    ]);
  });

  test('adds a user with the given role, hashing the password', async () => {
    const store = new UsersStore(path);
    const user = await store.create({ username: 'staff', password: 'staffpass', role: 'user' });
    expect(user.role).toBe('user');
    expect(user.passwordHash).not.toBe('staffpass');
    expect(await verifyPassword('staffpass', user.passwordHash)).toBe(true);
    expect(await store.findByUsername('staff')).toMatchObject({ userId: user.userId });
  });

  test('a duplicate username (case-insensitive) is refused', async () => {
    const store = new UsersStore(path);
    await store.create({ username: 'staff', password: 'staffpass' });
    await expect(store.create({ username: 'Staff', password: 'anotherpass' }))
      .rejects.toThrow(UsernameTakenError);
  });

  test('a short password is refused', async () => {
    const store = new UsersStore(path);
    await expect(store.create({ username: 'x', password: 'ab' })).rejects.toThrow(ValidationError);
  });

  test('defaults to the "user" role when none is given', async () => {
    const store = new UsersStore(path);
    const user = await store.create({ username: 'plain', password: 'longenough' });
    expect(user.role).toBe('user');
  });
});

describe('UsersStore.setPassword / setRole', () => {
  test('setPassword replaces the hash for an existing user', async () => {
    const store = new UsersStore(path);
    const user = await store.create({ username: 'staff', password: 'oldpassword' });
    await store.setPassword(user.userId, 'newpassword');
    const reloaded = await store.findById(user.userId);
    expect(await verifyPassword('newpassword', reloaded?.passwordHash ?? '')).toBe(true);
  });

  test('setPassword on a missing id throws UserNotFoundError', async () => {
    const store = new UsersStore(path);
    await expect(store.setPassword('nope', 'longenough')).rejects.toThrow(UserNotFoundError);
  });

  test('setRole can promote a user to admin freely', async () => {
    const store = new UsersStore(path);
    const user = await store.create({ username: 'staff', password: 'staffpass' });
    await store.setRole(user.userId, 'admin');
    expect((await store.findById(user.userId))?.role).toBe('admin');
  });

  test('setRole refuses to demote the last admin', async () => {
    const store = new UsersStore(path);
    const [seededAdmin] = await store.list();
    await expect(store.setRole(seededAdmin.userId, 'user')).rejects.toThrow(ValidationError);
  });

  test('setRole allows demoting an admin when another admin still exists', async () => {
    const store = new UsersStore(path);
    const [seededAdmin] = await store.list();
    const second = await store.create({ username: 'staff', password: 'staffpass', role: 'admin' });
    await store.setRole(second.userId, 'user');
    expect((await store.findById(second.userId))?.role).toBe('user');
    expect((await store.findById(seededAdmin.userId))?.role).toBe('admin');
  });
});

describe('UsersStore.remove', () => {
  test('removes a non-admin user', async () => {
    const store = new UsersStore(path);
    const user = await store.create({ username: 'staff', password: 'staffpass' });
    await store.remove(user.userId);
    expect(await store.findById(user.userId)).toBeUndefined();
  });

  test('removing the only admin account is refused', async () => {
    const store = new UsersStore(path);
    const [seededAdmin] = await store.list();
    await expect(store.remove(seededAdmin.userId)).rejects.toThrow(ValidationError);
    expect(await store.list()).toHaveLength(1);
  });

  test('removing a missing id throws UserNotFoundError', async () => {
    const store = new UsersStore(path);
    await expect(store.remove('nope')).rejects.toThrow(UserNotFoundError);
  });
});
