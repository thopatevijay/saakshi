/**
 * Confusion-aware fuzzy plate matching (D2-04).
 *
 * **The premise.** On this estate exact-string matching returns nothing. D2-01 measured 0% exact
 * plate accuracy and 51.8% character accuracy over 120 hand-labelled vehicle instances
 * (`docs/anpr-accuracy.md`). A jury that hands us a registration and gets zero rows has been told
 * the truth by a system that is useless. So the metric has to model the two failures the estate
 * actually makes, and nothing else:
 *
 *  1. **Confusable substitutions** — `0/O/D`, `1/I/L`, `8/B`, and the alpha→alpha ones D2-05
 *     measured (`C→F`, `D→B`, `E→F`) that D2-03's slot-aware corrector is structurally blind to,
 *     because they never change a character's class.
 *  2. **Trailing truncation** — the dominant failure here (`GJ35U0779 → GJ35U07`). It is *not* a
 *     run of substitutions, and a metric that bills it as one loses the case it exists for.
 *     `GJ35U07 → GJ35U0779` is plain edit distance 2 and weighted distance 0.70;
 *     `GJ32DD10 → GJ32D0107` is plain edit distance 2 and weighted distance 0.55. Plain levenshtein
 *     can only say "two characters wrong" about both; that is the number that has to become a
 *     ranking, and at `maxDistance = 2` it is indistinguishable from a genuinely unrelated plate
 *     sitting at its own limit.
 *
 * **The asymmetry is deliberate and is preserved here.** D2-03's corrector never touches the state
 * code, because symmetric digit↔letter correction turns `757508300` — a hoarding's phone number and
 * the highest-confidence read of the whole live run — into the structurally perfect registration
 * `TS75O8300`. Three guards reproduce that at the search layer:
 *
 *  - a query whose primary rejection reason is `no_letters` / `no_digits` / `empty` / `too_short`
 *    is **not searched at all**;
 *  - candidate generation is anchored on `parts.state` when the query carries a recognised RTO code;
 *  - a **cross-class** substitution at index 0 or 1 costs `stateCrossClass` (2.5) — out of reach of
 *    any sane `maxDistance` — whenever the query has no letter of its own in those positions. A
 *    state code may be misread; it may not be invented out of digits.
 *
 * **The matrix is config, not code.** `config/plate-confusions.json` is read from disk, the same
 * rule `config/trust-weights.json` follows, so a cost change alters ranking with no rebuild. Every
 * pair carries its own provenance.
 *
 * Two consumers, one metric:
 *  - {@link ConfusionPlateMatcher} implements D2-05's `PlateMatcher` seam — the watchlist lookup
 *    gets this metric by construction, with no change to any file in `src/watchlist/`.
 *  - {@link PlateSearchService} backs `GET /api/v1/plates/search` over `plate_reads ⋈ sightings`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  isStateCode,
  normalise,
  validate,
  type PlateRejectionCode,
  type PlateSlotName,
  type PlateValidation,
} from '@saakshi/shared';
import type { Db } from '../db/client.js';
import type { PlateMatch, PlateMatcher, PlateMatcherOptions } from '../watchlist/matcher.js';

/* ── Config ──────────────────────────────────────────────────────────────────────────────────── */

const ConfusionPair = z.object({
  a: z.string().length(1),
  b: z.string().length(1),
  kind: z.enum(['alpha', 'digit', 'cross']),
  cost: z.number().min(0).max(4),
  source: z.string(),
});

export const ConfusionConfig = z
  .object({
    version: z.number(),
    costs: z.object({
      substitution: z.number().min(0),
      indel: z.number().min(0),
      measured: z.number().min(0),
      derived: z.number().min(0),
      truncationTail: z.number().min(0),
      stateCrossClass: z.number().min(0),
    }),
    /** Tail characters that may be charged at `truncationTail` before the full `indel` price. */
    tailAllowance: z.number().int().min(0).max(6),
    positionWeights: z.record(z.string(), z.number().min(0)),
    pairs: z.array(ConfusionPair),
  })
  .loose();

export type ConfusionConfig = z.infer<typeof ConfusionConfig>;

export const CONFUSION_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/plate-confusions.json',
);

let cached: ConfusionConfig | undefined;

