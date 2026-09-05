/**
 * Evidence consumer tests, and D2-11's cross-seam regression test.
 *
 * D2-GATE (#23) failed AC 5 on the crop, and the failure lived in a seam that nothing tested:
 * D2-01 wrote plate crops to the analytics worker's local disk and put a `file://` path in
 * `plate_reads.crop_uri`; D2-02 uploaded **vehicle** crops to MinIO and owned the presign
 * semantics; and `services/alerts.ts` signed whatever string it was handed. Every one of those
 * worked in isolation. Joined up, an alert carried
 * `http://localhost:9000/saakshi-evidence/file%3A///Users/…-plate.jpg?X-Amz-…`, which returned
 * **HTTP 400** — a link that looks real, is not, and is exactly what this project's claims
 * discipline exists to prevent.
 *
 * So the assertion at the bottom of this file spans the whole loop with nothing stubbed: a real
 * `XADD` onto a real Valkey stream, the real sightings consumer, the real `AlertEngine` raising a
 * real alert, the real evidence consumer uploading to a real MinIO, the real
 * `GET /api/v1/alerts/:id`, and a real `fetch` of the URL that comes back. In the spirit of
 * D2-10's: one test that goes red the moment any one of those stops agreeing with the others.
 *
 * Requires `make up && npm run db:migrate`. Skips loudly, per component, when one is unreachable —
 * the MinIO half is the only half that can be skipped, and it says so when it is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { AlertRecord } from '@saakshi/shared';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { buildServer, type App } from '../server.js';
import type { UserRole } from '../auth.js';
import { AlertEngine } from '../services/alerts.js';
import { ConfusionPlateMatcher } from '../services/plate-search.js';
import { evidenceStoreFromEnv, evidenceKey, type EvidenceStore } from '../services/evidence.js';
import { presignerFor, presignerFromEnv } from '../services/crop-url.js';
import {
  createWatchlistRegistry,
  loadSeedCsv,
  SEED_CSV_PATH,
  upsertWatchlistEntries,
} from '../watchlist/index.js';
import { consumeSightings, SIGHTINGS_GROUP } from './sightings.js';
import { consumeEvidence, findPlateRead, EVIDENCE_GROUP } from './evidence.js';
import { createValkeyReader } from './valkey-reader.js';

const TAG = `EV${String(Date.now()).slice(-9)}`;
const CAM = `${TAG}-cam01`;
/** Streams of our own, so the suite never eats entries a live worker is publishing. */
const SIGHTINGS_STREAM = `sightings-d211-${TAG}`;
const EVIDENCE_STREAM_NAME = `evidence-d211-${TAG}`;

/**
 * The plate D2-GATE's live 8-camera run emitted on cam07 at confidence 0.449, seeded on the
 * watchlist as `ESTATE-OCR-GJ3266416`. A measured string, not an invented registration.
 */
const ALERTING_PLATE = 'GJ3266416';
const PLATE_CONFIDENCE = 0.449;

/**
 * The exact shape of URI D2-GATE found in `plate_reads.crop_uri` — an absolute path on the
 * analytics worker's own disk. The API cannot read it, cannot sign it, and must not pretend to.
 */
const LOCAL_CROP_URI =
  'file:///Users/vijay/hackathons/saakshi/evidence/plates/evidence/cam02/2026-09-05/100-plate.jpg';

/** A real, decodable 1x1 JPEG. Bytes matter: the assertion is that a browser can fetch this. */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const TRACK_BASE = 91_000_000 + (Date.now() % 1_000_000);

let rawSql: Sql;
let db: Db;
let env: Env;
let app: App;
let engine: AlertEngine;
let store: EvidenceStore | null = null;
let reachable = false;
let valkeyReachable = false;
let valkeyUrl = '';
let cameraUuid = '';
let operatorSub = '';
/** Every object this suite puts in the bucket, removed in `afterAll`. */
const uploaded: string[] = [];

function auth(role: UserRole): { authorization: string } {
  return {
    authorization: `Bearer ${app.jwt.sign({ sub: operatorSub, badgeNo: 'GP-OPR-1042', role, departmentId: null })}`,
  };
}

