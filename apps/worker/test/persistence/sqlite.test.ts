import { describe, it as test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigError } from '../../src/errors/base.ts';
import { ACCOUNT_MIGRATIONS, CONTROL_MIGRATIONS } from '../../src/persistence/migrations.ts';
import { type Migration, openDatabase, runMigrations } from '../../src/persistence/sqlite.ts';

const memory = () => openDatabase(':memory:');

const tableNames = (db: ReturnType<typeof memory>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
    name: string;
  }[]).map((r) => r.name);

const M = (version: number, up: string): Migration => ({ version, name: `m${version}`, up });

describe('openDatabase', () => {
  test('turns on foreign keys', () => {
    const db = memory();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });
});

describe('runMigrations', () => {
  test('applies pending migrations and records them', () => {
    const db = memory();
    const result = runMigrations(db, [M(1, 'CREATE TABLE a(x INTEGER)')]);
    expect(result.applied).toEqual([1]);
    expect(result.alreadyAt).toBe(0);
    expect(tableNames(db)).toContain('a');
    db.close();
  });

  test('is idempotent — a second run applies nothing', () => {
    const db = memory();
    const migrations = [M(1, 'CREATE TABLE a(x INTEGER)')];
    runMigrations(db, migrations);
    const second = runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.alreadyAt).toBe(1);
    db.close();
  });

  test('applies only the versions newer than what is recorded', () => {
    const db = memory();
    runMigrations(db, [M(1, 'CREATE TABLE a(x INTEGER)')]);
    const next = runMigrations(db, [
      M(1, 'CREATE TABLE a(x INTEGER)'),
      M(2, 'CREATE TABLE b(y INTEGER)'),
    ]);
    expect(next.applied).toEqual([2]);
    expect(tableNames(db)).toContain('b');
    db.close();
  });

  test('a failing migration rolls back and leaves the version unrecorded', () => {
    const db = memory();
    expect(() => runMigrations(db, [M(1, 'CREATE TABLE ok(x INTEGER); THIS IS NOT SQL;')]))
      .toThrow();
    expect(tableNames(db)).not.toContain('ok');
    const recorded = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(recorded.n).toBe(0);
    db.close();
  });

  test('rejects duplicate or out-of-order versions', () => {
    const db = memory();
    expect(() => runMigrations(db, [M(2, 'SELECT 1'), M(1, 'SELECT 1')])).toThrow(ConfigError);
    expect(() => runMigrations(db, [M(1, 'SELECT 1'), M(1, 'SELECT 1')])).toThrow(ConfigError);
    expect(() => runMigrations(db, [M(0, 'SELECT 1')])).toThrow(ConfigError);
    db.close();
  });
});

describe('shipped schemas', () => {
  test('the account schema applies cleanly', () => {
    const db = memory();
    runMigrations(db, ACCOUNT_MIGRATIONS);
    const names = tableNames(db);
    for (
      const t of ['room_configs', 'allowed_senders', 'rules', 'job_results', 'latency_rollups']
    ) {
      expect(names).toContain(t);
    }
    db.close();
  });

  test('the control schema applies cleanly and keeps one worker per owner', () => {
    const db = memory();
    runMigrations(db, CONTROL_MIGRATIONS);
    const now = Date.now();
    db.prepare('INSERT INTO users (user_id, created_at, updated_at) VALUES (?,?,?)')
      .run('o1', now, now);
    db.prepare('INSERT INTO deployments (owner_id, worker_id, updated_at) VALUES (?,?,?)')
      .run('o1', 'w1', now);
    // owner_id is the primary key, so a second worker for the same owner cannot
    // be inserted — the disjointness rule enforced by the schema itself.
    expect(() =>
      db.prepare('INSERT INTO deployments (owner_id, worker_id, updated_at) VALUES (?,?,?)')
        .run('o1', 'w2', now)
    ).toThrow();
    db.close();
  });

  test('account rules reject an unknown match kind', () => {
    const db = memory();
    runMigrations(db, ACCOUNT_MIGRATIONS);
    const now = Date.now();
    expect(() =>
      db.prepare(
        'INSERT INTO rules (rule_id, priority, kind, pattern, reply, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run('r1', 0, 'fuzzy', 'x', 'y', now, now)
    ).toThrow();
    db.close();
  });
});
