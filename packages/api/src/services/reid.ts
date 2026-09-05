/**
 * Vehicle re-ID bridging: attach a sighting whose plate was unreadable to an identity whose plate
 * was read (D3-03).
 *
 * ## This ships disabled by default, and that is the ticket's own answer
 *
 * D3-03's AC 3 gates the feature on measured precision: `>= 0.9`, or it ships off with the number
 * published. `python -m workers.analytics.eval_reid` measured **0.761** held-out precision
 * (leave-one-camera-out, 59 hand-verified positive and 51 hand-verified negative pairs) — so
 * `REID_ENABLED` defaults to `false` and a trace is plate-only unless an operator turns it on and
 * asks for it per query. The measurement is committed at `docs/reid-measurement.json`; the reasoning
 * is `docs/reid.md`; the limitation is `docs/limitations.md`.
 *
 * A wrong link attaches another vehicle's movements to this vehicle's evidentiary route. A missing
 * link merely leaves the route as sparse as ANPR alone would have left it. Those are not
 * symmetrical, which is why precision decides and recall is only reported.
 *
 * ## The order of operations IS the safety property
 *
 *     candidates -> SPATIO-TEMPORAL GATE -> appearance comparison -> link
 *
 * `gateCandidates` runs over candidate *metadata only*. Embeddings are fetched afterwards, for the
 * survivors alone (`loadEmbeddings`), so a candidate that could not have been the same vehicle is
 * never compared against — not as an optimisation, but so that the wrong answer is unreachable
 * rather than merely unlikely. `reid.test.ts` proves it by asserting the embedding query is never
 * issued for a gated-out candidate.
 *
 * The travel-time model is **D3-01's**: `timingPlausibility` from `route.ts`, over an `OsrmClient`
 * route duration. This module does not define a second notion of reachability, and if `route.ts`
 * changes its model this one changes with it.
 *
 * ## Not face recognition
 *
 * The descriptor compared here is `sighting_appearance.embedding`: white-balanced colour histograms
 * and a coarse edge signature taken from the *outside of a vehicle*. SAAKSHI performs no face
 * recognition and stores no biometric template, deliberately and for legal reasons. Migration 0022
 * and `docs/reid.md` §2 say the same thing in the same words.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { OsrmClient } from './osrm.js';
import { timingPlausibility } from './route.js';
import type { TraceResult, TraceSighting } from './trace.js';
import { writeAudit } from '../audit.js';
import type { Principal } from '../auth.js';

/**
 * The descriptor id the shipped calibration was measured on. Two embeddings may be compared **only**
 * when their ids match: a cosine between two different descriptors is a number with no meaning, and
 * it would be a number that silently links two unrelated vehicles.
 */
export const REID_EMBEDDER_ID = 'sog-hsv-shape-v1';

/** Calibrated by `eval_reid`, mirrored from `workers/analytics/reid.py::ReidThresholds`. */
export const REID_SIMILARITY_MIN = 0.933;
export const REID_GATE_TIMING_MIN = 0.25;
export const REID_SAME_CAMERA_MAX_GAP_S = 300;
export const REID_MAX_ELAPSED_S = 3600;
export const REID_MIN_BEST_SHOT_SCORE = 0.25;

/** Held-out, leave-one-camera-out, on `fixtures/reid-eval`. Stated, never rounded up. */
export const REID_MEASURED_PRECISION = 0.761;
export const REID_MEASURED_RECALL = 0.593;

export const REID_DISCLAIMER =
  'A re-ID link is an appearance match between vehicle crops, not a plate read and not a biometric ' +
  'identification. It was measured at 0.761 precision on a hand-verified set of 110 pairs — roughly ' +
  'one link in four is wrong — which is why it is disabled by default and must be asked for. ' +
  'Cross-camera performance is unmeasured on this estate. See docs/reid.md.';

/** Sorting a mixed list must never let the weakest claim outrank a plate. */
export const REID_MAX_LINK_CONFIDENCE = 0.6;

export interface ReidConfig {
  /** `REID_ENABLED`. Default **false** — the measured precision is below the ticket's bar. */
  enabled: boolean;
  embedderId: string;
  similarityMin: number;
  gateTimingMin: number;
  sameCameraMaxGapS: number;
  maxElapsedS: number;
  minBestShotScore: number;
}

