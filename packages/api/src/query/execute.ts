/**
 * Running a compiled filter (D3-09).
 *
 * **The read-only transaction is the load-bearing safety property, so be exact about what it
 * proves.** Every compiled query runs inside `begin` … `set transaction read only`, which makes
 * Postgres itself refuse any `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE` or `DROP` with
 * `25006 read_only_sql_transaction`. That is not our care being careful — it is the database
 * declining, in a way that holds even if every other defence in this package were removed. The
 * injection suite asserts it by attempting a write inside exactly this transaction and reading back
 * the SQLSTATE.
 *
 * What it does *not* prove: it is not a defence against reading too much. A read-only transaction
 * will happily return every sighting in the estate. That is what purpose binding (D3-04), the row
 * limit, and the officer's review of the filter before it runs are for. Three mechanisms, three
 * different failure modes, and it is worth not confusing them.
 *
 * **Fuzzy registrations are resolved by D2-04's matcher, never by anything here.** `#18`'s handoff
 * is explicit — reuse `PlateSearchService`, do not reimplement — and the reasons are measured: the
 * distance is fractional and weighted rather than levenshtein, truncation is charged as truncation,
 * and a read the plate grammar refuses (`no_letters` / `no_digits` / `empty` / `too_short`) must
 * produce nothing rather than a wide net.
 */
import { sql } from 'drizzle-orm';
import { evaluatePlateRead, type QueryDSL } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import { PlateSearchService } from '../services/plate-search.js';
import { compileQuery, renderQuery } from './sql.js';

export interface QuerySightingRow {
  sightingId: string;
  ts: string;
  framePtsMs: number;
  trackId: number;
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  district: string | null;
  lat: number | null;
  lon: number | null;
  class: string;
  detConfidence: number;
  vehicleColor: string | null;
  isBestShot: boolean;
  cropUri: string | null;
  plateNormalized: string | null;
  plateRawText: string | null;
  ocrConfidence: number | null;
}

