import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { db, pruneEphemeral, pruneOldUpdates } from '../db.js';
import { ingestAll } from './fetcher.js';
import { loadSampleCorpus } from './seed.js';

/**
 * Broadcasts ingestion activity so connected dashboards can update live
 * instead of waiting for a refresh. Listeners are SSE connections.
 */
export const ingestEvents = new EventEmitter();
// One listener per open dashboard tab; lift the default cap accordingly.
ingestEvents.setMaxListeners(0);

let timer = null;
let running = false;

export const ingestState = {
  lastRunAt: null,
  lastResult: null,
  running: false,
  usingSampleData: false,
};

export async function runIngestCycle({ verbose = true } = {}) {
  if (running) return null;
  running = true;
  ingestState.running = true;

  try {
    // Note the high-water mark so we can tell listeners exactly what is new.
    const before = db.prepare('SELECT MAX(rowid) AS mark FROM updates').get().mark ?? 0;

    const result = await ingestAll();
    ingestState.lastRunAt = new Date().toISOString();
    ingestState.lastResult = result;

    if (result.inserted > 0) {
      const fresh = db
        .prepare(
          `SELECT u.id, u.title, u.summary, u.link, u.published_at, u.category,
                  u.severity, u.is_sample,
                  s.id AS source_id, s.authority, s.agency, s.country,
                  s.country_code, s.region, s.site, s.topic, s.lat, s.lon
             FROM updates u
             JOIN sources s ON s.id = u.source_id
            WHERE u.rowid > ?
            ORDER BY u.published_at DESC
            LIMIT 40`,
        )
        .all(before);

      if (fresh.length > 0) ingestEvents.emit('items', fresh);
    }

    ingestEvents.emit('cycle', {
      at: ingestState.lastRunAt,
      reachable: result.ok,
      sources: result.sources,
      inserted: result.inserted,
    });

    if (verbose) {
      console.log(
        `[ingest] ${result.ok}/${result.sources} sources reachable, ` +
          `${result.inserted} new items in ${result.ms}ms`,
      );
      for (const r of result.results) {
        if (r?.error) console.warn(`[ingest]   ${r.sourceId}: ${r.error}`);
      }
    }

    pruneEphemeral();
    const pruned = pruneOldUpdates();
    if (verbose && pruned > 0) {
      console.log(`[ingest] pruned ${pruned} items past the retention window`);
    }

    // If nothing at all could be reached and the feed is empty, fall back to the
    // bundled sample corpus so the app is still explorable offline. Clearly
    // flagged as sample data everywhere it appears.
    if (config.seedWhenEmpty && result.ok === 0) {
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM updates WHERE is_sample = 0')
        .get();
      if (n === 0) {
        const added = loadSampleCorpus();
        ingestState.usingSampleData = true;
        if (verbose && added > 0) {
          console.warn(
            `[ingest] no source was reachable - loaded ${added} clearly-labelled sample items so the UI is populated. ` +
              'Run "npm run probe" from a network that can reach the authorities to diagnose.',
          );
        }
      }
    } else if (result.inserted > 0 || result.ok > 0) {
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM updates WHERE is_sample = 0')
        .get();
      if (n > 0) ingestState.usingSampleData = false;
    }

    return result;
  } finally {
    running = false;
    ingestState.running = false;
  }
}

export function startScheduler() {
  if (!config.autoIngest) {
    console.log('[ingest] AUTO_INGEST is off; not polling. Use "npm run ingest" to poll manually.');
    return;
  }

  // Kick off immediately, then on the configured interval.
  runIngestCycle().catch((err) => console.error('[ingest] cycle failed:', err));

  timer = setInterval(() => {
    runIngestCycle().catch((err) => console.error('[ingest] cycle failed:', err));
  }, config.pollIntervalMs);

  // Do not hold the process open purely for the poll timer.
  timer.unref?.();

  console.log(
    `[ingest] polling ${config.pollIntervalMs / 60000} min interval across all enabled sources`,
  );
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
