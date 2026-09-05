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
  Popup,
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
import {
  ROUTE_LINE_STYLE,
  routeBounds,
  toRouteGeometry,
  type RouteSegmentLike,
} from '@/src/lib/trace/route-geojson';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

const POINT_SOURCE = 'trace-points';
const PATH_SOURCE = 'trace-path-source';
/** D3-01. Two sources, because they carry two different claims — see `route-geojson.ts`. */
const ROUTE_OBSERVED_SOURCE = 'route-observed-source';
const ROUTE_INFERRED_SOURCE = 'route-inferred-source';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

let protocolRegistered = false;
function registerMapGlobals(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/** The popup content is built from API strings; escape before it reaches `setHTML`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  /** D3-01's reconstruction. Empty when no route was built — the map then falls back to D2-08. */
  route?: readonly RouteSegmentLike[];
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
}

export function TraceMap({ sightings, route = [], selectedSeq, onSelect }: TraceMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const handlers = useRef({ onSelect });
  const data = useRef(toTraceGeometry(sightings));
  const routeData = useRef(toRouteGeometry(route));
  const fitted = useRef<string>('');

  handlers.current = { onSelect };

  const applyData = useCallback(
    (sourceSightings: readonly TraceablePoint[], sourceRoute: readonly RouteSegmentLike[]) => {
      const geometry = toTraceGeometry(sourceSightings);
      const reconstruction = toRouteGeometry(sourceRoute);
      data.current = geometry;
      routeData.current = reconstruction;
      const globals = window as unknown as {
        __saakshiTraceFeatures?: unknown;
        __saakshiRouteFeatures?: unknown;
      };
      globals.__saakshiTraceFeatures = geometry.points;
      // The route's own debug handle, so `verify-route.mjs` can assert which line went into which
      // layer without trying to read a WebGL canvas.
      globals.__saakshiRouteFeatures = {
        observed: reconstruction.observed,
        inferred: reconstruction.inferred,
        undrawable: reconstruction.undrawable.map((s) => ({ seq: s.seq, kind: s.kind })),
        dwellAtSeq: reconstruction.dwellAtSeq,
      };

      const instance = map.current;
      if (instance === null || !ready.current) return;

      const points: GeoJSONSource | undefined = instance.getSource(POINT_SOURCE);
      void points?.setData(geometry.points);
      // When a route has been reconstructed the straight-line connector is worse than redundant:
      // it draws a chord the vehicle certainly did not drive, right beside the road path it
      // plausibly did. It is emptied rather than removed, so D2-08's fallback (and the layer
      // `verify-trace.mjs` asserts a dasharray on) still exists.
      const path: GeoJSONSource | undefined = instance.getSource(PATH_SOURCE);
      void path?.setData(
        reconstruction.observed.features.length + reconstruction.inferred.features.length > 0
          ? EMPTY
          : (geometry.path ?? EMPTY),
      );
      const observed: GeoJSONSource | undefined = instance.getSource(ROUTE_OBSERVED_SOURCE);
      void observed?.setData(reconstruction.observed);
      const inferred: GeoJSONSource | undefined = instance.getSource(ROUTE_INFERRED_SOURCE);
      void inferred?.setData(reconstruction.inferred);
    },
    [],
  );

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
      instance.addSource(ROUTE_OBSERVED_SOURCE, {
        type: 'geojson',
        data: routeData.current.observed,
      });
      instance.addSource(ROUTE_INFERRED_SOURCE, {
        type: 'geojson',
        data: routeData.current.inferred,
      });

      // 1 · the inferred order, dashed and faint. D2-08's straight-line fallback, used only when
      // no road-graph route was reconstructed.
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

      // 1b · the reconstructed route (D3-01). **Two layers, and the difference between them is the
      // point of the feature.** `route-inferred` is dashed, thin and translucent: a plausible road
      // path nobody watched. `route-observed` is solid, thick and opaque: movement that is on
      // video. They are separate layers over separate sources so no future edit can merge them
      // into one line by changing a single style expression.
      instance.addLayer({
        id: 'route-inferred',
        type: 'line',
        source: ROUTE_INFERRED_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_LINE_STYLE.inferred.colour,
          'line-width': ROUTE_LINE_STYLE.inferred.width,
          'line-opacity': ROUTE_LINE_STYLE.inferred.opacity,
          'line-dasharray': [...ROUTE_LINE_STYLE.inferred.dash],
        },
      });
      instance.addLayer({
        id: 'route-observed',
        type: 'line',
        source: ROUTE_OBSERVED_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_LINE_STYLE.observed.colour,
          'line-width': ROUTE_LINE_STYLE.observed.width,
          'line-opacity': ROUTE_LINE_STYLE.observed.opacity,
        },
      });

      // 1c · a solid ring on every camera that held the vehicle in one unbroken tracking session.
      // An observed dwell has no extent — the vehicle moved inside one field of view and where it
      // moved is not measured — so it gets a ring rather than a line. Solid, because it is still
      // evidence; drawing a line would invent the one thing we do not know.
      instance.addLayer({
        id: 'route-dwell',
        type: 'circle',
        source: POINT_SOURCE,
        filter: ['in', ['get', 'seq'], ['literal', routeData.current.dwellAtSeq]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 10, 16, 14, 20],
          'circle-color': 'rgba(52,211,153,0.15)',
          'circle-stroke-width': 3,
          'circle-stroke-color': ROUTE_LINE_STYLE.observed.colour,
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
      applyData(sightings, route);
    });

    instance.on('mouseenter', 'trace-pins', () => {
      instance.getCanvas().style.cursor = 'pointer';
    });
    instance.on('mouseleave', 'trace-pins', () => {
      instance.getCanvas().style.cursor = '';
    });

    // Per-segment confidence on hover, on both route layers. A `Popup` rather than a title
    // attribute because the canvas has no DOM nodes to hang one on.
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    for (const layer of ['route-inferred', 'route-observed'] as const) {
      instance.on('mousemove', layer, (event: MapMouseEvent & { features?: unknown[] }) => {
        const feature = event.features?.[0] as
          { properties?: { label?: string; note?: string; observed?: boolean } } | undefined;
        if (feature?.properties === undefined) return;
        instance.getCanvas().style.cursor = 'pointer';
        const heading = feature.properties.observed === true ? 'Observed' : 'Inferred';
        popup
          .setLngLat(event.lngLat)
          .setHTML(
            `<div style="max-width:22rem;font:11px/1.45 system-ui;color:#0b1220">` +
              `<strong>${heading}</strong> · ${escapeHtml(feature.properties.label ?? '')}` +
              `<br/><span style="color:#475569">${escapeHtml(feature.properties.note ?? '')}</span>` +
              `</div>`,
          )
          .addTo(instance);
      });
      instance.on('mouseleave', layer, () => {
        instance.getCanvas().style.cursor = '';
        popup.remove();
      });
    }
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
    applyData(sightings, route);

    const instance = map.current;
    // The dwell ring is a filter over the sighting source, so it has to be re-applied whenever the
    // route changes; the source data alone does not carry it.
    if (instance !== null && ready.current && instance.getLayer('route-dwell') !== undefined) {
      instance.setFilter('route-dwell', [
        'in',
        ['get', 'seq'],
        ['literal', toRouteGeometry(route).dwellAtSeq],
      ]);
    }

    // Refit only when the *route* changes, not when the selection moves, or every click would
    // yank the viewport back out.
    const key = sightings.map((s) => s.sightingId).join(',');
    if (key === fitted.current) return;
    fitted.current = key;

    // Fit to the road path when there is one: a reconstructed route can leave the box the pins
    // alone describe, and a route cropped at the viewport edge is the one part of it a reader
    // would assume was not there.
    const box = routeBounds(toRouteGeometry(route)) ?? traceBounds(sightings);
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
  }, [sightings, route, applyData]);

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
