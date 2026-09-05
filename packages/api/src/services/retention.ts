/**
 * The retention / evidence clock — the queries behind it (D3-05).
 *
 * The arithmetic lives in `@saakshi/shared`'s `retention.ts` so the API and the web app cannot
 * disagree about a countdown. This module is the part that needs a database: which cameras covered
 * a place at a time, what the estate's retention posture actually is, and the preservation-request
 * queue.
 *
 * ## Coverage is proximity, and says so
 *
 * "Which cameras covered this location" is answered with PostGIS `ST_DWithin` against
 * `cameras.location` — a camera within `radius_m` of the point. It is deliberately **not** a
 * view-frustum model. `camera_coverage` exists in the schema and holds a `viewshed` polygon, but
 * nothing populates it for this estate and inventing one would put a claim on screen that no
 * measurement supports. The response says which model produced it, in the payload, so a screenshot
 * carries the qualification rather than a slide having to.
 *
 * ## The estate this runs against
 *
 * All 30 cameras in the Gujarat sandbox catalogue have `location IS NULL` **and**
 * `retention_days IS NULL` — the upstream `GET /api/ingest` publishes a bare `[{id, name}]` array
 * (D1-04). So on the real estate this query returns zero covering cameras and thirty unassessable
 * ones, and every one of them is `unknown`.
 *
 * That is not a defect in this code. It is the ticket's thesis, measured: *nobody in Gujarat can
 * currently tell an investigating officer what footage still exists*, and the reason is that the
 * catalogue does not carry the two fields the question needs. Both counts are returned on every
 * response and rendered on screen, following D1-08's rule that the unassessable set is shown
 * explicitly rather than silently dropped.
 */
import { sql } from 'drizzle-orm';
import {
  DEFAULT_EXPIRING_SOON_HOURS,
  RETENTION_STATE_ORDER,
  type RetentionState,
  type RetentionStatus,
  describeRetention,
  expiryOf,
} from '@saakshi/shared';
import type { Db, DbLike } from '../db/client.js';
import type { Principal } from '../auth.js';
import { writeAudit } from './audit.js';

/** Ceiling on how many cameras one availability answer will describe. */
export const MAX_AVAILABILITY_CAMERAS = 500;

/** Ceiling on the radius. 20 km is a district-scale question; beyond that it is not a location. */
export const MAX_RADIUS_M = 20_000;

/** The audit-chain action a preservation request appends. Part of D3-04's vocabulary, extended. */
export const PRESERVATION_ACTION = 'evidence.preservation_request';
export const PRESERVATION_TARGET_TYPE = 'preservation_request';

/** What produced the covering set. Returned in the payload so the claim travels with the answer. */
export const COVERAGE_MODEL = 'proximity' as const;
export const COVERAGE_MODEL_NOTE =
  'A camera is reported as covering a location when its registered position is within the given ' +
  'radius. This is proximity, not a viewshed: SAAKSHI holds no field-of-view geometry for this ' +
  'estate, so a camera listed here may have been pointing away, and one just outside the radius ' +
  'may still have seen the incident. Widen the radius rather than trusting the boundary.';

export interface CameraRetention {
  cameraId: string;
  externalId: string;
  name: string;
  district: string | null;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  lat: number | null;
  lon: number | null;
  /** `false` when the camera has no registered position — 30 of 30 on the sandbox estate. */
  located: boolean;
  /** Metres from the queried point. `null` for an unplaced camera: not zero, not infinity. */
  distanceM: number | null;
  retention: RetentionStatus;
}

export interface AvailabilityResult {
  /** Echoed back so a screenshot of the answer carries the question. */
  query: {
    lat: number;
    lon: number;
    radiusM: number;
    at: string;
    expiringSoonHours: number;
  };
  coverageModel: typeof COVERAGE_MODEL;
  coverageModelNote: string;
  /** Cameras whose registered position falls within the radius, nearest first. */
  covering: CameraRetention[];
  /**
   * Cameras that cannot be assessed for coverage because the registry holds no position for them.
   * D1-08's "Not on the map · N" tray, in the API rather than only in the UI: an officer must be
   * told that thirty cameras could not be ruled in *or* out, not shown an empty list.
   */
  unassessable: CameraRetention[];
  counts: {
    covering: number;
    unassessable: number;
    /** Of the covering set, by retention state. The number the officer acts on. */
    byState: Record<RetentionState, number>;
    /** True when the covering set was cut at `MAX_AVAILABILITY_CAMERAS`. */
    truncated: boolean;
  };
}

