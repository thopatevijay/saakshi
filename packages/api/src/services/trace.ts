/**
 * Vehicle trace v1 (D2-08) — the graded live test case.
 *
 * The jury hands us a registration number and expects the vehicle's complete route with
 * timestamped, location-wise movement history. This service produces that, and it is careful about
 * exactly one thing above all others: **which parts of the answer are observed and which are
 * inferred.**
 *
 * ## The three claims in a trace, and their very different strengths
 *
 * | claim | strength | where it lives |
 * |---|---|---|
 * | "this camera detected a vehicle at this PTS-derived instant" | **observed** — a real YOLO11 detection with a real timestamp | `TraceSighting.basis === 'observed'` |
 * | "that vehicle is the registration you asked for" | **inferred** — `linkMethod` + `linkConfidence` say how strongly | `TraceSighting.linkMethod` |
 * | "the vehicle travelled from this camera to the next one" | **inferred** — nothing observed it in between | `TraceSegment.basis === 'inferred'` |
 *
 * Collapsing those into one confident polyline is the failure mode this file exists to avoid.
 * `CLAUDE.md` forbids implying certainty the data does not support, and on this estate the data
 * supports very little: D2-01 measured **0 exact plate reads** across a 120-instance hand-labelled
 * sample, because only 3 of those instances carried a human-legible plate at all. A trace here is
 * built out of detections and attributes far more often than out of confirmed identity, and the
 * payload says so in `claims` rather than leaving the UI to guess.
 *
 * ## Ordering
 *
 * **`ts`, never `ingested_at`.** `sightings.ts` is the wall-clock mapping of the frame's
 * presentation timestamp (D1-09). Arrival-time ordering is wrong here for a specific, measured
 * reason: the sandbox gateway replays a buffered GOP on connect, so frames arrive out of order
 * relative to the content clock after every reconnect, and reconnects are routine because the feeds
 * loop. Ties break on `frame_pts_ms` and then on `id`, so the order is total and stable.
 *
 * ## Why this does not do its own plate lookup
 *
 * D2-04's handoff is explicit: `PlateSearchService` is the matcher, and a trace that rolled its own
 * would be able to disagree with `GET /api/v1/plates/search` about which reads belong to which
 * vehicle. So candidate *resolution* is entirely D2-04's, via `resolveIdentity`. What this file
 * adds is the **ordered hydration** of those plates' sightings — every column the map, the timeline
 * and the evidence strip need (`track_id`, colour, crop, best-shot flag, camera coordinates), in
 * chronological order, with no per-candidate cap that would silently drop the oldest end of a
 * route. `plate-search`'s `refs()` deliberately returns the newest N per candidate; for a trace,
 * truncating the *start* of a journey is the one truncation you must not do.
 *
 * ## `track_id` is not a vehicle identity
 *
 * D1-09: `track_id = session_index * 100_000 + tracker_id`, unique only within one tracking
 * session on one camera, and a session ends at every scene cut and every reconnect. Raw ByteTrack
 * ids 1 and 2 were measured being reused across sessions 6 and 9 on `cam03` inside a single run.
 * Nothing here joins or groups on `track_id`; it is surfaced, split into its session and raw parts,
 * purely so an operator can see that two pins belong to different tracking sessions. Grouping, when
 * it happens, is on `(camera_id, track_id)`.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  DEFAULT_EXPIRING_SOON_HOURS,
  describeRetention,
  type RetentionStatus,
} from '@saakshi/shared';
import type { Db } from '../db/client.js';
import {
  loadStoredLinks,
  resolveIdentity,
  sightingLinkConfidence,
  type LinkedPlate,
  type LinkMethod,
  type ResolvedIdentity,
} from './identity.js';
import { PlateSearchService, type PlateSearchResult } from './plate-search.js';

/** Hard ceiling on hydrated sightings, so one very busy plate cannot exhaust the pool. */
export const MAX_TRACE_SIGHTINGS = 2000;

