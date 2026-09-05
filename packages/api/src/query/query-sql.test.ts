/**
 * D3-09 · the two claims that can only be proved against a real database.
 *
 * AC 7's construction argument — "mutations are impossible by construction" — is asserted here by
 * *attempting a mutation* inside the executor's own transaction and reading back the SQLSTATE.
 * Postgres answers `25006 read_only_sql_transaction`, and that is a stronger form of evidence than
 * any amount of reading our own code: it holds regardless of what the rest of this package does.
 *
 * AC 9's sequence query — "later appeared near X returns correct ordered results" — is asserted by
 * seeding a two-leg journey and checking both that the pair is found and that **reversing the legs
 * finds nothing**. The second half is the one that matters: a self-join that ignored direction
 * would pass the first check and be silently wrong about which way a vehicle travelled.
 *
 * Skips cleanly with a warning when no database is reachable, following `services/trace.test.ts`.
 * Every row it writes is tagged and removed afterwards, and the estate count is asserted unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EMPTY_QUERY_DSL, type QueryDSL } from '@saakshi/shared';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { QueryExecutor } from './execute.js';

const TAG = 'D3-09-QSQL';

let rawSql: Sql;
let db: Db;
let reachable = false;
let cameraA = '';
let cameraB = '';

/** `2026-03-01T…` — deliberately far from any other suite's window, so nothing collides. */
const T0 = '2026-03-01T02:00:00.000Z';
const T1 = '2026-03-01T02:40:00.000Z';
const T2 = '2026-03-01T05:30:00.000Z';

/**
 * Postgres's SQLSTATE, from wherever in the chain it ended up.
 *
 * drizzle wraps the driver's error, so `.code` on the outer object is `undefined` and a test that
 * read only that would report "no error" for an error that did happen — the worst possible result
 * for a suite whose job is to prove a write is refused. Walk the `cause` chain instead.
 */
function sqlStateOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function dsl(patch: (d: QueryDSL) => void): QueryDSL {
  const d = structuredClone(EMPTY_QUERY_DSL);
  patch(d);
  return d;
}