/**
 * Load the matrix from `config/plate-confusions.json`.
 *
 * Read from disk rather than imported, because AC 8 is that the matrix is *config*: a cost edit has
 * to change ranking without a rebuild. A bundled import would make it a build input.
 */
export function loadConfusions(configPath: string = CONFUSION_CONFIG_PATH): ConfusionConfig {
  if (configPath === CONFUSION_CONFIG_PATH && cached !== undefined) return cached;
  const parsed = ConfusionConfig.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  if (configPath === CONFUSION_CONFIG_PATH) cached = parsed;
  return parsed;
}

/** Test hook: forces the next {@link loadConfusions} to re-read the default path. */
export function clearConfusionCache(): void {
  cached = undefined;
}

/** `'A-B'` → cost, both directions. The metric is symmetric; the *guards* are what are not. */
export function confusionTable(config: ConfusionConfig): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (const pair of config.pairs) {
    const a = pair.a.toUpperCase();
    const b = pair.b.toUpperCase();
    const existing = table.get(`${a}${b}`);
    if (existing === undefined || pair.cost < existing) {
      table.set(`${a}${b}`, pair.cost);
      table.set(`${b}${a}`, pair.cost);
    }
  }
  return table;
}

/* ── Slots ───────────────────────────────────────────────────────────────────────────────────── */

const isAlpha = (ch: string): boolean => ch >= 'A' && ch <= 'Z';
const crossClass = (a: string, b: string): boolean => isAlpha(a) !== isAlpha(b);

/**
 * Which registration slot each index of `plate` sits in, for position weighting.
 *
 * Taken from D2-03's parse when there is one — the whole reason `parts` is exposed as data. Falls
 * back to `unparsed` (weight 1.0) rather than guessing, so an unparseable candidate is scored by
 * the confusion costs alone.
 */
export function slotsFor(plate: string, validation?: PlateValidation): PlateSlotName[] {
  const v = validation ?? validate(plate);
  const slots: PlateSlotName[] = [];
  if (v.parts !== null) {
    const ordered: [PlateSlotName, string | null][] = [
      ['state', v.parts.state],
      ['rto', v.parts.rto],
      ['series', v.parts.series],
      ['number', v.parts.number],
    ];
    for (const [name, value] of ordered) {
      for (let i = 0; i < (value?.length ?? 0); i += 1) slots.push(name);
    }
  }
  while (slots.length < plate.length) slots.push('unparsed');
  return slots.slice(0, plate.length);
}

/* ── The metric ──────────────────────────────────────────────────────────────────────────────── */

export interface EditOp {
  kind: 'sub' | 'ins' | 'del' | 'tail';
  /** Index into the candidate string, or the insertion point when the candidate has no character. */
  index: number;
  from: string;
  to: string;
  cost: number;
}

export interface WeightedDistance {
  distance: number;
  /** Characters charged at the truncation price rather than the full indel price. */
  tailChars: number;
  ops: EditOp[];
}

interface Weights {
  table: ReadonlyMap<string, number>;
  config: ConfusionConfig;
  slots: PlateSlotName[];
  /**
   * Whether the *query* carries a letter in either of the first two positions.
   *
   * This is the whole of the asymmetry, in one boolean. A state code may be **misread**; it may not
   * be **invented**. See {@link substitutionCost}.
   */
  queryStateAnchored: boolean;
}

/**
 * Cost of reading candidate character `cc` (at candidate index `ci`) as query character `qc`.
 *
 * The one non-obvious rule is the state guard. D2-03's corrector never touches the state code,
 * because symmetric digit↔letter correction turns `757508300` into `TS75O8300`. Reproducing that as
 * a blanket "no cross-class substitution at index 0–1" would also lose `6J18Y9407 → GJ18Y9407`,
 * which is a legitimate `G↔6` confusion and is exactly what AC 2 requires us to find. So the guard
 * is narrower and matches the actual failure: a cross-class substitution at index 0–1 is priced out
 * of reach **only when the query has no letter in either of those positions** — that is, only when
 * accepting it would *manufacture* a state code out of digits. A query that already reads `6J…`
 * has an anchoring letter and its other character is scored as an ordinary confusion.
 *
 * `757508300` is refused twice over: `no_letters` stops it before any query runs, and both of its
 * leading digits would cost `stateCrossClass` if it ever got here.
 */
