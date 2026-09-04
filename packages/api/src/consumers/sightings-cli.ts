/**
 * `npm run consume:sightings`
 *
 * Drains the Valkey `sightings` stream into Postgres until interrupted. Mirrors the shape of the
 * other jobs in this package (`sync:catalogue`, `trust:recompute`) rather than inventing a new one.
 *
 *   npm run consume:sightings                 # follow the stream, Ctrl-C to stop
 *   npm run consume:sightings -- --drain      # exit once the stream is empty (the gate run's mode)
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { consumeSightings, SIGHTINGS_GROUP, SIGHTINGS_STREAM } from './sightings.js';
import { createValkeyReader } from './valkey-reader.js';

const env = loadEnv();
const drain = process.argv.includes('--drain');
const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);
const reader = createValkeyReader(env.VALKEY_URL);

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
    onBatch: (inserted, running) => {
      console.log(`  +${String(inserted)} rows  (total ${String(running.inserted)})`);
    },
  });

  console.log('');
  console.log(`  entries read      ${String(stats.entriesRead)}`);
  console.log(`  rows inserted     ${String(stats.inserted)}`);
  console.log(`  invalid payloads  ${String(stats.invalidPayloads)}`);
  console.log(`  unknown cameras   ${String(stats.unknownCameras)}`);
  if (stats.unknownCameraIds.length > 0) {
    console.log(`  unknown ids       ${stats.unknownCameraIds.join(', ')}`);
  }
  console.log('');
} finally {
  await reader.close();
  await rawSql.end();
}
