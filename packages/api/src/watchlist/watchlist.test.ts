/**
 * Watchlist provider, registry, matcher and validity-window tests.
 *
 * They run against the real migrated database, like the registry suite: the validity boundary is a
 * SQL comparison and the fuzzy candidate generation is a `pg_trgm` index, and neither is proven by
 * a mocked query builder. Skips loudly when the database is unreachable.
 *
 * Requires `make up && make migrate`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db, type Sql } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  biometricKeysIn,
  createWatchlistRegistry,
  MockProvider,
  normaliseForLookup,
  parseWatchlistCsv,
  SEED_CSV_PATH,
  TrigramPlateMatcher,
  upsertWatchlistEntries,
  WatchlistRegistry,
  type LookupOptions,
  type ProviderHealth,
  type SyncResult,
  type WatchlistHit,
  type WatchlistProvider,
} from './index.js';

/** Marks every row this suite creates so teardown removes exactly them. */
const TAG = `T${String(Date.now()).slice(-9)}`;

let rawSql: Sql;
let db: Db;
let reachable = false;

const at = (iso: string): LookupOptions => ({ at: new Date(iso) });

beforeAll(async () => {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  rawSql = createSql(env.DATABASE_URL, 4);
  db = createDb(rawSql);
  try {
    await rawSql`select 1`;
    reachable = true;
  } catch {
    console.warn('[watchlist] database unreachable — skipping. Run `make up && make migrate`.');
  }
});

afterAll(async () => {
  if (reachable) {
    await db.execute(sql`delete from watchlist_entries where source_ref like ${`${TAG}%`}`);
  }
  await rawSql?.end();
});

// ── The interface and its implementations ───────────────────────────────────────────────────────

describe('MockProvider implements WatchlistProvider', () => {
  it('exposes every method the interface declares', () => {
    if (!reachable) return;
    const provider: WatchlistProvider = new MockProvider({ db, system: 'VAHAN' });
    expect(provider.system).toBe('VAHAN');
    expect(typeof provider.lookupVehicle).toBe('function');
    expect(typeof provider.lookupPerson).toBe('function');
    expect(typeof provider.sync).toBe('function');
    expect(typeof provider.health).toBe('function');
  });

  it('reports itself as a mock, never live', async () => {
    if (!reachable) return;
    const health = await new MockProvider({ db, system: 'eGujCop' }).health();
    expect(health.live).toBe(false);
    expect(health.mode).toBe('mock');
    expect(health.reachable).toBe(true);
    expect(health.note).toContain('no live eGujCop connectivity');
  });

  it('every registered provider reports live: false — no exceptions', async () => {
    if (!reachable) return;
    const health = await createWatchlistRegistry({ db }).health();
    expect(health).toHaveLength(6);
    expect(health.every((h) => h.live === false)).toBe(true);
    expect(health.map((h) => h.system).sort()).toEqual(
      ['AFIS', 'NAFIS', 'SARTHI', 'VAHAN', 'eGujCop', 'manual'].sort(),
    );
  });
});

/**
 * AC 2: a second provider registers with **zero core changes**.
 *
 * The proof is structural, not rhetorical: `NullProvider` is defined entirely inside this test file
 * and imports nothing but the exported interface. If the registry, the routes or the mock provider
 * had to know about it, this code could not compile — and the test could not be written without
 * touching `src/`.
 */
class NullProvider implements WatchlistProvider {
  readonly system = 'NAFIS' as const;
  calls = 0;

  lookupVehicle(): Promise<WatchlistHit[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
  lookupPerson(): Promise<WatchlistHit[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
  sync(): Promise<SyncResult> {
    return Promise.resolve({
      system: this.system,
      fetched: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      since: null,
      at: new Date().toISOString(),
    });
  }
  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      system: this.system,
      live: false,
      mode: 'mock',
      reachable: true,
      entries: 0,
      inactiveEntries: 0,
      lastSyncAt: null,
      note: 'null provider — answers nothing, on purpose',
    });
  }
}

describe('a second provider registers with zero core changes', () => {
  it('accepts a provider defined entirely outside the watchlist module', async () => {
    if (!reachable) return;
    const nullProvider = new NullProvider();
    const registry = new WatchlistRegistry().register(nullProvider);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get('NAFIS')).toBe(nullProvider);
    await expect(registry.lookupVehicle('GJ01AB1234')).resolves.toEqual([]);
    await expect(registry.lookupPerson('CASE/WA/2025/0001')).resolves.toEqual([]);
    expect(nullProvider.calls).toBe(2);

    const health = await registry.health();
    expect(health[0]?.note).toContain('null provider');
  });

  it('replaces one system without disturbing the other five', () => {
    if (!reachable) return;
    const registry = createWatchlistRegistry({ db });
    const nullProvider = new NullProvider();
    registry.register(nullProvider);

    expect(registry.list()).toHaveLength(6);
    expect(registry.get('NAFIS')).toBe(nullProvider);
    expect(registry.get('VAHAN')).toBeInstanceOf(MockProvider);
  });
});

