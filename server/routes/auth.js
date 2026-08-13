import express from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import {
  clearRateLimit,
  clearSessionCookie,
  consumePasswordReset,
  createLoginChallenge,
  createPasswordReset,
  createSession,
  createUser,
  destroySession,
  getUserByEmail,
  getUserById,
  getUserByLogin,
  hashPassword,
  maskEmail,
  normaliseEmail,
  publicUser,
  rateLimit,
  requireAuth,
  requireCsrf,
  setSessionCookie,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyLoginChallenge,
  verifyPassword,
} from '../auth.js';
import { sendLoginCode, sendPasswordReset } from '../mailer.js';

export const authRouter = express.Router();

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

/**
 * Sign-in is two steps for both portals:
 *   1. POST /login   - password checked, passcode emailed, challenge returned
 *   2. POST /verify  - passcode checked, session issued
 *
 * The portal ("subscriber" or "admin") is bound into the challenge, so a
 * challenge raised at one portal can never be completed at the other.
 */
function startLogin(req, res, portal) {
  const ip = clientIp(req);
  const identifier = String(req.body?.identifier ?? req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '');

  const ipOk = rateLimit({ key: `login:ip:${ip}`, limit: 25, windowMs: 15 * 60 * 1000 });
  const idOk = rateLimit({
    key: `login:id:${identifier.toLowerCase()}`,
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!ipOk || !idOk) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait a few minutes.' });
  }

  const user = getUserByLogin(identifier);
  const ok = user ? verifyPassword(password, user.password_hash) : false;

  // Identical response whether the account is missing or the password is wrong.
  if (!user || !ok) {
    return res.status(401).json({ error: 'Incorrect credentials.' });
  }

  // Portal separation: each login page accepts only its own kind of account.
  const isAdmin = user.role === 'admin';
  if (portal === 'admin' && !isAdmin) {
    return res.status(403).json({ error: 'This account is not an administrator.' });
  }
  if (portal === 'subscriber' && isAdmin) {
    return res.status(403).json({
      error: 'Administrator accounts sign in through the administrator portal at /admin.',
    });
  }

  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is awaiting approval by an administrator.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Your account is not active. Contact support.' });
  }

  clearRateLimit(`login:id:${identifier.toLowerCase()}`);

  // Passcode disabled only by deliberate configuration.
  if (!config.requireLoginPasscode) {
    return issueSession(req, res, user, { passcode: false });
  }

  const challenge = createLoginChallenge(user.id, {
    portal,
    ip,
    userAgent: req.get('user-agent'),
  });

  // Delivery is fire-and-forget: the response must not reveal whether the
  // mail server accepted the message.
  sendLoginCode({
    to: user.email,
    name: user.name,
    code: challenge.code,
    minutes: Math.round(config.passcodeTtlMs / 60000),
  }).catch(() => {});

  res.json({
    passcodeRequired: true,
    challengeId: challenge.id,
    sentTo: maskEmail(user.email),
    expiresInMinutes: Math.round(config.passcodeTtlMs / 60000),
  });
}