export interface QueryCameraRow {
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  district: string | null;
  lat: number | null;
  lon: number | null;
  sightingCount: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Why a run came back with nothing.
 *
 * The same discipline D2-08 (#22) applied to the trace: an empty result is an *answer*, and four
 * unrelated situations must not all render as "no results". `plate_not_searchable` is D2-04's
 * refusal, `no_matching_plate` is a registration nobody has read, `no_rows` is a filter that ran
 * and matched nothing, and `unknown_camera` is a question naming a camera the estate does not have
 * — which is the one an officer can fix by rephrasing.
 */
export type QueryEmptyReason =
  | 'plate_not_searchable'
  | 'no_matching_plate'
  | 'unknown_camera'
  | 'no_rows';

export interface QueryRunResult {
  entity: 'sightings' | 'cameras';
  sightings: QuerySightingRow[];
  cameras: QueryCameraRow[];
  /** Registrations D2-04's matcher resolved the plate filter to, with their weighted distances. */
  resolvedPlates: { plate: string; distance: number; matchType: 'exact' | 'fuzzy' }[];
  /** Camera ids named in the question that the catalogue does not contain. */
  unknownCameras: string[];
  /**
   * Districts named in the compiled filter that no camera is in.
   *
   * Measured need, not a hypothetical: a local 7B compiling "…passed Sector 18…" put `Sector 18`
   * into `districts`, where the estate has no such district, which silently narrows the result to
   * nothing. Reporting it turns an invisible wrong answer into a visible one the officer can edit.
   */
  unknownDistricts: string[];
  rowCount: number;
  emptyReason: QueryEmptyReason | null;
  tookMs: number;
  /** The generated SQL, parameter values redacted, so the console can show what actually ran. */
  sqlPreview: string;
  disclaimer: string;
}

export const QUERY_DISCLAIMER =
  'The filter above was written by a language model, reviewed by the officer who ran it, and ' +
  'executed by the database. The model never saw a result row and did not summarise anything on ' +
  'this page. Sightings are observed; that two sightings are the same vehicle is inferred from a ' +
  'plate read, with the confidence shown. There is no live VAHAN, SARTHI, eGujCop, AFIS or NAFIS ' +
  'connectivity, and no biometric processing of any kind.';

export class QueryExecutor {
  constructor(private readonly db: Db) {}

  async run(dsl: QueryDSL): Promise<QueryRunResult> {
    const startedAt = Date.now();

    const resolution = await this.resolvePlates(dsl);
    const { unknownCameras, unknownDistricts } = await this.unknownNames(dsl);
    const compiled = compileQuery(dsl, resolution.plates.map((p) => p.plate));

    const rows = await this.readOnly(compiled.query);

    const sightings = dsl.entity === 'sightings' || dsl.sequence !== null ? rows.map(toSighting) : [];
    const cameras = dsl.entity === 'cameras' && dsl.sequence === null ? rows.map(toCamera) : [];
    const rowCount = sightings.length + cameras.length;

    return {
      entity: dsl.entity,
      sightings,
      cameras,
      resolvedPlates: resolution.plates,
      unknownCameras,
      unknownDistricts,
      rowCount,
      emptyReason:
        rowCount > 0
          ? null
          : emptyReasonFor(dsl, resolution, [...unknownCameras, ...unknownDistricts]),
      tookMs: Date.now() - startedAt,
      sqlPreview: previewOf(compiled.query),
      disclaimer: QUERY_DISCLAIMER,
    };
  }

  /**
   * Runs one statement in a transaction Postgres will not let write.
   *
   * `unsafe` here is drizzle's name for "this string is the statement", and the string is a
   * compile-time literal with no interpolation of any kind — it is the one place in this package
   * where a fixed statement has to be issued outside the tagged template, because `SET TRANSACTION`
   * takes no parameters.
   */
  private async readOnly(query: ReturnType<typeof compileQuery>['query']): Promise<QueryRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return (await tx.execute<QueryRow>(query)) as unknown as QueryRow[];
    });
  }

  /**
   * Turns the DSL's plate filter into a concrete set of registrations, through D2-04's matcher.
   *
   * `exact` still goes through `evaluatePlateRead` first, because a query is a read like any other
   * and the grammar's refusal codes apply to it: `757508300` — the cam05 hoarding's phone number,
   * and the highest-confidence read of the whole live run — must not be searchable as a
   * registration from here any more than from anywhere else.
   */
  private async resolvePlates(dsl: QueryDSL): Promise<PlateResolution> {
    const filter = dsl.filters.plate;
    if (filter === null) return { searched: false, refused: false, plates: [] };

    // Confidence 1: this is an officer's typed query, not an OCR read, so there is no measured
    // confidence to down-weight. The grammar verdict is what we are after.
    const verdict = evaluatePlateRead(filter.pattern, 1);
    const refusal = verdict.reasons[0]?.code;
    if (
      refusal === 'no_letters' ||
      refusal === 'no_digits' ||
      refusal === 'empty' ||
      refusal === 'too_short'
    ) {
      return { searched: false, refused: true, plates: [] };
    }

    if (filter.mode === 'exact') {
      const plate = verdict.normalizedText === '' ? filter.pattern : verdict.normalizedText;
      return {
        searched: true,
        refused: false,
        plates: [{ plate, distance: 0, matchType: 'exact' as const }],
      };
    }

    const search = await new PlateSearchService(this.db).search(filter.pattern, {
      // Never above 2 — D2-04 measured 3.0 at 91.2% precision and 4.0 at 54.8%, and the DSL type
      // already refuses a higher value. `Math.min` is belt and braces for a hand-edited filter.
      maxDistance: Math.min(filter.maxDistance, 2),
      limit: 25,
      ...(dsl.filters.time.from !== null ? { from: new Date(dsl.filters.time.from) } : {}),
      ...(dsl.filters.time.to !== null ? { to: new Date(dsl.filters.time.to) } : {}),
    });

    if (!search.searched) return { searched: false, refused: true, plates: [] };
    return {
      searched: true,
      refused: false,
      plates: search.candidates.map((c) => ({
        plate: c.plateNormalized,
        // Fractional and weighted, never bucketed or rounded to an integer (#18).
        distance: c.distance,
        matchType: c.matchType,
      })),
    };
  }

  /**
   * Camera ids and districts the filter named that the catalogue does not hold.
   *
   * Reported rather than silently ignored: "cam99 has no sightings" and "there is no cam99" are
   * different answers, and only one of them means the officer should try a different name. This is
   * the check that catches a model grounding a place onto a name it invented.
   */
  private async unknownNames(
    dsl: QueryDSL,
  ): Promise<{ unknownCameras: string[]; unknownDistricts: string[] }> {
    const cameras = unique([
      ...dsl.filters.place.cameraExternalIds,
      ...(dsl.sequence?.place.cameraExternalIds ?? []),
    ]);
    const districts = unique([
      ...dsl.filters.place.districts,
      ...(dsl.sequence?.place.districts ?? []),
    ]);
    if (cameras.length === 0 && districts.length === 0) {
      return { unknownCameras: [], unknownDistricts: [] };
    }

    const rows = (await this.db.execute<{ external_id: string; district: string | null }>(sql`
      select external_id, district from cameras
    `)) as unknown as { external_id: string; district: string | null }[];
    const knownCameras = new Set(rows.map((r) => r.external_id));
    const knownDistricts = new Set(
      rows.map((r) => r.district).filter((d): d is string => d !== null),
    );

    return {
      unknownCameras: cameras.filter((id) => !knownCameras.has(id)),
      unknownDistricts: districts.filter((d) => !knownDistricts.has(d)),
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

interface PlateResolution {
  searched: boolean;
  refused: boolean;
  plates: { plate: string; distance: number; matchType: 'exact' | 'fuzzy' }[];
}

function emptyReasonFor(
  dsl: QueryDSL,
  resolution: PlateResolution,
  unknownNames: string[],
): QueryEmptyReason {
  if (resolution.refused) return 'plate_not_searchable';
  if (dsl.filters.plate !== null && resolution.plates.length === 0) return 'no_matching_plate';
  if (unknownNames.length > 0) return 'unknown_camera';
  return 'no_rows';
}

interface QueryRow extends Record<string, unknown> {
  sighting_id?: string;
  ts?: string | Date;
  frame_pts_ms?: string;
  track_id?: number;
  camera_id: string;
  camera_external_id: string;
  camera_name: string;
  district: string | null;
  lat: number | string | null;
  lon: number | string | null;
  class?: string;
  det_confidence?: string;
  vehicle_color?: string | null;
  is_best_shot?: boolean;
  crop_uri?: string | null;
  plate_normalized?: string | null;
  plate_raw_text?: string | null;
  ocr_confidence?: string | null;
  sighting_count?: string;
  first_seen?: string | Date;
  last_seen?: string | Date;
}

function toSighting(row: QueryRow): QuerySightingRow {
  return {
    sightingId: row.sighting_id ?? '',
    ts: iso(row.ts),
    framePtsMs: Number(row.frame_pts_ms ?? 0),
    trackId: Number(row.track_id ?? 0),
    cameraId: row.camera_id,
    cameraExternalId: row.camera_external_id,
    cameraName: row.camera_name,
    district: row.district,
    lat: num(row.lat),
    lon: num(row.lon),
    class: row.class ?? 'unknown',
    detConfidence: Number(row.det_confidence ?? 0),
    vehicleColor: row.vehicle_color ?? null,
    isBestShot: row.is_best_shot ?? false,
    cropUri: row.crop_uri ?? null,
    plateNormalized: row.plate_normalized ?? null,
    plateRawText: row.plate_raw_text ?? null,
    ocrConfidence: row.ocr_confidence === null || row.ocr_confidence === undefined
      ? null
      : Number(row.ocr_confidence),
  };
}

function toCamera(row: QueryRow): QueryCameraRow {
  return {
    cameraId: row.camera_id,
    cameraExternalId: row.camera_external_id,
    cameraName: row.camera_name,
    district: row.district,
    lat: num(row.lat),
    lon: num(row.lon),
    sightingCount: Number(row.sighting_count ?? 0),
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
  };
}

function num(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: string | Date | undefined): string {
  if (value === undefined) return '';
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The SQL an officer sees, with every bound value replaced by its placeholder.
 *
 * Showing the *text* and not the parameters is deliberate and is itself the demonstration: the
 * preview contains `$1`, `$2`, `$3` exactly where the officer's values went, which is the visible
 * form of "the model's output never became SQL".
 */
export function previewOf(query: ReturnType<typeof compileQuery>['query']): string {
  return renderQuery(query)
    .text.replace(/\s+/g, ' ')
    .trim();
}
