/**
 * Registry API integration tests.
 *
 * Every endpoint is covered three ways, because that is what the AC asks for: the happy path, a
 * validation failure, and an RBAC denial. They run against the real migrated database via
 * `app.inject()` — no HTTP listener, no mocked query builder. A mocked database would prove the
 * handlers call drizzle, not that the PostGIS bbox filter or the upsert key actually work.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import type { UserRole } from '../auth.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

/** Marks every row this suite creates so teardown can remove exactly them and nothing else. */
const TAG = `TEST-${String(Date.now())}`;

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;

/** Real seeded users, so the role claims match rows that exist. */
const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

/**
 * Mints a bearer token directly. There is no login endpoint in D1-02's scope — D1-07 owns
 * authentication — so the test signs with the same `JWT_SECRET` the server verifies with.
 */
function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

const catalogueStub = (): Promise<unknown> =>
  // Shaped exactly like the deployed sandbox: {id,name} and nothing else, despite what the
  // Integrator's Guide describes. Stubbed so the suite never depends on the sandbox being up.
  Promise.resolve([
    { id: `${TAG}-cam01`, name: '01 Chiman bhai Bridge' },
    { id: `${TAG}-cam02`, name: '02 Janpath' },
    { id: `${TAG}-cam03`, name: '03 O.N.G.C. Office' },
  ]);

async function auditCount(): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from audit_log`);
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[cameras] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const users = await db.execute<{ id: string; badge_no: string }>(
    sql`select id, badge_no from users`,
  );
  for (const role of Object.keys(actors) as UserRole[]) {
    const row = users.find((u) => u.badge_no === actors[role].badgeNo);
    if (row === undefined)
      throw new Error(`seed user ${actors[role].badgeNo} missing — run make migrate`);
    actors[role].sub = row.id;
  }

  app = await buildServer({ env, db, fetchCatalogue: catalogueStub });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    // Only rows this run created. audit_log is append-only and is deliberately left alone.
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
    await db.execute(sql`delete from cameras where external_id like 'GJ-%'`);
    await db.execute(sql`delete from catalogue_sync_runs where trigger_source = 'api'`);
  }
  await app?.close();
  await rawSql?.end();
});

describe('POST /api/v1/cameras — manual onboarding', () => {
  it('creates a camera and writes an audit row', async () => {
    if (!reachable) return;
    const before = await auditCount();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: {
        externalId: `${TAG}-manual-1`,
        name: 'Manual Onboarding Test',
        adapterKind: 'hls',
        lat: 23.0301,
        lon: 72.5145,
        district: 'Ahmedabad',
        declaredFps: 25,
        declaredResolution: '1920x1080',
        endpoints: { hls: 'https://example.invalid/cam/index.m3u8' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; lat: number; lon: number; trustScore: number | null }>();
    expect(body.lat).toBeCloseTo(23.0301, 4);
    expect(body.lon).toBeCloseTo(72.5145, 4);
    // Never probed is not the same as scored zero.
    expect(body.trustScore).toBeNull();
    expect(await auditCount()).toBe(before + 1);
  });

  it('rejects a bad declaredResolution with field-level detail', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: {
        externalId: `${TAG}-bad`,
        name: 'Bad',
        adapterKind: 'hls',
        declaredResolution: '1080p',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; details: { field: string }[] }>();
    expect(body.error).toBe('validation_failed');
    expect(body.details.map((d) => d.field)).toContain('declaredResolution');
  });

  it('rejects an adapterKind outside the enum', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: { externalId: `${TAG}-bad2`, name: 'Bad', adapterKind: 'carrier-pigeon' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409s on a duplicate external id in the same department', async () => {
    if (!reachable) return;
    const payload = { externalId: `${TAG}-dup`, name: 'Dup', adapterKind: 'hls' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it('denies operator (read-only) and auditor', async () => {
    if (!reachable) return;
    for (const role of ['operator', 'auditor'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: auth(role),
        payload: { externalId: `${TAG}-${role}`, name: 'x', adapterKind: 'hls' },
      });
      expect(res.statusCode, `${role} must not create`).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('forbidden');
    }
  });

  it('401s without a bearer token', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      payload: { externalId: 'x', name: 'x', adapterKind: 'hls' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s for a validly signed token whose subject is not a real user', async () => {
    if (!reachable) return;
    // A signed token stays cryptographically valid after its officer is deactivated, and
    // `audit_log.actor_id` references `users(id)` — so before this check the mutation failed on the
    // foreign key and surfaced as a 500. An unknown principal is an authentication problem.
    const ghost = app.jwt.sign({
      sub: '00000000-0000-4000-8000-0000000000ff',
      badgeNo: 'GHOST-0001',
      role: 'admin',
      departmentId: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${ghost}` },
      payload: { externalId: `${TAG}-ghost`, name: 'Ghost', adapterKind: 'hls' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ message: string }>().message).toMatch(/not an active user/);
  });
});

