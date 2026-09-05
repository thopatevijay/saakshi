import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { WatchlistSystem } from './provider.js';

/**
 * The seam D2-04 plugs into.
 *
 * D2-04 (#18) owns the confusion-aware weighted edit distance — the one that knows `0/O/D`, `1/I/L`,
 * `8/B` and the trailing-character truncation D2-01 measured as this estate's dominant failure. That
 * ticket is not merged, and it is not a blocker of D2-05, so the watchlist lookup ships with the
 * matcher *interface* and a plain two-stage default. **When D2-04 lands it constructs its matcher
 * and passes it to `createWatchlistRegistry({ matcher })` — no file in this directory changes.**
 *
 * The default is not a placeholder: it is the same two-stage design D2-04's plan specifies —
 * Postgres `pg_trgm` narrows the candidate set using `watchlist_entries_plate_trgm_idx`, and code
 * decides. What D2-04 replaces is the *metric*, not the shape.
 */

export interface PlateMatch {
  plateNormalized: string;
  /** Edit distance under this matcher's metric. `0` is exact. */
  distance: number;
  /** Match strength in `[0,1]`, `1` for exact. */
  confidence: number;
  /** Why it matched, for the alert why-payload. */
  explanation: string;
}

export interface PlateMatcherOptions {
  maxDistance: number;
  limit: number;
  /** Restricts candidate generation to one provider's rows. */
  system?: WatchlistSystem;
  /** The instant the validity window is evaluated at. */
  at: Date;
}

export interface PlateMatcher {
  /** Names the metric in the hit's explanation, and in `docs/watchlist-integration.md`. */
  readonly id: string;
  match(plateNormalized: string, options: PlateMatcherOptions): Promise<PlateMatch[]>;
}

interface CandidateRow extends Record<string, unknown> {
  plate_normalized: string;
  distance: number;
  similarity: number;
}

/**
 * `pg_trgm` for candidate generation, `levenshtein()` for the decision.
 *
 * Two candidate generators, unioned, because this estate has two different failure modes and a
 * single one misses half of them:
 *
 *  - **trigram similarity** (`%`, GIN-indexed) catches substitutions — `GJ01AB1234` read as
 *    `GJ0IAB1Z34`.
 *  - **prefix** (`LIKE q || '%'`, and the reverse) catches **truncation**, which D2-01 measured as
 *    the dominant failure here: `GJ35U0779 → GJ35U07`, `GJ35U07` sharing few enough trigrams with
 *    the full plate that a similarity threshold tuned for substitutions can drop it.
 *
 * The threshold is set per statement rather than globally, so this never mutates the database's
 * configuration for anything else running against it.
 */
export class TrigramPlateMatcher implements PlateMatcher {
  readonly id = 'trigram+levenshtein';

  /**
   * 0.2 rather than pg_trgm's 0.3 default. Plate strings are short — nine characters is seven
   * trigrams — so a two-character error costs a larger share of the similarity than it would in a
   * name, and 0.3 rejects candidates a human would call the same plate.
   */
  constructor(
    private readonly db: Db,
    private readonly similarityThreshold = 0.2,
  ) {}

  async match(plateNormalized: string, options: PlateMatcherOptions): Promise<PlateMatch[]> {
    const { maxDistance, limit, at } = options;
    const systemFilter =
      options.system === undefined ? sql`` : sql` and w.source_system = ${options.system} `;

    await this.db.execute(sql`select set_limit(${this.similarityThreshold}::real)`);

    const rows = await this.db.execute<CandidateRow>(sql`
      select distinct on (w.plate_normalized)
             w.plate_normalized,
             levenshtein(w.plate_normalized, ${plateNormalized}) as distance,
             similarity(w.plate_normalized, ${plateNormalized}) as similarity
        from watchlist_entries w
       where w.plate_normalized is not null
         and w.active
         and w.valid_from <= ${at.toISOString()}
         and (w.valid_to is null or w.valid_to > ${at.toISOString()})
         ${systemFilter}
         and (
              w.plate_normalized % ${plateNormalized}
           or w.plate_normalized like ${plateNormalized + '%'}
           or ${plateNormalized} like w.plate_normalized || '%'
         )
    `);

    return rows
      .map((row) => ({ ...row, distance: Number(row.distance), similarity: Number(row.similarity) }))
      .filter((row) => row.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance || b.similarity - a.similarity)
      .slice(0, limit)
      .map((row) => ({
        plateNormalized: row.plate_normalized,
        distance: row.distance,
        confidence: this.score(row.distance, row.plate_normalized.length),
        explanation:
          row.distance === 0
            ? `exact match on the normalised plate ${row.plate_normalized}`
            : `${String(row.distance)}-character difference from ${row.plate_normalized} ` +
              `(${this.id}, trigram similarity ${row.similarity.toFixed(2)}) — ` +
              `a fuzzy candidate, not a confirmed registration`,
      }));
  }

  /**
   * Distance to a `[0,1]` strength, relative to the entry's own length.
   *
   * Relative rather than absolute because one character wrong in a six-character plate is a weaker
   * claim than one wrong in a ten-character one, and an alert queue that ranks them equally makes
   * the operator do the arithmetic.
   */
  private score(distance: number, length: number): number {
    if (distance === 0) return 1;
    return Math.max(0, Math.round((1 - distance / Math.max(length, 1)) * 1000) / 1000);
  }
}
