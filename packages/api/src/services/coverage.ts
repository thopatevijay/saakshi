/**
 * Coverage and gap analysis — turning the registry from a list into a planning instrument.
 *
 * The claim this module exists to make is narrow and, said plainly, uncomfortable: **a gap is not
 * "no camera here", it is "no *trusted* camera here"**. Coverage counted against dead and blind
 * cameras is the false assurance `PROJECT.md §1 P2` names, and the whole point of computing it
 * twice — once over every camera, once over trusted cameras only — is that the delta between those
 * two numbers is the size of the lie a conventional coverage map tells.
 *
 * ## Three things a reader should know before trusting a number out of here
 *
 * **1 · Every coverage cell is a disc, not a wedge.** `cameras` has no bearing or azimuth column,
 * so there is nothing to point a wedge along — for 100% of the estate, not as a fallback for a few.
 * A disc over-counts a camera looking down one carriageway and under-counts a wide junction view.
 * `fovAssumption()` records that per camera so the report can say it rather than imply otherwise.
 *
 * **2 · Reconciliation is computed, not asserted.** It would be trivial to define
 * `uncovered := total - covered` and report a perfect reconciliation that proves nothing. Instead
 * `ST_Intersection` and `ST_Difference` are evaluated independently in EPSG:32643 (UTM 43N, metres,
 * the right projection for Gujarat) and their sum is checked against the ways' own length. A
 * mismatch beyond `RECONCILE_TOLERANCE_M` is a real defect and is reported as one.
 *
 * **3 · The denominator is a choice, and it is stated.** D3-01's handoff: *"State which classes
 * your denominator uses in the generated report, or the percentage is uninterpretable."*
 * `road_network` already excludes `service`, `track`, `path`, `footway` and `cycleway`; this module
 * additionally names a **major-class** subset for the junction analysis, because a junction of two
 * residential lanes is not what a coverage plan is about.
 *
 * ## The disjoint-set problem, which this module must not resolve silently
 *
 * The measured cameras and the geolocated cameras are two different sets (D1-08 → D3-01 → D3-05).
 * A spatial query with `where location is not null` analyses one of them and reports a clean number
 * about an estate that is partly invisible to it. So `computeCoverage()` writes a `camera_coverage`
 * row for **every** live camera including the unplaceable ones — `fov_polygon` null, an empty
 * `covered_road_ids`, and a recorded reason — and every result here carries `assessed` beside
 * `unassessable` so no caller can print one without the other.
 */
import { sql } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { bandSql, focusDisqualifiedSql, type ResolvedBand } from './trust-band-sql.js';

// ── The FOV model ───────────────────────────────────────────────────────────────────────────────

/**
 * Observation radius in metres, by `cameras.geometry_class`.
 *
 * These are **assumptions, not measurements**, and the report tags them as such. The reasoning:
 *
 * - `anpr_viable` — a plate needs roughly 60-80 px of width to be read. At the estate's commonest
 *   resolutions (D1-05 measured six distinct ones, twelve of thirty at 854x480) that puts the
 *   plate-readable zone in the tens of metres, not the hundreds. 60 m is the deliberately
 *   conservative end of that.
 * - `detection_only` — a vehicle is *visible* much further out than its plate is *readable*, so the
 *   disc is larger. This is coverage in the weaker sense and the report separates the two.
 * - `unclassified` — nobody has assessed the geometry, so it takes the conservative figure. Absence
 *   of a classification is not evidence of a good one.
 *
 * Override with `COVERAGE_RANGE_ANPR_M` / `COVERAGE_RANGE_DETECTION_M` if a survey ever supplies
 * real figures; the report prints whichever values were used.
 */
export const DEFAULT_RANGES = {
  anpr_viable: 60,
  detection_only: 120,
  unclassified: 60,
} as const;

export type GeometryClass = keyof typeof DEFAULT_RANGES;

/** Every reconciliation is checked to this. One metre over ~59 km of candidate road. */
export const RECONCILE_TOLERANCE_M = 1;

/**
 * The classes the junction analysis runs over. Deliberately narrower than the coverage denominator:
 * a junction is only a planning object if it carries through traffic.
 */
