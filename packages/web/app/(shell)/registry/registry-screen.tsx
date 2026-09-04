'use client';

/**
 * The registry screen — map, panes and controls, wired together.
 *
 * ## How state and the URL relate
 *
 * The server component does the **first** fetch, from the URL, so the initial paint has data and
 * there is no client waterfall on a cold load (the number AC 9 measures). Everything after that is
 * client-side: a filter change calls the `loadCameras` server action, and the URL is rewritten with
 * `history.replaceState` rather than `router.push`.
 *
 * That choice is deliberate. `router.push` re-runs the server component and re-renders the tree,
 * which for a layer toggle — a change to which pins are drawn from data already in memory — is a
 * network round trip and a remount of the WebGL context to accomplish nothing. `replaceState`
 * updates the address bar, so a reload or a shared link still restores the exact screen, which is
 * the actual acceptance criterion.
 *
 * ## Two panes, because the estate has two halves
 *
 * Cameras with coordinates go on the map. Cameras without go in the tray, counted and coloured by
 * their real band. Both counts are on screen at all times. The seeded estate makes this unavoidable
 * rather than decorative: the cameras with measured scores are exactly the ones with no
 * coordinates, so a map-only screen would show a geolocated estate that nobody has measured and a
 * measured estate that does not appear.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import { LoadingPanel } from '@/src/components/states';
import { useToast } from '@/src/components/toast';
import {
  isVisible,
  toSearchParams,
  toggleLayer,
  MAX_MAP_FEATURES,
  type FilterPatch,
  type LayerState,
  type RegistryFilters,
} from '@/src/lib/registry/query';
import {
  countByBand,
  partition,
  toFeatureCollection,
  type MappableCamera,
} from '@/src/lib/registry/geojson';
import type { BandKey } from '@/src/lib/registry/trust';
import { MapLegend } from './map-legend';
import { LayerToggles, type DepartmentOption } from './layer-toggles';
import { FilterPanel } from './filter-panel';
import { UnplacedTray } from './unplaced-tray';
import { CameraDrawer } from './camera-drawer';
import { ImportDialog } from './import-dialog';
import { ManualAddDialog } from './manual-add-dialog';
import { RegistryToolbar } from './registry-toolbar';
import { RegistryTable } from './registry-table';
import { loadCameraDetail, loadCameras } from './actions';
import type { Camera } from './types';

/** `ssr: false` because MapLibre needs a DOM and a WebGL context, neither of which Node has. */
const RegistryMap = dynamic(() => import('./registry-map').then((m) => m.RegistryMap), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[28rem] items-center justify-center rounded-lg border border-slate-800 bg-[#0b1220]">
      <LoadingPanel rows={0} label="Loading map" />
    </div>
  ),
});

export type CameraDetailPayload = NonNullable<Awaited<ReturnType<typeof loadCameraDetail>>>;

export interface RegistryScreenProps {
  initialCameras: Camera[];
  initialCapped: boolean;
  initialElapsedMs: number;
  initialFilters: RegistryFilters;
  initialLayers: LayerState;
  initialSelected: string | null;
  departments: DepartmentOption[];
  canWrite: boolean;
  canImport: boolean;
  canDelete: boolean;
}

type View = 'map' | 'table';

