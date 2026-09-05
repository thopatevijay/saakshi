/**
 * AC 1, 3, 4 and 8, against a running app and a real database.
 *
 *   AC 1 · every camera renders at its correct coordinates; clustering works to statewide zoom
 *   AC 3 · every layer toggle and filter works, composes, and survives a reload via URL state
 *   AC 4 · trust colouring matches the API's band exactly
 *   AC 8 · panning stays smooth at estate size
 *
 * Coordinates are checked against **`psql`, not against the API that produced them** — an assertion
 * that the map agrees with the endpoint it fetched from proves only that JSON survived a network
 * hop. Comparing `ST_X`/`ST_Y` from PostGIS to the numbers MapLibre is actually holding tests the
 * whole chain, including the longitude/latitude transposition everybody makes exactly once.
 *
 * ## Why this script brings its own cameras (D2-09)
 *
 * The Gujarat Sentinel catalogue publishes `{id, name}` and nothing else, so **no real camera in
 * the estate has a coordinate or a district**. Four of the checks below — clustering, street-zoom
 * pins, the filter, and filter restoration from the URL — need one or the other, and against the
 * real estate they failed on every run. A check that always fails is a check nobody reads, and the
 * GIS map is Model 1's headline deliverable: the worst place in the product to lose a signal.
 *
 * So `map-fixtures.mjs` seeds a small placed estate under the reserved `MAPFIX-` prefix, the
 * assertions run against known numbers, and the fixtures are deleted again — including when the
 * script fails part way, via the `process.on('exit')` net below. The real estate is never touched:
 * no coordinate is backfilled onto a real camera, and the count of cameras *without* coordinates is
 * asserted to be identical before and after. That absence is a Pillar 1 finding, and it stays.
 *
 *   DATABASE_URL=… node scripts/verify-map.mjs <token-file> [base-url] [api-url]
 *
 * `VERIFY_MAP_CRASH=1` throws immediately after seeding — the repeatable way to prove the estate is
 * still restored when the script dies in the middle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  MAP_READY,
  authenticate,
  check,
  navigate,
  openBrowser,
  screenshot,
  waitFor,
} from './cdp.mjs';
import {
  FILTER_MATCHES,
  FIXTURES,
  FIXTURE_PREFIX,
  STREET_ZOOM_IDS,
  UNSCORED_COUNT,
  cameraCount,
  psqlFor,
  realFilterMatches,
  removeMapFixtures,
  seedMapFixtures,
  unplacedCount,
} from './map-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required — this script checks against psql');

const sql = psqlFor(databaseUrl);
const psql = (query) =>
  JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${query}) t`) || '[]');

const apiGet = (path) =>
  fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

// ── Fixtures · seed, and guarantee the estate comes back ────────────────────────────────────────
console.log('\nEstate-independent fixtures\n');

const camerasBefore = cameraCount(sql);
const unplacedBefore = unplacedCount(sql);
const realMatches = realFilterMatches(sql);
let fixturesLive = false;

const cleanupFixtures = () => {
  if (!fixturesLive) return 0;
  fixturesLive = false;
  return removeMapFixtures(sql);
};

// The safety net for AC "still identical when the script fails part way". Everything it does is a
// synchronous `execFileSync`, which is the only kind of work an `exit` handler is allowed to
// finish — an async cleanup here would be silently abandoned and leave rows behind.
process.on('exit', () => {
  if (!fixturesLive) return;
  const removed = cleanupFixtures();
  console.error(
    `\n  ! the script exited early — removed ${String(removed)} fixtures, ${String(cameraCount(sql))} cameras remain (${String(camerasBefore)} before)\n`,
  );
});

seedMapFixtures(sql);
fixturesLive = true;
console.log(
  `  seeded ${String(FIXTURES.length)} placed fixtures as ${FIXTURE_PREFIX}* — ${String(camerasBefore)} cameras → ${String(cameraCount(sql))}`,
);
console.log(
  `  the real estate is untouched: ${String(unplacedBefore)} cameras still have no coordinates, and none was backfilled`,
);

if (process.env.VERIFY_MAP_CRASH === '1') {
  throw new Error(
    'VERIFY_MAP_CRASH=1 — deliberate mid-script failure, to prove cleanup still runs',
  );
}

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);

const ready = async () => {
  await waitFor(cdp, MAP_READY, { timeoutMs: 60000, label: 'the map to load' });
  await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'the map to go idle' });
};

// ── AC 1 · coordinates and clustering ───────────────────────────────────────────────────────────
console.log('\nAC 1 · every camera renders at its correct coordinates\n');

await navigate(cdp, `${base}/registry`);
await ready();

const inDb = psql(`
  select external_id,
         round(st_x(location::geometry)::numeric, 6)::float8 as lon,
         round(st_y(location::geometry)::numeric, 6)::float8 as lat
    from cameras
   where deleted_at is null and location is not null`);

const dbUnplaced = psql(`
  select count(*)::int as n from cameras where deleted_at is null and location is null`)[0].n;

/** Every feature the map is holding, read straight off the live GeoJSON source. */
const onMap = await cdp
  .evaluate(
    `(() => {
  const data = window.__saakshiFeatures;
  return JSON.stringify(data.features.map((f) => ({
    externalId: f.properties.externalId,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    band: f.properties.band,
  })));
})()`,
  )
  .then(JSON.parse);

