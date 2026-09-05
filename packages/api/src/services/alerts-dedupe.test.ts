/**
 * Alert dedupe tests (D2-06) — AC 2 and AC 3.
 *
 * A separate file because the ticket's validation gate names it separately
 * (`npm run test -w packages/api -- alerts-dedupe`), and because dedupe is the single property this
 * ticket exists for: **the real failure mode of an alert system is fatigue, not accuracy.** A
 * control room that gets fifty rows for one vehicle stops reading rows.
 *
 * Every assertion here runs against the real `(dedupe_key, dedupe_window_start)` unique index. The
 * index alone would give *tumbling* windows, under which twenty sightings straddling 09:59-10:04
 * produce two alerts and this suite fails — which is exactly why the engine probes a sliding window
 * first and keeps the index as the concurrency backstop.
 *
 * Requires `make up && npm run db:migrate`. Skips loudly when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { AlertEngine, loadAlertPolicy, POLICY_PATH } from './alerts.js';
import { ConfusionPlateMatcher } from './plate-search.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';

const TAG = `DD${String(Date.now()).slice(-9)}`;
const TRACK_BASE = 91_000_000 + (Date.now() % 1_000_000);

/**
 * The plate this suite fires on.
 *
 * Its own watchlist entry rather than a seeded one, so twenty repeats do not collide with the alerts
 * `alerts.test.ts` raises in the same database on the same shipped entries — two suites sharing one
 * dedupe key would each see the other's `sighting_count`.
 */
const PLATE = `GJ27AB${String(TRACK_BASE).slice(-4)}`;

let rawSql: Sql;
let db: Db;
let engine: AlertEngine;
let reachable = false;
let cameraA = '';
let cameraB = '';
let entryId = '';
let trackSeq = 0;

/** Minutes, from the shipped policy — asserted rather than assumed, so a config edit is visible. */
let windowMinutes = 10;

async function seedSighting(cameraId: string, ts: string): Promise<{ id: string; ts: string }> {
  const rows = await db.execute<{ id: string; ts: string }>(sql`
    insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
    values (${cameraId}::uuid, ${ts}, ${5_000 + trackSeq}, ${TRACK_BASE + trackSeq++}, 'car',
            '{"x":10,"y":20,"w":100,"h":80}'::jsonb, 0.9)
    returning id::text as id, ts
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('sighting insert returned no row');
  return row;
}

async function alertsFor(
  cameraId?: string,
): Promise<
  { id: string; camera_id: string; sighting_count: number; ts: string; last_seen_at: string }[]
> {
  return db.execute(sql`
    select id::text as id, camera_id::text as camera_id, sighting_count, ts, last_seen_at
      from alerts
     where watchlist_entry_id = ${entryId}::uuid
       ${cameraId === undefined ? sql`` : sql`and camera_id = ${cameraId}::uuid`}
     order by ts
  `);
}

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);

  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn(
      '[alerts-dedupe] database unreachable — skipping. Run `make up && npm run db:migrate`.',
    );
    return;
  }

  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const cams = await db.execute<{ id: string; external_id: string }>(
    sql`select id::text as id, external_id from cameras
         where external_id in ('cam01','cam02') order by external_id`,
  );
  cameraA = cams.find((c) => c.external_id === 'cam01')?.id ?? '';
  cameraB = cams.find((c) => c.external_id === 'cam02')?.id ?? '';
  if (cameraA === '' || cameraB === '') throw new Error('cam01/cam02 missing — run make migrate');

  const inserted = await db.execute<{ id: string }>(sql`
    insert into watchlist_entries (category, entity_type, plate_normalized, source_system,
                                   source_ref, severity, valid_from, active, meta)
    values ('stolen_vehicle', 'vehicle', ${PLATE}, 'VAHAN', ${`${TAG}-DEDUPE`}, 'high',
            '2020-01-01T00:00:00Z', true,
            '{"note":"D2-06 dedupe fixture — synthetic, never presented as a vehicle record"}'::jsonb)
    returning id::text as id
  `);
  entryId = inserted[0]?.id ?? '';

  windowMinutes = loadAlertPolicy(POLICY_PATH).dedupe.windowMinutes;
  engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from alerts where watchlist_entry_id = ${entryId}::uuid`);
    await db.execute(
      sql`delete from sightings where track_id >= ${TRACK_BASE} and track_id < ${TRACK_BASE + 1000}`,
    );
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
  }
  await rawSql?.end();
});

/* ── AC 2 ────────────────────────────────────────────────────────────────────────────────────── */

