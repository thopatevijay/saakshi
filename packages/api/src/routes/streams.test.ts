/**
 * `/api/v1/streams/:id/detections` — one analytics run per frame, and an honest truncation flag
 * (D4-17).
 *
 * Against the real migrated database via `app.inject()`, like the rest of the route suites. The
 * seeded camera replays the situation measured on cam04: two runs over the **same frames**, each
 * anchoring its own `ts` epoch and minting its own session-qualified track ids, so neither
 * `(frame_pts_ms, track_id)` nor anything else in the row collapses them.
 *
 * Requires `make up && make migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildServer, type App } from '../server.js';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { cutAtFrameBoundary } from './streams.js';

const TAG = `STREAMS-${String(Date.now())}`;
/** Ten frames at 25 fps. */
const FRAMES = Array.from({ length: 10 }, (_, i) => 1000 + i * 40);
/** Boxes per frame per run. */
const PER_FRAME = 3;

let app: App;
let rawSql: Sql;
let db: Db;
let env: Env;
let reachable = false;
let cameraId = '';
const admin = { sub: '', badgeNo: 'GP-ADM-0001' };

interface Body {
  truncated: boolean;
  nextFromPtsMs: number | null;
  detections: {
    ptsMs: number;
    ts: string;
    trackId: number;
    plate: string | null;
    plateConfidence: number | null;
  }[];
}

function auth(): { authorization: string } {
  return {
    authorization: `Bearer ${app.jwt.sign({ ...admin, role: 'admin', departmentId: null })}`,
  };
}

/** One analytics run: every frame, its own epoch, its own track-id range. */
async function seedRun(epochIso: string, trackBase: number, frames: number[]): Promise<void> {
  for (const pts of frames) {
    for (let k = 0; k < PER_FRAME; k += 1) {
      await db.execute(sql`
        insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
        values (${cameraId}::uuid, ${epochIso}::timestamptz + make_interval(secs => ${pts / 1000}),
                ${pts}, ${trackBase + k}, 'car', '{"x":10,"y":10,"w":50,"h":40}'::jsonb, 0.9)`);
    }
  }
}

async function get(query: string): Promise<{ status: number; body: Body }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/streams/${cameraId}/detections?${query}`,
    headers: auth(),
  });
  return { status: res.statusCode, body: res.json<Body>() };
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[streams] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const users = await db.execute<{ id: string }>(
    sql`select id from users where badge_no = ${admin.badgeNo}`,
  );
  admin.sub = users[0]?.id ?? '';
  if (admin.sub === '') throw new Error(`seed user ${admin.badgeNo} missing`);

  const created = await db.execute<{ id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind)
    values (${`${TAG}-replayed`}, 'Replayed VOD', 'hls') returning id::text`);
  cameraId = created[0]?.id ?? '';

  // Run A (older) covers every frame; run B (newer) covers all but the last two, the shape of a
  // run that was stopped early. Track ids are session-qualified, so they differ per run.
  await seedRun('2026-10-05T10:00:00Z', 1_000_001, FRAMES);
  await seedRun('2026-10-07T10:00:00Z', 2_000_001, FRAMES.slice(0, -2));

  // One plate read on run B's first frame, and one the grammar rejected (raw text only).
  await db.execute(sql`
    insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence)
    select id, ts, 'GJ01AB1234', 'GJ01AB1234', 0.87 from sightings
     where camera_id = ${cameraId}::uuid and frame_pts_ms = ${FRAMES[0] ?? 0} and track_id = 2000001
    union all
    select id, ts, 'SHOP SIGN', null, 0.41 from sightings
     where camera_id = ${cameraId}::uuid and frame_pts_ms = ${FRAMES[0] ?? 0} and track_id = 2000002`);

  app = await buildServer({ env, db });
  await app.ready();
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`
      delete from plate_reads where sighting_id in
        (select id from sightings where camera_id = ${cameraId}::uuid)`);
    await db.execute(sql`delete from sightings where camera_id = ${cameraId}::uuid`);
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  }
  await app?.close();
  await rawSql?.end();
});