function sightingPayload(options: {
  trackId: number;
  framePtsMs: number;
  ts: string;
  cropUri: string | null;
}): string {
  return JSON.stringify({
    cameraId: CAM,
    ts: options.ts,
    framePtsMs: options.framePtsMs,
    trackId: options.trackId,
    class: 'car',
    bbox: { x: 10, y: 20, w: 120, h: 90 },
    detConfidence: 0.87,
    plateReads: [
      {
        rawText: ALERTING_PLATE,
        // What the Python worker actually sends: the raw read, un-normalised.
        normalizedText: null,
        confidence: PLATE_CONFIDENCE,
        isBestShot: true,
        voteCount: 3,
        // D2-01's `LocalCropStore` URI, or `null` when the worker had nowhere to write it.
        cropUri: options.cropUri,
      },
    ],
  });
}

/**
 * The `kind: 'plate'` evidence record `workers/analytics/evidence.py:to_plate_record` publishes.
 *
 * Written out in full rather than built by a helper because the wire contract is the thing under
 * test: if the Python side and this diverge, the crop silently stops arriving and the alert
 * silently reverts to "no crop stored", which is the exact failure mode of the defect being fixed.
 */
function plateEvidencePayload(options: {
  trackId: number;
  framePtsMs: number;
  ts: string;
}): string {
  return JSON.stringify({
    cameraId: CAM,
    trackId: options.trackId,
    ts: options.ts,
    framePtsMs: options.framePtsMs,
    kind: 'plate',
    class: 'car',
    detConfidence: 0.612,
    bbox: { x: 42.5, y: 61.25, w: 96, h: 31 },
    bestShotScore: 0.4137,
    focus: 184.62,
    observations: 5,
    // A plate crop has had no colour classifier run over it. `unknown` with the flag set is the
    // honest value for a measurement nobody made, and the consumer never writes these anywhere.
    vehicleType: null,
    vehicleColor: 'unknown',
    vehicleColorConfidence: 0,
    attributesLowConfidence: true,
    colorChromaShare: 0,
    colorRunnerUp: null,
    contentType: 'image/jpeg',
    cropBase64: JPEG_BASE64,
    cropBytes: Buffer.from(JPEG_BASE64, 'base64').byteLength,
  });
}

async function xadd(stream: string, payload: string): Promise<void> {
  const publisher = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
  await publisher.xadd(stream, '*', 'payload', payload);
  await publisher.quit();
}

/** Drains the sightings stream through the real consumer, with the real alert engine attached. */
async function drainSightings(): Promise<void> {
  const reader = createValkeyReader(valkeyUrl);
  try {
    await consumeSightings({
      reader,
      db,
      alertEngine: engine,
      stream: SIGHTINGS_STREAM,
      group: SIGHTINGS_GROUP,
      maxIdlePolls: 1,
      blockMs: 500,
    });
  } finally {
    await reader.close();
  }
}

/** Drains the evidence stream through the real consumer, into the real bucket. */
async function drainEvidence(): Promise<{ stored: number; unmatched: number }> {
  if (store === null) throw new Error('drainEvidence called with no object store');
  const reader = createValkeyReader(valkeyUrl);
  try {
    const stats = await consumeEvidence({
      reader,
      db,
      store,
      stream: EVIDENCE_STREAM_NAME,
      group: EVIDENCE_GROUP,
      maxIdlePolls: 1,
      blockMs: 500,
      matchRetries: 2,
      matchRetryDelayMs: 200,
    });
    return { stored: stats.stored, unmatched: stats.unmatched };
  } finally {
    await reader.close();
  }
}

