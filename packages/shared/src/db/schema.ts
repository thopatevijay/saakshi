/**
 * Drizzle schema — the typed mirror of `db/migrations/`.
 *
 * The SQL is the source of truth: it can express `create_hypertable`, GIN trigram opclasses, the
 * audit-log trigger and partial indexes, none of which drizzle can. This file exists so the API
 * gets row types and a query builder over that schema, and `schema-drift.test.ts` asserts the two
 * against `information_schema` and `pg_enum` so they cannot drift apart silently.
 */
import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  geographyLineString,
  geographyPoint,
  geographyPolygon,
  numericAsNumber,
} from './columns.js';
import {
  adapterKindEnum,
  alertSeverityEnum,
  alertStatusEnum,
  cameraGeometryEnum,
  cameraMountEnum,
  cameraStatusEnum,
  cameraTypeEnum,
  linkMethodEnum,
  matchTypeEnum,
  routeAnomalyEnum,
  sourceSystemEnum,
  storageTypeEnum,
  userRoleEnum,
  vehicleClassEnum,
  watchlistCategoryEnum,
  watchlistEntityTypeEnum,
} from './enums.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

// ── Registry ────────────────────────────────────────────────────────────────────────────────────

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  contactJson: jsonb('contact_json').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    badgeNo: text('badge_no').notNull().unique(),
    role: userRoleEnum('role').notNull(),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('users_department_idx').on(t.departmentId)],
);

export const cameras = pgTable(
  'cameras',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id').notNull().unique(),
    name: text('name').notNull(),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),

    location: geographyPoint('location'),
    address: text('address'),
    district: text('district'),

    cameraType: cameraTypeEnum('camera_type').notNull().default('ip'),
    mount: cameraMountEnum('mount').notNull().default('static'),
    geometryClass: cameraGeometryEnum('geometry_class').notNull().default('unclassified'),

    // Declared by the owning department. Never trusted — compare against camera_health_checks.
    declaredCodec: text('declared_codec'),
    declaredFps: numericAsNumber('declared_fps'),
    declaredResolution: text('declared_resolution'),

    vendor: text('vendor'),
    vmsPlatform: text('vms_platform'),
    retentionDays: integer('retention_days'),
    storageType: storageTypeEnum('storage_type'),

    adapterKind: adapterKindEnum('adapter_kind').notNull(),
    endpoints: jsonb('endpoints').notNull().default({}),

    status: cameraStatusEnum('status').notNull().default('unknown'),
    // NULL means never probed, which is not the same as scored zero.
    trustScore: numericAsNumber('trust_score'),

    onboardedAt: ts('onboarded_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('cameras_department_idx').on(t.departmentId),
    index('cameras_district_idx').on(t.district),
    index('cameras_status_idx').on(t.status),
    index('cameras_geometry_class_idx').on(t.geometryClass),
  ],
);

export const cameraCoverage = pgTable('camera_coverage', {
  cameraId: uuid('camera_id')
    .primaryKey()
    .references(() => cameras.id, { onDelete: 'cascade' }),
  fovPolygon: geographyPolygon('fov_polygon'),
  coveredRoadIds: bigint('covered_road_ids', { mode: 'number' }).array().notNull().default([]),
  computedAt: ts('computed_at').notNull().defaultNow(),
});

export const roadNetwork = pgTable(
  'road_network',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    geom: geographyLineString('geom').notNull(),
    name: text('name'),
    highwayClass: text('highway_class'),
  },
  (t) => [index('road_network_highway_class_idx').on(t.highwayClass)],
);

// ── Hypertables ─────────────────────────────────────────────────────────────────────────────────

/** Timescale hypertable, partitioned on `checked_at`, 7-day chunks. */
export const cameraHealthChecks = pgTable(
  'camera_health_checks',
  {
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    checkedAt: ts('checked_at').notNull().defaultNow(),

    connectable: boolean('connectable').notNull(),
    decodable: boolean('decodable').notNull(),

    measuredFps: numericAsNumber('measured_fps'),
    actualResolution: text('actual_resolution'),
    actualCodec: text('actual_codec'),

    blurScore: numericAsNumber('blur_score'),
    lumaMean: numericAsNumber('luma_mean'),
    nightUsable: boolean('night_usable'),
    tamperScore: numericAsNumber('tamper_score'),
    ptsDriftMs: integer('pts_drift_ms'),

    trustScore: numericAsNumber('trust_score'),
    breakdown: jsonb('breakdown').notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.cameraId, t.checkedAt] }),
    // `camera_health_checks_checked_at_idx` is created by create_hypertable, not by us.
    index('camera_health_checks_camera_checked_at_idx').on(t.cameraId, t.checkedAt.desc()),
  ],
);

