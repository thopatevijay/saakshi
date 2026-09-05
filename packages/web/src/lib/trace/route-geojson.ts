/**
 * Turning a reconstructed route into map geometry (D3-01).
 *
 * Pure and separated from the MapLibre component for `registry/geojson.ts`'s reason: a WebGL canvas
 * is opaque to assertions, so the part that can be wrong — which line is drawn, in which layer,
 * carrying which claim — has to be testable without a browser.
 *
 * ## Two collections, because they are two different claims
 *
 * The whole ticket is one sentence: *a reviewer who has never seen this app must be able to tell
 * which parts are evidence and which are inference.* One `FeatureCollection` with a `kind` property
 * and a data-driven style would technically encode that, and would let a future edit collapse the
 * two into one line by changing one expression. Two collections feeding two layers with different
 * geometry — solid and opaque against dashed and translucent — cannot be collapsed by accident.
 *
 * ## What has no geometry, and why that is not a bug
 *
 * Three of the four segment kinds are not drawable, and each for a different honest reason:
 *
 *  - `observed_dwell` — the vehicle was watched inside **one** camera's field of view. It moved;
 *    where it moved is not measured. Drawing a line would invent the one thing we do not know, so
 *    the dwell is rendered as a **solid ring on the camera pin** instead: solid because it is
 *    evidence, a ring rather than a line because it has no extent.
 *  - `inferred_revisit` — same camera, different tracking session. The vehicle left and came back;
 *    the excursion is unbounded, so no line can be honest about it.
 *  - `inferred_unroutable` — a camera has no coordinates (**0 of 30 real cameras on this estate
 *    are placed**) or the road graph has no path.
 *
 * Those go into `undrawable`, which the screen renders as a **"Not drawn · N" tray** with the
 * reason against each one — D1-08's tray pattern, reused rather than reinvented, because its whole
 * point is that a thing missing from the map must still be visible on the screen.
 */
import type { Feature, FeatureCollection, LineString } from 'geojson';

export type RouteSegmentKind =
  'observed_dwell' | 'inferred_path' | 'inferred_revisit' | 'inferred_unroutable';

/** The fields of a route segment this module needs. Structural, so the API type can grow. */
export interface RouteSegmentLike {
  seq: number;
  fromSeq: number;
  toSeq: number;
  fromCameraName: string;
  toCameraName: string;
  kind: RouteSegmentKind;
  observed: boolean;
  elapsedSeconds: number;
  roadDistanceKm: number | null;
  expectedTravelTimeS: number | null;
  elapsedVsExpected: number | null;
  minimumAverageSpeedKmh: number | null;
  pathOptions: number | null;
  inferredConfidence: number | null;
  confidenceBasis: { timing: number; uniqueness: number; endpoints: number } | null;
  /**
   * `number[][]` rather than `[number, number][]`: this is the shape `openapi-typescript` produces
   * from the OpenAPI document, and narrowing it here would force a cast at every call site — which
   * is a cast the compiler cannot check and a reader would stop reading.
   */
  geometry: { type: 'LineString'; coordinates: number[][] } | null;
  note: string;
}

export interface RouteLineProperties {
  seq: number;
  fromSeq: number;
  toSeq: number;
  kind: RouteSegmentKind;
  observed: boolean;
  /**
   * `-1` when the segment was not scored, never `null`: a MapLibre `interpolate` over a null
   * property silently falls back to the default and would paint an unscored segment as if it were
   * a confident one.
   */
  confidence: number;
  /** What the hover tooltip shows. Built here so the map component holds no formatting. */
  label: string;
  note: string;
}

/**
 * The visual vocabulary, in one place.
 *
 * The distinction is carried by **three** channels at once — dash, width and opacity — and only
 * incidentally by hue, so it survives a colour-blind reader, a greyscale print of a case file, and
 * a projector with the contrast wound down. Amber for inference matches the claims banner at the
 * top of the screen, which has said "Inferred" in amber since D2-08.
 */
export const ROUTE_LINE_STYLE = {
  observed: {
    colour: '#34d399',
    width: 5,
    opacity: 0.95,
    dash: null,
    label: 'Observed',
    meaning:
      'One camera held the vehicle in a single unbroken tracking session. The movement itself is ' +
      'on video.',
  },
  inferred: {
    colour: '#f59e0b',
    width: 3,
    opacity: 0.8,
    dash: [2, 2] as [number, number],
    label: 'Inferred',
    meaning:
      'No camera watched the vehicle here. This is the most plausible driving path on the road ' +
      'graph, not the path it is known to have taken.',
  },
} as const;

