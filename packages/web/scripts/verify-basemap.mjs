/**
 * AC 2 — "Basemap loads entirely from the local PMTiles file: the network tab shows zero external
 * tile requests."
 *
 * This *is* the network tab, read by a machine. Every `Network.requestWillBeSent` over a full
 * load, a zoom in and a pan is captured, grouped by host, and anything that is not this app's own
 * origin fails the run. The style is also audited statically by
 * `src/lib/registry/basemap-style.test.ts`; that catches a URL nobody requested, this catches a
 * request nobody put in the style — a font fallback, a sprite, a telemetry ping from a dependency.
 *
 *   node scripts/verify-basemap.mjs <token-file> [base-url]
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

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const ownHost = new URL(base).host;

const cdp = await openBrowser();
await authenticate(cdp, token, 'admin', base);

const requests = [];
cdp.on('Network.requestWillBeSent', ({ request, type }) => {
  requests.push({ url: request.url, type, method: request.method });
});

console.log('\nAC 2 · the basemap is served entirely by this app\n');

await navigate(cdp, `${base}/registry`);
await waitFor(cdp, MAP_READY, { timeoutMs: 60000, label: 'the map to load its style' });
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'the map to go idle' });

// Zoom in and pan, so the tile pyramid is actually walked rather than one tile fetched. A run that
// never moves proves only that the first tile came from the right place.
await cdp.evaluate(
  `window.__saakshiMap.jumpTo({ center: [72.5714, 23.0225], zoom: 11 }); true`,
);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle after zooming to Ahmedabad' });
await cdp.evaluate(`window.__saakshiMap.jumpTo({ center: [72.8311, 21.1702], zoom: 10 }); true`);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle after panning to Surat' });
await cdp.evaluate(`window.__saakshiMap.jumpTo({ center: [70.8, 22.3], zoom: 8 }); true`);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle after panning to Rajkot' });

const byHost = new Map();
for (const request of requests) {
  if (request.url.startsWith('data:') || request.url.startsWith('blob:')) continue;
  const host = new URL(request.url).host;
  byHost.set(host, (byHost.get(host) ?? 0) + 1);
}

console.log(`  ${String(requests.length)} requests over load + 3 viewport changes`);
for (const [host, count] of [...byHost].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${host.padEnd(28)} ${String(count).padStart(4)}`);
}

const external = [...byHost.keys()].filter((host) => host !== ownHost);
check(
  external.length === 0,
  external.length === 0
    ? `every request went to ${ownHost} — no external host was contacted`
    : `external hosts contacted: ${external.join(', ')}`,
);

// The requests that actually carried the map, named, so the evidence says *what* was served
// locally rather than only that nothing external was.
const basemapRequests = requests.filter((r) => r.url.includes('/basemap/'));
const tiles = basemapRequests.filter((r) => r.url.includes('.pmtiles'));
const glyphs = basemapRequests.filter((r) => r.url.includes('.pbf'));
console.log(
  `  ${String(tiles.length)} range reads against /basemap/gujarat.pmtiles · ${String(glyphs.length)} glyph ranges`,
);
check(tiles.length > 0, 'the vector tiles came from this app’s own PMTiles route');
check(
  glyphs.length > 0,
  'the label glyphs came from this app too — MapLibre’s CDN default was overridden',
);

await cdp.evaluate(`window.__saakshiMap.jumpTo({ center: [71.7, 22.4], zoom: 6.2 }); true`);
await waitFor(cdp, 'window.__saakshiMapIdle === true', { label: 'idle back at the state view' });
await screenshot(cdp, path.join(SHOTS, 'd1-08-basemap.png'));

await cdp.close();
console.log('');
