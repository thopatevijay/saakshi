/**
 * Bus → Postgres consumer tests (D1-09).
 *
 * Against the real migrated database, per this package's convention: what can actually go wrong
 * here — the external-id → uuid resolution, the `vehicle_class` enum, the `det_confidence` CHECK,
 * whether a PTS-derived `ts` survives the round trip unmodified — are properties of PostgreSQL, and
 * a mocked query builder would only assert that we called drizzle.
 *
 * The stream is faked in the unit tests and **real in the last one**: a fake broker proves the
 * decode path, and only a real `XADD`/`XREADGROUP` round trip proves the wire contract the Python
 * worker publishes against.
 *
 * **D2-10's block at the bottom is the regression test D2-GATE (#23) failed for want of.** It runs
 * the whole loop with nothing stubbed — a real `XADD`, the real consumer, the real `AlertEngine`,
 * the real `GET /api/v1/trace` — because the defect was that each of those worked in isolation
 * while `plate_reads.normalized_text` fell through the seam between them. D2-08's trace tests set
 * that column in their own fixtures, which is exactly why 772 green tests said nothing.
 *
 * Requires `make up && make migrate`. Skips loudly when either service is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { evaluatePlateRead } from '@saakshi/shared';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { buildServer, type App } from '../server.js';
import type { UserRole } from '../auth.js';
import { AlertEngine } from '../services/alerts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import type { TraceResult } from '../services/trace.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';
import {
  CameraIdResolver,
  consumeSightings,
  decodeBatch,
  emptyStats,
  SIGHTINGS_GROUP,
  storedNormalizedText,
  type SightingsConsumerStats,
  type SightingStreamReader,
  type StreamEntry,
} from './sightings.js';
import { createValkeyReader } from './valkey-reader.js';

const TAG = `SIGHT-${String(Date.now())}`;
const CAM = `${TAG}-cam01`;
/** A second camera, so D2-10's trace assertion is a journey across cameras and not one pin. */
const CAM_B = `${TAG}-cam02`;
/** A stream of our own, so the suite never eats entries a live worker is publishing. */
const STREAM = `sightings-test-${TAG}`;

/**
 * The plate D2-GATE traced and could not find (#23). Measured output of the real 8-camera run —
 * emitted on cam07 at confidence 0.449 — and seeded on the watchlist as `ESTATE-OCR-GJ3266416`, so
 * this test reproduces the gate's exact failure rather than an invented one.
 */
const ALERTING_PLATE = 'GJ3266416';
const ALERTING_CONFIDENCE = 0.449;
/** A read that normalises to nothing: no `[A-Z0-9]` survives, so the canonical form is `''`. */
const UNREADABLE = '--- ---';

let rawSql: Sql;
let db: Db;
let env: Env;
let app: App;
let engine: AlertEngine;
let reachable = false;
let cameraUuid = '';
let cameraBUuid = '';
let operatorSub = '';
let valkeyUrl = '';
let valkeyReachable = false;

/** A reader over a fixed list — the decode path with no broker in it. */
function fakeReader(batches: StreamEntry[][]): SightingStreamReader {
  let index = 0;
  const acked: string[] = [];
  return {
    ensureGroup: () => Promise.resolve(),
    read: () => Promise.resolve(index < batches.length ? (batches[index++] ?? []) : []),
    ack: (_stream, _group, ids) => {
      acked.push(...ids);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cameraId: CAM,
    ts: '2026-09-04T10:00:00.000Z',
    framePtsMs: 4_000,
    trackId: 7,
    class: 'car',
    bbox: { x: 10, y: 20, w: 100, h: 80 },
    detConfidence: 0.87,
    ...overrides,
  });
}