export const JUNCTION_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
] as const;

/** A junction is a point where at least this many distinct major-class ways terminate. */
export const JUNCTION_MIN_DEGREE = 3;

export interface CoverageRanges {
  anpr_viable: number;
  detection_only: number;
  unclassified: number;
}

export function rangesFromEnv(env: NodeJS.ProcessEnv = process.env): CoverageRanges {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    anpr_viable: read('COVERAGE_RANGE_ANPR_M', DEFAULT_RANGES.anpr_viable),
    detection_only: read('COVERAGE_RANGE_DETECTION_M', DEFAULT_RANGES.detection_only),
    unclassified: read('COVERAGE_RANGE_UNCLASSIFIED_M', DEFAULT_RANGES.unclassified),
  };
}

/** What model was applied to one camera, and why. This is AC 1's "documented assumption". */
export interface FovAssumption {
  /** `disc` when the camera is placed; `none` when it cannot be placed at all. */
  model: 'disc' | 'none';
  /** Radius in metres. `null` when no cell could be drawn. */
  rangeM: number | null;
  /** Bearing in degrees, or `null`. Always `null` today — see `reason`. */
  bearingDeg: null;
  /** One sentence a reviewer can audit. */
  reason: string;
}

export interface CoverageCamera {
  id: string;
  externalId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  district: string | null;
  departmentId: string | null;
  geometryClass: string;
  band: ResolvedBand;
  focusDisqualified: boolean;
}

/**
 * The per-camera FOV assumption. Pure, so the report and the writer cannot disagree about what was
 * assumed, and so it is testable without a database.
 */
export function fovAssumption(camera: CoverageCamera, ranges: CoverageRanges): FovAssumption {
  if (camera.lat === null || camera.lon === null) {
    return {
      model: 'none',
      rangeM: null,
      bearingDeg: null,
      reason:
        'No coordinates. The upstream catalogue publishes {id, name} only, so this camera cannot be placed and contributes nothing to any coverage figure — it is unassessable, not uncovered.',
    };
  }
  const cls = isGeometryClass(camera.geometryClass) ? camera.geometryClass : 'unclassified';
  const rangeM = ranges[cls];
  const why: Record<GeometryClass, string> = {
    anpr_viable: `classified ANPR-viable, so the disc is the plate-readable zone (${String(rangeM)} m)`,
    detection_only: `classified detection-only, so the disc is the vehicle-visible zone (${String(rangeM)} m) — a vehicle here is seen but its plate is not read`,
    unclassified: `geometry never classified, so the conservative plate-readable radius (${String(rangeM)} m) is assumed rather than the larger detection radius`,
  };
  return {
    model: 'disc',
    rangeM,
    bearingDeg: null,
    reason: `Radius disc: ${why[cls]}. No bearing is available — \`cameras\` has no bearing column, so a directional wedge is not expressible for any camera in the estate.`,
  };
}

function isGeometryClass(value: string): value is GeometryClass {
  return value === 'anpr_viable' || value === 'detection_only' || value === 'unclassified';
}

// ── Reading the estate ──────────────────────────────────────────────────────────────────────────

/**
 * Every live camera with its band resolved server-side. `band` comes from `trust-band-sql.ts`, the
 * single source — never from arithmetic on `trust_score` here.
 */
export async function loadCameras(db: DbLike): Promise<CoverageCamera[]> {
  const rows = await db.execute<{
    id: string;
    external_id: string;
    name: string;
    lat: string | null;
    lon: string | null;
    district: string | null;
    department_id: string | null;
    geometry_class: string;
    band: ResolvedBand;
    focus_disqualified: boolean;
  }>(sql`
    -- No table alias: \`bandSql\` and \`focusDisqualifiedSql\` are drizzle expressions that render
    -- fully-qualified \`"cameras"."..."\` references, so an alias here makes them unresolvable.
    select cameras.id,
           cameras.external_id,
           cameras.name,
           case when cameras.location is null then null
                else st_y(cameras.location::geometry)::text end as lat,
           case when cameras.location is null then null
                else st_x(cameras.location::geometry)::text end as lon,
           cameras.district,
           cameras.department_id,
           cameras.geometry_class::text as geometry_class,
           ${bandSql} as band,
           ${focusDisqualifiedSql} as focus_disqualified
      from cameras
     where cameras.deleted_at is null
     order by cameras.external_id
  `);
  return [...rows].map((row) => ({
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    lat: row.lat === null ? null : Number(row.lat),
    lon: row.lon === null ? null : Number(row.lon),
    district: row.district,
    departmentId: row.department_id,
    geometryClass: row.geometry_class,
    band: row.band,
    focusDisqualified: row.focus_disqualified,
  }));
}

