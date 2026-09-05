/**
 * D2-08 AC 3 / AC 4 / AC 6 — the trace screen, verified in a real browser.
 *
 * A WebGL canvas is opaque to DOM assertions, so this drives Chrome over CDP the way D1-08's
 * `verify-map.mjs` does and reads the map's own state through the debug handles the component
 * exposes on purpose. Three things are checked that no unit test can reach:
 *
 *  - **ordered pins with camera names** actually exist as rendered features, one per mappable
 *    sighting, labelled 1..n, each carrying its camera name and its link method;
 *  - the **connecting order is a separate, dashed line** rather than a solid polyline — the visual
 *    difference between "this is where it was seen" and "this is where it went";
 *  - the **scrubber is synchronised to the map in both directions**: moving the handle changes the
 *    highlighted pin and the map centre, and the URL keeps the selection so a shared link restores
 *    the exact screen.
 *
 * It also captures `docs/screenshots/trace.png`.
 *
 * Requires the fixture route: `npm run demo:trace -w packages/api -- --seed`.
 *
 *   node scripts/verify-trace.mjs <token-file> [base-url] [api-url]
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

const TRACE_MAP_READY = `(() => {
  const m = window.__saakshiTraceMap;
  return m !== undefined && m.loaded() && m.getSource('trace-points') !== undefined;
})()`;

const apiGet = (p) =>
  fetch(`${api}${p}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

const cdp = await openBrowser({ width: 1600, height: 1100 });

try {
  const payload = await apiGet(`/api/v1/trace?plate=${PLATE}`);
  const mappable = payload.sightings.filter((s) => s.located);
  console.log(
    `\ntrace ${PLATE}: ${payload.sightings.length} sightings, ${mappable.length} mappable, ` +
      `${payload.coverage.exactLinks} exact / ${payload.coverage.fuzzyLinks} fuzzy\n`,
  );
  if (payload.sightings.length === 0) {
    throw new Error('no trace to verify — run `npm run demo:trace -w packages/api -- --seed`');
  }

  await authenticate(cdp, token, 'admin', base);
  await navigate(cdp, `${base}/trace?plate=${PLATE}`);
  await waitFor(cdp, TRACE_MAP_READY, { label: 'trace map ready' });
  await waitFor(cdp, 'window.__saakshiTraceMapIdle === true', { label: 'trace map idle' });

  console.log('AC 3 — ordered pins with camera names');

  // `querySourceFeatures` returns a feature once per tile it appears in, so a pin on a tile seam
  // comes back twice. Deduplicating by sighting id is the script's job, not the map's.
  const pins = await cdp.evaluate(`JSON.stringify(
    [...new Map(window.__saakshiTraceMap.querySourceFeatures('trace-points')
      .map((f) => [f.properties.id, { seq: f.properties.seq, label: f.properties.label,
                     name: f.properties.cameraName, method: f.properties.linkMethod }])).values()]
      .sort((a, b) => a.seq - b.seq))`);
  const rendered = JSON.parse(pins);

  check(rendered.length === mappable.length, `one pin per mappable sighting (${rendered.length})`);
  check(
    rendered.every((p, i) => p.seq === mappable[i].seq),
    'pins carry the trace order, ascending by PTS-derived timestamp',
  );
  check(
    rendered.every((p) => p.label === String(p.seq)),
    'every pin is labelled with its position in the route',
  );
  check(
    rendered.every((p) => typeof p.name === 'string' && p.name.length > 0),
    'every pin carries its camera name',
  );
  check(
    new Set(rendered.map((p) => p.method)).size > 1,
    'the fixture route exercises more than one link method, so exact and fuzzy are distinguishable',
  );

  const paint = await cdp.evaluate(`JSON.stringify({
    dash: window.__saakshiTraceMap.getPaintProperty('trace-path', 'line-dasharray'),
    pinColour: window.__saakshiTraceMap.getPaintProperty('trace-pins', 'circle-color'),
    layers: window.__saakshiTraceMap.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('trace-')),
  })`);
  const style = JSON.parse(paint);
  check(
    Array.isArray(style.dash) && style.dash.length > 0,
    'the connecting order is dashed — it is inferred, not observed',
  );
  check(
    JSON.stringify(style.pinColour).includes('plate_fuzzy'),
    'pin colour is a match over the link method, so a fuzzy link is visually distinct',
  );
  check(
    style.layers.indexOf('trace-path') < style.layers.indexOf('trace-pins'),
    'the inferred line paints under the observed pins',
  );

  console.log('\nAC 3 — the timeline scrubber is synchronised to the map');

  const drag = async (fraction) => {
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="trace-scrubber"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(Math.round(Number(input.max) * ${String(fraction)})));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 900));
  };
  const highlighted = async () =>
    cdp.evaluate(`JSON.stringify(window.__saakshiTraceMap.getFilter('trace-selected'))`);
  const readout = async () =>
    cdp.evaluate(`document.querySelector('[data-testid="trace-timeline-readout"]').textContent`);

  // The end of the timeline is the last sighting *in time*, which on this fixture route is the one
  // on the unplaced camera. That is the interesting case, not an inconvenience: the selection must
  // still be made and named even when there is no pin to fly to.
  const lastSeq = payload.sightings[payload.sightings.length - 1].seq;
  await drag(1);
  await waitFor(cdp, `location.search.includes('seq=')`, { label: 'the scrubber updates the URL' });
  check(
    (await readout()).includes(`#${lastSeq}`),
    `the end of the timeline selects sighting ${lastSeq}`,
  );
  check(
    !payload.sightings[payload.sightings.length - 1].located,
    'and that sighting is on a camera with no coordinates, so the no-pin path is exercised',
  );

  // Now back to the start, which *is* mappable: the highlight and the map centre must both follow.
  const centreBefore = await cdp.evaluate('JSON.stringify(window.__saakshiTraceMap.getCenter())');
  await drag(0);
  const firstSeq = mappable[0].seq;
  check(
    (await highlighted()).includes(String(firstSeq)),
    `scrubbing to the start highlights sighting ${firstSeq} on the map`,
  );
  check(
    (await cdp.evaluate('JSON.stringify(window.__saakshiTraceMap.getCenter())')) !== centreBefore,
    'the map moved to the selected sighting',
  );
  check(
    (await readout()).includes(`#${firstSeq}`),
    'the timeline readout names the selected sighting',
  );
  check(
    (await cdp.evaluate('location.search')).includes(`seq=${String(firstSeq)}`),
    'the selection is in the URL, so a shared link restores the same screen',
  );

  console.log('\nAC 4 — the evidence strip, in chronological order');

  const strip = await cdp.evaluate(`JSON.stringify(
    [...document.querySelectorAll('[data-testid="evidence-list"] li')].map((li) => Number(li.dataset.seq)))`);
  const stripOrder = JSON.parse(strip);
  check(
    stripOrder.length === payload.sightings.length,
    `one tile per sighting, mappable or not (${stripOrder.length})`,
  );
  check(
    stripOrder.every((seq, i) => seq === payload.sightings[i].seq),
    'tiles are in the order the API returned, which is chronological by PTS',
  );

  const images = await cdp.evaluate(`JSON.stringify(
    [...document.querySelectorAll('[data-testid="evidence-list"] img')]
      .map((img) => ({ complete: img.complete, w: img.naturalWidth })))`);
  const loaded = JSON.parse(images).filter((i) => i.complete && i.w > 0);
  check(
    loaded.length > 0,
    `evidence crops actually load (${loaded.length} of ${stripOrder.length})`,
  );

  console.log('\nHonesty — the claims are on screen, not in a footnote');

  const claims = await cdp.evaluate(
    `document.querySelector('[data-testid="trace-claims"]').textContent`,
  );
  check(claims.includes('Observed'), 'the observed claim is rendered above the result');
  check(claims.includes('Inferred'), 'the inferred claim is rendered above the result');
  const coverage = await cdp.evaluate(
    `document.querySelector('[data-testid="trace-coverage"]').textContent`,
  );
  check(
    coverage.includes('mappable'),
    'the coverage line states how much of the trace can be mapped',
  );
  check(coverage.includes('fuzzy'), 'the coverage line states how many links are fuzzy');

  console.log('\nAC 6 — the degenerate case');
  await navigate(cdp, `${base}/trace?plate=${PLATE}&min_confidence=0.85`);
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="trace-table"], .border-dashed') !== null`,
    {
      label: 'the filtered trace renders',
    },
  );
  const single = await cdp.evaluate(
    `document.querySelectorAll('[data-testid="trace-table"] tbody tr').length`,
  );
  check(single === 1, `a confidence floor of 0.85 leaves exactly one sighting (${single})`);
  const segments = await cdp.evaluate(
    `document.querySelector('[data-testid="trace-table"] tbody tr:last-child td:last-child').textContent.trim()`,
  );
  check(segments === '—', 'a single-sighting trace draws no segment');

  console.log('\nScreenshot');
  await navigate(cdp, `${base}/trace?plate=${PLATE}&seq=3`);
  await waitFor(cdp, TRACE_MAP_READY, { label: 'trace map ready' });
  await waitFor(cdp, 'window.__saakshiTraceMapIdle === true', { label: 'trace map idle' });
  await new Promise((r) => setTimeout(r, 1200));
  const file = await screenshot(cdp, path.join(SHOTS, 'trace.png'));
  pass(`captured ${file}`);

  const errors = await cdp.evaluate('JSON.stringify(window.__saakshiTraceMapErrors ?? [])');
  check(JSON.parse(errors).length === 0, `the map reported no errors (${errors})`);
} finally {
  await cdp.close();
}