// ── The validity window ─────────────────────────────────────────────────────────────────────────

describe('validity window', () => {
  const PLATE = 'GJ99ZZ0001';
  const FROM = '2026-03-01T00:00:00.000Z';
  const TO = '2026-04-01T00:00:00.000Z';

  beforeAll(async () => {
    if (!reachable) return;
    await upsertWatchlistEntries(db, [
      {
        category: 'stolen_vehicle',
        entityType: 'vehicle',
        plateNormalized: PLATE,
        personRef: null,
        sourceSystem: 'manual',
        sourceRef: `${TAG}-window`,
        severity: 'high',
        validFrom: FROM,
        validTo: TO,
        active: true,
        meta: { note: 'validity boundary fixture' },
      },
    ]);
  });

  const lookup = (iso: string) =>
    new MockProvider({ db, system: 'manual' }).lookupVehicle(PLATE, { ...at(iso), maxDistance: 0 });

  it('does not match one millisecond before valid_from', async () => {
    if (!reachable) return;
    expect(await lookup('2026-02-28T23:59:59.999Z')).toHaveLength(0);
  });

  it('matches exactly at valid_from — the lower bound is inclusive', async () => {
    if (!reachable) return;
    expect(await lookup(FROM)).toHaveLength(1);
  });

  it('matches one millisecond before valid_to', async () => {
    if (!reachable) return;
    expect(await lookup('2026-03-31T23:59:59.999Z')).toHaveLength(1);
  });

  /**
   * The boundary that matters. `valid_to` is **exclusive**: an entry whose window closes at T does
   * not match at T. An off-by-one here alerts on an expired record, which is the failure the AC
   * names.
   */
  it('does not match exactly at valid_to — the upper bound is exclusive', async () => {
    if (!reachable) return;
    expect(await lookup(TO)).toHaveLength(0);
  });

  it('does not match one millisecond after valid_to', async () => {
    if (!reachable) return;
    expect(await lookup('2026-04-01T00:00:00.001Z')).toHaveLength(0);
  });

  it('never matches a deactivated entry, whatever the window says', async () => {
    if (!reachable) return;
    await db.execute(
      sql`update watchlist_entries set active = false where source_ref = ${`${TAG}-window`}`,
    );
    expect(await lookup('2026-03-15T00:00:00.000Z')).toHaveLength(0);
    await db.execute(
      sql`update watchlist_entries set active = true where source_ref = ${`${TAG}-window`}`,
    );
  });
});

// ── Normalisation and fuzzy matching ────────────────────────────────────────────────────────────

describe('normaliseForLookup', () => {
  it('is total and idempotent', () => {
    for (const input of [' ind gj-01 ab 1234 ', '', '!!!', 'gj35u0779', 'GJ 35 U 0779']) {
      const once = normaliseForLookup(input);
      expect(normaliseForLookup(once)).toBe(once);
      expect(once).toMatch(/^[A-Z0-9]*$/);
    }
  });

  it('strips separators and uppercases', () => {
    expect(normaliseForLookup(' gj-01 ab 1234 ')).toBe('GJ01AB1234');
  });
});