/**
 * True when a camera should count towards **trusted** coverage.
 *
 * Two conditions, and the second is D1-06's, which the additive score cannot express: *"a camera
 * that cannot produce a readable image produces nothing for ANPR, whatever else is true of it."*
 * `cam22` (blur 0.011) bands `degraded` and would be excluded anyway; the veto matters for a camera
 * that is blind and otherwise scores well.
 */
export function countsAsTrusted(camera: CoverageCamera): boolean {
  return camera.band === 'trusted' && !camera.focusDisqualified;
}

// ── Populating `camera_coverage` ────────────────────────────────────────────────────────────────

export interface CoverageWriteResult {
  /** Rows written. Equals the live camera count — the gate asserts this. */
  rows: number;
  /** Cameras that got a real polygon. */
  withPolygon: number;
  /** Cameras with a row but no polygon, because they cannot be placed. */
  unplaceable: number;
  /** Total distinct road ways touched by at least one cell. */
  coveredWays: number;
}

/**
 * Recomputes `camera_coverage` for the whole live estate.
 *
 * Writes a row for **every** camera. An unplaceable camera gets `fov_polygon = NULL` and an empty
 * `covered_road_ids` rather than no row at all, so that a later `count(*)` cannot be mistaken for
 * "the estate is 50 cameras" — the thirty that nobody can place stay visible in the table they are
 * absent from geometrically.
 */
export async function computeCoverage(
  db: DbLike,
  ranges: CoverageRanges = rangesFromEnv(),
): Promise<CoverageWriteResult> {
  await db.execute(sql`delete from camera_coverage`);

  await db.execute(sql`
    insert into camera_coverage (camera_id, fov_polygon, covered_road_ids, computed_at)
    select c.id,
           case when c.location is null then null
                else st_buffer(c.location, ${radiusCase(ranges)})::geography end,
           coalesce((
             select array_agg(distinct r.id)
               from road_network r
              where c.location is not null
                and st_dwithin(r.geom, c.location, ${radiusCase(ranges)})
           ), '{}'::bigint[]),
           now()
      from cameras c
     where c.deleted_at is null
  `);

  const [summary] = [
    ...(await db.execute<{ rows: string; with_polygon: string; unplaceable: string }>(sql`
      select count(*)::text as rows,
             count(fov_polygon)::text as with_polygon,
             count(*) filter (where fov_polygon is null)::text as unplaceable
        from camera_coverage
    `)),
  ];
  const [ways] = [
    ...(await db.execute<{ n: string }>(sql`
      select count(distinct w)::text as n
        from camera_coverage, unnest(covered_road_ids) as w
    `)),
  ];

  return {
    rows: Number(summary?.rows ?? 0),
    withPolygon: Number(summary?.with_polygon ?? 0),
    unplaceable: Number(summary?.unplaceable ?? 0),
    coveredWays: Number(ways?.n ?? 0),
  };
}

/** `geometry_class` → radius, as a SQL `case`, so the disc radius is per camera, not estate-wide. */
function radiusCase(ranges: CoverageRanges) {
  return sql`case c.geometry_class
    when 'anpr_viable' then ${ranges.anpr_viable}::double precision
    when 'detection_only' then ${ranges.detection_only}::double precision
    else ${ranges.unclassified}::double precision end`;
}

// ── The road-kilometre arithmetic ───────────────────────────────────────────────────────────────

export interface NetworkTotals {
  ways: number;
  km: number;
  byClass: { highwayClass: string; ways: number; km: number }[];
}

