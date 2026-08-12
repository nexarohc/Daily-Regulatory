import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'daily-regulatory.db'),

  // Sessions are stored server-side; the cookie only carries an opaque id.
  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
  cookieName: 'dr_session',
  // Set COOKIE_SECURE=1 behind HTTPS in production.
  cookieSecure: bool(process.env.COOKIE_SECURE, false),

  // Ingestion
  pollIntervalMs: int(process.env.POLL_INTERVAL_MINUTES, 15) * 60 * 1000,
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 20000),
  fetchConcurrency: int(process.env.FETCH_CONCURRENCY, 6),
  userAgent:
    process.env.FEED_USER_AGENT ||
    'DailyRegulatory/1.0 (+regulatory intelligence aggregator; contact: admin@example.com)',
  // Poll on boot, then on the interval. Disable for tests.
  autoIngest: bool(process.env.AUTO_INGEST, true),
  // When the network cannot reach any source (offline / restricted egress),
  // load the bundled sample corpus so the app is still explorable.
  seedWhenEmpty: bool(process.env.SEED_WHEN_EMPTY, true),
  retentionDays: int(process.env.RETENTION_DAYS, 180),

  // Access control: every registered account is a "customer". When
  // REQUIRE_APPROVAL=1, new accounts sit in `pending` until an admin approves.
  requireApproval: bool(process.env.REQUIRE_APPROVAL, false),
  // First account to register with this email is promoted to admin.
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
};

// A stable secret keeps sessions valid across restarts in development. In
// production set SESSION_SECRET so restarts do not silently rotate it.
export const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.warn(
    '[config] SESSION_SECRET is not set - generated a random one. Sessions will not survive a restart.',
  );
}
