'use client';

/**
 * The trace map — numbered, ordered pins over the self-hosted Gujarat basemap (D2-08).
 *
 * Built on D1-08's registry map deliberately: the same `basemapStyle()`, the same PMTiles protocol
 * registration, the same build-once-with-refs pattern that keeps a callback identity change from
 * tearing down the WebGL context, and the same `window.__saakshi*` debug handles the CDP verify
 * scripts read, because a canvas is opaque to DOM assertions.
 *
 * **Three layers, in this order, and the order is the argument.**
 *
 *  1. `trace-path` — a **dashed** line through the sightings. Dashed because it is the *inferred*
 *     half of the answer: nothing observed the vehicle between two cameras. A solid polyline is the
 *     single most misleading thing this screen could draw.
 *  2. `trace-selected` — the halo for the sighting the timeline is on.
 *  3. `trace-pins` + `trace-labels` — the *observed* half. Coloured by **link method**, so a fuzzy
 *     link is visually distinct from an exact one at a glance, and labelled with its position in
 *     the route.
 *
 * Layers paint in insertion order, so the inferred line sits under the halo and the halo under the
 * pins — the observed thing is always on top of the claim about it.
 *
 * **Clustering is deliberately off.** D1-08 clusters because the estate is 80,000 cameras; a trace
 * is a handful of sightings whose *individual order* is the entire point, and a cluster labelled
 * "3" would destroy it. This is also why the trace uses its own sources and never merges geometry
 * into the registry's `cameras` source, which D2-09's verification asserts cluster counts against.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  Map as MlMap,
  NavigationControl,
  ScaleControl,
  addProtocol,
  type DataDrivenPropertyValueSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import {
  GUJARAT_BOUNDS,
  GUJARAT_CENTER,
  GUJARAT_ZOOM,
  basemapStyle,
} from '@/src/lib/registry/basemap-style';
import {
  LINK_METHOD_ORDER,
  LINK_STYLE,
  toTraceGeometry,
  traceBounds,
  type TraceablePoint,
} from '@/src/lib/trace/geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

const POINT_SOURCE = 'trace-points';
const PATH_SOURCE = 'trace-path-source';

let protocolRegistered = false;
function registerMapGlobals(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/** `match` over the link method, with no arithmetic — the colour *is* the claim, copied. */
function linkColour(key: 'fill' | 'stroke'): unknown[] {
  const chain: unknown[] = ['match', ['get', 'linkMethod']];
  for (const method of LINK_METHOD_ORDER) chain.push(method, LINK_STYLE[method][key]);
  chain.push('#64748b');
  return chain;
}

export interface TraceMapProps {
  sightings: readonly TraceablePoint[];
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
}

