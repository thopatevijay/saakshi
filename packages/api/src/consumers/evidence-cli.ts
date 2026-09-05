/**
 * `npm run consume:evidence`
 *
 * Drains the Valkey `evidence` stream: one best-shot crop per track session into MinIO, and the
 * attributes it carries back onto the sighting row.
 *
 *   npm run consume:evidence                 # follow the stream, Ctrl-C to stop
 *   npm run consume:evidence -- --drain      # exit once the stream is empty (the gate run's mode)
 *
 * Run it **after** `consume:sightings` on a gate run. The two streams are independent and a crop
 * cannot be named until its sighting row exists; the consumer waits and retries, but starting in
 * the natural order turns a bounded wait into no wait at all.
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { consumeEvidence, EVIDENCE_GROUP, EVIDENCE_STREAM } from './evidence.js';
import { evidenceStoreFromEnv } from '../services/evidence.js';
import { createValkeyReader } from './valkey-reader.js';

const env = loadEnv();
const drain = process.argv.includes('--drain');

const store = evidenceStoreFromEnv();
if (store === null) {
  console.error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are not set — nothing to write evidence to.');
  process.exit(2);
}

const rawSql = createSql(env.DATABASE_URL, 4);
const db = createDb(rawSql);
const reader = createValkeyReader(env.VALKEY_URL);

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

console.log(
  `consuming ${EVIDENCE_STREAM} as group ${EVIDENCE_GROUP} into ${store.bucket}${drain ? ' (drain mode)' : ''}`,
);

try {
  const stats = await consumeEvidence({
    reader,
    db,
    store,
    signal: controller.signal,
    maxIdlePolls: drain ? 2 : Infinity,
    blockMs: drain ? 1_000 : 5_000,
    onBatch: (stored, running) => {
      console.log(`  +${String(stored)} crops  (total ${String(running.stored)})`);
    },
  });

  const mean = stats.stored > 0 ? Math.round(stats.bytesStored / stats.stored) : 0;
  console.log('');
  console.log(`  entries read       ${String(stats.entriesRead)}`);
  console.log(`  crops stored       ${String(stats.stored)}`);
  console.log(`  bytes stored       ${String(stats.bytesStored)} (mean ${String(mean)} B/crop)`);
  console.log(`  low-confidence     ${String(stats.lowConfidenceColors)} colour reads -> unknown`);
  console.log(`  unmatched          ${String(stats.unmatched)} (no sighting row)`);
  console.log(`  invalid payloads   ${String(stats.invalidPayloads)}`);
  console.log(`  unknown cameras    ${String(stats.unknownCameras)}`);
  console.log(`  upload failures    ${String(stats.uploadFailures)}`);
  console.log('');
} finally {
  await reader.close();
  await rawSql.end();
}
