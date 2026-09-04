/**
 * Generates `src/lib/api/schema.d.ts` from the API's own OpenAPI document.
 *
 * The acceptance criterion is a **typed client generated from the OpenAPI spec, not hand-written
 * fetch**. Hand-written request types are a second description of the same contract, and the two
 * drift the moment a route changes — silently, because both still compile.
 *
 * The Fastify app is built **in-process** to produce the document, so generation needs no running
 * server and no database connection: `@fastify/swagger` reads the route schemas at registration
 * time and never executes a handler. The connection string below is therefore never dialled —
 * postgres.js connects lazily.
 *
 *   npm run generate:api -w @saakshi/web
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildServer } from '../../api/src/server.js';
import { createDb, createSql } from '../../api/src/db/client.js';
import { loadEnv } from '../../api/src/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../src/lib/api');
const specPath = path.join(outDir, 'openapi.json');
const typesPath = path.join(outDir, 'schema.d.ts');

const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
// Lazy: postgres.js opens no socket until a query runs, and generating a spec runs none.
const sql = createSql(env.DATABASE_URL, 1);
const app = await buildServer({ env, db: createDb(sql) });
await app.ready();

mkdirSync(outDir, { recursive: true });
writeFileSync(specPath, JSON.stringify(app.swagger(), null, 2));
await app.close();
await sql.end();

execFileSync('npx', ['openapi-typescript', specPath, '-o', typesPath], { stdio: 'inherit' });

const paths = Object.keys((JSON.parse(JSON.stringify(app.swagger())) as { paths: object }).paths);
console.log(`\n  ${String(paths.length)} paths → ${path.relative(process.cwd(), typesPath)}\n`);
