/**
 * Vehicle identity linking (D2-08).
 *
 * **What an "identity" is here, and what it is not.** A jury hands us one registration. This module
 * decides which *reads* — and therefore which sightings — belong to that one vehicle. It is the
 * step between D2-04's ranked candidate plates and D2-08's ordered trace, and it exists because
 * those two things are not the same claim:
 *
 *  - `GJ01AB1234` read exactly is a link we can defend: `plate_exact`, and the only doubt left is
 *    whether the camera read the characters right, which is what the OCR confidence carries.
 *  - `GJ01AB12` is the *same vehicle* only if the read was truncated. That is `plate_fuzzy`, and it
 *    is a **possibility**, never an identification. D2-04's handoff is explicit about it, the
 *    weighted distance is not a probability, and the UI must show the two differently.
 *
 * **Why this estate makes the distinction load-bearing rather than academic.** D2-01 measured **0
 * exact plate reads** over a 120-instance hand-labelled sample, because only 3 of those 120
 * instances carried a human-legible plate at all (`docs/anpr-accuracy.md`). On the live corpus a
 * trace is therefore built almost entirely out of *fuzzy* links or out of no plate link at all. A
 * UI that draws one confident line through those points is lying. So every link this module emits
 * carries three things, always:
 *
 *   `linkMethod`   — how the sighting was attached (the `link_method` enum from migration 0005)
 *   `linkConfidence` — `matchStrength × ocrConfidence`, in `[0,1]`, D2-04's own `rankingScore`
 *   `explanation`  — the human-readable edit script behind it
 *
 * **Two confidences, deliberately.** A candidate plate has a plate-level confidence built from its
 * *best* read in the window; an individual sighting has its own read confidence, which may be much
 * worse. `min_confidence` filters at the **sighting** level, because that is the claim an operator
 * is actually looking at when they look at one pin on the map.
 *
 * **What this module does not do.** It does not write `vehicle_identities`. v1 resolves an identity
 * per query rather than materialising one, so a read never mutates the corpus, and there is no
 * background job whose staleness could make a trace disagree with a search. It *does* read any
 * `identity_sightings` rows that already exist for the canonical plate and surface them verbatim —
 * that is the seam D3-03's `reid_bridge` links arrive through, and honouring it here means D3-03
 * changes a writer rather than this reader.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  MATCHER_ID,
  rankingScore,
  type PlateSearchCandidate,
  type PlateSearchResult,
} from './plate-search.js';

/** The `link_method` enum from migration 0005. */
export const LINK_METHODS = ['plate_exact', 'plate_fuzzy', 'reid_bridge'] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

/**
 * A candidate plate accepted into the identity, with the plate-level strength of the link.
 *
 * `linkConfidence` here is the **best case** for this plate — it uses the strongest read in the
 * window. Per-sighting confidence is computed by {@link sightingLinkConfidence} and is what the
 * `min_confidence` filter acts on.
 */
