import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * The enum contract. These values mirror `db/migrations/0002_enums.up.sql` exactly and are the
 * authoritative list for the API and the Python workers — nothing downstream may invent a variant,
 * because Postgres will reject it at insert time.
 *
 * The drift test in `schema-drift.test.ts` asserts every one of these against `pg_enum`, so an edit
 * here that is not also a migration fails the suite rather than production.
 */

export const cameraTypeEnum = pgEnum('camera_type', ['analog', 'ip']);
export const cameraMountEnum = pgEnum('camera_mount', ['static', 'mobile']);
export const storageTypeEnum = pgEnum('storage_type', ['cloud', 'local']);

export const adapterKindEnum = pgEnum('adapter_kind', [
  'hls',
  'rtsp',
  'onvif',
  'whep',
  'nvr',
  'file',
]);

export const cameraStatusEnum = pgEnum('camera_status', [
  'unknown',
  'online',
  'degraded',
  'offline',
]);

/**
 * Presence in the upstream catalogue — deliberately **not** `camera_status`.
 *
 * `camera_status` is measured health, owned by the prober (D1-05). Presence is a different fact
 * about a different subject: a camera can be listed and dead, or delisted and still serving. See
 * migration 0012 for the full reasoning.
 */
export const catalogueStatusEnum = pgEnum('catalogue_status', ['active', 'absent']);

export const cameraGeometryEnum = pgEnum('camera_geometry', [
  'anpr_viable',
  'detection_only',
  'unclassified',
]);

export const userRoleEnum = pgEnum('user_role', ['admin', 'supervisor', 'operator', 'auditor']);

export const watchlistCategoryEnum = pgEnum('watchlist_category', [
  'stolen_vehicle',
  'wanted_person',
  'missing_person',
  'blacklisted_vehicle',
  'suspect',
]);

export const watchlistEntityTypeEnum = pgEnum('watchlist_entity_type', ['vehicle', 'person']);

export const sourceSystemEnum = pgEnum('source_system', [
  'VAHAN',
  'SARTHI',
  'eGujCop',
  'AFIS',
  'NAFIS',
  'manual',
]);

export const alertSeverityEnum = pgEnum('alert_severity', ['low', 'medium', 'high', 'critical']);
export const alertStatusEnum = pgEnum('alert_status', ['new', 'ack', 'dismissed', 'escalated']);
export const matchTypeEnum = pgEnum('match_type', ['exact', 'fuzzy']);

export const linkMethodEnum = pgEnum('link_method', ['plate_exact', 'plate_fuzzy', 'reid_bridge']);

export const routeAnomalyEnum = pgEnum('route_anomaly', ['none', 'impossible_transition']);

export const vehicleClassEnum = pgEnum('vehicle_class', [
  'car',
  'motorcycle',
  'bus',
  'truck',
  'auto_rickshaw',
  'bicycle',
  'person',
  'unknown',
]);
