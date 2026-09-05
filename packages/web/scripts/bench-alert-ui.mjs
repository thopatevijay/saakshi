/**
 * `npm run bench:alert-ui` — D2-07 AC 9: "500 alerts render without jank (virtualised list)".
 *
 * ## What "without jank" is taken to mean, precisely
 *
 * Three numbers, because "jank" on its own is not falsifiable:
 *
 *   **1 · DOM nodes.** A virtualised list of 500 rows must put *tens* of rows in the document, not
 *   500. This is the criterion — the other two follow from it. Measured as
 *   `document.querySelectorAll('[data-testid="alert-row"]').length`, and the check is that it stays
 *   under 60 while the scroll height still accounts for all 500.
 *
 *   **2 · Long tasks.** A `PerformanceObserver` on `longtask` for the whole run. A long task is
 *   >50 ms on the main thread, so any of them is a stall an operator would feel.
 *
 *   **3 · Frame intervals.** The scroll runs *inside the page*, one step per `requestAnimationFrame`,
 *   recording the interval between frames. An interval over 33 ms means a 60 Hz frame was missed —
 *   that is the dropped-frame count, measured rather than inferred, and it cross-checks the
 *   long-task census. Driving the scroll from Node instead would measure the harness: `waitFor`
 *   polls every 200 ms, and the first version of this script duly reported a 209 ms p95 against a
 *   17 ms p50, which was a poll interval wearing a performance number's clothes.
 *
 * ## The 500 rows are cloned from real alerts, not invented
 *
 * The measured estate produces **7** alerts, so 500 has to be synthesised. Rather than invent 500
 * plausible-looking alerts — which would put 500 fabricated identifications in a database that
 * other tickets measure — the seeder **clones the existing rows' own `reason` payloads** under a
 * reserved `BENCH-ALERTUI-` dedupe prefix, with fresh ids and staggered timestamps. Every row it
 * writes is therefore structurally exactly what the engine produces, is unmistakably a benchmark
 * fixture, and is deleted at the end unless `BENCH_KEEP=1`.
 *
 * If there are no real alerts to clone, it says so and stops rather than making some up.
 *
 *   DATABASE_URL=… npm run bench:alert-ui
 *   DATABASE_URL=… node scripts/bench-alert-ui.mjs [token-file] [base-url] [api-url] [rows]
 *
 * With no token file it signs in as the seeded operator, so the bare command in the ticket's
 * validation gate works as written.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openBrowser, authenticate, navigate, waitFor, check, pass } from './cdp.mjs';

const tokenFile = process.argv[2];
const base = process.argv[3] ?? 'http://localhost:3100';
const api = process.argv[4] ?? 'http://localhost:4100';
const target = Number(process.argv[5] ?? 500);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required — this script seeds and cleans up');

/**
 * A session, without making the caller fetch one first.
 *
 * The ticket's validation gate is the bare command `npm run bench:alert-ui`, so it has to work with
 * no arguments. When no token file is given it signs in as the seeded control-room operator — the
 * same badge and dev password `docs/rbac.md` documents and `db/migrations/0009_seed.up.sql`
 * creates. No secret is introduced: both are already in the repository, and both are overridable
 * with `BENCH_BADGE` / `BENCH_PASSWORD` for an estate that seeded different ones.
 */
async function session() {
  if (tokenFile !== undefined) return readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      badgeNo: process.env.BENCH_BADGE ?? 'GP-OPR-1042',
      password: process.env.BENCH_PASSWORD ?? 'saakshi-dev',
    }),
  });
  if (!response.ok) {
    throw new Error(
      `could not sign in at ${api} (HTTP ${String(response.status)}). Pass a token file as the ` +
        'first argument, or set BENCH_BADGE / BENCH_PASSWORD.',
    );
  }
  const body = await response.json();
  return body.token;
}

const token = await session();

const PREFIX = 'BENCH-ALERTUI-';
const KEEP = process.env.BENCH_KEEP === '1';
/** A long task is >50 ms on the main thread — a dropped frame at 60 Hz, by definition. */
const LONG_TASK_MS = 50;
/** A virtualised 500-row list must hold tens of rows, not hundreds. */
const MAX_DOM_ROWS = 60;

const psql = (query) =>
  execFileSync('psql', [databaseUrl, '-tAc', query], { encoding: 'utf8' }).trim();

const benchCount = () =>
  Number(psql(`select count(*) from alerts where dedupe_key like '${PREFIX}%'`));