export const SEGMENT_KIND_LABEL: Record<RouteSegmentKind, string> = {
  observed_dwell: 'Observed at one camera',
  inferred_path: 'Inferred road path',
  inferred_revisit: 'Returned to the same camera',
  inferred_unroutable: 'Cannot be placed on a map',
};

export interface RouteGeometry {
  /** Solid layer. Segments whose movement was watched **and** has drawable extent. */
  observed: FeatureCollection<LineString, RouteLineProperties>;
  /** Dashed layer. Road paths between two placed cameras. */
  inferred: FeatureCollection<LineString, RouteLineProperties>;
  /** Everything with no geometry, in route order, with the reason. Rendered as a tray. */
  undrawable: RouteSegmentLike[];
  /** `fromSeq` of every observed dwell — the pins that get a solid "watched here" ring. */
  dwellAtSeq: number[];
  drawnKm: number;
  undrawnSegments: number;
}

export function toRouteGeometry(segments: readonly RouteSegmentLike[]): RouteGeometry {
  const observed: Feature<LineString, RouteLineProperties>[] = [];
  const inferred: Feature<LineString, RouteLineProperties>[] = [];
  const undrawable: RouteSegmentLike[] = [];
  const dwellAtSeq: number[] = [];
  let drawnKm = 0;

  for (const segment of segments) {
    if (segment.kind === 'observed_dwell') dwellAtSeq.push(segment.fromSeq);

    const coordinates = segment.geometry?.coordinates;
    if (coordinates === undefined || coordinates.length < 2) {
      undrawable.push(segment);
      continue;
    }
    drawnKm += segment.roadDistanceKm ?? 0;
    const feature: Feature<LineString, RouteLineProperties> = {
      type: 'Feature',
      id: segment.seq,
      geometry: { type: 'LineString', coordinates },
      properties: {
        seq: segment.seq,
        fromSeq: segment.fromSeq,
        toSeq: segment.toSeq,
        kind: segment.kind,
        observed: segment.observed,
        confidence: segment.inferredConfidence ?? -1,
        label: segmentLabel(segment),
        note: segment.note,
      },
    };
    (segment.observed ? observed : inferred).push(feature);
  }

  return {
    observed: { type: 'FeatureCollection', features: observed },
    inferred: { type: 'FeatureCollection', features: inferred },
    undrawable,
    dwellAtSeq,
    drawnKm: Math.round(drawnKm * 1000) / 1000,
    undrawnSegments: undrawable.length,
  };
}

/** `4 → 5 · 3.84 km · 8 min (expected 7 min) · confidence 0.47`. */
export function segmentLabel(segment: RouteSegmentLike): string {
  const parts = [`${String(segment.fromSeq)} → ${String(segment.toSeq)}`];
  if (segment.roadDistanceKm !== null) parts.push(`${segment.roadDistanceKm.toFixed(2)} km`);
  parts.push(formatSeconds(segment.elapsedSeconds));
  if (segment.expectedTravelTimeS !== null) {
    parts.push(`expected ${formatSeconds(segment.expectedTravelTimeS)}`);
  }
  parts.push(
    segment.inferredConfidence === null
      ? 'observed — nothing inferred'
      : `confidence ${segment.inferredConfidence.toFixed(2)}`,
  );
  return parts.join(' · ');
}

/** Bounding box over every drawn line. `[west, south, east, north]`, or `null`. */
export function routeBounds(geometry: RouteGeometry): [number, number, number, number] | null {
  const all = [...geometry.observed.features, ...geometry.inferred.features];
  let box: [number, number, number, number] | null = null;
  for (const feature of all) {
    for (const position of feature.geometry.coordinates) {
      const lon = position[0];
      const lat = position[1];
      // `Position` is `number[]` in the GeoJSON types, so both reads are `number | undefined`.
      if (lon === undefined || lat === undefined) continue;
      box =
        box === null
          ? [lon, lat, lon, lat]
          : [
              Math.min(box[0], lon),
              Math.min(box[1], lat),
              Math.max(box[2], lon),
              Math.max(box[3], lat),
            ];
    }
  }
  return box;
}

export function formatSeconds(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 90) return `${String(total)} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 90) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} h ${String(minutes % 60)} min`;
}
