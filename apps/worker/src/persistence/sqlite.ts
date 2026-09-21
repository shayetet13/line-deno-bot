import { DatabaseSync } from 'node:sqlite';
import { ConfigError } from '../errors/base.ts';
import type { Logger } from '../logging/logger.ts';

export type Database = DatabaseSync;

export interface Migration {
  /** Strictly increasing. Never renumber or edit a migration that has shipped —
   * add a new one (`CLAUDE .md` §6). */
  version: number;
  name: string;
  up: string;
}

/**
 * Opens a database in WAL mode.
 *
 * WAL lets readers run while a write is in flight, which is what keeps the
 * write-behind worker from ever blocking a reader — but there is still only one
 * writer at a time per database, so each account gets its own file
 * (Phases §15 / `[S15]`).
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // NORMAL is the documented pairing for WAL: durable across app crashes,
  // trading only the last transactions on an OS-level crash.
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`;

export interface MigrationResult {
  applied: readonly number[];
  alreadyAt: number;
}

/**
 * Applies pending migrations in order, each in its own transaction, recording
 * what ran. Re-running is a no-op.
 *
 * @throws {ConfigError} on duplicate or non-increasing versions — a mistake
 * that would otherwise apply schemas in an undefined order.
 */
export function runMigrations(
  db: Database,
  migrations: readonly Migration[],
  logger?: Logger,
): MigrationResult {
  assertOrdered(migrations);
  db.exec(MIGRATION_TABLE);

  const current = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  const alreadyAt = current?.v ?? 0;
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= alreadyAt) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
      db.exec('COMMIT');
      applied.push(migration.version);
      logger?.info('migration applied', { version: migration.version, name: migration.name });
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { applied, alreadyAt };
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new ConfigError('migration version must be an integer >= 1', {
        version: migration.version,
      });
    }
    if (migration.version <= previous) {
      throw new ConfigError('migrations must be strictly increasing', {
        version: migration.version,
        previous,
      });
    }
    previous = migration.version;
  }
}
