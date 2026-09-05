/**
 * D3-03 — re-ID links in the trace, end to end against the real database.
 *
 * The scenario is the one the feature exists for and it cannot be faked with a stub: **a sighting
 * whose plate was never read**. It has no `plate_reads` row, so `TraceService.hydrate()`'s
 * `from plate_reads pr ... where pr.normalized_text in (…)` cannot see it at any confidence floor.
 * Only the appearance bridge reaches it, and only when the officer asks.
 *
 * What is asserted here:
 *
 * - AC 4 — the bridged sighting is flagged `reid_bridge`, counted in `coverage.otherLinks`, and
 *   both filterable and excludable;
 * - AC 5 — with re-ID off the trace is plate-only, and a stored appearance link is not merely
 *   hidden from the count but not applied at all;
 * - AC 6 — the measured completeness delta: how many sightings the trace finds with and without.
 *
 * Skips loudly, never silently, when there is no database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv, type Env } from '../env.js';
import { TraceService } from './trace.js';
import { ReidBridgeService, reidConfigFromEnv, type ReidConfig } from './reid.js';
import type { LngLat, OsrmClient, OsrmRoute } from './osrm.js';

const TAG = `RI${String(Date.now()).slice(-9)}`;
const PLATE = 'GJ01ZZ9911';

let env: Env;
let rawSql: Sql;
let db: Db;
let service: TraceService;
let reachable = false;
const cameras: Record<string, string> = {};
/** The sighting whose plate nobody could read — the whole point of the feature. */
let unreadableSightingId = '';

const CONFIG: ReidConfig = { ...reidConfigFromEnv({}), enabled: true, minBestShotScore: 0.25 };

/** A ten-minute drive between the two cameras, whatever the coordinates say. */
const osrm: OsrmClient = {
  baseUrl: 'stub',
  route(_from: LngLat, _to: LngLat): Promise<OsrmRoute | null> {
    return Promise.resolve({
      distanceM: 6000,
      durationS: 600,
      geometry: null,
      options: 1,
      alternativeSpread: null,
    });
  },
};

/** A unit vector in the plane. `angle = 0` for both anchors and the true candidate. */
function unit(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

async function seedSighting(
  camera: string,
  ts: string,
  trackId: number,
  plate: string | null,
  embedding: number[] | null,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into sightings
      (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence,
       vehicle_color, vehicle_color_confidence, attributes_low_confidence, crop_uri, is_best_shot)
    values (${cameras[camera] ?? ''}::uuid, ${ts}, ${Math.round(Date.parse(ts) % 1_000_000)},
            ${trackId}, 'car', '{"x":0,"y":0,"w":120,"h":90}'::jsonb, 0.910,
            'white', 0.700, false,
            ${`s3://saakshi-evidence/evidence/${TAG}/${String(trackId)}-vehicle.jpg`}, true)
    returning id::text as id
  `);
  const id = rows[0]?.id ?? '';
  if (plate !== null) {
    await db.execute(sql`
      insert into plate_reads
        (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, is_best_shot)
      values (${id}::uuid, ${ts}, ${plate}, ${plate}, 0.910, 3, true)
    `);
  }
  if (embedding !== null) {
    await db.execute(sql`
      insert into sighting_appearance
        (sighting_id, sighting_ts, camera_id, embedder_id, dim, embedding, best_shot_score)
      values (${id}::uuid, ${ts}, ${cameras[camera] ?? ''}::uuid, ${CONFIG.embedderId},
              ${embedding.length}, ${`{${embedding.join(',')}}`}::real[], 0.800)
    `);
  }
  return id;
}

beforeAll(async () => {
  env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[trace-reid] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  const seeded = await db.execute<{ id: string; external_id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind, endpoints, district, location)
    values
      (${`${TAG}-CAM-A`}, 'D3-03 anchor camera (test)', 'hls', '{}'::jsonb, 'Ahmedabad',
       st_setsrid(st_makepoint(72.5714, 23.0225), 4326)::geography),
      (${`${TAG}-CAM-B`}, 'D3-03 bridge camera (test)', 'hls', '{}'::jsonb, 'Ahmedabad',
       st_setsrid(st_makepoint(72.6014, 23.0425), 4326)::geography),
      (${`${TAG}-CAM-C`}, 'D3-03 unplaced camera (test)', 'hls', '{}'::jsonb, null, null)
    returning id::text as id, external_id
  `);
  for (const row of seeded) {
    const key = row.external_id.endsWith('-A') ? 'a' : row.external_id.endsWith('-B') ? 'b' : 'c';
    cameras[key] = row.id;
  }

  // Two anchors: the plate was read at 09:00 and again at 09:20, both on camera A.
  await seedSighting('a', '2026-06-01T09:00:00.000Z', 800_001, PLATE, unit(0));
  await seedSighting('a', '2026-06-01T09:20:00.000Z', 800_002, PLATE, unit(0));

  // The candidate: camera B at 09:10, exactly the free-flow drive from either anchor — and **no
  // plate read at all**, which is why ANPR alone can never find it.
  unreadableSightingId = await seedSighting('b', '2026-06-01T09:10:00.000Z', 900_001, null, unit(0));

  // The decoy, on an **unplaced** camera — which is the state of all thirty real cameras on this
  // estate, not a contrived case. Identical embedding: a perfect appearance match. It must be
  // rejected, and it can only be rejected by the gate, because nothing can route to a camera with
  // no coordinates and D3-01 refuses to score an unroutable transition rather than guessing.
  //
  // A note worth having, because it is a real limit: with two anchors twenty minutes apart and a
  // ten-minute drive between the cameras, almost any *placed* candidate in the window is reachable
  // from at least one anchor. The gate's exclusion power falls as the gallery grows. That is
  // recorded in `docs/reid.md` §6, and it is one more reason precision decides this feature.
  await seedSighting('c', '2026-06-01T09:10:00.000Z', 900_002, null, unit(0));

  service = new TraceService(db, undefined, (uri) => `https://evidence.test/${uri.slice(5)}`);
}, 90_000);

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}-%`}`);
    await rawSql.end({ timeout: 5 });
  }
});