describe('vehicle lookup with the fuzzy matcher', () => {
  const EXACT = 'GJ01AB1234';

  beforeAll(async () => {
    if (!reachable) return;
    await upsertWatchlistEntries(db, [
      {
        category: 'stolen_vehicle',
        entityType: 'vehicle',
        plateNormalized: EXACT,
        personRef: null,
        sourceSystem: 'manual',
        sourceRef: `${TAG}-fuzzy`,
        severity: 'critical',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        active: true,
        meta: {},
      },
    ]);
  });

  const provider = () => new MockProvider({ db, system: 'manual' });

  it('returns an exact hit at distance 0 with confidence 1', async () => {
    if (!reachable) return;
    const hits = await provider().lookupVehicle(EXACT);
    const hit = hits.find((h) => h.plateNormalized === EXACT);
    expect(hit?.matchType).toBe('exact');
    expect(hit?.matchDistance).toBe(0);
    expect(hit?.matchConfidence).toBe(1);
  });

  it('accepts an unnormalised plate and matches it exactly', async () => {
    if (!reachable) return;
    const hits = await provider().lookupVehicle(' gj-01 ab 1234 ');
    expect(hits.some((h) => h.plateNormalized === EXACT && h.matchType === 'exact')).toBe(true);
  });

  it('recovers a single-character substitution as a fuzzy hit', async () => {
    if (!reachable) return;
    // 0/O is the confusion D2-01 measured most often. D2-04 will cost it less than an arbitrary
    // substitution; the default metric here already finds it at distance 1.
    const hits = await provider().lookupVehicle('GJO1AB1234');
    const hit = hits.find((h) => h.plateNormalized === EXACT);
    expect(hit?.matchType).toBe('fuzzy');
    expect(hit?.matchDistance).toBe(1);
    expect(hit?.matchConfidence).toBeLessThan(1);
  });

  it('ranks the exact hit above every fuzzy one', async () => {
    if (!reachable) return;
    const hits = await provider().lookupVehicle(EXACT, { maxDistance: 2 });
    expect(hits[0]?.matchType).toBe('exact');
    expect(hits.every((h, i) => i === 0 || h.matchDistance >= (hits[0]?.matchDistance ?? 0))).toBe(
      true,
    );
  });

  it('does not return an unrelated plate', async () => {
    if (!reachable) return;
    const hits = await provider().lookupVehicle('MH12ZZ9999', { maxDistance: 2 });
    expect(hits.some((h) => h.plateNormalized === EXACT)).toBe(false);
  });

  it('maxDistance 0 disables fuzzy matching entirely', async () => {
    if (!reachable) return;
    expect(await provider().lookupVehicle('GJO1AB1234', { maxDistance: 0 })).toHaveLength(0);
  });

  /**
   * The estate's real failure mode, end to end.
   *
   * D2-01 read `GJ35U0779` as `GJ35U07` on `cam07` — **truncation**, not substitution. A trigram
   * threshold tuned for substitutions can drop a candidate this short, which is why the matcher
   * also generates prefix candidates. This is the one seeded ground-truth plate today's default
   * metric recovers from what the pipeline actually emitted.
   */
  it('recovers the truncated read GJ35U07 → GJ35U0779 that cam07 actually produced', async () => {
    if (!reachable) return;
    const hits = await new MockProvider({ db, system: 'eGujCop' }).lookupVehicle('GJ35U07', {
      maxDistance: 2,
    });
    const hit = hits.find((h) => h.plateNormalized === 'GJ35U0779');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('fuzzy');
    expect(hit?.matchDistance).toBe(2);
  });
});

describe('TrigramPlateMatcher', () => {
  it('is swappable: the provider uses whatever matcher it is given', async () => {
    if (!reachable) return;
    let called = '';
    const provider = new MockProvider({
      db,
      system: 'manual',
      matcher: {
        id: 'stub',
        match: (plate) => {
          called = plate;
          return Promise.resolve([]);
        },
      },
    });
    await provider.lookupVehicle('GJ01AB1234', { maxDistance: 2 });
    expect(called).toBe('GJ01AB1234');
  });

  it('narrows candidates through pg_trgm and decides with levenshtein', async () => {
    if (!reachable) return;
    const matches = await new TrigramPlateMatcher(db).match('GJ01AB1234', {
      maxDistance: 2,
      limit: 10,
      system: 'manual',
      at: new Date(),
    });
    expect(matches.every((m) => m.distance <= 2)).toBe(true);
    expect(matches.map((m) => m.distance)).toEqual([...matches.map((m) => m.distance)].sort());
  });
});

// ── Person lookup ───────────────────────────────────────────────────────────────────────────────

describe('person lookup', () => {
  it('matches a case reference exactly and carries no biometric field', async () => {
    if (!reachable) return;
    const hits = await new MockProvider({ db, system: 'eGujCop' }).lookupPerson(
      'CASE/WA/2026/0001',
    );
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    expect(hit?.entityType).toBe('person');
    expect(hit?.plateNormalized).toBeNull();
    expect(biometricKeysIn(hit?.meta ?? {})).toEqual([]);
    expect(hit?.live).toBe(false);
  });

  it('does not fuzzy-match a case reference', async () => {
    if (!reachable) return;
    const hits = await new MockProvider({ db, system: 'eGujCop' }).lookupPerson(
      'CASE/WA/2026/0002X',
    );
    expect(hits).toHaveLength(0);
  });
});

// ── AFIS / NAFIS are reference-only ─────────────────────────────────────────────────────────────