check(
  onMap.length === inDb.length,
  `the map holds every placed camera — ${String(onMap.length)} features vs ${String(inDb.length)} rows with a location`,
);

const byId = new Map(onMap.map((f) => [f.externalId, f]));
let misplaced = 0;
for (const row of inDb) {
  const feature = byId.get(row.external_id);
  if (feature === undefined) {
    misplaced += 1;
    console.error(`    ${row.external_id} is in the database but not on the map`);
    continue;
  }
  // 1e-6 degrees ≈ 11 cm. Anything larger is a real discrepancy, not float noise.
  if (Math.abs(feature.lon - row.lon) > 1e-6 || Math.abs(feature.lat - row.lat) > 1e-6) {
    misplaced += 1;
    console.error(
      `    ${row.external_id}: map ${String(feature.lon)},${String(feature.lat)} ≠ PostGIS ${String(row.lon)},${String(row.lat)}`,
    );
  }
}
check(
  misplaced === 0,
  `every one of the ${String(inDb.length)} coordinates matches ST_X/ST_Y from PostGIS to 1e-6°`,
);

const trayCount = await cdp.evaluate(`document.querySelectorAll('[data-unplaced]').length`);
check(
  trayCount === dbUnplaced,
  `the ${String(dbUnplaced)} cameras PostGIS has no location for are listed in the tray, not dropped (${String(trayCount)} rows)`,
);
// The fixtures are all placed, so they must not move this number by one. If they did, the seed had
// started editing the real estate rather than adding to it.
check(
  dbUnplaced === unplacedBefore,
  `the "without coordinates" count is unchanged by the ${String(FIXTURES.length)} fixtures — ${String(unplacedBefore)} before, ${String(dbUnplaced)} with them seeded`,
);

// Clustering: statewide must aggregate, street level must not.
const statewide = await cdp
  .evaluate(
    `(async () => {
  window.__saakshiMap.jumpTo({ center: [71.7, 22.4], zoom: 6 });
  await new Promise((r) => window.__saakshiMap.once('idle', r));
  const f = window.__saakshiMap.queryRenderedFeatures({ layers: ['clusters', 'camera-pins'] });
  return JSON.stringify({
    clusters: f.filter((x) => x.properties.point_count !== undefined).length,
    clustered: f.reduce((n, x) => n + (x.properties.point_count ?? 0), 0),
    singles: f.filter((x) => x.properties.point_count === undefined).length,
  });
})()`,
  )
  .then(JSON.parse);
const rendered = statewide.clusters + statewide.singles;
console.log(`  z6  ${JSON.stringify(statewide)}`);
check(
  statewide.clusters > 0,
  `clustering works at statewide zoom — ${String(statewide.clusters)} clusters covering ${String(statewide.clustered)} cameras`,
);
// Two halves, and both are needed. The first says nothing was lost on the way into a cluster; the
// second says the clustering actually did something. A map that drew every pin separately would
// pass the first alone, and a map that dropped half the estate would pass the second alone.
check(
  statewide.clustered + statewide.singles === inDb.length,
  `every one of the ${String(inDb.length)} placed cameras is accounted for at z6 — ${String(statewide.clustered)} inside clusters, ${String(statewide.singles)} standing alone`,
);
check(
  rendered < inDb.length,
  `they collapse rather than pile up — ${String(inDb.length)} cameras render as ${String(rendered)} features at z6`,
);

