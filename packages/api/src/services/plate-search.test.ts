/**
 * D2-04 — confusion-aware fuzzy plate matching.
 *
 * Runs against the real migrated database, like the watchlist and registry suites: the candidate
 * generation is a `pg_trgm` index and the filters are SQL, and neither is proven by a mocked query
 * builder. Skips loudly when the database is unreachable.
 *
 * Requires `make up && make migrate`. The suite seeds everything it asserts on and removes it again.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  ConfusionPlateMatcher,
  CONFUSION_CONFIG_PATH,
  PlateSearchService,
  confusionTable,
  loadConfusions,
  matchStrength,
  planSearch,
  rankingScore,
  slotsFor,
  weightedDistance,
  type ConfusionConfig,
} from './plate-search.js';
import { TrigramPlateMatcher } from '../watchlist/matcher.js';

const TAG = `PS${String(Date.now()).slice(-9)}`;
const AT = new Date('2026-06-01T12:00:00Z');
const WINDOW_START = new Date('2026-05-01T00:00:00Z');

/** Registrations seeded for this suite only. Real-shaped, and none of them names a real vehicle. */
const SEEDED = [
  'GJ01AB1234',
  'GJ18Y9407',
  'GJ27CE4416',
  'GJ35U0779',
  'GJ32D0107',
  'MH12QR8890',
  // Chosen so that between them the seeds contain every character the matrix has an opinion about
  // — AC 2 says "over the whole confusion matrix", and a generated suite that never exercises `F`
  // or `Z` is not that.
  'GJ05FS7712',
  'GJ21LZ0946',
  'GJ11IT4570',
  'GJ33OQ8820',
] as const;

let rawSql: Sql;
let db: Db;
let reachable = false;
let config: ConfusionConfig;
let matcher: ConfusionPlateMatcher;
let service: PlateSearchService;
let cameraA = '';
let cameraB = '';