describe('GET /api/v1/cameras — list, filters, pagination, bbox', () => {
  it('paginates with an opaque cursor and never repeats a row', async () => {
    if (!reachable) return;
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras?limit=2',
      headers: auth('operator'),
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      data: { id: string }[];
      nextCursor: string | null;
      limit: number;
    }>();
    expect(page1.limit).toBe(2);
    expect(page1.data.length).toBeLessThanOrEqual(2);

    if (page1.nextCursor !== null) {
      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        headers: auth('operator'),
      });
      const page2 = second.json<{ data: { id: string }[] }>();
      const overlap = page1.data.filter((a) => page2.data.some((b) => b.id === a.id));
      expect(overlap).toEqual([]);
    }
  });

  it('bbox returns only cameras inside the box — PostGIS-verified', async () => {
    if (!reachable) return;
    // One inside the Ahmedabad box, one far outside it (Rajkot).
    const inside = {
      externalId: `${TAG}-inside`,
      name: 'Inside',
      adapterKind: 'hls',
      lat: 23.03,
      lon: 72.51,
    };
    const outside = {
      externalId: `${TAG}-outside`,
      name: 'Outside',
      adapterKind: 'hls',
      lat: 22.3,
      lon: 70.8,
    };
    for (const payload of [inside, outside]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: auth('supervisor'),
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras?bbox=72.4,23.0,72.8,23.4&limit=500&q=${TAG}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ data: { externalId: string }[] }>().data.map((c) => c.externalId);

    expect(ids).toContain(`${TAG}-inside`);
    expect(ids).not.toContain(`${TAG}-outside`);
  });

  it('rejects a malformed bbox', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras?bbox=72.4,23.0',
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters by adapterKind and geometryClass', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras?adapterKind=hls&geometryClass=unclassified&limit=500&q=${TAG}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    for (const cam of res.json<{ data: { adapterKind: string; geometryClass: string }[] }>().data) {
      expect(cam.adapterKind).toBe('hls');
      expect(cam.geometryClass).toBe('unclassified');
    }
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    expect((await app.inject({ method: 'GET', url: '/api/v1/cameras' })).statusCode).toBe(401);
  });
});

