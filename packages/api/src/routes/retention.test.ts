/**
 * Retention / evidence clock — endpoint tests (D3-05).
 *
 * Against the real migrated database via `app.inject()`, like the rest of the suite. The estate
 * this runs on declares **no** retention period and **no** coordinates for any of its 30 cameras,
 * which is the finding this ticket exists to surface — so the fixtures below create four cameras
 * that *do*, at known distances from a known point, with 7 / 15 / 90 / undeclared windows. Without
 * them "correct retention state" could only be asserted against the empty case.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MS_PER_DAY, MS_PER_HOUR, PRESERVATION_DISCLAIMER } from '@saakshi/shared';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import type { UserRole } from '../auth.js';
import { AlertEngine } from '../services/alerts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import { createWatchlistRegistry } from '../watchlist/index.js';

const TAG = `RET-${String(Date.now())}`;

/** Paldi Circle, Ahmedabad. The point every distance below is measured from. */
const LAT = 23.0125;
const LON = 72.5661;

/** The footage in question: 2026-09-01 14:00 IST. */
const FOOTAGE_AT = '2026-09-01T08:30:00.000Z';

/** AC 7's vehicle. Unique to this suite so no other worker's fixture can satisfy the assertion. */
const PLATE = 'GJ05RC0305';

/** Session-qualified track ids (D1-09's stride), high enough not to collide with a seeded run. */
const TRACK_BASE = 930_500_000;

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;

const cameraIds: Record<string, string> = {};

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

interface CameraRetentionBody {
  externalId: string;
  located: boolean;
  distanceM: number | null;
  retention: {
    state: string;
    retentionDays: number | null;
    expiresAt: string | null;
    remainingMs: number | null;
    expiringSoonHours: number;
    label: string;
  };
}

interface AvailabilityBody {
  query: { at: string; radiusM: number; expiringSoonHours: number };
  coverageModel: string;
  coverageModelNote: string;
  covering: CameraRetentionBody[];
  unassessable: CameraRetentionBody[];
  counts: {
    covering: number;
    unassessable: number;
    byState: Record<string, number>;
    truncated: boolean;
  };
  legend: Record<string, string>;
  disclaimer: string;
}

