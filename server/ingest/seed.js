import crypto from 'node:crypto';
import { db, nowIso, syncSources } from '../db.js';

/**
 * Sample corpus used only when no authority feed can be reached (offline or
 * restricted egress), so the interface is explorable rather than blank.
 *
 * These are NOT regulatory events. Every entry is explicitly marked [SAMPLE],
 * describes the *kind* of notice an authority publishes rather than inventing a
 * specific one, and links to that authority's real index page. Nothing here
 * should ever be mistaken for an actual recall, approval or safety alert.
 * They are stored with is_sample = 1 and the UI banners them as placeholders.
 */
const SAMPLE_ITEMS = [
  {
    sourceId: 'fda-recalls',
    title: '[SAMPLE] Placeholder for FDA recall and market-withdrawal notices',
    summary:
      'Placeholder entry. When the FDA recalls feed is reachable, real recall and market-withdrawal notices appear here with the authority’s own headline and a link to the notice. Follow the link for the live index.',
    category: 'Recall',
    severity: 'critical',
    anchor: 'sample-recall',
    link: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts',
    ageHours: 2,
  },
  {
    sourceId: 'fda-medwatch',
    title: '[SAMPLE] Placeholder for FDA MedWatch safety alerts',
    summary:
      'Placeholder entry. MedWatch safety alerts for human medical products are published here once the feed is reachable.',
    category: 'Safety Alert',
    severity: 'high',
    anchor: 'sample-medwatch',
    link: 'https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program',
    ageHours: 6,
  },
  {
    sourceId: 'ema',
    title: '[SAMPLE] Placeholder for European Medicines Agency news',
    summary:
      'Placeholder entry. EMA press releases, CHMP opinions and referral outcomes appear here once the feed is reachable.',
    category: 'Approval',
    severity: 'medium',
    anchor: 'sample-ema',
    link: 'https://www.ema.europa.eu/en/news-events',
    ageHours: 9,
  },
  {
    sourceId: 'mhra',
    title: '[SAMPLE] Placeholder for MHRA publications and alerts',
    summary:
      'Placeholder entry. MHRA guidance, drug safety updates and device alerts appear here once the feed is reachable.',
    category: 'Guidance',
    severity: 'medium',
    anchor: 'sample-mhra',
    link: 'https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency',
    ageHours: 14,
  },
  {
    sourceId: 'who-alerts',
    title: '[SAMPLE] Placeholder for WHO medical product alerts',
    summary:
      'Placeholder entry. WHO alerts on falsified and substandard medical products appear here once the feed is reachable.',
    category: 'Safety Alert',
    severity: 'critical',
    anchor: 'sample-who',
    link: 'https://www.who.int/teams/regulation-prequalification/incidents-and-SF/full-list-of-who-medical-product-alerts',
    ageHours: 20,
  },
  {
    sourceId: 'health-canada-recalls',
    title: '[SAMPLE] Placeholder for Health Canada recalls and safety alerts',
    summary:
      'Placeholder entry. Health Canada recalls and safety alerts appear here once the feed is reachable.',
    category: 'Recall',
    severity: 'high',
    anchor: 'sample-hc',
    link: 'https://recalls-rappels.canada.ca/en',
    ageHours: 26,
  },
  {
    sourceId: 'tga',
    title: '[SAMPLE] Placeholder for TGA safety alerts',
    summary:
      'Placeholder entry. TGA safety alerts and product recalls appear here once the feed is reachable.',
    category: 'Safety Alert',
    severity: 'high',
    anchor: 'sample-tga',
    link: 'https://www.tga.gov.au/safety',
    ageHours: 32,
  },
  {
    sourceId: 'pmda',
    title: '[SAMPLE] Placeholder for PMDA safety information',
    summary:
      'Placeholder entry. PMDA safety information and revision instructions appear here once the feed is reachable.',
    category: 'Safety Alert',
    severity: 'medium',
    anchor: 'sample-pmda',
    link: 'https://www.pmda.go.jp/english/safety/info-services/0001.html',
    ageHours: 40,
  },
  {
    sourceId: 'swissmedic',
    title: '[SAMPLE] Placeholder for Swissmedic news and safety information',
    summary:
      'Placeholder entry. Swissmedic authorisations and safety information appear here once the feed is reachable.',
    category: 'Approval',
    severity: 'info',
    anchor: 'sample-swissmedic',
    link: 'https://www.swissmedic.ch/swissmedic/en/home.html',
    ageHours: 48,
  },
  {
    sourceId: 'anvisa',
    title: '[SAMPLE] Placeholder for ANVISA notices',
    summary:
      'Placeholder entry. ANVISA resolutions, alerts and notices appear here once the feed is reachable.',
    category: 'Policy',
    severity: 'info',
    anchor: 'sample-anvisa',
    link: 'https://www.gov.br/anvisa/pt-br',
    ageHours: 56,
  },
  {
    sourceId: 'openfda-drug-enforcement',
    title: '[SAMPLE] Placeholder for openFDA drug enforcement reports',
    summary:
      'Placeholder entry. Structured drug enforcement (recall) records from the openFDA API appear here, carrying the FDA’s own Class I/II/III classification.',
    category: 'Recall',
    severity: 'high',
    anchor: 'sample-openfda',
    link: 'https://open.fda.gov/apis/drug/enforcement/',
    ageHours: 64,
  },
  {
    sourceId: 'ecdc',
    title: '[SAMPLE] Placeholder for ECDC threat assessments',
    summary:
      'Placeholder entry. ECDC communicable disease threat assessments appear here once the feed is reachable.',
    category: 'Outbreak',
    severity: 'medium',
    anchor: 'sample-ecdc',
    link: 'https://www.ecdc.europa.eu/en/threats-and-outbreaks',
    ageHours: 72,
  },
];

/**
 * Insert the sample corpus. Returns the number of rows added.
 * Safe to call repeatedly - existing rows are left alone.
 */
export function loadSampleCorpus() {
  syncSources();

  const insert = db.prepare(
    `INSERT INTO updates
       (id, source_id, title, summary, link, published_at, fetched_at, category, severity, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  );

  const now = Date.now();
  const fetchedAt = nowIso();
  let added = 0;

  for (const item of SAMPLE_ITEMS) {
    const exists = db.prepare('SELECT 1 FROM sources WHERE id = ?').get(item.sourceId);
    if (!exists) continue;

    const link = `${item.link}#${item.anchor}`;
    const id = crypto.createHash('sha1').update(`sample::${item.sourceId}::${item.anchor}`).digest('hex');
    const publishedAt = new Date(now - item.ageHours * 60 * 60 * 1000).toISOString();

    try {
      const result = insert.run(
        id,
        item.sourceId,
        item.title,
        item.summary,
        link,
        publishedAt,
        fetchedAt,
        item.category,
        item.severity,
      );
      added += result.changes;
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }

  return added;
}

/** Remove every sample row - used once real data arrives. */
export function clearSampleCorpus() {
  return db.prepare('DELETE FROM updates WHERE is_sample = 1').run().changes;
}

// Allow `npm run seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const added = loadSampleCorpus();
  console.log(`Loaded ${added} sample items (labelled [SAMPLE], is_sample = 1).`);
}
