/**
 * AC 9 — "Benchmark: dashboard load < 3 s, measured cold on the 100k fixture and recorded."
 *
 * The ticket calls UI/UX "a significant evaluation factor", so this number is scored — which is
 * exactly why it is a committed script rather than a figure pasted into a PR once. Anybody can
 * re-run it, on any machine, and get a number they can argue with.
 *
 * ## What "cold" means here, precisely
 *
 * A fresh browser profile per run, HTTP cache disabled, and a first navigation — so nothing is
 * warm: no service worker, no cached chunks, no cached tiles, no warmed Next route. The one thing
 * deliberately *not* reset is the API's Postgres connection pool and page cache, because a police
 * console is a long-running server and benchmarking a cold database measures the deploy, not the
 * product.
 *
 * ## What is measured
 *
 *   TTFB          the server's own work: session check, the first page of cameras, HTML
 *   FCP           the first pixel of the shell
 *   DOMContentLoaded / load
 *   map idle      MapLibre has fetched, parsed and drawn every tile in the viewport
 *
 * "Dashboard load" is taken as **load event** — the screen is readable and interactive there. The
 * map-idle figure is reported alongside, because a map that is still drawing at 4 s is a different
 * claim from a page that is still blank at 4 s, and conflating them would flatter us.
 *
 *   DATABASE_URL=… node scripts/bench-dashboard.mjs <token-file> [base-url] [target-rows]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { authenticate, check, navigate, openBrowser, waitFor } from './cdp.mjs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const base = process.argv[3] ?? 'http://localhost:3100';
const target = Number(process.argv[4] ?? 100000);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required — this script seeds and cleans up');

const BENCH_PREFIX = 'BENCH-';
const TARGET_MS = 3000;
const RUNS = 3;

const psql = (query) =>
  execFileSync('psql', [databaseUrl, '-tAc', query], { encoding: 'utf8' }).trim();

const rowCount = () => Number(psql('select count(*) from cameras where deleted_at is null'));

/**
 * Seed synthetic cameras up to `target`.
 *
 * Coordinates are spread across the Gujarat bounding box rather than stacked on one point: a
 * hundred thousand pins at identical coordinates cluster into a single feature and would benchmark
 * nothing. `generate_series` in one statement, because a hundred thousand round trips from Node
 * would measure Node.
 */
function seed(to) {
  const existing = rowCount();
  if (existing >= to) {
    console.log(`  already at ${String(existing)} cameras`);
    return;
  }
  const wanted = to - existing;
  console.log(`  seeding ${String(wanted)} synthetic cameras…`);
  const started = Date.now();
  psql(`
    insert into cameras (external_id, name, location, district, camera_type, mount,
                         geometry_class, adapter_kind, endpoints, trust_score)
    select
      '${BENCH_PREFIX}' || lpad(g::text, 7, '0'),
      'Synthetic bench camera ' || g,
      st_setsrid(st_makepoint(
        68.2 + (random() * 6.2),
        20.1 + (random() * 4.5)), 4326)::geography,
      (array['Ahmedabad','Surat','Rajkot','Vadodara','Bhuj','Jamnagar'])[1 + (g % 6)],
      (array['ip','analog']::camera_type[])[1 + (g % 2)],
      'static'::camera_mount,
      'unclassified'::camera_geometry,
      (array['hls','rtsp','onvif']::adapter_kind[])[1 + (g % 3)],
      '{}'::jsonb,
      case when g % 4 = 0 then null else round((random() * 100)::numeric, 2) end
    from generate_series(1, ${String(wanted)}) g
    on conflict do nothing`);
  console.log(
    `  seeded in ${String(((Date.now() - started) / 1000).toFixed(1))} s → ${String(rowCount())} cameras`,
  );
}

function cleanup() {
  const removed = psql(
    `with d as (delete from cameras where external_id like '${BENCH_PREFIX}%' returning 1)
     select count(*) from d`,
  );
  console.log(`  removed ${removed} synthetic cameras → ${String(rowCount())} remain`);
}

/** One cold load. Fresh browser, cache off. */
async function coldLoad() {
  const cdp = await openBrowser();
  await authenticate(cdp, token, 'admin', base);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const started = Date.now();
  await navigate(cdp, `${base}/registry`, { timeoutMs: 120000 });
  const loadMs = Date.now() - started;

  await waitFor(cdp, 'window.__saakshiMapIdle === true', {
    timeoutMs: 120000,
    label: 'the map to finish drawing',
  });
  const mapIdleMs = Date.now() - started;

  const timing = await cdp.evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return JSON.stringify({
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      transferredKb: Math.round(
        performance.getEntriesByType('resource').reduce((n, r) => n + r.transferSize, 0) / 1024,
      ),
      cameras: Number(document.querySelector('[data-count="total"]')?.textContent ?? 0),
    });
  })()`).then(JSON.parse);

  await cdp.close();
  return { ...timing, wallLoad: loadMs, mapIdle: mapIdleMs };
}

console.log(`\nAC 9 · cold dashboard load on ${String(target)} cameras\n`);

const original = rowCount();
console.log(`  registry starts at ${String(original)} cameras`);
seed(target);

const results = [];
for (let run = 1; run <= RUNS; run += 1) {
  const r = await coldLoad();
  results.push(r);
  console.log(
    `  run ${String(run)}  ttfb ${String(r.ttfb).padStart(5)} ms · fcp ${String(r.fcp).padStart(5)} ms · dcl ${String(r.domContentLoaded).padStart(5)} ms · ` +
      `load ${String(r.load).padStart(5)} ms · map idle ${String(r.mapIdle).padStart(5)} ms · ${String(r.transferredKb)} kB · ${String(r.cameras)} cameras drawn`,
  );
}

const median = (key) => {
  const sorted = results.map((r) => r[key]).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const medianLoad = median('load');
const medianIdle = median('mapIdle');

console.log(
  `\n  median over ${String(RUNS)} cold runs: TTFB ${String(median('ttfb'))} ms · FCP ${String(median('fcp'))} ms · ` +
    `load ${String(medianLoad)} ms · map idle ${String(medianIdle)} ms`,
);

check(
  medianLoad < TARGET_MS,
  `dashboard load ${String(medianLoad)} ms is under the ${String(TARGET_MS)} ms target on ${String(rowCount())} cameras`,
);
console.log(
  `  (the map finishes drawing at ${String(medianIdle)} ms; reported separately rather than folded into the headline)`,
);

console.log('\n  cleaning up');
cleanup();
console.log('');