interface CameraRow {
  /** `db.execute` requires an index signature on its row type. */
  [column: string]: unknown;
  camera_id: string;
  external_id: string;
  name: string;
  district: string | null;
  department_id: string | null;
  department_code: string | null;
  department_name: string | null;
  lat: string | null;
  lon: string | null;
  distance_m: string | null;
  retention_days: number | null;
}

function toCameraRetention(
  row: CameraRow,
  at: Date,
  now: Date,
  expiringSoonHours: number,
): CameraRetention {
  return {
    cameraId: row.camera_id,
    externalId: row.external_id,
    name: row.name,
    district: row.district,
    departmentId: row.department_id,
    departmentCode: row.department_code,
    departmentName: row.department_name,
    lat: row.lat === null ? null : Number(row.lat),
    lon: row.lon === null ? null : Number(row.lon),
    located: row.lat !== null && row.lon !== null,
    distanceM: row.distance_m === null ? null : Math.round(Number(row.distance_m)),
    retention: describeRetention({
      footageAt: at,
      retentionDays: row.retention_days,
      now,
      expiringSoonHours,
    }),
  };
}

const CAMERA_COLUMNS = sql`
  c.id::text                          as camera_id,
  c.external_id                       as external_id,
  c.name                              as name,
  c.district                          as district,
  c.department_id::text               as department_id,
  d.code                              as department_code,
  d.name                              as department_name,
  st_y(c.location::geometry)::text    as lat,
  st_x(c.location::geometry)::text    as lon,
  c.retention_days                    as retention_days`;

export interface AvailabilityQuery {
  lat: number;
  lon: number;
  radiusM: number;
  /** The instant the footage was recorded — the thing whose survival is in question. */
  at: Date;
  expiringSoonHours?: number;
  /** Injected in tests so a countdown can be asserted at a boundary. Defaults to now. */
  now?: Date;
  /** Restrict the unassessable tray to one department, when an officer knows the owner. */
  departmentId?: string | undefined;
}

/**
 * Which cameras covered a place at a time, and whether that footage still exists.
 *
 * Two queries rather than one union, because they answer different questions and the second one's
 * result must not be silently mixed into the first: a camera we cannot place is not a camera we
 * found. The unassessable tray is capped at the same ceiling and reported with its own count.
 */
export async function evidenceAvailability(
  db: DbLike,
  query: AvailabilityQuery,
): Promise<AvailabilityResult> {
  const now = query.now ?? new Date();
  const expiringSoonHours = query.expiringSoonHours ?? DEFAULT_EXPIRING_SOON_HOURS;
  const point = sql`st_setsrid(st_makepoint(${query.lon}, ${query.lat}), 4326)::geography`;

  const coveringRows = await db.execute<CameraRow>(sql`
    select ${CAMERA_COLUMNS},
           st_distance(c.location, ${point})::text as distance_m
      from cameras c
      left join departments d on d.id = c.department_id
     where c.deleted_at is null
       and c.location is not null
       and st_dwithin(c.location, ${point}, ${query.radiusM})
     order by st_distance(c.location, ${point}) asc
     limit ${MAX_AVAILABILITY_CAMERAS + 1}`);

  const departmentFilter =
    query.departmentId === undefined
      ? sql``
      : sql` and c.department_id = ${query.departmentId}::uuid`;

  const unassessableRows = await db.execute<CameraRow>(sql`
    select ${CAMERA_COLUMNS}, null::text as distance_m
      from cameras c
      left join departments d on d.id = c.department_id
     where c.deleted_at is null
       and c.location is null${departmentFilter}
     order by c.external_id asc
     limit ${MAX_AVAILABILITY_CAMERAS}`);

  const truncated = coveringRows.length > MAX_AVAILABILITY_CAMERAS;
  const covering = coveringRows
    .slice(0, MAX_AVAILABILITY_CAMERAS)
    .map((row) => toCameraRetention(row, query.at, now, expiringSoonHours));
  const unassessable = unassessableRows.map((row) =>
    toCameraRetention(row, query.at, now, expiringSoonHours),
  );

  const byState: Record<RetentionState, number> = {
    available: 0,
    expiring_soon: 0,
    expired: 0,
    unknown: 0,
  };
  for (const camera of covering) byState[camera.retention.state] += 1;

  return {
    query: {
      lat: query.lat,
      lon: query.lon,
      radiusM: query.radiusM,
      at: query.at.toISOString(),
      expiringSoonHours,
    },
    coverageModel: COVERAGE_MODEL,
    coverageModelNote: COVERAGE_MODEL_NOTE,
    covering,
    unassessable,
    counts: {
      covering: covering.length,
      unassessable: unassessable.length,
      byState,
      truncated,
    },
  };
}

