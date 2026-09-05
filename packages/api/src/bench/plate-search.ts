/**
 * Fuzzy plate search benchmark (D2-04, AC 7).
 *
 * The stated target is **p95 < 500 ms at demo data volume**, measured rather than asserted. "Demo
 * data volume" is defined here as 250,000 sightings carrying 250,000 plate reads across 40 cameras
 * and 30 days — an order of magnitude more than the 5-minute 8-camera live run produces, so the
 * number is a ceiling rather than a flattering best case.
 *
 * It also measures the thing a fuzzy matcher is actually judged on: **what widening the distance
 * budget costs**. The sweep prints candidate counts and latency at each `max_distance`, so the
 * operating point in `docs/fuzzy-matching.md` §6 comes from this output and not from taste.
 *
 * Run:  npm run bench:plate-search
 *       BENCH_ROWS=500000 npm run bench:plate-search
 *       BENCH_SKIP_SEED=1 npm run bench:plate-search
 *
 * Seeded rows are tagged `BENCH-PS-` and are dropped by `BENCH_CLEAN=1`.
 */
import autocannon from 'autocannon';
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { buildServer } from '../server.js';
import { PlateSearchService } from '../services/plate-search.js';

const TARGET_ROWS = Number(process.env['BENCH_ROWS'] ?? 250_000);
const CAMERAS = 40;
const P95_TARGET_MS = 500;
/**
 * Four, not five hundred.
 *
 * "p95 < 500 ms" is a **latency** target and "N concurrent users" is a **throughput** one, and
 * reporting one as the other is how a benchmark lies (the same rule `bench/api.ts` states). Four is
 * a realistic number of control-room operators running a plate search at the same instant. The
 * sweep at the end of this run says where latency actually degrades, so the headline number cannot
 * be mistaken for a saturation claim.
 */
const CONCURRENCY = Number(process.env['BENCH_CONNECTIONS'] ?? 4);
const SWEEP = [1, 4, 8, 16, 32];
const DURATION_S = Number(process.env['BENCH_DURATION'] ?? 5);
const PORT = Number(process.env['BENCH_PORT'] ?? 4110);
const TAG = 'BENCH-PS-';

