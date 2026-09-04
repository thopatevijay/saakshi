'use client';

/**
 * The map.
 *
 * ## Three decisions worth explaining
 *
 * **1 · The pin colour is the API's band, copied.** The paint expressions come from
 * `src/lib/registry/trust.ts` and are `match` over the `band` property — no arithmetic, no
 * threshold, nothing this component could get wrong independently of the server. A test asserts the
 * expressions contain no number, because the failure mode D1-06 warned about (a camera that went
 * dark yesterday still painted green from its stale score) is invisible on screen.
 *
 * **2 · Layer toggles refilter the data, they do not hide a layer.** A clustered source clusters
 * what it is given, so hiding `dead` with a layer `filter` would leave the *clusters* still
 * counting the dead cameras — a cluster badge reading 12 over 9 visible pins. Refiltering and
 * calling `setData` reclusters, so every number on screen agrees with every other one.
 *
 * **3 · A cluster is coloured by the worst band inside it.** `clusterProperties` counts each band
 * as the cluster forms, and the badge takes the worst present. Averaging would let one dead camera
 * disappear into forty trusted ones, which is precisely the reassurance this product exists to
 * withhold.
 *
 * ## Smoothness
 *
 * `moveend` is debounced and the viewport refetch is bbox-bounded, so a pan neither re-renders
 * React nor issues a request per frame. Nothing in the render path depends on map state: the map
 * instance, the last bbox and the pending timer are all refs.
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
import type { Feature, FeatureCollection, Point } from 'geojson';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BASEMAP_MAX_ZOOM,
  GUJARAT_BOUNDS,
  GUJARAT_CENTER,
  GUJARAT_ZOOM,
  basemapStyle,
} from '@/src/lib/registry/basemap-style';
import {
  BAND_KEYS,
  BAND_STYLE,
  bandFillExpression,
  bandStrokeExpression,
  bandStrokeWidthExpression,
} from '@/src/lib/registry/trust';
import type { CameraFeatureCollection } from '@/src/lib/registry/geojson';
import { bboxParam } from '@/src/lib/registry/query';

/**
 * The `pmtiles://` protocol, registered once per page — MapLibre keys protocols globally.
 *
 * ## Why this package is pinned to MapLibre 5, not 6
 *
 * MapLibre 6 loads its tile worker from a separate file, resolved with
 * `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Under webpack — which is what
 * `next build` uses — `import.meta.url` is not an `http(s):` URL, so MapLibre's own guard gives up
 * and returns `''`, and `new Worker('')` resolves against the **document**: it fetches `/registry`,
 * gets HTML, and dies with `Failed to load module script … MIME type "text/html"`.
 *
 * The failure mode is what makes this worth a paragraph. The map constructs, the canvas appears,
 * the style's sources resolve on the main thread, `map.on('error')` fires **nothing** — and the map
 * is simply blank, because every tile is parsed in a worker that never started. Pointing
 * `setWorkerUrl` at a webpack-emitted asset gets the worker to load and then fails one level
 * deeper, because the worker's own relative import of `maplibre-gl-shared.mjs` is not emitted
 * beside it.
 *
 * MapLibre 5 bundles the worker into the main file and creates it from a blob, so there is nothing
 * to resolve and nothing to vendor. Version 6 would need a copy step into `public/` that a fresh
 * clone must remember to run — a build dependency whose failure is an invisible blank map. Logged
 * to `BL-01`; revisit if a later ticket needs a v6-only feature.
 */