/** The denominator, and the class breakdown that makes the percentage interpretable. */
export async function networkTotals(db: DbLike): Promise<NetworkTotals> {
  const rows = [
    ...(await db.execute<{ highway_class: string | null; ways: string; m: string }>(sql`
      select highway_class, count(*)::text as ways, sum(st_length(geom))::text as m
        from road_network
       group by highway_class
       order by sum(st_length(geom)) desc
    `)),
  ];
  const byClass = rows.map((r) => ({
    highwayClass: r.highway_class ?? 'unclassified',
    ways: Number(r.ways),
    km: Number(r.m) / 1000,
  }));
  return {
    ways: byClass.reduce((a, b) => a + b.ways, 0),
    km: byClass.reduce((a, b) => a + b.km, 0),
    byClass,
  };
}

export interface CoverageSlice {
  /** What this slice counted. */
  label: string;
  /** Cameras contributing a cell. */
  cameras: number;
  coveredKm: number;
  /** Road length inside the candidate set that is *not* covered. Not the whole network. */
  candidateUncoveredKm: number;
  /** Length of every way that came near a cell — the reconciliation's subject. */
  candidateKm: number;
  candidateWays: number;
  /** `covered + uncovered - candidate`, in metres. Must be under `RECONCILE_TOLERANCE_M`. */
  reconcileErrorM: number;
  byDistrict: { district: string; coveredKm: number }[];
}

/**
 * Covered and uncovered kilometres for one set of cameras.
 *
 * The candidate set is every way within reach of a cell (GiST, so this is an index seek per camera,
 * not a scan of 540k rows). Ways outside it are 100% uncovered by construction — no floating point
 * involved — which is why the reconciliation is checked on the candidate set, where the geometry
 * library actually does arithmetic and could be wrong.
 */
