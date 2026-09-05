/**
 * D3-03 — vehicle re-ID bridging.
 *
 * The acceptance criterion this file exists for is AC 2: *"Spatio-temporal gate applied before any
 * appearance comparison (test proves an ungated match is rejected)"*. Proving that needs more than
 * "the link did not happen" — a broken matcher would also produce no link. So the test asserts the
 * *mechanism*: the SQL that loads embeddings is never issued for a candidate the gate rejected, and
 * a candidate the gate admits does get compared. Both directions, per the house rule.
 *
 * Everything here is pure or runs against a recording fake. There is no Postgres, no OSRM and no
 * network: the gate is arithmetic over metadata, which is exactly what makes it provable offline.
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import type { LngLat, OsrmClient, OsrmRoute } from './osrm.js';
import { timingPlausibility } from './route.js';
import type { TraceResult, TraceSighting } from './trace.js';
import {
  REID_MEASURED_PRECISION,
  REID_SIMILARITY_MIN,
  ReidBridgeService,
  anchorsOf,
  cosine,
  gateCandidates,
  gateReason,
  linkConfidence,
  matchReachable,
  reidConfigFromEnv,
  type ReidAnchor,
  type ReidCandidate,
  type ReidConfig,
} from './reid.js';

const CONFIG: ReidConfig = { ...reidConfigFromEnv({}), enabled: true };

const ANCHOR: ReidAnchor = {
  sightingId: 'a1111111-1111-4111-8111-111111111111',
  ts: '2026-09-05T10:00:00.000Z',
  cameraId: 'c1111111-1111-4111-8111-111111111111',
  lat: 23.0225,
  lon: 72.5714,
  located: true,
};

function candidate(over: Partial<ReidCandidate> = {}): ReidCandidate {
  return {
    sightingId: 'b2222222-2222-4222-8222-222222222222',
    ts: '2026-09-05T10:00:30.000Z',
    cameraId: 'c2222222-2222-4222-8222-222222222222',
    cameraExternalId: 'cam02',
    lat: 23.05,
    lon: 72.6,
    located: true,
    bestShotScore: 0.8,
    ...over,
  };
}

/** A vector that is identical to itself: a perfect appearance match, cosine exactly 1. */
const IDENTICAL = [0.6, 0.8, 0.0, 0.0];

// ── the gate, on its own ────────────────────────────────────────────────────────────────────────

describe('the spatio-temporal gate', () => {
  it('rejects a candidate that cannot be reached in the elapsed time', () => {
    const reason = gateReason(
      { sameCamera: false, elapsedS: 30, expectedTravelTimeS: 1800 },
      CONFIG,
    );
    expect(reason).toMatch(/plausibility/);
  });

  it('admits a candidate that can — the control for the test above', () => {
    expect(
      gateReason({ sameCamera: false, elapsedS: 900, expectedTravelTimeS: 600 }, CONFIG),
    ).toBeNull();
  });

  it("refuses an unroutable pair rather than guessing, exactly as D3-01's classifier does", () => {
    expect(gateReason({ sameCamera: false, elapsedS: 600, expectedTravelTimeS: null }, CONFIG)).toBe(
      'no route between the cameras — travel time unmeasured',
    );
  });

  it('treats one camera as a dwell window and says so, rather than as a zero travel time', () => {
    expect(gateReason({ sameCamera: true, elapsedS: 60, expectedTravelTimeS: null }, CONFIG)).toBeNull();
    expect(
      gateReason({ sameCamera: true, elapsedS: 600, expectedTravelTimeS: null }, CONFIG),
    ).toMatch(/dwell window/);
  });

  it('refuses a candidate that precedes its anchor, or sits beyond the elapsed ceiling', () => {
    expect(gateReason({ sameCamera: false, elapsedS: -5, expectedTravelTimeS: 60 }, CONFIG)).toBe(
      'candidate precedes the anchor',
    );
    expect(
      gateReason({ sameCamera: false, elapsedS: 7200, expectedTravelTimeS: 7000 }, CONFIG),
    ).toMatch(/ceiling/);
  });

  it("uses D3-01's travel-time model rather than a second one of its own", () => {
    // If `route.ts` ever changes its curve, this is the assertion that notices.
    const plausible = timingPlausibility(900, 600) ?? 0;
    const implausible = timingPlausibility(30, 1800) ?? 0;
    expect(plausible).toBeGreaterThanOrEqual(CONFIG.gateTimingMin);
    expect(implausible).toBeLessThan(CONFIG.gateTimingMin);
  });

  it('drops a crop too weak to be evidence of anything', () => {
    // D2-08 opened the shipped crops and found Gujarati shop signage among them. Two such crops
    // match each other happily, which is the failure this floor exists for.
    const { reachable, rejected } = gateCandidates(
      [ANCHOR],
      [candidate({ bestShotScore: 0.05 })],
      () => 600,
      CONFIG,
    );
    expect(reachable).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/best-shot score/);
  });
});