async function cropUriOf(sightingId: string): Promise<string | null> {
  const rows = await db.execute<{ crop_uri: string | null }>(
    sql`select crop_uri from plate_reads where sighting_id = ${sightingId}::uuid`,
  );
  return rows[0]?.crop_uri ?? null;
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  valkeyUrl = env.VALKEY_URL;
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[evidence] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const inserted = await db.execute<{ id: string }>(
    sql`insert into cameras (external_id, name, adapter_kind)
        values (${CAM}, ${'D2-11 evidence fixture'}, 'hls')
        returning id::text as id`,
  );
  cameraUuid = inserted[0]?.id ?? '';

  // Self-seeding, like the alert and sightings suites: the validation gate runs the tests before
  // `npm run seed:watchlist`, and a suite that only passes in one order is not a gate.
  const batch = await loadSeedCsv(SEED_CSV_PATH);
  await upsertWatchlistEntries(db, batch.valid);

  const users = await db.execute<{ id: string }>(
    sql`select id::text as id from users where badge_no = ${'GP-OPR-1042'}`,
  );
  operatorSub = users[0]?.id ?? '';
  if (operatorSub === '') throw new Error('seed user GP-OPR-1042 missing — run npm run db:migrate');

  store = evidenceStoreFromEnv();
  engine = new AlertEngine({
    db,
    registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
  });
  // The composition root's wiring, reproduced: `index.ts` builds the presigner from the
  // environment and injects it, and D2-11 threads it to the alert routes as well as the trace
  // routes so a crop URL is minted on read rather than served from a stored, expiring copy.
  app = await buildServer({ env, db, alertEngine: engine, cropPresigner: presignerFor(store) });
  await app.ready();

  const probe = new Redis(valkeyUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    valkeyReachable = true;
  } catch {
    console.warn('[evidence] valkey unreachable — the cross-seam round trip will skip.');
  } finally {
    probe.disconnect();
  }
}, 30_000);

afterAll(async () => {
  if (reachable && cameraUuid !== '') {
    await deleteOwnRows();
    await db.execute(sql`delete from cameras where id = ${cameraUuid}::uuid`);
  }
  if (store !== null) {
    for (const key of uploaded) {
      try {
        await store.deleteObject(key);
      } catch {
        // A leftover object is noise in a dev bucket, never a test failure.
      }
    }
  }
  if (valkeyReachable) {
    const client = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
    await client.del(SIGHTINGS_STREAM, EVIDENCE_STREAM_NAME);
    await client.quit();
  }
  await app?.close();
  await rawSql?.end();
});

async function deleteOwnRows(): Promise<void> {
  await db.execute(sql`delete from alerts where camera_id = ${cameraUuid}::uuid`);
  await db.execute(
    sql`delete from plate_reads where sighting_id in
          (select id from sightings where camera_id = ${cameraUuid}::uuid)`,
  );
  await db.execute(sql`delete from sightings where camera_id = ${cameraUuid}::uuid`);
}

beforeEach(async () => {
  if (reachable && cameraUuid !== '') await deleteOwnRows();
});

/* ── AC 1 · the guard, by name, on both paths ─────────────────────────────────────────────────── */

describe('D2-11 AC 1 — no path emits a presigned URL for a URI it cannot serve', () => {
  it('the trace path returns null for a file:// crop URI', () => {
    if (store === null) {
      console.warn('[evidence] MINIO_* unset — the store-configured half of AC 1 skips');
      return;
    }
    expect(presignerFor(store)(LOCAL_CROP_URI)).toBeNull();
    // The exact presigner `index.ts` hands `registerTraceRoutes` — the trace path itself, not a
    // re-implementation of it.
    expect(presignerFromEnv()(LOCAL_CROP_URI)).toBeNull();
    // And a crop in a *different* bucket, which these credentials also cannot serve.
    expect(presignerFor(store)('s3://some-other-bucket/evidence/cam01/x-plate.jpg')).toBeNull();
    // The control: an object in this bucket does sign, so the null above is a refusal and not an
    // inert function that returns null for everything.
    expect(presignerFor(store)(`s3://${store.bucket}/evidence/cam01/x-plate.jpg`)).toContain(
      'X-Amz-Signature=',
    );
  });

  it('the alert path returns null for the SAME file:// crop URI — same input, same answer', async () => {
    if (!reachable) return;
    const at = new Date().toISOString();
    const trackId = TRACK_BASE + 11;
    const rows = await db.execute<{ id: string; ts: string }>(sql`
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
                             crop_uri, is_best_shot)
      values (${cameraUuid}::uuid, ${at}::timestamptz, 4000, ${trackId}, 'car',
              '{"x":1,"y":2,"w":3,"h":4}'::jsonb, 0.87, ${LOCAL_CROP_URI}, true)
      returning id::text as id, ts::text as ts
    `);
    const sighting = rows[0];
    expect(sighting).toBeDefined();

    const outcome = await engine.correlate({
      sightingId: sighting?.id ?? '',
      sightingTs: sighting?.ts ?? '',
      cameraId: cameraUuid,
      rawText: ALERTING_PLATE,
      confidence: PLATE_CONFIDENCE,
      cropUri: LOCAL_CROP_URI,
    });
    const alert = outcome.alerts[0];
    expect(alert).toBeDefined();

    // The URI is reported honestly — it *is* what is stored — and the URL is null, not a guess.
    expect(alert?.reason.evidence.cropUri).toBe(LOCAL_CROP_URI);
    expect(alert?.reason.evidence.cropUrl).toBeNull();

    // And the reason says which of the three "no crop" cases this is, so a reader is never left
    // concluding that MinIO is down when MinIO is up and the URI is simply not one of its objects.
    if (store !== null) {
      expect(
        alert?.reason.caveats.some((c) => c.includes('not an object in this evidence store')),
      ).toBe(true);
    }

    // The whole point, stated as the thing that used to be false: the alert path never emits a
    // signed URL here. D2-GATE saw `…/saakshi-evidence/file%3A///Users/…?X-Amz-…` and HTTP 400.
    expect(String(alert?.reason.evidence.cropUrl)).not.toContain('X-Amz-Signature=');
  });
});

