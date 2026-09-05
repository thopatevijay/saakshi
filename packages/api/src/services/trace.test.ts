/**
 * D2-08 — vehicle trace v1.
 *
 * Against the real migrated database, through the real HTTP surface where the assertion is about
 * the endpoint, because ordering is a SQL property and a mocked query builder proves nothing about
 * it. Skips loudly when the database is unreachable.
 *
 * **Why the suite seeds its own corpus rather than tracing a plate off the estate.** The measured
 * corpus this repo carries has 28,438 real detections and **zero plate reads** — D2-01 read 0
 * plates exactly across 120 hand-labelled instances because only 3 of them were human-legible at
 * all. There is therefore no plate on the real estate to trace. The behavioural assertions run
 * against a seeded corpus with a per-run tag; the honest estate-wide number is measured separately
 * by `scripts/measure-trace-linking.mjs` and reported as it stands.
 *
 * `sightings`, `plate_reads` and `cameras` have no per-suite namespace and D2-04's benchmark seeds
 * 250,000 rows into the first two, so every count assertion here is scoped by `camera_id` or by the
 * suite tag, never taken over a whole table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { buildServer, type App } from '../server.js';
import type { UserRole } from '../auth.js';
import { TraceService, buildSegments, type TraceResult, type TraceSighting } from './trace.js';
import { TRACE_CSV_COLUMNS, traceCsv, tracePdf } from './trace-export.js';

const TAG = `TR${String(Date.now()).slice(-9)}`;
/** The registration the whole suite traces. Real-shaped; it names no real vehicle. */
const PLATE = 'GJ01AB1234';
/** What a truncating camera made of it — the dominant failure D2-04 measured on this estate. */
const TRUNCATED = 'GJ01AB12';
const LONELY = 'GJ18Y9407';

const actors: Record<UserRole, { sub: string; badgeNo: string }> = {
  admin: { sub: '', badgeNo: 'GP-ADM-0001' },
  supervisor: { sub: '', badgeNo: 'GP-SUP-0100' },
  operator: { sub: '', badgeNo: 'GP-OPR-1042' },
  auditor: { sub: '', badgeNo: 'GP-AUD-0007' },
};

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;
let service: TraceService;
const cameras: Record<string, string> = {};

