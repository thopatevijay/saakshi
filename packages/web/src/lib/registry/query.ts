/**
 * Registry screen state ⇄ URL, as one pure module.
 *
 * The acceptance criterion is *"every layer toggle and filter works, composes with the others, and
 * survives a page reload via URL state"*. That is a round-trip property — `parse(serialise(s))
 * === s` — and a property is worth testing only if it lives in a function with no React and no
 * network in it. Hence this file: no imports beyond the band vocabulary, every export pure.
 *
 * ## Two kinds of control, deliberately different
 *
 * **Filters** are D1-02's query contract, sent to `GET /api/v1/cameras`. They change *what is
 * fetched* — the server does the work, the bbox filter uses the PostGIS GiST index, and a filtered
 * estate of 100k cameras never crosses the wire. D1-02's published contract, verbatim:
 * `departmentId · district · cameraType · mount · adapterKind · status · geometryClass ·
 * trustMin/trustMax · bbox(minLon,minLat,maxLon,maxLat) · q · limit(1–500) · cursor`.
 *
 * **Layer toggles** change *what is drawn* from what was already fetched. They are client-side on
 * purpose: toggling a band off is a legend interaction and must be instant, and a round trip to
 * repaint pins that are already in the browser is latency for nothing.
 *
 * Both go in the URL, so a shared link restores the whole screen.
 *
 * ## Why toggles serialise as "hidden", not "shown"
 *
 * Default is everything visible. Serialising the *hidden* set means the default state has an empty
 * query string — a clean URL — and an unknown value added by a later ticket fails safe to visible
 * rather than silently vanishing from a colleague's map.
 *
 * ## Unknown values are dropped, never passed through
 *
 * Anything not in the enum is discarded at parse time. The API validates too, but a client that
 * forwards junk turns a typo in a shared link into a 400 the recipient cannot explain.
 */
import { BAND_KEYS, isBandKey, type BandKey } from './trust';

// ── The vocabulary, mirrored from `camera-contracts.ts` ─────────────────────────────────────────

export const CAMERA_TYPES = ['analog', 'ip'] as const;
export const CAMERA_MOUNTS = ['static', 'mobile'] as const;
export const ADAPTER_KINDS = ['hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file'] as const;
export const CAMERA_STATUSES = ['unknown', 'online', 'degraded', 'offline'] as const;
export const GEOMETRY_CLASSES = ['anpr_viable', 'detection_only', 'unclassified'] as const;

export type CameraType = (typeof CAMERA_TYPES)[number];
export type CameraMount = (typeof CAMERA_MOUNTS)[number];
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
export type CameraStatus = (typeof CAMERA_STATUSES)[number];
export type GeometryClass = (typeof GEOMETRY_CLASSES)[number];

/** D1-02's contract caps `limit` at 500. Asking for more is a 400, not a bigger page. */
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 500;

/**
 * How many cameras the map will hold at once.
 *
 * D1-02 caps `limit` at 500 a page, so a statewide view of a 100k estate is paged. Rather than page
 * forever, the map fetches up to this many and **says so** — a legend that silently shows 2,000 of
 * 100,000 cameras is a lie about coverage, and coverage is the thing this screen exists to report
 * on. Zooming in narrows the bbox and the cap stops binding.
 *
 * Lives here rather than beside the action that enforces it because a `'use server'` module may
 * export only async functions.
 */
export const MAX_MAP_FEATURES = 2000;

// ── State ───────────────────────────────────────────────────────────────────────────────────────

/** Server-side filters. Every key is a D1-02 query parameter, spelled exactly as the API spells it. */
export interface RegistryFilters {
  departmentId?: string;
  district?: string;
  cameraType?: CameraType;
  mount?: CameraMount;
  adapterKind?: AdapterKind;
  status?: CameraStatus;
  geometryClass?: GeometryClass;
  trustMin?: number;
  trustMax?: number;
  bbox?: string;
  q?: string;
  limit: number;
}

/**
 * Client-side visibility. Each set holds the values that are **hidden**.
 *
 * `department` is here as well as in the filters because the two answer different questions: the
 * filter narrows the fetch to one department, the toggle dims one department while keeping the rest
 * of the estate on screen for comparison.
 */
export interface LayerState {
  band: ReadonlySet<BandKey>;
  cameraType: ReadonlySet<CameraType>;
  mount: ReadonlySet<CameraMount>;
  adapterKind: ReadonlySet<AdapterKind>;
  status: ReadonlySet<CameraStatus>;
  department: ReadonlySet<string>;
}

