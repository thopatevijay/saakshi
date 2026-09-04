/**
 * Tolerant catalogue parsing.
 *
 * The upstream payload shape is **undocumented**. The Integrator's Guide describes one thing and
 * the deployed sandbox returns another — a bare `[{id,name}]` array with no codec, no fps and no
 * status (D0-01, logged on BL-01). The camera set and the payload can both change between now and
 * evaluation day, so parsing probes a set of plausible shapes and key names rather than asserting
 * one, and when nothing matches it fails **loudly**, naming every key it looked for and handing the
 * raw payload back so it can be persisted for inspection.
 *
 * The alternative — a strict schema — turns a renamed upstream key into a 502 on stage with no clue
 * what the payload actually was.
 */

/** Wrapper keys probed when the payload is an object rather than an array. Order is preference. */
const ARRAY_KEYS = [
  'cameras',
  'data',
  'items',
  'results',
  'result',
  'records',
  'feeds',
  'streams',
  'channels',
  'devices',
  'list',
] as const;

/** Per-entry aliases for the camera's upstream identifier. Order is preference. */
const ID_KEYS = [
  'id',
  'camera_id',
  'cameraId',
  'external_id',
  'externalId',
  'cameraCode',
  'camera_code',
  'code',
  'uid',
  'uuid',
  'deviceId',
  'device_id',
  'streamId',
  'stream_id',
  'channelId',
  'channel_id',
  'key',
] as const;

const NAME_KEYS = [
  'name',
  'camera_name',
  'cameraName',
  'title',
  'label',
  'display_name',
  'displayName',
  'location_name',
  'locationName',
  'description',
] as const;

/** Everything below is *declared*, never measured, and is only stored when actually supplied. */
const CODEC_KEYS = ['codec', 'video_codec', 'videoCodec', 'encoding', 'format'] as const;
const FPS_KEYS = ['fps', 'frame_rate', 'frameRate', 'framerate'] as const;
const RESOLUTION_KEYS = ['resolution', 'video_resolution', 'videoResolution'] as const;
const WIDTH_KEYS = ['width', 'video_width', 'videoWidth'] as const;
const HEIGHT_KEYS = ['height', 'video_height', 'videoHeight'] as const;
const LAT_KEYS = ['lat', 'latitude', 'y'] as const;
const LON_KEYS = ['lon', 'lng', 'long', 'longitude', 'x'] as const;
const ADDRESS_KEYS = ['address', 'street', 'location', 'place'] as const;
const DISTRICT_KEYS = ['district', 'zone', 'city', 'region'] as const;
const VENDOR_KEYS = ['vendor', 'make', 'manufacturer', 'brand'] as const;
/** Adapter endpoints. `GET /api/ingest` is the contract; the URL pattern is not — so it is read. */
const HLS_KEYS = ['hls', 'hls_url', 'hlsUrl', 'm3u8', 'playlist', 'url', 'stream_url'] as const;
const RTSP_KEYS = ['rtsp', 'rtsp_url', 'rtspUrl', 'rtsp_uri'] as const;

/** One catalogue entry, reduced to what we are willing to believe. */
export interface CatalogueEntry {
  externalId: string;
  name: string;
  declaredCodec?: string;
  declaredFps?: number;
  declaredResolution?: string;
  lat?: number;
  lon?: number;
  address?: string;
  district?: string;
  vendor?: string;
  endpoints: Record<string, string>;
}

export interface ParsedCatalogue {
  entries: CatalogueEntry[];
  /** Which strategy matched — 'array' or `wrapped:<key>`. Recorded on the run row. */
  shape: string;
  /** Entries the parser could not identify, reported rather than silently dropped. */
  rejections: {
    row: number;
    externalId: string | null;
    errors: { field: string; message: string }[];
  }[];
}

/**
 * Thrown when no probed shape matches. Carries the raw payload so the caller can persist it — the
 * AC is explicit that an unknown shape must leave the raw JSON behind for inspection.
 */