let protocolRegistered = false;
function registerMapGlobals(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

const SOURCE = 'cameras';
const EMPTY: CameraFeatureCollection = { type: 'FeatureCollection', features: [] };

/** Worst-first. A cluster takes the first band it actually contains. */
const SEVERITY: readonly (typeof BAND_KEYS)[number][] = [
  'dead',
  'untrusted',
  'degraded',
  'unscored',
  'trusted',
];

/** `case` chain over the per-band counts `clusterProperties` accumulates. */
function clusterColourExpression(): unknown[] {
  const chain: unknown[] = ['case'];
  for (const band of SEVERITY) {
    chain.push(['>', ['get', band], 0], BAND_STYLE[band].fill ?? '#64748b');
  }
  chain.push('#64748b');
  return chain;
}

/** One accumulator per band, so a cluster knows what it is made of. */
function clusterProperties(): Record<string, unknown> {
  return Object.fromEntries(
    BAND_KEYS.map((band) => [
      band,
      ['+', ['case', ['==', ['get', 'band'], band], 1, 0]],
    ]),
  );
}

export interface RegistryMapProps {
  data: CameraFeatureCollection;
  /** Camera id, or null. Drives the halo layer. */
  selected: string | null;
  onSelect: (cameraId: string | null) => void;
  /** Fired after a pan or zoom settles, with the viewport as an API `bbox` string. */
  onViewportChange?: (bbox: string) => void;
  /** Restored from the URL, so a shared link opens on the same view. */
  initialBbox?: string | null;
}

export function RegistryMap({
  data,
  selected,
  onSelect,
  onViewportChange,
  initialBbox,
}: RegistryMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<CameraFeatureCollection>(data);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref rather than a dependency so the map is built exactly once; a callback identity
  // change must never tear down a WebGL context.
  const handlers = useRef({ onSelect, onViewportChange });
  handlers.current = { onSelect, onViewportChange };

  const applyData = useCallback((collection: CameraFeatureCollection) => {
    pending.current = collection;
    // The exact collection the source is holding, for the verification scripts. MapLibre keeps its
    // copy on a private field, and reading a private field is a test that breaks on a patch bump.
    (window as unknown as { __saakshiFeatures?: CameraFeatureCollection }).__saakshiFeatures =
      collection;
    const instance = map.current;
    if (instance === null || !ready.current) return;
    const source: GeoJSONSource | undefined = instance.getSource(SOURCE);
    // `setData` returns the source for chaining, and its type says `Promise`-like in v6; nothing
    // here awaits it, so the intent is marked explicitly rather than left floating.
    void source?.setData(collection);
  }, []);

  // ── Build the map, once ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (container.current === null || map.current !== null) return;
    registerMapGlobals();

    const bounds: LngLatBoundsLike = [
      [GUJARAT_BOUNDS[0], GUJARAT_BOUNDS[1]],
      [GUJARAT_BOUNDS[2], GUJARAT_BOUNDS[3]],
    ];

    const instance = new MlMap({
      container: container.current,
      style: basemapStyle() as unknown as StyleSpecification,
      center: GUJARAT_CENTER,
      zoom: GUJARAT_ZOOM,
      // The extract holds z0–12. Beyond that MapLibre would ask for tiles that do not exist;
      // `maxZoom` above it plus `overzoom` on the source keeps the last real tile scaled instead.
      maxZoom: 16,
      // Panning out of Gujarat would show empty ocean, because there are no tiles out there.
      maxBounds: [
        [GUJARAT_BOUNDS[0] - 1.5, GUJARAT_BOUNDS[1] - 1.5],
        [GUJARAT_BOUNDS[2] + 1.5, GUJARAT_BOUNDS[3] + 1.5],
      ],
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      // The estate is static geography; a rotated police map is a map somebody misreads under time
      // pressure.
      dragRotate: false,
      pitchWithRotate: false,
    });

    map.current = instance;

    // A WebGL canvas is opaque to every kind of assertion. The verification scripts
    // (`packages/web/scripts/verify-*.mjs`) read the live source through this handle to check
    // feature coordinates against `psql`, count clusters, and time frames during a pan — none of
    // which can be done from the DOM. Kept deliberately rather than stripped in production: the
    // acceptance criteria have to stay re-runnable against a real deployment, and a debug handle
    // that only exists in development is a debug handle that has never been exercised.
    (window as unknown as { __saakshiMap?: MlMap }).__saakshiMap = instance;
    const markIdle = (value: boolean) => {
      (window as unknown as { __saakshiMapIdle?: boolean }).__saakshiMapIdle = value;
    };
    markIdle(false);
    instance.on('idle', () => {
      markIdle(true);
    });

    // Map errors are per-tile and non-fatal, so MapLibre only writes them to the console — where,
    // on a console-room screen nobody has open, they are invisible. Collected here so a failing
    // basemap is diagnosable after the fact instead of presenting as "the map is grey".
    const errors: string[] = [];
    (window as unknown as { __saakshiMapErrors?: string[] }).__saakshiMapErrors = errors;
    instance.on('error', (event: { error?: { message?: string } }) => {
      errors.push(event.error?.message ?? 'unknown map error');
    });
    instance.on('movestart', () => {
      markIdle(false);
    });

    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    instance.fitBounds(bounds, { padding: 24, animate: false });

    if (initialBbox !== undefined && initialBbox !== null) {
      const parts = initialBbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [west, south, east, north] = parts as [number, number, number, number];
        instance.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 16, animate: false },
        );
      }
    }

    instance.on('load', () => {
      instance.addSource(SOURCE, {
        type: 'geojson',
        data: pending.current as unknown as FeatureCollection,
        cluster: true,
        // Cluster right up to the last basemap zoom: statewide is where the estate is unreadable
        // as individual pins, and that is the zoom a commissioner looks at.
        clusterMaxZoom: BASEMAP_MAX_ZOOM - 1,
        clusterRadius: 46,
        clusterProperties: clusterProperties(),
        promoteId: 'id',
      });

      instance.addLayer({
        id: 'clusters',
        type: 'circle',
        source: SOURCE,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': clusterColourExpression() as unknown as DataDrivenPropertyValueSpecification<string>,
          'circle-opacity': 0.85,
          'circle-radius': [
            'step',
            ['get', 'point_count'],
            14,
            10,
            18,
            50,
            24,
            200,
            30,
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b1220',
        },
      });

      instance.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: SOURCE,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 11,
        },
        paint: { 'text-color': '#0b1220' },
      });

      instance.addLayer({
        id: 'selected-halo',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'id'], ''],
        paint: {
          'circle-radius': 13,
          'circle-color': 'rgba(56,189,248,0.28)',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#38bdf8',
        },
      });

      instance.addLayer({
        id: 'camera-pins',
        type: 'circle',
        source: SOURCE,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': bandFillExpression() as unknown as DataDrivenPropertyValueSpecification<string>,
          'circle-stroke-color': bandStrokeExpression() as unknown as DataDrivenPropertyValueSpecification<string>,
          'circle-stroke-width':
            bandStrokeWidthExpression() as unknown as DataDrivenPropertyValueSpecification<number>,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 10, 6.5, 14, 9],
        },
      });

      ready.current = true;
      applyData(pending.current);

      const cursor = (value: string) => () => {
        instance.getCanvas().style.cursor = value;
      };
      for (const layer of ['camera-pins', 'clusters']) {
        instance.on('mouseenter', layer, cursor('pointer'));
        instance.on('mouseleave', layer, cursor(''));
      }

      instance.on('click', 'camera-pins', (event: MapMouseEvent & { features?: Feature[] }) => {
        const id: unknown = event.features?.[0]?.properties?.['id'];
        if (typeof id === 'string') handlers.current.onSelect(id);
      });

      // Clicking a cluster zooms into it rather than opening thirty drawers.
      instance.on('click', 'clusters', (event: MapMouseEvent & { features?: Feature[] }) => {
        const feature = event.features?.[0];
        if (feature === undefined) return;
        const clusterId: unknown = feature.properties?.['cluster_id'];
        if (typeof clusterId !== 'number') return;
        const source = instance.getSource(SOURCE) as GeoJSONSource;
        void source.getClusterExpansionZoom(clusterId).then((zoom) => {
          instance.easeTo({
            center: (feature.geometry as Point).coordinates as [number, number],
            zoom,
            duration: 400,
          });
        });
      });

      instance.on('click', (event: MapMouseEvent) => {
        const hits = instance.queryRenderedFeatures(event.point, {
          layers: ['camera-pins', 'clusters'],
        });
        if (hits.length === 0) handlers.current.onSelect(null);
      });
    });

    // Debounced: a pan fires `moveend` once, but a kinetic flick can fire several in quick
    // succession, and each one would otherwise be a request.
    instance.on('moveend', () => {
      if (moveTimer.current !== null) clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(() => {
        handlers.current.onViewportChange?.(bboxParam(instance.getBounds()));
      }, 350);
    });

    return () => {
      if (moveTimer.current !== null) clearTimeout(moveTimer.current);
      ready.current = false;
      instance.remove();
      map.current = null;
    };
    // Built once, with an empty dependency list. `initialBbox` and `applyData` are read at
    // construction and deliberately excluded: a URL change or a new callback identity must never
    // rebuild the WebGL context.
  }, []);

  useEffect(() => {
    applyData(data);
  }, [data, applyData]);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready.current || instance.getLayer('selected-halo') === undefined) {
      return;
    }
    instance.setFilter('selected-halo', ['==', ['get', 'id'], selected ?? '']);
  }, [selected]);

  return (
    <div
      ref={container}
      // A canvas is not readable, so the region is labelled and the counts live in the legend and
      // the tray beside it — both of which are real text.
      role="application"
      aria-label="Camera registry map of Gujarat"
      className="size-full min-h-[28rem] rounded-lg border border-slate-800 bg-[#0b1220]"
      data-testid="registry-map"
    />
  );
}

export default RegistryMap;

/** Re-exported so the empty collection has one definition. */
export const EMPTY_FEATURES = EMPTY;