/**
 * A change to the filters, where `undefined` means **clear this one**.
 *
 * `Partial<RegistryFilters>` will not do under `exactOptionalPropertyTypes`: it makes a key
 * omittable but forbids passing `undefined` as its value, and "the operator emptied the search box"
 * has to be expressible.
 */
export type FilterPatch = { [K in keyof RegistryFilters]?: RegistryFilters[K] | undefined };

export interface RegistryState {
  filters: RegistryFilters;
  layers: LayerState;
  /** Which camera the detail drawer is open on, by id. In the URL so a link opens the drawer too. */
  selected: string | null;
}

/** The dimensions a layer toggle can hide, and the URL key each serialises under. */
export const LAYER_PARAM: Record<keyof LayerState, string> = {
  band: 'hideBand',
  cameraType: 'hideType',
  mount: 'hideMount',
  adapterKind: 'hideAdapter',
  status: 'hideStatus',
  department: 'hideDept',
};

const LAYER_VOCABULARY: Record<keyof LayerState, readonly string[] | null> = {
  band: BAND_KEYS,
  cameraType: CAMERA_TYPES,
  mount: CAMERA_MOUNTS,
  adapterKind: ADAPTER_KINDS,
  status: CAMERA_STATUSES,
  // Department ids are uuids from the API, not a fixed enum — validated by shape, not membership.
  department: null,
};

