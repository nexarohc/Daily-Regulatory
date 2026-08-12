import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { parseFeed, parseOpenFda } from './parse.js';
import { classify } from './classify.js';

/**
 * Fetch one source and store any new items.
 *
 * Uses conditional requests (If-None-Match / If-Modified-Since) so repeated
 * polling costs the authority a 304 rather than a full document.
 */
export async function fetchSource(source) {
  const started = Date.now();
  const headers = {
    'user-agent': config.userAgent,
    accept:
      source.kind === 'openfda'
        ? 'application/json'
        : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'accept-encoding': 'gzip, deflate',
  };
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.last_modified) headers['if-modified-since'] = source.last_modified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

  try {
    const response = await fetch(source.feed, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (response.status === 304) {
      markFetch(source.id, { status: '304 not modified', ok: true });
      return { sourceId: source.id, status: 304, inserted: 0, ms: Date.now() - started };
    }

    if (!response.ok) {
      markFetch(source.id, {
        status: `${response.status} ${response.statusText}`,
        ok: false,
        error: `HTTP ${response.status}`,
      });
      return {
        sourceId: source.id,
        status: response.status,
        inserted: 0,
        error: `HTTP ${response.status}`,
        ms: Date.now() - started,
      };
    }

    const body = await response.text();
    const items =
      source.kind === 'openfda' ? parseOpenFda(body, source.feed) : parseFeed(body);

    if (items.length === 0) {
      markFetch(source.id, {
        status: `${response.status} but no items parsed`,
        ok: false,
        error: 'Response contained no recognisable feed items',
      });
      return {
        sourceId: source.id,
        status: response.status,
        inserted: 0,
        error: 'no items parsed',
        ms: Date.now() - started,
      };
    }

    const inserted = storeItems(source, items);

    markFetch(source.id, {
      status: `${response.status} OK`,
      ok: true,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      itemCount: items.length,
    });

    return {
      sourceId: source.id,
      status: response.status,
      inserted,
      parsed: items.length,
      ms: Date.now() - started,
    };
  } catch (err) {
    const message =
      err.name === 'AbortError'
        ? `Timed out after ${config.fetchTimeoutMs}ms`
        : err.message || String(err);
    markFetch(source.id, { status: 'error', ok: false, error: message });
    return {
      sourceId: source.id,
      status: 0,
      inserted: 0,
      error: message,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Stable id so re-polling the same item does not create a duplicate. */
function updateId(sourceId, item) {
  return crypto
    .createHash('sha1')
    .update(`${sourceId}::${item.guid || item.link || item.title}`)
    .digest('hex');
}

function storeItems(source, items) {
  const insert = db.prepare(
    `INSERT INTO updates
       (id, source_id, title, summary, link, published_at, fetched_at, category, severity, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO NOTHING`,
  );

  const fetchedAt = nowIso();
  let inserted = 0;

  for (const item of items) {
    if (!item.title || !item.link) continue;
    // Items without a usable date are dated at ingestion so they still surface,
    // rather than being dropped or sorted to the bottom of the feed forever.
    const publishedAt = item.publishedAt ?? fetchedAt;
    const { category, severity } = classify(item);

    try {
      const result = insert.run(
        updateId(source.id, item),
        source.id,
        item.title,
        item.summary ?? '',
        item.link,
        publishedAt,
        fetchedAt,
        category,
        severity,
      );
      inserted += result.changes;
    } catch (err) {
      // A duplicate link from another source trips the unique index; that is
      // expected cross-posting (e.g. an FDA item in both drugs and recalls).
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }

  return inserted;
}

function markFetch(sourceId, { status, ok, error = null, etag, lastModified, itemCount }) {
  const now = nowIso();
  const sets = ['last_fetch_at = ?', 'last_status = ?', 'last_error = ?'];
  const params = [now, status, error];

  if (ok) {
    sets.push('last_success_at = ?');
    params.push(now);
  }
  if (etag !== undefined) {
    sets.push('etag = ?');
    params.push(etag);
  }
  if (lastModified !== undefined) {
    sets.push('last_modified = ?');
    params.push(lastModified);
  }
  if (itemCount !== undefined) {
    sets.push('item_count = ?');
    params.push(itemCount);
  }

  params.push(sourceId);
  db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** Run tasks with a bounded number in flight so we stay a polite client. */
export async function withConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Poll every enabled source once. */
export async function ingestAll() {
  const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
  const started = Date.now();

  const results = await withConcurrency(sources, config.fetchConcurrency, fetchSource);

  const inserted = results.reduce((sum, r) => sum + (r?.inserted ?? 0), 0);
  const okCount = results.filter((r) => r && !r.error).length;

  return {
    sources: sources.length,
    ok: okCount,
    failed: sources.length - okCount,
    inserted,
    ms: Date.now() - started,
    results,
  };
}