// ── The estate-wide picture ─────────────────────────────────────────────────────────────────────

export interface RetentionBucket {
  /** The declared window in days. `null` is the "never declared" bucket, and it is a bucket. */
  retentionDays: number | null;
  cameras: number;
}

export interface DepartmentRetention {
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  cameras: number;
  declared: number;
  undeclared: number;
  /** `null` when the department declared nothing at all — never 0, which would read as "no retention". */
  minRetentionDays: number | null;
  maxRetentionDays: number | null;
}

export interface RetentionSummary {
  totalCameras: number;
  declared: number;
  undeclared: number;
  /** Days of the shortest declared window across the estate. The number that bounds an investigation. */
  shortestDeclaredDays: number | null;
  longestDeclaredDays: number | null;
  buckets: RetentionBucket[];
  byDepartment: DepartmentRetention[];
  /** How many cameras have coordinates at all — the other half of what an availability query needs. */
  located: number;
  unlocated: number;
}

/**
 * The estate's retention posture, by declared window and by owning department.
 *
 * Aggregated in SQL rather than by pulling rows and counting in TypeScript: the summary's whole
 * purpose is to be checkable against `select retention_days, count(*) from cameras group by 1`,
 * and a JavaScript reducer over a paged read could agree with the wrong thing.
 */
export async function retentionSummary(db: DbLike): Promise<RetentionSummary> {
  const buckets = await db.execute<{ retention_days: number | null; cameras: string }>(sql`
    select retention_days, count(*)::text as cameras
      from cameras
     where deleted_at is null
     group by retention_days
     order by retention_days asc nulls last`);

  const totals = await db.execute<{
    total: string;
    declared: string;
    located: string;
    shortest: number | null;
    longest: number | null;
  }>(sql`
    select count(*)::text                                          as total,
           count(retention_days)::text                             as declared,
           count(location)::text                                   as located,
           min(retention_days)                                     as shortest,
           max(retention_days)                                     as longest
      from cameras
     where deleted_at is null`);

  const byDepartment = await db.execute<{
    department_id: string | null;
    department_code: string | null;
    department_name: string | null;
    cameras: string;
    declared: string;
    min_days: number | null;
    max_days: number | null;
  }>(sql`
    select c.department_id::text as department_id,
           d.code                as department_code,
           d.name                as department_name,
           count(*)::text        as cameras,
           count(c.retention_days)::text as declared,
           min(c.retention_days) as min_days,
           max(c.retention_days) as max_days
      from cameras c
      left join departments d on d.id = c.department_id
     where c.deleted_at is null
     group by 1, 2, 3
     order by count(*) desc, d.code asc nulls last`);

  const row = totals[0];
  const total = Number(row?.total ?? '0');
  const declared = Number(row?.declared ?? '0');
  const located = Number(row?.located ?? '0');

  return {
    totalCameras: total,
    declared,
    undeclared: total - declared,
    shortestDeclaredDays: row?.shortest ?? null,
    longestDeclaredDays: row?.longest ?? null,
    buckets: buckets.map((b) => ({
      retentionDays: b.retention_days,
      cameras: Number(b.cameras),
    })),
    byDepartment: byDepartment.map((d) => {
      const cameras = Number(d.cameras);
      const departmentDeclared = Number(d.declared);
      return {
        departmentId: d.department_id,
        departmentCode: d.department_code,
        departmentName: d.department_name,
        cameras,
        declared: departmentDeclared,
        undeclared: cameras - departmentDeclared,
        minRetentionDays: d.min_days,
        maxRetentionDays: d.max_days,
      };
    }),
    located,
    unlocated: total - located,
  };
}

// ── Preservation requests ───────────────────────────────────────────────────────────────────────

export interface PreservationRequestInput {
  cameraId: string;
  windowStart: Date;
  windowEnd: Date;
  caseRef: string;
  purpose: string;
  notes?: string | null;
}