export function emptyLayers(): LayerState {
  return {
    band: new Set(),
    cameraType: new Set(),
    mount: new Set(),
    adapterKind: new Set(),
    status: new Set(),
    department: new Set(),
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BBOX = /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/;

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function bounded(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** `URLSearchParams` or the plain object Next hands a server component. */
export type ParamsInput = URLSearchParams | Record<string, string | string[] | undefined>;

function toSearch(input: ParamsInput): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

export function parseFilters(input: ParamsInput): RegistryFilters {
  const p = toSearch(input);
  const text = (key: string): string | undefined => {
    const raw = p.get(key);
    return raw === null || raw.trim() === '' ? undefined : raw.trim();
  };

  const departmentId = p.get('departmentId');
  const bbox = p.get('bbox');

  return {
    ...(departmentId !== null && UUID.test(departmentId) ? { departmentId } : {}),
    ...(text('district') === undefined ? {} : { district: text('district') as string }),
    ...(oneOf(p.get('cameraType'), CAMERA_TYPES) === undefined
      ? {}
      : { cameraType: oneOf(p.get('cameraType'), CAMERA_TYPES) as CameraType }),
    ...(oneOf(p.get('mount'), CAMERA_MOUNTS) === undefined
      ? {}
      : { mount: oneOf(p.get('mount'), CAMERA_MOUNTS) as CameraMount }),
    ...(oneOf(p.get('adapterKind'), ADAPTER_KINDS) === undefined
      ? {}
      : { adapterKind: oneOf(p.get('adapterKind'), ADAPTER_KINDS) as AdapterKind }),
    ...(oneOf(p.get('status'), CAMERA_STATUSES) === undefined
      ? {}
      : { status: oneOf(p.get('status'), CAMERA_STATUSES) as CameraStatus }),
    ...(oneOf(p.get('geometryClass'), GEOMETRY_CLASSES) === undefined
      ? {}
      : { geometryClass: oneOf(p.get('geometryClass'), GEOMETRY_CLASSES) as GeometryClass }),
    ...(bounded(p.get('trustMin'), 0, 100) === undefined
      ? {}
      : { trustMin: bounded(p.get('trustMin'), 0, 100) as number }),
    ...(bounded(p.get('trustMax'), 0, 100) === undefined
      ? {}
      : { trustMax: bounded(p.get('trustMax'), 0, 100) as number }),
    ...(bbox !== null && BBOX.test(bbox) ? { bbox } : {}),
    ...(text('q') === undefined ? {} : { q: text('q') as string }),
    limit: bounded(p.get('limit'), 1, MAX_LIMIT) ?? DEFAULT_LIMIT,
  };
}

export function parseLayers(input: ParamsInput): LayerState {
  const p = toSearch(input);
  const layers = emptyLayers() as Record<keyof LayerState, Set<string>>;

  for (const dimension of Object.keys(LAYER_PARAM) as (keyof LayerState)[]) {
    const raw = p.get(LAYER_PARAM[dimension]);
    if (raw === null) continue;
    const vocabulary = LAYER_VOCABULARY[dimension];
    for (const value of raw.split(',').map((v) => v.trim())) {
      if (value === '') continue;
      // Unknown value → dropped. A typo in a shared link must not hide a camera silently.
      if (vocabulary === null ? UUID.test(value) : vocabulary.includes(value)) {
        layers[dimension].add(value);
      }
    }
  }

  return layers as unknown as LayerState;
}

export function parseRegistryState(input: ParamsInput): RegistryState {
  const p = toSearch(input);
  const selected = p.get('camera');
  return {
    filters: parseFilters(p),
    layers: parseLayers(p),
    selected: selected !== null && UUID.test(selected) ? selected : null,
  };
}

// ── Serialising ─────────────────────────────────────────────────────────────────────────────────

/**
 * State → query string. Only non-default values are written, so an untouched screen has a bare URL
 * and a shared link says exactly what was changed.
 */
export function toSearchParams(state: RegistryState): URLSearchParams {
  const p = new URLSearchParams();
  const f = state.filters;

  if (f.departmentId !== undefined) p.set('departmentId', f.departmentId);
  if (f.district !== undefined) p.set('district', f.district);
  if (f.cameraType !== undefined) p.set('cameraType', f.cameraType);
  if (f.mount !== undefined) p.set('mount', f.mount);
  if (f.adapterKind !== undefined) p.set('adapterKind', f.adapterKind);
  if (f.status !== undefined) p.set('status', f.status);
  if (f.geometryClass !== undefined) p.set('geometryClass', f.geometryClass);
  if (f.trustMin !== undefined) p.set('trustMin', String(f.trustMin));
  if (f.trustMax !== undefined) p.set('trustMax', String(f.trustMax));
  if (f.bbox !== undefined) p.set('bbox', f.bbox);
  if (f.q !== undefined) p.set('q', f.q);
  if (f.limit !== DEFAULT_LIMIT) p.set('limit', String(f.limit));

  for (const dimension of Object.keys(LAYER_PARAM) as (keyof LayerState)[]) {
    const hidden = [...state.layers[dimension]].sort();
    if (hidden.length > 0) p.set(LAYER_PARAM[dimension], hidden.join(','));
  }

  if (state.selected !== null) p.set('camera', state.selected);

  return p;
}

/**
 * Filters → the query object `apiClient(...).GET('/api/v1/cameras')` takes.
 *
 * Nothing is renamed on the way: every key here is already a D1-02 parameter name, which is the
 * point — a translation table between two spellings of the same contract is a place for them to
 * drift.
 */
export function toCameraListQuery(
  filters: RegistryFilters,
  cursor?: string,
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit: filters.limit };
  const copy = <K extends keyof RegistryFilters>(key: K) => {
    const value = filters[key];
    if (value !== undefined && key !== 'limit') query[key] = value;
  };

  copy('departmentId');
  copy('district');
  copy('cameraType');
  copy('mount');
  copy('adapterKind');
  copy('status');
  copy('geometryClass');
  copy('trustMin');
  copy('trustMax');
  copy('bbox');
  copy('q');
  if (cursor !== undefined && cursor !== '') query['cursor'] = cursor;

  return query;
}

// ── Composition ─────────────────────────────────────────────────────────────────────────────────

/** The subset of a camera the visibility rule reads. */
export interface Visibility {
  band: string | null;
  cameraType: string;
  mount: string;
  adapterKind: string;
  status: string;
  departmentId: string | null;
}

/**
 * Does this camera survive every toggle?
 *
 * **Every** — the toggles compose as AND across dimensions, which is the acceptance criterion's
 * "composes with the others". A camera hidden by the band toggle stays hidden however its adapter
 * is set.
 */
export function isVisible(camera: Visibility, layers: LayerState): boolean {
  const bandKey: BandKey = camera.band !== null && isBandKey(camera.band) ? camera.band : 'unscored';
  if (layers.band.has(bandKey)) return false;
  if (layers.cameraType.has(camera.cameraType as CameraType)) return false;
  if (layers.mount.has(camera.mount as CameraMount)) return false;
  if (layers.adapterKind.has(camera.adapterKind as AdapterKind)) return false;
  if (layers.status.has(camera.status as CameraStatus)) return false;
  if (camera.departmentId !== null && layers.department.has(camera.departmentId)) return false;
  return true;
}

/** Toggle one value on one dimension, returning fresh state (never mutating the old). */
export function toggleLayer(
  layers: LayerState,
  dimension: keyof LayerState,
  value: string,
): LayerState {
  const next = new Set<string>(layers[dimension]);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return { ...layers, [dimension]: next };
}

/** A viewport as the API's `bbox` string. Longitude first — the ordering everyone gets wrong once. */
export function bboxParam(bounds: {
  getWest: () => number;
  getSouth: () => number;
  getEast: () => number;
  getNorth: () => number;
}): string {
  const round = (n: number): string => n.toFixed(4);
  return [
    round(bounds.getWest()),
    round(bounds.getSouth()),
    round(bounds.getEast()),
    round(bounds.getNorth()),
  ].join(',');
}