describe('GET /api/v1/streams/:id/detections — one run per frame', () => {
  it('returns exactly one ts per frame_pts_ms, from the newest run that covered it', async () => {
    if (!reachable) return;
    const { status, body } = await get('fromPtsMs=0&toPtsMs=5000&limit=500');
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.nextFromPtsMs).toBeNull();

    const tsByFrame = new Map<number, Set<string>>();
    for (const d of body.detections) {
      tsByFrame.set(d.ptsMs, (tsByFrame.get(d.ptsMs) ?? new Set()).add(d.ts));
    }
    expect([...tsByFrame.keys()].sort((a, b) => a - b)).toEqual(FRAMES);
    for (const set of tsByFrame.values()) expect(set.size).toBe(1);

    // One run's worth of boxes per frame — not two runs' worth.
    expect(body.detections).toHaveLength(FRAMES.length * PER_FRAME);
    // Frames run B covered come from run B; the two it never reached fall back to run A.
    const covered = new Set(FRAMES.slice(0, -2));
    for (const d of body.detections) {
      expect(d.trackId >= 2_000_000).toBe(covered.has(d.ptsMs));
    }
  });

  it('attaches the plate read, falling back to the raw text when the grammar rejected it', async () => {
    if (!reachable) return;
    const { body } = await get('fromPtsMs=0&toPtsMs=5000&limit=500');
    // The reads were seeded on the first frame only; the same track ids recur on later frames.
    const firstFrame = body.detections.filter((d) => d.ptsMs === FRAMES[0]);
    const byTrack = new Map(firstFrame.map((d) => [d.trackId, d]));
    expect(byTrack.get(2_000_001)?.plate).toBe('GJ01AB1234');
    expect(byTrack.get(2_000_001)?.plateConfidence).toBeCloseTo(0.87);
    expect(byTrack.get(2_000_002)?.plate).toBe('SHOP SIGN');
    expect(byTrack.get(2_000_003)?.plate).toBeNull();
    expect(byTrack.get(2_000_003)?.plateConfidence).toBeNull();
  });

  it('flags a response cut by the limit, on a frame boundary, and pages to the rest', async () => {
    if (!reachable) return;
    // 7 rows fit two whole frames (6 rows) and one row of the third: that row must not be sent.
    const first = await get('fromPtsMs=0&toPtsMs=5000&limit=7');
    expect(first.status).toBe(200);
    expect(first.body.truncated).toBe(true);
    expect(first.body.detections).toHaveLength(2 * PER_FRAME);
    expect(first.body.nextFromPtsMs).toBe(FRAMES[2]);

    // Following nextFromPtsMs covers the window with no frame missing and none repeated.
    const seen: number[] = first.body.detections.map((d) => d.ptsMs);
    let from = first.body.nextFromPtsMs;
    for (let guard = 0; from !== null && guard < 20; guard += 1) {
      const next = await get(`fromPtsMs=${String(from)}&toPtsMs=5000&limit=7`);
      seen.push(...next.body.detections.map((d) => d.ptsMs));
      from = next.body.truncated ? next.body.nextFromPtsMs : null;
    }
    expect(seen).toHaveLength(FRAMES.length * PER_FRAME);
    expect([...new Set(seen)]).toEqual(FRAMES);
  });

  it('accepts the overlay limit of 2000 and rejects more', async () => {
    if (!reachable) return;
    expect((await get('fromPtsMs=0&toPtsMs=5000&limit=2000')).status).toBe(200);
    expect((await get('fromPtsMs=0&toPtsMs=5000&limit=2001')).status).toBe(400);
  });
});

describe('cutAtFrameBoundary', () => {
  const rows = (pts: number[]): { ptsMs: number }[] => pts.map((ptsMs) => ({ ptsMs }));

  it('is complete when the probe row is absent', () => {
    expect(cutAtFrameBoundary(rows([1, 1, 2]), 3)).toEqual({
      rows: rows([1, 1, 2]),
      truncated: false,
      nextFromPtsMs: null,
    });
  });

  it('drops a partial frame and resumes at it', () => {
    expect(cutAtFrameBoundary(rows([1, 1, 2, 2]), 3)).toEqual({
      rows: rows([1, 1]),
      truncated: true,
      nextFromPtsMs: 2,
    });
  });

  it('returns a single oversized frame partially rather than looping on it', () => {
    expect(cutAtFrameBoundary(rows([5, 5, 5]), 2)).toEqual({
      rows: rows([5, 5]),
      truncated: true,
      nextFromPtsMs: 6,
    });
  });
});
