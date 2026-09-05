/**
 * Turning a trace payload into map geometry, and keeping the timeline in step with it (D2-08).
 *
 * Pure, and separated from the MapLibre component for the same reason `registry/geojson.ts` is: a
 * WebGL canvas is opaque to assertions, so the part that can be wrong — which pins exist, in what
 * order, coloured by what — has to be testable without a browser.
 *
 * **Two layers, not one.** The numbered pins are one source; the connecting order is a separate
 * `LineString`. That separation is what lets the line be drawn *underneath* the pins and, more
 * importantly, what lets it be styled as the **inferred** thing it is — dashed, faint — while the
 * pins are drawn as the **observed** things they are. A single solid polyline through the sightings
 * would assert a route nobody observed.
 *
 * **Unplaced sightings are dropped from geometry and never from the trace.** Nought of the thirty
 * real cameras carries coordinates, so a trace with no mappable pin is the normal case here rather
 * than an edge case; the counts come back so the screen can say "3 of 7 sightings can be mapped"
 * instead of silently drawing three.
 */
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';

export type LinkMethod = 'plate_exact' | 'plate_fuzzy' | 'reid_bridge';

/** The fields of a trace sighting this module needs. Structural, so the API type can grow. */
export interface TraceablePoint {
  seq: number;
  sightingId: string;
  ts: string;
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  lat: number | null;
  lon: number | null;
  located: boolean;
  linkMethod: LinkMethod;
  linkConfidence: number;
}

/** The properties every trace pin carries. Typed, so the map expressions and the tests agree. */
export interface TracePinProperties {
  id: string;
  seq: number;
  label: string;
  ts: string;
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  linkMethod: LinkMethod;
  linkConfidence: number;
}

export interface TraceGeometry {
  points: FeatureCollection<Point, TracePinProperties>;
  /** `null` when fewer than two sightings can be placed — there is no order to draw. */
  path: Feature<LineString> | null;
  mappable: number;
  unmappable: number;
}

/**
 * Link colours. A fuzzy link must be visually distinct from an exact one — the ticket says so, and
 * on this estate almost every link is fuzzy, so the distinction carries most of the honesty.
 *
 * Deliberately not the trust palette: a trust band describes a *camera*, a link method describes a
 * *claim about a vehicle*, and reusing one vocabulary for both would make an untrusted camera and
 * an uncertain identification look like the same kind of doubt.
 */
export const LINK_STYLE: Record<
  LinkMethod,
  { fill: string; stroke: string; label: string; note: string }
> = {
  plate_exact: {
    fill: '#38bdf8',
    stroke: '#0ea5e9',
    label: 'Exact plate match',
    note: 'The normalised plate read equals the registration searched for.',
  },
  plate_fuzzy: {
    fill: '#f59e0b',
    stroke: '#b45309',
    label: 'Fuzzy plate match',
    note: 'A ranked possibility, not an identification — the read differs from the registration.',
  },
  reid_bridge: {
    fill: '#a78bfa',
    stroke: '#7c3aed',
    label: 'Appearance bridge',
    note: 'Linked by vehicle appearance, not by a plate. The weakest claim here.',
  },
};

export const LINK_METHOD_ORDER: LinkMethod[] = ['plate_exact', 'plate_fuzzy', 'reid_bridge'];

export function toTraceGeometry(sightings: readonly TraceablePoint[]): TraceGeometry {
  const placed = sightings.filter(
    (s): s is TraceablePoint & { lat: number; lon: number } =>
      s.located && s.lat !== null && s.lon !== null,
  );

  const points: FeatureCollection<Point, TracePinProperties> = {
    type: 'FeatureCollection',
    features: placed.map((s) => ({
      type: 'Feature',
      // `promoteId` needs a stable feature id for the selected-pin filter.
      id: s.sightingId,
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.sightingId,
        seq: s.seq,
        label: String(s.seq),
        ts: s.ts,
        cameraId: s.cameraId,
        cameraExternalId: s.cameraExternalId,
        cameraName: s.cameraName,
        linkMethod: s.linkMethod,
        linkConfidence: s.linkConfidence,
      },
    })),
  };

  const path: Feature<LineString> | null =
    placed.length < 2
      ? null
      : {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: placed.map((s) => [s.lon, s.lat]) },
          properties: { basis: 'inferred', points: placed.length },
        };

  return {
    points,
    path,
    mappable: placed.length,
    unmappable: sightings.length - placed.length,
  };
}

/** Bounding box of the mappable pins, or `null`. `[west, south, east, north]`. */
export function traceBounds(
  sightings: readonly TraceablePoint[],
): [number, number, number, number] | null {
  const placed = sightings.filter((s) => s.located && s.lat !== null && s.lon !== null);
  const first = placed[0];
  if (first === undefined) return null;
  let west = first.lon as number;
  let east = west;
  let south = first.lat as number;
  let north = south;
  for (const s of placed) {
    const lon = s.lon as number;
    const lat = s.lat as number;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/**
 * The scrubber ↔ map contract, in one function.
 *
 * The timeline is a position in **time**, not an index: sightings are unevenly spaced (the estate
 * delivers roughly 4 effective fps and a vehicle can sit in one camera's view for many frames), so
 * an evenly-stepped index scrubber would move the map in lurches that do not correspond to the
 * journey. `at` maps a fraction of the elapsed window to the sighting in effect at that instant —
 * the last one at or before it — which is what makes dragging the scrubber walk the route.
 */
export function seqAtFraction(
  sightings: readonly TraceablePoint[],
  fraction: number,
): number | null {
  if (sightings.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  const start = Date.parse(sightings[0]?.ts ?? '');
  const end = Date.parse(sightings.at(-1)?.ts ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // A trace whose sightings share one instant has no span to scrub; index by position instead of
  // dividing by zero.
  if (end === start) {
    const index = Math.min(sightings.length - 1, Math.floor(clamped * sightings.length));
    return sightings[index]?.seq ?? null;
  }
  const target = start + clamped * (end - start);
  let chosen = sightings[0]?.seq ?? null;
  for (const s of sightings) {
    if (Date.parse(s.ts) <= target) chosen = s.seq;
    else break;
  }
  return chosen;
}

/** The inverse: where the handle sits when a pin is selected. Keeps the two genuinely in step. */
export function fractionOfSeq(sightings: readonly TraceablePoint[], seq: number | null): number {
  if (seq === null || sightings.length === 0) return 0;
  const start = Date.parse(sightings[0]?.ts ?? '');
  const end = Date.parse(sightings.at(-1)?.ts ?? '');
  const found = sightings.find((s) => s.seq === seq);
  if (found === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end === start) return sightings.indexOf(found) / Math.max(1, sightings.length - 1);
  return (Date.parse(found.ts) - start) / (end - start);
}

/** Elapsed seconds from the first sighting. What the timeline axis is labelled in. */
export function elapsedSeconds(sightings: readonly TraceablePoint[], seq: number): number {
  const start = Date.parse(sightings[0]?.ts ?? '');
  const found = sightings.find((s) => s.seq === seq);
  if (found === undefined || !Number.isFinite(start)) return 0;
  return (Date.parse(found.ts) - start) / 1000;
}