const opts = (maxDistance: number, limit = 50): { maxDistance: number; limit: number; at: Date } => ({
  maxDistance,
  limit,
  at: AT,
});

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[plate-search] database unreachable — skipping. Run `make up && make migrate`.');
    return;
  }

  config = loadConfusions();
  matcher = new ConfusionPlateMatcher(db);
  service = new PlateSearchService(db);

  for (const [i, plate] of SEEDED.entries()) {
    await db.execute(sql`
      insert into watchlist_entries
        (source_system, source_ref, category, entity_type, plate_normalized, severity, valid_from, active, meta)
      values ('manual', ${`${TAG}-${String(i)}`}, 'stolen_vehicle', 'vehicle', ${plate}, 'high',
              '2026-01-01T00:00:00Z', true, '{}'::jsonb)
      on conflict (source_system, source_ref) where source_ref is not null do nothing
    `);
  }

  // Two cameras and a handful of reads, so the time-window and camera filters have something to
  // narrow. The reads deliberately include the two truncated strings cam07 actually produced.
  const cams = await db.execute<{ id: string }>(sql`
    insert into cameras (external_id, name, adapter_kind, endpoints)
    values (${`${TAG}-CAM-A`}, 'D2-04 test camera A', 'hls', '{}'::jsonb),
           (${`${TAG}-CAM-B`}, 'D2-04 test camera B', 'hls', '{}'::jsonb)
    returning id::text as id
  `);
  cameraA = cams[0]?.id ?? '';
  cameraB = cams[1]?.id ?? '';

  const reads: [string, string, string, string][] = [
    // camera, ts, raw read, normalised
    [cameraA, '2026-05-10T09:00:00Z', 'GJ 01 AB 1234', 'GJ01AB1234'],
    [cameraA, '2026-05-10T09:05:00Z', 'GJ35U07', 'GJ35U07'],
    [cameraB, '2026-05-20T18:30:00Z', 'GJ32DD10', 'GJ32DD10'],
    [cameraB, '2026-05-20T18:35:00Z', 'GJ0IAB1234', 'GJ0IAB1234'],
    [cameraA, '2026-04-01T06:00:00Z', 'GJ01AB1234', 'GJ01AB1234'],
    [cameraB, '2026-05-21T02:00:00Z', '757508300', '757508300'],
  ];
  for (const [camera, ts, raw, norm] of reads) {
    const rows = await db.execute<{ id: string }>(sql`
      insert into sightings (camera_id, ts, frame_pts_ms, track_id, class, bbox, det_confidence)
      values (${camera}::uuid, ${ts}, 1000, 100001, 'car', '{"x":0,"y":0,"w":10,"h":10}'::jsonb, 0.900)
      returning id::text as id
    `);
    await db.execute(sql`
      insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri)
      values (${rows[0]?.id ?? ''}::uuid, ${ts}, ${raw}, ${norm}, 0.610, 3, ${`s3://evidence/${TAG}`})
    `);
  }
}, 60_000);

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
    await db.execute(
      sql`delete from plate_reads where crop_uri = ${`s3://evidence/${TAG}`} or raw_text like ${`${TAG}%`}`,
    );
    await db.execute(
      sql`delete from sightings where camera_id in (select id from cameras where external_id like ${`${TAG}%`})`,
    );
    await db.execute(sql`delete from cameras where external_id like ${`${TAG}%`}`);
  }
  await rawSql?.end();
});

/* ── AC 8 · the matrix is config ─────────────────────────────────────────────────────────────── */

describe('AC 8 — the confusion matrix is config, not code', () => {
  it('loads from config/plate-confusions.json and every pair carries its provenance', () => {
    expect(CONFUSION_CONFIG_PATH.endsWith('config/plate-confusions.json')).toBe(true);
    expect(config.pairs.length).toBeGreaterThan(15);
    for (const pair of config.pairs) expect(pair.source).not.toBe('');
    // The four confusions D2-01/D2-05 measured on this estate must be present and priced cheapest.
    for (const [a, b] of [
      ['C', 'F'],
      ['D', 'B'],
      ['E', 'F'],
      ['0', 'D'],
    ]) {
      const pair = config.pairs.find(
        (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
      );
      expect(pair, `${a}↔${b} must be in the matrix`).toBeDefined();
      expect(pair?.source).toBe('measured');
      expect(pair?.cost).toBe(config.costs.measured);
    }
  });

  it('a cost edited on disk changes the distance with no code change', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plate-confusions-'));
    const file = path.join(dir, 'plate-confusions.json');
    const before = weightedDistance('GJ01AB1Z34', 'GJ01AB1234', config).distance;

    const edited = structuredClone(config) as ConfusionConfig;
    const zPair = edited.pairs.find((p) => (p.a === '2' && p.b === 'Z') || (p.a === 'Z' && p.b === '2'));
    if (zPair !== undefined) zPair.cost = 0.05;
    writeFileSync(file, JSON.stringify(edited));

    const after = weightedDistance('GJ01AB1Z34', 'GJ01AB1234', loadConfusions(file)).distance;
    expect(after).toBeLessThan(before);
  });
});

/* ── The metric ──────────────────────────────────────────────────────────────────────────────── */

describe('the weighted metric', () => {
  it('slots come from the D2-03 parse, and fall back to unparsed rather than guessing', () => {
    expect(slotsFor('GJ01AB1234')).toEqual([
      'state',
      'state',
      'rto',
      'rto',
      'series',
      'series',
      'number',
      'number',
      'number',
      'number',
    ]);
    expect(slotsFor('757508300').every((s) => s === 'unparsed')).toBe(true);
  });

  it('AC 3 — a confusable substitution costs less than an arbitrary one at the same index', () => {
    const confusable = weightedDistance('GJ01AB1Z34', 'GJ01AB1234', config).distance;
    const arbitrary = weightedDistance('GJ01AB1X34', 'GJ01AB1234', config).distance;
    expect(confusable).toBeLessThan(arbitrary);
    expect(matchStrength(confusable, 2)).toBeGreaterThan(matchStrength(arbitrary, 2));
  });

  it('charges truncation as truncation, not as a run of substitutions', () => {
    // Plain levenshtein calls both of these 2. The metric has to be able to tell them apart.
    const truncated = weightedDistance('GJ35U07', 'GJ35U0779', config);
    const unrelatedTail = weightedDistance('GJ35U0788', 'GJ35U0779', config);
    expect(truncated.tailChars).toBe(2);
    expect(truncated.distance).toBeLessThan(unrelatedTail.distance);
    expect(truncated.distance).toBeCloseTo(2 * config.costs.truncationTail, 5);
  });

  it('recovers the estate case D2-05 flagged: GJ32DD10 → GJ32D0107', () => {
    const result = weightedDistance('GJ32DD10', 'GJ32D0107', config);
    expect(result.distance).toBeLessThan(1);
    expect(result.tailChars).toBe(1);
    // One measured confusion (D↔0) plus one truncated character — not three substitutions.
    expect(result.ops.filter((o) => o.kind === 'sub')).toHaveLength(1);
    expect(result.ops.filter((o) => o.kind === 'tail')).toHaveLength(1);
  });

  it('never lets a state code be invented out of digits — the 757508300 → TS75O8300 guard', () => {
    // Two indels are cheaper than two `stateCrossClass` substitutions, so the DP takes that path —
    // either way the answer is "nowhere near any usable maxDistance", which is the point.
    const invented = weightedDistance('757508300', 'TS75O8300', config).distance;
    expect(invented).toBeGreaterThan(4);
    // A state code that is merely *misread* stays affordable: the query has its own anchor letter.
    expect(weightedDistance('6J18Y9407', 'GJ18Y9407', config).distance).toBeLessThanOrEqual(1);
  });

  it('is symmetric, and zero only for identical normalised strings', () => {
    expect(weightedDistance('GJ01AB1234', 'GJ01AB1234', config).distance).toBe(0);
    expect(weightedDistance('gj-01 ab 1234', 'GJ01AB1234', config).distance).toBe(0);
    const forward = weightedDistance('GJ35U07', 'GJ35U0779', config).distance;
    const back = weightedDistance('GJ35U0779', 'GJ35U07', config).distance;
    expect(forward).toBeCloseTo(back, 5);
  });

  it('the ranking score is a plain product of match strength and OCR confidence', () => {
    expect(rankingScore(0.8, 0.5)).toBe(0.4);
    expect(rankingScore(1, 1)).toBe(1);
  });
});

/* ── AC 2 / AC 4 · the generated confusion suites ────────────────────────────────────────────── */

describe('AC 2 — every single confusable substitution is found at distance 1', () => {
  it('over the whole matrix, at every index of every seeded plate', async () => {
    if (!reachable) return;
    const table = confusionTable(config);
    const cases: { query: string; truth: string }[] = [];
    for (const plate of SEEDED) {
      for (let i = 0; i < plate.length; i += 1) {
        for (const key of table.keys()) {
          if (key.charAt(0) !== plate.charAt(i)) continue;
          const query = plate.slice(0, i) + key.charAt(1) + plate.slice(i + 1);
          if (query !== plate) cases.push({ query, truth: plate });
        }
      }
    }
    expect(cases.length).toBeGreaterThan(100);
    // Every character the matrix has an opinion about is actually exercised.
    const exercised = new Set(cases.flatMap((c) => [...c.query]));
    const matrixChars = new Set([...table.keys()].flatMap((k) => [k.charAt(0), k.charAt(1)]));
    expect([...matrixChars].filter((ch) => !exercised.has(ch))).toEqual([]);

    const missed: string[] = [];
    for (const c of cases) {
      const hits = await matcher.match(c.query, opts(1));
      if (!hits.some((h) => h.plateNormalized === c.truth)) missed.push(`${c.query} → ${c.truth}`);
    }
    expect(missed, `${String(missed.length)}/${String(cases.length)} missed`).toEqual([]);
  }, 120_000);
});

describe('AC 4 — two-character confusions are found within maxDistance = 2', () => {
  it('and rank below the same plate with a single confusion', async () => {
    if (!reachable) return;
    const table = confusionTable(config);
    const cases: { query: string; truth: string }[] = [];
    for (const plate of SEEDED) {
      for (let i = 2; i < plate.length - 1; i += 1) {
        const first = [...table.keys()].find((k) => k.charAt(0) === plate.charAt(i));
        const second = [...table.keys()].find((k) => k.charAt(0) === plate.charAt(i + 1));
        if (first === undefined || second === undefined) continue;
        const query =
          plate.slice(0, i) + first.charAt(1) + second.charAt(1) + plate.slice(i + 2);
        if (query !== plate) cases.push({ query, truth: plate });
      }
    }
    expect(cases.length).toBeGreaterThan(10);

    const missed: string[] = [];
    for (const c of cases) {
      const hits = await matcher.match(c.query, opts(2));
      if (!hits.some((h) => h.plateNormalized === c.truth)) missed.push(`${c.query} → ${c.truth}`);
    }
    expect(missed, `${String(missed.length)}/${String(cases.length)} missed`).toEqual([]);

    const one = await matcher.match('GJ0IAB1234', opts(2));
    const two = await matcher.match('GJ0IAB1Z34', opts(2));
    const oneD = one.find((h) => h.plateNormalized === 'GJ01AB1234')?.distance ?? 99;
    const twoD = two.find((h) => h.plateNormalized === 'GJ01AB1234')?.distance ?? 99;
    expect(twoD).toBeGreaterThan(oneD);
  }, 120_000);
});

/* ── AC 1 · exact first ──────────────────────────────────────────────────────────────────────── */

describe('AC 1 — an exact match always ranks first', () => {
  it('generates the exact row outside the anchor, and sorts it to the top', async () => {
    if (!reachable) return;
    const hits = await matcher.match('GJ01AB1234', opts(2));
    expect(hits[0]?.plateNormalized).toBe('GJ01AB1234');
    expect(hits[0]?.distance).toBe(0);
    expect(hits[0]?.confidence).toBe(1);
    expect(hits[0]?.explanation).toContain('exact match');
  });

  it('and stays first even when a confusable neighbour is also on the list', async () => {
    if (!reachable) return;
    await db.execute(sql`
      insert into watchlist_entries
        (source_system, source_ref, category, entity_type, plate_normalized, severity, valid_from, active, meta)
      values ('manual', ${`${TAG}-NEIGHBOUR`}, 'stolen_vehicle', 'vehicle', 'GJ01AB1Z34', 'high',
              '2026-01-01T00:00:00Z', true, '{}'::jsonb)
      on conflict (source_system, source_ref) where source_ref is not null do nothing
    `);
    try {
      const hits = await matcher.match('GJ01AB1234', opts(2));
      expect(hits[0]?.plateNormalized).toBe('GJ01AB1234');
      expect(hits.map((h) => h.plateNormalized)).toContain('GJ01AB1Z34');
    } finally {
      // Removed here rather than in `afterAll`: it is a deliberate near-miss, and leaving it in the
      // table would make the precision measurement below score its own fixture as a false positive.
      await db.execute(sql`delete from watchlist_entries where source_ref = ${`${TAG}-NEIGHBOUR`}`);
    }
  });
});

/* ── AC 5 · precision ────────────────────────────────────────────────────────────────────────── */

describe('AC 5 — truly unrelated plates are not returned', () => {
  it('refuses to search a read the grammar says cannot be a registration', async () => {
    if (!reachable) return;
    for (const q of ['757508300', '755508000', '44671', '41111', 'CIRCLE', 'P4']) {
      const plan = planSearch(q, config);
      expect(plan.searchable, `${q} must not be searched`).toBe(false);
      expect(await matcher.match(q, opts(2))).toEqual([]);
    }
  });

  it('returns nothing for registrations from a different state and a different series', async () => {
    if (!reachable) return;
    for (const q of ['KA05MZ9911', 'TN22CX4477', 'DL8CAF5030', 'AP09BQ7781', 'UP32DN4410']) {
      const hits = await matcher.match(q, opts(2));
      expect(hits.map((h) => h.plateNormalized), `${q} matched something`).toEqual([]);
    }
  });

  it('precision over a generated perturbation set is 100% at the documented operating point', async () => {
    if (!reachable) return;
    const table = confusionTable(config);
    let returned = 0;
    let correct = 0;
    for (const plate of SEEDED) {
      for (let i = 0; i < plate.length; i += 1) {
        const key = [...table.keys()].find((k) => k.charAt(0) === plate.charAt(i));
        if (key === undefined) continue;
        const query = plate.slice(0, i) + key.charAt(1) + plate.slice(i + 1);
        const hits = await matcher.match(query, opts(2));
        returned += hits.length;
        correct += hits.filter((h) => h.plateNormalized === plate).length;
      }
    }
    expect(returned).toBeGreaterThan(0);
    expect(correct / returned).toBe(1);
  }, 60_000);
});

/* ── The metric versus the one it replaces ───────────────────────────────────────────────────── */

describe('what the confusion metric adds over plain levenshtein', () => {
  it('recovers a 3-character truncation that plain levenshtein cannot at maxDistance = 2', async () => {
    if (!reachable) return;
    const plain = new TrigramPlateMatcher(db);
    const query = 'GJ27CE4'; // GJ27CE4416 minus three characters
    expect((await plain.match(query, opts(2))).map((h) => h.plateNormalized)).not.toContain(
      'GJ27CE4416',
    );
    expect((await matcher.match(query, opts(2))).map((h) => h.plateNormalized)).toContain(
      'GJ27CE4416',
    );
  });

  it('delivers at maxDistance = 1 what plain levenshtein needs maxDistance = 2 for', async () => {
    if (!reachable) return;
    const plain = new TrigramPlateMatcher(db);
    const query = 'GJ32DD10';
    expect((await plain.match(query, opts(1))).map((h) => h.plateNormalized)).not.toContain(
      'GJ32D0107',
    );
    expect((await matcher.match(query, opts(1))).map((h) => h.plateNormalized)).toContain(
      'GJ32D0107',
    );
  });
});

/* ── AC 6 · the search API over sightings ────────────────────────────────────────────────────── */

describe('AC 6 — time-window and camera filters compose with fuzzy search', () => {
  it('finds the truncated read GJ35U07 when the jury types the full registration', async () => {
    if (!reachable) return;
    const result = await service.search('GJ35U0779', { maxDistance: 2, limit: 10 });
    expect(result.searched).toBe(true);
    const hit = result.candidates.find((c) => c.plateNormalized === 'GJ35U07');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('fuzzy');
    expect(hit?.distance).toBeLessThan(1);
    expect(hit?.sightings.length).toBeGreaterThan(0);
    expect(hit?.sightings[0]?.cameraExternalId).toBe(`${TAG}-CAM-A`);
    expect(hit?.score).toBeCloseTo(
      Math.round((hit?.matchStrength ?? 0) * (hit?.ocrConfidence ?? 0) * 1000) / 1000,
      5,
    );
  });

  it('an exact match ranks first over the sightings table too', async () => {
    if (!reachable) return;
    const result = await service.search('GJ01AB1234', { maxDistance: 2, limit: 10 });
    expect(result.candidates[0]?.plateNormalized).toBe('GJ01AB1234');
    expect(result.candidates[0]?.matchType).toBe('exact');
    expect(result.candidates[0]?.distance).toBe(0);
  });

  it('the time window narrows the sighting count without changing the candidate', async () => {
    if (!reachable) return;
    const all = await service.search('GJ01AB1234', { maxDistance: 0, limit: 10 });
    const windowed = await service.search('GJ01AB1234', {
      maxDistance: 0,
      limit: 10,
      from: WINDOW_START,
    });
    expect(all.candidates[0]?.sightingCount).toBe(2);
    expect(windowed.candidates[0]?.sightingCount).toBe(1);
    expect(windowed.candidates[0]?.sightings[0]?.sightingTs).toBe('2026-05-10T09:00:00.000Z');
  });

  it('a camera filter excludes the other camera entirely', async () => {
    if (!reachable) return;
    const onA = await service.search('GJ32D0107', {
      maxDistance: 2,
      limit: 10,
      cameraIds: [cameraA],
    });
    expect(onA.candidates).toEqual([]);
    const onB = await service.search('GJ32D0107', {
      maxDistance: 2,
      limit: 10,
      cameraIds: [cameraB],
    });
    expect(onB.candidates.map((c) => c.plateNormalized)).toContain('GJ32DD10');
    expect(onB.candidates[0]?.cameraCount).toBe(1);
  });

  it('reports searched: false with the grammar reason rather than fuzzing a phone number', async () => {
    if (!reachable) return;
    const result = await service.search('757508300', { maxDistance: 2, limit: 10 });
    expect(result.searched).toBe(false);
    expect(result.reason).toBe('no_letters');
    expect(result.candidates).toEqual([]);
  });

  it('carries the D2-03 verdict on the query so the UI can say what it did', async () => {
    if (!reachable) return;
    const result = await service.search('GJ35U07', { maxDistance: 2, limit: 10 });
    expect(result.validity).toBe('partial');
    expect(result.reason).toBe('truncated');
    expect(result.missingChars).toBe(2);
    expect(result.matcher).toBe('confusion-weighted');
  });
});