const entries = (...payloads: string[]): StreamEntry[] =>
  payloads.map((p, i) => ({ id: `${String(i + 1)}-0`, payload: p }));

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  valkeyUrl = env.VALKEY_URL;
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[sightings] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const inserted = await db.execute<{ id: string; external_id: string }>(
    sql`insert into cameras (external_id, name, adapter_kind)
        values (${CAM}, ${'D1-09 consumer fixture'}, 'hls'),
               (${CAM_B}, ${'D2-10 consumer fixture'}, 'hls')
        returning id::text as id, external_id`,
  );
  cameraUuid = inserted.find((c) => c.external_id === CAM)?.id ?? '';
  cameraBUuid = inserted.find((c) => c.external_id === CAM_B)?.id ?? '';

  // Self-seeding, like the watchlist and alert suites: the validation gate runs the tests before
  // `npm run seed:watchlist`, and a suite that only passes in one order is not a gate.
  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const users = await db.execute<{ id: string }>(
    sql`select id::text as id from users where badge_no = ${'GP-OPR-1042'}`,
  );
  operatorSub = users[0]?.id ?? '';
  if (operatorSub === '') throw new Error('seed user GP-OPR-1042 missing — run npm run db:migrate');

  engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });
  app = await buildServer({ env, db, alertEngine: engine });
  await app.ready();

  const probe = new Redis(valkeyUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    valkeyReachable = true;
  } catch {
    console.warn('[sightings] valkey unreachable — the live round trip will skip.');
  } finally {
    probe.disconnect();
  }
}, 30_000);

afterAll(async () => {
  if (reachable && cameraUuid !== '') {
    await deleteOwnRows();
    await db.execute(
      sql`delete from cameras where id in ${cameraUuids().map((id) => sql`${id}::uuid`)}`,
    );
  }
  if (valkeyReachable) {
    const client = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
    await client.del(STREAM);
    await client.quit();
  }
  await app?.close();
  await rawSql?.end();
});

/**
 * `plate_reads` has no foreign key to `sightings` — it cannot: `sightings` is a hypertable and
 * PostgreSQL will not let one be the target of a REFERENCES clause (`0005_anpr_identity.up.sql`).
 * So the cleanup has to walk the link by hand, in the right order, exactly as the writer does.
 */
async function deletePlateReads(): Promise<void> {
  await db.execute(
    sql`delete from plate_reads where sighting_id in
          (select id from sightings where camera_id in ${cameraUuids().map((id) => sql`${id}::uuid`)})`,
  );
}

/** The suite's cameras, as the uuid list every scoped query and cleanup uses. */
function cameraUuids(): string[] {
  return [cameraUuid, cameraBUuid].filter((id) => id !== '');
}

/**
 * Everything this suite writes, removed in dependency order: alerts, then plate reads, then the
 * sightings they hang off. `alerts.camera_id` cascades from `cameras`, but the per-test reset has
 * to clear them by hand or D2-06's `(dedupe_key, dedupe_window_start)` unique index would make the
 * second run of a test dedupe against the first instead of creating.
 */
async function deleteOwnRows(): Promise<void> {
  const ids = cameraUuids().map((id) => sql`${id}::uuid`);
  await db.execute(sql`delete from alerts where camera_id in ${ids}`);
  await deletePlateReads();
  await db.execute(sql`delete from sightings where camera_id in ${ids}`);
}

beforeEach(async () => {
  if (reachable && cameraUuid !== '') await deleteOwnRows();
});

