import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseOpenFda, parseDate, stripHtml } from '../server/ingest/parse.js';

test('parses an RSS 2.0 feed', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>FDA Recalls</title>
      <item>
        <title>Company A recalls Product B</title>
        <link>https://example.gov/recall/1</link>
        <description><![CDATA[<p>Undeclared allergen &amp; mislabelling.</p>]]></description>
        <pubDate>Tue, 05 Aug 2025 14:30:00 GMT</pubDate>
        <guid>https://example.gov/recall/1</guid>
      </item>
    </channel></rss>`;

  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Company A recalls Product B');
  assert.equal(items[0].link, 'https://example.gov/recall/1');
  assert.equal(items[0].summary, 'Undeclared allergen & mislabelling.');
  assert.equal(items[0].publishedAt, '2025-08-05T14:30:00.000Z');
});

test('parses an Atom feed and resolves the alternate link', () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Drug Safety Update: August 2025</title>
        <link rel="self" href="https://example.gov/self"/>
        <link rel="alternate" href="https://example.gov/dsu/aug"/>
        <id>tag:example.gov,2025:dsu-aug</id>
        <updated>2025-08-04T09:00:00Z</updated>
        <summary>Monthly bulletin.</summary>
      </entry>
    </feed>`;

  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://example.gov/dsu/aug');
  assert.equal(items[0].guid, 'tag:example.gov,2025:dsu-aug');
});

test('strips namespace prefixes so dc:date and content:encoded are read', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><item>
        <title>Notice</title>
        <link>https://example.gov/n</link>
        <dc:date>2025-07-01T00:00:00Z</dc:date>
      </item></channel></rss>`;

  const [item] = parseFeed(xml);
  assert.equal(item.publishedAt, '2025-07-01T00:00:00.000Z');
});

test('returns an empty array for non-feed payloads instead of throwing', () => {
  assert.deepEqual(parseFeed('<html><body>Not a feed</body></html>'), []);
  assert.deepEqual(parseFeed('total garbage <<<'), []);
  assert.deepEqual(parseFeed(''), []);
});

test('parses openFDA enforcement records and keeps the classification', () => {
  const json = JSON.stringify({
    results: [
      {
        recall_number: 'D-1234-2025',
        recalling_firm: 'Acme Pharma',
        product_description: 'Widget Tablets 10mg',
        reason_for_recall: 'Failed dissolution specification',
        classification: 'Class II',
        status: 'Ongoing',
        report_date: '20250715',
      },
    ],
  });

  const items = parseOpenFda(json, 'https://api.fda.gov/drug/enforcement.json?limit=1');
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Class II recall/);
  assert.match(items[0].summary, /Failed dissolution specification/);
  assert.equal(items[0].publishedAt, '2025-07-15T00:00:00.000Z');
  assert.equal(items[0].openFdaClassification, 'Class II');
});

test('parseDate rejects implausible future dates', () => {
  const farFuture = new Date(Date.now() + 90 * 86400000).toISOString();
  assert.equal(parseDate(farFuture), null);
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
});

test('stripHtml removes markup, decodes entities and truncates', () => {
  assert.equal(stripHtml('<b>Bold</b> &amp; <i>italic</i>'), 'Bold & italic');
  assert.equal(stripHtml('<script>bad()</script>Safe'), 'Safe');
  const long = stripHtml('x'.repeat(900), 100);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
});
