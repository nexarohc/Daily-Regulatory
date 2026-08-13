import express from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireCsrf } from '../auth.js';

export const accountRouter = express.Router();

accountRouter.use(requireAuth);

/** Days from now until the given date; negative once it is in the past. */
function daysUntil(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - Date.now()) / 86_400_000);
}

/**
 * GET /api/account
 * Everything the subscriber's account panel shows: identity, last sign-in,
 * subscription state, payment history and where to top up.
 */
accountRouter.get('/', (req, res) => {
  const user = db
    .prepare(
      `SELECT id, email, username, name, company, country, role, status,
              created_at, last_login_at, previous_login_at, password_changed_at
         FROM users WHERE id = ?`,
    )
    .get(req.user.id);

  const subscription =
    db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id) ?? null;

  const payments = db
    .prepare(
      `SELECT id, amount, currency, method, reference, period_from, period_to, paid_at
         FROM payments WHERE user_id = ? ORDER BY paid_at DESC LIMIT 24`,
    )
    .all(req.user.id);

  const totalPaid = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE user_id = ?')
    .get(req.user.id).total;

  const remaining = daysUntil(subscription?.renews_at);
  let standing = 'none';
  if (subscription) {
    if (remaining === null) standing = subscription.status;
    else if (remaining < 0) standing = 'expired';
    else if (subscription.status === 'trial') {
      // A trial reads as a trial for most of its life, and only starts
      // nagging near the end - otherwise a fresh signup looks overdue.
      standing = remaining <= 3 ? 'due-soon' : 'trial';
    } else if (remaining <= config.renewalWarningDays) standing = 'due-soon';
    else standing = 'active';
  }

  res.json({
    profile: {
      username: user.username,
      name: user.name,
      email: user.email,
      company: user.company,
      country: user.country,
      role: user.role,
      status: user.status,
      memberSince: user.created_at,
      // "Last login" means the sign-in before this one; the current session is
      // shown separately so the figure is not just "a moment ago".
      lastLoginAt: user.previous_login_at,
      currentSessionSince: user.last_login_at,
      passwordChangedAt: user.password_changed_at,
    },
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          standing,
          currency: subscription.currency,
          amount: subscription.amount,
          seats: subscription.seats,
          startedAt: subscription.started_at,
          lastPaidAt: subscription.last_paid_at,
          renewsAt: subscription.renews_at,
          daysRemaining: remaining,
          notes: subscription.notes,
        }
      : null,
    billing: {
      totalPaid,
      currency: config.currency,
      payments,
      // Empty until the operator configures a checkout link.
      paymentUrl: config.paymentUrl || null,
    },
  });
});

/** POST /api/account/feedback - subscriber feedback and reviews. */
accountRouter.post('/feedback', requireCsrf, (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  const subject = String(req.body?.subject ?? '').trim().slice(0, 160);
  const ratingRaw = Number(req.body?.rating);
  const rating = Number.isFinite(ratingRaw) ? Math.min(Math.max(Math.round(ratingRaw), 1), 5) : null;

  if (message.length < 4) {
    return res.status(400).json({ error: 'Please write a little more detail.' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'Feedback is limited to 4000 characters.' });
  }

  db.prepare(
    `INSERT INTO feedback (user_id, rating, subject, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(req.user.id, rating, subject, message, nowIso());

  res.status(201).json({ ok: true, message: 'Thank you — your feedback has been recorded.' });
});

/** The subscriber's own feedback history. */
accountRouter.get('/feedback', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, rating, subject, message, status, created_at
         FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(req.user.id);
  res.json(rows);
});

/** Update the editable parts of the profile. */
accountRouter.post('/profile', requireCsrf, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const company = String(req.body?.company ?? '').trim();
  const country = String(req.body?.country ?? '').trim();

  if (!name || name.length > 120) return res.status(400).json({ error: 'Enter your full name.' });
  if (!company || company.length > 160) {
    return res.status(400).json({ error: 'Enter your company name.' });
  }

  db.prepare('UPDATE users SET name = ?, company = ?, country = ? WHERE id = ?').run(
    name,
    company,
    country.slice(0, 80),
    req.user.id,
  );

  res.json({ ok: true });
});
