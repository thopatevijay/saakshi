/**
 * The retention / evidence clock — HTTP surface (D3-05).
 *
 * Three questions, three routes:
 *
 * - `GET  /api/v1/evidence/availability`      what covered this place at this time, and does it still exist
 * - `GET  /api/v1/evidence/retention/summary` the estate's retention posture, by window and by department
 * - `POST /api/v1/evidence/preservation`      ask the owning department to hold footage, on the record
 * - `GET  /api/v1/evidence/preservation`      the queue
 *
 * Every response that mentions retention carries `RETENTION_DISCLAIMER`, and every response that
 * mentions preservation carries `PRESERVATION_DISCLAIMER` — imported from `@saakshi/shared`, never
 * restated. D3-04 established the pattern for a reason: a paraphrase drifts, and the paraphrase
 * that drifts is always the one that starts implying more than the system does.
 */
import { z } from 'zod';
import {
  PRESERVATION_DISCLAIMER,
  RETENTION_DISCLAIMER,
  RETENTION_STATE_MEANING,
  RetentionState,
  RetentionStatus,
} from '@saakshi/shared';
import type { App } from '../server.js';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { READ_ROLES, WRITE_ROLES, authenticate, requireRole } from '../auth.js';
import { ErrorResponse } from './camera-contracts.js';
import {
  COVERAGE_MODEL_NOTE,
  MAX_RADIUS_M,
  PreservationCameraNotFound,
  createPreservationRequest,
  evidenceAvailability,
  preservationQueue,
  retentionSummary,
} from '../services/retention.js';

const CameraRetentionSchema = z.object({
  cameraId: z.uuid(),
  externalId: z.string(),
  name: z.string(),
  district: z.string().nullable(),
  departmentId: z.uuid().nullable(),
  departmentCode: z.string().nullable(),
  departmentName: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  located: z.boolean(),
  distanceM: z.number().nullable(),
  retention: RetentionStatus,
});

export const AvailabilityQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** Metres. Capped: beyond 20 km this stops being a location and becomes a district. */
  radius_m: z.coerce.number().int().min(1).max(MAX_RADIUS_M).default(500),
  /** The instant the footage was recorded. Defaults to now, which asks "what is live right now". */
  at: z.iso.datetime().optional(),
  /**
   * Per-query override of the warning threshold (AC 4). The deployment default comes from
   * `RETENTION_EXPIRING_SOON_HOURS`; this lets an officer widen the fuse for a slow evidence desk
   * without a redeploy.
   */
  expiring_soon_hours: z.coerce.number().min(1).max(8760).optional(),
  department_id: z.uuid().optional(),
});

export const AvailabilityResponse = z.object({
  query: z.object({
    lat: z.number(),
    lon: z.number(),
    radiusM: z.number().int(),
    at: z.string(),
    expiringSoonHours: z.number(),
  }),
  coverageModel: z.literal('proximity'),
  coverageModelNote: z.string(),
  covering: z.array(CameraRetentionSchema),
  unassessable: z.array(CameraRetentionSchema),
  counts: z.object({
    covering: z.number().int(),
    unassessable: z.number().int(),
    byState: z.record(RetentionState, z.number().int()),
    truncated: z.boolean(),
  }),
  /** One sentence per state, so a screenshot of the answer explains its own vocabulary. */
  legend: z.record(RetentionState, z.string()),
  disclaimer: z.string(),
});

export const RetentionSummaryResponse = z.object({
  totalCameras: z.number().int(),
  declared: z.number().int(),
  undeclared: z.number().int(),
  shortestDeclaredDays: z.number().int().nullable(),
  longestDeclaredDays: z.number().int().nullable(),
  buckets: z.array(
    z.object({
      retentionDays: z.number().int().nullable(),
      cameras: z.number().int(),
    }),
  ),
  byDepartment: z.array(
    z.object({
      departmentId: z.uuid().nullable(),
      departmentCode: z.string().nullable(),
      departmentName: z.string().nullable(),
      cameras: z.number().int(),
      declared: z.number().int(),
      undeclared: z.number().int(),
      minRetentionDays: z.number().int().nullable(),
      maxRetentionDays: z.number().int().nullable(),
    }),
  ),
  located: z.number().int(),
  unlocated: z.number().int(),
  disclaimer: z.string(),
});

/** Same shape D3-04 enforces on an export's case reference. One vocabulary for one concept. */
const CaseRef = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9/\-_.]+$/, 'case reference may contain letters, digits and / - _ . only');

