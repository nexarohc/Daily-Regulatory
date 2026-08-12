import express from 'express';
import { db } from '../db.js';
import { destroyAllSessionsFor, requireAdmin, requireAuth, requireCsrf } from '../auth.js';
import { runIngestCycle, ingestState } from '../ingest/scheduler.js';

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireAdmin);

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