// ── the ordering property, which is the safety property ─────────────────────────────────────────

describe('the gate runs before any appearance comparison', () => {
  it('never compares a pair the gate rejected, however perfect the appearance match', () => {
    const unreachable = candidate({ ts: '2026-09-05T10:00:30.000Z' }); // 30 s for a 30-minute drive
    const { reachable, rejected } = gateCandidates([ANCHOR], [unreachable], () => 1800, CONFIG);

    expect(reachable).toHaveLength(0);
    expect(rejected).toHaveLength(1);

    // The embeddings ARE identical — cosine 1.0, far above the floor. Appearance alone would link
    // them without hesitation, and it never gets the chance.
    const embeddings = new Map([
      [ANCHOR.sightingId, IDENTICAL],
      [unreachable.sightingId, IDENTICAL],
    ]);
    expect(cosine(IDENTICAL, IDENTICAL)).toBeCloseTo(1, 6);
    const { links, compared } = matchReachable(reachable, embeddings, CONFIG);
    expect(compared).toBe(0);
    expect(links).toHaveLength(0);
  });

  it('does link the same perfect match once it is reachable — the control', () => {
    const reachableCandidate = candidate({ ts: '2026-09-05T10:10:00.000Z' });
    const { reachable } = gateCandidates([ANCHOR], [reachableCandidate], () => 600, CONFIG);
    expect(reachable).toHaveLength(1);

    const embeddings = new Map([
      [ANCHOR.sightingId, IDENTICAL],
      [reachableCandidate.sightingId, IDENTICAL],
    ]);
    const { links, compared } = matchReachable(reachable, embeddings, CONFIG);
    expect(compared).toBe(1);
    expect(links).toHaveLength(1);
    expect(links[0]?.gate).toBe('travel_time');
  });

  it('never issues the embedding query for a gated-out candidate', async () => {
    // The mechanism, not the outcome. A recording fake fails the test if `sighting_appearance`'s
    // embedding column is ever selected for a candidate the gate threw away.
    const statements: string[] = [];
    const db = recordingDb(statements, [
      {
        sighting_id: 'b2222222-2222-4222-8222-222222222222',
        ts: '2026-09-05T10:00:30.000Z',
        camera_id: 'c2222222-2222-4222-8222-222222222222',
        camera_external_id: 'cam02',
        lat: 23.05,
        lon: 72.6,
        best_shot_score: '0.800',
      },
    ]);
    const osrm = fixedOsrm(1800); // a 30-minute drive, 30 seconds apart

    const service = new ReidBridgeService(db, osrm, CONFIG);
    const result = await service.bridge(traceOf(), { persist: false });

    expect(result.candidatesConsidered).toBe(1);
    expect(result.pairsGatedOut).toBe(1);
    expect(result.pairsCompared).toBe(0);
    expect(result.links).toHaveLength(0);
    expect(statements.some((s) => s.includes('embedding'))).toBe(false);
  });
});

// ── configuration and claims ────────────────────────────────────────────────────────────────────

