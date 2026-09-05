/**
 * The audit chain's read surface (D3-04) — and the export that leaves the building.
 *
 * ```
 * GET  /api/v1/audit          search the chain by actor, badge, action, case, target, time
 * GET  /api/v1/audit/verify   walk the chain and report the first broken link, if any
 * GET  /api/v1/audit/:id      one entry, with its purpose, parameters and recomputed status
 * POST /api/v1/audit/export   build an evidence bundle — requires a case reference
 * ```
 *
 * **The auditor role lives here and nowhere else.** `audit:read` and `audit:export` are the only
 * capabilities the auditor holds beyond `registry:read` and `trust:read`, and they deliberately do
 * **not** include `trace:run`, `video:view` or `alerts:view`: someone who reviews what was done must
 * not also be able to do it. The role lists are computed from `can()` rather than restated, so this
 * file cannot drift from the navigation the web shell renders.
 *
 * **Nothing here can be written to.** There is no PATCH, no DELETE and no "correct this entry"
 * route, because there is no such operation — `audit_log` is append-only in the database itself
 * (grants plus BEFORE UPDATE/DELETE triggers, D1-01), and an API that offered an edit would be
 * offering something the database would refuse.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, requireRole, userRoles } from '../auth.js';
import { can, canAll } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import { ErrorResponse } from './camera-contracts.js';
import {
  AuditSearchQuery,
  AuditSearchResponse,
  AuditEntryResponse,
  ChainVerificationResponse,
  ExportBundleRequest,
  ExportBundleResponse,
} from './audit-contracts.js';
import { readAuditEntry, searchAudit, verifyChain } from '../services/audit.js';
import { TraceService, type CropPresigner } from '../services/trace.js';
import { buildExportBundle } from '../services/export-bundle.js';

export const AUDIT_READ_ROLES = userRoles.filter((role) => can(role, 'audit:read'));

/**
 * An evidence bundle needs **both** capabilities, and the conjunction is the point.
 *
 * `trace:run` says you are allowed to look at this evidence; `audit:export` says you are allowed to
 * take something out of the building. An operator has the first and not the second, so they can
 * trace a vehicle on screen but cannot package it; an auditor has the second and not the first, so
 * they can read and export the chain but never the footage it describes — "an auditor who can change
 * the thing being audited is not an auditor", and one who can walk out with the evidence is not one
 * either. That leaves admin and supervisor, which is who the ticket means by "approves exports".
 */
export const AUDIT_EXPORT_ROLES = userRoles.filter((role) =>
  canAll(role, ['trace:run', 'audit:export']),
);

/**
 * What the chain viewer is allowed to claim, in one place so the UI never re-derives it.
 *
 * The two negatives are load-bearing and are scored: an audit trail that hinted an identification
 * had been made, or that a government registry had been consulted, would be asserting something
 * this system does not do.
 */
export const AUDIT_DISCLAIMER =
  'The chain records what was done and who stated what purpose. It is evidence of activity, not of ' +
  'identification: SAAKSHI performs no face recognition or other biometric processing, and has no ' +
  'live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, so no entry here reflects a lookup ' +
  'against a government registry.';

export const CHAIN_CLAIM =
  'A passing verification proves tamper EVIDENCE, not tamper prevention: any alteration to a single ' +
  'entry is detectable, as is any removal or reordering. It does not prevent an actor with database ' +
  'write access from rewriting the chain from a chosen point onward — which is why append-only is ' +
  'enforced by the database and not only by this application. See docs/chain-of-custody.md.';

export interface AuditRouteOptions {
  db: Db;
  /** Mints a short-lived GET URL for a stored `s3://` crop. Absent, a bundle carries no crops. */
  presign?: CropPresigner;
  /** Where export bundles are written. Absolute; defaults to `<repo>/exports`. */
  exportDir?: string;
}

/**
 * `<repo>/exports`, derived from this module rather than from `process.cwd()` — the API is started
 * from `packages/api`, so a relative default would write bundles somewhere no instruction mentions.
 */