export const TRACE_DISCLAIMER =
  'A trace is a set of observed detections plus an inferred identity link. Each sighting happened; ' +
  'that every sighting is the same vehicle is a claim with a confidence, and the segments between ' +
  'them are inferred — nothing observed the vehicle in between. Fuzzy links are ranked ' +
  'possibilities, not identifications. Measured plate accuracy: docs/anpr-accuracy.md; measured ' +
  'matcher precision and recall: docs/fuzzy-matching.md §6.';

export type TraceEmptyReason =
  'query_not_searchable' | 'no_matching_plate' | 'no_sightings_in_window' | 'below_min_confidence';

export interface TraceSighting {
  /** 1-based position in chronological order. What the map pin and the timeline both label. */
  seq: number;
  sightingId: string;
  /** PTS-derived wall clock. The ordering key. Never `ingested_at`. */
  ts: string;
  framePtsMs: number;

  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  district: string | null;
  lat: number | null;
  lon: number | null;
  /**
   * `false` when the camera has no coordinates — the normal case on this estate, where the Sentinel
   * catalogue publishes `{id, name}` only and 0 of 30 cameras are placed. An unplaced sighting is
   * still a real sighting with a real time; it just cannot be drawn on a map.
   */
  located: boolean;

  /** Tracker-local, session-qualified. Never an identity. Split out so the UI can show both. */
  trackId: number;
  trackingSession: number;
  rawTrackerId: number;

  class: string;
  detConfidence: number;
  vehicleColor: string | null;
  vehicleColorConfidence: number | null;
  attributesLowConfidence: boolean | null;
  isBestShot: boolean;

  /** `s3://bucket/key`, as stored. `null` when no crop was kept for this sighting. */
  cropUri: string | null;
  /** A time-limited HTTP URL for `cropUri`, or `null` when no object store is configured. */
  cropUrl: string | null;

  plateNormalized: string;
  plateRawText: string;
  ocrConfidence: number;
  voteCount: number;

  linkMethod: LinkMethod;
  /** `matchStrength × ocrConfidence`, in `[0,1]`. What `min_confidence` filters on. */
  linkConfidence: number;
  /** Weighted distance under `config/plate-confusions.json`. Never rendered on its own. */
  matchDistance: number | null;
  matchStrength: number | null;
  explanation: string;

  /** The detection itself. Always `'observed'` — a trace never invents a sighting. */
  basis: 'observed';

  /**
   * How long the **source footage** behind this sighting survives (D3-05).
   *
   * Per sighting rather than per camera, because a trace can span days and the same camera's
   * footage from Monday and from Thursday are on different clocks. Computed at read time against
   * the sighting's PTS-derived `ts` — never stored, and deliberately not carried into the route
   * cache, because a countdown baked into a cached answer is wrong the moment after it is written.
   *
   * `state: 'unknown'` when the owning department declared no retention period, which is every
   * camera on the sandbox estate. It is never defaulted to a window nobody stated.
   */
  retention: RetentionStatus;
}

/**
 * The gap between two consecutive sightings. **Always inferred.**
 *
 * v1 states the gap honestly and refuses to draw conclusions from it: `straightLineKm` is a lower
 * bound on the distance travelled and `impliedSpeedKmh` is therefore an *upper* bound on the
 * average speed, both `null` when either camera is unplaced. D3-01 replaces this with road-graph
 * reconstruction and D3-02 turns the speed bound into impossible-transition detection; both consume
 * exactly this shape.
 */
export interface TraceSegment {
  fromSeq: number;
  toSeq: number;
  fromSightingId: string;
  toSightingId: string;
  fromCameraId: string;
  toCameraId: string;
  gapSeconds: number;
  /** `true` when both sightings are on the same camera — no transition is being claimed at all. */
  sameCamera: boolean;
  straightLineKm: number | null;
  impliedSpeedKmh: number | null;
  basis: 'inferred';
  note: string;
}

export interface TraceCamera {
  cameraId: string;
  externalId: string;
  name: string;
  district: string | null;
  lat: number | null;
  lon: number | null;
  located: boolean;
  sightingCount: number;
  firstSeq: number;
}

