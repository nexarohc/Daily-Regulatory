import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  // Namespace prefixes vary between authorities (dc:date, content:encoded);
  // stripping them lets one set of field lookups cover every feed.
  removeNSPrefix: true,
  // Some feeds wrap text in CDATA that itself contains markup.
  cdataPropName: '__cdata',
});

const asArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Pull usable text out of a node that may be a string, CDATA, or {#text}. */
function text(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') {
    if (node.__cdata !== undefined) return text(node.__cdata);
    if (node['#text'] !== undefined) return text(node['#text']);
  }
  return '';
}

/** Collapse HTML markup into readable plain text for the summary field. */
export function stripHtml(html, maxLength = 600) {
  let out = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const entities = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&apos;': "'", '&hellip;': '…',
    '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
    '&ldquo;': '“', '&rdquo;': '”',
  };
  out = out.replace(/&[a-z#0-9]+;/gi, (m) => {
    const lower = m.toLowerCase();
    if (entities[lower] !== undefined) return entities[lower];
    const num = /^&#(\d+);$/.exec(m);
    if (num) return String.fromCodePoint(Number(num[1]));
    const hex = /^&#x([0-9a-f]+);$/i.exec(m);
    if (hex) return String.fromCodePoint(Number.parseInt(hex[1], 16));
    return ' ';
  });

  out = out.replace(/\s+/g, ' ').trim();
  return out.length > maxLength ? `${out.slice(0, maxLength - 1).trimEnd()}…` : out;
}

/**
 * Parse a date from any of the formats authorities publish (RFC 822 in RSS,
 * ISO 8601 in Atom, YYYYMMDD in openFDA). Returns an ISO string, or null when
 * the value is unusable so the caller can decide on a fallback.
 */
export function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, m, d] = compact;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  // Guard against clock-skewed or malformed future dates that would otherwise
  // pin an item to the top of the feed forever.
  const oneDayAhead = Date.now() + 24 * 60 * 60 * 1000;
  if (parsed.getTime() > oneDayAhead) return null;
  return parsed.toISOString();
}

/** Resolve the alternate link of an Atom entry. */
function atomLink(entry) {
  const links = asArray(entry.link);
  const alternate =
    links.find((l) => l?.['@_rel'] === 'alternate' && l?.['@_href']) ??
    links.find((l) => l?.['@_href'] && !l?.['@_rel']) ??
    links.find((l) => l?.['@_href']);
  if (alternate) return String(alternate['@_href']);
  return text(entry.link) || '';
}

/**
 * Parse an RSS 2.0, RSS 1.0/RDF or Atom document into normalised items.
 * Returns [] rather than throwing when the payload is not a recognised feed.
 */
export function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];

  // --- RSS 2.0 ------------------------------------------------------------
  if (doc.rss?.channel) {
    const channels = asArray(doc.rss.channel);
    const items = channels.flatMap((c) => asArray(c.item));
    return items.map((item) => ({
      guid: text(item.guid) || text(item.link) || text(item.title),
      title: stripHtml(text(item.title), 300),
      link: text(item.link).trim(),
      summary: stripHtml(text(item.description) || text(item.encoded) || text(item.summary)),
      publishedAt: parseDate(text(item.pubDate) || text(item.date) || text(item.published)),
    }));
  }

  // --- RSS 1.0 / RDF ------------------------------------------------------
  if (doc.RDF) {
    const items = asArray(doc.RDF.item);
    return items.map((item) => ({
      guid: text(item['@_about']) || text(item.link) || text(item.title),
      title: stripHtml(text(item.title), 300),
      link: text(item.link).trim(),
      summary: stripHtml(text(item.description)),
      publishedAt: parseDate(text(item.date) || text(item.pubDate)),
    }));
  }

  // --- Atom ---------------------------------------------------------------
  if (doc.feed) {
    const entries = asArray(doc.feed.entry);
    return entries.map((entry) => ({
      guid: text(entry.id) || atomLink(entry) || text(entry.title),
      title: stripHtml(text(entry.title), 300),
      link: atomLink(entry).trim(),
      summary: stripHtml(text(entry.summary) || text(entry.content)),
      publishedAt: parseDate(text(entry.published) || text(entry.updated)),
    }));
  }

  return [];
}

/**
 * Parse an openFDA enforcement payload. These are structured recall records
 * rather than a news feed, so the human-readable fields are assembled here.
 */
export function parseOpenFda(json, sourceUrl) {
  let doc;
  try {
    doc = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const results = Array.isArray(doc?.results) ? doc.results : [];

  return results.map((r) => {
    const firm = r.recalling_firm || 'Unknown firm';
    const product = r.product_description || 'Unspecified product';
    const klass = r.classification ? `${r.classification} recall` : 'Recall';
    const title = `${klass}: ${String(product).slice(0, 160)} (${firm})`;

    const summaryParts = [
      r.reason_for_recall && `Reason: ${r.reason_for_recall}`,
      r.status && `Status: ${r.status}`,
      r.distribution_pattern && `Distribution: ${r.distribution_pattern}`,
      r.product_quantity && `Quantity: ${r.product_quantity}`,
    ].filter(Boolean);

    // openFDA has no per-record permalink; the recall number is the stable
    // public identifier, so link back to a search for it.
    const recallNumber = r.recall_number || r.event_id || '';
    const link = recallNumber
      ? `https://api.fda.gov/${new URL(sourceUrl).pathname.replace(/^\//, '')}?search=recall_number:"${encodeURIComponent(recallNumber)}"`
      : sourceUrl;

    return {
      guid: recallNumber || `${firm}-${r.report_date}-${String(product).slice(0, 40)}`,
      title: stripHtml(title, 300),
      link,
      summary: stripHtml(summaryParts.join(' · ')),
      publishedAt: parseDate(
        r.report_date || r.recall_initiation_date || r.center_classification_date,
      ),
      // Carry the official classification through to the severity mapper.
      openFdaClassification: r.classification || null,
    };
  });
}
