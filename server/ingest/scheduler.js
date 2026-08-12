import { config } from '../config.js';
import { db, pruneEphemeral, pruneOldUpdates } from '../db.js';
import { ingestAll } from './fetcher.js';
import { loadSampleCorpus } from './seed.js';

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
    const result = await ingestAll();
    ingestState.lastRunAt = new Date().toISOString();
    ingestState.lastResult = result;

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
