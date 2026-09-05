/**
 * D3-01 — route reconstruction on the road graph.
 *
 * Two halves, deliberately separated:
 *
 *  - **the arithmetic**, which is pure and runs everywhere: classification, the confidence formula,
 *    the summary. These are the assertions that would still catch a regression on a machine with no
 *    Postgres and no OSRM, and they are where the acceptance criteria about *behaviour* live.
 *  - **the round trip**, which needs the migrated database: persistence and the two-key cache. It
 *    skips loudly rather than silently when the database is unreachable.
 *
 * A third, opt-in block hits a **real OSRM** when one is listening, because "OSRM answers with a
 * sane duration" is an acceptance criterion and a stub cannot prove it. It is skipped, with a
 * message, when there is no graph — which is the state of a fresh clone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  HttpOsrmClient,
  NullOsrmClient,
  type LngLat,
  type OsrmClient,
  type OsrmRoute,
} from './osrm.js';
import {
  MODEL_VERSION,
  RouteService,
  buildSegment,
  classify,
  endpointEvidence,
  fingerprintSightings,
  pathUniqueness,
  routeCacheKey,
  summarise,
  timingPlausibility,
} from './route.js';
import type { TraceCamera, TraceResult, TraceSighting } from './trace.js';

const TAG = `RT${String(Date.now()).slice(-9)}`;
const PLATE = `GJ01AB1234`;

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

/**
 * Four cameras on a plausible Ahmedabad itinerary, plus one deliberately unplaced.
 *
 * The ids are real UUIDs, not readable slugs, because `route_segments.from_camera_id` is a `uuid`
 * column: a slug makes the segment insert fail, and — before the write was made transactional —
 * that produced a `routes` row with zero segments that every later request happily served as a
 * cache *hit*. The fixture is shaped like the column for a reason.
 */
const PLACES: Record<string, { id: string; lon: number | null; lat: number | null; name: string }> =
  {
    A: {
      id: '11111111-1111-4111-8111-111111111111',
      lon: 72.5714,
      lat: 23.0225,
      name: 'Paldi Circle',
    },
    B: { id: '22222222-2222-4222-8222-222222222222', lon: 72.5871, lat: 23.0311, name: 'Janpath' },
    C: {
      id: '33333333-3333-4333-8333-333333333333',
      lon: 72.6042,
      lat: 23.0398,
      name: 'Chimanbhai Bridge',
    },
    E: {
      id: '55555555-5555-4555-8555-555555555555',
      lon: null,
      lat: null,
      name: 'Naroda Road (unplaced)',
    },
  };

let seq = 0;
function sighting(
  camera: keyof typeof PLACES,
  atSeconds: number,
  trackId: number,
  linkConfidence = 0.8,
): TraceSighting {
  const place = PLACES[camera] ?? PLACES['A'];
  seq += 1;
  return {
    seq,
    sightingId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ts: new Date(Date.UTC(2026, 8, 5, 9, 0, 0) + atSeconds * 1000).toISOString(),
    framePtsMs: atSeconds * 1000,
    cameraId: place?.id ?? '',
    cameraExternalId: `TRACEFIX-CAM-${camera}`,
    cameraName: place?.name ?? '',
    district: 'Ahmedabad',
    lat: place?.lat ?? null,
    lon: place?.lon ?? null,
    located: (place?.lat ?? null) !== null,
    trackId,
    trackingSession: Math.trunc(trackId / 100_000),
    rawTrackerId: trackId % 100_000,
    class: 'car',
    detConfidence: 0.91,
    vehicleColor: 'white',
    vehicleColorConfidence: 0.7,
    attributesLowConfidence: false,
    isBestShot: true,
    cropUri: null,
    cropUrl: null,
    plateNormalized: PLATE,
    plateRawText: PLATE,
    ocrConfidence: 0.88,
    voteCount: 3,
    linkMethod: 'plate_exact',
    linkConfidence,
    matchDistance: 0,
    matchStrength: 1,
    explanation: 'exact',
    basis: 'observed',
  };
}

