/**
 * D3-06 AC 5 — "Map overlay renders the three states distinctly and performs at statewide zoom."
 *
 * A WebGL canvas is opaque to assertions, so this drives a real browser over CDP and reads the map
 * instance's own state — the same technique `verify-map.mjs` uses, and the reason
 * `window.__saakshiMap` / `__saakshiCoverage` / `__saakshiMapIdle` / `__saakshiMapErrors` exist.
 *
 * What it proves, in order:
 *
 *   1. The overlay is its **own source and layers**, and both sit **below `clusters`** — D1-08's
 *      rule, because merging the polygons into the `cameras` source would change what the cluster
 *      counts mean, and `verify-map.mjs` asserts on those.
 *   2. The three states are visually distinct, and the paint expression reads the API's `state`
 *      property rather than deriving anything from a score.
 *   3. The cell count on screen matches `camera_coverage` in Postgres, and the cameras with null
 *      geometry are absent from the overlay rather than drawn at (0,0).
 *   4. Panning at statewide zoom with the overlay on stays under 50 ms at p95 — the same bar
 *      `verify-map.mjs` holds the pin layer to.
 *
 *   DATABASE_URL=… node scripts/verify-coverage-map.mjs <token-file> [base-url] [api-url]
 *
 * The api-url argument defaults to 4000, matching `packages/api`'s own default — `verify-map.mjs`
 * defaults to 4100 and that mismatch has cost two tickets an `ECONNREFUSED`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  MAP_READY,
  authenticate,
  check,
  navigate,
  openBrowser,
  pass,
  screenshot,
  waitFor,
} from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const apiUrl = process.argv[4] ?? 'http://localhost:4000';
const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  console.error('DATABASE_URL is required: the point is to check the map against Postgres.');
  process.exit(2);
}

const psql = (query) =>
  execFileSync('psql', [databaseUrl, '-tAc', query], { encoding: 'utf8' }).trim();

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);

console.log('\nD3-06 AC 5 · the coverage overlay\n');

await navigate(cdp, `${base}/registry`);
await waitFor(cdp, MAP_READY, { timeoutMs: 60000, label: 'the map to load its style' });
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'the map to go idle' });

// ── Turn the overlay on ─────────────────────────────────────────────────────────────────────────
// It is off by default, so this also proves the toggle actually wires the fetch to the source.
await cdp.evaluate(
  `document.querySelector('[data-testid="coverage-toggle"]').click(); true`,
);
await waitFor(cdp, 'window.__saakshiCoverage !== undefined', {
  timeoutMs: 30000,
  label: 'the coverage collection to reach the map',
});
await waitFor(cdp, 'window.__saakshiCoverage.features.length > 0', {
  timeoutMs: 30000,
  label: 'coverage cells to load',
});
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle after enabling coverage' });

// ── 1 · its own source, below the pins ──────────────────────────────────────────────────────────
const layers = await cdp.evaluate(`(() => {
  const m = window.__saakshiMap;
  const ids = m.getStyle().layers.map((l) => l.id);
  return {
    ids,
    hasSource: m.getSource('coverage') !== undefined,
    camerasIsSeparate: m.getLayer('coverage-fill').source !== m.getLayer('camera-pins').source,
  };
})()`);

check(layers.hasSource, 'the overlay has its own `coverage` source');
check(layers.camerasIsSeparate, 'the overlay does not share the `cameras` source');
for (const id of ['coverage-fill', 'coverage-outline']) {
  check(layers.ids.includes(id), `layer \`${id}\` exists`);
  check(
    layers.ids.indexOf(id) < layers.ids.indexOf('clusters'),
    `\`${id}\` is drawn before \`clusters\`, so camera pins stay on top`,
  );
}

// ── 2 · three distinct states, driven by the API's property ─────────────────────────────────────
const paint = await cdp.evaluate(`(() => {
  const m = window.__saakshiMap;
  return {
    fill: JSON.stringify(m.getPaintProperty('coverage-fill', 'fill-color')),
    opacity: JSON.stringify(m.getPaintProperty('coverage-fill', 'fill-opacity')),
    line: JSON.stringify(m.getPaintProperty('coverage-outline', 'line-color')),
  };
})()`);

check(paint.fill.includes('"state"'), 'the fill expression reads the API’s `state` property');
check(
  !paint.fill.includes('trust_score') && !/[^0-9.]70[^0-9]/.test(paint.fill),
  'the fill expression contains no score threshold — the client derives no state itself',
);
for (const [state, colour] of [
  ['trusted', '#10b981'],
  ['untrusted', '#f59e0b'],
]) {
  check(paint.fill.includes(colour), `\`${state}\` renders as ${colour}`);
}
check(
  paint.fill.includes('rgba(0,0,0,0)'),
  '`uncovered` has no fill — it is bare basemap, not a layer',
);
check(
  paint.fill.includes('#10b981') && paint.fill.includes('#f59e0b'),
  'covered-trusted and covered-untrusted are visually distinct',
);

// The legend must carry all three states even when the data has only one, or a reader cannot tell
// a missing state from an absent one.
const legend = await cdp.evaluate(
  `Array.from(document.querySelectorAll('[data-coverage-state]')).map((n) => n.dataset.coverageState)`,
);
check(
  ['trusted', 'untrusted', 'uncovered'].every((s) => legend.includes(s)),
  'the legend names all three states',
);

// ── 3 · the cells match Postgres ────────────────────────────────────────────────────────────────
const drawn = await cdp.evaluate(`window.__saakshiCoverage.features.length`);
const withPolygon = Number(psql('select count(*) from camera_coverage where fov_polygon is not null'));
const nullGeometry = Number(psql('select count(*) from camera_coverage where fov_polygon is null'));
const cameraCount = Number(psql('select count(*) from cameras where deleted_at is null'));
const coverageRows = Number(psql('select count(*) from camera_coverage'));

check(drawn === withPolygon, `${drawn} cells drawn = ${withPolygon} rows with geometry in Postgres`);
check(
  coverageRows === cameraCount,
  `camera_coverage has one row per live camera (${coverageRows} = ${cameraCount})`,
);
pass(
  `${nullGeometry} cameras have a row with null geometry and are absent from the overlay ` +
    '— unassessable, not drawn at (0,0)',
);

const states = await cdp.evaluate(`(() => {
  const by = {};
  for (const f of window.__saakshiCoverage.features) {
    by[f.properties.state] = (by[f.properties.state] ?? 0) + 1;
  }
  return by;
})()`);
const trustedInDb = Number(
  psql(`select count(*) from camera_coverage cc
          join cameras c on c.id = cc.camera_id
         where cc.fov_polygon is not null
           and c.trust_score is not null
           and c.trust_score >= 70`),
);
// Not an assertion that the client may compute the band this way — it is the *inverse*: the server
// must never hand back more trusted cells than the raw arithmetic could possibly justify, because
// the server also subtracts the dead and the focus-disqualified.
check(
  (states.trusted ?? 0) <= trustedInDb,
  `trusted cells (${states.trusted ?? 0}) never exceed what the raw score alone would allow (${trustedInDb})`,
);

// The map must be showing what the API actually served, not a stale bundle or a cached action.
const fromApi = await fetch(`${apiUrl}/api/v1/coverage/overlay`, {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json());
check(
  fromApi.features.length === drawn,
  `the map holds exactly what ${apiUrl}/api/v1/coverage/overlay served (${fromApi.features.length})`,
);
check(
  fromApi.features.every((f) => ['trusted', 'untrusted'].includes(f.properties.state)),
  'every served cell carries a state the legend defines',
);

const caption = await cdp.evaluate(
  `document.querySelector('[data-testid="coverage-caption"]').textContent`,
);
check(
  caption.trim().length > 0 && !caption.includes('undefined') && !caption.includes('NaN'),
  `the caption states what the overlay shows: "${caption.trim().slice(0, 90)}"`,
);

// ── 4 · statewide performance ───────────────────────────────────────────────────────────────────
await cdp.evaluate(`window.__saakshiMap.jumpTo({ center: [71.7, 22.4], zoom: 6 }); true`);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle at statewide zoom' });

const frames = await cdp.evaluate(`(async () => {
  const m = window.__saakshiMap;
  const times = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    times.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const legs = [
    [70.8, 22.3], [72.57, 23.02], [72.83, 21.17], [69.67, 23.24], [71.7, 22.4],
  ];
  for (const centre of legs) {
    m.easeTo({ center: centre, zoom: 8, duration: 700 });
    await new Promise((r) => m.once('moveend', r));
  }
  running = false;
  times.sort((a, b) => a - b);
  return { p95: times[Math.floor(times.length * 0.95)] ?? 0, frames: times.length };
})()`);

check(
  frames.p95 < 50,
  `p95 frame time ${frames.p95.toFixed(1)} ms over ${frames.frames} frames during a statewide pan with the overlay on (< 50 ms)`,
);

const errors = await cdp.evaluate(`window.__saakshiMapErrors ?? []`);
check(errors.length === 0, `the map raised no errors${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);

await cdp.evaluate(`window.__saakshiMap.jumpTo({ center: [72.5714, 23.0225], zoom: 13 }); true`);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle at street zoom' });
await screenshot(cdp, path.join(SHOTS, 'd3-06-coverage-overlay.png'));

// The legend sits below the fold in the sidebar, and it is where the three states are *explained*
// rather than merely coloured — so it gets its own frame instead of being cropped out of the map.
await cdp.evaluate(
  `document.querySelector('[data-testid="coverage-legend"]').scrollIntoView({ block: 'center' }); true`,
);
await screenshot(cdp, path.join(SHOTS, 'd3-06-coverage-legend.png'));
console.log(
  '\n  screenshots → docs/screenshots/d3-06-coverage-overlay.png, d3-06-coverage-legend.png\n',
);

await cdp.close();