export interface TraceCoverage {
  /** Sightings returned after the confidence filter. */
  sightings: number;
  cameras: number;
  /** Of those cameras, how many carry coordinates. 0 on the real estate — that is a finding. */
  camerasPlaced: number;
  sightingsMappable: number;
  sightingsWithCrop: number;
  exactLinks: number;
  fuzzyLinks: number;
  otherLinks: number;
  /** Candidate sightings dropped by `min_confidence`. */
  droppedBelowConfidence: number;
  /** `true` when `MAX_TRACE_SIGHTINGS` or `limit` cut the result short. */
  truncated: boolean;
}

export interface TraceResult {
  query: string;
  normalized: string;
  validity: PlateSearchResult['validity'];
  reason: PlateSearchResult['reason'];
  searched: boolean;
  window: { from: string | null; to: string | null };
  minConfidence: number;
  maxDistance: number;
  matcher: string;
  identity: ResolvedIdentity | null;
  sightings: TraceSighting[];
  segments: TraceSegment[];
  cameras: TraceCamera[];
  coverage: TraceCoverage;
  claims: { observed: string; inferred: string };
  emptyReason: TraceEmptyReason | null;
  disclaimer: string;
  tookMs: number;
}

export interface TraceOptions {
  from?: Date | undefined;
  to?: Date | undefined;
  cameraIds?: string[] | undefined;
  minConfidence?: number;
  maxDistance?: number;
  limit?: number;
}

const CLAIMS = {
  observed:
    'Every sighting below is a detection that happened: a real frame, a real camera, a wall-clock ' +
    'time derived from the frame presentation timestamp.',
  inferred:
    'That the sightings are the same vehicle is inferred from the plate read, with the confidence ' +
    'and method shown against each one. The path between two sightings is inferred entirely — no ' +
    'camera observed the vehicle between them.',
} as const;

/** Presigns an evidence crop for the browser. `null` when no object store is configured. */
export type CropPresigner = (cropUri: string) => string | null;

interface TraceRow extends Record<string, unknown> {
  sighting_id: string;
  ts: string;
  frame_pts_ms: string;
  track_id: number;
  camera_id: string;
  camera_external_id: string;
  camera_name: string;
  district: string | null;
  lat: number | null;
  lon: number | null;
  class: string;
  det_confidence: string;
  vehicle_color: string | null;
  vehicle_color_confidence: string | null;
  attributes_low_confidence: boolean | null;
  is_best_shot: boolean;
  sighting_crop_uri: string | null;
  plate_crop_uri: string | null;
  plate: string;
  raw_text: string;
  ocr_confidence: string;
  vote_count: number;
  /** The owning department's declared retention window (D3-05). `null` = it declared none. */
  retention_days: number | null;
}

export class TraceService {
  private readonly db: Db;
  private readonly search: PlateSearchService;
  private readonly presign: CropPresigner;

  private readonly expiringSoonHours: number;

  constructor(
    db: Db,
    search?: PlateSearchService,
    presign?: CropPresigner,
    /** `RETENTION_EXPIRING_SOON_HOURS` (D3-05). Passed in so this module needs no `Env`. */
    expiringSoonHours?: number,
  ) {
    this.db = db;
    this.search = search ?? new PlateSearchService(db);
    this.presign = presign ?? (() => null);
    this.expiringSoonHours = expiringSoonHours ?? DEFAULT_EXPIRING_SOON_HOURS;
  }

  async trace(rawQuery: string, options: TraceOptions = {}): Promise<TraceResult> {
    const started = Date.now();
    const minConfidence = options.minConfidence ?? 0;
    const maxDistance = options.maxDistance ?? 2;
    const limit = Math.min(options.limit ?? MAX_TRACE_SIGHTINGS, MAX_TRACE_SIGHTINGS);

    // D2-04 owns candidate resolution. `sightingsPerCandidate: 1` because this call is being used
    // for ranking only — the ordered hydration below fetches the sightings, without the
    // newest-first cap that would truncate the start of a journey.
    const searchResult = await this.search.search(rawQuery, {
      maxDistance,
      limit: 25,
      sightingsPerCandidate: 1,
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.to !== undefined ? { to: options.to } : {}),
      ...(options.cameraIds !== undefined ? { cameraIds: options.cameraIds } : {}),
    });