function traceOf(sightings: TraceSighting[]): TraceResult {
  const cameras: TraceCamera[] = [];
  for (const s of sightings) {
    if (cameras.some((c) => c.cameraId === s.cameraId)) continue;
    cameras.push({
      cameraId: s.cameraId,
      externalId: s.cameraExternalId,
      name: s.cameraName,
      district: s.district,
      lat: s.lat,
      lon: s.lon,
      located: s.located,
      sightingCount: 1,
      firstSeq: s.seq,
    });
  }
  return {
    query: PLATE,
    normalized: PLATE,
    validity: 'valid',
    reason: null,
    searched: true,
    window: { from: null, to: null },
    minConfidence: 0,
    maxDistance: 2,
    matcher: 'test',
    identity: {
      canonicalPlate: `${TAG}${PLATE}`.slice(0, 24),
      searched: true,
      plates: [],
      exactPlates: 1,
      fuzzyPlates: 0,
      candidateSightings: sightings.length,
      firstSeen: sightings[0]?.ts ?? null,
      lastSeen: sightings.at(-1)?.ts ?? null,
      matcher: 'test',
    },
    sightings,
    segments: [],
    cameras,
    coverage: {
      sightings: sightings.length,
      cameras: cameras.length,
      camerasPlaced: cameras.filter((c) => c.located).length,
      sightingsMappable: sightings.filter((s) => s.located).length,
      sightingsWithCrop: 0,
      exactLinks: sightings.length,
      fuzzyLinks: 0,
      otherLinks: 0,
      droppedBelowConfidence: 0,
      truncated: false,
    },
    claims: { observed: '', inferred: '' },
    emptyReason: null,
    disclaimer: '',
    tookMs: 1,
  };
}

/**
 * A stub road graph. Returns a fixed 4 km / 400 s path unless told otherwise, so a test that cares
 * about the *formula* is not also testing OSRM's opinion of Ahmedabad's traffic.
 */
function stubOsrm(over: Partial<OsrmRoute> = {}, unreachable: LngLat[] = []): OsrmClient {
  return {
    baseUrl: 'stub://osrm',
    route(from: LngLat, to: LngLat): Promise<OsrmRoute | null> {
      const blocked = unreachable.some(
        (p) => (p[0] === from[0] && p[1] === from[1]) || (p[0] === to[0] && p[1] === to[1]),
      );
      if (blocked) return Promise.resolve(null);
      return Promise.resolve({
        distanceM: 4000,
        durationS: 400,
        geometry: {
          type: 'LineString',
          coordinates: [from as [number, number], to as [number, number]],
        },
        options: 1,
        alternativeSpread: null,
        ...over,
      });
    },
  };
}

// ── AC 3 / AC 6 · classification ────────────────────────────────────────────────────────────────

describe('segment classification', () => {
  it('calls one camera and one unbroken tracking session observed', () => {
    const a = sighting('A', 0, 300_001);
    const b = sighting('A', 12, 300_001);
    expect(classify(a, b, null)).toBe('observed_dwell');
    expect(buildSegment(1, a, b, null).observed).toBe(true);
    expect(buildSegment(1, a, b, null).basis).toBe('observed');
  });

  it('does NOT call the same camera in a different tracking session observed', () => {
    // D1-09 measured raw ByteTrack ids being reused across sessions on one camera in a single run.
    // 300_001 and 700_001 are the SAME raw tracker id (1) in sessions 3 and 7.
    const a = sighting('A', 0, 300_001);
    const b = sighting('A', 2040, 700_001);
    expect(a.rawTrackerId).toBe(b.rawTrackerId);
    expect(classify(a, b, null)).toBe('inferred_revisit');
    expect(buildSegment(1, a, b, null).observed).toBe(false);
  });

  it('routes a transition between two placed cameras', async () => {
    const a = sighting('A', 0, 300_001);
    const b = sighting('B', 400, 400_012);
    const routed = await stubOsrm().route([a.lon ?? 0, a.lat ?? 0], [b.lon ?? 0, b.lat ?? 0]);
    expect(classify(a, b, routed)).toBe('inferred_path');
  });

  it('reports an unplaced camera as unroutable rather than dropping the segment', () => {
    const a = sighting('A', 0, 300_001);
    const e = sighting('E', 600, 800_002);
    expect(classify(a, e, null)).toBe('inferred_unroutable');
    const segment = buildSegment(1, a, e, null);
    expect(segment.roadDistanceKm).toBeNull();
    expect(segment.straightLineKm).toBeNull();
    expect(segment.note).toContain('no coordinates');
  });

  it('distinguishes "no coordinates" from "no path in the graph"', () => {
    const a = sighting('A', 0, 300_001);
    const b = sighting('B', 400, 400_012);
    expect(buildSegment(1, a, b, null).note).toContain('no driving path');
  });
});