export function TraceMap({ sightings, selectedSeq, onSelect }: TraceMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const handlers = useRef({ onSelect });
  const data = useRef(toTraceGeometry(sightings));
  const fitted = useRef<string>('');

  handlers.current = { onSelect };

  const applyData = useCallback((sourceSightings: readonly TraceablePoint[]) => {
    const geometry = toTraceGeometry(sourceSightings);
    data.current = geometry;
    (window as unknown as { __saakshiTraceFeatures?: unknown }).__saakshiTraceFeatures =
      geometry.points;

    const instance = map.current;
    if (instance === null || !ready.current) return;

    const points: GeoJSONSource | undefined = instance.getSource(POINT_SOURCE);
    void points?.setData(geometry.points);
    const path: GeoJSONSource | undefined = instance.getSource(PATH_SOURCE);
    void path?.setData(geometry.path ?? { type: 'FeatureCollection', features: [] });
  }, []);

  useEffect(() => {
    if (container.current === null || map.current !== null) return;
    registerMapGlobals();

    const instance = new MlMap({
      container: container.current,
      style: basemapStyle() as unknown as StyleSpecification,
      center: GUJARAT_CENTER,
      zoom: GUJARAT_ZOOM,
      maxZoom: 16,
      maxBounds: [
        [GUJARAT_BOUNDS[0] - 1.5, GUJARAT_BOUNDS[1] - 1.5],
        [GUJARAT_BOUNDS[2] + 1.5, GUJARAT_BOUNDS[3] + 1.5],
      ],
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.current = instance;

    // The same debug handles D1-08 exposes, under trace-specific names so the two screens can be
    // verified independently in one browser session.
    const globals = window as unknown as {
      __saakshiTraceMap?: MlMap;
      __saakshiTraceMapIdle?: boolean;
      __saakshiTraceMapErrors?: string[];
    };
    globals.__saakshiTraceMap = instance;
    const markIdle = (value: boolean): void => {
      globals.__saakshiTraceMapIdle = value;
    };
    markIdle(false);
    instance.on('idle', () => {
      markIdle(true);
    });
    instance.on('movestart', () => {
      markIdle(false);
    });
    const errors: string[] = [];
    globals.__saakshiTraceMapErrors = errors;
    instance.on('error', (event: { error?: { message?: string } }) => {
      errors.push(event.error?.message ?? 'unknown map error');
    });

    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    const bounds: LngLatBoundsLike = [
      [GUJARAT_BOUNDS[0], GUJARAT_BOUNDS[1]],
      [GUJARAT_BOUNDS[2], GUJARAT_BOUNDS[3]],
    ];
    instance.fitBounds(bounds, { padding: 24, animate: false });

    instance.on('load', () => {
      instance.addSource(PATH_SOURCE, {
        type: 'geojson',
        data: data.current.path ?? { type: 'FeatureCollection', features: [] },
      });
      instance.addSource(POINT_SOURCE, {
        type: 'geojson',
        data: data.current.points,
        promoteId: 'id',
      });

      // 1 · the inferred order, dashed and faint.
      instance.addLayer({
        id: 'trace-path',
        type: 'line',
        source: PATH_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#64748b',
          'line-width': 2,
          'line-opacity': 0.75,
          'line-dasharray': [2, 2],
        },
      });

      // 2 · the selection halo.
      instance.addLayer({
        id: 'trace-selected',
        type: 'circle',
        source: POINT_SOURCE,
        filter: ['==', ['get', 'seq'], -1],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 14, 10, 18, 14, 22],
          'circle-color': 'rgba(56,189,248,0.22)',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#38bdf8',
        },
      });

      // 3 · the observed sightings, coloured by how they were linked.
      instance.addLayer({
        id: 'trace-pins',
        type: 'circle',
        source: POINT_SOURCE,
        paint: {
          'circle-color': linkColour(
            'fill',
          ) as unknown as DataDrivenPropertyValueSpecification<string>,
          'circle-stroke-color': linkColour(
            'stroke',
          ) as unknown as DataDrivenPropertyValueSpecification<string>,
          'circle-stroke-width': 2,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 8, 10, 11, 14, 14],
        },
      });

      instance.addLayer({
        id: 'trace-labels',
        type: 'symbol',
        source: POINT_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#0b1220' },
      });

      ready.current = true;
      applyData(sightings);
    });

    instance.on('mouseenter', 'trace-pins', () => {
      instance.getCanvas().style.cursor = 'pointer';
    });
    instance.on('mouseleave', 'trace-pins', () => {
      instance.getCanvas().style.cursor = '';
    });
    instance.on('click', 'trace-pins', (event: MapMouseEvent & { features?: unknown[] }) => {
      const feature = event.features?.[0] as { properties?: { seq?: number } } | undefined;
      const seq = feature?.properties?.seq;
      if (typeof seq === 'number') handlers.current.onSelect(seq);
    });
    instance.on('click', (event: MapMouseEvent) => {
      const hits = instance.queryRenderedFeatures(event.point, { layers: ['trace-pins'] });
      if (hits.length === 0) handlers.current.onSelect(null);
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Built exactly once, with an empty dependency list on purpose: `sightings` is read through a
    // ref inside `applyData`, and re-running this effect would destroy and rebuild the WebGL
    // context on every data change. D1-08's registry map is constructed the same way.
  }, []);

  // Data updates go straight to the source, never through React state — the registry's rule.
  useEffect(() => {
    applyData(sightings);

    // Refit only when the *route* changes, not when the selection moves, or every click would
    // yank the viewport back out.
    const key = sightings.map((s) => s.sightingId).join(',');
    if (key === fitted.current) return;
    fitted.current = key;

    const instance = map.current;
    const box = traceBounds(sightings);
    if (instance === null || box === null) return;
    instance.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      // A single-sighting trace has a zero-width box; `maxZoom` is what stops fitBounds diving to
      // the maximum zoom on it.
      { padding: 80, maxZoom: 14, duration: 500 },
    );
  }, [sightings, applyData]);

  // Selection: highlight, and bring the sighting into view without changing the zoom.
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready.current) return;
    if (instance.getLayer('trace-selected') === undefined) return;

    instance.setFilter('trace-selected', ['==', ['get', 'seq'], selectedSeq ?? -1]);

    if (selectedSeq === null) return;
    const chosen = sightings.find((s) => s.seq === selectedSeq);
    if (chosen === undefined || chosen.lon === null || chosen.lat === null) return;
    instance.easeTo({ center: [chosen.lon, chosen.lat], duration: 400 });
  }, [selectedSeq, sightings]);

  return (
    <div
      ref={container}
      role="application"
      aria-label="Map of the traced vehicle's sightings, in order"
      className="size-full min-h-[26rem] rounded-lg border border-slate-800 bg-[#0b1220]"
      data-testid="trace-map"
    />
  );
}
