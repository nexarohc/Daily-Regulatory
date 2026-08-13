/**
 * End-to-end ingestion test against a real HTTP server.
 *
 * Serves an RSS fixture over HTTP, points a source at it, and checks that a
 * full cycle fetches, parses, classifies, stores and broadcasts it. This is the
 * live-update path the dashboard's event stream depends on.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `dr-ingest-${process.pid}.db`);
process.env.DB_FILE = dbFile;
process.env.AUTO_INGEST = '0';
process.env.SEED_WHEN_EMPTY = '0';

// Imported after the environment is set, since the database opens on import.
const { db, syncSources } = await import('../server/db.js');
const { ingestAll } = await import('../server/ingest/fetcher.js');
const { ingestEvents, runIngestCycle } = await import('../server/ingest/scheduler.js');

let server;
let origin;
let requestCount = 0;
let lastHeaders = {};

const rss = (items) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Authority Feed</title>
  ${items}
</channel></rss>`;

const ITEM_ONE = `
  <item>
    <title>Authority recalls Batch 77 of Widget Tablets</title>
    <link>http://fixture.invalid/notice/1</link>
    <description>Class I recall following reports of contamination.</description>
    <pubDate>Mon, 04 Aug 2025 08:00:00 GMT</pubDate>
    <guid>notice-1</guid>
  </item>`;

const ITEM_TWO = `
  <item>
    <title>Authority approves new paediatric indication</title>
    <link>http://fixture.invalid/notice/2</link>
    <description>Marketing authorisation extended.</description>
    <pubDate>Tue, 05 Aug 2025 08:00:00 GMT</pubDate>
    <guid>notice-2</guid>
  </item>`;

let payload = rss(ITEM_ONE);

before(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    lastHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  syncSources();
  // Register the fixture as a source directly; the static registry is not
  // involved, so this does not depend on any real authority being reachable.
  db.prepare(
    `INSERT INTO sources (id, authority, agency, country, country_code, region,
                          lat, lon, site, feed, kind, lang, topic, enabled)
     VALUES ('fixture', 'Fixture Authority', 'FIX', 'Testland', 'TL', 'Europe',
             0, 0, ?, ?, 'rss', 'en', 'Test notices', 1)
     ON CONFLICT(id) DO UPDATE SET feed = excluded.feed, enabled = 1`,
  ).run(origin, `${origin}/feed.xml`);
});

after(() => {
  server?.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbFile}${suffix}`, { force: true });
  }
});

test('a cycle fetches, classifies and stores items from a live feed', async () => {
  const result = await ingestAll();
  assert.ok(result.ok >= 1, 'fixture source should be reachable');

  const row = db
    .prepare("SELECT * FROM updates WHERE source_id = 'fixture' ORDER BY published_at")
    .all();
  assert.equal(row.length, 1);
  assert.equal(row[0].title, 'Authority recalls Batch 77 of Widget Tablets');
  assert.equal(row[0].category, 'Recall');
  // "Class I" plus "contamination" should be treated as the most severe.
  assert.equal(row[0].severity, 'critical');
});

test('identifies itself to the authority with a User-Agent', () => {
  assert.match(lastHeaders['user-agent'] ?? '', /TimelyRegulatory/);
});

test('re-polling an unchanged feed stores no duplicates', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM updates WHERE source_id='fixture'").get().n;
  await ingestAll();
  const after = db.prepare("SELECT COUNT(*) AS n FROM updates WHERE source_id='fixture'").get().n;
  assert.equal(after, before, 're-polling must not duplicate items');
});

test('new items are broadcast to live listeners', async () => {
  payload = rss(ITEM_ONE + ITEM_TWO);

  const broadcast = new Promise((resolve) => {
    ingestEvents.once('items', resolve);
  });

  await runIngestCycle({ verbose: false });

  const items = await Promise.race([
    broadcast,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no broadcast')), 5000)),
  ]);

  assert.ok(Array.isArray(items));
  assert.ok(
    items.some((i) => i.title === 'Authority approves new paediatric indication'),
    'the newly published item should reach subscribers',
  );
});

test('conditional requests are sent once an ETag is known', async () => {
  const source = db.prepare("SELECT etag FROM sources WHERE id='fixture'").get();
  assert.equal(source.etag, '"v1"', 'ETag should be recorded from the response');

  await ingestAll();
  assert.equal(lastHeaders['if-none-match'], '"v1"');
});
