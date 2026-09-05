/**
 * Placed camera fixtures, so the map's browser-render assertions survive a coordinate-free estate.
 *
 * ## Why this exists
 *
 * The Gujarat Sentinel catalogue publishes exactly two fields per camera — `id` and `name`. No
 * coordinates, no district. `D1-GATE` (#14) amended three ACs rather than invent a coordinate
 * nobody published, which was the right call: storing a location the estate never declared would be
 * fabricating evidence, and Pillar 1 exists to stop exactly that.
 *
 * The cost was that four checks in `verify-map.mjs` failed on every run — clustering, street-zoom
 * pins, the filter, and filter restoration from the URL. All four need a coordinate or a district.
 * They failed *loudly*, which sounds safe, but a check that always fails is a check nobody reads:
 * within a week "those four always fail" becomes the explanation, and a genuine regression in
 * clustering or pin rendering is indistinguishable from the data gap. **The GIS map is Model 1's
 * headline deliverable** — the worst place in the product to lose a signal.
 *
 * So the script brings its own placed estate, asserts the render against it, and takes it away
 * again. `bench-dashboard.mjs` already established the shape: seed, measure, clean up.
 *
 * ## The two rules these fixtures obey
 *
 * 1. **They are unmistakably fixtures.** Every `external_id` starts with `MAPFIX-`, which cannot
 *    collide with the sandbox catalogue (`cam01`…`cam30`), a bulk CSV import (`GJ-AHM-*`) or the
 *    benchmark's own rows (`BENCH-*`). Nothing here is ever mistaken for a real camera, and a
 *    stray row is greppable in one query.
 * 2. **They never touch a real camera.** Seeding inserts; cleanup deletes by prefix. No real row is
 *    read, updated or backfilled — the absence of coordinates on the real estate is a finding, and
 *    it stays. The count of cameras *without* coordinates is identical before and after.
 *
 * ## What the geometry has to satisfy
 *
 * D1-08's handoff fixes the source settings: `clusterMaxZoom: 11`, `clusterRadius: 46`. At z6 that
 * radius is about 1.0° of longitude, so the four city groups below (Ahmedabad, Surat, Rajkot, Bhuj)
 * are far enough apart to stay separate clusters and tight enough inside themselves to collapse
 * into one. At z14 clustering is off entirely and the six Ahmedabad fixtures sit inside a
 * 1600×1000 viewport centred on `72.5714, 23.0225`, so they render as individual pins.
 *
 * Bands are not set directly — the API resolves them (`packages/api/src/routes/cameras.ts`):
 * `trust_score >= 70` is trusted, `>= 40` degraded, below that untrusted, `null` never probed
 * (`unscored`), and a latest health check with `connectable = false` overrides all of it to `dead`.
 * The spread below therefore exercises all five, including the hollow-ring case.
 */
import { execFileSync } from 'node:child_process';

/** Reserved prefix. Never used by the catalogue (`cam*`), a CSV import (`GJ-*`) or the bench. */
export const FIXTURE_PREFIX = 'MAPFIX-';

/**
 * The seeded estate, written out row by row rather than generated.
 *
 * `bench-dashboard.mjs` uses `generate_series` because it needs a hundred thousand rows and their
 * individual values do not matter. Here every value is load-bearing — a district that a filter
 * selects on, a score that decides a colour, a coordinate that decides a cluster — so each row is
 * legible, and a failure names a camera rather than an index.
 */
export const FIXTURES = [
  // ── Ahmedabad · the street-zoom group, inside the z14 viewport at 72.5714,23.0225 ─────────────
  // Five of these six match `district=Ahmedabad & adapterKind=hls & cameraType=ip`; the sixth is
  // deliberately none of those, so the filter has something real to exclude.
  {
    id: 'AHM-01',
    lon: 72.5714,
    lat: 23.0225,
    district: 'Ahmedabad',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 88.5,
  },
  {
    id: 'AHM-02',
    lon: 72.581,
    lat: 23.029,
    district: 'Ahmedabad',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 55.0,
  },
  {
    id: 'AHM-03',
    lon: 72.562,
    lat: 23.016,
    district: 'Ahmedabad',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 22.75,
  },
  {
    id: 'AHM-04',
    lon: 72.577,
    lat: 23.013,
    district: 'Ahmedabad',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 91.0,
    connectable: false,
  },
  {
    id: 'AHM-05',
    lon: 72.566,
    lat: 23.03,
    district: 'Ahmedabad',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: null,
  },
  {
    id: 'AHM-06',
    lon: 72.586,
    lat: 23.019,
    district: 'Ahmedabad',
    type: 'analog',
    mount: 'mobile',
    adapter: 'rtsp',
    score: 74.0,
  },

  // ── Surat ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'SRT-01',
    lon: 72.8311,
    lat: 21.1702,
    district: 'Surat',
    type: 'ip',
    mount: 'static',
    adapter: 'rtsp',
    score: 79.25,
  },
  {
    id: 'SRT-02',
    lon: 72.839,
    lat: 21.176,
    district: 'Surat',
    type: 'ip',
    mount: 'mobile',
    adapter: 'rtsp',
    score: 46.0,
  },
  {
    id: 'SRT-03',
    lon: 72.824,
    lat: 21.164,
    district: 'Surat',
    type: 'analog',
    mount: 'static',
    adapter: 'onvif',
    score: 31.5,
  },
  {
    id: 'SRT-04',
    lon: 72.836,
    lat: 21.159,
    district: 'Surat',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: null,
  },

  // ── Rajkot ────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'RJK-01',
    lon: 70.8022,
    lat: 22.3039,
    district: 'Rajkot',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 83.0,
  },
  {
    id: 'RJK-02',
    lon: 70.811,
    lat: 22.31,
    district: 'Rajkot',
    type: 'ip',
    mount: 'static',
    adapter: 'rtsp',
    score: 68.75,
  },
  {
    id: 'RJK-03',
    lon: 70.795,
    lat: 22.297,
    district: 'Rajkot',
    type: 'analog',
    mount: 'mobile',
    adapter: 'onvif',
    score: 12.0,
  },

  // ── Bhuj (Kachchh) · the far-west group, so clustering has real spread to work with ───────────
  {
    id: 'BHJ-01',
    lon: 69.6669,
    lat: 23.2419,
    district: 'Kachchh',
    type: 'ip',
    mount: 'static',
    adapter: 'rtsp',
    score: 72.5,
  },
  {
    id: 'BHJ-02',
    lon: 69.675,
    lat: 23.248,
    district: 'Kachchh',
    type: 'ip',
    mount: 'static',
    adapter: 'hls',
    score: 41.0,
  },
  {
    id: 'BHJ-03',
    lon: 69.659,
    lat: 23.236,
    district: 'Kachchh',
    type: 'analog',
    mount: 'static',
    adapter: 'onvif',
    score: null,
  },
];

