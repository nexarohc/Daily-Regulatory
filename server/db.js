import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ALL_SOURCES } from './ingest/sources.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

// WAL keeps reads from blocking while the ingester writes.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  organisation  TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'customer',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  authority     TEXT NOT NULL,
  agency        TEXT NOT NULL,
  country       TEXT NOT NULL,
  country_code  TEXT NOT NULL,
  region        TEXT NOT NULL,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  site          TEXT NOT NULL,
  feed          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  lang          TEXT NOT NULL,
  topic         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  etag          TEXT,
  last_modified TEXT,
  last_status   TEXT,
  last_error    TEXT,
  last_fetch_at TEXT,
  last_success_at TEXT,
  item_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS updates (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  link         TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  category     TEXT NOT NULL,
  severity     TEXT NOT NULL,
  is_sample    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_updates_published ON updates(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_updates_source ON updates(source_id);
CREATE INDEX IF NOT EXISTS idx_updates_category ON updates(category);
CREATE INDEX IF NOT EXISTS idx_updates_severity ON updates(severity);
CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_link ON updates(link);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  update_id  TEXT    NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, update_id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(key, at);

-- Two-step sign-in: a challenge is created once the password is accepted, and
-- exchanged for a session only when the emailed passcode is verified.
CREATE TABLE IF NOT EXISTS login_challenges (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT    NOT NULL,
  portal      TEXT    NOT NULL DEFAULT 'subscriber',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  consumed_at TEXT,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON login_challenges(expires_at);

-- Single-use password reset tokens.
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_resets_expiry ON password_resets(expires_at);

-- One subscription row per account, carrying the current billing period.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan           TEXT    NOT NULL DEFAULT 'standard',
  status         TEXT    NOT NULL DEFAULT 'trial',
  currency       TEXT    NOT NULL DEFAULT 'USD',
  amount         REAL    NOT NULL DEFAULT 0,
  started_at     TEXT,
  last_paid_at   TEXT,
  renews_at      TEXT,
  seats          INTEGER NOT NULL DEFAULT 1,
  notes          TEXT    NOT NULL DEFAULT ''
);

-- Payments the administrator has recorded against an account. This is a
-- ledger of real receipts, not a card-processing integration.
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      REAL    NOT NULL,
  currency    TEXT    NOT NULL DEFAULT 'USD',
  method      TEXT    NOT NULL DEFAULT 'bank-transfer',
  reference   TEXT    NOT NULL DEFAULT '',
  period_from TEXT,
  period_to   TEXT,
  paid_at     TEXT    NOT NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid ON payments(paid_at);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER,
  subject    TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
`);

/**
 * Additive migrations for databases created by an earlier version. SQLite has
 * no "ADD COLUMN IF NOT EXISTS", so existing columns are read first.
 */
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
const addUserColumn = (name, definition) => {
  if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
};

addUserColumn('username', "TEXT NOT NULL DEFAULT ''");
addUserColumn('company', "TEXT NOT NULL DEFAULT ''");
addUserColumn('country', "TEXT NOT NULL DEFAULT ''");
addUserColumn('previous_login_at', 'TEXT');
addUserColumn('password_changed_at', 'TEXT');

// Usernames must be unique, but only where set (legacy rows may be blank).
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
     ON users(username) WHERE username != ''`,
);

// The customer role was renamed to subscriber.
db.exec("UPDATE users SET role = 'subscriber' WHERE role = 'customer'");

/**
 * Reconcile the sources table with the static registry. Metadata is owned by
 * the code; health columns (etag, last_status, ...) are owned by the database
 * and preserved across restarts.
 */
export function syncSources() {
  const upsert = db.prepare(`
    INSERT INTO sources (id, authority, agency, country, country_code, region,
                         lat, lon, site, feed, kind, lang, topic, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      authority = excluded.authority,
      agency = excluded.agency,
      country = excluded.country,
      country_code = excluded.country_code,
      region = excluded.region,
      lat = excluded.lat,
      lon = excluded.lon,
      site = excluded.site,
      kind = excluded.kind,
      lang = excluded.lang,
      topic = excluded.topic
  `);
  // `feed` and `enabled` are deliberately not overwritten on conflict: feed
  // discovery and the admin toggle own those columns once a row exists.

  for (const s of ALL_SOURCES) {
    upsert.run(
      s.id, s.authority, s.agency, s.country, s.countryCode, s.region,
      s.lat, s.lon, s.site, s.feed, s.kind, s.lang, s.topic,
      s.kind === 'directory' ? 0 : 1,
    );
  }

  // Drop sources that are no longer in the registry (cascades to updates).
  const known = ALL_SOURCES.map((s) => s.id);
  const placeholders = known.map(() => '?').join(',');
  db.prepare(`DELETE FROM sources WHERE id NOT IN (${placeholders})`).run(...known);
}

export function nowIso() {
  return new Date().toISOString();
}

/** Remove expired sessions and stale rate-limit rows. */
export function pruneEphemeral() {
  const now = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(cutoff);
}

/** Drop updates older than the retention window, keeping bookmarked items. */
export function pruneOldUpdates() {
  const cutoff = new Date(
    Date.now() - config.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `DELETE FROM updates
        WHERE published_at < ?
          AND id NOT IN (SELECT update_id FROM bookmarks)`,
    )
    .run(cutoff);
  return result.changes;
}
