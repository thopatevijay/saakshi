/**
 * Registry API benchmark.
 *
 * Three stated targets from D1-02, measured rather than asserted:
 *   1. p95 API response < 200 ms
 *   2. 500+ concurrent users without degradation
 *   3. 1,00,000+ camera records without pagination or query degradation
 *
 * Run:  npm run bench:api            (seeds to 100k if needed, then measures)
 *       BENCH_ROWS=250000 npm run bench:api
 *       BENCH_SKIP_SEED=1 npm run bench:api
 *
 * Seeds via one `generate_series` INSERT rather than 100k API calls: the thing under test is read
 * latency at scale, and spending twenty minutes on inserts to get there measures nothing useful.
 * The generated rows are tagged `BENCH-` so they can be dropped in one statement.
 */
import autocannon from 'autocannon';
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { buildServer } from '../server.js';

const TARGET_ROWS = Number(process.env['BENCH_ROWS'] ?? 100_000);
const P95_TARGET_MS = 200;
const CONCURRENCY = Number(process.env['BENCH_CONNECTIONS'] ?? 500);
const DURATION_S = Number(process.env['BENCH_DURATION'] ?? 10);
const PORT = Number(process.env['BENCH_PORT'] ?? 4100);

// NODE_ENV=test silences the request logger. Not cosmetic: at 37,000 req/s pino was writing
// ~370,000 log lines per scenario, and the measurement then reports the cost of stdout rather than
// the cost of the API. A production deployment logs to a transport, not to a benchmark's stdout.
const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
const rawSql = createSql(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(rawSql);

async function countCameras(): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from cameras where deleted_at is null`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function seed(target: number): Promise<void> {
  const existing = await countCameras();
  if (existing >= target) {
    console.log(`  already ${existing.toLocaleString('en-IN')} cameras — no seeding needed`);
    return;
  }

  const missing = target - existing;
  console.log(`  seeding ${missing.toLocaleString('en-IN')} cameras…`);
  const started = Date.now();

  // Spread over Gujarat's real bounding box (roughly 20.1–24.7 N, 68.2–74.5 E) so the bbox
  // benchmark exercises the GiST index against a realistic spatial distribution rather than
  // 100k points stacked on one coordinate.
  await db.execute(sql`
    insert into cameras (
      external_id, name, location, district, camera_type, mount, geometry_class,
      declared_codec, declared_fps, declared_resolution, adapter_kind, endpoints, status, trust_score
    )
    select
      'BENCH-' || g::text,
      'Bench Camera ' || g::text,
      st_setsrid(st_makepoint(68.2 + random() * 6.3, 20.1 + random() * 4.6), 4326)::geography,
      (array['Ahmedabad','Gandhinagar','Junagadh','Rajkot','Surat','Vadodara','Bhuj','Anand'])[1 + floor(random() * 8)],
      (array['ip','analog'])[1 + floor(random() * 2)]::camera_type,
      (array['static','mobile'])[1 + floor(random() * 2)]::camera_mount,
      (array['anpr_viable','detection_only','unclassified'])[1 + floor(random() * 3)]::camera_geometry,
      (array['h264','h265'])[1 + floor(random() * 2)],
      (array[30, 25, 20, 18, 12, 10])[1 + floor(random() * 6)],
      (array['1920x1080','854x480','1280x960','1280x720','960x576','640x480'])[1 + floor(random() * 6)],
      (array['hls','rtsp','onvif','whep','nvr'])[1 + floor(random() * 5)]::adapter_kind,
      '{}'::jsonb,
      (array['unknown','online','degraded','offline'])[1 + floor(random() * 4)]::camera_status,
      case when random() < 0.2 then null else round((random() * 100)::numeric, 2) end
    -- Explicit ::bigint casts: bound parameters arrive untyped, and generate_series has int/bigint/
    -- numeric/timestamp overloads, so Postgres refuses with "function generate_series(unknown,
    -- unknown) is not unique".
    from generate_series(${existing + 1}::bigint, ${existing + missing}::bigint) as g
    on conflict do nothing
  `);

  // ANALYZE, not optional: without fresh statistics the planner may choose a sequential scan over
  // the GiST index and the numbers would measure a stale plan rather than the schema.
  await db.execute(sql`analyze cameras`);
  console.log(`  seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

interface Scenario {
  name: string;
  path: string;
  connections: number;
}

interface Result extends Scenario {
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  non2xx: number;
  errors: number;
}