export class UnknownCatalogueShapeError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.name = 'UnknownCatalogueShapeError';
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First key present with a usable value. Empty strings do not count as present. */
function pick(entry: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

function pickString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = pick(entry, keys);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickNumber(entry: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const value = pick(entry, keys);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Upstreams commonly send numbers as strings ("25", "23.02"). Accept, but only if the whole
  // string is numeric — "25 fps" is a claim we do not understand and will not guess at.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

/**
 * Locates the array of cameras. A bare array is the sandbox's shape; a wrapped array is what most
 * documented APIs return, so both are probed before giving up.
 */
function locateArray(payload: unknown): { rows: unknown[]; shape: string } {
  if (Array.isArray(payload)) return { rows: payload, shape: 'array' };

  if (isRecord(payload)) {
    for (const key of ARRAY_KEYS) {
      const value = payload[key];
      if (Array.isArray(value)) return { rows: value, shape: `wrapped:${key}` };
    }
    // One level of nesting, e.g. {data:{cameras:[...]}} — common enough to be worth probing, and
    // cheap. Deeper than that is guessing, and guessing is what the loud failure exists to prevent.
    for (const outer of ARRAY_KEYS) {
      const nested = payload[outer];
      if (!isRecord(nested)) continue;
      for (const inner of ARRAY_KEYS) {
        const value = nested[inner];
        if (Array.isArray(value)) return { rows: value, shape: `wrapped:${outer}.${inner}` };
      }
    }
  }

  throw new UnknownCatalogueShapeError(
    'catalogue payload contained no recognisable camera array. Probed: a bare JSON array, and ' +
      `these wrapper keys (one and two levels deep): ${ARRAY_KEYS.join(', ')}. ` +
      `Received: ${describe(payload)}. The raw payload has been persisted on the failed sync run.`,
    payload,
  );
}

/** A one-line description of what actually arrived, for the error message. Never the whole body. */
function describe(payload: unknown): string {
  if (Array.isArray(payload)) return `array of ${String(payload.length)}`;
  if (isRecord(payload)) {
    const keys = Object.keys(payload);
    const shown = keys.slice(0, 12).join(', ');
    return `object with keys [${shown}${keys.length > 12 ? ', …' : ''}]`;
  }
  return typeof payload;
}

function resolution(entry: Record<string, unknown>): string | undefined {
  const declared = pickString(entry, RESOLUTION_KEYS);
  if (declared !== undefined && /^\d{2,5}x\d{2,5}$/.test(declared)) return declared;

  const width = pickNumber(entry, WIDTH_KEYS);
  const height = pickNumber(entry, HEIGHT_KEYS);
  if (width !== undefined && height !== undefined) return `${String(width)}x${String(height)}`;
  return undefined;
}

function endpointsOf(entry: Record<string, unknown>): Record<string, string> {
  const endpoints: Record<string, string> = {};
  const hls = pickString(entry, HLS_KEYS);
  const rtsp = pickString(entry, RTSP_KEYS);
  // Only absolute URLs. A relative path is meaningless without knowing which base it hangs off,
  // and inventing one is exactly the hardcoded-pattern assumption the ticket forbids.
  if (hls !== undefined && /^https?:\/\//.test(hls)) endpoints['hls'] = hls;
  if (rtsp !== undefined && /^rtsps?:\/\//.test(rtsp)) endpoints['rtsp'] = rtsp;
  return endpoints;
}

/**
 * Parses a catalogue payload into entries.
 *
 * Throws `UnknownCatalogueShapeError` when no shape matches, or when a matched array yields **zero**
 * identifiable entries — an array of a hundred objects none of which has anything resembling an id
 * is a shape mismatch wearing an array's clothing, and reporting "0 cameras, all rejected" would
 * hide it behind a successful-looking run.
 */
export function parseCatalogue(payload: unknown): ParsedCatalogue {
  const { rows, shape } = locateArray(payload);

  const entries: CatalogueEntry[] = [];
  const rejections: ParsedCatalogue['rejections'] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const at = index + 1;

    // A list of bare id strings is a legitimate minimal catalogue.
    if (typeof row === 'string' && row.trim() !== '') {
      const id = row.trim();
      if (seen.has(id)) {
        rejections.push({
          row: at,
          externalId: id,
          errors: [{ field: 'id', message: 'duplicate id within the same payload' }],
        });
        return;
      }
      seen.add(id);
      entries.push({ externalId: id, name: id, endpoints: {} });
      return;
    }

    if (!isRecord(row)) {
      rejections.push({
        row: at,
        externalId: null,
        errors: [{ field: '(root)', message: `expected an object or a string, got ${typeof row}` }],
      });
      return;
    }

    const externalId = pickString(row, ID_KEYS);
    if (externalId === undefined) {
      rejections.push({
        row: at,
        externalId: null,
        errors: [
          {
            field: 'id',
            message: `no identifier found. Probed: ${ID_KEYS.join(', ')}. Entry has: ${Object.keys(row).join(', ') || '(no keys)'}`,
          },
        ],
      });
      return;
    }

    if (seen.has(externalId)) {
      rejections.push({
        row: at,
        externalId,
        errors: [{ field: 'id', message: 'duplicate id within the same payload' }],
      });
      return;
    }
    seen.add(externalId);

    const fps = pickNumber(row, FPS_KEYS);

    entries.push({
      externalId,
      // The sandbox always supplies a name; falling back to the id keeps a nameless catalogue
      // importable rather than rejecting a camera over a cosmetic field.
      name: pickString(row, NAME_KEYS) ?? externalId,
      ...optional('declaredCodec', pickString(row, CODEC_KEYS)),
      ...optional('declaredFps', fps !== undefined && fps > 0 ? fps : undefined),
      ...optional('declaredResolution', resolution(row)),
      ...optional('lat', inRange(pickNumber(row, LAT_KEYS), -90, 90)),
      ...optional('lon', inRange(pickNumber(row, LON_KEYS), -180, 180)),
      ...optional('address', pickString(row, ADDRESS_KEYS)),
      ...optional('district', pickString(row, DISTRICT_KEYS)),
      ...optional('vendor', pickString(row, VENDOR_KEYS)),
      endpoints: endpointsOf(row),
    });
  });

  if (entries.length === 0 && rows.length > 0) {
    throw new UnknownCatalogueShapeError(
      `catalogue payload matched shape '${shape}' with ${String(rows.length)} rows, but none ` +
        `carried a recognisable identifier. Probed: ${ID_KEYS.join(', ')}. ` +
        'The raw payload has been persisted on the failed sync run.',
      payload,
    );
  }

  return { entries, shape, rejections };
}

/**
 * `{key: value}` when the catalogue supplied it, `{}` when it did not.
 *
 * The distinction is load-bearing: an omitted key means "the catalogue said nothing", which the
 * sync job then knows never to write over a stored value. A `null` would mean "the catalogue says
 * this is empty" and would erase what a person entered.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}

function inRange(value: number | undefined, min: number, max: number): number | undefined {
  return value !== undefined && value >= min && value <= max ? value : undefined;
}
