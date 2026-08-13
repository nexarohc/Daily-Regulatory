# Daily Regulatory

Global health-authority regulatory intelligence, aggregated from the
authorities' own published feeds and served behind a registered-customer login.

Daily Regulatory tracks **205 health authorities across 180 countries and
territories**, polls the **53 that publish a machine-readable feed** on a
continuous cycle, normalises what they publish (recalls, safety alerts,
approvals, guidance, enforcement, shortages), auto-tags each item by type and
severity, and streams it into a single searchable timeline with a 3D globe
showing where activity is happening.

New notices are pushed to open dashboards over server-sent events, so the feed
updates live without a refresh.

**Coverage.** Every country with a recognised medicines regulator is in the
registry. Authorities that publish a feed are polled; the rest are listed as
directory entries with a link to their official site, so nothing is silently
missing from the map. `npm run discover` probes those sites for a feed and
promotes any that genuinely resolve — coverage grows from what authorities
actually publish, never from invented URLs.

---

## What this does and does not do

**It does:** read each authority's own RSS/Atom feed or public API, store what
it finds, and link every item straight back to the original notice.

**It does not:** invent, rewrite, or editorialise regulatory content. Titles and
summaries come from the authority. Category and severity labels are generated
by keyword rules and are clearly marked as automatic — they are **not** the
authority's official classification. Anyone acting on an item is expected to
open the source link and read the original notice.

> This is an aggregator, not a regulatory authority, and nothing it outputs is
> legal or regulatory advice.

---

## Quick start

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite` module,
so there is no native build step and no external database to run).

```bash
npm install
npm start
```

Then open <http://localhost:3000>, register an account, and you are in the feed.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm start` | Run the server and poll feeds on an interval |
| `npm run dev` | Same, with auto-restart on file changes |
| `npm run probe` | Check every feed endpoint and report which resolve |
| `npm run discover` | Probe directory authorities for a feed and promote any found |
| `npm run ingest` | Run one ingestion cycle and exit (for cron deployments) |
| `npm run seed` | Load the labelled sample corpus |
| `npm test` | Run the test suite |

### Check your feeds first

Authorities move their feed endpoints when they redesign their sites, and some
networks block outbound HTTPS. Before trusting the feed, run:

```bash
npm run probe
```

It reports every source as reachable or failing, with the reason and the URL, so
a moved endpoint is obvious. Narrow it with a filter: `npm run probe -- fda ema`.

The same health data is visible continuously in the admin panel once signed in
as an administrator.

---

## Access control

The regulatory feed is available only to registered accounts. Specifically:

- **Sessions are server-side.** The cookie carries an opaque id, is `HttpOnly`,
  `SameSite=Lax`, and `Secure` when `COOKIE_SECURE=1`. There is no token in
  `localStorage`.
- **Passwords** are hashed with scrypt (`node:crypto`) using per-user salts, and
  the stored format records its parameters so they can be raised later.
- **Every data endpoint refuses anonymous requests** with 401, and `/app` (the
  dashboard shell) redirects to sign-in rather than merely hiding content in the
  client.
- **State-changing requests require a CSRF token** echoed in `X-CSRF-Token`.
- **Rate limits** apply to sign-in (per address and per IP) and registration.
- **Suspending an account** immediately destroys its live sessions.
- A strict **Content-Security-Policy** allows scripts only from this origin;
  Three.js and Chart.js are vendored locally rather than loaded from a CDN.

Only `/api/health` (liveness) and `/api/public/summary` (how many feeds are
tracked) are public, and neither exposes regulatory content.

Set `REQUIRE_APPROVAL=1` to hold new registrations in `pending` until an
administrator approves them. Set `ADMIN_EMAIL` to the address that should be
promoted to administrator when it registers.

---

## Configuration