function auth(role: UserRole): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ ...actors[role], role, departmentId: null })}` };
}

/**
 * The seeded route. Deliberately inserted **out of chronological order** and with `ingested_at`
 * running backwards relative to `ts`, so a trace that ordered by insertion or by arrival time would
 * come back visibly wrong rather than accidentally right.
 *
 * `trackId` values are session-qualified the way D1-09 writes them (`session * 100_000 + raw`), and
 * the two `cam-a` rows deliberately reuse **raw tracker id 1 across sessions 3 and 7** — the exact
 * shape D1-09 measured on `cam03`. A trace that grouped on the raw id would fuse them.
 */
const ROUTE: {
  camera: 'a' | 'b' | 'c';
  ts: string;
  raw: string;
  normalized: string;
  confidence: number;
  trackId: number;
  ingestOffsetS: number;
}[] = [
  // insertion order 1 — chronologically third, and the *first* to arrive
  { camera: 'b', ts: '2026-05-10T09:20:00.000Z', raw: 'GJ01AB1234', normalized: PLATE, confidence: 0.72, trackId: 400002, ingestOffsetS: 0 },
  // insertion order 2 — chronologically first, and the *last* to arrive: a reconnect replaying a
  // buffered GOP is exactly this shape, and it is why arrival time cannot be the clock.
  { camera: 'a', ts: '2026-05-10T09:00:00.000Z', raw: 'GJ 01 AB 1234', normalized: PLATE, confidence: 0.9, trackId: 300001, ingestOffsetS: 2400 },
  // insertion order 3 — chronologically fourth, and a fuzzy (truncated) read
  { camera: 'c', ts: '2026-05-10T09:35:00.000Z', raw: 'GJ01AB12', normalized: TRUNCATED, confidence: 0.55, trackId: 900003, ingestOffsetS: 60 },
  // insertion order 4 — chronologically second, same camera as the first but a *different session*
  { camera: 'a', ts: '2026-05-10T09:10:00.000Z', raw: 'GJ01AB1234', normalized: PLATE, confidence: 0.81, trackId: 700001, ingestOffsetS: 1500 },
];

async function seedSighting(row: (typeof ROUTE)[number]): Promise<void> {
  const cameraId = cameras[row.camera] ?? '';
  const ingestedAt = new Date(Date.parse(row.ts) + row.ingestOffsetS * 1000).toISOString();
  const rows = await db.execute<{ id: string }>(sql`
    insert into sightings
      (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
       vehicle_color, vehicle_color_confidence, attributes_low_confidence, crop_uri, is_best_shot,
       ingested_at)
    values (${cameraId}::uuid, ${row.ts}, ${Math.round(Date.parse(row.ts) % 1_000_000)},
            ${row.trackId}, 'car', '{"x":0,"y":0,"w":100,"h":80}'::jsonb, 0.910,
            'white', 0.640, false, ${`s3://saakshi-evidence/evidence/${TAG}/${String(row.trackId)}-plate.jpg`},
            true, ${ingestedAt})
    returning id::text as id
  `);
  await db.execute(sql`
    insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri, is_best_shot)
    values (${rows[0]?.id ?? ''}::uuid, ${row.ts}, ${row.raw}, ${row.normalized}, ${row.confidence}, 3,
            ${`s3://saakshi-evidence/evidence/${TAG}/${String(row.trackId)}-plate.jpg`}, true)
  `);
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[trace] database unreachable — skipping. Run `make up && make migrate`.');
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

  // Three cameras. Two are placed so a segment can carry a real distance; the third is deliberately
  // left **unplaced**, because that is the state of every one of the thirty real cameras and a
  // suite where every camera has coordinates would never exercise the branch that matters.
  const seeded = await db.execute<{ id: string; external_id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind, endpoints, district, location)
    values
      (${`${TAG}-CAM-A`}, 'D2-08 Paldi Circle (test)', 'hls', '{}'::jsonb, 'Ahmedabad',
       st_setsrid(st_makepoint(72.5714, 23.0225), 4326)::geography),
      (${`${TAG}-CAM-B`}, 'D2-08 Janpath (test)', 'hls', '{}'::jsonb, 'Ahmedabad',
       st_setsrid(st_makepoint(72.6014, 23.0425), 4326)::geography),
      (${`${TAG}-CAM-C`}, 'D2-08 unplaced camera (test)', 'hls', '{}'::jsonb, null, null)
    returning id::text as id, external_id
  `);
  for (const row of seeded) {
    const key = row.external_id.endsWith('-A') ? 'a' : row.external_id.endsWith('-B') ? 'b' : 'c';
    cameras[key] = row.id;
  }

  for (const row of ROUTE) await seedSighting(row);

  // A plate seen exactly once, for the degenerate case.
  await seedSighting({
    camera: 'a',
    ts: '2026-05-11T04:00:00.000Z',
    raw: LONELY,
    normalized: LONELY,
    confidence: 0.88,
    trackId: 1_200_004,
    ingestOffsetS: 0,
  });

  service = new TraceService(db, undefined, (uri) => `https://evidence.test/${uri.slice(5)}`);
  app = await buildServer({ env, db });
  await app.ready();
}, 90_000);

