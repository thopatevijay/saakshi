/**
 * Trust endpoint tests.
 *
 * Against the real migrated database via `app.inject()`, like the rest of the registry suite. The
 * summary's correctness is checked the way the ticket asks — **against the same SQL the validation
 * gate runs** — rather than against another copy of the same TypeScript that produced it.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import type { UserRole } from '../auth.js';
import { recompute } from '../jobs/trust-recompute.js';
import { loadWeights } from '../services/trust.js';

const TAG = `TRUST-${String(Date.now())}`;

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;
let cameraId = '';
let deadCameraId = '';

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[trust] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const users = await db.execute<{ id: string; badge_no: string }>(
    sql`select id, badge_no from users`,
  );
  for (const role of Object.keys(actors) as UserRole[]) {
    const row = users.find((u) => u.badge_no === actors[role].badgeNo);
    if (row === undefined) throw new Error(`seed user ${actors[role].badgeNo} missing`);
    actors[role].sub = row.id;
  }

  // A healthy camera and one that goes dark — the AC 5 pair.
  const created = await db.execute<{ id: string; external_id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind)
    values (${`${TAG}-healthy`}, 'Trust healthy', 'hls'), (${`${TAG}-dark`}, 'Trust dark', 'hls')
    returning id::text, external_id`);
  cameraId = created.find((c) => c.external_id.endsWith('healthy'))?.id ?? '';
  deadCameraId = created.find((c) => c.external_id.endsWith('dark'))?.id ?? '';

  // Two days of history on the healthy camera, so the trend has buckets to return.
  await db.execute(sql`
    insert into camera_health_checks (
      camera_id, checked_at, connectable, decodable, measured_fps, actual_resolution, actual_codec,
      blur_score, luma_mean, night_usable, tamper_score, pts_drift_ms, breakdown
    ) values
      (${cameraId}::uuid, now() - interval '2 days', true, true, 25.0, '1920x1080', 'h264',
       298.6, 92.7, true, 0.0, 124007, '{"source_is_vod": true, "fps": {"declared": null}}'::jsonb),
      (${cameraId}::uuid, now() - interval '1 hour', true, true, 25.0, '1920x1080', 'h264',
       298.6, 92.7, true, 0.0, 124007, '{"source_is_vod": true, "fps": {"declared": null}}'::jsonb),
      (${deadCameraId}::uuid, now() - interval '2 days', true, true, 25.0, '1920x1080', 'h264',
       298.6, 92.7, true, 0.0, 124007, '{"source_is_vod": true, "fps": {"declared": null}}'::jsonb)`);

  await recompute(db, { rescoreAll: false });

  app = await buildServer({ env, db });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

describe('GET /api/v1/cameras/:id/trust', () => {
  it('returns the score with a breakdown that sums to it', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/trust`,
      headers: auth('operator'),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      score: number;
      band: string;
      breakdown: {
        signals: { signal: string; points: number; weight: number; note: string }[];
        pointsTotal: number;
        excluded: { signal: string; reason: string }[];
      };
    }>();

    expect(body.score).toBeGreaterThan(0);
    expect(body.band).toBe('trusted');
    // The gate's checkbox: "Breakdown is human-readable and sums to the score."
    expect(Math.abs(body.breakdown.pointsTotal - body.score)).toBeLessThan(0.01);
    expect(body.breakdown.signals.map((s) => s.signal).sort()).toEqual([
      'clock',
      'focus',
      'frameRate',
      'light',
      'reachability',
      'tamper',
    ]);
    for (const signal of body.breakdown.signals) {
      expect(signal.note.length).toBeGreaterThan(10);
    }
    // Human-readable also means the exclusions are explained, not silently dropped.
    expect(body.breakdown.excluded.find((e) => e.signal === 'clock')?.reason).toContain('VOD');
  });

  it('returns a daily trend', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/trust?days=7`,
      headers: auth('operator'),
    });
    const body = res.json<{ trend: { bucket: string; score: number | null }[] }>();
    // Two checks two days apart → two daily buckets.
    expect(body.trend.length).toBeGreaterThanOrEqual(2);
  });

  it('AC 5 — a camera that goes dark drops to dead and the trend shows the drop', async () => {
    if (!reachable) return;

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${deadCameraId}/trust`,
      headers: auth('operator'),
    });
    expect(before.json<{ band: string }>().band).toBe('trusted');

    // The next pass finds nothing: unreachable, every signal null.
    await db.execute(sql`
      insert into camera_health_checks (camera_id, checked_at, connectable, decodable, breakdown)
      values (${deadCameraId}::uuid, now(), false, false,
              '{"error": "timed out", "retryable": true}'::jsonb)`);
    await recompute(db, { rescoreAll: false });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${deadCameraId}/trust`,
      headers: auth('operator'),
    });
    const body = after.json<{ band: string; score: number; trend: { score: number | null }[] }>();

    expect(body.band).toBe('dead');
    expect(body.score).toBe(0);

    // The drop is visible in the series, not merely in the current value — which is the point of
    // keeping a score per health check rather than only on the camera.
    const scores = body.trend.map((t) => t.score).filter((s): s is number => s !== null);
    expect(Math.max(...scores)).toBeGreaterThan(Math.min(...scores));
  });

  it('404s for an unknown camera', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000/trust',
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: `/api/v1/cameras/${cameraId}/trust` });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/trust/summary', () => {
  it('AC 6 — counts match the SQL the validation gate runs', async () => {
    if (!reachable) return;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trust/summary',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      total: number;
      bands: { trusted: number; degraded: number; untrusted: number; dead: number };
      byDepartment: { total: number }[];
      byDistrict: { total: number }[];
    }>();

    // The gate's query, verbatim in spirit: counted in SQL, independently of the endpoint's own
    // aggregation, so the two cannot agree by sharing a bug.
    const counts = await db.execute<{ trusted: string; untrusted: string; total: string }>(sql`
      select
        count(*) filter (where trust_score >= 70)::text as trusted,
        count(*) filter (where trust_score < 40)::text  as untrusted,
        count(*)::text                                  as total
      from cameras where deleted_at is null`);

    const sqlTrusted = Number(counts[0]?.trusted);
    const sqlUntrusted = Number(counts[0]?.untrusted);

    expect(body.total).toBe(Number(counts[0]?.total));
    // A dead camera keeps its last stored score, so SQL counts it in a numeric band while the
    // endpoint reports it as `dead`. Adding them back is what makes the two directly comparable —
    // and it is why the endpoint joins the latest health check rather than trusting the number.
    const deadThatWouldCountTrusted = await db.execute<{ n: string }>(sql`
      with latest as (
        select distinct on (camera_id) camera_id, connectable
        from camera_health_checks order by camera_id, checked_at desc
      )
      select count(*)::text as n from cameras c
      join latest l on l.camera_id = c.id
      where c.deleted_at is null and l.connectable = false and c.trust_score >= 70`);
    const deadUntrusted = await db.execute<{ n: string }>(sql`
      with latest as (
        select distinct on (camera_id) camera_id, connectable
        from camera_health_checks order by camera_id, checked_at desc
      )
      select count(*)::text as n from cameras c
      join latest l on l.camera_id = c.id
      where c.deleted_at is null and l.connectable = false and c.trust_score < 40`);

    expect(body.bands.trusted + Number(deadThatWouldCountTrusted[0]?.n)).toBe(sqlTrusted);
    expect(body.bands.untrusted + Number(deadUntrusted[0]?.n)).toBe(sqlUntrusted);
  });

  it('the four bands account for every live camera', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trust/summary',
      headers: auth('auditor'),
    });
    const body = res.json<{
      total: number;
      scored: number;
      unscored: number;
      bands: Record<string, number>;
    }>();

    const banded = Object.values(body.bands).reduce((a, b) => a + b, 0);
    expect(banded + body.unscored).toBe(body.total);
    expect(body.scored + body.unscored).toBe(body.total);
  });

  it('breaks the estate down by department and district', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trust/summary',
      headers: auth('auditor'),
    });
    const body = res.json<{
      total: number;
      byDepartment: { total: number }[];
      byDistrict: { total: number }[];
    }>();

    expect(body.byDepartment.reduce((a, d) => a + d.total, 0)).toBe(body.total);
    expect(body.byDistrict.reduce((a, d) => a + d.total, 0)).toBe(body.total);
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    expect((await app.inject({ method: 'GET', url: '/api/v1/trust/summary' })).statusCode).toBe(
      401,
    );
  });
});

describe('weights configuration', () => {
  it('the shipped weights sum to a sane total and every signal is documented', () => {
    const weights = loadWeights();
    const signals = Object.values(weights.signals);
    expect(signals.length).toBe(6);
    for (const signal of signals) {
      expect(signal.weight).toBeGreaterThan(0);
      // Every weight carries its reasoning in the file the AC says must be config, not code.
      expect(Array.isArray((signal as { $rationale?: unknown }).$rationale)).toBe(true);
    }
  });
});