export async function coverageFor(
  db: DbLike,
  cameraIds: readonly string[],
  label: string,
  ranges: CoverageRanges = rangesFromEnv(),
): Promise<CoverageSlice> {
  const empty: CoverageSlice = {
    label,
    cameras: 0,
    coveredKm: 0,
    candidateUncoveredKm: 0,
    candidateKm: 0,
    candidateWays: 0,
    reconcileErrorM: 0,
    byDistrict: [],
  };
  if (cameraIds.length === 0) return empty;

  const ids = sql.join(
    cameraIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const [totals] = [
    ...(await db.execute<{
      ways: string;
      candidate_m: string | null;
      covered_m: string | null;
      uncovered_m: string | null;
    }>(sql`
      with cam as (
        select c.id, c.location, ${radiusCase(ranges)} as radius
          from cameras c
         where c.deleted_at is null and c.location is not null and c.id in (${ids})
      ),
      cell as (
        select st_transform(st_buffer(location, radius)::geometry, 32643) as poly from cam
      ),
      merged as (select st_union(poly) as poly from cell),
      cand as (
        select r.id, st_transform(r.geom::geometry, 32643) as g
          from road_network r
         where exists (
           select 1 from cam where st_dwithin(r.geom, cam.location, cam.radius)
         )
      )
      select count(*)::text as ways,
             sum(st_length(cand.g))::text as candidate_m,
             sum(st_length(st_intersection(cand.g, merged.poly)))::text as covered_m,
             sum(st_length(st_difference(cand.g, merged.poly)))::text as uncovered_m
        from cand, merged
    `)),
  ];

  const candidateM = Number(totals?.candidate_m ?? 0);
  const coveredM = Number(totals?.covered_m ?? 0);
  const uncoveredM = Number(totals?.uncovered_m ?? 0);

  const byDistrict = [
    ...(await db.execute<{ district: string | null; m: string | null }>(sql`
      with cam as (
        select c.id, c.district, c.location, ${radiusCase(ranges)} as radius
          from cameras c
         where c.deleted_at is null and c.location is not null and c.id in (${ids})
      ),
      cell as (
        select coalesce(district, '(no district recorded)') as district,
               st_transform(st_buffer(location, radius)::geometry, 32643) as poly
          from cam
      ),
      merged as (select district, st_union(poly) as poly from cell group by district)
      select merged.district,
             sum(st_length(st_intersection(st_transform(r.geom::geometry, 32643), merged.poly)))::text as m
        from merged
        join road_network r
          on st_intersects(st_transform(r.geom::geometry, 32643), merged.poly)
       group by merged.district
       order by 2 desc
    `)),
  ].map((r) => ({ district: r.district ?? '(no district recorded)', coveredKm: Number(r.m ?? 0) / 1000 }));

  return {
    label,
    cameras: cameraIds.length,
    coveredKm: coveredM / 1000,
    candidateUncoveredKm: uncoveredM / 1000,
    candidateKm: candidateM / 1000,
    candidateWays: Number(totals?.ways ?? 0),
    reconcileErrorM: Math.abs(coveredM + uncoveredM - candidateM),
    byDistrict,
  };
}

// ── Junctions ───────────────────────────────────────────────────────────────────────────────────

export interface Junction {
  lon: number;
  lat: number;
  /** How many distinct major-class ways terminate here. */
  degree: number;
  /** Nearest named way at the junction, when one is named. */
  name: string | null;
  /** Metres to the nearest camera of the analysed set. `null` when there is none within reach. */
  nearestTrustedM: number | null;
}

export interface JunctionAnalysis {
  /** Junctions found across the whole network, by the stated definition. */
  total: number;
  /** Of those, how many fall inside a trusted camera's cell. */
  covered: number;
  /** `total - covered`. Every one of these is a gap. */
  uncovered: number;
  /** The worst of the uncovered ones, ranked by degree then by proximity to the existing estate. */
  worst: Junction[];
}

/**
 * Junctions with zero trusted coverage.
 *
 * The definition, which the report repeats: a point where at least `JUNCTION_MIN_DEGREE` distinct
 * ways of class `JUNCTION_CLASSES` terminate. That is a topological definition over the OSM way
 * geometry, not an OSM `highway=*_junction` tag — the import keeps ways only, so nodes are derived.
 * It will miss junctions expressed as a way passing *through* another without a shared endpoint,
 * and the report says so.
 *
 * `limit` bounds the listed table only; `total` and `uncovered` are counted over everything.
 */
export async function junctionsWithoutCoverage(
  db: DbLike,
  trustedCameraIds: readonly string[],
  ranges: CoverageRanges = rangesFromEnv(),
  limit = 25,
): Promise<JunctionAnalysis> {
  const classes = sql.join(
    JUNCTION_CLASSES.map((c) => sql`${c}`),
    sql`, `,
  );

  const junctionCte = sql`
    with major as (
      select id, geom::geometry as g, name from road_network where highway_class in (${classes})
    ),
    ends as (
      select st_startpoint(g) as p, id, name from major
      union all
      select st_endpoint(g) as p, id, name from major
    ),
    junction as (
      select p,
             count(distinct id) as degree,
             min(name) filter (where name is not null) as name
        from ends
       group by p
      having count(distinct id) >= ${JUNCTION_MIN_DEGREE}
    )`;

  // No trusted cameras at all: every junction is uncovered, and saying so needs one count, not a
  // spatial join against an empty set.
  if (trustedCameraIds.length === 0) {
    const [counts] = [
      ...(await db.execute<{ total: string }>(sql`${junctionCte} select count(*)::text as total from junction`)),
    ];
    const worst = [
      ...(await db.execute<{ lon: string; lat: string; degree: string; name: string | null }>(sql`
        ${junctionCte}
        select st_x(p)::text as lon, st_y(p)::text as lat, degree::text as degree, name
          from junction
         order by degree desc, st_x(p), st_y(p)
         limit ${limit}
      `)),
    ].map((r) => ({
      lon: Number(r.lon),
      lat: Number(r.lat),
      degree: Number(r.degree),
      name: r.name,
      nearestTrustedM: null,
    }));
    const total = Number(counts?.total ?? 0);
    return { total, covered: 0, uncovered: total, worst };
  }

  const ids = sql.join(
    trustedCameraIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const cam = sql`
    cam as (
      select c.location, ${radiusCase(ranges)} as radius
        from cameras c
       where c.deleted_at is null and c.location is not null and c.id in (${ids})
    )`;

  const [counts] = [
    ...(await db.execute<{ total: string; covered: string }>(sql`
      ${junctionCte}, ${cam}
      select count(*)::text as total,
             count(*) filter (where exists (
               select 1 from cam
                where st_dwithin(st_setsrid(junction.p, 4326)::geography, cam.location, cam.radius)
             ))::text as covered
        from junction
    `)),
  ];

  const worst = [
    ...(await db.execute<{
      lon: string;
      lat: string;
      degree: string;
      name: string | null;
      nearest_m: string | null;
    }>(sql`
      ${junctionCte}, ${cam}
      select st_x(p)::text as lon,
             st_y(p)::text as lat,
             degree::text as degree,
             name,
             (select min(st_distance(st_setsrid(junction.p, 4326)::geography, cam.location))::text
                from cam) as nearest_m
        from junction
       where not exists (
         select 1 from cam
          where st_dwithin(st_setsrid(junction.p, 4326)::geography, cam.location, cam.radius)
       )
       order by degree desc, st_x(p), st_y(p)
       limit ${limit}
    `)),
  ].map((r) => ({
    lon: Number(r.lon),
    lat: Number(r.lat),
    degree: Number(r.degree),
    name: r.name,
    nearestTrustedM: r.nearest_m === null ? null : Number(r.nearest_m),
  }));

  const total = Number(counts?.total ?? 0);
  const covered = Number(counts?.covered ?? 0);
  return { total, covered, uncovered: total - covered, worst };
}

// ── The whole analysis ──────────────────────────────────────────────────────────────────────────

export interface EstateSplit {
  total: number;
  /** Cameras that can be placed, and therefore assessed spatially. */
  assessed: number;
  /** Cameras with no coordinates. Unassessable — which is not the same as uncovered. */
  unassessable: number;
  /** Cameras that have never been probed. `band: null`. */
  neverProbed: number;
  /** Cameras counting towards the trusted slice. */
  trusted: number;
  /** Reachable and probed, but vetoed by D1-06's focus rule. */
  focusDisqualified: number;
  byBand: { band: string; total: number; placed: number }[];
}

export interface GapAnalysis {
  generatedAt: string;
  databaseName: string;
  ranges: CoverageRanges;
  network: NetworkTotals;
  split: EstateSplit;
  write: CoverageWriteResult;
  all: CoverageSlice;
  trustedOnly: CoverageSlice;
  anprViable: CoverageSlice;
  /** `all.coveredKm - trustedOnly.coveredKm` — the headline. */
  deltaKm: number;
  /** The delta as a share of all-camera coverage. `null` when there is no coverage at all. */
  deltaShare: number | null;
  junctions: JunctionAnalysis;
  assumptions: {
    externalId: string;
    name: string;
    district: string | null;
    lat: number | null;
    lon: number | null;
    trusted: boolean;
    assumption: FovAssumption;
  }[];
  /** Districts ordered by uncovered major-road km, i.e. where the next camera should go. */
  districtDeficit: { district: string; coveredKm: number }[];
}

export async function analyse(
  db: DbLike,
  ranges: CoverageRanges = rangesFromEnv(),
): Promise<GapAnalysis> {
  const cameras = await loadCameras(db);
  const write = await computeCoverage(db, ranges);

  const placed = cameras.filter((c) => c.lat !== null && c.lon !== null);
  const trusted = placed.filter(countsAsTrusted);
  const anpr = placed.filter((c) => c.geometryClass === 'anpr_viable');

  const bands = new Map<string, { total: number; placed: number }>();
  for (const camera of cameras) {
    const key = camera.band ?? 'never probed';
    const entry = bands.get(key) ?? { total: 0, placed: 0 };
    entry.total += 1;
    if (camera.lat !== null) entry.placed += 1;
    bands.set(key, entry);
  }

  const split: EstateSplit = {
    total: cameras.length,
    assessed: placed.length,
    unassessable: cameras.length - placed.length,
    neverProbed: cameras.filter((c) => c.band === null).length,
    trusted: trusted.length,
    focusDisqualified: cameras.filter((c) => c.focusDisqualified).length,
    byBand: [...bands.entries()]
      .map(([band, v]) => ({ band, ...v }))
      .sort((a, b) => b.total - a.total),
  };

  const [all, trustedOnly, anprViable] = await Promise.all([
    coverageFor(db, placed.map((c) => c.id), 'All cameras', ranges),
    coverageFor(db, trusted.map((c) => c.id), 'Trusted cameras only', ranges),
    coverageFor(db, anpr.map((c) => c.id), 'ANPR-viable cameras only', ranges),
  ]);

  const junctions = await junctionsWithoutCoverage(db, trusted.map((c) => c.id), ranges);
  const network = await networkTotals(db);

  const [dbName] = [
    ...(await db.execute<{ name: string }>(sql`select current_database() as name`)),
  ];

  const deltaKm = all.coveredKm - trustedOnly.coveredKm;

  return {
    generatedAt: new Date().toISOString(),
    databaseName: dbName?.name ?? 'unknown',
    ranges,
    network,
    split,
    write,
    all,
    trustedOnly,
    anprViable,
    deltaKm,
    deltaShare: all.coveredKm > 0 ? deltaKm / all.coveredKm : null,
    junctions,
    assumptions: cameras.map((c) => ({
      externalId: c.externalId,
      name: c.name,
      district: c.district,
      lat: c.lat,
      lon: c.lon,
      trusted: countsAsTrusted(c),
      assumption: fovAssumption(c, ranges),
    })),
    districtDeficit: all.byDistrict,
  };
}

// ── The map overlay ─────────────────────────────────────────────────────────────────────────────

/** The three states the overlay renders. `unscored` is not `untrusted` — D1-08's rule. */
export type CoverageState = 'trusted' | 'untrusted' | 'uncovered';

/**
 * `ST_AsGeoJSON` output. Narrowed enough for the route's response schema to accept it, with the
 * index signature matching that schema's `.passthrough()` — PostGIS may add `crs` or a bbox and
 * neither the route nor MapLibre should care.
 */
export interface CoverageGeometry {
  type: string;
  coordinates: unknown;
  [key: string]: unknown;
}

export interface CoverageOverlay {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    id: string;
    geometry: CoverageGeometry;
    properties: { id: string; externalId: string; state: CoverageState; band: string; rangeM: number };
  }[];
}

/**
 * Coverage cells as GeoJSON, one per placed camera, tagged with the state the map colours by.
 *
 * Only the cells; the third state — uncovered road — is drawn as the *absence* of a cell over the
 * basemap's own road layers rather than by shipping 540,584 lines to a browser. The report says so,
 * because "uncovered is rendered as absence" is a claim about the map that a reader is entitled to
 * check.
 */
export async function coverageOverlay(
  db: DbLike,
  ranges: CoverageRanges = rangesFromEnv(),
): Promise<CoverageOverlay> {
  const cameras = await loadCameras(db);
  const trusted = new Set(cameras.filter(countsAsTrusted).map((c) => c.id));

  const rows = [
    ...(await db.execute<{ camera_id: string; external_id: string; geom: string }>(sql`
      select cc.camera_id, c.external_id, st_asgeojson(cc.fov_polygon) as geom
        from camera_coverage cc
        join cameras c on c.id = cc.camera_id
       where cc.fov_polygon is not null and c.deleted_at is null
       order by c.external_id
    `)),
  ];

  const byId = new Map(cameras.map((c) => [c.id, c]));
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => {
      const camera = byId.get(row.camera_id);
      return {
        type: 'Feature' as const,
        id: row.camera_id,
        geometry: JSON.parse(row.geom) as CoverageGeometry,
        properties: {
          id: row.camera_id,
          externalId: row.external_id,
          state: (trusted.has(row.camera_id) ? 'trusted' : 'untrusted') as CoverageState,
          band: camera?.band ?? 'unscored',
          rangeM: camera === undefined ? ranges.unclassified : (fovAssumption(camera, ranges).rangeM ?? 0),
        },
      };
    }),
  };
}