afterAll(async () => {
  if (reachable) {
    await db.execute(
      sql`delete from plate_reads where crop_uri like ${`s3://saakshi-evidence/evidence/${TAG}/%`}`,
    );
    await db.execute(
      sql`delete from sightings where camera_id in (select id from cameras where external_id like ${`${TAG}%`})`,
    );
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

const cameraIds = (): string[] => [cameras['a'] ?? '', cameras['b'] ?? '', cameras['c'] ?? ''];

async function trace(plate: string, over: Record<string, unknown> = {}): Promise<TraceResult> {
  return service.trace(plate, { cameraIds: cameraIds(), ...over });
}

/* ── AC 1 · chronological order by PTS-derived timestamp ─────────────────────────────────────── */

describe('AC 1 — ordering is by the PTS-derived timestamp, not insertion order', () => {
  it('deliberately out-of-order inserts still trace chronologically', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);

    expect(result.sightings.length).toBe(4);
    const timestamps = result.sightings.map((s) => s.ts);
    expect(timestamps).toEqual([...timestamps].sort());
    expect(timestamps).toEqual([
      '2026-05-10T09:00:00.000Z',
      '2026-05-10T09:10:00.000Z',
      '2026-05-10T09:20:00.000Z',
      '2026-05-10T09:35:00.000Z',
    ]);
    // `seq` is dense, 1-based and follows the same order the map and the timeline both label by.
    expect(result.sightings.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  it('the arrival clock disagrees with the answer, which is the point', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ ts: string; ingested_at: string }>(sql`
      select ts, ingested_at from sightings
       where camera_id in ${cameraIds().map((id) => sql`${id}::uuid`)}
       order by ingested_at asc
    `);
    const byArrival = rows.map((r) => new Date(r.ts).toISOString());
    // If ordering by arrival happened to agree with ordering by PTS, this test would pass while
    // proving nothing — so assert the two genuinely differ on the seeded corpus.
    expect(byArrival).not.toEqual([...byArrival].sort());
  });

  it('a track_id is split into its session and its raw tracker id, and is never a grouping key', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const onCamA = result.sightings.filter((s) => s.cameraId === cameras['a']);
    expect(onCamA).toHaveLength(2);
    // The same raw ByteTrack id in two different sessions — D1-09 measured exactly this on cam03.
    expect(onCamA.map((s) => s.rawTrackerId)).toEqual([1, 1]);
    expect(onCamA.map((s) => s.trackingSession)).toEqual([3, 7]);
    // Two sightings, not one: nothing fused them on the raw id.
    expect(new Set(onCamA.map((s) => s.sightingId)).size).toBe(2);
  });
});

/* ── AC 2 · fuzzy links included, flagged and filterable ─────────────────────────────────────── */

describe('AC 2 — fuzzy links are included, flagged, and filterable by min_confidence', () => {
  it('the truncated read is present and flagged plate_fuzzy, the exact ones plate_exact', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const methods = result.sightings.map((s) => s.linkMethod);
    expect(methods.filter((m) => m === 'plate_exact')).toHaveLength(3);
    expect(methods.filter((m) => m === 'plate_fuzzy')).toHaveLength(1);

    const fuzzy = result.sightings.find((s) => s.linkMethod === 'plate_fuzzy');
    expect(fuzzy?.plateNormalized).toBe(TRUNCATED);
    expect(fuzzy?.matchDistance).toBeGreaterThan(0);
    expect(fuzzy?.matchStrength).toBeLessThan(1);
    expect(fuzzy?.explanation).toContain('not a confirmed registration');
    expect(result.coverage.fuzzyLinks).toBe(1);
    expect(result.coverage.exactLinks).toBe(3);
  });

  it('every sighting carries a confidence in [0,1] built from both halves of the claim', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    for (const s of result.sightings) {
      expect(s.linkConfidence).toBeGreaterThanOrEqual(0);
      expect(s.linkConfidence).toBeLessThanOrEqual(1);
      // strength × ocr, rounded to 3dp by D2-04's rankingScore.
      expect(s.linkConfidence).toBeCloseTo((s.matchStrength ?? 1) * s.ocrConfidence, 2);
    }
  });

  it('raising min_confidence drops the weak link and keeps the strong ones', async () => {
    if (!reachable) return;
    const all = await trace(PLATE, { minConfidence: 0 });
    const strict = await trace(PLATE, { minConfidence: 0.7 });

    expect(all.sightings.length).toBeGreaterThan(strict.sightings.length);
    expect(strict.sightings.every((s) => s.linkConfidence >= 0.7)).toBe(true);
    expect(strict.coverage.fuzzyLinks).toBe(0);
    expect(strict.sightings.map((s) => s.seq)).toEqual(
      strict.sightings.map((_, i) => i + 1),
    );
  });

  it('min_confidence at 1 empties the trace cleanly rather than erroring', async () => {
    if (!reachable) return;
    const result = await trace(PLATE, { minConfidence: 1 });
    expect(result.sightings).toEqual([]);
    expect(result.emptyReason).toBe('below_min_confidence');
  });
});

