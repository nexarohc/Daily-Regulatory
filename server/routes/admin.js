import express from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { destroyAllSessionsFor, requireAdmin, requireAuth, requireCsrf } from '../auth.js';
import { runIngestCycle, ingestState } from '../ingest/scheduler.js';
import { mailerStatus } from '../mailer.js';

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/dashboard
 *
 * The operator's overview: how many subscribers there are, where they are,
 * how much has actually been received, and who is overdue.
 *
 * Every money figure comes from payments recorded in this system. Nothing is
 * estimated or projected.
 */
adminRouter.get('/dashboard', (_req, res) => {
  const subscriberFilter = "role = 'subscriber'";

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
       FROM users WHERE ${subscriberFilter}`,
    )
    .get();

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const newThisMonth = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE ${subscriberFilter} AND created_at >= ?`)
    .get(thirtyDaysAgo).n;

  // --- subscribers by country -------------------------------------------
  const byCountry = db
    .prepare(
      `SELECT CASE WHEN TRIM(country) = '' THEN 'Not specified' ELSE country END AS country,
              COUNT(*) AS subscribers,
              COALESCE(SUM(p.paid), 0) AS revenue
         FROM users u
         LEFT JOIN (SELECT user_id, SUM(amount) AS paid FROM payments GROUP BY user_id) p
                ON p.user_id = u.id
        WHERE u.${subscriberFilter}
        GROUP BY country
        ORDER BY subscribers DESC, country`,
    )
    .all();

  // --- revenue -----------------------------------------------------------
  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count,
              MAX(paid_at) AS latest
         FROM payments`,
    )
    .get();

  const revenue30 = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_at >= ?')
    .get(thirtyDaysAgo).total;

  const revenueByMonth = db
    .prepare(
      `SELECT substr(paid_at, 1, 7) AS month, SUM(amount) AS total, COUNT(*) AS count
         FROM payments
        WHERE paid_at >= ?
        GROUP BY month ORDER BY month`,
    )
    .all(new Date(now.getTime() - 365 * 86_400_000).toISOString());

  // --- who has not paid --------------------------------------------------
  // Subscribers with no payment on record, or whose period has lapsed or is
  // about to. Ordered by how overdue they are.
  const warnAt = new Date(now.getTime() + config.renewalWarningDays * 86_400_000).toISOString();

  const outstanding = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.company, u.country, u.email, u.status,
              u.created_at, u.last_login_at,
              s.plan, s.status AS sub_status, s.amount, s.currency,
              s.last_paid_at, s.renews_at,
              (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) AS payment_count,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id) AS paid_total
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE u.${subscriberFilter}
          AND (
                (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) = 0
             OR s.renews_at IS NULL
             OR s.renews_at <= ?
          )
        ORDER BY COALESCE(s.renews_at, u.created_at) ASC
        LIMIT 100`,
    )
    .all(warnAt);

  const shaped = outstanding.map((row) => {
    const renews = row.renews_at ? new Date(row.renews_at).getTime() : null;
    const daysOverdue = renews === null ? null : Math.floor((Date.now() - renews) / 86_400_000);
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      company: row.company,
      country: row.country,
      email: row.email,
      status: row.status,
      plan: row.plan,
      subscriptionStatus: row.sub_status,
      amount: row.amount,
      currency: row.currency,
      lastPaidAt: row.last_paid_at,
      renewsAt: row.renews_at,
      paymentCount: row.payment_count,
      paidTotal: row.paid_total,
      neverPaid: row.payment_count === 0,
      daysOverdue: daysOverdue !== null && daysOverdue > 0 ? daysOverdue : null,
      joinedAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  });

  const recentSubscribers = db
    .prepare(
      `SELECT id, username, name, company, country, email, status, created_at, last_login_at
         FROM users WHERE ${subscriberFilter}
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all();

  const feedbackCount = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").get().n;

  res.json({
    subscribers: {
      total: totals.total ?? 0,
      active: totals.active ?? 0,
      pending: totals.pending ?? 0,
      suspended: totals.suspended ?? 0,
      newLast30Days: newThisMonth,
    },
    byCountry,
    revenue: {
      currency: config.currency,
      total: revenue.total,
      payments: revenue.count,
      last30Days: revenue30,
      latestPaymentAt: revenue.latest,
      byMonth: revenueByMonth,
    },
    outstanding: shaped,
    recentSubscribers,
    newFeedback: feedbackCount,
    mail: mailerStatus(),
  });
});

/** Full subscriber list with subscription and payment rollups. */
adminRouter.get('/subscribers', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const params = [];
  let where = "u.role = 'subscriber'";

  if (q) {
    where += ' AND (u.name LIKE ? OR u.company LIKE ? OR u.email LIKE ? OR u.username LIKE ?)';
    const term = `%${q.slice(0, 80)}%`;
    params.push(term, term, term, term);
  }

  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.company, u.country, u.email, u.status,
              u.created_at, u.last_login_at,
              s.plan, s.status AS sub_status, s.amount, s.currency, s.last_paid_at, s.renews_at,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id) AS paid_total,
              (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) AS payment_count
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE ${where}
        ORDER BY u.created_at DESC
        LIMIT 500`,
    )
    .all(...params);

  res.json(rows);
});

