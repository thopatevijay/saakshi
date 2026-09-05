import 'dotenv/config';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';
import { createDb, createSql } from './db/client.js';
import { startCatalogueSchedule } from './jobs/scheduler.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(sql);
// A connection of its own for `LISTEN`: a listening connection is blocked for the life of the
// subscription, so taking one from the query pool would permanently remove it from that pool.
const listenSql = createSql(env.DATABASE_URL, 1);
const app = await buildServer({ env, db, listenSql });

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
  await listenSql.end();
  await sql.end();
  process.exit(1);
}
