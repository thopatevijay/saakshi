/**
 * The registry edit form, parsed and validated (D4-20).
 *
 * Pure, so the rules are unit-tested rather than trusted. The bounds mirror `CameraCreate` in
 * `packages/api/src/routes/camera-contracts.ts` — the API re-validates every field, so this layer
 * exists only to put the message next to the field instead of behind an HTTP 400.
 *
 * A form that fails here is **never sent**: the server action returns the field errors and the
 * PATCH does not happen, so nothing is saved.
 */
import {
  ADAPTER_KINDS,
  CAMERA_MOUNTS,
  CAMERA_TYPES,
  GEOMETRY_CLASSES,
  STORAGE_TYPES,
} from './query';

export interface CameraEditBody {
  name: string;
  lat?: number;
  lon?: number;
  address: string | null;
  district: string | null;
  cameraType: (typeof CAMERA_TYPES)[number];
  mount: (typeof CAMERA_MOUNTS)[number];
  geometryClass: (typeof GEOMETRY_CLASSES)[number];
  adapterKind: (typeof ADAPTER_KINDS)[number];
  vendor: string | null;
  vmsPlatform: string | null;
  retentionDays: number | null;
  storageType: (typeof STORAGE_TYPES)[number] | null;
}

export type CameraEditResult =
  { ok: true; body: CameraEditBody } | { ok: false; fieldErrors: Record<string, string> };

type Read = (name: string) => string;

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function nullable(value: string): string | null {
  return value === '' ? null : value;
}

/** Latitude and longitude travel together: one without the other cannot place a pin. */
function coordinates(read: Read, errors: Record<string, string>): { lat?: number; lon?: number } {
  const rawLat = read('lat');
  const rawLon = read('lon');
  if (rawLat === '' && rawLon === '') return {};

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (rawLat === '') errors['lat'] = 'Enter a latitude with the longitude.';
  else if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    errors['lat'] = 'Latitude must be a number between -90 and 90.';
  if (rawLon === '') errors['lon'] = 'Enter a longitude with the latitude.';
  else if (!Number.isFinite(lon) || lon < -180 || lon > 180)
    errors['lon'] = 'Longitude must be a number between -180 and 180.';

  return errors['lat'] === undefined && errors['lon'] === undefined ? { lat, lon } : {};
}

function retention(raw: string, errors: Record<string, string>): number | null {
  if (raw === '') return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    errors['retentionDays'] = 'Retention must be a whole number of days from 0 to 3650.';
    return null;
  }
  return days;
}

/** Parse the edit form. `read` returns the trimmed field value, or `''` when absent. */
export function parseCameraEdit(read: Read): CameraEditResult {
  const errors: Record<string, string> = {};

  const name = read('name');
  if (name === '') errors['name'] = 'A name is required.';
  else if (name.length > 256) errors['name'] = 'A name is at most 256 characters.';

  const coords = coordinates(read, errors);
  const retentionDays = retention(read('retentionDays'), errors);

  const cameraType = oneOf(read('cameraType'), CAMERA_TYPES);
  const mount = oneOf(read('mount'), CAMERA_MOUNTS);
  const geometryClass = oneOf(read('geometryClass'), GEOMETRY_CLASSES);
  const adapterKind = oneOf(read('adapterKind'), ADAPTER_KINDS);
  const rawStorage = read('storageType');
  const storageType = rawStorage === '' ? null : oneOf(rawStorage, STORAGE_TYPES);
  if (cameraType === undefined) errors['cameraType'] = 'Choose a camera type.';
  if (mount === undefined) errors['mount'] = 'Choose a mount.';
  if (geometryClass === undefined) errors['geometryClass'] = 'Choose a geometry class.';
  if (adapterKind === undefined) errors['adapterKind'] = 'Choose an adapter.';
  if (storageType === undefined) errors['storageType'] = 'Choose cloud, local or blank.';

  if (
    Object.keys(errors).length > 0 ||
    cameraType === undefined ||
    mount === undefined ||
    geometryClass === undefined ||
    adapterKind === undefined ||
    storageType === undefined
  ) {
    return { ok: false, fieldErrors: errors };
  }

  return {
    ok: true,
    body: {
      name,
      ...coords,
      address: nullable(read('address')),
      district: nullable(read('district')),
      cameraType,
      mount,
      geometryClass,
      adapterKind,
      vendor: nullable(read('vendor')),
      vmsPlatform: nullable(read('vmsPlatform')),
      retentionDays,
      storageType,
    },
  };
}