describe('D3-03 · a trace that bridges an unreadable plate', () => {
  it('finds nothing to bridge until the bridge is run — the baseline', async () => {
    if (!reachable) return;
    const before = await service.trace(PLATE, { includeReid: true });
    expect(before.sightings).toHaveLength(2);
    expect(before.coverage.otherLinks).toBe(0);
  });

  it('links only the reachable candidate, and rejects the physically impossible one', async () => {
    if (!reachable) return;
    const trace = await service.trace(PLATE, {});
    const bridge = new ReidBridgeService(db, osrm, CONFIG);
    const result = await bridge.bridge(trace, { purpose: 'D3-03 acceptance test' });

    expect(result.enabled).toBe(true);
    expect(result.candidatesConsidered).toBe(2);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.sightingId).toBe(unreadableSightingId);
    // The decoy shares an identical embedding, so its rejection can only have come from the gate.
    expect(result.pairsGatedOut).toBeGreaterThan(0);
    expect(result.pairsCompared).toBe(2);
    expect(result.written).toBe(1);
  });

  it('AC 4 · flags the bridged sighting distinctly and counts it apart from plate links', async () => {
    if (!reachable) return;
    const trace = await service.trace(PLATE, { includeReid: true });
    const bridged = trace.sightings.find((s) => s.sightingId === unreadableSightingId);

    expect(bridged).toBeDefined();
    expect(bridged?.linkMethod).toBe('reid_bridge');
    expect(bridged?.plateNormalized).toBe('');
    expect(bridged?.explanation).toMatch(/no readable plate of its own/);
    expect(trace.coverage.otherLinks).toBe(1);
    expect(trace.coverage.exactLinks).toBe(2);
    // The weakest claim must never outrank a plate match in a sorted list. A cosine of exactly 1.0
    // — which these synthetic vectors are — still caps at 0.6, below every plate link here.
    expect(bridged?.linkConfidence ?? 1).toBeLessThanOrEqual(0.6);
    const plateLinks = trace.sightings.filter((s) => s.linkMethod === 'plate_exact');
    expect(plateLinks.every((s) => s.linkConfidence > (bridged?.linkConfidence ?? 1))).toBe(true);
  });

  it('AC 1 · places the bridged sighting in PTS order, not appended to the end', async () => {
    if (!reachable) return;
    const trace = await service.trace(PLATE, { includeReid: true });
    const times = trace.sightings.map((s) => Date.parse(s.ts));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // 09:10 sits between the 09:00 and 09:20 anchors, which is where the ordering key puts it —
    // second of three, not appended after the plate reads.
    expect(trace.sightings[1]?.sightingId).toBe(unreadableSightingId);
    expect(trace.sightings.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('AC 5 · with re-ID off the trace is plate-only, and the stored link is not applied', async () => {
    if (!reachable) return;
    const plateOnly = await service.trace(PLATE, {});
    expect(plateOnly.sightings).toHaveLength(2);
    expect(plateOnly.sightings.every((s) => s.linkMethod === 'plate_exact')).toBe(true);
    expect(plateOnly.coverage.otherLinks).toBe(0);
    expect(plateOnly.sightings.some((s) => s.sightingId === unreadableSightingId)).toBe(false);
  });

  it('AC 6 · records the measured completeness delta, with and without', async () => {
    if (!reachable) return;
    const without = await service.trace(PLATE, {});
    const withReid = await service.trace(PLATE, { includeReid: true });
    // The number quoted in docs/reid.md §8 and in the ticket's completeness comment.
    expect(withReid.sightings.length - without.sightings.length).toBe(1);
    expect(withReid.cameras.length).toBe(2);
    expect(without.cameras.length).toBe(1);
  });

  it('never claims a sighting a second identity already owns', async () => {
    if (!reachable) return;
    const trace = await service.trace(PLATE, {});
    const bridge = new ReidBridgeService(db, osrm, CONFIG);
    // Re-running finds nothing: the candidate now has an `identity_sightings` row, and a sighting
    // attached to any identity is not a candidate for another.
    const again = await bridge.bridge(trace, { purpose: 'D3-03 idempotency' });
    expect(again.links).toHaveLength(0);
  });
});