async function availability(params: Record<string, string>): Promise<AvailabilityBody> {
  const search = new URLSearchParams({
    lat: String(LAT),
    lon: String(LON),
    radius_m: '500',
    at: FOOTAGE_AT,
    ...params,
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/evidence/availability?${search.toString()}`,
    headers: auth('operator'),
  });
  expect(res.statusCode).toBe(200);
  return res.json<AvailabilityBody>();
}

function covering(body: AvailabilityBody, suffix: string): CameraRetentionBody | undefined {
  return body.covering.find((c) => c.externalId === `${TAG}-${suffix}`);
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[retention] database unreachable — skipping. Run `make up && make migrate`.');
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

  // Four cameras with real positions and four different retention postures.
  //
  //   in7    ~0 m     7-day  window   — the short regime the problem statement names
  //   in15   ~200 m   15-day window   — the long regime
  //   in90   ~400 m   90-day window   — a department that keeps far more
  //   inNull ~100 m   UNDECLARED      — the case the AC insists must read `unknown`
  //   far    ~3 km    7-day  window   — outside the radius, to prove the radius does something
  //
  // Longitude at this latitude: 1e-5 deg ~ 1.02 m. 0.0018 deg ~ 184 m.
  const created = await db.execute<{ id: string; external_id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind, retention_days, location, district)
    values
      (${`${TAG}-in7`},    'Retention 7d',    'hls', 7,
       st_setsrid(st_makepoint(${LON}, ${LAT}), 4326)::geography, 'Ahmedabad'),
      (${`${TAG}-in15`},   'Retention 15d',   'hls', 15,
       st_setsrid(st_makepoint(${LON + 0.002}, ${LAT}), 4326)::geography, 'Ahmedabad'),
      (${`${TAG}-in90`},   'Retention 90d',   'hls', 90,
       st_setsrid(st_makepoint(${LON + 0.004}, ${LAT}), 4326)::geography, 'Ahmedabad'),
      (${`${TAG}-inNull`}, 'Retention none',  'hls', null,
       st_setsrid(st_makepoint(${LON + 0.001}, ${LAT}), 4326)::geography, 'Ahmedabad'),
      (${`${TAG}-far`},    'Retention far',   'hls', 7,
       st_setsrid(st_makepoint(${LON + 0.03}, ${LAT}), 4326)::geography, 'Ahmedabad'),
      (${`${TAG}-unplaced`}, 'Retention unplaced', 'hls', 15, null, 'Ahmedabad')
    returning id::text, external_id`);

  for (const row of created) cameraIds[row.external_id] = row.id;

  // AC 7's fixture: one vehicle seen on the 7-day camera and then on the undeclared one, and one
  // alert raised on the first. Two sightings rather than one because the point of a per-sighting
  // retention field is that two sightings of the same vehicle can be on different clocks.
  const sightingTs = new Date(Date.now() - MS_PER_HOUR).toISOString();
  const seen = await db.execute<{ id: string; ts: string }>(sql`
    insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
                           is_best_shot)
    values
      (${cameraIds[`${TAG}-in7`] ?? ''}::uuid, ${sightingTs}, 4000, ${TRACK_BASE}, 'car',
       '{"x":10,"y":20,"w":100,"h":80}'::jsonb, 0.91, true),
      (${cameraIds[`${TAG}-inNull`] ?? ''}::uuid, ${new Date(Date.now() - 30 * 60_000).toISOString()},
       9000, ${TRACK_BASE + 1}, 'car', '{"x":10,"y":20,"w":100,"h":80}'::jsonb, 0.89, true)
    returning id::text as id, ts`);

  for (const row of seen) {
    await db.execute(sql`
      insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence,
                              is_best_shot, vote_count)
      values (${row.id}::uuid, ${row.ts}, ${PLATE}, ${PLATE}, 0.93, true, 3)`);
  }

  // A watchlist entry, and an alert raised through D2-06's own engine rather than hand-built. The
  // `reason` payload has a strict shape that the response schema validates; producing it by hand
  // here would be a second, drifting copy of the engine's contract.
  await db.execute(sql`
    insert into watchlist_entries (category, entity_type, plate_normalized, source_system,
                                   source_ref, severity, valid_from, active, meta)
    values ('stolen_vehicle', 'vehicle', ${PLATE}, 'VAHAN', ${`${TAG}-WL`}, 'high',
            now() - interval '2 days', true,
            '{"note":"D3-05 retention badge fixture"}'::jsonb)`);

  const engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });
  const first = seen[0];
  if (first !== undefined) {
    await engine.correlate({
      sightingId: first.id,
      sightingTs: first.ts,
      cameraId: cameraIds[`${TAG}-in7`] ?? '',
      rawText: PLATE,
      confidence: 0.93,
    });
  }

  app = await buildServer({ env, db, alertEngine: engine });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    // Cascades to preservation_requests. The audit-chain entries the tests appended stay, as they
    // must: `audit_log` is append-only by trigger and a chain that could be pruned by a test
    // teardown would not be tamper-evident.
    // Cameras cascade to sightings, plate_reads, alerts and preservation_requests; the watchlist
    // entry is not owned by a camera and has to go on its own.
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

// ── AC 1 · location + time returns covering cameras with correct retention state ────────────────

