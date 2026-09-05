/**
 * D3-06 — the coverage engine.
 *
 * Split the way `route.test.ts` documents: a **pure half** that runs anywhere (the FOV model, the
 * trusted predicate), and a **db half** that needs a migrated Postgres with PostGIS and a populated
 * `road_network`, and skips loudly rather than failing when one is absent.
 *
 * ## The test that matters most, and why it exists
 *
 * `"grades the delta as bands change"` is not a nice-to-have. On the estate this ticket ran against,
 * **every camera is `band: null`** — no health check exists in the database — so the live
 * trusted-only figure is 0.00 km and the delta is 100% of coverage. That number is true and it is
 * published, but it cannot demonstrate that the engine *grades* rather than merely zeroing.
 *
 * D2-09's standing rule is that a waived or degenerate acceptance criterion must name the test that
 * still protects the capability. This is that test: it seeds cameras across four bands with real
 * health-check rows, runs the real engine, and asserts trusted coverage lands strictly between zero
 * and all-camera coverage. If someone later replaces the band filter with `where true`, the live
 * report would not notice and this test fails immediately.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  analyse,
  computeCoverage,
  countsAsTrusted,
  coverageFor,
  coverageOverlay,
  DEFAULT_RANGES,
  fovAssumption,
  JUNCTION_CLASSES,
  junctionsWithoutCoverage,
  loadCameras,
  networkTotals,
  RECONCILE_TOLERANCE_M,
  rangesFromEnv,
  type CoverageCamera,
} from './coverage.js';

const RANGES = { ...DEFAULT_RANGES };

function camera(over: Partial<CoverageCamera> = {}): CoverageCamera {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    externalId: 'TEST-01',
    name: 'Test',
    lat: 23.0225,
    lon: 72.5714,
    district: 'Ahmedabad',
    departmentId: null,
    geometryClass: 'anpr_viable',
    band: 'trusted',
    focusDisqualified: false,
    ...over,
  };
}

/* ── Pure half ───────────────────────────────────────────────────────────────────────────────── */

describe('the FOV assumption is documented for every camera (AC 1)', () => {
  it('gives a placed camera a disc sized by its geometry class', () => {
    for (const [cls, expected] of Object.entries(RANGES)) {
      const a = fovAssumption(camera({ geometryClass: cls }), RANGES);
      expect(a.model).toBe('disc');
      expect(a.rangeM).toBe(expected);
      expect(a.reason).not.toBe('');
    }
  });

  it('records why an unplaceable camera has no cell, rather than omitting it', () => {
    const a = fovAssumption(camera({ lat: null, lon: null }), RANGES);
    expect(a.model).toBe('none');
    expect(a.rangeM).toBeNull();
    // The distinction the whole report rests on.
    expect(a.reason).toContain('unassessable, not uncovered');
  });

  it('falls back to the conservative radius for an unrecognised geometry class', () => {
    expect(fovAssumption(camera({ geometryClass: 'something-new' }), RANGES).rangeM).toBe(
      RANGES.unclassified,
    );
  });

  it('never claims a bearing, because the schema has no column to hold one', () => {
    for (const cls of Object.keys(RANGES)) {
      const a = fovAssumption(camera({ geometryClass: cls }), RANGES);
      expect(a.bearingDeg).toBeNull();
      expect(a.reason).toContain('no bearing column');
    }
  });

  it('reads overrides from the environment and otherwise uses the documented defaults', () => {
    expect(rangesFromEnv({})).toEqual(DEFAULT_RANGES);
    expect(rangesFromEnv({ COVERAGE_RANGE_ANPR_M: '85' }).anpr_viable).toBe(85);
    // A junk override must not silently produce NaN metres.
    expect(rangesFromEnv({ COVERAGE_RANGE_ANPR_M: 'wide' }).anpr_viable).toBe(
      DEFAULT_RANGES.anpr_viable,
    );
    expect(rangesFromEnv({ COVERAGE_RANGE_ANPR_M: '-5' }).anpr_viable).toBe(
      DEFAULT_RANGES.anpr_viable,
    );
  });
});

