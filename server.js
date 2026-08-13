import express from 'express';
import path from 'node:path';
import { config, ROOT } from './server/config.js';
import { db, syncSources, pruneEphemeral } from './server/db.js';
import { loadSession, requireAuth } from './server/auth.js';
import { authRouter } from './server/routes/auth.js';
import { updatesRouter } from './server/routes/updates.js';
import { adminRouter } from './server/routes/admin.js';
import { startScheduler, ingestState } from './server/ingest/scheduler.js';

const app = express();

// Trust the first proxy hop so req.ip is the client address behind a load
// balancer (Heroku, Render, Fly, nginx).
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser);

// Baseline security headers. The CSP is strict: everything the page needs is
// served from this origin, so no external script or style host is allowed.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(loadSession);

/** Minimal cookie parser - avoids a dependency for one header. */
function cookieParser(req, _res, next) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        req.cookies[key] = value;
      }
    }
  }
  next();
}

// ------------------------------------------------------------------ API

// Public liveness probe for load balancers and uptime monitors. Declared
// before the gated routers so it is not caught by their auth middleware, and
// deliberately free of any regulatory content.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

// Marketing counts for the public landing page. Deliberately limited to how
// many feeds are tracked - no regulatory item is readable without an account.
app.get('/api/public/summary', (_req, res) => {
  const authorities = db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  const feeds = db
    .prepare("SELECT COUNT(*) AS n FROM sources WHERE kind != 'directory' AND feed != ''")
    .get().n;
  const regions = db.prepare('SELECT COUNT(DISTINCT region) AS n FROM sources').get().n;
  const countries = db
    .prepare(
      "SELECT COUNT(DISTINCT country_code) AS n FROM sources WHERE country_code NOT IN ('INT','EU')",
    )
    .get().n;

  res.json({
    authorities,
    feeds,
    regions,
    countries,
    pollMinutes: Math.round(config.pollIntervalMs / 60000),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', updatesRouter);

// Operational detail is customer-visible but not public.
app.get('/api/status', requireAuth, (_req, res) => {
  const updates = db.prepare('SELECT COUNT(*) AS n FROM updates').get().n;
  const sources = db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  const live = db
    .prepare('SELECT COUNT(*) AS n FROM sources WHERE last_success_at IS NOT NULL')
    .get().n;

  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    updates,
    sources,
    sourcesLive: live,
    lastIngestAt: ingestState.lastRunAt,
    ingesting: ingestState.running,
  });
});

// ------------------------------------------------------------------ pages

// The dashboard shell is served only to a signed-in account, so the gated
// experience is not merely hidden in the client.
app.get('/app', requireAuthPage, (_req, res) => {
  res.sendFile(path.join(ROOT, 'views', 'app.html'));
});

function requireAuthPage(req, res, next) {
  if (!req.user || req.user.status !== 'active') return res.redirect('/?next=/app');
  next();
}

// Public assets: the landing page, styles, client scripts and vendored
// libraries. None of these contain regulatory data.
app.use(
  express.static(path.join(ROOT, 'public'), {
    index: 'index.html',
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// --------------------------------------------------------------- errors

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------------------------------------------------------------- start

syncSources();
pruneEphemeral();

const server = app.listen(config.port, config.host, () => {
  const { n: sources } = db.prepare('SELECT COUNT(*) AS n FROM sources').get();
  console.log(`Daily Regulatory listening on http://${config.host}:${config.port}`);
  console.log(`Tracking ${sources} authority feeds.`);
  if (config.requireApproval) {
    console.log('New registrations require administrator approval (REQUIRE_APPROVAL=1).');
  }
  startScheduler();
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