export interface PreservationRequestRecord {
  id: string;
  cameraId: string;
  cameraExternalId: string;
  cameraName: string;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  windowStart: string;
  windowEnd: string;
  caseRef: string;
  purpose: string;
  requestedBy: string | null;
  requestedByBadgeNo: string | null;
  requestedAt: string;
  status: 'open' | 'acknowledged' | 'preserved' | 'declined';
  /** What the registry declared when the request was made. `null` = it declared nothing. */
  retentionDaysAtRequest: number | null;
  expiresAtAtRequest: string | null;
  /** The `audit_log.hash` of the chain entry that authorised this. Verifiable at `/api/v1/audit`. */
  auditHash: string;
  notes: string | null;
  /** Recomputed on read against `now`, so a queue row's urgency is current rather than frozen. */
  retention: RetentionStatus;
}

interface PreservationRow {
  /** `db.execute` requires an index signature on its row type. */
  [column: string]: unknown;
  id: string;
  camera_id: string;
  camera_external_id: string;
  camera_name: string;
  department_id: string | null;
  department_code: string | null;
  department_name: string | null;
  window_start: string;
  window_end: string;
  case_ref: string;
  purpose: string;
  requested_by: string | null;
  requested_by_badge_no: string | null;
  requested_at: string;
  status: 'open' | 'acknowledged' | 'preserved' | 'declined';
  retention_days_at_request: number | null;
  expires_at_at_request: string | null;
  audit_hash: string;
  notes: string | null;
  /** The camera's retention as it stands NOW, for the live countdown. May differ from the snapshot. */
  retention_days_now: number | null;
}

const SELECT_PRESERVATION = sql`
  select p.id::text                 as id,
         p.camera_id::text          as camera_id,
         c.external_id              as camera_external_id,
         c.name                     as camera_name,
         c.department_id::text      as department_id,
         d.code                     as department_code,
         d.name                     as department_name,
         p.window_start             as window_start,
         p.window_end               as window_end,
         p.case_ref                 as case_ref,
         p.purpose                  as purpose,
         p.requested_by::text       as requested_by,
         u.badge_no                 as requested_by_badge_no,
         p.requested_at             as requested_at,
         p.status                   as status,
         p.retention_days_at_request as retention_days_at_request,
         p.expires_at_at_request    as expires_at_at_request,
         p.audit_hash               as audit_hash,
         p.notes                    as notes,
         c.retention_days           as retention_days_now
    from preservation_requests p
    join cameras c on c.id = p.camera_id
    left join departments d on d.id = c.department_id
    left join users u on u.id = p.requested_by`;

function toPreservationRecord(
  row: PreservationRow,
  now: Date,
  expiringSoonHours: number,
): PreservationRequestRecord {
  return {
    id: row.id,
    cameraId: row.camera_id,
    cameraExternalId: row.camera_external_id,
    cameraName: row.camera_name,
    departmentId: row.department_id,
    departmentCode: row.department_code,
    departmentName: row.department_name,
    windowStart: new Date(row.window_start).toISOString(),
    windowEnd: new Date(row.window_end).toISOString(),
    caseRef: row.case_ref,
    purpose: row.purpose,
    requestedBy: row.requested_by,
    requestedByBadgeNo: row.requested_by_badge_no,
    requestedAt: new Date(row.requested_at).toISOString(),
    status: row.status,
    retentionDaysAtRequest: row.retention_days_at_request,
    expiresAtAtRequest:
      row.expires_at_at_request === null
        ? null
        : new Date(row.expires_at_at_request).toISOString(),
    auditHash: row.audit_hash,
    notes: row.notes,
    // Against the window's START, which is the oldest footage in the request and therefore the
    // first part of it to be overwritten. Using the end would report the request as safe while its
    // opening minutes — usually the approach, usually the useful part — were already gone.
    retention: describeRetention({
      footageAt: new Date(row.window_start),
      retentionDays: row.retention_days_now,
      now,
      expiringSoonHours,
    }),
  };
}

/**
 * Record a preservation request and append the act to the audit chain, atomically.
 *
 * One transaction: `writeAudit` nests on a savepoint (D3-04), so either the request exists *and* the
 * chain records who asked for it, or neither happened. A request nobody can attribute is not a
 * request an evidence process can rely on, and a chain entry pointing at a row that was rolled back
 * is worse than no entry at all.
 */