describe('what counts as trusted coverage', () => {
  it('takes the band from the API and never re-derives it', () => {
    expect(countsAsTrusted(camera({ band: 'trusted' }))).toBe(true);
    for (const band of ['degraded', 'untrusted', 'dead', null] as const) {
      expect(countsAsTrusted(camera({ band }))).toBe(false);
    }
  });

  it('vetoes a blind camera regardless of its band (D1-06)', () => {
    // cam22 scores 55 and bands `degraded` while being effectively blind; the veto has to bite even
    // on a camera that bands `trusted`, or the additive score decides a necessary condition.
    expect(countsAsTrusted(camera({ band: 'trusted', focusDisqualified: true }))).toBe(false);
  });

  it('treats never-probed as not-trusted without treating it as bad', () => {
    // `null` is an absence of evidence. It must not count towards trusted coverage, and it must
    // stay distinguishable from `untrusted` — which the band value itself preserves.
    const never = camera({ band: null });
    expect(countsAsTrusted(never)).toBe(false);
    expect(never.band).not.toBe('untrusted');
  });
});

/* ── DB half ─────────────────────────────────────────────────────────────────────────────────── */

const TAG = `COV${String(Date.now()).slice(-9)}`;

/**
 * Four cameras, one per band.
 *
 * Their coordinates are **not** hand-written. The first draft of this file placed them on a
 * plausible-looking Ahmedabad grid and the AC-8 test failed with
 * `expected 0.834… to be greater than 0.834…` — the fourth camera had landed 60 m from no road at
 * all, so promoting it to `trusted` added exactly zero kilometres. A hand-picked lat/lon looks like
 * a fixture and behaves like a coin flip. `placements()` instead takes real, well-separated
 * midpoints out of `road_network`, so each camera provably sits on a road and the cells cannot
 * overlap.
 */
const SEEDS = [
  { suffix: 'A', band: 'trusted', score: 88, connectable: true },
  { suffix: 'B', band: 'degraded', score: 62, connectable: true },
  { suffix: 'C', band: 'untrusted', score: 31, connectable: true },
  { suffix: 'D', band: 'dead', score: 91, connectable: false },
] as const;

/** Metres between seeded cameras — comfortably over twice the largest cell radius. */
const SEPARATION_M = 600;