    const identity = resolveIdentity(searchResult, { minConfidence });
    const base = this.emptyShell(rawQuery, searchResult, options, minConfidence, maxDistance);

    if (!searchResult.searched) {
      return {
        ...base,
        identity: null,
        emptyReason: 'query_not_searchable',
        tookMs: elapsed(started),
      };
    }
    if (identity.plates.length === 0) {
      const reason: TraceEmptyReason =
        searchResult.candidates.length > 0 ? 'below_min_confidence' : 'no_matching_plate';
      return { ...base, identity, emptyReason: reason, tookMs: elapsed(started) };
    }

    const byPlate = new Map(identity.plates.map((p) => [p.plateNormalized, p]));
    const rows = await this.hydrate([...byPlate.keys()], options, limit);
    const stored = await loadStoredLinks(this.db, identity.canonicalPlate);

    // Sightings the confidence floor removed *before* hydration, because their plate's best read
    // could not clear it. Counted here rather than left invisible: an operator who raises the floor
    // and watches the trace shrink beside "0 below the confidence floor" is being told the count
    // fell for some other reason, which is worse than not reporting it at all.
    let dropped = searchResult.candidates
      .filter(
        (c) =>
          !byPlate.has(c.plateNormalized) &&
          sightingLinkConfidence(c.matchStrength, c.ocrConfidence) < minConfidence,
      )
      .reduce((n, c) => n + c.sightingCount, 0);
    const sightings: TraceSighting[] = [];
    for (const row of rows) {
      const plate = byPlate.get(row.plate);
      if (plate === undefined) continue;
      const sighting = this.toSighting(row, plate, stored, sightings.length + 1);
      if (sighting.linkConfidence < minConfidence) {
        dropped += 1;
        continue;
      }
      sightings.push(sighting);
    }
    // The filter runs after numbering, so renumber to keep `seq` dense and 1-based.
    sightings.forEach((s, i) => {
      s.seq = i + 1;
    });

    const cameras = summariseCameras(sightings);
    const segments = buildSegments(sightings);

