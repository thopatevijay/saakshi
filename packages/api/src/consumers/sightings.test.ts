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
 * Requires `make up && make migrate`. Skips loudly when either service is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  CameraIdResolver,
  consumeSightings,
  decodeBatch,
  emptyStats,
  SIGHTINGS_GROUP,
  type SightingStreamReader,
  type StreamEntry,
} from './sightings.js';
import { createValkeyReader } from './valkey-reader.js';

const TAG = `SIGHT-${String(Date.now())}`;
const CAM = `${TAG}-cam01`;
/** A stream of our own, so the suite never eats entries a live worker is publishing. */
const STREAM = `sightings-test-${TAG}`;

let rawSql: Sql;
let db: Db;
let reachable = false;
let cameraUuid = '';
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
  const env = loadEnv();
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

  const inserted = await db.execute<{ id: string }>(
    sql`insert into cameras (external_id, name, adapter_kind)
        values (${CAM}, ${'D1-09 consumer fixture'}, 'hls')
        returning id::text as id`,
  );
  cameraUuid = inserted[0]?.id ?? '';

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
    await deletePlateReads();
    await db.execute(sql`delete from sightings where camera_id = ${cameraUuid}::uuid`);
    await db.execute(sql`delete from cameras where id = ${cameraUuid}::uuid`);
  }
  if (valkeyReachable) {
    const client = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
    await client.del(STREAM);
    await client.quit();
  }
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
          (select id from sightings where camera_id = ${cameraUuid}::uuid)`,
  );
}

beforeEach(async () => {
  if (reachable && cameraUuid !== '') {
    await deletePlateReads();
    await db.execute(sql`delete from sightings where camera_id = ${cameraUuid}::uuid`);
  }
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
    // Raw here, normalised by D2-03. A worker that guessed would make the rejection rate — a trust
    // signal — unmeasurable.
    expect(rows[0]?.normalized_text).toBeNull();
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