export const PreservationRequestBody = z
  .object({
    cameraId: z.uuid(),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    /**
     * Mandatory, unlike on a search. Asking another department to change what it does with evidence
     * is an act that has to name the case it is for.
     */
    caseRef: CaseRef,
    purpose: z.string().trim().min(3).max(500),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((body) => new Date(body.windowEnd) > new Date(body.windowStart), {
    message: 'windowEnd must be after windowStart',
    path: ['windowEnd'],
  });

const PreservationRecordSchema = z.object({
  id: z.uuid(),
  cameraId: z.uuid(),
  cameraExternalId: z.string(),
  cameraName: z.string(),
  departmentId: z.uuid().nullable(),
  departmentCode: z.string().nullable(),
  departmentName: z.string().nullable(),
  windowStart: z.string(),
  windowEnd: z.string(),
  caseRef: z.string(),
  purpose: z.string(),
  requestedBy: z.uuid().nullable(),
  requestedByBadgeNo: z.string().nullable(),
  requestedAt: z.string(),
  status: z.enum(['open', 'acknowledged', 'preserved', 'declined']),
  retentionDaysAtRequest: z.number().int().nullable(),
  expiresAtAtRequest: z.string().nullable(),
  auditHash: z.string(),
  notes: z.string().nullable(),
  retention: RetentionStatus,
});

export const PreservationRequestResponse = z.object({
  request: PreservationRecordSchema,
  /** The chain entry that authorised it. Verifiable at `GET /api/v1/audit`. */
  auditHash: z.string(),
  disclaimer: z.string(),
});

export const PreservationQueueResponse = z.object({
  data: z.array(PreservationRecordSchema),
  limit: z.number().int(),
  counts: z.object({
    open: z.number().int(),
    acknowledged: z.number().int(),
    preserved: z.number().int(),
    declined: z.number().int(),
  }),
  disclaimer: z.string(),
});

export interface RetentionRouteOptions {
  db: Db;
  env: Env;
}

export function registerRetentionRoutes(app: App, deps: RetentionRouteOptions): void {
  const { db, env } = deps;
  const defaultThreshold = env.RETENTION_EXPIRING_SOON_HOURS;

  // ── GET /evidence/availability ────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/evidence/availability',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['evidence'],
        summary: 'Which cameras covered a location at a time, and whether that footage still exists',
        description:
          'Coverage is proximity to the registered position, not a viewshed. Cameras with no ' +
          'registered position cannot be ruled in or out and are returned in `unassessable` ' +
          'rather than dropped. A camera whose department declared no retention period is ' +
          '`unknown`, never assumed to be available or expired.',
        querystring: AvailabilityQuery,
        response: {
          200: AvailabilityResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const q = request.query;
      const result = await evidenceAvailability(db, {
        lat: q.lat,
        lon: q.lon,
        radiusM: q.radius_m,
        at: q.at === undefined ? new Date() : new Date(q.at),
        expiringSoonHours: q.expiring_soon_hours ?? defaultThreshold,
        departmentId: q.department_id,
      });

      return {
        ...result,
        coverageModelNote: COVERAGE_MODEL_NOTE,
        legend: RETENTION_STATE_MEANING,
        disclaimer: RETENTION_DISCLAIMER,
      };
    },
  );

  // ── GET /evidence/retention/summary ───────────────────────────────────────────────────────────
  app.get(
    '/api/v1/evidence/retention/summary',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['evidence'],
        summary: 'How much of the estate is on which retention window, by declared period and department',
        description:
          'The `retentionDays: null` bucket is cameras whose department declared no retention ' +
          'period. It is a real bucket and is never folded into a default.',
        response: { 200: RetentionSummaryResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => ({ ...(await retentionSummary(db)), disclaimer: RETENTION_DISCLAIMER }),
  );

  // ── POST /evidence/preservation ───────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/evidence/preservation',
    {
      onRequest: [authenticate(db)],
      // Write roles, not read roles: this creates a record that instructs another department, and
      // an auditor deliberately holds no power to change what is being audited.
      preHandler: [requireRole(WRITE_ROLES)],
      schema: {
        tags: ['evidence'],
        summary: 'Record a request that the owning department preserve footage past its retention window',
        description: PRESERVATION_DISCLAIMER,
        body: PreservationRequestBody,
        response: {
          201: PreservationRequestResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      try {
        const record = await createPreservationRequest(
          db,
          request.principal,
          {
            cameraId: body.cameraId,
            windowStart: new Date(body.windowStart),
            windowEnd: new Date(body.windowEnd),
            caseRef: body.caseRef,
            purpose: body.purpose,
            notes: body.notes ?? null,
          },
          { expiringSoonHours: defaultThreshold },
        );
        return reply.code(201).send({
          request: record,
          auditHash: record.auditHash,
          disclaimer: PRESERVATION_DISCLAIMER,
        });
      } catch (error) {
        if (error instanceof PreservationCameraNotFound) {
          return reply.code(404).send({ error: 'not_found', message: 'no such camera' });
        }
        throw error;
      }
    },
  );

  // ── GET /evidence/preservation ────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/evidence/preservation',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['evidence'],
        summary: 'The preservation queue, most urgent first',
        description:
          'Ordered on the retention state recomputed against now, not on the figure snapshotted ' +
          'when the request was made — urgency is a function of the current time. ' +
          PRESERVATION_DISCLAIMER,
        querystring: z.object({
          status: z.enum(['open', 'acknowledged', 'preserved', 'declined']).optional(),
          case_ref: CaseRef.optional(),
          camera_id: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          expiring_soon_hours: z.coerce.number().min(1).max(8760).optional(),
        }),
        response: { 200: PreservationQueueResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const q = request.query;
      const data = await preservationQueue(db, {
        status: q.status,
        caseRef: q.case_ref,
        cameraId: q.camera_id,
        limit: q.limit,
        expiringSoonHours: q.expiring_soon_hours ?? defaultThreshold,
      });

      const counts = { open: 0, acknowledged: 0, preserved: 0, declined: 0 };
      for (const row of data) counts[row.status] += 1;

      return { data, limit: q.limit, counts, disclaimer: PRESERVATION_DISCLAIMER };
    },
  );
}