/** The six that sit inside the z14 viewport centred on Ahmedabad — every one an individual pin. */
export const STREET_ZOOM_IDS = FIXTURES.filter((f) => f.district === 'Ahmedabad').map(
  (f) => `${FIXTURE_PREFIX}${f.id}`,
);

/** What `?district=Ahmedabad&adapterKind=hls&cameraType=ip` selects out of the fixtures: 5 of 16. */
export const FILTER_MATCHES = FIXTURES.filter(
  (f) => f.district === 'Ahmedabad' && f.adapter === 'hls' && f.type === 'ip',
).length;

/** Fixtures whose band is `unscored` — `trust_score is null`, never probed, hollow ring. */
export const UNSCORED_COUNT = FIXTURES.filter((f) => f.score === null).length;

/** Fixtures the API will band `dead`: a latest health check that could not connect. */
export const DEAD_COUNT = FIXTURES.filter((f) => f.connectable === false).length;

const quote = (value) => (value === null || value === undefined ? 'null' : `'${value}'`);

/**
 * A `psql` runner bound to a connection string. Synchronous on purpose: cleanup has to be able to
 * run from a `process.on('exit')` handler, where nothing asynchronous is allowed to finish.
 */
export function psqlFor(databaseUrl) {
  return (query) => execFileSync('psql', [databaseUrl, '-tAc', query], { encoding: 'utf8' }).trim();
}

/** Live camera rows, fixtures included. The number AC 4 compares before and after. */
export function cameraCount(psql) {
  return Number(psql('select count(*) from cameras where deleted_at is null'));
}

/** Live cameras PostGIS has no location for. Fixtures are all placed, so this must never move. */
export function unplacedCount(psql) {
  return Number(psql('select count(*) from cameras where deleted_at is null and location is null'));
}

/** How many *real* cameras the fixture filter already selects, so the expected count stays exact. */
export function realFilterMatches(psql) {
  return Number(
    psql(`select count(*) from cameras
           where deleted_at is null
             and district = 'Ahmedabad' and adapter_kind = 'hls' and camera_type = 'ip'
             and external_id not like '${FIXTURE_PREFIX}%'`),
  );
}

/**
 * Insert the fixture estate. Idempotent: a previous crashed run is removed first, so a stale row
 * can never inflate a count or a cluster.
 */
export function seedMapFixtures(psql) {
  removeMapFixtures(psql);

  const values = FIXTURES.map(
    (f) => `('${FIXTURE_PREFIX}${f.id}',
             'Map fixture ${f.id} (${f.district})',
             st_setsrid(st_makepoint(${f.lon}, ${f.lat}), 4326)::geography,
             ${quote(f.district)},
             '${f.type}'::camera_type,
             '${f.mount}'::camera_mount,
             '${f.adapter}'::adapter_kind,
             '{}'::jsonb,
             ${f.score === null ? 'null' : f.score})`,
  ).join(',\n');

  psql(`insert into cameras (external_id, name, location, district, camera_type, mount,
                             adapter_kind, endpoints, trust_score)
        values ${values}`);

  // `dead` is not a score — the API resolves it from the latest health check's `connectable`, so a
  // fixture that should read `dead` needs a real (failed) check row rather than a low number.
  for (const f of FIXTURES.filter((x) => x.connectable === false)) {
    psql(`insert into camera_health_checks (camera_id, checked_at, connectable, decodable,
                                            trust_score, breakdown)
          select id, now(), false, false, ${f.score}, '{}'::jsonb
            from cameras where external_id = '${FIXTURE_PREFIX}${f.id}'`);
  }

  return FIXTURES.length;
}

/**
 * Delete every fixture row, and say how many went.
 *
 * Health checks go first and explicitly: `camera_health_checks` is a TimescaleDB hypertable, and
 * leaning on the foreign key's `on delete cascade` across a hypertable is a bet this script has no
 * reason to take when one extra statement settles it.
 */
export function removeMapFixtures(psql) {
  psql(`delete from camera_health_checks h
         using cameras c
         where c.id = h.camera_id and c.external_id like '${FIXTURE_PREFIX}%'`);
  return Number(
    psql(`with d as (delete from cameras where external_id like '${FIXTURE_PREFIX}%' returning 1)
          select count(*) from d`),
  );
}