export function reidConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReidConfig {
  const number = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    // Explicit opt-in only. `'true'`, nothing else — a truthy-string check would turn `REID_ENABLED=false`
    // into an enabled feature, which for this feature is the expensive direction to be wrong in.
    enabled: (env['REID_ENABLED'] ?? '').trim().toLowerCase() === 'true',
    embedderId: env['REID_EMBEDDER_ID'] ?? REID_EMBEDDER_ID,
    similarityMin: number('REID_SIMILARITY_MIN', REID_SIMILARITY_MIN),
    gateTimingMin: number('REID_GATE_TIMING_MIN', REID_GATE_TIMING_MIN),
    sameCameraMaxGapS: number('REID_SAME_CAMERA_MAX_GAP_S', REID_SAME_CAMERA_MAX_GAP_S),
    maxElapsedS: number('REID_MAX_ELAPSED_S', REID_MAX_ELAPSED_S),
    minBestShotScore: number('REID_MIN_BEST_SHOT_SCORE', REID_MIN_BEST_SHOT_SCORE),
  };
}

/** An anchor: a sighting this identity owns because its plate was actually read. */
export interface ReidAnchor {
  sightingId: string;
  ts: string;
  cameraId: string;
  lat: number | null;
  lon: number | null;
  located: boolean;
}

/**
 * A candidate, as it comes out of the database **without its embedding**. The absence of the vector
 * from this type is the safety property expressed as a type: nothing downstream of the gate can
 * compare an appearance it does not have.
 */
export interface ReidCandidate {
  sightingId: string;
  ts: string;
  cameraId: string;
  cameraExternalId: string;
  lat: number | null;
  lon: number | null;
  located: boolean;
  bestShotScore: number;
}

export interface ReachablePair {
  anchor: ReidAnchor;
  candidate: ReidCandidate;
  elapsedS: number;
  expectedTravelTimeS: number | null;
  gate: 'same_camera_dwell' | 'travel_time';
}

export interface GateRejection {
  sightingId: string;
  anchorSightingId: string;
  elapsedS: number;
  reason: string;
}

export interface ReidLink {
  sightingId: string;
  sightingTs: string;
  anchorSightingId: string;
  cameraId: string;
  similarity: number;
  linkConfidence: number;
  elapsedS: number;
  expectedTravelTimeS: number | null;
  gate: ReachablePair['gate'];
  explanation: string;
}

export interface ReidBridgeResult {
  canonicalPlate: string;
  enabled: boolean;
  embedderId: string;
  anchors: number;
  anchorsWithEmbedding: number;
  candidatesConsidered: number;
  pairsGatedOut: number;
  pairsCompared: number;
  links: ReidLink[];
  written: number;
  measuredPrecision: number;
  disclaimer: string;
  takenMs: number;
}

export interface BridgeOptions {
  from?: Date | undefined;
  to?: Date | undefined;
  /** `false` runs the whole pipeline and returns the links without writing them. */
  persist?: boolean;
  principal?: Principal | undefined;
  purpose?: string;
}

// ── pure arithmetic ─────────────────────────────────────────────────────────────────────────────

/** Cosine similarity. Both sides are stored L2-normalised; this renormalises anyway, because a
 * `real[]` that has been through Postgres is float32 and no longer exactly unit length. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Map a cosine onto `identity_sightings.link_confidence`.
 *
 * Deliberately not the raw cosine. Cosines between two normalised histogram descriptors live in a
 * narrow high band — 0.97 links, 0.93 does not — and writing 0.97 into a column an officer reads as
 * "97% sure" would be a lie told by a number. Rescales the band above the floor onto `[0, 0.6]`; the
 * ceiling keeps a re-ID bridge below every plate match in any sorted list, because it is the weakest
 * claim the system can make.
 */
export function linkConfidence(similarity: number, similarityMin = REID_SIMILARITY_MIN): number {
  if (similarity < similarityMin) return 0;
  const span = Math.max(1e-6, 1 - similarityMin);
  const scaled = (REID_MAX_LINK_CONFIDENCE * (similarity - similarityMin)) / span;
  return Math.round(Math.min(REID_MAX_LINK_CONFIDENCE, scaled) * 1000) / 1000;
}

/**
 * Why this candidate cannot be this anchor's vehicle, or `null` when it could be.
 *
 * A string rather than a boolean because the reason is the evidence: "unroutable" and "impossibly
 * fast" are different failures, and an officer asking why a bridge did *not* happen deserves to
 * know which. Mirrors `workers/analytics/reid.py::gate_reason`, which the Python evaluation uses so
 * that the number in `docs/reid.md` is measured through the same gate the API applies.
 */
