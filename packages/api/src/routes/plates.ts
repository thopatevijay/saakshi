import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, requireRole, userRoles } from '../auth.js';
import { can } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import { CaseReference, PurposeStatement } from './audit-contracts.js';
import { writeAudit } from '../audit.js';
import { PlateSearchService, type PlateSearchResult } from '../services/plate-search.js';

/**
 * `GET /api/v1/plates/search` — confusion-aware fuzzy plate search over the sightings table (D2-04).
 *
 * The jury hands us a registration. Exact matching returns nothing on this estate (D2-01: 0% exact
 * plate accuracy), so this returns **ranked candidates with their distance, their strength and the
 * sightings behind them**, and it never presents a fuzzy candidate as an identification: every
 * result carries `matchType`, the weighted `distance`, the edit script in `explanation`, and the
 * disclaimer below.
 *
 * `searched: false` is a real, useful answer. A query the plate grammar can only read as signage or
 * a phone number (`no_letters`, `no_digits`) is refused rather than fuzzed against the estate — see
 * `docs/fuzzy-matching.md` §5.
 */

export const DISCLAIMER =
  'Fuzzy candidates are ranked possibilities, not identifications. `distance` is a weighted edit ' +
  'distance under config/plate-confusions.json, not a probability, and `score` combines it with the ' +
  'OCR confidence of the underlying read. Verify against the evidence crop before acting. ' +
  'Measured precision and recall: docs/fuzzy-matching.md §6.';

const csvUuids = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(z.uuid()).max(200));

export const PlateSearchQuery = z.object({
  q: z.string().trim().min(1).max(24),
  /**
   * Purpose binding (D3-04). Required and enforced here, not in the UI, and written into the audit
   * chain against the officer who stated it. A plate search with no stated reason is a 400.
   */
  purpose: PurposeStatement,
  case_ref: CaseReference.optional(),
  /** Weighted distance ceiling. 2 is the measured knee — see `docs/fuzzy-matching.md` §6. */
  max_distance: z.coerce.number().min(0).max(6).default(2),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  camera_ids: csvUuids.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sightings_per_candidate: z.coerce.number().int().min(1).max(100).default(20),
});

const SightingRef = z.object({
  sightingId: z.string(),
  sightingTs: z.string(),
  cameraId: z.string(),
  cameraExternalId: z.string(),
  cameraName: z.string(),
  plateReadId: z.string(),
  rawText: z.string(),
  ocrConfidence: z.number(),
  voteCount: z.number(),
  cropUri: z.string().nullable(),
});

const PlateSearchCandidate = z.object({
  plateNormalized: z.string(),
  matchType: z.enum(['exact', 'fuzzy']),
  distance: z.number(),
  matchStrength: z.number(),
  ocrConfidence: z.number(),
  score: z.number(),
  explanation: z.string(),
  sightingCount: z.number(),
  cameraCount: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  sightings: z.array(SightingRef),
});

export const PlateSearchResponse = z.object({
  query: z.string(),
  normalized: z.string(),
  validity: z.enum(['valid', 'partial', 'invalid']),
  /** `reasons[0].code` from the D2-03 grammar, or `null` for a clean registration. */
  reason: z.string().nullable(),
  missingChars: z.number().nullable(),
  /** `false` when the grammar says this string cannot be a registration. Not an error. */
  searched: z.boolean(),
  maxDistance: z.number(),
  matcher: z.string(),
  candidates: z.array(PlateSearchCandidate),
  disclaimer: z.string(),
});
export type PlateSearchResponse = z.infer<typeof PlateSearchResponse>;

export interface PlateRouteOptions {
  db: Db;
  service?: PlateSearchService;
}

/**
 * Derived from `trace:run`, not from `READ_ROLES` (D3-04).
 *
 * A plate search *is* an investigative query — the same question a trace asks, one step earlier —
 * and `READ_ROLES` includes the auditor, who by the shared RBAC table's own reasoning must not have
 * one: "the audit function examines what was done, not the footage itself". Reading the role list
 * off the capability keeps this endpoint and `/api/v1/trace` from drifting apart.
 */
export const PLATE_SEARCH_ROLES = userRoles.filter((role) => can(role, 'trace:run'));

export function registerPlateRoutes(app: App, options: PlateRouteOptions): void {
  const service = options.service ?? new PlateSearchService(options.db);

  app.get(
    '/api/v1/plates/search',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(PLATE_SEARCH_ROLES)],
      schema: {
        tags: ['plates'],
        summary: 'Confusion-aware fuzzy plate search over sightings, ranked with sighting refs',
        querystring: PlateSearchQuery,
        response: {
          200: PlateSearchResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request): Promise<PlateSearchResponse> => {
      const q = request.query;
      const result: PlateSearchResult = await service.search(q.q, {
        maxDistance: q.max_distance,
        limit: q.limit,
        sightingsPerCandidate: q.sightings_per_candidate,
        ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
        ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
        ...(q.camera_ids !== undefined ? { cameraIds: q.camera_ids } : {}),
      });

      // Awaited, not fired and forgotten: a search that ran without leaving a record is the state
      // this ticket exists to make unreachable (D3-04).
      await writeAudit(options.db, request.principal, {
        action: 'plate.search',
        targetType: 'plate_query',
        targetId: result.normalized === '' ? result.query : result.normalized,
        purpose: q.purpose,
        caseRef: q.case_ref ?? null,
        params: {
          q: q.q,
          normalized: result.normalized,
          maxDistance: q.max_distance,
          limit: q.limit,
          from: q.from ?? null,
          to: q.to ?? null,
          cameraIds: q.camera_ids ?? [],
          searched: result.searched,
        },
        resultCount: result.candidates.length,
      });

      return { ...result, disclaimer: DISCLAIMER };
    },
  );
}
