import express from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth, requireCsrf } from '../auth.js';
import { CATEGORIES, SEVERITIES } from '../ingest/classify.js';
import { ingestState } from '../ingest/scheduler.js';

export const updatesRouter = express.Router();

// Everything below requires an active, registered account.
updatesRouter.use(requireAuth);

const SELECT_UPDATE = `
  SELECT u.id, u.title, u.summary, u.link, u.published_at, u.category,
         u.severity, u.is_sample,
         s.id AS source_id, s.authority, s.agency, s.country, s.country_code,
         s.region, s.site, s.lat, s.lon, s.topic
    FROM updates u
    JOIN sources s ON s.id = u.source_id
`;

const shape = (row, bookmarkedIds) => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  link: row.link,
  publishedAt: row.published_at,
  category: row.category,
  severity: row.severity,
  isSample: row.is_sample === 1,
  bookmarked: bookmarkedIds ? bookmarkedIds.has(row.id) : undefined,
  source: {
    id: row.source_id,
    authority: row.authority,
    agency: row.agency,
    country: row.country,
    countryCode: row.country_code,
    region: row.region,
    site: row.site,
    topic: row.topic,
    lat: row.lat,
    lon: row.lon,
  },
});

function bookmarkSet(userId) {
  const rows = db.prepare('SELECT update_id FROM bookmarks WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => r.update_id));
}

/**
 * GET /api/updates
 * Filters: region, category, severity, sourceId, q, since, bookmarked
 * Paging:  limit (<=100), offset
 */
updatesRouter.get('/updates', (req, res) => {
  const where = [];
  const params = [];

  const { region, category, severity, sourceId, q, since, bookmarked } = req.query;

  if (region && region !== 'all') {
    where.push('s.region = ?');
    params.push(String(region));
  }
  if (category && category !== 'all') {
    where.push('u.category = ?');
    params.push(String(category));
  }
  if (severity && severity !== 'all') {
    where.push('u.severity = ?');
    params.push(String(severity));
  }
  if (sourceId && sourceId !== 'all') {
    where.push('u.source_id = ?');
    params.push(String(sourceId));
  }
  if (since) {
    const date = new Date(String(since));
    if (!Number.isNaN(date.getTime())) {
      where.push('u.published_at >= ?');
      params.push(date.toISOString());
    }
  }
  if (q) {
    const term = `%${String(q).slice(0, 120)}%`;
    where.push('(u.title LIKE ? OR u.summary LIKE ? OR s.authority LIKE ? OR s.agency LIKE ?)');
    params.push(term, term, term, term);
  }
  if (bookmarked === '1' || bookmarked === 'true') {
    where.push('u.id IN (SELECT update_id FROM bookmarks WHERE user_id = ?)');
    params.push(req.user.id);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM updates u JOIN sources s ON s.id = u.source_id ${clause}`)
    .get(...params);

  const rows = db
    .prepare(`${SELECT_UPDATE} ${clause} ORDER BY u.published_at DESC, u.id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  const marks = bookmarkSet(req.user.id);

  res.json({
    total,
    limit,
    offset,
    items: rows.map((r) => shape(r, marks)),
  });
});

updatesRouter.get('/updates/:id', (req, res) => {
  const row = db.prepare(`${SELECT_UPDATE} WHERE u.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Update not found.' });
  res.json(shape(row, bookmarkSet(req.user.id)));
});

/** Aggregate counts driving the dashboard tiles, chart and globe. */
updatesRouter.get('/stats', (req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const total = db.prepare('SELECT COUNT(*) AS n FROM updates').get().n;
  const last24h = db
    .prepare('SELECT COUNT(*) AS n FROM updates WHERE published_at >= ?')
    .get(dayAgo).n;
  const critical = db
    .prepare("SELECT COUNT(*) AS n FROM updates WHERE severity = 'critical' AND published_at >= ?")
    .get(weekAgo).n;

  const byCategory = db
    .prepare('SELECT category, COUNT(*) AS n FROM updates GROUP BY category ORDER BY n DESC')
    .all();
  const bySeverity = db
    .prepare('SELECT severity, COUNT(*) AS n FROM updates GROUP BY severity')
    .all();
  const byRegion = db
    .prepare(
      `SELECT s.region, COUNT(*) AS n
         FROM updates u JOIN sources s ON s.id = u.source_id
        GROUP BY s.region ORDER BY n DESC`,
    )
    .all();

  const perDay = db
    .prepare(
      `SELECT substr(published_at, 1, 10) AS day, COUNT(*) AS n
         FROM updates
        WHERE published_at >= ?
        GROUP BY day ORDER BY day`,
    )
    .all(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

  const sourcesLive = db
    .prepare('SELECT COUNT(*) AS n FROM sources WHERE last_success_at IS NOT NULL')
    .get().n;
  const sourcesTotal = db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  const sampleCount = db.prepare('SELECT COUNT(*) AS n FROM updates WHERE is_sample = 1').get().n;

  res.json({
    total,
    last24h,
    criticalLast7d: critical,
    sourcesLive,
    sourcesTotal,
    sampleCount,
    usingSampleData: sampleCount > 0 && total === sampleCount,
    lastIngestAt: ingestState.lastRunAt,
    byCategory,
    bySeverity,
    byRegion,
    perDay,
  });
});

/** Authority list with live activity counts, used to plot the globe. */
updatesRouter.get('/authorities', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.authority, s.agency, s.country, s.country_code, s.region,
              s.lat, s.lon, s.site, s.topic, s.last_success_at, s.last_status,
              COUNT(u.id) AS update_count,
              MAX(u.published_at) AS latest,
              SUM(CASE WHEN u.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count
         FROM sources s
         LEFT JOIN updates u ON u.source_id = s.id
        GROUP BY s.id
        ORDER BY s.region, s.authority`,
    )
    .all();

  res.json(
    rows.map((r) => ({
      id: r.id,
      authority: r.authority,
      agency: r.agency,
      country: r.country,
      countryCode: r.country_code,
      region: r.region,
      lat: r.lat,
      lon: r.lon,
      site: r.site,
      topic: r.topic,
      updateCount: r.update_count,
      criticalCount: r.critical_count ?? 0,
      latest: r.latest,
      live: Boolean(r.last_success_at),
      lastStatus: r.last_status,
    })),
  );
});

updatesRouter.get('/filters', (_req, res) => {
  const regions = db.prepare('SELECT DISTINCT region FROM sources ORDER BY region').all();
  res.json({
    regions: regions.map((r) => r.region),
    categories: CATEGORIES,
    severities: SEVERITIES,
  });
});

// ------------------------------------------------------------------ bookmarks

updatesRouter.post('/bookmarks/:id', requireCsrf, (req, res) => {
  const exists = db.prepare('SELECT 1 FROM updates WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Update not found.' });

  db.prepare(
    `INSERT INTO bookmarks (user_id, update_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, update_id) DO NOTHING`,
  ).run(req.user.id, req.params.id, nowIso());

  res.json({ ok: true, bookmarked: true });
});

updatesRouter.delete('/bookmarks/:id', requireCsrf, (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND update_id = ?').run(
    req.user.id,
    req.params.id,
  );
  res.json({ ok: true, bookmarked: false });
});