    return {
      ...base,
      identity,
      sightings,
      segments,
      cameras,
      coverage: {
        sightings: sightings.length,
        cameras: cameras.length,
        camerasPlaced: cameras.filter((c) => c.located).length,
        sightingsMappable: sightings.filter((s) => s.located).length,
        sightingsWithCrop: sightings.filter((s) => s.cropUri !== null).length,
        exactLinks: sightings.filter((s) => s.linkMethod === 'plate_exact').length,
        fuzzyLinks: sightings.filter((s) => s.linkMethod === 'plate_fuzzy').length,
        otherLinks: sightings.filter((s) => s.linkMethod === 'reid_bridge').length,
        droppedBelowConfidence: dropped,
        truncated: rows.length >= limit,
      },
      emptyReason: sightings.length === 0 ? emptyReasonFor(dropped) : null,
      tookMs: elapsed(started),
    };
  }

  private emptyShell(
    rawQuery: string,
    searchResult: PlateSearchResult,
    options: TraceOptions,
    minConfidence: number,
    maxDistance: number,
  ): Omit<TraceResult, 'identity' | 'emptyReason' | 'tookMs'> {
    return {
      query: rawQuery,
      normalized: searchResult.normalized,
      validity: searchResult.validity,
      reason: searchResult.reason,
      searched: searchResult.searched,
      window: {
        from: options.from?.toISOString() ?? null,
        to: options.to?.toISOString() ?? null,
      },
      minConfidence,
      maxDistance,
      matcher: searchResult.matcher,
      sightings: [],
      segments: [],
      cameras: [],
      coverage: {
        sightings: 0,
        cameras: 0,
        camerasPlaced: 0,
        sightingsMappable: 0,
        sightingsWithCrop: 0,
        exactLinks: 0,
        fuzzyLinks: 0,
        otherLinks: 0,
        droppedBelowConfidence: 0,
        truncated: false,
      },
      claims: CLAIMS,
      disclaimer: TRACE_DISCLAIMER,
    };
  }

  /**
   * Ordered hydration.
   *
   * `distinct on (s.id, s.ts)` because a sighting can carry several reads — D2-01 votes over
   * roughly three frames per pass — and a trace must show one pin per sighting, not one per read.
   * The strongest read wins, which is the same read `plate_reads.is_best_shot` marks when D2-01 has
   * chosen one, and a deterministic tiebreak on `pr.id` when it has not.
   *
   * `s.ts` carries the hypertable's partitioning column into the join, so the planner can exclude
   * chunks rather than scanning every daily chunk for a bare id (migration 0005's note).
   */
  private async hydrate(
    plates: string[],
    options: TraceOptions,
    limit: number,
  ): Promise<TraceRow[]> {
    if (plates.length === 0) return [];
    return this.db.execute<TraceRow>(sql`
      select * from (
        select distinct on (s.id, s.ts)
               s.id::text as sighting_id,
               s.ts,
               s.frame_pts_ms::text as frame_pts_ms,
               s.track_id,
               s.camera_id::text as camera_id,
               c.external_id as camera_external_id,
               c.name as camera_name,
               c.district,
               c.retention_days,
               case when c.location is null then null else st_y(c.location::geometry) end as lat,
               case when c.location is null then null else st_x(c.location::geometry) end as lon,
               s.class::text as class,
               s.det_confidence::text as det_confidence,
               s.vehicle_color,
               s.vehicle_color_confidence::text as vehicle_color_confidence,
               s.attributes_low_confidence,
               s.is_best_shot,
               s.crop_uri as sighting_crop_uri,
               pr.crop_uri as plate_crop_uri,
               pr.normalized_text as plate,
               pr.raw_text,
               pr.confidence::text as ocr_confidence,
               pr.vote_count
          from plate_reads pr
          join sightings s on s.id = pr.sighting_id and s.ts = pr.sighting_ts
          join cameras c on c.id = s.camera_id
         where pr.normalized_text in ${plates}
           ${traceWindowClause(options)}
         order by s.id, s.ts, pr.confidence desc, pr.id
      ) hydrated
      -- PTS-derived wall clock, never insertion order. Ties break so the order is total and stable.
      order by hydrated.ts asc, hydrated.frame_pts_ms asc, hydrated.sighting_id asc
      limit ${limit}
    `);
  }

  private toSighting(
    row: TraceRow,
    plate: LinkedPlate,
    stored: Map<string, { linkMethod: LinkMethod; linkConfidence: number }>,
    seq: number,
  ): TraceSighting {
    const ocrConfidence = Number(row.ocr_confidence);
    const override = stored.get(row.sighting_id);
    // A recorded link wins over a derived one: something else asserted it deliberately, and
    // silently overwriting that with a plate score would hide a weaker claim behind a stronger one.
    const linkMethod = override?.linkMethod ?? plate.linkMethod;
    const linkConfidence =
      override?.linkConfidence ?? sightingLinkConfidence(plate.matchStrength, ocrConfidence);
    const derived = override === undefined;
    const cropUri = row.plate_crop_uri ?? row.sighting_crop_uri;

    return {
      seq,
      sightingId: row.sighting_id,
      ts: new Date(row.ts).toISOString(),
      framePtsMs: Number(row.frame_pts_ms),
      cameraId: row.camera_id,
      cameraExternalId: row.camera_external_id,
      cameraName: row.camera_name,
      district: row.district,
      lat: row.lat === null ? null : Number(row.lat),
      lon: row.lon === null ? null : Number(row.lon),
      located: row.lat !== null && row.lon !== null,
      trackId: row.track_id,
      trackingSession: Math.trunc(row.track_id / TRACK_SESSION_STRIDE),
      rawTrackerId: row.track_id % TRACK_SESSION_STRIDE,
      class: row.class,
      detConfidence: Number(row.det_confidence),
      vehicleColor: row.vehicle_color,
      vehicleColorConfidence:
        row.vehicle_color_confidence === null ? null : Number(row.vehicle_color_confidence),
      attributesLowConfidence: row.attributes_low_confidence,
      isBestShot: row.is_best_shot,
      cropUri,
      cropUrl: cropUri === null ? null : this.presign(cropUri),
      plateNormalized: row.plate,
      plateRawText: row.raw_text,
      ocrConfidence,
      voteCount: row.vote_count,
      linkMethod,
      linkConfidence,
      matchDistance: derived ? plate.distance : null,
      matchStrength: derived ? plate.matchStrength : null,
      explanation: derived
        ? plate.explanation
        : `link recorded in identity_sightings as ${linkMethod}, confidence ${linkConfidence.toFixed(2)}`,
      basis: 'observed',
      retention: describeRetention({
        footageAt: row.ts,
        retentionDays: row.retention_days,
        expiringSoonHours: this.expiringSoonHours,
      }),
    };
  }
}