const realCount = () =>
  Number(psql(`select count(*) from alerts where dedupe_key not like '${PREFIX}%'`));

/**
 * Clone the real alerts up to `target`.
 *
 * `generate_series` in one statement: five hundred round trips from Node would benchmark Node. The
 * `reason` payload, severity, match type, distance and confidence come from a real row each time,
 * so every synthetic alert renders through exactly the same code paths as a measured one.
 */
function seed(to) {
  const existing = benchCount();
  if (existing >= to) {
    console.log(`  already at ${String(existing)} benchmark alerts`);
    return;
  }
  const real = realCount();
  if (real === 0) {
    throw new Error(
      'no real alerts to clone — run `npm run demo:alerts -w packages/api -- --seed` first. ' +
        'This script will not invent alert payloads.',
    );
  }
  const wanted = to - existing;
  console.log(`  cloning ${String(real)} real alerts into ${String(wanted)} benchmark rows…`);
  const started = Date.now();
  psql(`
    insert into alerts (watchlist_entry_id, sighting_id, sighting_ts, camera_id, ts, match_type,
                        match_distance, confidence, severity, reason, dedupe_key,
                        dedupe_window_start, last_seen_at, last_sighting_id, last_sighting_ts,
                        sighting_count, last_observed_plate, status)
    select a.watchlist_entry_id, a.sighting_id, a.sighting_ts, a.camera_id,
           a.ts - (g || ' seconds')::interval,
           a.match_type, a.match_distance, a.confidence, a.severity, a.reason,
           '${PREFIX}' || lpad(g::text, 6, '0'),
           a.dedupe_window_start - (g || ' seconds')::interval,
           a.last_seen_at - (g || ' seconds')::interval,
           a.last_sighting_id, a.last_sighting_ts,
           1 + (g % 7), a.last_observed_plate, 'new'
      from generate_series(1, ${String(wanted)}) g
      cross join lateral (
        select * from alerts where dedupe_key not like '${PREFIX}%'
         order by id offset (g % ${String(real)}) limit 1
      ) a
    on conflict do nothing`);
  console.log(
    `  seeded in ${String(((Date.now() - started) / 1000).toFixed(1))} s → ${String(benchCount())} benchmark alerts`,
  );
}

function cleanup() {
  const removed = psql(
    `with d as (delete from alerts where dedupe_key like '${PREFIX}%' returning 1) select count(*) from d`,
  );
  console.log(`  removed ${removed} benchmark alerts → ${String(realCount())} real ones remain`);
}

console.log(`\nAC 9 · ${String(target)} alerts in the queue, virtualised\n`);
console.log(`  database ${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`);
console.log(`  real alerts before: ${String(realCount())}`);
seed(target);