const street = await cdp
  .evaluate(
    `(async () => {
  window.__saakshiMap.jumpTo({ center: [72.5714, 23.0225], zoom: 14 });
  await new Promise((r) => window.__saakshiMap.once('idle', r));
  const f = window.__saakshiMap.queryRenderedFeatures({ layers: ['clusters', 'camera-pins'] });
  const pins = f.filter((x) => x.properties.point_count === undefined);
  return JSON.stringify({
    clusters: f.filter((x) => x.properties.point_count !== undefined).length,
    // Deduplicated: a pin on a tile boundary is returned once per tile it appears in.
    singleIds: [...new Set(pins.map((x) => x.properties.externalId))],
  });
})()`,
  )
  .then(JSON.parse);
const missingPins = STREET_ZOOM_IDS.filter((id) => !street.singleIds.includes(id));
console.log(
  `  z14 ${JSON.stringify({ clusters: street.clusters, pins: street.singleIds.length })}`,
);
check(
  street.singleIds.length > 0 && street.clusters === 0 && missingPins.length === 0,
  `individual pins at street zoom — ${String(street.singleIds.length)} pins, ${String(street.clusters)} clusters, and all ${String(STREET_ZOOM_IDS.length)} Ahmedabad fixtures are among them`,
);
if (missingPins.length > 0) console.error(`    missing at z14: ${missingPins.join(', ')}`);

// ── AC 4 · colour comes from the API's band ─────────────────────────────────────────────────────
console.log('\nAC 4 · trust colouring matches the API band exactly\n');

const list = await apiGet('/api/v1/cameras?limit=500');
const scored = list.data.filter((c) => c.trustScore !== null);
console.log(
  `  ${String(list.data.length)} cameras · ${String(scored.length)} scored · ${String(list.data.length - scored.length)} never probed`,
);

let disagreements = 0;
for (const camera of scored) {
  const trust = await apiGet(`/api/v1/cameras/${camera.id}/trust`);
  if (trust.band !== camera.band) {
    disagreements += 1;
    console.error(
      `    ${camera.externalId}: list says ${String(camera.band)}, /trust says ${String(trust.band)}`,
    );
  }
}
check(
  disagreements === 0,
  `the band on every one of the ${String(scored.length)} scored cameras agrees with GET /cameras/:id/trust`,
);

const nullBands = list.data.filter((c) => c.trustScore === null && c.band !== null);
check(
  nullBands.length === 0,
  'a never-probed camera carries band=null, never a band derived from a missing score',
);

// The colour the UI actually painted, read out of the DOM for the tray and out of the paint
// expression for the map — both keyed on the API's value with no arithmetic in between.
const colours = await cdp
  .evaluate(
    `(() => {
  const paint = window.__saakshiMap.getPaintProperty('camera-pins', 'circle-color');
  const chips = [...document.querySelectorAll('[data-unplaced]')].map((b) => ({
    externalId: b.getAttribute('data-unplaced'),
    dot: b.querySelector('span[style]')?.getAttribute('style') ?? '',
  }));
  return JSON.stringify({ paint, chips });
})()`,
  )
  .then(JSON.parse);

check(
  JSON.stringify(colours.paint).includes('"band"') &&
    !/[^0-9]70[^0-9]/.test(JSON.stringify(colours.paint)),
  'the pin paint expression reads the `band` property and contains no score threshold',
);

const EXPECTED = { trusted: '#10b981', degraded: '#f59e0b', untrusted: '#ef4444' };
const apiById = new Map(list.data.map((c) => [c.externalId, c]));
let mismatched = 0;
for (const chip of colours.chips) {
  const camera = apiById.get(chip.externalId);
  if (camera === undefined || camera.band === null) continue;
  const expected = EXPECTED[camera.band];
  if (expected !== undefined && !chip.dot.toLowerCase().replaceAll(' ', '').includes(expected)) {
    mismatched += 1;
    console.error(`    ${chip.externalId}: band ${camera.band} but the chip is "${chip.dot}"`);
  }
}
check(
  mismatched === 0,
  `every tray chip is painted the colour of the band the API returned (${String(colours.chips.length)} chips)`,
);

