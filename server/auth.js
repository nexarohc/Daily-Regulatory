import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { config } from './config.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Password hashing with scrypt (node:crypto, no native dependency).
 * Stored as scrypt$N$r$p$salt$hash so parameters can be raised later without
 * invalidating existing hashes.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const hash = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters.';
  }
  if (password.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain both letters and numbers.';
  }
  return null;
}

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function validateEmail(email) {
  // Deliberately permissive; the address only needs to be a plausible mailbox.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

// ------------------------------------------------------------------ sessions

export function createSession(userId, { ip, userAgent }) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionTtlMs);

  db.prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    csrfToken,
    created.toISOString(),
    expires.toISOString(),
    ip ?? null,
    (userAgent ?? '').slice(0, 300),
  );

  return { id, csrfToken, expires };
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.csrf_token, s.expires_at,
              u.email, u.name, u.organisation, u.role, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionId);

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    destroySession(sessionId);
    return null;
  }
  return row;
}

export function destroySession(sessionId) {
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function destroyAllSessionsFor(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function setSessionCookie(res, session) {
  res.cookie(config.cookieName, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: session.expires,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

// ---------------------------------------------------------------- middleware

/** Attaches req.session/req.user when a valid session cookie is present. */
export function loadSession(req, _res, next) {
  const sessionId = req.cookies?.[config.cookieName];
  const session = getSession(sessionId);
  if (session) {
    req.session = session;
    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      organisation: session.organisation,
      role: session.role,
      status: session.status,
    };
  }
  next();
}

/**
 * Gate for everything that exposes regulatory data. Only an authenticated
 * account in `active` status gets through.
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to access this content.' });
  }
  if (req.user.status !== 'active') {
    return res.status(403).json({
      error:
        req.user.status === 'pending'
          ? 'Your account is awaiting approval by an administrator.'
          : 'Your account is not active. Contact support.',
    });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

/**
 * CSRF: the session cookie is SameSite=Lax, and every state-changing request
 * must additionally echo the session's CSRF token in the X-CSRF-Token header.
 */
export function requireCsrf(req, res, next) {
  const sent = req.get('x-csrf-token');
  const expected = req.session?.csrf_token;
  if (!expected || !sent || sent.length !== expected.length) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  const ok = crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  next();
}

// --------------------------------------------------------------- rate limits

/**
 * Fixed-window limiter backed by SQLite so limits survive a restart and are
 * shared across workers.
 */
export function rateLimit({ key, limit, windowMs }) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?')
    .get(key, since);

  if (n >= limit) return false;
  db.prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').run(key, nowIso());
  return true;
}

export function clearRateLimit(key) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

// -------------------------------------------------------------------- users

export function createUser({ email, name, organisation, password }) {
  const isAdmin = config.adminEmail && email === config.adminEmail;
  const status = config.requireApproval && !isAdmin ? 'pending' : 'active';

  const info = db
    .prepare(
      `INSERT INTO users (email, name, organisation, password_hash, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      email,
      name,
      organisation ?? '',
      hashPassword(password),
      isAdmin ? 'admin' : 'customer',
      status,
      nowIso(),
    );

  return getUserById(Number(info.lastInsertRowid));
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    organisation: user.organisation,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  };
}