/* ── AC 5 / AC 6 · the two states that break naive implementations ───────────────────────────── */

describe('AC 5 — a plate with no sightings is a clean empty state, not an error', () => {
  it('returns 200 with an empty trace and a reason', async () => {
    if (!reachable) return;
    const result = await trace('GJ99ZZ9999');
    expect(result.sightings).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.cameras).toEqual([]);
    expect(result.emptyReason).toBe('no_matching_plate');
    expect(result.disclaimer).not.toBe('');
  });

  it('a query the plate grammar refuses is an answer, not a 400', async () => {
    if (!reachable) return;
    // The measured non-plate from the live run: a hoarding's phone number, read at high confidence.
    const result = await trace('757508300');
    expect(result.searched).toBe(false);
    expect(result.emptyReason).toBe('query_not_searchable');
    expect(result.identity).toBeNull();
  });

  it('over HTTP it is a 200, and an auditor is refused the endpoint entirely', async () => {
    if (!reachable) return;
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=GJ99ZZ9999`,
      headers: auth('operator'),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<TraceResult>().sightings).toEqual([]);

    // `trace:run` is deliberately not an auditor capability — the audit function reviews what was
    // done, it does not run investigative queries.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=${PLATE}`,
      headers: auth('auditor'),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('AC 6 — a plate seen at one camera only', () => {
  it('produces one sighting, no segments and no arithmetic on an empty pair', async () => {
    if (!reachable) return;
    const result = await trace(LONELY);
    expect(result.sightings).toHaveLength(1);
    expect(result.segments).toEqual([]);
    expect(result.cameras).toHaveLength(1);
    expect(result.coverage.cameras).toBe(1);
    expect(result.emptyReason).toBeNull();
  });

  it('buildSegments over zero and one sighting is empty, not undefined', () => {
    expect(buildSegments([])).toEqual([]);
    expect(buildSegments([{ seq: 1 } as unknown as TraceSighting])).toEqual([]);
  });
});

/* ── Observed vs inferred ────────────────────────────────────────────────────────────────────── */

describe('observed versus inferred — the distinction D3-01 builds on', () => {
  it('every sighting is observed and every segment is inferred', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    expect(result.sightings.every((s) => s.basis === 'observed')).toBe(true);
    expect(result.segments.every((s) => s.basis === 'inferred')).toBe(true);
    expect(result.segments).toHaveLength(result.sightings.length - 1);
    expect(result.claims.observed).toContain('detection that happened');
    expect(result.claims.inferred).toContain('inferred');
  });

  it('a segment between placed cameras carries a straight-line lower bound and an upper-bound speed', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const ab = result.segments.find((s) => s.fromCameraId === cameras['a'] && s.toCameraId === cameras['b']);
    expect(ab).toBeDefined();
    expect(ab?.straightLineKm).toBeGreaterThan(0);
    expect(ab?.impliedSpeedKmh).toBeGreaterThan(0);
    expect(ab?.note).toContain('lower bound');
  });

  it('a segment touching an unplaced camera has no distance and says why', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const toUnplaced = result.segments.find((s) => s.toCameraId === cameras['c']);
    expect(toUnplaced?.straightLineKm).toBeNull();
    expect(toUnplaced?.impliedSpeedKmh).toBeNull();
    expect(toUnplaced?.note).toContain('no coordinates');
  });

  it('two sightings on one camera claim no transition at all', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const sameCam = result.segments.find((s) => s.sameCamera);
    expect(sameCam?.straightLineKm).toBe(0);
    expect(sameCam?.note).toContain('no transition claimed');
  });

  it('coverage reports the coordinate gap rather than hiding it', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    expect(result.coverage.cameras).toBe(3);
    expect(result.coverage.camerasPlaced).toBe(2);
    expect(result.coverage.sightingsMappable).toBe(3);
    expect(result.sightings.find((s) => s.cameraId === cameras['c'])?.located).toBe(false);
  });
});

