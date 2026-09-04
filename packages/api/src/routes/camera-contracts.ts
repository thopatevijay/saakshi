import { z } from 'zod';

/**
 * The wire contract for the registry API. Every route validates against these on input **and**
 * output, and the OpenAPI document at `/api/v1/docs` is generated from exactly these objects — so
 * the spec cannot describe something the server does not do.
 *
 * Enum values mirror `db/migrations/0002_enums.up.sql`. They are the contract published on issue #5;
 * nothing here may invent a variant.
 */

export const AdapterKind = z.enum(['hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file']);
export const CameraType = z.enum(['analog', 'ip']);
export const CameraMount = z.enum(['static', 'mobile']);
export const StorageType = z.enum(['cloud', 'local']);
export const CameraStatus = z.enum(['unknown', 'online', 'degraded', 'offline']);
export const CameraGeometry = z.enum(['anpr_viable', 'detection_only', 'unclassified']);

const lat = z.coerce.number().min(-90).max(90);
const lon = z.coerce.number().min(-180).max(180);

export const CameraCreate = z.object({
  externalId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  departmentId: z.uuid().nullish(),

  lat: lat.nullish(),
  lon: lon.nullish(),
  address: z.string().max(512).nullish(),
  district: z.string().max(128).nullish(),

  cameraType: CameraType.default('ip'),
  mount: CameraMount.default('static'),
  geometryClass: CameraGeometry.default('unclassified'),

  // Declared by the department. Accepted as given and never trusted: the declared-vs-measured
  // delta is Pillar 1's whole argument, so a wrong declaration is data, not an error.
  declaredCodec: z.string().max(32).nullish(),
  declaredFps: z.coerce.number().positive().max(240).nullish(),
  declaredResolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'expected WIDTHxHEIGHT, e.g. 1920x1080')
    .nullish(),

  vendor: z.string().max(128).nullish(),
  vmsPlatform: z.string().max(128).nullish(),
  retentionDays: z.coerce.number().int().min(0).max(3650).nullish(),
  storageType: StorageType.nullish(),

  adapterKind: AdapterKind,
  endpoints: z.record(z.string(), z.string()).default({}),
});
export type CameraCreate = z.infer<typeof CameraCreate>;

/** PATCH is the same shape with everything optional, minus the upsert key. */
export const CameraPatch = CameraCreate.partial().omit({ externalId: true });
export type CameraPatch = z.infer<typeof CameraPatch>;

export const CameraResponse = z.object({
  id: z.uuid(),
  externalId: z.string(),
  name: z.string(),
  departmentId: z.uuid().nullable(),
  departmentCode: z.string().nullable(),

  lat: z.number().nullable(),
  lon: z.number().nullable(),
  address: z.string().nullable(),
  district: z.string().nullable(),

  cameraType: CameraType,
  mount: CameraMount,
  geometryClass: CameraGeometry,

  declaredCodec: z.string().nullable(),
  declaredFps: z.number().nullable(),
  declaredResolution: z.string().nullable(),

  vendor: z.string().nullable(),
  vmsPlatform: z.string().nullable(),
  retentionDays: z.number().nullable(),
  storageType: StorageType.nullable(),

  adapterKind: AdapterKind,
  endpoints: z.record(z.string(), z.string()),

  status: CameraStatus,
  /** null means never probed, which is not the same as scored zero. */
  trustScore: z.number().nullable(),
  onboardedAt: z.string(),
  updatedAt: z.string(),
});
export type CameraResponse = z.infer<typeof CameraResponse>;

/** Latest measured health, attached to the detail view alongside the trust breakdown. */
export const CameraHealthSummary = z.object({
  checkedAt: z.string(),
  connectable: z.boolean(),
  decodable: z.boolean(),
  measuredFps: z.number().nullable(),
  actualResolution: z.string().nullable(),
  actualCodec: z.string().nullable(),
  nightUsable: z.boolean().nullable(),
  ptsDriftMs: z.number().nullable(),
  trustScore: z.number().nullable(),
  breakdown: z.record(z.string(), z.unknown()),
});

export const CameraDetailResponse = CameraResponse.extend({
  latestHealth: CameraHealthSummary.nullable(),
  /**
   * Declared vs measured, computed rather than stored. This field is the product: a department that
   * declared 25 fps on a camera measuring 10 is the gap the registry exists to surface.
   */
  declaredVsMeasured: z
    .object({
      fpsDeclared: z.number().nullable(),
      fpsMeasured: z.number().nullable(),
      fpsDelta: z.number().nullable(),
      resolutionDeclared: z.string().nullable(),
      resolutionMeasured: z.string().nullable(),
      resolutionMatches: z.boolean().nullable(),
      codecDeclared: z.string().nullable(),
      codecMeasured: z.string().nullable(),
      codecMatches: z.boolean().nullable(),
    })
    .nullable(),
});

/**
 * List query. `bbox` is `minLon,minLat,maxLon,maxLat` — the GeoJSON / Leaflet / MapLibre ordering
 * (longitude first), so D1-08 can pass a map viewport straight through without transposing it.
 */
export const CameraListQuery = z.object({
  departmentId: z.uuid().optional(),
  district: z.string().max(128).optional(),
  cameraType: CameraType.optional(),
  mount: CameraMount.optional(),
  adapterKind: AdapterKind.optional(),
  status: CameraStatus.optional(),
  geometryClass: CameraGeometry.optional(),

  trustMin: z.coerce.number().min(0).max(100).optional(),
  trustMax: z.coerce.number().min(0).max(100).optional(),

  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'expected minLon,minLat,maxLon,maxLat')
    .optional(),

  q: z.string().max(128).optional(),

  /** Opaque. Clients must round-trip it, never construct it. */
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type CameraListQuery = z.infer<typeof CameraListQuery>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    /** null when this is the last page. */
    nextCursor: z.string().nullable(),
    limit: z.number(),
  });

export const DepartmentResponse = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  contactJson: z.record(z.string(), z.unknown()),
  cameraCount: z.number(),
  createdAt: z.string(),
});

/** Per-row failure from a bulk import. `row` is 1-based over data rows, matching a spreadsheet. */
export const BulkRowError = z.object({
  row: z.number().int().positive(),
  externalId: z.string().nullable(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })),
});

/**
 * Bulk import report.
 *
 * `imported` counts rows actually committed. When `rejected` is non-empty the valid rows still
 * commit as one transaction and the bad rows are reported — what never happens is a *partial*
 * commit of a single batch: it is one transaction, so it either lands whole or not at all.
 */
export const BulkImportReport = z.object({
  received: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  rejected: z.array(BulkRowError),
  format: z.enum(['csv', 'json']),
  committed: z.boolean(),
});
export type BulkImportReport = z.infer<typeof BulkImportReport>;

/**
 * The report an on-demand catalogue sync returns. It is D1-04's `SyncReport` in wire form, and the
 * identical row is persisted and readable at `GET /api/v1/sync/reports`.
 *
 * `created` is D1-02's original field name, kept as an alias of `added` so an existing client does
 * not break; `added` is the name the persisted report and every downstream consumer use.
 */
export const CatalogueOnboardReport = z.object({
  runId: z.uuid(),
  source: z.string(),
  /** Which tolerant-parse strategy matched — 'array', 'wrapped:cameras', … */
  shape: z.string().nullable(),
  fetched: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  wentAbsent: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  rejected: z.array(BulkRowError),
});

export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
  allowed: z.array(z.string()).optional(),
  details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
});
