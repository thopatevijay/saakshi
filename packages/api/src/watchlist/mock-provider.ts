import { and, eq, gt, isNull, lte, or, sql, count } from 'drizzle-orm';
import { watchlistEntries } from '@saakshi/shared/db';
import type { Db } from '../db/client.js';
import type { PlateMatcher } from './matcher.js';
import { TrigramPlateMatcher } from './matcher.js';
import {
  normaliseForLookup,
  type LookupOptions,
  type ProviderHealth,
  type SyncResult,
  type WatchlistHit,
  type WatchlistProvider,
  type WatchlistSystem,
} from './provider.js';
import { loadSeedCsv, upsertWatchlistEntries } from './seed.js';

/**
 * The provider that actually ships: `watchlist_entries` standing in for a connector.
 *
 * **It is a mock and it says so on every response.** `health().live` is the literal `false`, and
 * every hit carries `live: false` alongside the system it is modelled on, so a screenshot of the
 * running system cannot be mistaken for evidence of a VAHAN or eGujCop integration. The connector
 * specification — what each system would have to expose, and what Gujarat Police would have to
 * provide — is `docs/watchlist-integration.md`.
 *
 * One instance per system. They share the table and partition it on `source_system`, which is what
 * makes "swap the eGujCop connector for a real one" a one-line change at the registry rather than a
 * rewrite: the other five keep answering from the mock while one goes live.
 */
export interface MockProviderOptions {
  db: Db;
  system: WatchlistSystem;
  /** D2-04 passes its confusion-aware matcher here. Defaults to trigram + levenshtein. */
  matcher?: PlateMatcher;
  /** The mock's "upstream": the representative CSV `sync()` pulls from. */
  seedPath?: string;
}

const DEFAULT_MAX_DISTANCE = 2;
const DEFAULT_LIMIT = 25;

/** Only entries whose window is open at `at`, and which have not been deactivated. */
function validAt(at: Date) {
  const iso = at.toISOString();
  return and(
    eq(watchlistEntries.active, true),
    lte(watchlistEntries.validFrom, iso),
    // Upper bound is **exclusive**: an entry whose window closes at T does not match at T. The
    // schema's `valid_to > valid_from` CHECK uses the same convention, so a zero-length window is
    // impossible rather than silently matching for an instant.
    or(isNull(watchlistEntries.validTo), gt(watchlistEntries.validTo, iso)),
  );
}

export class MockProvider implements WatchlistProvider {
  readonly system: WatchlistSystem;
  private readonly db: Db;
  private readonly matcher: PlateMatcher;
  private readonly seedPath: string | undefined;
  private lastSyncAt: string | null = null;

  constructor(options: MockProviderOptions) {
    this.db = options.db;
    this.system = options.system;
    this.matcher = options.matcher ?? new TrigramPlateMatcher(options.db);
    this.seedPath = options.seedPath;
  }

  async lookupVehicle(plate: string, options: LookupOptions = {}): Promise<WatchlistHit[]> {
    const at = options.at ?? new Date();
    const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const normalized = normaliseForLookup(plate);
    if (normalized === '') return [];

    // Exact first, always, and independently of the matcher: an exact hit must never be lost
    // because a fuzzy candidate generator's threshold happened to exclude it. D2-04's AC 1 says the
    // same thing about ranking; this says it about *existence*.
    const exact = await this.rowsFor(
      and(validAt(at), eq(watchlistEntries.plateNormalized, normalized)),
    );

    const hits = exact.map((row) =>
      this.toHit(row, {
        matchType: 'exact',
        distance: 0,
        confidence: 1,
        explanation: `exact match on the normalised plate ${normalized}`,
      }),
    );

    if (maxDistance > 0) {
      const candidates = await this.matcher.match(normalized, {
        maxDistance,
        limit,
        system: this.system,
        at,
      });
      for (const candidate of candidates) {
        if (candidate.plateNormalized === normalized) continue;
        const rows = await this.rowsFor(
          and(validAt(at), eq(watchlistEntries.plateNormalized, candidate.plateNormalized)),
        );
        for (const row of rows) {
          hits.push(
            this.toHit(row, {
              matchType: 'fuzzy',
              distance: candidate.distance,
              confidence: candidate.confidence,
              explanation: candidate.explanation,
            }),
          );
        }
      }
    }

    return hits
      .sort((a, b) => a.matchDistance - b.matchDistance || b.matchConfidence - a.matchConfidence)
      .slice(0, limit);
  }

  /**
   * Person lookup is **exact only, and by reference**.
   *
   * A case reference is typed by an officer, not read off a moving vehicle by an OCR model, so the
   * error mode fuzzy matching exists to survive does not apply. Widening it would only manufacture
   * near-misses against people, which is the one place in this system where a false positive costs
   * the most.
   */
  async lookupPerson(ref: string, options: LookupOptions = {}): Promise<WatchlistHit[]> {
    const at = options.at ?? new Date();
    const trimmed = ref.trim();
    if (trimmed === '') return [];

    const rows = await this.rowsFor(
      and(
        validAt(at),
        sql`upper(${watchlistEntries.personRef}) = upper(${trimmed})`,
        eq(watchlistEntries.sourceSystem, this.system),
      ),
    );

    return rows
      .map((row) =>
        this.toHit(row, {
          matchType: 'exact',
          distance: 0,
          confidence: 1,
          explanation: `exact match on the case reference ${trimmed}`,
        }),
      )
      .slice(0, options.limit ?? DEFAULT_LIMIT);
  }

