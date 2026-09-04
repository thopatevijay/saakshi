import { z } from 'zod';

/**
 * How a camera is reached. The registry is adapter-agnostic by design: the sandbox turned out to
 * be HLS-only, but a real estate mixes ONVIF/RTSP IP cameras, NVR exports and WHEP gateways.
 * See PROJECT.md §4.
 */
export const AdapterKind = z.enum(['hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file']);
export type AdapterKind = z.infer<typeof AdapterKind>;

export const CameraType = z.enum(['analog', 'ip']);
export type CameraType = z.infer<typeof CameraType>;

export const CameraMount = z.enum(['static', 'mobile']);
export type CameraMount = z.infer<typeof CameraMount>;

export const StorageType = z.enum(['cloud', 'local']);
export type StorageType = z.infer<typeof StorageType>;

export const CameraStatus = z.enum(['unknown', 'online', 'degraded', 'offline']);
export type CameraStatus = z.infer<typeof CameraStatus>;

/**
 * Geometry classification, set by human review during recon (D0-01). It drives which analytics a
 * camera is eligible for: plates are a few pixels wide on a wide bridge overview.
 */
export const CameraGeometry = z.enum(['anpr_viable', 'detection_only', 'unclassified']);
export type CameraGeometry = z.infer<typeof CameraGeometry>;

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * What a department *declares* about a camera at onboarding. Deliberately separate from what we
 * measure — the declared-vs-measured delta is Pillar 1's whole point (PROJECT.md §3), so declared
 * fields are optional and never trusted.
 */
export const CameraConfig = z.object({
  id: z.uuid().optional(),
  externalId: z.string().min(1),
  name: z.string().min(1),
  departmentId: z.uuid().optional(),

  location: GeoPoint.optional(),
  address: z.string().optional(),
  district: z.string().optional(),

  cameraType: CameraType.default('ip'),
  mount: CameraMount.default('static'),
  geometry: CameraGeometry.default('unclassified'),

  // Declared, never trusted. `CAP_PROP_FPS` lies; we measure instead (CLAUDE.md domain rules).
  declaredCodec: z.string().optional(),
  declaredFps: z.number().positive().optional(),
  declaredResolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'expected WIDTHxHEIGHT')
    .optional(),

  vendor: z.string().optional(),
  vmsPlatform: z.string().optional(),
  retentionDays: z.number().int().nonnegative().optional(),
  storageType: StorageType.optional(),

  adapterKind: AdapterKind,
  /** Adapter-specific endpoints, e.g. `{ hls: "https://host/cam01/index.m3u8" }`. */
  endpoints: z.record(z.string(), z.string()),

  status: CameraStatus.default('unknown'),
  /** 0-100, computed by D1-06. Null until the prober has run at least once. */
  trustScore: z.number().min(0).max(100).nullable().default(null),
  onboardedAt: z.iso.datetime().optional(),
});
export type CameraConfig = z.infer<typeof CameraConfig>;