/* ── AC 4 · evidence ─────────────────────────────────────────────────────────────────────────── */

describe('AC 4 — the evidence strip has crops in chronological order', () => {
  it('crop URIs are returned in trace order, with a minted URL beside the stored s3 form', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    expect(result.coverage.sightingsWithCrop).toBe(4);
    for (const s of result.sightings) {
      expect(s.cropUri?.startsWith('s3://')).toBe(true);
      expect(s.cropUrl?.startsWith('https://evidence.test/')).toBe(true);
      // D2-02's key convention: the crop is named by the **track_id**, not the sighting id.
      expect(s.cropUri).toContain(`/${String(s.trackId)}-plate.jpg`);
    }
    const order = result.sightings.map((s) => s.ts);
    expect(order).toEqual([...order].sort());
  });

  it('with no object store configured the URL is null rather than a broken link', async () => {
    if (!reachable) return;
    const bare = new TraceService(db);
    const result = await bare.trace(PLATE, { cameraIds: cameraIds() });
    expect(result.sightings.every((s) => s.cropUrl === null)).toBe(true);
    expect(result.sightings.every((s) => s.cropUri !== null)).toBe(true);
  });
});

/* ── AC 7 · CSV ──────────────────────────────────────────────────────────────────────────────── */

describe('AC 7 — CSV export', () => {
  it('the first eight columns are exactly the ones the ticket names, in its order', () => {
    expect(TRACE_CSV_COLUMNS.slice(0, 8)).toEqual([
      'plate',
      'camera_id',
      'camera_name',
      'lat',
      'lon',
      'timestamp',
      'confidence',
      'link_method',
    ]);
  });

  it('a real trace round-trips into rows carrying all eight', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const csv = traceCsv(result);
    const lines = csv.trim().split('\n');

    expect(lines[0]).toBe(TRACE_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(result.sightings.length + 1);

    const first = (lines[1] ?? '').split(',');
    expect(first[0]).toBe(PLATE);
    expect(first[1]).toBe(cameras['a']);
    expect(first[2]).toContain('Paldi');
    expect(Number(first[3])).toBeCloseTo(23.0225, 4);
    expect(Number(first[4])).toBeCloseTo(72.5714, 4);
    expect(first[5]).toBe('2026-05-10T09:00:00.000Z');
    expect(Number(first[6])).toBeGreaterThan(0);
    expect(first[7]).toBe('plate_exact');
  });

  it('an unplaced camera exports empty coordinate cells rather than a fabricated point', async () => {
    if (!reachable) return;
    const result = await trace(PLATE);
    const csv = traceCsv(result);
    const row = csv.split('\n').find((line) => line.includes('unplaced camera'));
    expect(row).toBeDefined();
    const cells = (row ?? '').split(',');
    // camera_name is quoted (it contains no comma here, but assert the coordinate cells directly).
    expect(cells[3]).toBe('');
    expect(cells[4]).toBe('');
  });

  it('a camera name that could be read as a formula is neutralised', () => {
    const result = {
      sightings: [
        {
          plateNormalized: PLATE,
          cameraId: 'c',
          cameraName: '=cmd|calc',
          lat: null,
          lon: null,
          ts: '2026-05-10T09:00:00.000Z',
          linkConfidence: 0.5,
          linkMethod: 'plate_exact',
        } as unknown as TraceSighting,
      ],
    } as unknown as TraceResult;
    expect(traceCsv(result).split('\n')[1]).toContain(`"'=cmd|calc"`);
  });
});