export function gateReason(
  input: {
    sameCamera: boolean;
    elapsedS: number;
    expectedTravelTimeS: number | null;
  },
  config: ReidConfig,
): string | null {
  const { sameCamera, elapsedS, expectedTravelTimeS } = input;
  if (elapsedS < 0) return 'candidate precedes the anchor';
  if (elapsedS > config.maxElapsedS) {
    return `elapsed ${Math.round(elapsedS)}s exceeds the ${config.maxElapsedS}s ceiling`;
  }
  if (sameCamera) {
    return elapsedS > config.sameCameraMaxGapS
      ? `same camera, ${Math.round(elapsedS)}s apart, beyond the ${config.sameCameraMaxGapS}s dwell window`
      : null;
  }
  if (expectedTravelTimeS === null) {
    // D3-01 calls this `inferred_unroutable` and refuses to score it. Bridging on appearance alone
    // across a gap nothing can route is precisely the wrong link this ticket exists to avoid.
    return 'no route between the cameras — travel time unmeasured';
  }
  if (elapsedS < 0.5) {
    return 'two cameras, no elapsed time — one vehicle cannot be in two places at once';
  }
  const plausibility = timingPlausibility(elapsedS, expectedTravelTimeS);
  if (plausibility === null || plausibility < config.gateTimingMin) {
    return (
      `travel-time plausibility ${(plausibility ?? 0).toFixed(3)} below ` +
      `${config.gateTimingMin.toFixed(2)} (elapsed ${Math.round(elapsedS)}s vs ` +
      `${Math.round(expectedTravelTimeS)}s free-flow)`
    );
  }
  return null;
}

/** Travel time between two cameras, or `null`. `TravelTimeLookup` is keyed `fromCameraId>toCameraId`. */
export type TravelTimeLookup = (from: ReidAnchor, to: ReidCandidate) => number | null;

/**
 * **The gate. Runs over metadata only — no embeddings are in scope here.**
 *
 * Returns the anchor/candidate pairs that survive, and every rejection with its reason. A candidate
 * that reaches no anchor never appears in `reachable`, so `loadEmbeddings` is never asked for it.
 */
export function gateCandidates(
  anchors: readonly ReidAnchor[],
  candidates: readonly ReidCandidate[],
  travelTime: TravelTimeLookup,
  config: ReidConfig,
): { reachable: ReachablePair[]; rejected: GateRejection[] } {
  const reachable: ReachablePair[] = [];
  const rejected: GateRejection[] = [];
  for (const candidate of candidates) {
    if (candidate.bestShotScore < config.minBestShotScore) {
      // D2-08 opened the shipped crops and found Gujarati shop signage among them: the detector
      // fires on high-contrast rectangular text of any kind. A weak crop is a crop of *something*,
      // and matching two of them to each other is the failure mode this floor exists for.
      rejected.push({
        sightingId: candidate.sightingId,
        anchorSightingId: '',
        elapsedS: 0,
        reason: `best-shot score ${candidate.bestShotScore.toFixed(3)} below ${config.minBestShotScore}`,
      });
      continue;
    }
    for (const anchor of anchors) {
      if (anchor.sightingId === candidate.sightingId) continue;
      const elapsedS = Math.abs(Date.parse(candidate.ts) - Date.parse(anchor.ts)) / 1000;
      const sameCamera = anchor.cameraId === candidate.cameraId;
      const expectedTravelTimeS = sameCamera ? null : travelTime(anchor, candidate);
      const reason = gateReason({ sameCamera, elapsedS, expectedTravelTimeS }, config);
      if (reason !== null) {
        rejected.push({
          sightingId: candidate.sightingId,
          anchorSightingId: anchor.sightingId,
          elapsedS,
          reason,
        });
        continue;
      }
      reachable.push({
        anchor,
        candidate,
        elapsedS,
        expectedTravelTimeS,
        gate: sameCamera ? 'same_camera_dwell' : 'travel_time',
      });
    }
  }
  return { reachable, rejected };
}

/**
 * Appearance comparison, over pairs the gate already admitted. One link per candidate — its
 * strongest anchor — because a candidate is one vehicle and may join this identity once.
 *
 * Max rather than mean over the gallery: a vehicle looks like itself from one angle and unlike
 * itself from another, and averaging a good view with a bad one throws the good view away.
 */