// ── AC 3 · filters, toggles, composition, reload ────────────────────────────────────────────────
console.log('\nAC 3 · filters and toggles compose and survive a reload\n');

const shared = `${base}/registry?district=Ahmedabad&adapterKind=hls&cameraType=ip&hideBand=unscored&hideMount=mobile`;
await navigate(cdp, shared);
await ready();

const filtered = await cdp
  .evaluate(
    `(() => {
  const summary = document.querySelector('[data-testid="estate-summary"]').textContent;
  const source = window.__saakshiFeatures;
  return JSON.stringify({
    summary: summary.replace(/\\s+/g, ' ').trim(),
    features: source.features.map((f) => f.properties.externalId).sort(),
    bandPressed: [...document.querySelectorAll('[data-band]')].map((b) => b.getAttribute('data-band') + '=' + b.getAttribute('aria-pressed')),
    mountPressed: [...document.querySelectorAll('[data-layer^="mount:"]')].map((b) => b.getAttribute('data-layer') + '=' + b.getAttribute('aria-pressed')),
    filterValues: [...document.querySelectorAll('[data-filter]')].map((el) => el.getAttribute('data-filter') + '=' + el.value).filter((s) => !s.endsWith('=')),
  });
})()`,
  )
  .then(JSON.parse);

console.log(`  ${filtered.summary}`);
console.log(`  filters restored: ${filtered.filterValues.join(' · ')}`);
console.log(
  `  toggles restored: ${[...filtered.bandPressed, ...filtered.mountPressed].join(' · ')}`,
);

// The server-side half: the API returns exactly the same set for the same query.
//
// The expectation is a *number PostGIS predicted*, not "more than zero". `realFilterMatches` counted
// the real cameras this filter already selects before anything was seeded (zero, on an estate whose
// catalogue publishes no district), and `FILTER_MATCHES` is how many of the fixtures match all
// three clauses. A filter that quietly ignored one of them would return more than that and fail.
const apiFiltered = await apiGet(
  '/api/v1/cameras?district=Ahmedabad&adapterKind=hls&cameraType=ip&limit=500',
);
const expectedMatches = realMatches + FILTER_MATCHES;
check(
  apiFiltered.data.length === expectedMatches && expectedMatches > 0,
  `the filter narrows the estate rather than emptying it — the API returns ${String(apiFiltered.data.length)} cameras, the ${String(expectedMatches)} PostGIS predicted (${String(realMatches)} real + ${String(FILTER_MATCHES)} fixture)`,
);
check(
  expectedMatches < list.data.length,
  `and it narrows: ${String(expectedMatches)} of ${String(list.data.length)} cameras, not all of them`,
);

check(
  filtered.filterValues.includes('district=Ahmedabad') &&
    filtered.filterValues.includes('adapterKind=hls') &&
    filtered.filterValues.includes('cameraType=ip'),
  'all three filters came back from the URL into their controls after a full page load',
);
check(
  filtered.bandPressed.includes('unscored=false'),
  'the hidden band toggle came back pressed-off from the URL',
);
check(
  filtered.mountPressed.includes('mount:mobile=false'),
  'the hidden mount toggle came back pressed-off from the URL, composing with the band toggle',
);

// Composition: the hidden band must not be on the map, and the filtered-out cameras must not be
// in the response at all.
//
// The first check is what stops the second from being vacuous. `hiddenLeaked === 0` is trivially
// true on a map holding no unscored pins at all, which is precisely the state this script used to
// run in — so the unfiltered load is asserted to have held them first.
const unscoredOnMap = onMap.filter((f) => f.band === 'unscored').length;
check(
  unscoredOnMap === UNSCORED_COUNT,
  `the unfiltered map held ${String(unscoredOnMap)} never-probed pins, so hiding the band is a real removal (${String(UNSCORED_COUNT)} fixtures carry no score)`,
);

const hiddenLeaked = await cdp.evaluate(`(() => {
  return window.__saakshiFeatures.features.filter((f) => f.properties.band === 'unscored').length;
})()`);
check(
  hiddenLeaked === 0,
  `hiding a band removes it from the source, so the cluster counts stay truthful (${String(hiddenLeaked)} leaked)`,
);