describe('the shipped configuration', () => {
  it('is disabled unless something explicitly says true', () => {
    expect(reidConfigFromEnv({}).enabled).toBe(false);
    expect(reidConfigFromEnv({ REID_ENABLED: 'false' }).enabled).toBe(false);
    expect(reidConfigFromEnv({ REID_ENABLED: '0' }).enabled).toBe(false);
    expect(reidConfigFromEnv({ REID_ENABLED: 'yes' }).enabled).toBe(false);
    expect(reidConfigFromEnv({ REID_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('does nothing at all — not even a query — when it is disabled', async () => {
    const statements: string[] = [];
    const db = recordingDb(statements, []);
    const service = new ReidBridgeService(db, fixedOsrm(600), reidConfigFromEnv({}));
    const result = await service.bridge(traceOf(), { persist: false });
    expect(result.enabled).toBe(false);
    expect(result.links).toHaveLength(0);
    expect(statements).toHaveLength(0);
  });

  it('publishes the measured precision rather than an aspiration', () => {
    expect(REID_MEASURED_PRECISION).toBeLessThan(0.9);
    expect(REID_MEASURED_PRECISION).toBeCloseTo(0.761, 3);
  });
});

describe('the confidence a bridge writes', () => {
  it('is zero below the calibrated floor and capped well under any plate match', () => {
    expect(linkConfidence(REID_SIMILARITY_MIN - 0.001)).toBe(0);
    expect(linkConfidence(1)).toBeLessThanOrEqual(0.6);
    expect(linkConfidence(0.99)).toBeLessThan(linkConfidence(1));
  });

  it('is not the raw cosine, which would read as a confidence it has not earned', () => {
    expect(linkConfidence(0.98)).toBeLessThan(0.98);
  });
});

describe('the gallery', () => {
  it('is seeded only from plate-read sightings, never from another appearance link', () => {
    const trace = traceOf([
      sighting({ sightingId: 'p1', linkMethod: 'plate_exact' }),
      sighting({ sightingId: 'r1', linkMethod: 'reid_bridge' }),
      sighting({ sightingId: 'f1', linkMethod: 'plate_fuzzy' }),
    ]);
    const ids = anchorsOf(trace).map((a) => a.sightingId);
    expect(ids).toContain('p1');
    expect(ids).toContain('f1');
    // An identity bootstrapped from an appearance link compounds its own error, and at 0.761
    // precision the second hop would be wrong nearly half the time.
    expect(ids).not.toContain('r1');
  });

  it('ignores a sighting with no best-shot crop, because there is nothing to embed', () => {
    const trace = traceOf([sighting({ sightingId: 'p2', isBestShot: false })]);
    expect(anchorsOf(trace)).toHaveLength(0);
  });
});

describe('cosine', () => {
  it('is zero for mismatched or empty vectors rather than throwing into a request path', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it('survives the float32 round trip Postgres puts a real[] through', () => {
    const a = [0.6, 0.8];
    const roundTripped = a.map((v) => Math.fround(v));
    expect(cosine(a, roundTripped)).toBeCloseTo(1, 6);
  });
});

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────

function fixedOsrm(durationS: number): OsrmClient {
  return {
    baseUrl: 'fake',
    route(_from: LngLat, _to: LngLat): Promise<OsrmRoute | null> {
      return Promise.resolve({
        distanceM: durationS * 10,
        durationS,
        geometry: null,
        options: 1,
        alternativeSpread: null,
      });
    },
  };
}

/** Records every statement it is asked to run, so a test can assert what was NOT asked for. */
function recordingDb(statements: string[], rows: Record<string, unknown>[]): Db {
  const execute = (query: { queryChunks?: unknown[] }): Promise<Record<string, unknown>[]> => {
    statements.push(JSON.stringify(query.queryChunks ?? query));
    return Promise.resolve(rows);
  };
  return { execute } as unknown as Db;
}

function sighting(over: Partial<TraceSighting> = {}): TraceSighting {
  return {
    seq: 1,
    sightingId: ANCHOR.sightingId,
    ts: ANCHOR.ts,
    framePtsMs: 0,
    cameraId: ANCHOR.cameraId,
    cameraExternalId: 'cam01',
    cameraName: 'Camera 1',
    district: 'Ahmedabad',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    located: true,
    trackId: 100_001,
    trackingSession: 1,
    rawTrackerId: 1,
    class: 'car',
    detConfidence: 0.9,
    vehicleColor: 'white',
    vehicleColorConfidence: 0.7,
    attributesLowConfidence: false,
    isBestShot: true,
    cropUri: null,
    cropUrl: null,
    plateNormalized: 'GJ01AB1234',
    plateRawText: 'GJ01AB1234',
    ocrConfidence: 0.9,
    voteCount: 3,
    linkMethod: 'plate_exact',
    linkConfidence: 0.9,
    matchDistance: 0,
    matchStrength: 1,
    explanation: 'exact',
    basis: 'observed',
    retention: {
      state: 'unknown',
      retentionDays: null,
      expiresAt: null,
      remainingMs: null,
      remainingDays: null,
      remainingHours: null,
      expiringSoonHours: 48,
      computedAt: ANCHOR.ts,
      expiresOnIstDate: null,
      label: 'unknown',
    },
    ...over,
  };
}

function traceOf(sightings: TraceSighting[] = [sighting()]): TraceResult {
  return {
    query: 'GJ01AB1234',
    normalized: 'GJ01AB1234',
    validity: 'valid',
    reason: null,
    searched: true,
    window: { from: null, to: null },
    minConfidence: 0,
    maxDistance: 2,
    matcher: 'test',
    identity: {
      canonicalPlate: 'GJ01AB1234',
      searched: true,
      plates: [],
      exactPlates: 1,
      fuzzyPlates: 0,
      candidateSightings: sightings.length,
      firstSeen: ANCHOR.ts,
      lastSeen: ANCHOR.ts,
      matcher: 'test',
    },
    sightings,
    segments: [],
    cameras: [],
    coverage: {
      sightings: sightings.length,
      cameras: 1,
      camerasPlaced: 1,
      sightingsMappable: sightings.length,
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
