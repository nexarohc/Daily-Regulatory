/**
 * Run a single ingestion cycle and exit. Useful for cron-driven deployments
 * where the web process should not also poll:
 *
 *   npm run ingest
 */
import { syncSources } from '../db.js';
import { runIngestCycle } from './scheduler.js';

syncSources();
const result = await runIngestCycle({ verbose: true });

if (!result) {
  console.error('An ingestion cycle was already running.');
  process.exit(1);
}

console.log(
  `\nDone: ${result.ok}/${result.sources} sources reachable, ${result.inserted} new items.`,
);
process.exit(result.ok === 0 ? 1 : 0);