describe('sightings consumer', () => {
  it('resolves an external id to the registry uuid', async () => {
    if (!reachable) return;
    const resolver = new CameraIdResolver(db);
    expect(await resolver.resolve(CAM)).toBe(cameraUuid);
  });

  it('drops a malformed payload and counts it, rather than retrying it forever', async () => {
    if (!reachable) return;
    const stats = emptyStats();
    const rows = await decodeBatch(
      entries('not json at all', payload({ detConfidence: 4 }), payload()),
      new CameraIdResolver(db),
      stats,
    );

    expect(rows).toHaveLength(1);
    // One unparseable, one that parses as JSON but is not a `Sighting` (confidence out of 0..1).
    expect(stats.invalidPayloads).toBe(2);
  });

  it('counts a camera that is not in the registry instead of inserting an orphan row', async () => {
    if (!reachable) return;
    const stats = emptyStats();
    const rows = await decodeBatch(
      entries(payload({ cameraId: `${TAG}-not-a-camera` })),
      new CameraIdResolver(db),
      stats,
    );

    expect(rows).toHaveLength(0);
    expect(stats.unknownCameras).toBe(1);
    expect(stats.unknownCameraIds).toContain(`${TAG}-not-a-camera`);
  });

  it('lands rows with the camera uuid, the PTS-derived ts, track id, bbox and confidence', async () => {
    if (!reachable) return;
    const stats = await consumeSightings({
      reader: fakeReader([entries(payload(), payload({ trackId: 100_007, framePtsMs: 5_000 }))]),
      db,
      maxIdlePolls: 1,
      blockMs: 1,
    });

    expect(stats.inserted).toBe(2);

    const rows = await db.execute<{
      camera_id: string;
      ts: string;
      frame_pts_ms: string;
      track_id: number;
      class: string;
      bbox: { x: number; y: number; w: number; h: number };
      det_confidence: string;
    }>(
      sql`select camera_id::text, ts::text, frame_pts_ms::text, track_id, class::text, bbox,
                 det_confidence::text
          from sightings where camera_id = ${cameraUuid}::uuid order by frame_pts_ms`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.camera_id).toBe(cameraUuid);
    expect(rows[0]?.track_id).toBe(7);
    expect(rows[0]?.class).toBe('car');
    expect(rows[0]?.bbox).toEqual({ x: 10, y: 20, w: 100, h: 80 });
    expect(Number(rows[0]?.det_confidence)).toBeCloseTo(0.87, 3);
    // The instant the *frame* carries, not the instant we happened to consume it.
    expect(new Date(rows[0]?.ts ?? '').toISOString()).toBe('2026-09-04T10:00:00.000Z');
    expect(Number(rows[0]?.frame_pts_ms)).toBe(4_000);
    // A session-qualified track id survives the int4 column, which is what makes "no identity bleed
    // across the loop-point cut" checkable in SQL rather than only asserted in Python.
    expect(rows[1]?.track_id).toBe(100_007);
  });

  it('writes a plate read linked to the sighting it arrived on, with every D2-01 column', async () => {
    if (!reachable) return;

    const stats = await consumeSightings({
      reader: fakeReader([
        entries(
          payload({
            trackId: 200_012,
            plateReads: [
              {
                rawText: 'GJ01AB1234',
                normalizedText: null,
                confidence: 0.812,
                isBestShot: true,
                voteCount: 3,
                cropUri: 'file:///evidence/cam01/2026-09-04/200012-plate.jpg',
              },
            ],
          }),
          // A sighting with no plate read must not gain one — the link is positional, and an
          // off-by-one here would attach a read to the wrong vehicle.
          payload({ trackId: 200_013 }),
        ),
      ]),
      db,
      maxIdlePolls: 1,
      blockMs: 1,
    });

    expect(stats.inserted).toBe(2);
    expect(stats.plateReadsInserted).toBe(1);

    const rows = await db.execute<{
      raw_text: string;
      normalized_text: string | null;
      confidence: string;
      is_best_shot: boolean;
      vote_count: number;
      crop_uri: string;
      track_id: number;
      sighting_ts: string;
      ts: string;
    }>(
      sql`select p.raw_text, p.normalized_text, p.confidence::text, p.is_best_shot, p.vote_count,
                 p.crop_uri, s.track_id, p.sighting_ts::text, s.ts::text
          from plate_reads p
          join sightings s on s.id = p.sighting_id and s.ts = p.sighting_ts
          where s.camera_id = ${cameraUuid}::uuid`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_text).toBe('GJ01AB1234');
    // `raw_text` stays exactly what the camera produced; `normalized_text` is D2-03's canonical
    // form, computed by the consumer (D2-10). This assertion read `toBeNull()` until D2-10: the
    // worker sends `null` meaning *not evaluated*, and nothing downstream ever evaluated it, so
    // `services/trace.ts` — which filters on this column — could never match a live read.
    expect(rows[0]?.normalized_text).toBe('GJ01AB1234');
    expect(Number(rows[0]?.confidence)).toBeCloseTo(0.812, 3);
    expect(rows[0]?.is_best_shot).toBe(true);
    expect(rows[0]?.vote_count).toBe(3);
    expect(rows[0]?.crop_uri).toContain('200012-plate.jpg');
    // The read landed on the vehicle that produced it, not on its neighbour in the batch.
    expect(rows[0]?.track_id).toBe(200_012);
    // `sighting_ts` is carried so the planner can exclude hypertable chunks; it must equal the
    // sighting's own ts or the index is useless and the join is a lie.
    expect(rows[0]?.sighting_ts).toBe(rows[0]?.ts);
  });

  it('round-trips a real XADD through a real consumer group into Postgres', async () => {
    if (!reachable || !valkeyReachable) return;

    const publisher = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
    await publisher.xadd(STREAM, '*', 'payload', payload({ trackId: 11 }));
    await publisher.quit();

    const reader = createValkeyReader(valkeyUrl);
    try {
      const stats = await consumeSightings({
        reader,
        db,
        stream: STREAM,
        group: SIGHTINGS_GROUP,
        maxIdlePolls: 1,
        blockMs: 500,
      });
      expect(stats.entriesRead).toBe(1);
      expect(stats.inserted).toBe(1);
    } finally {
      await reader.close();
    }

    const rows = await db.execute<{ track_id: number }>(
      sql`select track_id from sightings where camera_id = ${cameraUuid}::uuid`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.track_id).toBe(11);
  }, 20_000);
});

