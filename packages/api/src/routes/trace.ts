/**
 * Vehicle trace endpoints (D2-08) — the graded live test case.
 *
 * `GET /api/v1/trace` returns a vehicle's movement history: ordered sightings, the cameras behind
 * them, the inferred segments between them, and — on every single row — **how** that sighting was
 * linked to the registration and **how strongly**. `GET /api/v1/trace.csv` and
 * `GET /api/v1/trace.pdf` are the same result in the two forms D4-03's output report needs.
 *
 * **Authorisation is by capability, derived rather than restated.** `/trace` is gated on
 * `trace:run` in `packages/shared/src/rbac.ts`, and an **auditor deliberately does not have it** —
 * the audit function reviews what was done, it does not run investigative queries. Computing the
 * role list from `can()` means the API and the web navigation cannot drift apart; hard-coding
 * `['admin','supervisor','operator']` here would be a second source of truth for the same rule.
 *
 * **The empty result is a 200, always.** A registration nobody has seen, and a query the plate
 * grammar refuses to read as a registration at all, are both *answers*. `emptyReason` says which,
 * and the UI renders a state rather than an error.
 */
import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, requireRole, userRoles } from '../auth.js';
import { can } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import { LINK_METHODS } from '../services/identity.js';
import {
  MAX_TRACE_SIGHTINGS,
  TraceService,
  type CropPresigner,
  type TraceResult,
} from '../services/trace.js';
import { traceCsv, tracePdf } from '../services/trace-export.js';
import { NullOsrmClient, type OsrmClient } from '../services/osrm.js';
import { RouteService, type RouteReconstruction } from '../services/route.js';

/** Derived from the shared RBAC table, so the API can never disagree with the navigation. */
export const TRACE_ROLES = userRoles.filter((role) => can(role, 'trace:run'));

const csvUuids = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(z.uuid()).max(200));

export const TraceQuery = z.object({
  plate: z.string().trim().min(1).max(24),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  camera_ids: csvUuids.optional(),
  /** Floor on `linkConfidence`, in `[0,1]`. 0 keeps every candidate the matcher returned. */
  min_confidence: z.coerce.number().min(0).max(1).default(0),
  /** Weighted-distance ceiling. 2 is D2-04's measured knee — `docs/fuzzy-matching.md` §6. */
  max_distance: z.coerce.number().min(0).max(6).default(2),
  limit: z.coerce.number().int().min(1).max(MAX_TRACE_SIGHTINGS).default(MAX_TRACE_SIGHTINGS),
  /**
   * Reconstruct the route on the road graph (D3-01). Off by default: it costs an OSRM query per
   * camera-to-camera transition, and `GET /api/v1/trace` is also the alert queue's deep link.
   *
   * `z.stringbool()` rather than the `z.coerce.boolean()` used elsewhere in this codebase, because
   * `coerce` runs `Boolean("false")` and that is `true` — `?reconstruct=false` would switch the
   * feature *on*. Logged against the existing uses on BL-01.
   */
  reconstruct: z.stringbool().default(false),
});

const LinkMethod = z.enum(LINK_METHODS);