const DEFAULT_EXPORT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../exports',
);

export function registerAuditRoutes(app: App, options: AuditRouteOptions): void {
  const exportDir = options.exportDir ?? DEFAULT_EXPORT_DIR;

  app.get(
    '/api/v1/audit',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(AUDIT_READ_ROLES)],
      schema: {
        tags: ['audit'],
        summary: 'Search the tamper-evident audit chain by actor, action, case reference or time',
        description:
          'Every entry carries the purpose that was stated when the action ran, and a `status` ' +
          'recomputed from the entry itself rather than trusted — a viewer that showed stored rows ' +
          'without re-checking them would be a list, not an audit.',
        querystring: AuditSearchQuery,
        response: {
          200: AuditSearchResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request): Promise<z.infer<typeof AuditSearchResponse>> => {
      const q = request.query;
      const result = await searchAudit(options.db, {
        actorId: q.actor_id,
        badgeNo: q.badge_no,
        action: q.action,
        caseRef: q.case_ref,
        targetType: q.target_type,
        targetId: q.target_id,
        from: q.from,
        to: q.to,
        limit: q.limit,
        offset: q.offset,
      });
      return { ...result, disclaimer: AUDIT_DISCLAIMER };
    },
  );

  app.get(
    '/api/v1/audit/verify',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(AUDIT_READ_ROLES)],
      schema: {
        tags: ['audit'],
        summary: 'Walk the whole chain and report the first broken link, if there is one',
        description:
          'A failing verification is a 200 with `ok: false`, not an error status: "the chain is ' +
          'broken" is an answer, and an auditor needs to read which entry and why.',
        response: {
          200: ChainVerificationResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (): Promise<z.infer<typeof ChainVerificationResponse>> => {
      const result = await verifyChain(options.db);
      return { ...result, claim: CHAIN_CLAIM };
    },
  );

  app.get(
    '/api/v1/audit/:id',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(AUDIT_READ_ROLES)],
      schema: {
        tags: ['audit'],
        summary: 'One audit entry, with its stated purpose, parameters and recomputed status',
        params: z.object({ id: z.uuid() }),
        response: {
          200: AuditEntryResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const entry = await readAuditEntry(options.db, request.params.id);
      if (entry === null) {
        return reply.code(404).send({ error: 'not_found', message: 'no such audit entry' });
      }
      return entry;
    },
  );

  app.post(
    '/api/v1/audit/export',
    {
      onRequest: [authenticate(options.db)],
      preHandler: [requireRole(AUDIT_EXPORT_ROLES)],
      schema: {
        tags: ['audit'],
        summary:
          'Package a vehicle trace and its evidence crops as an independently verifiable bundle',
        description:
          'Requires both a stated purpose and a case reference; the case reference is what makes an ' +
          'export answerable once the evidence has left the system. Crops are embedded as bytes — a ' +
          'signed URL is a credential with an expiry and would be dead before the bundle was opened.',
        body: ExportBundleRequest,
        response: {
          201: ExportBundleResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply): Promise<z.infer<typeof ExportBundleResponse>> => {
      const body = request.body;
      const service = new TraceService(options.db, undefined, options.presign);
      const trace = await service.trace(body.plate, {
        ...(body.from !== undefined ? { from: new Date(body.from) } : {}),
        ...(body.to !== undefined ? { to: new Date(body.to) } : {}),
      });

      const built = await buildExportBundle({
        db: options.db,
        principal: request.principal,
        trace,
        purpose: body.purpose,
        caseRef: body.case_ref,
        outDir: exportDir,
        ...(options.presign !== undefined ? { presign: options.presign } : {}),
      });

      reply.code(201);
      return {
        bundleId: built.bundleId,
        createdAt: built.manifest.createdAt,
        caseRef: built.manifest.caseRef,
        manifestHash: built.manifestHash,
        items: built.manifest.items.length,
        bytes: built.bytes,
        path: built.dir,
        auditEntryHash: built.manifest.chain.auditEntryHash,
      };
    },
  );
}