function substitutionCost(qc: string, cc: string, ci: number, w: Weights): number {
  if (qc === cc) return 0;
  if (ci <= 1 && crossClass(qc, cc) && !w.queryStateAnchored) return w.config.costs.stateCrossClass;
  const pair = w.table.get(`${qc}${cc}`);
  const base = pair ?? w.config.costs.substitution;
  const slot = w.slots[ci] ?? 'unparsed';
  const weight = w.config.positionWeights[slot] ?? 1;
  return base * weight;
}

/** Standard weighted Levenshtein with full-price indels — the tail is handled by the caller. */
function innerDistance(query: string, candidate: string, w: Weights): WeightedDistance {
  const m = query.length;
  const n = candidate.length;
  const indel = w.config.costs.indel;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) dp[i][0] = i * indel;
  for (let j = 1; j <= n; j += 1) dp[0][j] = j * indel;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const sub = dp[i - 1][j - 1] + substitutionCost(query[i - 1], candidate[j - 1], j - 1, w);
      dp[i][j] = Math.min(sub, dp[i - 1][j] + indel, dp[i][j - 1] + indel);
    }
  }
  return { distance: dp[m][n], tailChars: 0, ops: backtrack(dp, query, candidate, w) };
}

function backtrack(dp: number[][], query: string, candidate: string, w: Weights): EditOp[] {
  const ops: EditOp[] = [];
  const indel = w.config.costs.indel;
  let i = query.length;
  let j = candidate.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = substitutionCost(query[i - 1], candidate[j - 1], j - 1, w);
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        if (cost > 0) {
          ops.push({ kind: 'sub', index: j - 1, from: candidate[j - 1], to: query[i - 1], cost });
        }
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + indel) {
      ops.push({ kind: 'ins', index: j, from: '', to: query[i - 1], cost: indel });
      i -= 1;
      continue;
    }
    ops.push({ kind: 'del', index: j - 1, from: candidate[j - 1], to: '', cost: indel });
    j -= 1;
  }
  return ops.reverse();
}

/**
 * Weighted distance between an OCR read (or a typed query) and a candidate registration.
 *
 * **Truncation is charged as truncation.** Up to `tailAllowance` characters may be trimmed from the
 * *end* of either string at `truncationTail` (0.35) each instead of the full indel price, and the
 * minimum over those trims is the answer. That is the entire difference between `GJ35U07 →
 * GJ35U0779` costing 0.70 and costing 2.0, and between `GJ32DD10 → GJ32D0107` costing 0.55 and
 * costing 3. Beyond the allowance a missing character is a real deletion again, so `GJ35` does not
 * become a cheap match for every plate in Gujarat.
 */
export function weightedDistance(
  rawQuery: string,
  rawCandidate: string,
  config: ConfusionConfig,
  table?: ReadonlyMap<string, number>,
): WeightedDistance {
  const query = normalise(rawQuery);
  const candidate = normalise(rawCandidate);
  if (query === candidate) return { distance: 0, tailChars: 0, ops: [] };

  const w: Weights = {
    table: table ?? confusionTable(config),
    config,
    slots: slotsFor(candidate),
    queryStateAnchored: isAlpha(query[0] ?? '') || isAlpha(query[1] ?? ''),
  };
  const tail = config.costs.truncationTail;
  const allowance = config.tailAllowance;

  let best: WeightedDistance = innerDistance(query, candidate, w);
  for (let a = 0; a <= Math.min(allowance, Math.max(candidate.length - 1, 0)); a += 1) {
    for (let b = 0; b <= Math.min(allowance, Math.max(query.length - 1, 0)); b += 1) {
      // One side only. Trimming *both* tails at the truncation price would model a trailing
      // substitution as two cheap deletions — `GJ01AB1234` vs `GJ01AB1237` at 0.70 rather than
      // 0.80 — and that inverts AC 3 for any error in the last position. Truncation is one-sided
      // by definition: a read is short, it is not short at both ends.
      if (a === 0 ? b === 0 : b !== 0) continue;
      const trimmed = innerDistance(
        query.slice(0, query.length - b),
        candidate.slice(0, candidate.length - a),
        w,
      );
      const distance = trimmed.distance + (a + b) * tail;
      if (distance < best.distance) {
        const ops = [...trimmed.ops];
        for (let k = 0; k < a; k += 1) {
          const index = candidate.length - a + k;
          ops.push({ kind: 'tail', index, from: candidate[index], to: '', cost: tail });
        }
        for (let k = 0; k < b; k += 1) {
          const index = query.length - b + k;
          ops.push({ kind: 'tail', index, from: '', to: query[index], cost: tail });
        }
        best = { distance, tailChars: a + b, ops };
      }
    }
  }
  return { ...best, distance: Math.round(best.distance * 1000) / 1000 };
}

