/**
 * Cameras → map features, and the partition that decides which cameras can be drawn at all.
 *
 * ## The disjoint-set problem, made visible
 *
 * The estate splits in a way that no amount of UI polish can hide, and the honest thing is to stop
 * trying. The sandbox catalogue is a bare `[{id,name}]` array — D1-04 measured it: *"Every
 * `declared_*` column is therefore NULL"* — so the thirty cameras that have **real measured trust
 * scores** have **no coordinates**. The fifty bulk-fixture cameras have real Gujarat coordinates
 * and have never been probed, because they are not real streams.
 *
 * A map that silently drops one set misrepresents the estate: thirty invisible cameras, or fifty
 * pins the operator cannot tell apart from measured ones. So `partition` returns both halves and
 * the screen renders both — placed cameras on the map, unplaced ones in a tray that says how many
 * there are and why. **A registry that cannot place a camera is itself a Pillar 1 finding**, which
 * makes the tray a feature rather than an apology.
 */
import { bandKeyOf, type TrustBand } from './trust';

/** The fields a pin needs. A structural type, so this module never imports the generated client. */
export interface MappableCamera {
  id: string;
  externalId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  district: string | null;
  departmentId: string | null;
  departmentCode: string | null;
  cameraType: string;
  mount: string;
  adapterKind: string;
  status: string;
  catalogueStatus: string;
  trustScore: number | null;
  band: TrustBand | null;
}

export interface CameraFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    externalId: string;
    name: string;
    /** The API's band, copied verbatim; `unscored` when it was null. Never recomputed. */
    band: string;
    trustScore: number | null;
    district: string | null;
    departmentId: string | null;
    departmentCode: string | null;
    cameraType: string;
    mount: string;
    adapterKind: string;
    status: string;
    catalogueStatus: string;
  };
}

export interface CameraFeatureCollection {
  type: 'FeatureCollection';
  features: CameraFeature[];
}

/** Has coordinates → drawable. `lat`/`lon` are null together or not at all (one PostGIS point). */
export function isPlaced(camera: MappableCamera): boolean {
  return (
    camera.lat !== null &&
    camera.lon !== null &&
    Number.isFinite(camera.lat) &&
    Number.isFinite(camera.lon)
  );
}

export interface Partition<T> {
  placed: T[];
  unplaced: T[];
}

export function partition<T extends MappableCamera>(cameras: readonly T[]): Partition<T> {
  const placed: T[] = [];
  const unplaced: T[] = [];
  for (const camera of cameras) (isPlaced(camera) ? placed : unplaced).push(camera);
  return { placed, unplaced };
}

/**
 * GeoJSON for the MapLibre source.
 *
 * Coordinates are `[lon, lat]` — GeoJSON order, which is the same order the API's `bbox` filter
 * takes, so a viewport passes straight back without transposing. Unplaced cameras are skipped here
 * and rendered by the tray instead; they are never dropped.
 */
export function toFeatureCollection(
  cameras: readonly MappableCamera[],
): CameraFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cameras.filter(isPlaced).map((camera) => ({
      type: 'Feature' as const,
      id: camera.id,
      geometry: {
        type: 'Point' as const,
        coordinates: [camera.lon as number, camera.lat as number] as [number, number],
      },
      properties: {
        id: camera.id,
        externalId: camera.externalId,
        name: camera.name,
        band: bandKeyOf(camera.band),
        trustScore: camera.trustScore,
        district: camera.district,
        departmentId: camera.departmentId,
        departmentCode: camera.departmentCode,
        cameraType: camera.cameraType,
        mount: camera.mount,
        adapterKind: camera.adapterKind,
        status: camera.status,
        catalogueStatus: camera.catalogueStatus,
      },
    })),
  };
}

/** Band counts over a set of cameras — the legend's numbers, and the tray's. */
export function countByBand(cameras: readonly MappableCamera[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const camera of cameras) {
    const key = bandKeyOf(camera.band);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
