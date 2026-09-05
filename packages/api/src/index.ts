import 'dotenv/config';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';
import { createDb, createSql } from './db/client.js';
import { startCatalogueSchedule } from './jobs/scheduler.js';
import { presignerFromEnv } from './services/crop-url.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(sql);
// The object store is built here, at the composition root, and injected — no route module reads
// credentials at import time. With no MinIO configured this yields `null` for every evidence crop
// URL, which is the honest answer rather than a broken link.
const app = await buildServer({ env, db, cropPresigner: presignerFromEnv() });

// Scheduled catalogue re-sync. Off unless CATALOGUE_SYNC_INTERVAL_MIN is set, and never fatal —
// the on-demand paths (the API endpoint and `npm run sync:catalogue`) are the ones that matter.
const source =
  env.SENTINEL_INGEST_URL ??
  (env.SENTINEL_HOST === undefined ? undefined : `https://${env.SENTINEL_HOST}/cameras.json`);
if (source !== undefined) {
  startCatalogueSchedule({
    db,
    source,
    intervalMinutes: env.CATALOGUE_SYNC_INTERVAL_MIN,
    log: app.log,
    ...(env.SENTINEL_PORTAL_COOKIE === undefined ? {} : { cookie: env.SENTINEL_PORTAL_COOKIE }),
  });
}

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  await sql.end();
  process.exit(1);
}