/* ── The search plan ─────────────────────────────────────────────────────────────────────────── */

/**
 * Rejection codes that mean **do not search** — D2-03's `docs/plate-grammar.md` §7.
 *
 * `no_letters` is the one that matters most: `757508300` is a hoarding's phone number, it was the
 * highest-confidence read of the entire live run, and any system that fuzzy-searches it will find
 * something. The right number of results for it is zero.
 */
export const UNSEARCHABLE_CODES: readonly PlateRejectionCode[] = [
  'no_letters',
  'no_digits',
  'empty',
  'too_short',
];

export interface PlateSearchPlan {
  normalized: string;
  searchable: boolean;
  /** `reasons[0].code`, or `null` for a clean registration. */
  reason: PlateRejectionCode | null;
  validity: PlateValidation['validity'];
  missingChars: number | null;
  /**
   * Two-character state codes candidate generation is restricted to, or `null` for no anchor.
   *
   * The query's own state plus every single alpha↔alpha confusable variant of it. Anchoring only
   * happens when the query carries a *recognised* RTO code: if the state code is itself unreadable
   * then it is not a thing to anchor on, and the cross-class cost guard carries the precision
   * instead.
   */
  stateAnchors: string[] | null;
}

/** Alpha↔alpha variants of a two-letter state code, at most one substitution. */
function stateVariants(state: string, table: ReadonlyMap<string, number>): string[] {
  const out = new Set<string>([state]);
  for (let i = 0; i < state.length; i += 1) {
    for (const key of table.keys()) {
      const [from, to] = [key[0], key[1]];
      if (from !== state[i] || !isAlpha(from) || !isAlpha(to)) continue;
      out.add(state.slice(0, i) + to + state.slice(i + 1));
    }
  }
  return [...out];
}

export function planSearch(rawQuery: string, config: ConfusionConfig): PlateSearchPlan {
  const v = validate(rawQuery);
  const reason = v.reasons[0]?.code ?? null;
  const searchable = reason === null || !UNSEARCHABLE_CODES.includes(reason);
  const state = v.parts?.state ?? null;
  return {
    normalized: v.normalized,
    searchable,
    reason,
    validity: v.validity,
    missingChars: v.missingChars,
    stateAnchors:
      state !== null && isStateCode(state) ? stateVariants(state, confusionTable(config)) : null,
  };
}

/* ── Ranking ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Distance → a `[0,1]` match strength, relative to the distance budget the caller asked for.
 *
 * Flat and auditable rather than tuned, the same rule D2-03's confidence model follows: a single
 * opaque score cannot be argued with in front of a jury, and this one can be recomputed by hand.
 */
export function matchStrength(distance: number, maxDistance: number): number {
  if (distance <= 0) return 1;
  const budget = Math.max(maxDistance, 1) + 1;
  return Math.max(0, Math.round((1 - distance / budget) * 1000) / 1000);
}

/**
 * The one ranking score, combining how well the strings match with how well the camera read them.
 *
 * `score = matchStrength × ocrConfidence`. A product of two independent factors, neither hidden:
 * a perfect string match on a 0.3-confidence read and a 0.6-strength match on a 0.9-confidence read
 * are genuinely comparable claims, and the operator can see which half is weak. Watchlist entries
 * carry no OCR confidence, so there `ocrConfidence` is 1 and the score is the match strength.
 */
export function rankingScore(strength: number, ocrConfidence: number): number {
  return Math.round(strength * ocrConfidence * 1000) / 1000;
}