describe('no biometric data, anywhere', () => {
  it('detects a denylisted key however it is spelled', () => {
    expect(biometricKeysIn({ face_embedding: [1, 2] })).toEqual(['face_embedding']);
    expect(biometricKeysIn({ faceEmbedding: [1] })).toEqual(['faceEmbedding']);
    expect(biometricKeysIn({ 'FACE-EMBEDDING': [1] })).toEqual(['FACE-EMBEDDING']);
    expect(biometricKeysIn({ nested: { subject: { fingerprint: 'x' } } })).toEqual([
      'nested.subject.fingerprint',
    ]);
    expect(biometricKeysIn({ subject_ref: 'AFIS-SUBJECT-00001' })).toEqual([]);
  });

  it('rejects a CSV row carrying a biometric column', () => {
    const csv = [
      'source_system,source_ref,category,entity_type,person_ref,face_embedding',
      'AFIS,X-1,missing_person,person,CASE/MI/2025/0001,"[0.1,0.2]"',
    ].join('\n');
    const batch = parseWatchlistCsv(csv);
    expect(batch.valid).toHaveLength(0);
    expect(batch.rejected[0]?.message).toContain('biometric');
  });

  it('the shipped seed dataset contains no biometric field at all', async () => {
    if (!reachable) return;
    const batch = parseWatchlistCsv(
      await import('node:fs/promises').then((fs) => fs.readFile(SEED_CSV_PATH, 'utf8')),
    );
    expect(batch.rejected).toEqual([]);
    for (const entry of batch.valid) expect(biometricKeysIn(entry.meta)).toEqual([]);
  });

  it('every AFIS and NAFIS seeded entry holds a subject reference and nothing more', async () => {
    if (!reachable) return;
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from watchlist_entries
           where source_system in ('AFIS','NAFIS')
             and meta ?| array['face_embedding','fingerprint','iris','photo','biometric','dna']`,
    );
    expect(Number(rows[0]?.n ?? '1')).toBe(0);
  });
});

// ── The seed dataset ────────────────────────────────────────────────────────────────────────────

describe('the representative seed dataset', () => {
  it('carries at least 200 entries across all five categories', async () => {
    if (!reachable) return;
    const batch = parseWatchlistCsv(
      await import('node:fs/promises').then((fs) => fs.readFile(SEED_CSV_PATH, 'utf8')),
    );
    expect(batch.rejected).toEqual([]);
    expect(batch.valid.length).toBeGreaterThanOrEqual(200);

    const categories = new Set(batch.valid.map((e) => e.category));
    expect([...categories].sort()).toEqual([
      'blacklisted_vehicle',
      'missing_person',
      'stolen_vehicle',
      'suspect',
      'wanted_person',
    ]);
  });

  /**
   * The estate rows, and their provenance.
   *
   * `estate-groundtruth` plates are registrations a **human** read off the sandbox feeds.
   * `estate-ocr-output` strings were selected from **measured ANPR output**, not from a vehicle
   * registry — several are fragments. Both are labelled in the row itself, so nothing in the demo
   * can present one as the other.
   */
  it('labels every estate-derived row with its provenance', async () => {
    if (!reachable) return;
    const batch = parseWatchlistCsv(
      await import('node:fs/promises').then((fs) => fs.readFile(SEED_CSV_PATH, 'utf8')),
    );
    const groundTruth = batch.valid.filter((e) => e.meta['provenance'] === 'estate-groundtruth');
    const ocr = batch.valid.filter((e) => e.meta['provenance'] === 'estate-ocr-output');

    expect(groundTruth.map((e) => e.plateNormalized).sort()).toEqual([
      'GJ12EC7928',
      'GJ32D0107',
      'GJ35U0779',
      'RJ39CA5180',
    ]);
    expect(ocr.length).toBeGreaterThanOrEqual(5);
    for (const entry of ocr) {
      expect(String(entry.meta['note'])).toContain(
        'MEASURED ANPR OUTPUT, NOT FROM A VEHICLE REGISTRY',
      );
    }
  });

  it('the seeded expired fixture never matches now', async () => {
    if (!reachable) return;
    const hits = await new MockProvider({ db, system: 'manual' }).lookupVehicle('GJ01XX0001', {
      maxDistance: 0,
    });
    expect(hits).toHaveLength(0);
    const control = await new MockProvider({ db, system: 'manual' }).lookupVehicle('GJ01XX0002', {
      maxDistance: 0,
    });
    expect(control).toHaveLength(1);
  });
});

describe('sync', () => {
  it('pulls only its own system and reports what it skipped', async () => {
    if (!reachable) return;
    const result = await new MockProvider({ db, system: 'SARTHI', seedPath: SEED_CSV_PATH }).sync();
    expect(result.system).toBe('SARTHI');
    expect(result.fetched).toBeGreaterThanOrEqual(200);
    expect(result.inserted + result.updated).toBe(12);
    expect(result.skipped).toBe(result.fetched - 12);
  });

  it('is idempotent — a second sync updates, never duplicates', async () => {
    if (!reachable) return;
    const provider = new MockProvider({ db, system: 'SARTHI', seedPath: SEED_CSV_PATH });
    await provider.sync();
    const second = await provider.sync();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(12);
  });
});