const TraceSighting = z.object({
  seq: z.number().int(),
  sightingId: z.string(),
  ts: z.string(),
  framePtsMs: z.number(),
  cameraId: z.string(),
  cameraExternalId: z.string(),
  cameraName: z.string(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  located: z.boolean(),
  trackId: z.number().int(),
  trackingSession: z.number().int(),
  rawTrackerId: z.number().int(),
  class: z.string(),
  detConfidence: z.number(),
  vehicleColor: z.string().nullable(),
  vehicleColorConfidence: z.number().nullable(),
  attributesLowConfidence: z.boolean().nullable(),
  isBestShot: z.boolean(),
  cropUri: z.string().nullable(),
  cropUrl: z.string().nullable(),
  plateNormalized: z.string(),
  plateRawText: z.string(),
  ocrConfidence: z.number(),
  voteCount: z.number().int(),
  linkMethod: LinkMethod,
  linkConfidence: z.number(),
  matchDistance: z.number().nullable(),
  matchStrength: z.number().nullable(),
  explanation: z.string(),
  basis: z.literal('observed'),
});

const TraceSegment = z.object({
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  fromSightingId: z.string(),
  toSightingId: z.string(),
  fromCameraId: z.string(),
  toCameraId: z.string(),
  gapSeconds: z.number(),
  sameCamera: z.boolean(),
  straightLineKm: z.number().nullable(),
  impliedSpeedKmh: z.number().nullable(),
  basis: z.literal('inferred'),
  note: z.string(),
});

const TraceCamera = z.object({
  cameraId: z.string(),
  externalId: z.string(),
  name: z.string(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  located: z.boolean(),
  sightingCount: z.number().int(),
  firstSeq: z.number().int(),
});

const LinkedPlate = z.object({
  plateNormalized: z.string(),
  linkMethod: z.enum(['plate_exact', 'plate_fuzzy']),
  distance: z.number(),
  matchStrength: z.number(),
  ocrConfidence: z.number(),
  linkConfidence: z.number(),
  explanation: z.string(),
  sightingCount: z.number().int(),
  cameraCount: z.number().int(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

const ResolvedIdentity = z.object({
  canonicalPlate: z.string(),
  searched: z.boolean(),
  plates: z.array(LinkedPlate),
  exactPlates: z.number().int(),
  fuzzyPlates: z.number().int(),
  candidateSightings: z.number().int(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  matcher: z.string(),
});

/**
 * Route reconstruction (D3-01), additive.
 *
 * `segments` above is D2-08's list of *gaps* and is frozen — D3-02 consumes its exact shape, and
 * D2-08's handoff forbids re-sorting or re-vocabularising it. This is a second, richer list keyed
 * on the same `basis` vocabulary, present only when `reconstruct=true` and `null` otherwise.
 */
const RouteSegment = z.object({
  seq: z.number().int(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  fromSightingId: z.string(),
  toSightingId: z.string(),
  fromCameraId: z.string(),
  toCameraId: z.string(),
  fromCameraName: z.string(),
  toCameraName: z.string(),
  kind: z.enum(['observed_dwell', 'inferred_path', 'inferred_revisit', 'inferred_unroutable']),
  /** `true` only when one camera held the vehicle in an unbroken tracking session. */
  observed: z.boolean(),
  basis: z.enum(['observed', 'inferred']),
  sameCamera: z.boolean(),
  elapsedSeconds: z.number(),
  straightLineKm: z.number().nullable(),
  /** OSRM's fastest path. A LOWER bound on the distance actually driven. */
  roadDistanceKm: z.number().nullable(),
  expectedTravelTimeS: z.number().nullable(),
  elapsedVsExpected: z.number().nullable(),
  /** `roadDistanceKm / elapsed` — a LOWER bound: the vehicle averaged at least this. */
  minimumAverageSpeedKmh: z.number().nullable(),
  pathOptions: z.number().int().nullable(),
  inferredConfidence: z.number().nullable(),
  confidenceBasis: z
    .object({ timing: z.number(), uniqueness: z.number(), endpoints: z.number() })
    .nullable(),
  geometry: z
    .object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number(), z.number()])) })
    .nullable(),
  note: z.string(),
});

export const RouteResponse = z.object({
  canonicalPlate: z.string(),
  segments: z.array(RouteSegment),
  summary: z.object({
    segments: z.number().int(),
    observedSegments: z.number().int(),
    inferredSegments: z.number().int(),
    unmeasuredSegments: z.number().int(),
    cameras: z.number().int(),
    camerasPlaced: z.number().int(),
    firstSeen: z.string().nullable(),
    lastSeen: z.string().nullable(),
    elapsedSeconds: z.number(),
    totalKm: z.number(),
    observedKm: z.number(),
    inferredKm: z.number(),
    meanInferredConfidence: z.number().nullable(),
    weakestSegmentSeq: z.number().int().nullable(),
  }),
  coverage: z.object({
    segmentsRouted: z.number().int(),
    segmentsUnroutable: z.number().int(),
    segmentsUnplaced: z.number().int(),
    osrmQueries: z.number().int(),
    osrmFailures: z.number().int(),
  }),
  /** The two sentences the map legend renders. The distinction, in words, not a footnote. */
  legend: z.object({ observed: z.string(), inferred: z.string() }),
  cache: z.object({
    key: z.string(),
    fingerprint: z.string(),
    hit: z.boolean(),
    builtAt: z.string(),
  }),
  roadGraph: z.object({
    available: z.boolean(),
    baseUrl: z.string(),
    modelVersion: z.string(),
  }),
  buildMs: z.number(),
});
export type RouteResponse = z.infer<typeof RouteResponse>;

export const TraceResponse = z.object({
  query: z.string(),
  normalized: z.string(),
  validity: z.enum(['valid', 'partial', 'invalid']),
  reason: z.string().nullable(),
  searched: z.boolean(),
  window: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  minConfidence: z.number(),
  maxDistance: z.number(),
  matcher: z.string(),
  identity: ResolvedIdentity.nullable(),
  sightings: z.array(TraceSighting),
  segments: z.array(TraceSegment),
  cameras: z.array(TraceCamera),
  coverage: z.object({
    sightings: z.number().int(),
    cameras: z.number().int(),
    camerasPlaced: z.number().int(),
    sightingsMappable: z.number().int(),
    sightingsWithCrop: z.number().int(),
    exactLinks: z.number().int(),
    fuzzyLinks: z.number().int(),
    otherLinks: z.number().int(),
    droppedBelowConfidence: z.number().int(),
    truncated: z.boolean(),
  }),
  /** The two sentences that keep a trace from over-claiming. Rendered, not buried in a footer. */
  claims: z.object({ observed: z.string(), inferred: z.string() }),
  /** Present only when `reconstruct=true`. `null` otherwise — never an empty object. */
  route: RouteResponse.nullable(),
  emptyReason: z
    .enum([
      'query_not_searchable',
      'no_matching_plate',
      'no_sightings_in_window',
      'below_min_confidence',
    ])
    .nullable(),
  disclaimer: z.string(),
  tookMs: z.number(),
});
export type TraceResponse = z.infer<typeof TraceResponse>;

/** A trace, plus the reconstruction when one was asked for. `route` is `null` otherwise. */
export type TracedRoute = TraceResult & { route: RouteReconstruction | null };

export interface TraceRouteOptions {
  db: Db;
  service?: TraceService;
  /**
   * The road graph. Absent means no reconstruction is possible, which is the honest state of a
   * machine that has never run `scripts/import-osm.sh` — every transition then comes back as
   * `inferred_unroutable` with a reason rather than the endpoint failing.
   */
  osrm?: OsrmClient;
  /**
   * Mints a browser-usable URL for a stored `s3://` crop.
   *
   * Injected rather than constructed here: an object-store client reads credentials from the
   * environment and uploads `Buffer`s, and `packages/web` typechecks whatever the route graph
   * imports under `lib: DOM`, where `Buffer` is not a `BodyInit`. `services/crop-url.ts` explains
   * it in full. Absent, every `cropUrl` is `null` — which is the truth on a machine with no MinIO.
   */
  presign?: CropPresigner;
}

export function registerTraceRoutes(app: App, options: TraceRouteOptions): void {
  const service = options.service ?? new TraceService(options.db, undefined, options.presign);
  const routes = new RouteService(options.db, options.osrm ?? new NullOsrmClient());

  const run = async (
    query: z.infer<typeof TraceQuery>,
    requestedBy: string | null = null,
  ): Promise<TracedRoute> => {
    const result = await service.trace(query.plate, {
      minConfidence: query.min_confidence,
      maxDistance: query.max_distance,
      limit: query.limit,
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      ...(query.camera_ids !== undefined ? { cameraIds: query.camera_ids } : {}),
    });
    // Fewer than two sightings is not a degenerate route, it is *no* route: there is no pair to
    // reconstruct between. Returning `null` rather than an empty reconstruction keeps the UI from
    // rendering a summary of nothing.
    if (!query.reconstruct || result.sightings.length < 2) return { ...result, route: null };
    const route = await routes.reconstruct(result, { requestedBy });
    return { ...result, route };
  };

  app.get(
    '/api/v1/trace',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(TRACE_ROLES)],
      schema: {
        tags: ['trace'],
        summary: "A vehicle's movement history: ordered sightings, cameras, inferred segments",
        description:
          'Sightings are observed. That they are the same vehicle is inferred, with a link method ' +
          'and a confidence on every row; the path between them is inferred entirely. An empty ' +
          'result is a 200 with an `emptyReason`, never an error.',
        querystring: TraceQuery,
        response: {
          200: TraceResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request): Promise<TracedRoute> => run(request.query, request.principal?.sub ?? null),
  );

  app.get(
    '/api/v1/trace.csv',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(TRACE_ROLES)],
      schema: {
        tags: ['trace'],
        summary:
          'The same trace as CSV — plate, camera, coordinates, timestamp, confidence, method',
        querystring: TraceQuery,
        // No `response` map, matching `GET /api/v1/cameras/export`: a declared response schema puts
        // the zod serialiser in front of a body that is deliberately not JSON.
      },
    },
    async (request, reply): Promise<void> => {
      const result = await run(request.query);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = safeFileName(result.normalized === '' ? result.query : result.normalized);
      // `reply.send` rather than a returned value: the response schema map declares only errors, so
      // the type provider would otherwise insist a CSV string is an `ErrorResponse`.
      await reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="saakshi-trace-${name}-${stamp}.csv"`)
        .send(traceCsv(result));
    },
  );

  app.get(
    '/api/v1/trace.pdf',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(TRACE_ROLES)],
      schema: {
        tags: ['trace'],
        summary: 'The same trace as a one-or-more-page PDF report, presentable to a reviewer',
        querystring: TraceQuery,
        produces: ['application/pdf'],
      },
    },
    async (request, reply): Promise<void> => {
      const result = await run(request.query);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = safeFileName(result.normalized === '' ? result.query : result.normalized);
      await reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="saakshi-trace-${name}-${stamp}.pdf"`)
        .send(tracePdf(result));
    },
  );
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned === '' ? 'QUERY' : cleaned.slice(0, 24);
}