const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
const rawSql = createSql(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(rawSql);

/** A plate the seeder is guaranteed to have written, so the benchmark measures a real hit path. */
const EXACT_QUERY = 'GJ01AB1234';
/** The same plate two characters short — the estate's dominant failure, and the expensive path. */
const TRUNCATED_QUERY = 'GJ01AB12';
/** A registration from a state the seeder never writes: the empty-result path. */
const MISS_QUERY = 'KL07CD9911';

async function countReads(): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from plate_reads where crop_uri like ${`${TAG}%`}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Seeds in one `generate_series` pass rather than through the worker.
 *
 * The thing under test is read latency at scale; spending an hour producing rows the honest way
 * measures the producer, not the index. Plates are generated over a realistic alphabet so the
 * trigram index sees a realistic distribution rather than 250,000 copies of one string.
 */
async function seed(target: number): Promise<void> {
  const existing = await countReads();
  if (existing >= target) {
    console.log(`  already ${existing.toLocaleString('en-IN')} tagged plate reads — no seeding`);
    return;
  }

  console.log(`  seeding ${(target - existing).toLocaleString('en-IN')} sightings + plate reads…`);
  const started = Date.now();

  await db.execute(sql`
    insert into cameras (external_id, name, adapter_kind, endpoints)
    select ${TAG} || lpad(g::text, 3, '0'), 'Bench camera ' || g, 'hls', '{}'::jsonb
      from generate_series(1, ${CAMERAS}) g
     where not exists (select 1 from cameras where external_id = ${TAG} || lpad(g::text, 3, '0'))
  `);

  await db.execute(sql`
    with cams as (
      select id, row_number() over (order by external_id) - 1 as n
        from cameras where external_id like ${`${TAG}%`}
    ),
    gen as (
      select g,
             (select id from cams where n = g % ${CAMERAS}) as camera_id,
             now() - ((g % 2592000) || ' seconds')::interval as ts,
             -- A realistic Gujarat-heavy plate distribution: 34 RTOs, 26x26 series, 10k numbers.
             'GJ' || lpad((g % 34 + 1)::text, 2, '0')
                  || chr(65 + (g / 34) % 26) || chr(65 + (g / 884) % 26)
                  || lpad((g % 10000)::text, 4, '0') as plate
        from generate_series(1, ${target - existing}) g
    ),
    ins as (
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
      select camera_id, ts, (g * 40)::bigint, g, 'car',
             '{"x":0,"y":0,"w":80,"h":40}'::jsonb, 0.850
        from gen
      returning id, ts, track_id
    )
    insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri)
    select ins.id, ins.ts, gen.plate, gen.plate, 0.550, 3, ${TAG} || ins.track_id::text
      from ins join gen on gen.g = ins.track_id
  `);

  // The one row the exact-match scenario depends on, written explicitly rather than hoped for.
  await db.execute(sql`
    with c as (select id from cameras where external_id like ${`${TAG}%`} limit 1),
    s as (
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
      select c.id, now() - interval '1 hour', 0, -1, 'car', '{"x":0,"y":0,"w":80,"h":40}'::jsonb, 0.900
        from c returning id, ts
    )
    insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri)
    select s.id, s.ts, ${EXACT_QUERY}, ${EXACT_QUERY}, 0.700, 5, ${`${TAG}anchor`} from s
  `);

  console.log(`  seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

async function clean(): Promise<void> {
  await db.execute(sql`delete from plate_reads where crop_uri like ${`${TAG}%`}`);
  await db.execute(
    sql`delete from sightings where camera_id in (select id from cameras where external_id like ${`${TAG}%`})`,
  );
  await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  console.log('  bench rows removed');
}

interface Result {
  name: string;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  non2xx: number;
}

async function run(
  name: string,
  path: string,
  token: string,
  connections = CONCURRENCY,
): Promise<Result> {
  const result = await autocannon({
    url: `http://127.0.0.1:${String(PORT)}${path}`,
    connections,
    duration: DURATION_S,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    name,
    p50: result.latency.p50,
    p95: result.latency.p97_5,
    p99: result.latency.p99,
    rps: Math.round(result.requests.average),
    non2xx: result.non2xx,
  };
}

async function main(): Promise<void> {
  console.log('SAAKSHI fuzzy plate search benchmark (D2-04)\n');

  if (process.env['BENCH_CLEAN'] === '1') {
    await clean();
    await rawSql.end();
    return;
  }

  if (process.env['BENCH_SKIP_SEED'] !== '1') await seed(TARGET_ROWS);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from plate_reads`);
  console.log(`  corpus: ${Number(total[0]?.n ?? 0).toLocaleString('en-IN')} plate reads\n`);

  const app = await buildServer({ env, db });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  // A *real* seeded operator. `authenticate()` checks the subject against `users` and answers 401
  // for an unknown one, so a hand-minted uuid makes every request a 401 and the benchmark then
  // reports the latency of the auth rejection rather than of the search. Refuse rather than
  // publish that number — see the `non-2xx` column, which must stay at 0.
  const operator = await db.execute<{ id: string }>(
    sql`select id::text as id from users where role = 'operator' and active limit 1`,
  );
  const sub = operator[0]?.id;
  if (sub === undefined) {
    throw new Error('no active operator user — run `npm run db:migrate` so migration 0009 seeds one');
  }
  const token = app.jwt.sign({ sub, badgeNo: 'BENCH-0001', role: 'operator', departmentId: null });

  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const scenarios: [string, string][] = [
    ['exact', `/api/v1/plates/search?q=${EXACT_QUERY}&max_distance=0`],
    ['fuzzy d=1', `/api/v1/plates/search?q=${EXACT_QUERY}&max_distance=1`],
    ['fuzzy d=2', `/api/v1/plates/search?q=${EXACT_QUERY}&max_distance=2`],
    ['truncated d=2', `/api/v1/plates/search?q=${TRUNCATED_QUERY}&max_distance=2`],
    ['miss d=2', `/api/v1/plates/search?q=${MISS_QUERY}&max_distance=2`],
    [
      'fuzzy d=2 + 7-day window',
      `/api/v1/plates/search?q=${EXACT_QUERY}&max_distance=2&from=${encodeURIComponent(from)}`,
    ],
  ];

  const results: Result[] = [];
  console.log('scenario                      p50     p95     p99     rps    non-2xx');
  for (const [name, path] of scenarios) {
    const r = await run(name, path, token);
    results.push(r);
    console.log(
      `${name.padEnd(26)} ${String(r.p50).padStart(5)}ms ${String(r.p95).padStart(5)}ms ` +
        `${String(r.p99).padStart(5)}ms ${String(r.rps).padStart(6)} ${String(r.non2xx).padStart(8)}`,
    );
  }

  // What widening costs: candidates returned per distance budget, single-shot rather than under
  // load, because this is a precision question and not a latency one.
  console.log('\nwidening cost — candidates returned per max_distance (single query)');
  const service = new PlateSearchService(db);
  for (const d of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]) {
    const started = Date.now();
    const result = await service.search(TRUNCATED_QUERY, { maxDistance: d, limit: 100 });
    console.log(
      `  max_distance ${String(d).padEnd(4)} → ${String(result.candidates.length).padStart(4)} candidates in ${String(Date.now() - started).padStart(5)} ms`,
    );
  }

  // Where latency actually degrades. Reported rather than hidden, so the headline p95 above cannot
  // be read as a concurrency claim it does not make.
  const worstPath = scenarios.find(([n]) => n === 'truncated d=2')?.[1] ?? scenarios[0]?.[1] ?? '';
  console.log('\nconcurrency sweep on the slowest scenario (truncated d=2)');
  for (const connections of SWEEP) {
    const r = await run('sweep', worstPath, token, connections);
    console.log(
      `  ${String(connections).padStart(3)} conns → p50 ${String(r.p50).padStart(5)}ms · ` +
        `p95 ${String(r.p95).padStart(5)}ms · ${String(r.rps).padStart(5)} rps` +
        (r.p95 < P95_TARGET_MS ? '' : '   ← over target'),
    );
  }

  const rejected = results.reduce((n, r) => n + r.non2xx, 0);
  if (rejected > 0) {
    throw new Error(
      `${String(rejected)} non-2xx responses — the measurement is of the error path, not the search`,
    );
  }

  const worst = results.reduce((a, b) => (a.p95 > b.p95 ? a : b));
  console.log(
    `\nworst p95: ${String(worst.p95)} ms on "${worst.name}" — target ${String(P95_TARGET_MS)} ms — ` +
      (worst.p95 < P95_TARGET_MS ? 'PASS' : 'FAIL'),
  );
  console.log(`(${String(CONCURRENCY)} connections · ${String(DURATION_S)} s per scenario)`);

  await app.close();
  await rawSql.end();
  if (worst.p95 >= P95_TARGET_MS) process.exitCode = 1;
}

await main();
