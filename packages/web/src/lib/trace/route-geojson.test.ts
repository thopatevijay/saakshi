/**
 * D3-01 — the route's map geometry.
 *
 * The assertion that matters most here is a negative one: nothing may put an inferred road path
 * into the collection that the solid layer draws. That is the whole acceptance criterion about the
 * UI, expressed as a property of a pure function so it cannot regress silently behind a canvas.
 */
import { describe, expect, it } from 'vitest';
import {
  ROUTE_LINE_STYLE,
  formatSeconds,
  routeBounds,
  segmentLabel,
  toRouteGeometry,
  type RouteSegmentLike,
} from './route-geojson';

function segment(over: Partial<RouteSegmentLike> = {}): RouteSegmentLike {
  return {
    seq: 1,
    fromSeq: 1,
    toSeq: 2,
    fromCameraName: 'Paldi Circle',
    toCameraName: 'Janpath',
    kind: 'inferred_path',
    observed: false,
    elapsedSeconds: 315,
    roadDistanceKm: 2.473,
    expectedTravelTimeS: 205,
    elapsedVsExpected: 1.537,
    minimumAverageSpeedKmh: 28.3,
    pathOptions: 1,
    inferredConfidence: 0.781,
    confidenceBasis: { timing: 0.9267, uniqueness: 1, endpoints: 0.8432 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [72.5714, 23.0225],
        [72.5871, 23.0311],
      ],
    },
    note: 'the most plausible driving path',
    ...over,
  };
}

describe('toRouteGeometry', () => {
  it('never puts an inferred path into the solid collection', () => {
    const geometry = toRouteGeometry([
      segment({ seq: 1 }),
      segment({ seq: 2, kind: 'inferred_path', observed: false }),
    ]);
    expect(geometry.observed.features).toHaveLength(0);
    expect(geometry.inferred.features).toHaveLength(2);
    expect(geometry.inferred.features.every((f) => f.properties.observed === false)).toBe(true);
  });

  it('styles the two layers so they differ in dash, width and opacity, not only in colour', () => {
    // Three channels, so the distinction survives a colour-blind reader and a greyscale print.
    expect(ROUTE_LINE_STYLE.observed.dash).toBeNull();
    expect(ROUTE_LINE_STYLE.inferred.dash).toEqual([2, 2]);
    expect(ROUTE_LINE_STYLE.observed.width).toBeGreaterThan(ROUTE_LINE_STYLE.inferred.width);
    expect(ROUTE_LINE_STYLE.observed.opacity).toBeGreaterThan(ROUTE_LINE_STYLE.inferred.opacity);
    expect(ROUTE_LINE_STYLE.observed.colour).not.toBe(ROUTE_LINE_STYLE.inferred.colour);
  });

  it('sends every undrawable segment to the tray instead of dropping it', () => {
    const geometry = toRouteGeometry([
      segment({ seq: 1, kind: 'observed_dwell', observed: true, geometry: null, fromSeq: 1 }),
      segment({ seq: 2 }),
      segment({ seq: 3, kind: 'inferred_unroutable', geometry: null, roadDistanceKm: null }),
      segment({ seq: 4, kind: 'inferred_revisit', geometry: null, roadDistanceKm: null }),
    ]);
    expect(geometry.undrawable.map((s) => s.seq)).toEqual([1, 3, 4]);
    expect(geometry.undrawnSegments).toBe(3);
    // The dwell is undrawable as a *line* but still marks its camera as watched.
    expect(geometry.dwellAtSeq).toEqual([1]);
    expect(geometry.drawnKm).toBe(2.473);
  });

  it('treats a degenerate one-point geometry as undrawable rather than drawing nothing silently', () => {
    const geometry = toRouteGeometry([
      segment({ geometry: { type: 'LineString', coordinates: [[72.5714, 23.0225]] } }),
    ]);
    expect(geometry.inferred.features).toHaveLength(0);
    expect(geometry.undrawable).toHaveLength(1);
  });

  it('never lets an unscored segment carry a confidence a style expression could read', () => {
    const geometry = toRouteGeometry([segment({ inferredConfidence: null })]);
    expect(geometry.inferred.features[0]?.properties.confidence).toBe(-1);
  });

  it('bounds the drawn lines only', () => {
    const geometry = toRouteGeometry([segment(), segment({ seq: 2, geometry: null })]);
    expect(routeBounds(geometry)).toEqual([72.5714, 23.0225, 72.5871, 23.0311]);
    expect(routeBounds(toRouteGeometry([]))).toBeNull();
  });
});

describe('labels', () => {
  it('names both ends, the distance, the timing and the confidence', () => {
    expect(segmentLabel(segment())).toBe(
      '1 → 2 · 2.47 km · 5 min · expected 3 min · confidence 0.78',
    );
  });

  it('says an observed segment inferred nothing rather than showing a score', () => {
    const label = segmentLabel(
      segment({ kind: 'observed_dwell', observed: true, inferredConfidence: null }),
    );
    expect(label).toContain('nothing inferred');
    expect(label).not.toContain('confidence 0');
  });

  it('formats durations at a human scale', () => {
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(315)).toBe('5 min');
    expect(formatSeconds(7200)).toBe('2 h 0 min');
  });
});
