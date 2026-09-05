/**
 * D2-08 — identity linking.
 *
 * Two halves. The folding of D2-04's ranked candidates into one identity is pure, so it is tested
 * without a database; `loadStoredLinks` reads two real tables and is tested against the migrated
 * one, skipping loudly when it is unreachable — the same contract the plate-search and watchlist
 * suites use.
 *
 * The suite seeds everything it asserts on under a per-run tag and removes it again, because
 * `sightings`, `plate_reads` and `identity_sightings` have no per-suite namespace and D2-04's
 * benchmark seeds 250,000 rows into the first two.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  LINK_METHODS,
  linkMethodFor,
  loadStoredLinks,
  resolveIdentity,
  sightingLinkConfidence,
} from './identity.js';
import { rankingScore, type PlateSearchCandidate, type PlateSearchResult } from './plate-search.js';

const TAG = `ID${String(Date.now()).slice(-9)}`;

let rawSql: Sql;
let db: Db;
let reachable = false;

function candidate(over: Partial<PlateSearchCandidate> = {}): PlateSearchCandidate {
  const distance = over.distance ?? 0;
  const matchStrength = over.matchStrength ?? (distance === 0 ? 1 : 0.7);
  const ocrConfidence = over.ocrConfidence ?? 0.8;
  return {
    plateNormalized: 'GJ01AB1234',
    matchType: distance === 0 ? 'exact' : 'fuzzy',
    distance,
    matchStrength,
    ocrConfidence,
    score: rankingScore(matchStrength, ocrConfidence),
    explanation: 'seeded',
    sightingCount: 3,
    cameraCount: 2,
    firstSeen: '2026-05-01T00:00:00.000Z',
    lastSeen: '2026-05-02T00:00:00.000Z',
    sightings: [],
    ...over,
  };
}

function searchResult(candidates: PlateSearchCandidate[], searched = true): PlateSearchResult {
  return {
    query: 'GJ01AB1234',
    normalized: 'GJ01AB1234',
    validity: 'valid',
    reason: null,
    missingChars: null,
    searched,
    maxDistance: 2,
    matcher: 'confusion-weighted',
    candidates,
  };
}

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[identity] database unreachable — skipping. Run `make up && make migrate`.');
  }
}, 60_000);

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from vehicle_identities where canonical_plate like ${`${TAG}%`}`);
  }
  await rawSql?.end();
});

describe('the link method is the claim being made', () => {
  it('distance 0 is plate_exact and anything else is plate_fuzzy', () => {
    expect(linkMethodFor(0)).toBe('plate_exact');
    expect(linkMethodFor(0.55)).toBe('plate_fuzzy');
    expect(linkMethodFor(2)).toBe('plate_fuzzy');
  });

  it('the enum matches migration 0005, including the reid_bridge value D3-03 will write', () => {
    expect([...LINK_METHODS]).toEqual(['plate_exact', 'plate_fuzzy', 'reid_bridge']);
  });
});

describe('link confidence', () => {
  it('is matchStrength × ocrConfidence — D2-04’s own ranking score, not a second metric', () => {
    expect(sightingLinkConfidence(0.7, 0.8)).toBe(rankingScore(0.7, 0.8));
    expect(sightingLinkConfidence(0.7, 0.8)).toBeCloseTo(0.56, 5);
  });

  it('a perfect string match on a weak read is not a strong link', () => {
    // The failure this guards: presenting an exact string match as certainty when the camera only
    // half-read the plate. On this estate that is the common case.
    expect(sightingLinkConfidence(1, 0.3)).toBeLessThan(sightingLinkConfidence(0.7, 0.9));
  });
});

describe('resolveIdentity', () => {
  it('folds every accepted candidate into one identity and counts the methods apart', () => {
    const identity = resolveIdentity(
      searchResult([
        candidate({ plateNormalized: 'GJ01AB1234', distance: 0, ocrConfidence: 0.9 }),
        candidate({ plateNormalized: 'GJ01AB12', distance: 0.7, matchStrength: 0.77, ocrConfidence: 0.6 }),
      ]),
    );
    expect(identity.canonicalPlate).toBe('GJ01AB1234');
    expect(identity.plates).toHaveLength(2);
    expect(identity.exactPlates).toBe(1);
    expect(identity.fuzzyPlates).toBe(1);
    expect(identity.candidateSightings).toBe(6);
    expect(identity.plates.map((p) => p.linkMethod)).toEqual(['plate_exact', 'plate_fuzzy']);
  });

  it('min_confidence drops a weak plate and keeps a strong one', () => {
    const result = searchResult([
      candidate({ plateNormalized: 'GJ01AB1234', distance: 0, ocrConfidence: 0.9 }),
      candidate({ plateNormalized: 'GJ01AB12', distance: 1.4, matchStrength: 0.53, ocrConfidence: 0.4 }),
    ]);
    expect(resolveIdentity(result, { minConfidence: 0 }).plates).toHaveLength(2);
    const filtered = resolveIdentity(result, { minConfidence: 0.5 });
    expect(filtered.plates).toHaveLength(1);
    expect(filtered.plates[0]?.plateNormalized).toBe('GJ01AB1234');
    expect(filtered.fuzzyPlates).toBe(0);
  });

  it('carries first/last seen across every accepted plate, not just the best one', () => {
    const identity = resolveIdentity(
      searchResult([
        candidate({
          plateNormalized: 'A',
          firstSeen: '2026-05-03T00:00:00.000Z',
          lastSeen: '2026-05-09T00:00:00.000Z',
        }),
        candidate({
          plateNormalized: 'B',
          distance: 0.7,
          firstSeen: '2026-05-01T00:00:00.000Z',
          lastSeen: '2026-05-04T00:00:00.000Z',
        }),
      ]),
    );
    expect(identity.firstSeen).toBe('2026-05-01T00:00:00.000Z');
    expect(identity.lastSeen).toBe('2026-05-09T00:00:00.000Z');
  });

  it('an unsearchable query resolves to an empty identity, not an error', () => {
    const identity = resolveIdentity(searchResult([], false));
    expect(identity.searched).toBe(false);
    expect(identity.plates).toEqual([]);
    expect(identity.firstSeen).toBeNull();
  });
});

describe('loadStoredLinks — the seam D3-03 writes through', () => {
  it('returns an empty map for a plate with no materialised identity', async () => {
    if (!reachable) return;
    const links = await loadStoredLinks(db, `${TAG}NOTHING`);
    expect(links.size).toBe(0);
  });

  it('surfaces a recorded link verbatim, including a method the plate metric never produces', async () => {
    if (!reachable) return;
    const plate = `${TAG}X`;
    const sightingId = '11111111-2222-3333-4444-555555555555';
    const ts = '2026-05-01T00:00:00.000Z';

    const rows = await db.execute<{ id: string }>(sql`
      insert into vehicle_identities (canonical_plate, first_seen, last_seen, sighting_count)
      values (${plate}, ${ts}, ${ts}, 1)
      returning id::text as id
    `);
    await db.execute(sql`
      insert into identity_sightings (identity_id, sighting_id, sighting_ts, link_method, link_confidence)
      values (${rows[0]?.id ?? ''}::uuid, ${sightingId}::uuid, ${ts}, 'reid_bridge', 0.420)
    `);

    const links = await loadStoredLinks(db, plate);
    expect(links.size).toBe(1);
    expect(links.get(sightingId)?.linkMethod).toBe('reid_bridge');
    expect(links.get(sightingId)?.linkConfidence).toBeCloseTo(0.42, 5);
  });
});