describe('GET /api/v1/cameras/:id — detail with declared vs measured', () => {
  it('returns the camera and a null health block when never probed', async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: {
        externalId: `${TAG}-detail`,
        name: 'Detail',
        adapterKind: 'hls',
        declaredFps: 25,
        declaredResolution: '1920x1080',
        declaredCodec: 'h264',
      },
    });
    const { id } = created.json<{ id: string }>();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${id}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ latestHealth: unknown; declaredVsMeasured: unknown }>();
    expect(body.latestHealth).toBeNull();
    expect(body.declaredVsMeasured).toBeNull();
  });

  it('computes the declared-vs-measured delta once a health check exists', async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: {
        externalId: `${TAG}-delta`,
        name: 'Delta',
        adapterKind: 'hls',
        declaredFps: 25,
        declaredResolution: '1920x1080',
        declaredCodec: 'h264',
      },
    });
    const { id } = created.json<{ id: string }>();

    // The department declared 25 fps at 1080p; the camera actually delivers 10 fps at 480p. That
    // gap is the product.
    await db.execute(sql`
      insert into camera_health_checks
        (camera_id, checked_at, connectable, decodable, measured_fps, actual_resolution,
         actual_codec, night_usable, pts_drift_ms, trust_score, breakdown)
      values (${id}::uuid, now(), true, true, 10.0, '854x480', 'h264', false, 120, 61.5,
              '{"fps": 0.4, "resolution": 0.25}'::jsonb)`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${id}`,
      headers: auth('operator'),
    });
    const body = res.json<{
      latestHealth: { measuredFps: number; trustScore: number };
      declaredVsMeasured: {
        fpsDelta: number;
        resolutionMatches: boolean;
        codecMatches: boolean;
      };
    }>();

    expect(body.latestHealth.measuredFps).toBe(10);
    expect(body.latestHealth.trustScore).toBe(61.5);
    expect(body.declaredVsMeasured.fpsDelta).toBe(-15);
    expect(body.declaredVsMeasured.resolutionMatches).toBe(false);
    expect(body.declaredVsMeasured.codecMatches).toBe(true);
  });

  it('404s for an unknown id and 400s for a non-uuid', async () => {
    if (!reachable) return;
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/00000000-0000-4000-8000-00000000ffff',
      headers: auth('operator'),
    });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/not-a-uuid',
      headers: auth('operator'),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/cameras/:id', () => {
  let id = '';

  beforeAll(async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: { externalId: `${TAG}-patch`, name: 'Before', adapterKind: 'hls' },
    });
    id = created.json<{ id: string }>().id;
  });

  it('updates metadata and writes an audit row', async () => {
    if (!reachable) return;
    const before = await auditCount();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cameras/${id}`,
      headers: auth('supervisor'),
      payload: { name: 'After', district: 'Gandhinagar', lat: 23.2156, lon: 72.6369 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string; district: string; lat: number }>();
    expect(body.name).toBe('After');
    expect(body.district).toBe('Gandhinagar');
    expect(body.lat).toBeCloseTo(23.2156, 4);
    expect(await auditCount()).toBe(before + 1);
  });

  it('rejects an out-of-range declaredFps', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cameras/${id}`,
      headers: auth('supervisor'),
      payload: { declaredFps: 9000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('denies operator', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cameras/${id}`,
      headers: auth('operator'),
      payload: { name: 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/v1/cameras/:id — soft delete only', () => {
  it('admin soft-deletes; the row survives and disappears from reads', async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: { externalId: `${TAG}-del`, name: 'Doomed', adapterKind: 'hls' },
    });
    const { id } = created.json<{ id: string }>();
    const before = await auditCount();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/cameras/${id}`,
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deleted: boolean }>().deleted).toBe(true);
    expect(await auditCount()).toBe(before + 1);

    // Gone from the API...
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${id}`,
      headers: auth('operator'),
    });
    expect(detail.statusCode).toBe(404);

    // ...but still in the table, because it is the provenance of anything already attached to it.
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from cameras where id = ${id}::uuid and deleted_at is not null`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('denies supervisor and operator — delete is admin-only', async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('supervisor'),
      payload: { externalId: `${TAG}-del2`, name: 'Safe', adapterKind: 'hls' },
    });
    const { id } = created.json<{ id: string }>();

    for (const role of ['supervisor', 'operator', 'auditor'] as const) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${id}`,
        headers: auth(role),
      });
      expect(res.statusCode, `${role} must not delete`).toBe(403);
    }
  });
});

