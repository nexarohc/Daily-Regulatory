import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { SOURCES } from './ingest/sources.js';

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
`);

/**
 * Reconcile the sources table with the static registry. Metadata is owned by
 * the code; health columns (etag, last_status, ...) are owned by the database
 * and preserved across restarts.
 */
export function syncSources() {
  const upsert = db.prepare(`
    INSERT INTO sources (id, authority, agency, country, country_code, region,
                         lat, lon, site, feed, kind, lang, topic)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      authority = excluded.authority,
      agency = excluded.agency,
      country = excluded.country,
      country_code = excluded.country_code,
      region = excluded.region,
      lat = excluded.lat,
      lon = excluded.lon,
      site = excluded.site,
      feed = excluded.feed,
      kind = excluded.kind,
      lang = excluded.lang,
      topic = excluded.topic
  `);

  for (const s of SOURCES) {
    upsert.run(
      s.id, s.authority, s.agency, s.country, s.countryCode, s.region,
      s.lat, s.lon, s.site, s.feed, s.kind, s.lang, s.topic,
    );
  }

  // Drop sources that are no longer in the registry (cascades to updates).
  const known = SOURCES.map((s) => s.id);
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
