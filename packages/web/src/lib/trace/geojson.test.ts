/**
 * D2-08 — trace geometry and the scrubber ↔ map contract.
 *
 * A WebGL canvas cannot be asserted on, so everything that can be wrong about the map lives here:
 * which pins exist, in what order, which link method each carries, whether the connecting order is
 * drawn at all, and whether dragging the timeline selects the sighting that was in effect at that
 * instant.
 */
import { describe, expect, it } from 'vitest';
import {
  LINK_METHOD_ORDER,
  LINK_STYLE,
  elapsedSeconds,
  fractionOfSeq,
  seqAtFraction,
  toTraceGeometry,
  traceBounds,
  type TraceablePoint,
} from './geojson';

function point(over: Partial<TraceablePoint> & { seq: number }): TraceablePoint {
  return {
    sightingId: `s${String(over.seq)}`,
    ts: `2026-05-10T09:0${String(over.seq)}:00.000Z`,
    cameraId: `cam${String(over.seq)}`,
    cameraExternalId: `CAM-${String(over.seq)}`,
    cameraName: `Camera ${String(over.seq)}`,
    lat: 23.0225,
    lon: 72.5714,
    located: true,
    linkMethod: 'plate_exact',
    linkConfidence: 0.9,
    ...over,
  };
}

const ROUTE: TraceablePoint[] = [
  point({ seq: 1, lon: 72.5714, lat: 23.0225, ts: '2026-05-10T09:00:00.000Z' }),
  point({ seq: 2, lon: 72.6014, lat: 23.0425, ts: '2026-05-10T09:10:00.000Z' }),
  point({
    seq: 3,
    lon: 72.6314,
    lat: 23.0625,
    ts: '2026-05-10T09:40:00.000Z',
    linkMethod: 'plate_fuzzy',
    linkConfidence: 0.42,
  }),
];

describe('pins carry the order and the claim', () => {
  it('one feature per placed sighting, in trace order, labelled by seq', () => {
    const geometry = toTraceGeometry(ROUTE);
    expect(geometry.points.features).toHaveLength(3);
    expect(geometry.points.features.map((f) => f.properties.seq)).toEqual([1, 2, 3]);
    expect(geometry.points.features.map((f) => f.properties.label)).toEqual(['1', '2', '3']);
  });

  it('every pin carries its camera name, so the map can show it without a second lookup', () => {
    const geometry = toTraceGeometry(ROUTE);
    expect(geometry.points.features.map((f) => f.properties.cameraName)).toEqual([
      'Camera 1',
      'Camera 2',
      'Camera 3',
    ]);
  });

  it('a fuzzy pin is distinguishable from an exact one by a property, not by position', () => {
    const geometry = toTraceGeometry(ROUTE);
    expect(geometry.points.features.map((f) => f.properties.linkMethod)).toEqual([
      'plate_exact',
      'plate_exact',
      'plate_fuzzy',
    ]);
    expect(LINK_STYLE.plate_exact.fill).not.toBe(LINK_STYLE.plate_fuzzy.fill);
    expect(LINK_STYLE.plate_fuzzy.note).toContain('not an identification');
  });

  it('every link method the API can return has a style and a plain-language note', () => {
    for (const method of LINK_METHOD_ORDER) {
      expect(LINK_STYLE[method].label).not.toBe('');
      expect(LINK_STYLE[method].note).not.toBe('');
    }
    expect(LINK_METHOD_ORDER).toEqual(['plate_exact', 'plate_fuzzy', 'reid_bridge']);
  });
});

describe('the estate has no coordinates, and the geometry says so rather than hiding it', () => {
  it('unplaced sightings are counted, not drawn, and never dropped from the count', () => {
    const mixed = [...ROUTE, point({ seq: 4, lat: null, lon: null, located: false })];
    const geometry = toTraceGeometry(mixed);
    expect(geometry.points.features).toHaveLength(3);
    expect(geometry.mappable).toBe(3);
    expect(geometry.unmappable).toBe(1);
  });

  it('a trace with nothing placed produces no pins and no path, not an empty polyline', () => {
    const geometry = toTraceGeometry([point({ seq: 1, lat: null, lon: null, located: false })]);
    expect(geometry.points.features).toEqual([]);
    expect(geometry.path).toBeNull();
    expect(geometry.unmappable).toBe(1);
  });
});

describe('the connecting order is a separate, inferred feature', () => {
  it('is a LineString through the placed pins in order, flagged inferred', () => {
    const geometry = toTraceGeometry(ROUTE);
    expect(geometry.path?.geometry.coordinates).toEqual([
      [72.5714, 23.0225],
      [72.6014, 23.0425],
      [72.6314, 23.0625],
    ]);
    expect(geometry.path?.properties?.['basis']).toBe('inferred');
  });

  it('a single-sighting trace has pins but no path — the degenerate case', () => {
    const geometry = toTraceGeometry([ROUTE[0] as TraceablePoint]);
    expect(geometry.points.features).toHaveLength(1);
    expect(geometry.path).toBeNull();
  });
});

describe('bounds', () => {
  it('covers every placed pin', () => {
    expect(traceBounds(ROUTE)).toEqual([72.5714, 23.0225, 72.6314, 23.0625]);
  });

  it('is null when nothing can be placed', () => {
    expect(traceBounds([point({ seq: 1, lat: null, lon: null, located: false })])).toBeNull();
  });
});

describe('the timeline scrubber is synchronised to the map', () => {
  it('scrubs by time, not by index — the sightings are unevenly spaced', () => {
    // 0 → 40 minutes. Halfway is 09:20, and the sighting in effect then is seq 2 (09:10),
    // not seq 2-of-3 by position, which would be the same here only by coincidence.
    expect(seqAtFraction(ROUTE, 0)).toBe(1);
    expect(seqAtFraction(ROUTE, 0.5)).toBe(2);
    expect(seqAtFraction(ROUTE, 0.24)).toBe(1); // 09:09:36 — still before the second sighting
    expect(seqAtFraction(ROUTE, 0.26)).toBe(2); // 09:10:24 — just after it
    expect(seqAtFraction(ROUTE, 1)).toBe(3);
  });

  it('clamps rather than returning undefined outside [0,1]', () => {
    expect(seqAtFraction(ROUTE, -1)).toBe(1);
    expect(seqAtFraction(ROUTE, 5)).toBe(3);
  });

  it('is empty for an empty trace', () => {
    expect(seqAtFraction([], 0.5)).toBeNull();
  });

  it('round-trips: selecting a pin puts the handle where scrubbing to it would', () => {
    for (const s of ROUTE) {
      expect(seqAtFraction(ROUTE, fractionOfSeq(ROUTE, s.seq))).toBe(s.seq);
    }
  });

  it('a trace whose sightings share one instant has no span, and does not divide by zero', () => {
    const instant = [
      point({ seq: 1, ts: '2026-05-10T09:00:00.000Z' }),
      point({ seq: 2, ts: '2026-05-10T09:00:00.000Z' }),
    ];
    expect(seqAtFraction(instant, 0)).toBe(1);
    expect(seqAtFraction(instant, 1)).toBe(2);
    expect(fractionOfSeq(instant, 2)).toBe(1);
  });

  it('the axis is elapsed seconds from the first sighting', () => {
    expect(elapsedSeconds(ROUTE, 1)).toBe(0);
    expect(elapsedSeconds(ROUTE, 2)).toBe(600);
    expect(elapsedSeconds(ROUTE, 3)).toBe(2400);
  });
});