export function matchReachable(
  reachable: readonly ReachablePair[],
  embeddings: ReadonlyMap<string, readonly number[]>,
  config: ReidConfig,
): { links: ReidLink[]; compared: number } {
  const best = new Map<string, ReidLink>();
  let compared = 0;
  for (const pair of reachable) {
    const anchorVector = embeddings.get(pair.anchor.sightingId);
    const candidateVector = embeddings.get(pair.candidate.sightingId);
    if (anchorVector === undefined || candidateVector === undefined) continue;
    compared += 1;
    const similarity = cosine(anchorVector, candidateVector);
    if (similarity < config.similarityMin) continue;
    const existing = best.get(pair.candidate.sightingId);
    if (existing !== undefined && existing.similarity >= similarity) continue;
    best.set(pair.candidate.sightingId, {
      sightingId: pair.candidate.sightingId,
      sightingTs: pair.candidate.ts,
      anchorSightingId: pair.anchor.sightingId,
      cameraId: pair.candidate.cameraId,
      similarity: Math.round(similarity * 1e6) / 1e6,
      linkConfidence: linkConfidence(similarity, config.similarityMin),
      elapsedS: Math.round(pair.elapsedS * 1000) / 1000,
      expectedTravelTimeS: pair.expectedTravelTimeS,
      gate: pair.gate,
      explanation:
        `appearance match ${similarity.toFixed(3)} against a plate-read sighting on ` +
        `${pair.anchor.cameraId}, ${Math.round(pair.elapsedS)}s earlier` +
        (pair.expectedTravelTimeS === null
          ? ' (same camera, within the dwell window)'
          : ` (${Math.round(pair.expectedTravelTimeS)}s free-flow drive)`),
    });
  }
  return { links: [...best.values()], compared };
}

// ── the service ─────────────────────────────────────────────────────────────────────────────────

interface CandidateRow extends Record<string, unknown> {
  sighting_id: string;
  ts: string;
  camera_id: string;
  camera_external_id: string;
  lat: number | null;
  lon: number | null;
  best_shot_score: string;
}

interface EmbeddingRow extends Record<string, unknown> {
  sighting_id: string;
  embedding: number[] | string;
}

export class ReidBridgeService {
  constructor(
    private readonly db: Db,
    private readonly osrm: OsrmClient,
    private readonly config: ReidConfig = reidConfigFromEnv(),
  ) {}

  /**
   * Bridge one identity's trace: gallery from its plate-read sightings, candidates from best-shot
   * sightings nobody has claimed, gate, compare, write.
   *
   * Returns an empty result — not an error — when the feature is disabled. A caller asking for a
   * capability that is off should get "nothing was linked", with the reason, not an exception.
   */
  async bridge(trace: TraceResult, options: BridgeOptions = {}): Promise<ReidBridgeResult> {
    const startedAt = Date.now();
    const canonicalPlate = trace.identity?.canonicalPlate ?? trace.normalized;
    const empty = (anchors: number): ReidBridgeResult => ({
      canonicalPlate,
      enabled: this.config.enabled,
      embedderId: this.config.embedderId,
      anchors,
      anchorsWithEmbedding: 0,
      candidatesConsidered: 0,
      pairsGatedOut: 0,
      pairsCompared: 0,
      links: [],
      written: 0,
      measuredPrecision: REID_MEASURED_PRECISION,
      disclaimer: REID_DISCLAIMER,
      takenMs: Date.now() - startedAt,
    });

    if (!this.config.enabled || canonicalPlate === '') return empty(0);

    const anchors = anchorsOf(trace);
    if (anchors.length === 0) return empty(0);

    const candidates = await this.loadCandidates(trace, anchors, options);
    if (candidates.length === 0) return { ...empty(anchors.length), candidatesConsidered: 0 };

    // Batch the routing: one OSRM call per distinct ordered camera pair, not per candidate. D3-01
    // measured p95 route build at 125 ms for a 20-sighting trace, so the difference between 6 calls
    // and 600 is the difference between a usable request and a timeout.
    const travelTimes = await this.routeCameraPairs(anchors, candidates);
    const lookup: TravelTimeLookup = (from, to) =>
      travelTimes.get(`${from.cameraId}>${to.cameraId}`) ?? null;

    const { reachable, rejected } = gateCandidates(anchors, candidates, lookup, this.config);

    // Embeddings are fetched HERE — after the gate, for survivors only. A candidate that could not
    // have been this vehicle is never compared against, because its vector is never loaded.
    const wanted = new Set<string>();
    for (const pair of reachable) {
      wanted.add(pair.anchor.sightingId);
      wanted.add(pair.candidate.sightingId);
    }
    const embeddings = await this.loadEmbeddings([...wanted]);

    const { links, compared } = matchReachable(reachable, embeddings, this.config);
    const written =
      options.persist === false ? 0 : await this.persist(canonicalPlate, links, trace, options);

    return {
      canonicalPlate,
      enabled: true,
      embedderId: this.config.embedderId,
      anchors: anchors.length,
      anchorsWithEmbedding: anchors.filter((a) => embeddings.has(a.sightingId)).length,
      candidatesConsidered: candidates.length,
      pairsGatedOut: rejected.length,
      pairsCompared: compared,
      links,
      written,
      measuredPrecision: REID_MEASURED_PRECISION,
      disclaimer: REID_DISCLAIMER,
      takenMs: Date.now() - startedAt,
    };
  }