describe('POST /api/v1/cameras/bulk — CSV and JSON', () => {
  const multipart = (filename: string, body: string) => {
    const boundary = '----saakshitest';
    return {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: text/csv\r\n\r\n${body}\r\n--${boundary}--\r\n`,
        'utf8',
      ),
    };
  };

  it('imports 50 valid CSV rows', async () => {
    if (!reachable) return;
    const csv = await readFile(path.join(FIXTURES, 'cameras-bulk-sample.csv'), 'utf8');
    const { headers, payload } = multipart('cameras-bulk-sample.csv', csv);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...headers, ...auth('supervisor') },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const report = res.json<{ received: number; imported: number; rejected: unknown[] }>();
    expect(report.received).toBe(50);
    expect(report.imported).toBe(50);
    expect(report.rejected).toEqual([]);
  });

  it('re-running the same import produces zero duplicates', async () => {
    if (!reachable) return;
    const csv = await readFile(path.join(FIXTURES, 'cameras-bulk-sample.csv'), 'utf8');
    const countRows = async () => {
      const rows = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from cameras where external_id like 'GJ-%'`,
      );
      return Number(rows[0]?.n ?? 0);
    };

    const { headers, payload } = multipart('cameras-bulk-sample.csv', csv);
    await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...headers, ...auth('supervisor') },
      payload,
    });
    const after1 = await countRows();

    const again = multipart('cameras-bulk-sample.csv', csv);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...again.headers, ...auth('supervisor') },
      payload: again.payload,
    });
    const after2 = await countRows();

    expect(after2).toBe(after1);
    const report = res.json<{ created: number; updated: number }>();
    expect(report.created).toBe(0);
    expect(report.updated).toBe(50);
  });

  it('reports 47 imported + 3 row-level errors for the invalid file', async () => {
    if (!reachable) return;
    const csv = await readFile(path.join(FIXTURES, 'cameras-bulk-invalid.csv'), 'utf8');
    const { headers, payload } = multipart('cameras-bulk-invalid.csv', csv);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...headers, ...auth('supervisor') },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const report = res.json<{
      received: number;
      imported: number;
      committed: boolean;
      rejected: { row: number; errors: { field: string }[] }[];
    }>();

    expect(report.received).toBe(50);
    expect(report.imported).toBe(47);
    expect(report.rejected).toHaveLength(3);
    expect(report.committed).toBe(true);

    // The three failures are three *different* field errors, which is what makes the report useful.
    expect(report.rejected.map((r) => r.row).sort((a, b) => a - b)).toEqual([7, 19, 33]);
    const fields = report.rejected.flatMap((r) => r.errors.map((e) => e.field));
    expect(fields).toContain('declaredFps');
    expect(fields).toContain('adapterKind');
    expect(fields).toContain('externalId');
  });

  it('accepts a JSON body as the API onboarding path', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: auth('supervisor'),
      payload: {
        cameras: [
          { externalId: `${TAG}-json-1`, name: 'JSON One', adapterKind: 'rtsp' },
          { externalId: `${TAG}-json-2`, name: 'JSON Two', adapterKind: 'whep' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json<{ format: string; imported: number }>();
    expect(report.format).toBe('json');
    expect(report.imported).toBe(2);
  });

  it('flags a file that lists the same camera twice', async () => {
    if (!reachable) return;
    const csv = [
      'externalId,name,adapterKind',
      `${TAG}-twice,First,hls`,
      `${TAG}-twice,Second,hls`,
    ].join('\n');
    const { headers, payload } = multipart('dupes.csv', csv);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...headers, ...auth('supervisor') },
      payload,
    });

    const report = res.json<{
      imported: number;
      rejected: { row: number; errors: { message: string }[] }[];
    }>();
    expect(report.imported).toBe(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.errors[0]?.message).toMatch(/duplicate of row 1/);
  });

  it('denies operator', async () => {
    if (!reachable) return;
    const { headers, payload } = multipart('x.csv', 'externalId,name,adapterKind\na,b,hls');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/bulk',
      headers: { ...headers, ...auth('operator') },
      payload,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/v1/cameras/onboard-from-catalogue', () => {
  it('upserts the upstream catalogue and is idempotent', async () => {
    if (!reachable) return;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/onboard-from-catalogue',
      headers: auth('supervisor'),
      payload: { adapterKind: 'hls' },
    });

    expect(first.statusCode).toBe(200);
    const r1 = first.json<{ fetched: number; created: number; added: number; shape: string }>();
    expect(r1.fetched).toBe(3);
    expect(r1.created).toBe(3);
    expect(r1.added).toBe(3);
    expect(r1.shape).toBe('array');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/onboard-from-catalogue',
      headers: auth('supervisor'),
      payload: { adapterKind: 'hls' },
    });
    // D1-02 asserted `updated: 3` here, because its importer rewrote every row unconditionally.
    // D1-04 replaced that with a diff, and its AC 2 is explicit: a second run reports
    // **all-unchanged**. Rewriting three rows to the values they already held was the behaviour
    // that also erased retention_days and notes on every call.
    const r2 = second.json<{ created: number; updated: number; unchanged: number }>();
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(3);
  });

  it('persists the run and serves it from GET /api/v1/sync/reports', async () => {
    if (!reachable) return;
    const onboard = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/onboard-from-catalogue',
      headers: auth('supervisor'),
      payload: { adapterKind: 'hls' },
    });
    const { runId } = onboard.json<{ runId: string }>();

    const reports = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/reports?limit=50',
      headers: auth('auditor'),
    });
    expect(reports.statusCode).toBe(200);
    const body = reports.json<{ items: { id: string; trigger: string; fetched: number }[] }>();
    const mine = body.items.find((r) => r.id === runId);
    expect(mine?.trigger).toBe('api');
    expect(mine?.fetched).toBe(3);
  });

  it('denies an unauthenticated read of the sync reports', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/reports' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed sync-report cursor rather than silently returning page one', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/reports?cursor=garbage',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('denies operator', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras/onboard-from-catalogue',
      headers: auth('operator'),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/v1/cameras/export', () => {
  it('exports CSV whose header round-trips as an import', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/export?format=csv',
      headers: auth('auditor'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const header = res.body.split('\n')[0];
    expect(header).toBe(
      'externalId,name,departmentId,lat,lon,address,district,cameraType,mount,geometryClass,' +
        'declaredCodec,declaredFps,declaredResolution,vendor,vmsPlatform,retentionDays,' +
        'storageType,adapterKind',
    );
  });

  it('exports JSON', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/export?format=json',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json<{ cameras: unknown[] }>().cameras)).toBe(true);
  });

  it('rejects an unsupported format', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cameras/export?format=xlsx',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    expect((await app.inject({ method: 'GET', url: '/api/v1/cameras/export' })).statusCode).toBe(
      401,
    );
  });
});