/* ── D2-10 · normalisation on the write path ─────────────────────────────────────────────────── */

/**
 * One vehicle, three passes, two cameras, published **out of chronological order** so a trace that
 * ordered by arrival would come back visibly wrong rather than accidentally right.
 *
 * The timestamps are fixed rather than relative to `now` because the assertion is about ordering,
 * and `2026-09-05` sits inside `ESTATE-OCR-GJ3266416`'s validity window (`valid_from 2026-01-01`,
 * no `valid_to`) — D2-05's rule is that the watchlist is evaluated at the sighting's own instant.
 */
const JOURNEY: { camera: string; ts: string; framePtsMs: number; trackId: number }[] = [
  { camera: CAM, ts: '2026-09-05T10:05:00.000Z', framePtsMs: 12_000, trackId: 300_003 },
  { camera: CAM, ts: '2026-09-05T10:00:00.000Z', framePtsMs: 4_000, trackId: 300_001 },
  { camera: CAM_B, ts: '2026-09-05T10:02:00.000Z', framePtsMs: 8_000, trackId: 300_002 },
];

function plateReadPayload(
  over: { camera?: string; ts?: string; framePtsMs?: number; trackId?: number },
  read: { rawText: string; confidence: number; normalizedText?: string | null },
): string {
  return payload({
    cameraId: over.camera ?? CAM,
    ts: over.ts ?? '2026-09-05T10:00:00.000Z',
    framePtsMs: over.framePtsMs ?? 4_000,
    trackId: over.trackId ?? 300_000,
    plateReads: [
      {
        rawText: read.rawText,
        // The wire value the Python worker actually sends: `null` — *not evaluated*. Nothing in
        // this suite pre-computes the column it is asserting on, which is the whole point.
        normalizedText: read.normalizedText ?? null,
        confidence: read.confidence,
        isBestShot: true,
        voteCount: 3,
        cropUri: null,
      },
    ],
  });
}

/**
 * Drains a batch through the **real** path where Valkey is up: a real `XADD` into a real consumer
 * group. Falls back to the in-memory reader only when Valkey is unreachable, so the regression
 * test degrades to "still real Postgres, still the real consumer" rather than disappearing.
 */
async function drain(
  payloads: string[],
  options: { withAlerts?: boolean } = {},
): Promise<SightingsConsumerStats> {
  const alerts = options.withAlerts === true ? { alertEngine: engine } : {};
  if (!valkeyReachable) {
    return consumeSightings({
      reader: fakeReader([entries(...payloads)]),
      db,
      maxIdlePolls: 1,
      blockMs: 1,
      ...alerts,
    });
  }
  const publisher = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
  for (const entry of payloads) await publisher.xadd(STREAM, '*', 'payload', entry);
  await publisher.quit();

  const reader = createValkeyReader(valkeyUrl);
  try {
    return await consumeSightings({
      reader,
      db,
      stream: STREAM,
      group: SIGHTINGS_GROUP,
      maxIdlePolls: 1,
      blockMs: 500,
      ...alerts,
    });
  } finally {
    await reader.close();
  }
}

interface StoredRead extends Record<string, unknown> {
  raw_text: string;
  normalized_text: string | null;
  confidence: string;
}

async function storedReads(): Promise<StoredRead[]> {
  return db.execute<StoredRead>(sql`
    select p.raw_text, p.normalized_text, p.confidence::text
      from plate_reads p
      join sightings s on s.id = p.sighting_id and s.ts = p.sighting_ts
     where s.camera_id in ${cameraUuids().map((id) => sql`${id}::uuid`)}
     order by p.raw_text
  `);
}

