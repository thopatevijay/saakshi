/**
 * `npm run sync:catalogue` — the one command behind AC 1.
 *
 * It exists so a re-sync is something an operator can do on stage, in one line, when the camera set
 * changes mid-demonstration. Same job as the API endpoint and the scheduler; only the trigger and
 * the output differ.
 *
 *   npm run sync:catalogue
 *   npm run sync:catalogue -- --department AHM-TRAF --adapter hls
 *   npm run sync:catalogue -- --source https://host/api/ingest
 */
import 'dotenv/config';
import { loadEnv } from '../env.js';
import { createDb, createSql } from '../db/client.js';
import { AdapterKind } from '@saakshi/shared';
import { resolveDepartment, syncCatalogue, type SyncReport } from './catalogue-sync.js';
import { UnknownCatalogueShapeError } from './catalogue-parse.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(14)} ${String(value)}`);
}

function print(report: SyncReport): void {
  console.log('');
  line('source', report.source);
  line('shape', report.shape ?? '—');
  line('department', report.departmentId ?? '(unassigned)');
  line('fetched', report.fetched);
  console.log('');
  line('added', report.added);
  line('updated', report.updated);
  line('unchanged', report.unchanged);
  line('went absent', report.wentAbsent);
  line('returned', report.returned);
  line('rejected', report.rejected);
  console.log('');
  line('duration', `${String(report.durationMs)}ms`);
  line('run id', report.runId);

  for (const rejection of report.rejections.slice(0, 10)) {
    for (const error of rejection.errors) {
      console.log(
        `  ! row ${String(rejection.row)} (${rejection.externalId ?? 'no id'}): ` +
          `${error.field} — ${error.message}`,
      );
    }
  }
  if (report.rejections.length > 10) {
    console.log(`  ! …and ${String(report.rejections.length - 10)} more — see the run report`);
  }
  console.log('');
}

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, 4);
const db = createDb(sql);

// `GET /api/ingest` is the contract; the URL pattern is not. Never hardcoded — configuration, or
// an explicit flag for the case where the organisers move it on the day.
const source =
  flag('source') ?? env.SENTINEL_INGEST_URL ?? `https://${String(env.SENTINEL_HOST)}/cameras.json`;

if (
  env.SENTINEL_HOST === undefined &&
  env.SENTINEL_INGEST_URL === undefined &&
  flag('source') === undefined
) {
  console.error(
    'no catalogue source. Set SENTINEL_INGEST_URL or SENTINEL_HOST in .env, or pass --source <url>.',
  );
  await sql.end();
  process.exit(2);
}

const departmentRef = flag('department');
const adapterFlag = flag('adapter');
const adapter = adapterFlag === undefined ? undefined : AdapterKind.parse(adapterFlag);

try {
  const departmentId =
    departmentRef === undefined ? null : await resolveDepartment(db, departmentRef);

  const report = await syncCatalogue(db, {
    source,
    trigger: 'cli',
    departmentId,
    ...(adapter === undefined ? {} : { adapterKind: adapter }),
    ...(env.SENTINEL_PORTAL_COOKIE === undefined ? {} : { cookie: env.SENTINEL_PORTAL_COOKIE }),
  });

  print(report);
  await sql.end();
} catch (err) {
  console.error('');
  console.error(`  sync failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof UnknownCatalogueShapeError) {
    // The run row carries the raw payload. Say so — an operator who does not know it was kept will
    // go looking for it in a log that redacts bodies.
    console.error('');
    console.error('  The raw payload was persisted. Read it with:');
    console.error('    GET /api/v1/sync/reports?ok=false   → then GET /api/v1/sync/reports/<id>');
  }
  console.error('');
  await sql.end();
  process.exit(1);
}
