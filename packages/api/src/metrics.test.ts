/**
 * Metrics tests (D3-10).
 *
 * The three that matter are the *semantic* ones, because they are the ones a future change would
 * silently break: a null must not become a zero, an unscored camera must not become an untrusted
 * one, and `pts_drift_ms` must never lose the label that says whether it means anything. Each of
 * those is a real mistake this project has already made once.
 *
 * The database-backed cases skip when Postgres is unreachable, like every other suite here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from './server.js';
import { loadEnv, type Env } from './env.js';
import { createDb, createSql, type Db, type Sql } from './db/client.js';
import {
  UPTIME_TARGET_RATIO,
  observeHttp,
  recordRelayStats,
  refreshBusMetrics,
  refreshEstateMetrics,
  registry,
  renderMetrics,
  setBusReachable,
  type BusInspector,
} from './metrics.js';

const BANDS = { trusted: 70, degraded: 40 };

/** Cameras this suite owns. Prefixed so a concurrent suite's rows cannot be mistaken for them. */
const MEASURED = 'metrics-measured';
const UNMEASURABLE = 'metrics-unmeasurable';
const UNSCORED = 'metrics-unscored';
const VOD_DRIFT = 'metrics-vod';

let env: Env;
let rawSql: Sql;
let db: Db;
let reachable = false;

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[metrics] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const inserted = await db.execute<{ id: string; external_id: string }>(
    sql`insert into cameras (external_id, name, adapter_kind, declared_fps, trust_score)
        values (${MEASURED},     'D3-10 fixture: measured',     'hls', 30, 88.5),
               (${UNMEASURABLE}, 'D3-10 fixture: unmeasurable', 'hls', 30, 41.0),
               (${UNSCORED},     'D3-10 fixture: never probed', 'hls', 25, null),
               (${VOD_DRIFT},    'D3-10 fixture: vod drift',    'hls', 25, 60.0)
        returning id::text as id, external_id`,
  );
  const idOf = (externalId: string) =>
    inserted.find((row) => row.external_id === externalId)?.id ?? '';

  // A camera whose rate WAS measured.
  await db.execute(sql`
    insert into camera_health_checks
      (camera_id, checked_at, connectable, decodable, measured_fps, pts_drift_ms, breakdown)
    values (${idOf(MEASURED)}::uuid, now(), true, true, 14.99, 12,
            ${JSON.stringify({ pts_drift_meaning: 'live', fps: { declared: 30 } })}::jsonb)
  `);

  // A camera whose rate could NOT be measured. This is the row that must not become a zero.
  await db.execute(sql`
    insert into camera_health_checks
      (camera_id, checked_at, connectable, decodable, measured_fps, breakdown)
    values (${idOf(UNMEASURABLE)}::uuid, now(), true, true, null,
            ${JSON.stringify({ fps: { unmeasurable_reason: 'too_slow_to_measure' } })}::jsonb)
  `);

  // VOD: the drift number is real but means pull-rate skew, which is worth nothing.
  await db.execute(sql`
    insert into camera_health_checks
      (camera_id, checked_at, connectable, decodable, pts_drift_ms, breakdown)
    values (${idOf(VOD_DRIFT)}::uuid, now(), true, true, 124007,
            ${JSON.stringify({ pts_drift_meaning: 'vod' })}::jsonb)
  `);
});

afterAll(async () => {
  if (reachable) {
    await db.execute(
      sql`delete from cameras where external_id in
          (${MEASURED}, ${UNMEASURABLE}, ${UNSCORED}, ${VOD_DRIFT})`,
    );
    await rawSql.end();
  }
});