describe('AC 1 — a location + time query returns the covering cameras and their retention state', () => {
  it('returns exactly the cameras inside the radius, nearest first, and excludes the one outside', async () => {
    if (!reachable) return;
    const body = await availability({});
    const ours = body.covering.filter((c) => c.externalId.startsWith(TAG));

    expect(ours.map((c) => c.externalId)).toEqual([
      `${TAG}-in7`,
      `${TAG}-inNull`,
      `${TAG}-in15`,
      `${TAG}-in90`,
    ]);
    // The 3 km camera is a real camera with real retention. It is out of scope for *this location*,
    // and a coverage query that returned it would be answering a different question.
    expect(body.covering.map((c) => c.externalId)).not.toContain(`${TAG}-far`);
    expect(ours[0]?.distanceM).toBe(0);
  });

  it('widening the radius brings the far camera in — the radius is doing work, not decoration', async () => {
    if (!reachable) return;
    const wide = await availability({ radius_m: '5000' });
    expect(wide.covering.map((c) => c.externalId)).toContain(`${TAG}-far`);
  });

  it('states each camera’s retention state correctly against the footage instant', async () => {
    if (!reachable) return;
    // `at` is 2026-09-01 and `now` is the real clock, well past it — so a 7-day window on that
    // footage has long since closed and a 90-day one may or may not have. Assert the arithmetic
    // rather than a hardcoded verdict, so this test does not rot with the calendar.
    const body = await availability({});
    const now = Date.now();
    const footage = new Date(FOOTAGE_AT).getTime();

    for (const [suffix, days] of [
      ['in7', 7],
      ['in15', 15],
      ['in90', 90],
    ] as const) {
      const camera = covering(body, suffix);
      expect(camera, suffix).toBeDefined();
      expect(camera?.retention.retentionDays).toBe(days);
      expect(camera?.retention.expiresAt).toBe(new Date(footage + days * MS_PER_DAY).toISOString());
      const remaining = footage + days * MS_PER_DAY - now;
      expect(camera?.retention.state).toBe(
        remaining <= 0 ? 'expired' : remaining <= 48 * MS_PER_HOUR ? 'expiring_soon' : 'available',
      );
    }
  });

  it('answers "what is live right now" when `at` is omitted, rather than 400ing', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/availability?lat=${String(LAT)}&lon=${String(LON)}&radius_m=500`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AvailabilityBody>();
    // Footage recorded now is at the far end of every declared window.
    expect(covering(body, 'in7')?.retention.state).toBe('available');
  });

  it('says which coverage model produced the answer, in the payload', async () => {
    if (!reachable) return;
    const body = await availability({});
    // A screenshot has to carry the qualification. "Covered" here means "within the radius of the
    // registered position", and the API says so rather than leaving a slide to.
    expect(body.coverageModel).toBe('proximity');
    expect(body.coverageModelNote).toContain('proximity, not a viewshed');
    expect(body.disclaimer).toContain('not from an inspection');
  });

  it('401s without a token', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/availability?lat=${String(LAT)}&lon=${String(LON)}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── AC 3 · unknown is unknown ───────────────────────────────────────────────────────────────────

describe('AC 3 — a camera with no declared retention is reported unknown, never assumed', () => {
  it('carries no expiry, no countdown, and is not counted as expired', async () => {
    if (!reachable) return;
    const body = await availability({});
    const camera = covering(body, 'inNull');

    expect(camera?.retention.state).toBe('unknown');
    expect(camera?.retention.retentionDays).toBeNull();
    expect(camera?.retention.expiresAt).toBeNull();
    expect(camera?.retention.remainingMs).toBeNull();
    expect(camera?.retention.label).toBe('retention not declared');
  });

  it('the legend tells an officer what to do about an unknown', async () => {
    if (!reachable) return;
    const body = await availability({});
    expect(body.legend['unknown']).toContain('Contact the department');
  });

  it('an unplaced camera is returned in the unassessable tray, not silently dropped', async () => {
    if (!reachable) return;
    const body = await availability({});
    const ids = body.unassessable.map((c) => c.externalId);

    // D1-08's rule, in the API: a camera we cannot place can be ruled neither in nor out, and an
    // officer shown an empty covering list without this count has been told something false.
    expect(ids).toContain(`${TAG}-unplaced`);
    expect(body.counts.unassessable).toBeGreaterThanOrEqual(30); // the 30 sandbox cameras, at least
    for (const camera of body.unassessable) {
      expect(camera.located).toBe(false);
      expect(camera.distanceM).toBeNull(); // not 0, which would read as "at the scene"
    }
  });

  it('the unplaced camera still gets a real countdown — unplaced is not unknown', async () => {
    if (!reachable) return;
    const body = await availability({});
    const camera = body.unassessable.find((c) => c.externalId === `${TAG}-unplaced`);
    // It declares 15 days. We cannot say whether it saw the place; we can absolutely say how long
    // its footage lasts, and that is the more urgent of the two facts.
    expect(camera?.retention.retentionDays).toBe(15);
    expect(camera?.retention.state).not.toBe('unknown');
  });
});

// ── AC 4 · the threshold is configurable ────────────────────────────────────────────────────────

describe('AC 4 — the expiring-soon threshold is configurable per query', () => {
  it('the same camera reads available at the default and expiring_soon under a wider fuse', async () => {
    if (!reachable) return;
    // Footage recorded 3 days ago on the 7-day camera: 4 days left.
    const at = new Date(Date.now() - 3 * MS_PER_DAY).toISOString();
    const tight = await availability({ at });
    const wide = await availability({ at, expiring_soon_hours: '240' });

    expect(covering(tight, 'in7')?.retention.state).toBe('available');
    expect(covering(wide, 'in7')?.retention.state).toBe('expiring_soon');
    // The threshold travels with the status, so a rendered badge can explain itself.
    expect(covering(tight, 'in7')?.retention.expiringSoonHours).toBe(48);
    expect(covering(wide, 'in7')?.retention.expiringSoonHours).toBe(240);
    expect(wide.query.expiringSoonHours).toBe(240);
  });

  it('the deployment default comes from RETENTION_EXPIRING_SOON_HOURS', async () => {
    if (!reachable) return;
    const body = await availability({});
    expect(body.query.expiringSoonHours).toBe(env.RETENTION_EXPIRING_SOON_HOURS);
  });
});

// ── AC 8 · the estate-wide distribution ─────────────────────────────────────────────────────────

interface SummaryBody {
  totalCameras: number;
  declared: number;
  undeclared: number;
  shortestDeclaredDays: number | null;
  longestDeclaredDays: number | null;
  buckets: { retentionDays: number | null; cameras: number }[];
  byDepartment: { cameras: number; declared: number; undeclared: number }[];
  located: number;
  unlocated: number;
  disclaimer: string;
}

describe('AC 8 — the estate-wide distribution matches a hand-checked SQL count', () => {
  it('agrees with `select retention_days, count(*) from cameras group by 1`', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/evidence/retention/summary',
      headers: auth('auditor'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SummaryBody>();

    // The same query the validation gate runs, computed independently in SQL so the two cannot
    // agree by sharing a bug in the same TypeScript.
    const rows = await db.execute<{ retention_days: number | null; count: string }>(sql`
      select retention_days, count(*)::text as count
        from cameras where deleted_at is null
       group by retention_days order by retention_days asc nulls last`);

    expect(body.buckets).toEqual(
      rows.map((r) => ({ retentionDays: r.retention_days, cameras: Number(r.count) })),
    );
    expect(body.buckets.reduce((sum, b) => sum + b.cameras, 0)).toBe(body.totalCameras);
    expect(body.declared + body.undeclared).toBe(body.totalCameras);
    expect(body.located + body.unlocated).toBe(body.totalCameras);
  });

  it('keeps the undeclared cameras in their own bucket rather than folding them into a default', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/evidence/retention/summary',
      headers: auth('auditor'),
    });
    const body = res.json<SummaryBody>();

    const nullBucket = body.buckets.find((b) => b.retentionDays === null);
    // The 30 sandbox cameras declare nothing, plus this suite's own undeclared fixture.
    expect(nullBucket?.cameras).toBeGreaterThanOrEqual(31);
    expect(body.undeclared).toBe(nullBucket?.cameras);
    expect(body.shortestDeclaredDays).toBe(7);
    expect(body.longestDeclaredDays).toBe(90);
  });

  it('breaks down by department without losing a camera', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/evidence/retention/summary',
      headers: auth('auditor'),
    });
    const body = res.json<SummaryBody>();
    expect(body.byDepartment.reduce((sum, d) => sum + d.cameras, 0)).toBe(body.totalCameras);
    expect(body.byDepartment.reduce((sum, d) => sum + d.undeclared, 0)).toBe(body.undeclared);
  });
});

// ── AC 5 / AC 6 · preservation requests ─────────────────────────────────────────────────────────

interface PreservationBody {
  request: {
    id: string;
    cameraId: string;
    cameraExternalId: string;
    caseRef: string;
    purpose: string;
    requestedByBadgeNo: string | null;
    status: string;
    retentionDaysAtRequest: number | null;
    expiresAtAtRequest: string | null;
    auditHash: string;
    retention: { state: string };
  };
  auditHash: string;
  disclaimer: string;
}

async function requestPreservation(
  suffix: string,
  caseRef: string,
  windowStart: string,
): Promise<PreservationBody> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/evidence/preservation',
    headers: auth('supervisor'),
    payload: {
      cameraId: cameraIds[`${TAG}-${suffix}`],
      windowStart,
      windowEnd: new Date(new Date(windowStart).getTime() + MS_PER_HOUR).toISOString(),
      caseRef,
      purpose: 'Snatching investigation — hold the approach footage',
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<PreservationBody>();
}

describe('AC 5 — a preservation request records the case, is audited, and reaches the queue', () => {
  it('records the case reference and snapshots the retention that applied', async () => {
    if (!reachable) return;
    const caseRef = `FIR/${TAG}/0001`;
    const windowStart = new Date(Date.now() - 2 * MS_PER_DAY).toISOString();
    const body = await requestPreservation('in7', caseRef, windowStart);

    expect(body.request.caseRef).toBe(caseRef);
    expect(body.request.status).toBe('open');
    expect(body.request.requestedByBadgeNo).toBe('GP-SUP-0100');
    // The snapshot: what the registry declared at the moment the officer acted.
    expect(body.request.retentionDaysAtRequest).toBe(7);
    expect(body.request.expiresAtAtRequest).toBe(
      new Date(new Date(windowStart).getTime() + 7 * MS_PER_DAY).toISOString(),
    );

    const rows = await db.execute<{ case_ref: string; audit_hash: string }>(sql`
      select case_ref, audit_hash from preservation_requests where id = ${body.request.id}::uuid`);
    expect(rows[0]?.case_ref).toBe(caseRef);
    expect(rows[0]?.audit_hash).toBe(body.auditHash);
  });

  it('appends the act to D3-04’s chain, with the case reference and the actor', async () => {
    if (!reachable) return;
    const caseRef = `FIR/${TAG}/0002`;
    const body = await requestPreservation('in15', caseRef, new Date().toISOString());

    const entries = await db.execute<{
      action: string;
      case_ref: string | null;
      target_id: string | null;
      actor_badge_no: string | null;
      purpose: string;
      params: Record<string, unknown>;
    }>(sql`
      select action, case_ref, target_id, actor_badge_no, purpose, params
        from audit_log where hash = ${body.auditHash}`);

    const entry = entries[0];
    expect(entry?.action).toBe('evidence.preservation_request');
    expect(entry?.case_ref).toBe(caseRef);
    expect(entry?.target_id).toBe(`${TAG}-in15`);
    expect(entry?.actor_badge_no).toBe('GP-SUP-0100');
    expect(entry?.purpose).toContain('Snatching investigation');
    // What the officer was told about the footage's lifetime is part of why they acted, so it
    // belongs in the chain and not only in the row.
    expect(entry?.params['retentionDaysAtRequest']).toBe(15);
  });

  it('appears on the queue, filterable by case reference', async () => {
    if (!reachable) return;
    const caseRef = `FIR/${TAG}/0003`;
    const created = await requestPreservation('in90', caseRef, new Date().toISOString());

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/preservation?case_ref=${encodeURIComponent(caseRef)}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { id: string; caseRef: string }[];
      counts: { open: number };
      disclaimer: string;
    }>();

    expect(body.data.map((r) => r.id)).toEqual([created.request.id]);
    expect(body.counts.open).toBe(1);
  });

  it('a request against undeclared retention is recorded, with the unknown snapshotted as unknown', async () => {
    if (!reachable) return;
    // The most urgent kind of request there is — footage of unknown lifetime — and the one a
    // schema that defaulted `retention_days` would have quietly mis-recorded.
    const body = await requestPreservation('inNull', `FIR/${TAG}/0004`, new Date().toISOString());
    expect(body.request.retentionDaysAtRequest).toBeNull();
    expect(body.request.expiresAtAtRequest).toBeNull();
    expect(body.request.retention.state).toBe('unknown');
  });

  it('refuses a request with no case reference, and one with a reversed window', async () => {
    if (!reachable) return;
    const noCase = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/preservation',
      headers: auth('supervisor'),
      payload: {
        cameraId: cameraIds[`${TAG}-in7`],
        windowStart: new Date().toISOString(),
        windowEnd: new Date(Date.now() + MS_PER_HOUR).toISOString(),
        purpose: 'no case reference given',
      },
    });
    expect(noCase.statusCode).toBe(400);

    const now = Date.now();
    const reversed = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/preservation',
      headers: auth('supervisor'),
      payload: {
        cameraId: cameraIds[`${TAG}-in7`],
        windowStart: new Date(now).toISOString(),
        windowEnd: new Date(now - MS_PER_HOUR).toISOString(),
        caseRef: `FIR/${TAG}/0005`,
        purpose: 'window runs backwards',
      },
    });
    expect(reversed.statusCode).toBe(400);
  });

  it('an auditor may read the queue but may not create a request', async () => {
    if (!reachable) return;
    // An auditor who can instruct another department about evidence is not an auditor.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/preservation',
      headers: auth('auditor'),
      payload: {
        cameraId: cameraIds[`${TAG}-in7`],
        windowStart: new Date().toISOString(),
        windowEnd: new Date(Date.now() + MS_PER_HOUR).toISOString(),
        caseRef: `FIR/${TAG}/0006`,
        purpose: 'auditors do not preserve',
      },
    });
    expect(res.statusCode).toBe(403);

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/evidence/preservation',
      headers: auth('auditor'),
    });
    expect(read.statusCode).toBe(200);
  });

  it('orders the queue by urgency recomputed against now, not by the snapshot', async () => {
    if (!reachable) return;
    const caseRef = `FIR/${TAG}/0100`;
    // Made in this order: a comfortable one first, then an expired one. Urgency must reorder them.
    await requestPreservation('in90', caseRef, new Date().toISOString());
    await requestPreservation('in7', caseRef, new Date(Date.now() - 30 * MS_PER_DAY).toISOString());

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/evidence/preservation?case_ref=${encodeURIComponent(caseRef)}`,
      headers: auth('operator'),
    });
    const body = res.json<{ data: { cameraExternalId: string; retention: { state: string } }[] }>();

    expect(body.data[0]?.retention.state).toBe('expired');
    expect(body.data[0]?.cameraExternalId).toBe(`${TAG}-in7`);
    expect(body.data[1]?.cameraExternalId).toBe(`${TAG}-in90`);
  });
});