/** Timescale hypertable, partitioned on `ts`, 1-day chunks. */
export const sightings = pgTable(
  'sightings',
  {
    id: uuid('id').notNull().defaultRandom(),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    ts: ts('ts').notNull(),

    // Presentation timestamp, never arrival time.
    framePtsMs: bigint('frame_pts_ms', { mode: 'number' }).notNull(),
    trackId: integer('track_id').notNull(),

    class: vehicleClassEnum('class').notNull(),
    bbox: jsonb('bbox').notNull(),
    detConfidence: numericAsNumber('det_confidence').notNull(),

    vehicleColor: text('vehicle_color'),
    vehicleType: text('vehicle_type'),
    cropUri: text('crop_uri'),

    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.ts] }),
    index('sightings_camera_ts_idx').on(t.cameraId, t.ts.desc()),
    index('sightings_track_id_idx').on(t.trackId),
    index('sightings_class_idx').on(t.class),
  ],
);

// ── ANPR and identity ───────────────────────────────────────────────────────────────────────────

// `sightingId` + `sightingTs` with no foreign key: `sightings` is a hypertable and cannot be the
// target of a REFERENCES clause. The ts is what lets the planner exclude chunks.
export const plateReads = pgTable(
  'plate_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sightingId: uuid('sighting_id').notNull(),
    sightingTs: ts('sighting_ts').notNull(),

    rawText: text('raw_text').notNull(),
    // NULL when the Indian-plate grammar rejected the read. Kept: the rejection rate is a signal.
    normalizedText: text('normalized_text'),
    confidence: numericAsNumber('confidence').notNull(),

    isBestShot: boolean('is_best_shot').notNull().default(false),
    voteCount: integer('vote_count').notNull().default(1),

    cropUri: text('crop_uri'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('plate_reads_sighting_idx').on(t.sightingId, t.sightingTs),
    index('plate_reads_normalized_exact_idx').on(t.normalizedText),
  ],
);

export const vehicleIdentities = pgTable(
  'vehicle_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalPlate: text('canonical_plate').notNull().unique(),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    sightingCount: integer('sighting_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('vehicle_identities_last_seen_idx').on(t.lastSeen.desc())],
);

export const identitySightings = pgTable(
  'identity_sightings',
  {
    identityId: uuid('identity_id')
      .notNull()
      .references(() => vehicleIdentities.id, { onDelete: 'cascade' }),
    sightingId: uuid('sighting_id').notNull(),
    sightingTs: ts('sighting_ts').notNull(),

    linkMethod: linkMethodEnum('link_method').notNull(),
    linkConfidence: numericAsNumber('link_confidence').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.identityId, t.sightingId] }),
    index('identity_sightings_sighting_idx').on(t.sightingId, t.sightingTs),
    index('identity_sightings_method_idx').on(t.linkMethod),
  ],
);

// ── Watchlist and alerts ────────────────────────────────────────────────────────────────────────

export const watchlistEntries = pgTable(
  'watchlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: watchlistCategoryEnum('category').notNull(),
    entityType: watchlistEntityTypeEnum('entity_type').notNull(),

    plateNormalized: text('plate_normalized'),
    // Opaque case reference. Never biometric data — no face recognition anywhere in SAAKSHI.
    personRef: text('person_ref'),

    // The connector this entry is modelled on. No live connectivity to any of them.
    sourceSystem: sourceSystemEnum('source_system').notNull().default('manual'),
    sourceRef: text('source_ref'),

    severity: alertSeverityEnum('severity').notNull().default('medium'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    active: boolean('active').notNull().default(true),
    meta: jsonb('meta').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('watchlist_entries_category_idx').on(t.category),
    index('watchlist_entries_source_idx').on(t.sourceSystem),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    watchlistEntryId: uuid('watchlist_entry_id')
      .notNull()
      .references(() => watchlistEntries.id, { onDelete: 'cascade' }),
    sightingId: uuid('sighting_id').notNull(),
    sightingTs: ts('sighting_ts').notNull(),
    cameraId: uuid('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    ts: ts('ts').notNull(),

    matchType: matchTypeEnum('match_type').notNull(),
    matchDistance: integer('match_distance').notNull().default(0),
    confidence: numericAsNumber('confidence').notNull(),
    severity: alertSeverityEnum('severity').notNull(),

    // The why-payload. Verifiable in three seconds, never a bare score.
    reason: jsonb('reason').notNull().default({}),

    dedupeKey: text('dedupe_key').notNull(),
    dedupeWindowStart: ts('dedupe_window_start').notNull(),

    status: alertStatusEnum('status').notNull().default('new'),
    ackedBy: uuid('acked_by').references(() => users.id, { onDelete: 'set null' }),
    ackedAt: ts('acked_at'),

    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alerts_dedupe_uidx').on(t.dedupeKey, t.dedupeWindowStart),
    index('alerts_status_ts_idx').on(t.status, t.ts.desc()),
    index('alerts_camera_ts_idx').on(t.cameraId, t.ts.desc()),
    index('alerts_watchlist_entry_idx').on(t.watchlistEntryId),
  ],
);

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => vehicleIdentities.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    params: jsonb('params').notNull().default({}),
  },
  (t) => [
    index('routes_identity_idx').on(t.identityId),
    index('routes_requested_at_idx').on(t.requestedAt.desc()),
  ],
);

