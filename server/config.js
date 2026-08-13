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

  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'timely-regulatory.db'),

  // Sessions are stored server-side; the cookie only carries an opaque id.
  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
  cookieName: 'tr_session',
  // Set COOKIE_SECURE=1 behind HTTPS in production.
  cookieSecure: bool(process.env.COOKIE_SECURE, false),

  // Ingestion
  pollIntervalMs: int(process.env.POLL_INTERVAL_MINUTES, 15) * 60 * 1000,
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 20000),
  fetchConcurrency: int(process.env.FETCH_CONCURRENCY, 6),
  userAgent:
    process.env.FEED_USER_AGENT ||
    'TimelyRegulatory/1.0 (+regulatory intelligence aggregator; contact: admin@example.com)',
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

  // Two-step sign-in. The emailed passcode is mandatory; it can only be
  // disabled deliberately, for a deployment with no mail service at all.
  requireLoginPasscode: bool(process.env.REQUIRE_LOGIN_PASSCODE, true),
  passcodeLength: 6,
  passcodeTtlMs: int(process.env.PASSCODE_TTL_MINUTES, 10) * 60 * 1000,
  passcodeMaxAttempts: int(process.env.PASSCODE_MAX_ATTEMPTS, 5),
  resetTtlMs: int(process.env.RESET_TTL_MINUTES, 60) * 60 * 1000,

  // Public origin, used to build password-reset links in email.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Timely Regulatory <no-reply@example.com>',
  },

  // Subscriptions. The payment link points at whatever checkout the operator
  // uses (Stripe payment link, invoice portal, and so on); the app records
  // receipts but does not process cards itself.
  paymentUrl: process.env.PAYMENT_URL || '',
  currency: process.env.CURRENCY || 'USD',
  defaultPlanAmount: Number(process.env.PLAN_AMOUNT || 0),
  trialDays: int(process.env.TRIAL_DAYS, 14),
  // Days before renewal that an account is flagged as due.
  renewalWarningDays: int(process.env.RENEWAL_WARNING_DAYS, 14),
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
