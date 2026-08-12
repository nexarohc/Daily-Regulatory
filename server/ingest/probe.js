/**
 * Connectivity check for every registered feed.
 *
 *   npm run probe            # check all sources
 *   npm run probe -- ema fda # check sources whose id/agency matches a term
 *
 * Prints a per-source verdict so a broken or moved endpoint is obvious. Run
 * this from a network that can reach the authorities; it makes no database
 * changes.
 */
import { SOURCES } from './sources.js';
import { config } from '../config.js';
import { parseFeed, parseOpenFda } from './parse.js';
import { withConcurrency } from './fetcher.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function probe(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(source.feed, {
      headers: {
        'user-agent': config.userAgent,
        accept:
          source.kind === 'openfda'
            ? 'application/json'
            : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const ms = Date.now() - started;
    if (!response.ok) {
      return { source, ok: false, ms, detail: `HTTP ${response.status} ${response.statusText}` };
    }

    const body = await response.text();
    const items =
      source.kind === 'openfda' ? parseOpenFda(body, source.feed) : parseFeed(body);

    if (items.length === 0) {
      return {
        source,
        ok: false,
        ms,
        detail: `HTTP ${response.status} but 0 items parsed (${body.length} bytes) - endpoint may have moved or changed format`,
      };
    }

    const newest = items
      .map((i) => i.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      source,
      ok: true,
      ms,
      detail: `${items.length} items` + (newest ? `, newest ${newest.slice(0, 10)}` : ''),
    };
  } catch (err) {
    const ms = Date.now() - started;
    const detail =
      err.name === 'AbortError' ? `timeout after ${config.fetchTimeoutMs}ms` : err.message;
    return { source, ok: false, ms, detail };
  } finally {
    clearTimeout(timer);
  }
}

const terms = process.argv.slice(2).map((t) => t.toLowerCase());
const selected = terms.length
  ? SOURCES.filter((s) =>
      terms.some(
        (t) =>
          s.id.toLowerCase().includes(t) ||
          s.agency.toLowerCase().includes(t) ||
          s.country.toLowerCase().includes(t) ||
          s.region.toLowerCase().includes(t),
      ),
    )
  : SOURCES;

console.log(`Probing ${selected.length} source(s) with ${config.fetchConcurrency} in flight...\n`);

const results = await withConcurrency(selected, config.fetchConcurrency, probe);

const byRegion = new Map();
for (const r of results) {
  if (!byRegion.has(r.source.region)) byRegion.set(r.source.region, []);
  byRegion.get(r.source.region).push(r);
}

for (const [region, rows] of [...byRegion.entries()].sort()) {
  console.log(`${DIM}${region}${RESET}`);
  for (const r of rows.sort((a, b) => a.source.id.localeCompare(b.source.id))) {
    const mark = r.ok ? `${GREEN}  ok  ${RESET}` : `${RED} fail ${RESET}`;
    const ms = String(r.ms).padStart(5);
    console.log(`${mark} ${r.source.id.padEnd(28)} ${DIM}${ms}ms${RESET}  ${r.detail}`);
    if (!r.ok) console.log(`       ${DIM}${r.source.feed}${RESET}`);
  }
  console.log();
}

const ok = results.filter((r) => r.ok).length;
const failed = results.length - ok;
const colour = failed === 0 ? GREEN : ok === 0 ? RED : YELLOW;
console.log(`${colour}${ok}/${results.length} reachable, ${failed} failing${RESET}`);

if (ok === 0) {
  console.log(
    `\n${YELLOW}No source was reachable at all.${RESET} That usually means egress is blocked ` +
      'rather than every authority being down - check proxy/firewall rules for outbound HTTPS.',
  );
}

process.exit(failed > 0 && ok === 0 ? 1 : 0);