// ── AC 6 · the same-camera edge cases ───────────────────────────────────────────────────────────

describe('same camera and degenerate traces', () => {
  it('claims no distance for two consecutive sightings at the same camera', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const trace = traceOf([sighting('A', 0, 300_001), sighting('A', 12, 300_001)]);
    const route = await service.reconstruct(trace, { persist: false });

    expect(route.segments).toHaveLength(1);
    const only = route.segments[0];
    expect(only?.kind).toBe('observed_dwell');
    expect(only?.sameCamera).toBe(true);
    // No transition is being claimed, so no path is drawn and no distance is asserted.
    expect(only?.geometry).toBeNull();
    expect(only?.roadDistanceKm).toBeNull();
    expect(only?.straightLineKm).toBeNull();
    // Nothing was inferred, so there is nothing to score. 1.0 would read as a measurement.
    expect(only?.inferredConfidence).toBeNull();
  });

  it('never queries the road graph for a same-camera pair', async () => {
    let calls = 0;
    const counting: OsrmClient = {
      baseUrl: 'stub://osrm',
      route(): Promise<OsrmRoute | null> {
        calls += 1;
        return Promise.resolve(null);
      },
    };
    const service = new RouteService(nullDb(), counting);
    await service.reconstruct(
      traceOf([sighting('A', 0, 300_001), sighting('A', 12, 300_001), sighting('A', 30, 700_001)]),
      { persist: false },
    );
    expect(calls).toBe(0);
  });

  it('produces no segments at all from a single sighting', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const route = await service.reconstruct(traceOf([sighting('A', 0, 300_001)]), {
      persist: false,
    });
    expect(route.segments).toEqual([]);
    expect(route.summary.segments).toBe(0);
    expect(route.summary.totalKm).toBe(0);
    expect(route.summary.meanInferredConfidence).toBeNull();
  });
});

// ── AC 5 · the confidence formula ───────────────────────────────────────────────────────────────

