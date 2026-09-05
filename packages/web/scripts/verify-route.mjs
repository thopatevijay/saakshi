/**
 * D3-01 AC 4 — the observed/inferred distinction, verified in a real browser.
 *
 * The acceptance criterion is about what a **reviewer who has never seen the app** can tell at a
 * glance, and that cannot be asserted from a unit test: `route-geojson.test.ts` proves the right
 * line goes into the right collection, but only a browser can prove the two collections reach two
 * layers with genuinely different strokes, painted under the pins, with a legend beside them.
 *
 * A WebGL canvas is opaque to DOM assertions, so this drives Chrome over CDP the way
 * `verify-trace.mjs` and D1-08's `verify-map.mjs` do, and reads the map's own state through the
 * `window.__saakshiRouteFeatures` handle the component exposes on purpose.
 *
 * What it checks that nothing else can:
 *
 *  - the two route layers **exist and differ in dash, width and opacity** — three channels, so the
 *    distinction survives a colour-blind reader and a greyscale print of a case file;
 *  - no inferred road path has leaked into the solid layer, in the *rendered* features rather than
 *    in the pure function's output;
 *  - the route paints **under** the sighting pins — the observed thing on top of the claim about it;
 *  - the summary states the kilometre split in words, and the legend says what each stroke means;
 *  - segments that could not be drawn are **listed** rather than silently missing.
 *
 * It also captures `docs/screenshots/d3-01-route-observed-inferred.png`.
 *
 * Requires the fixture route and a road graph:
 *   npm run demo:trace -w packages/api -- --seed
 *   ./scripts/import-osm.sh
 *
 *   node scripts/verify-route.mjs <token-file> [base-url] [api-url]
 *
 * Defaults match the other verify scripts: web on 3100, API on 4100 — **not** the dev ports.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, authenticate, navigate, waitFor, screenshot, check, pass } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';
const PLATE = 'GJ01AB1234';

const ROUTE_READY = `(() => {
  const m = window.__saakshiTraceMap;
  return m !== undefined && m.loaded()
    && m.getSource('route-inferred-source') !== undefined
    && window.__saakshiRouteFeatures !== undefined;
})()`;

const apiGet = (p) =>
  fetch(`${api}${p}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

const cdp = await openBrowser({ width: 1600, height: 1100 });

try {
  const payload = await apiGet(`/api/v1/trace?plate=${PLATE}&reconstruct=true`);
  if (payload.route === null || payload.route === undefined) {
    throw new Error(
      `no route in the payload for ${PLATE}. Seed the fixture: ` +
        `npm run demo:trace -w packages/api -- --seed`,
    );
  }
  const route = payload.route;
  console.log(
    `\nroute ${PLATE}: ${route.segments.length} segments, ` +
      `${route.summary.observedSegments} observed / ${route.summary.inferredSegments} inferred, ` +
      `${route.summary.observedKm} km observed / ${route.summary.inferredKm} km inferred`,
  );

  // ── AC 3 · the classification is a mix, on live data ───────────────────────────────────────────
  console.log('\nAC 3 — classification');
  const kinds = route.segments.map((s) => s.observed);
  check(
    kinds.includes(true) && kinds.includes(false),
    `the classification array is a realistic mix, not all-true or all-false (${JSON.stringify(kinds)})`,
  );
  check(
    route.segments.some((s) => s.kind === 'inferred_unroutable'),
    'the unplaced camera produces an unroutable segment rather than vanishing from the route',
  );

  await authenticate(cdp, token, 'admin', base);
  await navigate(cdp, `${base}/trace?plate=${PLATE}`);
  await waitFor(cdp, ROUTE_READY, { label: 'route map ready' });
  await waitFor(cdp, 'window.__saakshiTraceMapIdle === true', { label: 'route map idle' });

  // ── AC 4 · the two layers are genuinely different ─────────────────────────────────────────────
  console.log('\nAC 4 — the distinction is unmistakable');
  const style = JSON.parse(
    await cdp.evaluate(`(() => {
      const m = window.__saakshiTraceMap;
      const read = (id) => ({
        dash: m.getPaintProperty(id, 'line-dasharray') ?? null,
        width: m.getPaintProperty(id, 'line-width'),
        opacity: m.getPaintProperty(id, 'line-opacity'),
        colour: m.getPaintProperty(id, 'line-color'),
      });
      return JSON.stringify({
        observed: read('route-observed'),
        inferred: read('route-inferred'),
        layers: m.getStyle().layers.map((l) => l.id),
      });
    })()`),
  );

  check(
    style.observed.dash === null && Array.isArray(style.inferred.dash),
    `observed is solid and inferred is dashed (${JSON.stringify(style.inferred.dash)})`,
  );
  check(
    style.observed.width > style.inferred.width,
    `the observed stroke is thicker (${style.observed.width} vs ${style.inferred.width})`,
  );
  check(
    style.observed.opacity > style.inferred.opacity,
    `the observed stroke is more opaque (${style.observed.opacity} vs ${style.inferred.opacity})`,
  );
  check(
    style.observed.colour !== style.inferred.colour,
    `and a different colour (${style.observed.colour} vs ${style.inferred.colour})`,
  );
  check(
    style.layers.indexOf('route-inferred') < style.layers.indexOf('trace-pins') &&
      style.layers.indexOf('route-observed') < style.layers.indexOf('trace-pins'),
    'both route layers paint under the observed pins',
  );

  // ── AC 4 · nothing inferred leaked into the solid layer ───────────────────────────────────────
  const features = JSON.parse(await cdp.evaluate(`JSON.stringify(window.__saakshiRouteFeatures)`));
  check(
    features.observed.features.every((f) => f.properties.observed === true),
    `every feature in the solid layer is observed (${features.observed.features.length})`,
  );
  check(
    features.inferred.features.every((f) => f.properties.observed === false),
    `every feature in the dashed layer is inferred (${features.inferred.features.length})`,
  );
  check(
    features.inferred.features.length ===
      route.segments.filter((s) => s.kind === 'inferred_path').length,
    'one dashed line per routed hop, no more and no fewer',
  );
  check(
    features.dwellAtSeq.length === route.summary.observedSegments,
    `every observed dwell marks its camera with a solid ring (${JSON.stringify(features.dwellAtSeq)})`,
  );
  check(
    features.undrawable.length ===
      route.summary.segments -
        features.inferred.features.length -
        features.observed.features.length,
    `everything without geometry is accounted for, not dropped (${features.undrawable.length})`,
  );

  // ── AC 4 · the words, not only the strokes ────────────────────────────────────────────────────
  console.log('\nAC 4 — the summary and legend say it in plain language');
  const split = await cdp.evaluate(
    `document.querySelector('[data-testid="route-split"]').textContent.trim()`,
  );
  check(
    split.includes('km observed') && split.includes('km inferred'),
    `the kilometre split is stated in words: "${split}"`,
  );
  const legend = await cdp.evaluate(
    `document.querySelector('[data-testid="route-legend"]').textContent.trim()`,
  );
  check(
    /observed/i.test(legend) && /on video/i.test(legend),
    'the legend says what "observed" means without jargon',
  );
  check(
    /no camera watched the vehicle/i.test(legend),
    'the legend says what "inferred" means without jargon',
  );
  const legendStrokes = Number(
    await cdp.evaluate(`document.querySelectorAll('[data-route-legend] svg line').length`),
  );
  check(legendStrokes === 2, `the legend draws the actual strokes it explains (${legendStrokes})`);

  const undrawn = await cdp.evaluate(
    `(document.querySelector('[data-testid="route-undrawn"]') ?? {}).textContent ?? ''`,
  );
  check(
    undrawn.includes('Not drawn'),
    'segments that cannot be drawn are listed with a reason rather than silently missing',
  );

  const badges = JSON.parse(
    await cdp.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-route-basis]')].map((n) => n.dataset.routeBasis))`,
    ),
  );
  check(
    badges.includes('observed') && badges.includes('inferred'),
    `the table carries the same distinction for a keyboard reader and a printed file (${JSON.stringify(badges)})`,
  );

  console.log('\nScreenshot');
  await new Promise((r) => setTimeout(r, 1200));
  const file = await screenshot(cdp, path.join(SHOTS, 'd3-01-route-observed-inferred.png'));
  pass(`captured ${file}`);

  const errors = await cdp.evaluate('JSON.stringify(window.__saakshiTraceMapErrors ?? [])');
  check(JSON.parse(errors).length === 0, `the map reported no errors (${errors})`);
} finally {
  await cdp.close();
}