function completeLogin(req, res, portal) {
  const ip = clientIp(req);
  if (!rateLimit({ key: `verify:ip:${ip}`, limit: 30, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  }

  const result = verifyLoginChallenge(req.body?.challengeId, req.body?.code, portal);
  if (!result.ok) return res.status(401).json({ error: result.error });

  const user = getUserById(result.userId);
  if (!user || user.status !== 'active') {
    return res.status(403).json({ error: 'Your account is not active. Contact support.' });
  }

  issueSession(req, res, user, { passcode: true });
}

function issueSession(req, res, user, { passcode }) {
  const session = createSession(user.id, {
    ip: clientIp(req),
    userAgent: req.get('user-agent'),
  });
  setSessionCookie(res, session);

  // Keep the prior sign-in so the account page can show "last login".
  db.prepare(
    'UPDATE users SET previous_login_at = last_login_at, last_login_at = ? WHERE id = ?',
  ).run(nowIso(), user.id);

  res.json({
    user: publicUser(getUserById(user.id)),
    csrfToken: session.csrfToken,
    passcodeVerified: passcode,
    home: user.role === 'admin' ? '/admin/dashboard' : '/app',
  });
}

// ------------------------------------------------------------- subscriber

authRouter.post('/register', (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit({ key: `register:${ip}`, limit: 5, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
  }

  const email = normaliseEmail(req.body?.email);
  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const name = String(req.body?.name ?? '').trim();
  const company = String(req.body?.company ?? '').trim();
  const country = String(req.body?.country ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'Please provide your full name.' });
  }
  if (!company || company.length > 160) {
    return res.status(400).json({ error: 'Please provide your company name.' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid work email address.' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: 'That username is taken. Choose another.' });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({
      error: 'That email address cannot be registered. If you already have an account, sign in.',
    });
  }

  const user = createUser({ email, username, name, company, country, password });

  if (user.status !== 'active') {
    return res.status(202).json({
      pending: true,
      message:
        'Registration received. An administrator will approve your account before you can sign in.',
    });
  }

  // Registration does not sign you in: the passcode step still applies.
  res.status(201).json({
    registered: true,
    message: 'Account created. Sign in with your username and password to continue.',
  });
});

authRouter.post('/login', (req, res) => startLogin(req, res, 'subscriber'));
authRouter.post('/verify', (req, res) => completeLogin(req, res, 'subscriber'));

/** Re-send a passcode for an in-flight challenge. */
authRouter.post('/resend', (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit({ key: `resend:ip:${ip}`, limit: 6, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many passcode requests. Please wait.' });
  }

  const challenge = db
    .prepare('SELECT * FROM login_challenges WHERE id = ?')
    .get(String(req.body?.challengeId ?? ''));
  if (!challenge) {
    return res.status(400).json({ error: 'This sign-in request is no longer valid. Start again.' });
  }

  const user = getUserById(challenge.user_id);
  if (!user) return res.status(400).json({ error: 'This sign-in request is no longer valid.' });

  const next = createLoginChallenge(user.id, {
    portal: challenge.portal,
    ip,
    userAgent: req.get('user-agent'),
  });

  sendLoginCode({
    to: user.email,
    name: user.name,
    code: next.code,
    minutes: Math.round(config.passcodeTtlMs / 60000),
  }).catch(() => {});

  res.json({ challengeId: next.id, sentTo: maskEmail(user.email) });
});

// ---------------------------------------------------------- administrator

authRouter.post('/admin/login', (req, res) => startLogin(req, res, 'admin'));
authRouter.post('/admin/verify', (req, res) => completeLogin(req, res, 'admin'));

// ------------------------------------------------------- password recovery

authRouter.post('/forgot', async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit({ key: `forgot:ip:${ip}`, limit: 8, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const identifier = String(req.body?.identifier ?? req.body?.email ?? '').trim();
  const user = getUserByLogin(identifier);

  // Always the same answer, so this cannot be used to discover accounts.
  const answer = {
    ok: true,
    message:
      'If that account exists, a password reset link has been sent to its registered email address.',
  };

  if (!user || user.status === 'suspended') return res.json(answer);

  const token = createPasswordReset(user.id);
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/reset?token=${encodeURIComponent(token)}`;

  sendPasswordReset({
    to: user.email,
    name: user.name,
    url,
    minutes: Math.round(config.resetTtlMs / 60000),
  }).catch(() => {});

  res.json(answer);
});

authRouter.post('/reset', (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit({ key: `reset:ip:${ip}`, limit: 10, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many attempts. Please wait.' });
  }

  const password = String(req.body?.password ?? '');
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const result = consumePasswordReset(req.body?.token);
  if (!result.ok) return res.status(400).json({ error: result.error });

  db.prepare(
    'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
  ).run(hashPassword(password), nowIso(), result.userId);

  // A reset invalidates every existing session for that account.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(result.userId);

  res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
});

// ---------------------------------------------------------------- session

authRouter.post('/logout', requireAuth, requireCsrf, (req, res) => {
  destroySession(req.session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({
    user: req.user,
    csrfToken: req.session.csrf_token,
    requireApproval: config.requireApproval,
  });
});

authRouter.post('/change-password', requireAuth, requireCsrf, (req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');

  const user = getUserById(req.user.id);
  if (!verifyPassword(current, user.password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }
  const passwordError = validatePassword(next);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (current === next) {
    return res.status(400).json({ error: 'Choose a password different from the current one.' });
  }

  db.prepare(
    'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
  ).run(hashPassword(next), nowIso(), user.id);

  // Keep this session, drop the others.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, req.session.id);

  res.json({ ok: true, message: 'Password changed. Other sessions have been signed out.' });
});