// ── AC 7 · the clock reaches the alert and trace views ──────────────────────────────────────────

describe('AC 7 — retention state travels with the alert and with every trace sighting', () => {
  it('every trace sighting carries its own retention state, from its own camera', async () => {
    if (!reachable) return;
    // Two sightings of one vehicle: one on a 7-day camera, one on a camera whose department
    // declared nothing. A trace that reported a single retention figure for the vehicle would be
    // wrong about one of them, which is why the field is per sighting.
    const res = await app.inject({
      method: 'GET',
      url:
        `/api/v1/trace?plate=${PLATE}&purpose=${encodeURIComponent('D3-05 retention badge check')}` +
        `&from=${encodeURIComponent(new Date(Date.now() - 2 * MS_PER_DAY).toISOString())}`,
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      sightings: {
        cameraExternalId: string;
        retention: { state: string; retentionDays: number | null; expiringSoonHours: number };
      }[];
    }>();

    const on7 = body.sightings.find((s) => s.cameraExternalId === `${TAG}-in7`);
    const onNull = body.sightings.find((s) => s.cameraExternalId === `${TAG}-inNull`);

    expect(on7?.retention.retentionDays).toBe(7);
    expect(on7?.retention.state).toBe('available');
    expect(onNull?.retention.state).toBe('unknown');
    expect(onNull?.retention.retentionDays).toBeNull();
    expect(on7?.retention.expiringSoonHours).toBe(env.RETENTION_EXPIRING_SOON_HOURS);
  });

  it('an alert carries "this evidence expires in N" on the list and on the detail', async () => {
    if (!reachable) return;
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/alerts?cameraId=${cameraIds[`${TAG}-in7`] ?? ''}`,
      headers: auth('operator'),
    });
    expect(list.statusCode).toBe(200);
    const alerts = list.json<{
      data: { id: string; retention: { state: string; retentionDays: number | null; label: string } }[];
    }>();

    const alert = alerts.data[0];
    expect(alert, 'the fixture alert should be on the queue').toBeDefined();
    expect(alert?.retention.retentionDays).toBe(7);
    expect(alert?.retention.state).toBe('available');
    expect(alert?.retention.label).toMatch(/left$/);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/alerts/${alert?.id ?? ''}`,
      headers: auth('operator'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ retention: { retentionDays: number | null } }>().retention.retentionDays).toBe(7);
  });
});

describe('AC 6 — the API states the limit of a preservation request, in the exact words', () => {
  it('returns the shared disclaimer on the create response and on the queue', async () => {
    if (!reachable) return;
    const created = await requestPreservation('in7', `FIR/${TAG}/0007`, new Date().toISOString());
    expect(created.disclaimer).toBe(PRESERVATION_DISCLAIMER);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/evidence/preservation?limit=1',
      headers: auth('operator'),
    });
    expect(res.json<{ disclaimer: string }>().disclaimer).toBe(PRESERVATION_DISCLAIMER);
    // The claim itself, asserted rather than assumed: no surface may imply retention was extended.
    expect(PRESERVATION_DISCLAIMER).toContain('does NOT extend retention automatically');
  });
});
