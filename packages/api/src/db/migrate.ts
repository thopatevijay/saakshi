/**
 * SQL migration runner.
 *
 * Why not `drizzle-kit migrate`: drizzle-kit generates forward SQL only — it has no `--down` and no
 * rollback command — and D1-01 requires a tested rollback path. Migrations here are hand-authored
 * `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs, which is also the only way to express
 * `create_hypertable`, GiST/GIN index opclasses, enum types and the audit-log trigger. drizzle-orm
 * remains the typed schema (`@saakshi/shared/db`) and the source of the row types.
 *
 * Commands:
 *   migrate   apply every pending .up.sql in order            (idempotent)
 *   rollback  apply the newest applied migration's .down.sql   (one step; `--all` for everything)
 *   reset     drop and recreate the public schema, then migrate
 *   status    list migrations and whether each is applied
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createSql, type Sql } from './client.js';
import { loadEnv } from '../env.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../db/migrations',
);

const LEDGER = 'schema_migrations';

interface Migration {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
}

async function discover(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const ups = entries.filter((f) => f.endsWith('.up.sql')).sort();

  return ups.map((file) => {
    const base = file.replace(/\.up\.sql$/, '');
    const version = base.slice(0, base.indexOf('_'));
    const down = `${base}.down.sql`;
    if (!entries.includes(down)) {
      throw new Error(`migration ${base} has no ${down} — every migration must be reversible`);
    }
    return {
      version,
      name: base,
      upPath: path.join(MIGRATIONS_DIR, file),
      downPath: path.join(MIGRATIONS_DIR, down),
    };
  });
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists ${LEDGER} (
      version     text primary key,
      name        text not null,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

async function appliedVersions(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql.unsafe<{ version: string; checksum: string }[]>(
    `select version, checksum from ${LEDGER}`,
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

const checksum = (body: string): string =>
  createHash('sha256').update(body).digest('hex').slice(0, 16);

async function migrate(sql: Sql): Promise<number> {
  await ensureLedger(sql);
  const applied = await appliedVersions(sql);
  const migrations = await discover();
  let count = 0;

  for (const m of migrations) {
    const body = await readFile(m.upPath, 'utf8');
    const sum = checksum(body);
    const previous = applied.get(m.version);

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new Error(
          `migration ${m.name} changed after being applied (${previous} -> ${sum}). ` +
            `Edit history is not a migration: add a new one, or db:reset in development.`,
        );
      }
      continue;
    }

    // Each migration is one transaction: a half-applied migration is worse than a failed one.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe(`insert into ${LEDGER} (version, name, checksum) values ($1, $2, $3)`, [
        m.version,
        m.name,
        sum,
      ]);
    });

    console.log(`  applied  ${m.name}`);
    count += 1;
  }

  console.log(count === 0 ? '  nothing to apply — already up to date' : `  ${count} applied`);
  return count;
}

async function rollback(sql: Sql, all: boolean): Promise<number> {
  await ensureLedger(sql);
  const migrations = await discover();
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  let count = 0;

  for (;;) {
    const rows = await sql.unsafe<{ version: string }[]>(
      `select version from ${LEDGER} order by version desc limit 1`,
    );
    const top = rows[0];
    if (top === undefined) break;

    const m = byVersion.get(top.version);
    if (m === undefined) {
      throw new Error(`${LEDGER} records version ${top.version} but no such migration file exists`);
    }

    const body = await readFile(m.downPath, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe(`delete from ${LEDGER} where version = $1`, [m.version]);
    });

    console.log(`  reverted ${m.name}`);
    count += 1;
    if (!all) break;
  }

  if (count === 0) console.log('  nothing to roll back');
  return count;
}

async function reset(sql: Sql): Promise<void> {
  // Timescale needs its own teardown before the schema goes: dropping `public` out from under an
  // extension that owns objects in it leaves the extension in a broken state.
  await sql.unsafe(`drop schema if exists public cascade`);
  await sql.unsafe(`create schema public`);
  await sql.unsafe(`grant all on schema public to current_user`);
  console.log('  public schema recreated');
  await migrate(sql);
}

async function status(sql: Sql): Promise<void> {
  await ensureLedger(sql);
  const applied = await appliedVersions(sql);
  for (const m of await discover()) {
    console.log(`  ${applied.has(m.version) ? 'applied' : 'pending'}  ${m.name}`);
  }
}

const command = process.argv[2] ?? 'migrate';
const env = loadEnv();
const sql = createSql(env.DATABASE_URL, 1);

try {
  switch (command) {
    case 'migrate':
      await migrate(sql);
      break;
    case 'rollback':
      await rollback(sql, process.argv.includes('--all'));
      break;
    case 'reset':
      await reset(sql);
      break;
    case 'status':
      await status(sql);
      break;
    default:
      console.error(`unknown command: ${command} (migrate | rollback | reset | status)`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
