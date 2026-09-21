import type { Migration } from './sqlite.ts';

/**
 * Per-account schema (`accounts/<account-id>.sqlite`).
 *
 * One file per account rather than one shared database with a tenant column:
 * SQLite has no row-level security, and WAL still allows only one writer per
 * database, so separate files give both isolation and write parallelism
 * (decision doc §8 step 7, Phases §15).
 */
export const ACCOUNT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial account schema',
    up: `
      CREATE TABLE room_configs (
        room_id     TEXT PRIMARY KEY,
        surface     TEXT NOT NULL CHECK (surface IN ('talk','square','oa')),
        enabled     INTEGER NOT NULL DEFAULT 0,
        dedicated_poll INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );

      -- Senders are trusted by immutable id only; display_name is a memory aid
      -- and must never be used to decide (Phase 0 §3).
      CREATE TABLE allowed_senders (
        sender_id    TEXT NOT NULL,
        room_id      TEXT NOT NULL REFERENCES room_configs(room_id) ON DELETE CASCADE,
        display_name TEXT,
        created_at   INTEGER NOT NULL,
        deleted_at   INTEGER,
        PRIMARY KEY (sender_id, room_id)
      );
      CREATE INDEX idx_allowed_senders_room ON allowed_senders(room_id);

      CREATE TABLE rules (
        rule_id    TEXT PRIMARY KEY,
        room_id    TEXT REFERENCES room_configs(room_id) ON DELETE CASCADE,
        priority   INTEGER NOT NULL DEFAULT 0,
        kind       TEXT NOT NULL CHECK (kind IN ('exact','prefix','contains')),
        pattern    TEXT NOT NULL,
        reply      TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX idx_rules_room_enabled ON rules(room_id, enabled);

      CREATE TABLE warm_schedules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timezone    TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end   TEXT NOT NULL,
        warm_start   TEXT NOT NULL,
        interval_ms  INTEGER NOT NULL,
        tick_count   INTEGER NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      -- The worker ACKs the generation it is actually running, so the control
      -- plane can tell "config sent" from "config live" (Phases §15).
      CREATE TABLE config_generations (
        generation  INTEGER PRIMARY KEY,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        acked_at    INTEGER
      );

      -- Encrypted at rest; the key lives outside this file.
      CREATE TABLE encrypted_session_records (
        bot_id      TEXT PRIMARY KEY,
        ciphertext  BLOB NOT NULL,
        nonce       BLOB NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Reserve a request-sequence range before using it; a restart must skip
      -- the reserved block rather than replay it (Phases §7.2).
      CREATE TABLE sequence_reservations (
        bot_id         TEXT PRIMARY KEY,
        high_watermark INTEGER NOT NULL,
        reserved_at    INTEGER NOT NULL
      );

      CREATE TABLE job_results (
        job_key      TEXT PRIMARY KEY,
        room_id      TEXT NOT NULL,
        rule_id      TEXT,
        outcome      TEXT NOT NULL CHECK (outcome IN ('won','lost','unknown')),
        first_attempt_ms REAL,
        send_rtt_ms  REAL,
        inbound_ms   REAL,
        source       TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_job_results_created ON job_results(created_at);
      CREATE INDEX idx_job_results_room ON job_results(room_id, created_at);

      CREATE TABLE latency_rollups (
        bucket_start INTEGER NOT NULL,
        span         TEXT NOT NULL,
        count        INTEGER NOT NULL,
        p50          REAL NOT NULL,
        p95          REAL NOT NULL,
        p99          REAL NOT NULL,
        max          REAL NOT NULL,
        PRIMARY KEY (bucket_start, span)
      );

      CREATE TABLE operational_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        detail     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_operational_events_created ON operational_events(created_at);
    `,
  },
];

/**
 * Control-plane schema (`control.sqlite`) — users, ownership and which worker
 * serves which owner. Kept apart from account data so a worker never needs
 * read access to another owner's credentials.
 */
export const CONTROL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial control schema',
    up: `
      CREATE TABLE users (
        user_id    TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      -- LINE Login identity for the website. Separate from a self-bot session:
      -- logging into the site never grants message access (Phases §15).
      CREATE TABLE line_identities (
        line_sub    TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        display_name TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_line_identities_user ON line_identities(user_id);

      CREATE TABLE web_sessions (
        session_id  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        revoked_at  INTEGER
      );
      CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);
      CREATE INDEX idx_web_sessions_expiry ON web_sessions(expires_at);

      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        label      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX idx_accounts_owner ON accounts(owner_id);

      -- Shard assignment. UNIQUE(owner_id) is the schema-level guarantee behind
      -- the disjointness rule: one owner can never map to two workers.
      CREATE TABLE deployments (
        owner_id   TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        worker_id  TEXT NOT NULL,
        worker_url TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_deployments_worker ON deployments(worker_id);
    `,
  },
];