export function explain(
  candidate: string,
  result: WeightedDistance,
  matcherId: string,
  strength: number,
): string {
  if (result.distance === 0) return `exact match on the normalised plate ${candidate}`;
  const subs = result.ops.filter((o) => o.kind === 'sub');
  const parts: string[] = [];
  if (subs.length > 0) {
    parts.push(subs.map((o) => `${o.from}→${o.to} at ${String(o.index)}`).join(', '));
  }
  if (result.tailChars > 0) {
    parts.push(`${String(result.tailChars)} truncated character(s)`);
  }
  const other = result.ops.filter((o) => o.kind === 'ins' || o.kind === 'del').length;
  if (other > 0) parts.push(`${String(other)} inserted/deleted character(s)`);
  return (
    `${candidate}: ${parts.join(' · ')} — weighted distance ${result.distance.toFixed(2)}, ` +
    `strength ${strength.toFixed(2)} (${matcherId}). ` +
    `A fuzzy candidate, not a confirmed registration.`
  );
}

/* ── The PlateMatcher seam (D2-05, #19) ──────────────────────────────────────────────────────── */

interface CandidateRow extends Record<string, unknown> {
  plate_normalized: string;
}

/**
 * D2-05's `PlateMatcher`, backed by this metric. Registered with
 * `createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) })`; no file in
 * `src/watchlist/` changes.
 *
 * Three stages, in the order the ticket specifies — *index narrows, code decides*:
 *  1. `pg_trgm` (`watchlist_entries_plate_trgm_idx`) plus prefix probes in both directions, because
 *     a similarity threshold tuned for substitutions drops a truncated read;
 *  2. the state anchor, which *narrows* — the D2-03 precision guard;
 *  3. the weighted metric in application code, which decides and ranks.
 *
 * An exact row is matched by its own equality term outside the anchor, so it can never be lost to a
 * candidate generator's threshold.
 */
export class ConfusionPlateMatcher implements PlateMatcher {
  readonly id = 'confusion-weighted';
  private readonly config: ConfusionConfig;
  private readonly table: ReadonlyMap<string, number>;

  constructor(
    private readonly db: Db,
    config?: ConfusionConfig,
    /**
     * 0.2 rather than pg_trgm's 0.3 default, for the reason D2-05 documented: nine characters is
     * seven trigrams, so a two-character error costs a larger share of the similarity than it would
     * in a name.
     */
    private readonly similarityThreshold = 0.2,
  ) {
    this.config = config ?? loadConfusions();
    this.table = confusionTable(this.config);
  }

  async match(plateNormalized: string, options: PlateMatcherOptions): Promise<PlateMatch[]> {
    const { maxDistance, limit, at } = options;
    const plan = planSearch(plateNormalized, this.config);
    if (!plan.searchable || plan.normalized === '') return [];

    const iso = at.toISOString();
    const systemFilter =
      options.system === undefined ? sql`` : sql` and w.source_system = ${options.system} `;

    await this.db.execute(sql`select set_limit(${this.similarityThreshold}::real)`);
    const rows = await this.db.execute<CandidateRow>(sql`
      select distinct w.plate_normalized
        from watchlist_entries w
       where w.plate_normalized is not null
         and w.active
         and w.valid_from <= ${iso}
         and (w.valid_to is null or w.valid_to > ${iso})
         ${systemFilter}
         and ${candidateClause(sql`w.plate_normalized`, plan)}
    `);

    return rank(
      rows.map((row) => row.plate_normalized),
      plan.normalized,
      maxDistance,
      limit,
      this.config,
      this.table,
      this.id,
    );
  }
}

/**
 * The generate-then-narrow SQL fragment shared by both consumers.
 *
 * `column = q` sits *outside* the anchor conjunction on purpose: AC 1 is that an exact match always
 * ranks first, and it can only do that if it is always generated.
 */
export function candidateClause(column: SQL, plan: PlateSearchPlan): SQL {
  const q = plan.normalized;
  const generators = sql`(${column} % ${q} or ${column} like ${q + '%'} or ${q} like ${column} || '%')`;
  const anchor =
    plan.stateAnchors === null ? sql`true` : sql`left(${column}, 2) in ${plan.stateAnchors}`;
  return sql`(${column} = ${q} or (${generators} and ${anchor}))`;
}

