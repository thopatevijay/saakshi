/**
 * Schema drift test.
 *
 * The SQL in `db/migrations/` is the source of truth; the drizzle schema in `@saakshi/shared/db` is
 * a hand-maintained mirror that produces the row types. Two hand-maintained descriptions of the
 * same thing drift, and the drift is invisible — the types keep compiling while the queries start
 * failing at runtime. So this suite asks the live database what it actually has and compares.
 *
 * Requires the migrated database (`make up && npm run db:migrate`). Skips itself, loudly, when the
 * database is unreachable, so `npm run test` still works offline; CI runs it against a live one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@saakshi/shared/db';
import { createDb, createSql, type Db, type Sql } from './client.js';
import { loadEnv } from '../env.js';

const TABLES: PgTable[] = [
  schema.departments,
  schema.users,
  schema.cameras,
  schema.cameraCoverage,
  schema.catalogueSyncRuns,
  schema.roadNetwork,
  schema.cameraHealthChecks,
  schema.sightings,
  schema.plateReads,
  schema.vehicleIdentities,
  schema.identitySightings,
  schema.watchlistEntries,
  schema.alerts,
  schema.routes,
  schema.routeSegments,
  schema.auditLog,
  schema.exportBundles,
  schema.onboardingResponses,
];

const ENUMS: Record<string, readonly string[]> = {
  camera_type: schema.cameraTypeEnum.enumValues,
  camera_mount: schema.cameraMountEnum.enumValues,
  storage_type: schema.storageTypeEnum.enumValues,
  adapter_kind: schema.adapterKindEnum.enumValues,
  camera_status: schema.cameraStatusEnum.enumValues,
  catalogue_status: schema.catalogueStatusEnum.enumValues,
  camera_geometry: schema.cameraGeometryEnum.enumValues,
  user_role: schema.userRoleEnum.enumValues,
  watchlist_category: schema.watchlistCategoryEnum.enumValues,
  watchlist_entity_type: schema.watchlistEntityTypeEnum.enumValues,
  source_system: schema.sourceSystemEnum.enumValues,
  alert_severity: schema.alertSeverityEnum.enumValues,
  alert_status: schema.alertStatusEnum.enumValues,
  match_type: schema.matchTypeEnum.enumValues,
  link_method: schema.linkMethodEnum.enumValues,
  route_anomaly: schema.routeAnomalyEnum.enumValues,
  vehicle_class: schema.vehicleClassEnum.enumValues,
};

let rawSql: Sql;
let db: Db;
let reachable = false;

beforeAll(async () => {
  rawSql = createSql(loadEnv().DATABASE_URL, 1);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[schema-drift] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  // Reachable but unmigrated is a different situation from unreachable, and it must not pass
  // quietly: an empty database would satisfy nothing here while looking like a clean run.
  const ledger = await rawSql<{ n: string }[]>`
    select count(*)::text as n from information_schema.tables
    where table_schema = 'public' and table_name = 'schema_migrations'`;
  if (ledger[0]?.n === '0') {
    throw new Error(
      'database is reachable but has no migrations applied — run `make migrate` (npm run db:migrate)',
    );
  }
});

afterAll(async () => {
  await rawSql?.end();
});

describe('drizzle schema matches the migrated database', () => {
  it('every table in the drizzle schema exists in the database', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const actual = new Set(rows.map((r) => r.table_name));
    const missing = TABLES.map(getTableName).filter((t) => !actual.has(t));
    expect(missing).toEqual([]);
  });

  it.each(TABLES.map((t) => [getTableName(t), t] as const))(
    '%s has exactly the columns drizzle declares',
    async (tableName, table) => {
      if (!reachable) return;
      const rows = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = ${tableName}`,
      );
      const actual = [...new Set(rows.map((r) => r.column_name))].sort();
      const declared = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();

      expect(actual).toEqual(declared);
    },
  );

  it.each(Object.entries(ENUMS))(
    'enum %s has exactly the declared values',
    async (name, values) => {
      if (!reachable) return;
      const rows = await db.execute<{ label: string }>(
        sql`select e.enumlabel as label from pg_enum e
          join pg_type t on t.oid = e.enumtypid
          where t.typname = ${name}
          order by e.enumsortorder`,
      );
      expect(rows.map((r) => r.label)).toEqual([...values]);
    },
  );

  it('both time-series tables are Timescale hypertables', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ hypertable_name: string }>(
      sql`select hypertable_name from timescaledb_information.hypertables
          where hypertable_schema = 'public'`,
    );
    expect(rows.map((r) => r.hypertable_name).sort()).toEqual([
      'camera_health_checks',
      'sightings',
    ]);
  });

  it('the fuzzy plate index is a trigram index, not a btree', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'plate_reads' and indexname = 'plate_reads_normalized_trgm_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('gin_trgm_ops');
  });
});

describe('audit_log is append-only', () => {
  it('rejects UPDATE as the app role', async () => {
    if (!reachable) return;
    // `saakshi` owns the database, and an owner cannot be restricted by grants — so the guard is
    // proven as `saakshi_app`, the role the deployed API actually connects as.
    await expect(
      rawSql.begin(async (tx) => {
        await tx.unsafe('set local role saakshi_app');
        await tx.unsafe(`update audit_log set purpose = 'tampered'`);
      }),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('rejects DELETE as the app role', async () => {
    if (!reachable) return;
    await expect(
      rawSql.begin(async (tx) => {
        await tx.unsafe('set local role saakshi_app');
        await tx.unsafe('delete from audit_log');
      }),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('rejects UPDATE even for the owner, via the trigger', async () => {
    if (!reachable) return;
    // Defence in depth: grants can be changed by an administrator in a hurry, a trigger shows up
    // in a schema diff. Seed one row, then try to edit it as the owner.
    await expect(
      rawSql.begin(async (tx) => {
        await tx.unsafe(
          `
          insert into audit_log (action, target_type, purpose, prev_hash, hash)
          values ('drift.test', 'test', 'verifying the append-only guard', 'genesis', $1)
        `,
          [`drift-${Date.now()}`],
        );
        await tx.unsafe(`update audit_log set purpose = 'tampered' where action = 'drift.test'`);
      }),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('seed data', () => {
  it('has 5 departments and 4 users, one per role', async () => {
    if (!reachable) return;
    const deps = await db.execute<{ n: string }>(sql`select count(*)::text as n from departments`);
    // Sorted as text, not by enum order: the AC is about coverage of the four roles, not sequence.
    const roles = await db.execute<{ role: string }>(sql`select role::text as role from users`);

    expect(deps[0]?.n).toBe('5');
    expect(roles.map((r) => r.role).sort()).toEqual(['admin', 'auditor', 'operator', 'supervisor']);
  });
});