export function RegistryScreen({
  initialCameras,
  initialCapped,
  initialElapsedMs,
  initialFilters,
  initialLayers,
  initialSelected,
  departments,
  canWrite,
  canImport,
  canDelete,
}: RegistryScreenProps) {
  const { notify } = useToast();

  const [filters, setFilters] = useState<RegistryFilters>(initialFilters);
  const [layers, setLayers] = useState<LayerState>(initialLayers);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [cameras, setCameras] = useState<Camera[]>(initialCameras);
  const [capped, setCapped] = useState(initialCapped);
  const [elapsedMs, setElapsedMs] = useState(initialElapsedMs);
  const [view, setView] = useState<View>('map');
  const [dialog, setDialog] = useState<'import' | 'manual' | null>(null);
  const [detail, setDetail] = useState<CameraDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  // ── URL, without a server round trip ──────────────────────────────────────────────────────────
  useEffect(() => {
    const query = toSearchParams({ filters, layers, selected }).toString();
    const next = query === '' ? window.location.pathname : `${window.location.pathname}?${query}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [filters, layers, selected]);

  // ── Refetch on a filter change ────────────────────────────────────────────────────────────────
  // Skipped on mount: the server component already fetched exactly this.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    startTransition(() => {
      void loadCameras(filters).then((page) => {
        if (page.error !== null) {
          notify(page.error, 'error');
          return;
        }
        setCameras(page.cameras);
        setCapped(page.capped);
        setElapsedMs(page.elapsedMs);
      });
    });
  }, [filters, notify]);

  // ── Drawer ────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetailLoading(true);
    void loadCameraDetail(selected).then((result) => {
      if (!live) return;
      setDetail(result);
      setDetailLoading(false);
      if (result === null) notify('That camera could not be loaded.', 'error');
    });
    return () => {
      live = false;
    };
  }, [selected, notify]);

  // ── Derived ───────────────────────────────────────────────────────────────────────────────────
  const mappable = cameras as unknown as MappableCamera[];
  const visible = useMemo(() => mappable.filter((c) => isVisible(c, layers)), [mappable, layers]);
  const { placed, unplaced } = useMemo(() => partition(visible), [visible]);
  const features = useMemo(() => toFeatureCollection(placed), [placed]);

  // Counts are over the *fetched* estate, not the visible one: a legend whose numbers shrank as you
  // hid bands could never tell you how many you had hidden.
  const bandCounts = useMemo(() => countByBand(mappable), [mappable]);
  const layerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const bump = (key: string) => {
      counts[key] = (counts[key] ?? 0) + 1;
    };
    for (const camera of mappable) {
      bump(`cameraType:${camera.cameraType}`);
      bump(`mount:${camera.mount}`);
      bump(`adapterKind:${camera.adapterKind}`);
      bump(`status:${camera.status}`);
      if (camera.departmentId !== null) bump(`department:${camera.departmentId}`);
    }
    return counts;
  }, [mappable]);

  const districts = useMemo(
    () =>
      [...new Set(mappable.map((c) => c.district).filter((d): d is string => d !== null))].sort(),
    [mappable],
  );

  const totalPlaced = useMemo(() => partition(mappable).placed.length, [mappable]);
  const totalUnplaced = mappable.length - totalPlaced;

  // ── Handlers ──────────────────────────────────────────────────────────────────────────────────
  const patchFilters = useCallback((patch: FilterPatch) => {
    setFilters((current) => {
      // `undefined` in a patch means *clear*, and under `exactOptionalPropertyTypes` a cleared key
      // has to be deleted rather than set to undefined — otherwise it round-trips into the URL.
      const next: Record<string, unknown> = { ...current, ...patch };
      for (const key of Object.keys(next)) {
        if (next[key] === undefined) delete next[key];
      }
      return next as unknown as RegistryFilters;
    });
  }, []);

  const onViewportChange = useCallback(
    (bbox: string) => {
      // Only refetch when the result was capped: below the cap the client already holds every
      // camera the filters match, so a pan is a pure GPU operation and must not touch the network.
      if (!capped) return;
      patchFilters({ bbox });
    },
    [capped, patchFilters],
  );

  const onToggleBand = useCallback((band: BandKey) => {
    setLayers((current) => toggleLayer(current, 'band', band));
  }, []);

  const onToggleLayer = useCallback((dimension: keyof LayerState, value: string) => {
    setLayers((current) => toggleLayer(current, dimension, value));
  }, []);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Camera registry</h1>
          <p className="mt-1 text-sm text-slate-400" data-testid="estate-summary">
            <span data-count="total">{cameras.length}</span> cameras ·{' '}
            <span data-count="placed">{totalPlaced}</span> on the map ·{' '}
            <span data-count="unplaced">{totalUnplaced}</span> without coordinates
            {capped ? (
              <span className="text-amber-400">
                {' '}
                · capped at {MAX_MAP_FEATURES} — zoom in to load the rest
              </span>
            ) : null}
            <span className="text-slate-600"> · API {elapsedMs} ms</span>
          </p>
        </div>
        <RegistryToolbar
          canImport={canImport}
          canWrite={canWrite}
          exportHref="/registry/export"
          onOpenImport={() => {
            setDialog('import');
          }}
          onOpenManualAdd={() => {
            setDialog('manual');
          }}
        />
      </header>

      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="space-y-5 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-4">
          <FilterPanel
            filters={filters}
            districts={districts}
            departments={departments}
            busy={pending}
            onChange={patchFilters}
            onReset={() => {
              setFilters({ limit: filters.limit });
            }}
          />
          <hr className="border-slate-800" />
          <MapLegend counts={bandCounts} hidden={layers.band} onToggle={onToggleBand} />
          <hr className="border-slate-800" />
          <LayerToggles
            layers={layers}
            counts={layerCounts}
            departments={departments}
            onToggle={onToggleLayer}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            {(['map', 'table'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-view={option}
                aria-pressed={view === option}
                onClick={() => {
                  setView(option);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                  view === option
                    ? 'border-sky-800 bg-sky-950/50 text-sky-200'
                    : 'border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-600'
                }`}
              >
                {option === 'map' ? 'Map' : 'Table'}
              </button>
            ))}
            <span className="ml-1 text-[11px] text-slate-500" data-testid="visible-count">
              {placed.length} drawn · {unplaced.length} in the tray
            </span>
          </div>

          {view === 'map' ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="h-[calc(100dvh-17rem)] min-h-[28rem]">
                <RegistryMap
                  data={features}
                  selected={selected}
                  onSelect={setSelected}
                  onViewportChange={onViewportChange}
                  initialBbox={initialFilters.bbox ?? null}
                />
              </div>
              <div className="h-[calc(100dvh-17rem)] min-h-[28rem] overflow-hidden">
                <UnplacedTray cameras={unplaced} selected={selected} onSelect={setSelected} />
              </div>
            </div>
          ) : (
            <RegistryTable
              cameras={visible as unknown as Camera[]}
              canWrite={canWrite}
              canDelete={canDelete}
              onSelect={setSelected}
            />
          )}
        </div>
      </div>

      {selected === null ? null : (
        <CameraDrawer
          detail={detail}
          loading={detailLoading}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}

      {dialog === 'import' ? (
        <ImportDialog
          onClose={() => {
            setDialog(null);
            // The estate changed underneath us; reload it rather than leaving a stale map.
            startTransition(() => {
              void loadCameras(filters).then((page) => {
                if (page.error === null) {
                  setCameras(page.cameras);
                  setCapped(page.capped);
                }
              });
            });
          }}
        />
      ) : null}

      {dialog === 'manual' ? (
        <ManualAddDialog
          onClose={() => {
            setDialog(null);
            startTransition(() => {
              void loadCameras(filters).then((page) => {
                if (page.error === null) {
                  setCameras(page.cameras);
                  setCapped(page.capped);
                }
              });
            });
          }}
        />
      ) : null}
    </div>
  );
}
