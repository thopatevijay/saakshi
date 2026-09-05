/**
 * Watchlist API integration tests — CRUD, bulk import, lookup, RBAC and the audit trail.
 *
 * Against the real migrated database via `app.inject()`, like the registry suite. A mocked query
 * builder would prove the handlers call drizzle; it would not prove that the audit row lands in the
 * same transaction as the mutation, or that `operator` is actually refused.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import type { UserRole } from '../auth.js';

/** Marks every row this suite creates so teardown removes exactly them and nothing else. */
const TAG = `WL${String(Date.now()).slice(-9)}`;
const PURPOSE = 'investigating a reported vehicle theft — test';

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

/** Audit rows for one target. A global count is a shared counter across parallel suites. */
async function auditCountFor(targetId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from audit_log where target_id = ${targetId}`,
  );
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
    console.warn('[watchlist-api] database unreachable — skipping. Run `make up && make migrate`.');
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

  app = await buildServer({ env, db });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    // audit_log is append-only and is deliberately left alone.
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

// ── CRUD ────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/watchlist', () => {
  it('creates a vehicle entry, normalises the plate and writes an audit row', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist',
      headers: auth('supervisor'),
      payload: {
        category: 'stolen_vehicle',
        entityType: 'vehicle',
        plate: ' gj-27 cd 4455 ',
        sourceSystem: 'VAHAN',
        sourceRef: `${TAG}-create`,
        severity: 'high',
        meta: { make: 'Tata', model: 'Nexon', colour: 'white', rc_status: 'active' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; plateNormalized: string; valid: boolean }>();
    expect(body.plateNormalized).toBe('GJ27CD4455');
    expect(body.valid).toBe(true);
    expect(await auditCountFor(body.id)).toBe(1);
  });

  it('refuses a biometric field with a 400 — SAAKSHI processes no biometrics', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist',
      headers: auth('supervisor'),
      payload: {
        category: 'missing_person',
        entityType: 'person',
        personRef: `CASE/${TAG}/0001`,
        sourceSystem: 'AFIS',
        sourceRef: `${TAG}-bio`,
        meta: { subject_ref: 'AFIS-SUBJECT-00001', face_embedding: [0.1, 0.2] },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('schema');
  });

  it('rejects a vehicle entry with no plate', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist',
      headers: auth('supervisor'),
      payload: { category: 'stolen_vehicle', entityType: 'vehicle', sourceRef: `${TAG}-noplate` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects validTo on or before validFrom', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist',
      headers: auth('supervisor'),
      payload: {
        category: 'suspect',
        entityType: 'person',
        personRef: `CASE/${TAG}/0002`,
        sourceRef: `${TAG}-window`,
        validFrom: '2026-05-01T00:00:00.000Z',
        validTo: '2026-05-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH and DELETE', () => {
  let entryId = '';

  beforeAll(async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist',
      headers: auth('admin'),
      payload: {
        category: 'blacklisted_vehicle',
        entityType: 'vehicle',
        plate: 'GJ27ZZ9911',
        sourceRef: `${TAG}-mutate`,
      },
    });
    entryId = res.json<{ id: string }>().id;
  });

  it('updates severity and audits the change', async () => {
    if (!reachable) return;
    const before = await auditCountFor(entryId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/watchlist/${entryId}`,
      headers: auth('supervisor'),
      payload: { severity: 'critical' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ severity: string }>().severity).toBe('critical');
    expect(await auditCountFor(entryId)).toBe(before + 1);
  });

  it('404s an unknown id', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/watchlist/00000000-0000-0000-0000-000000000000',
      headers: auth('supervisor'),
      payload: { severity: 'low' },
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * DELETE deactivates. `alerts.watchlist_entry_id` cascades, so a hard delete would destroy the
   * alerts the entry already raised — the evidence for decisions already taken.
   */
  it('deactivates rather than deletes, and the entry stops matching', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/watchlist/${entryId}`,
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(204);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/${entryId}`,
      headers: auth('operator'),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ active: boolean; valid: boolean }>()).toMatchObject({
      active: false,
      valid: false,
    });

    const lookup = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/vehicle/GJ27ZZ9911?purpose=${encodeURIComponent(PURPOSE)}&maxDistance=0`,
      headers: auth('operator'),
    });
    expect(lookup.json<{ hits: unknown[] }>().hits).toEqual([]);
  });
});

// ── RBAC ────────────────────────────────────────────────────────────────────────────────────────

describe('RBAC — the operator is read-only on the watchlist', () => {
  const mutations: [string, string, object][] = [
    ['POST', '/api/v1/watchlist', { category: 'suspect', entityType: 'person', personRef: 'X' }],
    ['PATCH', '/api/v1/watchlist/00000000-0000-0000-0000-000000000000', { severity: 'low' }],
    ['POST', '/api/v1/watchlist/import', {}],
  ];

  for (const [method, url, payload] of mutations) {
    it(`refuses ${method} ${url.split('?')[0] ?? url} for an operator with 403`, async () => {
      if (!reachable) return;
      const res = await app.inject({
        method: method as 'POST',
        url,
        headers: auth('operator'),
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('forbidden');
    });
  }

  it('refuses DELETE for a supervisor — only admin may deactivate', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/watchlist/00000000-0000-0000-0000-000000000000',
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows an operator to read and to look up', async () => {
    if (!reachable) return;
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist?limit=5',
      headers: auth('operator'),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: unknown[] }>().data.length).toBeGreaterThan(0);
  });

  it('refuses an unauthenticated lookup with 401', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist/lookup/vehicle/GJ35U0779',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Lookup and the audit trail ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/watchlist/lookup/vehicle/:plate', () => {
  it('requires a stated purpose — a lookup with none is a 400', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist/lookup/vehicle/GJ35U0779',
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns the seeded ground-truth plate and writes an audit row carrying the purpose', async () => {
    if (!reachable) return;
    const before = await auditCountFor('GJ35U0779');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/vehicle/GJ35U0779?purpose=${encodeURIComponent(PURPOSE)}&caseRef=FIR/2026/903`,
      headers: auth('operator'),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      normalized: string;
      hits: { plateNormalized: string; matchType: string; live: boolean }[];
      disclaimer: string;
    }>();
    expect(body.normalized).toBe('GJ35U0779');
    expect(
      body.hits.some((h) => h.plateNormalized === 'GJ35U0779' && h.matchType === 'exact'),
    ).toBe(true);
    expect(body.hits.every((h) => !h.live)).toBe(true);
    expect(body.disclaimer).toContain('no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS');

    expect(await auditCountFor('GJ35U0779')).toBe(before + 1);
    const row = await db.execute<{ purpose: string; case_ref: string; action: string }>(
      sql`select purpose, case_ref, action from audit_log
           where target_id = 'GJ35U0779' order by ts desc limit 1`,
    );
    expect(row[0]?.action).toBe('watchlist.lookup.vehicle');
    expect(row[0]?.purpose).toBe(PURPOSE);
    expect(row[0]?.case_ref).toBe('FIR/2026/903');
  });

  /**
   * The live end-to-end case, against what the estate actually produced.
   *
   * `cam07` read `GJ35U0779` as `GJ35U07` — truncation, D2-01's dominant failure. The watchlist
   * carries the true registration, so only fuzzy matching closes the gap. This is the query D2-06's
   * alert engine will make.
   */
  it('recovers the plate from the truncated string cam07 actually emitted', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/vehicle/GJ35U07?purpose=${encodeURIComponent(PURPOSE)}&maxDistance=2`,
      headers: auth('operator'),
    });
    const hit = res
      .json<{ hits: { plateNormalized: string; matchType: string; matchDistance: number }[] }>()
      .hits.find((h) => h.plateNormalized === 'GJ35U0779');
    expect(hit?.matchType).toBe('fuzzy');
    expect(hit?.matchDistance).toBe(2);
  });

  it('matches a measured ANPR output string exactly — the other live alert path', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/vehicle/GJ3266416?purpose=${encodeURIComponent(PURPOSE)}&maxDistance=0`,
      headers: auth('operator'),
    });
    const body = res.json<{ hits: { plateNormalized: string; meta: { note?: string } }[] }>();
    expect(body.hits[0]?.plateNormalized).toBe('GJ3266416');
    expect(body.hits[0]?.meta.note).toContain('MEASURED ANPR OUTPUT');
  });

  it('never returns an entry whose validity window has closed', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/vehicle/GJ01XX0001?purpose=${encodeURIComponent(PURPOSE)}&maxDistance=0`,
      headers: auth('operator'),
    });
    expect(res.json<{ hits: unknown[] }>().hits).toEqual([]);
  });

  it('honours `at` so an alert can be reviewed as of the sighting', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url:
        `/api/v1/watchlist/lookup/vehicle/GJ01XX0001?purpose=${encodeURIComponent(PURPOSE)}` +
        '&maxDistance=0&at=2026-03-01T00:00:00.000Z',
      headers: auth('operator'),
    });
    expect(res.json<{ hits: unknown[] }>().hits).toHaveLength(1);
  });
});

describe('GET /api/v1/watchlist/lookup/person/:ref', () => {
  it('matches a case reference and audits the lookup', async () => {
    if (!reachable) return;
    const ref = 'CASE/WA/2026/0001';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist/lookup/person/${encodeURIComponent(ref)}?purpose=${encodeURIComponent(PURPOSE)}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hits: { entityType: string; meta: Record<string, unknown> }[] }>();
    expect(body.hits[0]?.entityType).toBe('person');
    expect(Object.keys(body.hits[0]?.meta ?? {})).not.toContain('face_embedding');
    expect(await auditCountFor(ref)).toBeGreaterThan(0);
  });
});

// ── Providers ───────────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/watchlist/providers', () => {
  it('reports six connectors, every one of them a mock', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist/providers',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: { system: string; live: boolean; mode: string }[] }>();
    expect(body.providers).toHaveLength(6);
    expect(body.providers.every((p) => p.live === false && p.mode === 'mock')).toBe(true);
  });
});

// ── Bulk import ─────────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/watchlist/import', () => {
  const header =
    'source_system,source_ref,category,entity_type,plate,person_ref,severity,valid_from,valid_to,active,make,note';

  it('imports valid rows and reports the invalid ones by row and field', async () => {
    if (!reachable) return;
    const csv = [
      header,
      `VAHAN,${TAG}-imp-1,stolen_vehicle,vehicle,GJ05AB1111,,high,2026-01-01T00:00:00Z,,true,Honda,ok`,
      `VAHAN,${TAG}-imp-2,stolen_vehicle,vehicle,,,high,2026-01-01T00:00:00Z,,true,Honda,missing plate`,
      `VAHAN,${TAG}-imp-3,not_a_category,vehicle,GJ05AB2222,,high,2026-01-01T00:00:00Z,,true,Honda,bad category`,
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist/import',
      headers: { ...auth('supervisor'), 'content-type': 'text/csv' },
      payload: csv,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      received: number;
      inserted: number;
      updated: number;
      rejected: { row: number; field: string }[];
    }>();
    expect(body.received).toBe(3);
    expect(body.inserted).toBe(1);
    expect(body.rejected.map((r) => r.row).sort()).toEqual([2, 3]);
  });

  /** The natural key migration 0015 declares: a re-import is a correction, not a duplication. */
  it('upserts on (source_system, source_ref) — a second import updates', async () => {
    if (!reachable) return;
    const csv = [
      header,
      `VAHAN,${TAG}-imp-1,stolen_vehicle,vehicle,GJ05AB1111,,critical,2026-01-01T00:00:00Z,,true,Honda,corrected`,
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist/import',
      headers: { ...auth('supervisor'), 'content-type': 'text/csv' },
      payload: csv,
    });

    expect(res.json<{ inserted: number; updated: number }>()).toMatchObject({
      inserted: 0,
      updated: 1,
    });
    const rows = await db.execute<{ severity: string }>(
      sql`select severity from watchlist_entries where source_ref = ${`${TAG}-imp-1`}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe('critical');
  });

  it('refuses a CSV carrying a biometric column, row by row', async () => {
    if (!reachable) return;
    const csv = [
      'source_system,source_ref,category,entity_type,person_ref,fingerprint',
      `NAFIS,${TAG}-bio,suspect,person,CASE/${TAG}/9,ABC123`,
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlist/import',
      headers: { ...auth('supervisor'), 'content-type': 'text/csv' },
      payload: csv,
    });

    const body = res.json<{ inserted: number; rejected: { message: string }[] }>();
    expect(body.inserted).toBe(0);
    expect(body.rejected[0]?.message).toContain('biometric');
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/watchlist', () => {
  it('filters by category and pages with a stable cursor', async () => {
    if (!reachable) return;
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist?category=stolen_vehicle&limit=10',
      headers: auth('operator'),
    });
    const page = first.json<{
      data: { id: string; category: string }[];
      nextCursor: string | null;
    }>();
    expect(page.data).toHaveLength(10);
    expect(page.data.every((e) => e.category === 'stolen_vehicle')).toBe(true);
    expect(page.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/watchlist?category=stolen_vehicle&limit=10&cursor=${page.nextCursor ?? ''}`,
      headers: auth('operator'),
    });
    const next = second.json<{ data: { id: string }[] }>();
    const overlap = next.data.filter((e) => page.data.some((p) => p.id === e.id));
    expect(overlap).toEqual([]);
  });

  it('validNow=true excludes entries whose window has closed', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/watchlist?plate=GJ01XX&validNow=true',
      headers: auth('operator'),
    });
    const body = res.json<{ data: { plateNormalized: string }[] }>();
    expect(body.data.map((e) => e.plateNormalized)).toEqual(['GJ01XX0002']);
  });
});