describe('inferred confidence', () => {
  it('scores a near-instant transition at essentially zero', () => {
    // Two seconds to cover a path the road graph says takes seven minutes.
    const timing = timingPlausibility(2, 420);
    expect(timing).not.toBeNull();
    expect(timing ?? 1).toBeLessThan(0.01);
  });

  it('scores an exactly-plausible transition at essentially one', () => {
    expect(timingPlausibility(400, 400)).toBe(1);
  });

  it('scores a plausibly slow transition high and a wildly slow one low', () => {
    const slightlySlow = timingPlausibility(480, 400) ?? 0; // 20 % over free-flow
    const absurdlySlow = timingPlausibility(400 * 12, 400) ?? 1; // an hour for a 7-minute drive
    expect(slightlySlow).toBeGreaterThan(0.9);
    expect(absurdlySlow).toBeLessThan(0.15);
  });

  it('punishes being early far harder than being late', () => {
    // Same factor from free-flow in each direction: half the time vs double the time.
    const early = timingPlausibility(200, 400) ?? 1;
    const late = timingPlausibility(800, 400) ?? 0;
    expect(late).toBeGreaterThan(early * 4);
  });

  it('returns null when the road graph gave no expected time, and 0 for a zero gap', () => {
    expect(timingPlausibility(120, null)).toBeNull();
    expect(timingPlausibility(120, 0)).toBeNull();
    expect(timingPlausibility(0, 400)).toBe(0);
  });

  it('discounts a path that has an equally quick alternative, but never to zero', () => {
    expect(pathUniqueness(1, null)).toBe(1); // forced
    expect(pathUniqueness(3, 1.0)).toBeCloseTo(0.35, 5); // a tie
    expect(pathUniqueness(3, 1.3)).toBe(1); // every alternative is materially worse
    expect(pathUniqueness(3, 1.1)).toBeGreaterThan(0.35);
    expect(pathUniqueness(3, 1.1)).toBeLessThan(1);
  });

  it('lets one weak endpoint drag the segment down rather than averaging it away', () => {
    const strong = endpointEvidence(sighting('A', 0, 1, 0.9), sighting('B', 1, 2, 0.9));
    const mixed = endpointEvidence(sighting('A', 0, 1, 0.9), sighting('B', 1, 2, 0.1));
    expect(strong).toBeGreaterThan(0.89);
    expect(mixed).toBeLessThan(0.31); // an arithmetic mean would have said 0.50
  });

  it('multiplies the three factors and records the working', async () => {
    const a = sighting('A', 0, 300_001, 0.88);
    const b = sighting('B', 440, 400_012, 0.79);
    const routed = await stubOsrm().route([a.lon ?? 0, a.lat ?? 0], [b.lon ?? 0, b.lat ?? 0]);
    const segment = buildSegment(1, a, b, routed);

    const basis = segment.confidenceBasis;
    expect(basis).not.toBeNull();
    expect(segment.inferredConfidence).toBeCloseTo(
      (basis?.timing ?? 0) * (basis?.uniqueness ?? 0) * (basis?.endpoints ?? 0),
      3,
    );
    expect(segment.inferredConfidence ?? 0).toBeGreaterThan(0.7);
  });

  it('states the bound in the direction it actually points', async () => {
    const a = sighting('A', 0, 300_001);
    const b = sighting('B', 400, 400_012);
    const routed = await stubOsrm().route([a.lon ?? 0, a.lat ?? 0], [b.lon ?? 0, b.lat ?? 0]);
    const segment = buildSegment(1, a, b, routed);
    // 4 km in 400 s = 36 km/h, and the vehicle averaged AT LEAST that: the road distance is a
    // lower bound on the distance it actually covered. D3-02 needs this direction.
    expect(segment.roadDistanceKm).toBe(4);
    expect(segment.minimumAverageSpeedKmh).toBe(36);
  });
});

// ── AC 3 · a whole route, mixed ─────────────────────────────────────────────────────────────────