  /**
   * Best-shot sightings with a descriptor, in the trace's window, that no identity already owns.
   *
   * `not exists (select 1 from identity_sightings ...)` rather than a left join: a sighting already
   * attached to *any* identity is not a candidate, whichever identity that is, because claiming it
   * for a second one would assert one vehicle is two.
   */
  private async loadCandidates(
    trace: TraceResult,
    anchors: readonly ReidAnchor[],
    options: BridgeOptions,
  ): Promise<ReidCandidate[]> {
    const claimed = new Set(trace.sightings.map((s) => s.sightingId));
    const from = options.from ?? (trace.window.from === null ? null : new Date(trace.window.from));
    const to = options.to ?? (trace.window.to === null ? null : new Date(trace.window.to));
    const cameraIds = [...new Set(anchors.map((a) => a.cameraId))];

    // The candidate window is the anchor span widened by the gate's own ceiling on both sides —
    // anything further out is rejected by `gateReason` anyway, so fetching it would be work done to
    // be thrown away.
    const times = trace.sightings.map((s) => Date.parse(s.ts)).filter((t) => Number.isFinite(t));
    const pad = this.config.maxElapsedS * 1000;
    const lower = from ?? new Date(Math.min(...times) - pad);
    const upper = to ?? new Date(Math.max(...times) + pad);
    if (times.length === 0) return [];

    const rows = await this.db.execute<CandidateRow>(
      sql`select s.id::text as sighting_id,
                 s.ts,
                 s.camera_id::text as camera_id,
                 c.external_id as camera_external_id,
                 case when c.location is null then null else st_y(c.location::geometry) end as lat,
                 case when c.location is null then null else st_x(c.location::geometry) end as lon,
                 sa.best_shot_score::text as best_shot_score
            from sighting_appearance sa
            join sightings s on s.id = sa.sighting_id and s.ts = sa.sighting_ts
            join cameras c on c.id = s.camera_id
           where sa.embedder_id = ${this.config.embedderId}
             and sa.sighting_ts >= ${lower.toISOString()}
             and sa.sighting_ts <= ${upper.toISOString()}
             and sa.best_shot_score >= ${this.config.minBestShotScore}
             and not exists (
                   select 1 from identity_sightings isg where isg.sighting_id = s.id
                 )
           order by s.ts asc, s.id asc
           limit 500`,
    );
    void cameraIds;
    return rows
      .filter((row) => !claimed.has(row.sighting_id))
      .map((row) => ({
        sightingId: row.sighting_id,
        ts: new Date(row.ts).toISOString(),
        cameraId: row.camera_id,
        cameraExternalId: row.camera_external_id,
        lat: row.lat === null ? null : Number(row.lat),
        lon: row.lon === null ? null : Number(row.lon),
        located: row.lat !== null && row.lon !== null,
        bestShotScore: Number(row.best_shot_score),
      }));
  }

  private async routeCameraPairs(
    anchors: readonly ReidAnchor[],
    candidates: readonly ReidCandidate[],
  ): Promise<Map<string, number>> {
    const pairs = new Map<string, [ReidAnchor, ReidCandidate]>();
    for (const anchor of anchors) {
      for (const candidate of candidates) {
        if (anchor.cameraId === candidate.cameraId) continue;
        if (!anchor.located || !candidate.located) continue;
        pairs.set(`${anchor.cameraId}>${candidate.cameraId}`, [anchor, candidate]);
      }
    }
    const out = new Map<string, number>();
    await Promise.all(
      [...pairs.entries()].map(async ([key, [anchor, candidate]]) => {
        const route = await this.osrm.route(
          [anchor.lon as number, anchor.lat as number],
          [candidate.lon as number, candidate.lat as number],
        );
        if (route !== null) out.set(key, route.durationS);
      }),
    );
    return out;
  }

