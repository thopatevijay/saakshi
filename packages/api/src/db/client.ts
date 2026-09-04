import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@saakshi/shared/db';

export type Sql = postgres.Sql<Record<string, never>>;

export function createSql(databaseUrl: string, max = 10): Sql {
  return postgres(databaseUrl, {
    max,
    // Timescale and PostGIS return types postgres-js has no parser for; keeping them as text and
    // letting drizzle/zod decide beats a silent lossy cast.
    types: {},
    onnotice: () => {},
  });
}

export function createDb(sql: Sql) {
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * A drizzle transaction handle. It is not assignable to `Db` — it has no `$client` — so anything
 * that must work both standalone and inside a transaction takes `DbLike`. `writeAudit` is the
 * reason this exists: an audit row belongs in the same transaction as the mutation it records.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;
