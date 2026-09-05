/**
 * A traceable vehicle, so the trace screen can be demonstrated and verified (D2-08).
 *
 * **Why fixtures are unavoidable here, stated plainly.** The measured estate cannot produce a
 * vehicle trace: 30 cameras with **no coordinates**, 28,438 real detections with **no plate reads**
 * and **no crops**, because D2-01 read 0 plates exactly across 120 hand-labelled instances (only 3
 * carried a human-legible plate at all). A screen that traces a registration across a map has
 * nothing to render against, and `scripts/measure-trace-linking.*` reports that as the finding it
 * is. This seeder exists so the *screen* stays demonstrable and verifiable while the *estate*
 * measurement stays untouched — the same bargain D2-09 struck for the registry map.
 *
 * **The rules it keeps, which are D2-09's rules:**
 *  - every row it creates is unmistakably a fixture, under the reserved `TRACEFIX-` prefix;
 *  - it **never** writes a coordinate onto a real camera, and never touches a real row at all;
 *  - removal is complete and idempotent, and `--remove` alone is enough to clean up after a crash.
 *
 * **The evidence crops are real.** They come from `fixtures/plate-eval/crops` — actual frames from
 * the live estate, the corpus D2-01 hand-labelled. What is synthetic is the *itinerary*: one
 * vehicle passing five cameras. Nothing here should be quoted as an observation.
 *
 *   npm run demo:trace -w packages/api -- --seed
 *   npm run demo:trace -w packages/api -- --remove
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { evidenceStoreFromEnv } from '../services/evidence.js';

export const FIXTURE_PREFIX = 'TRACEFIX-';
/** The registration the demo traces. Real-shaped; it names no real vehicle. */
export const DEMO_PLATE = 'GJ01AB1234';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CROPS = path.resolve(HERE, '../../../../fixtures/plate-eval/crops');

/**
 * Five cameras along a plausible Ahmedabad itinerary, and one that is deliberately **unplaced**.
 *
 * The unplaced camera is not padding: it is the state of every real camera on this estate, and a
 * demo where every pin has coordinates would never show the "not placed" path an operator will
 * actually meet.
 */
const CAMERAS: { id: string; name: string; lon: number | null; lat: number | null }[] = [
  { id: 'CAM-A', name: 'Paldi Circle (fixture)', lon: 72.5714, lat: 23.0225 },
  { id: 'CAM-B', name: 'Janpath (fixture)', lon: 72.5871, lat: 23.0311 },
  { id: 'CAM-C', name: 'Chimanbhai Bridge (fixture)', lon: 72.6042, lat: 23.0398 },
  { id: 'CAM-D', name: 'Visat Teen Rasta (fixture)', lon: 72.6218, lat: 23.0611 },
  { id: 'CAM-E', name: 'Naroda Road (fixture, unplaced)', lon: null, lat: null },
];

/**
 * The itinerary.
 *
 * The reads reproduce what this estate actually does to a plate: two exact, two truncated the way
 * `GJ35U0779 → GJ35U07` was truncated, and one with a confusable substitution. `trackId` is
 * session-qualified the way D1-09 writes it, and **camera A is visited twice in two different
 * tracking sessions with the same raw tracker id (1)** — the exact reuse D1-09 measured on `cam03`,
 * so the demo exercises the case where grouping on a raw track id would fuse two passes into one.
 */
const ITINERARY: {
  camera: string;
  minute: number;
  raw: string;
  normalized: string;
  confidence: number;
  trackId: number;
  crop: string;
  color: string;
  colorConfidence: number;
}[] = [
  {
    camera: 'CAM-A',
    minute: 0,
    raw: 'GJ 01 AB 1234',
    normalized: 'GJ01AB1234',
    confidence: 0.88,
    trackId: 300001,
    crop: 'day_cam04_122_02_plate.jpg',
    color: 'white',
    colorConfidence: 0.71,
  },
  // D3-01 added this one. Same camera, same *tracking session and raw tracker id* as the stop
  // above, 45 seconds later: ByteTrack never dropped the vehicle between the two frames, so the
  // movement between them is the one thing on this whole itinerary that was actually **observed**.
  // Without it every segment of the demo route is inferred, and a screen whose entire point is the
  // observed/inferred distinction would only ever be able to show one of the two.
  // (`0.75` and not `2/3`: `frame_pts_ms` is an integer column and 0.667 x 60000 is not one.)
  {
    camera: 'CAM-A',
    minute: 0.75,
    raw: 'GJ 01 AB 1234',
    normalized: 'GJ01AB1234',
    confidence: 0.9,
    trackId: 300001,
    crop: 'day_cam04_122_02_plate.jpg',
    color: 'white',
    colorConfidence: 0.73,
  },
  {
    camera: 'CAM-B',
    minute: 6,
    raw: 'GJ01AB1234',
    normalized: 'GJ01AB1234',
    confidence: 0.79,
    trackId: 400012,
    crop: 'day_cam07_050_09_plate.jpg',
    color: 'white',
    colorConfidence: 0.64,
  },
  {
    camera: 'CAM-C',
    minute: 13,
    raw: 'GJ01AB12',
    normalized: 'GJ01AB12',
    confidence: 0.61,
    trackId: 500007,
    crop: 'day_cam07_070_01_plate.jpg',
    color: 'silver',
    colorConfidence: 0.42,
  },
  {
    camera: 'CAM-D',
    minute: 21,
    raw: 'GJ01A81234',
    normalized: 'GJ01A81234',
    confidence: 0.55,
    trackId: 600004,
    crop: 'day_cam07_097_01_plate.jpg',
    color: 'white',
    colorConfidence: 0.38,
  },
  {
    camera: 'CAM-A',
    minute: 34,
    raw: 'GJ01AB1234',
    normalized: 'GJ01AB1234',
    confidence: 0.83,
    trackId: 700001,
    crop: 'day_cam07_114_05_plate.jpg',
    color: 'white',
    colorConfidence: 0.69,
  },
  {
    camera: 'CAM-E',
    minute: 41,
    raw: 'GJ01AB123',
    normalized: 'GJ01AB123',
    confidence: 0.58,
    trackId: 800002,
    crop: 'day_cam04_122_02_plate.jpg',
    color: 'white',
    colorConfidence: 0.51,
  },
];