Copy `.env.example` to `.env`, or set these in your process environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/daily-regulatory.db` | SQLite database location |
| `SESSION_SECRET` | random | Set in production so restarts do not rotate it |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `COOKIE_SECURE` | `0` | Set to `1` behind HTTPS |
| `POLL_INTERVAL_MINUTES` | `15` | How often each feed is re-checked |
| `FETCH_TIMEOUT_MS` | `20000` | Per-request timeout |
| `FETCH_CONCURRENCY` | `6` | Feeds fetched in parallel |
| `AUTO_INGEST` | `1` | Set `0` to poll externally via `npm run ingest` |
| `SEED_WHEN_EMPTY` | `1` | Load labelled samples if nothing is reachable |
| `RETENTION_DAYS` | `180` | Age at which items are pruned (bookmarks kept) |
| `REQUIRE_APPROVAL` | `0` | Require admin approval for new accounts |
| `ADMIN_EMAIL` | — | Address promoted to admin on registration |
| `FEED_USER_AGENT` | see `config.js` | Sent to authorities; put a real contact in it |

---

## How it works

```
server.js                 Express app, security headers, page + API routing
server/
  config.js               Environment configuration
  db.js                   SQLite schema, migrations, retention
  auth.js                 Passwords, sessions, CSRF, rate limits, gates
  routes/
    auth.js               register / login / logout / me
    updates.js            feed, stats, authorities, filters, bookmarks,
                          live event stream (all gated)
    admin.js              feed health, manual poll, user management (admin)
  ingest/
    sources.js            Registry: 53 live feeds + worldwide authority directory
    fetcher.js            Conditional HTTP GET, retries, storage
    parse.js              RSS 2.0 / RDF / Atom / openFDA parsing
    classify.js           Category + severity heuristics
    scheduler.js          Polling loop and offline fallback
    probe.js              Connectivity check (npm run probe)
    discover.js           Feed discovery for directory authorities
    seed.js               Labelled sample corpus
public/                   Landing page, styles, client JS, vendored libraries
views/app.html            Dashboard shell, served only to signed-in accounts
```

**Live updates.** `GET /api/stream` is a gated server-sent event stream. Each
ingestion cycle broadcasts newly stored items, so open dashboards prepend them
and pulse the globe as they arrive. The client falls back to periodic polling if
the stream drops.

**Ingestion.** Each cycle fetches every enabled source with a bounded number of
requests in flight, sending `If-None-Match` / `If-Modified-Since` so an unchanged
feed costs the authority a 304. Items are keyed by a hash of source and GUID, so
re-polling never duplicates. Undated items are stamped at ingestion rather than
dropped. Per-source status, error and last-success are recorded for the health
view.

**The globe.** `public/js/globe.js` renders a dot-matrix Earth in Three.js. The
continents come from a coarse land mask embedded in the file and subdivided at
runtime, so the scene needs no image texture and no external asset fetch. Each
authority is plotted at its coordinates, coloured by activity, and new items
fire an animated arc. It degrades to a static panel where WebGL is unavailable
and respects `prefers-reduced-motion`.

---

## When no feed is reachable

If a polling cycle reaches **zero** sources and the database holds no real
items, the app loads a small **sample corpus** so the interface is explorable
instead of blank. This is deliberately conspicuous:

- every sample title is prefixed `[SAMPLE]`,
- every card carries a `sample` tag,
- a banner across the dashboard states that the data is not live,
- rows are stored with `is_sample = 1` and are replaced as soon as real items
  arrive.

The samples describe the *kind* of notice an authority publishes and link to
that authority's real index page. They never assert that a specific recall,
approval or alert occurred. Set `SEED_WHEN_EMPTY=0` to disable this entirely.

---

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). In short: set `SESSION_SECRET` and
`COOKIE_SECURE=1`, put it behind HTTPS, and give `data/` persistent storage —
the SQLite file lives there, so an ephemeral filesystem loses accounts and
history on every restart.

---

## Testing

```bash
npm test
```

Covers feed parsing across RSS/RDF/Atom/openFDA, the classification rules, and
an end-to-end access-control suite that boots the server and asserts anonymous
requests cannot read regulatory data, administrator endpoints reject ordinary
customers, CSRF is enforced, and forged session cookies are rejected.

---

## Licence

MIT. Not affiliated with any regulatory authority. Feed content belongs to the
issuing authorities and is subject to their terms.