describe('a reconstructed route', () => {
  const itinerary = (): TraceSighting[] => {
    seq = 0;
    return [
      sighting('A', 0, 300_001, 0.88), // 1
      sighting('A', 14, 300_001, 0.88), // 2 · dwell, same track   -> observed
      sighting('B', 420, 400_012, 0.79), // 3 · A->B               -> inferred_path
      sighting('C', 900, 500_007, 0.61), // 4 · B->C               -> inferred_path
      sighting('A', 2100, 700_001, 0.83), // 5 · C->A              -> inferred_path
      sighting('E', 2500, 800_002, 0.58), // 6 · A->E, E unplaced  -> inferred_unroutable
    ];
  };

  it('classifies a realistic mix rather than all-true or all-false', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const route = await service.reconstruct(traceOf(itinerary()), { persist: false });

    expect(route.segments.map((s) => s.kind)).toEqual([
      'observed_dwell',
      'inferred_path',
      'inferred_path',
      'inferred_path',
      'inferred_unroutable',
    ]);
    const observed = route.segments.map((s) => s.observed);
    expect(observed).toContain(true);
    expect(observed).toContain(false);
  });

  it('never drops the unplaced sighting from the route', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const route = await service.reconstruct(traceOf(itinerary()), { persist: false });
    // Five pairs from six sightings — the unplaced one keeps its place and states why it cannot
    // be routed. D1-08's handoff: neither set may be silently dropped.
    expect(route.segments).toHaveLength(5);
    expect(route.coverage.segmentsUnplaced).toBe(1);
    expect(route.coverage.segmentsRouted).toBe(3);
    expect(route.summary.unmeasuredSegments).toBe(2);
  });

  it('reports a road graph that is not answering instead of pretending it is', async () => {
    const service = new RouteService(nullDb(), new NullOsrmClient());
    const route = await service.reconstruct(traceOf(itinerary()), { persist: false });
    expect(route.segments.filter((s) => s.kind === 'inferred_path')).toHaveLength(0);
    expect(route.coverage.osrmFailures).toBe(3);
    expect(route.roadGraph.available).toBe(false);
  });

  // ── AC 7 · the summary, hand-checked ──────────────────────────────────────────────────────────
  it('agrees with a hand check on a small case', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const sightings = itinerary();
    const route = await service.reconstruct(traceOf(sightings), { persist: false });
    const summary = route.summary;

    // By hand: 6 sightings, 5 segments. 1 observed dwell, 4 inferred. 3 of the inferred ones were
    // routed at 4 km each -> 12 km inferred; the dwell and the unplaced hop contribute nothing.
    expect(summary.segments).toBe(5);
    expect(summary.observedSegments).toBe(1);
    expect(summary.inferredSegments).toBe(4);
    expect(summary.totalKm).toBe(12);
    expect(summary.observedKm).toBe(0);
    expect(summary.inferredKm).toBe(12);
    // 4 cameras appear (A, B, C, E); A twice. 3 of them are placed.
    expect(summary.cameras).toBe(4);
    expect(summary.camerasPlaced).toBe(3);
    // Elapsed is last.ts - first.ts = 2500 s, from PTS-derived wall clock.
    expect(summary.elapsedSeconds).toBe(2500);
    // The weakest inferred hop is C->A: 1200 s elapsed against a 400 s expectation.
    expect(summary.weakestSegmentSeq).toBe(4);

    const scored = route.segments.filter((s) => s.inferredConfidence !== null);
    expect(scored).toHaveLength(3);
    expect(summary.meanInferredConfidence).toBeCloseTo(
      scored.reduce((n, s) => n + (s.inferredConfidence ?? 0), 0) / 3,
      3,
    );
  });

  it('keeps the API order and never re-sorts it', async () => {
    const service = new RouteService(nullDb(), stubOsrm());
    const sightings = itinerary();
    const route = await service.reconstruct(traceOf(sightings), { persist: false });
    // D2-08's handoff: `ts ASC, framePtsMs ASC, sightingId ASC` is the single order. Every segment
    // is the pair at that position, in that order.
    expect(route.segments.map((s) => [s.fromSeq, s.toSeq])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ]);
  });

  // ── AC 8 · the latency budget ────────────────────────────────────────────────────────────────
  it('builds a 20-sighting trace well inside 3 s (p95 over 20 runs)', async () => {
    seq = 0;
    const cameras: (keyof typeof PLACES)[] = ['A', 'B', 'C'];
    const twenty = Array.from({ length: 20 }, (_, i) =>
      sighting(cameras[i % 3] ?? 'A', i * 300, 100_000 * (i + 1) + 1),
    );
    const trace = traceOf(twenty);
    // 40 ms per OSRM call, so a serial build of 19 hops would take ~760 ms and a badly serialised
    // one far more; the concurrency is what this measures.
    const slow: OsrmClient = {
      baseUrl: 'stub://osrm',
      async route(from: LngLat, to: LngLat): Promise<OsrmRoute | null> {
        await new Promise((r) => setTimeout(r, 40));
        return {
          distanceM: 4000,
          durationS: 400,
          geometry: {
            type: 'LineString',
            coordinates: [from as [number, number], to as [number, number]],
          },
          options: 1,
          alternativeSpread: null,
        };
      },
    };
    const service = new RouteService(nullDb(), slow);

    const timings: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = Date.now();
      const route = await service.reconstruct(trace, { persist: false });
      timings.push(Date.now() - started);
      expect(route.segments).toHaveLength(19);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(0.95 * timings.length) - 1)] ?? 0;
    console.log(`[route] 20-sighting build p95 ${String(p95)} ms over 20 runs`);
    expect(p95).toBeLessThan(3000);
  });
});

