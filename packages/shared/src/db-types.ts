/**
 * Row types, inferred by drizzle from the schema in `./db/schema.ts`.
 *
 * `<Table>Row` is what a SELECT returns; `New<Table>` is what an INSERT accepts (defaults and
 * generated columns optional). Import these rather than hand-writing shapes — the drift test keeps
 * them honest against the real database, so a hand-written interface is a shape nothing verifies.
 */
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type {
  alertDigests,
  alerts,
  auditLog,
  cameraCoverage,
  cameraHealthChecks,
  cameras,
  catalogueSyncRuns,
  departments,
  exportBundles,
  identitySightings,
  onboardingResponses,
  plateReads,
  roadNetwork,
  routeSegments,
  routes,
  sightings,
  users,
  vehicleIdentities,
  watchlistEntries,
} from './db/schema.js';

export type DepartmentRow = InferSelectModel<typeof departments>;
export type NewDepartment = InferInsertModel<typeof departments>;

export type UserRow = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type CameraRow = InferSelectModel<typeof cameras>;
export type NewCamera = InferInsertModel<typeof cameras>;

export type CatalogueSyncRunRow = InferSelectModel<typeof catalogueSyncRuns>;
export type NewCatalogueSyncRun = InferInsertModel<typeof catalogueSyncRuns>;

export type CameraCoverageRow = InferSelectModel<typeof cameraCoverage>;
export type NewCameraCoverage = InferInsertModel<typeof cameraCoverage>;

export type RoadNetworkRow = InferSelectModel<typeof roadNetwork>;
export type NewRoadNetwork = InferInsertModel<typeof roadNetwork>;

export type CameraHealthCheckRow = InferSelectModel<typeof cameraHealthChecks>;
export type NewCameraHealthCheck = InferInsertModel<typeof cameraHealthChecks>;

export type SightingRow = InferSelectModel<typeof sightings>;
export type NewSighting = InferInsertModel<typeof sightings>;

export type PlateReadRow = InferSelectModel<typeof plateReads>;
export type NewPlateRead = InferInsertModel<typeof plateReads>;

export type VehicleIdentityRow = InferSelectModel<typeof vehicleIdentities>;
export type NewVehicleIdentity = InferInsertModel<typeof vehicleIdentities>;

export type IdentitySightingRow = InferSelectModel<typeof identitySightings>;
export type NewIdentitySighting = InferInsertModel<typeof identitySightings>;

export type WatchlistEntryRow = InferSelectModel<typeof watchlistEntries>;
export type NewWatchlistEntry = InferInsertModel<typeof watchlistEntries>;

export type AlertRow = InferSelectModel<typeof alerts>;
export type NewAlert = InferInsertModel<typeof alerts>;

export type AlertDigestRow = InferSelectModel<typeof alertDigests>;
export type NewAlertDigest = InferInsertModel<typeof alertDigests>;

export type RouteRow = InferSelectModel<typeof routes>;
export type NewRoute = InferInsertModel<typeof routes>;

export type RouteSegmentRow = InferSelectModel<typeof routeSegments>;
export type NewRouteSegment = InferInsertModel<typeof routeSegments>;

export type AuditLogRow = InferSelectModel<typeof auditLog>;
export type NewAuditLog = InferInsertModel<typeof auditLog>;

export type ExportBundleRow = InferSelectModel<typeof exportBundles>;
export type NewExportBundle = InferInsertModel<typeof exportBundles>;

export type OnboardingResponseRow = InferSelectModel<typeof onboardingResponses>;
export type NewOnboardingResponse = InferInsertModel<typeof onboardingResponses>;