/**
 * Record a payment against a subscriber and roll their period forward.
 * This is the operator's own ledger entry, not a card transaction.
 */
adminRouter.post('/subscribers/:id/payments', requireCsrf, (req, res) => {
  const user = db
    .prepare("SELECT id FROM users WHERE id = ? AND role = 'subscriber'")
    .get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Subscriber not found.' });

  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter a payment amount greater than zero.' });
  }

  const months = Math.min(Math.max(Number(req.body?.months) || 12, 1), 60);
  const currency = String(req.body?.currency ?? config.currency).slice(0, 8);
  const method = String(req.body?.method ?? 'bank-transfer').slice(0, 40);
  const reference = String(req.body?.reference ?? '').slice(0, 120);
  const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) {
    return res.status(400).json({ error: 'Payment date is not valid.' });
  }

  // Extend from the current expiry when still in credit, otherwise from today,
  // so paying early never loses time and paying late does not backdate.
  const existing = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);
  const currentEnd = existing?.renews_at ? new Date(existing.renews_at) : null;
  const base = currentEnd && currentEnd > paidAt ? currentEnd : paidAt;
  const renewsAt = new Date(base);
  renewsAt.setMonth(renewsAt.getMonth() + months);

  db.prepare(
    `INSERT INTO payments
       (user_id, amount, currency, method, reference, period_from, period_to,
        paid_at, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    amount,
    currency,
    method,
    reference,
    base.toISOString(),
    renewsAt.toISOString(),
    paidAt.toISOString(),
    req.user.id,
    nowIso(),
  );

  db.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, currency, amount, started_at,
                                last_paid_at, renews_at)
     VALUES (?, 'standard', 'active', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       status = 'active',
       currency = excluded.currency,
       amount = excluded.amount,
       last_paid_at = excluded.last_paid_at,
       renews_at = excluded.renews_at,
       started_at = COALESCE(subscriptions.started_at, excluded.started_at)`,
  ).run(
    user.id,
    currency,
    amount,
    paidAt.toISOString(),
    paidAt.toISOString(),
    renewsAt.toISOString(),
  );

  res.status(201).json({ ok: true, renewsAt: renewsAt.toISOString() });
});

/** Feedback and reviews submitted by subscribers. */
adminRouter.get('/feedback', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT f.id, f.rating, f.subject, f.message, f.status, f.created_at,
              u.name, u.company, u.country, u.email
         FROM feedback f JOIN users u ON u.id = f.user_id
        ORDER BY f.created_at DESC LIMIT 200`,
    )
    .all();
  res.json(rows);
});

adminRouter.post('/feedback/:id/status', requireCsrf, (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['new', 'reviewed', 'actioned'].includes(status)) {
    return res.status(400).json({ error: 'Status must be new, reviewed or actioned.' });
  }
  db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true, status });
});

/** Feed health - which authorities are answering and which are not. */
adminRouter.get('/sources', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, COUNT(u.id) AS stored
         FROM sources s
         LEFT JOIN updates u ON u.source_id = s.id
        GROUP BY s.id
        ORDER BY (s.last_success_at IS NULL) DESC, s.region, s.id`,
    )
    .all();

  res.json(
    rows.map((r) => ({
      id: r.id,
      authority: r.authority,
      agency: r.agency,
      country: r.country,
      region: r.region,
      feed: r.feed,
      kind: r.kind,
      enabled: r.enabled === 1,
      stored: r.stored,
      lastStatus: r.last_status,
      lastError: r.last_error,
      lastFetchAt: r.last_fetch_at,
      lastSuccessAt: r.last_success_at,
      healthy: Boolean(r.last_success_at) && !r.last_error,
    })),
  );
});

adminRouter.post('/sources/:id/toggle', requireCsrf, (req, res) => {
  const source = db.prepare('SELECT enabled FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found.' });

  const next = source.enabled === 1 ? 0 : 1;
  db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(next, req.params.id);
  res.json({ ok: true, enabled: next === 1 });
});

/** Trigger a poll immediately rather than waiting for the interval. */
adminRouter.post('/ingest', requireCsrf, async (_req, res) => {
  if (ingestState.running) {
    return res.status(409).json({ error: 'An ingestion cycle is already running.' });
  }
  const result = await runIngestCycle({ verbose: true });
  res.json({
    ok: true,
    sources: result.sources,
    reachable: result.ok,
    failed: result.failed,
    inserted: result.inserted,
    ms: result.ms,
  });
});

// ---------------------------------------------------------------------- users

adminRouter.get('/users', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, email, name, organisation, role, status, created_at, last_login_at
         FROM users ORDER BY created_at DESC`,
    )
    .all();
  res.json(rows);
});

adminRouter.post('/users/:id/status', requireCsrf, (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['active', 'pending', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active, pending or suspended.' });
  }

  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  // Never let an admin lock themselves out.
  if (target.id === req.user.id && status !== 'active') {
    return res.status(400).json({ error: 'You cannot suspend your own account.' });
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  // A suspended or pending account should lose any live session immediately.
  if (status !== 'active') destroyAllSessionsFor(target.id);

  res.json({ ok: true, status });
});