async function run(scenario: Scenario, token: string): Promise<Result> {
  const result = await autocannon({
    url: `http://127.0.0.1:${String(PORT)}${scenario.path}`,
    connections: scenario.connections,
    duration: DURATION_S,
    headers: { authorization: `Bearer ${token}` },
  });

  return {
    ...scenario,
    requests: result.requests.total,
    rps: Math.round(result.requests.average),
    p50: result.latency.p50,
    p95: result.latency.p97_5,
    p99: result.latency.p99,
    max: result.latency.max,
    non2xx: result.non2xx,
    errors: result.errors,
  };
}

async function main(): Promise<void> {
  console.log('SAAKSHI registry API benchmark\n');

  if (process.env['BENCH_SKIP_SEED'] !== '1') await seed(TARGET_ROWS);
  const rows = await countCameras();
  console.log(`  registry size: ${rows.toLocaleString('en-IN')} live cameras\n`);

  const app = await buildServer({ env, db });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  // An operator-role token: read-only, which is what every benchmarked path needs.
  const token = app.jwt.sign({
    sub: '00000000-0000-4000-8000-000000000001',
    badgeNo: 'BENCH-0001',
    role: 'operator',
    departmentId: null,
  });

  // A deep cursor, to prove pagination does not degrade with depth — the OFFSET failure mode.
  const deepPage = await app.inject({
    method: 'GET',
    url: '/api/v1/cameras?limit=500',
    headers: { authorization: `Bearer ${token}` },
  });
  const deepCursor = deepPage.json<{ nextCursor: string | null }>().nextCursor;

  const scenarios: Scenario[] = [
    { name: 'health', path: '/health', connections: CONCURRENCY },
    { name: 'list (50)', path: '/api/v1/cameras?limit=50', connections: CONCURRENCY },
    { name: 'list (500)', path: '/api/v1/cameras?limit=500', connections: 100 },
    {
      name: 'bbox (Ahmedabad)',
      path: '/api/v1/cameras?bbox=72.4,23.0,72.8,23.4&limit=50',
      connections: CONCURRENCY,
    },
    {
      name: 'filtered (adapter+trust)',
      path: '/api/v1/cameras?adapterKind=hls&trustMin=60&limit=50',
      connections: CONCURRENCY,
    },
    { name: 'departments', path: '/api/v1/departments', connections: CONCURRENCY },
  ];

  if (deepCursor !== null) {
    scenarios.push({
      name: 'deep cursor page',
      path: `/api/v1/cameras?limit=50&cursor=${encodeURIComponent(deepCursor)}`,
      connections: CONCURRENCY,
    });
  }

  const results: Result[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  running ${scenario.name} @ ${String(scenario.connections)} conns… `);
    const result = await run(scenario, token);
    results.push(result);
    console.log(`p95 ${String(result.p95)} ms`);
  }

  await app.close();
  await rawSql.end();

  console.log(`\n  Registry size: ${rows.toLocaleString('en-IN')} cameras · ${String(DURATION_S)}s per scenario\n`);
  console.log('| Scenario | Conns | Requests | req/s | p50 | p95 | p99 | max | non-2xx | errors |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.name} | ${String(r.connections)} | ${r.requests.toLocaleString('en-IN')} | ` +
        `${r.rps.toLocaleString('en-IN')} | ${String(r.p50)} ms | **${String(r.p95)} ms** | ` +
        `${String(r.p99)} ms | ${String(r.max)} ms | ${String(r.non2xx)} | ${String(r.errors)} |`,
    );
  }

  const worst = results.reduce((a, b) => (b.p95 > a.p95 ? b : a));
  const failures = results.filter((r) => r.non2xx > 0 || r.errors > 0);

  console.log(`\n  worst p95: ${String(worst.p95)} ms (${worst.name}) · target < ${String(P95_TARGET_MS)} ms`);
  console.log(`  concurrency: ${String(CONCURRENCY)} connections`);
  console.log(`  failed responses: ${String(failures.reduce((n, r) => n + r.non2xx + r.errors, 0))}`);

  const p95Ok = worst.p95 < P95_TARGET_MS;
  const cleanOk = failures.length === 0;
  const rowsOk = rows >= 100_000;

  console.log(
    `\n  p95 < ${String(P95_TARGET_MS)} ms: ${p95Ok ? 'PASS' : 'FAIL'}` +
      ` · ${String(CONCURRENCY)} concurrent clean: ${cleanOk ? 'PASS' : 'FAIL'}` +
      ` · >= 1,00,000 rows: ${rowsOk ? 'PASS' : 'FAIL'}`,
  );

  if (!p95Ok || !cleanOk || !rowsOk) process.exitCode = 1;
}

await main();