export async function createPreservationRequest(
  db: Db,
  principal: Principal | undefined,
  input: PreservationRequestInput,
  options: { now?: Date; expiringSoonHours?: number } = {},
): Promise<PreservationRequestRecord> {
  const now = options.now ?? new Date();
  const expiringSoonHours = options.expiringSoonHours ?? DEFAULT_EXPIRING_SOON_HOURS;

  return db.transaction(async (tx) => {
    const cameraRows = await tx.execute<{ retention_days: number | null; external_id: string }>(sql`
      select retention_days, external_id from cameras
       where id = ${input.cameraId}::uuid and deleted_at is null`);
    const camera = cameraRows[0];
    if (camera === undefined) throw new PreservationCameraNotFound(input.cameraId);

    const retentionDays = camera.retention_days;
    const expiresAt = expiryOf(input.windowStart, retentionDays);

    const audit = await writeAudit(tx, principal, {
      action: PRESERVATION_ACTION,
      targetType: PRESERVATION_TARGET_TYPE,
      targetId: camera.external_id,
      purpose: input.purpose,
      caseRef: input.caseRef,
      params: {
        cameraId: input.cameraId,
        cameraExternalId: camera.external_id,
        windowStart: input.windowStart.toISOString(),
        windowEnd: input.windowEnd.toISOString(),
        // Recorded in the chain, not merely in the row: what the officer was told about this
        // footage's lifetime is part of why they acted, and the chain is where "why" lives.
        retentionDaysAtRequest: retentionDays,
        expiresAtAtRequest: expiresAt === null ? null : expiresAt.toISOString(),
      },
      resultCount: 1,
    });

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into preservation_requests (
        camera_id, window_start, window_end, case_ref, purpose, requested_by,
        retention_days_at_request, expires_at_at_request, audit_hash, notes
      ) values (
        ${input.cameraId}::uuid,
        ${input.windowStart.toISOString()}::timestamptz,
        ${input.windowEnd.toISOString()}::timestamptz,
        ${input.caseRef},
        ${input.purpose},
        ${principal?.sub ?? null}::uuid,
        ${retentionDays},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz,
        ${audit.hash},
        ${input.notes ?? null}
      ) returning id::text`);

    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('preservation request insert returned no id');

    const rows = await tx.execute<PreservationRow>(
      sql`${SELECT_PRESERVATION} where p.id = ${id}::uuid`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('preservation request vanished inside its own insert');
    return toPreservationRecord(row, now, expiringSoonHours);
  });
}

/** A request against a camera the registry does not hold. Distinguished so the route can 404. */
export class PreservationCameraNotFound extends Error {
  constructor(readonly cameraId: string) {
    super(`no such camera: ${cameraId}`);
    this.name = 'PreservationCameraNotFound';
  }
}

export interface PreservationQueueQuery {
  status?: 'open' | 'acknowledged' | 'preserved' | 'declined' | undefined;
  caseRef?: string | undefined;
  cameraId?: string | undefined;
  limit: number;
  now?: Date;
  expiringSoonHours?: number;
}

/**
 * The queue, most urgent first.
 *
 * Ordered in TypeScript on the *recomputed* state rather than in SQL on the snapshot, because
 * urgency is a function of `now` and the snapshot is a function of when the request was made. A
 * queue sorted on the frozen figure would put a request made last week above one made this morning
 * about footage expiring in an hour.
 */
export async function preservationQueue(
  db: DbLike,
  query: PreservationQueueQuery,
): Promise<PreservationRequestRecord[]> {
  const now = query.now ?? new Date();
  const expiringSoonHours = query.expiringSoonHours ?? DEFAULT_EXPIRING_SOON_HOURS;

  const filters = [];
  if (query.status !== undefined) filters.push(sql`p.status = ${query.status}`);
  if (query.caseRef !== undefined) filters.push(sql`p.case_ref = ${query.caseRef}`);
  if (query.cameraId !== undefined) filters.push(sql`p.camera_id = ${query.cameraId}::uuid`);
  const where = filters.length === 0 ? sql`` : sql` where ${sql.join(filters, sql` and `)}`;

  const rows = await db.execute<PreservationRow>(
    sql`${SELECT_PRESERVATION}${where} order by p.requested_at desc limit ${query.limit}`,
  );

  return rows
    .map((row) => toPreservationRecord(row, now, expiringSoonHours))
    .sort((a, b) => {
      const byState =
        RETENTION_STATE_ORDER[a.retention.state] - RETENTION_STATE_ORDER[b.retention.state];
      if (byState !== 0) return byState;
      const aLeft = a.retention.remainingMs;
      const bLeft = b.retention.remainingMs;
      if (aLeft !== null && bLeft !== null && aLeft !== bLeft) return aLeft - bLeft;
      return b.requestedAt.localeCompare(a.requestedAt);
    });
}