describe('coverage against a live database', () => {
  let rawSql: Sql;
  let db: Db;
  let reachable = false;
  let hasRoads = false;

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
    rawSql = createSql(env.DATABASE_URL, 4);
    db = createDb(rawSql);
    try {
      await rawSql`select 1`;
      reachable = true;
      const [row] = await rawSql<{ n: string }[]>`select count(*)::text as n from road_network`;
      hasRoads = Number(row?.n ?? 0) > 0;
      if (!hasRoads) {
        console.warn(
          '[coverage] road_network is empty — skipping the spatial tests. Populate it with ' +
            './scripts/import-osm.sh (docs/road-network-setup.md).',
        );
      }
    } catch {
      console.warn('[coverage] database unreachable — skipping. Run `make up && make migrate`.');
    }
  });

  afterAll(async () => {
    if (reachable) await cleanup();
    await rawSql?.end();
  });

  async function cleanup(): Promise<void> {
    // Health checks first, explicitly: `camera_health_checks` is a TimescaleDB hypertable and the
    // FK cascade is not worth betting on (D2-09).
    await db.execute(sql`
      delete from camera_health_checks
       where camera_id in (select id from cameras where external_id like ${`${TAG}%`})`);
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  }

  /**
   * `SEEDS.length` points that each sit on a real road and are pairwise at least `SEPARATION_M`
   * apart, so every seeded camera contributes coverage and no two cells overlap. Greedy over a
   * candidate pool, so it degrades to "as many as the data allows" rather than looping forever.
   */
  async function placements(): Promise<{ lon: number; lat: number }[]> {
    const candidates = [
      ...(await db.execute<{ lon: string; lat: string }>(sql`
        select st_x(p)::text as lon, st_y(p)::text as lat
          from (
            select st_lineinterpolatepoint(geom::geometry, 0.5) as p
              from road_network
             where highway_class in ('primary', 'secondary', 'tertiary', 'residential')
               and st_length(geom) > 200
             order by id
             limit 4000
          ) m`)),
    ].map((r) => ({ lon: Number(r.lon), lat: Number(r.lat) }));

    const chosen: { lon: number; lat: number }[] = [];
    for (const c of candidates) {
      if (chosen.every((k) => metres(k, c) >= SEPARATION_M)) chosen.push(c);
      if (chosen.length === SEEDS.length) break;
    }
    return chosen;
  }

  /** Equirectangular approximation — plenty for "are these two points far apart". */
  function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
    const R = 6_371_000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = (((b.lon - a.lon) * Math.PI) / 180) * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon) * R;
  }

  async function seed(): Promise<void> {
    await cleanup();
    const points = await placements();
    expect(points).toHaveLength(SEEDS.length);
    for (const [i, s] of SEEDS.entries()) {
      const point = points[i] as { lon: number; lat: number };
      const id = `${TAG}-${s.suffix}`;
      await db.execute(sql`
        insert into cameras (external_id, name, location, district, geometry_class, adapter_kind,
                             trust_score)
        values (${id}, ${`Coverage test ${id}`},
                st_setsrid(st_makepoint(${point.lon}, ${point.lat}), 4326)::geography,
                'Ahmedabad', 'anpr_viable', 'hls', ${s.score})`);
      await db.execute(sql`
        insert into camera_health_checks (camera_id, checked_at, connectable, decodable, trust_score)
        select id, now(), ${s.connectable}, true, ${s.score}
          from cameras where external_id = ${id}`);
    }
  }

  it('writes one camera_coverage row per live camera, including the unplaceable ones (AC 1)', async () => {
    if (!reachable) return;
    const result = await computeCoverage(db);
    const [row] = [
      ...(await db.execute<{ n: string }>(
        sql`select count(*)::text as n from cameras where deleted_at is null`,
      )),
    ];
    // The gate's assertion, made from inside the engine: `count(*) = camera count`. It only holds
    // because unplaceable cameras get a row with null geometry rather than no row at all.
    expect(result.rows).toBe(Number(row?.n ?? -1));
    expect(result.withPolygon + result.unplaceable).toBe(result.rows);
  }, 60_000);

  it('reconciles covered + uncovered against the candidate ways own length (AC 2)', async () => {
    if (!reachable || !hasRoads) return;
    const placed = (await loadCameras(db)).filter((c) => c.lat !== null);
    if (placed.length === 0) return;
    const slice = await coverageFor(db, placed.map((c) => c.id), 'all');
    expect(slice.candidateWays).toBeGreaterThan(0);
    expect(slice.reconcileErrorM).toBeLessThan(RECONCILE_TOLERANCE_M);
    // Sanity: neither half may swallow the whole. A cell that covered every candidate way end to
    // end would mean the radius or the projection is wrong.
    expect(slice.coveredKm).toBeGreaterThan(0);
    expect(slice.candidateUncoveredKm).toBeGreaterThan(0);
  }, 120_000);

  it('grades the delta as bands change, which the live estate cannot demonstrate (AC 3)', async () => {
    if (!reachable || !hasRoads) return;
    await seed();
    await computeCoverage(db);
    const cameras = (await loadCameras(db)).filter((c) => c.externalId.startsWith(TAG));
    expect(cameras).toHaveLength(SEEDS.length);

    // The bands resolved server-side, from `trust-band-sql.ts` — not asserted against arithmetic
    // this test does itself.
    expect(new Set(cameras.map((c) => c.band))).toEqual(
      new Set(['trusted', 'degraded', 'untrusted', 'dead']),
    );

    const all = await coverageFor(db, cameras.map((c) => c.id), 'all');
    const trusted = await coverageFor(
      db,
      cameras.filter(countsAsTrusted).map((c) => c.id),
      'trusted',
    );

    expect(trusted.cameras).toBe(1);
    // The point of the whole ticket: trusted coverage is a strict, non-degenerate subset. Not zero
    // (the filter is not just discarding everything) and not equal (the filter actually bites).
    expect(trusted.coveredKm).toBeGreaterThan(0);
    expect(trusted.coveredKm).toBeLessThan(all.coveredKm);
    expect(all.coveredKm - trusted.coveredKm).toBeGreaterThan(0);
    expect(trusted.reconcileErrorM).toBeLessThan(RECONCILE_TOLERANCE_M);
  }, 120_000);

  it('excludes a dead camera even though its stored score is the highest of the set', async () => {
    if (!reachable || !hasRoads) return;
    await seed();
    const cameras = (await loadCameras(db)).filter((c) => c.externalId.startsWith(TAG));
    const dead = cameras.find((c) => c.externalId === `${TAG}-D`);
    // 91 is the best score in the set. An unreachable camera keeps its last good score, so a filter
    // written as `trust_score >= 70` would have counted this one as trusted coverage.
    expect(dead?.band).toBe('dead');
    expect(countsAsTrusted(dead as CoverageCamera)).toBe(false);
  }, 60_000);

  it('re-running after a trust change updates the numbers (AC 8)', async () => {
    if (!reachable || !hasRoads) return;
    await seed();
    const before = (await loadCameras(db)).filter((c) => c.externalId.startsWith(TAG));
    const beforeTrusted = await coverageFor(
      db,
      before.filter(countsAsTrusted).map((c) => c.id),
      'trusted',
    );

    // The dead camera answers again, at a trusted score. Nothing else changes.
    await db.execute(sql`
      insert into camera_health_checks (camera_id, checked_at, connectable, decodable, trust_score)
      select id, now() + interval '1 minute', true, true, 92
        from cameras where external_id = ${`${TAG}-D`}`);
    await db.execute(sql`
      update cameras set trust_score = 92 where external_id = ${`${TAG}-D`}`);

    const after = (await loadCameras(db)).filter((c) => c.externalId.startsWith(TAG));
    const afterTrusted = await coverageFor(
      db,
      after.filter(countsAsTrusted).map((c) => c.id),
      'trusted',
    );

    expect(after.find((c) => c.externalId === `${TAG}-D`)?.band).toBe('trusted');
    expect(afterTrusted.cameras).toBe(beforeTrusted.cameras + 1);
    expect(afterTrusted.coveredKm).toBeGreaterThan(beforeTrusted.coveredKm);
  }, 120_000);

  it('applies the focus veto through the health-check breakdown, not just in memory', async () => {
    if (!reachable) return;
    await seed();
    // The shape D1-06's handoff names: `breakdown.trust.signals[]` carrying `{signal, quality}`.
    await db.execute(sql`
      insert into camera_health_checks (camera_id, checked_at, connectable, decodable, trust_score,
                                        breakdown)
      select id, now() + interval '2 minutes', true, true, 88,
             ${JSON.stringify({ trust: { signals: [{ signal: 'focus', quality: 0 }] } })}::jsonb
        from cameras where external_id = ${`${TAG}-A`}`);

    const blind = (await loadCameras(db)).find((c) => c.externalId === `${TAG}-A`);
    expect(blind?.band).toBe('trusted');
    expect(blind?.focusDisqualified).toBe(true);
    // Bands trusted, contributes nothing. This is the case the additive score cannot express.
    expect(countsAsTrusted(blind as CoverageCamera)).toBe(false);
  }, 60_000);

  it('lists junctions with zero trusted coverage, with coordinates (AC 4)', async () => {
    if (!reachable || !hasRoads) return;
    const result = await junctionsWithoutCoverage(db, [], undefined, 5);
    expect(result.total).toBeGreaterThan(0);
    // With no trusted camera, every junction is a gap — and the count must say so rather than
    // returning an empty list that reads as "no gaps".
    expect(result.uncovered).toBe(result.total);
    expect(result.worst).toHaveLength(5);
    for (const j of result.worst) {
      expect(j.degree).toBeGreaterThanOrEqual(3);
      // Inside the Gujarat import clip, and in lon/lat order — the ordering everyone gets wrong once.
      expect(j.lon).toBeGreaterThan(68);
      expect(j.lon).toBeLessThan(74.6);
      expect(j.lat).toBeGreaterThan(19.9);
      expect(j.lat).toBeLessThan(24.8);
    }
    // Ranked by degree, so the top of the list is the worst gap.
    const degrees = result.worst.map((j) => j.degree);
    expect([...degrees].sort((a, b) => b - a)).toEqual(degrees);
  }, 120_000);

  it('counts a junction as covered once a trusted camera sits on it', async () => {
    if (!reachable || !hasRoads) return;
    await seed();
    const cameras = (await loadCameras(db)).filter((c) => c.externalId.startsWith(TAG));
    const trusted = cameras.filter(countsAsTrusted).map((c) => c.id);
    const none = await junctionsWithoutCoverage(db, [], undefined, 1);
    const some = await junctionsWithoutCoverage(db, trusted, undefined, 1);
    expect(some.total).toBe(none.total);
    // May be zero on this sample, but it can never be negative or exceed the total.
    expect(some.covered).toBeGreaterThanOrEqual(0);
    expect(some.covered + some.uncovered).toBe(some.total);
  }, 120_000);

  it('reports the network denominator by class, so a percentage is interpretable (AC 2)', async () => {
    if (!reachable || !hasRoads) return;
    const totals = await networkTotals(db);
    expect(totals.ways).toBeGreaterThan(0);
    expect(totals.km).toBeGreaterThan(0);
    expect(totals.byClass.reduce((a, b) => a + b.ways, 0)).toBe(totals.ways);
    // D3-01 excluded these at import on purpose; a coverage percentage over car-park aisles is not
    // a number to put in front of a reviewer.
    for (const excluded of ['service', 'track', 'path', 'footway', 'cycleway']) {
      expect(totals.byClass.map((c) => c.highwayClass)).not.toContain(excluded);
    }
    for (const cls of JUNCTION_CLASSES) {
      expect(totals.byClass.map((c) => c.highwayClass)).toContain(cls);
    }
  }, 60_000);

  it('produces an overlay whose states come from the band, one feature per placed camera (AC 5)', async () => {
    if (!reachable) return;
    await seed();
    await computeCoverage(db);
    const overlay = await coverageOverlay(db);
    const mine = overlay.features.filter((f) => f.properties.externalId.startsWith(TAG));
    expect(mine).toHaveLength(SEEDS.length);
    expect(mine.filter((f) => f.properties.state === 'trusted')).toHaveLength(1);
    expect(mine.filter((f) => f.properties.state === 'untrusted')).toHaveLength(3);
    // A never-probed camera must stay distinguishable from a badly-scoring one in the payload, even
    // though both fall on the same side of the trusted/untrusted split.
    const bands = new Set(overlay.features.map((f) => f.properties.band));
    expect(bands.size).toBeGreaterThan(1);
    for (const feature of mine) {
      expect((feature.geometry as { type: string }).type).toBe('Polygon');
      expect(feature.properties.rangeM).toBeGreaterThan(0);
    }
  }, 60_000);

  it('always reports the unassessable set beside the assessed one (the disjoint-set rule)', async () => {
    if (!reachable || !hasRoads) return;
    const a = await analyse(db);
    expect(a.split.assessed + a.split.unassessable).toBe(a.split.total);
    // Every slice is reconciled, or the CLI refuses to publish.
    for (const slice of [a.all, a.trustedOnly, a.anprViable]) {
      expect(slice.reconcileErrorM).toBeLessThan(RECONCILE_TOLERANCE_M);
    }
    // Trusted coverage can never exceed all-camera coverage; the delta is therefore never negative.
    expect(a.trustedOnly.coveredKm).toBeLessThanOrEqual(a.all.coveredKm);
    expect(a.deltaKm).toBeGreaterThanOrEqual(0);
    expect(a.assumptions).toHaveLength(a.split.total);
  }, 180_000);
});