  private async loadEmbeddings(
    sightingIds: readonly string[],
  ): Promise<Map<string, readonly number[]>> {
    const out = new Map<string, readonly number[]>();
    if (sightingIds.length === 0) return out;
    const list = sql.join(
      sightingIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const rows = await this.db.execute<EmbeddingRow>(
      sql`select sighting_id::text as sighting_id, embedding
            from sighting_appearance
           where embedder_id = ${this.config.embedderId}
             and sighting_id in (${list})`,
    );
    for (const row of rows) {
      out.set(row.sighting_id, parseVector(row.embedding));
    }
    return out;
  }

  /**
   * Write the links, and audit the act.
   *
   * One transaction: the identity upsert, the `identity_sightings` rows and the audit entry land
   * together or not at all. `writeAudit` is called *inside* it (D3-04's rule) and the transaction is
   * kept short, because while it is open no other writer can append to the chain.
   *
   * `on conflict do nothing`: a plate link already on this sighting is a stronger claim and must not
   * be overwritten by a weaker one. `loadStoredLinks` (D2-08) surfaces whatever it finds verbatim,
   * so demoting an exact plate match to a re-ID bridge would be silently destructive.
   */
  private async persist(
    canonicalPlate: string,
    links: readonly ReidLink[],
    trace: TraceResult,
    options: BridgeOptions,
  ): Promise<number> {
    if (links.length === 0) return 0;
    let written = 0;
    await this.db.transaction(async (tx) => {
      const identity = await tx.execute<{ id: string }>(
        sql`insert into vehicle_identities (canonical_plate, first_seen, last_seen, sighting_count)
            values (${canonicalPlate},
                    ${trace.window.from ?? links[0]?.sightingTs ?? new Date().toISOString()}::timestamptz,
                    ${trace.window.to ?? links[0]?.sightingTs ?? new Date().toISOString()}::timestamptz,
                    0)
            on conflict (canonical_plate) do update
              set last_seen = greatest(vehicle_identities.last_seen, excluded.last_seen),
                  first_seen = least(vehicle_identities.first_seen, excluded.first_seen)
            returning id::text as id`,
      );
      const identityId = identity[0]?.id;
      if (identityId === undefined) return;
      for (const link of links) {
        const result = await tx.execute(
          sql`insert into identity_sightings
                (identity_id, sighting_id, sighting_ts, link_method, link_confidence)
              values (${identityId}::uuid, ${link.sightingId}::uuid,
                      ${link.sightingTs}::timestamptz, 'reid_bridge', ${link.linkConfidence})
              on conflict (identity_id, sighting_id) do nothing`,
        );
        void result;
        written += 1;
      }
      await writeAudit(tx, options.principal, {
        action: 'reid.bridge',
        targetType: 'vehicle',
        targetId: canonicalPlate,
        // NOT NULL in the schema, and machine-initiated rows still have to say what happened.
        purpose: options.purpose ?? 'automated appearance bridge for a plate-anchored trace',
        params: {
          embedderId: this.config.embedderId,
          similarityMin: this.config.similarityMin,
          measuredPrecision: REID_MEASURED_PRECISION,
          links: links.map((l) => ({
            sightingId: l.sightingId,
            anchorSightingId: l.anchorSightingId,
            similarity: l.similarity,
            linkConfidence: l.linkConfidence,
            gate: l.gate,
          })),
          disclaimer: REID_DISCLAIMER,
        },
        resultCount: links.length,
      });
    });
    return written;
  }
}

/**
 * The gallery: the trace's own plate-read sightings.
 *
 * Seeded only from `plate_exact` / `plate_fuzzy` links — never from a `reid_bridge` one. An identity
 * bootstrapped from an appearance link would compound its own error, and at 0.761 precision the
 * second hop would be wrong nearly half the time.
 */
export function anchorsOf(trace: TraceResult): ReidAnchor[] {
  return trace.sightings
    .filter((s: TraceSighting) => s.linkMethod !== 'reid_bridge' && s.isBestShot)
    .map((s) => ({
      sightingId: s.sightingId,
      ts: s.ts,
      cameraId: s.cameraId,
      lat: s.lat,
      lon: s.lon,
      located: s.located,
    }));
}

/** Postgres returns `real[]` as an array through the driver, or as `{1,2,3}` text through `execute`. */
function parseVector(value: number[] | string): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return value
    .replace(/^[{[]|[}\]]$/g, '')
    .split(',')
    .filter((part) => part.trim() !== '')
    .map(Number);
}