// ── cache keys ──────────────────────────────────────────────────────────────────────────────────

describe('cache keys', () => {
  it('keys the question on the parameters and the model version', () => {
    seq = 0;
    const a = traceOf([sighting('A', 0, 1), sighting('B', 400, 2)]);
    const b = { ...a, minConfidence: 0.5 };
    expect(routeCacheKey(a)).toBe(routeCacheKey({ ...a }));
    expect(routeCacheKey(a)).not.toBe(routeCacheKey(b));
    expect(MODEL_VERSION).toMatch(/^d3-01\./);
  });

  it('changes the evidence fingerprint the moment a sighting is added', () => {
    seq = 0;
    const first = [sighting('A', 0, 1), sighting('B', 400, 2)];
    const before = fingerprintSightings(first);
    const after = fingerprintSightings([...first, sighting('C', 800, 3)]);
    expect(before).not.toBe(after);
    expect(fingerprintSightings(first)).toBe(before);
  });
});

// ── the summary of an empty route ───────────────────────────────────────────────────────────────

describe('summarise', () => {
  it('handles a trace with no sightings without dividing by anything', () => {
    const summary = summarise([], traceOf([]));
    expect(summary).toMatchObject({
      segments: 0,
      elapsedSeconds: 0,
      totalKm: 0,
      meanInferredConfidence: null,
      weakestSegmentSeq: null,
    });
  });
});

// ── AC 9 · persistence and the two-key cache (needs the database) ───────────────────────────────

describe('persistence and cache', () => {
  let rawSql: Sql;
  let db: Db;
  let reachable = false;

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
    rawSql = createSql(env.DATABASE_URL, 4);
    db = createDb(rawSql);
    try {
      await rawSql`select 1`;
      reachable = true;
    } catch {
      console.warn('[route] database unreachable — skipping. Run `make up && make migrate`.');
    }
  });

  afterAll(async () => {
    if (reachable) {
      await db.execute(sql`delete from vehicle_identities where canonical_plate like ${`${TAG}%`}`);
    }
    await rawSql?.end();
  });

  it('hits the cache on a repeat request and misses when a sighting arrives', async () => {
    if (!reachable) return;
    seq = 0;
    const sightings = [sighting('A', 0, 300_001), sighting('B', 420, 400_012)];
    const trace = traceOf(sightings);
    const service = new RouteService(db, stubOsrm());

    const first = await service.reconstruct(trace);
    expect(first.cache.hit).toBe(false);
    expect(first.segments).toHaveLength(1);

    const second = await service.reconstruct(trace);
    expect(second.cache.hit).toBe(true);
    expect(second.cache.key).toBe(first.cache.key);
    expect(second.segments).toHaveLength(1);
    expect(second.segments[0]?.kind).toBe('inferred_path');
    expect(second.segments[0]?.roadDistanceKm).toBe(4);
    expect(second.summary.totalKm).toBe(first.summary.totalKm);

    // A new sighting arrives. Same question, different evidence — the stored answer must not serve.
    const grown = traceOf([...sightings, sighting('C', 900, 500_007)]);
    expect(routeCacheKey(grown)).toBe(first.cache.key);
    expect(fingerprintSightings(grown.sightings)).not.toBe(first.cache.fingerprint);
    const third = await service.reconstruct(grown);
    expect(third.cache.hit).toBe(false);
    expect(third.segments).toHaveLength(2);
  });

  it('never serves a half-written route as a cache hit', async () => {
    if (!reachable) return;
    seq = 0;
    // A camera id that is not a uuid makes the *segment* insert fail while the `routes` insert
    // succeeds. Before the write was wrapped in a transaction this left a keyed route with zero
    // segments, and every later request served it as a hit with an empty route.
    const broken = [sighting('A', 0, 300_001), sighting('B', 420, 400_012)];
    const second = broken[1];
    if (second !== undefined) second.cameraId = 'not-a-uuid';
    const trace = traceOf(broken);
    const service = new RouteService(db, stubOsrm());

    const first = await service.reconstruct(trace);
    expect(first.cache.hit).toBe(false);
    expect(first.segments).toHaveLength(1); // the answer is still returned in full

    const again = await service.reconstruct(trace);
    expect(again.cache.hit).toBe(false); // ...and nothing partial was left behind to serve
    expect(again.segments).toHaveLength(1);
  });

  it('stores the road path as real geography, readable back as GeoJSON', async () => {
    if (!reachable) return;
    seq = 0;
    const trace = traceOf([sighting('A', 0, 300_001), sighting('B', 420, 400_012)]);
    const service = new RouteService(db, stubOsrm());
    await service.reconstruct(trace);
    const cached = await service.reconstruct(trace);
    expect(cached.cache.hit).toBe(true);
    expect(cached.segments[0]?.geometry?.type).toBe('LineString');
    expect(cached.segments[0]?.geometry?.coordinates.length).toBeGreaterThanOrEqual(2);
  });
});