  /**
   * Bulk pull into `watchlist_entries`.
   *
   * The mock's upstream is the committed representative CSV, so this exercises the same code path a
   * real connector would: fetch, filter to this provider's system, upsert on the natural key. Rows
   * belonging to another system are counted as `skipped`, not silently dropped — a sync that
   * reports 0 fetched and 0 skipped is indistinguishable from a broken one.
   *
   * `since` is honoured against `valid_from`, which is the only timestamp the mock upstream carries.
   * A real connector filters on the upstream's own change marker; the field is on the result so a
   * caller can tell a full pull from an incremental one.
   */
  async sync(since?: Date): Promise<SyncResult> {
    const at = new Date().toISOString();
    if (this.seedPath === undefined) {
      return {
        system: this.system,
        fetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        since: since?.toISOString() ?? null,
        at,
      };
    }

    const batch = await loadSeedCsv(this.seedPath);
    const mine = batch.valid.filter(
      (entry) =>
        entry.sourceSystem === this.system &&
        (since === undefined || Date.parse(entry.validFrom) >= since.getTime()),
    );
    const result = await upsertWatchlistEntries(this.db, mine);
    this.lastSyncAt = at;

    return {
      system: this.system,
      fetched: batch.valid.length,
      inserted: result.inserted,
      updated: result.updated,
      skipped: batch.valid.length - mine.length + batch.rejected.length,
      since: since?.toISOString() ?? null,
      at,
    };
  }

  async health(): Promise<ProviderHealth> {
    const now = new Date();
    let reachable = true;
    let entries = 0;
    let total = 0;

    try {
      const active = await this.db
        .select({ n: count() })
        .from(watchlistEntries)
        .where(and(eq(watchlistEntries.sourceSystem, this.system), validAt(now)));
      const all = await this.db
        .select({ n: count() })
        .from(watchlistEntries)
        .where(eq(watchlistEntries.sourceSystem, this.system));
      entries = active[0]?.n ?? 0;
      total = all[0]?.n ?? 0;
    } catch {
      reachable = false;
    }

    return {
      system: this.system,
      live: false,
      mode: 'mock',
      reachable,
      entries,
      inactiveEntries: Math.max(total - entries, 0),
      lastSyncAt: this.lastSyncAt,
      note:
        `MOCK PROVIDER — there is no live ${this.system} connectivity. Entries are served from ` +
        'the representative watchlist database this project ships (fixtures/watchlist-seed.csv). ' +
        'The connector specification is docs/watchlist-integration.md.',
    };
  }

  private async rowsFor(where: ReturnType<typeof and>): Promise<WatchlistRow[]> {
    return this.db
      .select({
        id: watchlistEntries.id,
        category: watchlistEntries.category,
        entityType: watchlistEntries.entityType,
        plateNormalized: watchlistEntries.plateNormalized,
        personRef: watchlistEntries.personRef,
        sourceSystem: watchlistEntries.sourceSystem,
        sourceRef: watchlistEntries.sourceRef,
        severity: watchlistEntries.severity,
        validFrom: watchlistEntries.validFrom,
        validTo: watchlistEntries.validTo,
        meta: watchlistEntries.meta,
      })
      .from(watchlistEntries)
      .where(and(where, eq(watchlistEntries.sourceSystem, this.system)));
  }

  private toHit(
    row: WatchlistRow,
    match: {
      matchType: 'exact' | 'fuzzy';
      distance: number;
      confidence: number;
      explanation: string;
    },
  ): WatchlistHit {
    return {
      entryId: row.id,
      category: row.category,
      entityType: row.entityType,
      plateNormalized: row.plateNormalized,
      personRef: row.personRef,
      sourceSystem: row.sourceSystem,
      sourceRef: row.sourceRef,
      providerSystem: this.system,
      live: false,
      severity: row.severity,
      matchType: match.matchType,
      matchDistance: match.distance,
      matchConfidence: match.confidence,
      matchExplanation: match.explanation,
      validFrom: new Date(row.validFrom).toISOString(),
      validTo: row.validTo === null ? null : new Date(row.validTo).toISOString(),
      meta: row.meta as Record<string, unknown>,
    };
  }
}

interface WatchlistRow {
  id: string;
  category: WatchlistHit['category'];
  entityType: WatchlistHit['entityType'];
  plateNormalized: string | null;
  personRef: string | null;
  sourceSystem: WatchlistSystem;
  sourceRef: string | null;
  severity: WatchlistHit['severity'];
  validFrom: string;
  validTo: string | null;
  meta: unknown;
}
