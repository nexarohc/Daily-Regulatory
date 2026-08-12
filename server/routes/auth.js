import express from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import {
  createSession,
  createUser,
  clearRateLimit,
  clearSessionCookie,
  destroySession,
  getUserByEmail,
  hashPassword,
  normaliseEmail,
  publicUser,
  rateLimit,
  requireAuth,
  requireCsrf,
  setSessionCookie,
  validateEmail,
  validatePassword,
  verifyPassword,
} from '../auth.js';

export const authRouter = express.Router();

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

authRouter.post('/register', (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit({ key: `register:${ip}`, limit: 5, windowMs: 60 * 60 * 1000 })) {
    return res
      .status(429)
      .json({ error: 'Too many registration attempts. Try again later.' });
  }

  const email = normaliseEmail(req.body?.email);
  const name = String(req.body?.name ?? '').trim();
  const organisation = String(req.body?.organisation ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'Please provide your name.' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  if (getUserByEmail(email)) {
    // Do not disclose whether an address is already registered.
    return res.status(409).json({
      error: 'That email address cannot be registered. If you already have an account, sign in.',
    });
  }

  const user = createUser({ email, name, organisation, password });

  if (user.status !== 'active') {
    return res.status(202).json({
      pending: true,
      message:
        'Registration received. An administrator will approve your account before you can sign in.',
    });
  }

  const session = createSession(user.id, { ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, session);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

  res.status(201).json({ user: publicUser(user), csrfToken: session.csrfToken });
});

authRouter.post('/login', (req, res) => {
  const ip = clientIp(req);
  const email = normaliseEmail(req.body?.email);
  const password = String(req.body?.password ?? '');

  // Limit by address and by IP so neither a single account nor a single host
  // can be hammered.
  const ipOk = rateLimit({ key: `login:ip:${ip}`, limit: 20, windowMs: 15 * 60 * 1000 });
  const emailOk = rateLimit({ key: `login:email:${email}`, limit: 10, windowMs: 15 * 60 * 1000 });
  if (!ipOk || !emailOk) {
    return res
      .status(429)
      .json({ error: 'Too many sign-in attempts. Please wait a few minutes.' });
  }

  const user = email ? getUserByEmail(email) : null;
  const ok = user ? verifyPassword(password, user.password_hash) : false;

  if (!user || !ok) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (user.status === 'pending') {
    return res
      .status(403)
      .json({ error: 'Your account is awaiting approval by an administrator.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Your account is not active. Contact support.' });
  }

  clearRateLimit(`login:email:${email}`);

  const session = createSession(user.id, { ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, session);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

  res.json({ user: publicUser(user), csrfToken: session.csrfToken });
});

authRouter.post('/logout', requireAuth, requireCsrf, (req, res) => {
  destroySession(req.session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Who am I - used by the client to restore state on load. */
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

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, user.password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }
  const passwordError = validatePassword(next);
  if (passwordError) return res.status(400).json({ error: passwordError });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(next),
    user.id,
  );

  // Keep the current session, drop the rest.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(
    user.id,
    req.session.id,
  );

  res.json({ ok: true });
});
