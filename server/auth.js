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
              u.email, u.username, u.name, u.company, u.country, u.role, u.status
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
      username: session.username,
      name: session.name,
      company: session.company,
      country: session.country,
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

export function createUser({ email, username, name, company, country, organisation, password }) {
  const isAdmin = config.adminEmail && email === config.adminEmail;
  const status = config.requireApproval && !isAdmin ? 'pending' : 'active';

  const info = db
    .prepare(
      `INSERT INTO users (email, username, name, company, country, organisation,
                          password_hash, role, status, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      email,
      username ?? '',
      name,
      company ?? organisation ?? '',
      country ?? '',
      organisation ?? company ?? '',
      hashPassword(password),
      isAdmin ? 'admin' : 'subscriber',
      status,
      nowIso(),
      nowIso(),
    );

  const user = getUserById(Number(info.lastInsertRowid));

  // Every subscriber starts on a trial period so the account page always has
  // a meaningful subscription state to show.
  if (!isAdmin) {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + config.trialDays * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan, status, currency, amount, started_at, renews_at)
       VALUES (?, 'standard', 'trial', ?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).run(
      user.id,
      config.currency,
      config.defaultPlanAmount,
      now.toISOString(),
      trialEnd.toISOString(),
    );
  }

  return user;
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

/** Subscribers sign in with a username or their email address. */
export function getUserByLogin(identifier) {
  const value = String(identifier ?? '').trim().toLowerCase();
  if (!value) return null;
  return (
    db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(value) ??
    db.prepare('SELECT * FROM users WHERE email = ?').get(value) ??
    null
  );
}

export function validateUsername(username) {
  if (typeof username !== 'string') return 'Choose a username.';
  const value = username.trim();
  if (value.length < 3 || value.length > 40) {
    return 'Username must be between 3 and 40 characters.';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    return 'Username may contain only letters, numbers, dots, hyphens and underscores.';
  }
  return null;
}

// ------------------------------------------------- two-step sign-in codes

/** Numeric passcode, zero-padded so it is always the configured length. */
function generatePasscode() {
  const max = 10 ** config.passcodeLength;
  return String(crypto.randomInt(0, max)).padStart(config.passcodeLength, '0');
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * Record a pending sign-in. The password has been accepted at this point, but
 * no session exists until the emailed passcode is verified.
 */
export function createLoginChallenge(userId, { portal, ip, userAgent }) {
  const id = crypto.randomBytes(24).toString('base64url');
  const code = generatePasscode();
  const now = new Date();

  // Only one live challenge per account.
  db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId);

  db.prepare(
    `INSERT INTO login_challenges
       (id, user_id, code_hash, portal, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    hashCode(code),
    portal,
    now.toISOString(),
    new Date(now.getTime() + config.passcodeTtlMs).toISOString(),
    ip ?? null,
    (userAgent ?? '').slice(0, 300),
  );

  return { id, code };
}

/**
 * Check a submitted passcode. Returns { ok } or { error } describing why not,
 * consuming the challenge on success and counting attempts on failure.
 */
export function verifyLoginChallenge(challengeId, code, portal) {
  const challenge = db
    .prepare('SELECT * FROM login_challenges WHERE id = ?')
    .get(String(challengeId ?? ''));

  if (!challenge || challenge.consumed_at) {
    return { error: 'This sign-in request is no longer valid. Start again.' };
  }
  if (challenge.portal !== portal) {
    return { error: 'This sign-in request is no longer valid. Start again.' };
  }
  if (new Date(challenge.expires_at) < new Date()) {
    db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challenge.id);
    return { error: 'That passcode has expired. Request a new one.' };
  }
  if (challenge.attempts >= config.passcodeMaxAttempts) {
    db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challenge.id);
    return { error: 'Too many incorrect passcodes. Start again.' };
  }

  const submitted = hashCode(String(code ?? '').trim());
  const expected = challenge.code_hash;
  const match =
    submitted.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));

  if (!match) {
    db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?').run(
      challenge.id,
    );
    const left = config.passcodeMaxAttempts - (challenge.attempts + 1);
    return {
      error:
        left > 0
          ? `Incorrect passcode. ${left} attempt${left === 1 ? '' : 's'} remaining.`
          : 'Too many incorrect passcodes. Start again.',
    };
  }

  db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challenge.id);
  return { ok: true, userId: challenge.user_id };
}

export function pruneChallenges() {
  db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(nowIso());
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(nowIso());
}

// -------------------------------------------------------- password resets

export function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomBytes(12).toString('hex'),
    userId,
    hashCode(token),
    now.toISOString(),
    new Date(now.getTime() + config.resetTtlMs).toISOString(),
  );

  return token;
}

export function consumePasswordReset(token) {
  const row = db
    .prepare('SELECT * FROM password_resets WHERE token_hash = ?')
    .get(hashCode(String(token ?? '')));

  if (!row || row.used_at) return { error: 'This reset link is not valid.' };
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_resets WHERE id = ?').run(row.id);
    return { error: 'This reset link has expired. Request a new one.' };
  }

  db.prepare('DELETE FROM password_resets WHERE id = ?').run(row.id);
  return { ok: true, userId: row.user_id };
}

/** Mask an address for display during two-step sign-in. */
export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '•••';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'•'.repeat(Math.max(local.length - head.length, 2))}@${domain}`;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    company: user.company || user.organisation,
    country: user.country,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    lastLoginAt: user.previous_login_at,
  };
}