describe('GET /metrics', () => {
  let app: App;

  beforeAll(async () => {
    // No `db`: the endpoint must answer on a health-only server too, because a metrics endpoint
    // that needs the database is blind exactly when the database is the problem.
    app = await buildServer({ env: loadEnv({ NODE_ENV: 'test' }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is exposed, unauthenticated, in the Prometheus exposition format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE saakshi_build_info gauge');
  });

  it('is hidden from the OpenAPI document — it is text, not part of the typed client', async () => {
    const spec = app.swagger() as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).not.toContain('/metrics');
    expect(Object.keys(spec.paths)).toContain('/health');
  });

  it('exports the stated uptime target as a constant, so a panel compares against something written down', async () => {
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(UPTIME_TARGET_RATIO).toBe(0.99);
    expect(body).toMatch(/^saakshi_uptime_target_ratio 0\.99$/m);
  });

  it('records every served request in the HTTP counter, labelled by route template', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toMatch(
      /saakshi_api_http_requests_total\{method="GET",route="\/health",status="200"\}/,
    );
    expect(body).toContain('saakshi_api_http_request_duration_seconds_bucket');
  });

  it('buckets request duration at exactly 0.2 s, the stated API latency target', async () => {
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toMatch(/saakshi_api_http_request_duration_seconds_bucket\{[^}]*le="0\.2"/);
  });
});

describe('observeHttp', () => {
  it('counts a 5xx as an error and a 200 as not one', async () => {
    observeHttp('GET', '/api/v1/metrics-test', 500, 0.01);
    const body = await renderMetrics();

    expect(body).toMatch(
      /saakshi_api_http_errors_total\{method="GET",route="\/api\/v1\/metrics-test",class="5xx"\} 1/,
    );
  });
});

describe('the estate snapshot', () => {
  it('exports a measured frame rate as a value and an unmeasurable one as an ABSENT series with a reason', async () => {
    if (!reachable) return;
    await refreshEstateMetrics(db, BANDS);
    const body = await renderMetrics();

    // The measured camera has a real number.
    expect(body).toMatch(
      new RegExp(`saakshi_camera_measured_fps\\{camera="${MEASURED}"\\} 14\\.99`),
    );
    // The unmeasurable camera has NO fps series at all — not a zero.
    expect(body).not.toMatch(new RegExp(`saakshi_camera_measured_fps\\{camera="${UNMEASURABLE}"`));
    expect(body).toMatch(
      new RegExp(
        `saakshi_camera_fps_unmeasurable\\{camera="${UNMEASURABLE}",reason="too_slow_to_measure"\\} 1`,
      ),
    );
  });

  it('treats a never-scored camera as unbanded rather than untrusted', async () => {
    if (!reachable) return;
    await refreshEstateMetrics(db, BANDS);
    const body = await renderMetrics();

    expect(body).toMatch(new RegExp(`saakshi_camera_unbanded\\{camera="${UNSCORED}"\\} 1`));
    expect(body).not.toMatch(new RegExp(`saakshi_camera_trust_band\\{camera="${UNSCORED}"`));
    expect(body).not.toMatch(new RegExp(`saakshi_camera_trust_score\\{camera="${UNSCORED}"`));
  });

  it('bands a scored camera by the shared thresholds', async () => {
    if (!reachable) return;
    await refreshEstateMetrics(db, BANDS);
    const body = await renderMetrics();

    expect(body).toMatch(
      new RegExp(`saakshi_camera_trust_band\\{camera="${MEASURED}",band="trusted"\\} 1`),
    );
    expect(body).toMatch(
      new RegExp(`saakshi_camera_trust_band\\{camera="${UNMEASURABLE}",band="degraded"\\} 1`),
    );
  });

  it('carries the meaning of pts_drift_ms as a label, so an alert can ignore VOD skew', async () => {
    if (!reachable) return;
    await refreshEstateMetrics(db, BANDS);
    const body = await renderMetrics();

    expect(body).toMatch(
      new RegExp(`saakshi_camera_pts_drift_ms\\{camera="${MEASURED}",meaning="live"\\} 12`),
    );
    expect(body).toMatch(
      new RegExp(`saakshi_camera_pts_drift_ms\\{camera="${VOD_DRIFT}",meaning="vod"\\} 124007`),
    );
  });

  it('drops a camera that has left the registry, rather than freezing its last value', async () => {
    if (!reachable) return;
    await refreshEstateMetrics(db, BANDS);
    expect(await renderMetrics()).toMatch(
      new RegExp(`saakshi_camera_status\\{camera="${MEASURED}"`),
    );

    await db.execute(sql`update cameras set deleted_at = now() where external_id = ${MEASURED}`);
    await refreshEstateMetrics(db, BANDS);
    expect(await renderMetrics()).not.toMatch(
      new RegExp(`saakshi_camera_status\\{camera="${MEASURED}"`),
    );

    await db.execute(sql`update cameras set deleted_at = null where external_id = ${MEASURED}`);
  });
});

describe('bus and relay gauges', () => {
  it('reports stream length, group lag and consumer count without joining a group', async () => {
    const calls: string[] = [];
    const inspector: BusInspector = {
      async streamLength(stream) {
        calls.push(`length:${stream}`);
        return 4242;
      },
      async groups(stream) {
        calls.push(`groups:${stream}`);
        return [{ name: 'sightings-writer', pending: 7, lag: 13, consumers: 1 }];
      },
    };

    await refreshBusMetrics(inspector, ['sightings']);
    const body = await renderMetrics();

    expect(calls).toEqual(['length:sightings', 'groups:sightings']);
    expect(body).toMatch(/saakshi_bus_stream_length\{stream="sightings"\} 4242/);
    expect(body).toMatch(
      /saakshi_bus_group_lag_entries\{stream="sightings",group="sightings-writer"\} 13/,
    );
    expect(body).toMatch(
      /saakshi_bus_group_pending_entries\{stream="sightings",group="sightings-writer"\} 7/,
    );
  });

  it('says the bus is unreachable rather than reporting a zero-length stream', async () => {
    setBusReachable(false);
    expect(await renderMetrics()).toMatch(/^saakshi_bus_reachable 0$/m);
    setBusReachable(true);
    expect(await renderMetrics()).toMatch(/^saakshi_bus_reachable 1$/m);
  });

  it("exports the relay's own counters rather than re-instrumenting it", async () => {
    recordRelayStats({
      cachedObjects: 12,
      cachedBytes: 3456,
      hits: 90,
      misses: 10,
      upstreamRequests: 10,
      inFlight: 2,
      queued: 1,
      meanUpstreamMs: 31_000,
    });
    const body = await renderMetrics();

    expect(body).toMatch(/^saakshi_relay_hits 90$/m);
    expect(body).toMatch(/^saakshi_relay_upstream_requests 10$/m);
    // 31 s for one HLS object is not a bug in this exporter — D3-07 measured 22-49 s per segment.
    expect(body).toMatch(/^saakshi_relay_upstream_mean_ms 31000$/m);
  });
});

describe('registry hygiene', () => {
  it('prefixes every metric it defines with saakshi_', async () => {
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);

    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !n.startsWith('saakshi_'))).toEqual([]);
  });

  it('gives every metric a help string — an unexplained gauge is an unusable one', async () => {
    const missing = (await registry.getMetricsAsJSON())
      .filter((m) => !m.help || m.help.length < 10)
      .map((m) => m.name);

    expect(missing).toEqual([]);
  });
});