/** Anchored so a demo and a screenshot show the same times whenever they are taken. */
const START = new Date('2026-09-05T09:00:00.000Z');

async function main(): Promise<void> {
  const mode = process.argv.includes('--remove') ? 'remove' : 'seed';
  const env = loadEnv({ ...process.env });
  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  try {
    // Removal first in both modes: seeding is idempotent, and a re-run must not double the route.
    const before = await countReal(db);
    await db.execute(
      sql`delete from plate_reads where crop_uri like ${`s3://%/evidence/${FIXTURE_PREFIX}%`}`,
    );
    await db.execute(sql`
      delete from sightings
       where camera_id in (select id from cameras where external_id like ${`${FIXTURE_PREFIX}%`})
    `);
    await db.execute(sql`
      delete from camera_health_checks
       where camera_id in (select id from cameras where external_id like ${`${FIXTURE_PREFIX}%`})
    `);
    const removed = await db.execute<{ n: string }>(
      sql`with d as (delete from cameras where external_id like ${`${FIXTURE_PREFIX}%`} returning 1)
          select count(*)::text as n from d`,
    );
    out(`removed ${removed[0]?.n ?? '0'} ${FIXTURE_PREFIX} cameras and everything under them`);

    if (mode === 'remove') {
      const after = await countReal(db);
      out(`real cameras before ${String(before)} · after ${String(after)} — must be equal`);
      if (before !== after) throw new Error('a real camera row changed; that must never happen');
      return;
    }

    const ids = new Map<string, string>();
    for (const camera of CAMERAS) {
      const point =
        camera.lon === null || camera.lat === null
          ? sql`null`
          : sql`st_setsrid(st_makepoint(${camera.lon}, ${camera.lat}), 4326)::geography`;
      const rows = await db.execute<{ id: string }>(sql`
        insert into cameras (external_id, name, adapter_kind, endpoints, district, location)
        values (${`${FIXTURE_PREFIX}${camera.id}`}, ${camera.name}, 'hls', '{}'::jsonb,
                ${camera.lat === null ? null : 'Ahmedabad'}, ${point})
        returning id::text as id
      `);
      ids.set(camera.id, rows[0]?.id ?? '');
    }

    const store = evidenceStoreFromEnv();
    if (store === null) {
      out('no object store configured — crops will be seeded as URIs with no bytes behind them');
    }

    for (const stop of ITINERARY) {
      const ts = new Date(START.getTime() + stop.minute * 60_000).toISOString();
      const day = ts.slice(0, 10);
      // D2-02's key convention: named by the **track_id**, not the sighting id.
      const key = `evidence/${FIXTURE_PREFIX}${stop.camera}/${day}/${String(stop.trackId)}-plate.jpg`;
      const cropUri = store === null ? null : `s3://${store.bucket}/${key}`;

      if (store !== null) {
        await store.putObject(key, readFileSync(path.join(CROPS, stop.crop)), 'image/jpeg');
      }

      const rows = await db.execute<{ id: string }>(sql`
        insert into sightings
          (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
           vehicle_color, vehicle_color_confidence, attributes_low_confidence, crop_uri, is_best_shot)
        values (${ids.get(stop.camera) ?? ''}::uuid, ${ts}, ${stop.minute * 60_000}, ${stop.trackId},
                'car', '{"x":120,"y":220,"w":180,"h":140}'::jsonb, 0.912,
                ${stop.color}, ${stop.colorConfidence}, ${stop.colorConfidence < 0.5}, ${cropUri}, true)
        returning id::text as id
      `);
      await db.execute(sql`
        insert into plate_reads
          (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri, is_best_shot)
        values (${rows[0]?.id ?? ''}::uuid, ${ts}, ${stop.raw}, ${stop.normalized}, ${stop.confidence},
                3, ${cropUri}, true)
      `);
    }

    const after = await countReal(db);
    out(
      `seeded ${String(CAMERAS.length)} fixture cameras and ${String(ITINERARY.length)} sightings for ${DEMO_PLATE}`,
    );
    out(`real cameras before ${String(before)} · after ${String(after)} — must be equal`);
    if (before !== after) throw new Error('a real camera row changed; that must never happen');
    out(`trace it:  /trace?plate=${DEMO_PLATE}`);
  } finally {
    await rawSql.end();
  }
}

/** Real cameras are the invariant: this number must be identical before and after, always. */
async function countReal(db: ReturnType<typeof createDb>): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from cameras where external_id not like ${`${FIXTURE_PREFIX}%`}`,
  );
  return Number(rows[0]?.n ?? 0);
}

await main();