let result;
const cdp = await openBrowser({ width: 1680, height: 1050 });
try {
  await authenticate(cdp, token, 'operator', base);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const started = Date.now();
  await navigate(cdp, `${base}/alerts?sort=recent&limit=200`, { timeoutMs: 120000 });
  await waitFor(
    cdp,
    `(() => { const r = document.querySelector('[data-testid="alert-row"]'); return r !== null && r.getBoundingClientRect().height > 0; })()`,
    { timeoutMs: 120000, label: 'the first row to lay out' },
  );
  const firstRowMs = Date.now() - started;

  // Page in the rest of the queue: `limit` caps a page at 200, so 500 needs the cursor followed.
  await cdp.evaluate(`window.__benchLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__benchLongTasks.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'] });`);

  for (let page = 0; page < 4; page += 1) {
    const more = await cdp.evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Load more'); if (b === undefined) return false; b.click(); return true; })()`,
    );
    if (!more) break;
    await new Promise((r) => setTimeout(r, 1200));
  }

  const loaded = await cdp.evaluate(
    `Number(document.querySelector('[data-testid="alert-count"]').textContent.match(/^(\\d+)/)[1])`,
  );

  /* ── the scripted scroll ────────────────────────────────────────────────────────────────── */

  /**
   * Scroll top to bottom **one step per animation frame**, inside the page.
   *
   * The first draft of this drove the scroll from Node and timed how long the rendered slice took
   * to catch up. That measured the harness: `waitFor` polls every 200 ms, so anything slower than
   * one tick reported as ~205 ms and the p95 was 209 ms against a p50 of 17 ms — a bimodal
   * distribution that is a poll interval, not jank. Frame intervals are the thing the criterion is
   * actually about, and only the page can see them.
   *
   * A frame interval over 33 ms means a 60 Hz frame was missed. That is the dropped-frame count,
   * measured rather than inferred, and it is cross-checked against the `longtask` census.
   */
  const steps = 120;
  const scrollStarted = Date.now();
  const scroll = await cdp
    .evaluate(
      `new Promise((resolve) => {
    const vp = document.querySelector('[data-testid="alert-viewport"]');
    const max = vp.scrollHeight - vp.clientHeight;
    const intervals = [];
    const rows = [];
    let i = 0;
    let last = performance.now();
    const step = (now) => {
      if (i > 0) intervals.push(Math.round((now - last) * 10) / 10);
      last = now;
      vp.scrollTop = Math.round((max * i) / ${String(steps)});
      rows.push(document.querySelectorAll('[data-testid="alert-row"]').length);
      i += 1;
      if (i <= ${String(steps)}) requestAnimationFrame(step);
      else resolve(JSON.stringify({ intervals, rows, finalScrollTop: vp.scrollTop, max }));
    };
    requestAnimationFrame(step);
  })`,
    )
    .then(JSON.parse);
  const scrollMs = Date.now() - scrollStarted;

  const latencies = scroll.intervals;
  const domRows = scroll.rows;
  const dropped = latencies.filter((ms) => ms > 33);

  const longTasks = await cdp.evaluate(`JSON.stringify(window.__benchLongTasks)`).then(JSON.parse);
  const geometry = await cdp
    .evaluate(
      `JSON.stringify((() => {
        const vp = document.querySelector('[data-testid="alert-viewport"]');
        return { scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight };
      })())`,
    )
    .then(JSON.parse);

  const sorted = [...latencies].sort((a, b) => a - b);
  result = {
    loaded,
    firstRowMs,
    scrollMs,
    steps,
    maxDomRows: Math.max(...domRows),
    minDomRows: Math.min(...domRows),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    worst: sorted[sorted.length - 1],
    dropped,
    reachedBottom: scroll.finalScrollTop >= scroll.max - 2,
    longTasks: longTasks.filter((d) => d >= LONG_TASK_MS),
    geometry,
  };
} finally {
  await cdp.close();
  if (!KEEP) cleanup();
  else console.log('  BENCH_KEEP=1 — benchmark alerts left in place');
}

console.log('');
console.log('─'.repeat(84));
console.log(`  alerts in the queue          ${String(result.loaded)}`);
console.log(
  `  rows in the DOM              ${String(result.minDomRows)}–${String(result.maxDomRows)}`,
);
console.log(
  `  scroll height / viewport     ${String(result.geometry.scrollHeight)} px / ${String(result.geometry.clientHeight)} px`,
);
console.log(`  first row laid out           ${String(result.firstRowMs)} ms`);
console.log(
  `  scroll top→bottom            ${String(result.steps)} frames in ${String(result.scrollMs)} ms`,
);
console.log(
  `  frame interval               p50 ${String(result.p50)} ms · p95 ${String(result.p95)} ms · worst ${String(result.worst)} ms`,
);
console.log(
  `  dropped frames (>33 ms)      ${String(result.dropped.length)} of ${String(result.steps - 1)}${
    result.dropped.length === 0 ? '' : ` — ${result.dropped.join(', ')} ms`
  }`,
);
console.log(
  `  long tasks (>${String(LONG_TASK_MS)} ms)          ${String(result.longTasks.length)}${
    result.longTasks.length === 0 ? '' : ` — ${result.longTasks.join(', ')} ms`
  }`,
);
console.log('─'.repeat(84));
console.log('');

check(
  result.loaded >= target,
  `the queue actually holds ${String(target)} alerts (${String(result.loaded)})`,
);
check(
  result.maxDomRows <= MAX_DOM_ROWS,
  `the list is virtualised — never more than ${String(MAX_DOM_ROWS)} rows in the DOM (peak ${String(result.maxDomRows)})`,
);
check(
  result.geometry.scrollHeight > result.loaded * 90,
  `the scroll height still accounts for every alert (${String(result.geometry.scrollHeight)} px)`,
);
check(result.reachedBottom, 'the scroll actually reached the bottom of the queue');
check(
  result.longTasks.length === 0,
  `no long task over ${String(LONG_TASK_MS)} ms while scrolling top to bottom`,
);
check(
  result.dropped.length === 0,
  `no dropped frames — every one of ${String(result.steps - 1)} intervals under 33 ms (worst ${String(result.worst)} ms)`,
);

if (process.exitCode === undefined || process.exitCode === 0) {
  pass(`${String(target)} alerts render without jank`);
}