// ── AC 2 · a real road graph, when one is listening ─────────────────────────────────────────────

describe('a live OSRM', () => {
  const baseUrl = process.env['OSRM_URL'] ?? 'http://localhost:5000';
  let live = false;
  let client: HttpOsrmClient;

  beforeAll(async () => {
    client = new HttpOsrmClient({ baseUrl, timeoutMs: 4000 });
    const probe = await client.route([72.6, 23.2], [72.65, 23.25]);
    live = probe !== null;
    if (!live) {
      console.warn(`[route] no OSRM at ${baseUrl} — skipping. Run ./scripts/import-osm.sh.`);
    }
  });

  it('answers between two fixture camera positions with a sane duration', async () => {
    if (!live) return;
    // Paldi Circle -> Janpath, about 2 km apart in central Ahmedabad.
    const route = await client.route([72.5714, 23.0225], [72.5871, 23.0311]);
    expect(route).not.toBeNull();
    expect(route?.distanceM ?? 0).toBeGreaterThan(500);
    expect(route?.distanceM ?? 0).toBeLessThan(20_000);
    expect(route?.durationS ?? 0).toBeGreaterThan(10);
    // A city crossing of a couple of kilometres that OSRM thinks takes over an hour would mean the
    // graph is wrong, not that the traffic is bad — the car profile has no traffic model at all.
    expect(route?.durationS ?? 0).toBeLessThan(3600);
    const kmh = (route?.distanceM ?? 0) / 1000 / ((route?.durationS ?? 1) / 3600);
    expect(kmh).toBeGreaterThan(5);
    expect(kmh).toBeLessThan(130);
    console.log(
      `[route] live OSRM: ${((route?.distanceM ?? 0) / 1000).toFixed(2)} km, ` +
        `${(route?.durationS ?? 0).toFixed(0)} s, ${kmh.toFixed(1)} km/h`,
    );
  });

  it('returns null rather than throwing when there is no server', async () => {
    const dead = new HttpOsrmClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });
    await expect(dead.route([72.6, 23.2], [72.65, 23.25])).resolves.toBeNull();
  });
});

/**
 * A `Db` that must never be called. The pure tests pass `persist: false`, so any query reaching
 * this is a bug in the "do not touch the database when you were not asked to" contract.
 */
function nullDb(): Db {
  return {
    execute: () => {
      throw new Error('the database was queried during a persist:false reconstruction');
    },
  } as unknown as Db;
}