// Now toggle in the browser and confirm the URL follows, then reload and confirm it comes back.
await cdp.evaluate(`document.querySelector('[data-band="degraded"]').click(); true`);
await waitFor(cdp, `location.search.includes('degraded')`, {
  label: 'the URL to record the toggle',
});
const url = await cdp.evaluate('location.href');
check(url.includes('hideBand='), `a click on the legend rewrote the URL — ${new URL(url).search}`);

await navigate(cdp, url);
await ready();
const afterReload = await cdp.evaluate(
  `[...document.querySelectorAll('[data-band]')].map((b) => b.getAttribute('data-band') + '=' + b.getAttribute('aria-pressed')).join(',')`,
);
check(
  afterReload.includes('degraded=false') && afterReload.includes('unscored=false'),
  `both toggles survived the reload — ${afterReload}`,
);

await navigate(cdp, `${base}/registry`);
await ready();
// Named for the fixtures, not for D1-08. Every pin in this frame is a `MAPFIX-` row, so filing it
// as the registry-map screenshot would put a picture of synthetic cameras where the estate's own
// screenshot belongs — the exact kind of claim this project does not make.
await screenshot(cdp, path.join(SHOTS, 'd2-09-map-fixtures.png'));

// ── AC 8 · panning stays smooth ─────────────────────────────────────────────────────────────────
console.log('\nAC 8 · map interaction stays smooth\n');

const frames = await cdp
  .evaluate(
    `(async () => {
  const map = window.__saakshiMap;
  const times = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // A programmatic sweep across the state, at the zoom where the most pins are drawn.
  const legs = [
    [69.7, 23.2], [70.8, 22.3], [72.0, 21.7], [72.57, 23.02], [73.2, 22.3], [71.7, 22.4],
  ];
  map.jumpTo({ center: legs[0], zoom: 9 });
  for (const centre of legs.slice(1)) {
    map.easeTo({ center: centre, duration: 900 });
    await new Promise((r) => setTimeout(r, 1000));
  }
  running = false;
  await new Promise((r) => setTimeout(r, 100));

  const sorted = times.slice(5).sort((a, b) => a - b);
  const at = (q) => sorted[Math.floor(sorted.length * q)];
  return JSON.stringify({
    frames: sorted.length,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    worst: Number(sorted[sorted.length - 1].toFixed(2)),
    over50ms: sorted.filter((t) => t > 50).length,
  });
})()`,
  )
  .then(JSON.parse);

console.log(
  `  ${String(frames.frames)} frames over a 5-leg sweep · p50 ${String(frames.p50)} ms · p95 ${String(frames.p95)} ms · worst ${String(frames.worst)} ms`,
);
// 50 ms is the threshold below which a pan reads as continuous rather than stepped. Headless
// software WebGL is materially slower than a real GPU, so passing here is a floor, not a ceiling.
check(
  frames.p95 < 50,
  `p95 frame time ${String(frames.p95)} ms is under the 50 ms jank threshold (${String(frames.over50ms)} slow frames of ${String(frames.frames)}, headless SwiftShader — no GPU)`,
);

await cdp.close();

// ── The estate goes back exactly as it was found ────────────────────────────────────────────────
console.log('\nFixtures removed — the estate is as it was found\n');

const removedFixtures = cleanupFixtures();
const camerasAfter = cameraCount(sql);
const unplacedAfter = unplacedCount(sql);
const strays = Number(
  sql(`select count(*) from cameras where external_id like '${FIXTURE_PREFIX}%'`),
);

check(
  removedFixtures === FIXTURES.length && strays === 0,
  `all ${String(FIXTURES.length)} fixtures deleted, ${String(strays)} ${FIXTURE_PREFIX}* rows left behind`,
);
check(
  camerasAfter === camerasBefore,
  `the camera row count is identical before and after — ${String(camerasBefore)} → ${String(camerasAfter)}`,
);
check(
  unplacedAfter === unplacedBefore,
  `and so is the "without coordinates" count — ${String(unplacedBefore)} → ${String(unplacedAfter)}; no real camera was placed, edited or removed`,
);

console.log('');
