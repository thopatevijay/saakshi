import 'dotenv/config';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';
import { createDb, createSql } from './db/client.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
const app = await buildServer({ env, db: createDb(sql) });

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  await sql.end();
  process.exit(1);
}