describe('AC 2 — the same vehicle at the same camera 20 times in 5 minutes is one alert', () => {
  it('collapses to one row with an updated last-seen and a sighting count of 20', async () => {
    if (!reachable) return;
    // 20 sightings over 5 minutes: every 15 s, which is what a vehicle stopped in a camera's view
    // or a loop-point re-detection actually looks like.
    const start = Date.parse('2026-07-01T09:00:00.000Z');
    const timestamps: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      timestamps.push(new Date(start + i * 15_000).toISOString());
    }

    let created = 0;
    let deduped = 0;
    for (const ts of timestamps) {
      const sighting = await seedSighting(cameraA, ts);
      const outcome = await engine.correlate({
        sightingId: sighting.id,
        sightingTs: sighting.ts,
        cameraId: cameraA,
        rawText: PLATE,
        confidence: 0.9,
      });
      created += outcome.created;
      deduped += outcome.deduped;
    }

    expect(created).toBe(1);
    expect(deduped).toBe(19);

    const rows = await alertsFor(cameraA);
    expect(rows).toHaveLength(1);
    const alert = rows[0];
    expect(Number(alert?.sighting_count)).toBe(20);
    // `ts` stays the FIRST sighting; `last_seen_at` follows the most recent. Together they say
    // "first seen 09:00, still here 09:04:45, 20 times" in one row.
    expect(new Date(String(alert?.ts)).toISOString()).toBe(timestamps[0]);
    expect(new Date(String(alert?.last_seen_at)).toISOString()).toBe(timestamps[19]);

    console.log(
      `  [AC 2] 20 sightings in 5 min → ${String(rows.length)} alert, ` +
        `sighting_count ${String(alert?.sighting_count)}, ` +
        `last_seen ${new Date(String(alert?.last_seen_at)).toISOString()}`,
    );
  });

  it('collapses across a window boundary too — tumbling windows alone would give two alerts', async () => {
    if (!reachable) return;
    const windowMs = windowMinutes * 60_000;
    // Deliberately straddling: the first sighting is 60 s before a bucket boundary, the second 60 s
    // after it. Both are inside one dedupe window and must be one alert.
    const boundary = Math.ceil(Date.parse('2026-07-02T09:03:00.000Z') / windowMs) * windowMs;
    const before = new Date(boundary - 60_000).toISOString();
    const after = new Date(boundary + 60_000).toISOString();
    expect(Math.floor(Date.parse(before) / windowMs)).not.toBe(
      Math.floor(Date.parse(after) / windowMs),
    );

    let created = 0;
    for (const ts of [before, after]) {
      const sighting = await seedSighting(cameraB, ts);
      const outcome = await engine.correlate({
        sightingId: sighting.id,
        sightingTs: sighting.ts,
        cameraId: cameraB,
        rawText: PLATE,
        confidence: 0.9,
      });
      created += outcome.created;
    }
    expect(created).toBe(1);
    const rows = await alertsFor(cameraB);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.sighting_count)).toBe(2);

    await db.execute(
      sql`delete from alerts where watchlist_entry_id = ${entryId}::uuid and camera_id = ${cameraB}::uuid`,
    );
  });

  it('raises a NEW alert once the window has passed — dedupe is a window, not a mute button', async () => {
    if (!reachable) return;
    const first = '2026-07-03T09:00:00.000Z';
    const later = new Date(Date.parse(first) + (windowMinutes + 5) * 60_000).toISOString();

    for (const ts of [first, later]) {
      const sighting = await seedSighting(cameraB, ts);
      await engine.correlate({
        sightingId: sighting.id,
        sightingTs: sighting.ts,
        cameraId: cameraB,
        rawText: PLATE,
        confidence: 0.9,
      });
    }
    const rows = await alertsFor(cameraB);
    expect(rows).toHaveLength(2);
    await db.execute(
      sql`delete from alerts where watchlist_entry_id = ${entryId}::uuid and camera_id = ${cameraB}::uuid`,
    );
  });
});

/* ── AC 3 ────────────────────────────────────────────────────────────────────────────────────── */

describe('AC 3 — the same vehicle at a different camera is a new alert', () => {
  it('keys the dedupe on (entry, camera), because a second camera is movement', async () => {
    if (!reachable) return;
    const ts = '2026-07-04T09:00:00.000Z';
    for (const camera of [cameraA, cameraB]) {
      const sighting = await seedSighting(camera, ts);
      await engine.correlate({
        sightingId: sighting.id,
        sightingTs: sighting.ts,
        cameraId: camera,
        rawText: PLATE,
        confidence: 0.9,
      });
    }

    const onA = await alertsFor(cameraA);
    const onB = await alertsFor(cameraB);
    expect(onA.length).toBeGreaterThanOrEqual(1);
    expect(onB).toHaveLength(1);
    expect(onA.map((r) => r.id)).not.toContain(onB[0]?.id);

    const keys = await db.execute<{ dedupe_key: string }>(
      sql`select distinct dedupe_key from alerts where watchlist_entry_id = ${entryId}::uuid`,
    );
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key.dedupe_key.startsWith(`${entryId}:`)).toBe(true);

    console.log(
      `  [AC 3] same plate, two cameras → ${String(keys.length)} dedupe keys, ` +
        `${String(onA.length + onB.length)} alerts`,
    );
  });
});

/* ── The unique index is the backstop, and it holds ──────────────────────────────────────────── */

describe('the database enforces the dedupe guarantee', () => {
  it('refuses a second row on the same (dedupe_key, dedupe_window_start)', async () => {
    if (!reachable) return;
    const rows = await alertsFor(cameraA);
    const existing = rows[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;

    let thrown: unknown;
    try {
      await db.execute(sql`
        insert into alerts (watchlist_entry_id, sighting_id, sighting_ts, camera_id, ts,
                            match_type, match_distance, confidence, severity, reason,
                            dedupe_key, dedupe_window_start)
        select watchlist_entry_id, sighting_id, sighting_ts, camera_id, ts,
               match_type, match_distance, confidence, severity, reason,
               dedupe_key, dedupe_window_start
          from alerts where id = ${existing.id}::uuid
      `);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // drizzle wraps the driver error, so the constraint name is on the cause — asserting on the
    // wrapper's message would pass against any failed insert at all.
    const cause = (thrown as { cause?: { constraint_name?: string; code?: string } }).cause;
    expect(cause?.constraint_name).toBe('alerts_dedupe_uidx');
    expect(cause?.code).toBe('23505');
  });

  it('stores a continuous match distance — the numeric column 0016 introduced', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ data_type: string; numeric_scale: number | null }>(sql`
      select data_type, numeric_scale from information_schema.columns
       where table_name = 'alerts' and column_name = 'match_distance'
    `);
    expect(rows[0]?.data_type).toBe('numeric');
    expect(Number(rows[0]?.numeric_scale)).toBe(3);
  });
});