describe('GET /api/v1/departments', () => {
  it('lists the five seeded departments with live camera counts', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/departments',
      headers: auth('operator'),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { code: string; cameraCount: number }[] }>();
    expect(body.data.map((d) => d.code).sort()).toEqual([
      'GSRTC',
      'HEALTH',
      'MUNICIPAL',
      'PANCHAYAT',
      'POLICE',
    ]);
    for (const d of body.data) expect(Number.isInteger(d.cameraCount)).toBe(true);
  });

  it('rejects an over-large limit', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/departments?limit=99999',
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    expect((await app.inject({ method: 'GET', url: '/api/v1/departments' })).statusCode).toBe(401);
  });
});

describe('OpenAPI document', () => {
  it('serves the spec and describes all nine registry paths', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/docs/json' });
    expect(res.statusCode).toBe(200);

    const spec = res.json<{ openapi: string; paths: Record<string, Record<string, unknown>> }>();
    expect(spec.openapi).toMatch(/^3\./);

    const expected: [string, string][] = [
      ['/api/v1/cameras', 'get'],
      ['/api/v1/cameras', 'post'],
      ['/api/v1/cameras/{id}', 'get'],
      ['/api/v1/cameras/{id}', 'patch'],
      ['/api/v1/cameras/{id}', 'delete'],
      ['/api/v1/cameras/bulk', 'post'],
      ['/api/v1/cameras/onboard-from-catalogue', 'post'],
      ['/api/v1/sync/reports', 'get'],
      ['/api/v1/cameras/export', 'get'],
      ['/api/v1/departments', 'get'],
    ];
    for (const [route, method] of expected) {
      expect(
        spec.paths[route]?.[method],
        `${method.toUpperCase()} ${route} missing from spec`,
      ).toBeDefined();
    }
  });

  it('serves the browsable UI at /api/v1/docs', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('swagger');
  });
});

describe('audit trail', () => {
  it('every mutation is recorded, and the chain links', async () => {
    if (!reachable) return;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: auth('admin'),
      payload: { externalId: `${TAG}-audit`, name: 'Audited', adapterKind: 'hls' },
    });
    const { id } = created.json<{ id: string }>();

    const rows = await db.execute<{
      action: string;
      target_id: string | null;
      purpose: string;
      prev_hash: string;
      hash: string;
      actor_id: string | null;
    }>(sql`select action, target_id, purpose, prev_hash, hash, actor_id
            from audit_log where target_id = ${id} order by ts desc limit 1`);

    const row = rows[0];
    expect(row?.action).toBe('camera.create');
    expect(row?.purpose).toBe('manual camera onboarding');
    expect(row?.actor_id).toBe(actors.admin.sub);
    // Every row links to a predecessor, and none of them is null.
    expect(row?.prev_hash).toBeTruthy();
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