function rank(
  candidates: string[],
  query: string,
  maxDistance: number,
  limit: number,
  config: ConfusionConfig,
  table: ReadonlyMap<string, number>,
  matcherId: string,
): PlateMatch[] {
  return candidates
    .map((plate) => ({ plate, result: weightedDistance(query, plate, config, table) }))
    .filter((row) => row.result.distance <= maxDistance)
    .map(({ plate, result }) => {
      const strength = matchStrength(result.distance, maxDistance);
      return {
        plateNormalized: plate,
        distance: result.distance,
        confidence: strength,
        explanation: explain(plate, result, matcherId, strength),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.plateNormalized.localeCompare(b.plateNormalized))
    .slice(0, limit);
}

/* ── The sightings search ────────────────────────────────────────────────────────────────────── */

export interface PlateSearchOptions {
  maxDistance: number;
  limit: number;
  from?: Date | undefined;
  to?: Date | undefined;
  cameraIds?: string[] | undefined;
  /** Sighting references returned per candidate plate. */
  sightingsPerCandidate?: number;
}

export interface SightingRef {
  sightingId: string;
  sightingTs: string;
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  plateReadId: string;
  rawText: string;
  ocrConfidence: number;
  voteCount: number;
  cropUri: string | null;
}

export interface PlateSearchCandidate {
  plateNormalized: string;
  matchType: 'exact' | 'fuzzy';
  distance: number;
  matchStrength: number;
  /** Best OCR confidence among this plate's reads in the window. */
  ocrConfidence: number;
  score: number;
  explanation: string;
  sightingCount: number;
  firstSeen: string;
  lastSeen: string;
  cameraCount: number;
  sightings: SightingRef[];
}

export interface PlateSearchResult {
  query: string;
  normalized: string;
  validity: PlateValidation['validity'];
  reason: PlateRejectionCode | null;
  missingChars: number | null;
  searched: boolean;
  maxDistance: number;
  matcher: string;
  candidates: PlateSearchCandidate[];
}

interface GroupRow extends Record<string, unknown> {
  plate: string;
  sighting_count: string;
  camera_count: string;
  first_seen: string;
  last_seen: string;
  best_confidence: string;
}

interface RefRow extends Record<string, unknown> {
  plate: string;
  sighting_id: string;
  sighting_ts: string;
  camera_id: string;
  camera_external_id: string;
  camera_name: string;
  plate_read_id: string;
  raw_text: string;
  confidence: string;
  vote_count: number;
  crop_uri: string | null;
}

export const MATCHER_ID = 'confusion-weighted';

/**
 * `GET /api/v1/plates/search` — ranked candidate plates with their sighting references.
 *
 * Two round trips rather than one join returning every row: the first groups `plate_reads ⋈
 * sightings` down to distinct candidate plates with their counts, the metric ranks those in code,
 * and only the survivors' sighting references are fetched. At demo volume that is the difference
 * between scoring a handful of plates and hydrating tens of thousands of rows to throw them away.
 */
export class PlateSearchService {
  private readonly config: ConfusionConfig;
  private readonly table: ReadonlyMap<string, number>;

  constructor(
    private readonly db: Db,
    config?: ConfusionConfig,
    private readonly similarityThreshold = 0.2,
  ) {
    this.config = config ?? loadConfusions();
    this.table = confusionTable(this.config);
  }

  async search(rawQuery: string, options: PlateSearchOptions): Promise<PlateSearchResult> {
    const plan = planSearch(rawQuery, this.config);
    const base: Omit<PlateSearchResult, 'candidates'> = {
      query: rawQuery,
      normalized: plan.normalized,
      validity: plan.validity,
      reason: plan.reason,
      missingChars: plan.missingChars,
      searched: plan.searchable && plan.normalized !== '',
      maxDistance: options.maxDistance,
      matcher: MATCHER_ID,
    };
    if (!base.searched) return { ...base, candidates: [] };

    const groups = await this.candidates(plan, options);
    const scored = groups
      .map((row) => ({ row, result: weightedDistance(plan.normalized, row.plate, this.config, this.table) }))
      .filter((row) => row.result.distance <= options.maxDistance)
      .sort(
        (a, b) =>
          a.result.distance - b.result.distance ||
          Number(b.row.best_confidence) - Number(a.row.best_confidence),
      )
      .slice(0, options.limit);

    const refs = await this.refs(
      scored.map((s) => s.row.plate),
      options,
    );

    return {
      ...base,
      candidates: scored.map(({ row, result }) => {
        const strength = matchStrength(result.distance, options.maxDistance);
        const ocrConfidence = Number(row.best_confidence);
        return {
          plateNormalized: row.plate,
          matchType: result.distance === 0 ? ('exact' as const) : ('fuzzy' as const),
          distance: result.distance,
          matchStrength: strength,
          ocrConfidence,
          score: rankingScore(strength, ocrConfidence),
          explanation: explain(row.plate, result, MATCHER_ID, strength),
          sightingCount: Number(row.sighting_count),
          cameraCount: Number(row.camera_count),
          firstSeen: new Date(row.first_seen).toISOString(),
          lastSeen: new Date(row.last_seen).toISOString(),
          sightings: refs.get(row.plate) ?? [],
        };
      }),
    };
  }

  private async candidates(plan: PlateSearchPlan, options: PlateSearchOptions): Promise<GroupRow[]> {
    await this.db.execute(sql`select set_limit(${this.similarityThreshold}::real)`);
    return this.db.execute<GroupRow>(sql`
      select pr.normalized_text as plate,
             count(*)::text as sighting_count,
             count(distinct s.camera_id)::text as camera_count,
             min(s.ts) as first_seen,
             max(s.ts) as last_seen,
             max(pr.confidence)::text as best_confidence
        from plate_reads pr
        join sightings s on s.id = pr.sighting_id and s.ts = pr.sighting_ts
       where pr.normalized_text is not null
         ${windowClause(options)}
         and ${candidateClause(sql`pr.normalized_text`, plan)}
       group by pr.normalized_text
    `);
  }

  private async refs(
    plates: string[],
    options: PlateSearchOptions,
  ): Promise<Map<string, SightingRef[]>> {
    const out = new Map<string, SightingRef[]>();
    if (plates.length === 0) return out;
    const perPlate = options.sightingsPerCandidate ?? 20;

    const rows = await this.db.execute<RefRow>(sql`
      select * from (
        select pr.normalized_text as plate,
               s.id::text as sighting_id, s.ts as sighting_ts,
               s.camera_id::text as camera_id, c.external_id as camera_external_id, c.name as camera_name,
               pr.id::text as plate_read_id, pr.raw_text, pr.confidence::text as confidence,
               pr.vote_count, pr.crop_uri,
               row_number() over (partition by pr.normalized_text order by s.ts desc) as rn
          from plate_reads pr
          join sightings s on s.id = pr.sighting_id and s.ts = pr.sighting_ts
          join cameras c on c.id = s.camera_id
         where pr.normalized_text in ${plates}
           ${windowClause(options)}
      ) ranked
      where rn <= ${perPlate}
      order by plate, sighting_ts desc
    `);

    for (const row of rows) {
      const list = out.get(row.plate) ?? [];
      list.push({
        sightingId: row.sighting_id,
        sightingTs: new Date(row.sighting_ts).toISOString(),
        cameraId: row.camera_id,
        cameraExternalId: row.camera_external_id,
        cameraName: row.camera_name,
        plateReadId: row.plate_read_id,
        rawText: row.raw_text,
        ocrConfidence: Number(row.confidence),
        voteCount: row.vote_count,
        cropUri: row.crop_uri,
      });
      out.set(row.plate, list);
    }
    return out;
  }
}

/** Time-window and camera filters, composed into whichever query needs them. */
function windowClause(options: PlateSearchOptions): SQL {
  const parts: SQL[] = [];
  if (options.from !== undefined) parts.push(sql` and s.ts >= ${options.from.toISOString()}`);
  if (options.to !== undefined) parts.push(sql` and s.ts <= ${options.to.toISOString()}`);
  if (options.cameraIds !== undefined && options.cameraIds.length > 0) {
    parts.push(sql` and s.camera_id in ${options.cameraIds.map((id) => sql`${id}::uuid`)}`);
  }
  return sql.join(parts, sql``);
}
