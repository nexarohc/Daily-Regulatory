/**
 * Feed discovery for directory entries.
 *
 *   npm run discover              # probe every directory authority
 *   npm run discover -- africa    # limit to matching ids/countries/regions
 *
 * Many national regulators publish a feed without advertising it prominently.
 * Rather than guessing URLs and baking them into the registry (which would fill
 * the health panel with endpoints that never existed), this probes each
 * authority's own site for a feed in the conventional places, validates that it
 * actually parses into items, and only then promotes the source to live.
 *
 * Nothing is invented: a source is enabled only when a real endpoint returns
 * real, parseable items.
 */
import { db, syncSources, nowIso } from '../db.js';
import { config } from '../config.js';
import { parseFeed } from './parse.js';
import { withConcurrency } from './fetcher.js';

// Conventional feed locations, in rough order of how common they are across
// government and institutional sites.
const CANDIDATE_PATHS = [
  '/feed/',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/rss',
  '/en/rss.xml',
  '/news/rss',
  '/news/feed/',
  '/index.php?format=feed&type=rss',
  '/?format=feed&type=rss',
  '/rss/news.xml',
  '/sitepages/rss.aspx',
];

/** Follow <link rel="alternate" type="application/rss+xml"> on the homepage. */
async function declaredFeeds(site, signal) {
  try {
    const response = await fetch(site, {
      headers: { 'user-agent': config.userAgent, accept: 'text/html' },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) return [];

    const html = (await response.text()).slice(0, 400_000);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /rel=["']?alternate/i.test(tag))
      .filter((tag) => /type=["']?application\/(rss|atom)\+xml/i.test(tag));

    return links
      .map((tag) => /href=["']([^"']+)["']/i.exec(tag)?.[1])
      .filter(Boolean)
      .map((href) => {
        try {
          return new URL(href, site).toString();
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Fetch a candidate URL and report whether it is a usable feed. */
async function tryFeed(url, signal) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': config.userAgent,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) return null;

    const body = await response.text();
    const items = parseFeed(body);
    // Require more than one item so a stub or error page does not qualify.
    return items.length > 1 ? { url, count: items.length } : null;
  } catch {
    return null;
  }
}

async function discoverFor(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs * 2);

  try {
    // Prefer a feed the site declares about itself.
    for (const url of await declaredFeeds(source.site, controller.signal)) {
      const hit = await tryFeed(url, controller.signal);
      if (hit) return { source, ...hit, how: 'declared' };
    }

    for (const path of CANDIDATE_PATHS) {
      let url;
      try {
        url = new URL(path, source.site).toString();
      } catch {
        continue;
      }
      const hit = await tryFeed(url, controller.signal);
      if (hit) return { source, ...hit, how: 'probed' };
    }

    return { source, url: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Promote a directory source to a live RSS source. */
function promote(sourceId, feedUrl) {
  db.prepare(
    `UPDATE sources
        SET feed = ?, kind = 'rss', enabled = 1,
            topic = 'Discovered feed', last_error = NULL, last_status = 'discovered',
            last_fetch_at = ?
      WHERE id = ?`,
  ).run(feedUrl, nowIso(), sourceId);
}

export async function discoverAll({ filter = [], verbose = true } = {}) {
  syncSources();

  let sources = db.prepare("SELECT * FROM sources WHERE kind = 'directory'").all();
  if (filter.length) {
    const terms = filter.map((t) => t.toLowerCase());
    sources = sources.filter((s) =>
      terms.some(
        (t) =>
          s.id.toLowerCase().includes(t) ||
          s.country.toLowerCase().includes(t) ||
          s.region.toLowerCase().includes(t) ||
          s.agency.toLowerCase().includes(t),
      ),
    );
  }

  if (verbose) {
    console.log(`Probing ${sources.length} directory authorities for feeds...\n`);
  }

  const results = await withConcurrency(sources, config.fetchConcurrency, discoverFor);

  let promoted = 0;
  for (const result of results) {
    if (result?.url) {
      promote(result.source.id, result.url);
      promoted++;
      if (verbose) {
        console.log(
          `  found  ${result.source.agency.padEnd(14)} ${result.source.country.padEnd(24)} ` +
            `${result.count} items  ${result.url}  (${result.how})`,
        );
      }
    }
  }

  if (verbose) {
    console.log(
      `\n${promoted} of ${sources.length} directory authorities now have a live feed.`,
    );
    if (promoted === 0) {
      console.log(
        'None resolved. If every authority failed, check outbound HTTPS rather than assuming ' +
          'none of them publish feeds.',
      );
    }
  }

  return { probed: sources.length, promoted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { promoted } = await discoverAll({ filter: process.argv.slice(2) });
  process.exit(promoted > 0 ? 0 : 1);
}