export const routeSegments = pgTable(
  'route_segments',
  {
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),

    fromSightingId: uuid('from_sighting_id').notNull(),
    fromSightingTs: ts('from_sighting_ts').notNull(),
    toSightingId: uuid('to_sighting_id').notNull(),
    toSightingTs: ts('to_sighting_ts').notNull(),

    // true = both endpoints were seen on camera. false = the path between them is OSRM's
    // inference. The UI must never render evidence and inference identically.
    observed: boolean('observed').notNull(),

    path: geographyLineString('path'),
    travelTimeS: integer('travel_time_s'),
    inferredConfidence: numericAsNumber('inferred_confidence'),

    anomaly: routeAnomalyEnum('anomaly').notNull().default('none'),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.seq] })],
);

// ── Audit and export ────────────────────────────────────────────────────────────────────────────

/**
 * Append-only, enforced twice in the database: `saakshi_app` holds only SELECT+INSERT, and
 * BEFORE UPDATE/DELETE triggers raise `restrict_violation`. Do not add an update path here.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: ts('ts').notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),

    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),

    // Not optional: a search of a citizen's movements without a stated purpose is what this table
    // exists to make impossible.
    purpose: text('purpose').notNull(),
    caseRef: text('case_ref'),

    params: jsonb('params').notNull().default({}),
    resultCount: integer('result_count'),

    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull().unique(),
  },
  (t) => [
    index('audit_log_ts_idx').on(t.ts.desc()),
    index('audit_log_actor_idx').on(t.actorId),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);

export const exportBundles = pgTable(
  'export_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),

    items: jsonb('items').notNull().default([]),
    manifest: jsonb('manifest').notNull().default({}),
    manifestHash: text('manifest_hash').notNull(),
  },
  (t) => [
    index('export_bundles_created_at_idx').on(t.createdAt.desc()),
    index('export_bundles_created_by_idx').on(t.createdBy),
  ],
);

export const onboardingResponses = pgTable(
  'onboarding_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    questionnaire: jsonb('questionnaire').notNull().default({}),
    submittedAt: ts('submitted_at').notNull().defaultNow(),
  },
  (t) => [index('onboarding_responses_department_idx').on(t.departmentId)],
);

// ── Relations ───────────────────────────────────────────────────────────────────────────────────

export const departmentsRelations = relations(departments, ({ many }) => ({
  users: many(users),
  cameras: many(cameras),
  onboardingResponses: many(onboardingResponses),
}));

export const usersRelations = relations(users, ({ one }) => ({
  department: one(departments, { fields: [users.departmentId], references: [departments.id] }),
}));

export const camerasRelations = relations(cameras, ({ one, many }) => ({
  department: one(departments, { fields: [cameras.departmentId], references: [departments.id] }),
  coverage: one(cameraCoverage),
  healthChecks: many(cameraHealthChecks),
  sightings: many(sightings),
  alerts: many(alerts),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  watchlistEntry: one(watchlistEntries, {
    fields: [alerts.watchlistEntryId],
    references: [watchlistEntries.id],
  }),
  camera: one(cameras, { fields: [alerts.cameraId], references: [cameras.id] }),
  ackedByUser: one(users, { fields: [alerts.ackedBy], references: [users.id] }),
}));

export const routesRelations = relations(routes, ({ one, many }) => ({
  identity: one(vehicleIdentities, {
    fields: [routes.identityId],
    references: [vehicleIdentities.id],
  }),
  segments: many(routeSegments),
}));

export const routeSegmentsRelations = relations(routeSegments, ({ one }) => ({
  route: one(routes, { fields: [routeSegments.routeId], references: [routes.id] }),
}));