describe('D2-10 — plate normalisation is on the write path', () => {
  it('preserves the three-way meaning of normalized_text: null = not normalised, empty string = normalised to nothing, string = the canonical form', async () => {
    if (!reachable) return;

    await drain([
      plateReadPayload({ trackId: 400_001 }, { rawText: 'GJ01AB1234', confidence: 0.812 }),
      plateReadPayload(
        { trackId: 400_002, framePtsMs: 5_000 },
        { rawText: UNREADABLE, confidence: 0.31 },
      ),
    ]);

    const rows = await storedReads();
    expect(rows).toHaveLength(2);

    const canonical = rows.find((r) => r.raw_text === 'GJ01AB1234');
    const rejected = rows.find((r) => r.raw_text === UNREADABLE);

    // 3. A STRING — the canonical `[A-Z0-9]` form the watchlist, D2-04 and trace key on.
    expect(canonical?.normalized_text).toBe('GJ01AB1234');

    // 2. THE EMPTY STRING — normalised to *nothing*. `evaluatePlateRead` ran; no `[A-Z0-9]`
    //    survived. This is a rejection, and it must NOT be stored as null, or the per-camera
    //    rejection rate D2-01's handoff calls a trust signal stops being measurable.
    expect(rejected?.normalized_text).toBe('');
    expect(rejected?.normalized_text).not.toBeNull();

    // 1. NULL — *not normalised yet*. Unreachable from this consumer now that it always evaluates;
    //    it survives as the meaning of a row written before D2-10 or by another writer. Insert one
    //    by hand, because that is the only way this state can now arise, and prove SQL can still
    //    tell all three apart.
    const orphan = await db.execute<{ id: string; ts: string }>(sql`
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
      values (${cameraUuid}::uuid, '2026-09-05T09:00:00.000Z', 1000, 400003, 'car',
              '{"x":1,"y":2,"w":3,"h":4}'::jsonb, 0.5)
      returning id::text as id, ts
    `);
    await db.execute(sql`
      insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence)
      values (${orphan[0]?.id ?? ''}::uuid, ${orphan[0]?.ts ?? ''}, 'GJ01AB1234', null, 0.5)
    `);

    // The per-camera rejection-rate query (AC 7). Three buckets, from `plate_reads` alone.
    const rates = await db.execute<{
      external_id: string;
      reads: string;
      not_normalised: string;
      rejected: string;
      usable: string;
    }>(sql`
      select c.external_id,
             count(*)                                          as reads,
             count(*) filter (where p.normalized_text is null) as not_normalised,
             count(*) filter (where p.normalized_text = '')    as rejected,
             count(*) filter (where p.normalized_text <> '')   as usable
        from plate_reads p
        join sightings s on s.id = p.sighting_id and s.ts = p.sighting_ts
        join cameras c on c.id = s.camera_id
       where c.external_id = ${CAM}
       group by c.external_id
    `);

    expect(rates[0]?.reads).toBe('3');
    expect(rates[0]?.not_normalised).toBe('1');
    expect(rates[0]?.rejected).toBe('1');
    expect(rates[0]?.usable).toBe('1');
  }, 20_000);

  it('leaves the worker authoritative when it does send a normalised form, rather than becoming a second normaliser', () => {
    const base = { confidence: 0.8, isBestShot: false, voteCount: 1, cropUri: null };
    // Worker said nothing → the consumer evaluates.
    expect(storedNormalizedText({ ...base, rawText: 'gj 01 ab 1234', normalizedText: null })).toBe(
      'GJ01AB1234',
    );
    // Worker sent a value → stored verbatim, even one this side would not have produced.
    expect(
      storedNormalizedText({ ...base, rawText: 'gj 01 ab 1234', normalizedText: 'WORKERSAIDSO' }),
    ).toBe('WORKERSAIDSO');
    // Worker sent "normalised to nothing" → that is a value too, and it is not re-derived.
    expect(storedNormalizedText({ ...base, rawText: 'GJ01AB1234', normalizedText: '' })).toBe('');
  });

  it('stores exactly the form services/alerts.ts computes for the same raw_text, so the two paths cannot drift', async () => {
    if (!reachable) return;

    await drain([
      plateReadPayload(
        { trackId: 410_001 },
        { rawText: ALERTING_PLATE, confidence: ALERTING_CONFIDENCE },
      ),
      plateReadPayload(
        { trackId: 410_002, framePtsMs: 5_000 },
        { rawText: '757508300', confidence: 0.888 },
      ),
      plateReadPayload(
        { trackId: 410_003, framePtsMs: 6_000 },
        { rawText: UNREADABLE, confidence: 0.31 },
      ),
    ]);

    const rows = await storedReads();
    expect(rows).toHaveLength(3);

    const sighting = await db.execute<{ id: string; ts: string }>(sql`
      select id::text as id, ts from sightings
       where camera_id = ${cameraUuid}::uuid and track_id = 410001
    `);

    for (const row of rows) {
      const confidence = Number(row.confidence);
      // What `@saakshi/shared` computes …
      expect(row.normalized_text).toBe(evaluatePlateRead(row.raw_text, confidence).normalizedText);
      // … and, for the one that alerts, what `services/alerts.ts` itself computes when it
      // correlates — through the engine, not through a second call to the shared function, so this
      // fails if the alert path ever stops using the same evaluator.
      if (row.raw_text !== ALERTING_PLATE) continue;
      const outcome = await engine.correlate({
        sightingId: sighting[0]?.id ?? '',
        sightingTs: sighting[0]?.ts ?? '',
        cameraId: cameraUuid,
        rawText: row.raw_text,
        confidence,
      });
      expect(row.normalized_text).toBe(outcome.evaluation.normalizedText);
    }
  }, 20_000);

  it('the regression D2-GATE failed on: a plate that raises an alert is also returned by GET /api/v1/trace, in PTS order', async () => {
    if (!reachable) return;

    const stats = await drain(
      JOURNEY.map((leg) =>
        plateReadPayload(leg, { rawText: ALERTING_PLATE, confidence: ALERTING_CONFIDENCE }),
      ),
      { withAlerts: true },
    );

    expect(stats.inserted).toBe(3);
    expect(stats.plateReadsInserted).toBe(3);
    expect(stats.correlationFailures).toBe(0);

    // Half one: the alert path fired, exactly as it did on the gate run.
    const alerts = await db.execute<{ id: string }>(sql`
      select a.id::text as id
        from alerts a
        join watchlist_entries w on w.id = a.watchlist_entry_id
       where a.camera_id in ${cameraUuids().map((id) => sql`${id}::uuid`)}
         and w.plate_normalized = ${ALERTING_PLATE}
    `);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(stats.alertsRaised).toBeGreaterThanOrEqual(1);

    // Half two — the half that was broken. Same plate, same run, through the real endpoint.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/trace?plate=${ALERTING_PLATE}&purpose=D2-10%20write-path%20regression&camera_ids=${cameraUuids().join(',')}`,
      headers: {
        authorization: `Bearer ${app.jwt.sign({
          sub: operatorSub,
          role: 'operator' satisfies UserRole,
          badgeNo: 'GP-OPR-1042',
          departmentId: null,
        })}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<TraceResult>();
    // The gate saw `sightings: 0, emptyReason: "no_matching_plate"` for a plate that had alerted.
    expect(body.emptyReason).toBeNull();
    expect(body.sightings).toHaveLength(3);
    expect(body.identity?.canonicalPlate).toBe(ALERTING_PLATE);

    // Chronological by the PTS-derived wall clock, never by insertion order — the journey was
    // published 10:05 → 10:00 → 10:02 and must come back 10:00 → 10:02 → 10:05.
    const ts = body.sightings.map((s) => new Date(s.ts).toISOString());
    expect(ts).toEqual([...ts].sort());
    expect(ts).toEqual([
      '2026-09-05T10:00:00.000Z',
      '2026-09-05T10:02:00.000Z',
      '2026-09-05T10:05:00.000Z',
    ]);
    expect(body.sightings.map((s) => s.framePtsMs)).toEqual([4_000, 8_000, 12_000]);
    // A journey across cameras, not three pins on one.
    expect(new Set(body.sightings.map((s) => s.cameraExternalId))).toEqual(new Set([CAM, CAM_B]));
  }, 30_000);
});