/* ── AC 8 · PDF ──────────────────────────────────────────────────────────────────────────────── */

describe('AC 8 — PDF export', () => {
  it('is a structurally valid PDF with an xref and a trailer', async () => {
    if (!reachable) return;
    const pdf = tracePdf(await trace(PLATE), new Date('2026-09-05T12:00:00Z'));
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('xref');
    expect(text).toContain('trailer');
    expect(pdf.byteLength).toBeGreaterThan(1500);
  });

  it('carries the registration, the coverage counts and the honesty a judge needs', async () => {
    if (!reachable) return;
    const text = tracePdf(await trace(PLATE)).toString('latin1');
    expect(text).toContain('SAAKSHI');
    expect(text).toContain('Vehicle trace report');
    expect(text).toContain(PLATE);
    expect(text).toContain('What this report claims');
    expect(text).toContain('OBSERVED');
    expect(text).toContain('INFERRED');
    expect(text).toContain('ranked possibilities, not identifications');
    // The coordinate gap is stated on page 1, not buried in the rows.
    expect(text).toContain('have coordinates');
  });

  it('an empty trace still produces a presentable one-page report explaining why', async () => {
    if (!reachable) return;
    const text = tracePdf(await trace('757508300')).toString('latin1');
    expect(text).toContain('No sightings for this registration');
    expect(text).toContain('/Count 1');
  });
});

/* ── The endpoint ────────────────────────────────────────────────────────────────────────────── */

describe('the trace endpoints', () => {
  it('GET /api/v1/trace returns the ordered payload the UI renders', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=${PLATE}&camera_ids=${cameraIds().join(',')}`,
      headers: auth('supervisor'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<TraceResult>();
    expect(body.sightings).toHaveLength(4);
    expect(body.sightings.map((s) => s.ts)).toEqual([...body.sightings.map((s) => s.ts)].sort());
    expect(body.identity?.canonicalPlate).toBe(PLATE);
    expect(body.matcher).toBe('confusion-weighted');
    expect(body.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/v1/trace.csv serves a CSV attachment', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace.csv?plate=${PLATE}&camera_ids=${cameraIds().join(',')}`,
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`saakshi-trace-${PLATE}`);
    expect(res.body.split('\n')[0]).toBe(TRACE_CSV_COLUMNS.join(','));
  });

  it('GET /api/v1/trace.pdf serves a PDF attachment', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace.pdf?plate=${PLATE}&camera_ids=${cameraIds().join(',')}`,
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  });

  it('rejects a query the schema cannot accept, with a field-level reason', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=${PLATE}&min_confidence=9`,
      headers: auth('admin'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_failed');
  });

  it('is unauthenticated without a token', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: `/api/v1/trace?plate=${PLATE}` });
    expect(res.statusCode).toBe(401);
  });
});

/* ── AC 9 · latency ──────────────────────────────────────────────────────────────────────────── */

describe('AC 9 — p95 trace latency at demo data volume', () => {
  it('stays under 2 s over 30 traces against the real corpus', async () => {
    if (!reachable) return;
    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      await service.trace(PLATE, {});
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)] ?? 0;
    console.info(
      `[trace] p95 ${p95.toFixed(1)} ms over ${String(samples.length)} traces ` +
        `(min ${(samples[0] ?? 0).toFixed(1)} ms, max ${(samples.at(-1) ?? 0).toFixed(1)} ms)`,
    );
    expect(p95).toBeLessThan(2000);
  }, 120_000);
});