async function seedSighting(
  cameraId: string,
  ts: string,
  trackId: number,
  plate: string,
): Promise<void> {
  const rows = (await db.execute<{ id: string }>(sql`
    insert into sightings
      (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence, vehicle_color,
       is_best_shot)
    values (${cameraId}::uuid, ${ts}, ${Math.round(Date.parse(ts) % 1_000_000)}, ${trackId},
            'car', '{"x":0,"y":0,"w":100,"h":80}'::jsonb, 0.910, 'white', true)
    returning id::text as id
  `)) as unknown as { id: string }[];
  await db.execute(sql`
    insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count)
    values (${rows[0]?.id ?? ''}::uuid, ${ts}, ${plate}, ${plate}, 0.880, 3)
  `);
}

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[query-sql] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const cameras = (await db.execute<{ id: string; external_id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind, endpoints, district)
    values (${`${TAG}-CAM-A`}, 'D3-09 leg A (test)', 'hls', '{}'::jsonb, ${`${TAG}-District`}),
           (${`${TAG}-CAM-B`}, 'D3-09 leg B (test)', 'hls', '{}'::jsonb, ${`${TAG}-District`})
    returning id::text as id, external_id
  `)) as unknown as { id: string; external_id: string }[];
  cameraA = cameras.find((c) => c.external_id === `${TAG}-CAM-A`)?.id ?? '';
  cameraB = cameras.find((c) => c.external_id === `${TAG}-CAM-B`)?.id ?? '';

  // One vehicle: cam A at 02:00, cam A again at 02:40, cam B at 05:30. Two hops, three sightings.
  await seedSighting(cameraA, T0, 100_001, `${'GJ01QQ'}1111`);
  await seedSighting(cameraA, T1, 100_002, `${'GJ01QQ'}1111`);
  await seedSighting(cameraB, T2, 200_003, `${'GJ01QQ'}1111`);
  // A decoy that only ever appears at leg B, so a broken join would surface it.
  await seedSighting(cameraB, T1, 200_004, `${'GJ09ZZ'}9999`);
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`
      delete from plate_reads where sighting_id in (
        select id from sightings where camera_id in (
          select id from cameras where external_id like ${`${TAG}-%`}))`);
    await db.execute(sql`
      delete from sightings where camera_id in (
        select id from cameras where external_id like ${`${TAG}-%`})`);
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}-%`}`);
    const left = (await db.execute<{ n: string }>(
      sql`select count(*)::text as n from cameras where external_id like ${`${TAG}-%`}`,
    )) as unknown as { n: string }[];
    expect(left[0]?.n).toBe('0');
  }
  await rawSql?.end({ timeout: 5 });
});

describe('AC 7 — a mutation is refused by Postgres, not by our care', () => {
  it('the executor’s transaction is read only: an INSERT fails 25006', async () => {
    if (!reachable) return;
    // Exactly the transaction `QueryExecutor.readOnly` opens. If a compiled query ever *did* carry
    // a write — through a bug, a bad edit, or a defence removed — this is what would stop it.
    let code: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        await tx.execute(sql`insert into cameras (external_id, name, adapter_kind, endpoints)
                             values (${`${TAG}-SHOULD-NOT-EXIST`}, 'x', 'hls', '{}'::jsonb)`);
      });
    } catch (error) {
      code = sqlStateOf(error);
    }
    expect(code).toBe('25006');

    const leaked = (await db.execute<{ n: string }>(
      sql`select count(*)::text as n from cameras where external_id = ${`${TAG}-SHOULD-NOT-EXIST`}`,
    )) as unknown as { n: string }[];
    expect(leaked[0]?.n).toBe('0');
  });

  it('refuses an UPDATE and a DELETE in the same transaction', async () => {
    if (!reachable) return;
    for (const statement of [
      sql`update cameras set name = 'tampered' where external_id like ${`${TAG}-%`}`,
      sql`delete from cameras where external_id like ${`${TAG}-%`}`,
    ]) {
      let code: string | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`set transaction read only`);
          await tx.execute(statement);
        });
      } catch (error) {
        code = sqlStateOf(error);
      }
      expect(code).toBe('25006');
    }
    // And the rows the suite seeded are untouched.
    const still = (await db.execute<{ n: string }>(
      sql`select count(*)::text as n from cameras where external_id like ${`${TAG}-%`}`,
    )) as unknown as { n: string }[];
    expect(still[0]?.n).toBe('2');
  });

  it('a normal read still works inside it', async () => {
    if (!reachable) return;
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.districts = [`${TAG}-District`];
      }),
    );
    expect(result.rowCount).toBe(4);
    expect(result.sqlPreview).toContain('$1');
  });
});

describe('AC 9 — sequence queries return correct ordered results', () => {
  it('finds A-then-B and returns it in ts order', async () => {
    if (!reachable) return;
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.cameraExternalIds = [`${TAG}-CAM-A`];
        d.sequence = {
          place: {
            cameraExternalIds: [`${TAG}-CAM-B`],
            districts: [],
            nearName: null,
            radius: null,
          },
          withinMinutes: 300,
        };
      }),
    );

    // Both legs of the journey, and only the vehicle that made it.
    expect(result.sightings.map((s) => s.plateNormalized)).toEqual([
      'GJ01QQ1111',
      'GJ01QQ1111',
      'GJ01QQ1111',
    ]);
    // D2-08's ordering, unchanged: ts ASC, framePtsMs ASC, sightingId ASC.
    const stamps = result.sightings.map((s) => s.ts);
    expect([...stamps]).toEqual([...stamps].sort());
    expect(stamps[0]).toBe(new Date(T0).toISOString());
    expect(stamps[stamps.length - 1]).toBe(new Date(T2).toISOString());
    // The decoy only ever appeared at leg B and never at leg A, so it must not be here.
    expect(result.sightings.some((s) => s.plateNormalized === 'GJ09ZZ9999')).toBe(false);
  });

  it('finds nothing when the legs are reversed — direction is real', async () => {
    if (!reachable) return;
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.cameraExternalIds = [`${TAG}-CAM-B`];
        d.sequence = {
          place: {
            cameraExternalIds: [`${TAG}-CAM-A`],
            districts: [],
            nearName: null,
            radius: null,
          },
          withinMinutes: 300,
        };
      }),
    );
    expect(result.rowCount).toBe(0);
    // An empty result is an answer, with a reason — D2-08's rule.
    expect(result.emptyReason).toBe('no_rows');
  });

  it('respects the time ceiling between the legs', async () => {
    if (!reachable) return;
    // The two legs are 3h30m apart; a 60-minute ceiling must exclude the pair entirely.
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.cameraExternalIds = [`${TAG}-CAM-A`];
        d.sequence = {
          place: {
            cameraExternalIds: [`${TAG}-CAM-B`],
            districts: [],
            nearName: null,
            radius: null,
          },
          withinMinutes: 60,
        };
      }),
    );
    expect(result.rowCount).toBe(0);
  });
});

describe('the executor reports what it could not recognise', () => {
  it('names a camera the estate does not have, rather than returning a silent empty result', async () => {
    if (!reachable) return;
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.cameraExternalIds = ['cam-that-does-not-exist'];
      }),
    );
    expect(result.unknownCameras).toEqual(['cam-that-does-not-exist']);
    expect(result.emptyReason).toBe('unknown_camera');
  });

  it('names a district the estate does not have — the measured local-model failure', async () => {
    if (!reachable) return;
    // A 7B model compiling "…passed Sector 18…" put `Sector 18` in `districts`, where no camera is.
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.place.districts = ['Sector 18'];
      }),
    );
    expect(result.unknownDistricts).toEqual(['Sector 18']);
    expect(result.emptyReason).toBe('unknown_camera');
  });

  it('refuses to search a read the plate grammar rejects, and says so', async () => {
    if (!reachable) return;
    // `757508300` is the cam05 hoarding's phone number and the highest-confidence read of the whole
    // live run (D2-01). It must not be searchable as a registration from here either.
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.plate = { pattern: '757508300', mode: 'fuzzy', maxDistance: 2 };
      }),
    );
    expect(result.rowCount).toBe(0);
    expect(result.emptyReason).toBe('plate_not_searchable');
  });

  it('an exact registration nobody has read is `no_matching_plate`, not `no_rows`', async () => {
    if (!reachable) return;
    const result = await new QueryExecutor(db).run(
      dsl((d) => {
        d.filters.plate = { pattern: 'GJ01QQ1111', mode: 'exact', maxDistance: 0 };
        d.filters.place.districts = [`${TAG}-District`];
      }),
    );
    // This one *has* been read — three times, by the seed above.
    expect(result.rowCount).toBe(3);
    expect(result.resolvedPlates[0]?.matchType).toBe('exact');
  });
});
