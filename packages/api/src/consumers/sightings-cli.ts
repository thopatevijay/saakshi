/**
 * `npm run consume:sightings`
 *
 * Drains the Valkey `sightings` stream into Postgres until interrupted. Mirrors the shape of the
 * other jobs in this package (`sync:catalogue`, `trust:recompute`) rather than inventing a new one.
 *
 *   npm run consume:sightings                 # follow the stream, Ctrl-C to stop
 *   npm run consume:sightings -- --drain      # exit once the stream is empty (the gate run's mode)
 *   npm run consume:sightings -- --no-alerts  # ingest only, no watchlist correlation (D2-06)
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { consumeSightings, SIGHTINGS_GROUP, SIGHTINGS_STREAM } from './sightings.js';
import { createValkeyReader } from './valkey-reader.js';
import { AlertEngine } from '../services/alerts.js';
import { createWatchlistRegistry } from '../watchlist/index.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';

const env = loadEnv();
const drain = process.argv.includes('--drain');
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);
const reader = createValkeyReader(env.VALKEY_URL);

// D2-06's alert engine. `--no-alerts` skips it, for an ingest-only run on a machine with no
// watchlist — the correlation is a feature of the pipeline, not a precondition for it.
const alerts = !process.argv.includes('--no-alerts');
const engine = alerts
  ? new AlertEngine({
      db,
      registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
    })
  : undefined;

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

console.log(
  `consuming ${SIGHTINGS_STREAM} as group ${SIGHTINGS_GROUP}${drain ? ' (drain mode)' : ''}`,
);

try {
  const stats = await consumeSightings({
    reader,
    db,
    signal: controller.signal,
    // Drain mode exits after two empty polls; following mode never does. Two rather than one so a
    // batch that lands between polls is not mistaken for the end of the stream.
    maxIdlePolls: drain ? 2 : Infinity,
    blockMs: drain ? 1_000 : 5_000,
    ...(engine === undefined ? {} : { alertEngine: engine }),
    onBatch: (inserted, running) => {
      console.log(`  +${String(inserted)} rows  (total ${String(running.inserted)})`);
    },
  });

  console.log('');
  console.log(`  entries read      ${String(stats.entriesRead)}`);
  console.log(`  rows inserted     ${String(stats.inserted)}`);
  console.log(`  plate reads       ${String(stats.plateReadsInserted)}`);
  console.log(`  invalid payloads  ${String(stats.invalidPayloads)}`);
  console.log(`  unknown cameras   ${String(stats.unknownCameras)}`);
  console.log(
    `  alerts raised     ${String(stats.alertsRaised)}${alerts ? '' : ' (correlation off)'}`,
  );
  if (stats.correlationFailures > 0) {
    console.log(`  correlation fails ${String(stats.correlationFailures)}`);
  }
  if (stats.unknownCameraIds.length > 0) {
    console.log(`  unknown ids       ${stats.unknownCameraIds.join(', ')}`);
  }
  console.log('');
} finally {
  await reader.close();
  await rawSql.end();
}