export interface LinkedPlate {
  plateNormalized: string;
  linkMethod: Extract<LinkMethod, 'plate_exact' | 'plate_fuzzy'>;
  /** Weighted distance under `config/plate-confusions.json`. Not a probability. Never shown alone. */
  distance: number;
  matchStrength: number;
  /** Best OCR confidence among this plate's reads in the window. */
  ocrConfidence: number;
  linkConfidence: number;
  explanation: string;
  sightingCount: number;
  cameraCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ResolvedIdentity {
  /** The normalised form of what the jury actually asked for. Not a plate we claim to have read. */
  canonicalPlate: string;
  /** `false` when the D2-03 grammar refuses the query (a phone number, signage). Not an error. */
  searched: boolean;
  plates: LinkedPlate[];
  exactPlates: number;
  fuzzyPlates: number;
  /** Sum of `sightingCount` over accepted plates — before the per-sighting confidence filter. */
  candidateSightings: number;
  firstSeen: string | null;
  lastSeen: string | null;
  matcher: string;
}

export interface ResolveOptions {
  /**
   * Plate-level floor. A plate whose *best* read cannot clear this cannot contribute a sighting
   * that clears it either, so filtering here saves hydrating rows that would be dropped anyway.
   */
  minConfidence?: number;
  /** Cap on distinct candidate plates folded into one identity. */
  maxPlates?: number;
}

export function linkMethodFor(distance: number): 'plate_exact' | 'plate_fuzzy' {
  return distance === 0 ? 'plate_exact' : 'plate_fuzzy';
}

/**
 * The confidence of attaching **one sighting** to the identity.
 *
 * `matchStrength` is a property of the two strings; `ocrConfidence` is a property of this
 * particular read. Multiplying them keeps both visible: an operator looking at a weak pin can see
 * whether the string match or the camera is the weak half. This is D2-04's `rankingScore`, reused
 * rather than re-derived, so a trace and a search can never disagree about how strong a link is.
 */
export function sightingLinkConfidence(matchStrength: number, ocrConfidence: number): number {
  return rankingScore(matchStrength, ocrConfidence);
}

/** Fold D2-04's ranked candidates into one identity. Pure — the search has already happened. */
export function resolveIdentity(
  search: PlateSearchResult,
  options: ResolveOptions = {},
): ResolvedIdentity {
  const minConfidence = options.minConfidence ?? 0;
  const maxPlates = options.maxPlates ?? 25;

  const plates: LinkedPlate[] = search.candidates
    .map(toLinkedPlate)
    .filter((p) => p.linkConfidence >= minConfidence)
    .slice(0, maxPlates);

  const firstSeen = plates.length === 0 ? null : (plates.map((p) => p.firstSeen).sort()[0] ?? null);
  const lastSeen =
    plates.length === 0
      ? null
      : (plates
          .map((p) => p.lastSeen)
          .sort()
          .at(-1) ?? null);

  return {
    canonicalPlate: search.normalized,
    searched: search.searched,
    plates,
    exactPlates: plates.filter((p) => p.linkMethod === 'plate_exact').length,
    fuzzyPlates: plates.filter((p) => p.linkMethod === 'plate_fuzzy').length,
    candidateSightings: plates.reduce((n, p) => n + p.sightingCount, 0),
    firstSeen,
    lastSeen,
    matcher: search.matcher || MATCHER_ID,
  };
}

function toLinkedPlate(candidate: PlateSearchCandidate): LinkedPlate {
  return {
    plateNormalized: candidate.plateNormalized,
    linkMethod: linkMethodFor(candidate.distance),
    distance: candidate.distance,
    matchStrength: candidate.matchStrength,
    ocrConfidence: candidate.ocrConfidence,
    // `candidate.score` is already `rankingScore(matchStrength, ocrConfidence)`; recomputing it
    // through the same function keeps this honest if D2-04 ever changes what `score` means.
    linkConfidence: sightingLinkConfidence(candidate.matchStrength, candidate.ocrConfidence),
    explanation: candidate.explanation,
    sightingCount: candidate.sightingCount,
    cameraCount: candidate.cameraCount,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
  };
}

/**
 * A link recorded in `identity_sightings` rather than derived from the plate metric.
 *
 * Nothing in D2-08 writes these. They exist so that a link produced by a *different* mechanism —
 * D3-03's appearance-based `reid_bridge` for unreadable plates — appears in the trace as soon as it
 * is written, flagged as what it is. A reid link is a weaker claim than a plate match and migration
 * 0005 says so in as many words; the UI must keep them visually distinct.
 */
export interface StoredLink {
  sightingId: string;
  sightingTs: string;
  linkMethod: LinkMethod;
  linkConfidence: number;
}

interface StoredLinkRow extends Record<string, unknown> {
  sighting_id: string;
  sighting_ts: string;
  link_method: LinkMethod;
  link_confidence: string;
}

/**
 * Stored links for a canonical plate, keyed by sighting id.
 *
 * Returns an empty map when no identity has been materialised for the plate, which is the normal
 * case in v1 — `vehicle_identities` is written by nothing yet.
 */
export async function loadStoredLinks(
  db: Db,
  canonicalPlate: string,
): Promise<Map<string, StoredLink>> {
  const out = new Map<string, StoredLink>();
  if (canonicalPlate === '') return out;

  const rows = await db.execute<StoredLinkRow>(sql`
    select isg.sighting_id::text as sighting_id,
           isg.sighting_ts,
           isg.link_method,
           isg.link_confidence::text as link_confidence
      from identity_sightings isg
      join vehicle_identities vi on vi.id = isg.identity_id
     where vi.canonical_plate = ${canonicalPlate}
  `);

  for (const row of rows) {
    out.set(row.sighting_id, {
      sightingId: row.sighting_id,
      sightingTs: new Date(row.sighting_ts).toISOString(),
      linkMethod: row.link_method,
      linkConfidence: Number(row.link_confidence),
    });
  }
  return out;
}