/* ── AC 4 · the fallback, with no object store configured ─────────────────────────────────────── */

describe('D2-11 AC 4 — with no object store configured the crop renders as "no crop stored"', () => {
  it('presignerFor(null) refuses even a well-formed s3:// URI', () => {
    expect(presignerFor(null)('s3://saakshi-evidence/evidence/cam01/2026-09-05/x-plate.jpg')).toBe(
      null,
    );
  });

  it('an alert engine with no evidence store yields cropUrl null and says why', async () => {
    if (!reachable) return;
    const at = new Date().toISOString();
    const trackId = TRACK_BASE + 12;
    const storedUri = 's3://saakshi-evidence/evidence/cam01/2026-09-05/fallback-plate.jpg';
    const rows = await db.execute<{ id: string; ts: string }>(sql`
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
                             crop_uri, is_best_shot)
      values (${cameraUuid}::uuid, ${at}::timestamptz, 4000, ${trackId}, 'car',
              '{"x":1,"y":2,"w":3,"h":4}'::jsonb, 0.87, ${storedUri}, true)
      returning id::text as id, ts::text as ts
    `);
    const sighting = rows[0];

    // `evidence: null` is what `evidenceStoreFromEnv()` returns on a machine with no MINIO_* keys.
    // The pipeline still runs; the crop is simply not signable, and the alert says so.
    const offline = new AlertEngine({
      db,
      evidence: null,
      registry: createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) }),
    });
    const outcome = await offline.correlate({
      sightingId: sighting?.id ?? '',
      sightingTs: sighting?.ts ?? '',
      cameraId: cameraUuid,
      rawText: ALERTING_PLATE,
      confidence: PLATE_CONFIDENCE,
      cropUri: storedUri,
    });
    const alert = outcome.alerts[0];
    expect(alert?.reason.evidence.cropUri).toBe(storedUri);
    expect(alert?.reason.evidence.cropUrl).toBeNull();
    expect(alert?.reason.caveats.some((c) => c.includes('no evidence store is configured'))).toBe(
      true,
    );
  });

  it('the HTTP surface renders the same alert as "no crop stored" when the API has no presigner', async () => {
    if (!reachable) return;
    const at = new Date().toISOString();
    const trackId = TRACK_BASE + 13;
    const storedUri = 's3://saakshi-evidence/evidence/cam01/2026-09-05/fallback2-plate.jpg';
    const rows = await db.execute<{ id: string; ts: string }>(sql`
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
                             crop_uri, is_best_shot)
      values (${cameraUuid}::uuid, ${at}::timestamptz, 4000, ${trackId}, 'car',
              '{"x":1,"y":2,"w":3,"h":4}'::jsonb, 0.87, ${storedUri}, true)
      returning id::text as id, ts::text as ts
    `);
    const outcome = await engine.correlate({
      sightingId: rows[0]?.id ?? '',
      sightingTs: rows[0]?.ts ?? '',
      cameraId: cameraUuid,
      rawText: ALERTING_PLATE,
      confidence: PLATE_CONFIDENCE,
    });
    const id = outcome.alerts[0]?.id ?? '';

    const offlineApp = await buildServer({ env, db, alertEngine: engine });
    await offlineApp.ready();
    try {
      const response = await offlineApp.inject({
        method: 'GET',
        url: `/api/v1/alerts/${id}`,
        headers: {
          authorization: `Bearer ${offlineApp.jwt.sign({ sub: operatorSub, badgeNo: 'GP-OPR-1042', role: 'operator', departmentId: null })}`,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<AlertRecord>();
      expect(body.reason.evidence.cropUrl).toBeNull();
    } finally {
      await offlineApp.close();
    }
  });
});

/* ── AC 2, 3, 5 · the cross-seam regression test ──────────────────────────────────────────────── */

describe('D2-11 — plate crops reach the object store and the alert links to one that resolves', () => {
  it('routes a plate crop to the plate_reads row, not the sighting row', async () => {
    if (!reachable || !valkeyReachable || store === null) {
      console.warn('[evidence] database, valkey or MINIO_* unavailable — skipping');
      return;
    }
    const trackId = TRACK_BASE + 21;
    const ts = new Date().toISOString();
    await xadd(
      SIGHTINGS_STREAM,
      sightingPayload({ trackId, framePtsMs: 4_000, ts, cropUri: null }),
    );
    await drainSightings();

    const read = await findPlateRead(db, cameraUuid, trackId, 4_000);
    expect(read).not.toBeNull();

    await xadd(EVIDENCE_STREAM_NAME, plateEvidencePayload({ trackId, framePtsMs: 4_000, ts }));
    const stats = await drainEvidence();
    expect(stats.stored).toBe(1);

    const key = evidenceKey({
      cameraExternalId: CAM,
      ts: read?.ts ?? '',
      sightingId: read?.id ?? '',
      kind: 'plate',
    });
    uploaded.push(key);

    // D2-02's key convention, unchanged — this is the same uploader, told which row to write.
    expect(key).toMatch(/^evidence\/.+\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}-plate\.jpg$/);
    expect(await cropUriOf(read?.id ?? '')).toBe(`s3://${store.bucket}/${key}`);

    // The sighting row's own crop is untouched: a plate crop carries no colour read, and letting it
    // overwrite the vehicle crop's attributes would lose a measurement to a record that made none.
    const sightingRows = await db.execute<{
      crop_uri: string | null;
      vehicle_color: string | null;
    }>(sql`select crop_uri, vehicle_color from sightings where id = ${read?.id ?? ''}::uuid`);
    expect(sightingRows[0]?.crop_uri).toBeNull();
    expect(sightingRows[0]?.vehicle_color).toBeNull();
  });

  it('lists the uploaded object in the bucket — a row saying s3:// is a claim, the listing is evidence', async () => {
    if (!reachable || !valkeyReachable || store === null) return;
    const trackId = TRACK_BASE + 22;
    const ts = new Date().toISOString();
    await xadd(
      SIGHTINGS_STREAM,
      sightingPayload({ trackId, framePtsMs: 5_000, ts, cropUri: null }),
    );
    await drainSightings();
    await xadd(EVIDENCE_STREAM_NAME, plateEvidencePayload({ trackId, framePtsMs: 5_000, ts }));
    await drainEvidence();

    const read = await findPlateRead(db, cameraUuid, trackId, 5_000);
    const key = evidenceKey({
      cameraExternalId: CAM,
      ts: read?.ts ?? '',
      sightingId: read?.id ?? '',
      kind: 'plate',
    });
    uploaded.push(key);

    const listed = await store.listObjects(`evidence/${CAM}/`);
    expect(listed.map((o) => o.key)).toContain(key);
    expect(listed.find((o) => o.key === key)?.size).toBe(
      Buffer.from(JPEG_BASE64, 'base64').byteLength,
    );
  });

  /**
   * **The regression D2-GATE (#23) failed for want of.**
   *
   * Nothing is stubbed. A real `XADD` of a sighting carrying a plate read whose `crop_uri` is
   * D2-01's `file://` path, drained by the real sightings consumer with the real `AlertEngine`
   * attached, so the alert is raised by the code that raises alerts in production. Then the real
   * evidence consumer uploads the plate crop to the real bucket. Then the alert is read back over
   * HTTP by the real route, and the URL that comes back is fetched over real HTTP.
   *
   * The answer must be one of exactly two things: **HTTP 200 with an image content type**, or
   * `null`. Never a URL that 4xxs. Reverting either half of the fix turns the 200 into a failure.
   */
  it('the regression D2-GATE failed on: an alert raised through the real correlation path carries a crop link a real HTTP request can fetch, or an explicit null', async () => {
    if (!reachable || !valkeyReachable) {
      console.warn('[evidence] database or valkey unreachable — the cross-seam test skips');
      return;
    }
    const trackId = TRACK_BASE + 31;
    const framePtsMs = 6_000;
    const ts = new Date().toISOString();

    // 1 · The writer. The worker's `file://` URI goes in, exactly as it does on a live run.
    await xadd(
      SIGHTINGS_STREAM,
      sightingPayload({ trackId, framePtsMs, ts, cropUri: LOCAL_CROP_URI }),
    );
    await drainSightings();

    const alerts = await db.execute<{ id: string }>(
      sql`select id::text as id from alerts where camera_id = ${cameraUuid}::uuid`,
    );
    expect(alerts).toHaveLength(1);
    const alertId = alerts[0]?.id ?? '';

    const read = await findPlateRead(db, cameraUuid, trackId, framePtsMs);
    expect(read).not.toBeNull();
    // The seam, before it is closed: what the worker wrote is a path on the worker's own disk.
    expect(await cropUriOf(read?.id ?? '')).toBe(LOCAL_CROP_URI);

    if (store === null) {
      // The honest fallback, asserted rather than skipped: with no object store the answer is
      // `null`, which D2-07 renders as "no crop stored".
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/alerts/${alertId}`,
        headers: auth('operator'),
      });
      expect(response.json<AlertRecord>().reason.evidence.cropUrl).toBeNull();
      console.warn('[evidence] MINIO_* unset — asserted the null branch of the cross-seam test');
      return;
    }

    // 2 · The uploader. The same evidence path D2-02 built, carrying `kind: 'plate'`.
    await xadd(EVIDENCE_STREAM_NAME, plateEvidencePayload({ trackId, framePtsMs, ts }));
    expect((await drainEvidence()).stored).toBe(1);

    const key = evidenceKey({
      cameraExternalId: CAM,
      ts: read?.ts ?? '',
      sightingId: read?.id ?? '',
      kind: 'plate',
    });
    uploaded.push(key);
    expect(await cropUriOf(read?.id ?? '')).toBe(`s3://${store.bucket}/${key}`);

    // 3 · The reader. The real route, the real RBAC, the real presigner.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/alerts/${alertId}`,
      headers: auth('operator'),
    });
    expect(response.statusCode).toBe(200);
    const record = response.json<AlertRecord>();
    const cropUrl = record.reason.evidence.cropUrl;

    // 4 · The assertion that spans the writer and the reader. Either it fetches, or it is null.
    expect(cropUrl).not.toBeNull();
    expect(cropUrl).toContain('X-Amz-Signature=');

    // GET, not HEAD: a pre-signed URL is signed for one method, and a HEAD of a GET-presigned URL
    // is a different canonical request that answers 403 against a store that is working perfectly.
    const fetched = await fetch(String(cropUrl));
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/jpeg');
    expect((await fetched.arrayBuffer()).byteLength).toBe(
      Buffer.from(JPEG_BASE64, 'base64').byteLength,
    );

    // And the caveat that said there was no crop is gone, because there now is one.
    expect(record.reason.caveats.some((c) => c.startsWith('no crop URL'))).toBe(false);

    console.log(`  [D2-11] alert ${alertId.slice(0, 8)} → ${key} → HTTP ${String(fetched.status)}`);
  }, 30_000);
});