/**
 * D1-09's `TRACK_SESSION_STRIDE`. A tracking session ends at every scene cut and every reconnect,
 * so the same raw ByteTrack id recurs many times on one camera; the stride is what keeps
 * `(camera_id, track_id)` a safe grouping key.
 */
export const TRACK_SESSION_STRIDE = 100_000;

function elapsed(started: number): number {
  return Date.now() - started;
}

function emptyReasonFor(dropped: number): TraceEmptyReason {
  return dropped > 0 ? 'below_min_confidence' : 'no_sightings_in_window';
}

function traceWindowClause(options: TraceOptions): SQL {
  const parts: SQL[] = [];
  if (options.from !== undefined) parts.push(sql` and s.ts >= ${options.from.toISOString()}`);
  if (options.to !== undefined) parts.push(sql` and s.ts <= ${options.to.toISOString()}`);
  if (options.cameraIds !== undefined && options.cameraIds.length > 0) {
    parts.push(sql` and s.camera_id in ${options.cameraIds.map((id) => sql`${id}::uuid`)}`);
  }
  return sql.join(parts, sql``);
}

function summariseCameras(sightings: TraceSighting[]): TraceCamera[] {
  const out = new Map<string, TraceCamera>();
  for (const s of sightings) {
    const existing = out.get(s.cameraId);
    if (existing === undefined) {
      out.set(s.cameraId, {
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
    } else {
      existing.sightingCount += 1;
    }
  }
  return [...out.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}

/**
 * One segment per consecutive pair. A single-sighting trace produces none, which is the degenerate
 * case the ticket calls out — there is no arithmetic here that a length of 1 can divide by.
 */
export function buildSegments(sightings: TraceSighting[]): TraceSegment[] {
  const segments: TraceSegment[] = [];
  for (let i = 1; i < sightings.length; i += 1) {
    const a = sightings[i - 1];
    const b = sightings[i];
    if (a === undefined || b === undefined) continue;

    const gapSeconds = (Date.parse(b.ts) - Date.parse(a.ts)) / 1000;
    const sameCamera = a.cameraId === b.cameraId;
    const km = sameCamera ? 0 : haversineKm(a, b);
    // Guard the division rather than the display: a zero gap is normal at ~4 fps, and an Infinity
    // reaching the UI would be read as a measurement.
    const speed = km === null || gapSeconds <= 0 ? null : round(km / (gapSeconds / 3600), 1);

    segments.push({
      fromSeq: a.seq,
      toSeq: b.seq,
      fromSightingId: a.sightingId,
      toSightingId: b.sightingId,
      fromCameraId: a.cameraId,
      toCameraId: b.cameraId,
      gapSeconds: round(gapSeconds, 3),
      sameCamera,
      straightLineKm: km === null ? null : round(km, 3),
      impliedSpeedKmh: speed,
      basis: 'inferred',
      note: noteFor(sameCamera, km),
    });
  }
  return segments;
}

function noteFor(sameCamera: boolean, km: number | null): string {
  if (sameCamera) return 'same camera — no transition claimed';
  if (km === null) {
    return (
      'one or both cameras have no coordinates, so no distance can be computed — the ' +
      'catalogue publishes no location for this estate'
    );
  }
  return (
    'straight-line lower bound on distance; the implied speed is therefore an upper bound. ' +
    'Road-graph reconstruction is D3-01.'
  );
}

function haversineKm(
  a: { lat: number | null; lon: number | null },
  b: { lat: number | null; lon: number | null },
): number | null {
  if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return null;
  const R = 6371.0088;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
