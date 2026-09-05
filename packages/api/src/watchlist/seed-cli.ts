/**
 * `npm run seed:watchlist`
 *
 * Loads `fixtures/watchlist-seed.csv` — the representative watchlist database the challenge's
 * problem statement invites participants to create — into `watchlist_entries`.
 *
 * **Idempotent.** It upserts on `(source_system, source_ref)`, the natural key migration `0015`
 * declares, so running it twice leaves the same rows rather than doubling the estate. That matters
 * because the validation gate runs it and a demo re-runs it, and a seeder that silently duplicates
 * turns 235 entries into 470 with no error to notice.
 *
 * **Nothing loaded here is a live record.** There is no VAHAN / SARTHI / eGujCop / AFIS / NAFIS
 * connectivity; these rows are synthetic, except the plates explicitly marked
 * `provenance=estate-groundtruth` (registrations a human read off the sandbox feeds) and
 * `provenance=estate-ocr-output` (strings the ANPR pipeline actually emitted). See
 * `docs/watchlist-integration.md`.
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { SEED_CSV_PATH } from './index.js';
import { loadSeedCsv, upsertWatchlistEntries } from './seed.js';

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const env = loadEnv();
  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const csvPath = process.argv.find((arg) => arg.endsWith('.csv')) ?? SEED_CSV_PATH;

  try {
    const batch = await loadSeedCsv(csvPath);
    const result = await upsertWatchlistEntries(db, batch.valid);

    console.log('');
    console.log(`  source            ${csvPath}`);
    console.log(`  rows read         ${String(batch.received)}`);
    console.log(`  inserted          ${String(result.inserted)}`);
    console.log(`  updated           ${String(result.updated)}`);
    console.log(`  rejected          ${String(batch.rejected.length)}`);
    for (const rejection of batch.rejected.slice(0, 10)) {
      console.log(`    row ${String(rejection.row)} · ${rejection.field}: ${rejection.message}`);
    }
    console.log('');
    if (batch.rejected.length > 0) process.exitCode = 1;
  } finally {
    await rawSql.end();
  }
}
